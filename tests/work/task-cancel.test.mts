import { observedRecords } from '../support/service-fixtures.mts';
import { activeTaskFixture, deliveredMessageId } from '../support/service-fixtures.mts';
import { NativeVoiceFixture } from '../support/native-service-fixtures.mts';
import type { EngineVoice, EngineCredentials } from '../../src/work/engine.mts';
import { VoiceFixture } from '../support/protocol-fixtures.mts';
import { CredentialFixture } from '../support/engine-service-fixtures.mts';
import {
  WorkerServiceFixture,
  engineCallFixture,
  listeningPort,
  observedRecord,
} from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import type { ExecutionTask } from '../../src/work/engine-types.ts';
import { isRecord } from '../../src/contracts/json.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';
import { createWorkerApp } from '../../src/app/server.mts';
import { CredentialRequests, CredentialVault } from '../../src/security/credentials.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
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
  constructor(dir: string) {
    super();
    this.status = 'online';
    this.runtimeId = 'vm:cancel:test';
    this.workspaceRoot = path.join(dir, 'workspaces');
    this.desktopPath = path.join(dir, 'desktop.py');
    this.calls = [];
    this.responses = [];
    this.nextTurn = 0;
    this.autoInterrupt = false;
    this.rpc = {
      send: (value) => this.responses.push(value),
      reply: (id, result) => this.responses.push({ id, result }),
    };
  }
  async request(method: string, params?: RpcParams): Promise<RpcResult> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++this.nextTurn } };
    if (method === 'turn/interrupt' && this.autoInterrupt)
      queueMicrotask(() => this.emit('event', completed(defined(params?.turnId), 'interrupted')));
    if (method === 'thread/realtime/start')
      queueMicrotask(() => {
        this.emit(
          'event',
          event('thread/realtime/started', {
            version: 'v3',
            realtimeSessionId: 'rt-' + params?.voiceSessionId,
          }),
        );
        this.emit('event', event('thread/realtime/sdp', { sdp }));
      });
    if (method === 'thread/realtime/stop')
      queueMicrotask(() => this.emit('event', event('thread/realtime/closed')));
    if (method === 'thread/read') {
      const turns = [...(defined(this.engine?.nativeVoice?.session?.turns).values() || [])].map(
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
  disconnect() {
    this.status = 'offline';
    this.emit('status');
  }
  async terminateConfirmed(): Promise<never> {
    throw Error('Single-task cancellation must not kill the executor');
  }
}
const event = (method: string, params: RpcParams = {}) => ({
  method,
  params: { threadId: 'thread', ...params },
});
const completed = (id: string | null | undefined, status = 'completed') =>
  event('turn/completed', { turn: { id: defined(id), status } });
function fixture(
  t: NodeTestContext,
  {
    native = false,
    secure = false,
    ...options
  }: NonNullable<ConstructorParameters<typeof Engine>[2]> & {
    native?: boolean;
    secure?: boolean;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(base, 'task-cancel-')),
    store = new Store(dir),
    worker = new Worker(dir),
    credentials = secure
      ? new CredentialRequests({ vault: new CredentialVault({ dataDir: dir }), timeoutMs: 1000 })
      : undefined,
    engine = new Engine(store, worker, { ...options, ...(credentials ? { credentials } : {}) });
  worker.engine = engine;
  store.state.settings.language = 'en';
  const voice = native
    ? new NativeRealtimeVoice({ worker, engine, connectTimeoutMs: 1000, stopTimeoutMs: 100 })
    : null;
  t.after(() => {
    credentials?.close();
    clearTimeout(engine.streamingSaveTimer ?? undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, worker, engine, voice, credentials };
}
function plan(
  f: Pick<ReturnType<typeof fixture>, 'engine' | 'store'>,
  owner: ExecutionTask | null = f.engine.active,
) {
  f.engine.observeRegisteredPlan(defined(owner), [
    { step: 'Build the requested output', status: 'inProgress' },
    { step: 'Verify it', status: 'pending' },
  ]);
  return f.store.state.workTasks.find((item) => item.turnId === defined(owner).turnId);
}
async function start(f: { store: Store; engine: Engine }, text = 'Keep my work') {
  const message = f.store.add({ role: 'user', text });
  f.engine.enqueue(message);
  await tick();
  return message;
}

test('explicit cancellation waits for its exact terminal event, retains results, and does not drain the unrelated queue', async (t) => {
  const f = fixture(t),
    message = await start(f),
    active = f.engine.active,
    record = plan(f);
  f.store.setProgressPriority(defined(record).id, 'work', 'high');
  const output = f.engine.deliverText('Partial useful result', active),
    queued = f.store.add({ role: 'user', text: 'Unrelated next task' });
  f.engine.enqueue(queued);
  let settled = false;
  const stopping = Promise.resolve(
    f.engine.cancelProgress(defined(record).id, 'work', { turnId: defined(active).turnId }),
  ).then((result) => {
    settled = true;
    return result;
  });
  await tick();
  assert.equal(settled, false);
  assert.equal(message.status, 'pausing');
  assert.equal(defined(f.engine.progress).status, 'pausing');
  assert.equal(queued.status, 'queued');
  assert.equal(f.engine.queue[0], queued);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  await f.engine.handle(
    event('turn/completed', {
      threadId: 'foreign',
      turn: { id: defined(defined(active).turnId), status: 'interrupted' },
    }),
  );
  assert.equal(settled, false);
  await f.engine.handle(completed(defined(active).turnId, 'interrupted'));
  assert.deepEqual(await stopping, { ok: true, cancelled: true });
  await tick();
  assert.equal(message.status, 'cancelled');
  assert.equal(defined(f.store.state.workTasks[0]).status, 'cancelled');
  assert.equal(defined(f.store.state.workTasks[0]).progressPriority, 'high');
  assert.equal(
    defined(defined(defined(f.store.state.workTasks[0]).plan).steps[0]).status,
    'inProgress',
  );
  assert.equal(
    defined(f.store.state.messages.find((item) => item.id === deliveredMessageId(output))).text,
    'Partial useful result',
  );
  assert.equal(defined(f.engine.active).messageId, queued.id);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
  const restored = new Store(f.dir),
    cancelled = restored.state.workTasks[0];
  assert.equal(defined(cancelled).status, 'cancelled');
  assert.ok(defined(cancelled).cancelledAt);
  assert.ok(defined(cancelled).executionEndedAt);
  assert.equal(defined(restored.state.messages[0]).status, 'cancelled');
  assert.throws(() => f.engine.resumePaused([message.id]), /cannot be resumed/);
  assert.throws(
    () =>
      restored.registerWork({
        workId: defined(cancelled).id,
        turnId: 'another-turn',
        source: 'chat',
        title: 'Reopen',
        plan: defined(cancelled).plan,
      }),
    (error) => observedRecord(error).code === 'work_not_continuable',
  );
  assert.throws(
    () =>
      restored.registerWork({
        workId: defined(cancelled).id,
        turnId: defined(cancelled).turnId,
        source: 'chat',
        title: 'Reopen',
        plan: defined(cancelled).plan,
      }),
    (error) => observedRecord(error).code === 'work_not_continuable',
  );
  assert.throws(
    () => restored.updateRegisteredWork(defined(cancelled).turnId, { status: 'running' }),
    (error) => observedRecord(error).code === 'work_not_continuable',
  );
  assert.deepEqual(
    await f.engine.cancelProgress(defined(record).id, 'work', { turnId: defined(active).turnId }),
    {
      ok: true,
      cancelled: true,
    },
  );
  assert.equal(defined(f.engine.active).messageId, queued.id);
});

test('preparation cancellation aborts unsent audio work and persists cancelled without a turn submission', async (t) => {
  const f = fixture(t, {
      audioTranscriber: {
        transcribe: async (_file, { signal } = {}) =>
          new Promise((_resolve, reject) =>
            defined(signal).addEventListener('abort', () => reject(Error('Recognition aborted')), {
              once: true,
            }),
          ),
      },
    }),
    message = f.store.add({
      role: 'user',
      text: '',
      attachments: [{ id: 'audio', type: 'audio/webm', guestPath: '/audio.webm' }],
    });
  f.engine.enqueue(message);
  await tick();
  assert.equal(defined(f.engine.active).turnId, null);
  assert.deepEqual(await f.engine.cancelProgress(message.id, 'task', { turnId: null }), {
    ok: true,
    cancelled: true,
  });
  assert.equal(message.status, 'cancelled');
  assert.equal(f.engine.active, null);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.equal(defined(new Store(f.dir).state.messages[0]).status, 'cancelled');
});

test('unknown turn submission is never reported cancelled or replayed', async (t) => {
  const f = fixture(t),
    request = f.worker.request.bind(f.worker);
  let rejectStart!: (error: unknown) => void;
  f.worker.request = (method, params) =>
    method === 'turn/start'
      ? new Promise((_resolve, reject) => (rejectStart = reject))
      : request(method, params);
  const message = await start(f);
  assert.equal(message.submission, 'submitting');
  const stopping = f.engine.cancelProgress(message.id, 'task', { turnId: null });
  rejectStart(Error('Acknowledgement lost'));
  await assert.rejects(
    async () => await stopping,
    (error) => isRecord(error) && error.status === 409,
  );
  assert.equal(message.status, 'paused');
  assert.equal(message.submission, 'unknown');
  assert.equal(f.engine.queue.length, 0);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/interrupt'),
    false,
  );
});

test('unconfirmed interruption remains visible until a late matching stop confirms cancellation', async (t) => {
  const f = fixture(t),
    message = await start(f),
    active = f.engine.active,
    record = plan(f);
  f.engine.waitStopped = async (owner) => {
    await f.engine.interrupt(activeTaskFixture({ ...defined(owner) }));
    throw Error('Stop acknowledgement timed out');
  };
  await assert.rejects(
    async () =>
      await f.engine.cancelProgress(defined(record).id, 'work', { turnId: defined(active).turnId }),
    (error) =>
      isRecord(error) && error.status === 409 && observedRecord(error).unknownOutcome === true,
  );
  assert.equal(defined(f.engine.progress).status, 'unknown');
  assert.notEqual(message.status, 'cancelled');
  assert.notEqual(defined(f.store.state.workTasks[0]).status, 'cancelled');
  assert.equal(f.engine.active, active);
  await f.engine.handle(completed(defined(active).turnId, 'interrupted'));
  assert.equal(message.status, 'cancelled');
  assert.equal(defined(f.store.state.workTasks[0]).status, 'cancelled');
  assert.equal(f.engine.active, null);
});

test('natural completion winning a cancellation race remains a result for review', async (t) => {
  const f = fixture(t),
    message = await start(f),
    active = f.engine.active;
  const stopping = f.engine.cancelProgress(message.id, 'task', { turnId: defined(active).turnId });
  await tick();
  await f.engine.handle(completed(defined(active).turnId));
  await assert.rejects(
    async () => await stopping,
    (error) => isRecord(error) && error.status === 409,
  );
  assert.equal(message.status, 'review');
  assert.equal(f.engine.active, null);
});

test('inactive unfinished plans cancel atomically without interrupting unrelated work or accepting results', async (t) => {
  const f = fixture(t),
    message = await start(f),
    other = f.engine.active,
    old = f.store.add({
      role: 'user',
      text: 'Old entrusted task',
      turnId: 'old-turn',
      status: 'review',
    }),
    record = f.store.registerWork({
      turnId: 'old-turn',
      messageId: old.id,
      source: 'chat',
      title: 'Old entrusted task',
      plan: { steps: [{ step: 'Unfinished', status: 'pending' }] },
    });
  f.store.updateRegisteredWork('old-turn', { status: 'waiting_user', executionEnded: true });
  const beforeCalls = f.worker.calls.length;
  assert.deepEqual(await f.engine.cancelProgress(record.id, 'work', { turnId: 'old-turn' }), {
    ok: true,
    cancelled: true,
  });
  assert.equal(f.engine.active, other);
  assert.equal(message.status, 'running');
  assert.equal(old.status, 'cancelled');
  assert.equal(f.worker.calls.length, beforeCalls);
  assert.equal(
    f.store.isProgressCompleted(
      defined(f.store.state.workTasks.find((item) => item.id === record.id)),
      'work',
    ),
    false,
  );
  assert.equal(f.engine.clearCompletedProgress().cleared, 0);
  assert.throws(() => f.engine.confirm(old.id));
  assert.deepEqual(f.engine.dismissProgress(record.id, 'work', { confirmUnfinished: true }), {
    ok: true,
  });
});

test('inactive cancellation save failure restores messages and registered plan metadata', (t) => {
  const f = fixture(t),
    message = f.store.add({
      role: 'user',
      text: 'Keep intact',
      turnId: 'old-turn',
      status: 'review',
    }),
    record = f.store.registerWork({
      turnId: 'old-turn',
      messageId: message.id,
      source: 'chat',
      title: 'Keep intact',
      plan: { steps: [{ step: 'Unfinished', status: 'pending' }] },
    });
  f.store.updateRegisteredWork('old-turn', { status: 'continuing', executionEnded: true });
  const before = structuredClone(f.store.state),
    save = f.store.save;
  f.store.save = () => {
    throw Error('Synthetic disk failure');
  };
  assert.throws(
    () => f.engine.cancelProgress(record.id, 'work', { turnId: 'old-turn' }),
    /Synthetic disk failure/,
  );
  assert.deepEqual(f.store.state, before);
  f.store.save = save;
});

test('a confirmed interruption with a failed save can persist on retry without interrupting again', async (t) => {
  const f = fixture(t),
    message = await start(f),
    owner = f.engine.active,
    record = plan(f),
    save = f.store.save;
  f.worker.autoInterrupt = true;
  f.store.save = () => {
    throw Error('Synthetic disk failure');
  };
  await assert.rejects(
    async () =>
      await f.engine.cancelProgress(defined(record).id, 'work', { turnId: defined(owner).turnId }),
    /Synthetic disk failure/,
  );
  assert.equal(f.engine.active, null);
  f.store.save = save;
  assert.deepEqual(
    await f.engine.cancelProgress(defined(record).id, 'work', { turnId: defined(owner).turnId }),
    {
      ok: true,
      cancelled: true,
    },
  );
  assert.equal(defined(new Store(f.dir).state.workTasks[0]).status, 'cancelled');
  assert.equal(defined(new Store(f.dir).state.messages[0]).status, 'cancelled');
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
  assert.equal(message.status, 'cancelled');
});

test('an old current-owner cancellation receipt cannot overwrite a resubmitted message on a new turn', async (t) => {
  const f = fixture(t),
    message = await start(f),
    old = f.engine.active;
  f.worker.autoInterrupt = true;
  await f.engine.cancelProgress(message.id, 'task', { turnId: defined(old).turnId });
  f.engine.enqueue(message);
  await tick();
  const current = f.engine.active,
    before = f.worker.calls.length;
  assert.notEqual(defined(current).turnId, defined(old).turnId);
  assert.throws(
    () => f.engine.cancelProgress('current', 'active', { turnId: defined(old).turnId }),
    (error) => isRecord(error) && error.status === 409,
  );
  assert.equal(f.engine.active, current);
  assert.equal(message.status, 'running');
  assert.equal(f.worker.calls.length, before);
  assert.throws(
    () => f.store.cancelWork({ turnId: defined(old).turnId, messageIds: [message.id] }),
    (error) => isRecord(error) && error.status === 409,
  );
});

test('stale, queued, accepted and unconfirmed targets cannot cancel a different owner', async (t) => {
  const f = fixture(t),
    message = await start(f),
    active = f.engine.active,
    record = plan(f),
    queued = f.store.add({ role: 'user', text: 'Next' });
  f.engine.enqueue(queued);
  const before = f.worker.calls.length;
  for (const [id, kind, body] of [
    [message.id, 'task', { turnId: 'stale' }],
    [defined(record).id, 'work', { turnId: null }],
    [queued.id, 'task', { turnId: null }],
    ['current', 'active', { turnId: 'stale' }],
  ] as const)
    assert.throws(
      () => f.engine.cancelProgress(id, kind, body),
      (error) => isRecord(error) && error.status === 409,
    );
  defined(active).steerUnconfirmed = true;
  assert.throws(
    () => f.engine.cancelProgress(message.id, 'task', { turnId: defined(active).turnId }),
    (error) => isRecord(error) && error.status === 409,
  );
  defined(active).steerUnconfirmed = false;
  assert.equal(f.worker.calls.length, before);
  assert.equal(f.engine.active, active);
  await f.engine.handle(completed(defined(active).turnId));
  f.engine.confirm(message.id);
  await tick();
  assert.throws(
    () => f.engine.cancelProgress(defined(record).id, 'work', { turnId: defined(active).turnId }),
    (error) => isRecord(error) && error.status === 409,
  );
});

test('ordinary pause and automatic human takeover remain resumable rather than cancelled', async (t) => {
  const f = fixture(t),
    message = await start(f);
  f.worker.autoInterrupt = true;
  await f.engine.pause();
  assert.equal(message.status, 'paused');
  f.engine.resumePaused([message.id]);
  await tick();
  assert.equal(message.status, 'running');
  await f.engine.acquire();
  assert.equal(message.status, 'paused');
  assert.equal(f.engine.takeover, true);
});

test('native exact cancellation retains a call-owned history record and leaves media connected', async (t) => {
  const f = fixture(t, { native: true }),
    call = await f.engine.startCall(sdp);
  f.engine.confirmCallConnected(call.callId);
  await f.engine.handle(
    event('turn/started', { turn: { id: 'native-task', status: 'inProgress' } }),
  );
  assert.equal(defined(defined(f.voice).progress).callId, call.callId);
  assert.throws(
    () => f.engine.cancelProgress('current', 'active', { turnId: 'native-task' }),
    (error) => isRecord(error) && error.status === 409,
  );
  const stopping = f.engine.cancelProgress('current', 'active', {
    turnId: 'native-task',
    callId: call.callId,
  });
  await tick();
  assert.equal(defined(defined(f.voice).progress).status, 'pausing');
  assert.equal(defined(f.engine.call).status, 'connected');
  assert.equal(f.store.state.workTasks.length, 1);
  await f.engine.handle(completed('native-task', 'interrupted'));
  assert.deepEqual(await stopping, { ok: true, cancelled: true });
  assert.equal(defined(f.engine.call).id, call.callId);
  assert.equal(defined(f.engine.call).status, 'connected');
  assert.equal(defined(f.voice).active, null);
  assert.equal(defined(f.store.state.workTasks[0]).status, 'cancelled');
  assert.equal(defined(new Store(f.dir).state.workTasks[0]).status, 'cancelled');
  assert.equal(
    f.worker.calls.some((call) => call.method === 'thread/realtime/stop'),
    false,
  );
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
});

test('native unknown or pending ownership cannot falsely cancel or shut down a healthy call', async (t) => {
  const f = fixture(t, { native: true }),
    call = await f.engine.startCall(sdp);
  await f.engine.handle(
    event('turn/started', { turn: { id: 'native-unknown', status: 'inProgress' } }),
  );
  const turn = defined(defined(f.voice).session).turns.get('native-unknown');
  plan(f, turn);
  const body = { turnId: defined(turn).turnId, callId: call.callId };
  for (const mutate of [
    () => (defined(defined(f.voice).session).unknown = true),
    () => {
      defined(defined(f.voice).session).unknown = false;
      defined(turn).pendingSubmissions = 1;
    },
  ] as const) {
    mutate();
    assert.throws(
      () => f.engine.cancelProgress('current', 'active', body),
      (error) => isRecord(error) && error.status === 409,
    );
  }
  defined(turn).pendingSubmissions = 0;
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/interrupt'),
    false,
  );
  assert.equal(defined(f.engine.call).id, call.callId);
});

test('native cancellation rejects a secure input wait before draining events and preserves connected media', async (t) => {
  const f = fixture(t, { native: true, secure: true }),
    call = await f.engine.startCall(sdp);
  f.engine.confirmCallConnected(call.callId);
  await f.engine.handle(
    event('turn/started', { turn: { id: 'credential-task', status: 'inProgress' } }),
  );
  const turn = defined(defined(f.voice).session).turns.get('credential-task'),
    record = plan(f, turn),
    pending = f.engine.handle({
      ...event('item/tool/call', {
        turnId: defined(turn).turnId,
        callId: 'credential-tool',
        tool: 'credential_request',
        arguments: {
          name: 'Test account',
          service: 'example.invalid',
          reason: 'Continue accepted work',
        },
      }),
      id: 81,
    });
  await tick();
  assert.equal(defined(f.credentials).snapshot().requests.length, 1);
  f.worker.autoInterrupt = true;
  assert.deepEqual(
    await f.engine.cancelProgress(defined(record).id, 'work', {
      turnId: defined(turn).turnId,
      callId: call.callId,
    }),
    { ok: true, cancelled: true },
  );
  await pending;
  assert.equal(defined(f.credentials).snapshot().requests.length, 0);
  assert.equal(
    observedRecord(defined(f.worker.responses.find((item) => item.id === 81)).result).success,
    false,
  );
  assert.equal(defined(f.engine.call).status, 'connected');
  assert.equal(defined(f.store.state.workTasks[0]).status, 'cancelled');
  assert.equal(
    f.worker.calls.some((call) => call.method === 'thread/realtime/stop'),
    false,
  );
});

test('cancelling detached native work uses its original call identity and keeps its durable history', async (t) => {
  const f = fixture(t, { native: true }),
    call = await f.engine.startCall(sdp);
  await f.engine.handle(
    event('turn/started', { turn: { id: 'detached-task', status: 'inProgress' } }),
  );
  const turn = defined(defined(f.voice).session).turns.get('detached-task'),
    record = plan(f, turn);
  await f.engine.stopCall(call.callId);
  assert.equal(f.engine.call, null);
  assert.equal(defined(defined(f.voice).progress).callId, call.callId);
  f.worker.autoInterrupt = true;
  const delivered = f.engine.deliverText('Useful partial result', turn);
  await f.engine.cancelProgress(defined(record).id, 'work', {
    turnId: defined(turn).turnId,
    callId: call.callId,
  });
  assert.equal(defined(f.voice).session, null);
  assert.equal(defined(f.store.state.workTasks[0]).status, 'cancelled');
  const completion = f.store.state.completions.find((item) => item.turnId === defined(turn).turnId);
  assert.equal(defined(defined(completion).work).status, 'cancelled');
  assert.equal(
    defined(
      defined(new Store(f.dir).state.completions.find((item) => item.id === defined(completion).id))
        .work,
    ).status,
    'cancelled',
  );
  assert.deepEqual(defined(completion).messageIds, [deliveredMessageId(delivered)]);
  assert.equal(
    f.store.state.messages.filter((message) => message.role === 'assistant').length,
    1,
    'cancellation keeps real results without a canned stopped message',
  );
});

test('native cancellation timeout keeps an unconfirmed active owner and never claims cancelled', async (t) => {
  const f = fixture(t, { native: true }),
    call = await f.engine.startCall(sdp);
  await f.engine.handle(
    event('turn/started', { turn: { id: 'native-delayed', status: 'inProgress' } }),
  );
  const turn = defined(defined(f.voice).session).turns.get('native-delayed'),
    record = plan(f, turn);
  await assert.rejects(
    async () =>
      await f.engine.cancelProgress(defined(record).id, 'work', {
        turnId: defined(turn).turnId,
        callId: call.callId,
      }),
    (error) =>
      isRecord(error) && error.status === 409 && observedRecord(error).unknownOutcome === true,
  );
  assert.equal(defined(defined(f.voice).progress).status, 'unknown');
  assert.notEqual(defined(f.store.state.workTasks[0]).status, 'cancelled');
  assert.equal(defined(f.engine.call).id, call.callId);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'thread/realtime/stop'),
    false,
  );
});

