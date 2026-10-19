import type { ExecutionTask, EngineActiveTask, WorkMessage } from '../work/engine-types.ts';
import type { RpcEvent } from '../runtime/protocol.ts';
import type { TaskExecutionProgress } from '../contracts/contracts.ts';
import type { LiveContextQueue } from './call-context.mts';
import type { createSpokenSubtitles } from './call-subtitles.mts';

export interface VoidDeferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}
export interface NativeTurn extends ExecutionTask {
  turnId: string;
  explicitMessageIds: string[];
  pendingSubmissions: number;
  stopped: Promise<void>;
  resolveStopped: () => void;
  done: boolean;
  resultSaved?: boolean;
  outputChars?: number;
  error?: string | undefined;
  interruption?: Promise<unknown>;
  finalized?: boolean;
}
export interface ContinuationAdmission {
  active: EngineActiveTask;
  session: NativeSession;
  threadId: string | null;
  callId: string;
  generation: number;
  epoch: number;
  attemptId: string;
  conflict: boolean;
  checked?: boolean;
  acknowledged?: boolean;
  retained: RpcEvent[];
}
export interface NativeHandoff {
  itemId: string;
  turnId: string | null;
  idleConfirmed?: boolean;
  humanControl?: boolean;
}
export interface NativeCallInput {
  epoch: number;
  dispatched: boolean;
  settled: boolean;
  promise: Promise<NativeMessageResult> | null;
  error?: string | undefined;
}
export interface NativeStopCause {
  reason: string;
  at: number;
  method?: string;
  eventBytes?: number;
  queuedBytes?: number;
  queuedEvents?: number;
  itemType?: string;
  itemStatus?: string;
  itemId?: string;
}
export interface NativeStopRecord extends NativeStopCause {
  callId: string;
  executorStopped: boolean;
  confirmed: boolean;
  workContinues?: boolean;
}
export interface NativeSession {
  id: string;
  mediaId: string;
  mediaGeneration: number;
  voice: string;
  status: string;
  threadId: string | null;
  startSubmitted: boolean;
  startAccepted: boolean;
  started: boolean;
  closed: boolean;
  unknown: boolean;
  workEpoch: number;
  turns: Map<string, NativeTurn>;
  externalTurns: Map<string, EngineActiveTask>;
  handoffs: Map<string, NativeHandoff>;
  finished: Set<string>;
  tools: Set<string>;
  spokenContext: Array<{ role: string; text: string }>;
  eventChain: Promise<unknown>;
  mediaChain: Promise<unknown>;
  messageChain: Promise<unknown>;
  queuedEvents: number;
  queuedBytes: number;
  ready: VoidDeferred;
  closedSignal: VoidDeferred;
  failure: VoidDeferred;
  borrowedWork?: boolean;
  background?: boolean;
  reconnecting?: boolean;
  mediaUnconfirmed?: boolean;
  pausing?: boolean;
  stopping?: boolean;
  continueWork?: boolean;
  connectedAt?: number | null;
  answer?: string;
  realtimeSessionId?: string | undefined;
  retiredRealtimeIds?: Set<string>;
  contextQueue?: LiveContextQueue;
  callInputs?: Map<string, NativeCallInput>;
  backgroundInputs?: Map<string, { turnId: string; promise: Promise<unknown> }>;
  continuationAdmission?: ContinuationAdmission | null;
  continuationUncertain?: ContinuationAdmission;
  workProgress?: TaskExecutionProgress;
  submitting?: { message: WorkMessage; early: RpcEvent[]; bytes: number };
  pausePromise?: Promise<unknown> | null;
  stopPromise?: Promise<unknown> | null;
  stopCause?: NativeStopCause;
  stopRecord?: NativeStopRecord;
  stopAttempt?: { callId: string; generation: number; acceptedWork: boolean; live: boolean } | null;
  subtitles?: ReturnType<typeof createSpokenSubtitles>;
}

export interface NativeMessageResult {
  turnId?: string;
  message: WorkMessage;
  callId: string;
  submission?:
    import('../conversation/types.ts').ChatMessage['submission'] | 'confirmed' | undefined;
  voiceContext?:
    | import('./call-context.mts').LiveContextResult
    | {
        callId: string | undefined;
        kind: string;
        messageId?: string | undefined;
        status: string;
        error?: string;
      };
  duplicate?: boolean;
  unknownOutcome?: boolean;
}
