import {
  WorkerServiceFixture,
  activeTaskFixture,
  engineCallFixture,
  nativeTurnFixture,
  nativeSessionFixture,
  observedRecord,
  observedRecords,
} from '../support/service-fixtures.mts';
import type { SchedulerEngine } from '../../src/schedules/scheduler.mts';
import type { ChatMessage } from '../../src/conversation/types.ts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import { isRecord } from '../../src/contracts/json.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../../src/conversation/store.mts';
import { Scheduler } from '../../src/schedules/scheduler.mts';
import { Engine, dynamicTools } from '../../src/work/engine.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';
import { VOICE_TOOLS } from '../../src/voice/voice.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const NOW = Date.parse('2026-10-18T00:00:00Z'),
  ISO = '2026-10-18T09:00:00+08:00';
const job = (extra: Record<string, unknown> = {}) => ({
  text: 'Check the requested result tomorrow',
  at: ISO,
  timeZone: 'Asia/Kuala_Lumpur',
  ...extra,
});
class ScheduleWorker extends WorkerServiceFixture {
  calls: Array<{ method: string; params: RpcParams | undefined }> = [];
  async request(method: string, params?: RpcParams): Promise<RpcResult> {
    this.calls.push({ method, params });
    return {};
  }
}
class ScheduleEngine extends EventEmitter implements SchedulerEngine {
  worker: ScheduleWorker;
  store: Store;
  queue: ChatMessage[] = [];
  declare active?: Exclude<SchedulerEngine['active'], undefined> & {
    awaitingChatInput?: boolean;
    startAcknowledged?: boolean;
  };
  declare call: unknown;
  declare takeover: boolean;
  declare acquiring: boolean;
  declare pendingFollowups: { size: number };
  declare callReferences: { size: number };
  declare referencePending: unknown;
  declare nativeVoice?: {
    session?: {
      unknown?: boolean;
      submitting?: unknown;
      stopping?: boolean;
      pausing?: boolean;
      background?: boolean;
    };
    acceptsChatInput?: boolean;
    acceptsInteractiveChatInput?: boolean;
  };
  readonly enqueued: Enqueued[];
  constructor(store: Store, worker: ScheduleWorker, enqueued: Enqueued[]) {
    super();
    this.store = store;
    this.worker = worker;
    this.enqueued = enqueued;
  }
  change() {}
  enqueue(message: ChatMessage, options?: unknown) {
    this.enqueued.push({ message, options });
    this.queue.push(message);
  }
}
interface Enqueued {
  message: ChatMessage;
  options: unknown;
}
interface Fixture<Execution> {
  dir: string;
  store: Store;
  worker: ScheduleWorker;
  engine: Execution;
  scheduler: Scheduler;
  enqueued: Enqueued[];
  setNow(value: number): number;
}
function fixture(t: NodeTestContext, options: { realEngine: true }): Fixture<Engine>;
function fixture(t: NodeTestContext, options?: { realEngine?: false }): Fixture<ScheduleEngine>;
function fixture(
  t: NodeTestContext,
  { realEngine = false } = {},
): Fixture<Engine | ScheduleEngine> {
  const dir = fs.mkdtempSync(path.join(base, 'scheduler-')),
    store = new Store(dir),
    worker = new ScheduleWorker();
  worker.status = 'online';
  let now = NOW;
  const enqueued: Enqueued[] = [],
    engine = realEngine ? new Engine(store, worker) : new ScheduleEngine(store, worker, enqueued);
  const scheduler = new Scheduler({ store, engine, worker, now: () => now });
  t.after(() => {
    scheduler.close();
    if (engine instanceof Engine) {
      engine.pauseQueue();
      clearTimeout(engine.streamingSaveTimer ?? undefined);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    store,
    worker,
    engine,
    scheduler,
    enqueued,
    setNow: (value: number) => (now = value),
  };
}

test('saving a timezone-explicit one-time schedule persists it without submitting any task and lists its local time', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(job(), { allowEpoch: false });
  assert.equal(saved.status, 'pending');
  assert.equal(saved.enabled, true);
  assert.equal(saved.at, Date.parse(ISO));
  assert.equal(saved.atISO, '2026-10-18T01:00:00.000Z');
  assert.equal(saved.timeZone, 'Asia/Kuala_Lumpur');
  assert.match(defined(saved.localAt), /9:00:00/);
  assert.equal(f.enqueued.length, 0);
  assert.equal(f.store.state.messages.length, 0);
  f.store.state.settings.timeZone = 'Asia/Kuala_Lumpur';
  const listed = f.scheduler.list();
  assert.equal(defined(listed.items[0]).id, saved.id);
  assert.equal(listed.now, '2026-10-18T00:00:00.000Z');
  assert.equal(listed.timeZone, 'Asia/Kuala_Lumpur');
  assert.equal(defined(new Store(f.dir).state.schedules[0]).id, saved.id);
});

test('schedule validation rejects guessed local times, impossible dates, absent timezones and unsupported recurrence', (t) => {
  const f = fixture(t);
  for (const args of [
    job({ at: '2026-10-18T09:00:00' }),
    job({ at: '2027-02-29T09:00:00+08:00' }),
    job({ at: '2026-10-18T24:00:00Z' }),
    job({ at: '2026-10-18T09:00:00+24:00' }),
    job({ at: NOW + 1000 }),
    job({ timeZone: undefined }),
    job({ timeZone: 'Not/A_Timezone' }),
    job({ text: ' ' }),
    job({ text: 'a\0b' }),
    job({ enabled: 'yes' }),
    job({ rrule: 'FREQ=DAILY' }),
    job({ at: '2026-10-17T09:00:00+08:00' }),
    { id: 'unknown', enabled: false },
  ] as const)
    assert.throws(() => f.scheduler.save(args, { allowEpoch: false }));
  assert.equal(f.store.state.schedules.length, 0);
  assert.equal(f.enqueued.length, 0);
});

test('legacy numeric schedules retain compatibility and a missing legacy timezone is presented honestly as UTC', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save({ text: 'A legacy UI task', at: NOW + 1000 });
  assert.equal(saved.timeZone, 'UTC');
  f.store.state.schedules.push({
    id: 'legacy',
    text: 'Existing saved task',
    at: NOW + 2000,
    status: 'pending',
  });
  f.store.save();
  assert.equal(f.scheduler.get('legacy').timeZone, 'UTC');
  assert.equal(Object.hasOwn(defined(f.store.state.schedules[1]), 'timeZone'), false);
  f.setNow(NOW + 3000);
  assert.equal(f.scheduler.tick().length, 2);
  assert.equal(f.enqueued.length, 2);
});

