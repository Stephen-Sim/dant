import type { ServiceUpdateStatusValue } from '../../src/contracts/states.mts';
import type { ScheduleRecord } from '../../src/schedules/schedule-types.ts';
import type {
  PlanStepStatusValue,
  TaskPriorityValue,
  TaskProgressSnapshot,
  TaskStatusValue,
  WorkRecord,
} from '../../src/contracts/contracts.ts';

/** The browser accepts JSON only at its transport boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export { isRecord } from '../../src/contracts/json.mts';
import { isRecord } from '../../src/contracts/json.mts';
export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
export const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size?: number;
  sourcePath?: string;
  url?: string;
  text?: string;
}
const attachmentOptionalStrings = ['sourcePath', 'url', 'text'] as const;
export function isAttachment(value: unknown): value is Attachment {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    (value.size === undefined || isFiniteNumber(value.size)) &&
    attachmentOptionalStrings.every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    )
  );
}
export function attachmentSnapshot(value: unknown): Attachment {
  if (!isAttachment(value)) throw Error('Invalid attachment metadata');
  return value;
}
export interface WorkReplyTarget {
  workId: string;
  turnId: string;
  conversationId: string;
}
export interface MessageReceipt {
  readAt?: number | null;
  deliveredAt?: number | null;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  time?: number;
  status?: TaskStatusValue | 'streaming' | 'read' | 'sent' | 'received';
  kind?: string;
  callId?: string;
  turnId?: string | null;
  workId?: string;
  workKind?: string;
  voiceCallId?: string;
  clientMessageId?: string;
  attachments?: Attachment[];
  editedAt?: number;
  starred?: boolean;
  pinned?: boolean;
  read?: boolean;
  readAt?: number | null;
  visibleAt?: number | null;
  receipt?: MessageReceipt;
  replyTo?: string | null;
  reactions?: string[];
  assistantReaction?: string | null;
  receivedAt?: number;
  executorConfirmedAt?: number | null;
  visibleAttachmentIds?: string[];
  seconds?: number;
  error?: unknown;
  unknownOutcome?: boolean;
  submission?: string | null;
  progressPriority?: TaskPriorityValue;
  progressCompleted?: boolean;
  progressDismissed?: boolean;
  progressDismissedAt?: number | null;
  workReply?: WorkReplyTarget;
}
export interface VmSettings {
  host?: string;
  user?: string;
  port?: number;
  keyPath?: string;
  knownHosts?: string;
  provider?: string;
}
export interface UiSettings {
  language?: string;
  vm?: VmSettings;
  timeZone?: string;
}
export type UsageProvider = 'subscription' | 'apiVoice';
export type UsageMode = 'daily' | 'weekly' | 'cumulative';
export type TokenField =
  'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningOutputTokens' | 'totalTokens';
export type UsageCounters = Partial<Record<TokenField, number | null>> & { at?: number };
export interface UsageSnapshot {
  recordedSince?: number | null;
  subscription?: {
    available?: boolean;
    totals?: UsageCounters | null;
    lastResponse?: UsageCounters | null;
  };
  apiVoice?: {
    available?: boolean;
    totals?: UsageCounters | null;
    lastResponse?: UsageCounters | null;
  };
  activity?: {
    timeZone?: string;
    days?: ({ date: string } & Partial<Record<UsageProvider, UsageCounters | null>>)[];
    unallocated?: Partial<Record<UsageProvider, UsageCounters | null>>;
  };
}
export interface UiServiceUpdate {
  status: ServiceUpdateStatusValue;
  confirmed: boolean;
  targetVersion: string;
  runningVersion: string | null;
  reason: string | null;
}
export interface UiConnection {
  status?: string;
  cached?: boolean;
  serviceUpdate?: UiServiceUpdate;
}
export interface CallState {
  id?: string;
  callId?: string;
  provider: 'subscription' | 'api';
  status?: string;
  connectedAt?: number | null;
  startedAt?: number | null;
  seconds?: number;
}
export interface UiActiveTask extends Partial<TaskProgressSnapshot> {
  visible?: boolean;
  messageIds?: string[];
  callId?: string | null;
  progressPriority?: TaskPriorityValue;
  canSteer?: boolean;
}
export interface UiWorkRecord extends Partial<Omit<WorkRecord, 'status' | 'plan'>> {
  status?: string;
  plan?:
    | (Partial<Omit<NonNullable<WorkRecord['plan']>, 'steps'>> & {
        steps?: NonNullable<WorkRecord['plan']>['steps'];
      })
    | null;
  messageId?: string | null;
  provisional?: boolean;
  progressDismissedAt?: number | null;
  pauseReason?: string | null;
  projectContext?: unknown;
}
export interface UiCompletion {
  id?: string;
  turnId: string;
  taskId?: string | null;
  messageIds?: string[];
  at?: number;
  work?: { source: 'voice' | 'chat'; status: TaskStatusValue; updatedAt?: number };
  progressPriority?: TaskPriorityValue;
  progressDismissedAt?: number | null;
  unknownOutcome?: boolean;
  submission?: string | null;
  status?: TaskStatusValue;
}
export interface UiState {
  mode?: 'vm-controller' | 'vm-worker' | 'worker';
  conversationId?: string;
  settings?: UiSettings;
  controller?: UiConnection;
  worker?: UiConnection;
  active?: UiActiveTask | null;
  queue?: string[];
  messages?: ChatMessage[];
  work?: UiWorkRecord[];
  workTasks?: UiWorkRecord[];
  completions?: UiCompletion[];
  capabilities?: { workReply?: boolean; taskReopen?: boolean; recurringSchedules?: boolean };
  takeover?: boolean;
  call?: CallState | null;
  memory?: string;
  memoryFiles?: { name: string; text: string }[];
  credentials?: CredentialVault;
  skills?: SkillLibrary;
  schedules?: UiSchedule[];
}
export type UiSchedule = Pick<
  ScheduleRecord,
  'id' | 'text' | 'at' | 'status' | 'cron' | 'priority' | 'timeZone'
>;
export interface CredentialItem {
  id: string;
  name: string;
  service: string;
  username?: string;
}
export interface CredentialRequest {
  id: string;
  name: string;
  service: string;
  reason?: string;
}
export interface CredentialVault {
  items: CredentialItem[];
  requests: CredentialRequest[];
  error?: string | boolean;
}
export interface SkillItem {
  name: string;
  description: string;
  enabled: boolean;
  path?: string;
}
export interface SkillLibrary {
  items: SkillItem[];
  error?: string | boolean;
}
export interface UiModal {
  type: string;
  messageId?: string;
  fileId?: string;
  parent?: UiModal;
  target?: WorkReplyTarget;
  detailId?: number;
  previewId?: number;
  key?: string | number;
}
export interface DraftPayload {
  text: string;
  replyTo: string | null;
  attachments: Attachment[];
  workReply?: WorkReplyTarget;
}
export interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  keepalive?: boolean;
  signal?: AbortSignal;
  /** JSON transport precondition; runs locally immediately before sending, never across IPC. */
  beforeSend?: () => boolean;
}
export type ApiRequest = (route: string, options?: ApiOptions) => Promise<unknown>;
export type Timer = ReturnType<typeof setTimeout> | number;
export type ScheduleTimer = (callback: () => void, delay: number) => Timer;
export type CancelTimer = (timer: Timer | undefined) => void;
export type Interval = ReturnType<typeof setInterval> | number;
export type Cleanup = () => void;
export interface CoreModule {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}
export interface EventModule {
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<Cleanup>;
}
export interface PlanStepView {
  step: string;
  status: PlanStepStatusValue;
}

/** Preserve structured failure metadata without trusting an arbitrary thrown value. */
export class LocalRequestError extends Error {
  status?: number;
  code?: string;
  unknownOutcome = false;
}
export const requestError = (cause: unknown): LocalRequestError => {
  if (cause instanceof LocalRequestError) return cause;
  const error = new LocalRequestError(
    isRecord(cause) && typeof cause.message === 'string'
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : 'Local API request failed',
  );
  if (isRecord(cause) && typeof cause.name === 'string') error.name = cause.name;
  if (isRecord(cause)) {
    if (typeof cause.status === 'number') error.status = cause.status;
    if (typeof cause.code === 'string') error.code = cause.code;
    error.unknownOutcome = cause.unknownOutcome === true;
  }
  return error;
};

export const hasValue = (values: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && values.includes(value);
