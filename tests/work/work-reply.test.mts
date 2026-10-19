import { currentActive } from '../support/service-fixtures.mts';
import { TracingWorkerFixture } from '../support/worker-fixtures.mts';
import {
  nativeSessionFixture,
  nativeTurnFixture,
  observedRecord,
  rpcText,
} from '../support/service-fixtures.mts';
import type { RpcParams } from '../../src/runtime/protocol.ts';
import type { TaskStatusValue, PlanStep } from '../../src/contracts/contracts.ts';
import type { StoredWorkRecord } from '../../src/conversation/types.ts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';
import { workReplyInput, workReplyRecord } from '../../src/work/work-reply.mts';
const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plan = (): PlanStep[] => [
  { step: 'Keep the verified result', status: 'completed' },
  { step: 'Use the requested answer', status: 'pending' },
];
function fixture(t: NodeTestContext) {
  const dir = fs.mkdtempSync(path.join(base, 'work-reply-')),
    store = new Store(dir),
    worker = new TracingWorkerFixture(),
    turns = [{ id: 'old-turn', status: 'completed' }];
  Object.assign(worker, {
    status: 'online',
    runtimeId: 'reply-runtime',
    workspaceRoot: path.join(dir, 'workspaces'),
    rpc: { send() {}, reply() {} },
  });
  let count = 0;
  worker.request = async (method: string, params: RpcParams = {}) => {
    worker.calls.push({ method, params });
    if (method === 'thread/read')
      return { thread: { id: 'thread', status: { type: 'idle' }, turns: structuredClone(turns) } };
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') {
      const turn = { id: 'new-' + ++count, status: 'inProgress' };
      turns.push(turn);
      return { turn };
    }
    return {};
  };
  const engine = new Engine(store, worker);
  Object.assign(store.state, {
    threadId: 'thread',
    threadRuntime: engine.runtimeId,
    threadConversationId: store.state.conversationId,
  });
  engine.loaded = true;
  const notices: unknown[] = [];
  engine.on('notice', (value) => notices.push(value));
  t.after(() => {
    if (engine.streamingSaveTimer) clearTimeout(engine.streamingSaveTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const makeRecord = (status: TaskStatusValue = 'waiting_user') => {
    const record = store.registerWork({
      turnId: 'old-turn',
      title: 'Continue the same report',
      source: 'chat',
      plan: { steps: plan() },
      startedAt: 100,
    });
    return defined(
      store.updateRegisteredWork(record.turnId, {
        status,
        executionEnded: true,
        at: Date.now() - 10000,
      }),
    );
  };
  const target = (record: StoredWorkRecord) => ({
    workId: record.id,
    turnId: record.turnId,
    conversationId: store.state.conversationId,
  });
  const message = (record: StoredWorkRecord, text = 'The requested answer is blue') =>
    store.add({ role: 'user', text, status: 'queued', workReply: target(record) });
  const finish = async (status = 'completed') => {
    const active = engine.active;
    defined(turns.find((turn) => turn.id === defined(active).turnId)).status = status;
    await engine.handle({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: defined(active).turnId, status } },
    });
    await tick();
  };
  return { dir, store, worker, engine, notices, turns, makeRecord, target, message, finish };
}

test('a human answer resumes ended waiting, continuing or paused work with its same workId and preserved verified steps', async (t) => {
  for (const status of ['waiting_user', 'continuing', 'paused'] as const)
    await t.test(status, async (t) => {
      const f = fixture(t),
        record = f.makeRecord(status),
        message = f.message(defined(record));
      f.engine.enqueue(message, { interactive: true });
      await tick();
      assert.equal(message.submission, 'confirmed');
      assert.equal(message.workId, defined(record).id);
      assert.equal(f.store.state.workTasks.length, 1);
      assert.equal(defined(defined(f.engine.active).workRecord).id, defined(record).id);
      assert.equal(defined(f.engine.active).quietHumanResponse, true);
      assert.deepEqual(defined(defined(defined(f.engine.active).workRecord).plan).steps, plan());
      const start = f.worker.calls.find((call) => call.method === 'turn/start');
      assert.match(
        rpcText(defined(defined(defined(start).params.input)[0])),
        /current human message explicitly replies/,
      );
      assert.match(
        rpcText(defined(defined(defined(start).params.input)[0])),
        /requested answer is blue/,
      );
      assert.match(
        rpcText(defined(defined(defined(start).params.input)[0])),
        new RegExp(defined(record).id),
      );
      assert.doesNotMatch(
        rpcText(defined(defined(defined(start).params.input)[0])),
        /Automatic follow-up/,
      );
      assert.deepEqual(defined(f.store.state.workTasks[0]).turnIds, ['old-turn', message.turnId]);
      await assert.rejects(
        f.engine.tool('task_plan', { title: 'Wrong replacement', steps: plan() }),
        /exact registered workId/,
      );
      await f.engine.tool('task_plan', {
        workId: defined(record).id,
        title: defined(record).title,
        steps: plan().map((step) => ({ ...step, status: 'completed' })),
      });
      await f.finish();
      assert.equal(defined(f.store.state.workTasks[0]).status, 'review');
    });
});

