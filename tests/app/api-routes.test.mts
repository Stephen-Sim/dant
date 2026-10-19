import {
  activeTaskFixture,
  engineCallFixture,
  rpcText,
  emitFixtureEvent,
  observedRecord,
} from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import type { WorkerAppOptions } from '../../src/app/worker-app-types.ts';
import { WorkerServiceFixture, listeningPort } from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkerApp } from '../../src/app/server.mts';
import { API_JSON_BODY_BYTES } from '../../src/config/network.mts';
import { Store } from '../../src/conversation/store.mts';
import { SKILL_SUPPORT_FILE_LIMIT, SKILL_ARCHIVE_BYTES } from '../../src/skills/skill-limits.mts';
import { VoiceKeyStore } from '../../src/security/secrets.mts';
import { readAppState } from '../../ui/app/application-state.mts';
import { workProgress } from '../../ui/work/work-progress.mts';
import { skillPngFixture } from '../support/skill-png-fixtures.mts';
import { VoiceFixture } from '../support/protocol-fixtures.mts';
import { NativeVoiceFixture } from '../support/native-service-fixtures.mts';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
class Worker extends WorkerServiceFixture {
  declare calls: Array<{ method: string; params: RpcParams | undefined }>;
  declare turns: number;
  declare connections: number;
  declare connectWait: (() => Promise<unknown>) | undefined;
  constructor() {
    super();
    this.status = 'online';
    this.calls = [];
    this.rpc = { reply() {}, send() {} };
    this.turns = 0;
    this.connections = 0;
  }
  async connect() {
    this.connections++;
    this.status = 'connecting';
    if (this.connectWait) await this.connectWait();
    this.status = 'online';
    return { ok: true };
  }
  async request(method: string, params?: RpcParams): Promise<RpcResult> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'api-thread' } };
    if (method === 'turn/start') return { turn: { id: 'api-turn-' + ++this.turns } };
    if (method === 'turn/interrupt')
      queueMicrotask(() =>
        this.emit('event', {
          method: 'turn/completed',
          params: {
            threadId: 'api-thread',
            turn: { id: defined(params?.turnId), status: 'interrupted' },
          },
        }),
      );
    return { ok: true };
  }
  async guest(route: string) {
    if (route === '/screen') return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  disconnect() {
    this.status = 'offline';
    this.emit('status');
  }
}
async function fixture(t: NodeTestContext, options: WorkerAppOptions = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'api-routes-')),
    worker = new Worker(),
    keys = { configured: false };
  const instance = createWorkerApp({
    dataDir: dir,
    workerFactory: () => worker,
    secretFactory: () => ({
      status: () => ({ ...keys }),
      set: async () => {
        keys.configured = true;
      },
      clear: async () => {
        keys.configured = false;
      },
      get: async () => null,
    }),
    ...options,
  });
  t.after(async () => {
    await instance.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + listeningPort(instance.server),
    { token } = await fetch(base + '/api/session').then((response) => response.json());
  async function api(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    return fetch(base + '/api' + route, {
      method,
      headers: {
        'X-Dant-Token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return { ...instance, worker, api, base, token, dir };
}

test('a new Worker state decodes and renders progress with unconfigured voice and no reported usage', async (t) => {
  const { api, worker, engine } = await fixture(t, {
    secretFactory: (dir) => new VoiceKeyStore(dir, { platform: 'linux', env: {} }),
  });
  const response = await api('/state');
  assert.equal(response.status, 200);
  const wire: unknown = await response.json(),
    raw = observedRecord(wire),
    key = observedRecord(observedRecord(observedRecord(raw.worker).realtime).key),
    usage = observedRecord(raw.usage);
  assert.equal(key.configured, false);
  assert.equal(key.source, null, 'the real secret store reports absence as null');
  assert.equal(usage.recordedSince, null);
  for (const source of ['subscription', 'apiVoice']) {
    const counters = observedRecord(usage[source]);
    assert.equal(counters.available, false);
    assert.equal(counters.totals, null);
    assert.equal(counters.lastResponse, null);
  }
  const state = readAppState(wire),
    progress = workProgress(state);
  assert.equal(state.worker.realtime?.key?.source, null);
  assert.equal(state.usage?.recordedSince, null);
  assert.equal(progress.active, null);
  assert.deepEqual(progress.items, []);
  assert.deepEqual(progress.queue, []);
  assert.equal(progress.completedCount, 0);
  assert.equal(engine.active, null);
  assert.equal(worker.connections, 0);
  assert.deepEqual(worker.calls, []);
});

test('state exposes durable native and optional API voice usage without launching work', async (t) => {
  const { api, worker, engine, store } = await fixture(t);
  let state = await (await api('/state')).json();
  assert.equal(state.usage.subscription.available, false);
  assert.equal(state.usage.apiVoice.available, false);
  store.state.threadId = 'usage-thread';
  worker.emit('event', {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'usage-thread',
      turnId: 'usage-turn',
      tokenUsage: {
        total: {
          inputTokens: 100,
          cachedInputTokens: 30,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 120,
        },
        last: {
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 2,
          reasoningOutputTokens: 1,
          totalTokens: 12,
        },
        modelContextWindow: 128000,
      },
    },
  });
  emitFixtureEvent(engine.voice, 'usage', {
    callId: 'usage-call',
    responseId: 'usage-response',
    usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
  });
  state = await (await api('/state')).json();
  assert.equal(state.usage.subscription.totals.totalTokens, 120);
  assert.equal(state.usage.apiVoice.totals.totalTokens, 50);
  assert.equal(state.usage.apiVoice.totals.cachedInputTokens, null);
  assert.equal(worker.calls.length, 0);
  assert.equal(engine.active, null);
});

test('visible attachment snapshots protect a newer file from an older read receipt and reject invalid receipt shapes', async (t) => {
  const { api, store } = await fixture(t),
    one = { id: randomUUID(), name: 'one.png' },
    two = { id: randomUUID(), name: 'two.png' },
    message = store.add({
      role: 'assistant',
      status: 'completed',
      text: 'Result',
      attachments: [one],
    });
  store.update(message.id, { attachments: [one, two] });
  assert.equal(
    (await api('/read', { ids: [message.id], attachmentSnapshots: { [message.id]: [one.id] } }))
      .status,
    200,
  );
  assert.equal(message.read, false);
  assert.deepEqual(message.visibleAttachmentIds, [one.id]);
  assert.equal(
    (await api('/read', { ids: [message.id], attachmentSnapshots: { [message.id]: [two.id] } }))
      .status,
    200,
  );
  assert.equal(message.read, true);
  assert.deepEqual(new Set(message.visibleAttachmentIds), new Set([one.id, two.id]));
  for (const attachmentSnapshots of [
    null,
    [],
    { foreign: [one.id] },
    { [message.id]: ['not-a-file'] },
    { [message.id]: Array(6).fill(one.id) },
  ] as const)
    assert.equal((await api('/read', { ids: [message.id], attachmentSnapshots })).status, 400);
  const legacy = store.add({
    role: 'assistant',
    status: 'completed',
    text: 'Legacy',
    attachments: [one],
  });
  assert.equal((await api('/read', { ids: [legacy.id] })).status, 200);
  assert.equal(legacy.read, true);
  assert.equal(legacy.visibleAttachmentIds, undefined);
});

test('explicit task replies expose a capability and continue the exact waiting task with durable target metadata', async (t) => {
  const f = await fixture(t),
    { store, engine, worker, api } = f;
  Object.assign(store.state, {
    threadId: 'api-thread',
    threadRuntime: engine.runtimeId,
    threadConversationId: store.state.conversationId,
  });
  engine.loaded = true;
  const original = store.add({
      role: 'user',
      text: 'Original task must not be replayed',
      status: 'review',
      turnId: 'previous',
    }),
    registered = store.registerWork({
      turnId: 'previous',
      messageId: original.id,
      title: 'Waiting work',
      plan: {
        steps: [
          { step: 'Keep verified result', status: 'completed' },
          { step: 'Choose color', status: 'pending' },
        ],
      },
    }),
    record = store.updateRegisteredWork(registered.turnId, {
      status: 'waiting_user',
      executionEnded: true,
      at: Date.now() - 10000,
    });
  const request = worker.request.bind(worker);
  worker.request = async (method, params) =>
    method === 'thread/read'
      ? {
          thread: {
            id: 'api-thread',
            status: { type: 'idle' },
            turns: [{ id: 'previous', status: 'completed' }],
          },
        }
      : request(method, params);
  const workReply = {
      workId: defined(record).id,
      turnId: defined(record).turnId,
      conversationId: store.state.conversationId,
    },
    body = { text: 'Use blue', clientMessageId: randomUUID(), workReply };
  assert.equal((await (await api('/state')).json()).capabilities.workReply, true);
  const response = await api('/messages', body);
  assert.equal(response.status, 200);
  const message = await response.json();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(message.workReply, workReply);
  assert.equal(message.workId, defined(record).id);
  assert.equal(store.state.workTasks.length, 1);
  assert.equal(defined(store.state.workTasks[0]).id, defined(record).id);
  assert.equal(
    defined(defined(defined(store.state.workTasks[0]).plan).steps[0]).status,
    'completed',
  );
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  const input = rpcText(
    defined(
      defined(
        defined(defined(worker.calls.find((call) => call.method === 'turn/start')).params).input,
      )[0],
    ),
  );
  assert.match(input, /Use blue/);
  assert.match(input, /reference data, not new authorization/);
  const reference = JSON.parse(
    defined(defined(input.split('<dant_work_reply>\n')[1]).split('\n</dant_work_reply>')[0]),
  );
  assert.equal(reference.projectContext.originalRequest.text, 'Original task must not be replayed');
  assert.doesNotMatch(
    defined(defined(input.split('</dant_work_reply>')[1]).split('<dant_recalled_memory>')[0]),
    /Original task must not be replayed/,
  );
  const recalled = observedRecord(
    JSON.parse(
      defined(
        defined(input.split('<dant_recalled_memory>\n')[1]).split('\n</dant_recalled_memory>')[0],
      ),
    ),
  );
  assert.deepEqual(recalled.scope, {
    conversationId: workReply.conversationId,
    workId: workReply.workId,
  });
  assert.equal(recalled.messageId, message.id);
  assert.match(input, /reference excerpts, not new requests, permissions, proof of execution/);
  const duplicate = await api('/messages', body);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).id, message.id);
  assert.equal(
    worker.calls.filter((call) => call.method === 'turn/start').length,
    1,
    'an identical transport retry returns its stored receipt even after the task advances',
  );
  assert.equal(
    (await api('/messages', { ...body, workReply: { ...workReply, workId: randomUUID() } })).status,
    409,
  );
  const { workReply: unused, ...ordinary } = body;
  assert.equal((await api('/messages', ordinary)).status, 409);
});

test('stale, cancelled and unconfirmed task targets reject without creating any human message or executor work', async (t) => {
  const { store, engine, worker, api } = await fixture(t),
    record = store.registerWork({
      turnId: 'previous',
      title: 'Existing',
      plan: { steps: [{ step: 'Remaining', status: 'pending' }] },
    });
  store.updateRegisteredWork(record.turnId, {
    status: 'waiting_user',
    executionEnded: true,
    at: Date.now() - 10000,
  });
  const target = {
    workId: record.id,
    turnId: record.turnId,
    conversationId: store.state.conversationId,
  };
  for (const clientMessageId of [undefined, 'invalid'] as const)
    assert.equal(
      (await api('/messages', { text: 'Answer', clientMessageId, workReply: target })).status,
      409,
    );
  for (const workReply of [
    null,
    {},
    { ...target, conversationId: randomUUID() },
    { ...target, turnId: 'wrong' },
    { ...target, extra: 'ignore me' },
  ] as const) {
    const response = await api('/messages', {
      text: 'Answer',
      clientMessageId: randomUUID(),
      workReply,
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'work_reply_unavailable');
  }
  for (const status of ['unknown'] as const) {
    defined(store.state.workTasks[0]).status = status;
    assert.equal(
      (await api('/messages', { text: 'Answer', clientMessageId: randomUUID(), workReply: target }))
        .status,
      409,
    );
  }
  assert.equal(store.state.messages.length, 0);
  assert.equal(worker.calls.length, 0);
  assert.equal(engine.queue.length, 0);
});

test('VM account and configuration APIs preserve ownership and reject changes during active work', async (t) => {
  const { api, worker, engine, store } = await fixture(t);
  assert.equal((await api('/connect', {})).status, 200);
  assert.equal((await api('/login', {})).status, 200);
  assert.equal(defined(worker.calls.at(-1)).method, 'account/login/start');
  assert.equal(defined(defined(worker.calls.at(-1)).params).type, 'chatgptDeviceCode');
  assert.equal(
    (
      await api(
        '/settings',
        {
          language: 'en',
          notifications: false,
          model: 'fixture-model',
          nativeVoice: 'ember',
          apiVoice: 'marin',
        },
        'PATCH',
      )
    ).status,
    200,
  );
  assert.equal(store.state.settings.language, 'en');
  assert.equal(store.state.settings.nativeVoice, 'ember');
  assert.equal(store.state.settings.model, 'fixture-model');
  assert.equal((await api('/settings', { vm: { host: 'example.test' } }, 'PATCH')).status, 400);
  engine.call = engineCallFixture({ id: 'call-guard', provider: 'subscription' });
  for (const [route, body, method] of [
    ['/connect', {}],
    ['/logout', {}],
    ['/settings', { model: 'other' }, 'PATCH'],
    ['/voice-key', { key: 'never-stored' }],
    ['/voice-key', {}, 'DELETE'],
  ] as const)
    assert.equal((await api(route, body, method)).status, 400, route);
  assert.equal(store.state.settings.model, 'fixture-model');
  engine.call = null;
  assert.equal((await api('/voice-key', { key: 'test-only' })).status, 200);
  assert.equal((await api('/state').then((r) => r.json())).worker.realtime.key.configured, true);
  assert.equal((await api('/voice-key', {}, 'DELETE')).status, 200);
  assert.equal((await api('/logout', {})).status, 200);
  assert.equal(defined(worker.calls.at(-1)).method, 'account/logout');
});

test('private task progress failures expose only fixed whitelisted codes without leaking exceptions or changing credential errors', async (t) => {
  const { base, worker, engine } = await fixture(t),
    originalTool = engine.tool,
    secret = 'private-task-plan-diagnostic-and-arguments',
    active = activeTaskFixture({
      turnId: 'safe-error-owner',
      messageIds: [],
      startAcknowledged: true,
      stopRequested: false,
      finishing: false,
    });
  let calls = 0,
    code: string | undefined;
  const internal = (tool: string, args: unknown = {}, token = worker.credentialBridgeToken) =>
    fetch(base + '/api/internal/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dant-Credential-Token': token },
      body: JSON.stringify({ tool, arguments: args }),
    });
  engine.tool = async () => {
    calls++;
    throw Object.assign(Error(secret), { code });
  };
  try {
    assert.equal((await internal('task_plan', { title: secret }, 'forged-token')).status, 403);
    assert.equal((await internal('task_plan', { title: secret })).status, 409);
    assert.equal(calls, 0);
    engine.active = active;
    for (code of [
      'work_not_found',
      'work_conflict',
      'work_not_continuable',
      'work_stale_turn',
      secret,
      undefined,
    ] as const) {
      const response = await internal('task_plan', { title: secret });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: 'The task progress request could not be completed.',
        ...(['work_not_found', 'work_conflict', 'work_not_continuable', 'work_stale_turn'].includes(
          code ?? '',
        )
          ? { code }
          : {}),
      });
    }
    const before = calls,
      response = await internal('task_plan', []);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'The task progress request could not be completed.',
    });
    assert.equal(calls, before);
    code = 'work_not_found';
    const credential = await internal('credential_get', { id: secret });
    assert.equal(credential.status, 400);
    assert.deepEqual(await credential.json(), {
      error: 'The credential operation could not be completed.',
    });
    let release!: (value: unknown) => void;
    engine.tool = () => new Promise<unknown>((resolve) => (release = resolve));
    const pending = internal('task_plan', { title: secret });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    active.stopRequested = true;
    release({ secret });
    const stale = await pending;
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      error: 'The task progress request is no longer active.',
    });
  } finally {
    engine.active = null;
    engine.tool = originalTool;
  }
});