test('API call task cancellation keeps its original call identity and media intact', async (t) => {
  const f = fixture(t);
  f.engine.call = engineCallFixture({ id: 'api-call', provider: 'api', status: 'connected' });
  f.engine.voice = Object.assign(new VoiceFixture(), {
    conversationReady: async (callId) => ({ callId, status: 'ready' }),
  } satisfies Partial<EngineVoice>);
  const message = await start(f),
    owner = f.engine.active;
  assert.equal(defined(f.engine.progress).callId, 'api-call');
  assert.throws(
    () =>
      f.engine.cancelProgress(message.id, 'task', {
        turnId: defined(defined(owner).turnId),
        callId: 'other-call',
      }),
    (error) => isRecord(error) && error.status === 409,
  );
  f.worker.autoInterrupt = true;
  await f.engine.cancelProgress(message.id, 'task', {
    turnId: defined(defined(owner).turnId),
    callId: 'api-call',
  });
  assert.equal(message.status, 'cancelled');
  assert.equal(defined(f.engine.call).id, 'api-call');
  assert.equal(defined(f.engine.call).status, 'connected');
});

test('model self-cancellation acknowledges the tool before stopping its exact owner without deadlocking', async (t) => {
  for (const native of [false, true] as const) {
    const f = fixture(t, { native });
    let call;
    if (native) {
      call = await f.engine.startCall(sdp);
      await f.engine.handle(
        event('turn/started', { turn: { id: 'self-cancel', status: 'inProgress' } }),
      );
    } else await start(f);
    const owner = native
        ? defined(defined(f.voice).session).turns.get('self-cancel')
        : f.engine.active,
      record = plan(f, owner),
      request = f.worker.request.bind(f.worker);
    f.worker.autoInterrupt = true;
    f.worker.request = (method, params) => {
      if (method === 'turn/interrupt') {
        const receipt = f.worker.responses.find((item) => item.id === 90);
        assert.equal(observedRecord(defined(receipt).result).success, true);
        assert.equal(
          JSON.parse(
            String(
              defined(observedRecords(observedRecord(defined(receipt).result).contentItems)[0])
                .text,
            ),
          ).cancelRequested,
          true,
        );
      }
      return request(method, params);
    };
    await f.engine.handle({
      ...event('item/tool/call', {
        turnId: defined(defined(owner).turnId),
        callId: 'self-cancel-tool',
        tool: 'task_cancel',
        arguments: { workId: defined(record).id },
      }),
      id: 90,
    });
    assert.equal(
      observedRecord(defined(f.worker.responses.find((item) => item.id === 90)).result).success,
      true,
    );
    await tick();
    await tick();
    assert.equal(defined(f.store.state.workTasks[0]).status, 'cancelled');
    if (native) assert.equal(defined(f.engine.call).id, defined(call).callId);
  }
});

