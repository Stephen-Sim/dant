import { defined } from '../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { DiagnosticSink, ObservedMessage } from '../../src/diagnostics/diagnostic-events.mts';
type DiagnosticEntry = { event: string } & Record<string, unknown>;
type ObservedEngine = {
  call: { id: string; provider: string; status: string; sdp?: string } | null;
};
import {
  diagnosticRoute,
  diagnosticRpcMethod,
  observeHttp,
  observeTasks,
  observeBridge,
  serviceVersion,
  diagnosticWorkerStatus,
} from '../../src/diagnostics/diagnostic-events.mts';

test('HTTP diagnostics retain templates and fixed reasons, never route parameters or query/body/header values', () => {
  const entries: DiagnosticEntry[] = [],
    logger: DiagnosticSink = { log: (event, metadata) => entries.push({ event, ...metadata }) };
  let now = 10;
  const middleware = observeHttp(logger, { now: () => now });
  function request(url: string, status: number, duration = 5, method = 'POST') {
    const req = {
        originalUrl: url,
        method,
        body: { secret: 'private-body' },
        headers: { authorization: 'private-header' },
      },
      res = Object.assign(new EventEmitter(), { statusCode: status });
    let next = false;
    middleware(req, res, () => (next = true));
    assert.equal(next, true);
    now += duration;
    res.emit('finish');
  }
  request('/api/credentials/private-name?token=private-query', 409);
  request('/api/private-path/private-file', 500);
  request('/api/messages', 200);
  request('/api/state', 200, 2001, 'GET');
  request('/api/events', 200, 60000, 'GET');
  request('/assets/private.png', 404);
  request('/api/settings', 400, 1, 'invalid-method');
  assert.deepEqual(
    entries.map((entry) => [entry.route, entry.status, entry.reason]),
    [
      ['/api/credentials/:id', 409, 'conflict'],
      ['/api/:unknown', 500, 'server-error'],
      ['/api/state', 200, 'slow-request'],
      ['/api/settings', 400, 'request-rejected'],
    ],
  );
  assert.equal(defined(entries.at(-1)).method, 'OTHER');
  assert.equal(JSON.stringify(entries).includes('private-'), false);
  for (const [url, expected] of [
    ['/api/messages/sensitive/reaction', '/api/messages/:id/reaction'],
    ['/api/skills/sensitive', '/api/skills/:name'],
    ['/api/notifications/sensitive/ack', '/api/notifications/:id/ack'],
    ['/api/state?key=secret', '/api/state'],
  ])
    assert.equal(diagnosticRoute(url), expected);
  assert.equal(diagnosticRpcMethod('turn/start'), 'turn/start');
  assert.equal(diagnosticRpcMethod('secret/value'), 'other');
  assert.equal(diagnosticWorkerStatus('unexpected private text'), 'unknown');
  assert.equal(serviceVersion('/missing-test-project'), 'unknown');
});

test('task and call diagnostics log transitions once without reading message text or replaying historical tasks', () => {
  const entries: DiagnosticEntry[] = [],
    logger: DiagnosticSink = { log: (event, metadata) => entries.push({ event, ...metadata }) },
    store: { state: { messages: ObservedMessage[] } } = {
      state: {
        messages: [{ id: 'old', role: 'user', status: 'review', text: 'historical private text' }],
      },
    },
    engine: ObservedEngine = { call: null };
  const observe = observeTasks(logger, store, engine);
  observe();
  assert.deepEqual(entries, Array<DiagnosticEntry>());
  const message = { id: 'new', role: 'user', status: 'queued', text: 'new private text' };
  store.state.messages.push(message);
  observe();
  observe();
  message.status = 'accepted';
  observe();
  observe();
  assert.equal(defined(entries.at(-1)).status, 'accepted');
  message.status = 'running';
  engine.call = { id: 'call', provider: 'subscription', status: 'connected', sdp: 'private-sdp' };
  observe();
  observe();
  engine.call = null;
  observe();
  assert.deepEqual(
    entries.map((entry) => entry.event),
    ['task.status', 'task.status', 'task.status', 'call.status', 'call.closed'],
  );
  assert.equal(JSON.stringify(entries).includes('private'), false);
  store.state.messages = [];
  observe();
  store.state.messages = [{ id: 'new', role: 'user', status: 'paused' }];
  observe();
  assert.equal(defined(entries.at(-1)).status, 'paused');
});