test('call caption preferences persist strictly without changing a current call, media or executor', async (t) => {
  const { api, store, dir, worker, engine } = await fixture(t, {
      voiceFactory: () => Object.assign(new VoiceFixture(), { close: async () => {} }),
      nativeVoiceFactory: () => Object.assign(new NativeVoiceFixture(), { close: async () => {} }),
    }),
    call = engineCallFixture({ id: 'caption-call', provider: 'api', status: 'connected' }),
    active = activeTaskFixture({ turnId: 'caption-existing-turn', messageIds: [] });
  assert.equal((await (await api('/state')).json()).settings.showCallCaptions, true);
  engine.call = call;
  engine.active = active;
  engine.loaded = true;
  try {
    for (const showCallCaptions of [false, true, false]) {
      assert.equal((await api('/settings', { showCallCaptions }, 'PATCH')).status, 200);
      assert.equal(store.state.settings.showCallCaptions, showCallCaptions);
      assert.equal(new Store(dir).state.settings.showCallCaptions, showCallCaptions);
      assert.equal(engine.call, call);
      assert.equal(engine.active, active);
      assert.equal(engine.loaded, true);
      assert.equal(worker.calls.length, 0);
      assert.equal(worker.connections, 0);
    }
    const saved = fs.readFileSync(store.file, 'utf8'),
      before = structuredClone(store.state);
    for (const showCallCaptions of [null, 'false', 0, 1, [], {}]) {
      const response = await api('/settings', { showCallCaptions, notifications: false }, 'PATCH');
      assert.equal(response.status, 400);
      assert.deepEqual(store.state, before);
      assert.equal(fs.readFileSync(store.file, 'utf8'), saved);
    }
  } finally {
    engine.call = null;
    engine.active = null;
  }
});

