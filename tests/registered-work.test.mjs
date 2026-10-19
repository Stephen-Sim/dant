import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/conversation/store.mjs';
import { Engine, dynamicTools } from '../src/work/engine.mjs';
import { NativeRealtimeVoice } from '../src/voice/realtime.mjs';
import { taskPlanInput, publicTaskPlan, startTaskProgress } from '../src/work/task-progress.mts';
import { createWorkerApp } from '../src/app/server.mjs';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const steps = () => [
  { step: 'Inspect the current project', status: 'inProgress' },
  { step: 'Make the requested change', status: 'pending' },
  { step: 'Verify the result', status: 'pending' },
];
const plan = () => ({ title: 'Update the requested project', steps: steps() });
class Worker extends EventEmitter {
  constructor() {
    super();
    this.status = 'online';
    this.calls = [];
    this.responses = [];
    this.rpc = {
      reply: (id, result) => this.responses.push({ id, result }),
      send: (result) => this.responses.push(result),
    };
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'thread/realtime/start') {
      queueMicrotask(() => {
        this.emit('event', {
          method: 'thread/realtime/started',
          params: { threadId: 'thread', version: 'v3' },
        });
        this.emit('event', { method: 'thread/realtime/sdp', params: { threadId: 'thread', sdp } });
      });
      return {};
    }
    if (method === 'thread/realtime/stop') {
      queueMicrotask(() =>
        this.emit('event', { method: 'thread/realtime/closed', params: { threadId: 'thread' } }),
      );
      return {};
    }
    if (method === 'thread/read') {
      const turns = [...(this.engine?.nativeVoice?.session?.turns.values() || [])].map((turn) => ({
        id: turn.turnId,
        status: turn.done
          ? turn.finalStatus === 'review'
            ? 'completed'
            : turn.finalStatus === 'paused'
              ? 'interrupted'
              : 'failed'
          : 'inProgress',
      }));
      return {
        thread: {
          id: 'thread',
          status: { type: turns.some((turn) => turn.status === 'inProgress') ? 'active' : 'idle' },
          turns,
        },
      };
    }
    return {};
  }
  disconnect() {
    this.status = 'offline';
  }
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(root, 'registered-work-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    worker = new Worker(),
    engine = new Engine(store, worker),
    notices = [];
  worker.engine = engine;
  engine.on('notice', (text) => notices.push(text));
  return { dir, store, worker, engine, notices };
}
function activeTask(f, { id = 'owned-turn', voice = false } = {}) {
  const message = f.store.add({
    role: 'user',
    text: 'Please change the project',
    status: 'running',
    turnId: id,
  });
  const active = {
    threadId: 'thread',
    turnId: id,
    startAcknowledged: true,
    messageId: message.id,
    messageIds: [message.id],
    assistantIds: [],
    outputs: new Map(),
    explicitPaths: [],
    resolveStopped() {},
    voiceOutput: voice,
  };
  startTaskProgress(active);
  f.engine.active = active;
  return { message, active };
}
const event = (method, params = {}, id) => ({
  method,
  params: { threadId: 'thread', ...params },
  ...(id === undefined ? {} : { id }),
});

test('task plan validation stores only redacted public title and actual step statuses', () => {
  const value = taskPlanInput(
    {
      title: 'Fix synthetic-secret\nproject',
      steps: [
        {
          step: 'Read synthetic-secret\nconfig',
          status: 'inProgress',
          privateReasoning: 'must not copy',
        },
      ],
    },
    { redact: (text) => text.replaceAll('synthetic-secret', '[redacted]') },
  );
  assert.equal(value.title, 'Fix [redacted] project');
  assert.deepEqual(value.plan, {
    total: 1,
    completed: 0,
    currentStep: 'Read [redacted] config',
    steps: [{ step: 'Read [redacted] config', status: 'inProgress' }],
  });
  assert.equal(JSON.stringify(value).includes('must not copy'), false);
  for (const args of [
    null,
    [],
    {},
    { ...plan(), status: 'completed' },
    { ...plan(), title: ' ' },
    { ...plan(), title: 'x'.repeat(241) },
    { ...plan(), steps: [] },
    { ...plan(), steps: [{ step: 'Do work', status: 'finished' }] },
    { ...plan(), steps: [{ step: ' ', status: 'pending' }] },
    { ...plan(), steps: [{ step: 'x'.repeat(5001), status: 'pending' }] },
    { ...plan(), steps: Array.from({ length: 129 }, () => steps()[0]) },
  ])
    assert.throws(() => taskPlanInput(args));
  assert.throws(
    () => publicTaskPlan([{ step: 'x', status: 'pending' }], { redact: () => '' }),
    /visible text/,
  );
  assert.throws(() => taskPlanInput(plan(), { redact: () => '' }), /visible text/);
});

