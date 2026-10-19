import type {
  TaskExecutionProgress,
  TaskProgressTask,
  TaskStatusValue,
} from '../contracts/contracts.ts';
import type {
  ChatAttachment,
  ChatMessage,
  StoredWorkRecord,
  WorkReplyTarget,
  ProgressMetadata,
} from '../conversation/types.ts';
import type { DeliverableBaseline } from '../files/attachment-types.ts';
import type { RpcEvent } from '../runtime/protocol.ts';

export type WorkMessage = Pick<ChatMessage, 'id'> & Partial<Omit<ChatMessage, 'id'>>;
export interface EngineCall {
  id: string;
  started?: number;
  connectedAt: number | null;
  status: string;
  provider: 'subscription' | 'api';
}
export interface ContinuationOwner {
  workId: string;
  attemptId: string;
  fromTurnId: string;
  epoch: number;
  bindingPending?: boolean;
  bindingUnconfirmed?: boolean;
  unknown?: boolean;
  possiblySteered?: boolean;
  terminalConfirmed?: boolean;
  stopped?: Promise<void>;
  resolveStopped?: () => void;
}
export interface ExecutionTask extends TaskProgressTask {
  messageId?: string | null;
  turnId: string | null;
  source?: 'chat' | 'voice';
  workProgress?: TaskExecutionProgress;
  workRecord?: StoredWorkRecord | null;
  workReply?: WorkReplyTarget;
  workObserved?: boolean;
  messageIds?: string[];
  explicitMessageIds?: string[];
  outputs: Map<string, string>;
  assistantIds: string[];
  explicitPaths: string[];
  baseline?: DeliverableBaseline | null | undefined;
  voiceOutput?: boolean;
  conversationalInput?: boolean;
  background?: boolean;
  backgroundVoice?: boolean;
  backgroundWaitNotified?: boolean;
  callId?: string | null;
  startAcknowledged?: boolean;
  startSubmitted?: boolean;
  stopRequested?: boolean;
  cancelRequested?: boolean;
  cancelUnconfirmed?: boolean;
  pauseRequested?: boolean;
  pauseOnly?: boolean;
  done?: boolean;
  finalized?: boolean;
  finishing?: Promise<unknown> | boolean;
  finalStatus?: TaskStatusValue;
  credentialWaits?: number;
  awaitingChatInput?: boolean;
  planWaitingForUser?: boolean;
  planWaitRevision?: number;
  continuation?: ContinuationOwner;
  continuationConflict?: boolean;
  continuationExecutionObserved?: boolean;
  pendingSubmissions?: number;
  resultSaved?: boolean;
  cancelOperation?: Promise<unknown>;
  steerUnconfirmed?: boolean;
  preparation?: AbortController;
  terminalConfirmed?: boolean;
  stopped?: Promise<void>;
  resolveStopped?: () => void;
  itemLimitWarning?: boolean;
  outputLimitWarning?: boolean;
  deliveredMcpIds?: Set<string>;
  deliveredTexts?: Set<string>;
  linkedArchives?: Map<string, Promise<ChatAttachment[]>>;
  voiceOutputs?: Map<string, { text: string; raw?: string; final?: boolean }>;
  blockerSequence?: number;
  quietHumanResponse?: boolean;
  quietHumanResponseStart?: number;
  quietInputDelivered?: boolean;
  quietInputCompletion?: boolean;
  quietPublishing?: boolean;
  quietOutcome?: 'result' | 'input' | 'failure';
  quietPending?: Set<Promise<unknown>>;
  quietTexts?: Array<{ text: string; ready: boolean; waiting: boolean }>;
  quietOutputMeta?: Map<string, { phase?: string | undefined; ready?: boolean; waiting?: boolean }>;
}
export interface EngineActiveTask extends ExecutionTask {
  messageId: string | null;
  messageIds: string[];
  continuationAdmission?: {
    threadId: string | null;
    callId: string;
    generation: number;
    epoch: number;
    attemptId: string;
  };
  threadId: string | null;
  starting: Promise<void>;
  resolveStarted: () => void;
  stopped: Promise<void>;
  resolveStopped: () => void;
  startSubmitted: boolean;
  startAcknowledged: boolean;
  early: Array<{ event: RpcEvent; bytes: number }>;
  earlyBytes: number;
  bufferWarning?: boolean;
  finishing?: Promise<unknown> | false;
  steerChain: Promise<unknown>;
}
export interface EngineToolContext {
  task?: ExecutionTask;
  owner?: string;
  callId?: string;
  mediaCallId?: string | null | undefined;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}
export interface ContinueWorkOptions {
  expectedTurnId?: string;
  message?: WorkMessage;
}
export interface ContinuationAdmissionOwner {
  workReply?: WorkReplyTarget | undefined;
  continuation?: ContinuationOwner;
}
export interface ProgressOwnership {
  session: import('../voice/realtime-types.ts').NativeSession | null | undefined;
  ids: Set<string>;
  turns: Set<string>;
  unboundIds: Set<string>;
  queuedTurns: Set<string>;
  queuedIds: Set<string>;
  unboundQueuedIds: Set<string>;
}
export interface ConfirmedStopOwner {
  turnId: string | null;
  messageIds: string[];
  workId?: string | undefined;
}
export interface CallReference {
  message: WorkMessage;
  callId: string;
  promise: Promise<unknown>;
}
export interface PendingVoiceTask {
  resolve: (value: VoiceTaskResult) => void;
  reject: (reason: unknown) => void;
  callId: string | undefined;
  background: boolean;
}
export interface VoiceTaskResult {
  result: string;
  [key: string]: unknown;
}
export type ProgressRecord = ProgressMetadata;

export type DeliveryResult =
  | { sent: true; messageId: string }
  | { sent: false; quiet: true; buffered: boolean; alreadyNotified?: boolean; message?: string };
