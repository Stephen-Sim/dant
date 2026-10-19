import { VoiceFixture } from '../support/protocol-fixtures.mts';
import { unexpectedFixtureOperation } from '../support/service-fixtures.mts';
import { NativeVoiceFixture } from '../support/native-service-fixtures.mts';
import { TracingWorkerFixture } from '../support/worker-fixtures.mts';
import {
  activeTaskFixture,
  engineCallFixture,
  nativeSessionFixture,
  nativeTurnFixture,
  observedRecord,
  listeningPort,
} from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import type { TaskStatusValue } from '../../src/contracts/contracts.ts';
import type {
  ChatMessage,
  ConversationStoreState,
  ChatCompletion,
} from '../../src/conversation/types.ts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { createWorkerApp } from '../../src/app/server.mts';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
const status = (expected: number) => (error: unknown) => observedRecord(error).status === expected;
const tick = () => new Promise((resolve) => setImmediate(resolve));
class Worker extends TracingWorkerFixture {
  constructor() {
    super();
    this.status = 'offline';
    this.calls = [];
  }
  async request(method: string, params: RpcParams = {}): Promise<RpcResult> {
    this.calls.push({ method, params });
    return method === 'thread/start'
      ? { thread: { id: 'thread' } }
      : method === 'turn/start'
        ? { turn: { id: 'new-turn' } }
        : {};
  }
  disconnect() {
    this.status = 'offline';
    this.emit('status');
  }
}
function setup(t: NodeTestContext) {
  const dir = fs.mkdtempSync(path.join(root, 'progress-dismiss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    worker = new Worker(),
    engine = new Engine(store, worker);
  store.state.threadId = 'retained-thread';
  store.state.threadRuntime = engine.runtimeId;
  store.state.threadConversationId = store.state.conversationId;
  store.state.voiceHistory = [
    { role: 'user', text: 'Retained spoken context', status: 'submitted' },
  ];
  store.save();
  return { dir, store, worker, engine };
}
function withoutDismissal(state: ConversationStoreState) {
  const copy = structuredClone(state);
  for (const entry of [...copy.messages, ...copy.completions, ...copy.workTasks])
    delete entry.progressDismissedAt;
  return copy;
}
function voiceResult(
  store: Store,
  {
    turnId = 'voice-turn',
    taskId,
    work = { source: 'voice', status: 'review' },
  }: { turnId?: string; taskId?: string; work?: NonNullable<ChatCompletion['work']> } = {},
) {
  const answer = store.add({
    role: 'assistant',
    text: 'Task result',
    status: 'completed',
    source: { type: 'voice-call' },
    read: false,
  });
  return store.addCompletion({ turnId, taskId, messageIds: [answer.id], work });
}
function registered(store: Store, turnId: string, status: TaskStatusValue = 'completed') {
  const record = store.registerWork({
    turnId,
    title: 'Registered task',
    source: 'voice',
    plan: { steps: [{ step: 'Verified result', status: 'completed' }] },
  });
  store.updateRegisteredWork(turnId, { status, executionEnded: true });
  return defined(store.state.workTasks.find((entry) => entry.id === record.id));
}

test('display priorities change active and queued metadata without reordering or touching execution, and survive continuation and restart', (t) => {
  const { dir, store, engine, worker } = setup(t),
    active = store.add({ role: 'user', text: 'Active', status: 'running', turnId: 'active' }),
    queued = store.add({ role: 'user', text: 'Queued', status: 'queued' }),
    record = registered(store, 'registered', 'continuing'),
    receipt = voiceResult(store, { turnId: 'unregistered-voice' });
  engine.active = activeTaskFixture({
    messageId: active.id,
    messageIds: [active.id],
    turnId: defined(active.turnId),
  });
  engine.queue = [queued];
  const owner = engine.active,
    queue = engine.queue,
    before = structuredClone(store.state);
  for (const [entry, kind, priority] of [
    [active, 'task', 'low'],
    [queued, 'task', 'high'],
    [record, 'work', 'high'],
    [receipt, 'completion', 'normal'],
  ] as const)
    assert.deepEqual(engine.setProgressPriority(defined(entry).id, kind, priority), {
      ok: true,
      progressPriority: priority,
    });
  const copy = structuredClone(store.state);
  for (const entries of [copy.messages, copy.workTasks, copy.completions])
    for (const entry of entries) delete entry.progressPriority;
  assert.deepEqual(copy, before);
  assert.equal(engine.active, owner);
  assert.equal(engine.queue, queue);
  assert.deepEqual(engine.queue, [queued]);
  assert.equal(worker.calls.length, 0);
  const next = store.registerWork({
    workId: record.id,
    turnId: 'continuation',
    title: 'Continuing the same task',
    source: 'voice',
    plan: { steps: [{ step: 'Next action', status: 'inProgress' }] },
  });
  assert.equal(next.progressPriority, 'high');
  const restored = new Store(dir);
  assert.equal(
    defined(restored.state.messages.find((entry) => entry.id === active.id)).progressPriority,
    'low',
  );
  assert.equal(
    defined(restored.state.messages.find((entry) => entry.id === queued.id)).progressPriority,
    'high',
  );
  assert.equal(defined(restored.state.workTasks[0]).progressPriority, 'high');
  assert.equal(defined(restored.state.completions[0]).progressPriority, 'normal');
  engine.active = null;
  engine.queue = [];
});

test('priority validation and failed persistence leave all progress metadata unchanged', (t) => {
  const { store, engine } = setup(t),
    task = store.add({ role: 'user', text: 'Task', status: 'draft' }),
    assistant = store.add({ role: 'assistant', text: 'Result', status: 'completed' }),
    before = structuredClone(store.state);
  for (const priority of [undefined, null, 'urgent', 1, {}, []])
    assert.throws(() => engine.setProgressPriority(task.id, 'task', priority), status(400));
  assert.throws(() => engine.setProgressPriority(task.id, 'constructor', 'high'), status(400));
  assert.throws(() => engine.setProgressPriority('missing', 'task', 'high'), status(404));
  assert.throws(() => engine.setProgressPriority(assistant.id, 'task', 'high'), status(409));
  assert.deepEqual(store.state, before);
  const save = store.save;
  store.save = () => {
    throw Error('Disk unavailable');
  };
  assert.throws(() => engine.setProgressPriority(task.id, 'task', 'high'), /Disk unavailable/);
  assert.deepEqual(store.state, before);
  task.progressPriority = 'low';
  assert.throws(() => engine.setProgressPriority(task.id, 'task', 'high'), /Disk unavailable/);
  assert.equal(task.progressPriority, 'low');
  store.save = save;
});

test('initial plans inherit an existing task priority and malformed persisted priorities use normal', (t) => {
  const { dir, store, engine } = setup(t),
    task = store.add({ role: 'user', text: 'New task', status: 'queued' });
  engine.setProgressPriority(task.id, 'task', 'high');
  const record = store.registerWork({
    messageId: task.id,
    turnId: 'first-plan',
    title: 'Real plan',
    plan: { steps: [{ step: 'Do the work', status: 'inProgress' }] },
  });
  assert.equal(record.progressPriority, 'high');
  engine.active = activeTaskFixture({
    messageId: task.id,
    turnId: record.turnId,
    workRecord: record,
  });
  record.status = 'continuing';
  assert.deepEqual(engine.setProgressPriority(record.id, 'work', 'low'), {
    ok: true,
    progressPriority: 'low',
  });
  assert.equal(
    record.status,
    'continuing',
    'display metadata does not reconcile execution lifecycle',
  );
  engine.active = null;
  const receipt = voiceResult(store);
  Object.assign(task, { progressPriority: 'invalid' });
  Object.assign(defined(receipt), { progressPriority: { value: 'high' } });
  Object.assign(record, { progressPriority: 'invalid' });
  store.save();
  const restored = new Store(dir);
  assert.equal(
    defined(restored.state.messages.find((message) => message.id === task.id)).progressPriority,
    'normal',
  );
  assert.equal(defined(restored.state.completions[0]).progressPriority, 'normal');
  assert.equal(defined(restored.state.workTasks[0]).progressPriority, 'normal');
});

test('unfinished dismissal requires exact confirmation and rechecks current completion and owner state', (t) => {
  const { store, engine } = setup(t),
    task = store.add({ role: 'user', text: 'Task', status: 'completed' }),
    work = registered(store, 'finished'),
    receipt = voiceResult(store, { turnId: 'finished' });
  assert.deepEqual(engine.dismissProgress(task.id, 'task'), { ok: true });
  assert.deepEqual(engine.dismissProgress(work.id, 'work'), { ok: true });
  assert.deepEqual(engine.dismissProgress(defined(receipt).id, 'completion'), { ok: true });
  for (const confirmUnfinished of [undefined, false, 'true', 1]) {
    task.status = 'paused';
    assert.throws(
      () => engine.dismissProgress(task.id, 'task', { confirmUnfinished }),
      (error) =>
        observedRecord(error).status === 409 && observedRecord(error).confirmationRequired === true,
    );
  }
  task.status = 'completed';
  task.submission = 'unknown';
  assert.throws(
    () => engine.dismissProgress(task.id, 'task'),
    (error) => observedRecord(error).confirmationRequired === true,
  );
  assert.deepEqual(engine.dismissProgress(task.id, 'task', { confirmUnfinished: true }), {
    ok: true,
  });
  engine.queue = [task];
  assert.throws(
    () => engine.dismissProgress(task.id, 'task', { confirmUnfinished: true }),
    (error) => observedRecord(error).status === 409 && !observedRecord(error).confirmationRequired,
  );
  engine.queue = [];
  const review = voiceResult(store, { turnId: 'review-only' });
  assert.throws(
    () => engine.dismissProgress(defined(review).id, 'completion'),
    (error) => observedRecord(error).confirmationRequired === true,
  );
  assert.deepEqual(
    engine.dismissProgress(defined(review).id, 'completion', { confirmUnfinished: true }),
    {
      ok: true,
    },
  );
});

test('clear completed atomically hides only accepted task/work/linked receipts and preserves unrelated state and unread results', (t) => {
  const { dir, store, engine, worker } = setup(t),
    task = store.add({ role: 'user', text: 'Accepted', status: 'completed', turnId: 'accepted' }),
    linked = voiceResult(store, { turnId: 'accepted', taskId: task.id }),
    work = registered(store, 'registered-complete'),
    receipt = voiceResult(store, { turnId: work.turnId }),
    review = voiceResult(store, { turnId: 'review-only' }),
    ongoing = registered(store, 'ongoing', 'continuing');
  store.add({ role: 'user', text: 'Paused', status: 'paused' });
  store.state.schedules = [
    { id: 'schedule', text: 'Keep scheduled work', at: 1000, status: 'pending' },
  ];
  store.scheduleDatabase.replace(
    store.scheduleDatabase.snapshot().revision,
    store.state.schedules,
    [],
  );
  store.refreshSchedules();
  store.state.memory = 'Persistent memory';
  store.save();
  const before = withoutDismissal(store.state),
    save = store.save.bind(store);
  let writes = 0;
  store.save = () => {
    writes++;
    save();
  };
  assert.deepEqual(engine.clearCompletedProgress(), { ok: true, cleared: 4 });
  assert.equal(writes, 1);
  for (const entry of [task, linked, work, receipt])
    assert.ok(defined(defined(entry).progressDismissedAt) > 0);
  assert.equal(defined(review).progressDismissedAt, undefined);
  assert.equal(ongoing.progressDismissedAt, undefined);
  assert.equal(defined(linked).readAt, null);
  assert.equal(
    defined(store.state.messages.find((entry) => entry.id === defined(linked).messageIds[0])).read,
    false,
  );
  assert.deepEqual(withoutDismissal(store.state), before);
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(engine.clearCompletedProgress(), { ok: true, cleared: 0 });
  assert.equal(writes, 1);
  assert.deepEqual(withoutDismissal(new Store(dir).state), JSON.parse(JSON.stringify(before)));
});

test('clear completed skips stale completed entries with active, queued, native or unresolved delivery ownership', (t) => {
  const { store, engine } = setup(t),
    active = store.add({
      role: 'user',
      text: 'Active alias',
      status: 'completed',
      turnId: 'owned',
    }),
    queue = store.add({ role: 'user', text: 'Queue alias', status: 'completed', turnId: 'queued' }),
    unknown = store.add({
      role: 'user',
      text: 'Unconfirmed',
      status: 'completed',
      submission: 'unknown',
      turnId: 'uncertain',
    }),
    submitting = store.add({
      role: 'user',
      text: 'Submitting',
      status: 'completed',
      submission: 'submitting',
    }),
    unknownOutcome = store.add({
      role: 'user',
      text: 'Unknown outcome',
      status: 'completed',
      unknownOutcome: true,
    }),
    reference = store.add({
      role: 'user',
      text: 'Reference pending',
      status: 'completed',
      turnId: 'reference',
    }),
    native = registered(store, 'native'),
    receipt = voiceResult(store, { turnId: 'uncertain', taskId: unknown.id }),
    historical = registered(store, 'historical');
  const pending = store.add({
      role: 'user',
      text: 'Pending follow-up alias',
      status: 'review',
      turnId: 'followup-turn',
    }),
    followup = store.add({
      role: 'user',
      text: 'Accepted same-turn alias',
      status: 'completed',
      turnId: 'followup-turn',
    });
  engine.pendingFollowups.set(pending.id, Promise.resolve());
  engine.active = activeTaskFixture({
    messageId: active.id,
    messageIds: [active.id],
    turnId: 'owned',
  });
  engine.queue = [queue];
  engine.callReferences.set(reference.id, {
    message: reference,
    callId: 'call',
    promise: Promise.resolve({}),
  });
  engine.nativeVoice = Object.assign(new NativeVoiceFixture(), {
    session: nativeSessionFixture({
      turns: new Map([
        ['native', nativeTurnFixture({ turnId: 'native', done: true, resultSaved: false })],
      ]),
    }),
  });
  const before = withoutDismissal(store.state);
  assert.deepEqual(engine.clearCompletedProgress(), { ok: true, cleared: 1 });
  assert.ok(historical.progressDismissedAt);
  for (const entry of [
    active,
    queue,
    unknown,
    submitting,
    unknownOutcome,
    reference,
    native,
    receipt,
    pending,
    followup,
  ])
    assert.equal(defined(entry).progressDismissedAt, undefined);
  assert.deepEqual(withoutDismissal(store.state), before);
  assert.equal(defined(engine.active).turnId, 'owned');
  assert.equal(engine.queue[0], queue);
  engine.active = null;
  engine.queue = [];
  engine.callReferences.clear();
  engine.pendingFollowups.clear();
});

test('bulk clearing a large legacy task history makes a bounded linear number of message reads', (t) => {
  const { store, engine } = setup(t),
    count = 3000,
    messages: ChatMessage[] = Array.from({ length: count }, (_, index) => ({
      time: index + 1,
      read: false,
      reactions: [],
      id: 'legacy-' + index,
      role: 'user',
      status: 'completed',
      text: 'Retained chat ' + index,
    }));
  let reads = 0;
  store.state.messages = new Proxy(messages, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(engine.clearCompletedProgress(), { ok: true, cleared: count });
  assert.ok(reads < count * 12, 'bulk clear must not scan the full message list once per task');
  assert.ok(messages.every((message) => defined(message.progressDismissedAt) > 0));
  assert.equal(defined(messages[0]).text, 'Retained chat 0');
});

test('completion clearing uses the exact current registered turn and rolls every marker back on one persistence failure', (t) => {
  const { store, engine } = setup(t),
    record = registered(store, 'old'),
    historical = store.add({
      role: 'user',
      text: 'Accepted historical step',
      status: 'completed',
      turnId: 'old',
    }),
    receipt = voiceResult(store, { turnId: 'old', taskId: historical.id });
  record.turnIds = ['old', 'current'];
  record.turnId = 'current';
  record.status = 'completed';
  assert.equal(store.isProgressCompleted(defined(receipt), 'completion'), false);
  const task = store.add({ role: 'user', text: 'Accepted task', status: 'completed' }),
    before = structuredClone(store.state),
    save = store.save;
  Object.assign(record, { progressDismissedAt: 'invalid' });
  const original = structuredClone(store.state);
  store.save = () => {
    throw Error('Disk full');
  };
  assert.throws(() => engine.clearCompletedProgress(), /Disk full/);
  assert.deepEqual(store.state, original);
  assert.equal(task.progressDismissedAt, undefined);
  store.save = save;
  delete record.progressDismissedAt;
  assert.deepEqual(store.state, before);
});

test('dismissing inactive task history changes only persistent progress metadata, including after restart', (t) => {
  const { dir, store, engine, worker } = setup(t);
  for (const taskState of ['paused', 'failed', 'review', 'completed'] as const) {
    const task = store.add({
      role: 'user',
      text: 'Keep this conversation',
      status: taskState,
      turnId: 'old-' + taskState,
      acceptedAt: taskState === 'completed' ? 123 : null,
      read: false,
    });
    const before = withoutDismissal(store.state);
    assert.deepEqual(engine.dismissProgress(task.id, 'task', { confirmUnfinished: true }), {
      ok: true,
    });
    assert.ok(defined(task.progressDismissedAt) > 0);
    const at = task.progressDismissedAt;
    assert.deepEqual(engine.dismissProgress(task.id, 'task', { confirmUnfinished: true }), {
      ok: true,
    });
    assert.equal(task.progressDismissedAt, at);
    assert.deepEqual(withoutDismissal(store.state), before);
  }
  const reopened = new Store(dir);
  assert.ok(reopened.state.messages.every((message) => defined(message.progressDismissedAt) > 0));
  assert.deepEqual(withoutDismissal(reopened.state), withoutDismissal(store.state));
  assert.equal(worker.calls.length, 0);
  assert.equal(engine.active, null);
  assert.equal(engine.queue.length, 0);
});

test('only final voice result receipts can be dismissed, without marking results read or accepting work', (t) => {
  const { dir, store, engine } = setup(t),
    result = voiceResult(store),
    before = withoutDismissal(store.state);
  assert.deepEqual(
    engine.dismissProgress(defined(result).id, 'completion', { confirmUnfinished: true }),
    {
      ok: true,
    },
  );
  assert.deepEqual(withoutDismissal(store.state), before);
  assert.equal(defined(result).readAt, null);
  assert.equal(defined(defined(result).work).status, 'review');
  assert.equal(defined(store.state.messages[0]).read, false);
  assert.ok(defined(defined(new Store(dir).state.completions[0]).progressDismissedAt) > 0);
  for (const receipt of [
    store.addCompletion({ turnId: 'ordinary', messageIds: [defined(store.state.messages[0]).id] }),
    voiceResult(store, { turnId: 'turn:input:1' }),
    voiceResult(store, { turnId: 'turn:credential:1' }),
    store.addCompletion({
      turnId: 'gone-result',
      messageIds: ['missing'],
      work: { source: 'voice', status: 'failed' },
    }),
  ])
    assert.throws(() => engine.dismissProgress(defined(receipt).id, 'completion'), status(409));
  const malformed = voiceResult(store, { turnId: 'malformed' });
  Object.assign(defined(defined(malformed).work), { status: 'running' });
  assert.throws(() => engine.dismissProgress(defined(malformed).id, 'completion'), status(409));
});

test('invalid, missing, non-user and unfinished entries cannot be dismissed', (t) => {
  const { store, engine } = setup(t);
  for (const id of [undefined, '', 'x'.repeat(129)])
    assert.throws(() => engine.dismissProgress(id, 'task'), status(400));
  for (const kind of [undefined, 'message', 'constructor', null])
    assert.throws(() => engine.dismissProgress('id', kind), status(400));
  for (const kind of ['task', 'completion'])
    assert.throws(() => engine.dismissProgress('missing', kind), status(404));
  for (const taskState of ['draft', 'queued', 'running', 'waiting_user', 'pausing'] as const) {
    const task = store.add({ role: 'user', text: 'Unfinished work', status: taskState });
    assert.throws(() => engine.dismissProgress(task.id, 'task'), status(409));
    assert.equal(task.progressDismissedAt, undefined);
  }
  const assistant = store.add({ role: 'assistant', text: 'Keep', status: 'completed' });
  assert.throws(() => engine.dismissProgress(assistant.id, 'task'), status(409));
});

test('active task aliases, steered turns, pending output persistence and queue ownership remain visible', (t) => {
  const { store, engine, worker } = setup(t),
    original = store.add({
      role: 'user',
      text: 'Original task',
      status: 'review',
      turnId: 'owned',
    }),
    steered = store.add({ role: 'user', text: 'Steered task', status: 'paused', turnId: 'owned' }),
    pending = store.add({
      role: 'user',
      text: 'Pending steer',
      status: 'paused',
      parentTaskId: original.id,
    }),
    old = store.add({
      role: 'user',
      text: 'Earlier unrelated task',
      status: 'review',
      turnId: 'old',
    }),
    result = voiceResult(store, { turnId: 'owned', taskId: original.id });
  engine.active = activeTaskFixture({
    messageId: original.id,
    messageIds: [original.id],
    turnId: 'owned',
    finishing: Promise.resolve(),
  });
  for (const task of [original, steered, pending])
    assert.throws(() => engine.dismissProgress(task.id, 'task'), status(409));
  assert.throws(() => engine.dismissProgress(defined(result).id, 'completion'), status(409));
  assert.deepEqual(engine.dismissProgress(old.id, 'task', { confirmUnfinished: true }), {
    ok: true,
  });
  assert.equal(defined(engine.active).turnId, 'owned');
  assert.equal(worker.calls.length, 0);
  engine.active = null;
  engine.queue = [original];
  assert.throws(() => engine.dismissProgress(original.id, 'task'), status(409));
  assert.throws(() => engine.dismissProgress(steered.id, 'task'), status(409));
  engine.queue = [];
  assert.deepEqual(engine.dismissProgress(original.id, 'task', { confirmUnfinished: true }), {
    ok: true,
  });
});

test('native owned turns, aliases and unresolved same-call submissions cannot be hidden', (t) => {
  const { store, engine } = setup(t),
    alias = store.add({
      role: 'user',
      text: 'Steered native task',
      status: 'paused',
      turnId: 'native-turn',
    }),
    explicit = store.add({ role: 'user', text: 'Accepted native input', status: 'review' }),
    unknown = store.add({
      role: 'user',
      text: 'Unconfirmed native reply',
      status: 'paused',
      submission: 'unknown',
      voiceCallId: 'call',
    }),
    result = voiceResult(store, { turnId: 'native-turn' });
  const turn = nativeTurnFixture({
    turnId: 'native-turn',
    messageId: null,
    explicitMessageIds: [explicit.id],
    done: false,
    resultSaved: false,
  });
  const nativeOwner = Object.assign(new NativeVoiceFixture(), {
    active: {
      turnId: 'native-turn',
      messageId: null,
      source: 'voice',
      status: 'running',
    } as NonNullable<import('../../src/work/engine.mts').EngineNativeVoice['active']> | null,
    session: nativeSessionFixture({
      id: 'call',
      unknown: true,
      turns: new Map([['native-turn', turn]]),
    }),
  });
  engine.nativeVoice = nativeOwner;
  for (const task of [alias, explicit, unknown])
    assert.throws(() => engine.dismissProgress(task.id, 'task'), status(409));
  assert.throws(() => engine.dismissProgress(defined(result).id, 'completion'), status(409));
  nativeOwner.active = null;
  defined(defined(engine.nativeVoice).session).unknown = false;
  turn.done = true;
  assert.throws(() => engine.dismissProgress(defined(result).id, 'completion'), status(409));
  turn.resultSaved = true;
  turn.pendingSubmissions = 1;
  assert.throws(() => engine.dismissProgress(defined(result).id, 'completion'), status(409));
  turn.pendingSubmissions = 0;
  assert.deepEqual(engine.dismissProgress(alias.id, 'task', { confirmUnfinished: true }), {
    ok: true,
  });
  assert.deepEqual(
    engine.dismissProgress(defined(result).id, 'completion', { confirmUnfinished: true }),
    {
      ok: true,
    },
  );
});

test('dismissal persistence failure rolls back only its marker and does not mutate the task', (t) => {
  const { store, engine } = setup(t),
    task = store.add({ role: 'user', text: 'Keep task', status: 'review' }),
    before = structuredClone(store.state),
    save = store.save;
  store.save = () => {
    throw Error('Storage unavailable');
  };
  assert.throws(
    () => engine.dismissProgress(task.id, 'task', { confirmUnfinished: true }),
    /Storage unavailable/,
  );
  assert.deepEqual(store.state, before);
  Object.assign(task, { progressDismissedAt: 'invalid' });
  assert.throws(
    () => engine.dismissProgress(task.id, 'task', { confirmUnfinished: true }),
    /Storage unavailable/,
  );
  assert.equal(task.progressDismissedAt, 'invalid');
  store.save = save;
});

test('explicitly resuming dismissed work clears its marker and surfaces the actual next run', async (t) => {
  const { dir, store, engine, worker } = setup(t),
    task = store.add({ role: 'user', text: 'Resume me', status: 'paused', submission: 'unknown' });
  engine.dismissProgress(task.id, 'task', { confirmUnfinished: true });
  const dismissed = task.progressDismissedAt;
  assert.throws(() => engine.resumePaused([task.id]), /explicitly confirm/);
  assert.equal(task.progressDismissedAt, dismissed);
  assert.equal(engine.queue.length, 0);
  engine.resumePaused([task.id], { confirmUnknown: true });
  assert.equal(task.progressDismissedAt, null);
  assert.equal(task.status, 'queued');
  assert.equal(defined(engine.queue[0]).id, task.id);
  assert.equal(worker.calls.length, 0);
  const reopened = new Store(dir);
  assert.equal(defined(reopened.state.messages[0]).progressDismissedAt, null);
  assert.equal(defined(reopened.state.messages[0]).status, 'paused');
  worker.status = 'online';
  worker.emit('status');
  await tick();
  assert.equal(defined(engine.active).messageId, task.id);
  assert.equal(task.progressDismissedAt, null);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  await engine.handle({
    method: 'turn/completed',
    params: { threadId: 'retained-thread', turn: { id: 'new-turn', status: 'completed' } },
  });
  assert.equal(task.status, 'review');
  assert.equal(task.progressDismissedAt, null);
  assert.equal(engine.active, null);
});

test('enqueue clears history dismissal only once the task may enter accepted work paths', (t) => {
  const { store, engine } = setup(t),
    task = store.add({ role: 'user', text: 'Run again', status: 'paused' });
  engine.dismissProgress(task.id, 'task', { confirmUnfinished: true });
  const dismissed = task.progressDismissedAt;
  engine.takeover = true;
  engine.enqueue(task);
  assert.equal(task.progressDismissedAt, dismissed);
  engine.takeover = false;
  engine.call = engineCallFixture({ provider: 'subscription' });
  engine.enqueue(task);
  assert.equal(task.progressDismissedAt, dismissed);
  engine.call = null;
  let received;
  engine.nativeVoice = Object.assign(new NativeVoiceFixture(), {
    acceptsChatInput: true,
    answerBackground: async (message: import('../../src/work/engine-types.ts').WorkMessage) => {
      received = message;
    },
  });
  engine.enqueue(task, { interactive: true });
  assert.equal(received, task);
  assert.equal(task.progressDismissedAt, null);
  assert.equal(engine.queue.length, 0);
});

async function apiSetup(t: NodeTestContext) {
  const dir = fs.mkdtempSync(path.join(root, 'progress-dismiss-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  class Provider extends VoiceFixture {
    state = { available: true };
    message = unexpectedFixtureOperation;
    close = async () => {};
  }
  class NativeProvider extends NativeVoiceFixture {
    async close() {}
  }
  const worker = new Worker(),
    nativeVoice = new NativeProvider(),
    voice = new Provider(),
    instance = createWorkerApp({
      dataDir: dir,
      workerFactory: () => worker,
      voiceFactory: () => voice,
      nativeVoiceFactory: () => nativeVoice,
    });
  t.after(async () => {
    instance.engine.active = null;
    nativeVoice.active = null;
    nativeVoice.progress = null;
    nativeVoice.session = null;
    await instance.close();
  });
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + listeningPort(instance.server),
    { token } = await fetch(base + '/api/session').then((response) => response.json());
  const request = (route: string, body: unknown = {}, authorized = true) =>
      fetch(base + '/api/tasks/' + route, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorized ? { 'X-Dant-Token': token } : {}),
        },
        body: JSON.stringify(body),
      }),
    post = (id: string, body: unknown, authorized = true) =>
      request(encodeURIComponent(id) + '/dismiss', body, authorized);
  return { instance, worker, nativeVoice, post, request };
}

test('authenticated dismiss API persists idempotent task and final voice history metadata only', async (t) => {
  const { instance, worker, post } = await apiSetup(t),
    { store, engine } = instance,
    task = store.add({ role: 'user', text: 'Keep chat', status: 'review' }),
    completion = voiceResult(store),
    before = withoutDismissal(store.state);
  let changes = 0;
  engine.on('change', () => changes++);
  assert.equal((await post(task.id, { kind: 'task' }, false)).status, 401);
  assert.equal(task.progressDismissedAt, undefined);
  for (const [id, kind] of [
    [task.id, 'task'],
    [defined(completion).id, 'completion'],
  ] as const) {
    const response = await post(id, { kind, confirmUnfinished: true });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(await (await post(id, { kind, confirmUnfinished: true })).json(), {
      ok: true,
    });
  }
  assert.equal(changes, 4);
  assert.deepEqual(withoutDismissal(store.state), before);
  assert.equal(worker.calls.length, 0);
  assert.equal(engine.active, null);
  assert.equal(engine.queue.length, 0);
});

test('dismiss API returns safe errors for invalid, missing, owned and persistence-failed requests', async (t) => {
  const { instance, post, nativeVoice } = await apiSetup(t),
    { store, engine } = instance,
    task = store.add({
      role: 'user',
      text: 'SYNTHETIC_PRIVATE_CONTENT',
      status: 'paused',
      turnId: 'active-turn',
    }),
    completion = voiceResult(store, { turnId: 'active-turn' });
  assert.equal((await post(task.id, {})).status, 400);
  assert.equal((await post('missing', { kind: 'task' })).status, 404);
  engine.queue = [task];
  assert.equal((await post(task.id, { kind: 'task' })).status, 409);
  engine.queue = [];
  nativeVoice.session = nativeSessionFixture({
    turns: new Map([
      ['active-turn', nativeTurnFixture({ turnId: 'active-turn', done: true, resultSaved: false })],
    ]),
  });
  assert.equal((await post(defined(completion).id, { kind: 'completion' })).status, 409);
  nativeVoice.session = null;
  const save = store.save;
  store.save = () => {
    throw Error('SYNTHETIC_SECRET_PATH');
  };
  const response = await post(task.id, { kind: 'task', confirmUnfinished: true }),
    body = await response.json();
  store.save = save;
  assert.equal(response.status, 409);
  assert.equal(JSON.stringify(body).includes('SYNTHETIC_'), false);
  assert.equal(task.progressDismissedAt, undefined);
  assert.equal(defined(completion).progressDismissedAt, undefined);
  assert.equal(task.status, 'paused');
});

test('dismiss API rejects stale turn and conversation ownership before hiding a newer saved result', async (t) => {
  const { instance, worker, post } = await apiSetup(t),
    { store, engine } = instance,
    previous = registered(store, 'previous-turn', 'review'),
    captured = {
      kind: 'work',
      confirmUnfinished: true,
      expectedTurnId: previous.turnId,
      expectedConversationId: store.state.conversationId,
    };
  store.registerWork({
    workId: previous.id,
    turnId: 'new-turn',
    title: 'New result waiting for review',
    source: 'voice',
    plan: { steps: [{ step: 'Verified a newer result', status: 'completed' }] },
  });
  store.updateRegisteredWork('new-turn', { status: 'review', executionEnded: true });
  const current = defined(store.state.workTasks.find((item) => item.id === previous.id)),
    before = structuredClone(store.state);
  for (const body of [
    captured,
    { ...captured, expectedTurnId: current.turnId, expectedConversationId: 'other-conversation' },
  ]) {
    const response = await post(current.id, body);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'Work progress could not be dismissed. Only inactive task history can be hidden.',
    });
    assert.deepEqual(store.state, before);
  }
  engine.active = activeTaskFixture({ turnId: current.turnId, workRecord: current });
  assert.equal(
    (await post(current.id, { ...captured, expectedTurnId: current.turnId })).status,
    409,
  );
  assert.deepEqual(store.state, before);
  engine.active = null;
  assert.equal(
    (await post(current.id, { ...captured, expectedTurnId: current.turnId })).status,
    200,
  );
  assert.ok(defined(current.progressDismissedAt) > 0);
  assert.deepEqual(withoutDismissal(store.state), withoutDismissal(before));
  assert.equal(worker.calls.length, 0);
  assert.equal(engine.queue.length, 0);
});