test('desktop state polling exposes only current sanitized captions in RAM and settings saves never persist speech', async (t) => {
  const { api, store, engine, worker, credentials, diagnostics } = await fixture(t, {
      voiceFactory: () => Object.assign(new VoiceFixture(), { close: async () => {} }),
      nativeVoiceFactory: () => Object.assign(new NativeVoiceFixture(), { close: async () => {} }),
    }),
    secret = 'synthetic-caption-secret',
    phrase = 'RAM_ONLY_CAPTION',
    call = engineCallFixture({ id: 'caption-current', provider: 'api', status: 'connected' }),
    emit = (sequence: number, patch: Record<string, unknown> = {}) =>
      engine.emit('realtime', {
        method: 'dant/call/subtitle',
        params: {
          callId: call.id,
          provider: call.provider,
          sequence,
          text: phrase + ' ' + secret,
          final: true,
          ...patch,
        },
      });
  credentials.upsert({ name: 'Synthetic caption credential', secret });
  engine.call = call;
  try {
    emit(1);
    const first = await (await api('/state')).json();
    assert.equal(first.callCaption.callId, call.id);
    assert.equal(first.callCaption.text, phrase + ' [credential redacted]');
    assert.equal(first.callCaption.final, true);
    emit(1, { text: 'Old repeated speech' });
    emit(2, { callId: 'other-call', text: 'FOREIGN_CAPTION' });
    assert.equal((await (await api('/state')).json()).callCaption.text, first.callCaption.text);
    assert.equal((await api('/settings', { showCallCaptions: false }, 'PATCH')).status, 200);
    assert.equal((await (await api('/state')).json()).callCaption.text, first.callCaption.text);
    const persisted = fs.readFileSync(store.file, 'utf8');
    assert.doesNotMatch(persisted, /RAM_ONLY_CAPTION|synthetic-caption-secret|callCaption/);
    assert.doesNotMatch(JSON.stringify(store.state), /RAM_ONLY_CAPTION|callCaption/);
    assert.doesNotMatch(
      JSON.stringify(diagnostics.recent(50)),
      /RAM_ONLY_CAPTION|synthetic-caption-secret/,
    );
    assert.deepEqual(Object.keys(call).sort(), Object.keys(first.call).sort());
    engine.call = { ...call, id: 'caption-next' };
    engine.change();
    emit(100);
    assert.equal((await (await api('/state')).json()).callCaption, null);
    engine.call = null;
    engine.change();
    emit(101);
    assert.equal((await (await api('/state')).json()).callCaption, null);
    assert.equal(worker.calls.length, 0);
  } finally {
    engine.call = null;
  }
});

