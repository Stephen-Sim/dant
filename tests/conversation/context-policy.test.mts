import { RpcFixture } from '../support/protocol-fixtures.mts';
import type { RpcParams, RpcResult, RpcEnvelope } from '../../src/runtime/protocol.ts';
import type { WorkerCall } from '../support/worker-fixtures.mts';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { observedRecord } from '../support/service-fixtures.mts';
import { fixtureString } from '../support/engine-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { LocalWorker } from '../../src/runtime/local-worker.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';

const base = path.resolve('.cache/tests'),
  sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
fs.mkdirSync(base, { recursive: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const policyFields = [
  'model_context_window',
  'modelContextWindow',
  'context_window',
  'contextWindow',
  'model_auto_compact_token_limit',
  'modelAutoCompactTokenLimit',
  'auto_compact_token_limit',
  'autoCompactTokenLimit',
  'max_output_tokens',
  'maxOutputTokens',
  'truncation',
  'truncationPolicy',
];
function nativePolicy(params: RpcParams) {
  for (const key of policyFields) {
    assert.equal(Object.hasOwn(params, key), false, 'Codex owns ' + key);
    assert.equal(
      Object.hasOwn(params.config === undefined ? {} : observedRecord(params.config), key),
      false,
      'Codex config owns ' + key,
    );
  }
}

test('the actual LocalWorker and Engine preserve Codex native context and compaction defaults across text, resume and voice', async (t) => {
  const dir = fs.mkdtempSync(path.join(base, 'context-policy-')),
    home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local/bin/codex'), 'synthetic executable, never launched');
  class FakeRpc extends RpcFixture {
    requests: WorkerCall[];
    sent: RpcEnvelope[];
    turns: number;
    constructor() {
      super();
      this.requests = [];
      this.sent = [];
      this.turns = 0;
    }
    event(method: string, params: Record<string, unknown> = {}) {
      this.emit('event', { method, params: { threadId: 'policy-thread', ...params } });
    }
    request = async (method: string, params: RpcParams = {}): Promise<RpcResult> => {
      this.requests.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'model/list') return { data: [{ id: 'native-model' }] };
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: 'policy-thread' } };
      if (method === 'turn/start')
        return { turn: { id: ++this.turns === 1 ? 'policy-turn' : 'native-policy-turn' } };
      if (method === 'thread/read')
        return { thread: { id: 'policy-thread', status: { type: 'idle' }, turns: [] } };
      if (method === 'thread/realtime/start')
        queueMicrotask(() => {
          this.event('thread/realtime/started', { version: 'v3' });
          this.event('thread/realtime/sdp', { sdp });
        });
      if (method === 'thread/realtime/stop')
        queueMicrotask(() => this.event('thread/realtime/closed'));
      return {};
    };
    send = (value: RpcEnvelope) => {
      this.sent.push(value);
    };
    close = () => {
      this.closed = true;
      this.emit('disconnected', Error('Synthetic worker closed'));
    };
  }
  const store = new Store(path.join(dir, 'data')),
    rpc = new FakeRpc(),
    launches: { command: string; args: string[]; options: SpawnOptionsWithoutStdio }[] = [];
  const worker = new LocalWorker(store, {
    platform: 'linux',
    home,
    verifyRuntime: async () => {},
    rpcFactory: (command, args, options) => {
      launches.push({ command, args, options });
      return rpc;
    },
  });
  worker.workspaceRoot = path.join(dir, 'workspaces');
  const engine = new Engine(store, worker),
    voice = new NativeRealtimeVoice({
      worker,
      engine,
      connectTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    });
  t.after(async () => {
    await voice.close();
    worker.disconnect();
    assert.ok(dir.startsWith(base + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await worker.connect();
  assert.equal(launches.length, 1);
  assert.ok(defined(launches[0]).args.includes('app-server'));
  for (const key of policyFields)
    assert.equal(
      defined(launches[0]).args.some((arg) => arg.includes(key)),
      false,
      'CLI must not override ' + key,
    );
  const memory = '中文😀'.repeat(5000) + 'FULL_MEMORY_TAIL';
  engine.memory.write('working-memory.md', memory);
  await engine.thread();
  const start = rpc.requests.find((request) => request.method === 'thread/start');
  nativePolicy(defined(start).params);
  assert.ok(defined(defined(start).params.developerInstructions).includes(memory));
  const text = 'User context 中文😀'.repeat(3000) + 'CURRENT_INPUT_TAIL',
    message = store.add({ role: 'user', text, status: 'queued' }),
    conversationId = store.state.conversationId;
  engine.enqueue(message);
  await tick();
  const turn = rpc.requests.find((request) => request.method === 'turn/start');
  nativePolicy(defined(turn).params);
  assert.ok(
    defined(defined(turn).params.input).some(
      (item) => item.type === 'text' && item.text.includes(text),
    ),
  );
  const correction = 'Correction 中文😀'.repeat(1000) + 'STEER_INPUT_TAIL';
  await engine.steer(
    store.add({ role: 'user', text: correction, status: 'queued' }),
    'policy-turn',
  );
  const steer = rpc.requests.find((request) => request.method === 'turn/steer');
  nativePolicy(defined(steer).params);
  assert.ok(
    defined(defined(steer).params.input).some(
      (item) => item.type === 'text' && item.text.includes(correction),
    ),
  );
  await engine.handle({
    method: 'turn/completed',
    params: { threadId: 'policy-thread', turn: { id: 'policy-turn', status: 'completed' } },
  });
  engine.loaded = false;
  await engine.thread();
  const resume = rpc.requests.find((request) => request.method === 'thread/resume');
  nativePolicy(defined(resume).params);
  assert.equal(defined(resume).params.threadId, 'policy-thread');
  assert.equal(defined(resume).params.excludeTurns, true);
  assert.equal(store.state.conversationId, conversationId);
  const call = await engine.startCall(sdp),
    voiceStart = rpc.requests.find((request) => request.method === 'thread/realtime/start');
  nativePolicy(defined(voiceStart).params);
  assert.notEqual(defined(voiceStart).params.includeStartupContext, false);
  assert.equal(defined(voiceStart).params.threadId, 'policy-thread');
  const context = await voice.syncContext({ kind: 'message', message, callId: call.callId });
  assert.equal(context.status, 'submitted');
  const appended = rpc.requests.find(
      (request) =>
        request.method === 'thread/realtime/appendText' &&
        defined(request.params.text).includes('<dant_live_reference>'),
    ),
    reference = fixtureJson(
      defined(defined(defined(appended).params.text).split('<dant_live_reference>\n')[1]).split(
        '\n</dant_live_reference>',
      )[0],
    );
  assert.equal(reference.text, text);
  assert.equal(reference.truncated, false);
  assert.equal(rpc.requests.filter((request) => request.method === 'turn/start').length, 1);
  assert.equal(rpc.requests.filter((request) => request.method === 'turn/steer').length, 1);
  const long = 'Native call input 中文😀 '.repeat(6000) + 'NATIVE_CALL_INPUT_TAIL';
  assert.ok(long.length > 100000);
  const result = await voice.message({
    clientMessageId: 'long-native-policy',
    text: long,
    callId: call.callId,
  });
  assert.equal(result.submission, 'confirmed');
  assert.equal(result.message.status, 'accepted');
  const nativeReference = rpc.requests
      .filter((request) => request.method === 'thread/realtime/appendText')
      .at(-1),
    live = fixtureJson(
      defined(defined(defined(nativeReference).params.text).split('<dant_call_input>\n')[1]).split(
        '\n</dant_call_input>',
      )[0],
    );
  assert.equal(live.text, long);
  assert.equal(defined(nativeReference).params.threadId, 'policy-thread');
  assert.equal(
    defined(
      store.state.messages.find((message) => message.clientMessageId === 'long-native-policy'),
    ).text,
    long,
  );
  assert.equal(
    (
      await voice.message({
        clientMessageId: 'long-native-policy',
        text: long,
        callId: call.callId,
      })
    ).duplicate,
    true,
  );
  assert.equal(rpc.requests.filter((request) => request.method === 'turn/start').length, 1);
  assert.equal(
    rpc.requests.filter((request) => request.method === 'thread/inject_items').length,
    1,
  );
  assert.equal(store.state.conversationId, conversationId);
  await engine.stopCall(call.callId);
  assert.equal(worker.status, 'online');
});

function fixtureJson(value: unknown): Record<string, unknown> {
  return observedRecord(JSON.parse(fixtureString(value)));
}
