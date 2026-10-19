import { includesValue, isRecord } from '../contracts/json.mts';
import {
  TaskStatus,
  PlanStepStatus,
  TaskPriority,
  ConnectionStatus,
} from '../contracts/states.mts';
import type { EventEmitter } from 'node:events';
import type { TaskPlan } from '../contracts/contracts.ts';
export interface ContinuationObservation {
  id?: unknown;
  turnId?: unknown;
  turnIds?: unknown;
  status?: unknown;
  executionEndedAt?: unknown;
  progressDismissedAt?: unknown;
  progressPriority?: unknown;
  unknownOutcome?: unknown;
  submission?: unknown;
  plan?: unknown;
  provisional?: unknown;
  continuation?: unknown;
  pauseReason?: unknown;
}
interface ContinuationStore {
  state: { workTasks: ContinuationObservation[] };
}
export interface ContinuationEngine extends Pick<
  EventEmitter,
  'on' | 'off' | 'removeListener' | 'emit'
> {
  store: ContinuationStore;
  worker: { status: string };
  canContinueRegisteredWork?: (() => unknown) | undefined;
  continueRegisteredWork: (workId: string, options: { expectedTurnId: string }) => unknown;
}
type Timer = number | NodeJS.Timeout;
interface TimerPort {
  setTimer(callback: () => void, delay: number): Timer;
  clearTimer(timer: Timer): unknown;
}
interface ContinuationSupervisorOptions {
  engine?: ContinuationEngine;
  store?: ContinuationStore;
  worker?: { status: string };
  now?: () => number;
  intervalMs?: number;
  setTimer?: TimerPort['setTimer'];
  clearTimer?: TimerPort['clearTimer'];
}
const unref = (timer: Timer) => {
  if (typeof timer !== 'number') timer.unref();
};
function observedPlan(value: unknown): Pick<TaskPlan, 'steps'> {
  if (!isRecord(value) || !Array.isArray(value.steps)) throw Error('Invalid task plan');
  const steps = value.steps.map((step) => {
    if (
      !isRecord(step) ||
      typeof step.step !== 'string' ||
      !includesValue(Object.values(PlanStepStatus), step.status)
    )
      throw Error('Invalid task step');
    return { step: step.step, status: step.status };
  });
  return { steps };
}
import {
  continuationEligible,
  continuationId,
  workContinuationCheckpoint,
} from './work-continuation-state.mts';

const CHANGE_DELAY = 5000;
const FAILURE_DELAY = 30000;
const FAILURE_NOTICE = 'Unfinished work could not be continued. Its saved state was preserved.';
const priority = Object.freeze({
  [TaskPriority.High]: 0,
  [TaskPriority.Normal]: 1,
  [TaskPriority.Low]: 2,
});
const unfinished = (plan: unknown) =>
  plan === null ||
  (isRecord(plan) &&
    Array.isArray(plan.steps) &&
    plan.steps.length > 0 &&
    plan.steps.every(
      (step) => isRecord(step) && includesValue(Object.values(PlanStepStatus), step.status),
    ) &&
    plan.steps.some((step) => step.status !== PlanStepStatus.Completed));
const dueAt = (record: ContinuationObservation) => {
  const continuation = isRecord(record.continuation) ? record.continuation : null;
  return typeof continuation?.nextAt === 'number'
    ? continuation.nextAt
    : (typeof record.executionEndedAt === 'number' ? record.executionEndedAt : Infinity) +
        CHANGE_DELAY;
};
const actionableFailure = (
  record: ContinuationObservation | null | undefined | false,
): record is ContinuationObservation & { id: string } => {
  if (!record || typeof record.id !== 'string') return false;
  const continuation = isRecord(record.continuation) ? record.continuation : null;
  return (
    includesValue([TaskStatus.Unknown, TaskStatus.Failed], record.status) ||
    Boolean(continuation?.invalid || continuation?.dispatch) ||
    (record.status === TaskStatus.Paused &&
      includesValue(['automatic-no-progress', 'continuation-save-failed'], record.pauseReason))
  );
};
const failureFingerprint = (record: ContinuationObservation) => {
  let checkpoint;
  try {
    checkpoint = workContinuationCheckpoint(
      record.plan === null ? null : observedPlan(record.plan),
    );
  } catch {
    checkpoint = 'invalid';
  }
  return JSON.stringify([
    record.turnId,
    record.status,
    record.pauseReason || null,
    checkpoint,
    Boolean(isRecord(record.continuation) && record.continuation.invalid),
    isRecord(record.continuation) && isRecord(record.continuation.dispatch)
      ? record.continuation.dispatch.phase
      : null,
  ]);
};