test('normal call startup is connecting while unknown provider states remain bounded', () => {
  const entries: DiagnosticEntry[] = [],
    logger: DiagnosticSink = { log: (event, metadata) => entries.push({ event, ...metadata }) },
    store: { state: { messages: ObservedMessage[] } } = { state: { messages: [] } },
    engine: ObservedEngine = { call: null },
    observe = observeTasks(logger, store, engine);
  engine.call = { id: 'call', provider: 'subscription', status: 'connecting' };
  observe();
  observe();
  engine.call.status = 'negotiating';
  observe();
  engine.call.status = 'connected';
  observe();
  engine.call.status = 'private unexpected status';
  observe();
  engine.call.provider = 'private-provider';
  engine.call.status = 'starting';
  observe();
  assert.deepEqual(
    entries.map((entry) => entry.status),
    ['connecting', 'negotiating', 'connected', 'unknown', 'starting'],
  );
  assert.equal(defined(entries.at(-1)).provider, 'unknown');
  assert.doesNotMatch(JSON.stringify(entries), /private/);
});

test('task action diagnostics distinguish registered task routes without retaining IDs or reference queries', () => {
  for (const action of ['accept', 'pause', 'resume', 'cancel', 'priority', 'dismiss', 'context'])
    assert.equal(
      diagnosticRoute(
        '/api/tasks/private-task-id/' +
          action +
          '?turnId=private-turn&conversationId=private-conversation&token=private-token',
      ),
      '/api/tasks/:id/' + action,
    );
  for (const action of ['pause', 'resume', 'clear-completed'])
    assert.equal(
      diagnosticRoute('/api/tasks/' + action + '?token=private-token'),
      '/api/tasks/' + action,
    );
  assert.equal(
    diagnosticRoute('/api/messages/private-message/output-link/resolve?token=private-token'),
    '/api/messages/:id/output-link/resolve',
  );
  for (const route of [
    '/api/tasks/private-task/private-action',
    '/api/tasks/private-task/context/extra',
    '/api/tasks/private-task/contextual',
  ])
    assert.equal(diagnosticRoute(route), '/api/:unknown');
});