test('acknowledged typed task plan is saved before tool acknowledgement, reuses one real turn and never creates chat or work', async (t) => {
  const f = setup(t),
    { message, active } = activeTask(f),
    beforeMessages = structuredClone(f.store.state.messages),
    calls = f.worker.calls.length;
  const result = await f.engine.tool('task_plan', plan()),
    saved = JSON.parse(fs.readFileSync(f.store.file, 'utf8')).workTasks[0];
  assert.equal(result.saved, true);
  assert.equal(saved.id, result.workId);
  assert.equal(saved.turnId, active.turnId);
  assert.equal(saved.messageId, message.id);
  assert.equal(saved.status, 'running');
  assert.equal(saved.source, 'chat');
  assert.deepEqual(saved.plan.steps, steps());
  assert.deepEqual(f.store.state.messages, beforeMessages);
  assert.equal(f.worker.calls.length, calls);
  assert.equal(f.engine.queue.length, 0);
  assert.equal(f.engine.active, active);
  assert.equal(f.engine.progress.title, plan().title);
  assert.equal(f.engine.progress.workId, saved.id);
  assert.deepEqual(f.engine.progress.plan.steps, steps());
  const updated = await f.engine.tool('task_plan', {
    title: 'Verify this same change',
    steps: [{ step: 'Change verified', status: 'completed' }],
  });
  assert.equal(updated.workId, saved.id);
  assert.equal(f.store.state.workTasks.length, 1);
  assert.equal(f.store.state.workTasks[0].status, 'running');
  assert.equal(message.status, 'running');
  assert.equal(f.engine.active, active, 'a completed checklist does not complete execution');
  assert.ok(dynamicTools.some((tool) => tool.name === 'task_plan'));
  assert.match(f.engine.instructions(), /Before executing.*task_plan/);
  assert.match(f.engine.instructions(), /Ordinary conversation does not need a task plan/);
});

test('task plan failures roll back both first registration and updates before any success response', async (t) => {
  const f = setup(t),
    { active } = activeTask(f),
    save = f.store.save;
  f.store.save = () => {
    throw Error('Disk is full');
  };
  await assert.rejects(f.engine.tool('task_plan', plan()), /Disk is full/);
  assert.deepEqual(f.store.state.workTasks, []);
  assert.equal(active.workRecord, undefined);
  f.store.save = save;
  await f.engine.tool('task_plan', plan());
  const before = structuredClone(f.store.state.workTasks),
    oldRecord = active.workRecord;
  f.store.save = () => {
    throw Error('Disk is full');
  };
  await assert.rejects(
    f.engine.tool('task_plan', { title: 'Unsaved replacement', steps: steps() }),
    /Disk is full/,
  );
  assert.deepEqual(f.store.state.workTasks, before);
  assert.equal(active.workRecord, oldRecord);
});

