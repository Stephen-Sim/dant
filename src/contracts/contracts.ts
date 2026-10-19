import {ChatTaskStatus, ComputerControlStatus, ConnectionStatus, ContinuationDispatchPhase, DesktopPhase, PlanStepStatus, ServiceUpdateStatus, SubmissionStatus, TaskPriority, VmPowerState, WorkStatus} from './states.mjs';

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

export interface PlanStep {step: string; status: PlanStepStatusValue;}
export interface TaskPlan {total: number; completed: number; currentStep: string; steps: PlanStep[];}
export interface WorkRecord {
  id: string; turnId: string; turnIds: string[]; title: string;
  status: WorkStatusValue; source: 'chat' | 'voice'; plan: TaskPlan | null;
  startedAt: number; updatedAt: number; executionEndedAt?: number;
  progressPriority?: TaskPriorityValue; unknownOutcome?: boolean;
  submission?: SubmissionStatusValue; continuation?: WorkContinuation;
}
export interface WorkContinuation {
  nextAt: number | null; attempts: number; noProgressCount: number; lastCheckpoint: string;
  invalid?: true;
  dispatch?: {id: string; fromTurnId: string; runtimeId: string; threadId: string; phase: ContinuationDispatchPhaseValue; createdAt: number; turnId?: string;};
}
export type ServiceUpdate = {
  status: typeof ServiceUpdateStatus.Current; confirmed: true; targetVersion: string; runningVersion: string; reason: string;
} | {
  status: Exclude<ServiceUpdateStatusValue, typeof ServiceUpdateStatus.Current>; confirmed: boolean; targetVersion: string; runningVersion: string | null; reason: string;
};
export type DesktopExitResult = {ok: true; workPaused: true} & (
  {vmSuspended: true; unsupported?: false} | {vmSuspended: false; unsupported: true}
);
export interface ComputerControl {status: ComputerControlStatusValue; sessionId: string | null; expiresAt: number; pending?: boolean;}
export interface ConnectionSnapshot {status: ConnectionStatusValue; cached: boolean; authority: 'vm';}

export function assertNever(value: never): never {throw new Error(`Unexpected contract state: ${String(value)}`);}
