import portableFixture from './testdata/portable-backup.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createBackupTransfer,
  validBackupPassphrase,
  WEB_BACKUP_MAX_BYTES,
  BACKUP_PASSPHRASE_MIN_BYTES,
  BACKUP_PASSPHRASE_MAX_BYTES,
  BACKUP_TRANSFER_TIMEOUT_MS,
} from '../../../ui/platform/backup-transfer.mts';
import type { CoreModule } from '../../../ui/shared/contracts.mts';
import type { BackupMetadata } from '../../../ui/settings/backup-types.ts';

const ID = '00000000-0000-4000-8000-000000000009',
  TOKEN = 'a'.repeat(64),
  PASSWORD = 'isolated passphrase';
const metadata: BackupMetadata = portableFixture.metadata;
const portableBytes = Buffer.from(portableFixture.base64, 'base64');

test('browser import and export apply the same bounded transfer deadline', async () => {
  const timeout = AbortSignal.timeout,
    deadlines: number[] = [];
  AbortSignal.timeout = (duration) => {
    deadlines.push(duration);
    return new AbortController().signal;
  };
  try {
    const port = createBackupTransfer({
      getToken: () => TOKEN,
      saveBlob() {},
      fetchRequest: async (url) =>
        url.endsWith('/export')
          ? new Response(portableBytes, { headers: { 'Content-Type': 'application/octet-stream' } })
          : Response.json({ backup: metadata }),
    });
    assert.equal(await port.exportBackup(ID, PASSWORD), true);
    assert.deepEqual(
      await port.importBackup(PASSWORD, new File([portableBytes], 'fixture.dant')),
      metadata,
    );
    assert.equal(BACKUP_TRANSFER_TIMEOUT_MS, 1_800_000);
    assert.deepEqual(deadlines, [BACKUP_TRANSFER_TIMEOUT_MS, BACKUP_TRANSFER_TIMEOUT_MS]);
  } finally {
    AbortSignal.timeout = timeout;
  }
});
test('Go, browser and native portable limits agree without importing Node runtime into the browser', () => {
  assert.ok(portableBytes.subarray(0, 22).toString().startsWith('DANT-PORTABLE-BACKUP/1'));
  const source = fs.readFileSync(
    new URL('../../../src-tauri/src/backup_transfer.rs', import.meta.url),
    'utf8',
  );
  const match = /const MAX_PORTABLE_BYTES: u64 = ([\d_]+);/.exec(source);
  assert.ok(match?.[1]);
  assert.equal(Number(match[1].replaceAll('_', '')), portableFixture.maxFileBytes);
  assert.equal(BACKUP_PASSPHRASE_MIN_BYTES, portableFixture.passphraseMinBytes);
  assert.equal(BACKUP_PASSPHRASE_MAX_BYTES, portableFixture.passphraseMaxBytes);
  assert.equal(validBackupPassphrase('中文中文'), true);
  assert.equal(validBackupPassphrase('中文'), false);
  assert.equal(validBackupPassphrase('x'.repeat(1025)), false);
});

test('native invocation carries only IDs, in-memory session and passphrase, with no destination or URL', async () => {
  const calls: { name: string; args: Record<string, unknown> | undefined }[] = [];
  const port = createBackupTransfer({
    desktop: true,
    getToken: () => TOKEN,
    loadCore: async () => ({
      invoke: async (name, args) => {
        calls.push({ name, args });
        return name === 'export_dant_backup' ? true : metadata;
      },
    }),
  });
  assert.equal(await port.exportBackup(ID, PASSWORD), true);
  assert.deepEqual(await port.importBackup(PASSWORD), metadata);
  assert.deepEqual(calls, [
    { name: 'export_dant_backup', args: { backupId: ID, token: TOKEN, passphrase: PASSWORD } },
    { name: 'import_dant_backup', args: { token: TOKEN, passphrase: PASSWORD } },
  ]);
});

