import { activeTaskFixture, engineCallFixture } from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import type { ApiVoiceFactoryOptions } from '../../src/app/worker-app-types.ts';
import { VoiceFixture } from '../support/protocol-fixtures.mts';
import { NativeVoiceFixture } from '../support/native-service-fixtures.mts';
import {
  nativeSessionFixture,
  nativeTurnFixture,
  observedRecord,
  observedArray,
} from '../support/service-fixtures.mts';
import type { Engine } from '../../src/work/engine.mts';
import { WorkerServiceFixture, listeningPort } from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkerApp } from '../../src/app/server.mts';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup(t: NodeTestContext) {
  const dataDir = fs.mkdtempSync(path.join(root, 'server-tools-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  class Worker extends WorkerServiceFixture {
    declare calls: Array<{ method: string; params: RpcParams | undefined }>;
    declare failDiscovery: boolean;
    constructor() {
      super();
      this.status = 'online';
      this.calls = [];
    }
    async request(method: string, params?: RpcParams): Promise<RpcResult> {
      this.calls.push({ method, params });
      if (this.failDiscovery) throw Error('private-transport-diagnostic');
      return {};
    }
    disconnect() {
      this.status = 'offline';
    }
  }
  class Provider extends VoiceFixture {
    declare state: { available: boolean };
    declare stopped: boolean;
    constructor() {
      super();
      this.state = { available: true };
    }
    close = async () => {};
    stop = async () => {
      this.stopped = true;
    };
  }
  class NativeProvider extends NativeVoiceFixture {
    declare stopped: boolean;
    close = async () => {};
    async stop() {
      this.stopped = true;
    }
  }
  const worker = new Worker(),
    voice = new Provider(),
    nativeVoice = new NativeProvider();
  let voiceOptions!: ApiVoiceFactoryOptions;
  const instance = createWorkerApp({
    dataDir,
    workerFactory: () => worker,
    voiceFactory: (options) => {
      voiceOptions = options;
      return voice;
    },
    nativeVoiceFactory: () => nativeVoice,
  });
  t.after(async () => {
    instance.engine.active = null;
    await instance.close();
  });
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + listeningPort(instance.server),
    { token } = await fetch(base + '/api/session').then((response) => response.json());
  const request = (
    route: string,
    {
      method = 'GET',
      body,
      headers = {},
    }: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    fetch(base + '/api' + route, {
      method,
      headers: {
        'X-Dant-Token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const internal = (tool: string, args: unknown = {}, headers: Record<string, string> = {}) =>
    request('/internal/credentials', {
      method: 'POST',
      body: { tool, arguments: args },
      headers: { 'X-Dant-Credential-Token': worker.credentialBridgeToken, ...headers },
    });
  const active = () =>
    (instance.engine.active = activeTaskFixture({
      turnId: 'accepted-turn',
      messageIds: [],
      startAcknowledged: true,
      stopRequested: false,
      finishing: false,
    }));
  return {
    dataDir,
    base,
    instance,
    worker,
    voice,
    nativeVoice,
    voiceOptions,
    request,
    internal,
    active,
  };
}

test('public credential APIs expose metadata, preserve omitted secrets, and persist encrypted values only', async (t) => {
  const h = await setup(t),
    secret = 'isolated-password-never-in-public-state';
  assert.deepEqual(await (await h.request('/credentials')).json(), { items: [], requests: [] });
  const response = await h.request('/credentials', {
      method: 'POST',
      body: { name: 'Work', service: 'work.example', username: 'tester', secret },
    }),
    item = await response.json();
  assert.equal(response.status, 200);
  assert.equal('secret' in item, false);
  assert.equal(h.instance.credentials.get(item.id).secret, secret);
  const updated = await (
    await h.request('/credentials/' + item.id, { method: 'PATCH', body: { name: 'Updated work' } })
  ).json();
  assert.equal(updated.name, 'Updated work');
  assert.equal(h.instance.credentials.get(item.id).secret, secret);
  const state = await (await h.request('/state')).json();
  assert.equal(state.credentials.items[0].id, item.id);
  assert.deepEqual(state.credentials.requests, []);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(JSON.stringify(state).includes(h.worker.credentialBridgeToken), false);
  assert.equal(JSON.stringify(h.worker).includes(h.worker.credentialBridgeToken), false);
  assert.equal(
    fs.readFileSync(path.join(h.dataDir, 'credentials', 'vault.enc'), 'utf8').includes(secret),
    false,
  );
  assert.equal((await h.request('/credentials/' + item.id)).status, 404); // no public raw-secret GET route
  const invalid = await h.request('/credentials/' + item.id, {
    method: 'PATCH',
    body: { secret: '\0' + secret },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.text()).includes(secret), false);
  assert.equal(h.instance.credentials.get(item.id).secret, secret);
  const malformed = await fetch(h.base + '/api/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"secret":"' + secret + '", INVALID}',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes(secret), false);
  assert.equal((await h.request('/credentials/' + item.id, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await h.request('/state')).json()).credentials.items, []);
  assert.equal(h.instance.store.state.messages.length, 0);
});

test('internal tool bridge requires its private token and a current acknowledged exact VM task', async (t) => {
  const h = await setup(t),
    secret = 'private-value-returned-only-to-current-mcp',
    item = h.instance.credentials.upsert({ name: 'Private', secret });
  assert.equal(
    (await h.internal('credential_get', { id: item.id }, { 'X-Dant-Credential-Token': 'forged' }))
      .status,
    403,
  );
  assert.equal((await h.internal('credential_get', { id: item.id })).status, 409);
  const active = h.active();
  active.startAcknowledged = false;
  assert.equal((await h.internal('credential_get', { id: item.id })).status, 409);
  active.startAcknowledged = true;
  for (const flag of ['stopRequested', 'finishing'] as const) {
    Object.defineProperty(active, flag, { value: true, configurable: true, writable: true });
    assert.equal((await h.internal('credential_get', { id: item.id })).status, 409);
    active[flag] = false;
  }
  assert.equal((await h.internal('send_message', { text: 'No side effects' })).status, 400);
  assert.equal((await h.internal('credential_get', [])).status, 400);
  assert.equal((await h.internal('credential_get', { id: 'invalid' })).status, 400);
  assert.equal(h.instance.store.state.messages.length, 0);
  const result = await h.internal('credential_get', { id: item.id });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).secret, secret);
  const badOrigin = await h.internal(
    'credential_get',
    { id: item.id },
    { Origin: 'https://untrusted.example' },
  );
  assert.equal(badOrigin.status, 403);
  let release!: (value: unknown) => void;
  h.instance.engine.tool = async () => new Promise((resolve) => (release = resolve));
  const pending = h.internal('credential_get', { id: item.id });
  while (!release) await tick();
  active.stopRequested = true;
  release({ secret });
  const stale = await pending;
  assert.equal(stale.status, 409);
  assert.equal((await stale.text()).includes(secret), false);
});

test('secure forms fulfill through separate metadata-only APIs and cancel on loss of scope or shutdown', async (t) => {
  const h = await setup(t);
  h.active();
  const pending = h.internal('credential_request', {
    name: 'Account',
    service: 'example.test',
    reason: 'Sign in for requested work',
  });
  let request;
  while (!(request = h.instance.credentials.snapshot().requests[0])) await tick();
  assert.equal(h.instance.store.state.messages.length, 0);
  const visible = await (await h.request('/credentials')).json();
  assert.equal(visible.requests[0].id, request.id);
  assert.equal('owner' in visible.requests[0], false);
  const secret = 'secure-form-only-password',
    fulfill = await h.request('/credentials/requests/' + request.id, {
      method: 'POST',
      body: { username: 'user', secret },
    });
  assert.equal(fulfill.status, 200);
  assert.equal((await fulfill.text()).includes(secret), false);
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal((await result.text()).includes(secret), false);
  const cancelled = h.instance.credentials.request(
    { name: 'Cancel me' },
    { owner: 'accepted-turn', isCurrent: () => true },
  );
  const cancelledId = defined(h.instance.credentials.snapshot().requests[0]).id;
  const rejection = assert.rejects(cancelled, /cancelled/);
  assert.equal(
    (await h.request('/credentials/requests/' + cancelledId, { method: 'DELETE' })).status,
    200,
  );
  await rejection;
  const stale = h.instance.credentials.request(
    { name: 'Stale' },
    { owner: 'old', isCurrent: () => false },
  );
  await assert.rejects(stale, /no longer active/);
  const closing = h.instance.credentials.request(
      { name: 'Closing' },
      { owner: 'old', isCurrent: () => true },
    ),
    closed = assert.rejects(closing, /cancelled/);
  await h.instance.close();
  await closed;
  assert.deepEqual(h.instance.credentials.snapshot().requests, []);
});

test('API voice tool callbacks cannot borrow an unrelated active task or replay into a later call', async (t) => {
  const h = await setup(t),
    item = h.instance.credentials.upsert({ name: 'Private', secret: 'scoped-voice-secret' });
  h.active();
  h.instance.engine.call = engineCallFixture({ id: 'voice-one', provider: 'api' });
  const scope = { callId: 'voice-one', isCurrent: () => true };
  const result = await h.voiceOptions.tool('credential_get', { id: item.id }, scope);
  assert.equal(observedRecord(result).secret, 'scoped-voice-secret');
  h.instance.engine.call = engineCallFixture({ id: 'voice-two', provider: 'api' });
  assert.throws(
    () => h.voiceOptions.tool('credential_get', { id: item.id }, scope),
    /no longer active/,
  );
  assert.throws(() => h.voiceOptions.tool('credential_get', { id: item.id }), /no longer active/);
  assert.throws(
    () =>
      h.voiceOptions.tool(
        'credential_get',
        { id: item.id },
        { callId: 'voice-two', isCurrent: () => false },
      ),
    /no longer active/,
  );
  h.instance.engine.call = engineCallFixture({ id: 'subscription', provider: 'subscription' });
  assert.throws(
    () =>
      h.voiceOptions.tool(
        'credential_get',
        { id: item.id },
        { callId: 'subscription', isCurrent: () => true },
      ),
    /no longer active/,
  );
  h.instance.store.add({ role: 'user', text: 'Old message containing scoped-voice-secret' });
  assert.equal(h.voiceOptions.context().includes('scoped-voice-secret'), false);
});

test('API media closure routes only the current call to continuation or explicit shutdown', async (t) => {
  const h = await setup(t),
    engine = h.instance.engine,
    continued: string[] = [],
    stopped: Array<Parameters<Engine['waitStopped']>[0]> = [];
  engine.continueVoiceTasks = (id) => continued.push(defined(id));
  engine.waitStopped = async (active) => {
    stopped.push(defined(active));
  };
  for (const reason of ['user', 'tool', 'connection-lost', 'error', 'shutdown'] as const) {
    const callId = 'api-' + reason;
    engine.call = engineCallFixture({ id: callId, provider: 'api' });
    const active = (engine.active = activeTaskFixture({
      messageId: 'task-' + reason,
      startAcknowledged: true,
    }));
    engine.voiceTasks.set(defined(active.messageId), {
      callId,
      background: false,
      resolve() {},
      reject() {},
    });
    const before = continued.length + stopped.length;
    h.voice.emit('closed', { callId: 'stale-call', reason: 'user' });
    assert.equal(defined(engine.call).id, callId);
    assert.equal(continued.length + stopped.length, before);
    h.voice.emit('closed', { callId, reason });
    assert.equal(engine.call, null);
    if (['user', 'tool', 'connection-lost'].includes(reason))
      assert.equal(continued.at(-1), callId);
    else assert.equal(stopped.at(-1), active);
    engine.active = null;
    engine.voiceTasks.clear();
  }
});

test('native internal tools reject unknown, paused or completed turn scopes', async (t) => {
  const h = await setup(t),
    s = nativeSessionFixture({ id: 'native-call', status: 'connected', turns: new Map() }),
    turn = nativeTurnFixture({ turnId: 'native-turn', done: false });
  s.turns.set(turn.turnId, turn);
  h.nativeVoice.session = s;
  h.instance.engine.call = engineCallFixture({ id: s.id, provider: 'subscription' });
  assert.equal((await h.internal('credential_find', { query: '' })).status, 200);
  for (const [object, flag] of [
    [s, 'unknown'],
    [s, 'pausing'],
    [s, 'stopping'],
    [s, 'closed'],
    [turn, 'done'],
    [turn, 'pauseRequested'],
  ] as const) {
    Object.defineProperty(defined(object), flag, {
      value: true,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    assert.equal((await h.internal('credential_find', { query: '' })).status, 409, flag);
    Object.defineProperty(defined(object), flag, {
      value: false,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  s.turns.set('second', nativeTurnFixture({ turnId: 'second', done: false }));
  assert.equal((await h.internal('credential_find', { query: '' })).status, 409);
});

test('hanging up media preserves the exact accepted native task credential scope until completion', async (t) => {
  const h = await setup(t),
    s = nativeSessionFixture({ id: 'background-call', status: 'connected', turns: new Map() }),
    turn = nativeTurnFixture({ turnId: 'background-turn', done: false });
  s.turns.set(turn.turnId, turn);
  h.nativeVoice.session = s;
  h.instance.engine.call = engineCallFixture({ id: s.id, provider: 'subscription' });
  const pending = h.internal('credential_request', {
    name: 'Background login',
    service: 'example.test',
  });
  let request;
  while (!(request = h.instance.credentials.snapshot().requests[0])) await tick();
  s.continueWork = true;
  s.stopping = true;
  s.status = 'stopping';
  assert.equal((await h.internal('credential_find', { query: '' })).status, 200);
  s.closed = true;
  s.stopping = false;
  s.background = true;
  s.status = 'background';
  h.instance.engine.call = null;
  h.nativeVoice.emit('closed', { callId: s.id, workContinues: true });
  assert.equal(h.instance.credentials.snapshot().requests.length, 1);
  assert.equal((await h.internal('credential_find', { query: '' })).status, 200);
  const secret = 'background-secure-form-only';
  assert.equal(
    (
      await h.request('/credentials/requests/' + request.id, {
        method: 'POST',
        body: { username: 'test-user', secret },
      })
    ).status,
    200,
  );
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal((await result.text()).includes(secret), false);
  for (const [object, flag] of [
    [s, 'unknown'],
    [s, 'pausing'],
    [turn, 'done'],
    [turn, 'pauseRequested'],
  ] as const) {
    Object.defineProperty(defined(object), flag, {
      value: true,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    assert.equal((await h.internal('credential_find', { query: '' })).status, 409, flag);
    Object.defineProperty(defined(object), flag, {
      value: false,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  s.background = false;
  s.continueWork = false;
  assert.equal((await h.internal('credential_find', { query: '' })).status, 409);
  assert.equal(JSON.stringify(await (await h.request('/state')).json()).includes(secret), false);
});

test('safety shutdown still cancels a pending native task credential form', async (t) => {
  const h = await setup(t),
    s = nativeSessionFixture({ id: 'unsafe-call', status: 'connected', turns: new Map() }),
    turn = nativeTurnFixture({ turnId: 'unsafe-turn', done: false });
  s.turns.set(turn.turnId, turn);
  h.nativeVoice.session = s;
  h.instance.engine.call = engineCallFixture({ id: s.id, provider: 'subscription' });
  const pending = h.internal('credential_request', { name: 'Cancel on shutdown' });
  while (!h.instance.credentials.snapshot().requests.length) await tick();
  h.nativeVoice.emit('closed', { callId: s.id, workContinues: false });
  const response = await pending;
  assert.equal(response.status, 400);
  assert.deepEqual(h.instance.credentials.snapshot().requests, []);
});

test('managed skill HTTP APIs save real files, preserve helpers, reload discovery and remain usable offline', async (t) => {
  const h = await setup(t),
    input = {
      name: 'report-review',
      description: 'Review a report',
      instructions: 'Read and check the report.',
      files: { 'scripts/check.py': 'print("check")', 'references/checklist.txt': 'Verify totals' },
      enabled: true,
    };
  assert.equal(h.instance.engine.skills, h.instance.skills);
  assert.equal(h.worker.skills, h.instance.skills);
  const created = await h.request('/skills', { method: 'POST', body: input }),
    skill = await created.json();
  assert.equal(created.status, 200);
  assert.equal(skill.name, input.name);
  assert.equal(fs.existsSync(skill.path), true);
  assert.deepEqual(
    (await (await h.request('/skills')).json()).items.map((item: { name: string }) => item.name),
    [input.name],
  );
  assert.equal('instructions' in (await (await h.request('/state')).json()).skills.items[0], false);
  const updated = await (
    await h.request('/skills/' + input.name, {
      method: 'PATCH',
      body: { instructions: 'Updated real instructions.' },
    })
  ).json();
  assert.deepEqual(updated.files, input.files);
  assert.equal(updated.instructions, 'Updated real instructions.');
  const disabled = await (
    await h.request('/skills/' + input.name, { method: 'PATCH', body: { enabled: false } })
  ).json();
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.files, input.files);
  assert.match(disabled.path, /\.dant-disabled-skills/);
  assert.equal(h.instance.skills.context().includes(input.name), false);
  assert.equal(h.worker.calls.filter((call) => call.method === 'skills/list').length, 3);
  assert.ok(
    h.worker.calls.every(
      (call) =>
        defined(call.params).forceReload &&
        observedArray(defined(call.params).cwds)[0] === h.instance.engine.workspace,
    ),
  );
  h.worker.status = 'offline';
  const calls = h.worker.calls.length;
  assert.equal(
    (await h.request('/skills/' + input.name, { method: 'PATCH', body: { enabled: true } })).status,
    200,
  );
  assert.equal(h.worker.calls.length, calls);
  assert.equal((await (await h.request('/skills/' + input.name)).json()).enabled, true);
  assert.equal((await h.request('/skills/' + input.name, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await h.request('/skills')).json()).items, []);
});

test('skill failures are atomic and safe while discovery failure does not undo durable saves', async (t) => {
  const h = await setup(t),
    notices: string[] = [];
  h.instance.engine.on('notice', (message) => notices.push(message));
  h.instance.credentials.upsert({ name: 'Private', secret: 'never-store-this-in-a-skill' });
  const input = {
    name: 'safe-skill',
    description: 'A reusable safe procedure',
    instructions: 'Do safe work.',
    files: { 'references/guide.txt': 'Safe guide' },
  };
  await h.request('/skills', { method: 'POST', body: input });
  for (const patch of [
    { enabled: 'false' },
    { name: 'renamed' },
    { files: { '../escape.txt': 'No' } },
    { instructions: 'never-store-this-in-a-skill' },
  ] as const) {
    const response = await h.request('/skills/' + input.name, { method: 'PATCH', body: patch });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.equal(text.includes('never-store-this'), false);
    assert.deepEqual(h.instance.skills.get(input.name).files, input.files);
    assert.equal(h.instance.skills.get(input.name).instructions, input.instructions);
  }
  assert.equal(
    (await h.request('/skills', { method: 'POST', body: { ...input, name: '../escape' } })).status,
    400,
  );
  assert.equal((await h.request('/skills/missing')).status, 400);
  h.worker.failDiscovery = true;
  const saved = await h.request('/skills/' + input.name, {
    method: 'PATCH',
    body: { description: 'Durably updated' },
  });
  assert.equal(saved.status, 200);
  assert.equal(h.instance.skills.get(input.name).description, 'Durably updated');
  assert.equal(notices.length, 1);
  assert.equal(defined(notices[0]).includes('private-transport'), false);
  h.active();
  h.worker.failDiscovery = false;
  assert.equal((await h.internal('skill_list')).status, 200);
  const read = await h.internal('skill_get', { name: input.name });
  assert.equal((await read.json()).instructions, input.instructions);
  const created = await h.internal('skill_save', {
    name: 'from-model',
    description: 'Model managed',
    instructions: 'Check data before responding.',
    files: { 'references/notes.txt': 'Relevant notes' },
    enabled: false,
  });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).saved, true);
  assert.equal(h.instance.skills.get('from-model').enabled, false);
  assert.equal(h.instance.store.state.messages.length, 0);
});

test('malformed skill directories cannot break state snapshots or expose filesystem diagnostics', async (t) => {
  const h = await setup(t);
  fs.mkdirSync(path.join(h.instance.engine.workspace, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(h.instance.engine.workspace, '.agents', 'skills'), 'not-a-directory');
  const listing = await h.request('/skills');
  assert.equal(listing.status, 200);
  const skills = await listing.json();
  assert.deepEqual(skills.items, []);
  assert.match(skills.error, /Existing files were preserved/);
  const state = await h.request('/state');
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json()).skills, skills);
  assert.equal(JSON.stringify(skills).includes(h.instance.engine.workspace), false);
});