test('old Worker settings default call captions on and discard any legacy transient caption payload', (t) => {
  for (const showCallCaptions of [undefined, false, true, 'false', null]) {
    const dir = fs.mkdtempSync(path.join(root, 'caption-store-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new Store(dir),
      raw = observedRecord(JSON.parse(fs.readFileSync(store.file, 'utf8'))),
      settings = observedRecord(raw.settings);
    if (showCallCaptions === undefined) delete settings.showCallCaptions;
    else settings.showCallCaptions = showCallCaptions;
    raw.callCaption = { text: 'LEGACY_RAM_ONLY_SPEECH' };
    fs.writeFileSync(store.file, JSON.stringify(raw));
    const restored = new Store(dir);
    assert.equal(restored.state.settings.showCallCaptions, showCallCaptions !== false);
    assert.doesNotMatch(
      fs.readFileSync(restored.file, 'utf8'),
      /callCaption|LEGACY_RAM_ONLY_SPEECH/,
    );
  }
});

test('standalone Worker work summaries default hidden and persist both toggle values across Store reloads', async (t) => {
  const { api, store, dir } = await fixture(t);
  assert.equal(
    (await api('/state').then((response) => response.json())).settings.showWorkSummary,
    false,
  );
  for (const showWorkSummary of [true, false, true] as const) {
    assert.equal((await api('/settings', { showWorkSummary }, 'PATCH')).status, 200);
    assert.equal(store.state.settings.showWorkSummary, showWorkSummary);
    assert.equal(
      (await api('/state').then((response) => response.json())).settings.showWorkSummary,
      showWorkSummary,
    );
    assert.equal(new Store(dir).state.settings.showWorkSummary, showWorkSummary);
  }
});

test('standalone work summary changes leave a running call and its executor untouched', async (t) => {
  const { api, store, worker, engine } = await fixture(t),
    call = engineCallFixture({ id: 'existing-call', provider: 'api', status: 'connected' }),
    active = activeTaskFixture({ turnId: 'already-running', messageIds: [], voiceOutput: true });
  engine.call = call;
  engine.active = active;
  engine.loaded = true;
  try {
    for (const showWorkSummary of [true, false] as const) {
      assert.equal((await api('/settings', { showWorkSummary }, 'PATCH')).status, 200);
      assert.equal(store.state.settings.showWorkSummary, showWorkSummary);
      assert.equal(engine.call, call);
      assert.equal(engine.active, active);
      assert.equal(engine.loaded, true);
      assert.equal(worker.calls.length, 0);
      assert.equal(worker.connections, 0);
    }
  } finally {
    engine.call = null;
    engine.active = null;
  }
});

test('invalid standalone work summary preferences reject other settings before mutating state or disk', async (t) => {
  const { api, store, engine, worker } = await fixture(t);
  engine.loaded = true;
  const state = structuredClone(store.state),
    saved = fs.readFileSync(store.file, 'utf8');
  for (const showWorkSummary of ['false', 1, 0, null, [], {}] as const) {
    const response = await api(
      '/settings',
      {
        showWorkSummary,
        language: 'en',
        notifications: false,
        model: 'not-applied',
        timeZone: 'Asia/Kuala_Lumpur',
      },
      'PATCH',
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /work summary preference/);
    assert.deepEqual(store.state, state);
    assert.deepEqual(fs.readFileSync(store.file, 'utf8'), saved);
    assert.equal(engine.loaded, true);
    assert.equal(worker.calls.length, 0);
  }
});

test('legacy and invalid stored work summary values normalize to false while an explicit true survives restart', (t) => {
  for (const showWorkSummary of [undefined, false, true, 'true', 1, null, [], {}] as const) {
    const dir = fs.mkdtempSync(path.join(root, 'work-summary-store-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const original = new Store(dir);
    const persisted = observedRecord(JSON.parse(JSON.stringify(original.state))),
      settings = observedRecord(persisted.settings);
    if (showWorkSummary === undefined) delete settings.showWorkSummary;
    else settings.showWorkSummary = showWorkSummary;
    settings.language = 'en';
    fs.writeFileSync(original.file, JSON.stringify(persisted));
    const restored = new Store(dir);
    assert.equal(restored.state.settings.showWorkSummary, showWorkSummary === true);
    assert.equal(restored.state.settings.language, 'en');
    assert.equal(
      JSON.parse(fs.readFileSync(restored.file, 'utf8')).settings.showWorkSummary,
      showWorkSummary === true,
    );
  }
});

test('background native work blocks executor and model replacement even after media hangup', async (t) => {
  const { api, worker, nativeVoice, store } = await fixture(t),
    model = store.state.settings.model;
  Object.defineProperty(nativeVoice, 'active', {
    configurable: true,
    value: { messageId: 'native-background', background: true },
  });
  for (const [route, body, method] of [
    ['/connect', {}],
    ['/logout', {}],
    ['/provision', {}],
    ['/settings', { model: 'replacement' }, 'PATCH'],
  ] as const)
    assert.equal((await api(route, body, method)).status, 400, route);
  assert.equal(store.state.settings.model, model);
  assert.equal(worker.calls.length, 0);
  assert.equal(worker.connections, 0);
  assert.equal(Reflect.deleteProperty(nativeVoice, 'active'), true);
});

test('pending followup or native canonical-reference delivery blocks executor replacement and new calls after its owner ends', async (t) => {
  const { api, worker, engine, store } = await fixture(t),
    model = store.state.settings.model;
  for (const deliveries of [engine.pendingFollowups, engine.callReferences] as const) {
    if (deliveries === engine.pendingFollowups)
      engine.pendingFollowups.set('awaiting-message', new Promise(() => {}));
    else
      engine.callReferences.set('awaiting-message', {
        message: { id: 'awaiting-message' },
        callId: 'fixture-call',
        promise: new Promise(() => {}),
      });
    assert.equal(engine.active, null);
    try {
      for (const [route, body, method] of [
        ['/connect', {}],
        ['/connect', { idleRecovery: true }],
        ['/logout', {}],
        ['/provision', {}],
        ['/settings', { model: 'replacement' }, 'PATCH'],
        ['/call', { sdp: 'unused', provider: 'subscription' }],
      ] as const) {
        const response = await api(route, body, method);
        assert.ok([400, 409].includes(response.status), route);
      }
      assert.equal(store.state.settings.model, model);
      assert.equal(worker.calls.length, 0);
      assert.equal(worker.connections, 0);
      assert.equal(engine.call, null);
    } finally {
      deliveries.clear();
    }
  }
});

test('public work progress keeps ephemeral voice work visible after hangup and exposes only safe plan metadata', async (t) => {
  const { api, engine, nativeVoice } = await fixture(t);
  const progress = {
    messageId: null,
    turnId: 'native-owned-turn',
    source: 'voice',
    background: true,
    status: 'waiting_user',
    startedAt: 100,
    updatedAt: 200,
    step: 'computer',
    plan: { total: 3, completed: 1, currentStep: 'Check the board' },
  };
  Object.defineProperty(nativeVoice, 'progress', { configurable: true, value: progress });
  let snapshot = await api('/state').then((response) => response.json());
  assert.equal(snapshot.call, null);
  assert.deepEqual(snapshot.active, progress);
  assert.equal(snapshot.messages.length, 0);
  engine.active = activeTaskFixture({
    messageId: null,
    turnId: 'api-owned-turn',
    messageIds: [],
    voiceOutput: true,
    backgroundVoice: true,
    awaitingChatInput: true,
    workProgress: { startedAt: 300, updatedAt: 400, step: 'files', items: new Map() },
  });
  snapshot = await api('/state').then((response) => response.json());
  assert.equal(snapshot.active.turnId, 'api-owned-turn');
  assert.equal(snapshot.active.source, 'voice');
  assert.equal(snapshot.active.background, true);
  assert.equal(snapshot.active.status, 'waiting_user');
  assert.equal(snapshot.active.step, 'files');
  assert.equal('items' in snapshot.active, false);
  engine.active = null;
  assert.equal(Reflect.deleteProperty(nativeVoice, 'progress'), true);
});

test('private shared call input references never enter desktop state snapshots', async (t) => {
  const { api, store } = await fixture(t);
  store.state.callInputHistory = [
    {
      messageId: 'private-input',
      callId: 'private-call',
      text: 'PRIVATE_CALL_INPUT',
      quotedMessage: {
        messageId: 'private-quoted-message',
        role: 'assistant',
        text: 'PRIVATE_QUOTED_CONTENT',
        attachments: [],
      },
      conversationId: store.state.conversationId,
      role: 'user',
      at: Date.now(),
      replyTo: null,
      attachments: [],
      submission: 'submitted',
    },
  ];
  store.save();
  const snapshot = await api('/state').then((response) => response.json());
  assert.equal('callInputHistory' in snapshot, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_CALL_INPUT|PRIVATE_QUOTED_CONTENT/);
});

test('steering preflight rejects an unavailable or different owned turn before creating a message or task', async (t) => {
  const { api, engine, nativeVoice, store } = await fixture(t);
  for (const progress of [
    null,
    { turnId: 'native-background', source: 'voice', background: true, canSteer: false },
    { turnId: 'new-turn', canSteer: true },
  ] as const) {
    Object.defineProperty(nativeVoice, 'progress', { configurable: true, value: progress });
    const response = await api('/steer', {
      text: 'Only adjust the displayed turn',
      expectedTurnId: 'native-background',
    });
    assert.equal(response.status, 400);
    assert.equal(store.state.messages.length, 0);
    assert.equal(engine.queue.length, 0);
  }
  assert.equal(Reflect.deleteProperty(nativeVoice, 'progress'), true);
});

test('ordinary chat followups reach the active task once and remain unread until executor acknowledgement', async (t) => {
  const { api, worker, engine, store } = await fixture(t);
  const first = await api('/messages', { text: 'Keep working on the current task' }).then(
    (response) => response.json(),
  );
  while (!engine.active?.turnId) await new Promise((resolve) => setImmediate(resolve));
  const turnId = engine.active.turnId,
    request = worker.request.bind(worker);
  let acknowledge!: (value: RpcResult) => void, entered!: () => void;
  const submitted = new Promise<void>((resolve) => (entered = resolve));
  worker.request = (method, params) => {
    if (method !== 'turn/steer') return request(method, params);
    worker.calls.push({ method, params });
    entered();
    return new Promise((resolve) => (acknowledge = resolve));
  };
  try {
    const payload = {
      text: 'Open the test room first',
      replyTo: first.id,
      clientMessageId: randomUUID(),
    };
    const sent = await api('/messages', payload);
    assert.equal(sent.status, 200);
    await submitted;
    const followup = store.state.messages.find(
      (message) => message.clientMessageId === payload.clientMessageId,
    );
    assert.equal(defined(followup).executorConfirmedAt, null);
    assert.equal(engine.queue.length, 0);
    assert.equal((await api('/messages', payload)).status, 200);
    assert.equal(worker.calls.filter((call) => call.method === 'turn/steer').length, 1);
    acknowledge({});
    await engine.active.steerChain;
    assert.ok(defined(followup).executorConfirmedAt);
    assert.equal(defined(followup).turnId, turnId);
    assert.equal(defined(followup).submission, 'confirmed');
    const steer = worker.calls.find((call) => call.method === 'turn/steer');
    assert.equal(defined(defined(steer).params).expectedTurnId, turnId);
    assert.match(
      rpcText(defined(defined(defined(defined(steer).params).input)[0])),
      /Replying to: Keep working on the current task/,
    );
    assert.match(
      rpcText(defined(defined(defined(defined(steer).params).input)[0])),
      /Open the test room first/,
    );
    assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 1);
    assert.equal(
      store.state.messages.filter((message) => message.clientMessageId === payload.clientMessageId)
        .length,
      1,
    );
    await engine.handle({
      method: 'turn/completed',
      params: { threadId: 'api-thread', turn: { id: turnId, status: 'completed' } },
    });
    assert.equal(defined(followup).status, 'review');
  } finally {
    acknowledge?.({});
  }
});

test('recorded voice API preserves original playback while recognized speech reaches the shared task once', async (t) => {
  const audio = Buffer.from([26, 69, 223, 163, 1, 2, 3, 4]),
    recognized = '请记住紫色自行车。 Remember the purple bicycle.';
  let count = 0;
  const { api, base, token, worker, store, engine } = await fixture(t, {
    audioTranscriberFactory: ({ attachments }) => ({
      transcribe: async (file) => {
        count++;
        assert.deepEqual(observedRecord(defined(attachments).read(file.id)).data, audio);
        return { text: recognized, language: 'zh', duration: 3 };
      },
    }),
  });
  const form = new FormData();
  form.set('file', new Blob([audio], { type: 'audio/webm' }), 'voice.webm');
  const file = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'X-Dant-Token': token },
    body: form,
  }).then((response) => response.json());
  const payload = { text: '', attachments: [file.id], clientMessageId: randomUUID() },
    response = await api('/messages', payload);
  assert.equal(response.status, 200);
  const sent = await response.json();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await api('/messages', payload)).status, 200);
  assert.equal(count, 1);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.match(
    rpcText(
      defined(
        defined(
          defined(defined(worker.calls.find((call) => call.method === 'turn/start')).params).input,
        )[0],
      ),
    ),
    /purple bicycle/,
  );
  assert.equal(sent.text, '');
  assert.equal(
    store.state.messages.filter((message) => message.clientMessageId === payload.clientMessageId)
      .length,
    1,
  );
  const snapshot = await api('/state').then((response) => response.json());
  assert.equal(JSON.stringify(snapshot).includes(recognized), false);
  assert.equal(JSON.stringify(store.state).includes(recognized), false);
  const playback = await api('/files/' + file.id);
  assert.equal(playback.headers.get('content-type'), 'audio/webm');
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), audio);
  await engine.handle({
    method: 'turn/completed',
    params: {
      threadId: 'api-thread',
      turn: { id: defined(defined(engine.active).turnId), status: 'completed' },
    },
  });
});

