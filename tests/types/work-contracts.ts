import { PlanStepStatus, TaskStatus } from '../../src/contracts/states.mts';
import type {
  TaskExecutionProgress,
  TaskPlanInput,
  TaskProgressSnapshot,
  TaskProgressTask,
  VoiceCompletionWork,
  WorkContinuation,
} from '../../src/contracts/contracts.ts';
import {
  publicTaskPlan,
  safeCompletionWork,
  startTaskProgress,
  taskPlanInput,
  taskProgressSnapshot,
} from '../../src/work/task-progress.mts';
import {
  continuationEligible,
  continuationId,
  safeWorkContinuation,
  workContinuationCheckpoint,
} from '../../src/work/work-continuation-state.mts';

export function acceptUnknownPlan(value: unknown): TaskPlanInput {
  return taskPlanInput(value);
}
export function validatedContinuation(value: unknown): WorkContinuation | null {
  return safeWorkContinuation(value);
}
export function validatedVoiceResult(value: unknown): VoiceCompletionWork | undefined {
  return safeCompletionWork(value);
}
const task: TaskProgressTask = { messageId: 'task', turnId: 'turn' };
export const progress: TaskExecutionProgress = startTaskProgress(task, { at: 1 });
export const snapshot: TaskProgressSnapshot = taskProgressSnapshot(task, {
  status: TaskStatus.Running,
});
export const checkpoint: string = workContinuationCheckpoint(
  publicTaskPlan([{ step: 'Verify', status: PlanStepStatus.Pending }]),
);
export const canContinue: boolean = continuationEligible({});
export function explicitIdLimit(value: unknown): string | null {
  return continuationId(value, 128) ? value : null;
}
