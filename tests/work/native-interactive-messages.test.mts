import { WorkerServiceFixture, rpcText } from '../support/service-fixtures.mts';
import { operationError } from '../../src/runtime/errors.mts';
import { readRpcResult } from '../../src/runtime/rpc-values.mts';
import type { RpcParams, RpcResult, RpcEvent } from '../../src/runtime/protocol.ts';
function requestFixture(
  handler: (method: string, params: RpcParams) => unknown | Promise<unknown>,
) {
  return async (method: string, params: RpcParams = {}) =>
    readRpcResult(await handler(method, params));
}
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../../src/work/engine.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';
import { Store } from '../../src/conversation/store.mts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
// Deliberately malformed owner snapshots must reach admission guards unchanged.
function injectUnsafeOwnerState(target: object, key: string, value: unknown): void {
  Reflect.set(target, key, value);
}
function injectNativeMapEntry(target: Map<unknown, unknown>, key: unknown, value: unknown): void {
  Reflect.apply(Map.prototype.set, target, [key, value]);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
class Worker extends WorkerServiceFixture {
  calls: Array<{ method: string; params: RpcParams }> = [];
  responses: Array<{
    id?: string | number | null | undefined;
    result?: Record<string, unknown>;
    error?: unknown;
  }> = [];
  wire: RpcEvent[] = [];
  turns: Map<string, string> = new Map();
  nextTurn = 0;
  terminated = 0;
  failMedia: string | null = null;
  emitClosed = true;
  engine?: Engine;
  constructor(dir: string) {
    super();
    this.status = 'online';
    this.workspaceRoot = path.join(dir, 'workspaces');
    this.desktopPath = path.join(dir, 'desktop.py');
    this.calls = [];
    this.rpc = { reply() {}, send() {} };
  }
  override async request(method: string, params: RpcParams = {}): Promise<RpcResult> {
    this.calls.push({ method, params });
    const event = (method: string, params: Record<string, unknown> = {}) =>
      this.emit('event', { method, params: { threadId: 'thread', ...params } });
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'thread/realtime/start') {
      queueMicrotask(() => {
        event('thread/realtime/started', { version: 'v3' });
        event('thread/realtime/sdp', { sdp });
      });
      return {};
    }
    if (method === 'thread/realtime/stop') {
      queueMicrotask(() => event('thread/realtime/closed'));
      return {};
    }
    if (method === 'thread/read')
      return {
        thread: {
          id: 'thread',
          status: { type: 'active' },
          turns: [...defined(defined(defined(this.engine).nativeVoice).session).turns.values()].map(
            (turn) => ({
              id: turn.turnId,
              status: turn.done ? 'completed' : 'inProgress',
            }),
          ),
        },
      };
    return {};
  }
}
async function fixture(t: NodeTestContext) {
  const dir = fs.mkdtempSync(path.join(base, 'native-interactive-')),
    store = new Store(dir),
    worker = new Worker(dir),
    engine = new Engine(store, worker),
    voice = new NativeRealtimeVoice({
      worker,
      engine,
      connectTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    });
  worker.engine = engine;
  t.after(() => {
    engine.pauseQueue();
    if (engine.streamingSaveTimer) clearTimeout(engine.streamingSaveTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const event = (method: string, params: Record<string, unknown> = {}, id?: string | number) =>
    engine.handle({
      method,
      params: { threadId: 'thread', ...params },
      ...(id === undefined ? {} : { id }),
    });
  const call = await engine.startCall(sdp);
  engine.confirmCallConnected(call.callId);
  await event('turn/started', { turn: { id: 'owned', status: 'inProgress' } });
  await engine.stopCall(call.callId);
  return {
    store,
    worker,
    engine,
    voice,
    event,
    session: defined(voice.session),
    turn: defined(defined(voice.session).turns.get('owned')),
    message: (
      text = 'Open a room now',
      extra: Partial<Omit<import('../../src/conversation/types.ts').ChatMessage, 'role'>> = {},
    ) => store.add({ role: 'user', text, ...extra }),
    finish: () => event('turn/completed', { turn: { id: 'owned', status: 'completed' } }),
    steers: () => worker.calls.filter((call) => call.method === 'turn/steer'),
  };
}

test('opted-in native chat follows the exact running background turn and confirms receipt only after its steer acknowledgement', async (t) => {
  const f = await fixture(t);
  assert.equal(f.voice.acceptsChatInput, false);
  assert.equal(f.voice.acceptsInteractiveChatInput, true);
  assert.equal(defined(f.voice.progress).canSteer, true);
  const ordinary = f.message('An automatic scheduled task');
  await assert.rejects(f.voice.answerBackground(ordinary), /changed/);
  assert.equal(f.engine.queue.length, 0);
  assert.equal(f.steers().length, 0);
  let acknowledge: ((value: unknown) => void) | undefined;
  const request = f.worker.request.bind(f.worker);
  f.worker.request = requestFixture((method, params) => {
    if (method !== 'turn/steer') return request(method, params);
    f.worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  const message = f.message(),
    pending = f.voice.answerBackground(message, { interactive: true, expectedTurnId: 'owned' });
  while (!acknowledge) await tick();
  assert.equal(message.submission, 'submitting');
  assert.equal(message.executorConfirmedAt, null);
  assert.equal(defined(f.steers()[0]).params.expectedTurnId, 'owned');
  assert.ok(
    rpcText(defined(defined(f.steers()[0]).params.input)[0]).includes(defined(message.text)),
  );
  defined(acknowledge)({});
  assert.deepEqual(await pending, { queued: false, turnId: 'owned' });
  assert.equal(message.submission, 'confirmed');
  assert.ok(defined(message.executorConfirmedAt) > 0);
  assert.equal(f.voice.acceptsChatInput, false);
  assert.equal(f.voice.acceptsInteractiveChatInput, true);
  assert.equal(f.engine.queue.length, 0);
  await f.finish();
  assert.equal(message.status, 'review');
  assert.equal(f.voice.session, null);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('native interactive replies require text and the explicit current turn without accepting attachments', async (t) => {
  const f = await fixture(t);
  for (const [text, extra, expectedTurnId] of [
    ['Open room', {}, 'old-owner'],
    ['Open room', {}, undefined],
    ['Open room', { attachments: [{ id: 'image' }] }, 'owned'],
    [' ', {}, 'owned'],
  ] as const) {
    const message = f.message(
      text,
      'attachments' in extra ? { attachments: [...extra.attachments] } : {},
    );
    await assert.rejects(f.voice.answerBackground(message, { interactive: true, expectedTurnId }));
    assert.equal(message.submission, 'preparing');
    assert.equal(message.status, 'failed');
    assert.equal(message.executorConfirmedAt, null);
  }
  assert.equal(f.steers().length, 0);
  assert.equal(f.engine.queue.length, 0);
  await f.finish();
});

test('native interactive followups serialize on one confirmed owner and duplicate message IDs execute once', async (t) => {
  const f = await fixture(t),
    acknowledgements: Array<(value: unknown) => void> = [],
    request = f.worker.request.bind(f.worker);
  f.worker.request = requestFixture((method, params) => {
    if (method !== 'turn/steer') return request(method, params);
    f.worker.calls.push({ method, params });
    return new Promise((resolve) => acknowledgements.push(resolve));
  });
  const first = f.message('Create room'),
    second = f.message('Share its code'),
    options = { interactive: true, expectedTurnId: 'owned' },
    one = f.voice.answerBackground(first, options);
  assert.equal(f.voice.answerBackground(first, options), one);
  const two = f.voice.answerBackground(second, options);
  while (!acknowledgements.length) await tick();
  assert.equal(f.steers().length, 1);
  assert.equal(f.voice.acceptsInteractiveChatInput, true);
  defined(acknowledgements[0])({});
  await one;
  while (acknowledgements.length < 2) await tick();
  assert.equal(first.submission, 'confirmed');
  assert.equal(second.submission, 'submitting');
  defined(acknowledgements[1])({});
  await two;
  await f.voice.answerBackground(first, options);
  assert.equal(f.steers().length, 2);
  assert.deepEqual(
    f.steers().map((call) => call.params.expectedTurnId),
    ['owned', 'owned'],
  );
  assert.deepEqual(defined(f.turn).explicitMessageIds, [first.id, second.id]);
  assert.equal(f.engine.queue.length, 0);
  await f.finish();
  assert.equal(first.status, 'review');
  assert.equal(second.status, 'review');
});

test('a captured native owner finishing before dispatch fails visibly instead of becoming a queued or new task', async (t) => {
  const f = await fixture(t);
  let release: (() => void) | undefined;
  defined(f.session).messageChain = new Promise<void>((resolve) => (release = resolve));
  const message = f.message(),
    pending = f.voice.answerBackground(message, { interactive: true, expectedTurnId: 'owned' });
  await f.finish();
  defined(release)();
  await assert.rejects(pending, (error) => operationError(error).submission === 'not-submitted');
  assert.equal(message.status, 'failed');
  assert.equal(message.submission, 'preparing');
  assert.equal(message.executorConfirmedAt, null);
  assert.equal(f.engine.queue.length, 0);
  assert.equal(f.steers().length, 0);
  assert.equal(f.voice.session, null);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('native interactive input rejects unsafe ownership states before dispatch', async (t) => {
  const mutations = [
    ['unknown', (f: Fixture) => (f.session.unknown = true)],
    [
      'new turn submitting',
      (f: Fixture) =>
        injectUnsafeOwnerState(f.session, 'submitting', { message: { id: 'pending' } }),
    ],
    ['pausing', (f: Fixture) => (f.session.pausing = true)],
    ['stopping', (f: Fixture) => (f.session.stopping = true)],
    ['human control', (f: Fixture) => (f.engine.takeover = true)],
    ['acquiring control', (f: Fixture) => (f.engine.acquiring = true)],
    ['offline', (f: Fixture) => (f.worker.status = 'offline')],
    ['turn pause', (f: Fixture) => (f.turn.pauseRequested = true)],
    [
      'pending handoff',
      (f: Fixture) =>
        injectNativeMapEntry(f.session.handoffs, 'pending', { turnId: null, idleConfirmed: false }),
    ],
    [
      'multiple turns',
      (f: Fixture) =>
        injectNativeMapEntry(f.session.turns, 'another', { turnId: 'another', done: false }),
    ],
  ] as const;
  for (const [name, mutate] of mutations)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      mutate(f);
      assert.equal(f.voice.acceptsInteractiveChatInput, false);
      const message = f.message();
      await assert.rejects(
        f.voice.answerBackground(message, { interactive: true, expectedTurnId: 'owned' }),
        (error) => operationError(error).submission === 'not-submitted',
      );
      assert.equal(message.status, 'failed');
      assert.equal(f.steers().length, 0);
      assert.equal(f.engine.queue.length, 0);
    });
});

test('native interactive input rechecks its captured owner and pending handoffs after serialization', async (t) => {
  for (const [name, mutate] of [
    ['replaced session', (f: Fixture) => (f.voice.session = { ...f.session, turns: new Map() })],
    [
      'new handoff',
      (f: Fixture) =>
        injectNativeMapEntry(f.session.handoffs, 'late', { turnId: null, idleConfirmed: false }),
    ],
    ['human control', (f: Fixture) => (f.engine.acquiring = true)],
  ] as const)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      let release: (() => void) | undefined;
      defined(f.session).messageChain = new Promise<void>((resolve) => (release = resolve));
      const message = f.message(),
        pending = f.voice.answerBackground(message, { interactive: true, expectedTurnId: 'owned' });
      mutate(f);
      defined(release)();
      await assert.rejects(
        pending,
        (error) => operationError(error).submission === 'not-submitted',
      );
      assert.equal(message.status, 'failed');
      assert.equal(message.submission, 'preparing');
      assert.equal(f.steers().length, 0);
      assert.equal(f.engine.queue.length, 0);
    });
});

test('lost native followup acknowledgement locks the owner and never dispatches or replays the serialized next reply', async (t) => {
  const f = await fixture(t);
  let rejectFirst: ((reason: unknown) => void) | undefined;
  const request = f.worker.request.bind(f.worker);
  f.worker.request = requestFixture((method, params) => {
    if (method !== 'turn/steer') return request(method, params);
    f.worker.calls.push({ method, params });
    return new Promise((_resolve, reject) => (rejectFirst = reject));
  });
  const first = f.message('Create room'),
    second = f.message('Share code'),
    options = { interactive: true, expectedTurnId: 'owned' },
    one = f.voice.answerBackground(first, options),
    two = f.voice.answerBackground(second, options);
  const firstRejected = assert.rejects(
      one,
      (error) =>
        operationError(error).unknownOutcome === true &&
        operationError(error).submission === 'unknown',
    ),
    secondRejected = assert.rejects(
      two,
      (error) => operationError(error).submission === 'not-submitted',
    );
  while (!rejectFirst) await tick();
  defined(rejectFirst)(Error('The acknowledgement was lost'));
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(first.submission, 'unknown');
  assert.equal(first.status, 'paused');
  assert.equal(first.executorConfirmedAt, null);
  assert.equal(second.submission, 'preparing');
  assert.equal(second.status, 'failed');
  assert.equal(defined(f.session).unknown, true);
  assert.equal(f.voice.acceptsInteractiveChatInput, false);
  await assert.rejects(f.voice.answerBackground(first, options));
  assert.equal(f.steers().length, 1);
  assert.equal(f.engine.queue.length, 0);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('an explicit native steer rejection stays failed and allows a distinct followup without replay', async (t) => {
  const f = await fixture(t),
    request = f.worker.request.bind(f.worker);
  let rejected = false;
  f.worker.request = requestFixture((method, params) => {
    if (method !== 'turn/steer' || rejected) return request(method, params);
    rejected = true;
    f.worker.calls.push({ method, params });
    return Promise.reject(Object.assign(Error('Turn rejected the adjustment'), { code: -32000 }));
  });
  const first = f.message(),
    options = { interactive: true, expectedTurnId: 'owned' };
  await assert.rejects(
    f.voice.answerBackground(first, options),
    (error) => operationError(error).submission === 'rejected',
  );
  assert.equal(first.status, 'failed');
  assert.equal(first.submission, 'rejected');
  assert.equal(first.executorConfirmedAt, null);
  assert.equal(defined(f.session).unknown, false);
  assert.equal(f.voice.acceptsInteractiveChatInput, true);
  await assert.rejects(f.voice.answerBackground(first, options));
  const second = f.message('Use another room');
  await f.voice.answerBackground(second, options);
  assert.equal(second.submission, 'confirmed');
  assert.equal(f.steers().length, 2);
  await f.finish();
  assert.equal(first.status, 'failed');
  assert.equal(second.status, 'review');
});

test('a terminal event during native steer acknowledgement persists the acknowledged followup with the same final result', async (t) => {
  const f = await fixture(t),
    request = f.worker.request.bind(f.worker);
  let acknowledge: ((value: unknown) => void) | undefined;
  f.worker.request = requestFixture((method, params) => {
    if (method !== 'turn/steer') return request(method, params);
    f.worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  const message = f.message(),
    pending = f.voice.answerBackground(message, { interactive: true, expectedTurnId: 'owned' });
  while (!acknowledge) await tick();
  await f.finish();
  assert.equal(defined(f.turn).resultSaved, undefined);
  defined(acknowledge)({});
  await pending;
  assert.equal(message.submission, 'confirmed');
  assert.equal(message.status, 'review');
  assert.ok(defined(message.executorConfirmedAt) > 0);
  assert.equal(f.voice.session, null);
  assert.equal(f.steers().length, 1);
});