test('editing a skill grown beyond twenty helpers preserves every current file and the shared conversation', async (t) => {
  const { api, skills, store, worker } = await fixture(t),
    files = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        'scripts/helper-' + index + '.mjs',
        'export const value = ' + index + ';\n',
      ]),
    ),
    saved = skills.save({
      name: 'growing-skill',
      description: 'Growing source tree',
      instructions: 'Read the helpers.',
      files,
    }),
    directory = path.dirname(saved.path),
    marker = fs.readFileSync(path.join(directory, '.dant-managed.json'), 'utf8'),
    before = structuredClone(store.state.messages);
  for (let index = 20; index < 30; index++) {
    const name = 'scripts/helper-' + index + '.mjs',
      value = 'export const value = ' + index + ';\n';
    files[name] = value;
    fs.writeFileSync(path.join(directory, name), value);
  }
  const read = await api('/skills/growing-skill', undefined, 'GET');
  assert.equal(read.status, 200);
  const draft = await read.json();
  assert.deepEqual(draft.files, files);
  assert.deepEqual(
    fs.readFileSync(path.join(directory, '.dant-managed.json'), 'utf8'),
    marker,
    'opening Edit is read-only',
  );
  const response = await api(
    '/skills/growing-skill',
    {
      description: 'Updated description',
      instructions: draft.instructions,
      files: draft.files,
      enabled: true,
    },
    'PATCH',
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).files, files);
  assert.deepEqual(skills.get('growing-skill').files, files);
  for (const [name, value] of Object.entries(files))
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), value);
  assert.deepEqual(store.state.messages, before);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('skill read count failures expose only a safe size code and preserve the complete directory', async (t) => {
  const { api, skills } = await fixture(t),
    files = Object.fromEntries(
      Array.from({ length: SKILL_SUPPORT_FILE_LIMIT }, (_, index) => [
        'references/' + index + '.txt',
        'Reference ' + index,
      ]),
    ),
    saved = skills.save({
      name: 'bounded-skill',
      description: 'Bounded source tree',
      instructions: 'Read references.',
      files,
    }),
    directory = path.dirname(saved.path),
    marker = fs.readFileSync(path.join(directory, '.dant-managed.json'), 'utf8');
  fs.writeFileSync(path.join(directory, 'references/new.txt'), 'Keep this authored helper');
  const response = await api('/skills/bounded-skill', undefined, 'GET');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'The skill action could not be completed. Existing skills were preserved.',
    code: 'size_limit',
  });
  assert.deepEqual(fs.readFileSync(path.join(directory, '.dant-managed.json'), 'utf8'), marker);
  assert.equal(
    fs.readFileSync(path.join(directory, 'references/new.txt'), 'utf8'),
    'Keep this authored helper',
  );
});