test('partial edits and pause/resume retain the scheduled task ID and do not execute it while saving', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(job());
  const paused = f.scheduler.save({ id: saved.id, enabled: false });
  assert.equal(paused.id, saved.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.at, saved.at);
  f.setNow(saved.at + 1000);
  assert.deepEqual(f.scheduler.tick(), []);
  assert.throws(() => f.scheduler.save({ id: saved.id, enabled: true }), /future/);
  const updated = f.scheduler.save({
    id: saved.id,
    text: 'Use the changed instruction',
    at: saved.at + 5000,
    enabled: true,
  });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.status, 'pending');
  assert.equal(updated.text, 'Use the changed instruction');
  assert.equal(f.enqueued.length, 0);
  assert.equal(f.store.state.schedules.length, 1);
  assert.equal(f.scheduler.remove(saved.id).deleted, true);
  assert.equal(f.store.state.schedules.length, 0);
  assert.throws(
    () => f.scheduler.get(saved.id),
    (error) => isRecord(error) && error.status === 404,
  );
});

test('due jobs wait for VM, both call providers, human control and unresolved shared RPC ownership', (t) => {
  const blockers: Array<(f: Fixture<ScheduleEngine>) => unknown> = [
    (f: Fixture<ScheduleEngine>) => (f.worker.status = 'offline'),
    (f: Fixture<ScheduleEngine>) =>
      (f.engine.call = engineCallFixture({ provider: 'subscription' })),
    (f: Fixture<ScheduleEngine>) => (f.engine.call = engineCallFixture({ provider: 'api' })),
    (f: Fixture<ScheduleEngine>) => (f.engine.takeover = true),
    (f: Fixture<ScheduleEngine>) => (f.engine.acquiring = true),
    (f: Fixture<ScheduleEngine>) => (f.engine.pendingFollowups = new Map([['pending', {}]])),
    (f: Fixture<ScheduleEngine>) => (f.engine.callReferences = new Map([['pending', {}]])),
    (f: Fixture<ScheduleEngine>) => (f.engine.referencePending = 1),
    (f: Fixture<ScheduleEngine>) => (f.engine.nativeVoice = { session: { unknown: true } }),
    (f: Fixture<ScheduleEngine>) => (f.engine.nativeVoice = { session: { submitting: {} } }),
    (f: Fixture<ScheduleEngine>) => (f.engine.nativeVoice = { session: { stopping: true } }),
    (f: Fixture<ScheduleEngine>) => (f.engine.nativeVoice = { session: { pausing: true } }),
    (f: Fixture<ScheduleEngine>) =>
      (f.engine.active = activeTaskFixture({ steerUnconfirmed: true })),
  ];
  for (const block of blockers) {
    const f = fixture(t),
      saved = f.scheduler.save(job());
    f.setNow(saved.at + 1);
    block(f);
    assert.deepEqual(f.scheduler.tick(), []);
    assert.equal(defined(f.store.state.schedules[0]).status, 'pending');
    assert.equal(f.store.state.messages.length, 0);
    assert.equal(f.enqueued.length, 0);
  }
});

test('due claim and stable message ID are durable before enqueue and cannot dispatch twice after restart', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(job());
  f.setNow(saved.at + 1);
  let disk!: {
    schedules: import('../../src/schedules/schedule-types.ts').ScheduleRecord[];
    messages: ChatMessage[];
  };
  f.engine.enqueue = (message) => {
    disk = JSON.parse(fs.readFileSync(f.store.file, 'utf8'));
    f.enqueued.push({ message, options: undefined });
  };
  const result = f.scheduler.tick();
  assert.equal(result.length, 1);
  assert.equal(defined(defined(disk).schedules[0]).status, 'dispatched');
  assert.equal(
    defined(defined(disk).schedules[0]).messageId,
    defined(defined(disk).messages[0]).id,
  );
  assert.equal(defined(defined(disk).messages[0]).scheduled, true);
  assert.equal(defined(defined(disk).messages[0]).scheduleId, saved.id);
  assert.equal(defined(defined(disk).messages[0]).text, saved.text);
  assert.equal(f.scheduler.tick().length, 0);
  const restored = new Store(f.dir),
    again = [];
  const restarted = new Scheduler({
    store: restored,
    engine: { worker: f.worker, change() {}, enqueue: (message) => again.push(message) },
    worker: f.worker,
    now: () => saved.at + 10000,
  });
  assert.equal(restarted.tick().length, 0);
  assert.equal(again.length, 0);
  assert.equal(defined(restored.state.messages[0]).status, 'paused');
  assert.equal(defined(restored.state.messages[0]).id, defined(defined(disk).messages[0]).id);
  restarted.close();
});

