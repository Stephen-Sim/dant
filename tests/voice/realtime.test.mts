import { readRpcResult } from '../../src/runtime/rpc-values.mts';
import { operationError } from '../../src/runtime/errors.mts';
import { observedRecord, observedRecords } from '../support/service-fixtures.mts';
import type {
  DeliverableArchiveInput,
  DeliverableOwnership,
  DeliverableBaseline,
} from '../../src/files/attachment-types.ts';
import { EventEmitter } from 'node:events';
import { WorkerServiceFixture } from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult, RpcEvent, ToolArguments } from '../../src/runtime/protocol.ts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/conversation/store.mts';
import type { EngineDeliverables } from '../../src/work/engine.mts';
import { Engine } from '../../src/work/engine.mts';
import { NativeRealtimeVoice, NATIVE_REALTIME_MODEL } from '../../src/voice/realtime.mts';
import { CredentialVault, CredentialRequests } from '../../src/security/credentials.mts';
import { DANT_IDENTITY_INSTRUCTIONS } from '../../src/conversation/identity.mts';
import { ComputerSession } from '../../src/computer/computer-session.mts';

function requestFixture(
  handler: (method: string, params: RpcParams) => unknown | Promise<unknown>,
) {
  return async (method: string, params: RpcParams = {}): Promise<RpcResult> =>
    readRpcResult(await handler(method, params));
}
class FixtureCollector extends EventEmitter implements EngineDeliverables {
  archive: EngineDeliverables['archive'] = async () => {
    throw Error('Unexpected archive');
  };
  captureBaseline?: NonNullable<EngineDeliverables['captureBaseline']>;
}
function fixtureNumber(value: unknown): number {
  assert.ok(typeof value === 'number');
  return value;
}
function fixtureText(value: unknown): string {
  assert.equal(typeof value, 'string');
  return String(value);
}
function fixtureJson(value: unknown): Record<string, unknown> {
  return observedRecord(JSON.parse(fixtureText(value)));
}
interface FixtureResponse {
  id?: string | number | null;
  result?: Record<string, unknown> & {
    success?: boolean;
    contentItems?: Array<{ type?: string; text?: string }>;
  };
  error?: Record<string, unknown>;
}
function fixtureResponse(value: unknown): FixtureResponse {
  const raw = observedRecord(value),
    result: FixtureResponse = {};
  if (raw.id !== undefined) {
    assert.ok(typeof raw.id === 'string' || typeof raw.id === 'number' || raw.id === null);
    result.id = raw.id;
  }
  if (raw.result !== undefined) {
    const payload = observedRecord(raw.result);
    result.result = { ...payload };
    if (payload.success !== undefined) {
      assert.equal(typeof payload.success, 'boolean');
      result.result.success = payload.success === true;
    }
    if (payload.contentItems !== undefined)
      result.result.contentItems = observedRecords(payload.contentItems).map((item) => ({
        ...(typeof item.type === 'string' ? { type: item.type } : {}),
        ...(typeof item.text === 'string' ? { text: item.text } : {}),
      }));
  }
  if (raw.error !== undefined) result.error = observedRecord(raw.error);
  return result;
}
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
class FakeWorker extends WorkerServiceFixture {
  readonly calls: Array<{ method: string; params: RpcParams }>;
  responses: FixtureResponse[];
  terminated: number;
  nextTurn: number;
  engine?: Engine;
  constructor(dir: string) {
    super();
    this.status = 'online';
    this.workspaceRoot = path.join(dir, 'workspaces');
    this.calls = [];
    this.responses = [];
    this.terminated = 0;
    this.nextTurn = 0;
    this.rpc = {
      reply: (id, result) => this.responses.push(fixtureResponse({ id, result })),
      send: (result) => this.responses.push(fixtureResponse(result)),
    };
  }
  event(method: string, params: Record<string, unknown> = {}) {
    this.emit('event', { method, params: { threadId: 'thread', ...params } });
  }
  override async request(method: string, params: RpcParams = {}): Promise<RpcResult> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'thread/realtime/listVoices')
      return { voices: { v3: ['ember', 'cove'], v2: ['marin'] } };
    if (method === 'thread/realtime/start') {
      queueMicrotask(() => {
        this.event('thread/realtime/started', {
          version: 'v3',
          realtimeSessionId: 'native-' + String(params.voiceSessionId),
        });
        this.event('thread/realtime/sdp', { sdp });
      });
      return {};
    }
    if (method === 'thread/realtime/stop') {
      queueMicrotask(() => this.event('thread/realtime/closed'));
      return {};
    }
    if (method === 'thread/read') {
      const turns = [
        ...((
          this.engine?.nativeVoice?.session?.turns ??
          new Map<string, import('../../src/voice/realtime-types.ts').NativeTurn>()
        ).values() || []),
      ].map((turn) => ({
        id: turn.turnId,
        status: turn.done ? 'completed' : 'inProgress',
      }));
      return {
        thread: {
          id: 'thread',
          status: { type: turns.some((turn) => turn.status === 'inProgress') ? 'active' : 'idle' },
          turns,
        },
      };
    }
    if (method === 'turn/start') return { turn: { id: 'typed-' + ++this.nextTurn } };
    if (method === 'turn/interrupt') {
      queueMicrotask(() =>
        this.event('turn/completed', { turn: { id: params.turnId, status: 'interrupted' } }),
      );
      return {};
    }
    return {};
  }
  createVoiceMessage?: NonNullable<
    import('../../src/runtime/worker-types.ts').WorkerPublic['createVoiceMessage']
  >;
  async terminateConfirmed() {
    this.terminated++;
    this.status = 'offline';
    this.emit('status');
    return { terminated: true };
  }
}
function setup(
  t: NodeTestContext,
  options: {
    engine?: ConstructorParameters<typeof Engine>[2];
    voice?: ConstructorParameters<typeof NativeRealtimeVoice>[0];
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(base, 'realtime-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    worker = new FakeWorker(dir),
    engine = new Engine(store, worker, options.engine);
  const voice = new NativeRealtimeVoice({
    worker,
    engine,
    connectTimeoutMs: 1000,
    stopTimeoutMs: 1000,
    ...options.voice,
  });
  worker.engine = engine;
  return { dir, store, worker, engine, voice };
}
function event(method: string): RpcEvent;
function event<Params extends Record<string, unknown>>(
  method: string,
  params: Params,
  id?: string | number | null,
): { method: string; params: Params & { threadId: string }; id?: string | number | null };
function event(
  method: string,
  params: Record<string, unknown> = {},
  id?: string | number | null,
): RpcEvent {
  return { method, params: { threadId: 'thread', ...params }, ...(id === undefined ? {} : { id }) };
}
const begin = (engine: Engine, id: string) =>
  engine.handle(event('turn/started', { turn: { id, status: 'inProgress' } }));
const tool = (
  engine: Engine,
  id: string,
  name: string,
  args: ToolArguments,
  requestId: string | number,
) =>
  engine.handle(
    event(
      'item/tool/call',
      { turnId: id, callId: 'call-' + requestId, tool: name, arguments: args },
      requestId,
    ),
  );
const handoff = (id: string, patch: Record<string, unknown> = {}) =>
  event('thread/realtime/itemAdded', {
    item: {
      type: 'handoff_request',
      handoff_id: id,
      item_id: 'item-' + id,
      input_transcript: 'Private spoken computer instruction',
      active_transcript: [],
      ...patch,
    },
  });
const liveReferences = (worker: FakeWorker) =>
  worker.calls.filter(
    (call) =>
      call.method === 'thread/realtime/appendText' &&
      defined(call.params.text).includes('<dant_live_reference>'),
  );

test('a valid server-managed handoff attaches to its announced turn without disconnecting the executor', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'delegated-turn');
  await engine.handle(handoff('delegated'));
  assert.equal(defined(voice.session).unknown, false);
  await engine.handle(
    event('turn/completed', { turn: { id: 'delegated-turn', status: 'completed' } }),
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
  assert.equal(worker.status, 'online');
  assert.equal(defined(voice.state.lastStop).executorStopped, false);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('a valid handoff preceding its announced turn is reconciled without submitting duplicate work', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await engine.handle(handoff('before-turn'));
  await begin(engine, 'later-turn');
  assert.equal(defined(voice.session).unknown, false);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
  assert.equal(defined(voice.active).turnId, 'later-turn');
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('a valid handoff published after the routed turn completed does not poison hangup', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'fast-turn');
  await engine.handle(event('turn/completed', { turn: { id: 'fast-turn', status: 'completed' } }));
  await engine.handle(handoff('after-completion'));
  assert.equal(defined(voice.session).unknown, false);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('a completed task followed by its handoff still accepts the next typed message in the same call', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'fast-before-text');
  await engine.handle(
    event('turn/completed', { turn: { id: 'fast-before-text', status: 'completed' } }),
  );
  await engine.handle(handoff('receipt-before-text'));
  const sent = await voice.message({
    clientMessageId: 'after-fast-completion',
    text: 'A fresh typed request',
  });
  assert.equal(sent.submission, 'confirmed');
  assert.equal(sent.message.status, 'accepted');
  assert.equal(sent.turnId, undefined);
  assert.equal(defined(engine.call).id, call.callId);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 0);
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('pause after a completed-task handoff proves live idle and keeps the call and executor connected', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  engine.confirmCallConnected(call.callId);
  await begin(engine, 'fast-before-pause');
  await engine.handle(
    event('turn/completed', { turn: { id: 'fast-before-pause', status: 'completed' } }),
  );
  await engine.handle(handoff('receipt-before-pause'));
  const result = observedRecord(await engine.pause());
  assert.equal(result.paused, true);
  assert.deepEqual(result.turnIds, []);
  assert.equal(defined(engine.call).status, 'connected');
  assert.equal(defined(voice.session).unknown, false);
  assert.equal(worker.terminated, 0);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('a stale live idle read cannot clear a newer receipt or submit the waiting typed task', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  let reply: ((value: unknown) => void) | undefined;
  await engine.handle(handoff('older-pending'));
  worker.request = requestFixture((method, params) =>
    method === 'thread/read'
      ? new Promise((resolve) => (reply = resolve))
      : request(method, params),
  );
  const sending = voice.message({
      clientMessageId: 'stale-read-task',
      text: 'Do not submit based on an older receipt',
    }),
    rejected = assert.rejects(sending, /waiting for its task/);
  await tick();
  await engine.handle(handoff('newer-pending'));
  defined(reply)({ thread: { id: 'thread', status: { type: 'idle' }, turns: [] } });
  await rejected;
  assert.equal(defined(defined(voice.session).handoffs.get('older-pending')).idleConfirmed, true);
  assert.equal(
    defined(defined(voice.session).handoffs.get('newer-pending')).idleConfirmed,
    undefined,
  );
  assert.equal(defined(voice.session).unknown, false);
  assert.equal(store.state.messages.length, 0);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  worker.request = requestFixture(request);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('server managed steering and duplicate handoffs stay scoped to one announced turn without retaining speech', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp),
    startupReads = worker.calls.filter((call) => call.method === 'thread/read').length;
  await begin(engine, 'steered-voice-turn');
  await engine.handle(handoff('first'));
  await engine.handle(handoff('second'));
  await engine.handle(handoff('first'));
  assert.equal(defined(voice.session).handoffs.size, 2);
  assert.ok(
    [...defined(voice.session).handoffs.values()].every(
      (item) => item.turnId === 'steered-voice-turn',
    ),
  );
  assert.equal(
    JSON.stringify([...defined(voice.session).handoffs]).includes('Private spoken'),
    false,
  );
  assert.equal(
    worker.calls.some((call) => ['turn/start', 'turn/steer'].includes(call.method)),
    false,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
  assert.equal(defined(voice.active).turnId, 'steered-voice-turn');
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/read').length - startupReads,
    1,
  );
});

test('an unannounced handoff blocks competing typed submission until its own announced turn arrives', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) =>
    method === 'thread/read' && voice.pendingHandoffs(defined(voice.session))
      ? Promise.resolve({ thread: { id: 'thread', status: { type: 'active' }, turns: [] } })
      : request(method, params),
  );
  await engine.handle(handoff('pending'));
  assert.equal(defined(voice.active).status, 'running');
  await assert.rejects(
    voice.message({ clientMessageId: 'competing', text: 'A different task' }),
    /waiting for its task/,
  );
  assert.equal(store.state.messages.length, 0);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  await begin(engine, 'pending-turn');
  await voice.message({ clientMessageId: 'correction-after-start', text: 'A correction' });
  assert.equal(worker.calls.filter((call) => call.method === 'turn/steer').length, 0);
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('closing drains a handoff and continues its late announced accepted task', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/stop') return request(method, params);
    worker.calls.push({ method, params });
    queueMicrotask(() => {
      worker.event('turn/started', { turn: { id: 'late-admitted', status: 'inProgress' } });
      const raw = handoff('late-admission');
      worker.event(raw.method, raw.params);
      worker.event('thread/realtime/closed');
    });
    return Promise.resolve({});
  });
  await engine.stopCall(call.callId);
  assert.equal(engine.call, null);
  assert.equal(worker.terminated, 0);
  assert.equal(defined(voice.state.lastStop).executorStopped, false);
  assert.deepEqual(
    worker.calls.filter((call) => call.method === 'turn/interrupt'),
    [],
  );
  assert.equal(defined(voice.active).turnId, 'late-admitted');
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('empty delegation receipts create no work, and foreign or previously closed call handoffs are ignored', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await engine.handle(handoff('empty', { input_transcript: '' }));
  await engine.handle({
    ...handoff('foreign'),
    params: { ...handoff('foreign').params, threadId: 'another-thread' },
  });
  await engine.handle({
    ...handoff('old-session'),
    params: { ...handoff('old-session').params, realtimeSessionId: 'different-session' },
  });
  assert.equal(defined(voice.session).handoffs.size, 0);
  assert.equal(defined(voice.session).unknown, false);
  await begin(engine, 'first-call-turn');
  await engine.handle(handoff('known-old'));
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
  await engine.pause();
  const next = await engine.startCall(sdp);
  await engine.handle(handoff('known-old'));
  assert.equal(defined(voice.session).handoffs.size, 0);
  assert.equal(defined(voice.session).unknown, false);
  await engine.stopCall(next.callId);
  assert.equal(worker.terminated, 0);
});