test('authorized API voice can cancel inactive work without borrowing another executor or ending its call', async (t) => {
  const f = fixture(t),
    message = f.store.add({ role: 'user', text: 'Old work', status: 'review', turnId: 'old' }),
    record = f.store.registerWork({
      turnId: 'old',
      messageId: message.id,
      source: 'chat',
      title: 'Old work',
      plan: { steps: [{ step: 'Remaining task', status: 'pending' }] },
    });
  f.store.updateRegisteredWork('old', { status: 'continuing', executionEnded: true });
  f.engine.call = engineCallFixture({ id: 'api-call', provider: 'api', status: 'connected' });
  const context = { owner: 'api-call', callId: 'api-call', isCurrent: () => true };
  const listed = await f.engine.tool('task_list', {}, context);
  assert.deepEqual(listed, {
    items: [
      {
        workId: record.id,
        title: 'Old work',
        status: 'continuing',
        steps: { completed: 0, total: 1 },
      },
    ],
  });
  assert.deepEqual(
    await f.engine.tool('task_cancel', { workId: defined(listed.items[0]).workId }, context),
    { cancelled: true, workId: record.id },
  );
  assert.equal(message.status, 'cancelled');
  assert.equal(f.engine.active, null);
  assert.equal(f.worker.calls.length, 0);
  assert.equal(defined(f.engine.call).id, 'api-call');
  await assert.rejects(
    f.engine.tool('task_cancel', { workId: record.id, turnId: 'invented' }, context),
    /existing workId/,
  );
  await assert.rejects(
    f.engine.tool('task_cancel', { workId: record.id }, { ...context, callId: 'other' }),
  );
  await assert.rejects(
    f.engine.tool('task_list', { workId: record.id }, context),
    /empty arguments/,
  );
});

