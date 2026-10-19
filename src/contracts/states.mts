/** Named wire values shared by the Controller, Worker and browser. */
export const DesktopPhase = Object.freeze({
  Idle: 'idle',
  Pausing: 'pausing',
  Paused: 'paused',
  Suspending: 'suspending',
  Suspended: 'suspended',
  Resuming: 'resuming',
} as const);
export const VmPowerState = Object.freeze({
  Running: 'running',
  Suspended: 'suspended',
  Off: 'off',
} as const);
export const VmReceiptPhase = Object.freeze({
  Suspending: 'suspending',
  Suspended: 'suspended',
} as const);
export const ServiceUpdateStatus = Object.freeze({
  Checking: 'checking',
  Updating: 'updating',
  Pending: 'pending',
  Current: 'current',
  Failed: 'failed',
} as const);
export const ConnectionStatus = Object.freeze({
  Offline: 'offline',
  Connecting: 'connecting',
  Online: 'online',
} as const);

// TaskStatus contains the compatibility vocabulary. Validators still use the
// narrower ChatTaskStatus or WorkStatus domain for their actual record kind.
export const TaskStatus = Object.freeze({
  Draft: 'draft',
  Accepted: 'accepted',
  Queued: 'queued',
  Running: 'running',
  Continuing: 'continuing',
  WaitingUser: 'waiting_user',
  Pausing: 'pausing',
  Paused: 'paused',
  Unknown: 'unknown',
  Review: 'review',
  Failed: 'failed',
  Completed: 'completed',
  Cancelled: 'cancelled',
  Interrupted: 'interrupted',
} as const);
export const ChatTaskStatus = Object.freeze({
  Draft: TaskStatus.Draft,
  Accepted: TaskStatus.Accepted,
  Queued: TaskStatus.Queued,
  Running: TaskStatus.Running,
  WaitingUser: TaskStatus.WaitingUser,
  Pausing: TaskStatus.Pausing,
  Paused: TaskStatus.Paused,
  Failed: TaskStatus.Failed,
  Review: TaskStatus.Review,
  Completed: TaskStatus.Completed,
  Cancelled: TaskStatus.Cancelled,
} as const);
export const WorkStatus = Object.freeze({
  Running: TaskStatus.Running,
  Continuing: TaskStatus.Continuing,
  WaitingUser: TaskStatus.WaitingUser,
  Pausing: TaskStatus.Pausing,
  Paused: TaskStatus.Paused,
  Unknown: TaskStatus.Unknown,
  Review: TaskStatus.Review,
  Failed: TaskStatus.Failed,
  Completed: TaskStatus.Completed,
  Cancelled: TaskStatus.Cancelled,
} as const);
export const PlanStepStatus = Object.freeze({
  Pending: 'pending',
  InProgress: 'inProgress',
  Completed: 'completed',
} as const);
export const TaskPriority = Object.freeze({ High: 'high', Normal: 'normal', Low: 'low' } as const);
export const SubmissionStatus = Object.freeze({
  Preparing: 'preparing',
  Submitting: 'submitting',
  Confirmed: 'confirmed',
  Unknown: 'unknown',
  NotSubmitted: 'not-submitted',
} as const);
export const ContinuationDispatchPhase = Object.freeze({
  Claimed: 'claimed',
  Submitting: 'submitting',
  Acknowledged: 'acknowledged',
  Unknown: 'unknown',
} as const);
export const TaskProgressStage = Object.freeze({
  Preparing: 'preparing',
  Working: 'working',
  Computer: 'computer',
  Command: 'command',
  Files: 'files',
  Responding: 'responding',
  Saving: 'saving',
} as const);
export const ComputerControlStatus = Object.freeze({
  Dant: 'dant',
  Acquiring: 'acquiring',
  Human: 'human',
} as const);

export type DesktopPhaseValue = (typeof DesktopPhase)[keyof typeof DesktopPhase];
export type ServiceUpdateStatusValue =
  (typeof ServiceUpdateStatus)[keyof typeof ServiceUpdateStatus];
export type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus];
export type ChatTaskStatusValue = (typeof ChatTaskStatus)[keyof typeof ChatTaskStatus];
export type WorkStatusValue = (typeof WorkStatus)[keyof typeof WorkStatus];
export type PlanStepStatusValue = (typeof PlanStepStatus)[keyof typeof PlanStepStatus];
export type TaskPriorityValue = (typeof TaskPriority)[keyof typeof TaskPriority];

/** Validate a wire value without coercion or an invented fallback. */
export function isEnumValue<Domain extends Readonly<Record<string, string>>>(
  domain: Domain,
  value: unknown,
): value is Domain[keyof Domain] {
  return typeof value === 'string' && Object.values(domain).some((entry) => entry === value);
}