test('an entrusted task spans related conversational follow-ups without a task for every sentence or completed response', async (t) => {
  const f = setup(t),
    first = activeTask(f, { id: 'first-conversation' });
  first.message.workKind = 'conversation';
  first.active.conversationalInput = true;
  assert.equal(f.engine.progress.visible, false);
  const saved = await f.engine.tool('task_plan', plan());
  assert.equal(first.message.workKind, 'task');
  assert.notEqual(f.engine.progress.visible, false);
  const started = f.engine.progress.startedAt;
  await f.engine.finish('completed');
  assert.equal(f.engine.active, null);
  assert.equal(f.store.state.workTasks[0].status, 'continuing');
  assert.equal(f.store.state.workTasks.length, 1);
  const followup = activeTask(f, { id: 'related-followup' });
  followup.message.workKind = 'conversation';
  followup.active.conversationalInput = true;
  assert.equal(f.engine.progress.visible, false);
  const continued = await f.engine.tool('task_plan', { ...plan(), workId: saved.workId });
  assert.equal(continued.workId, saved.workId);
  assert.equal(followup.message.workKind, 'task');
  assert.notEqual(f.engine.progress.visible, false);
  assert.equal(f.engine.progress.startedAt, started);
  assert.deepEqual(f.store.state.workTasks[0].turnIds, ['first-conversation', 'related-followup']);
  assert.equal(f.store.state.workTasks.length, 1);
  await f.engine.tool('task_plan', {
    ...plan(),
    workId: saved.workId,
    steps: steps().map((step) => ({ ...step, status: 'completed' })),
  });
  await f.engine.finish('completed');
  assert.equal(f.store.state.workTasks[0].status, 'review');
  assert.equal(f.engine.active, null);
  assert.equal(f.engine.queue.length, 0);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  const conversation = activeTask(f, { id: 'ordinary-thanks' });
  conversation.message.workKind = 'conversation';
  conversation.active.conversationalInput = true;
  assert.equal(f.engine.progress.visible, false);
  await f.engine.finish('completed');
  assert.equal(conversation.message.workKind, 'conversation');
  assert.equal(f.store.state.workTasks.length, 1);
  assert.equal(f.store.state.workTasks[0].status, 'review');
});

test('stale, unacknowledged, paused, offline and unrelated voice callers cannot register a plan', async (t) => {
  const f = setup(t),
    { active } = activeTask(f);
  for (const flag of ['startAcknowledged', 'stopRequested', 'finishing']) {
    const old = active[flag];
    active[flag] = flag === 'startAcknowledged' ? false : true;
    await assert.rejects(f.engine.tool('task_plan', plan()), /current acknowledged/);
    active[flag] = old;
  }
  for (const field of ['takeover', 'acquiring']) {
    f.engine[field] = true;
    await assert.rejects(f.engine.tool('task_plan', plan()), /current acknowledged/);
    f.engine[field] = false;
  }
  f.worker.status = 'offline';
  await assert.rejects(f.engine.tool('task_plan', plan()), /current acknowledged/);
  f.worker.status = 'online';
  for (const context of [
    { owner: 'voice', isCurrent: () => true },
    { task: { turnId: 'unowned' }, isCurrent: () => true },
    { task: active, isCurrent: () => false },
  ])
    await assert.rejects(f.engine.tool('task_plan', plan(), context), /no longer belongs/);
  f.engine.active = null;
  await assert.rejects(f.engine.tool('task_plan', plan()), /current acknowledged/);
  assert.deepEqual(f.store.state.workTasks, []);
});

test('typed lifecycle follows executor status, persists review, accepts result and dismisses without touching shared model context', async (t) => {
  const f = setup(t),
    { active, message } = activeTask(f);
  f.store.state.threadId = 'shared-thread';
  f.store.state.voiceHistory = [{ role: 'user', text: 'Private reference only' }];
  await f.engine.tool('task_plan', plan());
  const id = active.workRecord.id;
  active.awaitingChatInput = true;
  f.engine.change();
  assert.equal(f.store.state.workTasks[0].status, 'waiting_user');
  active.awaitingChatInput = false;
  f.engine.change();
  assert.equal(f.store.state.workTasks[0].status, 'running');
  assert.throws(
    () => f.engine.dismissProgress(id, 'work'),
    (error) => error.status === 409,
  );
  await f.engine.tool('task_plan', {
    ...plan(),
    steps: steps().map((step) => ({ ...step, status: 'completed' })),
  });
  await f.engine.finish('completed');
  assert.equal(f.store.state.workTasks[0].status, 'review');
  assert.equal(message.status, 'review');
  f.engine.confirm(message.id);
  assert.equal(f.store.state.workTasks[0].status, 'completed');
  const before = structuredClone(f.store.state),
    read = message.read;
  assert.deepEqual(f.engine.dismissProgress(id, 'work'), { ok: true });
  assert.equal(message.read, read);
  assert.equal(f.store.state.threadId, 'shared-thread');
  assert.deepEqual(f.store.state.voiceHistory, before.voiceHistory);
  assert.equal(f.worker.calls.length, 0);
  assert.deepEqual(f.engine.dismissProgress(id, 'work'), { ok: true });
  const restored = new Store(f.dir);
  assert.equal(restored.state.workTasks[0].status, 'completed');
  assert.ok(restored.state.workTasks[0].progressDismissedAt > 0);
  assert.equal(restored.state.workTasks[0].id, id);
});