test('native cancellation, validation and unknown outcomes do not resubmit a transfer or reveal raw errors', async () => {
  let count = 0;
  let invoke: CoreModule['invoke'] = async () => {
    count++;
    return null;
  };
  const port = createBackupTransfer({
    desktop: true,
    getToken: () => TOKEN,
    loadCore: async () => ({ invoke: (name, args) => invoke(name, args) }),
  });
  assert.equal(await port.importBackup(PASSWORD), null);
  invoke = async () => false;
  assert.equal(await port.exportBackup(ID, PASSWORD), false);
  await assert.rejects(port.exportBackup('../outside', PASSWORD), { code: 'backup_invalid' });
  await assert.rejects(port.importBackup('short'), { code: 'backup_passphrase_invalid' });
  invoke = async () => {
    throw 'raw private native failure';
  };
  await assert.rejects(port.importBackup(PASSWORD), {
    code: 'backup_transfer_unconfirmed',
    message: 'backup_transfer_unconfirmed',
  });
  assert.equal(count, 1);
  const invalid = createBackupTransfer({
    desktop: true,
    getToken: () => '',
    loadCore: async () => ({ invoke: async () => assert.fail('no invalid session IPC') }),
  });
  await assert.rejects(invalid.importBackup(PASSWORD), { code: 'backup_transfer_failed' });
});

test('browser export uses the fixed local API and bounds memory even when Content-Length is absent or wrong', async () => {
  let saved: Blob | null = null;
  let mode = 'small',
    cancelled = 0;
  const port = createBackupTransfer({
    getToken: () => TOKEN,
    saveBlob: (blob, name) => {
      saved = blob;
      assert.equal(name, `dant-backup-${ID}.dant`);
    },
    fetchRequest: async (url, options) => {
      assert.equal(url, `/api/backups/${ID}/export`);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      if (mode === 'small')
        return new Response(portableBytes, {
          headers: {
            'Content-Length': String(portableBytes.byteLength),
            'Content-Type': 'application/octet-stream',
          },
        });
      if (mode === 'declared')
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          {
            headers: {
              'Content-Length': String(WEB_BACKUP_MAX_BYTES + 1),
              'Content-Type': 'application/octet-stream',
            },
          },
        );
      const chunk = new Uint8Array(1024 * 1024);
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { 'Content-Type': 'application/octet-stream' } },
      );
    },
  });
  assert.equal(await port.exportBackup(ID, PASSWORD), true);
  const savedBlob = (): Blob | null => saved;
  const actual = savedBlob();
  assert.ok(actual);
  assert.deepEqual(Buffer.from(await actual.arrayBuffer()), portableBytes);
  mode = 'declared';
  await assert.rejects(port.exportBackup(ID, PASSWORD), { code: 'backup_size_limit' });
  mode = 'stream';
  await assert.rejects(port.exportBackup(ID, PASSWORD), { code: 'backup_size_limit' });
  assert.equal(cancelled, 2);
});

test('browser import rejects oversized files before upload and only imports authenticated metadata', async () => {
  const phrase = '中文中文',
    file = new File([portableBytes], 'fixture.dant');
  let count = 0;
  const port = createBackupTransfer({
    getToken: () => TOKEN,
    fetchRequest: async (url, options) => {
      count++;
      assert.equal(url, '/api/backups/import');
      assert.equal(options.body, file);
      const headers = new Headers(options.headers);
      assert.equal(
        Buffer.from(headers.get('X-Dant-Backup-Passphrase') ?? '', 'base64').toString(),
        phrase,
      );
      assert.equal(headers.get('X-Dant-Token'), TOKEN);
      return Response.json({ backup: metadata });
    },
  });
  assert.deepEqual(await port.importBackup(phrase, file), metadata);
  class LargeFile extends File {
    override get size() {
      return WEB_BACKUP_MAX_BYTES + 1;
    }
  }
  await assert.rejects(port.importBackup(phrase, new LargeFile([], 'large.dant')), {
    code: 'backup_size_limit',
  });
  assert.equal(count, 1);
  await assert.rejects(port.importBackup(phrase), { code: 'backup_invalid' });
  const wrong = createBackupTransfer({
    getToken: () => TOKEN,
    fetchRequest: async () =>
      Response.json({ code: 'backup_invalid', error: 'private server data' }, { status: 400 }),
  });
  await assert.rejects(wrong.importBackup(phrase, file), {
    code: 'backup_invalid',
    message: 'backup_invalid',
  });
});
