import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/conversation/store.mjs';
import { Engine } from '../src/work/engine.mjs';
import { NativeRealtimeVoice } from '../src/voice/realtime.mjs';
import { WorkContinuationSupervisor } from '../src/work/work-continuation.mjs';
import { createWorkerApp } from '../src/app/server.mjs';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const tick = () => new Promise((resolve) => setImmediate(resolve)),
  sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
  steps = [
    { step: 'Implement the requested change', status: 'inProgress' },
    { step: 'Verify the result', status: 'pending' },
  ];
const event = (method, params = {}) => ({ method, params: { threadId: 'thread', ...params } }),
  terminal = (id, status = 'interrupted') => event('turn/completed', { turn: { id, status } });
class Worker extends EventEmitter {
  constructor(dir) {
    super();
    this.status = 'online';
    this.runtimeId = 'vm:pause:test';
    this.workspaceRoot = path.join(dir, 'workspaces');
    this.calls = [];
    this.next = 0;
    this.interrupt = true;
    this.rpc = { send() {}, reply() {} };
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++this.next } };
    if (method === 'turn/interrupt' && this.interrupt)
      queueMicrotask(() => this.emit('event', terminal(params.turnId)));
    if (method === 'thread/realtime/start')
      queueMicrotask(() => {
        this.emit(
          'event',
          event('thread/realtime/started', {
            version: 'v3',
            realtimeSessionId: 'rt-' + params.voiceSessionId,
          }),
        );
        this.emit('event', event('thread/realtime/sdp', { sdp }));
      });
    if (method === 'thread/realtime/stop')
      queueMicrotask(() => this.emit('event', event('thread/realtime/closed')));
    if (method === 'thread/read')
      return {
        thread: {
          id: 'thread',
          status: { type: 'idle' },
          turns: [
            { id: 'old-turn', status: 'completed' },
            ...[...(this.engine?.nativeVoice?.session?.turns.values() || [])].map((turn) => ({
              id: turn.turnId,
              status: turn.done ? 'completed' : 'inProgress',
            })),
          ],
        },
      };
    return {};
  }
  async terminateConfirmed() {
    throw Error('Pausing must not terminate the executor');
  }
  disconnect() {}
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(base, 'task-pause-'));
  t.after(() => {
    assert.equal(path.dirname(dir), base);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir),
    worker = new Worker(dir),
    engine = new Engine(store, worker);
  worker.engine = engine;
  return { dir, store, worker, engine };
}
async function activeTask(f) {
  const message = f.store.add({ role: 'user', text: 'Continue the implementation' });
  f.engine.enqueue(message);
  await tick();
  const saved = f.engine.registerTaskPlan({ title: 'Entrusted work', steps }),
    record = f.store.state.workTasks.find((item) => item.id === saved.workId);
  return { message, record, active: f.engine.active };
}
function inactiveTask(f) {
  f.store.state.threadId = 'thread';
  const message = f.store.add({
      role: 'user',
      text: 'Original request',
      turnId: 'old-turn',
      status: 'review',
    }),
    record = f.store.registerWork({
      turnId: 'old-turn',
      messageId: message.id,
      title: 'Saved unfinished work',
      plan: { steps },
    });
  f.store.updateRegisteredWork('old-turn', { status: 'continuing', executionEnded: true });
  return { message, record: f.store.state.workTasks.find((item) => item.id === record.id) };
}

test('pause stops only the selected task and keeps queued work and partial results', async (t) => {
  const f = fixture(t),
    { record, message, active } = await activeTask(f),
    partial = f.engine.deliverText('Useful result so far'),
    queued = f.store.add({ role: 'user', text: 'Unrelated queued work' });
  f.engine.enqueue(queued);
  assert.deepEqual(await f.engine.pauseProgress(record.id, 'work', { turnId: active.turnId }), {
    ok: true,
    paused: true,
  });
  assert.equal(message.status, 'paused');
  assert.equal(f.store.state.workTasks.find((item) => item.id === record.id).status, 'paused');
  assert.equal(f.engine.task(partial.messageId).text, 'Useful result so far');
  assert.equal(f.engine.active.messageId, queued.id);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
  assert.equal(record.cancelledAt, undefined);
  const restored = new Store(f.dir);
  assert.equal(restored.state.workTasks[0].status, 'paused');
  assert.equal(restored.state.workTasks[0].plan.steps[0].status, 'inProgress');
  await f.engine.handle(terminal(f.engine.active.turnId, 'completed'));
});