test('malformed handoffs and conflicting duplicate identities retain confirmed executor termination', async (t) => {
  for (const patch of [
    { handoff_id: '' },
    { item_id: 'bad id' },
    { handoff_id: 'x'.repeat(257) },
    { input_transcript: 7 },
    { active_transcript: null },
    { active_transcript: [{}] },
    { active_transcript: [null] },
    { item_id: undefined },
  ]) {
    const { engine, voice, worker } = setup(t),
      call = await engine.startCall(sdp);
    await begin(engine, 'guarded-turn');
    await engine.handle(handoff('invalid', patch));
    assert.equal(defined(voice.session).unknown, true);
    await engine.stopCall(call.callId);
    assert.equal(worker.terminated, 1);
    assert.equal(defined(voice.state.lastStop).confirmed, true);
  }
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'conflict-turn');
  await engine.handle(handoff('conflict'));
  await engine.handle(handoff('conflict', { item_id: 'different-item' }));
  assert.equal(defined(voice.session).unknown, true);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 1);
});

test('completed-before-receipt and valid no-task handoffs require explicit live idle after closed', async (t) => {
  for (const status of ['idle', 'notLoaded', 'systemError', 'active', undefined]) {
    const { engine, voice, worker } = setup(t),
      call = await engine.startCall(sdp),
      request = worker.request.bind(worker),
      diagnostics: Array<Record<string, unknown>> = [];
    voice.on('diagnostic', (entry) => diagnostics.push(entry));
    await engine.handle(handoff('valid-no-task'));
    assert.equal(defined(voice.session).unknown, false);
    assert.equal(voice.pendingHandoffs(defined(voice.session)), true);
    worker.request = requestFixture((method, params) =>
      method === 'thread/read'
        ? Promise.resolve({
            thread: { id: 'thread', ...(status ? { status: { type: status } } : {}), turns: [] },
          })
        : request(method, params),
    );
    await engine.stopCall(call.callId);
    assert.equal(worker.terminated, status === 'idle' ? 0 : 1);
    assert.equal(
      diagnostics.some((entry) => entry.code === 'voice_handoff_confirmed'),
      status === 'idle',
    );
  }
});

test('whitespace input and valid transcript-only handoffs are tracked and confirmed without saving speech', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    diagnostics: Array<Record<string, unknown>> = [];
  voice.on('diagnostic', (entry) => diagnostics.push(entry));
  await begin(engine, 'transcript-turn');
  await engine.handle(handoff('whitespace', { input_transcript: ' ' }));
  await engine.handle(
    handoff('transcript-only', {
      input_transcript: '',
      active_transcript: [{ role: 'user', text: 'Private transcript reference' }],
    }),
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
  assert.equal(store.state.messages.length, 0);
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['voice_handoff_tracked', 'voice_handoff_tracked', 'voice_handoff_confirmed', 'voice_shutdown'],
  );
  assert.equal(
    defined(diagnostics.find((entry) => entry.code === 'voice_handoff_confirmed')).count,
    2,
  );
  assert.equal(JSON.stringify(diagnostics).includes('Private'), false);
});

test('a live thread snapshot can acknowledge an owned completed turn before its terminal notification arrives', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  await begin(engine, 'already-terminal');
  await engine.handle(handoff('terminal-proof'));
  worker.request = requestFixture((method, params) =>
    method === 'thread/read'
      ? Promise.resolve({
          thread: {
            id: 'thread',
            status: { type: 'idle' },
            turns: [{ id: 'already-terminal', status: 'completed' }],
          },
        })
      : request(method, params),
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/interrupt'),
    false,
  );
  assert.equal(defined(voice.state.lastStop).executorStopped, false);
  await engine.handle(
    event('turn/completed', { turn: { id: 'already-terminal', status: 'completed' } }),
  );
  assert.equal(engine.call, null);
});

test('a stalled or late reconciliation cannot unlock known work until a fresh read confirms detach', async (t) => {
  const { engine, voice, worker, store } = setup(t, { voice: { stopTimeoutMs: 15 } }),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  let reply: ((value: unknown) => void) | undefined;
  await begin(engine, 'reconciliation-timeout');
  await engine.handle(handoff('slow-proof'));
  worker.request = requestFixture((method, params) =>
    method === 'thread/read'
      ? new Promise((resolve) => (reply = resolve))
      : request(method, params),
  );
  await assert.rejects(engine.stopCall(call.callId), /shutdown could not be confirmed/);
  assert.equal(worker.terminated, 0);
  assert.equal(defined(engine.call).id, call.callId);
  assert.equal(defined(voice.state.lastStop).confirmed, false);
  const history = JSON.stringify(store.state.messages);
  defined(reply)({
    thread: {
      id: 'thread',
      status: { type: 'idle' },
      turns: [{ id: 'reconciliation-timeout', status: 'completed' }],
    },
  });
  await tick();
  assert.equal(JSON.stringify(store.state.messages), history);
  assert.equal(defined(engine.call).id, call.callId);
  assert.equal(defined(defined(voice.session).turns.get('reconciliation-timeout')).done, false);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/interrupt'),
    false,
  );
  worker.request = requestFixture(request);
  await engine.stopCall(call.callId);
  assert.equal(engine.call, null);
  assert.equal(defined(voice.active).turnId, 'reconciliation-timeout');
  await engine.handle(
    event('turn/completed', { turn: { id: 'reconciliation-timeout', status: 'completed' } }),
  );
  assert.equal(worker.terminated, 0);
});

test('handoff ledger stays bounded and unresolved or invalid authoritative snapshots cannot unlock work', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'limited-turn');
  for (let index = 0; index < 129; index++) await engine.handle(handoff('handoff-' + index));
  assert.equal(defined(voice.session).handoffs.size, 128);
  assert.equal(defined(voice.session).unknown, true);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 1);
  for (const snapshot of [
    { thread: { id: 'foreign-thread', turns: [] } },
    { thread: { id: 'thread', turns: null } },
    {
      thread: {
        id: 'thread',
        turns: [
          { id: 'known-turn', status: 'inProgress' },
          { id: 'known-turn', status: 'inProgress' },
        ],
      },
    },
    { thread: { id: 'thread', turns: [{ id: 'known-turn', status: 'unexpected' }] } },
    { thread: { id: 'thread', turns: [{ id: 'unknown-active', status: 'inProgress' }] } },
    { thread: { id: 'thread', turns: [] } },
  ]) {
    const { engine, voice, worker } = setup(t),
      call = await engine.startCall(sdp),
      request = worker.request.bind(worker);
    await begin(engine, 'known-turn');
    await engine.handle(handoff('snapshot-validation'));
    worker.request = requestFixture((method, params) =>
      method === 'thread/read' ? Promise.resolve(snapshot) : request(method, params),
    );
    if (snapshot.thread.turns?.some((turn) => turn.id === 'unknown-active')) {
      await engine.stopCall(call.callId);
      assert.equal(worker.terminated, 1);
      assert.equal(defined(voice.state.lastStop).confirmed, true);
    } else {
      await assert.rejects(engine.stopCall(call.callId), /shutdown could not be confirmed/);
      assert.equal(worker.terminated, 0);
      assert.equal(defined(engine.call).id, call.callId);
      assert.equal(defined(engine.call).status, 'stop-unconfirmed');
      assert.equal(defined(voice.session).unknown, false);
      assert.equal(defined(defined(voice.session).turns.get('known-turn')).done, false);
      worker.request = requestFixture(request);
      await engine.stopCall(call.callId);
      assert.equal(engine.call, null);
      assert.equal(defined(voice.active).turnId, 'known-turn');
      await engine.handle(
        event('turn/completed', { turn: { id: 'known-turn', status: 'completed' } }),
      );
      assert.equal(worker.terminated, 0);
    }
  }
});

test('subscription uses exact V3 WebRTC RPC and counts only confirmed connected calls', async (t) => {
  const { store, worker, engine, voice } = setup(t);
  assert.deepEqual(defined((await voice.listVoices()).voices).v3, ['ember', 'cove']);
  const result = await engine.startCall(sdp),
    request = worker.calls.find((call) => call.method === 'thread/realtime/start');
  assert.equal(result.provider, 'subscription');
  assert.equal(defined(request).params.version, 'v3');
  assert.equal(defined(request).params.model, NATIVE_REALTIME_MODEL);
  assert.equal(defined(request).params.voice, 'ember');
  assert.deepEqual(defined(request).params.transport, { type: 'webrtc', sdp });
  assert.equal(defined(engine.call).status, 'negotiating');
  assert.equal(store.state.messages.filter((message) => message.kind === 'call').length, 0);
  await assert.rejects(engine.stopCall('old-call'), /changed/);
  assert.throws(() => engine.confirmCallConnected('old-call'), /changed/);
  const connected = engine.confirmCallConnected(result.callId);
  assert.equal(defined(engine.call).status, 'connected');
  assert.equal(connected.connectedAt, defined(engine.call).connectedAt);
  assert.equal(engine.confirmCallConnected(result.callId).connectedAt, connected.connectedAt);
  defined(engine.call).connectedAt = defined(defined(engine.call).connectedAt) - 2100;
  await engine.stopCall(result.callId);
  assert.equal(engine.call, null);
  assert.equal(voice.call, null);
  assert.equal(worker.terminated, 0);
  const records = store.state.messages.filter((message) => message.kind === 'call');
  assert.equal(records.length, 1);
  assert.equal(defined(records[0]).provider, 'subscription');
  assert.equal(defined(records[0]).seconds, 2);
  assert.equal(defined(records[0]).text, '');
});

test('native startup receives the same full sanitized memory and records the speech tail before releasing its thread', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    memory =
      'Shared preference 中文😀 '.repeat(1800) +
      'SHARED_MEMORY_TAIL\nsk-fake_reference_token_do_not_use';
  engine.memory.write('working-memory.md', memory);
  const conversation = store.state.conversationId,
    call = await engine.startCall(sdp),
    start = worker.calls.find((item) => item.method === 'thread/realtime/start');
  assert.equal(defined(start).params.flushTranscriptTailOnSessionEnd, true);
  const reference = fixtureJson(
    defined(defined(defined(start).params.prompt).split('<dant_shared_memory>\n')[1]).split(
      '\n</dant_shared_memory>',
    )[0],
  );
  assert.equal(reference.memory, engine.memory.context());
  assert.ok(reference.memory.includes('SHARED_MEMORY_TAIL'));
  assert.equal(
    defined(defined(start).params.prompt).includes('sk-fake_reference_token_do_not_use'),
    false,
  );
  assert.equal(defined(start).params.threadId, 'thread');
  assert.equal(
    worker.calls.some((item) => item.method === 'thread/realtime/appendText'),
    false,
    'Codex owns native startup history without a redundant full-history replay',
  );
  await engine.handle(
    event('thread/realtime/transcriptDone', {
      role: 'user',
      text: 'Synthetic spoken fact stays in model history, not a visible chat message',
    }),
  );
  const request = worker.request.bind(worker);
  let persisted = false,
    release: (() => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/stop') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise(
      (resolve) =>
        (release = () => {
          persisted = true;
          worker.event('thread/realtime/closed');
          resolve({});
        }),
    );
  });
  const stopping = engine.stopCall(call.callId);
  await tick();
  assert.ok(engine.call);
  assert.equal(persisted, false);
  defined(release)();
  await stopping;
  assert.equal(persisted, true);
  assert.equal(engine.call, null);
  assert.equal(store.state.messages.length, 0);
  assert.equal(worker.terminated, 0);
  assert.equal(store.state.conversationId, conversation);
  assert.equal(store.state.threadId, 'thread');
  assert.equal(worker.calls.filter((item) => item.method === 'thread/start').length, 1);
  assert.equal(
    worker.calls.some((item) => ['turn/start', 'turn/steer'].includes(item.method)),
    false,
  );
  assert.equal(defined(voice.state.lastStop).executorStopped, false);
});