test('a precise live reply steers only its accepted owner and clears that task input wait', async (t) => {
  const f = fixture(t),
    original = f.store.add({ role: 'user', text: 'Original request', status: 'queued' });
  f.engine.enqueue(original);
  await tick();
  const result = await f.engine.tool('task_plan', {
      title: 'Live work',
      steps: plan(),
      status: 'waiting_user',
    }),
    record = f.store.state.workTasks.find((record) => record.id === observedRecord(result).workId),
    message = f.message(defined(record));
  f.engine.enqueue(message, { interactive: true });
  await defined(f.engine.active).steerChain;
  assert.equal(message.submission, 'confirmed');
  assert.equal(message.turnId, original.turnId);
  assert.equal(defined(f.engine.active).planWaitingForUser, false);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/steer').length, 1);
  assert.equal(defined(f.worker.calls.at(-1)).params.expectedTurnId, defined(record).turnId);
  await f.finish();
});

test('a reply to another ended task queues its exact owner instead of steering unrelated active work', async (t) => {
  const f = fixture(t),
    record = f.makeRecord(),
    other = f.store.add({ role: 'user', text: 'Unrelated request', status: 'queued' });
  f.engine.enqueue(other);
  await tick();
  const message = f.message(defined(record));
  f.engine.enqueue(message, { interactive: true });
  assert.equal(f.engine.queue[0], message);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/steer'),
    false,
  );
  assert.equal(message.submission, undefined);
  await f.finish();
  assert.equal(message.submission, 'confirmed');
  assert.equal(defined(defined(f.engine.active).workRecord).id, defined(record).id);
  assert.notEqual(message.turnId, other.turnId);
  assert.equal(
    defined(
      defined(defined(f.store.state.workTasks.find((item) => item.id === defined(record).id)).plan)
        .steps[0],
    ).status,
    'completed',
  );
  await f.finish();
});

test('stale queued task identity is rejected before a new turn and cannot fall back to ordinary chat', async (t) => {
  const f = fixture(t),
    record = f.makeRecord(),
    other = f.store.add({ role: 'user', text: 'Other', status: 'queued' });
  f.engine.enqueue(other);
  await tick();
  const message = f.message(defined(record));
  f.engine.enqueue(message, { interactive: true });
  f.store.state.workTasks[0] = { ...defined(f.store.state.workTasks[0]), turnId: 'changed' };
  await f.finish();
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(message.status, 'failed');
  assert.equal(message.pauseReason, 'work-reply-unavailable');
  assert.equal(f.engine.active, null);
});

test('task reply rejects mismatched conversation, turn and unknown submission before enqueue', (t) => {
  const f = fixture(t),
    record = f.makeRecord(),
    target = f.target(record),
    before = f.worker.calls.length;
  for (const value of [
    null,
    {},
    { ...target, turnId: 'other' },
    { ...target, conversationId: 'other' },
    { ...target, extra: true },
  ])
    assert.throws(
      () => workReplyRecord(f.engine, value),
      (error) => observedRecord(error).status === 409,
    );
  for (const patch of [
    { status: 'unknown' },
    { submission: 'unknown' },
    { continuation: { invalid: true } },
    { continuation: { dispatch: { phase: 'submitting' } } },
  ]) {
    const saved = defined(f.store.state.workTasks[0]);
    f.store.state.workTasks[0] = Object.assign({ ...saved }, patch);
    assert.throws(
      () => workReplyRecord(f.engine, target),
      (error) => observedRecord(error).status === 409,
    );
    f.store.state.workTasks[0] = saved;
  }
  assert.equal(f.worker.calls.length, before);
  assert.deepEqual(workReplyInput(target), target);
  assert.equal(f.engine.queue.length, 0);
});

