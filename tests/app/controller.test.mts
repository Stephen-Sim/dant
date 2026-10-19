import {
  ControllerBridgeFixture,
  ProvisioningFixture,
  listeningPort,
  deferred,
  observedRecord,
  observedRecords,
} from '../support/service-fixtures.mts';
import type { ControllerAppOptions } from '../../src/app/controller-types.ts';
import type { VmObservation } from '../../src/computer/vm-observation-types.ts';
import type { VmConnectOptions, VmRequestOptions } from '../../src/computer/vm-bridge.mts';
import { isRecord, errorMessage } from '../../src/contracts/json.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createControllerApp } from '../../src/app/controller.mts';
import { VmBridge } from '../../src/computer/vm-bridge.mts';
import { assertVmRuntime } from '../../src/runtime/local-worker.mts';
import { appearanceDefaults, appearanceKeys } from '../../src/settings/appearance.mts';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
const temporary = (t: NodeTestContext) => {
  const dir = fs.mkdtempSync(path.join(root, 'controller-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
class FakeProvisioning extends ProvisioningFixture {
  snapshot() {
    return { status: 'idle', running: false };
  }
  providers() {
    return {
      selected: 'auto',
      provider: 'vmware',
      availableProviders: [
        { id: 'hyperv', available: false },
        { id: 'vmware', available: true },
      ],
    };
  }
  resumeMonitoring() {
    return this.snapshot();
  }
  close() {}
}
class FakeBridge extends ControllerBridgeFixture {
  constructor() {
    super();
    this.status = 'offline';
    this.error = null;
    this.requests = [];
  }
  declare requests: Array<{ route: string } & VmRequestOptions>;
  declare fail: boolean;
  declare pauses: number;
  emit(event: string | symbol, ...args: unknown[]) {
    const state = args[0];
    if (event === 'state' && isRecord(state))
      state.settings = {
        language: 'zh',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(isRecord(state.settings) ? state.settings : {}),
      };
    return super.emit(event, ...args);
  }
  async refresh(_force?: boolean) {
    return this.cached;
  }
  async pauseWorkForUpdate() {
    this.pauses = (this.pauses || 0) + 1;
    return this.cached;
  }
  async request(route: string, options: VmRequestOptions = {}) {
    this.requests.push({ route, ...options });
    if (this.fail)
      throw Object.assign(Error('Unknown outcome; not resent'), {
        unknownOutcome: true,
        status: 502,
      });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  close() {}
  disconnect() {
    this.status = 'offline';
    this.emit('change');
  }
}
function listen(t: NodeTestContext, dir: string): ReturnType<typeof listenWithBridge<FakeBridge>>;
function listen<Bridge extends FakeBridge>(
  t: NodeTestContext,
  dir: string,
  bridge: Bridge,
  options?: ControllerAppOptions,
): ReturnType<typeof listenWithBridge<Bridge>>;
function listen(
  t: NodeTestContext,
  dir: string,
  bridge = new FakeBridge(),
  options: ControllerAppOptions = {},
) {
  return listenWithBridge(t, dir, bridge, options);
}
async function listenWithBridge<Bridge extends FakeBridge>(
  t: NodeTestContext,
  dir: string,
  bridge: Bridge,
  options: ControllerAppOptions = {},
) {
  const app = createControllerApp({
    dataDir: dir,
    projectRoot: path.resolve('.'),
    bridgeFactory: () => bridge,
    provisioningFactory: () => new FakeProvisioning(),
    profileOptions: {
      registryFile: path.join(dir, 'registry.json'),
      includeProject: false,
      candidateDirs: [],
      env: {},
    },
    ...options,
  });
  t.after(() => app.close());
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${listeningPort(app.server)}`;
  const session = await fetch(base + '/api/session').then((response) => response.json());
  return {
    app,
    bridge,
    base,
    session,
    headers: { 'X-Dant-Token': session.token, 'Content-Type': 'application/json' },
  };
}

test('the private VM credential and skill tool bridge cannot be proxied through the Controller', async (t) => {
  const { base, headers, bridge } = await listen(t, temporary(t));
  const response = await fetch(base + '/api/internal/credentials', {
    method: 'POST',
    headers,
    body: JSON.stringify({ tool: 'credential_get', arguments: { id: 'target' } }),
  });
  assert.equal(response.status, 403);
  assert.equal(bridge.requests.length, 0);
});

test('task replies and recurring schedule fields require a fresh explicit worker capability before forwarding', async (t) => {
  const dir = temporary(t),
    bridge = new FakeBridge();
  bridge.status = 'online';
  bridge.cached = {
    worker: { status: 'online' },
    capabilities: {},
    settings: { language: 'zh' },
    schedules: [{ id: 'saved', cron: '0 9 * * *', priority: 'high' }],
  };
  fs.writeFileSync(path.join(dir, 'state-cache.json'), JSON.stringify(bridge.cached));
  const { base, headers } = await listen(t, dir, bridge);
  const target = { workId: 'work', turnId: 'turn', conversationId: 'conversation' };
  for (const [route, method, body] of [
    ['/api/messages', 'POST', { text: 'Done', workReply: target }],
    ['/api/schedules', 'POST', { text: 'Daily', cron: '0 9 * * *', priority: 'high' }],
    ['/api/schedules/saved', 'PATCH', { priority: 'low' }],
    ['/api/schedules/saved', 'PATCH', { enabled: true }],
    ['/api/schedules/saved', 'DELETE', {}],
  ] as const) {
    const before = bridge.requests.length,
      response = await fetch(base + route, { method, headers, body: JSON.stringify(body) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'service_update_required');
    assert.equal(bridge.requests.length, before);
  }
  bridge.cached.capabilities = { workReply: true, recurringSchedules: true };
  let refreshes = 0;
  bridge.refresh = async (force) => {
    assert.equal(force, true);
    refreshes++;
    return bridge.cached;
  };
  for (const [route, body] of [
    ['/api/messages', { text: 'Done', workReply: target }],
    ['/api/schedules', { text: 'Daily', cron: '0 9 * * *', priority: 'high' }],
  ] as const) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(String(defined(bridge.requests.at(-1)).body)), body);
  }
  assert.equal(refreshes, 2);
  bridge.cached.capabilities = {};
  const ordinary = await fetch(base + '/api/messages', {
    method: 'POST',
    headers,
    body: '{"text":"Ordinary chat"}',
  });
  assert.equal(ordinary.status, 200, 'ordinary chat remains compatible with older workers');
  bridge.cached.capabilities = { workReply: true };
  bridge.refresh = async () => {
    bridge.generation = (bridge.generation || 0) + 1;
    return bridge.cached;
  };
  const before = bridge.requests.length,
    changed = await fetch(base + '/api/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'Done', workReply: target }),
    });
  assert.equal(changed.status, 409);
  assert.equal(
    bridge.requests.length,
    before,
    'a connection change during the capability check cannot forward a task reply',
  );
});

test('language changes persist offline and synchronize the VM default on reconnect', async (t) => {
  const dir = temporary(t),
    { app, base, headers, bridge } = await listen(t, dir);
  let response = await fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ language: 'en' }),
  });
  assert.equal(response.ok, true);
  assert.equal(app.snapshot().settings.language, 'en');
  assert.equal(bridge.requests.length, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'controller.json'), 'utf8')).language,
    'en',
  );
  fs.writeFileSync(path.join(dir, 'test-key'), 'temporary test fixture');
  fs.writeFileSync(
    path.join(dir, 'vm.json'),
    JSON.stringify({ host: '192.0.2.1', user: 'dant', port: 22, keyPath: 'test-key' }),
  );
  bridge.connect = async () => {
    bridge.status = 'online';
    bridge.cached = { settings: { language: 'zh' } };
  };
  response = await fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' });
  assert.equal(response.ok, true);
  assert.equal(bridge.requests.length, 1);
  assert.equal(defined(bridge.requests[0]).route, '/api/settings');
  assert.deepEqual(JSON.parse(String(defined(bridge.requests[0]).body)), {
    language: 'en',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  response = await fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ language: 'zh' }),
  });
  assert.equal(response.ok, true);
  assert.equal(app.snapshot().settings.language, 'zh');
  assert.deepEqual(JSON.parse(String(defined(bridge.requests.at(-1)).body)), {
    language: 'zh',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const invalid = await fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ language: 'unknown' }),
  });
  assert.equal(invalid.ok, false);
  assert.equal(app.snapshot().settings.language, 'zh');
});

test('default Controller has no authoritative Store or local task executor', async (t) => {
  const dir = temporary(t),
    { app, base, session, headers } = await listen(t, dir);
  assert.equal(session.product, 'dant');
  assert.equal(session.mode, 'controller');
  assert.equal('store' in app, false);
  assert.equal('engine' in app, false);
  assert.equal('worker' in app, false);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  const state = await fetch(base + '/api/state', { headers }).then((response) => response.json());
  assert.equal(state.mode, 'vm-controller');
  assert.equal(state.controller.authority, 'vm');
  assert.deepEqual(state.messages, []);
});

test('Controller retains cached VM conversation offline and never loads legacy host state as authority', async (t) => {
  const dir = temporary(t),
    message = { id: 'from-vm', role: 'assistant', text: 'VM history', status: 'completed' },
    legacy = { messages: [{ id: 'host-only' }] };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(legacy));
  fs.writeFileSync(
    path.join(dir, 'state-cache.json'),
    JSON.stringify({
      messages: [message],
      settings: { language: 'en' },
      worker: { status: 'online' },
      memory: 'VM memory',
      queue: [],
    }),
  );
  const { base, headers } = await listen(t, dir);
  const state = await fetch(base + '/api/state', { headers }).then((response) => response.json());
  assert.equal(state.worker.status, 'offline');
  assert.equal(state.controller.cached, true);
  assert.deepEqual(state.messages, [message]);
  assert.equal(state.memory, 'VM memory');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')), legacy);
});

test('Controller proxies a mutation once and preserves an unknown result instead of resending', async (t) => {
  const { base, headers, bridge } = await listen(t, temporary(t));
  bridge.status = 'online';
  bridge.fail = true;
  const response = await fetch(base + '/api/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'one request' }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).unknownOutcome, true);
  assert.equal(bridge.requests.length, 1);
  assert.equal(defined(bridge.requests[0]).body, '{"text":"one request"}');
});

test('Controller token and origin checks protect proxied mutations', async (t) => {
  const { base, headers, bridge } = await listen(t, temporary(t));
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal(
    (
      await fetch(base + '/api/messages', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(bridge.requests.length, 0);
});

test('VM bridge merges simultaneous state refreshes and serves the 2 second cache', async (t) => {
  let finish!: (response: Response) => void,
    calls = 0;
  const bridge = new VmBridge({
    dataDir: temporary(t),
    projectRoot: path.resolve('.'),
    fetchImpl: () => {
      calls++;
      return new Promise((resolve) => (finish = resolve));
    },
  });
  t.after(() => bridge.close());
  bridge.status = 'online';
  bridge.token = 'test-token';
  bridge.port = 1234;
  const first = bridge.refresh(),
    second = bridge.refresh();
  assert.equal(calls, 1);
  finish(
    new Response(JSON.stringify({ messages: [{ id: 'vm' }] }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  assert.deepEqual(await first, await second);
  await bridge.refresh();
  assert.equal(calls, 1);
});

test('VM bridge never retries a failed business mutation', async (t) => {
  let calls = 0;
  const bridge = new VmBridge({
    dataDir: temporary(t),
    projectRoot: path.resolve('.'),
    fetchImpl: async () => {
      calls++;
      throw Error('Network ended');
    },
  });
  t.after(() => bridge.close());
  bridge.status = 'online';
  bridge.token = 'test-token';
  bridge.port = 1234;
  await assert.rejects(
    bridge.request('/api/messages', { method: 'POST', body: '{}' }),
    (error) =>
      isRecord(error) && error.unknownOutcome === true && /not resent/.test(errorMessage(error)),
  );
  assert.equal(calls, 1);
});

test('runtime verification rejects root, bare metal and unavailable desktop before execution', async () => {
  await assert.rejects(assertVmRuntime({ platform: 'linux', uid: 0 }), /ordinary user/);
  await assert.rejects(
    assertVmRuntime({
      platform: 'linux',
      uid: 1000,
      detect: () => {
        throw Error('not a VM');
      },
    }),
    /No virtual machine/,
  );
  await assert.rejects(
    assertVmRuntime({
      platform: 'linux',
      uid: 1000,
      detect: () => 'microsoft',
      fetchImpl: async () =>
        new Response('{"ok":false}', { headers: { 'Content-Type': 'application/json' } }),
    }),
    /not healthy/,
  );
  let requests = 0;
  await assertVmRuntime({
    platform: 'linux',
    uid: 1000,
    detect: () => 'microsoft',
    fetchImpl: async () =>
      ++requests === 1
        ? new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
        : new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  });
  assert.equal(requests, 2);
});

test('prepare mode displays setup without automatically connecting a bound VM', async (t) => {
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, 'vm.json'), '{"host":"192.0.2.1"}');
  const bridge = new FakeBridge();
  bridge.connect = () => assert.fail('Prepare mode must not connect automatically');
  const instance = createControllerApp({
    dataDir: dir,
    projectRoot: path.resolve('.'),
    prepareOnly: true,
    bridgeFactory: () => bridge,
    provisioningFactory: () => new FakeProvisioning(),
    profileOptions: {
      registryFile: path.join(dir, 'registry.json'),
      includeProject: false,
      env: {},
    },
  });
  t.after(() => instance.close());
  await instance.start();
  assert.equal(defined(instance.snapshot().worker).status, 'offline');
});

test('SSE sends the same cached state contract without opening a VM connection', async (t) => {
  const { base, session } = await listen(t, temporary(t));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(base + '/api/events?token=' + session.token, {
    signal: controller.signal,
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = defined(response.body).getReader(),
    chunk = await reader.read();
  const event = JSON.parse(
    new TextDecoder()
      .decode(chunk.value)
      .trim()
      .replace(/^data: /, ''),
  );
  assert.equal(event.type, 'state');
  assert.equal(event.data.mode, 'vm-controller');
  await reader.cancel();
});

test('host appearance defaults and changes persist offline without proxying to the VM', async (t) => {
  const dir = temporary(t),
    { app, base, headers, bridge } = await listen(t, dir);
  assert.deepEqual(
    Object.fromEntries(
      (['theme', 'font', 'fontSize'] as const).map((key) => [
        key,
        observedRecord(app.snapshot().settings)[key],
      ]),
    ),
    { theme: 'system', font: 'system', fontSize: 13 },
  );
  const update = { theme: 'dark', font: 'mono', fontSize: 16 };
  const response = await fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(update),
  });
  assert.equal(response.status, 200);
  assert.equal(bridge.requests.length, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'controller.json'), 'utf8'));
  for (const [key, value] of Object.entries(update)) {
    assert.equal(observedRecord(app.snapshot().settings)[key], value);
    assert.equal(saved[key], value);
  }
  for (const invalid of [
    { theme: 'custom' },
    { font: 'unknown' },
    { fontSize: 11 },
    { fontSize: 19 },
    { fontSize: 13.5 },
    { fontSize: '14' },
  ] as const) {
    assert.equal(
      (
        await fetch(base + '/api/settings', {
          method: 'PATCH',
          headers,
          body: JSON.stringify(invalid),
        })
      ).status,
      400,
    );
    assert.equal(app.snapshot().settings.fontSize, 16);
  }
  const before = fs.readFileSync(path.join(dir, 'controller.json'), 'utf8');
  assert.equal(
    (
      await fetch(base + '/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ theme: 'light', fontSize: 99, language: 'en', notifications: true }),
      })
    ).status,
    400,
  );
  assert.deepEqual(fs.readFileSync(path.join(dir, 'controller.json'), 'utf8'), before);
  assert.equal(app.snapshot().settings.theme, 'dark');
  assert.equal(app.snapshot().settings.language, 'zh');
  assert.equal(bridge.requests.length, 0);
  bridge.status = 'online';
  assert.equal(
    (
      await fetch(base + '/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ font: 'sans', fontSize: 14 }),
      })
    ).status,
    200,
  );
  assert.equal(bridge.requests.length, 0);
  const reloaded = createControllerApp({
    dataDir: dir,
    projectRoot: path.resolve('.'),
    bridgeFactory: () => new FakeBridge(),
    provisioningFactory: () => new FakeProvisioning(),
    profileOptions: {
      registryFile: path.join(dir, 'registry.json'),
      includeProject: false,
      env: {},
    },
  });
  t.after(() => reloaded.close());
  assert.equal(reloaded.snapshot().settings.theme, 'dark');
  assert.equal(reloaded.snapshot().settings.font, 'sans');
  assert.equal(reloaded.snapshot().settings.fontSize, 14);
});

test('inline work summaries default hidden and persist offline independently of cached VM settings', async (t) => {
  const dir = temporary(t),
    { app, base, headers, bridge } = await listen(t, dir),
    patch = (showWorkSummary: boolean) =>
      fetch(base + '/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ showWorkSummary }),
      });
  assert.equal(app.snapshot().settings.showWorkSummary, false);
  const cached = {
    messages: [],
    settings: { showWorkSummary: true },
    worker: { status: 'online' },
    queue: [],
  };
  bridge.cached = cached;
  bridge.emit('state', cached);
  assert.equal(
    app.snapshot().settings.showWorkSummary,
    false,
    'a VM preference cannot enable this host UI setting',
  );
  for (const showWorkSummary of [true, false, true] as const) {
    assert.equal((await patch(showWorkSummary)).status, 200);
    assert.equal(app.snapshot().settings.showWorkSummary, showWorkSummary);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, 'controller.json'), 'utf8')).showWorkSummary,
      showWorkSummary,
    );
  }
  assert.equal(bridge.requests.length, 0);
  cached.settings.showWorkSummary = false;
  bridge.emit('state', cached);
  assert.equal(app.snapshot().settings.showWorkSummary, true);
  await app.close();
  const reloaded = createControllerApp({
    dataDir: dir,
    projectRoot: path.resolve('.'),
    bridgeFactory: () => new FakeBridge(),
    provisioningFactory: () => new FakeProvisioning(),
    profileOptions: {
      registryFile: path.join(dir, 'registry.json'),
      includeProject: false,
      candidateDirs: [],
      env: {},
    },
  });
  t.after(() => reloaded.close());
  assert.equal(
    reloaded.snapshot().settings.showWorkSummary,
    true,
    'the host preference survives a Controller restart',
  );
  assert.equal(
    reloaded.snapshot().settings.showWorkSummary !== cached.settings.showWorkSummary,
    true,
  );
});

test('work summary changes stay local during a call and are removed from mixed proxied settings', async (t) => {
  const { app, base, headers, bridge } = await listen(t, temporary(t)),
    call = { id: 'ongoing-call', provider: 'subscription' },
    active = { turnId: 'existing-work' };
  const state = {
    messages: [],
    settings: { showWorkSummary: false },
    worker: { status: 'online' },
    call,
    active,
    queue: ['queued-task'],
  };
  bridge.status = 'online';
  bridge.cached = state;
  bridge.emit('state', state);
  let disconnects = 0;
  bridge.disconnect = () => {
    disconnects++;
  };
  const patch = (body: unknown) =>
    fetch(base + '/api/settings', { method: 'PATCH', headers, body: JSON.stringify(body) });
  assert.equal((await patch({ showWorkSummary: true })).status, 200);
  assert.equal(bridge.requests.length, 0);
  assert.equal(app.snapshot().settings.showWorkSummary, true);
  assert.equal(
    (await patch({ showWorkSummary: false, language: 'en', model: 'unchanged-proxy-behavior' }))
      .status,
    200,
  );
  assert.deepEqual(
    bridge.requests.map((request) => JSON.parse(String(request.body))),
    [
      { language: 'en', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      { model: 'unchanged-proxy-behavior' },
    ],
  );
  assert.equal(app.snapshot().settings.showWorkSummary, false);
  assert.equal(state.call, call);
  assert.equal(state.active, active);
  assert.deepEqual(state.queue, ['queued-task']);
  assert.equal(disconnects, 0);
  assert.equal(bridge.status, 'online');
});

test('invalid work summary values reject a whole Controller settings patch before any local or VM mutation', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.40');
  const { app, base, headers, bridge } = await listen(t, dir),
    patch = (body: unknown) =>
      fetch(base + '/api/settings', { method: 'PATCH', headers, body: JSON.stringify(body) });
  assert.equal((await patch({ showWorkSummary: true, theme: 'dark' })).status, 200);
  bridge.status = 'online';
  let disconnects = 0;
  bridge.disconnect = () => {
    disconnects++;
  };
  const config = fs.readFileSync(path.join(dir, 'controller.json'), 'utf8'),
    vm = fs.readFileSync(path.join(dir, 'vm.json'), 'utf8'),
    settings = structuredClone(app.snapshot().settings);
  for (const showWorkSummary of ['true', 1, 0, null, [], {}] as const) {
    const response = await patch({
      showWorkSummary,
      theme: 'light',
      language: 'en',
      notifications: true,
      vm: { host: '192.0.2.41' },
      model: 'must-not-forward',
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /work summary preference/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'controller.json'), 'utf8'), config);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'vm.json'), 'utf8'), vm);
    assert.deepEqual(app.snapshot().settings, settings);
    assert.equal(disconnects, 0);
    assert.equal(bridge.requests.length, 0);
  }
});

test('invalid persisted Controller work summary values normalize to the hidden default', (t) => {
  for (const showWorkSummary of ['true', 1, null, [], {}] as const) {
    const dir = temporary(t);
    fs.writeFileSync(path.join(dir, 'controller.json'), JSON.stringify({ showWorkSummary }));
    const app = createControllerApp({
      dataDir: dir,
      projectRoot: path.resolve('.'),
      bridgeFactory: () => new FakeBridge(),
      provisioningFactory: () => new FakeProvisioning(),
      profileOptions: {
        registryFile: path.join(dir, 'registry.json'),
        includeProject: false,
        candidateDirs: [],
        env: {},
      },
    });
    t.after(() => app.close());
    assert.equal(app.snapshot().settings.showWorkSummary, false);
  }
});

test('missing VM Connect returns actionable guidance and profile APIs stay local', async (t) => {
  const { app, base, headers, bridge } = await listen(t, temporary(t));
  bridge.connect = () => assert.fail('Missing configuration must not start a transport');
  const response = await fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' }),
    body = await response.json();
  assert.equal(response.status, 409);
  assert.match(body.error, /Import an existing/);
  assert.doesNotMatch(body.error, /ENOENT/);
  const profiles = await fetch(base + '/api/vm/profiles', { headers }).then((result) =>
    result.json(),
  );
  assert.equal(profiles.current, null);
  assert.deepEqual(profiles.candidates, []);
  assert.equal(bridge.requests.length, 0);
  assert.equal(defined(app.snapshot().worker).status, 'offline');
});

function writeProfile(dir: string, host: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'key'), 'temporary private key fixture');
  fs.writeFileSync(
    path.join(dir, 'vm.json'),
    JSON.stringify({ host, user: 'dant', port: 22, keyPath: 'key' }),
  );
}

test('profile API requires a choice for several VMs, imports references without connecting, and preserves valid current', async (t) => {
  const dir = temporary(t),
    one = temporary(t),
    two = temporary(t);
  writeProfile(one, '192.0.2.1');
  writeProfile(two, '192.0.2.2');
  const bridge = new FakeBridge();
  bridge.connect = () => assert.fail('Import must not connect');
  const { app, base, headers } = await listen(t, dir, bridge, {
    profileOptions: {
      registryFile: path.join(dir, 'registry.json'),
      includeProject: false,
      candidateDirs: [one, two],
      env: {},
    },
  });
  let profiles = await fetch(base + '/api/vm/profiles', { headers }).then((response) =>
    response.json(),
  );
  assert.equal(profiles.requiresSelection, true);
  assert.equal(profiles.candidates.length, 2);
  const blocked = await fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /Several existing/);
  const selected = profiles.candidates.find(
    (candidate: { host: string; id: string }) => candidate.host === '192.0.2.2',
  );
  const imported = await fetch(base + '/api/vm/import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: defined(selected).id }),
  }).then((response) => response.json());
  assert.equal(imported.connected, false);
  assert.equal(imported.profile.directory, two);
  assert.equal(app.snapshot().settings.vm.host, '192.0.2.2');
  assert.equal(
    observedRecord(app.snapshot().settings.vm).keyPath,
    fs.realpathSync(path.join(two, 'key')),
  );
  assert.equal(bridge.requests.length, 0);
  const before = fs.readFileSync(path.join(dir, 'vm.json'), 'utf8');
  assert.equal(
    (
      await fetch(base + '/api/vm/import', {
        method: 'POST',
        headers,
        body: JSON.stringify({ directory: one }),
      })
    ).status,
    409,
  );
  assert.deepEqual(fs.readFileSync(path.join(dir, 'vm.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

test('profile API supports an explicitly selected absolute directory when no old profile was registered', async (t) => {
  const dir = temporary(t),
    original = temporary(t);
  writeProfile(original, '192.0.2.50');
  const { base, headers, app } = await listen(t, dir);
  const response = await fetch(base + '/api/vm/import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ directory: original }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).connected, false);
  assert.equal(app.snapshot().settings.vm.host, '192.0.2.50');
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

test('an old failed setup status does not prevent a valid existing VM from reconnecting', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.60');
  const failed = new FakeProvisioning();
  failed.snapshot = () => ({
    status: 'failed',
    stage: 'failed:checking-hyper-v',
    running: false,
    error: 'A VM already exists',
  });
  const bridge = new FakeBridge();
  let connections = 0;
  bridge.connect = async () => {
    connections++;
    bridge.status = 'online';
    bridge.cached = { settings: { language: 'zh' } };
  };
  const { app } = await listen(t, dir, bridge, { provisioningFactory: () => failed });
  await app.start();
  assert.equal(connections, 1);
  assert.equal(app.snapshot().provisioning.status, 'failed');
  assert.equal(app.snapshot().settings.vm.host, '192.0.2.60');
});

test('busy VM connection changes are rejected atomically while appearance and language stay editable', async (t) => {
  for (const [name, busy] of [
    ['task', { active: { messageId: 'working' } }],
    ['call', { call: { id: 'live-call' } }],
    ['takeover', { takeover: true }],
    ['human', { computer: { status: 'human' } }],
    ['taking-over', { computer: { status: 'taking-over' } }],
  ] as const) {
    await t.test(name, async (t) => {
      const dir = temporary(t);
      writeProfile(dir, '192.0.2.60');
      const { app, base, headers, bridge } = await listen(t, dir);
      let disconnects = 0;
      bridge.disconnect = () => {
        disconnects++;
        bridge.status = 'offline';
      };
      const patch = (body: unknown) =>
        fetch(base + '/api/settings', { method: 'PATCH', headers, body: JSON.stringify(body) });
      assert.equal((await patch({ theme: 'dark', language: 'en' })).status, 200);
      const state = {
        messages: [],
        settings: { language: 'en' },
        worker: { status: 'online' },
        ...busy,
      };
      bridge.cached = state;
      bridge.status = 'online';
      bridge.emit('state', state);
      const oldVm = fs.readFileSync(path.join(dir, 'vm.json'), 'utf8'),
        oldConfig = fs.readFileSync(path.join(dir, 'controller.json'), 'utf8'),
        oldRegistry = fs.readFileSync(path.join(dir, 'registry.json'), 'utf8');
      for (const body of [
        { vm: { host: '192.0.2.70' } },
        { vm: { host: '192.0.2.70' }, theme: 'light', language: 'zh', fontSize: 17 },
      ] as const) {
        const response = await patch(body);
        assert.equal(response.status, 409);
        assert.equal(
          (await response.json()).error,
          'Stop active work and return computer control before changing its connection',
        );
        assert.deepEqual(fs.readFileSync(path.join(dir, 'vm.json'), 'utf8'), oldVm);
        assert.deepEqual(fs.readFileSync(path.join(dir, 'controller.json'), 'utf8'), oldConfig);
        assert.deepEqual(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'), oldRegistry);
        assert.equal(app.snapshot().settings.vm.host, '192.0.2.60');
        assert.equal(app.snapshot().settings.theme, 'dark');
        assert.equal(app.snapshot().settings.language, 'en');
        assert.equal(disconnects, 0);
        assert.equal(bridge.status, 'online');
        assert.equal(bridge.requests.length, 0);
      }
      assert.equal((await patch({ theme: 'light', font: 'mono', language: 'zh' })).status, 200);
      assert.equal(app.snapshot().settings.theme, 'light');
      assert.equal(app.snapshot().settings.language, 'zh');
      assert.equal(disconnects, 0);
      assert.deepEqual(JSON.parse(String(defined(bridge.requests[0]).body)), {
        language: 'zh',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    });
  }
});

test('idle connection changes save the new VM binding and disconnect the previous transport', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.60');
  const { app, base, headers, bridge } = await listen(t, dir);
  let disconnects = 0;
  bridge.disconnect = () => {
    disconnects++;
    bridge.status = 'offline';
  };
  const state = {
    messages: [],
    active: null,
    call: null,
    takeover: false,
    computer: { status: 'agent' },
    settings: {},
    worker: { status: 'online' },
  };
  bridge.status = 'online';
  bridge.cached = state;
  bridge.emit('state', state);
  const response = await fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ vm: { host: '192.0.2.70' }, theme: 'dark' }),
  });
  assert.equal(response.status, 200);
  assert.equal(disconnects, 1);
  assert.equal(bridge.status, 'offline');
  assert.equal(bridge.requests.length, 0);
  assert.equal(app.snapshot().settings.vm.host, '192.0.2.70');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'vm.json'), 'utf8')).host, '192.0.2.70');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'controller.json'), 'utf8')).theme,
    'dark',
  );
});

test('hypervisor and font discovery remain on the Controller and do not start or contact the VM', async (t) => {
  let enumerations = 0;
  const inventory = { fonts: ['Aptos', 'Cascadia Code', '微软雅黑'], source: 'windows' };
  const { base, headers, bridge, app } = await listen(t, temporary(t), new FakeBridge(), {
    fontsProvider: async () => {
      enumerations++;
      return inventory;
    },
  });
  assert.equal(enumerations, 0);
  assert.equal((await fetch(base + '/api/fonts')).status, 401);
  assert.equal(enumerations, 0);
  const fonts = await fetch(base + '/api/fonts', { headers });
  assert.equal(fonts.status, 200);
  assert.deepEqual(await fonts.json(), inventory);
  assert.equal(enumerations, 1);
  const providers = await fetch(base + '/api/vm/providers', { headers });
  assert.equal(providers.status, 200);
  assert.deepEqual(await providers.json(), app.provisioning.providers());
  assert.equal(bridge.requests.length, 0);
  assert.equal(bridge.status, 'offline');
});

test('expanded appearance settings persist locally, normalize colors and never reach VM settings', async (t) => {
  const dir = temporary(t),
    { app, base, headers, bridge } = await listen(t, dir);
  assert.deepEqual(
    Object.fromEntries(
      appearanceKeys.map((key) => [key, observedRecord(app.snapshot().settings)[key]]),
    ),
    appearanceDefaults,
  );
  const patch = {
    theme: 'dark',
    themePreset: 'custom',
    accentColor: '#ab12ef',
    backgroundColor: '#102030',
    foregroundColor: '#f1f2f3',
    font: 'sans',
    fontFamily: 'Aptos',
    fontSize: 16,
    contentFontSize: 22,
    codeFontSize: 19,
    reduceMotion: 'reduce',
  };
  let response = await fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  });
  assert.equal(response.status, 200);
  assert.equal(bridge.requests.length, 0);
  const expected = { ...patch, accentColor: '#AB12EF', foregroundColor: '#F1F2F3' },
    saved = JSON.parse(fs.readFileSync(path.join(dir, 'controller.json'), 'utf8'));
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(observedRecord(app.snapshot().settings)[key], value);
    assert.equal(saved[key], value);
  }
  bridge.status = 'online';
  response = await fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      themePreset: 'warm',
      fontFamily: 'Cascadia Code',
      language: 'en',
      model: 'fixture-model',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(bridge.requests.length, 2);
  assert.deepEqual(
    bridge.requests.map((request) => JSON.parse(String(request.body))),
    [
      { language: 'en', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      { model: 'fixture-model' },
    ],
  );
  assert.equal(app.snapshot().settings.themePreset, 'warm');
  assert.equal(app.snapshot().settings.fontFamily, 'Cascadia Code');
  const reloaded = createControllerApp({
    dataDir: dir,
    projectRoot: path.resolve('.'),
    bridgeFactory: () => new FakeBridge(),
    provisioningFactory: () => new FakeProvisioning(),
    profileOptions: {
      registryFile: path.join(dir, 'registry.json'),
      includeProject: false,
      env: {},
    },
  });
  t.after(() => reloaded.close());
  assert.equal(reloaded.snapshot().settings.themePreset, 'warm');
  assert.equal(reloaded.snapshot().settings.codeFontSize, 19);
  assert.equal(reloaded.snapshot().settings.fontFamily, 'Cascadia Code');
});

test('invalid expanded appearance patches reject all changes before writing VM or host preferences', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.40');
  const { app, base, headers, bridge } = await listen(t, dir);
  await fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ theme: 'dark', fontFamily: 'Aptos' }),
  });
  bridge.status = 'online';
  let disconnects = 0;
  bridge.disconnect = () => {
    disconnects++;
  };
  const beforeConfig = fs.readFileSync(path.join(dir, 'controller.json'), 'utf8'),
    beforeVM = fs.readFileSync(path.join(dir, 'vm.json'), 'utf8');
  for (const invalid of [
    { themePreset: 'unsupported' },
    { accentColor: 'red' },
    { backgroundColor: '#123' },
    { foregroundColor: 'url(https://example.com)' },
    { fontFamily: 'name; color:red' },
    { contentFontSize: 25 },
    { codeFontSize: 10 },
    { reduceMotion: true },
  ] as const) {
    const response = await fetch(base + '/api/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        theme: 'light',
        language: 'en',
        notifications: true,
        vm: { host: '192.0.2.41' },
        ...invalid,
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'controller.json'), 'utf8'), beforeConfig);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'vm.json'), 'utf8'), beforeVM);
    assert.equal(app.snapshot().settings.theme, 'dark');
    assert.equal(app.snapshot().settings.language, 'zh');
    assert.equal(app.snapshot().settings.fontFamily, 'Aptos');
    assert.equal(disconnects, 0);
    assert.equal(bridge.requests.length, 0);
  }
});

test('invalid persisted appearance values fall back to safe defaults and font enumeration failures are local', async (t) => {
  const dir = temporary(t);
  fs.writeFileSync(
    path.join(dir, 'controller.json'),
    JSON.stringify({
      themePreset: 'invalid',
      accentColor: 'red',
      fontFamily: 'unsafe;name',
      fontSize: 99,
      contentFontSize: 0,
      codeFontSize: '13',
      reduceMotion: 'invalid',
    }),
  );
  const { app, base, headers, bridge } = await listen(t, dir, new FakeBridge(), {
    fontsProvider: async () => {
      throw Object.assign(Error('Windows font list is unavailable.'), { status: 503 });
    },
  });
  assert.deepEqual(
    Object.fromEntries(
      appearanceKeys.map((key) => [key, observedRecord(app.snapshot().settings)[key]]),
    ),
    appearanceDefaults,
  );
  const response = await fetch(base + '/api/fonts', { headers });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'Windows font list is unavailable.');
  assert.equal(bridge.requests.length, 0);
});

interface RecoveryState extends VmObservation {
  conversationId?: string;
  messages: Array<{ id: string; role: string; text: string; status: string; pauseReason: string }>;
  settings: {
    language: string;
    timeZone?: string;
    model?: string;
    voiceProvider?: string;
    [key: string]: unknown;
  };
  worker: { status: string; error?: string | null; [key: string]: unknown };
  active: Record<string, unknown> | null;
  queue: readonly unknown[] | null;
  workTasks: unknown[];
  call: Record<string, unknown> | null;
  takeover: boolean;
  computer: { status: string; sessionId?: string | null; expiresAt?: number; pending?: boolean };
}
const idleRecoveryState = (): RecoveryState => ({
  conversationId: 'preserved-conversation',
  messages: [
    {
      id: 'paused-task',
      role: 'user',
      text: 'Existing work',
      status: 'paused',
      pauseReason: 'executor-disconnected',
    },
  ],
  settings: { language: 'zh', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  worker: { status: 'offline', error: 'Worker stopped' },
  active: null,
  queue: [],
  workTasks: [],
  call: null,
  takeover: false,
  computer: { status: 'dant', sessionId: null, expiresAt: 0 },
});
class RecoveryBridge extends FakeBridge {
  declare state: RecoveryState;
  declare connections: number;
  declare refreshes: Array<boolean | undefined>;
  declare wait: (() => Promise<unknown>) | undefined;
  declare failure: Error | undefined;
  declare responseStatus: number | undefined;
  constructor(state: RecoveryState = idleRecoveryState()) {
    super();
    this.state = state;
    this.connections = 0;
    this.refreshes = [];
  }
  async connect(_options?: VmConnectOptions) {
    this.connections++;
    this.status = 'online';
    this.cached = this.state;
    this.emit('state', this.state);
    return this.state;
  }
  async refresh(force?: boolean) {
    this.refreshes.push(force);
    this.cached = this.state;
    this.emit('state', this.state);
    return this.state;
  }
  async request(route: string, options: VmRequestOptions = {}) {
    this.requests.push({ route, ...options });
    assert.equal(route, '/api/connect');
    assert.deepEqual(JSON.parse(String(options.body)), { idleRecovery: true });
    assert.equal(options.method, 'POST');
    if (this.wait) await this.wait();
    if (this.failure) throw this.failure;
    if (this.responseStatus)
      return new Response('{"error":"not forwarded"}', { status: this.responseStatus });
    this.state.worker = { ...this.state.worker, status: 'online', error: null };
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  }
}
async function recoveryFixture(
  t: NodeTestContext,
  state: RecoveryState = idleRecoveryState(),
  options: ControllerAppOptions = {},
) {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.90');
  return listen(t, dir, new RecoveryBridge(state), options);
}

test('explicit Controller Reconnect starts an idle stopped VM executor once and refreshes its authoritative state without replaying paused history', async (t) => {
  const { app, base, headers, bridge } = await recoveryFixture(t),
    messages = structuredClone(bridge.state.messages);
  const response = await fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal(bridge.connections, 2);
  assert.equal(bridge.requests.length, 1);
  assert.deepEqual(bridge.refreshes, [true, true, true]);
  assert.equal(defined(app.snapshot().worker).status, 'online');
  assert.equal(app.snapshot().conversationId, 'preserved-conversation');
  assert.deepEqual(app.snapshot().messages, messages);
  assert.deepEqual(app.snapshot().queue, []);
});

test('automatic Controller startup and provisioning reconnect preserve a deliberately stopped executor', async (t) => {
  const provisioning = new FakeProvisioning(),
    { app, bridge } = await recoveryFixture(t, idleRecoveryState(), {
      provisioningFactory: () => provisioning,
    });
  await app.start();
  assert.equal(bridge.connections, 1);
  assert.equal(bridge.requests.length, 0);
  assert.equal(defined(app.snapshot().worker).status, 'offline');
  provisioning.emit('change', { status: 'ready', running: false });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.connections, 1, 'ready events do not reopen an already connected transport');
  assert.equal(bridge.requests.length, 0);
  assert.equal(defined(app.snapshot().worker).status, 'offline');
  assert.equal(defined(observedRecords(app.snapshot().messages)[0]).status, 'paused');
});

test('only the explicit Reconnect action authorizes updating running VM work', async (t) => {
  const state = idleRecoveryState();
  state.worker.status = 'online';
  const provisioning = new FakeProvisioning(),
    { app, bridge, base, headers } = await recoveryFixture(t, state, {
      provisioningFactory: () => provisioning,
    }),
    modes: Array<boolean | undefined> = [];
  const original = bridge.connect.bind(bridge);
  bridge.connect = async (options = {}) => {
    modes.push(options.updateRunningWork);
    return original(options);
  };
  await app.start();
  assert.deepEqual(modes, [false]);
  const response = await fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(modes, [false, true]);
  assert.equal(
    bridge.requests.length,
    0,
    'the controller does not independently pause or replay tasks',
  );
  provisioning.emit('change', { status: 'ready', running: false });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(modes, [false, true]);
});

test('Controller startup exposes pending service upgrade and automatically updates after fresh idle state', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.102');
  const bridge = new FakeBridge();
  bridge.generation = 0;
  bridge.serviceUpdate = {
    status: 'checking',
    targetVersion: '0.4.7-beta.6',
    runningVersion: null,
    confirmed: false,
    reason: null,
  };
  let state: RecoveryState = {
      ...idleRecoveryState(),
      worker: { status: 'online' },
      active: { turnId: 'running' },
      messages: [],
      workTasks: [],
    },
    connections = 0;
  bridge.connect = async (options = {}) => {
    assert.equal(options.updateRunningWork, false);
    assert.equal(options.autoUpdate, true);
    connections++;
    bridge.generation++;
    bridge.status = 'online';
    bridge.serviceUpdate = {
      ...defined(bridge.serviceUpdate),
      status: connections === 1 ? 'pending' : 'current',
      reason: connections === 1 ? 'work-active' : 'source-current',
      confirmed: true,
      runningVersion: connections === 1 ? '0.4.7-beta.5' : '0.4.7-beta.6',
    };
    bridge.cached = state;
    bridge.emit('state', state);
    bridge.emit('change');
  };
  bridge.refresh = async () => state;
  const { app } = await listen(t, dir, bridge);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.start();
  assert.equal(connections, 1);
  assert.equal(defined(app.snapshot().controller.serviceUpdate).status, 'pending');
  assert.equal(defined(app.snapshot().controller.serviceUpdate).runningVersion, '0.4.7-beta.5');
  t.mock.timers.tick(30000);
  await settle();
  assert.equal(connections, 1, 'cached idle must not bypass fresh active work');
  state = { ...state, active: null };
  t.mock.timers.tick(30000);
  await settle(() => connections === 2);
  await settle();
  assert.equal(defined(app.snapshot().controller.serviceUpdate).status, 'current');
  assert.equal(
    bridge.requests.length,
    0,
    'automatic update must not POST pause or executor recovery',
  );
  bridge.status = 'offline';
  assert.equal(defined(app.snapshot().controller.serviceUpdate).confirmed, false);
});

test('a failed first automatic Controller connection retries and shutdown cancels future attempts', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.103');
  const bridge = new FakeBridge();
  let attempts = 0;
  bridge.serviceUpdate = {
    status: 'checking',
    targetVersion: '0.4.7-beta.6',
    runningVersion: null,
    confirmed: false,
    reason: null,
  };
  bridge.connect = async (options = {}) => {
    assert.equal(options.updateRunningWork, false);
    if (++attempts === 1) {
      bridge.serviceUpdate = {
        ...defined(bridge.serviceUpdate),
        status: 'failed',
        reason: 'connection-unavailable',
      };
      throw Error('fixture offline');
    }
    bridge.status = 'online';
    bridge.cached = { ...idleRecoveryState(), worker: { status: 'online' } };
    bridge.serviceUpdate = {
      ...defined(bridge.serviceUpdate),
      status: 'current',
      runningVersion: '0.4.7-beta.6',
      confirmed: true,
      reason: 'source-current',
    };
  };
  const { app } = await listen(t, dir, bridge);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.start();
  assert.equal(attempts, 1);
  t.mock.timers.tick(5000);
  await settle(() => attempts === 2);
  await settle();
  assert.equal(defined(app.snapshot().controller.serviceUpdate).status, 'current');
  await app.close();
  t.mock.timers.tick(60000);
  assert.equal(attempts, 2);
});

test('explicit executor recovery is blocked by fresh active work, queues, calls, leases or handover state', async (t) => {
  for (const [name, busy] of [
    ['task', { active: { messageId: 'working' } }],
    ['queue', { queue: ['queued-task'] }],
    ['call', { call: { id: 'live-call' } }],
    ['takeover', { takeover: true }],
    ['acquiring', { acquiring: true }],
    ['human', { computer: { status: 'human', sessionId: 'lease' } }],
    ['taking-over', { computer: { status: 'taking-over' } }],
    ['returning', { computer: { status: 'returning' } }],
    ['lease', { computer: { status: 'dant', sessionId: 'lease' } }],
    ['pending', { computer: { status: 'dant', pending: true } }],
    ['unknown-control', { computer: { status: 'unknown' } }],
    ['unknown-queue', { queue: null }],
  ] as const) {
    await t.test(name, async (t) => {
      const state = { ...idleRecoveryState(), ...busy },
        { app, base, headers, bridge } = await recoveryFixture(t, state);
      bridge.cached = idleRecoveryState();
      const response = await fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /Stop active work and return computer control/);
      assert.equal(bridge.requests.length, 0);
      assert.deepEqual(bridge.refreshes, [true]);
      assert.equal(defined(app.snapshot().worker).status, 'offline');
      assert.deepEqual(bridge.state, state);
    });
  }
});

test('an online or already connecting executor is never restarted by Controller Reconnect', async (t) => {
  for (const status of ['online', 'connecting'] as const)
    await t.test(status, async (t) => {
      const state = idleRecoveryState();
      state.worker.status = status;
      const { base, headers, bridge } = await recoveryFixture(t, state);
      const response = await fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, status === 'connecting' ? 409 : 200);
      assert.equal(bridge.requests.length, 0);
      assert.deepEqual(bridge.refreshes, [true]);
      assert.equal(bridge.state.worker.status, status);
    });
});

test('simultaneous explicit reconnect clicks share one executor recovery and do not send duplicate mutations', async (t) => {
  const { app, base, headers, bridge } = await recoveryFixture(t);
  let release!: () => void,
    started!: () => void,
    secondArrived!: () => void,
    incoming = 0;
  const entered = new Promise<void>((resolve) => (started = resolve)),
    bothArrived = new Promise<void>((resolve) => (secondArrived = resolve));
  bridge.wait = () => {
    started();
    return new Promise<void>((resolve) => (release = resolve));
  };
  app.server.on('request', (req) => {
    if (req.url === '/api/connect' && ++incoming === 2)
      req.once('end', () => setImmediate(secondArrived));
  });
  const first = fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' });
  await entered;
  const second = fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' });
  await bothArrived;
  release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.equal(bridge.connections, 2);
  assert.equal(bridge.requests.length, 1);
  assert.deepEqual(bridge.refreshes, [true, true, true]);
});

test('executor recovery failures are surfaced once without replay or an automatic retry', async (t) => {
  for (const [name, setup, status] of [
    ['rejected', (bridge: RecoveryBridge) => (bridge.responseStatus = 409), 409],
    [
      'transport-unknown',
      (bridge: RecoveryBridge) =>
        (bridge.failure = Object.assign(Error('Unknown recovery outcome'), {
          status: 502,
          unknownOutcome: true,
        })),
      502,
    ],
    [
      'not-online',
      (bridge: RecoveryBridge) =>
        (bridge.refresh = async () => {
          bridge.refreshes.push(true);
          return { ...bridge.state, worker: { status: 'offline' } };
        }),
      503,
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const { base, headers, bridge } = await recoveryFixture(t);
      setup(bridge);
      const response = await fetch(base + '/api/connect', { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(bridge.requests.length, 1);
      assert.equal(defined(bridge.state.messages[0]).status, 'paused');
      assert.deepEqual(bridge.state.queue, []);
      if (name === 'transport-unknown') assert.equal(body.unknownOutcome, true);
      else assert.match(body.error, /executor/);
    });
  }
});

const settle = async (predicate = () => true) => {
  for (let i = 0; i < 80; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (predicate()) return;
  }
  assert.fail('Local preference fixture did not settle.');
};
const gate = deferred;
interface PreferenceRequest extends VmRequestOptions {
  route: string;
  values: { language?: string; model?: string; timeZone?: string };
  generation: number;
}
class PreferenceBridge extends FakeBridge {
  declare state: RecoveryState;
  declare connections: boolean[];
  declare refreshes: Array<{ generation: number; force: boolean | undefined }>;
  declare inFlight: number;
  declare maxInFlight: number;
  declare requests: PreferenceRequest[];
  declare write: ((request: PreferenceRequest) => Promise<Response | void> | undefined) | undefined;
  constructor(state: RecoveryState = idleRecoveryState()) {
    super();
    this.state = state;
    this.generation = 0;
    this.connections = [];
    this.refreshes = [];
    this.inFlight = 0;
    this.maxInFlight = 0;
  }
  async connect({ deploy = true }: VmConnectOptions = {}) {
    this.connections.push(deploy);
    this.generation++;
    this.status = 'online';
    this.cached = this.state;
    this.emit('state', this.state);
    this.emit('change');
    return this.state;
  }
  disconnect() {
    this.generation++;
    super.disconnect();
  }
  async request(route: string, options: VmRequestOptions = {}) {
    assert.equal(
      route,
      '/api/settings',
      'preference synchronization must never restart or pause work',
    );
    assert.equal(options.method, 'PATCH');
    const values = JSON.parse(String(options.body)),
      target = this.state,
      request = { route, ...options, values, generation: this.generation };
    this.requests.push(request);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const result = await this.write?.(request);
      if (result) return result;
      Object.assign(target.settings, values);
      return new Response('{"ok":true}');
    } finally {
      this.inFlight--;
    }
  }
  async refresh(force?: boolean) {
    this.refreshes.push({ generation: this.generation, force });
    this.cached = this.state;
    this.emit('state', this.state);
    return this.state;
  }
}

test('automatic transport recovery synchronizes an offline language change and time zone once while preserving calls, work and queue', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.95');
  const state = {
      ...idleRecoveryState(),
      settings: { language: 'zh', timeZone: 'Europe/Paris' },
      worker: { status: 'online' },
      active: { turnId: 'still-running' },
      call: { id: 'still-speaking' },
      queue: ['still-queued'],
    },
    bridge = new PreferenceBridge(state),
    { app, base, headers } = await listen(t, dir, bridge);
  assert.equal(
    (await fetch(base + '/api/settings', { method: 'PATCH', headers, body: '{"language":"en"}' }))
      .status,
    200,
  );
  assert.equal(bridge.requests.length, 0);
  const work = structuredClone({
    active: state.active,
    call: state.call,
    queue: state.queue,
    messages: state.messages,
  });
  await bridge.connect({ deploy: false });
  await settle(() => bridge.refreshes.length === 1);
  assert.deepEqual(bridge.connections, [false]);
  assert.deepEqual(
    bridge.requests.map((item) => item.values),
    [{ language: 'en', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }],
  );
  assert.equal(app.snapshot().settings.language, 'en');
  assert.equal(state.settings.language, 'en');
  for (let i = 0; i < 4; i++) {
    bridge.emit('state', state);
    bridge.emit('change');
  }
  await settle();
  assert.equal(bridge.requests.length, 1, 'successful state refreshes cannot trigger a PATCH loop');
  assert.deepEqual(
    { active: state.active, call: state.call, queue: state.queue, messages: state.messages },
    work,
  );
});

test('a language change during an older reconnect write is serialized and acknowledged only after the latest preference refresh', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.96');
  const state = { ...idleRecoveryState(), settings: { language: 'en', timeZone: 'Europe/Paris' } },
    bridge = new PreferenceBridge(state),
    first = gate(),
    second = gate();
  bridge.write = (request) => (request.values.language === 'zh' ? first.promise : second.promise);
  const { app, base, headers } = await listen(t, dir, bridge);
  await bridge.connect({ deploy: false });
  assert.equal(defined(bridge.requests[0]).values.language, 'zh');
  let answered = false;
  const changed = fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: '{"language":"en"}',
  }).then((response) => {
    answered = true;
    return response;
  });
  await settle(() => app.snapshot().settings.language === 'en');
  assert.equal(bridge.requests.length, 1);
  assert.equal(answered, false);
  first.resolve();
  await settle(() => bridge.requests.length === 2);
  assert.equal(state.settings.language, 'zh');
  assert.equal(answered, false);
  second.resolve();
  assert.equal((await changed).status, 200);
  assert.equal(state.settings.language, 'en');
  assert.equal(bridge.maxInFlight, 1);
  assert.deepEqual(
    bridge.requests.map((item) => item.values.language),
    ['zh', 'en'],
  );
  assert.equal(bridge.refreshes.length, 2);
});

test('a failed automatic preference write can retry on a later fresh state without an immediate event retry loop', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.97');
  const bridge = new PreferenceBridge({
    ...idleRecoveryState(),
    settings: { language: 'en', timeZone: 'Europe/Paris' },
  });
  let fail = true;
  bridge.write = async () => (fail ? new Response('{}', { status: 503 }) : undefined);
  await listen(t, dir, bridge);
  await bridge.connect({ deploy: false });
  await settle();
  assert.equal(bridge.requests.length, 1);
  for (let i = 0; i < 5; i++) bridge.emit('state', bridge.state);
  await settle();
  assert.equal(bridge.requests.length, 1);
  assert.equal(bridge.refreshes.length, 0);
  const later = Date.now() + 6000;
  t.mock.method(Date, 'now', () => later);
  fail = false;
  bridge.emit('state', bridge.state);
  await settle(() => bridge.refreshes.length === 1);
  assert.equal(bridge.requests.length, 2);
  assert.equal(bridge.state.settings.language, 'zh');
  assert.equal(defined(defined(bridge.requests[0]).signal).aborted, false);
});

test('switching VM aborts the old preference scope and ignores its late acknowledgement', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.98');
  const old = { ...idleRecoveryState(), settings: { language: 'en', timeZone: 'Europe/Paris' } },
    bridge = new PreferenceBridge(old),
    late = gate();
  bridge.write = (request) => (request.generation === 1 ? late.promise : undefined);
  const { app, base, headers } = await listen(t, dir, bridge);
  await bridge.connect({ deploy: false });
  const oldRequest = bridge.requests[0];
  assert.equal(
    (
      await fetch(base + '/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ vm: { host: '192.0.2.99' }, language: 'en' }),
      })
    ).status,
    200,
  );
  assert.equal(defined(defined(oldRequest).signal).aborted, true);
  bridge.state = {
    ...idleRecoveryState(),
    conversationId: 'new-vm',
    settings: { language: 'zh', timeZone: 'Europe/Paris' },
  };
  await bridge.connect({ deploy: false });
  await settle(() => bridge.state.settings.language === 'en');
  const refreshes = bridge.refreshes.length;
  late.resolve();
  await settle();
  assert.equal(
    bridge.refreshes.length,
    refreshes,
    'the old acknowledgement cannot refresh the new VM',
  );
  assert.equal(bridge.state.settings.language, 'en');
  assert.equal(app.snapshot().conversationId, 'new-vm');
  assert.equal(app.snapshot().settings.language, 'en');
  assert.deepEqual(
    bridge.requests.map((item) => item.values.language),
    ['zh', 'en'],
  );
});

test('closing the Controller aborts a preference write even when its mock bridge emits no close event', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.100');
  const bridge = new PreferenceBridge({
      ...idleRecoveryState(),
      settings: { language: 'en', timeZone: 'Europe/Paris' },
    }),
    late = gate();
  bridge.write = () => late.promise;
  const { app } = await listen(t, dir, bridge);
  await bridge.connect({ deploy: false });
  const request = bridge.requests[0];
  await app.close();
  assert.equal(defined(defined(request).signal).aborted, true);
  late.resolve();
  await settle();
  assert.equal(bridge.refreshes.length, 0);
  assert.equal(bridge.requests.length, 1);
});

test('a mixed settings request cannot send its remaining model mutation to a new VM after awaited language synchronization', async (t) => {
  const dir = temporary(t);
  writeProfile(dir, '192.0.2.101');
  const bridge = new PreferenceBridge(idleRecoveryState()),
    late = gate();
  t.after(() => late.resolve());
  bridge.write = (request) => (request.values.language === 'en' ? late.promise : undefined);
  const { base, headers } = await listen(t, dir, bridge);
  await bridge.connect({ deploy: false });
  const pending = fetch(base + '/api/settings', {
    method: 'PATCH',
    headers,
    body: '{"language":"en","model":"old-vm-only"}',
  });
  await settle(() => bridge.requests.length === 1);
  const oldRequest = bridge.requests[0];
  assert.equal(
    (
      await fetch(base + '/api/settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ vm: { host: '192.0.2.102' }, language: 'zh' }),
      })
    ).status,
    200,
  );
  assert.equal(defined(defined(oldRequest).signal).aborted, true);
  bridge.state = { ...idleRecoveryState(), conversationId: 'new-vm' };
  await bridge.connect({ deploy: false });
  late.resolve();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /VM connection changed/);
  assert.equal(bridge.state.settings.model, undefined);
  assert.equal(
    bridge.requests.some((request) => request.values.model === 'old-vm-only'),
    false,
    'a stale model mutation must not cross VM ownership',
  );
});