test('skill import previews are read-only, commits refresh discovery and name collisions preserve both previews and existing skills', async (t) => {
  const { api, base, token, skills, worker } = await fixture(t),
    source =
      '---\nname: imported-check\ndescription: Check a desktop workflow.\nlicense: MIT\n---\nRead the screen before clicking.';
  const preview = async () => {
    const form = new FormData();
    form.set('file', new Blob([source], { type: 'text/markdown' }), 'SKILL.md');
    const response = await fetch(base + '/api/skills/import/preview', {
      method: 'POST',
      headers: { 'X-Dant-Token': token },
      body: form,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await preview();
  assert.equal(first.name, 'imported-check');
  assert.deepEqual(skills.list(), []);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.ok(first.files.some((file: { path: string }) => file.path === 'SKILL.md'));
  const saved = await api('/skills/import', { id: first.id, enabled: false });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).enabled, false);
  assert.match(skills.get(first.name).instructions, /Read the screen/);
  assert.ok(
    worker.calls.some((call) => call.method === 'skills/list' && defined(call.params).forceReload),
  );
  assert.equal((await api('/skills/import', { id: first.id })).status, 410);
  const again = await preview();
  const conflict = await api('/skills/import', { id: again.id });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'name_exists');
  assert.equal(
    (await api('/skills/import', { id: again.id, name: 'imported-renamed', enabled: true })).status,
    200,
  );
  assert.equal(skills.list().length, 2);
  assert.equal(skills.get(first.name).enabled, false);
  const discard = await preview();
  assert.equal(
    (await api('/skills/import/previews/' + discard.id, undefined, 'DELETE')).status,
    200,
  );
  assert.equal((await api('/skills/import', { id: discard.id })).status, 410);
  assert.equal(skills.list().length, 2);
});