test('native startup retains Codex default history context and returns its acknowledged SDP without replaying history', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    memory = 'Current shared memory 中文😀 '.repeat(1800) + 'MEMORY_TAIL',
    request = worker.request.bind(worker);
  let accept: ((value: unknown) => void) | undefined,
    returned = false;
  worker.request = requestFixture((method, params) => {
    if (method === 'thread/realtime/start') {
      worker.calls.push({ method, params });
      queueMicrotask(() => worker.event('thread/realtime/started', { version: 'v3' }));
      return new Promise((resolve) => (accept = resolve));
    }
    if (method === 'thread/realtime/appendText')
      throw Error('Native startup must not replay full history');
    return request(method, params);
  });
  const starting = voice.start({ sdp, memory }).then((result) => {
    returned = true;
    return result;
  });
  await tick();
  assert.equal(returned, false);
  defined(accept)({});
  await tick();
  assert.equal(returned, false, 'start acknowledgement alone is not an SDP-ready session');
  worker.event('thread/realtime/sdp', { sdp });
  const call = await starting;
  assert.equal(call.sdp, sdp);
  assert.equal(defined(engine.call).status, 'negotiating');
  const start = worker.calls.find((item) => item.method === 'thread/realtime/start');
  assert.ok(defined(defined(start).params.prompt).startsWith(DANT_IDENTITY_INSTRUCTIONS + '\n\n'));
  assert.equal(
    fixtureJson(
      defined(defined(defined(start).params.prompt).split('<dant_shared_memory>\n')[1]).split(
        '\n</dant_shared_memory>',
      )[0],
    ).memory,
    memory,
  );
  assert.equal(
    Object.hasOwn(defined(start).params, 'includeStartupContext'),
    false,
    'the executor chooses its own startup history policy',
  );
  assert.equal(defined(voice.session).contextQueue, undefined);
  assert.equal(store.state.messages.length, 0);
  assert.equal(worker.calls.filter((item) => item.method === 'thread/start').length, 1);
  assert.equal(
    worker.calls.some((item) =>
      ['turn/start', 'turn/steer', 'thread/inject_items'].includes(item.method),
    ),
    false,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('native live memory snapshots replace unsent snapshots in the same owned reference queue without chat tasks', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker),
    baseline = worker.calls.length;
  let acknowledge: ((value: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return acknowledge ? Promise.resolve({}) : new Promise((resolve) => (acknowledge = resolve));
  });
  const first = voice.syncMemory({ memory: 'Earlier memory', callId: call.callId });
  await tick();
  const middle = voice.syncMemory({ memory: 'Unsent obsolete memory', callId: call.callId }),
    latest = 'Latest memory 中文😀 '.repeat(1000) + 'CURRENT_MEMORY_TAIL',
    last = voice.syncMemory({ memory: latest, callId: call.callId });
  assert.equal((await middle).status, 'superseded');
  assert.equal(
    (await voice.syncMemory({ memory: 'Wrong call', callId: 'other' })).status,
    'cancelled',
  );
  defined(acknowledge)({});
  assert.deepEqual(
    (await Promise.all([first, last])).map((item) => item.status),
    ['submitted', 'submitted'],
  );
  const calls = worker.calls
    .slice(baseline)
    .filter((item) => item.method === 'thread/realtime/appendText');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((item) => item.params.threadId === 'thread'));
  assert.equal(
    fixtureJson(
      defined(defined(defined(calls[1]).params.text).split('<dant_shared_memory>\n')[1]).split(
        '\n</dant_shared_memory>',
      )[0],
    ).memory,
    latest,
  );
  assert.match(defined(defined(calls[1]).params.text), /replaces earlier memory snapshots/);
  assert.match(defined(defined(calls[1]).params.text), /not new work/);
  assert.equal(store.state.messages.length, 0);
  assert.equal(
    worker.calls.some((item) => ['turn/start', 'turn/steer'].includes(item.method)),
    false,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('native uncertain or cancelled memory delivery never retries or crosses into another call', async (t) => {
  const { engine, voice, worker, store } = setup(t, { voice: { contextTimeoutMs: 10 } }),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  let late: ((value: unknown) => void) | undefined;
  const delayed = (method: string, params: RpcParams) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (late = resolve));
  };
  worker.request = requestFixture(delayed);
  const baseline = worker.calls.length;
  assert.equal(
    (await voice.syncMemory({ memory: 'Unconfirmed', callId: call.callId })).status,
    'unknown',
  );
  assert.equal(
    (await voice.syncMemory({ memory: 'Do not retry', callId: call.callId })).status,
    'unknown',
  );
  defined(late)({});
  await tick();
  assert.equal(
    worker.calls.slice(baseline).filter((item) => item.method === 'thread/realtime/appendText')
      .length,
    1,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
  voice.contextTimeoutMs = 1000;
  worker.request = requestFixture(request);
  const next = await engine.startCall(sdp);
  worker.request = requestFixture(delayed);
  const nextBaseline = worker.calls.length,
    pending = voice.syncMemory({ memory: 'In flight', callId: next.callId });
  await tick();
  const queued = voice.syncMemory({ memory: 'Queued old memory', callId: next.callId });
  await engine.stopCall(next.callId);
  assert.deepEqual(
    (await Promise.all([pending, queued])).map((item) => item.status),
    ['cancelled', 'cancelled'],
  );
  worker.request = requestFixture(request);
  const third = await engine.startCall(sdp);
  defined(late)({});
  await tick();
  assert.equal(
    worker.calls.slice(nextBaseline).filter((item) => item.method === 'thread/realtime/appendText')
      .length,
    1,
    'only the old in-flight memory was sent; the queued old snapshot cannot cross calls',
  );
  assert.equal(
    (await voice.syncMemory({ memory: 'Old owner', callId: next.callId })).status,
    'cancelled',
  );
  assert.equal(store.state.messages.length, 0);
  assert.equal(
    (await voice.syncMemory({ memory: 'Fresh current memory', callId: third.callId })).status,
    'submitted',
  );
  await engine.stopCall(third.callId);
  assert.equal(worker.terminated, 0);
});

test('typed native call messages stay in the current voice session without replaying finalized speech or creating a chat task', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    spoken = 'Spoken context 中文😀 '.repeat(1500) + 'HIDDEN_SPOKEN_TAIL',
    answer = 'Assistant spoken answer';
  await engine.handle(event('thread/realtime/transcript/done', { role: 'user', text: spoken }));
  await engine.handle(
    event('thread/realtime/transcript/done', { role: 'assistant', text: answer }),
  );
  assert.equal(store.state.messages.length, 0);
  await voice.message({
    clientMessageId: 'spoken-reference-task',
    text: 'Recall what I just said aloud.',
    callId: call.callId,
  });
  await engine.handle(
    event('thread/realtime/transcript/done', { role: 'user', text: 'Another spoken fact' }),
  );
  await voice.message({
    clientMessageId: 'spoken-reference-steer',
    text: 'Use the latest spoken fact too.',
    callId: call.callId,
  });
  const inputs = worker.calls.filter((item) => item.method === 'thread/realtime/appendText');
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every((item) => defined(item.params.text).includes('<dant_call_input>')));
  assert.equal(
    inputs.some(
      (item) =>
        defined(item.params.text).includes('HIDDEN_SPOKEN_TAIL') ||
        defined(item.params.text).includes(answer),
    ),
    false,
  );
  assert.equal(
    worker.calls.some((item) => ['turn/start', 'turn/steer'].includes(item.method)),
    false,
  );
  assert.equal(worker.calls.filter((item) => item.method === 'thread/inject_items').length, 2);
  assert.equal(
    store.state.messages.some(
      (item) => defined(item.text).includes('HIDDEN_SPOKEN_TAIL') || item.text === answer,
    ),
    false,
  );
  assert.equal(JSON.stringify(voice.state).includes('HIDDEN_SPOKEN_TAIL'), false);
  const session = voice.session;
  await engine.stopCall(call.callId);
  assert.deepEqual(defined(session).spokenContext, []);
  assert.equal(worker.terminated, 0);
});

test('native call input never replays private speech and quotes only redacted authoritative message context', async (t) => {
  const { dir, engine, voice, worker, store } = setup(t),
    vault = new CredentialVault({ dataDir: dir }),
    secret = 'synthetic-secret-crossing-finalized-parts';
  vault.upsert({
    name: 'Synthetic test credential',
    service: 'test.invalid',
    username: 'fixture',
    secret,
  });
  engine.credentials = new CredentialRequests({ vault });
  const call = await engine.startCall(sdp),
    session = voice.session;
  for (const params of [
    { threadId: 'foreign-thread', role: 'user', text: 'wrong-thread' },
    { realtimeSessionId: 'foreign-session', role: 'user', text: 'wrong-session' },
    { callId: 'foreign-call', role: 'user', text: 'wrong-call' },
    { role: 'system', text: 'wrong-role' },
    { role: 'user', text: 42 },
    { role: 'user', text: '' },
  ])
    await engine.handle(event('thread/realtime/transcript/done', params));
  await engine.handle(
    event('thread/realtime/transcript/done', { role: 'user', text: secret.slice(0, 17) }),
  );
  await engine.handle(
    event('thread/realtime/transcript/done', { role: 'user', text: secret.slice(17) }),
  );
  await engine.handle(
    event('thread/realtime/transcript/done', { role: 'assistant', text: 'Acknowledged' }),
  );
  for (let n = 0; n < 2; n++)
    await engine.handle(
      event('thread/realtime/transcript/done', { role: 'user', text: 'A repeated real utterance' }),
    );
  assert.equal(
    defined(session).spokenContext.filter((item) => item.text === 'A repeated real utterance')
      .length,
    2,
  );
  assert.equal(
    defined(session).spokenContext.some((item) => item.text.includes('wrong-')),
    false,
  );
  const reply = store.add({ role: 'assistant', text: 'A referenced answer containing ' + secret });
  await voice.message({
    clientMessageId: 'redacted-spoken-context',
    text: 'Use this context.',
    replyTo: reply.id,
    callId: call.callId,
  });
  const input = defined(worker.calls.find((item) => item.method === 'thread/realtime/appendText'))
    .params.text;
  assert.equal(defined(input).includes(secret), false);
  assert.match(defined(input), /credential redacted/);
  assert.equal(defined(input).includes('A repeated real utterance'), false);
  assert.equal(store.state.messages.length, 2);
  const request = worker.request.bind(worker);
  let release: ((value?: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) =>
    method === 'thread/realtime/stop'
      ? new Promise(
          (resolve) =>
            (release = () => {
              worker.event('thread/realtime/closed');
              resolve({});
            }),
        )
      : request(method, params),
  );
  const stopping = engine.stopCall(call.callId);
  await tick();
  const before = defined(session).spokenContext.length;
  await engine.handle(
    event('thread/realtime/transcript/done', { role: 'user', text: 'during-stop' }),
  );
  assert.equal(defined(session).spokenContext.length, before);
  defined(release)();
  await stopping;
  assert.deepEqual(defined(session).spokenContext, []);
  worker.request = requestFixture(request);
  await engine.pause();
  const next = await engine.startCall(sdp);
  await engine.handle(
    event('thread/realtime/transcript/done', {
      realtimeSessionId: 'native-' + call.callId,
      role: 'user',
      text: 'old-call',
    }),
  );
  assert.deepEqual(defined(voice.session).spokenContext, []);
  await engine.stopCall(next.callId);
  assert.equal(worker.terminated, 0);
});

test('native subscription startup anchors the same assistant identity for English and Chinese without reversing live chat roles', async (t) => {
  for (const language of ['en', 'zh'] as const) {
    const { engine, voice, worker, store } = setup(t);
    store.state.settings.language = language;
    const human = store.add({
        role: 'user',
        text:
          language === 'zh'
            ? '你是谁？我没有告诉过你我的姓名。'
            : 'Who are you? I have not supplied my name.',
        status: 'review',
      }),
      assistant = store.add({
        role: 'assistant',
        text: language === 'zh' ? '我是 dant，你的数字伙伴。' : "I'm dant, your digital coworker.",
        status: 'completed',
      });
    const conversation = store.state.conversationId,
      call = await engine.startCall(sdp),
      request = worker.calls.find((item) => item.method === 'thread/realtime/start');
    assert.ok(
      defined(defined(request).params.realtimeStartInstructions).startsWith(
        DANT_IDENTITY_INSTRUCTIONS + '\n\n',
      ),
    );
    assert.ok(
      defined(request).params.prompt?.startsWith(DANT_IDENTITY_INSTRUCTIONS + '\n\n'),
      'the actual voice-model prompt must bind dant to the assistant, independently of backend mode instructions',
    );
    assert.match(
      defined(defined(request).params.prompt),
      /dant_spoken_reference data uses its explicit inner speaker role/,
    );
    assert.match(
      defined(defined(request).params.prompt),
      /transport-user wrapper does not turn quoted assistant speech into human speech/,
    );
    assert.match(defined(defined(request).params.prompt), /\[USER\].*human/);
    assert.match(defined(defined(request).params.prompt), /\[BACKEND\].*backend/);
    assert.match(
      defined(defined(request).params.prompt),
      /delegate to the backend immediately using native delegation/,
    );
    assert.match(defined(defined(request).params.prompt), /Do not merely promise or narrate/);
    assert.match(
      defined(defined(request).params.prompt),
      /Only the backend can run computer tools or call send_message, send_file, and end_call/,
    );
    assert.match(
      defined(defined(request).params.prompt),
      /Wait for a successful backend result before saying an action or delivery succeeded/,
    );
    assert.match(
      defined(defined(request).params.prompt),
      /Current dant_call_input messages are the human typing into this same call/,
    );
    assert.match(
      defined(defined(request).params.prompt),
      /never delegate or execute those references as another request/,
    );
    assert.match(
      defined(defined(request).params.prompt),
      /Do not copy speech transcripts into chat/,
    );
    assert.notEqual(defined(request).params.includeStartupContext, false);
    assert.equal(defined(request).params.threadId, 'thread');
    assert.equal(defined(request).params.clientManagedHandoffs, false);
    assert.equal(defined(request).params.flushTranscriptTailOnSessionEnd, true);
    for (const message of [human, assistant]) {
      const result = await voice.syncContext({ kind: 'message', message, callId: call.callId });
      assert.equal(result.status, 'submitted');
    }
    const contexts = liveReferences(worker).map((item) => {
      assert.equal(item.params.threadId, 'thread');
      const json = defined(defined(item.params.text).split('<dant_live_reference>\n')[1]).split(
        '\n</dant_live_reference>',
      )[0];
      return fixtureJson(json);
    });
    assert.deepEqual(
      contexts.map((item) => item.role),
      ['user', 'assistant'],
    );
    assert.deepEqual(
      contexts.map((item) => item.messageId),
      [human.id, assistant.id],
    );
    assert.equal(
      worker.calls.some((item) => ['turn/start', 'turn/steer'].includes(item.method)),
      false,
    );
    assert.equal(store.state.conversationId, conversation);
    assert.deepEqual(
      store.state.messages.map((item) => item.role),
      ['user', 'assistant'],
    );
    await engine.stopCall(call.callId);
    assert.equal(worker.terminated, 0);
  }
});

