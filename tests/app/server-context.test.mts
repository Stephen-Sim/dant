import { engineCallFixture } from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import type { ApiVoiceFactoryOptions } from '../../src/app/worker-app-types.ts';
import type { EngineVoice } from '../../src/work/engine.mts';
import type { Voice } from '../../src/voice/voice.mts';
import type { LiveContextResult } from '../../src/voice/call-context.mts';
import { VoiceFixture } from '../support/protocol-fixtures.mts';
import { NativeVoiceFixture } from '../support/native-service-fixtures.mts';
import {
  WorkerServiceFixture,
  listeningPort,
  deferred,
  observedRecord,
} from '../support/service-fixtures.mts';
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
type ContextInput = Parameters<Voice['syncContext']>[0];
type MessageInput = Parameters<NonNullable<EngineVoice['message']>>[0];
type Confirmation = Awaited<ReturnType<NonNullable<EngineVoice['message']>>>;
type ContextHandler = (input: ContextInput) => Promise<LiveContextResult>;
interface SetupOptions {
  api?: ContextHandler;
  native?: ContextHandler;
  input?: (input: MessageInput) => Promise<Confirmation>;
}
async function setup(t: NodeTestContext, { api, native, input }: SetupOptions = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'server-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
      return method === 'thread/start'
        ? { thread: { id: 'thread' } }
        : method === 'turn/start'
          ? { turn: { id: 'turn' } }
          : {};
    }
    disconnect() {
      this.status = 'offline';
      this.emit('status');
    }
  }
  class Provider extends VoiceFixture {
    readonly handler: ContextHandler | undefined;
    calls: ContextInput[] = [];
    inputs: MessageInput[] = [];
    state = { available: true };
    constructor(handler?: ContextHandler) {
      super();
      this.handler = handler;
    }
    async syncContext(args: ContextInput): Promise<LiveContextResult> {
      this.calls.push(args);
      return this.handler
        ? await this.handler(args)
        : {
            callId: defined(args.callId),
            contextId: 'context-' + this.calls.length,
            messageId: String(observedRecord(args.message).id),
            kind: args.kind,
            status: 'submitted',
          };
    }
    async message(args: MessageInput): Promise<Confirmation> {
      this.inputs.push(args);
      return input ? await input(args) : { submission: 'confirmed', confirmedAt: Date.now() };
    }
    close = async () => {};
    stop = async () => {};
  }
  class NativeProvider extends NativeVoiceFixture {
    readonly handler: ContextHandler | undefined;
    calls: ContextInput[] = [];
    constructor(handler?: ContextHandler) {
      super();
      this.handler = handler;
    }
    async syncContext(args: ContextInput): Promise<LiveContextResult> {
      this.calls.push(args);
      return this.handler
        ? await this.handler(args)
        : {
            callId: defined(args.callId),
            contextId: 'context-' + this.calls.length,
            messageId: String(observedRecord(args.message).id),
            kind: args.kind,
            status: 'submitted',
          };
    }
    async close() {}
    async stop() {}
  }
  const worker = new Worker(),
    voice = new Provider(api),
    nativeVoice = new NativeProvider(native);
  let voiceOptions!: ApiVoiceFactoryOptions;
  const instance = createWorkerApp({
    dataDir: dir,
    workerFactory: () => worker,
    voiceFactory: (options) => {
      voiceOptions = options;
      return voice;
    },
    nativeVoiceFactory: () => nativeVoice,
  });
  t.after(() => instance.close());
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + listeningPort(instance.server),
    { token } = await fetch(base + '/api/session').then((response) => response.json());
  const post = (route: string, body: unknown) =>
    fetch(base + '/api' + route, {
      method: 'POST',
      headers: { 'X-Dant-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { instance, worker, voice, nativeVoice, post, voiceOptions };
}

test(
  'API call text reaches the same live call once and duplicate HTTP attempts never create an ordinary task',
  { timeout: 15000 },
  async (t) => {
    const entered = deferred<MessageInput>(),
      done = deferred<Confirmation>();
    const h = await setup(t, {
      input: async (args) => {
        entered.resolve(args);
        return done.promise;
      },
    });
    h.instance.engine.call = engineCallFixture({ id: 'api-call', provider: 'api' });
    try {
      const payload = {
          text: 'Create the actual report',
          clientMessageId: '650af0bf-1264-49ee-bc6f-1571b99e7295',
        },
        first = await h.post('/messages', payload),
        result = await first.json(),
        captured = await entered.promise,
        message = h.instance.store.state.messages[0];
      assert.equal(defined(message).executorConfirmedAt, null);
      assert.equal(h.instance.store.state.messages.length, 1);
      assert.equal(observedRecord(defined(captured).message).text, payload.text);
      assert.equal(defined(captured).callId, 'api-call');
      assert.equal(
        h.worker.calls.filter((call) => call.method === 'thread/inject_items').length,
        1,
      );
      assert.equal(h.worker.calls.filter((call) => call.method === 'turn/start').length, 0);
      assert.equal(h.voice.calls.length, 0);
      assert.equal(h.instance.engine.queue.length, 0);
      const duplicate = await (await h.post('/messages', payload)).json();
      assert.equal(duplicate.id, result.id);
      assert.equal(h.voice.inputs.length, 1);
      done.resolve({ submission: 'confirmed', confirmedAt: Date.now() });
      await h.instance.engine.pendingFollowups.get(defined(message).id);
      assert.equal(defined(message).submission, 'confirmed');
      assert.equal(defined(message).status, 'accepted');
      assert.ok(defined(message).executorConfirmedAt);
      assert.equal(defined(message).read, false);
      await h.post('/messages', payload);
      assert.equal(h.voice.inputs.length, 1);
      assert.equal(
        h.worker.calls.filter((call) => call.method === 'thread/inject_items').length,
        1,
      );
      assert.equal(h.worker.calls.filter((call) => call.method === 'turn/start').length, 0);
      assert.match(h.voiceOptions.context(), new RegExp(defined(message).id));
      assert.match(h.voiceOptions.context(), /Create the actual report/);
      assert.equal(
        (await h.post('/messages', { ...payload, text: 'Different request' })).status,
        409,
      );
    } finally {
      done.resolve({ submission: 'confirmed', confirmedAt: Date.now() });
    }
  },
);

test('reactions persist before current API or subscription context synchronization without creating tasks', async (t) => {
  for (const provider of ['api', 'subscription'] as const)
    await t.test(provider, async (t) => {
      const h = await setup(t),
        message = h.instance.store.add({
          role: 'assistant',
          text: 'Target result',
          reactions: ['👍'],
        });
      h.instance.engine.call = engineCallFixture({ id: 'call-' + provider, provider });
      const response = await h.post('/messages/' + message.id + '/reaction', { emoji: '👍' }),
        result = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(message.reactions, []);
      assert.equal(result.voiceContext.status, 'submitted');
      assert.equal(result.voiceContext.callId, 'call-' + provider);
      const selected = provider === 'api' ? h.voice : h.nativeVoice,
        other = provider === 'api' ? h.nativeVoice : h.voice;
      assert.equal(selected.calls.length, 1);
      assert.equal(other.calls.length, 0);
      assert.equal(observedRecord(defined(selected.calls[0]).message).id, message.id);
      assert.equal(defined(selected.calls[0]).kind, 'reaction');
      assert.equal(h.worker.calls.length, 0);
      assert.equal(h.instance.engine.queue.length, 0);
    });
});

test('failed and unknown live context delivery cannot undo a saved reaction or expose transport secrets', async (t) => {
  for (const status of ['failed', 'unknown'] as const)
    await t.test(status, async (t) => {
      const h = await setup(t, {
          api: async () => {
            throw Object.assign(
              Error('sk-DO-NOT-EXPOSE-CREDENTIAL'),
              status === 'failed' ? { code: -1 } : {},
            );
          },
        }),
        notices: unknown[] = [];
      h.instance.engine.on('notice', (notice) => notices.push(notice));
      h.instance.engine.call = engineCallFixture({ id: 'call', provider: 'api' });
      const message = h.instance.store.add({ role: 'assistant', text: 'Result' }),
        response = await h.post('/messages/' + message.id + '/reaction', { emoji: '❤️' }),
        body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(message.reactions, ['❤️']);
      assert.equal(body.voiceContext.status, status);
      assert.equal(defined(message.voiceContext).status, status);
      assert.equal(JSON.stringify({ body, notices }).includes('DO-NOT-EXPOSE'), false);
      assert.equal(notices.length, 1);
      assert.equal(h.worker.calls.length, 0);
    });
});

test('late results remain tied to the original call and cannot overwrite a newer reaction status', async (t) => {
  const first = deferred<LiveContextResult>(),
    second = deferred<LiveContextResult>(),
    entered = deferred();
  const h = await setup(t, {
      api: async (args) => {
        if (args.callId === 'old') {
          entered.resolve();
          return first.promise;
        }
        return second.promise;
      },
    }),
    message = h.instance.store.add({ role: 'assistant', text: 'Result' });
  h.instance.engine.call = engineCallFixture({ id: 'old', provider: 'api' });
  const old = h.post('/messages/' + message.id + '/reaction', { emoji: '👍' });
  await entered.promise;
  h.instance.engine.call = engineCallFixture({ id: 'new', provider: 'api' });
  const current = h.post('/messages/' + message.id + '/reaction', { emoji: '👍' });
  while (h.voice.calls.length < 2) await tick();
  second.resolve({
    callId: 'new',
    contextId: 'new-result',
    messageId: message.id,
    kind: 'reaction',
    status: 'submitted',
  });
  assert.equal((await (await current).json()).voiceContext.callId, 'new');
  first.resolve({
    callId: 'old',
    contextId: 'old-result',
    messageId: message.id,
    kind: 'reaction',
    status: 'submitted',
  });
  assert.equal((await (await old).json()).voiceContext.callId, 'old');
  assert.equal(defined(message.voiceContext).callId, 'new');
  assert.deepEqual(message.reactions, []);
  assert.deepEqual(
    h.voice.calls.map((call) => call.callId),
    ['old', 'new'],
  );
  assert.equal(h.worker.calls.length, 0);
});