test('registered records pause after restart and failed persistence never exposes an unconfirmed lifecycle update', async (t) => {
  const f = setup(t);
  activeTask(f);
  await f.engine.tool('task_plan', plan());
  const before = structuredClone(f.store.state.workTasks),
    save = f.store.save;
  f.store.save = () => {
    throw Error('Storage unavailable');
  };
  assert.throws(
    () => f.store.updateRegisteredWork(before[0].turnId, { status: 'review' }),
    /Storage unavailable/,
  );
  assert.deepEqual(f.store.state.workTasks, before);
  f.store.save = save;
  const restored = new Store(f.dir);
  assert.equal(restored.state.workTasks[0].status, 'paused');
  assert.equal(restored.state.workTasks[0].pauseReason, 'restart');
  assert.equal(restored.state.workTasks[0].title, plan().title);
  assert.deepEqual(restored.state.workTasks[0].plan.steps, steps());
  assert.equal(restored.state.threadId, f.store.state.threadId);
});

test('accepting registered work persists message and work state atomically and leaves failures retryable', async (t) => {
  const f = setup(t),
    { message } = activeTask(f);
  await f.engine.tool('task_plan', {
    ...plan(),
    steps: steps().map((step) => ({ ...step, status: 'completed' })),
  });
  await f.engine.finish('completed');
  const before = structuredClone(f.store.state),
    save = f.store.save;
  f.store.save = () => {
    throw Error('Cannot accept yet');
  };
  assert.throws(() => f.engine.confirm(message.id), /Cannot accept yet/);
  assert.deepEqual(f.store.state, before);
  assert.equal(message.status, 'review');
  assert.equal(f.store.state.workTasks[0].status, 'review');
  f.store.save = save;
  f.engine.confirm(message.id);
  const disk = JSON.parse(fs.readFileSync(f.store.file, 'utf8'));
  assert.equal(disk.messages[0].status, 'completed');
  assert.equal(disk.workTasks[0].status, 'completed');
});

test('dismissing a finished registered turn never hides or mutates a distinct retry using the same user message', async (t) => {
  const f = setup(t),
    { message, active } = activeTask(f);
  await f.engine.tool('task_plan', plan());
  await f.engine.finish('failed');
  const old = f.store.state.workTasks[0];
  const retry = {
    ...active,
    turnId: 'retry-turn',
    finishing: false,
    finalStatus: undefined,
    workRecord: undefined,
  };
  f.engine.active = retry;
  message.turnId = retry.turnId;
  message.status = 'running';
  await f.engine.tool('task_plan', { ...plan(), title: 'Retry this project' });
  const current = f.store.state.workTasks[1];
  assert.deepEqual(f.engine.dismissProgress(old.id, 'work', { confirmUnfinished: true }), {
    ok: true,
  });
  assert.equal(message.status, 'running');
  assert.throws(
    () => f.engine.dismissProgress(current.id, 'work'),
    (error) => error.status === 409,
  );
  assert.equal(current.progressDismissedAt, undefined);
  const before = old.progressDismissedAt;
  f.engine.active = null;
  f.engine.queue = [{ id: message.id, turnId: 'retry-turn' }];
  assert.deepEqual(f.engine.dismissProgress(old.id, 'work', { confirmUnfinished: true }), {
    ok: true,
  });
  assert.equal(old.progressDismissedAt, before);
  f.engine.queue = [{ id: message.id }];
  assert.throws(
    () => f.engine.dismissProgress(old.id, 'work'),
    (error) => error.status === 409,
  );
  f.engine.queue = [];
});