test('started and SDP events preceding the start acknowledgement are retained', async (t) => {
  const { worker, engine } = setup(t);
  let acknowledge: ((value: unknown) => void) | undefined;
  const request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/start') return request(method, params);
    worker.calls.push({ method, params });
    worker.event('thread/realtime/started', { version: 'v3' });
    worker.event('thread/realtime/sdp', { sdp });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  let returned = false;
  const starting = engine.startCall(sdp).then((result) => {
    returned = true;
    return result;
  });
  await tick();
  assert.equal(returned, false);
  assert.ok(engine.call);
  defined(acknowledge)({});
  const call = await starting;
  assert.equal(call.sdp, sdp);
  await engine.stopCall(call.callId);
});

test('negotiation close has no call record and never falls back to API billing', async (t) => {
  const { store, engine } = setup(t);
  let apiStarts = 0;
  engine.voice = {
    stop: async () => {
      throw Error('Unexpected API stop');
    },
    start: () => {
      apiStarts++;
      throw Error('unexpected API fallback');
    },
  };
  const result = await engine.startCall(sdp);
  await engine.stopCall(result.callId);
  assert.equal(apiStarts, 0);
  assert.equal(store.state.messages.length, 0);
});

test('native owns only its thread and announced background turns; speech is ephemeral', async (t) => {
  const { store, worker, engine } = setup(t);
  const call = await engine.startCall(sdp);
  assert.equal(engine.active, null);
  await engine.handle(
    event('thread/realtime/transcriptDone', { role: 'user', text: 'private speech' }),
  );
  await engine.handle(
    event('item/completed', {
      turnId: 'other-turn',
      item: { id: 'foreign', type: 'agentMessage', text: 'wrong thread' },
      threadId: 'other-thread',
    }),
  );
  await begin(engine, 'background');
  await engine.handle(
    event('item/agentMessage/delta', {
      turnId: 'background',
      itemId: 'speech',
      delta: 'Do not store my transcript',
    }),
  );
  await tool(engine, 'background', 'send_message', { text: 'Requested useful link' }, 1);
  await engine.handle(event('turn/completed', { turn: { id: 'background', status: 'completed' } }));
  assert.deepEqual(
    store.state.messages.map((message) => message.text),
    ['Requested useful link'],
  );
  assert.equal(
    defined(defined(worker.responses.find((response) => response.id === 1)).result).success,
    true,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('background file delivery archives only explicit output and never duplicates final archive', async (t) => {
  const collector = new FixtureCollector(),
    captures: Array<{ outputDir: string } & DeliverableOwnership> = [],
    archives: DeliverableArchiveInput[] = [];
  const baseline: DeliverableBaseline = { valid: true, hashes: new Map() };
  collector.captureBaseline = async (args) => {
    captures.push(args);
    return baseline;
  };
  collector.archive = async (args) => {
    archives.push(args);
    return [{ id: 'file', name: 'result.wav', sha256: 'hash' }];
  };
  const { store, engine, worker } = setup(t, { engine: { deliverables: collector } }),
    call = await engine.startCall(sdp);
  await begin(engine, 'background');
  worker.createVoiceMessage = async ({ text, outputDir }) => {
    assert.equal(text, 'Hello');
    assert.equal(outputDir, engine.outputDir);
    return { type: 'voice', path: path.join(defined(outputDir), 'result.wav') };
  };
  await tool(engine, 'background', 'create_voice_message', { text: 'Hello' }, 1);
  await engine.handle(event('turn/completed', { turn: { id: 'background', status: 'completed' } }));
  assert.equal(captures.length, 1);
  assert.equal(defined(archives[0]).onlyExplicit, true);
  assert.equal(defined(archives[0]).baseline, baseline);
  assert.equal(defined(defined(worker.responses[0]).result).success, true);
  assert.equal(store.state.messages.flatMap((message) => message.attachments || []).length, 1);
  await engine.stopCall(call.callId);
});

test('normal work stays paused and takeover waits for established native media', async (t) => {
  const { store, worker, engine } = setup(t),
    call = await engine.startCall(sdp),
    message = store.add({ role: 'user', text: 'Later task' });
  engine.enqueue(message);
  assert.equal(message.status, 'paused');
  assert.equal(message.pauseReason, 'voice-call');
  await assert.rejects(engine.acquire(), /Wait for the voice call/);
  await engine.stopCall(call.callId);
  await tick();
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 0);
  assert.equal(message.status, 'paused');
});

test('desktop takeover pauses actual native work while retaining speech and storing typed control context without execution', async (t) => {
  const { store, worker, engine, voice } = setup(t),
    call = await engine.startCall(sdp);
  engine.confirmCallConnected(call.callId);
  const sent = await voice.message({
    clientMessageId: 'manual-login-task',
    text: 'Open the login page',
  });
  await begin(engine, 'manual-login-work');
  const session = voice.session,
    liveCall = engine.call;
  const lease: Array<Record<string, unknown>> = [];
  worker.guest = async (route, body) => {
    const data = observedRecord(body);
    lease.push({ route, ...data });
    return Response.json({
      status:
        observedRecord(body).action === 'release'
          ? 'dant'
          : observedRecord(body).action === 'acquire'
            ? 'taking-over'
            : 'human',
      sessionId: observedRecord(body).action === 'release' ? null : 'human-lease',
      expiresAt: Date.now() + 120000,
    });
  };
  const computer = new ComputerSession(engine, worker);
  t.after(() => computer.close());
  const taken = await computer.acquire();
  assert.equal(taken.status, 'human');
  assert.equal(engine.takeover, true);
  assert.equal(voice.session, session);
  assert.equal(engine.call, liveCall);
  assert.equal(defined(engine.call).status, 'connected');
  assert.equal(sent.message.status, 'accepted');
  assert.equal(defined(defined(session).turns.get('manual-login-work')).finalStatus, 'paused');
  assert.equal(worker.terminated, 0);
  assert.deepEqual(
    worker.calls.filter((entry) => entry.method === 'turn/interrupt').map((entry) => entry.params),
    [{ threadId: 'thread', turnId: 'manual-login-work' }],
  );
  assert.equal(
    worker.calls.some((entry) => entry.method === 'thread/realtime/stop'),
    false,
  );
  const paused = await voice.message({
    clientMessageId: 'typed-while-manual',
    text: 'I am entering the password myself',
  });
  assert.equal(paused.message.status, 'paused');
  assert.equal(paused.message.pauseReason, 'human-control');
  assert.equal(defined(paused.voiceContext).status, 'submitted');
  assert.equal(
    defined(defined(liveReferences(worker).at(-1)).params.text).includes(
      'I am entering the password myself',
    ),
    true,
  );
  await computer.input({ sessionId: taken.sessionId, type: 'key', key: 'Tab' });
  await computer.release(taken.sessionId);
  await tick();
  assert.equal(engine.takeover, false);
  assert.equal(engine.call, liveCall);
  assert.equal(voice.session, session);
  assert.equal(paused.message.status, 'paused');
  const fresh = await voice.message({
    clientMessageId: 'continue-after-manual',
    text: 'I have finished. Continue now.',
  });
  assert.equal(fresh.message.status, 'accepted');
  assert.equal(
    worker.calls.some((entry) => ['turn/start', 'turn/steer'].includes(entry.method)),
    false,
  );
  assert.equal(
    store.state.messages.some((message) => message.id === sent.message.id),
    true,
  );
  await engine.pause();
  await engine.stopCall(call.callId);
  assert.deepEqual(
    lease.filter((entry) => entry.route === '/control').map((entry) => entry.action),
    ['acquire', 'confirm', 'release'],
  );
});

test('new native spoken work is interrupted during human control without closing media or replaying late admissions', async (t) => {
  const { worker, engine, voice } = setup(t),
    call = await engine.startCall(sdp);
  engine.confirmCallConnected(call.callId);
  await engine.acquire();
  const session = voice.session;
  await begin(engine, 'while-held');
  await tick();
  await engine.handle(handoff('held-receipt'));
  await defined(session).eventChain;
  assert.equal(defined(defined(session).turns.get('while-held')).done, true);
  assert.equal(defined(defined(session).turns.get('while-held')).pauseRequested, true);
  assert.equal(engine.takeover, true);
  assert.equal(defined(engine.call).id, call.callId);
  assert.equal(defined(engine.call).status, 'connected');
  await engine.handle(handoff('late-held-receipt'));
  assert.equal(defined(defined(session).handoffs.get('late-held-receipt')).humanControl, true);
  engine.release();
  await begin(engine, 'late-after-return');
  await tick();
  await defined(session).eventChain;
  assert.equal(defined(defined(session).turns.get('late-after-return')).done, true);
  assert.equal(defined(defined(session).turns.get('late-after-return')).pauseRequested, true);
  assert.equal(defined(engine.call).status, 'connected');
  assert.equal(worker.terminated, 0);
  assert.deepEqual(
    worker.calls
      .filter((entry) => entry.method === 'turn/interrupt')
      .map((entry) => entry.params.turnId),
    ['while-held', 'late-after-return'],
  );
  assert.equal(
    worker.calls.some(
      (entry) =>
        entry.method === 'thread/realtime/stop' ||
        entry.method === 'turn/start' ||
        entry.method === 'turn/steer',
    ),
    false,
  );
  await engine.stopCall(call.callId);
});

test('native ownership uncertainty blocks takeover before requesting a guest lease', async (t) => {
  const { worker, engine, voice } = setup(t),
    call = await engine.startCall(sdp);
  engine.confirmCallConnected(call.callId);
  const guest: Array<{ route: string; body: unknown }> = [];
  worker.guest = async (route, body) => {
    guest.push({ route, body });
    throw Error('Must not reach guest');
  };
  const computer = new ComputerSession(engine, worker);
  t.after(() => computer.close());
  for (const patch of [
    { unknown: true },
    { stopping: true },
    { closed: true },
    { submitting: {} },
    { pausing: true },
    { background: true },
    { status: 'negotiating' },
  ]) {
    const previous = Object.fromEntries(
      Object.keys(patch).map((key) => [key, Reflect.get(defined(voice.session), key)]),
    );
    Object.assign(defined(voice.session), patch);
    await assert.rejects(computer.acquire(), /Wait for the voice call/);
    Object.assign(defined(voice.session), previous);
    assert.equal(engine.takeover, false);
    assert.equal(engine.acquiring, false);
  }
  await engine.handle(handoff('unresolved-before-takeover'));
  await assert.rejects(computer.acquire(), /Wait for the voice call/);
  assert.deepEqual(guest, []);
  await engine.stopCall(call.callId);
});

test('takeover never grants ownership after the captured call changes while its task pauses', async (t) => {
  const { worker, engine, voice } = setup(t),
    call = await engine.startCall(sdp);
  engine.confirmCallConnected(call.callId);
  await begin(engine, 'pause-before-call-change');
  const request = worker.request.bind(worker);
  let interrupt: (() => void) | undefined;
  worker.request = requestFixture((method, params) =>
    method === 'turn/interrupt'
      ? new Promise(
          (resolve) =>
            (interrupt = () => {
              worker.event('turn/completed', {
                turn: { id: defined(params).turnId, status: 'interrupted' },
              });
              resolve({});
            }),
        )
      : request(method, params),
  );
  const taking = engine.acquire(),
    rejected = assert.rejects(taking, /voice call changed/);
  while (!interrupt) await tick();
  engine.call = null;
  defined(interrupt)();
  await rejected;
  assert.equal(engine.takeover, false);
  assert.equal(engine.acquiring, false);
  assert.equal(defined(voice.session).unknown, false);
  assert.equal(worker.terminated, 0);
  engine.call = {
    id: call.callId,
    provider: 'subscription',
    connectedAt: 123,
    status: 'connected',
  };
  await engine.stopCall(call.callId);
});

test('connected API media survives matched task pause and blocks new computer work until explicit return', async (t) => {
  const { engine, worker } = setup(t),
    call = { id: 'api-live', provider: 'api', status: 'connected', connectedAt: 123 } as const;
  engine.call = call;
  let mediaStops = 0;
  engine.voice = {
    start: async () => {
      throw Error('Unexpected start');
    },
    call: { callId: call.id, status: 'active' },
    async stop() {
      mediaStops++;
    },
  };
  const task = engine.runVoiceTask('Open the sign-in screen'),
    paused = assert.rejects(task, /paused/);
  await tick();
  const turnId = defined(engine.active).turnId;
  await engine.acquire();
  await paused;
  assert.equal(engine.takeover, true);
  assert.equal(engine.call, call);
  assert.equal(mediaStops, 0);
  assert.deepEqual(
    worker.calls.filter((entry) => entry.method === 'turn/interrupt').map((entry) => entry.params),
    [{ threadId: 'thread', turnId }],
  );
  await assert.rejects(engine.runVoiceTask('Do not run while I type'), /Return the desktop/);
  engine.release();
  await tick();
  assert.equal(engine.call, call);
  assert.equal(worker.calls.filter((entry) => entry.method === 'turn/start').length, 1);
  assert.equal(worker.terminated, 0);
  defined(defined(engine.voice).call).status = 'stopping';
  await assert.rejects(engine.acquire(), /Wait for the voice call/);
  assert.equal(engine.takeover, false);
});

test('explicit safety stop waits for a known background turn interrupt completion before release', async (t) => {
  const { worker, engine } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'background');
  let interrupt: RpcParams | undefined;
  const request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) => {
    if (method !== 'turn/interrupt') return request(method, params);
    interrupt = params;
    return Promise.resolve({});
  });
  let ended = false;
  const stopping = engine.stopCall(call.callId, { continueWork: false }).then(() => (ended = true));
  await tick();
  assert.ok(interrupt);
  assert.equal(ended, false);
  assert.ok(engine.call);
  await engine.handle(
    event('turn/completed', { turn: { id: 'background', status: 'interrupted' } }),
  );
  await stopping;
  assert.equal(engine.call, null);
  assert.equal(worker.terminated, 0);
});

