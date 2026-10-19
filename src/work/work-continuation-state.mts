import {
  ContinuationDispatchPhase,
  isEnumValue,
  PlanStepStatus,
  SubmissionStatus,
  TaskStatus,
} from '../contracts/states.mts';
import { createHash } from 'node:crypto';
import { ContinuationPolicy, WorkLimits } from './work-limits.mts';
import type {
  PlanStep,
  RestoredWorkContinuation,
  TaskPlan,
  WorkContinuation,
  WorkRecord,
} from '../contracts/contracts.ts';

interface ContinuationTimeOptions {
  at?: unknown;
}
function properties(value: unknown): Record<string, unknown> | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? (value as Record<string, unknown>)
    : null;
}
function checkpointStep(value: unknown): value is PlanStep {
  const step = properties(value);
  return !!step && typeof step.step === 'string' && isEnumValue(PlanStepStatus, step.status);
}
function eligibleStep(value: unknown): value is PlanStep {
  return (
    checkpointStep(value) && !!value.step.trim() && value.step.length <= WorkLimits.PublicStepLength
  );
}
const uncertainDispatchPhases: ReadonlySet<unknown> = new Set([
  ContinuationDispatchPhase.Submitting,
  ContinuationDispatchPhase.Unknown,
]);
const replyStatuses: ReadonlySet<unknown> = new Set([
  TaskStatus.Continuing,
  TaskStatus.WaitingUser,
  TaskStatus.Paused,
  TaskStatus.Failed,
  TaskStatus.Review,
  TaskStatus.Completed,
  TaskStatus.Cancelled,
]);