test('read-only task discovery uses real IDs and redacted compact metadata with exact current authorization', async (t) => {
  const f = fixture(t),
    message = await start(f),
    record = plan(f);
  f.engine.credentials = Object.assign(new CredentialFixture(), {
    redact: (text) => String(text).replaceAll('PRIVATE_SECRET', '[redacted]'),
  } satisfies Partial<EngineCredentials>);
  defined(record).title = 'A PRIVATE_SECRET title';
  defined(defined(defined(record).plan).steps[0]).step = 'PRIVATE_FILE_CONTENT';
  const before = fs.readFileSync(f.store.file, 'utf8'),
    calls = f.worker.calls.length;
  const listed = await f.engine.tool('task_list', {});
  assert.equal(
    defined(observedRecords(observedRecord(listed).items)[0]).workId,
    defined(record).id,
  );
  assert.equal(
    defined(observedRecords(observedRecord(listed).items)[0]).title,
    'A [redacted] title',
  );
  assert.deepEqual(defined(observedRecords(observedRecord(listed).items)[0]).steps, {
    completed: 0,
    total: 2,
  });
  assert.equal(JSON.stringify(listed).includes('PRIVATE_'), false);
  assert.deepEqual(fs.readFileSync(f.store.file, 'utf8'), before);
  assert.equal(f.worker.calls.length, calls);
  defined(f.engine.active).stopRequested = true;
  await assert.rejects(f.engine.tool('task_list', {}));
  assert.equal(message.status, 'running');
});

