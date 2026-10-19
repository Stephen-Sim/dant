import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash, createCipheriv, scryptSync } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { PortableBackup, PORTABLE_MAX_FILE_BYTES } from '../../src/backups/portable-backup.mts';
import { LocalBackupVault } from '../../src/backups/local-backup-vault.mts';
import { archiveStream, validateWorkerBackup } from '../../src/backups/archive-stream.mts';
import type { ArchiveEntry, WorkerBackupManifest } from '../../src/backups/archive-types.ts';
import type { BackupMetadata } from '../../src/backups/backup-types.ts';
import { isRecord } from '../../src/contracts/json.mts';
import { defined } from '../support/fixture-assertions.mts';

const PASSPHRASE = 'isolated portable backup password';
interface FileEntry {
  domain: 'data' | 'workspace';
  path: string;
  text: string;
}
function fixture(t: TestContext) {
  const parent = path.resolve('.cache/tests');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'portable-backup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  function account(name: string) {
    const root = path.join(directory, name);
    fs.mkdirSync(root);
    const keys = new Map<string, string>();
    const vault = new LocalBackupVault(root, {
      async protect(key) {
        const reference = randomUUID();
        keys.set(reference, key);
        return Buffer.from(reference);
      },
      async unprotect(blob) {
        return defined(
          keys.get(blob.toString()),
          'Different fixture account cannot decrypt this key',
        );
      },
    });
    return { root, keys, vault, portable: new PortableBackup(root) };
  }
  const a = account('pc-a'),
    b = account('pc-b');
  async function archive(extra: FileEntry[] = []) {
    const root = fs.mkdtempSync(path.join(directory, 'original-'));
    const files: FileEntry[] = [
      {
        domain: 'data',
        path: 'state.json',
        text: JSON.stringify({
          conversationId: 'preserved-conversation',
          messages: [],
          workTasks: [],
          completions: [],
          settings: {},
        }),
      },
      ...extra,
    ];
    const entries: ArchiveEntry[] = [];
    for (const file of files) {
      const target = path.join(root, file.domain, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.text);
      entries.push({
        domain: file.domain,
        path: file.path,
        directory: false,
        size: Buffer.byteLength(file.text),
        executable: false,
        sha256: createHash('sha256').update(file.text).digest('hex'),
      });
    }
    const manifest: WorkerBackupManifest = {
      schemaVersion: 1,
      createdAt: 1700000000000,
      appVersion: '0.4.7-beta.9',
      sourceId: 'a'.repeat(64),
      files: files.length,
      bytes: entries.reduce((sum, item) => sum + item.size, 0),
    };
    const metadata: BackupMetadata = {
      id: randomUUID(),
      createdAt: manifest.createdAt,
      appVersion: manifest.appVersion,
      files: manifest.files,
      bytes: manifest.bytes,
      source: 'b'.repeat(12),
    };
    const bytes = await collect(archiveStream(root, manifest, entries));
    return { bytes, metadata, files };
  }
  async function saved(extra: FileEntry[] = []) {
    const value = await archive(extra);
    await a.vault.save(Readable.from([value.bytes]), value.metadata);
    return value;
  }
  return { directory, a, b, archive, saved };
}
async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of stream) {
    assert.ok(Buffer.isBuffer(value) || typeof value === 'string');
    chunks.push(typeof value === 'string' ? Buffer.from(value) : value);
  }
  return Buffer.concat(chunks);
}
async function exported(
  portable: PortableBackup,
  vault: LocalBackupVault,
  id: string,
  passphrase = PASSPHRASE,
) {
  const chunks: Buffer[] = [];
  const metadata = await portable.export({
    vault,
    id,
    passphrase,
    output: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  });
  return { bytes: Buffer.concat(chunks), metadata };
}
function header(bytes: Buffer) {
  const magic = bytes.indexOf(10) + 1,
    length = bytes.readUInt32BE(magic),
    start = magic + 4 + length;
  const parsed: unknown = JSON.parse(bytes.subarray(magic + 4, start).toString());
  assert.ok(isRecord(parsed));
  return { magic, start, parsed };
}
function changedHeader(bytes: Buffer, change: (value: Record<string, unknown>) => void) {
  const { magic, start, parsed } = header(bytes);
  change(parsed);
  const content = Buffer.from(JSON.stringify(parsed));
  const prefix = Buffer.from(bytes.subarray(0, magic + 4));
  prefix.writeUInt32BE(content.length, magic);
  return Buffer.concat([prefix, content, bytes.subarray(start)]);
}
function maliciousPackage(archive: Buffer, metadata: BackupMetadata) {
  const salt = Buffer.alloc(32, 9),
    iv = Buffer.alloc(12, 7);
  const record = {
    schema: 1,
    cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', N: 65536, r: 8, p: 1, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    metadata,
    archiveBytes: archive.length,
  };
  const bytes = Buffer.from(JSON.stringify(record)),
    magic = Buffer.from('DANT-PORTABLE-BACKUP/1\n'),
    length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const aad = Buffer.concat([magic, length, bytes]),
    key = scryptSync(PASSPHRASE, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    return Buffer.concat([aad, cipher.update(archive), cipher.final(), cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
}
test('portable encrypted backup crosses independent host accounts and filters authentication without deleting project modules', async (t) => {
  const f = fixture(t),
    value = await f.saved([
      { domain: 'data', path: 'memory/dant/notes.md', text: 'private user memory sentinel' },
      { domain: 'data', path: 'credentials/master.key', text: 'private vault master sentinel' },
      { domain: 'data', path: 'credentials/vault.enc', text: 'private credential sentinel' },
      { domain: 'data', path: 'telegram.json', text: 'telegram secret sentinel' },
      { domain: 'data', path: 'voice-key.backup.dpapi', text: 'voice secret sentinel' },
      {
        domain: 'workspace',
        path: 'src/credentials/model.ts',
        text: 'export const model = "preserve business code";',
      },
      { domain: 'workspace', path: 'fixtures/auth.json', text: '{"businessFixture":true}' },
      { domain: 'workspace', path: '.env.example', text: 'EXAMPLE=' },
      { domain: 'workspace', path: '.env.local', text: 'PRIVATE=private env sentinel' },
      { domain: 'workspace', path: '.git/config', text: 'remote with token sentinel' },
      { domain: 'workspace', path: '.git/HEAD', text: 'ref: refs/heads/main\n' },
      { domain: 'workspace', path: '.ssh/id_ed25519', text: 'ssh secret sentinel' },
    ]);
  const original = fs.readFileSync(f.a.vault.file(value.metadata.id));
  const one = await exported(f.a.portable, f.a.vault, value.metadata.id),
    two = await exported(f.a.portable, f.a.vault, value.metadata.id);
  assert.notDeepEqual(one.bytes, two.bytes);
  for (const sentinel of [
    PASSPHRASE,
    'private user memory sentinel',
    'private vault master sentinel',
    'ssh secret sentinel',
    ...f.a.keys.keys(),
  ])
    assert.equal(one.bytes.includes(Buffer.from(sentinel)), false);
  assert.equal(PORTABLE_MAX_FILE_BYTES, 16_173_244_459);
  assert.deepEqual(
    await f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([one.bytes.subarray(0, 30), one.bytes.subarray(30)]),
      passphrase: PASSPHRASE,
    }),
    one.metadata,
  );
  assert.ok(one.metadata.files < value.metadata.files);
  assert.ok(one.metadata.bytes < value.metadata.bytes);
  const opened = await f.b.vault.open(one.metadata.id);
  const staging = path.join(f.directory, 'verify-portable');
  fs.mkdirSync(staging);
  try {
    const decoded = await validateWorkerBackup({ input: opened.stream(), stagingDir: staging });
    assert.equal(decoded.manifest.files, one.metadata.files);
    assert.equal(decoded.manifest.bytes, one.metadata.bytes);
    assert.equal(
      fs.readFileSync(path.join(staging, 'data/memory/dant/notes.md'), 'utf8'),
      'private user memory sentinel',
    );
    for (const file of [
      'src/credentials/model.ts',
      'fixtures/auth.json',
      '.env.example',
      '.git/HEAD',
    ])
      assert.ok(fs.existsSync(path.join(staging, 'workspace', file)));
    for (const file of [
      'data/credentials',
      'data/telegram.json',
      'data/voice-key.backup.dpapi',
      'workspace/.env.local',
      'workspace/.git/config',
      'workspace/.ssh',
    ])
      assert.equal(fs.existsSync(path.join(staging, file)), false);
  } finally {
    await opened.close();
  }
  assert.deepEqual(fs.readFileSync(f.a.vault.file(value.metadata.id)), original);
  assert.deepEqual(fs.readdirSync(f.a.portable.directory), []);
  assert.deepEqual(fs.readdirSync(f.b.portable.directory), []);
  assert.notDeepEqual(fs.readFileSync(f.b.vault.file(one.metadata.id)), original);
});

test('wrong password, authenticated header, ciphertext, tag, truncation and trailing bytes fail before local-key creation', async (t) => {
  const f = fixture(t),
    value = await f.saved(),
    good = await exported(f.a.portable, f.a.vault, value.metadata.id);
  const start = header(good.bytes).start;
  const ciphertext = Buffer.from(good.bytes);
  ciphertext[start] = defined(ciphertext[start]) ^ 1;
  const tag = Buffer.from(good.bytes);
  tag[tag.length - 1] = defined(tag.at(-1)) ^ 1;
  const variants = [
    changedHeader(good.bytes, (v) => {
      const m = v.metadata;
      assert.ok(isRecord(m));
      m.appVersion = '9.9.9';
    }),
    changedHeader(good.bytes, (v) => {
      v.iv = Buffer.alloc(12, 8).toString('base64');
    }),
    ciphertext,
    tag,
    good.bytes.subarray(0, -1),
    Buffer.concat([good.bytes, Buffer.from([0])]),
    Buffer.from('invalid portable format'),
  ];
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([good.bytes]),
      passphrase: 'another incorrect password',
    }),
    { code: 'backup_invalid' },
  );
  for (const bytes of variants) {
    await assert.rejects(
      f.b.portable.import({
        vault: f.b.vault,
        input: Readable.from([bytes]),
        passphrase: PASSPHRASE,
      }),
      { code: 'backup_invalid' },
    );
    assert.deepEqual(fs.readdirSync(f.b.portable.directory), []);
  }
  assert.equal(f.b.keys.size, 0);
  assert.deepEqual(f.b.vault.list(), []);
});