/** Reconcile saved unfinished work through the Engine's single admission path. */
export class WorkContinuationSupervisor {
  readonly engine: ContinuationEngine;
  readonly store: ContinuationStore;
  readonly worker: { status: string };
  readonly now: () => number;
  readonly intervalMs: number;
  readonly setTimer: TimerPort['setTimer'];
  readonly clearTimer: TimerPort['clearTimer'];
  timer: Timer | null;
  changeTimer: Timer | null;
  started: boolean;
  closed: boolean;
  running: boolean;
  retryAt: number;
  generation: number;
  readonly failureNotices: Map<string, string>;
  readonly onChange: () => void;
  constructor({
    engine,
    store = engine?.store,
    worker = engine?.worker,
    now = Date.now,
    intervalMs = 30000,
    setTimer = setInterval,
    clearTimer = clearInterval,
  }: ContinuationSupervisorOptions = {}) {
    if (
      !engine ||
      !store ||
      !worker ||
      typeof now !== 'function' ||
      typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs <= 0
    )
      throw Error('Work continuation requires the existing conversation engine and timers.');
    this.engine = engine;
    this.store = store;
    this.worker = worker;
    this.now = now;
    this.intervalMs = intervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.changeTimer = null;
    this.started = false;
    this.closed = false;
    this.running = false;
    this.retryAt = 0;
    this.generation = 0;
    this.failureNotices = new Map();
    this.onChange = () => this.scheduleCheck();
  }
  available() {
    return (
      !this.closed &&
      this.worker.status === ConnectionStatus.Online &&
      typeof this.engine.canContinueRegisteredWork === 'function' &&
      this.engine.canContinueRegisteredWork() === true
    );
  }
  eligible(
    record: ContinuationObservation | null | undefined,
    at: number,
  ): record is ContinuationObservation & { id: string; turnId: string } {
    return (
      Boolean(record) &&
      continuationId(record?.id, 128) &&
      continuationId(record?.turnId) &&
      unfinished(record?.plan) &&
      continuationEligible(record, { at })
    );
  }
  candidate(at: number) {
    const records = Array.isArray(this.store.state?.workTasks) ? this.store.state.workTasks : [];
    return (
      records
        .map((record, index) => ({ record, index }))
        .filter(
          (
            entry,
          ): entry is typeof entry & {
            record: ContinuationObservation & { id: string; turnId: string };
          } => this.eligible(entry.record, at),
        )
        .sort(
          (a, b) =>
            (priority[
              includesValue(Object.values(TaskPriority), a.record.progressPriority)
                ? a.record.progressPriority
                : TaskPriority.Normal
            ] ?? 1) -
              (priority[
                includesValue(Object.values(TaskPriority), b.record.progressPriority)
                  ? b.record.progressPriority
                  : TaskPriority.Normal
              ] ?? 1) ||
            dueAt(a.record) - dueAt(b.record) ||
            a.index - b.index,
        )
        .map(({ record }) => ({ id: record.id, turnId: record.turnId }))[0] || null
    );
  }
  async tick() {
    if (this.closed || this.running) return null;
    this.running = true;
    const generation = this.generation;
    let selected: { id: string; turnId: string } | null = null;
    try {
      for (const [id, fingerprint] of this.failureNotices) {
        const record = this.store.state.workTasks.find((record) => record.id === id);
        if (!record || failureFingerprint(record) !== fingerprint) this.failureNotices.delete(id);
      }
      const at = this.now();
      if (at < this.retryAt || !this.available()) return null;
      selected = this.candidate(at);
      if (!selected || !this.available()) return null;
      const current = this.store.state.workTasks.find((record) => record.id === selected?.id);
      if (
        this.closed ||
        generation !== this.generation ||
        current?.turnId !== selected.turnId ||
        !this.eligible(current, this.now())
      )
        return null;
      // No await separates the final selection from the Engine's synchronous
      // reservation. It rechecks the exact saved owner before any submission.
      const result = await this.engine.continueRegisteredWork(selected.id, {
        expectedTurnId: selected.turnId,
      });
      this.failureNotices.delete(selected.id);
      return this.closed || generation !== this.generation ? null : result;
    } catch {
      if (!this.closed && generation === this.generation) {
        this.retryAt = Math.max(this.retryAt, this.now() + FAILURE_DELAY);
        const record =
          selected &&
          this.store.state.workTasks.find(
            (record) =>
              record.id === selected?.id &&
              (record.turnId === selected?.turnId ||
                (selected?.turnId !== undefined &&
                  Array.isArray(record.turnIds) &&
                  record.turnIds.includes(selected.turnId))),
          );
        if (actionableFailure(record)) {
          const fingerprint = failureFingerprint(record);
          if (this.failureNotices.get(record.id) !== fingerprint) {
            this.failureNotices.set(record.id, fingerprint);
            try {
              this.engine.emit?.('notice', FAILURE_NOTICE);
            } catch {}
          }
        }
      }
      return null;
    } finally {
      this.running = false;
    }
  }
  scheduleCheck() {
    if (!this.started || this.closed) return;
    if (this.changeTimer !== null) this.clearTimer(this.changeTimer);
    const generation = this.generation,
      timer = this.setTimer(() => {
        if (this.changeTimer !== timer) return;
        this.clearTimer(timer);
        this.changeTimer = null;
        if (!this.closed && this.started && generation === this.generation) void this.tick();
      }, CHANGE_DELAY);
    this.changeTimer = timer;
    unref(timer);
  }
  start() {
    if (this.started || this.closed) return this;
    this.started = true;
    this.engine.on?.('change', this.onChange);
    this.timer = this.setTimer(() => {
      void this.tick();
    }, this.intervalMs);
    unref(this.timer);
    return this;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.changeTimer !== null) this.clearTimer(this.changeTimer);
    this.timer = null;
    this.changeTimer = null;
    if (typeof this.engine.off === 'function') this.engine.off('change', this.onChange);
    else this.engine.removeListener?.('change', this.onChange);
  }
}
