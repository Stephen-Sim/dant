import {
  ServiceUpdateStatus,
  ConnectionStatus,
  TaskStatus,
  SubmissionStatus,
  ComputerControlStatus,
} from '../contracts/states.mts';

type ConnectionState = (typeof ConnectionStatus)[keyof typeof ConnectionStatus];
type UpdateState = (typeof ServiceUpdateStatus)[keyof typeof ServiceUpdateStatus];
type TimerHandle = ReturnType<typeof setTimeout>;

export interface ServiceUpdateObservation {
  readonly status: UpdateState;
  readonly reason?: string | null;
}

export interface ServiceUpdateBridge {
  readonly status: ConnectionState;
  readonly generation?: number | undefined;
  readonly serviceUpdate?: ServiceUpdateObservation | null | undefined;
  readonly sourceVerified?: boolean;
  refresh(force: boolean): Promise<unknown>;
  confirmServiceVersion?(): Promise<unknown>;
  reconcileServiceUpdate?(): Promise<unknown>;
}

export interface AutomaticServiceConnection {
  readonly deploy: boolean;
  readonly automatic: true;
}

export interface ServiceUpdateLoopOptions {
  readonly bridge: ServiceUpdateBridge;
  readonly connect: (options: AutomaticServiceConnection) => Promise<unknown>;
  readonly binding: () => unknown;
  readonly allowed?: () => boolean;
  readonly setTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
  readonly clearTimer?: (timer: TimerHandle | null) => void;
}

const RETRY_BASE_DELAY_MS = 5_000;
const PENDING_UPDATE_DELAY_MS = 1_000;
const UPDATE_RECHECK_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// The automatic path only observes fresh VM state. The remote installer repeats
// these checks immediately before changing a live service.
function quiescent(state: unknown, allowStopped: boolean): boolean {
  if (!isRecord(state)) return false;
  const worker = state.worker;
  if (
    state.active !== null ||
    state.call !== null ||
    !isArray(state.queue) ||
    state.queue.length ||
    state.takeover !== false ||
    state.acquiring ||
    !isRecord(worker) ||
    !(
      worker.status === ConnectionStatus.Online ||
      (allowStopped && worker.status === ConnectionStatus.Offline)
    )
  )
    return false;
  const computer = state.computer;
  if (
    !isRecord(computer) ||
    computer.status !== ComputerControlStatus.Dant ||
    computer.sessionId ||
    computer.pending ||
    computer.acquiring
  )
    return false;
  if (!isArray(state.messages) || !isArray(state.workTasks)) return false;
  return ![...state.messages, ...state.workTasks].some((entry) => {
    if (!isRecord(entry)) return true;
    const continuation = entry.continuation;
    if (
      entry.unknownOutcome === true ||
      [SubmissionStatus.Unknown, SubmissionStatus.Submitting].some(
        (status) => status === entry.submission,
      ) ||
      (continuation !== undefined &&
        continuation !== null &&
        (!isRecord(continuation) || continuation.invalid || continuation.dispatch))
    )
      return true;
    // Accepted speech in a finished call is conversation history, not an
    // execution task. It has no turn/work ownership to interrupt or resume.
    if (
      entry.role === 'user' &&
      entry.workKind === 'conversation' &&
      entry.voiceCallId &&
      !entry.turnId &&
      !entry.workId &&
      entry.status === TaskStatus.Accepted
    )
      return false;
    return (
      [
        TaskStatus.Unknown,
        TaskStatus.Running,
        TaskStatus.Queued,
        TaskStatus.Accepted,
        TaskStatus.Pausing,
        TaskStatus.Continuing,
      ].some((status) => status === entry.status) ||
      (entry.status === TaskStatus.WaitingUser &&
        !(
          typeof entry.executionEndedAt === 'number' &&
          Number.isFinite(entry.executionEndedAt) &&
          entry.executionEndedAt > 0
        ))
    );
  });
}
export const serviceUpdateIdle = (state: unknown): boolean => quiescent(state, false);
// Explicit installation/Exit may suspend an already stopped executor. A
// connecting, unknown or busy executor is never substituted with an online one.
export const serviceUpdatePaused = (state: unknown): boolean => quiescent(state, true);

// One Controller owns retries. A transport retry never gains permission to pause
// work, and an unconfirmed installation is only reconciled with read requests.
export class VmServiceUpdateLoop {
  readonly bridge: ServiceUpdateBridge;
  readonly connect: ServiceUpdateLoopOptions['connect'];
  readonly binding: ServiceUpdateLoopOptions['binding'];
  readonly allowed: () => boolean;
  readonly setTimer: NonNullable<ServiceUpdateLoopOptions['setTimer']>;
  readonly clearTimer: NonNullable<ServiceUpdateLoopOptions['clearTimer']>;
  enabled = false;
  closed = false;
  epoch = 0;
  attempt = 0;
  checked = false;
  scope: string | null | undefined = null;
  pending: Promise<void> | null = null;
  timer: TimerHandle | null = null;
  driving = false;