test('inactive pause survives restart and explicit resume schedules the same work without creating a message', async (t) => {
  const f = fixture(t),
    { record } = inactiveTask(f),
    before = structuredClone(f.store.state.messages);
  await f.engine.pauseProgress(record.id, 'work', { turnId: record.turnId });
  assert.equal(f.store.state.workTasks[0].status, 'paused');
  assert.equal(await new WorkContinuationSupervisor({ engine: f.engine }).tick(), null);
  assert.deepEqual(
    f.store.state.messages.map((m) => m.text),
    before.map((m) => m.text),
  );
  const restored = new Store(f.dir),
    engine = new Engine(restored, f.worker),
    count = restored.state.messages.length,
    reply = engine.resumeProgress(record.id, 'work', { turnId: record.turnId });
  assert.equal(reply.resumed, true);
  assert.equal(reply.workId, record.id);
  assert.equal(restored.state.workTasks[0].status, 'continuing');
  assert.equal(restored.state.messages.length, count);
  const result = await new WorkContinuationSupervisor({ engine }).tick();
  assert.equal(result.workId, record.id);
  assert.equal(engine.active.workRecord.id, record.id);
  assert.equal(restored.state.messages.length, count);
  await engine.handle(terminal(engine.active.turnId));
});

test('native task pause keeps the same call connected and preserves its saved work identity', async (t) => {
  const f = fixture(t),
    voice = new NativeRealtimeVoice({
      engine: f.engine,
      worker: f.worker,
      connectTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    }),
    call = await f.engine.startCall(sdp);
  f.engine.confirmCallConnected(call.callId);
  await f.engine.handle(
    event('turn/started', { turn: { id: 'native-turn', status: 'inProgress' } }),
  );
  const session = voice.session,
    turn = session.turns.get('native-turn'),
    record = f.engine.registerTaskPlan(
      { title: 'Native entrusted work', steps },
      { task: turn, isCurrent: () => voice.session === session },
    );
  assert.deepEqual(
    await f.engine.pauseProgress(record.workId, 'work', {
      turnId: turn.turnId,
      callId: session.id,
    }),
    { ok: true, paused: true },
  );
  assert.equal(f.engine.call.id, call.callId);
  assert.equal(f.engine.call.status, 'connected');
  assert.equal(f.store.state.workTasks[0].status, 'paused');
  assert.equal(turn.cancelRequested, undefined);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'thread/realtime/stop'),
    false,
  );
  await f.engine.stopCall(call.callId);
});

test('stale identities, uncertain tasks and finished records cannot be resumed or repurposed', async (t) => {
  const f = fixture(t),
    { record } = inactiveTask(f),
    before = structuredClone(f.store.state.workTasks);
  assert.throws(
    () => f.engine.pauseProgress(record.id, 'work', { turnId: 'wrong-turn' }),
    (error) => error.status === 409,
  );
  assert.deepEqual(f.store.state.workTasks, before);
  await f.engine.pauseProgress(record.id, 'work', { turnId: record.turnId });
  const paused = f.store.state.workTasks[0];
  for (const patch of [
    { status: 'cancelled' },
    { status: 'completed' },
    { status: 'unknown' },
    { continuation: { invalid: true } },
    { continuation: { dispatch: { phase: 'unknown' } } },
    { plan: { steps: [{ step: 'Done', status: 'completed' }] } },
  ]) {
    const original = structuredClone(paused);
    Object.assign(paused, patch);
    assert.throws(() => f.engine.resumeProgress(record.id, 'work', { turnId: record.turnId }));
    for (const key of Object.keys(paused)) delete paused[key];
    Object.assign(paused, original);
  }
  assert.throws(() => f.engine.resumeProgress(record.id, 'work', { turnId: 'wrong-turn' }));
  f.store.state.messages[0].submission = 'unknown';
  assert.throws(() => f.engine.resumeProgress(record.id, 'work', { turnId: record.turnId }));
  assert.equal(f.worker.calls.length, 0);
});

