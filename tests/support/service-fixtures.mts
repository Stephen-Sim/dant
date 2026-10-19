import { isRecord } from '../../src/contracts/json.mts';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import type { ControllerBridge, ControllerProvisioning } from '../../src/app/controller-types.ts';
import type { WorkerService } from '../../src/app/worker-app-types.ts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import type { WorkerPublic, WorkerRpcPublic } from '../../src/runtime/worker-types.ts';
import type {
  VmConnectOptions,
  VmRequestOptions,
  BridgeServiceUpdate,
} from '../../src/computer/vm-bridge.mts';
import type { VmObservation } from '../../src/computer/vm-observation-types.ts';
import type { ConnectionStatusValue } from '../../src/contracts/contracts.ts';

export function unexpectedFixtureOperation(): never {
  throw Error('Unexpected fixture operation. Configure this operation explicitly in the test.');
}
export function listeningPort(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'The isolated fixture must be listening.');
  return address.port;
}
export function deferred<Value = void>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export class ControllerBridgeFixture extends EventEmitter implements ControllerBridge {
  declare status: ConnectionStatusValue;
  declare error: string | null;
  declare cached: VmObservation | undefined;
  declare generation: number;
  declare preparing: Promise<unknown> | null;
  declare refreshing: Promise<VmObservation> | null;
  declare reconnectManaged: boolean;
  declare serviceUpdate: BridgeServiceUpdate | null;
  async connect(_options?: VmConnectOptions): Promise<unknown> {
    return unexpectedFixtureOperation();
  }
  async prepare(): Promise<unknown> {
    return unexpectedFixtureOperation();
  }
  async refresh(_force?: boolean): Promise<VmObservation | undefined> {
    return unexpectedFixtureOperation();
  }
  async pauseWorkForUpdate(_options?: { reason?: 'install' | 'exit' }): Promise<unknown> {
    return unexpectedFixtureOperation();
  }
  async request(_route: string, _options?: VmRequestOptions): Promise<Response> {
    return unexpectedFixtureOperation();
  }
  close(): void {
    unexpectedFixtureOperation();
  }
  disconnect(): void {
    unexpectedFixtureOperation();
  }
}

export class ProvisioningFixture extends EventEmitter implements ControllerProvisioning {
  snapshot(): ReturnType<ControllerProvisioning['snapshot']> {
    return unexpectedFixtureOperation();
  }
  providers(): unknown {
    return unexpectedFixtureOperation();
  }
  resumeMonitoring(): ReturnType<ControllerProvisioning['snapshot']> {
    return unexpectedFixtureOperation();
  }
  start(_input: Parameters<ControllerProvisioning['start']>[0]): unknown {
    return unexpectedFixtureOperation();
  }
  close(): void {
    unexpectedFixtureOperation();
  }
}

export class WorkerServiceFixture extends EventEmitter implements WorkerService {
  declare status: ConnectionStatusValue;
  declare error: string | null;
  declare models: RpcResult | null;
  declare rpc: WorkerRpcPublic | null;
  declare runtimeId: string;
  declare workspaceRoot: string;
  declare desktopPath: string;
  declare credentialBridgeToken: string;
  declare skills?: Exclude<WorkerPublic['skills'], undefined>;
  async connect(): Promise<unknown> {
    return unexpectedFixtureOperation();
  }
  async request(_method: string, _params?: RpcParams): Promise<RpcResult> {
    return unexpectedFixtureOperation();
  }
  async guest(_route: string, _body?: unknown): Promise<Response> {
    return unexpectedFixtureOperation();
  }
  disconnect(): void {
    unexpectedFixtureOperation();
  }
}

export function observedRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), 'Expected a fixture object.');
  return value;
}
export function observedRecords(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), 'Expected a fixture array.');
  return value.map(observedRecord);
}