  constructor({
    bridge,
    connect,
    binding,
    allowed = () => true,
    setTimer = (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer = (timer) => {
      if (timer !== null) clearTimeout(timer);
    },
  }: ServiceUpdateLoopOptions) {
    this.bridge = bridge;
    this.connect = connect;
    this.binding = binding;
    this.allowed = allowed;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }
  identity(): string | undefined {
    return JSON.stringify(this.binding());
  }
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.enabled = true;
    return this.run();
  }
  reset(): void {
    this.epoch++;
    this.attempt = 0;
    this.checked = false;
    this.scope = this.identity();
    this.clearTimer(this.timer);
    this.timer = null;
    if (this.enabled) this.schedule(0);
  }
  schedule(ms = UPDATE_RECHECK_DELAY_MS): void {
    if (!this.enabled || this.closed || this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run().catch(() => {});
    }, ms);
    this.timer?.unref?.();
  }
  changed(): void {
    if (!this.enabled || this.closed) return;
    if (this.scope !== this.identity()) {
      this.reset();
      return;
    }
    if (this.pending || this.driving) return;
    const update = this.bridge.serviceUpdate;
    if (this.bridge.status !== ConnectionStatus.Online) this.schedule(RETRY_BASE_DELAY_MS);
    else if (update && update.status !== ServiceUpdateStatus.Current)
      this.schedule(
        update.status === ServiceUpdateStatus.Pending
          ? PENDING_UPDATE_DELAY_MS
          : UPDATE_RECHECK_DELAY_MS,
      );
  }
  async run(): Promise<void> {
    if (!this.enabled || this.closed) return;
    if (this.pending) return this.pending;
    if (this.scope !== this.identity()) {
      this.epoch++;
      this.scope = this.identity();
      this.checked = false;
      this.attempt = 0;
    }
    const epoch = this.epoch,
      scope = this.scope,
      current = () =>
        !this.closed && this.enabled && epoch === this.epoch && scope === this.identity();
    this.driving = true;
    const pending = (async () => {
      if (!this.allowed()) {
        this.schedule(RETRY_BASE_DELAY_MS);
        return;
      }
      const update = this.bridge.serviceUpdate,
        uncertain = update?.reason === 'update-unconfirmed';
      try {
        if (this.bridge.status === ConnectionStatus.Online) {
          if (update?.status === ServiceUpdateStatus.Current || (!update && this.checked)) {
            this.checked = true;
            this.attempt = 0;
            return;
          }
          if (update?.reason === 'version-unconfirmed' && this.bridge.sourceVerified) {
            await this.bridge.confirmServiceVersion?.();
            return;
          }
          if (uncertain) {
            await this.bridge.reconcileServiceUpdate?.();
            return;
          }
          if (
            update?.status === ServiceUpdateStatus.Failed &&
            !['connection-unavailable', 'version-unconfirmed'].some(
              (reason) => reason === update.reason,
            )
          )
            return;
          const generation = this.bridge.generation,
            state = await this.bridge.refresh(true);
          if (!current() || generation !== this.bridge.generation || !serviceUpdateIdle(state))
            return;
        }
        if (!current() || !this.allowed()) return;
        await this.connect({ deploy: !this.checked && !uncertain, automatic: true });
        if (!current()) return;
        if (
          this.bridge.serviceUpdate?.status === ServiceUpdateStatus.Current ||
          !this.bridge.serviceUpdate
        ) {
          this.checked = true;
          this.attempt = 0;
        } else if (uncertain) await this.bridge.reconcileServiceUpdate?.();
      } catch {
        if (current()) this.attempt = Math.min(this.attempt + 1, MAX_RETRY_ATTEMPTS);
      }
    })().finally(() => {
      if (this.pending === pending) this.pending = null;
      this.driving = false;
      if (!current()) {
        if (!this.closed && this.enabled) this.schedule(0);
        return;
      }
      const update = this.bridge.serviceUpdate;
      if (this.bridge.status !== ConnectionStatus.Online)
        this.schedule(
          Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, this.attempt - 1)),
        );
      else if (update && update.status !== ServiceUpdateStatus.Current)
        this.schedule(UPDATE_RECHECK_DELAY_MS);
    });
    this.pending = pending;
    return pending;
  }
  close(): void {
    this.closed = true;
    this.enabled = false;
    this.epoch++;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
