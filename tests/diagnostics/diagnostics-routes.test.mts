import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkerApp } from '../../src/app/server.mts';
import { createControllerApp } from '../../src/app/controller.mts';
import { Diagnostics } from '../../src/diagnostics/diagnostics.mts';
import type { DiagnosticsOptions } from '../../src/diagnostics/diagnostics.mts';
import {
  ControllerBridgeFixture,
  ProvisioningFixture,
  WorkerServiceFixture,
  listeningPort,
  observedRecord,
  observedRecords,
} from '../support/service-fixtures.mts';
import { RpcFixture } from '../support/protocol-fixtures.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';

const testRoot = path.resolve('.cache/tests');
fs.mkdirSync(testRoot, { recursive: true });
class Worker extends WorkerServiceFixture {
  constructor() {
    super();
    this.status = 'online';
    this.rpc = Object.assign(new RpcFixture(), { reply() {}, send() {} });
  }
  disconnect() {
    this.status = 'offline';
    this.emit('status');
  }
  async request() {
    return {};
  }
}
class Provisioning extends ProvisioningFixture {
  snapshot() {
    return { status: 'idle' };
  }
  close() {}
}
class Bridge extends ControllerBridgeFixture {
  requests: string[];
  failRequest = false;
  constructor() {
    super();
    this.status = 'offline';
    this.requests = [];
    this.cached = {
      settings: { language: 'zh', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    };
  }
  async request(route: string) {
    this.requests.push(route);
    if (this.failRequest) throw Error('private SSH error');
    return Response.json({
      status: { role: 'vm-worker', retentionDays: 3 },
      recent: [{ event: 'service.started' }],
    });
  }
  close() {
    this.status = 'offline';
    this.emit('change');
  }
}
async function createFixture(t: NodeTestContext, mode: 'worker' | 'controller') {
  const dir = fs.mkdtempSync(path.join(testRoot, 'diagnostics-route-')),
    worker = new Worker(),
    bridge = new Bridge();
  let timerCallback: (() => void) | undefined,
    cancelled = 0;
  const diagnosticsFactory = (options: DiagnosticsOptions) =>
    new Diagnostics({
      ...options,
      schedule: (callback) => {
        timerCallback = callback;
        return setInterval(() => {}, 60_000).unref();
      },
      cancel: (timer) => {
        clearInterval(timer);
        cancelled++;
      },
    });
  const instance =
    mode === 'worker'
      ? createWorkerApp({ dataDir: dir, workerFactory: () => worker, diagnosticsFactory })
      : createControllerApp({
          dataDir: dir,
          projectRoot: path.resolve('.'),
          bridgeFactory: () => bridge,
          provisioningFactory: () => new Provisioning(),
          diagnosticsFactory,
          profileOptions: {
            registryFile: path.join(dir, 'registry.json'),
            includeProject: false,
            candidateDirs: [],
            env: {},
          },
        });
  t.after(async () => {
    await instance.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', () => resolve()));
  const base = 'http://127.0.0.1:' + listeningPort(instance.server),
    { token } = await fetch(base + '/api/session').then(async (response) =>
      observedRecord(await response.json()),
    );
  assert.ok(typeof token === 'string');
  return {
    instance,
    worker,
    bridge,
    dir,
    base,
    headers: { 'X-Dant-Token': token, 'Content-Type': 'application/json' },
    timer: () => timerCallback,
    cancelled: () => cancelled,
  };
}
type FixtureCommon = Omit<Awaited<ReturnType<typeof createFixture>>, 'instance'>;
function fixture(
  t: NodeTestContext,
  mode: 'worker',
): Promise<FixtureCommon & { instance: ReturnType<typeof createWorkerApp> }>;
function fixture(
  t: NodeTestContext,
  mode: 'controller',
): Promise<FixtureCommon & { instance: ReturnType<typeof createControllerApp> }>;
function fixture(t: NodeTestContext, mode: 'worker' | 'controller') {
  return createFixture(t, mode);
}

test('Worker diagnostics require session auth, are read-only, redact payloads and close their timer', async (t) => {
  const { instance, worker, dir, base, headers, timer, cancelled } = await fixture(t, 'worker');
  assert.equal((await fetch(base + '/api/diagnostics?privateQuery=hidden')).status, 401);
  assert.equal(
    (
      await fetch(base + '/api/diagnostics', {
        headers: { ...headers, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  worker.emit('diagnostic', 'private-raw-stderr');
  worker.emit('lifecycle', {
    code: 'rpc.timeout',
    method: 'turn/start',
    count: 1,
    durationMs: 60000,
    error: 'private-error',
    body: { secret: 'private-body' },
  });
  assert.ok(instance.nativeVoice instanceof NativeRealtimeVoice);
  instance.nativeVoice.emit('diagnostic', {
    code: 'voice_shutdown',
    callId: 'test-call',
    reason: 'notification-buffer',
    confirmed: true,
    executorStopped: true,
    payload: 'private-image',
  });
  worker.error = 'private-worker-error';
  worker.status = 'offline';
  worker.emit('status');
  worker.emit('status');
  instance.nativeVoice.emit('diagnostic', {
    code: 'voice_handoff_tracked',
    callId: 'test-call',
    turnId: 'test-turn',
    count: 1,
    payload: 'private-spoken-text',
  });
  instance.nativeVoice.emit('diagnostic', {
    code: 'voice_handoff_confirmed',
    callId: 'test-call',
    count: 1,
    text: 'private-transcript',
  });
  instance.nativeVoice.emit('diagnostic', {
    code: 'voice_observer_payload_omitted',
    callId: 'test-call',
    method: 'item/completed',
    itemType: 'mcpToolCall',
    itemStatus: 'completed',
    itemId: 'screenshot-1',
    eventBytes: 1049077,
    bytes: 240,
    count: 1,
    output: 'private-large-output',
    arguments: { secret: 'private-argument' },
  });
  const message = instance.store.add({ role: 'user', text: 'private-prompt', status: 'queued' });
  instance.engine.change();
  message.status = 'review';
  instance.engine.change();
  assert.equal(
    (
      await fetch(base + '/api/credentials/private-name?privateQuery=hidden', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ secret: 'private-secret' }),
      })
    ).status,
    400,
  );
  const response = await fetch(base + '/api/diagnostics', { headers });
  assert.equal(response.status, 200);
  const result = observedRecord(await response.json());
  assert.equal(observedRecord(result.status).role, 'vm-worker');
  assert.equal(observedRecord(result.status).retentionDays, 3);
  assert.equal(
    observedRecord(result.status).version,
    observedRecord(JSON.parse(fs.readFileSync('package.json', 'utf8'))).version,
  );
  assert.ok(observedRecords(result.recent).some((entry) => entry.event === 'rpc.timeout'));
  assert.ok(observedRecords(result.recent).some((entry) => entry.event === 'voice_shutdown'));
  assert.equal(
    observedRecords(result.recent).filter(
      (entry) => entry.event === 'worker.status' && entry.status === 'offline',
    ).length,
    1,
  );
  assert.ok(
    observedRecords(result.recent).some(
      (entry) => entry.event === 'http.request' && entry.route === '/api/credentials/:id',
    ),
  );
  assert.ok(
    observedRecords(result.recent).some(
      (entry) => entry.event === 'task.status' && entry.status === 'review',
    ),
  );
  assert.ok(
    observedRecords(result.recent).some(
      (entry) =>
        entry.event === 'voice_handoff_tracked' &&
        entry.turnId === 'test-turn' &&
        entry.count === 1,
    ),
  );
  assert.ok(
    observedRecords(result.recent).some(
      (entry) => entry.event === 'voice_handoff_confirmed' && entry.count === 1,
    ),
  );
  assert.ok(
    observedRecords(result.recent).some(
      (entry) =>
        entry.event === 'voice_observer_payload_omitted' &&
        entry.itemType === 'mcpToolCall' &&
        entry.itemStatus === 'completed' &&
        entry.itemId === 'screenshot-1' &&
        entry.eventBytes === 1049077 &&
        entry.bytes === 240,
    ),
  );
  assert.equal(JSON.stringify(result).includes('private-'), false);
  const mutation = await fetch(base + '/api/diagnostics', { method: 'DELETE', headers });
  assert.equal(mutation.status, 405);
  assert.equal(fs.readdirSync(path.join(dir, 'logs')).length, 1);
  const cleanup = defined(timer());
  await instance.close();
  assert.equal(instance.diagnostics.status().closed, true);
  assert.equal(cancelled(), 1);
  assert.equal(defined(instance.diagnostics.recent(50).at(-1)).event, 'service.closed');
  assert.equal(cleanup(), false);
  await instance.close();
  assert.equal(cancelled(), 1);
});

test('Controller diagnostics aggregate only an online Worker and retain fixed offline/failure results', async (t) => {
  const { instance, bridge, base, headers } = await fixture(t, 'controller');
  assert.equal((await fetch(base + '/api/diagnostics')).status, 401);
  let result = await fetch(base + '/api/diagnostics', { headers }).then((response) =>
    response.json().then(observedRecord),
  );
  assert.deepEqual(result.worker, { available: false, reason: 'worker-unavailable' });
  assert.equal(bridge.requests.length, 0);
  bridge.status = 'online';
  bridge.emit('change');
  bridge.emit('state', {
    messages: [],
    settings: {},
    worker: { status: 'offline', error: 'private cached model error' },
    queue: [],
  });
  result = await fetch(base + '/api/diagnostics', { headers }).then((response) =>
    response.json().then(observedRecord),
  );
  assert.equal(observedRecord(result.worker).available, true);
  assert.equal(observedRecord(observedRecord(result.worker).status).role, 'vm-worker');
  assert.deepEqual(bridge.requests, ['/api/diagnostics']);
  assert.ok(
    observedRecords(result.recent).some(
      (entry) => entry.event === 'bridge.status' && entry.status === 'online',
    ),
  );
  assert.ok(
    observedRecords(result.recent).some((entry) => entry.event === 'worker.status' && entry.cached),
  );
  assert.equal(JSON.stringify(result).includes('private'), false);
  bridge.failRequest = true;
  result = await fetch(base + '/api/diagnostics', { headers }).then((response) =>
    response.json().then(observedRecord),
  );
  assert.deepEqual(result.worker, { available: false, reason: 'worker-unavailable' });
  assert.equal(
    (await fetch(base + '/api/diagnostics', { method: 'POST', headers, body: '{}' })).status,
    405,
  );
  assert.equal(bridge.requests.length, 2);
  await instance.close();
  assert.equal(instance.diagnostics.status().closed, true);
});
