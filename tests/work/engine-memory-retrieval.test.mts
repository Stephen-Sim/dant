import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../../src/work/engine.mts';
import { Store } from '../../src/conversation/store.mts';
import { WorkContinuationSupervisor } from '../../src/work/work-continuation.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import { TracingWorkerFixture } from '../support/worker-fixtures.mts';
import { RpcFixture } from '../support/protocol-fixtures.mts';
import { deferred } from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';
import { inputText } from '../support/engine-fixtures.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
class Worker extends TracingWorkerFixture {
  engine?: Engine;
  next = 0;
  constructor() {
    super();
    this.status = 'online';
    this.calls = [];
    this.rpc = Object.assign(new RpcFixture(), { reply() {}, send() {} });
  }
  async request(method: string, params: RpcParams = {}): Promise<RpcResult> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++this.next } };
    if (method === 'thread/read')
      return {
        thread: {
          id: 'thread',
          status: { type: 'idle' },
          turns: defined(this.engine).store.state.workTasks.map((work) => ({
            id: defined(work.turnId),
            status: 'completed',
          })),
        },
      };
    if (method === 'thread/realtime/start') {
      queueMicrotask(() => {
        this.emit('event', {
          method: 'thread/realtime/started',
          params: { threadId: 'thread', version: 'v3' },
        });
        this.emit('event', { method: 'thread/realtime/sdp', params: { threadId: 'thread', sdp } });
      });
    }
    return {};
  }
}
function fixture(
  t: TestContext,
  options: NonNullable<ConstructorParameters<typeof Engine>[2]> = {},
) {
  const dir = fs.mkdtempSync(path.join(base, 'engine-memory-'));
  const store = new Store(dir),
    worker = new Worker(),
    engine = new Engine(store, worker, options);
  worker.engine = engine;
  t.after(() => {
    engine.continuationStopped = true;
    clearTimeout(engine.streamingSaveTimer ?? undefined);
    engine.memory.close();
    const relative = path.relative(base, dir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { engine, store, worker };
}
function remember(engine: Engine, text: string) {
  return engine.memory.confirmEntry(
    engine.memory.proposeEntry({ kind: 'semantic', text, source: { kind: 'user' } }).id,
  );
}
function sent(worker: Worker, method = 'turn/start') {
  const call = defined(worker.calls.findLast((entry) => entry.method === method));
  assert.ok(Array.isArray(call.params.input));
  return inputText(call.params.input[0]);
}
function unfinished(f: ReturnType<typeof fixture>, title = 'Cairo renderer verification') {
  const message = f.store.add({
    role: 'user',
    text: title,
    turnId: 'previous-turn',
    status: 'review',
    submission: 'confirmed',
    workKind: 'task',
  });
  const work = f.store.registerWork({
    turnId: 'previous-turn',
    messageId: message.id,
    title,
    source: 'chat',
    plan: {
      steps: [
        { step: 'Inspect renderer', status: 'completed' },
        { step: 'Verify Cairo renderer', status: 'inProgress' },
      ],
    },
  });
  f.store.updateRegisteredWork('previous-turn', {
    status: 'continuing',
    executionEnded: true,
    at: Date.now() - 10000,
  });
  f.store.state.threadId = 'thread';
  f.store.state.threadRuntime = f.engine.runtimeId;
  f.store.state.threadConversationId = f.store.state.conversationId;
  f.engine.loaded = true;
  return defined(f.store.state.workTasks.find((entry) => entry.id === work.id));
}

test('actual admitted input recalls confirmed memory without mutating the human message or starting extra work', async (t) => {
  const f = fixture(t);
  remember(f.engine, 'Cairo renderer uses a monochrome palette.');
  f.engine.memory.proposeEntry({
    kind: 'semantic',
    text: 'Cairo candidate secret choice',
    source: { kind: 'inference' },
  });
  const message = f.store.add({ role: 'user', text: 'Please implement the Cairo renderer' });
  f.engine.enqueue(message);
  await tick();
  assert.match(sent(f.worker), /dant_recalled_memory/);
  assert.match(sent(f.worker), /monochrome palette/);
  assert.doesNotMatch(sent(f.worker), /candidate secret/);
  assert.equal(message.text, 'Please implement the Cairo renderer');
  assert.equal(f.store.state.messages.length, 1);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'thread/inject_items'),
    false,
  );
  assert.doesNotMatch(f.engine.instructions(), /monochrome palette/);
});

test('lookup uses original user text rather than generated attachment instructions and leaves unmatched input unchanged', async (t) => {
  const f = fixture(t);
  remember(f.engine, 'execution current automatic memory reference');
  const message = f.store.add({ role: 'user', text: 'quartz xyzzy' });
  const plain = f.engine.input(message);
  assert.equal(f.engine.withMemoryInput(plain, message), plain);
  f.engine.enqueue(message);
  await tick();
  assert.equal(sent(f.worker), inputText(plain[0]));
});

test('fresh recall after asynchronous baseline honors edits and deletions before submission', async (t) => {
  const baseline = deferred<void>();
  const entered = deferred<void>();
  const f = fixture(t, {
    deliverables: {
      archive: () => [],
      captureBaseline: async () => {
        entered.resolve();
        await baseline.promise;
        return { valid: true, hashes: new Map<string, string>() };
      },
    },
  });
  const edited = remember(f.engine, 'Cairo renderer OLD preference');
  const deleted = remember(f.engine, 'Cairo renderer DELETED preference');
  const message = f.store.add({ role: 'user', text: 'Implement Cairo renderer' });
  f.engine.enqueue(message);
  await entered.promise;
  f.engine.memory.updateEntry(edited.id, { text: 'Cairo renderer CURRENT preference' });
  f.engine.memory.confirmEntry(edited.id);
  f.engine.memory.deleteEntry(deleted.id);
  baseline.resolve();
  await tick();
  assert.match(sent(f.worker), /CURRENT preference/);
  assert.doesNotMatch(sent(f.worker), /OLD preference|DELETED preference/);
});

test('a failed local recall is definitely not submitted and is never retried automatically', async (t) => {
  const f = fixture(t);
  f.engine.memory.retrieve = () => {
    throw Error('Isolated memory database is unavailable');
  };
  const message = f.store.add({ role: 'user', text: 'Cairo renderer' });
  f.engine.enqueue(message);
  await tick();
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.notEqual(message.submission, 'unknown');
  assert.equal(f.engine.queue.length, 0);
  assert.equal(f.engine.active, null);
});

test('steering reads fresh memory for the confirmed turn and preserves expectedTurnId', async (t) => {
  const f = fixture(t);
  f.engine.enqueue(f.store.add({ role: 'user', text: 'Initial renderer' }));
  await tick();
  remember(f.engine, 'Cairo renderer uses BOUND source');
  const message = f.store.add({ role: 'user', text: 'Use Cairo renderer' });
  await f.engine.steer(message, 'turn-1');
  assert.match(sent(f.worker, 'turn/steer'), /BOUND source/);
  assert.equal(
    defined(f.worker.calls.find((call) => call.method === 'turn/steer')).params.expectedTurnId,
    'turn-1',
  );
  assert.equal(message.text, 'Use Cairo renderer');
});

test('automatic continuation recalls only the exact project and remains quiet when idle or paused', async (t) => {
  const f = fixture(t),
    work = unfinished(f),
    supervisor = new WorkContinuationSupervisor({ engine: f.engine });
  const context = {
    version: 1,
    updatedAt: 1000,
    originalRequest: {
      messageId: work.messageId,
      at: 1000,
      text: 'Cairo renderer BOUND project result',
      attachments: [],
    },
    humanUpdates: [],
    results: [],
  };
  f.engine.memory.writeProject(f.store.state.conversationId, work.id, context);
  f.engine.memory.writeProject(f.store.state.conversationId, 'unrelated', {
    ...context,
    originalRequest: { ...context.originalRequest, text: 'Cairo renderer OTHER project result' },
  });
  const before = structuredClone(f.store.state.messages);
  await supervisor.tick();
  assert.match(sent(f.worker), /BOUND project result/);
  assert.doesNotMatch(sent(f.worker), /OTHER project result/);
  assert.deepEqual(f.store.state.messages, before);
  assert.equal(defined(f.engine.active?.workRecord).id, work.id);
  const callCount = f.worker.calls.length;
  await supervisor.tick();
  assert.equal(f.worker.calls.length, callCount);
  const other = fixture(t),
    idle = new WorkContinuationSupervisor({ engine: other.engine });
  await idle.tick();
  assert.equal(other.worker.calls.length, 0);
  unfinished(other);
  other.store.pauseContinuingWork();
  other.engine.memory.retrieve = () => assert.fail('Paused work must not trigger recall');
  await idle.tick();
  assert.equal(other.worker.calls.length, 0);
});

test('recognized audio contributes to recall without adding its transcript to the saved chat message', async (t) => {
  const f = fixture(t, {
    audioTranscriber: {
      transcribe: async () => ({ text: 'Cairo renderer', language: 'en', duration: 1 }),
    },
  });
  remember(f.engine, 'Cairo renderer AUDIO preference');
  const message = f.store.add({
    role: 'user',
    text: '',
    attachments: [
      { id: 'audio', name: 'voice.wav', type: 'audio/wav', path: '/fixture/voice.wav' },
    ],
  });
  f.engine.enqueue(message);
  await tick();
  assert.match(sent(f.worker), /AUDIO preference/);
  assert.equal(message.text, '');
  assert.equal(f.store.state.messages.length, 1);
});

test('native typed call input recalls current facts at dispatch without changing saved message identity', async (t) => {
  const f = fixture(t);
  const voice = new NativeRealtimeVoice({
    engine: f.engine,
    worker: f.worker,
    connectTimeoutMs: 1000,
    contextTimeoutMs: 1000,
  });
  const call = await f.engine.startCall(sdp);
  f.engine.confirmCallConnected(call.callId);
  remember(f.engine, 'Cairo renderer NATIVE preference');
  const message = f.store.add({ role: 'user', text: 'Use Cairo renderer' });
  const result = await voice.submitCallMessage(message, { callId: call.callId });
  assert.equal(result.submission, 'confirmed');
  const appended = f.worker.calls.filter((entry) => entry.method === 'thread/realtime/appendText');
  assert.equal(appended.length, 1);
  assert.match(String(appended[0]?.params.text), /NATIVE preference/);
  assert.equal(f.engine.task(message.id), message);
  assert.equal(message.text, 'Use Cairo renderer');
  assert.equal(f.store.state.messages.length, 1);
});