const checkpointPattern = /^[a-f0-9]{64}$/;

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const continuationTime = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= WorkLimits.MaxTimestamp;
export const continuationId = (
  value: unknown,
  max: number = WorkLimits.ReferenceIdLength,
): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x20\x7f]/.test(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

export function workContinuationCheckpoint(
  plan: Pick<TaskPlan, 'steps'> | null | undefined,
): string {
  return createHash('sha256')
    .update(JSON.stringify(plan ? plan.steps.map(({ step, status }) => ({ step, status })) : null))
    .digest('hex');
}
export const continuationDelay = (noProgressCount: number): number =>
  Math.min(
    ContinuationPolicy.MaxDelayMs,
    ContinuationPolicy.BaseDelayMs *
      2 ** Math.min(Math.max(0, noProgressCount - 1), ContinuationPolicy.MaxBackoffExponent),
  );

/** Only bounded control metadata survives restart; never preserve raw errors. */
export function safeWorkContinuation(value: unknown): WorkContinuation | null {
  if (
    !plain(value) ||
    !keys(value, [
      'nextAt',
      'attempts',
      'noProgressCount',
      'lastCheckpoint',
      'dispatch',
      'invalid',
    ]) ||
    (value.nextAt !== null && !continuationTime(value.nextAt)) ||
    !count(value.attempts) ||
    !count(value.noProgressCount) ||
    value.noProgressCount > value.attempts ||
    typeof value.lastCheckpoint !== 'string' ||
    !checkpointPattern.test(value.lastCheckpoint)
  )
    return null;
  if (Object.hasOwn(value, 'invalid') && value.invalid !== true) return null;
  const result: WorkContinuation = {
    nextAt: value.nextAt,
    attempts: value.attempts,
    noProgressCount: value.noProgressCount,
    lastCheckpoint: value.lastCheckpoint,
  };
  if (value.invalid === true) {
    if (Object.hasOwn(value, 'dispatch') || value.nextAt !== null) return null;
    result.invalid = true;
    return result;
  }
  if (Object.hasOwn(value, 'dispatch')) {
    const d = value.dispatch;
    if (
      !plain(d) ||
      !keys(d, ['id', 'fromTurnId', 'runtimeId', 'threadId', 'phase', 'createdAt', 'turnId']) ||
      !continuationId(d.id, WorkLimits.IdLength) ||
      !continuationId(d.fromTurnId) ||
      typeof d.runtimeId !== 'string' ||
      !d.runtimeId.trim() ||
      d.runtimeId.length > WorkLimits.RuntimeIdLength ||
      /[\x00-\x1f\x7f]/.test(d.runtimeId) ||
      !continuationId(d.threadId) ||
      !isEnumValue(ContinuationDispatchPhase, d.phase) ||
      !continuationTime(d.createdAt)
    )
      return null;
    if (
      (d.phase === ContinuationDispatchPhase.Acknowledged && !continuationId(d.turnId)) ||
      (Object.hasOwn(d, 'turnId') && (!continuationId(d.turnId) || d.turnId === d.fromTurnId)) ||
      ((d.phase === ContinuationDispatchPhase.Claimed ||
        d.phase === ContinuationDispatchPhase.Submitting) &&
        Object.hasOwn(d, 'turnId'))
    )
      return null;
    result.dispatch = {
      id: d.id,
      fromTurnId: d.fromTurnId,
      runtimeId: d.runtimeId,
      threadId: d.threadId,
      phase: d.phase,
      createdAt: d.createdAt,
      ...(Object.hasOwn(d, 'turnId') ? { turnId: d.turnId as string } : {}),
    };
  }
  return result;
}
export function continuationUnconfirmed(input: unknown): boolean {
  const record = properties(input);
  if (!record || !Object.hasOwn(record, 'continuation')) return false;
  const value = safeWorkContinuation(record.continuation);
  return !value || value.invalid === true || uncertainDispatchPhases.has(value.dispatch?.phase);
}
export function continuationEligible(
  value: unknown,
  { at = Date.now() }: ContinuationTimeOptions = {},
): boolean {
  const record = properties(value);
  if (
    !record ||
    !continuationTime(at) ||
    !continuationId(record?.id, WorkLimits.IdLength) ||
    !continuationId(record?.turnId) ||
    record.status !== TaskStatus.Continuing ||
    !continuationTime(record.executionEndedAt) ||
    record.executionEndedAt > at ||
    record.progressDismissedAt ||
    record.unknownOutcome === true ||
    record.submission === SubmissionStatus.Unknown ||
    record.submission === SubmissionStatus.Submitting
  )
    return false;
  const plan = properties(record.plan),
    planSteps = plan?.steps;
  if (
    record.plan === null
      ? record.provisional !== true
      : !Array.isArray(planSteps) ||
        !planSteps.length ||
        planSteps.length > WorkLimits.PlanSteps ||
        !planSteps.every(eligibleStep) ||
        !planSteps.some((step) => step.status !== PlanStepStatus.Completed)
  )
    return false;
  if (!Object.hasOwn(record, 'continuation'))
    return at >= record.executionEndedAt + ContinuationPolicy.InitialDelayMs;
  const state = safeWorkContinuation(record.continuation);
  return (
    !!state &&
    !state.invalid &&
    !state.dispatch &&
    state.noProgressCount < ContinuationPolicy.NoProgressLimit &&
    state.nextAt !== null &&
    at >= state.nextAt
  );
}
/** An explicit new human answer may wake an ended task, never an uncertain dispatch. */
export function workReplyEligible(
  value: unknown,
  { at = Date.now() }: ContinuationTimeOptions = {},
): boolean {
  const record = properties(value);
  if (
    !record ||
    !replyStatuses.has(record.status) ||
    properties(record.continuation)?.dispatch ||
    continuationUnconfirmed(record)
  )
    return false;
  try {
    const planFields = properties(record.plan),
      steps = planFields?.steps;
    if (record.plan && (!Array.isArray(steps) || !steps.every(checkpointStep))) return false;
    const originalPlan: Pick<TaskPlan, 'steps'> | null | undefined =
      Array.isArray(steps) && steps.every(checkpointStep)
        ? { steps }
        : record.plan === null
          ? null
          : undefined;
    const plan = originalPlan && {
        ...planFields,
        steps: originalPlan.steps.map((step, index) =>
          index === 0 &&
          originalPlan.steps.every((item) => item.status === PlanStepStatus.Completed)
            ? { ...step, status: PlanStepStatus.Pending }
            : step,
        ),
      },
      candidate = {
        ...record,
        plan,
        status: TaskStatus.Continuing,
        continuation: {
          nextAt: at,
          attempts: 0,
          noProgressCount: 0,
          lastCheckpoint: workContinuationCheckpoint(originalPlan),
        },
      };
    return continuationEligible(candidate, { at });
  } catch {
    return false;
  }
}
export function restoreWorkContinuation(
  record: Pick<WorkRecord, 'turnId' | 'turnIds' | 'plan' | 'status'>,
  raw: unknown,
): RestoredWorkContinuation {
  const state = safeWorkContinuation(raw),
    dispatch = state?.dispatch,
    owner = dispatch?.turnId || dispatch?.fromTurnId;
  if (
    !state ||
    (dispatch && (record.turnId !== owner || !record.turnIds.includes(dispatch.fromTurnId)))
  ) {
    return {
      continuation: {
        nextAt: null,
        attempts: 0,
        noProgressCount: 0,
        lastCheckpoint: workContinuationCheckpoint(record.plan),
        invalid: true,
      },
      status: TaskStatus.Unknown,
      pauseReason: 'continuation-state-invalid',
    };
  }
  if (state.invalid)
    return {
      continuation: state,
      status: TaskStatus.Unknown,
      pauseReason: 'continuation-state-invalid',
    };
  if (dispatch)
    return {
      continuation: state,
      status: uncertainDispatchPhases.has(dispatch.phase) ? TaskStatus.Unknown : TaskStatus.Paused,
      pauseReason: uncertainDispatchPhases.has(dispatch.phase)
        ? 'continuation-unconfirmed'
        : 'continuation-interrupted',
    };
  if (
    record.status === TaskStatus.Continuing &&
    state.noProgressCount >= ContinuationPolicy.NoProgressLimit
  )
    return {
      continuation: { ...state, nextAt: null },
      status: TaskStatus.Paused,
      pauseReason: 'automatic-no-progress',
    };
  return { continuation: state };
}