test('a schedule never automatically answers a current background blocker or opts into interactive steering', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(job());
  f.engine.nativeVoice = {
    session: { background: true },
    acceptsChatInput: true,
    acceptsInteractiveChatInput: true,
  };
  f.engine.active = activeTaskFixture({ awaitingChatInput: true, startAcknowledged: true });
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  assert.equal(f.enqueued.length, 1);
  assert.equal(defined(f.enqueued[0]).options, undefined);
  assert.equal(defined(f.enqueued[0]).message.scheduled, true);
});

test('an enqueue failure after a durable due claim does not replay the job or lose its resumable message', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(job());
  f.setNow(saved.at + 1);
  f.engine.enqueue = () => {
    throw Error('Queue persistence unavailable');
  };
  assert.throws(() => f.scheduler.tick(), /Queue persistence/);
  assert.equal(defined(f.store.state.schedules[0]).status, 'dispatched');
  assert.equal(f.store.state.messages.length, 1);
  assert.deepEqual(f.scheduler.tick(), []);
  const restored = new Store(f.dir);
  assert.equal(defined(restored.state.messages[0]).status, 'paused');
  assert.equal(
    defined(restored.state.schedules[0]).messageId,
    defined(restored.state.messages[0]).id,
  );
});

test('failed schedule saves, deletions and due claims roll back in-memory state before any executor submission', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(job()),
    before = structuredClone(f.store.state),
    save = f.store.save;
  f.store.save = () => {
    throw Error('Disk full');
  };
  assert.throws(() => f.scheduler.save({ id: saved.id, text: 'Unsaved change' }), /Disk full/);
  assert.deepEqual(f.store.state, before);
  assert.throws(() => f.scheduler.remove(saved.id), /Disk full/);
  assert.deepEqual(f.store.state, before);
  f.setNow(saved.at + 1);
  assert.throws(() => f.scheduler.tick(), /Disk full/);
  assert.deepEqual(f.store.state, before);
  assert.equal(f.enqueued.length, 0);
  f.store.save = save;
  assert.equal(f.scheduler.tick().length, 1);
  assert.equal(f.enqueued.length, 1);
});

test('rescheduling a dispatched item preserves prior execution history and clears stale current execution fields', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(job());
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  const first = f.scheduler.get(saved.id);
  assert.equal(first.status, 'dispatched');
  assert.throws(() => f.scheduler.save({ id: saved.id, enabled: false }), /already dispatched/);
  const next = f.scheduler.save({ id: saved.id, at: saved.at + 5000 });
  assert.equal(next.status, 'pending');
  assert.equal(next.messageId, undefined);
  assert.equal(next.dispatchedAt, undefined);
  assert.equal(next.taskStatus, undefined);
  assert.equal(defined(defined(next.runHistory)[0]).messageId, first.messageId);
  assert.equal(f.store.state.messages.length, 1);
  const deleted = f.scheduler.remove(saved.id);
  assert.equal(deleted.executionContinues, undefined);
  assert.equal(f.store.state.messages.length, 1);
});

test('UI creation retries use one stable request ID across edits, dispatch and restart and reject changed or deleted attempts', (t) => {
  const f = fixture(t),
    clientRequestId = randomUUID(),
    args = job({ at: Date.parse(ISO), clientRequestId }),
    saved = f.scheduler.save(args);
  assert.equal(f.scheduler.save(args).id, saved.id);
  assert.equal(f.store.state.schedules.length, 1);
  assert.equal('creationFingerprint' in saved ? saved.creationFingerprint : undefined, undefined);
  assert.throws(
    () => f.scheduler.save({ ...args, text: 'Different task' }),
    (error) => isRecord(error) && error.status === 409,
  );
  f.scheduler.save({ id: saved.id, text: 'Later user edit' });
  assert.equal(f.scheduler.save(args).text, 'Later user edit');
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  assert.equal(f.scheduler.save(args).status, 'dispatched');
  assert.equal(f.store.state.messages.length, 1);
  const restored = new Store(f.dir),
    next = new Scheduler({
      store: restored,
      engine: { worker: f.worker, change() {}, enqueue() {} },
      now: () => saved.at + 1000,
    });
  assert.equal(next.save(args).id, saved.id);
  next.remove(saved.id);
  assert.throws(
    () => next.save(args),
    (error) => isRecord(error) && error.status === 409,
  );
  next.close();
});