test('VM service update diagnostics retain fixed update phases and reasons without forwarding raw bridge data', () => {
  const bridge = new EventEmitter(),
    entries: DiagnosticEntry[] = [],
    detach = observeBridge({ log: (event, fields) => entries.push({ event, ...fields }) }, bridge);
  bridge.emit('diagnostic', {
    event: 'vm.service-update',
    fields: {
      status: 'checking',
      phase: 'prepare',
      targetVersion: '0.4.7-beta.7',
      runningVersion: '0.4.7-beta.6',
      reason: null,
    },
  });
  bridge.emit('diagnostic', {
    event: 'vm.service-update',
    fields: {
      status: 'failed',
      phase: 'pause',
      reason: 'pause-unconfirmed',
      stage: 'post-pause',
      targetVersion: '0.4.7-beta.7',
      runningVersion: '0.4.7-beta.6',
      exitCode: 1,
      attempt: 1,
      durationMs: 15000,
      unknownOutcome: true,
      stdout: 'PRIVATE stdout',
      error: Error('PRIVATE path'),
      binding: { host: 'PRIVATE host' },
      task: { text: 'PRIVATE message' },
      body: 'PRIVATE body',
    },
  });
  assert.deepEqual(entries, [
    {
      event: 'vm.service-update',
      status: 'checking',
      phase: 'prepare',
      targetVersion: '0.4.7-beta.7',
      runningVersion: '0.4.7-beta.6',
    },
    {
      event: 'vm.service-update',
      status: 'failed',
      phase: 'pause',
      reason: 'pause-unconfirmed',
      stage: 'post-pause',
      targetVersion: '0.4.7-beta.7',
      runningVersion: '0.4.7-beta.6',
      durationMs: 15000,
      attempt: 1,
      exitCode: 1,
      unknownOutcome: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE|stdout|binding|body|task/);
  detach();
  bridge.emit('diagnostic', { event: 'vm.service-update', fields: { status: 'current' } });
  assert.equal(entries.length, 2);
  assert.equal(bridge.listenerCount('diagnostic'), 0);
});

test('VM update diagnostics distinguish the explicit idle witness and rollback failures', () => {
  const bridge = new EventEmitter(),
    entries: DiagnosticEntry[] = [],
    detach = observeBridge({ log: (event, fields) => entries.push({ event, ...fields }) }, bridge);
  for (const stage of ['final', 'rollback'])
    bridge.emit('diagnostic', {
      event: 'vm.service-update',
      fields: {
        status: 'failed',
        phase: 'prepare',
        reason: 'idle-unconfirmed',
        stage,
        exitCode: 1,
      },
    });
  assert.deepEqual(
    entries.map(({ reason, stage }) => ({ reason, stage })),
    [
      { reason: 'idle-unconfirmed', stage: 'final' },
      { reason: 'idle-unconfirmed', stage: 'rollback' },
    ],
  );
  detach();
});

test('VM diagnostics ignore unknown fields, getters, invalid events and logger failures without affecting bridge events', () => {
  const bridge = new EventEmitter(),
    entries: DiagnosticEntry[] = [],
    detach = observeBridge({ log: (event, fields) => entries.push({ event, ...fields }) }, bridge);
  for (const value of [
    null,
    [],
    Error('PRIVATE'),
    { event: 'PRIVATE', fields: { status: 'failed' } },
    { event: 'vm.service-update', fields: { status: 'PRIVATE status' } },
    { event: 'vm.service-update', fields: [] },
  ])
    bridge.emit('diagnostic', value);
  const accessor = { event: 'vm.service-update' };
  Object.defineProperty(accessor, 'fields', {
    get() {
      assert.fail('Do not read a diagnostic getter');
    },
  });
  bridge.emit('diagnostic', accessor);
  const fields = {
    status: 'pending',
    phase: 'PRIVATE phase',
    reason: 'private-secret-label',
    stage: 'PRIVATE stage',
    targetVersion: 'PRIVATE version',
    runningVersion: '0.4.7-beta.6 PRIVATE',
    attempt: -1,
    durationMs: Infinity,
    exitCode: '1',
    unknownOutcome: 'true',
  };
  Object.defineProperty(fields, 'error', {
    get() {
      assert.fail('Do not read raw errors');
    },
  });
  bridge.emit('diagnostic', { event: 'vm.service-update', fields });
  assert.deepEqual(entries, [{ event: 'vm.service-update', status: 'pending' }]);
  detach();
  const stop = observeBridge(
    {
      log() {
        throw Error('PRIVATE diagnostic failure');
      },
    },
    bridge,
  );
  assert.doesNotThrow(() =>
    bridge.emit('diagnostic', {
      event: 'vm.service-update',
      fields: { status: 'failed', reason: 'update-failed' },
    }),
  );
  stop();
});

test('an HTTP response closed before finish logs one metadata-only client abort and detaches both listeners', () => {
  const entries: DiagnosticEntry[] = [],
    logger: DiagnosticSink = { log: (event, metadata) => entries.push({ event, ...metadata }) };
  let now = 100;
  const middleware = observeHttp(logger, { now: () => now }),
    res = Object.assign(new EventEmitter(), { statusCode: 200 });
  middleware(
    {
      originalUrl: '/api/files/private-filename?token=private-query',
      method: 'GET',
      body: { text: 'private-body' },
      headers: { authorization: 'private-header' },
    },
    res,
    () => {},
  );
  now = 10421.4;
  res.emit('close');
  res.emit('finish');
  res.emit('close');
  assert.deepEqual(entries, [
    {
      event: 'http.request',
      method: 'GET',
      route: '/api/files/:id',
      status: 499,
      durationMs: 10321,
      reason: 'client-aborted',
    },
  ]);
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(JSON.stringify(entries).includes('private-'), false);
});

test('ordinary response finish suppresses a later close, including fast responses intentionally omitted from diagnostics', () => {
  const entries: DiagnosticEntry[] = [],
    logger: DiagnosticSink = { log: (event, metadata) => entries.push({ event, ...metadata }) };
  let now = 0;
  const middleware = observeHttp(logger, { now: () => now });
  for (const [status, duration] of [
    [200, 10],
    [503, 20],
    [200, 2500],
  ] as const) {
    const res = Object.assign(new EventEmitter(), { statusCode: status });
    middleware({ url: '/api/screen', method: 'GET' }, res, () => {});
    now += duration;
    res.emit('finish');
    res.emit('close');
    assert.equal(res.listenerCount('close'), 0);
  }
  assert.deepEqual(
    entries.map((entry) => [entry.status, entry.reason, entry.durationMs]),
    [
      [503, 'server-error', 20],
      [200, 'slow-request', 2500],
    ],
  );
});

test('an actual client disconnect while a desktop response is pending records 499 without payload or URL parameters', async (t) => {
  const entries: DiagnosticEntry[] = [],
    middleware = observeHttp({ log: (event, metadata) => entries.push({ event, ...metadata }) });
  let entered: (() => void) | undefined, closed: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => (entered = resolve)),
    disconnected = new Promise<void>((resolve) => (closed = resolve)),
    server = http.createServer((req, res) =>
      middleware(req, res, () => {
        res.once('close', () => defined(closed)());
        defined(entered)();
      }),
    );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = http.request({
    host: '127.0.0.1',
    port: address.port,
    path: '/api/screen?token=private-query',
    headers: { Authorization: 'private-header' },
    method: 'GET',
  });
  request.on('error', () => {});
  request.end();
  await pending;
  request.destroy();
  await disconnected;
  assert.equal(entries.length, 1);
  assert.equal(defined(entries[0]).status, 499);
  assert.equal(defined(entries[0]).reason, 'client-aborted');
  assert.equal(defined(entries[0]).route, '/api/screen');
  const duration = defined(entries[0]).durationMs;
  assert.ok(typeof duration === 'number' && duration >= 0);
  assert.equal(JSON.stringify(entries).includes('private-'), false);
});