test('model cancellation rejects unconfirmed active work before reporting a stop request', async (t) => {
  const f = fixture(t),
    message = await start(f),
    owner = f.engine.active,
    record = plan(f);
  defined(owner).steerUnconfirmed = true;
  await assert.rejects(
    f.engine.tool('task_cancel', { workId: defined(record).id }),
    (error) => isRecord(error) && error.status === 409,
  );
  await tick();
  assert.equal(defined(owner).cancelRequested, undefined);
  assert.equal(message.status, 'running');
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/interrupt'),
    false,
  );
});

test('authenticated cancellation HTTP route rejects stale tokens and suppresses private failures', async (t) => {
  const dir = fs.mkdtempSync(path.join(base, 'task-cancel-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  class Provider extends VoiceFixture {
    declare state: { available: boolean };
    declare active: null;
    declare progress: null;
    declare session: null;
    constructor() {
      super();
      this.state = { available: true };
      this.active = null;
      this.progress = null;
      this.session = null;
    }
    ownsEvent() {
      return false;
    }
    close = async () => {};
  }
  class NativeProvider extends NativeVoiceFixture {
    ownsEvent() {
      return false;
    }
    async close() {}
  }
  const worker = new Worker(dir),
    instance = createWorkerApp({
      dataDir: dir,
      workerFactory: () => worker,
      voiceFactory: () => new Provider(),
      nativeVoiceFactory: () => new NativeProvider(),
    });
  worker.engine = instance.engine;
  t.after(() => instance.close());
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + listeningPort(instance.server),
    session = await fetch(url + '/api/session').then((response) => response.json());
  const post = (id: string, body: unknown, authorized = true) =>
      fetch(url + '/api/tasks/' + id + '/cancel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorized ? { 'X-Dant-Token': session.token } : {}),
        },
        body: JSON.stringify(body),
      }),
    message = await start(instance),
    owner = instance.engine.active;
  assert.equal(
    (await post(message.id, { kind: 'task', turnId: defined(owner).turnId }, false)).status,
    401,
  );
  assert.equal((await post(message.id, { kind: 'task', turnId: 'stale' })).status, 409);
  assert.equal((await post(message.id, { kind: 'task' })).status, 400);
  worker.autoInterrupt = true;
  const response = await post(message.id, { kind: 'task', turnId: defined(owner).turnId });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, cancelled: true });
  instance.engine.cancelProgress = () => {
    throw Object.assign(Error('PRIVATE_ERROR_AND_TOKEN'), { status: 409, unknownOutcome: true });
  };
  const failed = await post(message.id, { kind: 'task', turnId: defined(owner).turnId }),
    body = await failed.json();
  assert.equal(failed.status, 409);
  assert.equal(body.code, 'cancel_unconfirmed');
  assert.equal(JSON.stringify(body).includes('PRIVATE_'), false);
});

