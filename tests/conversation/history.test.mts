import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { ConversationHistory } from '../../src/conversation/history.mts';
import { Scheduler } from '../../src/schedules/scheduler.mts';
import { isRecord } from '../../src/contracts/json.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import type { WorkerPublic, WorkerRpcPublic } from '../../src/runtime/worker-types.ts';

class Worker extends EventEmitter {
  status: WorkerPublic['status'];
  calls: { method: string; params: RpcParams | undefined }[];
  rpc: WorkerRpcPublic;
  constructor() {
    super();
    this.status = 'offline';
    this.calls = [];
    this.rpc = { send() {}, reply() {} };
  }
  async request(method: string, params?: RpcParams): Promise<RpcResult> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'new-thread' } };
    if (method === 'turn/start') return { turn: { id: 'new-turn' } };
    return {};
  }
}
function setup(t: NodeTestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    worker = new Worker(),
    engine = new Engine(store, worker);
  store.state.threadId = 'existing-thread';
  store.state.threadRuntime = engine.runtimeId;
  store.state.threadConversationId = store.state.conversationId;
  engine.loaded = true;
  store.save();
  return { dir, store, worker, engine, history: new ConversationHistory({ store, engine }) };
}
const identity = ({ store, engine }: Pick<ReturnType<typeof setup>, 'store' | 'engine'>) => ({
  threadId: store.state.threadId,
  threadRuntime: store.state.threadRuntime,
  threadConversationId: store.state.threadConversationId,
  conversationId: store.state.conversationId,
  loaded: engine.loaded,
  workspace: engine.workspace,
});
const errorStatus = (status: number) => (error: unknown) =>
  isRecord(error) && error.status === status;

test('pending message delivery keeps history immutable after its original task ends', (t) => {
  const context = setup(t),
    { store, engine, history } = context,
    message = store.add({
      role: 'user',
      text: 'A followup awaiting acknowledgement',
      status: 'running',
    }),
    before = structuredClone(store.state);
  engine.pendingFollowups.set(message.id, new Promise(() => {}));
  assert.equal(engine.active, null);
  assert.throws(() => history.edit(message.id, { text: 'Changed' }), errorStatus(409));
  assert.throws(() => history.remove(message.id), errorStatus(409));
  assert.throws(() => history.clear({ confirm: true }), errorStatus(409));
  assert.deepEqual(store.state, before);
  engine.pendingFollowups.clear();
  assert.equal(history.edit(message.id, { text: 'Safe after delivery' }).edited, true);
});

test('editing changes only the stored user text by default and preserves model conversation/task status', (t) => {
  const context = setup(t),
    { store, history, engine, worker, dir } = context,
    before = identity(context),
    attachments = [{ id: 'file', path: '/retained/output.txt' }];
  const user = store.add({
    role: 'user',
    text: 'Original',
    status: 'completed',
    turnId: 'old-turn',
    executorConfirmedAt: 100,
    acceptedAt: 200,
    attachments,
  });
  const result = history.edit(user.id, { text: ' Edited text ' });
  assert.equal(result.edited, true);
  assert.equal(result.resubmitted, false);
  assert.equal(result.message.id, user.id);
  assert.equal(result.message.text, 'Edited text');
  assert.ok(defined(result.message.editedAt) > 0);
  assert.equal(result.message.status, 'completed');
  assert.equal(result.message.acceptedAt, 200);
  assert.equal(result.message.turnId, 'old-turn');
  assert.deepEqual(result.message.attachments, attachments);
  assert.deepEqual(identity(context), before);
  assert.equal(engine.queue.length, 0);
  assert.equal(worker.calls.length, 0);
  assert.equal(defined(new Store(dir).state.messages[0]).text, 'Edited text');
});

