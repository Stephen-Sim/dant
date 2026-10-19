import { isRecord } from '../contracts/json.mts';
import { ComputerControlStatus, isEnumValue } from '../contracts/states.mts';
import type { ComputerControl } from '../contracts/contracts.ts';
interface ControlEngine {
  acquiring: boolean;
  takeover: boolean;
  assertTakeoverCall(): void;
  pauseQueue?(): void;
  acquire(): Promise<unknown>;
  release(): unknown;
}
interface GuestWorker {
  guest(route: string, body: unknown): Promise<Response>;
}
const CONTROL_EXPIRY_GRACE_MS = 20;
const CONTROL_INPUT_TTL_MS = 120000;
function controlResult(value: unknown): ComputerControl {
  if (
    !isRecord(value) ||
    !isEnumValue(ComputerControlStatus, value.status) ||
    (value.sessionId !== null && typeof value.sessionId !== 'string') ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt < 0
  )
    throw Error('Desktop control state was not confirmed.');
  return { status: value.status, sessionId: value.sessionId, expiresAt: value.expiresAt };
}
import { EventEmitter } from 'node:events';

export class ComputerSession extends EventEmitter {
  readonly engine: ControlEngine;
  readonly worker: GuestWorker;
  state: ComputerControl;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  constructor(engine: ControlEngine, worker: GuestWorker) {
    super();
    this.engine = engine;
    this.worker = worker;
    this.state = { status: ComputerControlStatus.Dant, sessionId: null, expiresAt: 0 };
    this.pending = false;
    this.timer = null;
  }
  snapshot() {
    return { ...this.state };
  }
  change() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.state.sessionId) {
      this.timer = setTimeout(
        () => {
          this.state = { status: ComputerControlStatus.Dant, sessionId: null, expiresAt: 0 };
          this.engine.release();
          this.change();
        },
        Math.max(1, this.state.expiresAt - Date.now() + CONTROL_EXPIRY_GRACE_MS),
      );
      this.timer.unref?.();
    }
    this.emit('change');
  }
  async control(body: { action: 'acquire' | 'confirm' | 'release'; sessionId?: string | null }) {
    return controlResult(await (await this.worker.guest('/control', body)).json());
  }
  async acquire() {
    if (this.pending || this.state.sessionId) throw Error('Desktop takeover is already active.');
    this.engine.assertTakeoverCall();
    this.pending = true;
    this.engine.acquiring = true;
    this.engine.pauseQueue?.();
    try {
      this.state = await this.control({ action: 'acquire' });
      this.change();
      this.engine.acquiring = false;
      await this.engine.acquire();
      this.state = await this.control({ action: 'confirm', sessionId: this.state.sessionId });
      this.change();
      return this.snapshot();
    } catch (error) {
      if (this.state.sessionId)
        await this.control({ action: 'release', sessionId: this.state.sessionId }).catch(() => {});
      this.state = { status: ComputerControlStatus.Dant, sessionId: null, expiresAt: 0 };
      this.engine.takeover = false;
      this.change();
      throw error;
    } finally {
      this.pending = false;
      this.engine.acquiring = false;
    }
  }
  assertSession(sessionId: unknown) {
    if (
      this.state.status !== ComputerControlStatus.Human ||
      !sessionId ||
      sessionId !== this.state.sessionId ||
      Date.now() >= this.state.expiresAt
    )
      throw Error('Desktop control session expired. Take control again.');
  }
  async input(body: unknown) {
    if (!isRecord(body)) throw Error('Invalid desktop input.');
    this.assertSession(body.sessionId);
    const expected = this.state.sessionId;
    const result: unknown = await (await this.worker.guest('/input', body)).json();
    if (!isRecord(result)) throw Error('Desktop input result was not confirmed.');
    if (this.state.sessionId === expected) {
      this.state.expiresAt =
        typeof result.expiresAt === 'number' &&
        Number.isFinite(result.expiresAt) &&
        result.expiresAt > 0
          ? result.expiresAt
          : Date.now() + CONTROL_INPUT_TTL_MS;
      this.change();
    }
    return result;
  }
  async release(sessionId: unknown) {
    this.assertSession(sessionId);
    if (this.pending) throw Error('Desktop control is changing.');
    this.pending = true;
    try {
      await this.control({ action: 'release', sessionId: this.state.sessionId });
      this.state = { status: ComputerControlStatus.Dant, sessionId: null, expiresAt: 0 };
      this.engine.release();
      this.change();
      return this.snapshot();
    } finally {
      this.pending = false;
    }
  }
  close() {
    if (this.timer) clearTimeout(this.timer);
  }
}