test('fixed KDF parameters and bounded header/archive sizes reject inflation without deriving or persisting snapshots', async (t) => {
  const f = fixture(t),
    value = await f.saved(),
    good = await exported(f.a.portable, f.a.vault, value.metadata.id);
  for (const field of ['N', 'r', 'p']) {
    const bytes = changedHeader(good.bytes, (v) => {
      assert.ok(isRecord(v.kdf));
      v.kdf[field] = 1073741824;
    });
    await assert.rejects(
      f.b.portable.import({
        vault: f.b.vault,
        input: Readable.from([bytes]),
        passphrase: PASSPHRASE,
      }),
      { code: 'backup_invalid' },
    );
  }
  const large = changedHeader(good.bytes, (v) => {
    v.archiveBytes = PORTABLE_MAX_FILE_BYTES;
  });
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([large]),
      passphrase: PASSPHRASE,
    }),
    { code: 'backup_size_limit' },
  );
  const prefix = Buffer.from(good.bytes.subarray(0, header(good.bytes).magic + 4));
  prefix.writeUInt32BE(8193, header(good.bytes).magic);
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([prefix]),
      passphrase: PASSPHRASE,
    }),
    { code: 'backup_invalid' },
  );
  assert.equal(f.b.keys.size, 0);
  assert.deepEqual(fs.readdirSync(f.b.portable.directory), []);
});