test('unknown background handoff rejects effects and confirms process termination before unlock', async (t) => {
  const { store, worker, engine } = setup(t),
    call = await engine.startCall(sdp);
  await tool(engine, 'unannounced', 'send_message', { text: 'must not be sent' }, 1);
  assert.equal(store.state.messages.length, 0);
  assert.ok(defined(worker.responses[0]).error);
  let confirm: ((value: { terminated: boolean }) => void) | undefined;
  worker.terminateConfirmed = () => new Promise((resolve) => (confirm = resolve));
  let ended = false;
  const stopping = engine.stopCall(call.callId).then(() => (ended = true));
  await tick();
  assert.ok(confirm);
  assert.equal(ended, false);
  assert.ok(engine.call);
  defined(confirm)({ terminated: true });
  await stopping;
  assert.equal(engine.call, null);
  assert.equal(engine.loaded, false);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('missing closed confirmation terminates executor and failed termination retains the call lock', async (t) => {
  const { worker, engine, voice } = setup(t, { voice: { stopTimeoutMs: 10 } }),
    call = await engine.startCall(sdp);
  const request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) =>
    method === 'thread/realtime/stop' ? Promise.resolve({}) : request(method, params),
  );
  worker.terminateConfirmed = async () => {
    throw Error('Actual process exit not confirmed');
  };
  await assert.rejects(engine.stopCall(call.callId), /not confirmed/);
  assert.ok(engine.call);
  assert.equal(engine.call.status, 'stop-unconfirmed');
  assert.equal(defined(voice.call).status, 'stop-unconfirmed');
  await assert.rejects(engine.acquire(), /Wait for the voice call/);
  worker.terminateConfirmed = async () => ({ terminated: true });
  await engine.stopCall(call.callId);
  assert.equal(engine.call, null);
  assert.equal(voice.call, null);
});

test('stop while only reserved cancels the pending start without reviving it', async (t) => {
  const { engine, worker, store } = setup(t);
  let prepared: ((value: Awaited<ReturnType<Engine['prepareInput']>>) => void) | undefined;
  engine.prepareInput = () => new Promise((resolve) => (prepared = resolve));
  const message = store.add({ role: 'user', text: 'An already requested task' });
  engine.enqueue(message);
  await tick();
  const owner = engine.active;
  assert.ok(prepared);
  const starting = engine.startCall(sdp),
    cancelled = assert.rejects(starting, /cancelled/);
  const callId = defined(engine.call).id;
  await engine.stopCall(callId);
  assert.equal(engine.call, null);
  assert.equal(engine.active, owner);
  assert.equal(defined(owner).stopRequested, undefined);
  defined(prepared)(engine.input(message));
  await cancelled;
  assert.equal(
    worker.calls.some((call) => call.method === 'thread/realtime/start'),
    false,
  );
  assert.equal(defined(owner).startAcknowledged, true);
  await engine.handle(
    event('turn/completed', { turn: { id: defined(owner).turnId, status: 'completed' } }),
  );
});

test('stop while opening a thread does not send realtime start or kill an idle executor', async (t) => {
  const { engine, worker } = setup(t);
  let acknowledge: ((value: unknown) => void) | undefined;
  const request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) =>
    method === 'thread/start'
      ? new Promise((resolve) => (acknowledge = resolve))
      : request(method, params),
  );
  const starting = engine.startCall(sdp);
  await tick();
  const callId = defined(engine.call).id;
  await engine.stopCall(callId);
  assert.equal(engine.call, null);
  defined(acknowledge)({ thread: { id: 'thread' } });
  await assert.rejects(starting, /cancelled/);
  assert.equal(
    worker.calls.some((call) => call.method === 'thread/realtime/start'),
    false,
  );
  assert.equal(worker.terminated, 0);
});

test('lost start acknowledgement terminates the old process and never retries the start', async (t) => {
  const { worker, engine } = setup(t, { voice: { connectTimeoutMs: 10 } }),
    request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) => {
    if (method === 'thread/realtime/start') {
      worker.calls.push({ method, params });
      return new Promise(() => {});
    }
    return request(method, params);
  });
  await assert.rejects(engine.startCall(sdp), /timed out/);
  assert.equal(worker.terminated, 1);
  assert.equal(engine.call, null);
  assert.equal(worker.calls.filter((call) => call.method === 'thread/realtime/start').length, 1);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('only validated owned MCP delivery payloads publish chat once; ordinary final speech stays ephemeral', async (t) => {
  const { store, engine } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'background');
  const item = {
    id: 'mcp-message',
    type: 'mcpToolCall',
    server: 'dant_desktop',
    tool: 'send_chat_message',
    status: 'completed',
    arguments: { text: 'Useful result' },
    result: { structuredContent: { dantMessage: { text: 'Useful result' } } },
  };
  await engine.handle(
    event('item/completed', { turnId: 'background', item: { ...item, server: 'untrusted' } }),
  );
  await engine.handle(
    event('item/completed', {
      turnId: 'background',
      item: { ...item, result: { structuredContent: { dantMessage: { text: 'mismatch' } } } },
    }),
  );
  assert.equal(store.state.messages.length, 0);
  await engine.handle(event('item/completed', { turnId: 'background', item }));
  await engine.handle(event('item/completed', { turnId: 'background', item }));
  await engine.handle(
    event('item/completed', {
      turnId: 'background',
      item: { id: 'ordinary', type: 'agentMessage', text: 'Useful result' },
    }),
  );
  assert.deepEqual(
    store.state.messages.map((message) => message.text),
    ['Useful result'],
  );
  await engine.handle(event('turn/completed', { turn: { id: 'background', status: 'completed' } }));
  await engine.stopCall(call.callId);
});

test('MCP voice result follows explicit archive and all native background outputs share a 120k budget', async (t) => {
  const collector = new FixtureCollector(),
    archives: DeliverableArchiveInput[] = [];
  collector.captureBaseline = async () => ({ valid: true, hashes: new Map() });
  collector.archive = async (options) => {
    archives.push(options);
    return [{ id: 'voice', name: 'voice.wav', sha256: 'wav' }];
  };
  const { engine, store, voice } = setup(t, { engine: { deliverables: collector } }),
    call = await engine.startCall(sdp);
  await begin(engine, 'background');
  const file = path.join(engine.outputDir, 'voice.wav'),
    payload = { voiceFile: { path: file } };
  await engine.handle(
    event('item/completed', {
      turnId: 'background',
      item: {
        id: 'mcp-voice',
        type: 'mcpToolCall',
        server: 'dant_desktop',
        tool: 'create_voice_message',
        status: 'completed',
        arguments: { text: 'Hello' },
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      },
    }),
  );
  assert.equal(defined(archives[0]).onlyExplicit, true);
  assert.deepEqual(defined(archives[0]).explicitPaths, [file]);
  assert.equal(defined(defined(defined(store.state.messages[0]).attachments)[0]).id, 'voice');
  for (let index = 0; index < 3; index++)
    await engine.handle(
      event('item/agentMessage/delta', {
        turnId: 'background',
        itemId: 'item-' + index,
        delta: 'x'.repeat(80000),
      }),
    );
  assert.equal(
    [...defined(defined(voice.session).turns.get('background')).outputs.values()].reduce(
      (sum, text) => sum + text.length,
      0,
    ),
    120000,
  );
  await engine.handle(event('turn/completed', { turn: { id: 'background', status: 'completed' } }));
  await engine.stopCall(call.callId);
});

test('raw handoff_request forces confirmed executor termination even with no announced background turn', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp);
  await engine.handle(
    event('thread/realtime/itemAdded', {
      item: { type: 'handoff_request', handoff_id: 'unobservable' },
    }),
  );
  await assert.rejects(
    voice.message({ clientMessageId: 'message-after-handoff', text: 'Do something' }),
    /handoff.*unconfirmed/,
  );
  assert.equal(store.state.messages.length, 0);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 1);
  assert.equal(engine.call, null);
  assert.equal(defined(voice.state.lastStop).reason, 'untracked-handoff');
  assert.equal(defined(voice.state.lastStop).executorStopped, true);
  assert.equal(defined(voice.state.lastStop).confirmed, true);
  assert.equal(defined(voice.state.lastStop).method, 'thread/realtime/itemAdded');
  assert.match(defined(voice.state.error), /Only the Codex executor was stopped/);
});

test('typed native input waits for current voice admission, preserves quoted context and deduplicates client IDs without a chat task', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    reply = store.add({ role: 'assistant', text: 'I can create a room and give you its code.' }),
    request = worker.request.bind(worker);
  let acknowledge: ((value: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  const sending = voice.message({
    clientMessageId: 'explicit-one',
    text: '这个',
    replyTo: reply.id,
    callId: call.callId,
  });
  await tick();
  assert.equal(typeof acknowledge, 'function');
  assert.equal(defined(store.state.messages[1]).executorConfirmedAt, null);
  assert.equal(defined(voice.session).turns.size, 0);
  defined(acknowledge)({});
  const result = await sending;
  assert.equal(result.message.status, 'accepted');
  assert.ok(result.message.executorConfirmedAt);
  assert.equal(result.turnId, undefined);
  assert.equal(store.state.completions.length, 0);
  const live = worker.calls.find((call) => call.method === 'thread/realtime/appendText'),
    input = fixtureJson(
      defined(defined(defined(live).params.text).split('<dant_call_input>\n')[1]).split(
        '\n</dant_call_input>',
      )[0],
    );
  assert.equal(input.text, '这个');
  assert.deepEqual(input.quotedMessage, {
    messageId: reply.id,
    role: 'assistant',
    text: reply.text,
    attachments: [],
  });
  assert.match(defined(defined(live).params.text), /Respond naturally aloud/);
  await begin(engine, 'voice-delegated');
  await engine.handle(
    event('item/completed', {
      turnId: 'voice-delegated',
      item: { id: 'answer', type: 'agentMessage', text: 'The room is ready' },
    }),
  );
  await engine.handle(
    event('turn/completed', { turn: { id: 'voice-delegated', status: 'completed' } }),
  );
  assert.equal(store.state.messages.length, 2);
  assert.equal(store.state.completions.length, 0);
  const repeated = await voice.message({
    clientMessageId: 'explicit-one',
    text: '这个',
    replyTo: reply.id,
    callId: call.callId,
  });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.message.id, result.message.id);
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  assert.equal(worker.calls.filter((call) => call.method === 'thread/inject_items').length, 1);
  assert.equal(
    worker.calls.some((call) => ['turn/start', 'turn/steer'].includes(call.method)),
    false,
  );
  await engine.stopCall(call.callId);
});

test('reaction changes reach the existing call without creating a chat task or accepting work', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp);
  engine.confirmCallConnected(call.callId);
  const target = store.add({
    role: 'assistant',
    text: 'Here is your picture',
    attachments: [{ id: 'picture', name: 'picture.png' }],
    reactions: ['👍'],
  });
  const first = await voice.syncContext({ kind: 'reaction', message: target, callId: call.callId });
  assert.equal(first.status, 'submitted');
  store.update(target.id, { reactions: [] });
  await voice.syncContext({ kind: 'reaction', message: target, callId: call.callId });
  const requests = liveReferences(worker);
  assert.equal(requests.length, 2);
  assert.match(defined(defined(requests[0]).params.text), /picture\.png/);
  assert.match(defined(defined(requests[0]).params.text), /👍/);
  assert.match(defined(defined(requests[1]).params.text), /"reactions":\[\]/);
  assert.equal(
    worker.calls.some((call) =>
      ['turn/start', 'turn/steer', 'response.create'].includes(call.method),
    ),
    false,
  );
  assert.equal(store.state.messages.length, 1);
  assert.equal(target.status, undefined);
  const stale = await voice.syncContext({ kind: 'reaction', message: target, callId: 'previous' });
  assert.equal(stale.status, 'cancelled');
  assert.equal(requests.length, 2);
  await engine.stopCall(call.callId);
  assert.equal(
    (await voice.syncContext({ kind: 'reaction', message: target, callId: call.callId })).status,
    'cancelled',
  );
});

