import { DesktopPhase, ConnectionStatus } from '../contracts/states.mts';
import { serviceUpdatePaused } from '../computer/vm-service-update.mts';
const failure = () =>
  Object.assign(Error('The work computer transition is still in progress.'), {
    status: 409,
    code: 'desktop_transition_busy',
  });

import type { DesktopPhaseValue } from '../contracts/states.mts';
import type { DesktopExitResult } from '../contracts/contracts.ts';

export interface DesktopBridge {
  status: string;
  cached?: { worker?: { status?: unknown } } | undefined;
  connect(options: { deploy: false }): Promise<unknown>;
  refresh(force: true): Promise<unknown>;
  pauseWorkForUpdate(options: { reason: 'install' | 'exit' }): Promise<unknown>;
  disconnect(): void;
}
export type VmSuspension =
  { supported: true; vmSuspended: true } | { supported: false; vmSuspended: false };
export interface OwnedVmLifecycle {
  suspend(): Promise<VmSuspension>;
  resume(): Promise<unknown>;
  resumeForReconnect?(): Promise<unknown>;
}
export interface DesktopLifecycleOptions {
  bridge: DesktopBridge;
  lifecycle: OwnedVmLifecycle;
  binding: () => { host?: string };
  onChange?: () => void;
}

// Coordinates explicit UI/native requests. A normal window close never enters
// this transaction, and a service shutdown never implicitly powers off a VM.
export class DesktopLifecycle {
  readonly bridge: DesktopBridge;
  readonly lifecycle: OwnedVmLifecycle;
  readonly binding: () => { host?: string };
  readonly onChange: () => void;
  phase: DesktopPhaseValue;
  pending: Promise<unknown> | null;
  closed: boolean;
  constructor({ bridge, lifecycle, binding, onChange = () => {} }: DesktopLifecycleOptions) {
    this.bridge = bridge;
    this.lifecycle = lifecycle;
    this.binding = binding;
    this.onChange = onChange;
    this.phase = DesktopPhase.Idle;
    this.pending = null;
    this.closed = false;
  }
  get blocked() {
    return this.phase !== DesktopPhase.Idle;
  }
  state(phase: DesktopPhaseValue) {
    this.phase = phase;
    this.onChange();
  }
  identity() {
    return JSON.stringify(this.binding());
  }
  run<Result>(operation: (current: () => void) => Result | Promise<Result>): Promise<Result> {
    if (this.closed || this.pending) throw failure();
    const identity = this.identity(),
      current = () => {
        if (this.closed || this.identity() !== identity) throw failure();
      };
    const pending = Promise.resolve()
      .then(() => operation(current))
      .catch((error) => {
        this.state(DesktopPhase.Idle);
        throw error;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
  async pause(current: () => void, reason: 'install' | 'exit' = 'install') {
    if (this.phase === DesktopPhase.Paused && this.binding().host) {
      const state = await this.bridge.refresh(true);
      current();
      if (!serviceUpdatePaused(state)) throw failure();
      return;
    }
    this.state(DesktopPhase.Pausing);
    current();
    if (!this.binding().host) {
      this.state(DesktopPhase.Paused);
      return;
    }
    if (this.bridge.status !== ConnectionStatus.Online)
      await this.bridge.connect({ deploy: false });
    current();
    if (
      this.bridge.cached?.worker?.status === ConnectionStatus.Offline ||
      this.bridge.cached?.worker?.status === ConnectionStatus.Connecting
    ) {
      const state = await this.bridge.refresh(true);
      current();
      if (!serviceUpdatePaused(state))
        throw Object.assign(
          Error('Stop active work and return computer control before reconnecting the executor.'),
          { status: 409 },
        );
      this.state(DesktopPhase.Paused);
      return;
    }
    await this.bridge.pauseWorkForUpdate({ reason });
    current();
    this.state(DesktopPhase.Paused);
  }
  prepare({
    recoverManagedVm = false,
    managedVmAlreadyRestored = false,
  }: {
    recoverManagedVm?: boolean;
    managedVmAlreadyRestored?: boolean;
  } = {}) {
    return this.run(async (current) => {
      if (this.binding().host && this.bridge.status !== ConnectionStatus.Online) {
        this.state(DesktopPhase.Resuming);
        if (!managedVmAlreadyRestored) {
          if (recoverManagedVm && this.lifecycle.resumeForReconnect)
            await this.lifecycle.resumeForReconnect();
          else await this.lifecycle.resume();
        }
        current();
      }
      await this.pause(current);
      return { ok: true, workPaused: true } as const;
    });
  }
  exit(): Promise<DesktopExitResult & { notConfigured?: true }> {
    return this.run(async (current) => {
      await this.pause(current, 'exit');
      this.state(DesktopPhase.Suspending);
      const result = await this.lifecycle.suspend();
      current();
      this.state(result.vmSuspended ? DesktopPhase.Suspended : DesktopPhase.Paused);
      if (result.vmSuspended) this.bridge.disconnect();
      const context = {
        ok: true,
        workPaused: true,
        ...(!this.binding().host ? { notConfigured: true as const } : {}),
      } as const;
      return result.vmSuspended
        ? { ...context, vmSuspended: true as const }
        : { ...context, vmSuspended: false as const, unsupported: true as const };
    });
  }
  cancel({ managedVmAlreadyRestored = false }: { managedVmAlreadyRestored?: boolean } = {}) {
    return this.run(async (current) => {
      this.state(DesktopPhase.Resuming);
      if (!managedVmAlreadyRestored) await this.lifecycle.resume();
      current();
      if (this.binding().host && this.bridge.status !== ConnectionStatus.Online)
        await this.bridge.connect({ deploy: false });
      current();
      this.state(DesktopPhase.Idle);
      return { ok: true };
    });
  }
  close() {
    this.closed = true;
  }
}
