const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const CALL_DURATION_TICK_MS = MILLISECONDS_PER_SECOND;

export function formatCallDuration(value: unknown): string {
  const seconds = Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE),
    remainder = String(seconds % SECONDS_PER_MINUTE).padStart(2, '0');
  return seconds < SECONDS_PER_HOUR
    ? minutes + ':' + remainder
    : Math.floor(seconds / SECONDS_PER_HOUR) +
        ':' +
        String(minutes % SECONDS_PER_MINUTE).padStart(2, '0') +
        ':' +
        remainder;
}

export interface CallDurationSnapshot {
  callId: string | null;
  seconds: number;
  confirmed: boolean;
  finalized: boolean;
  running: boolean;
}
type DefaultTimer = ReturnType<typeof setInterval>;
type TimerHandle = number | DefaultTimer;
interface CallDurationCallbacks {
  now?: () => number;
  onTick?: (snapshot: CallDurationSnapshot) => void;
}
export interface DefaultCallDurationOptions extends CallDurationCallbacks {
  schedule?: undefined;
  cancel?: (handle: DefaultTimer) => void;
}
export interface ScheduledCallDurationOptions<
  Handle extends TimerHandle,
> extends CallDurationCallbacks {
  schedule: (tick: () => void, milliseconds: number) => Handle;
  cancel?: (handle: Handle) => void;
}
export type CallDurationOptions<Handle extends TimerHandle = DefaultTimer> =
  DefaultCallDurationOptions | ScheduledCallDurationOptions<Handle>;
export interface CallDurationClock {
  readonly snapshot: CallDurationSnapshot;
  reset(id?: string | null): void;
  start(id: unknown, at: unknown): void;
  stop(id?: unknown, finalSeconds?: unknown): void;
  sync(call: unknown, messages?: unknown): void;
  dispose(): void;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

// The server's connectedAt and final history seconds are authoritative. A local
// stop freezes the display until confirmation; stale snapshots cannot restart it.
export function createCallDuration<Handle extends TimerHandle>(
  options: ScheduledCallDurationOptions<Handle>,
): CallDurationClock;
export function createCallDuration(options?: DefaultCallDurationOptions): CallDurationClock;
export function createCallDuration<Handle extends TimerHandle = DefaultTimer>(
  options: CallDurationOptions<Handle> = {},
): CallDurationClock {
  const { now = Date.now, onTick = () => {} } = options;
  let callId: string | null = null,
    connectedAt: number | null = null,
    seconds = 0,
    stopTimer: (() => void) | null = null,
    stopped = false,
    confirmed = false,
    finalized = false;
  const snapshot = (): CallDurationSnapshot => ({
    callId,
    seconds,
    confirmed,
    finalized,
    running: stopTimer !== null,
  });
  const clear = (): void => {
    if (stopTimer !== null) {
      stopTimer();
      stopTimer = null;
    }
  };
  function tick(): void {
    if (connectedAt === null) return;
    const next = Math.max(0, Math.round((now() - connectedAt) / MILLISECONDS_PER_SECOND));
    if (next !== seconds) {
      seconds = next;
      onTick(snapshot());
    }
  }
  function reset(id: string | null = null): void {
    clear();
    callId = id;
    connectedAt = null;
    seconds = 0;
    stopped = false;
    confirmed = false;
    finalized = false;
    onTick(snapshot());
  }
  function start(id: unknown, at: unknown): void {
    if (typeof id !== 'string' || !id || typeof at !== 'number' || !Number.isFinite(at) || at < 0)
      return;
    if (callId !== id) reset(id);
    if (stopped) return;
    connectedAt = at;
    confirmed = true;
    tick();
    if (stopTimer === null) {
      if (options.schedule) {
        const custom = options;
        const handle = custom.schedule(tick, CALL_DURATION_TICK_MS);
        stopTimer = () => {
          if (custom.cancel) custom.cancel(handle);
          else clearInterval(handle);
        };
      } else {
        const standard = options;
        const handle = setInterval(tick, CALL_DURATION_TICK_MS);
        stopTimer = () => {
          if (standard.cancel) standard.cancel(handle);
          else clearInterval(handle);
        };
      }
    }
  }
  function stop(id: unknown = callId, finalSeconds?: unknown): void {
    if (!id || id !== callId) return;
    tick();
    clear();
    connectedAt = null;
    stopped = true;
    if (typeof finalSeconds === 'number' && Number.isFinite(finalSeconds) && finalSeconds >= 0) {
      seconds = Math.round(finalSeconds);
      finalized = true;
      confirmed = true;
    }
    onTick(snapshot());
  }
  function sync(call: unknown, messages: unknown = []): void {
    const current = record(call);
    const previous = Array.isArray(messages)
      ? messages.find((value: unknown) => {
          const message = record(value);
          return message?.kind === 'call' && message.callId === callId;
        })
      : undefined;
    const history = record(previous);
    if (history) stop(callId, history.seconds);
    const id = current?.id || current?.callId;
    if (!id) {
      if (callId && !stopped) stop(callId);
      return;
    }
    if (typeof id !== 'string') return;
    if (id !== callId) reset(id);
    if (current?.connectedAt !== null && current?.connectedAt !== undefined)
      start(id, current.connectedAt);
  }
  return {
    get snapshot() {
      return snapshot();
    },
    reset,
    start,
    stop,
    sync,
    dispose() {
      clear();
      stopped = true;
    },
  };
}
