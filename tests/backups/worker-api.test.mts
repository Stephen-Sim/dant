import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createWorkerApp } from '../../src/app/server.mts';
import { VoiceKeyStore } from '../../src/security/secrets.mts';
import { validateWorkerBackup } from '../../src/backups/archive-stream.mts';
import { WORKER_RESTORE_RECEIPT_FILE } from '../../src/backups/worker-restore.mts';
import { ConnectionStatus, TaskStatus, PlanStepStatus } from '../../src/contracts/states.mts';
import {
  WorkerServiceFixture,
  activeTaskFixture,
  engineCallFixture,
  listeningPort,
  observedRecord,
} from '../support/service-fixtures.mts';

async function fixture(t: TestContext) {
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