test('skill import rejects invalid remote sources, oversized files, unauthenticated writes and offline VM work', async (t) => {
  const { api, base, worker } = await fixture(t);
  assert.equal(
    (
      await fetch(base + '/api/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  const rejected = await api('/skills/import/preview', { url: 'https://127.0.0.1/private' });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, 'invalid_source');
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(SKILL_ARCHIVE_BYTES + 1)]), 'oversized.zip');
  const { token } = await fetch(base + '/api/session').then((response) => response.json());
  const tooLarge = await fetch(base + '/api/skills/import/preview', {
    method: 'POST',
    headers: { 'X-Dant-Token': token },
    body: form,
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, 'size_limit');
  worker.status = 'offline';
  assert.equal(
    (await api('/skills/import/preview', { url: 'https://github.com/example/skills' })).status,
    409,
  );
  assert.equal((await api('/skills/import', { id: 'old' })).status, 409);
});

test('managed skill ZIP export uses immutable attachments without changing chat or running helpers', async (t) => {
  const { api, base, skills, store, worker } = await fixture(t),
    original = skills.save({
      name: 'desktop-check',
      description: 'Inspect the desktop',
      instructions: 'Read before acting.',
      files: {
        'scripts/check.py': 'raise RuntimeError("never run on export")',
        LICENSE: 'MIT fixture',
      },
      enabled: false,
    }),
    before = structuredClone(store.state.messages);
  assert.equal(
    (
      await fetch(base + '/api/skills/desktop-check/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  const response = await api('/skills/desktop-check/export', {});
  assert.equal(response.status, 200);
  const file = await response.json();
  assert.equal(file.name, 'desktop-check.zip');
  assert.equal(file.type, 'application/zip');
  assert.ok(file.size > 100);
  const downloaded = await api('/files/' + file.id + '?download=1');
  assert.match(
    defined(downloaded.headers.get('content-disposition')),
    /^attachment;.*desktop-check\.zip/,
  );
  const zip = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.match(zip.toString('utf8'), /desktop-check\/SKILL\.md/);
  assert.match(zip.toString('utf8'), /desktop-check\/scripts\/check\.py/);
  assert.match(zip.toString('utf8'), /MIT fixture/);
  assert.doesNotMatch(zip.toString('utf8'), /\.dant-managed\.json/);
  assert.deepEqual(skills.get('desktop-check'), original);
  assert.deepEqual(store.state.messages, before);
  assert.equal(worker.calls.length, 0);
  assert.equal((await api('/skills/missing/export', {})).status, 400);
  assert.equal((await api('/skills/%2e%2e%2foutside/export', {})).status, 400);
  worker.status = 'offline';
  assert.equal((await api('/skills/desktop-check/export', {})).status, 409);
});

test('legacy skill binary assets survive HTTP edits and export while unsafe files fail with content-free diagnostics', async (t) => {
  const { api, skills, store, worker, diagnostics } = await fixture(t),
    original = skills.save({
      name: 'legacy-images',
      description: 'A skill with image templates.',
      instructions: 'Read the helper before acting.',
      files: { 'scripts/check.py': 'raise RuntimeError("never execute in an export")' },
      enabled: false,
    }),
    directory = path.dirname(original.path),
    image = skillPngFixture(),
    opaque = Buffer.from([255, 0, 1, 2, 127, 128]),
    imagePath = path.join(directory, 'scripts', 'template.png'),
    messages = structuredClone(store.state.messages);
  fs.writeFileSync(imagePath, image);
  fs.mkdirSync(path.join(directory, 'assets'));
  const opaquePath = path.join(directory, 'assets', 'data.bin');
  fs.writeFileSync(opaquePath, opaque);
  assert.equal((await api('/skills/legacy-images')).status, 200);
  assert.equal(
    (await api('/skills/legacy-images', { description: 'Updated description.' }, 'PATCH')).status,
    200,
  );
  assert.equal(
    (
      await api(
        '/skills/legacy-images',
        {
          files: { 'scripts/check.py': 'print("still never executed")' },
          preserveBinaryFiles: true,
        },
        'PATCH',
      )
    ).status,
    200,
  );
  assert.deepEqual(fs.readFileSync(imagePath), image);
  assert.deepEqual(fs.readFileSync(opaquePath), opaque);
  const exported = await api('/skills/legacy-images/export', {});
  assert.equal(exported.status, 200);
  const attachment: unknown = await exported.json(),
    attachmentId = observedRecord(attachment).id;
  assert.equal(typeof attachmentId, 'string');
  const download = await api('/files/' + String(attachmentId) + '?download=1');
  assert.equal(download.status, 200);
  const archive = Buffer.from(await download.arrayBuffer());
  assert.ok(archive.includes(image));
  assert.ok(archive.includes(opaque));
  assert.equal(
    (await api('/skills/legacy-images', { preserveBinaryFiles: null }, 'PATCH')).status,
    400,
  );
  fs.linkSync(
    path.join(directory, 'scripts', 'check.py'),
    path.join(directory, 'scripts', 'private-support.bin'),
  );
  const rejected = await api('/skills/legacy-images/export', {});
  assert.equal(rejected.status, 400);
  const failure: unknown = await rejected.json();
  assert.equal(observedRecord(failure).code, 'skill_export_failed');
  const event = diagnostics.recent(20).findLast((row) => row.event === 'skill.export.failed');
  assert.equal(event?.code, 'skill_export_failed');
  assert.doesNotMatch(
    JSON.stringify({ failure, event }),
    /private-support|template\.png|never execute/,
  );
  assert.deepEqual(store.state.messages, messages);
  assert.equal(
    worker.calls.some((call) => ['turn/start', 'thread/start'].includes(call.method)),
    false,
  );
});

test('VM memory, reactions and read APIs validate references and preserve unrelated messages', async (t) => {
  const { api, store, engine } = await fixture(t);
  engine.loaded = true;
  assert.equal(
    (await api('/memory/working-memory.md', { text: 'A useful preference' }, 'PATCH')).status,
    200,
  );
  assert.equal(engine.loaded, false);
  assert.equal(store.state.memory, 'A useful preference');
  const memory = await api('/memory').then((r) => r.json());
  assert.ok(memory.files.some((file: { name: string }) => file.name === 'working-memory.md'));
  assert.equal(
    (await api('/memory/unknown.md', { text: 'Should not write' }, 'PATCH')).status,
    400,
  );
  const a = store.add({ role: 'assistant', text: 'Read this', status: 'completed' }),
    b = store.add({ role: 'assistant', text: 'Remain unread', status: 'completed' });
  assert.equal((await api('/messages/' + a.id + '/reaction', { emoji: 'invalid' })).status, 400);
  assert.equal((await api('/messages/missing/reaction', { emoji: '👍' })).status, 404);
  await api('/messages/' + a.id + '/reaction', { emoji: '👍' });
  await api('/messages/' + a.id + '/reaction', { emoji: '👍' });
  assert.deepEqual(a.reactions, []);
  assert.equal((await api('/read', { ids: 'all' })).status, 400);
  assert.equal((await api('/read', { ids: [a.id] })).status, 200);
  assert.equal(a.read, true);
  assert.equal(b.read, false);
});

test('upload and download APIs preserve immutable content and never inline active documents', async (t) => {
  const { api, base, token } = await fixture(t);
  const form = new FormData();
  form.set(
    'file',
    new Blob(['<script>window.injected=true</script>'], { type: 'text/html' }),
    'page.html',
  );
  const uploaded = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'X-Dant-Token': token },
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const file = await uploaded.json();
  assert.equal(file.type, 'application/octet-stream');
  const download = await api('/files/' + file.id);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(defined(download.headers.get('content-disposition')), /^attachment/);
  assert.equal(await download.text(), '<script>window.injected=true</script>');
  assert.equal((await api('/files/00000000-0000-0000-0000-000000000000')).status, 404);
  const forged = new FormData();
  forged.set('file', new Blob(['plain text'], { type: 'image/png' }), 'fake.png');
  assert.equal(
    (
      await fetch(base + '/api/upload', {
        method: 'POST',
        headers: { 'X-Dant-Token': token },
        body: forged,
      })
    ).status,
    400,
  );
  assert.equal((await api('/upload', {})).status, 400);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
    imageForm = new FormData();
  imageForm.set('file', new Blob([png], { type: 'image/png' }), 'screenshot.png');
  const image = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'X-Dant-Token': token },
    body: imageForm,
  }).then((response) => response.json());
  const inline = await api('/files/' + image.id);
  assert.equal(inline.headers.get('content-type'), 'image/png');
  assert.equal(inline.headers.has('content-disposition'), false);
  const saved = await api('/files/' + image.id + '?download=1');
  assert.match(defined(saved.headers.get('content-disposition')), /^attachment;.*screenshot\.png/);
  assert.equal(saved.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), png);
});

test('invalid message references and uncertain retries never accidentally submit model work', async (t) => {
  const { api, worker, store } = await fixture(t);
  for (const body of [
    { text: 'hello', clientMessageId: 'unsafe-id' },
    { text: 'hello', attachments: ['missing'] },
    { text: 'hello', replyTo: 'missing' },
    { text: 'hello', attachments: ['same', 'same'] },
    { text: '' },
  ] as const)
    assert.equal((await api('/messages', body)).status, 400);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 0);
  const task = store.add({
    role: 'user',
    text: 'Uncertain external action',
    status: 'paused',
    submission: 'unknown',
  });
  assert.equal((await api('/retry/' + task.id, {})).status, 400);
  assert.equal(task.status, 'paused');
  assert.equal((await api('/tasks/resume', { ids: [task.id] })).status, 400);
  assert.equal((await api('/tasks/resume', { ids: 'all' })).status, 400);
  assert.equal((await api('/tasks/' + task.id + '/accept', {})).status, 400);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 0);
  store.update(task.id, { status: 'review' });
  assert.equal((await api('/tasks/' + task.id + '/accept', {})).status, 200);
  assert.equal(task.status, 'completed');
  worker.status = 'offline';
  assert.equal((await api('/messages', { text: 'Wait until online' })).status, 409);
  assert.equal((await api('/steer', { text: 'extra', expectedTurnId: 'old' })).status, 400);
});

