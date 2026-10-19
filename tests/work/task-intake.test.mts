import { observedRecords } from '../support/service-fixtures.mts';
import { observedString } from '../support/service-fixtures.mts';
import { nativeTurnFromSession } from '../support/service-fixtures.mts';
import {
  WorkerServiceFixture,
  activeTaskFixture,
  observedRecord,
} from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';
import { startTaskProgress } from '../../src/work/task-progress.mts';
import { workProgress, renderWorkTaskHistory } from '../../ui/work/work-progress.mts';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const event = (method: string, params: RpcParams = {}, id?: string | number) => ({
  method,
  params: { threadId: 'thread', ...params },
  ...(id === undefined ? {} : { id }),
});
class Worker extends WorkerServiceFixture {
  declare calls: Array<{ method: string; params: RpcParams | undefined }>;
  declare responses: Array<{
    id?: string | number | null | undefined;
    result?: unknown;
    method?: string | undefined;
    params?: RpcParams | undefined;
    error?: unknown;
  }>;
  declare replies: unknown[];
  declare count: number;
  declare nextTurn: number;
  declare autoInterrupt: boolean;
  declare terminated: number;
  declare engine: Engine;
  constructor() {
    super();
    this.status = 'online';
    this.calls = [];
    this.replies = [];
    this.rpc = { reply: (id, value) => this.replies.push({ id, value }), send() {} };
  }
  async request(method: string, params?: RpcParams): Promise<RpcResult> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'thread/realtime/start') {
      queueMicrotask(() => {
        this.emit('event', event('thread/realtime/started', { version: 'v3' }));
        this.emit('event', event('thread/realtime/sdp', { sdp }));
      });
    }
    if (method === 'thread/realtime/stop')
      queueMicrotask(() => this.emit('event', event('thread/realtime/closed')));
    if (method === 'thread/read') {
      const turns = [...(defined(this.engine.nativeVoice?.session?.turns).values() || [])].map(
        (turn) => ({
          id: turn.turnId,
          status: turn.done ? 'completed' : 'inProgress',
        }),
      );
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
}
function fixture(t: NodeTestContext, { native = false } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'task-intake-')),
    store = new Store(dir),
    worker = new Worker(),
    engine = new Engine(store, worker),
    notices: string[] = [];
  store.state.settings.language = 'en';
  worker.engine = engine;
  engine.on('notice', (text) => notices.push(text));
  const voice = native
    ? new NativeRealtimeVoice({ engine, worker, connectTimeoutMs: 1000, stopTimeoutMs: 1000 })
    : null;
  t.after(() => {
    engine.pauseQueue();
    clearTimeout(engine.streamingSaveTimer ?? undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, worker, engine, voice, notices };
}
function owned(f: ReturnType<typeof fixture>, id = 'owned', text = 'Send me the dant UI profile') {
  const message = f.store.add({
    role: 'user',
    text,
    status: 'running',
    turnId: id,
    workKind: 'conversation',
    submission: 'confirmed',
  });
  const task = activeTaskFixture({
    threadId: 'thread',
    turnId: id,
    messageId: message.id,
    messageIds: [message.id],
    assistantIds: [],
    outputs: new Map(),
    explicitPaths: [],
    startAcknowledged: true,
    conversationalInput: true,
    resolveStopped() {},
  });
  startTaskProgress(task);
  f.engine.active = task;
  return { message, task };
}
const waiting = () => ({
  title: 'Confirm and send the dant UI profile',
  status: 'waiting_user',
  steps: [
    { step: 'Confirm which profile is needed', status: 'pending' },
    { step: 'Send the requested profile', status: 'pending' },
  ],
});
const action = (turnId: string, id = 'command') =>
  event('item/started', {
    turnId,
    item: {
      id,
      type: 'commandExecution',
      command: 'private-command',
      output: 'private-output',
      arguments: { secret: 'private-secret' },
    },
  });
const state = (f: ReturnType<typeof fixture>) => ({
  messages: f.store.state.messages,
  workTasks: f.store.state.workTasks,
  completions: f.store.state.completions,
  active: f.engine.progress || f.voice?.progress,
  worker: { status: 'online' },
  queue: [],
});

test('a clarification is saved as waiting before acknowledgement and keeps one task through its answer and restart', async (t) => {
  const f = fixture(t),
    first = owned(f);
  assert.equal(defined(f.engine.progress).visible, false);
  const ack = await f.engine.tool('task_plan', waiting()),
    saved = JSON.parse(fs.readFileSync(f.store.file, 'utf8')).workTasks[0];
  assert.equal(observedRecord(ack).saved, true);
  assert.equal(observedRecord(ack).status, 'waiting_user');
  assert.equal(saved.status, 'waiting_user');
  assert.equal(first.message.workKind, 'task');
  assert.equal(defined(f.engine.progress).status, 'waiting_user');
  assert.equal(f.worker.calls.length, 0);
  await f.engine.finish('completed');
  assert.equal(f.engine.active, null);
  assert.equal(defined(f.store.state.workTasks[0]).status, 'waiting_user');
  assert.ok(defined(f.store.state.workTasks[0]).executionEndedAt);
  const model = workProgress(state(f));
  assert.equal(defined(model.ongoing[0]).status, 'waiting_user');
  assert.equal(defined(new Store(f.dir).state.workTasks[0]).status, 'waiting_user');
  owned(f, 'answer', 'The UI profile page link');
  const continued = await f.engine.tool('task_plan', {
    ...waiting(),
    workId: observedRecord(ack).workId,
    status: 'running',
    steps: [{ step: 'Send the confirmed UI profile link', status: 'inProgress' }],
  });
  assert.equal(observedRecord(continued).workId, observedRecord(ack).workId);
  assert.equal(observedRecord(continued).status, 'running');
  assert.equal(f.store.state.workTasks.length, 1);
  assert.deepEqual(defined(f.store.state.workTasks[0]).turnIds, ['owned', 'answer']);
  await f.engine.tool('task_plan', {
    title: waiting().title,
    steps: [{ step: 'Send the confirmed UI profile link', status: 'completed' }],
  });
  await f.engine.finish('completed');
  assert.equal(defined(f.store.state.workTasks[0]).status, 'review');
  owned(f, 'thanks', 'Thank you');
  await f.engine.finish('completed');
  assert.equal(f.store.state.workTasks.length, 1, 'ordinary acknowledgement creates no task');
  owned(f, 'unrelated', 'Inspect a different project');
  await f.engine.tool('task_plan', {
    title: 'Inspect another project',
    steps: [{ step: 'Inspect the project', status: 'inProgress' }],
  });
  assert.equal(f.store.state.workTasks.length, 2);
  assert.notEqual(defined(f.store.state.workTasks[1]).id, observedRecord(ack).workId);
});

test('a failed waiting save changes neither the current task nor its previous wait and real user-input waits take precedence', async (t) => {
  const f = fixture(t),
    { task } = owned(f),
    save = f.store.save;
  f.store.save = () => {
    throw Error('Disk unavailable');
  };
  await assert.rejects(f.engine.tool('task_plan', waiting()), /Disk unavailable/);
  assert.equal(task.planWaitingForUser, undefined);
  assert.equal(task.workRecord, undefined);
  assert.equal(defined(f.engine.progress).visible, false);
  f.store.save = save;
  await f.engine.tool('task_plan', waiting());
  const original = task.workRecord;
  f.store.save = () => {
    throw Error('Disk unavailable');
  };
  await assert.rejects(
    f.engine.tool('task_plan', { ...waiting(), status: 'running' }),
    /Disk unavailable/,
  );
  assert.equal(task.workRecord, original);
  assert.equal(task.planWaitingForUser, true);
  f.store.save = save;
  for (const status of ['inProgress', 'completed'] as const) {
    await assert.rejects(
      f.engine.tool('task_plan', {
        title: waiting().title,
        steps: [{ step: 'Send the profile', status }],
      }),
      /waiting_user/,
    );
    assert.equal(task.workRecord, original);
    assert.equal(task.planWaitingForUser, true);
  }
  for (const status of ['inProgress', 'completed'] as const) {
    await f.engine.handle(
      event('turn/plan/updated', { turnId: 'owned', plan: [{ step: 'Send the profile', status }] }),
    );
    assert.equal(task.workRecord, original);
    assert.equal(defined(f.store.state.workTasks[0]).status, 'waiting_user');
    assert.deepEqual(observedRecord(defined(f.engine.progress).plan).steps, waiting().steps);
  }
  await f.engine.handle(event('item/tool/requestUserInput', { turnId: 'owned', questions: [] }, 7));
  assert.equal(task.awaitingChatInput, true);
  await f.engine.tool('task_plan', { ...waiting(), status: 'running' });
  assert.equal(defined(f.engine.progress).status, 'waiting_user');
  f.engine.respondToUser(7, {});
  assert.equal(task.awaitingChatInput, false);
  assert.equal(task.planWaitingForUser, false);
  assert.equal(defined(f.engine.progress).status, 'running');
  await f.engine.handle(event('item/tool/requestUserInput', { turnId: 'owned', questions: [] }, 8));
  await f.engine.finish('completed');
  assert.equal(
    defined(f.store.state.workTasks[0]).status,
    'waiting_user',
    'turn ending while the request is unanswered keeps the saved wait',
  );
});

test('real execution without a plan gets one durable record with no invented checklist or completion', async (t) => {
  const f = fixture(t),
    { message, task } = owned(f);
  f.engine.redact = (text) => observedString(text).replaceAll('profile', '[redacted]');
  await f.engine.handle(action('foreign'));
  assert.equal(f.store.state.workTasks.length, 0);
  await f.engine.handle(action('owned'));
  const record = f.store.state.workTasks[0];
  assert.ok(defined(record).id);
  assert.equal(defined(record).plan, null);
  assert.equal(defined(record).provisional, true);
  assert.equal(message.workId, defined(record).id);
  assert.equal(message.workKind, 'task');
  assert.equal(defined(task.workRecord).id, defined(record).id);
  assert.equal(defined(record).title, 'Send me the dant UI [redacted]');
  assert.equal(Object.hasOwn(defined(f.engine.progress), 'plan'), false);
  assert.equal(JSON.stringify(record).includes('private-'), false);
  await f.engine.handle(
    event('item/completed', { turnId: 'owned', item: { id: 'command', type: 'commandExecution' } }),
  );
  assert.equal(f.store.state.workTasks.length, 1);
  assert.equal(
    defined(observedRecords(observedRecord(await f.engine.tool('task_list', {})).items)[0]).steps,
    null,
  );
  await f.engine.finish('completed');
  assert.equal(defined(f.store.state.workTasks[0]).status, 'continuing');
  assert.ok(defined(f.store.state.workTasks[0]).executionEndedAt);
  assert.equal(defined(new Store(f.dir).state.workTasks[0]).plan, null);
  const model = workProgress(state(f));
  assert.equal(defined(model.ongoing[0]).plan, null);
  assert.doesNotMatch(
    renderWorkTaskHistory(defined(model.ongoing[0]), model.labels),
    /<progress|steps completed/,
  );
  await f.engine.handle(action('owned', 'late'));
  assert.equal(f.store.state.workTasks.length, 1);
});

test('an observed placeholder upgrades to the actual public plan or explicitly rejoins the matching older task', async (t) => {
  const f = fixture(t);
  owned(f, 'older');
  const ack = await f.engine.tool('task_plan', waiting());
  await f.engine.finish('completed');
  owned(f, 'current');
  await f.engine.handle(action('current'));
  const placeholder = defined(f.engine.active).workRecord;
  await f.engine.handle(
    event('turn/plan/updated', {
      turnId: 'current',
      plan: [{ step: 'Locate the requested page', status: 'inProgress' }],
    }),
  );
  assert.equal(defined(defined(f.engine.active).workRecord).id, defined(placeholder).id);
  assert.equal(defined(defined(f.engine.active).workRecord).title, 'Locate the requested page');
  assert.ok(defined(defined(f.engine.active).workRecord).plan);
  const continued = await f.engine.tool('task_plan', {
    ...waiting(),
    workId: observedRecord(ack).workId,
    status: 'running',
  });
  assert.equal(observedRecord(continued).workId, observedRecord(ack).workId);
  assert.equal(f.store.state.workTasks.length, 1);
  assert.deepEqual(defined(f.store.state.workTasks[0]).turnIds, ['older', 'current']);
  assert.equal(defined(f.store.state.workTasks[0]).provisional, undefined);
});

test('observed persistence failures are reported and retried at finalization without exposing a saved acknowledgement early', async (t) => {
  const f = fixture(t),
    { task } = owned(f),
    save = f.store.save;
  f.store.save = () => {
    throw Error('Temporary save failure');
  };
  await f.engine.handle(action('owned'));
  assert.equal(task.workObserved, true);
  assert.equal(task.workRecord, undefined);
  assert.equal(f.store.state.workTasks.length, 0);
  assert.match(defined(f.notices[0]), /Could not save observed/);
  f.store.save = save;
  await f.engine.finish('completed');
  assert.equal(f.store.state.workTasks.length, 1);
  assert.equal(defined(f.store.state.workTasks[0]).status, 'continuing');
  assert.equal(defined(f.store.state.workTasks[0]).plan, null);
});

test('an older operation completing cannot clear a newly registered clarification wait in text or native work', async (t) => {
  for (const native of [false, true] as const) {
    const f = fixture(t, { native });
    let task;
    if (native) {
      await f.engine.startCall(sdp);
      await f.engine.handle(event('turn/started', { turn: { id: 'owned', status: 'inProgress' } }));
      task = defined(defined(f.voice).session).turns.get('owned');
    } else ({ task } = owned(f));
    const savePlan = (args: Record<string, unknown>) =>
      native
        ? defined(f.voice).tool(
            defined(defined(f.voice).session),
            nativeTurnFromSession(defined(defined(f.voice).session), task),
            'task_plan',
            args,
          )
        : f.engine.tool('task_plan', args);
    await f.engine.handle(action('owned'));
    await savePlan(waiting());
    assert.equal(defined(f.voice?.progress || f.engine.progress).status, 'waiting_user');
    await f.engine.handle(
      event('item/completed', {
        turnId: 'owned',
        item: { id: 'command', type: 'commandExecution' },
      }),
    );
    assert.equal(defined(task).planWaitingForUser, true);
    assert.equal(defined(f.voice?.progress || f.engine.progress).status, 'waiting_user');
    await f.engine.handle(event('turn/completed', { turn: { id: 'owned', status: 'completed' } }));
    assert.equal(defined(f.store.state.workTasks[0]).status, 'waiting_user');
  }
});

test('human steer acknowledgements clear only the wait that existed when submitted, preserving a newer saved question', async (t) => {
  for (const native of [false, true] as const)
    for (const newerWait of [false, true] as const) {
      const f = fixture(t, { native });
      let task;
      if (native) {
        const call = await f.engine.startCall(sdp);
        await f.engine.handle(
          event('turn/started', { turn: { id: 'owned', status: 'inProgress' } }),
        );
        task = defined(defined(f.voice).session).turns.get('owned');
        await f.engine.stopCall(call.callId);
      } else {
        ({ task } = owned(f));
        task.steerChain = Promise.resolve();
        f.engine.prepareInput = async (message) => [
          { type: 'text', text: observedString(message.text) },
        ];
      }
      const savePlan = (args: Record<string, unknown>) =>
        native
          ? defined(f.voice).tool(
              defined(defined(f.voice).session),
              nativeTurnFromSession(defined(defined(f.voice).session), task),
              'task_plan',
              args,
            )
          : f.engine.tool('task_plan', args);
      await savePlan(waiting());
      let acknowledge!: (result: RpcResult) => void, submitted!: () => void;
      const ready = new Promise<void>((resolve) => (submitted = resolve)),
        original = f.worker.request.bind(f.worker);
      f.worker.request = (method, params) =>
        method === 'turn/steer'
          ? new Promise((resolve) => {
              acknowledge = resolve;
              submitted();
            })
          : original(method, params);
      const reply = f.store.add({
          role: 'user',
          text: 'The UI profile page link',
          workKind: 'conversation',
          status: 'accepted',
        }),
        pending = native
          ? defined(f.voice).answerBackground(reply)
          : f.engine.steer(reply, 'owned');
      await ready;
      if (newerWait)
        await savePlan({ ...waiting(), title: 'Confirm the destination for the profile link' });
      acknowledge({});
      await pending;
      assert.equal(defined(task).planWaitingForUser, newerWait);
      assert.equal(
        defined(f.voice?.progress || f.engine.progress).status,
        newerWait ? 'waiting_user' : 'running',
      );
      assert.equal(reply.workId, defined(defined(task).workRecord).id);
      assert.equal(f.store.state.workTasks.length, 1);
    }
});

test('native work registers missing execution plans and explicit clarification waits without turning conversation into work', async (t) => {
  const f = fixture(t, { native: true }),
    call = await f.engine.startCall(sdp);
  await f.engine.handle(event('turn/started', { turn: { id: 'speech', status: 'inProgress' } }));
  await f.engine.handle(
    event('item/agentMessage/delta', { turnId: 'speech', itemId: 'speech-text', delta: 'Hello' }),
  );
  assert.equal(defined(defined(f.voice).progress).visible, false);
  assert.equal(f.store.state.workTasks.length, 0);
  await f.engine.handle(event('turn/completed', { turn: { id: 'speech', status: 'completed' } }));
  await f.engine.handle(event('turn/started', { turn: { id: 'work', status: 'inProgress' } }));
  await f.engine.handle(action('work'));
  const id = defined(defined(f.voice).progress).workId;
  assert.ok(id);
  assert.equal(defined(defined(f.voice).progress).visible, true);
  assert.equal(Object.hasOwn(defined(defined(f.voice).progress), 'plan'), false);
  await f.engine.handle(event('turn/completed', { turn: { id: 'work', status: 'completed' } }));
  assert.equal(defined(f.store.state.workTasks[0]).status, 'continuing');
  await f.engine.handle(event('turn/started', { turn: { id: 'clarify', status: 'inProgress' } }));
  const turn = defined(defined(f.voice).session).turns.get('clarify'),
    ack = await defined(f.voice).tool(
      defined(defined(f.voice).session),
      defined(turn),
      'task_plan',
      waiting(),
    );
  assert.equal(observedRecord(ack).status, 'waiting_user');
  assert.equal(defined(defined(f.voice).progress).status, 'waiting_user');
  await f.engine.handle(event('turn/completed', { turn: { id: 'clarify', status: 'completed' } }));
  assert.equal(defined(f.store.state.workTasks[1]).status, 'waiting_user');
  assert.equal(defined(f.voice).active, null);
  assert.equal(defined(new Store(f.dir).state.workTasks[1]).status, 'waiting_user');
  await f.engine.stopCall(call.callId);
});

test('a native handoff receipt cannot clear a later clarification wait without an explicit plan update', async (t) => {
  const f = fixture(t, { native: true });
  await f.engine.startCall(sdp);
  await f.engine.handle(event('turn/started', { turn: { id: 'owned', status: 'inProgress' } }));
  const turn = defined(defined(f.voice).session).turns.get('owned');
  await defined(f.voice).tool(
    defined(defined(f.voice).session),
    defined(turn),
    'task_plan',
    waiting(),
  );
  await f.engine.handle(
    event('thread/realtime/itemAdded', {
      item: {
        type: 'handoff_request',
        handoff_id: 'original-late-handoff',
        item_id: 'original-input',
        input_transcript: 'Send me the profile',
        active_transcript: [],
      },
    }),
  );
  assert.equal(defined(turn).planWaitingForUser, true);
  assert.equal(defined(defined(f.voice).progress).status, 'waiting_user');
  defined(turn).credentialWaits = 1;
  const ack = await defined(f.voice).tool(
    defined(defined(f.voice).session),
    defined(turn),
    'task_plan',
    {
      title: waiting().title,
      status: 'running',
      steps: [{ step: 'Send the confirmed profile link', status: 'inProgress' }],
    },
  );
  assert.equal(observedRecord(ack).status, 'waiting_user');
  defined(turn).credentialWaits = 0;
  assert.equal(defined(defined(f.voice).progress).status, 'running');
  assert.equal(f.store.state.workTasks.length, 1);
});

test('confirmed cancellation keeps task history without inserting a canned stopped message', async (t) => {
  for (const native of [false, true] as const) {
    const f = fixture(t, { native });
    let task;
    if (native) {
      await f.engine.startCall(sdp);
      await f.engine.handle(
        event('turn/started', { turn: { id: 'cancel', status: 'inProgress' } }),
      );
      task = defined(defined(f.voice).session).turns.get('cancel');
      await defined(f.voice).tool(
        defined(defined(f.voice).session),
        nativeTurnFromSession(defined(defined(f.voice).session), task),
        'task_plan',
        { ...waiting(), status: 'running' },
      );
      defined(task).background = true;
      defined(task).cancelRequested = true;
      await f.engine.handle(
        event('turn/completed', { turn: { id: 'cancel', status: 'interrupted' } }),
      );
    } else {
      ({ task } = owned(f));
      task.backgroundVoice = true;
      task.voiceOutputs = new Map();
      task.cancelRequested = true;
      await f.engine.tool('task_plan', { ...waiting(), status: 'running' });
      await f.engine.finish('interrupted');
    }
    assert.equal(defined(f.store.state.workTasks[0]).status, 'cancelled');
    assert.equal(
      f.store.state.messages.filter((message) => message.role === 'assistant').length,
      0,
    );
    assert.equal(f.store.state.completions.length, 0);
  }
});