test('only owned public plan events register actual steps; reasoning and private tool output stay out', async (t) => {
  const f = setup(t),
    { active } = activeTask(f);
  await f.engine.handle(
    event('turn/plan/updated', {
      turnId: 'stale',
      plan: steps(),
      explanation: 'Private explanation',
    }),
  );
  assert.equal(f.store.state.workTasks.length, 0);
  await f.engine.handle(
    event('turn/plan/updated', {
      turnId: active.turnId,
      plan: steps(),
      explanation: 'Private explanation',
    }),
  );
  assert.equal(f.store.state.workTasks.length, 1);
  assert.deepEqual(f.store.state.workTasks[0].plan.steps, steps());
  assert.equal(JSON.stringify(f.store.state.workTasks).includes('Private explanation'), false);
  await f.engine.handle(
    event('item/started', {
      turnId: active.turnId,
      item: { id: 'reasoning', type: 'reasoning', text: 'Private reasoning' },
    }),
  );
  assert.equal(JSON.stringify(f.store.state.workTasks).includes('Private reasoning'), false);
  await f.engine.finish('failed', 'Execution failed');
  assert.equal(f.store.state.workTasks[0].status, 'failed');
});

test('native call tasks register before their tool result, survive hangup, and finalize without synthetic chat or speech', async (t) => {
  const f = setup(t),
    voice = new NativeRealtimeVoice({
      worker: f.worker,
      engine: f.engine,
      connectTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    });
  const call = await f.engine.startCall(sdp);
  await f.engine.handle(
    event('turn/started', { turn: { id: 'native-owned', status: 'inProgress' } }),
  );
  const turn = voice.session.turns.get('native-owned');
  await f.engine.handle(
    event(
      'item/tool/call',
      { turnId: turn.turnId, tool: 'task_plan', arguments: plan(), callId: 'register' },
      81,
    ),
  );
  assert.equal(f.worker.responses.find((item) => item.id === 81).result.success, true);
  assert.equal(f.store.state.messages.length, 0);
  assert.equal(f.store.state.workTasks[0].source, 'voice');
  assert.equal(f.store.state.workTasks[0].messageId, null);
  assert.equal(voice.progress.title, plan().title);
  await f.engine.handle(
    event('turn/plan/updated', {
      turnId: turn.turnId,
      plan: [
        { step: 'Inspected', status: 'completed' },
        { step: 'Verify actual result', status: 'inProgress' },
      ],
      explanation: 'Private spoken context',
    }),
  );
  assert.equal(f.store.state.workTasks[0].plan.completed, 1);
  assert.equal(f.store.state.workTasks[0].plan.steps[1].step, 'Verify actual result');
  // Model planning is task metadata; it never creates a second turn or queue.
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.equal(f.engine.queue.length, 0);
  f.worker.request = async (method, params) => {
    f.worker.calls.push({ method, params });
    if (method === 'thread/realtime/stop')
      queueMicrotask(() => f.worker.emit('event', event('thread/realtime/closed')));
    if (method === 'thread/read')
      return {
        thread: {
          id: 'thread',
          status: { type: 'active' },
          turns: [{ id: turn.turnId, status: 'inProgress' }],
        },
      };
    return {};
  };
  await f.engine.stopCall(call.callId);
  assert.equal(f.engine.call, null);
  assert.equal(voice.progress.title, plan().title);
  assert.equal(f.store.state.workTasks[0].status, 'running');
  await f.engine.handle(
    event('turn/completed', { turn: { id: turn.turnId, status: 'completed' } }),
  );
  assert.equal(f.store.state.workTasks[0].status, 'continuing');
  assert.equal(voice.session, null);
  assert.equal(f.store.state.messages.filter((message) => message.role === 'user').length, 0);
  assert.equal(JSON.stringify(f.store.state.workTasks).includes('Private spoken context'), false);
  assert.match(
    f.store.state.messages.find((message) => message.role === 'assistant').text,
    /unfinished|尚未完成/,
  );
});

test('native registered work remains in history even with no final chat result and cannot be updated by a completed scope', async (t) => {
  const f = setup(t),
    voice = new NativeRealtimeVoice({
      worker: f.worker,
      engine: f.engine,
      connectTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    }),
    call = await f.engine.startCall(sdp);
  await f.engine.handle(event('turn/started', { turn: { id: 'no-output', status: 'inProgress' } }));
  const session = voice.session,
    turn = session.turns.get('no-output');
  await voice.tool(session, turn, 'task_plan', plan());
  await f.engine.handle(
    event('turn/completed', { turn: { id: turn.turnId, status: 'interrupted' } }),
  );
  assert.equal(f.store.state.workTasks[0].status, 'paused');
  assert.equal(f.store.state.completions.length, 0);
  assert.equal(f.store.state.messages.length, 0);
  await assert.rejects(voice.tool(session, turn, 'task_plan', plan()), /no longer belongs/);
  assert.deepEqual(
    f.engine.dismissProgress(f.store.state.workTasks[0].id, 'work', { confirmUnfinished: true }),
    { ok: true },
  );
  await f.engine.stopCall(call.callId);
});

