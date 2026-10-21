import {
  DesktopPhase,
  isEnumValue,
  PlanStepStatus,
  ServiceUpdateStatus,
  TaskPriority,
  TaskStatus,
  WorkStatus,
} from '../../ui/shared/states.mts';
import type {
  DesktopExitResult,
  PlanStep,
  ServiceUpdate,
  TaskPriorityValue,
  WorkStatusValue,
} from '../../ui/shared/api-types.ts';

export const realStep: PlanStep = { step: 'Verify', status: PlanStepStatus.InProgress };
export const realPriority: TaskPriorityValue = TaskPriority.Normal;
export const unfinished: WorkStatusValue = WorkStatus.Continuing;
export const current: ServiceUpdate = {
  status: ServiceUpdateStatus.Current,
  confirmed: true,
  targetVersion: '1.0.0',
  runningVersion: '1.0.0',
  reason: 'source-current',
};
export const suspended: DesktopExitResult = { ok: true, workPaused: true, vmSuspended: true };
// @ts-expect-error A misspelled persisted step state must be rejected.
export const badStep: PlanStep = { step: 'Verify', status: 'in_progress' };
// @ts-expect-error A UI draft is not a durable work record state.
export const draftWork: WorkStatusValue = TaskStatus.Draft;
// @ts-expect-error Priority is a closed domain, not an arbitrary display label.
export const badPriority: TaskPriorityValue = 'urgent';
// @ts-expect-error Current service status requires a live confirmed version.
export const cachedCurrent: ServiceUpdate = {
  status: ServiceUpdateStatus.Current,
  confirmed: false,
  targetVersion: '1.0.0',
  runningVersion: null,
  reason: 'cached',
};
// @ts-expect-error Exit cannot be acknowledged without confirmed paused work.
export const unsafeExit: DesktopExitResult = { ok: true, workPaused: false, vmSuspended: true };
export function phaseFromWire(value: unknown) {
  if (isEnumValue(DesktopPhase, value)) {
    const phase: (typeof DesktopPhase)[keyof typeof DesktopPhase] = value;
    return phase;
  }
  return null;
}