test('lost authoritative voice admission pauses typed input and duplicate delivery never replays it', async (t) => {
  const { engine, voice, worker, store } = setup(t, { voice: { contextTimeoutMs: 10 } }),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  let acknowledge: ((value: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  await assert.rejects(
    voice.message({
      clientMessageId: 'live-timeout',
      text: 'Use the blue background',
      callId: call.callId,
    }),
    (error) => operationError(error).unknownOutcome === true,
  );
  const message = store.state.messages[0];
  assert.equal(defined(message).submission, 'unknown');
  assert.equal(defined(message).status, 'paused');
  assert.equal(defined(defined(message).voiceContext).status, 'unknown');
  assert.equal(defined(message).executorConfirmedAt, null);
  assert.equal(defined(voice.session).unknown, true);
  const duplicate = await voice.message({
    clientMessageId: 'live-timeout',
    text: 'Use the blue background',
    callId: call.callId,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.unknownOutcome, true);
  defined(acknowledge)({});
  await tick();
  assert.equal(defined(message).submission, 'unknown');
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 1);
});

test('ending a call cancels live context immediately and never forwards it into the next call', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  let acknowledge: ((value: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  const target = store.add({ role: 'assistant', text: 'reference' }),
    first = voice.syncContext({ kind: 'reaction', message: target, callId: call.callId });
  await tick();
  const second = voice.syncContext({
    kind: 'reaction',
    message: { ...target, reactions: ['❤️'] },
    callId: call.callId,
  });
  await engine.stopCall(call.callId);
  assert.equal((await first).status, 'cancelled');
  assert.equal((await second).status, 'cancelled');
  worker.request = requestFixture(request);
  const next = await engine.startCall(sdp);
  defined(acknowledge)({});
  await tick();
  assert.equal(liveReferences(worker).length, 1);
  assert.equal(defined(engine.call).id, next.callId);
  await engine.stopCall(next.callId);
});

test('stored native call input validates exact ownership, deduplicates its pending admission and cannot cross calls', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    message = store.add({ role: 'user', text: 'Tell me about this', replyTo: null }),
    request = worker.request.bind(worker);
  let acknowledge: ((value: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  await assert.rejects(
    voice.submitCallMessage({ ...message }, { callId: call.callId }),
    /stored nonempty text/,
  );
  await assert.rejects(voice.submitCallMessage(message, { callId: 'other' }), /changed/);
  const sending = voice.submitCallMessage(message, { callId: call.callId });
  assert.equal(voice.submitCallMessage(message, { callId: call.callId }), sending);
  await tick();
  assert.equal(message.executorConfirmedAt, null);
  defined(acknowledge)({});
  await sending;
  assert.equal(message.status, 'accepted');
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  await engine.stopCall(call.callId);
  worker.request = requestFixture(request);
  const next = await engine.startCall(sdp);
  await assert.rejects(voice.submitCallMessage(message, { callId: next.callId }), /another call/);
  assert.equal(message.status, 'accepted');
  await engine.stopCall(next.callId);
});

test('uncertain canonical native input reference blocks live voice admission and is never reinjected on duplicate delivery', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/inject_items') return request(method, params);
    worker.calls.push({ method, params });
    return Promise.reject(Error('Canonical acknowledgement lost'));
  });
  await assert.rejects(
    voice.message({ clientMessageId: 'canonical-unknown', text: 'This one', callId: call.callId }),
    (error) => operationError(error).unknownOutcome === true,
  );
  const message = store.state.messages[0];
  assert.equal(defined(defined(message).callContext).status, 'unknown');
  assert.equal(defined(message).submission, 'unknown');
  assert.equal(defined(message).executorConfirmedAt, null);
  assert.equal(
    worker.calls.some((call) => call.method === 'thread/realtime/appendText'),
    false,
  );
  const duplicate = await voice.message({
    clientMessageId: 'canonical-unknown',
    text: 'This one',
    callId: call.callId,
  });
  assert.equal(duplicate.unknownOutcome, true);
  assert.equal(worker.calls.filter((call) => call.method === 'thread/inject_items').length, 1);
  assert.equal(defined(voice.session).unknown, false);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('public native message records a known canonical reference rejection as failed without a voice receipt or automatic retry', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/inject_items') return request(method, params);
    worker.calls.push({ method, params });
    return Promise.reject(Object.assign(Error('Reference rejected'), { code: -32000 }));
  });
  await assert.rejects(
    voice.message({
      clientMessageId: 'canonical-rejected',
      text: 'A new input',
      callId: call.callId,
    }),
    (error) =>
      operationError(error).submission === 'not-submitted' && !operationError(error).unknownOutcome,
  );
  const message = store.state.messages[0];
  assert.equal(defined(defined(message).callContext).status, 'failed');
  assert.equal(defined(message).status, 'failed');
  assert.equal(defined(message).submission, 'preparing');
  assert.equal(defined(message).executorConfirmedAt, null);
  assert.equal(
    worker.calls.some((call) => call.method === 'thread/realtime/appendText'),
    false,
  );
  const duplicate = await voice.message({
    clientMessageId: 'canonical-rejected',
    text: 'A new input',
    callId: call.callId,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.status, 'failed');
  assert.equal(worker.calls.filter((call) => call.method === 'thread/inject_items').length, 1);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('public native message paused by immediate hangup cannot remain queued or dispatch canonical context into a later call', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    sending = voice.message({
      clientMessageId: 'closed-before-canonical',
      text: 'Do not send after hangup',
      callId: call.callId,
    }),
    rejected = assert.rejects(
      sending,
      (error) =>
        operationError(error).submission === 'not-submitted' &&
        !operationError(error).unknownOutcome,
    );
  await engine.stopCall(call.callId);
  await rejected;
  const message = store.state.messages[0];
  assert.equal(defined(message).status, 'paused');
  assert.equal(defined(message).submission, 'preparing');
  assert.equal(defined(message).executorConfirmedAt, null);
  assert.equal(
    worker.calls.some((call) =>
      ['thread/inject_items', 'thread/realtime/appendText', 'turn/start'].includes(call.method),
    ),
    false,
  );
  const next = await engine.startCall(sdp);
  await tick();
  assert.equal(defined(message).status, 'paused');
  assert.equal(
    worker.calls.some((call) =>
      ['thread/inject_items', 'thread/realtime/appendText', 'turn/start'].includes(call.method),
    ),
    false,
  );
  await assert.rejects(
    voice.message({
      clientMessageId: 'closed-before-canonical',
      text: 'Do not send after hangup',
      callId: next.callId,
    }),
    /another call/,
  );
  await engine.stopCall(next.callId);
  assert.equal(worker.terminated, 0);
});

test('native hangup cancels unsent typed inputs without forwarding them into a later call or fabricating a receipt', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  let release: ((value?: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (release = resolve));
  });
  const memory = voice.syncMemory({ memory: 'Hold the reference queue', callId: call.callId });
  await tick();
  const one = voice.message({ clientMessageId: 'unsent-one', text: 'First old input' }),
    two = voice.message({ clientMessageId: 'unsent-two', text: 'Second old input' }),
    rejections = [
      assert.rejects(one, (error) => operationError(error).submission === 'not-submitted'),
      assert.rejects(two, (error) => operationError(error).submission === 'not-submitted'),
    ];
  await tick();
  await engine.stopCall(call.callId);
  await Promise.all(rejections);
  assert.equal((await memory).status, 'cancelled');
  assert.ok(
    store.state.messages
      .filter((message) => message.role === 'user')
      .every(
        (message) =>
          message.status === 'paused' &&
          message.submission === 'preparing' &&
          !message.executorConfirmedAt,
      ),
  );
  assert.equal(worker.terminated, 0);
  worker.request = requestFixture(request);
  const next = await engine.startCall(sdp);
  defined(release)({});
  await tick();
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  await voice.message({
    clientMessageId: 'new-current',
    text: 'Current call input',
    callId: next.callId,
  });
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    2,
  );
  await engine.stopCall(next.callId);
});

test('native hangup during unacknowledged typed input requires confirmed shutdown and late acknowledgement cannot mark it accepted', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  let acknowledge: ((value: unknown) => void) | undefined,
    confirm: ((value: { terminated: boolean }) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  const sending = voice.message({
      clientMessageId: 'inflight-hangup',
      text: 'An input already sent',
    }),
    rejected = assert.rejects(sending, (error) => operationError(error).unknownOutcome === true);
  await tick();
  worker.terminateConfirmed = () => new Promise((resolve) => (confirm = resolve));
  let stopped = false;
  const stopping = engine.stopCall(call.callId).then(() => (stopped = true));
  await tick();
  assert.equal(typeof confirm, 'function');
  assert.equal(stopped, false);
  assert.ok(engine.call);
  assert.equal(defined(store.state.messages[0]).submission, 'unknown');
  defined(confirm)({ terminated: true });
  await stopping;
  await rejected;
  defined(acknowledge)({});
  await tick();
  assert.equal(defined(store.state.messages[0]).submission, 'unknown');
  assert.equal(defined(store.state.messages[0]).executorConfirmedAt, null);
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  assert.equal(engine.call, null);
});

test('a known native voice input rejection preserves failure and permits a different fresh input', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  let fail = true;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText' || !fail) return request(method, params);
    fail = false;
    worker.calls.push({ method, params });
    return Promise.reject(Object.assign(Error('Input rejected'), { code: -32000 }));
  });
  await assert.rejects(
    voice.message({ clientMessageId: 'voice-rejected', text: 'Rejected input' }),
    (error) => operationError(error).submission === 'rejected',
  );
  assert.equal(defined(store.state.messages[0]).status, 'failed');
  assert.equal(defined(store.state.messages[0]).executorConfirmedAt, null);
  assert.equal(defined(voice.session).unknown, false);
  const duplicate = await voice.message({
    clientMessageId: 'voice-rejected',
    text: 'Rejected input',
  });
  assert.equal(duplicate.duplicate, true);
  const next = await voice.message({ clientMessageId: 'voice-fresh', text: 'A new request' });
  assert.equal(next.message.status, 'accepted');
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    2,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('an uncertain older reference prevents unsent native input from claiming execution or being retried', async (t) => {
  const { engine, voice, worker, store } = setup(t, { voice: { contextTimeoutMs: 10 } }),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise(() => {});
  });
  assert.equal(
    (await voice.syncMemory({ memory: 'Uncertain old reference', callId: call.callId })).status,
    'unknown',
  );
  await assert.rejects(
    voice.message({
      clientMessageId: 'after-uncertain-reference',
      text: 'This input was never sent',
    }),
    (error) => operationError(error).submission === 'not-submitted',
  );
  const message = store.state.messages[0];
  assert.equal(defined(message).submission, 'preparing');
  assert.equal(defined(message).status, 'paused');
  assert.equal(defined(message).executorConfirmedAt, null);
  assert.equal(defined(voice.session).unknown, false);
  await voice.message({
    clientMessageId: 'after-uncertain-reference',
    text: 'This input was never sent',
  });
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('native credential requests cancel before waiting for the voice event chain on pause', async (t) => {
  const { dir, engine, voice, worker } = setup(t);
  const credentials = new CredentialRequests({ vault: new CredentialVault({ dataDir: dir }) });
  engine.credentials = credentials;
  const call = await engine.startCall(sdp);
  engine.confirmCallConnected(call.callId);
  await begin(engine, 'credential-turn');
  const pending = tool(
    engine,
    'credential-turn',
    'credential_request',
    { name: 'VM login', service: 'example.test', reason: 'Continue authorized work' },
    101,
  );
  await tick();
  const request = credentials.snapshot().requests[0];
  assert.ok(request);
  const result = observedRecord(await engine.pause());
  await pending;
  assert.equal(result.callContinues, true);
  assert.equal(defined(engine.call).id, call.callId);
  assert.deepEqual(credentials.snapshot().requests, []);
  assert.throws(() => credentials.fulfill(request.id, { secret: 'late-secret' }), /no longer/);
  assert.equal(
    defined(defined(worker.responses.find((response) => response.id === 101)).result).success,
    false,
  );
  const oldTurn = defined(voice.session).turns.get('credential-turn');
  await assert.rejects(
    voice.tool(defined(voice.session), defined(oldTurn), 'credential_get', { id: 'anything' }),
    /no longer/,
  );
  await engine.stopCall(call.callId);
});

test('the LLM native reaction tool sets its own reaction without altering human feedback', async (t) => {
  const { engine, store } = setup(t),
    call = await engine.startCall(sdp),
    message = store.add({ role: 'user', text: 'A milestone worth celebrating', reactions: ['❤️'] });
  await begin(engine, 'reaction-turn');
  await tool(engine, 'reaction-turn', 'react_message', { messageId: message.id, emoji: '🎉' }, 102);
  assert.equal(message.assistantReaction, '🎉');
  assert.deepEqual(message.reactions, ['❤️']);
  assert.equal(store.state.messages.length, 1);
  await engine.stopCall(call.callId);
});

test('typed input during native work serializes through the same voice session without separately steering or echoing backend final text', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'known-turn');
  const request = worker.request.bind(worker);
  let firstAck: ((value: unknown) => void) | undefined,
    inputs = 0;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    if (++inputs === 1) return new Promise((resolve) => (firstAck = resolve));
    return Promise.resolve({});
  });
  const first = voice.message({ clientMessageId: 'steer-one', text: 'First correction' }),
    second = voice.message({ clientMessageId: 'steer-two', text: 'Second correction' });
  await tick();
  assert.equal(inputs, 1);
  defined(firstAck)({});
  await Promise.all([first, second]);
  assert.equal(inputs, 2);
  assert.ok(
    worker.calls
      .filter((call) => call.method === 'thread/realtime/appendText')
      .every((call) => call.params.threadId === 'thread'),
  );
  assert.equal(
    worker.calls.some((call) => ['turn/start', 'turn/steer'].includes(call.method)),
    false,
  );
  await engine.handle(
    event('item/completed', {
      turnId: 'known-turn',
      item: { id: 'answer', type: 'agentMessage', text: 'Both corrections applied' },
    }),
  );
  await engine.handle(event('turn/completed', { turn: { id: 'known-turn', status: 'completed' } }));
  assert.deepEqual(
    store.state.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.status),
    ['accepted', 'accepted'],
  );
  assert.equal(
    store.state.messages.some((message) => message.role === 'assistant'),
    false,
  );
  await engine.stopCall(call.callId);
});

test('backend completion before typed voice admission cannot create a second chat assistant response', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'known-turn');
  const request = worker.request.bind(worker);
  let acknowledge: ((value: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  const sending = voice.message({ clientMessageId: 'late-steer-ack', text: 'Use this correction' });
  await tick();
  await engine.handle(
    event('item/completed', {
      turnId: 'known-turn',
      item: { id: 'answer', type: 'agentMessage', text: 'Accepted correction result' },
    }),
  );
  await engine.handle(event('turn/completed', { turn: { id: 'known-turn', status: 'completed' } }));
  assert.equal(store.state.messages.length, 1);
  defined(acknowledge)({});
  const result = await sending;
  assert.equal(result.message.status, 'accepted');
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.completions.length, 0);
  await engine.stopCall(call.callId);
});