test('executor finality is saved for typed work even when the earlier chat result save fails', async (t) => {
  const f = setup(t),
    { message } = activeTask(f);
  await f.engine.tool('task_plan', plan());
  const update = f.store.update.bind(f.store);
  f.store.update = (id, patch) => {
    if (id === message.id) throw Error('Chat write failed');
    return update(id, patch);
  };
  await f.engine.finish('failed', 'Execution failed');
  assert.equal(f.engine.active, null);
  assert.equal(f.store.state.workTasks[0].status, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).workTasks[0].status, 'failed');
  assert.match(f.notices.join('\n'), /Chat write failed/);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('native registered task finality is saved independently of a failed explicit message update', async (t) => {
  const f = setup(t),
    voice = new NativeRealtimeVoice({
      worker: f.worker,
      engine: f.engine,
      connectTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    }),
    call = await f.engine.startCall(sdp);
  await f.engine.handle(
    event('turn/started', { turn: { id: 'native-finality', status: 'inProgress' } }),
  );
  const session = voice.session,
    turn = session.turns.get('native-finality');
  const message = f.store.add({
    role: 'user',
    text: 'Typed follow-up',
    status: 'running',
    turnId: turn.turnId,
  });
  turn.messageId = message.id;
  turn.explicitMessageIds.push(message.id);
  await voice.tool(session, turn, 'task_plan', plan());
  const update = f.store.update.bind(f.store);
  f.store.update = (id, patch) => {
    if (id === message.id) throw Error('Cannot save this chat result');
    return update(id, patch);
  };
  await f.engine.handle(
    event('turn/completed', { turn: { id: turn.turnId, status: 'interrupted' } }),
  );
  assert.equal(turn.resultSaved, true);
  assert.equal(f.store.state.workTasks[0].status, 'paused');
  assert.equal(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).workTasks[0].status, 'paused');
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  await f.engine.stopCall(call.callId);
});