test('long message edits preserve the full text and model identity and resubmit only when explicitly requested', (t) => {
  const context = setup(t),
    { store, history, engine, worker } = context,
    before = identity(context),
    text = '中文😀'.repeat(30000) + 'LONG_EDIT_TAIL',
    user = store.add({ role: 'user', text, status: 'review' });
  assert.ok(text.length > 100000);
  const saved = history.edit(user.id, { text: text + ' saved' });
  assert.equal(saved.message.id, user.id);
  assert.equal(saved.message.text, text + ' saved');
  assert.equal(saved.resubmitted, false);
  assert.equal(engine.queue.length, 0);
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(identity(context), before);
  const resubmitted = history.edit(user.id, { text: text + ' resent', resubmit: true });
  assert.equal(resubmitted.message.text, text + ' resent');
  assert.equal(resubmitted.resubmitted, true);
  assert.equal(engine.queue.length, 1);
  assert.equal(defined(engine.queue[0]).id, user.id);
  assert.equal(defined(engine.queue[0]).text, text + ' resent');
  assert.deepEqual(identity(context), before);
  history.edit(user.id, { text: text + ' updated pending', resubmit: true });
  assert.equal(engine.queue.length, 1);
  assert.equal(defined(engine.queue[0]).text, text + ' updated pending');
  assert.equal(worker.calls.length, 0);
});

test('explicit save and resend enters the normal queue once with old execution receipts cleared', async (t) => {
  const context = setup(t),
    { store, history, engine, worker } = context,
    before = identity(context),
    user = store.add({
      role: 'user',
      text: 'Old',
      status: 'completed',
      turnId: 'old-turn',
      submission: 'confirmed',
      executorConfirmedAt: 100,
      acceptedAt: 200,
    });
  const result = history.edit(user.id, { text: 'Please run this edited task', resubmit: true });
  assert.equal(result.resubmitted, true);
  assert.equal(engine.queue.length, 1);
  assert.equal(defined(engine.queue[0]).id, user.id);
  assert.equal(result.message.executorConfirmedAt, null);
  assert.equal(result.message.acceptedAt, null);
  assert.equal(result.message.turnId, null);
  assert.equal(result.message.submission, null);
  assert.deepEqual(identity(context), before);
  worker.status = 'online';
  worker.emit('status');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.calls.filter((item) => item.method === 'turn/start').length, 1);
  assert.equal(
    worker.calls.some((item) => item.method === 'thread/start'),
    false,
  );
  assert.equal(defined(engine.active).messageId, user.id);
  assert.equal(store.state.messages.length, 1);
  await engine.handle({
    method: 'turn/completed',
    params: { threadId: 'existing-thread', turn: { id: 'new-turn', status: 'completed' } },
  });
  assert.equal(engine.active, null);
  assert.equal(defined(store.state.messages[0]).status, 'review');
});

test('editing an already queued message updates that pending task without duplicating execution', (t) => {
  const { store, history, engine } = setup(t),
    user = store.add({ role: 'user', text: 'First' });
  engine.enqueue(user);
  const result = history.edit(user.id, { text: 'Edited pending task' });
  assert.equal(result.resubmitted, false);
  assert.equal(engine.queue.length, 1);
  assert.equal(engine.queue[0], result.message);
  assert.equal(engine.queue[0].text, 'Edited pending task');
  history.edit(user.id, { text: 'Explicitly resend pending task', resubmit: true });
  assert.equal(engine.queue.length, 1);
  assert.equal(engine.queue[0].text, 'Explicitly resend pending task');
});

test('edits reject nonexistent/non-user targets and invalid text', (t) => {
  const { store, history } = setup(t),
    user = store.add({ role: 'user', text: 'Keep' }),
    assistant = store.add({ role: 'assistant', text: 'Answer' });
  assert.throws(() => history.edit('missing', { text: 'New' }), errorStatus(404));
  assert.throws(() => history.edit(assistant.id, { text: 'New' }), errorStatus(400));
  for (const text of [undefined, null, 42, '', '   '])
    assert.throws(() => history.edit(user.id, { text }), errorStatus(400));
  assert.throws(() => history.edit(user.id, { text: 'New', resubmit: 'yes' }), errorStatus(400));
  assert.equal(defined(store.state.messages[0]).text, 'Keep');
});

test('individual deletion clears dangling replies/completion IDs and leaves other visible messages', (t) => {
  const context = setup(t),
    { store, history } = context,
    before = identity(context),
    user = store.add({ role: 'user', text: 'Task' }),
    answer = store.add({ role: 'assistant', text: 'Answer', replyTo: user.id }),
    followup = store.add({ role: 'user', text: 'Followup', replyTo: answer.id }),
    other = store.add({ role: 'assistant', text: 'Other' });
  store.state.completions = [
    { id: 'one', taskId: user.id, messageIds: [answer.id, other.id] },
    { id: 'two', messageIds: [answer.id] },
  ];
  store.save();
  const removed = history.remove(answer.id);
  assert.deepEqual(removed, { removed: true, id: answer.id, withdrawn: false });
  assert.equal(defined(store.state.messages.find((item) => item.id === followup.id)).replyTo, null);
  assert.deepEqual(store.state.completions, [
    { id: 'one', taskId: user.id, messageIds: [other.id] },
  ]);
  history.remove(user.id);
  assert.equal(defined(store.state.completions[0]).taskId, null);
  assert.deepEqual(identity(context), before);
  assert.throws(() => history.remove(answer.id), errorStatus(404));
});