test('authenticated text and steering pass complete input beyond 100000 characters while keeping the HTTP transport bound', async (t) => {
  const { api, worker, engine, store } = await fixture(t),
    text = 'Long input 中文😀 '.repeat(9000) + 'LONG_USER_INPUT_TAIL',
    clientMessageId = randomUUID();
  assert.ok(text.length > 100000);
  const response = await api('/messages', { text, clientMessageId });
  assert.equal(response.status, 200);
  const message = await response.json();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(message.text, text);
  assert.equal(defined(store.state.messages.find((item) => item.id === message.id)).text, text);
  const turn = worker.calls.find((call) => call.method === 'turn/start');
  assert.ok(
    defined(defined(defined(turn).params).input).some(
      (item) => item.type === 'text' && item.text.endsWith('LONG_USER_INPUT_TAIL'),
    ),
  );
  assert.ok(
    defined(defined(defined(turn).params).input).some(
      (item) => item.type === 'text' && item.text.includes(text),
    ),
  );
  const duplicate = await api('/messages', { text, clientMessageId });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).id, message.id);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  const correction = 'Correction 中文😀 '.repeat(9000) + 'LONG_STEER_INPUT_TAIL';
  assert.ok(correction.length > 100000);
  const steering = await api('/steer', {
    text: correction,
    expectedTurnId: defined(engine.active).turnId,
  });
  assert.equal(steering.status, 200);
  const steer = worker.calls.find((call) => call.method === 'turn/steer');
  assert.ok(
    defined(defined(defined(steer).params).input).some(
      (item) => item.type === 'text' && item.text.includes(correction),
    ),
  );
  assert.equal(defined(store.state.messages.at(-1)).text, correction);
  const count = store.state.messages.length;
  assert.equal((await api('/messages', { text: 'x'.repeat(API_JSON_BODY_BYTES + 1) })).status, 413);
  assert.equal(
    (
      await api('/steer', {
        text: 'x'.repeat(API_JSON_BODY_BYTES + 1),
        expectedTurnId: defined(engine.active).turnId,
      })
    ).status,
    413,
  );
  assert.equal(store.state.messages.length, count);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/steer').length, 1);
});

test('schedules dispatch once only when the VM executor is online and can be removed', async (t) => {
  const { api, worker, store, scheduler } = await fixture(t);
  worker.status = 'offline';
  let at = Date.now();
  scheduler.now = () => at;
  assert.equal((await api('/schedules', { text: 'too late', at: at - 1 })).status, 400);
  const response = await api('/schedules', { text: 'One scheduled task', at: at + 1000 });
  assert.equal(response.status, 200);
  const schedule = await response.json();
  at += 2000;
  scheduler.tick();
  assert.equal(defined(store.state.schedules[0]).status, 'pending');
  assert.equal(store.state.messages.length, 0);
  worker.status = 'online';
  scheduler.tick();
  scheduler.tick();
  assert.equal(defined(store.state.schedules[0]).status, 'dispatched');
  assert.equal(store.state.messages.filter((message) => message.scheduled).length, 1);
  assert.equal((await api('/schedules/' + schedule.id, {}, 'DELETE')).status, 200);
  assert.equal(store.state.schedules.length, 0);
  assert.equal((await api('/tasks/pause', {})).status, 200);
  assert.equal((await api('/stop', {})).status, 200);
});

test('idle executor recovery restores only the stopped worker and never resumes paused or uncertain messages', async (t) => {
  const { api, worker, engine, store } = await fixture(t);
  worker.status = 'offline';
  engine.loaded = true;
  const message = store.add({
      role: 'user',
      text: 'Do not replay this work',
      status: 'paused',
      submission: 'unknown',
    }),
    before = structuredClone(message),
    conversation = store.state.conversationId;
  const response = await api('/connect', { idleRecovery: true });
  assert.equal(response.status, 200);
  assert.equal(worker.connections, 1);
  assert.equal(worker.status, 'online');
  assert.equal(engine.loaded, false);
  assert.deepEqual(engine.queue, []);
  assert.deepEqual(message, before);
  assert.equal(store.state.conversationId, conversation);
  assert.equal(worker.calls.length, 0);
});

test('the Worker atomically rejects idle recovery during authoritative work, calls, native handoffs or computer control changes', async (t) => {
  for (const name of [
    'active',
    'native-active',
    'call',
    'queue',
    'finishing',
    'acquiring',
    'takeover',
    'computer-pending',
    'human',
    'taking-over',
    'lease',
  ] as const)
    await t.test(name, async (t) => {
      const { api, worker, engine, nativeVoice, computer } = await fixture(t);
      worker.status = 'offline';
      engine.loaded = true;
      if (name === 'active') engine.active = activeTaskFixture({ messageId: 'active' });
      if (name === 'native-active')
        Object.defineProperty(nativeVoice, 'active', {
          configurable: true,
          value: { messageId: 'native-handoff' },
        });
      if (name === 'call') engine.call = engineCallFixture({ id: 'call-in-progress' });
      if (name === 'queue') engine.queue.push({ id: 'queued-work' });
      if (name === 'finishing') engine.finishing = Promise.resolve();
      if (name === 'acquiring') engine.acquiring = true;
      if (name === 'takeover') engine.takeover = true;
      if (name === 'computer-pending') computer.pending = true;
      if (name === 'human') computer.state.status = 'human';
      if (name === 'taking-over') computer.state.status = 'taking-over';
      if (name === 'lease') computer.state.sessionId = 'unreleased-lease';
      const response = await api('/connect', { idleRecovery: true });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /Stop active work and return computer control/);
      assert.equal(worker.connections, 0);
      assert.equal(worker.calls.length, 0);
      assert.equal(worker.status, 'offline');
      assert.equal(engine.loaded, true);
      engine.active = null;
      engine.call = null;
      engine.queue = [];
      engine.finishing = null;
      engine.acquiring = false;
      engine.takeover = false;
      computer.pending = false;
      computer.state = { status: 'dant', sessionId: null, expiresAt: 0 };
      if (name === 'native-active')
        assert.equal(Reflect.deleteProperty(nativeVoice, 'active'), true);
    });
});

test('idle recovery of an already online executor is a no-op that preserves its loaded model session', async (t) => {
  const { api, worker, engine } = await fixture(t);
  engine.loaded = true;
  const response = await api('/connect', { idleRecovery: true });
  assert.equal(response.status, 200);
  assert.equal(worker.connections, 0);
  assert.equal(engine.loaded, true);
  assert.equal(worker.calls.length, 0);
});

test('a concurrent worker recovery and new chat work cannot restart or feed the connecting executor', async (t) => {
  const { api, worker, engine, store } = await fixture(t);
  worker.status = 'offline';
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  worker.connectWait = () => {
    started();
    return new Promise<void>((resolve) => (release = resolve));
  };
  const first = api('/connect', { idleRecovery: true });
  await entered;
  assert.equal(worker.status, 'connecting');
  assert.equal((await api('/connect', { idleRecovery: true })).status, 409);
  assert.equal((await api('/messages', { text: 'Must not queue while connecting' })).status, 409);
  assert.deepEqual(engine.queue, []);
  assert.equal(store.state.messages.length, 0);
  release();
  assert.equal((await first).status, 200);
  assert.equal(worker.connections, 1);
  assert.equal(worker.calls.length, 0);
});