test('a valid encrypted envelope carrying auth paths or invalid archive hashes cannot enter the local vault', async (t) => {
  const f = fixture(t);
  for (const entry of [
    { domain: 'data' as const, path: 'credentials/master.key', text: 'forbidden' },
    { domain: 'workspace' as const, path: '.git/config', text: 'forbidden remote' },
  ]) {
    const value = await f.archive([entry]);
    await assert.rejects(
      f.b.portable.import({
        vault: f.b.vault,
        input: Readable.from([maliciousPackage(value.bytes, value.metadata)]),
        passphrase: PASSPHRASE,
      }),
      { code: 'backup_invalid' },
    );
  }
  const value = await f.archive();
  const corrupted = Buffer.from(
    value.bytes.toString().replace(/"sha256":"[a-f0-9]{64}"/, '"sha256":"' + '0'.repeat(64) + '"'),
  );
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([maliciousPackage(corrupted, value.metadata)]),
      passphrase: PASSPHRASE,
    }),
    { code: 'backup_invalid' },
  );
  assert.equal(f.b.keys.size, 0);
  assert.deepEqual(f.b.vault.list(), []);
});

test('interrupted and aborted transfers preserve prior snapshots, clean ciphertext staging and never fall back to plaintext', async (t) => {
  const f = fixture(t),
    value = await f.saved(),
    good = await exported(f.a.portable, f.a.vault, value.metadata.id);
  await f.b.vault.save(Readable.from([value.bytes]), value.metadata);
  const previous = fs.readFileSync(f.b.vault.file(value.metadata.id));
  async function* failed() {
    yield good.bytes.subarray(0, good.bytes.length - 10);
    throw Error('isolated stream failure');
  }
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from(failed()),
      passphrase: PASSPHRASE,
    }),
    { code: 'backup_invalid' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([good.bytes]),
      passphrase: PASSPHRASE,
      signal: controller.signal,
    }),
  );
  assert.deepEqual(fs.readFileSync(f.b.vault.file(value.metadata.id)), previous);
  assert.deepEqual(fs.readdirSync(f.b.portable.directory), []);
  const root = path.join(f.directory, 'no-protection');
  fs.mkdirSync(root);
  await assert.rejects(
    f.b.portable.import({
      vault: new LocalBackupVault(root),
      input: Readable.from([good.bytes]),
      passphrase: PASSPHRASE,
    }),
    { code: 'backup_protection_unavailable' },
  );
  assert.deepEqual(fs.readdirSync(path.join(root, 'vm-backups')), []);
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([good.bytes]),
      passphrase: PASSPHRASE,
    }),
    { code: 'backup_exists' },
  );
  assert.deepEqual(fs.readFileSync(f.b.vault.file(value.metadata.id)), previous);
});