test('only an explicit new human reply reopens reliable final work in the same workId and preserves completed steps', async (t) => {
  for (const status of ['review', 'completed', 'cancelled', 'failed'] as const)
    await t.test(status, async (t) => {
      const f = fixture(t);
      let record = f.makeRecord();
      record = defined(
        f.store.updateRegisteredWork(defined(record).turnId, {
          status,
          plan: { steps: plan().map((step) => ({ ...step, status: 'completed' })) },
          executionEnded: true,
          at: Date.now() - 10000,
        }),
      );
      const target = f.target(record);
      assert.equal(workReplyRecord(f.engine, target).active, null);
      assert.equal(f.worker.calls.length, 0, 'selecting a target never starts execution');
      const message = f.message(record, 'Please add the newly requested comparison');
      f.engine.enqueue(message, { interactive: true });
      await tick();
      assert.equal(f.store.state.workTasks.length, 1);
      assert.equal(defined(defined(f.engine.active).workRecord).id, defined(record).id);
      assert.equal(defined(defined(f.engine.active).workRecord).status, 'running');
      assert.equal(message.workId, defined(record).id);
      assert.equal(message.turnId, 'new-1');
      assert.ok(
        defined(defined(defined(f.engine.active).workRecord).plan).steps.every(
          (step) => step.status === 'completed',
        ),
      );
      const started = f.worker.calls.filter((call) => call.method === 'turn/start');
      assert.equal(started.length, 1);
      assert.match(
        rpcText(defined(defined(defined(started[0]).params.input)[0])),
        /only this NEW human message authorizes reopening/,
      );
      assert.match(
        rpcText(defined(defined(defined(started[0]).params.input)[0])),
        /newly requested comparison/,
      );
      assert.match(
        rpcText(defined(defined(defined(started[0]).params.input)[0])),
        /reference data, not new authorization/,
      );
      await f.finish();
    });
});

test('an ordinary new task cannot revive an ended record merely by referencing its workId in task_plan', async (t) => {
  const f = fixture(t);
  let record = f.makeRecord();
  record = defined(
    f.store.updateRegisteredWork(defined(record).turnId, {
      status: 'review',
      plan: { steps: plan().map((step) => ({ ...step, status: 'completed' })) },
      executionEnded: true,
      at: Date.now() - 10000,
    }),
  );
  const ordinary = f.store.add({ role: 'user', text: 'A different instruction', status: 'queued' });
  f.engine.enqueue(ordinary, { interactive: true });
  await tick();
  const before = structuredClone(
    f.store.state.workTasks.find((item) => item.id === defined(record).id),
  );
  await assert.rejects(
    f.engine.tool('task_plan', {
      workId: defined(record).id,
      title: defined(record).title,
      steps: plan(),
    }),
    (error) => observedRecord(error).code === 'work_reply_required',
  );
  assert.deepEqual(
    f.store.state.workTasks.find((item) => item.id === defined(record).id),
    before,
  );
  await f.finish();
});

test('a lost targeted turn acknowledgement becomes unknown and never automatically resubmits its human answer', async (t) => {
  const f = fixture(t),
    record = f.makeRecord(),
    request = f.worker.request;
  f.worker.request = async (method: string, params: RpcParams = {}) => {
    if (method === 'turn/start') {
      f.worker.calls.push({ method, params });
      throw Error('ack lost');
    }
    return request(method, params);
  };
  const message = f.message(defined(record));
  f.engine.enqueue(message, { interactive: true });
  await tick();
  assert.equal(message.submission, 'unknown');
  assert.equal(message.status, 'paused');
  assert.equal(defined(f.store.state.workTasks[0]).status, 'unknown');
  assert.equal(
    defined(defined(defined(f.store.state.workTasks[0]).continuation).dispatch).phase,
    'unknown',
  );
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.throws(
    () => f.engine.enqueue(message, { interactive: true }),
    (error) => observedRecord(error).status === 409,
  );
  const restarted = new Store(f.dir);
  assert.deepEqual(
    defined(restarted.state.messages.find((item) => item.id === message.id)).workReply,
    message.workReply,
  );
  assert.equal(defined(restarted.state.workTasks[0]).status, 'unknown');
});

