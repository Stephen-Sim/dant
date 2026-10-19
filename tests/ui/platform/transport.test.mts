import type { NativeApiRequest, TransportEvent } from '../../../ui/platform/transport.mts';
import { isRecord, requestError } from '../../../ui/shared/contracts.mts';
import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../../../ui/platform/transport.mts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const response = (value: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(value),
});
async function until(predicate: () => unknown) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Test condition was not reached');
    await pause(3);
  }
}

test('desktop JSON requests use the native bridge serially and recover after a failed request', async () => {
  const requests: NativeApiRequest[] = [];
  let active = 0,
    maximum = 0;
  const transport = createTransport({
    desktop: true,
    invokeRequest: async (command, args) => {
      assert.equal(command, 'api_request');
      active++;
      maximum = Math.max(maximum, active);
      requests.push(args);
      await pause(5);
      active--;
      return defined(args).route === '/api/fail'
        ? { status: 409, body: JSON.stringify({ error: 'Task changed', code: 'name_exists' }) }
        : response({ ok: true });
    },
  });
  transport.setToken('test-session');
  const results = await Promise.allSettled([
    transport.json('/api/settings', { method: 'PATCH', body: { language: 'en' } }),
    transport.json('/api/fail'),
    transport.json('/api/state'),
  ]);
  assert.equal(maximum, 1);
  assert.deepEqual(
    requests.map((item) => item.route),
    ['/api/settings', '/api/fail', '/api/state'],
  );
  assert.equal(defined(requests[0]).body, '{"language":"en"}');
  assert.equal(defined(requests[0]).token, 'test-session');
  assert.equal(defined(requests[2]).body, null);
  const rejected = defined(results[1]);
  assert.equal(rejected.status, 'rejected');
  if (rejected.status !== 'rejected') throw Error('Expected rejected request');
  assert.equal(requestError(rejected.reason).status, 409);
  assert.equal(requestError(rejected.reason).code, 'name_exists');
  assert.equal(results[2].status, 'fulfilled');
  transport.close();
});

test('a remote skill preview cannot delay native call shutdown or state polling', async () => {
  let finishPreview: ((value: ReturnType<typeof response>) => void) | undefined;
  const starts: string[] = [];
  const transport = createTransport({
    desktop: true,
    invokeRequest: async (_command, args) => {
      starts.push(defined(args).route);
      if (defined(args).route === '/api/skills/import/preview')
        return new Promise((resolve) => (finishPreview = resolve));
      return response({ ok: true });
    },
  });
  const preview = transport.json('/api/skills/import/preview', {
    method: 'POST',
    body: { url: 'https://github.com/example/skills' },
  });
  const stopping = transport.json('/api/call/stop', {
      method: 'POST',
      body: { callId: 'current' },
    }),
    reading = transport.json('/api/state');
  try {
    await until(() => starts.includes('/api/state'));
    assert.deepEqual(await stopping, { ok: true });
    assert.deepEqual(await reading, { ok: true });
  } finally {
    finishPreview?.(response({ id: 'preview' }));
    await preview;
    transport.close();
  }
});

test('a slow update check does not delay call shutdown or state polling over native IPC', async () => {
  let finishUpdate: ((value: ReturnType<typeof response>) => void) | undefined;
  const starts: string[] = [];
  const transport = createTransport({
    desktop: true,
    invokeRequest: async (_command, args) => {
      starts.push(defined(args).route);
      if (defined(args).route === '/api/updates')
        return new Promise((resolve) => {
          finishUpdate = resolve;
        });
      return response({ ok: true });
    },
  });
  const checking = transport.json('/api/updates');
  const stopping = transport.json('/api/call/stop', {
    method: 'POST',
    body: { callId: 'current-call' },
  });
  const reading = transport.json('/api/state');
  try {
    await until(() => starts.includes('/api/state'));
    assert.deepEqual(await stopping, { ok: true });
    assert.deepEqual(await reading, { ok: true });
    assert.deepEqual(starts, ['/api/updates', '/api/call/stop', '/api/state']);
  } finally {
    finishUpdate?.(response({ latestVersion: '0.4.5' }));
    await checking;
    transport.close();
  }
});

test('only exact stable/beta update reads and version reads bypass pending native mutations', async () => {
  let finishMutation: ((value: ReturnType<typeof response>) => void) | undefined;
  const starts: string[] = [];
  const transport = createTransport({
    desktop: true,
    invokeRequest: async (_command, args) => {
      starts.push(defined(args).route);
      if (defined(args).route === '/api/settings')
        return new Promise((resolve) => {
          finishMutation = resolve;
        });
      return response({ ok: true });
    },
  });
  const saving = transport.json('/api/settings', { method: 'PATCH', body: { language: 'en' } });
  await until(() => finishMutation);
  const version = transport.json('/api/version'),
    checking = transport.json('/api/updates'),
    beta = transport.json('/api/updates?channel=beta');
  const mutation = transport.json('/api/updates', { method: 'POST' }),
    other = transport.json('/api/updates/other'),
    invalid = transport.json('/api/updates?channel=other');
  try {
    await until(() => starts.includes('/api/version') && starts.includes('/api/updates'));
    assert.deepEqual(await version, { ok: true });
    assert.deepEqual(await checking, { ok: true });
    assert.deepEqual(await beta, { ok: true });
    assert.deepEqual(starts, [
      '/api/settings',
      '/api/version',
      '/api/updates',
      '/api/updates?channel=beta',
    ]);
  } finally {
    defined(finishMutation)(response({ ok: true }));
    await Promise.all([saving, mutation, other, invalid]);
    transport.close();
  }
  assert.deepEqual(starts, [
    '/api/settings',
    '/api/version',
    '/api/updates',
    '/api/updates?channel=beta',
    '/api/updates',
    '/api/updates/other',
    '/api/updates?channel=other',
  ]);
});