test('a truly queued user task can be withdrawn without disturbing another active task or model thread', (t) => {
  const context = setup(t),
    { store, history, engine, worker } = context,
    before = identity(context),
    running = store.add({ role: 'user', text: 'Running' }),
    queued = store.add({ role: 'user', text: 'Withdraw me' }),
    remaining = store.add({ role: 'user', text: 'Leave queued' });
  history.engine.active = { messageId: running.id, messageIds: [running.id] };
  engine.queue = [queued, remaining];
  assert.deepEqual(history.remove(queued.id), { removed: true, id: queued.id, withdrawn: true });
  assert.deepEqual(
    engine.queue.map((item) => item.id),
    [remaining.id],
  );
  assert.equal(defined(engine.active).messageId, running.id);
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(identity(context), before);
  assert.throws(() => history.remove(running.id), errorStatus(409));
  assert.throws(() => history.edit(remaining.id, { text: 'No mutation' }), errorStatus(409));
  assert.throws(() => history.clear({ confirm: true }), errorStatus(409));
});

test('calls/native work and active task aliases cannot be bypassed by a queue entry', (t) => {
  const { store, history, engine } = setup(t),
    user = store.add({ role: 'user', text: 'Keep' });
  engine.queue = [user];
  history.engine.call = { id: 'call' };
  for (const action of [
    () => history.remove(user.id),
    () => history.edit(user.id, { text: 'new' }),
    () => history.clear({ confirm: true }),
  ])
    assert.throws(action, errorStatus(409));
  engine.call = null;
  history.engine.active = { messageId: 'other', messageIds: [user.id] };
  assert.throws(() => history.remove(user.id), errorStatus(409));
  engine.active = null;
  engine.queue = [];
  history.engine.nativeVoice = { active: { turnId: 'voice' } };
  assert.throws(() => history.remove(user.id), errorStatus(409));
  history.engine.nativeVoice = null;
  engine.finishing = Promise.resolve();
  assert.throws(() => history.edit(user.id, { text: 'new' }), errorStatus(409));
});

test('system call records can be removed when idle without changing the current conversation', (t) => {
  const context = setup(t),
    { store, history } = context,
    before = identity(context),
    record = store.add({ role: 'system', kind: 'call', seconds: 30, text: '' });
  assert.equal(history.remove(record.id).removed, true);
  assert.equal(store.state.messages.length, 0);
  assert.deepEqual(identity(context), before);
});

test('confirmed clear removes visible history and pending queue while preserving workspace/memory/skills/settings', (t) => {
  const context = setup(t),
    { store, history, engine, dir } = context,
    before = identity(context),
    user = store.add({ role: 'user', text: 'Queued' });
  engine.enqueue(user);
  store.add({ role: 'assistant', text: 'Visible result' });
  store.state.completions = [{ id: 'completion', messageIds: ['answer'] }];
  const scheduler = new Scheduler({ store, engine, now: () => 1_000 });
  scheduler.save({ text: 'Keep', at: 2_000 });
  const schedules = structuredClone(store.state.schedules);
  store.state.presence = { lastActiveAt: 1000 };
  store.save();
  engine.ensureWorkspace();
  fs.writeFileSync(path.join(engine.outputDir, 'retained.txt'), 'keep');
  engine.memory.write('working-memory.md', 'Remember this');
  const settings = structuredClone(store.state.settings);
  assert.throws(() => history.clear(), errorStatus(400));
  assert.throws(() => history.clear({ confirm: 'true' }), errorStatus(400));
  assert.deepEqual(history.clear({ confirm: true }), { cleared: true, count: 2 });
  assert.deepEqual(store.state.messages, []);
  assert.deepEqual(store.state.completions, []);
  assert.deepEqual(engine.queue, []);
  assert.deepEqual(store.state.schedules, schedules);
  assert.deepEqual(store.state.settings, settings);
  assert.deepEqual(store.state.presence, { lastActiveAt: 1000 });
  assert.equal(fs.readFileSync(path.join(engine.outputDir, 'retained.txt'), 'utf8'), 'keep');
  assert.equal(engine.memory.read('working-memory.md'), 'Remember this');
  assert.deepEqual(identity(context), before);
  assert.deepEqual(new Store(dir).state.messages, []);
});

