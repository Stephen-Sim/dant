import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createWorkerApp } from '../../src/app/server.mts';
import type { WorkerAppOptions } from '../../src/app/worker-app-types.ts';
import type {
  AsyncWorkerBackupOptions,
  AsyncWorkerBackupSnapshot,
} from '../../src/backups/archive-types.ts';
import { createWorkerBackup } from '../../src/backups/worker-archive.mts';
import { VoiceKeyStore } from '../../src/security/secrets.mts';
import { backupError, validateWorkerBackup } from '../../src/backups/archive-stream.mts';
import { WORKER_RESTORE_RECEIPT_FILE } from '../../src/backups/worker-restore.mts';
import { ConnectionStatus, TaskStatus, PlanStepStatus } from '../../src/contracts/states.mts';
import {
  WorkerServiceFixture,
  activeTaskFixture,
  engineCallFixture,
  listeningPort,
  observedRecord,
} from '../support/service-fixtures.mts';

async function fixture(
  t: TestContext,
  options: Pick<WorkerAppOptions, 'backupSnapshotFactory'> = {},
) {
  const parent = path.resolve('.cache/tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'worker-backup-api-')),
    dataDir = path.join(root, 'data'),
    worker = new WorkerServiceFixture();
  worker.status = ConnectionStatus.Online;
  worker.error = null;
  worker.models = null;
  worker.rpc = null;
  worker.workspaceRoot = path.join(root, 'workspaces');
  worker.disconnect = () => {
    worker.status = ConnectionStatus.Offline;
  };
  const app = createWorkerApp({
    dataDir,
    workerFactory: () => worker,
    secretFactory: (dir) => new VoiceKeyStore(dir, { env: {}, platform: 'linux' }),
    ...options,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${listeningPort(app.server)}`,
    session: unknown = await fetch(base + '/api/session').then((response) => response.json()),
    token = observedRecord(session).token;
  assert.ok(typeof token === 'string');
  return { ...app, dataDir, root, base, headers: { 'X-Dant-Token': token } };
}
test('authenticated idle Worker export stages real data and advertises the stream metadata without executing work', async (t) => {
  const { base, headers, engine, root, store } = await fixture(t);
  assert.equal((await fetch(base + '/api/backups/export')).status, 401);
  const state: unknown = await fetch(base + '/api/state', { headers }).then((response) =>
    response.json(),
  );
  assert.equal(observedRecord(observedRecord(state).capabilities).backups, true);
  const historical = store.registerWork({
    turnId: 'ended-unknown-turn',
    title: 'Retained unconfirmed history',
    source: 'voice',
    status: TaskStatus.Unknown,
    plan: { steps: [{ step: 'Reconcile before continuing', status: PlanStepStatus.Pending }] },
  });
  store.updateRegisteredWork(historical.turnId, { executionEnded: true });
  const response = await fetch(base + '/api/backups/export', { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/x-dant-backup');
  const encodedMetadata = response.headers.get('x-dant-backup-metadata');
  assert.ok(encodedMetadata);
  const metadata = observedRecord(
      JSON.parse(Buffer.from(encodedMetadata, 'base64').toString('utf8')),
    ),
    stagingDir = path.join(root, 'decoded');
  fs.mkdirSync(stagingDir);
  const decoded = await validateWorkerBackup({
    input: Readable.from([Buffer.from(await response.arrayBuffer())]),
    stagingDir,
  });
  assert.equal(metadata.files, decoded.manifest.files);
  assert.equal(metadata.bytes, decoded.manifest.bytes);
  assert.equal(metadata.createdAt, decoded.manifest.createdAt);
  assert.equal(metadata.appVersion, decoded.manifest.appVersion);
  assert.equal(engine.active, null);
  assert.deepEqual(engine.queue, []);
  assert.equal(
    store.state.workTasks.find((record) => record.id === historical.id)?.status,
    TaskStatus.Unknown,
  );
});
test('portable Worker backups retain durable preferences and never contain the RAM-only call caption', async (t) => {
  const { base, headers, engine, root, store } = await fixture(t),
    call = engineCallFixture({
      id: 'backup-caption-call',
      provider: 'subscription',
      status: 'connected',
    }),
    phrase = 'BACKUP_MUST_NOT_CAPTURE_LIVE_SPEECH';
  engine.call = call;
  engine.emit('realtime', {
    method: 'dant/call/subtitle',
    params: { callId: call.id, provider: call.provider, sequence: 1, text: phrase, final: true },
  });
  const live = observedRecord(await (await fetch(base + '/api/state', { headers })).json());
  assert.equal(observedRecord(live.callCaption).text, phrase);
  engine.call = null;
  engine.change();
  store.state.settings.showCallCaptions = false;
  const response = await fetch(base + '/api/backups/export', { headers });
  assert.equal(response.status, 200);
  const stagingDir = path.join(root, 'caption-decoded');
  fs.mkdirSync(stagingDir);
  const decoded = await validateWorkerBackup({
      input: Readable.from([Buffer.from(await response.arrayBuffer())]),
      stagingDir,
    }),
    persisted = fs.readFileSync(path.join(decoded.directory, 'data', 'state.json'), 'utf8'),
    state = observedRecord(JSON.parse(persisted));
  assert.equal(observedRecord(state.settings).showCallCaptions, false);
  assert.doesNotMatch(persisted, /callCaption|BACKUP_MUST_NOT_CAPTURE_LIVE_SPEECH/);
  assert.equal(
    observedRecord(await (await fetch(base + '/api/state', { headers })).json()).callCaption,
    null,
  );
});

test('busy exports defer without pausing an active task, call, queue or taking over the computer', async (t) => {
  const { base, headers, engine, store } = await fixture(t);
  for (const kind of ['task', 'call', 'queue', 'control'] as const) {
    const active = activeTaskFixture();
    if (kind === 'task') engine.active = active;
    if (kind === 'call') engine.call = engineCallFixture();
    if (kind === 'queue')
      engine.queue = [store.add({ role: 'user', text: 'Keep queued', status: TaskStatus.Queued })];
    if (kind === 'control') engine.takeover = true;
    const response = await fetch(base + '/api/backups/export', { headers });
    assert.equal(response.status, 409, kind);
    assert.equal(observedRecord(await response.json()).code, 'backup_busy');
    if (kind === 'task') {
      assert.equal(engine.active, active);
      assert.equal(active.stopRequested, undefined);
    }
    engine.active = null;
    engine.call = null;
    engine.queue = [];
    engine.takeover = false;
  }
});

test('a locked data SQLite snapshot defers with a bounded diagnostic and succeeds after the writer releases it', async (t) => {
  const { base, headers, engine, root, dataDir, diagnostics } = await fixture(t),
    privateName = 'private-user-project-credential.sqlite',
    database = new DatabaseSync(path.join(dataDir, privateName));
  t.mock.method(os, 'tmpdir', () => root);
  try {
    database.exec('CREATE TABLE private_records(value); BEGIN EXCLUSIVE');
    const response = await fetch(base + '/api/backups/export', { headers });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'The work computer is busy or changed during backup.',
      code: 'backup_busy',
    });
    const events = diagnostics.recent(50),
      failure = events.find((event) => event.event === 'backup.export.failed');
    assert.ok(failure);
    assert.equal(failure.stage, 'snapshot');
    assert.equal(failure.reason, 'sqlite_busy');
    assert.equal(failure.code, 'backup_busy');
    assert.equal(JSON.stringify(events).includes(privateName), false);
    assert.equal(JSON.stringify(events).includes('private_records'), false);
    assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('dant-worker-backup-')));
    assert.equal(engine.active, null);
    assert.deepEqual(engine.queue, []);
    database.exec('ROLLBACK');
    const retry = await fetch(base + '/api/backups/export', { headers });
    assert.equal(retry.status, 200);
    await retry.arrayBuffer();
  } finally {
    if (database.isTransaction) database.exec('ROLLBACK');
    database.close();
  }
});

test('unexpected snapshot errors retain a generic response and never expose exception details in diagnostics', async (t) => {
  const secret = 'private-disk-token-and-user-content',
    { base, headers, diagnostics } = await fixture(t, {
      backupSnapshotFactory: async () => {
        throw Object.assign(Error(secret), { code: secret, path: secret });
      },
    });
  const response = await fetch(base + '/api/backups/export', { headers });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'The work computer backup could not be created.',
    code: 'backup_failed',
  });
  const events = diagnostics.recent(50),
    failure = events.find((event) => event.event === 'backup.export.failed');
  assert.ok(failure);
  assert.equal(failure.stage, 'snapshot');
  assert.equal(failure.reason, 'generic');
  assert.equal(failure.code, 'backup_failed');
  assert.equal(JSON.stringify(events).includes(secret), false);
});

function snapshotBarrier() {
  let enter = (_options: AsyncWorkerBackupOptions) => {},
    release = () => {};
  const entered = new Promise<AsyncWorkerBackupOptions>((resolve) => {
      enter = resolve;
    }),
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
  let captured: AsyncWorkerBackupSnapshot | undefined,
    cleaned = 0;
  return {
    entered,
    release,
    cleaned: () => cleaned,
    snapshot: () => captured,
    factory: async (options: AsyncWorkerBackupOptions): Promise<AsyncWorkerBackupSnapshot> => {
      enter(options);
      const signal = options.signal;
      let abort = () => {};
      try {
        await Promise.race([
          released,
          new Promise<void>((_resolve, reject) => {
            abort = () => reject(backupError('backup_busy'));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          }),
        ]);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
      const original = createWorkerBackup(options);
      captured = {
        ...original,
        cleanup: async () => {
          cleaned++;
          original.stream.destroy();
          original.cleanup();
        },
      };
      return captured;
    },
  };
}

test('a staged export leaves state requests responsive and rejects concurrent exports immediately', async (t) => {
  const barrier = snapshotBarrier(),
    { base, headers } = await fixture(t, { backupSnapshotFactory: barrier.factory }),
    pending = fetch(base + '/api/backups/export', { headers });
  await barrier.entered;
  try {
    const state = await fetch(base + '/api/state', {
      headers,
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(state.status, 200);
    const second = await fetch(base + '/api/backups/export', {
      headers,
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(second.status, 409);
    assert.equal(observedRecord(await second.json()).code, 'backup_busy');
  } finally {
    barrier.release();
  }
  const exported = await pending;
  assert.equal(exported.status, 200);
  await exported.arrayBuffer();
});

test('work that starts and ends while staging invalidates the capture and cleans it before returning a conflict', async (t) => {
  const barrier = snapshotBarrier(),
    { base, headers, engine } = await fixture(t, { backupSnapshotFactory: barrier.factory }),
    pending = fetch(base + '/api/backups/export', { headers });
  await barrier.entered;
  engine.active = activeTaskFixture();
  engine.change();
  engine.active = null;
  engine.change();
  barrier.release();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal(observedRecord(await response.json()).code, 'backup_busy');
  assert.equal(barrier.cleaned(), 1);
  assert.equal(barrier.snapshot()?.stream.destroyed, true);
  assert.equal(engine.active, null);
});

test('work admitted while staging continues unchanged and prevents a successful export', async (t) => {
  const barrier = snapshotBarrier(),
    { base, headers, engine } = await fixture(t, { backupSnapshotFactory: barrier.factory }),
    pending = fetch(base + '/api/backups/export', { headers });
  await barrier.entered;
  const active = activeTaskFixture();
  engine.active = active;
  barrier.release();
  try {
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal(observedRecord(await response.json()).code, 'backup_busy');
    assert.equal(engine.active, active);
    assert.equal(active.stopRequested, undefined);
    assert.equal(barrier.cleaned(), 1);
  } finally {
    engine.active = null;
  }
});

test('a disconnected export cancels staging and releases its scoped admission listener', async (t) => {
  const barrier = snapshotBarrier(),
    { base, headers, engine } = await fixture(t, { backupSnapshotFactory: barrier.factory }),
    initialListeners = engine.listenerCount('change'),
    controller = new AbortController(),
    pending = fetch(base + '/api/backups/export', { headers, signal: controller.signal }),
    options = await barrier.entered;
  controller.abort();
  await assert.rejects(pending);
  for (
    let attempt = 0;
    attempt < 200 && engine.listenerCount('change') !== initialListeners;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(options.signal?.aborted, true);
  assert.equal(engine.listenerCount('change'), initialListeners);
  assert.equal(engine.active, null);
});

test('closing the Worker cancels and awaits a pending snapshot before finishing shutdown', async (t) => {
  const barrier = snapshotBarrier(),
    app = await fixture(t, { backupSnapshotFactory: barrier.factory }),
    pending = fetch(app.base + '/api/backups/export', { headers: app.headers }),
    options = await barrier.entered;
  const result = pending.catch(() => undefined);
  await app.close();
  const response = await result;
  if (response) assert.equal(response.status, 409);
  assert.equal(options.signal?.aborted, true);
  assert.equal(barrier.snapshot(), undefined);
});

test('a state-save permission failure is diagnosed separately without starting a snapshot or work', async (t) => {
  const { base, headers, store, engine, diagnostics } = await fixture(t),
    secret = 'private-state-path-and-credential',
    save = store.save.bind(store);
  let rejectSave = true;
  t.mock.method(store, 'save', () => {
    if (rejectSave) throw Object.assign(Error(secret), { code: 'EACCES', path: secret });
    return save();
  });
  try {
    const response = await fetch(base + '/api/backups/export', { headers });
    assert.equal(response.status, 400);
    assert.equal(observedRecord(await response.json()).code, 'backup_failed');
    const events = diagnostics.recent(50),
      failure = events.find((event) => event.event === 'backup.export.failed');
    assert.ok(failure);
    assert.equal(failure.stage, 'state_save');
    assert.equal(failure.reason, 'fs_permission');
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(engine.active, null);
    assert.deepEqual(engine.queue, []);
  } finally {
    rejectSave = false;
  }
});

test('an unsafe data source remains rejected and reports only a fixed source reason', async (t) => {
  const { base, headers, dataDir, diagnostics } = await fixture(t),
    privatePath = path.join(dataDir, 'private-linked-token.txt'),
    contents = 'private-customer-document';
  fs.writeFileSync(privatePath, contents);
  fs.linkSync(privatePath, path.join(dataDir, 'private-hardlink-token.txt'));
  const response = await fetch(base + '/api/backups/export', { headers });
  assert.equal(response.status, 400);
  assert.equal(observedRecord(await response.json()).code, 'backup_failed');
  const events = diagnostics.recent(50),
    failure = events.find((event) => event.event === 'backup.export.failed');
  assert.ok(failure);
  assert.equal(failure.stage, 'snapshot');
  assert.equal(failure.reason, 'invalid_source');
  assert.equal(JSON.stringify(events).includes('private-'), false);
  assert.equal(fs.readFileSync(privatePath, 'utf8'), contents);
});
test('restore confirmation reports only the data loaded by this Worker process', async (t) => {
  const { base, headers, dataDir } = await fixture(t);
  const before: unknown = await fetch(base + '/api/backups/info', { headers }).then((response) =>
    response.json(),
  );
  assert.deepEqual(before, { restored: false, restoreId: null });
  fs.writeFileSync(
    path.join(dataDir, WORKER_RESTORE_RECEIPT_FILE),
    JSON.stringify({ restored: true, restoreId: randomUUID() }),
  );
  const after: unknown = await fetch(base + '/api/backups/info', { headers }).then((response) =>
    response.json(),
  );
  assert.deepEqual(
    after,
    before,
    'a replaced marker must never confirm that an old process loaded restored data',
  );
});

test('aborting a real export closes the source stream and removes only its private staged files', async (t) => {
  const { base, headers, root, engine } = await fixture(t);
  t.mock.method(os, 'tmpdir', () => root);
  fs.mkdirSync(engine.workspaceRoot, { recursive: true });
  const descriptor = fs.openSync(
    path.join(engine.workspaceRoot, 'large-isolated-output.bin'),
    'wx',
  );
  try {
    fs.ftruncateSync(descriptor, 16 * 1024 * 1024);
  } finally {
    fs.closeSync(descriptor);
  }
  const controller = new AbortController(),
    response = await fetch(base + '/api/backups/export', { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.ok(fs.readdirSync(root).some((name) => name.startsWith('dant-worker-backup-')));
  const body = response.body;
  assert.ok(body);
  const reader = body.getReader();
  await reader.read();
  controller.abort();
  try {
    await reader.cancel();
  } catch {}
  for (
    let attempt = 0;
    attempt < 200 && fs.readdirSync(root).some((name) => name.startsWith('dant-worker-backup-'));
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('dant-worker-backup-')));
  assert.ok(fs.existsSync(path.join(engine.workspaceRoot, 'large-isolated-output.bin')));
  assert.equal(engine.active, null);
});