test('a deleted creation request cannot resurrect after more than two thousand later deletions', (t) => {
  const f = fixture(t),
    clientRequestId = randomUUID(),
    args = job({ at: Date.parse(ISO), clientRequestId }),
    saved = f.scheduler.save(args);
  f.scheduler.remove(saved.id);
  const oldest = defined(f.store.state.deletedScheduleRequestIds)[0];
  defined(f.store.state.deletedScheduleRequestIds).push(
    ...Array.from({ length: 2000 }, () => randomUUID()),
  );
  const latest = f.scheduler.save(job({ at: Date.parse(ISO), clientRequestId: randomUUID() }));
  f.scheduler.remove(latest.id);
  assert.equal(defined(f.store.state.deletedScheduleRequestIds).length, 2002);
  assert.equal(defined(f.store.state.deletedScheduleRequestIds)[0], oldest);
  assert.throws(
    () => f.scheduler.save(args),
    (error) => isRecord(error) && error.status === 409,
  );
  const restored = new Store(f.dir),
    again = new Scheduler({
      store: restored,
      engine: { worker: f.worker, change() {}, enqueue() {} },
      now: () => NOW,
    });
  assert.throws(
    () => again.save(args),
    (error) => isRecord(error) && error.status === 409,
  );
  again.close();
  assert.equal(restored.state.schedules.length, 0);
});

test('a queued scheduled job waits through a later API call and canonical references before starting exactly once after hangup', async (t) => {
  const f = fixture(t, { realEngine: true }),
    tick = () => new Promise((resolve) => setImmediate(resolve));
  acknowledge(f);
  f.engine.loaded = true;
  Object.assign(f.store.state, {
    threadId: 'thread',
    threadRuntime: f.engine.runtimeId,
    threadConversationId: f.store.state.conversationId,
  });
  let releaseReference!: (result: RpcResult) => void;
  f.worker.request = async (method, params) => {
    f.worker.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread', turns: [] } };
    if (method === 'turn/start') return { turn: { id: 'scheduled-after-call' } };
    if (method === 'thread/inject_items')
      return new Promise((resolve) => (releaseReference = resolve));
    return {};
  };
  f.engine.voice = {
    start: async () => ({ sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }),
    stop: async () => {},
  };
  const saved = f.scheduler.save(job());
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  assert.equal(f.engine.queue.length, 1);
  const call = await f.engine.startCall('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', {
    provider: 'api',
  });
  f.engine.confirmCallConnected(call.callId);
  await f.engine.finish('completed');
  await tick();
  assert.equal(f.engine.active, null);
  assert.equal(f.engine.queue.length, 1);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  const reference = f.engine.injectReference('A completed call context reference');
  await tick();
  assert.equal(typeof releaseReference, 'function');
  await f.engine.stopCall(call.callId);
  await tick();
  assert.equal(f.engine.call, null);
  assert.equal(f.engine.active, null);
  assert.equal(f.engine.queue.length, 1);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  defined(releaseReference)({});
  await reference;
  await tick();
  assert.equal(currentActive(f.engine)?.turnId, 'scheduled-after-call');
  assert.equal(
    defined(currentActive(f.engine)).messageId,
    defined(f.store.state.schedules[0]).messageId,
  );
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/steer'),
    false,
  );
  await f.engine.finish('completed');
  f.scheduler.tick();
  await tick();
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('current API call work can bypass a parked scheduled job without starting or steering that scheduled job', async (t) => {
  const f = fixture(t, { realEngine: true }),
    tick = () => new Promise((resolve) => setImmediate(resolve));
  acknowledge(f);
  f.engine.loaded = true;
  Object.assign(f.store.state, {
    threadId: 'thread',
    threadRuntime: f.engine.runtimeId,
    threadConversationId: f.store.state.conversationId,
  });
  let next = 0;
  f.worker.request = async (method, params) => {
    f.worker.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread', turns: [] } };
    if (method === 'turn/start') return { turn: { id: 'owned-turn-' + ++next } };
    return {};
  };
  f.engine.voice = {
    start: async () => ({ sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }),
    stop: async () => {},
  };
  const saved = f.scheduler.save(job());
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  const queued = f.engine.queue[0],
    call = await f.engine.startCall('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', {
      provider: 'api',
    });
  await f.engine.finish('completed');
  await tick();
  const requested = f.engine.runVoiceTask('Do this work requested during the current call');
  await tick();
  assert.equal(f.engine.active?.voiceOutput, true);
  assert.notEqual(defined(currentActive(f.engine)).messageId, defined(queued).id);
  assert.equal(defined(currentActive(f.engine)).turnId, 'owned-turn-1');
  assert.equal(f.engine.queue[0], queued);
  await f.engine.finish('completed');
  await requested;
  await tick();
  assert.equal(f.engine.active, null);
  assert.equal(f.engine.queue[0], queued);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  await f.engine.stopCall(call.callId);
  await tick();
  assert.equal(currentActive(f.engine)?.messageId, defined(queued).id);
  assert.equal(defined(currentActive(f.engine)).turnId, 'owned-turn-2');
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 2);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/steer'),
    false,
  );
  await f.engine.finish('completed');
});

test('deleting a dispatched schedule preserves the actual queued work and accurately reports that it continues', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(job());
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  const result = f.scheduler.remove(saved.id);
  assert.equal(result.executionContinues, true);
  assert.equal(result.dispatchedMessageId, defined(f.store.state.messages[0]).id);
  assert.equal(f.enqueued.length, 1);
  assert.equal(f.store.state.messages.length, 1);
  assert.equal(f.store.state.schedules.length, 0);
});