test('unknown typed voice submission is paused and duplicate client delivery never replays it', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return Promise.reject(Error('Connection lost after send'));
  });
  await assert.rejects(
    voice.message({ clientMessageId: 'unknown-text', text: 'Maybe submitted' }),
    (error) =>
      operationError(error).unknownOutcome === true &&
      /may have been delivered/.test(operationError(error).message),
  );
  assert.equal(defined(store.state.messages[0]).status, 'paused');
  assert.equal(defined(store.state.messages[0]).submission, 'unknown');
  const duplicate = await voice.message({
    clientMessageId: 'unknown-text',
    text: 'Maybe submitted',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.unknownOutcome, true);
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 1);
});

test('a stale Codex realtime event cannot close a later independently billed API call', async (t) => {
  const { engine } = setup(t);
  engine.voice = { start: async () => ({ sdp }), stop: async () => {} };
  const call = await engine.startCall(sdp, { provider: 'api' });
  await engine.handle(event('thread/realtime/closed'));
  await engine.handle(event('thread/realtime/error', { message: 'old native call error' }));
  assert.equal(defined(engine.call).id, call.callId);
  await engine.stopCall(call.callId);
});

test('automatic voice final delivers useful links without narration, repeated tool links or credential URLs', async (t) => {
  const { engine, store } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'background');
  await tool(
    engine,
    'background',
    'send_message',
    { text: 'Requested link https://example.test/one' },
    1,
  );
  await engine.handle(
    event('item/completed', {
      turnId: 'background',
      item: {
        id: 'final',
        type: 'agentMessage',
        text: 'Spoken narration remains private. [One](https://example.test/one) [Two](https://example.test/two). https://example.test/private?token=sensitive https://name:password@example.test/private',
      },
    }),
  );
  await engine.handle(event('turn/completed', { turn: { id: 'background', status: 'completed' } }));
  assert.deepEqual(
    store.state.messages.map((message) => message.text),
    ['Requested link https://example.test/one', 'https://example.test/two'],
  );
  await engine.stopCall(call.callId);
});

test('pause routes to actual delegated native work while admitted voice input stays accepted and never auto-replays', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp);
  engine.confirmCallConnected(call.callId);
  const first = await voice.message({ clientMessageId: 'pause-first', text: 'Work on this' });
  await begin(engine, 'voice-task');
  assert.deepEqual(voice.active, {
    messageId: null,
    turnId: 'voice-task',
    source: 'voice',
    status: 'running',
  });
  const result = observedRecord(await engine.pause());
  assert.deepEqual(result, {
    paused: true,
    callId: call.callId,
    callContinues: true,
    turnIds: ['voice-task'],
  });
  assert.equal(first.message.status, 'accepted');
  assert.equal(voice.active, null);
  assert.equal(defined(engine.call).status, 'connected');
  assert.equal(worker.terminated, 0);
  assert.equal(
    worker.calls.some((call) => call.method === 'thread/realtime/stop'),
    false,
  );
  const duplicate = await voice.message({ clientMessageId: 'pause-first', text: 'Work on this' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  const next = await voice.message({ clientMessageId: 'pause-fresh', text: 'A new task' });
  assert.equal(next.message.status, 'accepted');
  assert.equal(next.turnId, undefined);
  assert.equal(store.state.messages.filter((message) => message.role === 'user').length, 2);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  await engine.pause();
  await engine.stopCall(call.callId);
});

test('native pause waits for matching completion even when interrupt acknowledgement remains pending', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'owned-task');
  const request = worker.request.bind(worker);
  let interrupted;
  worker.request = requestFixture((method, params) => {
    if (method !== 'turn/interrupt') return request(method, params);
    interrupted = params;
    return new Promise(() => {});
  });
  let finished = false;
  const pausing = engine.pause().then((result) => {
    finished = true;
    return result;
  });
  await tick();
  assert.deepEqual(interrupted, { threadId: 'thread', turnId: 'owned-task' });
  assert.equal(finished, false);
  assert.equal(defined(voice.active).status, 'pausing');
  await engine.handle(
    event('turn/completed', {
      threadId: 'different-thread',
      turn: { id: 'owned-task', status: 'interrupted' },
    }),
  );
  await tick();
  assert.equal(finished, false);
  await engine.handle(
    event('turn/completed', { turn: { id: 'owned-task', status: 'interrupted' } }),
  );
  const result = observedRecord(await pausing);
  assert.equal(result.paused, true);
  assert.ok(engine.call);
  assert.equal(voice.active, null);
  await engine.stopCall(call.callId);
});

test('unobservable voice handoff cannot report paused and keeps the call until explicit hangup', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await engine.handle(event('thread/realtime/itemAdded', { item: { type: 'handoff_request' } }));
  assert.equal(defined(voice.active).status, 'unknown');
  await assert.rejects(
    engine.pause(),
    (error) =>
      operationError(error).unknownOutcome === true &&
      /End the call/.test(operationError(error).message),
  );
  assert.equal(defined(engine.call).id, call.callId);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/interrupt'),
    false,
  );
  assert.equal(worker.terminated, 0);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 1);
});

test('an unconfirmed native interruption reports unknown without pretending the task paused', async (t) => {
  const { engine, voice, worker } = setup(t, { voice: { stopTimeoutMs: 10 } }),
    call = await engine.startCall(sdp);
  await begin(engine, 'still-running');
  const request = worker.request.bind(worker);
  worker.request = requestFixture((method, params) =>
    method === 'turn/interrupt' ? Promise.resolve({}) : request(method, params),
  );
  await assert.rejects(engine.pause(), (error) => operationError(error).unknownOutcome === true);
  assert.ok(engine.call);
  assert.equal(defined(voice.active).status, 'unknown');
  assert.equal(worker.terminated, 0);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 1);
});

test('pause invalidates queued native voice input before dispatch without replaying it after the reference queue drains', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker);
  let release: ((value?: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (release = resolve));
  });
  const reference = voice.syncMemory({ memory: 'Pending reference', callId: call.callId });
  await tick();
  const sending = voice.message({
      clientMessageId: 'queued-before-pause',
      text: 'Do not submit after pause',
    }),
    rejected = assert.rejects(sending, /paused before submission/);
  await tick();
  const result = observedRecord(await engine.pause());
  assert.equal(result.paused, true);
  defined(release)({});
  await reference;
  await rejected;
  assert.equal(defined(store.state.messages[0]).status, 'paused');
  assert.equal(defined(store.state.messages[0]).executorConfirmedAt, null);
  assert.equal(
    worker.calls.filter((call) => call.method === 'thread/realtime/appendText').length,
    1,
  );
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.ok(engine.call);
  await engine.stopCall(call.callId);
});

test('a large screenshot completion does not overflow the voice observer or terminate its executor', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'screenshot-turn');
  const image = Buffer.alloc(900000, 37).toString('base64'),
    notification = event('item/completed', {
      turnId: 'screenshot-turn',
      item: {
        id: 'large-screen',
        type: 'mcpToolCall',
        server: 'dant_desktop',
        tool: 'screenshot',
        status: 'completed',
        arguments: {},
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: image }],
          isError: false,
        },
      },
    });
  assert.ok(Buffer.byteLength(JSON.stringify(notification)) > 1024 * 1024);
  const original = JSON.stringify(notification);
  await engine.handle(notification);
  await tick();
  assert.equal(worker.terminated, 0);
  assert.equal(worker.status, 'online');
  assert.equal(defined(voice.session).unknown, false);
  assert.equal(defined(engine.call).id, call.callId);
  assert.equal(JSON.stringify(notification), original);
  await engine.stopCall(call.callId);
});

