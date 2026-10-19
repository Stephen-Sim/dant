import {
  ChatTaskStatus,
  ComputerControlStatus,
  ConnectionStatus,
  ContinuationDispatchPhase,
  DesktopPhase,
  PlanStepStatus,
  ServiceUpdateStatus,
  SubmissionStatus,
  TaskProgressStage,
  TaskPriority,
  TaskStatus,
  VmPowerState,
  WorkStatus,
} from './states.mts';

export type ValueOf<Domain> = Domain[keyof Domain];
export type DesktopPhaseValue = ValueOf<typeof DesktopPhase>;
export type VmPowerStateValue = ValueOf<typeof VmPowerState>;
export type ServiceUpdateStatusValue = ValueOf<typeof ServiceUpdateStatus>;
export type ChatTaskStatusValue = ValueOf<typeof ChatTaskStatus>;
export type WorkStatusValue = ValueOf<typeof WorkStatus>;
export type PlanStepStatusValue = ValueOf<typeof PlanStepStatus>;
export type TaskPriorityValue = ValueOf<typeof TaskPriority>;
export type ConnectionStatusValue = ValueOf<typeof ConnectionStatus>;
export type SubmissionStatusValue = ValueOf<typeof SubmissionStatus>;
export type ContinuationDispatchPhaseValue = ValueOf<typeof ContinuationDispatchPhase>;
export type ComputerControlStatusValue = ValueOf<typeof ComputerControlStatus>;
export type TaskStatusValue = ValueOf<typeof TaskStatus>;
export type TaskProgressStageValue = ValueOf<typeof TaskProgressStage>;

export interface PlanStep {
  step: string;
  status: PlanStepStatusValue;
}
export interface TaskPlan {
  total: number;
  completed: number;
  currentStep: string;
  steps: PlanStep[];
}
export interface TaskPlanInput {
  title: string;
  plan: TaskPlan;
  workId?: string;
  status?: typeof TaskStatus.Running | typeof TaskStatus.WaitingUser;
}
export type TaskPlanSummary = Pick<TaskPlan, 'total' | 'completed' | 'currentStep'>;
export interface TaskExecutionProgress {
  startedAt: number;
  updatedAt: number;
  step: TaskProgressStageValue;
  items: Map<string, TaskProgressStageValue>;
  plan?: TaskPlanSummary;
}
export interface TaskProgressTask {
  messageId?: string | null;
  turnId?: string | null;
  workProgress?: TaskExecutionProgress;
  workRecord?: Pick<WorkRecord, 'id' | 'title' | 'plan' | 'startedAt'> | null;
  workObserved?: boolean;
  awaitingChatInput?: unknown;
  credentialWaits?: unknown;
  planWaitingForUser?: unknown;
}
export type ActiveTaskProgressStatus =
  | typeof TaskStatus.Running
  | typeof TaskStatus.WaitingUser
  | typeof TaskStatus.Pausing
  | typeof TaskStatus.Unknown;
export interface TaskProgressSnapshot {
  messageId: string | null;
  turnId: string | null;
  source: 'chat' | 'voice';
  background: boolean;
  status: ActiveTaskProgressStatus;
  startedAt: number | null;
  updatedAt: number | null;
  step: TaskProgressStageValue;
  plan?: TaskPlanSummary | TaskPlan;
  workId?: string;
  title?: string;
}
export type VoiceCompletionStatus =
  | typeof TaskStatus.Review
  | typeof TaskStatus.Failed
  | typeof TaskStatus.Paused
  | typeof TaskStatus.Cancelled;
export interface VoiceCompletionWork {
  source: 'voice';
  status: VoiceCompletionStatus;
  startedAt?: number;
  updatedAt?: number;
}
export interface WorkRecord {
  id: string;
  turnId: string;
  turnIds: string[];
  title: string;
  status: WorkStatusValue;
  source: 'chat' | 'voice';
  plan: TaskPlan | null;
  startedAt: number;
  updatedAt: number;
  executionEndedAt?: number;
  progressPriority?: TaskPriorityValue;
  unknownOutcome?: boolean;
  submission?: SubmissionStatusValue;
  continuation?: WorkContinuation;
}
export interface WorkContinuation {
  nextAt: number | null;
  attempts: number;
  noProgressCount: number;
  lastCheckpoint: string;
  invalid?: true;
  dispatch?: {
    id: string;
    fromTurnId: string;
    runtimeId: string;
    threadId: string;
    phase: ContinuationDispatchPhaseValue;
    createdAt: number;
    turnId?: string;
  };
}
export interface RestoredWorkContinuation {
  continuation: WorkContinuation;
  status?: typeof TaskStatus.Unknown | typeof TaskStatus.Paused;
  pauseReason?:
    | 'continuation-state-invalid'
    | 'continuation-unconfirmed'
    | 'continuation-interrupted'
    | 'automatic-no-progress';
}
export type ServiceUpdate =
  | {
      status: typeof ServiceUpdateStatus.Current;
      confirmed: true;
      targetVersion: string;
      runningVersion: string;
      reason: string;
    }
  | {
      status: Exclude<ServiceUpdateStatusValue, typeof ServiceUpdateStatus.Current>;
      confirmed: boolean;
      targetVersion: string;
      runningVersion: string | null;
      reason: string;
    };
export type DesktopExitResult = { ok: true; workPaused: true } & (
  { vmSuspended: true; unsupported?: false } | { vmSuspended: false; unsupported: true }
);
export interface ComputerControl {
  status: ComputerControlStatusValue;
  sessionId: string | null;
  expiresAt: number;
  pending?: boolean;
}
export interface ConnectionSnapshot {
  status: ConnectionStatusValue;
  cached: boolean;
  authority: 'vm';
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected contract state: ${String(value)}`);
}