test('failed pause and resume saves roll back the original plan and status', async (t) => {
  const f = fixture(t),
    { record } = inactiveTask(f),
    save = f.store.save,
    before = structuredClone(f.store.state);
  f.store.save = () => {
    throw Error('Disk unavailable');
  };
  assert.throws(
    () => f.engine.pauseProgress(record.id, 'work', { turnId: record.turnId }),
    /Disk unavailable/,
  );
  assert.deepEqual(f.store.state, before);
  f.store.save = save;
  await f.engine.pauseProgress(record.id, 'work', { turnId: record.turnId });
  const paused = structuredClone(f.store.state);
  f.store.save = () => {
    throw Error('Disk unavailable');
  };
  assert.throws(
    () => f.engine.resumeProgress(record.id, 'work', { turnId: record.turnId }),
    /Disk unavailable/,
  );
  assert.deepEqual(f.store.state, paused);
  f.store.save = save;
});

test('unconfirmed pause never claims success and a later exact terminal event retains paused history', async (t) => {
  const f = fixture(t),
    { record, active } = await activeTask(f);
  f.worker.interrupt = false;
  f.engine.waitStopped = async (owner) => {
    await f.engine.interrupt(owner);
    throw Error('Stop acknowledgement lost');
  };
  await assert.rejects(
    f.engine.pauseProgress(record.id, 'work', { turnId: active.turnId }),
    (error) => error.unknownOutcome === true,
  );
  assert.equal(f.engine.progress.status, 'unknown');
  assert.throws(() => f.engine.resumeProgress(record.id, 'work', { turnId: active.turnId }));
  await f.engine.handle(terminal(active.turnId));
  assert.equal(f.store.state.workTasks[0].status, 'paused');
  assert.notEqual(f.store.state.workTasks[0].status, 'cancelled');
});

test('a confirmed pause can retry persistence after every stop-time save failed without interrupting twice', async (t) => {
  const f = fixture(t),
    { record, active } = await activeTask(f),
    save = f.store.save;
  f.store.save = () => {
    throw Error('Storage unavailable');
  };
  await assert.rejects(
    f.engine.pauseProgress(record.id, 'work', { turnId: active.turnId }),
    /Storage unavailable/,
  );
  assert.equal(f.engine.active, null);
  assert.equal(f.engine.confirmedPauses.has(active.turnId), true);
  f.store.save = save;
  assert.deepEqual(await f.engine.pauseProgress(record.id, 'work', { turnId: active.turnId }), {
    ok: true,
    paused: true,
  });
  assert.equal(f.store.state.workTasks[0].status, 'paused');
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
  assert.equal(new Store(f.dir).state.workTasks[0].status, 'paused');
});

test('authenticated pause and resume routes preserve work and reject stale selectors', async (t) => {
  const f = fixture(t),
    app = createWorkerApp({ dataDir: f.dir, workerFactory: () => f.worker });
  t.after(() => app.close());
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + app.server.address().port,
    { token } = await fetch(url + '/api/session').then((r) => r.json()),
    headers = { 'Content-Type': 'application/json', 'X-Dant-Token': token };
  const record = app.store.registerWork({
    turnId: 'saved-turn',
    title: 'Saved unfinished task',
    plan: { steps },
  });
  app.store.updateRegisteredWork('saved-turn', { status: 'continuing', executionEnded: true });
  const pause = await fetch(url + '/api/tasks/' + record.id + '/pause', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'work', turnId: 'saved-turn' }),
  });
  assert.equal(pause.status, 200);
  assert.equal((await pause.json()).paused, true);
  const wrong = await fetch(url + '/api/tasks/' + record.id + '/resume', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'work', turnId: 'wrong-turn' }),
  });
  assert.equal(wrong.status, 409);
  const resume = await fetch(url + '/api/tasks/' + record.id + '/resume', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'work', turnId: 'saved-turn' }),
  });
  assert.equal(resume.status, 200);
  assert.equal((await resume.json()).resumed, true);
  assert.equal(app.store.state.workTasks[0].id, record.id);
  assert.equal(app.store.state.messages.length, 0);
});