async function apiSetup(t) {
  const dir = fs.mkdtempSync(path.join(root, 'registered-work-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  class Provider extends EventEmitter {
    constructor() {
      super();
      this.state = { available: true };
    }
    async close() {}
  }
  const worker = new Worker(),
    nativeVoice = new Provider(),
    voice = new Provider(),
    instance = createWorkerApp({
      dataDir: dir,
      workerFactory: () => worker,
      voiceFactory: () => voice,
      nativeVoiceFactory: () => nativeVoice,
    });
  t.after(async () => {
    instance.engine.active = null;
    nativeVoice.session = null;
    await instance.close();
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + instance.server.address().port,
    { token } = await fetch(base + '/api/session').then((response) => response.json());
  const internal = (body, privateToken = worker.credentialBridgeToken) =>
    fetch(base + '/api/internal/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dant-Credential-Token': privateToken },
      body: JSON.stringify({ tool: 'task_plan', arguments: body }),
    });
  return {
    instance,
    worker,
    nativeVoice,
    internal,
    state: () =>
      fetch(base + '/api/state', { headers: { 'X-Dant-Token': token } }).then((response) =>
        response.json(),
      ),
  };
}
test('MCP private task-plan bridge checks token, active owned scope, durable save and public snapshot', async (t) => {
  const h = await apiSetup(t);
  assert.equal((await h.internal(plan(), 'forged')).status, 403);
  assert.equal((await h.internal(plan())).status, 409);
  const { active } = activeTask({ store: h.instance.store, engine: h.instance.engine });
  assert.equal((await h.internal(plan())).status, 200);
  const state = await h.state();
  assert.equal(state.workTasks.length, 1);
  assert.equal(state.active.workId, state.workTasks[0].id);
  assert.equal(state.active.title, plan().title);
  h.instance.engine.takeover = true;
  assert.equal((await h.internal(plan())).status, 409);
  h.instance.engine.takeover = false;
  const save = h.instance.store.save;
  h.instance.store.save = () => {
    throw Error('Storage rejected private-secret-value');
  };
  const failed = await h.internal({ title: 'Must not acknowledge', steps: steps() });
  assert.equal(failed.status, 400);
  assert.equal((await failed.text()).includes('private-secret-value'), false);
  assert.equal(h.instance.store.state.workTasks[0].title, plan().title);
  h.instance.store.save = save;
  h.instance.engine.active = null;
  const session = { id: 'native-call', status: 'connected', turns: new Map() },
    turn = { turnId: 'native-turn', done: false };
  session.turns.set(turn.turnId, turn);
  h.nativeVoice.session = session;
  h.instance.engine.call = { id: session.id, provider: 'subscription' };
  assert.equal((await h.internal(plan())).status, 200);
  assert.equal(h.instance.store.state.workTasks[1].source, 'voice');
  session.unknown = true;
  assert.equal((await h.internal(plan())).status, 409);
  session.unknown = false;
  session.turns.set('second', { turnId: 'second', done: false });
  assert.equal((await h.internal(plan())).status, 409);
  assert.equal(h.instance.store.state.workTasks.length, 2);
  assert.equal(active.turnId, 'owned-turn');
});

test('MCP continuation binding conflicts return a recoverable unsaved receipt without switching or mutating tasks', async (t) => {
  const h = await apiSetup(t),
    { store, engine } = h.instance;
  store.state.threadId = 'thread';
  store.state.threadRuntime = engine.runtimeId;
  store.state.threadConversationId = store.state.conversationId;
  engine.loaded = true;
  const first = store.registerWork({
      turnId: 'first-old-turn',
      source: 'chat',
      title: 'Verify the hard drop',
      plan: { steps: steps() },
    }),
    second = store.registerWork({
      turnId: 'second-old-turn',
      source: 'chat',
      title: 'Optimize another task',
      plan: { steps: steps() },
    });
  for (const record of [first, second])
    store.updateRegisteredWork(record.turnId, {
      status: 'continuing',
      executionEnded: true,
      at: Date.now() - 10000,
    });
  h.worker.request = async (method, params) => {
    h.worker.calls.push({ method, params });
    if (method === 'thread/read')
      return {
        thread: {
          id: 'thread',
          status: { type: 'idle' },
          turns: store.state.workTasks.map((record) => ({
            id: record.turnId,
            status: 'completed',
          })),
        },
      };
    if (method === 'turn/start') return { turn: { id: 'automatic-owned-turn' } };
    return {};
  };
  await engine.continueRegisteredWork(first.id, { expectedTurnId: first.turnId });
  const before = structuredClone(store.state.workTasks),
    starts = h.worker.calls.filter((call) => call.method === 'turn/start').length;
  for (const workId of [undefined, second.id]) {
    const response = await h.internal({
      ...(workId ? { workId } : {}),
      title: second.title,
      steps: steps(),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.saved, false);
    assert.equal(body.code, 'work_conflict');
    assert.equal(body.activeWorkId, first.id);
    assert.match(body.guidance, /not saved/);
    assert.ok(body.guidance.includes(first.id));
    assert.ok(!body.guidance.includes(second.id));
  }
  assert.deepEqual(store.state.workTasks, before);
  assert.equal(h.worker.calls.filter((call) => call.method === 'turn/start').length, starts);
  const original = engine.tool;
  engine.tool = async () => {
    throw Object.assign(Error('private conflict detail'), {
      code: 'work_conflict',
      activeWorkId: first.id,
    });
  };
  const unknown = await h.internal({ workId: second.id, title: second.title, steps: steps() });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), {
    error: 'The task progress request could not be completed.',
    code: 'work_conflict',
  });
  engine.tool = original;
  const response = await h.internal({ workId: first.id, title: first.title, steps: steps() });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.saved, true);
  assert.equal(saved.workId, first.id);
  assert.equal(store.state.workTasks.length, 2);
  assert.deepEqual(
    store.state.workTasks.find((record) => record.id === second.id),
    before.find((record) => record.id === second.id),
  );
  assert.equal(h.worker.calls.filter((call) => call.method === 'turn/start').length, starts);
});