test('passphrase limits count exact UTF8 bytes and never trim or normalize the password', async (t) => {
  const f = fixture(t),
    value = await f.saved();
  for (const passphrase of ['', 'a'.repeat(11), 'a'.repeat(1025), '密'.repeat(342)]) {
    await assert.rejects(exported(f.a.portable, f.a.vault, value.metadata.id, passphrase), {
      code: 'backup_passphrase_invalid',
    });
    await assert.rejects(
      f.b.portable.import({ vault: f.b.vault, input: Readable.from([]), passphrase }),
      { code: 'backup_passphrase_invalid' },
    );
  }
  const unicode = await exported(f.a.portable, f.a.vault, value.metadata.id, '密'.repeat(4));
  assert.deepEqual(
    await f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([unicode.bytes]),
      passphrase: '密'.repeat(4),
    }),
    unicode.metadata,
  );
  const spaces = await exported(f.a.portable, f.a.vault, value.metadata.id, '  twelve spaces  ');
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([spaces.bytes]),
      passphrase: 'twelve spaces',
    }),
    { code: 'backup_invalid' },
  );
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([spaces.bytes]),
      passphrase: '  twelve spaces  ',
    }),
    { code: 'backup_exists' },
  );
  assert.equal(fs.readdirSync(f.b.portable.directory).length, 0);
});

test('large archives stream through ciphertext-only staging and preserve binary chunks across frame boundaries', async (t) => {
  const f = fixture(t),
    sentinel = 'private large plaintext sentinel '.repeat(20000),
    value = await f.saved([{ domain: 'workspace', path: 'project/notes.txt', text: sentinel }]);
  const good = await exported(f.a.portable, f.a.vault, value.metadata.id);
  let inspected = false;
  async function* incoming() {
    for (let position = 0; position < good.bytes.length; position += 8191) {
      yield good.bytes.subarray(position, position + 8191);
      if (!inspected && position > good.bytes.length / 2) {
        const names = fs.readdirSync(f.b.portable.directory);
        assert.equal(names.length, 1);
        const staged = fs.readFileSync(path.join(f.b.portable.directory, defined(names[0])));
        assert.equal(staged.includes(Buffer.from('private large plaintext sentinel')), false);
        inspected = true;
      }
    }
  }
  await f.b.portable.import({
    vault: f.b.vault,
    input: Readable.from(incoming()),
    passphrase: PASSPHRASE,
  });
  assert.equal(inspected, true);
  const opened = await f.b.vault.open(value.metadata.id),
    staging = path.join(f.directory, 'large-verify');
  fs.mkdirSync(staging);
  try {
    await validateWorkerBackup({ input: opened.stream(), stagingDir: staging });
    assert.equal(
      fs.readFileSync(path.join(staging, 'workspace/project/notes.txt'), 'utf8'),
      sentinel,
    );
  } finally {
    await opened.close();
  }
});