test('local recovery reads reach the authenticated native bridge while Reconnect blocks the mutation queue', async () => {
  let finishConnection: ((value: ReturnType<typeof response>) => void) | undefined;
  const requests: NativeApiRequest[] = [];
  const transport = createTransport({
    desktop: true,
    invokeRequest: async (command, request) => {
      assert.equal(command, 'api_request');
      requests.push(request);
      if (request.route === '/api/connect')
        return new Promise((resolve) => {
          finishConnection = resolve;
        });
      return response(
        request.route === '/api/session' ? { token: 'refreshed-session' } : { ok: true },
      );
    },
  });
  transport.setToken('current-session');
  const connecting = transport.json('/api/connect', {
    method: 'POST',
    body: { updateRunningWork: true },
  });
  await until(() => finishConnection);
  const session = transport.json('/api/session');
  const settings = transport.json('/api/controller/settings');
  const queued = [
    transport.json('/api/controller/settings', { method: 'PATCH', body: { language: 'en' } }),
    transport.json('/api/session', { method: 'POST' }),
    transport.json('/api/controller/settings?unsafe=1'),
    transport.json('/api/controller/settings/other'),
    transport.json('/api/state'),
  ];
  try {
    assert.deepEqual(await session, { token: 'refreshed-session' });
    assert.deepEqual(await settings, { ok: true });
    assert.deepEqual(
      requests.map(({ route, method, token, body }) => ({ route, method, token, body })),
      [
        {
          route: '/api/connect',
          method: 'POST',
          token: 'current-session',
          body: '{"updateRunningWork":true}',
        },
        { route: '/api/session', method: 'GET', token: 'current-session', body: null },
        { route: '/api/controller/settings', method: 'GET', token: 'current-session', body: null },
      ],
    );
    // Token refresh remains the caller's validated action. Queued mutations use
    // the current session when they actually cross the native boundary.
    transport.setToken('refreshed-session');
  } finally {
    defined(finishConnection)(response({ ok: true }));
    await Promise.all([connecting, ...queued]);
    transport.close();
  }
  assert.deepEqual(
    requests.slice(3).map(({ route, method, token }) => ({ route, method, token })),
    [
      { route: '/api/controller/settings', method: 'PATCH', token: 'refreshed-session' },
      { route: '/api/session', method: 'POST', token: 'refreshed-session' },
      { route: '/api/controller/settings?unsafe=1', method: 'GET', token: 'refreshed-session' },
      { route: '/api/controller/settings/other', method: 'GET', token: 'refreshed-session' },
      { route: '/api/state', method: 'GET', token: 'refreshed-session' },
    ],
  );
});

test('independent recovery reads retain native authentication and reject an unconfirmed response', async () => {
  const transport = createTransport({
    desktop: true,
    invokeRequest: async (_command, request) => {
      assert.equal(request.token, 'expired-session');
      if (request.route === '/api/controller/settings')
        return { status: 401, body: '{"error":"Unauthorized"}' };
      return { status: 200, body: 'not JSON' };
    },
  });
  transport.setToken('expired-session');
  await assert.rejects(
    transport.json('/api/controller/settings'),
    (error) => requestError(error).status === 401,
  );
  await assert.rejects(transport.json('/api/session'), /Invalid JSON/);
  transport.close();
});

test('desktop state polling waits until the prior request completes and never opens browser streams', async () => {
  let finishFirst: (() => void) | undefined,
    finishSecond: (() => void) | undefined,
    firstCompleted = 0;
  const starts: number[] = [],
    events: TransportEvent[] = [];
  class ForbiddenStream {
    declare onopen: null;
    declare onmessage: null;
    declare onerror: null;
    declare onclose: null;
    addEventListener() {}
    close() {}

    constructor() {
      throw new Error('Desktop must not use browser event streams');
    }
  }
  const transport = createTransport({
    desktop: true,
    pollDelay: 20,
    EventSourceImpl: ForbiddenStream,
    WebSocketImpl: ForbiddenStream,
    invokeRequest: async (_command, args) => {
      assert.equal(defined(args).route, '/api/state');
      starts.push(Date.now());
      return new Promise((resolve) => {
        if (starts.length === 1)
          finishFirst = () => {
            firstCompleted = Date.now();
            resolve(response({ number: 1 }));
          };
        else finishSecond = () => resolve(response({ number: 2 }));
      });
    },
  });
  transport.startEvents({ onEvent: (event) => events.push(event) });
  await until(() => finishFirst);
  await pause(25);
  assert.equal(starts.length, 1, 'an unresolved state request must not overlap another poll');
  defined(finishFirst)();
  await until(() => finishSecond);
  assert.ok(defined(starts[1]) - firstCompleted >= 18, 'the poll delay begins after completion');
  transport.stopEvents();
  defined(finishSecond)();
  await pause(25);
  assert.equal(starts.length, 2);
  assert.deepEqual(
    events.map((event) => {
      assert.ok(isRecord(event.data));
      return event.data.number;
    }),
    [1],
    'responses from a stopped poll must be discarded',
  );
});

