/** Named wire values shared by the Controller, Worker and browser. */
export const DesktopPhase = Object.freeze(/** @type {const} */ ({
  Idle: 'idle', Pausing: 'pausing', Paused: 'paused', Suspending: 'suspending', Suspended: 'suspended', Resuming: 'resuming',
}));
export const VmPowerState = Object.freeze(/** @type {const} */ ({Running: 'running', Suspended: 'suspended', Off: 'off'}));
export const VmReceiptPhase = Object.freeze(/** @type {const} */ ({Suspending: 'suspending', Suspended: 'suspended'}));
export const ServiceUpdateStatus = Object.freeze(/** @type {const} */ ({Checking: 'checking', Updating: 'updating', Pending: 'pending', Current: 'current', Failed: 'failed'}));
export const ConnectionStatus = Object.freeze(/** @type {const} */ ({Offline: 'offline', Connecting: 'connecting', Online: 'online'}));

// TaskStatus contains the compatibility vocabulary. Validators still use the
// narrower ChatTaskStatus or WorkStatus domain for their actual record kind.
export const TaskStatus = Object.freeze(/** @type {const} */ ({
  Draft: 'draft', Accepted: 'accepted', Queued: 'queued', Running: 'running', Continuing: 'continuing', WaitingUser: 'waiting_user', Pausing: 'pausing', Paused: 'paused', Unknown: 'unknown', Review: 'review', Failed: 'failed', Completed: 'completed', Cancelled: 'cancelled', Interrupted: 'interrupted',
}));
export const ChatTaskStatus = Object.freeze(/** @type {const} */ ({
  Draft: TaskStatus.Draft, Accepted: TaskStatus.Accepted, Queued: TaskStatus.Queued, Running: TaskStatus.Running, WaitingUser: TaskStatus.WaitingUser, Pausing: TaskStatus.Pausing, Paused: TaskStatus.Paused, Failed: TaskStatus.Failed, Review: TaskStatus.Review, Completed: TaskStatus.Completed, Cancelled: TaskStatus.Cancelled,
}));
export const WorkStatus = Object.freeze(/** @type {const} */ ({
  Running: TaskStatus.Running, Continuing: TaskStatus.Continuing, WaitingUser: TaskStatus.WaitingUser, Pausing: TaskStatus.Pausing, Paused: TaskStatus.Paused, Unknown: TaskStatus.Unknown, Review: TaskStatus.Review, Failed: TaskStatus.Failed, Completed: TaskStatus.Completed, Cancelled: TaskStatus.Cancelled,
}));
export const PlanStepStatus = Object.freeze(/** @type {const} */ ({Pending: 'pending', InProgress: 'inProgress', Completed: 'completed'}));
export const TaskPriority = Object.freeze(/** @type {const} */ ({High: 'high', Normal: 'normal', Low: 'low'}));
export const SubmissionStatus = Object.freeze(/** @type {const} */ ({Preparing: 'preparing', Submitting: 'submitting', Confirmed: 'confirmed', Unknown: 'unknown', NotSubmitted: 'not-submitted'}));
export const ContinuationDispatchPhase = Object.freeze(/** @type {const} */ ({Claimed: 'claimed', Submitting: 'submitting', Acknowledged: 'acknowledged', Unknown: 'unknown'}));
export const TaskProgressStage = Object.freeze(/** @type {const} */ ({Preparing: 'preparing', Working: 'working', Computer: 'computer', Command: 'command', Files: 'files', Responding: 'responding', Saving: 'saving'}));
export const ComputerControlStatus = Object.freeze(/** @type {const} */ ({Dant: 'dant', Acquiring: 'acquiring', Human: 'human'}));

/** @typedef {(typeof DesktopPhase)[keyof typeof DesktopPhase]} DesktopPhaseValue */
/** @typedef {(typeof ServiceUpdateStatus)[keyof typeof ServiceUpdateStatus]} ServiceUpdateStatusValue */
/** @typedef {(typeof TaskStatus)[keyof typeof TaskStatus]} TaskStatusValue */
/** @typedef {(typeof ChatTaskStatus)[keyof typeof ChatTaskStatus]} ChatTaskStatusValue */
/** @typedef {(typeof WorkStatus)[keyof typeof WorkStatus]} WorkStatusValue */
/** @typedef {(typeof PlanStepStatus)[keyof typeof PlanStepStatus]} PlanStepStatusValue */
/** @typedef {(typeof TaskPriority)[keyof typeof TaskPriority]} TaskPriorityValue */

/**
 * Validate an unknown wire value without coercion or inventing a fallback.
 * @template {Record<string, string>} Domain
 * @param {Domain} domain
 * @param {unknown} value
 * @returns {value is Domain[keyof Domain]}
 */
export function isEnumValue(domain, value) {
  return typeof value === 'string' && Object.values(domain).some((entry) => entry === value);
}
