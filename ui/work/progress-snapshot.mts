import { isRecord } from '../shared/contracts.mts';
import type { Attachment, WorkReplyTarget } from '../shared/contracts.mts';
import {
  arrayOf,
  objectOf,
  optional,
  nullable,
  stringValue as string,
  booleanValue as boolean,
  numberValue as number,
  unknownValue,
} from '../shared/validation.mts';
import { PlanStepStatus, TaskProgressStage, isEnumValue } from '../shared/states.mts';
import type { PlanStepStatusValue } from '../shared/states.mts';
import type { TaskProgressStageValue } from '../shared/api-types.ts';

/** Presentation accepts partial old snapshots; unknown state values stay unknown until normalized. */
export interface ProgressMessage {
  id: string;
  role: string;
  text?: string;
  time?: unknown;
  acceptedAt?: unknown;
  status?: unknown;
  source?: unknown;
  kind?: string;
  workKind?: string;
  voiceCallId?: string;
  turnId?: string | null;
  workId?: string;
  attachments?: Attachment[];
  read?: boolean;
  readAt?: number | null;
  receipt?: { readAt?: number | null };
  visibleAt?: number | null;
  unknownOutcome?: unknown;
  submission?: string | null;
  progressPriority?: unknown;
  progressCompleted?: boolean;
  progressDismissedAt?: unknown;
  workReply?: WorkReplyTarget;
}
export interface ProgressPlan {
  total?: number;
  completed?: number;
  currentStep?: string;
  steps?: { step: string; status: PlanStepStatusValue }[];
}
export interface ProgressRecord {
  id: string;
  turnId: string;
  turnIds?: string[];
  messageId?: string | null;
  title?: string;
  status?: unknown;
  source?: string;
  startedAt?: unknown;
  updatedAt?: unknown;
  executionEndedAt?: unknown;
  plan?: ProgressPlan | null;
  unknownOutcome?: unknown;
  submission?: string | null;
  progressPriority?: unknown;
  progressDismissedAt?: unknown;
  continuation?: {
    invalid?: unknown;
    attempts?: number;
    nextAt?: number | null;
    noProgressCount?: number;
    lastCheckpoint?: string;
    dispatch?: { id?: string; threadId?: string; phase?: unknown };
  };
  provisional?: boolean;
  pauseReason?: string | null;
}
export interface ProgressActive {
  messageId?: string | null;
  messageIds?: string[];
  turnId?: string | null;
  workId?: string;
  source?: string;
  status?: unknown;
  visible?: boolean;
  background?: boolean;
  title?: string;
  startedAt?: unknown;
  updatedAt?: unknown;
  plan?: ProgressPlan;
  callId?: string | null;
  canSteer?: boolean;
  progressPriority?: unknown;
  step?: TaskProgressStageValue;
}
export interface ProgressCompletion {
  id?: string;
  turnId: string;
  taskId?: string | null;
  messageIds?: string[];
  at?: unknown;
  work?: { source?: string; status?: unknown; updatedAt?: unknown };
  status?: unknown;
  unknownOutcome?: unknown;
  submission?: string | null;
  progressPriority?: unknown;
  progressDismissedAt?: unknown;
}
export interface ProgressSnapshot {
  conversationId?: string;
  messages?: ProgressMessage[];
  queue?: string[];
  workTasks?: ProgressRecord[];
  completions?: ProgressCompletion[];
  active?: ProgressActive | null;
  worker?: { status?: unknown };
  controller?: { status?: unknown; cached?: unknown };
  capabilities?: { workReply?: unknown; taskReopen?: unknown };
  takeover?: unknown;
}
const strings = arrayOf(string);
const file = objectOf<Attachment>({
  id: string,
  name: string,
  type: string,
  size: optional(number),
  sourcePath: optional(string),
  url: optional(string),
  text: optional(string),
});
const target = objectOf<WorkReplyTarget>({
  workId: string,
  turnId: string,
  conversationId: string,
});
const message = objectOf<ProgressMessage>({
  id: string,
  role: string,
  text: optional(string),
  time: unknownValue,
  acceptedAt: unknownValue,
  status: unknownValue,
  source: unknownValue,
  kind: optional(string),
  workKind: optional(string),
  voiceCallId: optional(string),
  turnId: optional(nullable(string)),
  workId: optional(string),
  attachments: optional(arrayOf(file)),
  read: optional(boolean),
  readAt: optional(nullable(number)),
  visibleAt: optional(nullable(number)),
  receipt: optional(objectOf<{ readAt?: number | null }>({ readAt: optional(nullable(number)) })),
  unknownOutcome: unknownValue,
  submission: optional(nullable(string)),
  progressPriority: unknownValue,
  progressCompleted: optional(boolean),
  progressDismissedAt: unknownValue,
  workReply: optional(target),
});
const plan = objectOf<ProgressPlan>({
  total: optional(number),
  completed: optional(number),
  currentStep: optional(string),
  steps: optional(
    arrayOf(
      objectOf<NonNullable<ProgressPlan['steps']>[number]>({
        step: string,
        status: (value): value is PlanStepStatusValue => isEnumValue(PlanStepStatus, value),
      }),
    ),
  ),
});
const continuation = objectOf<NonNullable<ProgressRecord['continuation']>>({
  invalid: unknownValue,
  attempts: optional(number),
  nextAt: optional(nullable(number)),
  noProgressCount: optional(number),
  lastCheckpoint: optional(string),
  dispatch: optional(
    objectOf<{ id?: string; threadId?: string; phase?: unknown }>({
      id: optional(string),
      threadId: optional(string),
      phase: unknownValue,
    }),
  ),
});
const record = objectOf<ProgressRecord>({
  id: string,
  turnId: string,
  turnIds: optional(strings),
  messageId: optional(nullable(string)),
  title: optional(string),
  status: unknownValue,
  source: optional(string),
  startedAt: unknownValue,
  updatedAt: unknownValue,
  executionEndedAt: unknownValue,
  plan: optional(nullable(plan)),
  unknownOutcome: unknownValue,
  submission: optional(nullable(string)),
  progressPriority: unknownValue,
  progressDismissedAt: unknownValue,
  continuation: optional(continuation),
  provisional: optional(boolean),
  pauseReason: optional(nullable(string)),
});
const active = objectOf<ProgressActive>({
  messageId: optional(nullable(string)),
  messageIds: optional(strings),
  turnId: optional(nullable(string)),
  workId: optional(string),
  source: optional(string),
  status: unknownValue,
  visible: optional(boolean),
  background: optional(boolean),
  title: optional(string),
  startedAt: unknownValue,
  updatedAt: unknownValue,
  plan: optional(plan),
  callId: optional(nullable(string)),
  canSteer: optional(boolean),
  progressPriority: unknownValue,
  step: optional((value): value is TaskProgressStageValue => isEnumValue(TaskProgressStage, value)),
});
const completion = objectOf<ProgressCompletion>({
  id: optional(string),
  turnId: string,
  taskId: optional(nullable(string)),
  messageIds: optional(strings),
  at: unknownValue,
  work: optional(
    objectOf<NonNullable<ProgressCompletion['work']>>({
      source: optional(string),
      status: unknownValue,
      updatedAt: unknownValue,
    }),
  ),
  status: unknownValue,
  unknownOutcome: unknownValue,
  submission: optional(nullable(string)),
  progressPriority: unknownValue,
  progressDismissedAt: unknownValue,
});
const snapshot = objectOf<ProgressSnapshot>({
  conversationId: optional(string),
  messages: optional(arrayOf(message)),
  queue: optional(strings),
  workTasks: optional(arrayOf(record)),
  completions: optional(arrayOf(completion)),
  active: optional(nullable(active)),
  worker: optional(objectOf<{ status?: unknown }>({ status: unknownValue })),
  controller: optional(
    objectOf<{ status?: unknown; cached?: unknown }>({
      status: unknownValue,
      cached: unknownValue,
    }),
  ),
  capabilities: optional(
    objectOf<{ workReply?: unknown; taskReopen?: unknown }>({
      workReply: unknownValue,
      taskReopen: unknownValue,
    }),
  ),
  takeover: unknownValue,
});
export function progressSnapshot(value: unknown): ProgressSnapshot | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !snapshot(value)) throw Error('Invalid work progress snapshot');
  return value;
}