test('dismiss API validates optional identities, preserves null ownership and accepts legacy clients', async (t) => {
  const { instance, post } = await apiSetup(t),
    { store } = instance,
    task = store.add({ role: 'user', text: 'Legacy result', status: 'paused', turnId: null }),
    before = structuredClone(store.state);
  for (const invalid of [false, 0, '', {}, [], 'x'.repeat(257)]) {
    assert.equal(
      (
        await post(task.id, {
          kind: 'task',
          confirmUnfinished: true,
          expectedTurnId: invalid,
        })
      ).status,
      400,
    );
    assert.deepEqual(store.state, before);
  }
  for (const invalid of [null, false, 0, '', {}, [], 'x'.repeat(129)]) {
    assert.equal(
      (
        await post(task.id, {
          kind: 'task',
          confirmUnfinished: true,
          expectedConversationId: invalid,
        })
      ).status,
      400,
    );
    assert.deepEqual(store.state, before);
  }
  assert.equal(
    (
      await post(task.id, {
        kind: 'task',
        confirmUnfinished: true,
        expectedTurnId: 'not-the-null-turn',
      })
    ).status,
    409,
  );
  assert.deepEqual(store.state, before);
  assert.equal(
    (
      await post(task.id, {
        kind: 'task',
        confirmUnfinished: true,
        expectedTurnId: null,
      })
    ).status,
    200,
  );
  const omitted = store.add({ role: 'user', text: 'No recorded turn', status: 'paused' });
  assert.equal(
    (
      await post(omitted.id, {
        kind: 'task',
        confirmUnfinished: true,
        expectedTurnId: null,
      })
    ).status,
    409,
  );
  assert.equal(omitted.progressDismissedAt, undefined);
  assert.equal((await post(omitted.id, { kind: 'task', confirmUnfinished: true })).status, 200);
  assert.ok(defined(omitted.progressDismissedAt) > 0);
});

