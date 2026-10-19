/** Named wire values shared by the Controller, Worker and browser. */
export const HostPlatformId = Object.freeze({
  Windows: 'win32',
  MacOS: 'darwin',
  Linux: 'linux',
  Unsupported: 'unsupported',
} as const);
export const VmProviderId = Object.freeze({
  HyperV: 'hyperv',
  VMware: 'vmware',
  Ssh: 'ssh',
} as const);
export type HostPlatformIdValue = (typeof HostPlatformId)[keyof typeof HostPlatformId];
export type VmProviderIdValue = (typeof VmProviderId)[keyof typeof VmProviderId];

export const BackupMode = Object.freeze({ Manual: 'manual', Automatic: 'automatic' } as const);
export const BackupPhase = Object.freeze({
  Idle: 'idle',
  BackingUp: 'backing-up',
  Restoring: 'restoring',
  Failed: 'failed',
  Unknown: 'unknown',
} as const);
export type BackupModeValue = (typeof BackupMode)[keyof typeof BackupMode];
export type BackupPhaseValue = (typeof BackupPhase)[keyof typeof BackupPhase];
export const WorkerRestorePhase = Object.freeze({
  Prepared: 'prepared',
  Installing: 'installing',
  Committed: 'committed',
  RollingBack: 'rolling-back',
} as const);
export type WorkerRestorePhaseValue = (typeof WorkerRestorePhase)[keyof typeof WorkerRestorePhase];

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
  Resuming: 'resuming',
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
  TakingOver: 'taking-over',
  Human: 'human',
} as const);
export const ScheduleStatus = Object.freeze({
  Pending: 'pending',
  Paused: 'paused',
  Dispatched: 'dispatched',
} as const);
export type ScheduleStatusValue = (typeof ScheduleStatus)[keyof typeof ScheduleStatus];
export const ScheduleDispatchPhase = Object.freeze({
  Prepared: 'prepared',
  Materialized: 'materialized',
  Held: 'held',
  HandedOff: 'handed-off',
} as const);
export type ScheduleDispatchPhaseValue =
  (typeof ScheduleDispatchPhase)[keyof typeof ScheduleDispatchPhase];
export const ProvisioningStatus = Object.freeze({
  Idle: 'idle',
  Preparing: 'preparing',
  AwaitingAdmin: 'awaiting-admin',
  Creating: 'creating',
  Installing: 'installing',
  Ready: 'ready',
  Failed: 'failed',
} as const);
export type ProvisioningStatusValue = (typeof ProvisioningStatus)[keyof typeof ProvisioningStatus];
export const AppUpdateStatus = Object.freeze({
  Idle: 'idle',
  Checking: 'checking',
  Available: 'available',
  Current: 'current',
  Failed: 'failed',
} as const);
export type AppUpdateStatusValue = (typeof AppUpdateStatus)[keyof typeof AppUpdateStatus];
export const UpdateDownloadStatus = Object.freeze({
  Downloading: 'downloading',
  Ready: 'ready',
  Installing: 'installing',
  DownloadFailed: 'downloadFailed',
} as const);
export type UpdateDownloadStatusValue =
  (typeof UpdateDownloadStatus)[keyof typeof UpdateDownloadStatus];
export const RecordingDraftStatus = Object.freeze({
  Recording: 'recording',
  Paused: 'paused',
  Ready: 'ready',
  Finishing: 'finishing',
} as const);
export type RecordingDraftStatusValue =
  (typeof RecordingDraftStatus)[keyof typeof RecordingDraftStatus];
export const MemoryEntryStatus = Object.freeze({
  Candidate: 'candidate',
  Confirmed: 'confirmed',
  Conflicted: 'conflicted',
  Rejected: 'rejected',
} as const);
export type MemoryEntryStatusValue = (typeof MemoryEntryStatus)[keyof typeof MemoryEntryStatus];

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