test('aborting an input stalled between chunks terminates the transfer instead of holding the backup slot', async (t) => {
  const f = fixture(t),
    value = await f.saved(),
    good = await exported(f.a.portable, f.a.vault, value.metadata.id);
  const controller = new AbortController();
  let supplied = false;
  const input = new Readable({
    read() {
      if (!supplied) {
        supplied = true;
        this.push(good.bytes.subarray(0, 100));
      }
    },
  });
  const pending = f.b.portable.import({
    vault: f.b.vault,
    input,
    passphrase: PASSPHRASE,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'backup_invalid' });
  assert.equal(input.destroyed, true);
  assert.deepEqual(fs.readdirSync(f.b.portable.directory), []);
  assert.deepEqual(f.b.vault.list(), []);
});

test('a changed source between export passes never produces an authenticated portable package', async (t) => {
  const f = fixture(t),
    value = await f.saved();
  let opens = 0;
  const changed = {
    async open(id: string, signal?: AbortSignal) {
      opens++;
      const snapshot = await f.a.vault.open(id, signal);
      if (opens === 2) {
        const source = snapshot.stream;
        return {
          ...snapshot,
          stream: () => {
            const raw = source();
            return Readable.from(
              (async function* () {
                for await (const chunk of raw) {
                  assert.ok(Buffer.isBuffer(chunk));
                  const next = Buffer.from(chunk);
                  if (next.length) next[next.length - 2] = defined(next[next.length - 2]) ^ 1;
                  yield next;
                }
              })(),
            );
          },
        };
      }
      return snapshot;
    },
    save: f.a.vault.save.bind(f.a.vault),
  };
  const chunks: Buffer[] = [];
  await assert.rejects(
    f.a.portable.export({
      vault: changed,
      id: value.metadata.id,
      passphrase: PASSPHRASE,
      output: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    }),
  );
  assert.equal(opens, 2);
  await assert.rejects(
    f.b.portable.import({
      vault: f.b.vault,
      input: Readable.from([Buffer.concat(chunks)]),
      passphrase: PASSPHRASE,
    }),
    { code: 'backup_invalid' },
  );
  assert.equal(f.b.keys.size, 0);
});

test('portable archive schema rejects traversal, repeated paths, unknown records and incomplete required state', async (t) => {
  const f = fixture(t),
    value = await f.archive();
  const lines = value.bytes.toString().trimEnd().split('\n');
  const records = lines.slice(1).map((line) => {
    const entry: unknown = JSON.parse(line);
    assert.ok(isRecord(entry));
    return entry;
  });
  const variants = [
    () => {
      const changed = structuredClone(records);
      defined(changed[1]).path = '../escape';
      return changed;
    },
    () => {
      const changed = structuredClone(records);
      defined(changed[0]).unexpected = 'unsupported field';
      return changed;
    },
    () => {
      const changed = structuredClone(records);
      changed.splice(changed.length - 1, 0, defined(changed[1]));
      return changed;
    },
    () => {
      const changed = structuredClone(records);
      defined(changed[1]).path = 'other.json';
      return changed;
    },
  ];
  for (const mutate of variants) {
    const bytes = Buffer.from(
      defined(lines[0]) +
        '\n' +
        mutate()
          .map((item) => JSON.stringify(item) + '\n')
          .join(''),
    );
    await assert.rejects(
      f.b.portable.import({
        vault: f.b.vault,
        input: Readable.from([maliciousPackage(bytes, value.metadata)]),
        passphrase: PASSPHRASE,
      }),
      { code: 'backup_invalid' },
    );
  }
  assert.equal(f.b.keys.size, 0);
  assert.deepEqual(fs.readdirSync(f.b.portable.directory), []);
});