test('progress metadata APIs authenticate, validate priorities and require fresh unfinished confirmation', async (t) => {
  const { instance, request, post, worker } = await apiSetup(t),
    { store, engine } = instance,
    task = store.add({ role: 'user', text: 'Task', status: 'completed' }),
    draft = store.add({ role: 'user', text: 'New task', status: 'draft' });
  assert.equal(
    (await request(task.id + '/priority', { kind: 'task', priority: 'high' }, false)).status,
    401,
  );
  assert.equal((await request('clear-completed', {}, false)).status, 401);
  assert.equal(
    (await request(draft.id + '/priority', { kind: 'task', priority: 'high' })).status,
    200,
  );
  assert.equal(draft.progressPriority, 'high');
  assert.equal(
    (await request(task.id + '/priority', { kind: 'task', priority: 'urgent' })).status,
    400,
  );
  assert.equal((await request('missing/priority', { kind: 'task', priority: 'low' })).status, 404);
  assert.equal(
    (await request(task.id + '/priority', { kind: 'task', priority: 'low' })).status,
    200,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(store.file, 'utf8')).messages.find(
      (message: unknown) => observedRecord(message).id === task.id,
    ).progressPriority,
    'low',
  );
  task.status = 'review';
  const response = await post(task.id, { kind: 'task' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'Work progress could not be dismissed. Only inactive task history can be hidden.',
    confirmationRequired: true,
    code: 'confirmation_required',
  });
  assert.equal(task.progressDismissedAt, undefined);
  engine.queue = [task];
  assert.equal((await post(task.id, { kind: 'task', confirmUnfinished: true })).status, 409);
  engine.queue = [];
  assert.equal((await post(task.id, { kind: 'task', confirmUnfinished: true })).status, 200);
  assert.equal(task.status, 'review');
  assert.equal(worker.calls.length, 0);
});