export function engineCallFixture(
  overrides: Partial<import('../../src/work/engine-types.ts').EngineCall> = {},
): import('../../src/work/engine-types.ts').EngineCall {
  return {
    id: 'fixture-call',
    provider: 'api',
    connectedAt: null,
    status: 'connected',
    ...overrides,
  };
}
export function activeTaskFixture(
  overrides: Partial<import('../../src/work/engine-types.ts').EngineActiveTask> = {},
): import('../../src/work/engine-types.ts').EngineActiveTask {
  return {
    messageId: null,
    turnId: null,
    threadId: null,
    messageIds: [],
    outputs: new Map(),
    assistantIds: [],
    explicitPaths: [],
    starting: Promise.resolve(),
    resolveStarted() {},
    stopped: Promise.resolve(),
    resolveStopped() {},
    startSubmitted: false,
    startAcknowledged: false,
    early: [],
    earlyBytes: 0,
    steerChain: Promise.resolve(),
    ...overrides,
  };
}
export function nativeTurnFixture(
  overrides: Partial<import('../../src/voice/realtime-types.ts').NativeTurn> = {},
): import('../../src/voice/realtime-types.ts').NativeTurn {
  return {
    turnId: 'fixture-turn',
    explicitMessageIds: [],
    pendingSubmissions: 0,
    stopped: Promise.resolve(),
    resolveStopped() {},
    done: false,
    outputs: new Map(),
    assistantIds: [],
    explicitPaths: [],
    ...overrides,
  };
}
export function nativeSessionFixture(
  overrides: Partial<import('../../src/voice/realtime-types.ts').NativeSession> = {},
): import('../../src/voice/realtime-types.ts').NativeSession {
  return {
    id: 'fixture-call',
    mediaId: overrides.id ?? 'fixture-call',
    mediaGeneration: 0,
    voice: 'marin',
    status: 'connected',
    threadId: null,
    startSubmitted: false,
    startAccepted: false,
    started: false,
    closed: false,
    unknown: false,
    workEpoch: 0,
    turns: new Map(),
    externalTurns: new Map(),
    handoffs: new Map(),
    finished: new Set(),
    tools: new Set(),
    spokenContext: [],
    eventChain: Promise.resolve(),
    mediaChain: Promise.resolve(),
    messageChain: Promise.resolve(),
    queuedEvents: 0,
    queuedBytes: 0,
    ready: deferred(),
    closedSignal: deferred(),
    failure: deferred(),
    ...overrides,
  };
}

export function observedArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'Expected a fixture array.');
  return value;
}
export function rpcText(
  value: import('../../src/runtime/protocol.ts').RpcInput | undefined,
): string {
  assert.ok(value && value.type === 'text', 'Expected a text RPC input.');
  return value.text;
}
export function emitFixtureEvent(value: unknown, event: string, ...arguments_: unknown[]): boolean {
  assert.ok(value instanceof EventEmitter, 'Expected an observable fixture.');
  return value.emit(event, ...arguments_);
}

export function observedString(value: unknown): string {
  assert.ok(typeof value === 'string', 'Expected a fixture string.');
  return value;
}

export function nativeTurnFromSession(
  session: import('../../src/voice/realtime-types.ts').NativeSession,
  value: import('../../src/work/engine-types.ts').ExecutionTask | undefined,
): import('../../src/voice/realtime-types.ts').NativeTurn {
  assert.ok(value && value.turnId, 'Expected the accepted native turn.');
  const turn = session.turns.get(value.turnId);
  assert.ok(turn && turn === value, 'The exact native turn must still own the session.');
  return turn;
}
export function currentActive(engine: {
  active: import('../../src/work/engine-types.ts').EngineActiveTask | null;
}) {
  return engine.active;
}
export function currentProgress(
  voice: Pick<import('../../src/voice/realtime.mts').NativeRealtimeVoice, 'progress'>,
) {
  return voice.progress;
}

export function deliveredMessageId(
  value: import('../../src/work/engine-types.ts').DeliveryResult,
): string {
  assert.ok(value.sent, 'Expected a delivered message.');
  return value.messageId;
}