function acknowledge(f: Fixture<Engine>) {
  const message = f.store.add({
      role: 'user',
      text: 'Schedule this requested work',
      status: 'running',
    }),
    active = activeTaskFixture({
      startAcknowledged: true,
      turnId: 'owned',
      threadId: 'thread',
      messageId: message.id,
      messageIds: [message.id],
      assistantIds: [],
      outputs: new Map(),
      explicitPaths: [],
      resolveStopped() {},
    });
  f.engine.active = active;
  return active;
}
test('agent schedule tools use the same persistent service and require an actual acknowledged text-task owner', async (t) => {
  const f = fixture(t, { realEngine: true });
  await assert.rejects(f.engine.tool('schedule_list', {}), /current acknowledged/);
  const active = acknowledge(f);
  const result = observedRecord(await f.engine.tool('schedule_save', job()));
  assert.equal(result.saved, true);
  assert.equal(observedRecord(result.item).timeZone, 'Asia/Kuala_Lumpur');
  assert.equal(
    observedRecords(observedRecord(await f.engine.tool('schedule_list', {})).items).length,
    1,
  );
  await f.engine.tool('schedule_save', { id: observedRecord(result.item).id, enabled: false });
  assert.equal(defined(f.store.state.schedules[0]).status, 'paused');
  await assert.rejects(f.engine.tool('schedule_save', job({ at: NOW + 1000 })), /explicit ISO/);
  await assert.rejects(f.engine.tool('schedule_list', { unexpected: true }), /does not accept/);
  await assert.rejects(
    f.engine.tool('schedule_delete', { id: observedRecord(result.item).id, other: true }),
    /Invalid/,
  );
  await assert.rejects(
    f.engine.tool('schedule_save', job(), { owner: 'forged', isCurrent: () => true }),
    /no longer belongs/,
  );
  active.stopRequested = true;
  await assert.rejects(
    f.engine.tool('schedule_delete', { id: observedRecord(result.item).id }),
    /current acknowledged/,
  );
  active.stopRequested = false;
  await f.engine.tool('schedule_delete', { id: observedRecord(result.item).id });
  assert.equal(f.store.state.schedules.length, 0);
  assert.equal(f.store.state.messages.length, 1);
  assert.equal(f.worker.calls.length, 0);
  assert.equal(f.engine.queue.length, 0);
});

test('API voice schedule tools accept only their current confirmed call context and respect control and provider availability', async (t) => {
  const f = fixture(t, { realEngine: true }),
    call = engineCallFixture({ id: 'api-call', provider: 'api', status: 'connected' });
  f.engine.call = call;
  const context = { owner: call.id, callId: call.id, isCurrent: () => true };
  const saved = observedRecord(await f.engine.tool('schedule_save', job(), context));
  assert.equal(saved.saved, true);
  for (const invalid of [
    { ...context, owner: 'stale' },
    { ...context, callId: 'stale' },
    { ...context, isCurrent: () => false },
  ] as const)
    await assert.rejects(f.engine.tool('schedule_list', {}, invalid));
  f.engine.takeover = true;
  await assert.rejects(
    f.engine.tool('schedule_delete', { id: observedRecord(saved.item).id }, context),
  );
  f.engine.takeover = false;
  f.worker.status = 'offline';
  await assert.rejects(f.engine.tool('schedule_list', {}, context));
  f.worker.status = 'online';
  f.engine.call = engineCallFixture({ ...call, id: 'new-call' });
  await assert.rejects(f.engine.tool('schedule_list', {}, context));
  assert.equal(f.store.state.schedules.length, 1);
});

test('native background schedule tools require their exact accepted turn and expose the same tools to API and text providers', async (t) => {
  const f = fixture(t, { realEngine: true }),
    native = new NativeRealtimeVoice({ worker: f.worker, engine: f.engine }),
    turn = nativeTurnFixture({
      turnId: 'native-owned',
      done: false,
      explicitMessageIds: [],
      assistantIds: [],
    }),
    session = nativeSessionFixture({
      id: 'native-call',
      status: 'connected',
      threadId: 'thread',
      turns: new Map([[turn.turnId, turn]]),
      handoffs: new Map(),
      background: false,
    });
  native.session = session;
  f.engine.call = engineCallFixture({
    id: session.id,
    provider: 'subscription',
    status: 'connected',
  });
  const saved = observedRecord(await native.tool(session, turn, 'schedule_save', job()));
  assert.equal(saved.saved, true);
  assert.equal(
    defined(
      observedRecords(
        observedRecord(await native.tool(session, turn, 'schedule_list', {})).items,
      )[0],
    ).id,
    observedRecord(saved.item).id,
  );
  turn.done = true;
  await assert.rejects(
    native.tool(session, turn, 'schedule_delete', { id: observedRecord(saved.item).id }),
    /no longer belongs/,
  );
  for (const name of ['schedule_list', 'schedule_save', 'schedule_delete'] as const) {
    assert.ok(dynamicTools.find((tool) => tool.name === name));
    assert.ok(VOICE_TOOLS.find((tool) => tool.name === name));
  }
  assert.equal(f.store.state.schedules.length, 1);
  assert.match(f.engine.instructions(), /For a recurring task provide cron as five fields/);
});