test('clear-completed API uses authoritative current state rather than stale UI selection and persists atomically', async (t) => {
  const { instance, request } = await apiSetup(t),
    { store, engine } = instance,
    completed = store.add({ role: 'user', text: 'Accepted', status: 'completed' }),
    changed = store.add({ role: 'user', text: 'Stale completed row', status: 'completed' }),
    owned = store.add({ role: 'user', text: 'Now running', status: 'completed', turnId: 'owned' });
  changed.status = 'paused';
  engine.active = activeTaskFixture({
    messageId: owned.id,
    messageIds: [owned.id],
    turnId: 'owned',
  });
  const response = await request('clear-completed', { ids: [changed.id, owned.id] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, cleared: 1 });
  assert.ok(defined(completed.progressDismissedAt) > 0);
  assert.equal(changed.progressDismissedAt, undefined);
  assert.equal(owned.progressDismissedAt, undefined);
  assert.equal(defined(engine.active).turnId, 'owned');
  engine.active = null;
  const saved = fs.readFileSync(store.file),
    save = store.save;
  store.save = () => {
    throw Error('SYNTHETIC_PRIVATE_STORAGE');
  };
  const failure = await request('clear-completed');
  store.save = save;
  assert.equal(failure.status, 409);
  assert.equal(JSON.stringify(await failure.json()).includes('SYNTHETIC_'), false);
  assert.equal(owned.progressDismissedAt, undefined);
  assert.deepEqual(fs.readFileSync(store.file), saved);
});
