import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/conversation/store.mjs';
import { Engine } from '../src/work/engine.mjs';
import { LocalWorker } from '../src/runtime/local-worker.mjs';
import { NativeRealtimeVoice } from '../src/voice/realtime.mjs';

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
function nativePolicy(params) {
  for (const key of policyFields) {
    assert.equal(Object.hasOwn(params, key), false, 'Codex owns ' + key);
    assert.equal(Object.hasOwn(params.config || {}, key), false, 'Codex config owns ' + key);
  }
}

test('the actual LocalWorker and Engine preserve Codex native context and compaction defaults across text, resume and voice', async (t) => {
  const dir = fs.mkdtempSync(path.join(base, 'context-policy-')),
    home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local/bin/codex'), 'synthetic executable, never launched');
  class FakeRpc extends EventEmitter {
    constructor() {
      super();
      this.requests = [];
      this.sent = [];
      this.turns = 0;
    }
    event(method, params = {}) {
      this.emit('event', { method, params: { threadId: 'policy-thread', ...params } });
    }
    async request(method, params = {}) {
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
    }
    send(value) {
      this.sent.push(value);
    }
    close() {
      this.closed = true;
      this.emit('disconnected', Error('Synthetic worker closed'));
    }
  }
  const store = new Store(path.join(dir, 'data')),
    rpc = new FakeRpc(),
    launches = [];
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
  assert.ok(launches[0].args.includes('app-server'));
  for (const key of policyFields)
    assert.equal(
      launches[0].args.some((arg) => arg.includes(key)),
      false,
      'CLI must not override ' + key,
    );
  const memory = '中文😀'.repeat(5000) + 'FULL_MEMORY_TAIL';
  engine.memory.write('working-memory.md', memory);
  await engine.thread();
  const start = rpc.requests.find((request) => request.method === 'thread/start');
  nativePolicy(start.params);
  assert.ok(start.params.developerInstructions.includes(memory));
  const text = 'User context 中文😀'.repeat(3000) + 'CURRENT_INPUT_TAIL',
    message = store.add({ role: 'user', text, status: 'queued' }),
    conversationId = store.state.conversationId;
  engine.enqueue(message);
  await tick();
  const turn = rpc.requests.find((request) => request.method === 'turn/start');
  nativePolicy(turn.params);
  assert.ok(turn.params.input.some((item) => item.type === 'text' && item.text.includes(text)));
  const correction = 'Correction 中文😀'.repeat(1000) + 'STEER_INPUT_TAIL';
  await engine.steer(
    store.add({ role: 'user', text: correction, status: 'queued' }),
    'policy-turn',
  );
  const steer = rpc.requests.find((request) => request.method === 'turn/steer');
  nativePolicy(steer.params);
  assert.ok(
    steer.params.input.some((item) => item.type === 'text' && item.text.includes(correction)),
  );
  await engine.handle({
    method: 'turn/completed',
    params: { threadId: 'policy-thread', turn: { id: 'policy-turn', status: 'completed' } },
  });
  engine.loaded = false;
  await engine.thread();
  const resume = rpc.requests.find((request) => request.method === 'thread/resume');
  nativePolicy(resume.params);
  assert.equal(resume.params.threadId, 'policy-thread');
  assert.equal(resume.params.excludeTurns, true);
  assert.equal(store.state.conversationId, conversationId);
  const call = await engine.startCall(sdp),
    voiceStart = rpc.requests.find((request) => request.method === 'thread/realtime/start');
  nativePolicy(voiceStart.params);
  assert.notEqual(voiceStart.params.includeStartupContext, false);
  assert.equal(voiceStart.params.threadId, 'policy-thread');
  const context = await voice.syncContext({ kind: 'message', message, callId: call.callId });
  assert.equal(context.status, 'submitted');
  const appended = rpc.requests.find(
      (request) =>
        request.method === 'thread/realtime/appendText' &&
        request.params.text.includes('<dant_live_reference>'),
    ),
    reference = JSON.parse(
      appended.params.text.split('<dant_live_reference>\n')[1].split('\n</dant_live_reference>')[0],
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
    live = JSON.parse(
      nativeReference.params.text.split('<dant_call_input>\n')[1].split('\n</dant_call_input>')[0],
    );
  assert.equal(live.text, long);
  assert.equal(nativeReference.params.threadId, 'policy-thread');
  assert.equal(
    store.state.messages.find((message) => message.clientMessageId === 'long-native-policy').text,
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