const recurring = (extra = {}) => ({
  text: 'Run the requested recurring check',
  cron: '0 9 * * *',
  ...extra,
});
function finishScheduled(
  f: Fixture<ScheduleEngine>,
  maybeMessage: ChatMessage | undefined,
  status: import('../../src/contracts/states.mts').TaskStatusValue = 'review',
) {
  const message = defined(maybeMessage);
  f.engine.queue = f.engine.queue.filter((item) => item.id !== message.id);
  f.store.update(message.id, { status, submission: 'confirmed' });
}

test('recurring schedules use settings timezone, retain cron and priority, and saving submits nothing', (t) => {
  const f = fixture(t);
  f.store.state.settings.timeZone = 'Asia/Kuala_Lumpur';
  const saved = f.scheduler.save(recurring({ priority: 'high' }), { allowEpoch: false });
  assert.equal(saved.at, Date.parse(ISO));
  assert.equal(saved.timeZone, 'Asia/Kuala_Lumpur');
  assert.equal(saved.cron, '0 9 * * *');
  assert.equal(saved.priority, 'high');
  assert.equal(saved.status, 'pending');
  assert.equal(saved.enabled, true);
  assert.equal(f.store.state.messages.length, 0);
  assert.equal(f.enqueued.length, 0);
  const restored = new Store(f.dir);
  assert.equal(defined(restored.state.schedules[0]).cron, saved.cron);
  assert.equal(defined(restored.state.schedules[0]).priority, 'high');
  const before = structuredClone(f.store.state);
  for (const args of [
    recurring({ at: ISO }),
    recurring({ cron: '@daily' }),
    recurring({ cron: '0 0 31 2 *' }),
    recurring({ priority: 'urgent' }),
    recurring({ timeZone: 'Invalid/Zone' }),
    recurring({ cron: undefined }),
  ] as const)
    assert.throws(
      () => f.scheduler.save(args, { allowEpoch: false }),
      (error) => isRecord(error) && error.status === 400,
    );
  assert.deepEqual(f.store.state, before);
});

test('recurring pause/resume and conversion preserve the ID without replaying missed paused occurrences', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(recurring({ timeZone: 'Asia/Kuala_Lumpur' }));
  const paused = f.scheduler.save({ id: saved.id, enabled: false });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.cron, saved.cron);
  f.setNow(saved.at + 8 * 86400000 + 1000);
  assert.deepEqual(f.scheduler.tick(), []);
  const resumed = f.scheduler.save({ id: saved.id, enabled: true });
  assert.equal(resumed.id, saved.id);
  assert.ok(resumed.at > saved.at + 8 * 86400000 + 1000);
  assert.equal(f.enqueued.length, 0);
  const changed = f.scheduler.save({
    id: saved.id,
    text: 'Updated recurring instruction',
    priority: 'low',
  });
  assert.equal(changed.cron, saved.cron);
  assert.equal(changed.at, resumed.at);
  assert.equal(changed.priority, 'low');
  assert.throws(() => f.scheduler.save({ id: saved.id, cron: null }), /future execution/);
  const once = f.scheduler.save({ id: saved.id, cron: null, at: resumed.at + 1000 });
  assert.equal(once.cron, null);
  assert.equal(once.id, saved.id);
});

test('offline missed recurring times dispatch once and advance directly beyond the actual current time', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(recurring({ timeZone: 'UTC' })),
    later = saved.at + 35 * 86400000 + 1000;
  f.setNow(later);
  f.worker.status = 'offline';
  assert.deepEqual(f.scheduler.tick(), []);
  f.worker.status = 'online';
  const result = f.scheduler.tick();
  assert.equal(result.length, 1);
  assert.equal(f.enqueued.length, 1);
  assert.equal(defined(result[0]).status, 'pending');
  assert.equal(defined(result[0]).enabled, true);
  assert.ok(defined(result[0]).at > later);
  assert.equal(defined(result[0]).lastRunAt, saved.at);
  assert.equal(defined(f.store.state.messages[0]).scheduleId, saved.id);
  assert.equal(defined(f.store.state.messages[0]).scheduledAt, saved.at);
  assert.deepEqual(f.scheduler.tick(), []);
});

test('an unfinished recurring occurrence blocks later times even if its chat turn finished', (t) => {
  for (const status of [
    'running',
    'continuing',
    'waiting_user',
    'paused',
    'pausing',
    'unknown',
  ] as const) {
    const f = fixture(t),
      saved = f.scheduler.save(recurring({ cron: '* * * * *', timeZone: 'UTC' }));
    f.setNow(saved.at + 1);
    f.scheduler.tick();
    const message = f.store.state.messages[0];
    finishScheduled(f, message);
    f.store.update(defined(message).id, { turnId: 'original-turn' });
    const work = f.store.registerWork({
      turnId: 'original-turn',
      messageId: defined(message).id,
      source: 'chat',
      title: 'Complete this scheduled run',
      plan: { steps: [{ step: 'Verify the result', status: 'pending' }] },
    });
    f.store.updateRegisteredWork('original-turn', { status, executionEnded: true });
    f.setNow(defined(f.store.state.schedules[0]).at + 1);
    assert.deepEqual(f.scheduler.tick(), [], status);
    assert.equal(f.enqueued.length, 1);
    assert.equal(f.scheduler.get(saved.id).id, saved.id);
    f.store.updateRegisteredWork(work.turnId, { status: 'review', executionEnded: true });
    assert.equal(
      f.scheduler.tick().length,
      1,
      status + ' releases only after terminal registered work',
    );
    assert.equal(f.enqueued.length, 2);
  }
});