test('a full one-MiB command result remains available to Codex while native observation stays connected', async (t) => {
  const { engine, voice, worker } = setup(t),
    diagnostics: Array<Record<string, unknown>> = [];
  voice.on('diagnostic', (entry) => diagnostics.push(entry));
  const call = await engine.startCall(sdp);
  await begin(engine, 'command-output-turn');
  const notification = event('item/completed', {
      turnId: 'command-output-turn',
      item: {
        id: 'large-command',
        type: 'commandExecution',
        command: 'existing-tool',
        cwd: '/workspace',
        processId: '123',
        source: 'agent',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'x'.repeat(1024 * 1024),
        exitCode: 0,
        durationMs: 12,
      },
    }),
    before = JSON.stringify(notification);
  assert.ok(Buffer.byteLength(before) > 1024 * 1024);
  await engine.handle(notification);
  await tick();
  assert.equal(worker.terminated, 0);
  assert.equal(worker.status, 'online');
  assert.equal(defined(voice.session).unknown, false);
  assert.equal(defined(engine.call).id, call.callId);
  assert.equal(JSON.stringify(notification), before);
  assert.equal(defined(defined(notification.params.item).aggregatedOutput).length, 1024 * 1024);
  assert.equal(diagnostics.length, 1);
  assert.equal(defined(diagnostics[0]).code, 'voice_observer_payload_omitted');
  assert.equal(defined(diagnostics[0]).itemType, 'commandExecution');
  assert.equal(defined(diagnostics[0]).itemStatus, 'completed');
  assert.equal(defined(diagnostics[0]).itemId, 'large-command');
  assert.ok(fixtureNumber(defined(diagnostics[0]).bytes) < 1024);
  assert.equal(JSON.stringify(diagnostics).includes('aggregatedOutput'), false);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('a screenshot encoded inside a one-MiB JSON text result cannot stop an otherwise empty native queue', async (t) => {
  const { engine, voice, worker } = setup(t),
    diagnostics: Array<Record<string, unknown>> = [];
  voice.on('diagnostic', (entry) => diagnostics.push(entry));
  const call = await engine.startCall(sdp);
  await begin(engine, 'json-screenshot-turn');
  assert.equal(defined(voice.session).queuedBytes, 0);
  assert.equal(defined(voice.session).queuedEvents, 0);
  const image = { content: [{ type: 'image', data: 'x'.repeat(1048460), mimeType: 'image/png' }] },
    text = JSON.stringify(image),
    notification = event('item/completed', {
      turnId: 'json-screenshot-turn',
      item: {
        id: 'json-image-tool',
        type: 'mcpToolCall',
        server: 'dant_desktop',
        tool: 'screenshot',
        status: 'completed',
        arguments: {},
        result: { content: [{ type: 'text', text }], isError: false },
      },
    }),
    before = JSON.stringify(notification);
  assert.equal(text.length, 1048523);
  assert.ok(Buffer.byteLength(before) > 1024 * 1024);
  await engine.handle(notification);
  await tick();
  assert.equal(worker.terminated, 0);
  assert.equal(worker.status, 'online');
  assert.equal(defined(voice.session).unknown, false);
  assert.equal(defined(engine.call).id, call.callId);
  assert.equal(defined(voice.session).queuedBytes, 0);
  assert.equal(defined(voice.session).queuedEvents, 0);
  assert.equal(
    defined(defined(defined(defined(notification.params.item).result).content)[0]).text,
    text,
  );
  assert.equal(JSON.stringify(notification), before);
  assert.equal(diagnostics.length, 1);
  assert.equal(defined(diagnostics[0]).code, 'voice_observer_payload_omitted');
  assert.equal(defined(diagnostics[0]).itemType, 'mcpToolCall');
  assert.equal(defined(diagnostics[0]).itemStatus, 'completed');
  assert.equal(defined(diagnostics[0]).itemId, 'json-image-tool');
  assert.ok(fixtureNumber(defined(diagnostics[0]).bytes) < 1024);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('large command results during typed voice admission retain only observer metadata and never replay the task', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker),
    diagnostics: Array<Record<string, unknown>> = [];
  voice.on('diagnostic', (entry) => diagnostics.push(entry));
  let acknowledge: ((value: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  const sending = voice.message({
    clientMessageId: 'large-early-command',
    text: 'Run the requested tool',
  });
  await tick();
  await begin(engine, 'native-command');
  const output = 'x'.repeat(1024 * 1024),
    notification = event('item/completed', {
      turnId: 'native-command',
      item: {
        id: 'early-command',
        type: 'commandExecution',
        status: 'completed',
        aggregatedOutput: output,
        exitCode: 0,
      },
    });
  await engine.handle(notification);
  assert.equal(defined(voice.session).queuedBytes, 0);
  assert.equal(defined(voice.session).unknown, false);
  assert.equal(defined(notification.params.item).aggregatedOutput, output);
  assert.equal(defined(diagnostics[0]).code, 'voice_observer_payload_omitted');
  assert.ok(fixtureNumber(defined(diagnostics[0]).bytes) < 1024);
  defined(acknowledge)({});
  await sending;
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.equal(worker.terminated, 0);
  assert.equal(defined(engine.call).id, call.callId);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('unknown oversized item completions still stop the executor with safe item metadata only', async (t) => {
  const { engine, voice, worker } = setup(t),
    diagnostics: Array<Record<string, unknown>> = [];
  voice.on('diagnostic', (entry) => diagnostics.push(entry));
  await engine.startCall(sdp);
  await begin(engine, 'unknown-output-turn');
  const notification = event('item/completed', {
    turnId: 'unknown-output-turn',
    item: {
      id: 'unknown-output',
      type: 'futureUnknownType',
      status: 'completed',
      payload: 'private-unrecognized-' + 'x'.repeat(1024 * 1024),
    },
  });
  await engine.handle(notification);
  await tick();
  assert.equal(worker.terminated, 1);
  assert.equal(defined(voice.state.lastStop).reason, 'notification-buffer');
  assert.equal(defined(voice.state.lastStop).itemType, 'other');
  assert.equal(defined(voice.state.lastStop).itemStatus, 'completed');
  assert.equal(defined(voice.state.lastStop).itemId, 'unknown-output');
  assert.equal(JSON.stringify(diagnostics).includes('private-unrecognized'), false);
  assert.equal(
    diagnostics.some((item) => item.code === 'voice_observer_payload_omitted'),
    false,
  );
});

test('observer projection never grants turn ownership or turns malformed screenshots into accepted notifications', async (t) => {
  for (const turnId of [undefined, 'foreign-turn']) {
    const { engine, voice, worker } = setup(t),
      call = await engine.startCall(sdp);
    await begin(engine, 'owned-turn');
    const notification = event('item/completed', {
      turnId,
      item: {
        id: 'unowned-command',
        type: 'commandExecution',
        status: 'completed',
        aggregatedOutput: 'x'.repeat(1024 * 1024),
      },
    });
    await engine.handle(notification);
    assert.equal(defined(voice.session).unknown, true);
    assert.equal(defined(defined(voice.session).stopCause).reason, 'untracked-turn');
    await engine.stopCall(call.callId);
    assert.equal(worker.terminated, 1);
  }
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'owned-turn');
  await engine.handle(
    event('item/completed', {
      threadId: 'another-thread',
      turnId: 'owned-turn',
      item: {
        id: 'foreign-thread-command',
        type: 'commandExecution',
        aggregatedOutput: 'x'.repeat(1024 * 1024),
      },
    }),
  );
  assert.equal(defined(voice.session).unknown, false);
  assert.equal(worker.terminated, 0);
  await engine.stopCall(call.callId);
  const malformed = setup(t);
  await malformed.engine.startCall(sdp);
  await begin(malformed.engine, 'valid-turn');
  await malformed.engine.handle(
    event('item/completed', {
      turnId: 'valid-turn',
      item: {
        type: 'mcpToolCall',
        server: 'dant_desktop',
        tool: 'screenshot',
        status: 'completed',
        result: { content: [{ type: 'image', data: 'x'.repeat(1024 * 1024) }] },
      },
    }),
  );
  await tick();
  assert.equal(malformed.worker.terminated, 1);
  assert.equal(defined(malformed.voice.state.lastStop).reason, 'notification-buffer');
});

test('large delivery marker mismatches remain invalid and zero or null RPC IDs cannot bypass control limits', async (t) => {
  const { engine, store, worker } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'delivery-validation');
  const text = 'x'.repeat(90000),
    notification = event('item/completed', {
      turnId: 'delivery-validation',
      item: {
        id: 'mismatch',
        type: 'mcpToolCall',
        server: 'dant_desktop',
        tool: 'send_chat_message',
        status: 'completed',
        arguments: { text },
        result: {
          structuredContent: { dantMessage: { text: 'different-' + text } },
          content: [{ type: 'text', text: 'x'.repeat(100000) }],
        },
      },
    });
  await engine.handle(notification);
  assert.equal(store.state.messages.length, 0);
  assert.equal(worker.terminated, 0);
  await engine.stopCall(call.callId);
  for (const requestId of [0, null]) {
    const state = setup(t);
    await state.engine.startCall(sdp);
    await begin(state.engine, 'control-turn');
    await state.engine.handle(
      event(
        'item/tool/call',
        {
          turnId: 'control-turn',
          tool: 'send_message',
          arguments: { text: 'x'.repeat(1024 * 1024) },
        },
        requestId,
      ),
    );
    await tick();
    assert.equal(state.worker.terminated, 1);
    assert.equal(defined(state.voice.state.lastStop).reason, 'notification-buffer');
    assert.equal(state.store.state.messages.length, 0);
    assert.equal(
      state.worker.responses.some((reply) => reply.result?.success),
      false,
    );
  }
});

test('consecutive large screenshots queue only metadata while preserving validated MCP delivery', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    call = await engine.startCall(sdp);
  await begin(engine, 'screenshot-turn');
  let release: ((value?: unknown) => void) | undefined;
  defined(voice.session).eventChain = new Promise((resolve) => (release = resolve));
  const image = Buffer.alloc(900000, 41).toString('base64'),
    notifications = [];
  for (let index = 0; index < 8; index++)
    notifications.push(
      event('item/completed', {
        turnId: 'screenshot-turn',
        item: {
          id: 'screen-' + index,
          type: 'mcpToolCall',
          server: 'dant_desktop',
          tool: 'screenshot',
          status: 'completed',
          result: {
            content: [{ type: 'image', mimeType: 'image/png', data: image }],
            isError: false,
          },
        },
      }),
    );
  const payload = { dantMessage: { text: 'Explicit requested result' } },
    delivery = event('item/completed', {
      turnId: 'screenshot-turn',
      item: {
        id: 'delivery',
        type: 'mcpToolCall',
        server: 'dant_desktop',
        tool: 'send_chat_message',
        status: 'completed',
        arguments: { text: payload.dantMessage.text },
        result: {
          content: [
            { type: 'text', text: JSON.stringify(payload) },
            { type: 'image', mimeType: 'image/png', data: image },
          ],
          structuredContent: payload,
          isError: false,
        },
      },
    });
  notifications.push(delivery);
  const pending = notifications.map((notification) => engine.handle(notification));
  assert.equal(defined(voice.session).queuedEvents, 9);
  assert.ok(defined(voice.session).queuedBytes < 10000);
  assert.equal(defined(voice.session).unknown, false);
  defined(release)();
  await Promise.all(pending);
  assert.equal(worker.terminated, 0);
  assert.equal(defined(voice.session).queuedBytes, 0);
  assert.equal(defined(voice.session).queuedEvents, 0);
  assert.equal(defined(store.state.messages[0]).text, 'Explicit requested result');
  assert.ok(
    notifications.every((notification) =>
      defined(defined(defined(notification.params.item).result).content).some(
        (content) => content.type === 'image' && content.data === image,
      ),
    ),
  );
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 0);
});

test('three observed screenshots emit exactly three safe size diagnostics before queueing', async (t) => {
  const { engine, voice, worker } = setup(t),
    diagnostics: Array<Record<string, unknown>> = [];
  voice.on('diagnostic', (entry) => diagnostics.push(entry));
  const call = await engine.startCall(sdp);
  await begin(engine, 'screenshot-diagnostics');
  const image = Buffer.alloc(900000, 47).toString('base64');
  for (let index = 0; index < 3; index++)
    await engine.handle(
      event('item/completed', {
        turnId: 'screenshot-diagnostics',
        item: {
          id: 'diagnostic-image-' + index,
          type: 'mcpToolCall',
          server: 'dant_desktop',
          tool: 'screenshot',
          status: 'completed',
          result: { content: [{ type: 'image', mimeType: 'image/png', data: image }] },
        },
      }),
    );
  assert.equal(diagnostics.length, 3);
  assert.ok(
    diagnostics.every(
      (entry) =>
        entry.code === 'voice_observer_image_omitted' &&
        entry.callId === call.callId &&
        entry.method === 'item/completed' &&
        fixtureNumber(entry.eventBytes) > 1024 * 1024 &&
        fixtureNumber(entry.bytes) < 1000 &&
        entry.count === 1,
    ),
  );
  assert.equal(JSON.stringify(diagnostics).includes(image.slice(0, 100)), false);
  assert.equal(
    diagnostics.reduce((count, entry) => count + fixtureNumber(entry.count), 0),
    3,
  );
  assert.equal(worker.terminated, 0);
  await engine.stopCall(call.callId);
});

test('large screenshot results during typed voice admission stay bounded without mutating the model result', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp),
    request = worker.request.bind(worker),
    diagnostics: Array<Record<string, unknown>> = [];
  voice.on('diagnostic', (entry) => diagnostics.push(entry));
  let acknowledge: ((value: unknown) => void) | undefined;
  worker.request = requestFixture((method, params) => {
    if (method !== 'thread/realtime/appendText') return request(method, params);
    worker.calls.push({ method, params });
    return new Promise((resolve) => (acknowledge = resolve));
  });
  const sending = voice.message({
    clientMessageId: 'large-early-screenshot',
    text: 'Observe the game',
  });
  await tick();
  await begin(engine, 'native-screen');
  const image = Buffer.alloc(900000, 43).toString('base64'),
    notification = event('item/completed', {
      turnId: 'native-screen',
      item: {
        id: 'early-screen',
        type: 'mcpToolCall',
        server: 'dant_desktop',
        tool: 'screenshot',
        status: 'completed',
        result: { content: [{ type: 'image', mimeType: 'image/png', data: image }] },
      },
    });
  await engine.handle(notification);
  assert.equal(defined(voice.session).queuedBytes, 0);
  assert.equal(
    defined(defined(defined(defined(notification.params.item).result).content)[0]).data,
    image,
  );
  assert.equal(defined(voice.session).unknown, false);
  assert.equal(defined(diagnostics[0]).code, 'voice_observer_image_omitted');
  assert.ok(fixtureNumber(defined(diagnostics[0]).bytes) < 1000);
  defined(acknowledge)({});
  const result = await sending;
  assert.equal(result.submission, 'confirmed');
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.equal(worker.terminated, 0);
  assert.equal(defined(engine.call).id, call.callId);
  await engine.stopCall(call.callId);
});

test('real critical notification overflow still waits for confirmed termination and never replays work', async (t) => {
  const { engine, voice, worker, store } = setup(t),
    diagnostics: Array<Record<string, unknown>> = [];
  voice.on('diagnostic', (entry) => diagnostics.push(entry));
  await engine.startCall(sdp);
  await voice.message({ clientMessageId: 'critical-overflow', text: 'An owned task' });
  await begin(engine, 'critical-owned');
  let confirm: ((value: { terminated: boolean }) => void) | undefined,
    terminations = 0;
  worker.terminateConfirmed = () => {
    terminations++;
    return new Promise((resolve) => (confirm = resolve));
  };
  const privateText = 'never-publish-this-payload-' + 'x'.repeat(1024 * 1024),
    notification = event(
      'item/tool/call',
      { turnId: 'critical-owned', tool: 'send_message', arguments: { text: privateText } },
      900,
    );
  await engine.handle(notification);
  await tick();
  assert.equal(terminations, 1);
  assert.ok(engine.call);
  assert.equal(defined(voice.state.lastStop).reason, 'notification-buffer');
  assert.equal(defined(voice.state.lastStop).confirmed, false);
  assert.equal(defined(voice.state.lastStop).executorStopped, false);
  assert.equal(defined(voice.state.lastStop).method, 'item/tool/call');
  assert.ok(defined(defined(voice.state.lastStop).eventBytes) > 1024 * 1024);
  assert.equal(JSON.stringify(voice.state).includes('never-publish'), false);
  assert.equal(store.state.messages.length, 1);
  const stopping = defined(voice.session).stopPromise;
  defined(confirm)({ terminated: true });
  await stopping;
  assert.equal(engine.call, null);
  assert.equal(defined(voice.state.lastStop).confirmed, true);
  assert.equal(defined(voice.state.lastStop).executorStopped, true);
  assert.equal(defined(voice.state.lastStop).reason, 'notification-buffer');
  assert.match(defined(voice.state.error), /VM was not shut down/);
  assert.equal(defined(store.state.messages[0]).status, 'accepted');
  assert.equal(engine.queue.length, 0);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 0);
  assert.equal(
    worker.responses.some((response) => response.result?.success),
    false,
  );
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['voice_executor_stop_required', 'voice_shutdown'],
  );
  assert.equal(defined(diagnostics[0]).confirmed, false);
  assert.equal(defined(diagnostics[1]).confirmed, true);
  assert.equal(JSON.stringify(diagnostics).includes('never-publish'), false);
});

test('early control-event overflow retains its own reason and still requires confirmed executor stop', async (t) => {
  const { engine, voice, worker } = setup(t),
    call = await engine.startCall(sdp),
    session = voice.session;
  defined(session).submitting = { message: { id: 'pending' }, early: [], bytes: 0 };
  for (let index = 0; index < 129; index++)
    await engine.handle(
      event('item/started', {
        turnId: 'pending-turn',
        item: {
          id: 'control-' + index,
          type: 'mcpToolCall',
          server: 'dant_desktop',
          tool: 'click',
          arguments: { x: index, y: index },
        },
      }),
    );
  assert.equal(defined(session).unknown, true);
  assert.equal(defined(defined(session).submitting).early.length, 128);
  assert.equal(defined(defined(session).stopCause).reason, 'early-text-buffer');
  assert.equal(worker.terminated, 0);
  await engine.stopCall(call.callId);
  assert.equal(worker.terminated, 1);
  assert.equal(defined(voice.state.lastStop).reason, 'early-text-buffer');
  assert.equal(defined(voice.state.lastStop).queuedEvents, 128);
  assert.equal(defined(voice.state.lastStop).confirmed, true);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('unconfirmed shutdown diagnostics retain a fixed reason without transport payloads or secrets', async (t) => {
  const { engine, voice, worker } = setup(t),
    diagnostics: Array<Record<string, unknown>> = [];
  voice.on('diagnostic', (entry) => diagnostics.push(entry));
  const call = await engine.startCall(sdp);
  await engine.handle(
    event('thread/realtime/itemAdded', {
      item: { type: 'handoff_request', text: 'private-handoff-payload' },
    }),
  );
  worker.terminateConfirmed = async () => {
    throw Error('private-termination-secret');
  };
  await assert.rejects(engine.stopCall(call.callId), /private-termination-secret/);
  assert.ok(engine.call);
  assert.equal(defined(voice.state.lastStop).reason, 'untracked-handoff');
  assert.equal(defined(voice.state.lastStop).confirmed, false);
  assert.equal(defined(voice.state.lastStop).executorStopped, false);
  assert.match(defined(voice.state.error), /has not been confirmed/);
  assert.equal(JSON.stringify({ state: voice.state, diagnostics }).includes('private-'), false);
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['voice_executor_stop_required', 'voice_shutdown_unconfirmed'],
  );
  worker.terminateConfirmed = async () => ({ terminated: true });
  await engine.stopCall(call.callId);
  assert.equal(defined(voice.state.lastStop).confirmed, true);
});