test('private MCP task management authenticates, lists actual IDs, cancels inactive work, and contains unsafe errors', async (t) => {
  const dir = fs.mkdtempSync(path.join(base, 'task-cancel-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  class Provider extends VoiceFixture {
    declare state: { available: boolean };
    declare active: null;
    declare progress: null;
    declare session: null;
    constructor() {
      super();
      this.state = { available: true };
    }
    ownsEvent() {
      return false;
    }
    close = async () => {};
  }
  class NativeProvider extends NativeVoiceFixture {
    ownsEvent() {
      return false;
    }
    async close() {}
  }
  const worker = new Worker(dir),
    instance = createWorkerApp({
      dataDir: dir,
      workerFactory: () => worker,
      voiceFactory: () => new Provider(),
      nativeVoiceFactory: () => new NativeProvider(),
    });
  worker.engine = instance.engine;
  t.after(() => instance.close());
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + listeningPort(instance.server);
  const internal = (tool: string, args: unknown, token = worker.credentialBridgeToken) =>
    fetch(url + '/api/internal/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dant-Credential-Token': token },
      body: JSON.stringify({ tool, arguments: args }),
    });
  assert.equal((await internal('task_list', {}, 'forged')).status, 403);
  assert.equal((await internal('task_list', {})).status, 409);
  await start(instance);
  const record = instance.store.registerWork({
    turnId: 'older',
    source: 'voice',
    title: 'Old requested work',
    plan: { steps: [{ step: 'PRIVATE_FILE_CONTENT', status: 'pending' }] },
  });
  instance.store.updateRegisteredWork('older', { status: 'continuing', executionEnded: true });
  const discovery = await internal('task_list', {});
  assert.equal(discovery.status, 200);
  const listed = await discovery.json();
  assert.equal(listed.items[0].workId, record.id);
  assert.equal(JSON.stringify(listed).includes('PRIVATE_'), false);
  const stopped = await internal('task_cancel', { workId: record.id });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { cancelled: true, workId: record.id });
  assert.ok(instance.engine.active);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/interrupt'),
    false,
  );
  const forged = await internal('task_cancel', { workId: record.id, turnId: 'PRIVATE_TOKEN' });
  assert.equal(forged.status, 400);
  assert.equal((await forged.text()).includes('PRIVATE_'), false);
  instance.engine.requestWorkCancellation = () => {
    throw Error('PRIVATE_ERROR_AND_TOKEN');
  };
  const failed = await internal('task_cancel', { workId: record.id });
  assert.equal(failed.status, 400);
  assert.deepEqual(await failed.json(), {
    error: 'The task cancellation request could not be completed.',
  });
});