test('recurring claims and messages are durable before enqueue and do not duplicate after restart', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(recurring({ cron: '* * * * *', timeZone: 'UTC' }));
  f.setNow(saved.at + 1);
  let disk!: {
    schedules: import('../../src/schedules/schedule-types.ts').ScheduleRecord[];
    messages: ChatMessage[];
  };
  f.engine.enqueue = (message) => {
    disk = JSON.parse(fs.readFileSync(f.store.file, 'utf8'));
    f.enqueued.push({ message, options: undefined });
  };
  f.scheduler.tick();
  assert.equal(defined(defined(disk).schedules[0]).status, 'pending');
  assert.ok(defined(defined(disk).schedules[0]).at > saved.at + 1);
  assert.equal(
    defined(defined(disk).schedules[0]).messageId,
    defined(defined(disk).messages[0]).id,
  );
  const restored = new Store(f.dir),
    again = [],
    next = new Scheduler({
      store: restored,
      engine: {
        worker: f.worker,
        queue: [],
        change() {},
        enqueue: (message) => again.push(message),
      },
      worker: f.worker,
      now: () => defined(defined(disk).schedules[0]).at + 60000,
    });
  assert.equal(defined(restored.state.messages[0]).status, 'paused');
  assert.deepEqual(next.tick(), []);
  assert.equal(again.length, 0);
  next.close();
});

test('known terminal receipts allow chat cleanup while an ambiguous missing current run remains blocked', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(recurring({ cron: '* * * * *', timeZone: 'UTC' }));
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  const first = f.store.state.messages[0];
  finishScheduled(f, first);
  assert.deepEqual(f.scheduler.tick(), []);
  let current = f.store.state.schedules[0];
  assert.equal(
    defined(defined(defined(current).runHistory).find((run) => run.messageId === defined(first).id))
      .terminalStatus,
    'review',
  );
  f.store.state.messages = [];
  f.store.save();
  f.setNow(defined(current).at + 1);
  assert.equal(f.scheduler.tick().length, 1, 'verified prior message may be removed');
  current = f.store.state.schedules[0];
  const second = f.store.state.messages[0];
  assert.equal(defined(second).id, defined(current).messageId);
  f.engine.queue = [];
  f.store.state.messages = [];
  f.store.save();
  f.setNow(defined(current).at + 60000);
  assert.deepEqual(f.scheduler.tick(), [], 'missing latest claim has no terminal receipt');
  assert.equal(f.enqueued.length, 2);
});

test('a terminal receipt does not hide a related registered task that later becomes unfinished', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(recurring({ cron: '* * * * *', timeZone: 'UTC' }));
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  const message = f.store.state.messages[0];
  finishScheduled(f, message);
  f.store.update(defined(message).id, { turnId: 'old-turn' });
  const work = f.store.registerWork({
    turnId: 'old-turn',
    messageId: defined(message).id,
    source: 'chat',
    title: 'Verify scheduled work',
    plan: { steps: [{ step: 'Verify result', status: 'completed' }] },
  });
  f.store.updateRegisteredWork(work.turnId, { status: 'review', executionEnded: true });
  f.scheduler.tick();
  f.store.state.messages = [];
  f.store.registerWork({
    workId: work.id,
    turnId: 'new-turn',
    messageId: defined(message).id,
    source: 'chat',
    title: 'Recheck scheduled work',
    plan: { steps: [{ step: 'Recheck result', status: 'pending' }] },
  });
  f.store.updateRegisteredWork('new-turn', { status: 'waiting_user', executionEnded: true });
  f.setNow(defined(f.store.state.schedules[0]).at + 1);
  assert.deepEqual(f.scheduler.tick(), []);
  assert.equal(f.enqueued.length, 1);
});

test('terminal receipts retain work and turn ownership when a scheduled run reused older human work', (t) => {
  const f = fixture(t),
    human = f.store.add({
      role: 'user',
      text: 'Original entrusted work',
      turnId: 'human-turn',
      status: 'review',
    }),
    work = f.store.registerWork({
      turnId: 'human-turn',
      messageId: human.id,
      source: 'chat',
      title: 'Existing shared work',
      plan: { steps: [{ step: 'Verify result', status: 'completed' }] },
    });
  f.store.updateRegisteredWork('human-turn', { status: 'review', executionEnded: true });
  const saved = f.scheduler.save(recurring({ cron: '* * * * *', timeZone: 'UTC' }));
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  const message = f.store.state.messages.find((message) => message.scheduleId === saved.id);
  finishScheduled(f, message);
  f.store.update(defined(message).id, { turnId: 'scheduled-turn', workId: work.id });
  f.store.registerWork({
    workId: work.id,
    turnId: 'scheduled-turn',
    messageId: defined(message).id,
    source: 'chat',
    title: 'Existing shared work',
    plan: { steps: [{ step: 'Verify result', status: 'completed' }] },
  });
  f.store.updateRegisteredWork('scheduled-turn', { status: 'review', executionEnded: true });
  f.scheduler.tick();
  const receipt = defined(defined(f.store.state.schedules[0]).runHistory).find(
    (run) => run.messageId === defined(message).id,
  );
  assert.equal(defined(receipt).workId, work.id);
  assert.equal(defined(receipt).turnId, 'scheduled-turn');
  assert.equal(defined(f.store.state.workTasks[0]).messageId, human.id);
  f.store.state.messages = f.store.state.messages.filter((item) => item.id !== defined(message).id);
  f.store.registerWork({
    workId: work.id,
    turnId: 'new-answer-turn',
    source: 'chat',
    title: 'Existing shared work',
    plan: { steps: [{ step: 'Wait for the requested account', status: 'pending' }] },
  });
  f.store.updateRegisteredWork('new-answer-turn', { status: 'waiting_user', executionEnded: true });
  f.setNow(defined(f.store.state.schedules[0]).at + 1);
  assert.deepEqual(f.scheduler.tick(), []);
  assert.equal(f.enqueued.length, 1);
});