test('a failed task preflight keeps its new input unsubmitted and the original work paused', async (t) => {
  const f = fixture(t),
    record = f.makeRecord(),
    request = f.worker.request;
  f.worker.request = async (method: string, params: RpcParams = {}) =>
    method === 'thread/read'
      ? { thread: { id: 'thread', status: { type: 'busy' }, turns: f.turns } }
      : request(method, params);
  const message = f.message(defined(record));
  f.engine.enqueue(message, { interactive: true });
  await tick();
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.equal(message.submission, 'preparing');
  assert.equal(message.status, 'failed');
  assert.equal(defined(f.store.state.workTasks[0]).status, 'paused');
  assert.equal(
    defined(defined(defined(f.store.state.workTasks[0]).plan).steps[0]).status,
    'completed',
  );
});

test('live native call work accepts only the exact targeted turn without appending generic realtime text', async (t) => {
  const { store, worker, engine } = fixture(t);
  store.state.conversationId = 'conversation';
  const record = store.registerWork({
    turnId: 'native-turn',
    title: 'Targeted human reply',
    plan: { steps: plan() },
  });
  const message = store.add({
    id: 'answer',
    role: 'user',
    text: 'Blue',
    workReply: { workId: record.id, turnId: 'native-turn', conversationId: 'conversation' },
  });
  const turn = nativeTurnFixture({
    turnId: 'native-turn',
    done: false,
    explicitMessageIds: [],
    pendingSubmissions: 0,
    workRecord: record,
    planWaitingForUser: true,
  });
  engine.input = () => [{ type: 'text', text: 'Exact human reply' }];
  const voice = new NativeRealtimeVoice({ worker, engine });
  voice.session = nativeSessionFixture({
    threadId: 'thread',
    status: 'connected',
    turns: new Map([[turn.turnId, turn]]),
    eventChain: Promise.resolve(),
    messageChain: Promise.resolve(),
    handoffs: new Map(),
  });
  voice.change = () => {};
  voice.finishTurn = async () => {};
  voice.finishBackground = () => {};
  const result = await voice.answerBackground(message, {
    interactive: true,
    expectedTurnId: turn.turnId,
    targeted: true,
  });
  assert.equal(observedRecord(result).turnId, turn.turnId);
  assert.equal(message.submission, 'confirmed');
  assert.equal(turn.planWaitingForUser, false);
  assert.deepEqual(
    worker.calls.map((call) => call.method),
    ['turn/steer'],
  );
  assert.equal(defined(worker.calls[0]).params.expectedTurnId, 'native-turn');
});

test('scheduled priorities reorder only scheduled queue slots and retain the explicit task reply owner', async (t) => {
  const f = fixture(t),
    record = f.makeRecord(),
    other = f.store.add({ role: 'user', text: 'Active human request', status: 'queued' });
  f.engine.enqueue(other);
  await tick();
  const low = f.store.add({
      role: 'user',
      text: 'Low priority schedule',
      status: 'queued',
      scheduled: true,
      progressPriority: 'low',
    }),
    high = f.store.add({
      role: 'user',
      text: 'High priority schedule',
      status: 'queued',
      scheduled: true,
      progressPriority: 'high',
    }),
    reply = f.message(record);
  f.engine.enqueue(low);
  f.engine.enqueue(reply, { interactive: true });
  f.engine.enqueue(high);
  assert.deepEqual(f.engine.queue, [high, reply, low]);
  assert.equal(defined(f.engine.active).messageId, other.id);
  await f.finish();
  assert.equal(defined(f.engine.active).messageId, high.id);
  await f.finish();
  assert.equal(defined(f.engine.active).messageId, reply.id);
  assert.equal(defined(defined(f.engine.active).workRecord).id, defined(record).id);
  await f.finish();
  assert.equal(defined(f.engine.active).messageId, low.id);
  await f.finish();
});

test('a queued task answer wakes after a pending shared reference settles without requiring another chat message', async (t) => {
  const f = fixture(t),
    record = f.makeRecord(),
    message = f.message(defined(record));
  f.engine.referencePending = 1;
  f.engine.enqueue(message, { interactive: true });
  await tick();
  assert.equal(f.engine.active, null);
  assert.equal(message.submission, undefined);
  f.engine.referencePending = 0;
  f.engine.wakeScheduledQueue();
  await tick();
  assert.equal(message.submission, 'confirmed');
  assert.equal(defined(defined(currentActive(f.engine)).workRecord).id, defined(record).id);
  await f.finish();
});