test('failed history persistence rolls back messages/completions and does not withdraw or enqueue work', (t) => {
  const { store, history, engine } = setup(t),
    user = store.add({ role: 'user', text: 'Original' });
  engine.enqueue(user);
  store.state.completions = [{ id: 'one', messageIds: [user.id] }];
  const messages = store.state.messages,
    completions = store.state.completions,
    queue = engine.queue;
  store.save = () => {
    throw Error('Injected save failure');
  };
  for (const action of [
    () => history.remove(user.id),
    () => history.edit(user.id, { text: 'Changed', resubmit: true }),
    () => history.clear({ confirm: true }),
  ]) {
    assert.throws(action, /Injected save failure/);
    assert.equal(store.state.messages, messages);
    assert.equal(store.state.completions, completions);
    assert.equal(engine.queue, queue);
    assert.equal(defined(store.state.messages[0]).text, 'Original');
  }
});

test('clear rejects unresolved ephemeral voice tasks instead of stranding their promises', (t) => {
  const { store, history } = setup(t);
  store.add({ role: 'user', text: 'Keep' });
  history.engine.voiceTasks = new Map([['voice-task-1', {}]]);
  assert.throws(() => history.clear({ confirm: true }), errorStatus(409));
  assert.equal(store.state.messages.length, 1);
  for (const id of [null, 3, '', 'x'.repeat(129)])
    assert.throws(() => history.remove(id), errorStatus(400));
});

test('deleted request IDs persist across restart for queued withdrawals and clearing all user records', (t) => {
  const { store, history, engine, dir } = setup(t),
    queued = store.add({ role: 'user', text: 'Withdraw', clientMessageId: 'client-withdraw' });
  engine.enqueue(queued);
  history.remove(queued.id);
  assert.equal(history.hasDeletedClientId('client-withdraw'), true);
  assert.equal(history.hasDeletedClientId('missing'), false);
  assert.equal(engine.queue.length, 0);
  store.add({ role: 'user', text: 'Clear', clientMessageId: 'client-clear' });
  store.add({
    role: 'assistant',
    text: 'Assistant IDs are not request identities',
    clientMessageId: 'assistant-only',
  });
  history.clear({ confirm: true });
  assert.deepEqual(store.state.deletedClientMessageIds, ['client-withdraw', 'client-clear']);
  assert.equal(history.hasDeletedClientId('assistant-only'), false);
  const reopened = new Store(dir),
    again = new ConversationHistory({ store: reopened, engine });
  assert.equal(again.hasDeletedClientId('client-withdraw'), true);
  assert.equal(again.hasDeletedClientId('client-clear'), true);
  assert.deepEqual(reopened.state.messages, []);
});

test('request tombstones are bounded at 2000 opaque IDs and failed saves do not advance them', (t) => {
  const { store, history } = setup(t);
  store.state.deletedClientMessageIds = Array.from({ length: 2000 }, (_, index) => 'old-' + index);
  const message = store.add({ role: 'user', text: 'Last', clientMessageId: 'new-id' });
  history.remove(message.id);
  assert.equal(store.state.deletedClientMessageIds.length, 2000);
  assert.equal(history.hasDeletedClientId('old-0'), false);
  assert.equal(history.hasDeletedClientId('old-1'), true);
  assert.equal(history.hasDeletedClientId('new-id'), true);
  assert.equal(
    store.state.deletedClientMessageIds.some((id) => id.includes('Last')),
    false,
  );
  const other = store.add({ role: 'user', text: 'Keep', clientMessageId: 'failed-id' }),
    prior = store.state.deletedClientMessageIds;
  store.save = () => {
    throw Error('Injected failure');
  };
  assert.throws(() => history.remove(other.id), /Injected failure/);
  assert.equal(store.state.deletedClientMessageIds, prior);
  assert.equal(history.hasDeletedClientId('failed-id'), false);
});
