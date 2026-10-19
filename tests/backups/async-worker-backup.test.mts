import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkerBackupAsync } from '../../src/backups/async-worker-backup.mts';
import { validateWorkerBackup } from '../../src/backups/archive-stream.mts';
import { workerBackupFailure } from '../../src/backups/backup-diagnostics.mts';
import {
  readBackupThreadManifest,
  readBackupThreadOptions,
} from '../../src/backups/async-worker-backup-protocol.mts';
import { BACKUP_MAX_BYTES, BACKUP_MAX_FILES } from '../../src/backups/backup-constants.mts';
import type { AsyncWorkerBackupOptions } from '../../src/backups/archive-types.ts';

function fixture(t: TestContext) {
  const parent = path.resolve('.cache/tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'async-worker-backup-')),
    dataDir = path.join(root, 'data'),
    workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ messages: [] }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options: AsyncWorkerBackupOptions = {
    dataDir,
    workspaceRoot,
    temporaryRoot: root,
    appVersion: '1.2.3',
    sourceId: 'isolated-runtime',
  };
  return { root, options };
}

test('the background snapshot transfers a bounded readable archive and removes its private container', async (t) => {
  const { root, options } = fixture(t),
    expected = Buffer.alloc(2 * 1024 * 1024, 31);
  fs.writeFileSync(path.join(options.workspaceRoot, 'isolated-output.bin'), expected);
  const snapshot = await createWorkerBackupAsync(options),
    decoded = path.join(root, 'decoded');
  fs.mkdirSync(decoded);
  try {
    const archive = await validateWorkerBackup({ input: snapshot.stream, stagingDir: decoded });
    assert.equal(archive.manifest.sourceId, options.sourceId);
    assert.equal(archive.manifest.files, 2);
    assert.deepEqual(
      fs.readFileSync(path.join(decoded, 'workspace', 'isolated-output.bin')),
      expected,
    );
  } finally {
    await snapshot.cleanup();
  }
  assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('dant-worker-backup-job-')));
  assert.ok(fs.existsSync(path.join(options.workspaceRoot, 'isolated-output.bin')));
});

test('an aborted background staging job settles once and removes only its captured temporary container', async (t) => {
  const { root, options } = fixture(t),
    controller = new AbortController(),
    untouched = path.join(root, 'untouched.txt');
  fs.writeFileSync(untouched, 'keep');
  const pending = createWorkerBackupAsync({ ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'backup_busy' });
  assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('dant-worker-backup-job-')));
  assert.equal(fs.readFileSync(untouched, 'utf8'), 'keep');
});

test('background staging errors preserve only the fixed failure classification and clean staged files', async (t) => {
  const { root, options } = fixture(t),
    source = path.join(options.dataDir, 'private-source.txt');
  fs.writeFileSync(source, 'secret-content');
  fs.linkSync(source, path.join(options.dataDir, 'private-link.txt'));
  await assert.rejects(createWorkerBackupAsync(options), (error: unknown) => {
    assert.deepEqual(workerBackupFailure(error), {
      reason: 'invalid_source',
      status: 400,
      code: 'backup_failed',
    });
    assert.equal(String(error).includes('private-'), false);
    assert.equal(String(error).includes('secret-content'), false);
    return true;
  });
  assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('dant-worker-backup-job-')));
});

test('cancelling an unconsumed transferred stream closes the producer and makes cleanup idempotent', async (t) => {
  const { root, options } = fixture(t),
    controller = new AbortController(),
    snapshot = await createWorkerBackupAsync({ ...options, signal: controller.signal });
  controller.abort();
  await Promise.all([snapshot.cleanup(), snapshot.cleanup()]);
  assert.equal(snapshot.stream.destroyed, true);
  assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('dant-worker-backup-job-')));
  assert.ok(fs.existsSync(path.join(options.dataDir, 'state.json')));
});

test('thread boundaries reject wrong identities, excessive counts, invalid timestamps and unsafe inputs', (t) => {
  const { options } = fixture(t),
    manifest = {
      schemaVersion: 1,
      createdAt: 1_700_000_000_000,
      appVersion: options.appVersion,
      sourceId: options.sourceId,
      files: 2,
      bytes: 100,
    };
  assert.deepEqual(readBackupThreadManifest(manifest, options), manifest);
  for (const invalid of [
    null,
    { ...manifest, schemaVersion: 2 },
    { ...manifest, createdAt: 0 },
    { ...manifest, createdAt: Infinity },
    { ...manifest, appVersion: '9.9.9' },
    { ...manifest, sourceId: 'different-runtime' },
    { ...manifest, files: BACKUP_MAX_FILES + 1 },
    { ...manifest, bytes: BACKUP_MAX_BYTES + 1 },
  ])
    assert.throws(() => readBackupThreadManifest(invalid, options), { code: 'invalid_backup' });
  assert.deepEqual(readBackupThreadOptions(options), options);
  for (const invalid of [
    null,
    { ...options, dataDir: 'relative' },
    { ...options, workspaceRoot: 'relative' },
    { ...options, temporaryRoot: 'relative' },
    { ...options, appVersion: 'private-invalid-value' },
    { ...options, sourceId: 'private source' },
  ])
    assert.throws(() => readBackupThreadOptions(invalid), { code: 'invalid_backup' });
});