test('browser state uses SSE first, handles named and envelope events, and falls back to WebSocket', () => {
  const sources: Source[] = [],
    sockets: Socket[] = [],
    events: TransportEvent[] = [];
  class Source {
    url: string;
    handlers: Record<string, (event: MessageEvent) => void>;
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      this.handlers = {};
      sources.push(this);
    }
    addEventListener(name: string, listener: (event: MessageEvent) => void) {
      this.handlers[name] = listener;
    }
    close() {
      this.closed = true;
    }
  }
  class Socket {
    url: string;
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const transport = createTransport({
    desktop: false,
    origin: 'http://127.0.0.1:4318',
    EventSourceImpl: Source,
    WebSocketImpl: Socket,
  });
  transport.setToken('test-token');
  transport.startEvents({ onEvent: (event) => events.push(event) });
  assert.equal(sources.length, 1);
  assert.equal(sockets.length, 0);
  assert.equal(defined(sources[0]).url, '/api/events?token=test-token');
  defined(defined(sources[0]).handlers.state)(
    new MessageEvent('message', { data: '{"messages":[]}' }),
  );
  defined(defined(sources[0]).onmessage)(
    new MessageEvent('message', { data: '{"type":"notice","data":{"message":"ready"}}' }),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['state', 'notice'],
  );
  defined(defined(sources[0]).onerror)();
  assert.equal(defined(sources[0]).closed, true);
  assert.equal(defined(sockets[0]).url, 'ws://127.0.0.1:4318/events?token=test-token');
  defined(defined(sources[0]).onerror)();
  defined(defined(sources[0]).handlers.state)(
    new MessageEvent('message', { data: '{"messages":["stale"]}' }),
  );
  assert.equal(
    sockets.length,
    1,
    'a closed SSE connection must not create duplicate fallback sockets',
  );
  assert.equal(events.length, 2, 'closed SSE events must not overwrite a newer transport');
  defined(defined(sockets[0]).onmessage)(
    new MessageEvent('message', { data: '{"type":"state","data":{"messages":[1]}}' }),
  );
  assert.deepEqual(
    (() => {
      const value = defined(events.at(-1)).data;
      assert.ok(isRecord(value));
      return value.messages;
    })(),
    [1],
  );
  transport.stopEvents();
  defined(defined(sources[0]).handlers.state)(
    new MessageEvent('message', { data: '{"messages":[2]}' }),
  );
  assert.equal(events.length, 3, 'events from the previous transport must be ignored');
});

test('JSON transport rejects invalid responses and external or traversing routes', async () => {
  let requests = 0;
  const transport = createTransport({
    desktop: false,
    fetchRequest: async () => {
      requests++;
      return { status: 200, text: async () => '<html>not JSON</html>' };
    },
  });
  await assert.rejects(transport.json('https://example.test/api/state'), /Invalid local API route/);
  await assert.rejects(transport.json('/api/../state'), /Invalid local API route/);
  assert.equal(requests, 0);
  await assert.rejects(transport.json('/api/state'), /Invalid JSON response/);
  transport.close();
});

test('ambiguous mutations retain their outcome marker across HTTP and native IPC failures', async () => {
  const browser = createTransport({
    desktop: false,
    fetchRequest: async () => ({
      status: 502,
      text: async () => JSON.stringify({ error: 'Result unconfirmed', unknownOutcome: true }),
    }),
  });
  await assert.rejects(
    browser.json('/api/messages', { method: 'POST', body: { text: 'one attempt' } }),
    (error) => isRecord(error) && error.status === 502 && error.unknownOutcome === true,
  );
  const native = createTransport({
    desktop: true,
    invokeRequest: async () => {
      throw 'The request outcome is unconfirmed. It has not been resent.';
    },
  });
  await assert.rejects(
    native.json('/api/messages', { method: 'POST', body: { text: 'one attempt' } }),
    (error) =>
      error instanceof Error &&
      isRecord(error) &&
      error.unknownOutcome === true &&
      /unconfirmed/.test(error.message),
  );
  await assert.rejects(
    native.json('/api/state'),
    (error) => error instanceof Error && isRecord(error) && !error.unknownOutcome,
    'a failed read does not create a mutation warning',
  );
  browser.close();
  native.close();
});
