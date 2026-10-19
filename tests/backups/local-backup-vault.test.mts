import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { LocalBackupVault } from '../../src/backups/local-backup-vault.mts';
import type { BackupMetadata } from '../../src/backups/backup-types.ts';
import type { HostSecretProtection } from '../../src/platform/host-types.ts';
import { defined } from '../support/fixture-assertions.mts';

function fixture(t: TestContext) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'backup-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // A fixture-only key provider never writes unwrapped keys to any file.
  const keys = new Map<string, string>();
  const protection: HostSecretProtection = {
    async protect(value) {
      const reference = randomUUID();
      keys.set(reference, value);
      return Buffer.from(reference);
    },
    async unprotect(blob) {
      return defined(keys.get(blob.toString()), 'Unknown fixture key');
    },
  };
  const vault = new LocalBackupVault(directory, protection);
  const metadata = (overrides: Partial<BackupMetadata> = {}): BackupMetadata => ({
    id: randomUUID(),
    createdAt: Date.now(),
    appVersion: '0.4.7-beta.8',
    bytes: 64,
    files: 1,
    source: 'a'.repeat(12),
    ...overrides,
  });
  return { directory, vault, protection, metadata };
}
async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of stream) {
    assert.ok(Buffer.isBuffer(value));
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

test('vault streams an authenticated roundtrip and stores independent ciphertext without archive plaintext', async (t) => {
  const f = fixture(t),
    metadata = f.metadata();
  const sentinel = Buffer.from(
    'isolated private memory, skills and history fixture\n'.repeat(5000),
  );
  await f.vault.save(Readable.from([sentinel.subarray(0, 24), sentinel.subarray(24)]), metadata);
  const encrypted = fs.readFileSync(f.vault.file(metadata.id));
  assert.equal(encrypted.includes(sentinel.subarray(0, 100)), false);
  assert.deepEqual(f.vault.list(), [metadata]);
  const opened = await f.vault.open(metadata.id);
  try {
    assert.deepEqual(opened.metadata, metadata);
    assert.deepEqual(await collect(opened.stream()), sentinel);
    assert.throws(() => opened.stream(), { code: 'backup_invalid' });
  } finally {
    await opened.close();
  }
  const next = f.metadata();
  await f.vault.save(Readable.from([sentinel]), next);
  assert.notDeepEqual(fs.readFileSync(f.vault.file(next.id)), encrypted);
  const closed = await f.vault.open(next.id);
  await closed.close();
  await closed.close();
  assert.throws(() => closed.stream(), { code: 'backup_invalid' });
});

test('authenticated metadata, ciphertext, tag and truncation tampering fail before any restore stream is returned', async (t) => {
  const f = fixture(t),
    metadata = f.metadata();
  await f.vault.save(Readable.from([Buffer.from('isolated archive payload')]), metadata);
  const file = f.vault.file(metadata.id),
    original = fs.readFileSync(file);
  const inspected = f.vault.readHeader(metadata.id);
  const variants = [
    () => {
      const changed = Buffer.from(original);
      const position = changed.indexOf(Buffer.from('0.4.7-beta.8'));
      assert.ok(position >= 0);
      changed[position] = '1'.charCodeAt(0);
      return changed;
    },
    () => {
      const changed = Buffer.from(original);
      changed[inspected.start] = defined(changed[inspected.start]) ^ 1;
      return changed;
    },
    () => {
      const changed = Buffer.from(original);
      changed[changed.length - 1] = defined(changed.at(-1)) ^ 1;
      return changed;
    },
    () => original.subarray(0, original.length - 1),
    () => original.subarray(0, 8),
    () => Buffer.from('not a backup file'),
  ];
  for (const alter of variants) {
    fs.writeFileSync(file, alter());
    await assert.rejects(f.vault.open(metadata.id), { code: 'backup_invalid' });
  }
  fs.writeFileSync(file, original);
  const opened = await f.vault.open(metadata.id);
  try {
    assert.equal((await collect(opened.stream())).toString(), 'isolated archive payload');
  } finally {
    await opened.close();
  }
});

test('source stream failure, key protection failure and abort preserve existing snapshots and remove partial files', async (t) => {
  const f = fixture(t),
    first = f.metadata();
  await f.vault.save(Readable.from(['existing archive']), first);
  const saved = fs.readFileSync(f.vault.file(first.id));
  async function* failing() {
    yield Buffer.from('partial archive');
    throw Error('Isolated input failed');
  }
  await assert.rejects(
    f.vault.save(Readable.from(failing()), f.metadata()),
    /Isolated input failed/,
  );
  const failedProtection = new LocalBackupVault(f.directory, {
    protect: async () => {
      throw Error('Isolated key protection failed');
    },
    unprotect: f.protection.unprotect,
  });
  await assert.rejects(
    failedProtection.save(Readable.from(['never plaintext']), f.metadata()),
    /Isolated key protection failed/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.vault.save(Readable.from(['aborted archive']), f.metadata(), controller.signal),
  );
  assert.deepEqual(fs.readFileSync(f.vault.file(first.id)), saved);
  assert.deepEqual(fs.readdirSync(f.vault.directory), [first.id + '.dantbak']);
  await assert.rejects(f.vault.save(Readable.from(['replacement']), first), {
    code: 'backup_exists',
  });
  assert.deepEqual(fs.readFileSync(f.vault.file(first.id)), saved);
});

test('missing secure host protection never falls back to plaintext persistence or restore', async (t) => {
  const f = fixture(t),
    vault = new LocalBackupVault(f.directory);
  await assert.rejects(vault.save(Readable.from(['private sentinel']), f.metadata()), {
    code: 'backup_protection_unavailable',
  });
  await assert.rejects(vault.open(randomUUID()), { code: 'backup_protection_unavailable' });
  assert.deepEqual(fs.readdirSync(vault.directory), []);
});

test('retention keeps the requested newest count independently for each source computer', async (t) => {
  const f = fixture(t),
    records: BackupMetadata[] = [];
  for (const source of ['a'.repeat(12), 'b'.repeat(12)])
    for (const createdAt of [1, 2, 3]) {
      const metadata = f.metadata({ source, createdAt });
      records.push(metadata);
      await f.vault.save(Readable.from(['fixture']), metadata);
    }
  f.vault.retain(2);
  const remaining = f.vault.list();
  assert.equal(remaining.length, 4);
  assert.ok(remaining.every((item) => item.createdAt >= 2));
  assert.equal(remaining.filter((item) => item.source === 'a'.repeat(12)).length, 2);
  assert.equal(remaining.filter((item) => item.source === 'b'.repeat(12)).length, 2);
  for (const count of [0, 101, 1.5])
    assert.throws(() => f.vault.retain(count), { code: 'backup_settings_invalid' });
});

test('unsafe IDs, hard-linked archives and linked vault directories cannot select another file', async (t) => {
  const f = fixture(t),
    metadata = f.metadata();
  for (const id of ['../state', '', 'C:\\outside', 'not-an-id'])
    assert.throws(() => f.vault.file(id), { code: 'backup_invalid' });
  await f.vault.save(Readable.from(['fixture archive']), metadata);
  const alias = path.join(f.directory, 'external-hardlink');
  fs.linkSync(f.vault.file(metadata.id), alias);
  await assert.rejects(f.vault.open(metadata.id), { code: 'backup_invalid' });
  fs.unlinkSync(alias);
  const original = f.vault.directory + '.original';
  fs.renameSync(f.vault.directory, original);
  fs.symlinkSync(original, f.vault.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.vault.list(), /directory|link|managed/i);
  assert.throws(() => f.vault.listResult(), /directory|link|managed/i);
  assert.equal(fs.readFileSync(path.join(original, metadata.id + '.dantbak')).length > 0, true);
});

test('a named archive replaced after authentication is rejected before accepted EOF', async (t) => {
  const f = fixture(t),
    metadata = f.metadata();
  await f.vault.save(Readable.from(['fixture archive']), metadata);
  const file = f.vault.file(metadata.id),
    opened = await f.vault.open(metadata.id);
  fs.renameSync(file, file + '.previous');
  fs.copyFileSync(file + '.previous', file);
  try {
    await assert.rejects(collect(opened.stream()), { code: 'backup_invalid' });
  } finally {
    await opened.close();
  }
});

test('invalid archive headers do not hide valid snapshots, are counted, and are never retained as restore candidates or removed', async (t) => {
  const f = fixture(t),
    metadata = f.metadata(),
    badId = randomUUID();
  await f.vault.save(Readable.from(['fixture archive']), metadata);
  fs.writeFileSync(f.vault.file(badId), 'corrupt isolated archive');
  assert.deepEqual(f.vault.listResult(), { backups: [metadata], invalidCount: 1 });
  assert.deepEqual(f.vault.list(), [metadata]);
  await assert.rejects(f.vault.open(badId), { code: 'backup_invalid' });
  f.vault.retain(1);
  assert.equal(fs.existsSync(f.vault.file(badId)), true);
  assert.equal(fs.existsSync(f.vault.file(metadata.id)), true);
  const allBad = fixture(t),
    allBadId = randomUUID();
  fs.writeFileSync(allBad.vault.file(allBadId), 'corrupt isolated archive');
  assert.deepEqual(allBad.vault.listResult(), { backups: [], invalidCount: 1 });
  assert.equal(fs.existsSync(allBad.vault.file(allBadId)), true);
});

test('a linked archive entry is isolated while a linked vault directory still fails closed', async (t) => {
  const f = fixture(t),
    metadata = f.metadata(),
    linked = randomUUID();
  await f.vault.save(Readable.from(['fixture archive']), metadata);
  fs.symlinkSync(f.vault.file(metadata.id), f.vault.file(linked), 'file');
  assert.deepEqual(f.vault.listResult(), { backups: [metadata], invalidCount: 1 });
  assert.equal(fs.lstatSync(f.vault.file(linked)).isSymbolicLink(), true);
  await assert.rejects(f.vault.open(linked), { code: 'backup_invalid' });
});