test('due scheduled runs are queued by priority without interrupting current work', (t) => {
  const f = fixture(t),
    at = NOW + 1000;
  for (const priority of ['low', 'high', 'normal'] as const)
    f.scheduler.save({ text: priority, at, priority });
  const owner = { messageId: 'unrelated-current' };
  f.engine.active = owner;
  f.setNow(at + 1);
  f.scheduler.tick();
  assert.deepEqual(
    f.enqueued.map((item) => item.message.text),
    ['high', 'normal', 'low'],
  );
  assert.deepEqual(
    f.enqueued.map((item) => item.message.progressPriority),
    ['high', 'normal', 'low'],
  );
  assert.equal(f.engine.active, owner);
  assert.equal(f.worker.calls.length, 0);
});

test('priority edits atomically update queued occurrences but preserve a running owner', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(recurring({ cron: '* * * * *', timeZone: 'UTC', priority: 'low' }));
  f.setNow(saved.at + 1);
  f.scheduler.tick();
  const queued = f.store.state.messages[0];
  assert.equal(f.engine.queue[0], queued);
  f.scheduler.save({ id: saved.id, priority: 'high' });
  assert.equal(defined(queued).progressPriority, 'high');
  assert.equal(defined(new Store(f.dir).state.messages[0]).progressPriority, 'high');
  const save = f.store.save;
  f.store.save = () => {
    throw Error('Disk full');
  };
  assert.throws(() => f.scheduler.save({ id: saved.id, priority: 'low' }), /Disk full/);
  assert.equal(defined(queued).progressPriority, 'high');
  assert.equal(f.scheduler.get(saved.id).priority, 'high');
  f.store.save = save;
  f.store.update(defined(queued).id, { status: 'running' });
  f.engine.active = activeTaskFixture({ messageId: defined(queued).id });
  f.scheduler.save({ id: saved.id, priority: 'low' });
  assert.equal(defined(queued).progressPriority, 'high');
  assert.equal(defined(currentActive(f.engine)).messageId, defined(queued).id);
  assert.equal(f.worker.calls.length, 0);
});

test('recurring creation receipts ignore derived next times and legacy one-time retry receipts remain valid', (t) => {
  const f = fixture(t),
    clientRequestId = randomUUID(),
    args = recurring({ timeZone: 'UTC', clientRequestId }),
    saved = f.scheduler.save(args);
  f.setNow(saved.at + 3 * 86400000);
  assert.equal(f.scheduler.save(args).id, saved.id);
  assert.equal(f.store.state.schedules.length, 1);
  assert.throws(
    () => f.scheduler.save({ ...args, priority: 'high' }),
    (error) => isRecord(error) && error.status === 409,
  );
  const legacy = fixture(t),
    oldArgs = job({ clientRequestId: randomUUID() }),
    old = legacy.scheduler.save(oldArgs),
    raw = legacy.store.state.schedules[0];
  defined(raw).creationFingerprint = createHash('sha256')
    .update(JSON.stringify({ text: old.text, at: old.at, timeZone: old.timeZone, enabled: true }))
    .digest('hex');
  legacy.store.save();
  legacy.setNow(old.at + 1000);
  assert.equal(legacy.scheduler.save({ ...oldArgs, cron: null, priority: 'normal' }).id, old.id);
  assert.throws(
    () => legacy.scheduler.save({ ...oldArgs, priority: 'high' }),
    (error) => isRecord(error) && error.status === 409,
  );
});

test('recurring write failures keep the original due time and never create a second ambiguous occurrence', (t) => {
  const f = fixture(t),
    saved = f.scheduler.save(recurring({ cron: '* * * * *', timeZone: 'UTC' })),
    before = structuredClone(f.store.state),
    save = f.store.save;
  f.setNow(saved.at + 1);
  f.store.save = () => {
    throw Error('Disk unavailable');
  };
  assert.throws(() => f.scheduler.tick(), /Disk unavailable/);
  assert.deepEqual(f.store.state, before);
  assert.equal(f.enqueued.length, 0);
  f.store.save = save;
  f.engine.enqueue = () => {
    throw Error('Queue unavailable');
  };
  assert.throws(() => f.scheduler.tick(), /Queue unavailable/);
  assert.equal(f.store.state.messages.length, 1);
  assert.ok(defined(f.store.state.schedules[0]).at > saved.at + 1);
  f.setNow(defined(f.store.state.schedules[0]).at + 60000);
  assert.deepEqual(f.scheduler.tick(), []);
  assert.equal(f.store.state.messages.length, 1);
});

function currentActive(engine: {
  active?: { messageId?: string | null; turnId?: string | null } | null;
}) {
  return engine.active;
}
