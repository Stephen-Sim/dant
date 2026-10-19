import { isRecord, errorCode, includesValue } from '../contracts/json.mts';
import { createHostPlatform } from '../platform/host-platform.mts';
import type { HostPlatform } from '../platform/host-types.ts';
import { createVmProviders } from './providers/vm-providers.mts';
import type { VmProviderRegistry } from './providers/provider-types.ts';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import type { VmPowerStateValue } from '../contracts/contracts.ts';
type VmReceiptPhaseValue = (typeof VmReceiptPhase)[keyof typeof VmReceiptPhase];
import type { ManagedVmProvider } from './computer-types.ts';
interface VmIdentity {
  value: Record<string, unknown>;
  digest: string;
}
interface VmReceipt {
  version: 1;
  phase: VmReceiptPhaseValue;
  provider: ManagedVmProvider;
  binding: string;
  vmId: string | null;
  operationId?: string;
  expiresAt?: number;
}
interface VmCommandResult {
  ok: true;
  provider: ManagedVmProvider;
  vmId: string;
  state: VmPowerStateValue;
  changed: boolean;
  addresses?: string[];
}
export type VmSuspendResult =
  | { ok: true; supported: false; vmSuspended: false }
  | { ok: true; supported: true; vmSuspended: true; state: VmPowerStateValue };
export type VmResumeResult = { ok: true; resumed: boolean; state?: VmPowerStateValue };
export interface VmLifecycleOptions {
  dataDir?: string;
  projectRoot?: string;
  platform?: NodeJS.Platform;
  host?: HostPlatform;
  run?: (
    command: string,
    args: readonly string[],
    options: ExecFileOptionsWithStringEncoding,
  ) => Promise<string>;
  timeoutMs?: number;
}
import { VM_OPERATION_TIMEOUT_MS } from '../config/limits.mts';
import { VmPowerState, VmReceiptPhase, VmProviderId } from '../contracts/states.mts';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isIPv4 } from 'node:net';
import { renameAtomicFileSync } from '../files/atomic-file-rename.mts';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OPERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REVOKED_OPERATION_DEADLINE = 1;
const MAX_GUEST_ADDRESSES = 16;
function guestAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !isIPv4(value)) return false;
  const first = Number(value.split('.')[0]);
  return first > 0 && first < 224 && first !== 127 && !value.startsWith('169.254.');
}
const failure = (reason: string) =>
  Object.assign(Error(`vm_lifecycle_${reason}`), { code: `vm_lifecycle_${reason}`, status: 409 });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function readFile(file: string, limit = 65536) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit)
    throw failure('invalid_identity');
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}
function jsonFile(file: string): unknown {
  return JSON.parse(readFile(file));
}
function writeFile(file: string, value: VmReceipt) {
  const temporary = path.join(path.dirname(file), `.vm-lifecycle-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
const execute = (
  command: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) =>
  new Promise<string>((resolve, reject) =>
    execFile(command, args, options, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );

/** Owns only the configured, locally managed VM. Never searches by a guessed VM name. */
export class VmLifecycle {
  readonly dataDir: string;
  readonly projectRoot: string;
  readonly platform: NodeJS.Platform;
  readonly host: HostPlatform;
  readonly vmProviders: VmProviderRegistry;
  run: NonNullable<VmLifecycleOptions['run']>;
  readonly timeoutMs: number;
  readonly file: string;
  pending: Promise<unknown> | null;
  constructor({
    dataDir,
    projectRoot = root,
    platform = process.platform,
    host = createHostPlatform({ platform }),
    run = execute,
    timeoutMs = VM_OPERATION_TIMEOUT_MS,
  }: VmLifecycleOptions = {}) {
    if (typeof dataDir !== 'string') throw failure('invalid_identity');
    this.dataDir = path.resolve(dataDir);
    this.projectRoot = projectRoot;
    this.platform = host.platform;
    this.host = host;
    this.vmProviders = createVmProviders(host);
    this.run = run;
    this.timeoutMs = timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > VM_OPERATION_TIMEOUT_MS)
      throw failure('invalid_timeout');
    this.file = path.join(this.dataDir, 'vm-lifecycle.json');
    this.pending = null;
  }
  binding(): VmIdentity | null {
    try {
      const raw = readFile(path.join(this.dataDir, 'vm.json')),
        value: unknown = JSON.parse(raw);
      if (!isRecord(value)) throw failure('invalid_identity');
      return { value, digest: hash(raw) };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw failure('invalid_identity');
    }
  }
  managed(binding: VmIdentity | null): ManagedVmProvider | false {
    if (!binding) return false;
    const vm = binding.value;
    if (
      !vm ||
      typeof vm.keyPath !== 'string' ||
      !path.isAbsolute(vm.keyPath) ||
      path.basename(vm.keyPath) !== 'vm-key'
    )
      return false;
    if (
      vm.provider === VmProviderId.Ssh ||
      (vm.provider && !includesValue([VmProviderId.HyperV, VmProviderId.VMware], vm.provider))
    )
      return false;
    try {
      const base = path.dirname(vm.keyPath);
      if (vm.provider === VmProviderId.VMware) {
        const manifest = jsonFile(path.join(base, 'manifest.json')),
          vmx = path.join(base, 'dant.vmx');
        if (
          !isRecord(manifest) ||
          manifest.owner !== 'dant-vmware-v1' ||
          manifest.provider !== VmProviderId.VMware ||
          manifest.version !== 1 ||
          manifest.id !== vm.vmwareId ||
          typeof manifest.id !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(manifest.id) ||
          typeof manifest.vmx !== 'string' ||
          typeof manifest.disk !== 'string' ||
          path.resolve(manifest.vmx) !== vmx ||
          path.resolve(manifest.disk) !== path.join(base, 'dant.vmdk') ||
          !includesValue(['created', 'starting', 'started', 'connected'], manifest.phase)
        )
          return false;
        const text = readFile(vmx, 1024 * 1024);
        return new RegExp(`^annotation\\s*=\\s*"dant-vmware-v1:${manifest.id}"\\s*$`, 'm').test(
          text,
        )
          ? VmProviderId.VMware
          : false;
      }
      const status = jsonFile(path.join(base, 'vm-setup-status.json'));
      if (
        !isRecord(status) ||
        !includesValue(['ready', 'guest-installing'], status.stage) ||
        typeof status.name !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(status.name) ||
        (vm.name && vm.name !== status.name)
      )
        return false;
      const disk = fs.lstatSync(path.join(base, 'vm', 'dant.vhdx'));
      return disk.isFile() && !disk.isSymbolicLink() ? VmProviderId.HyperV : false;
    } catch {
      return false;
    }
  }
  receipt(): VmReceipt | null {
    try {
      const value = jsonFile(this.file);
      if (
        !isRecord(value) ||
        value.version !== 1 ||
        !includesValue(
          [VmReceiptPhase.Suspending, VmReceiptPhase.Suspended, VmReceiptPhase.Resuming],
          value.phase,
        ) ||
        !includesValue([VmProviderId.HyperV, VmProviderId.VMware] as const, value.provider) ||
        typeof value.binding !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.binding) ||
        (value.vmId !== null &&
          (typeof value.vmId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.vmId))) ||
        ((value.operationId !== undefined || value.expiresAt !== undefined) &&
          (typeof value.operationId !== 'string' ||
            !OPERATION_ID.test(value.operationId) ||
            typeof value.expiresAt !== 'number' ||
            !Number.isSafeInteger(value.expiresAt) ||
            value.expiresAt <= 0))
      )
        throw Error();
      return {
        version: 1,
        phase: value.phase,
        provider: value.provider,
        binding: value.binding,
        vmId: value.vmId,
        ...(typeof value.operationId === 'string' && typeof value.expiresAt === 'number'
          ? { operationId: value.operationId, expiresAt: value.expiresAt }
          : {}),
      };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw failure('invalid_receipt');
    }
  }
  async command(
    action: 'suspend' | 'resume',
    binding: VmIdentity,
    receipt: VmReceipt,
  ): Promise<VmCommandResult> {
    if (!receipt.operationId || !receipt.expiresAt) throw failure('invalid_receipt');
    const adapter = this.vmProviders.get(receipt.provider);
    if (adapter.id === VmProviderId.Ssh || !adapter.capabilities.powerLifecycle)
      throw failure('unsupported');
    const invocation = adapter.lifecycleCommand({
      projectRoot: this.projectRoot,
      dataDir: this.dataDir,
      action,
      binding: binding.digest,
      vmId: receipt.vmId,
      operationId: receipt.operationId,
      expiresAt: receipt.expiresAt,
    });
    let value: unknown;
    try {
      const output = await this.run(invocation.command, invocation.args, {
        windowsHide: true,
        shell: false,
        timeout: this.timeoutMs,
        maxBuffer: 32768,
        encoding: 'utf8',
      });
      value = JSON.parse(String(output).replace(/^\uFEFF/, ''));
    } catch {
      throw failure('unconfirmed');
    }
    if (
      !isRecord(value) ||
      value.ok !== true ||
      value.provider !== receipt.provider ||
      typeof value.vmId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(value.vmId) ||
      (receipt.vmId && receipt.vmId.toLowerCase() !== value.vmId.toLowerCase()) ||
      !includesValue(
        [VmPowerState.Running, VmPowerState.Suspended, VmPowerState.Off],
        value.state,
      ) ||
      typeof value.changed !== 'boolean' ||
      (value.addresses !== undefined &&
        (!Array.isArray(value.addresses) ||
          value.addresses.length > MAX_GUEST_ADDRESSES ||
          !value.addresses.every(guestAddress) ||
          new Set(value.addresses).size !== value.addresses.length))
    )
      throw failure('unconfirmed');
    if (this.binding()?.digest !== binding.digest) throw failure('binding_changed');
    if (!this.currentIntent(receipt)) throw failure('intent_changed');
    return {
      ok: true,
      provider: receipt.provider,
      vmId: value.vmId,
      state: value.state,
      changed: value.changed,
      ...(Array.isArray(value.addresses) && value.addresses.every(guestAddress)
        ? { addresses: value.addresses }
        : {}),
    };
  }
  private currentIntent(receipt: VmReceipt) {
    const current = this.receipt();
    return (
      current?.operationId === receipt.operationId &&
      current?.expiresAt === receipt.expiresAt &&
      current?.binding === receipt.binding &&
      current?.phase === receipt.phase &&
      current?.provider === receipt.provider &&
      current?.vmId === receipt.vmId
    );
  }
  private intent(receipt: VmReceipt, phase: VmReceiptPhaseValue): VmReceipt {
    return { ...receipt, phase, operationId: randomUUID(), expiresAt: Date.now() + this.timeoutMs };
  }
  private async perform(action: 'suspend' | 'resume', binding: VmIdentity, receipt: VmReceipt) {
    try {
      return await this.command(action, binding, receipt);
    } catch (error) {
      // Keep uncertainty durable, but revoke this command's authorization. A UAC
      // prompt accepted after its parent timed out must not operate the VM.
      try {
        if (this.currentIntent(receipt))
          writeFile(this.file, {
            ...receipt,
            operationId: randomUUID(),
            expiresAt: REVOKED_OPERATION_DEADLINE,
          });
      } catch {
        /* An in-flight helper can still own the intent; its fixed deadline remains binding. */
      }
      throw error;
    }
  }
  exclusive<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    if (this.pending) return Promise.reject(failure('busy'));
    const pending = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
  suspend(): Promise<VmSuspendResult> {
    return this.exclusive<VmSuspendResult>(async () => {
      const binding = this.binding(),
        provider = this.managed(binding);
      if (!binding || !provider || !this.host.capabilities.managedVm)
        return { ok: true, supported: false, vmSuspended: false };
      const previous = this.receipt();
      if (previous && (previous.binding !== binding.digest || previous.provider !== provider))
        throw failure('binding_changed');
      const receipt = this.intent(
        previous || {
          version: 1,
          phase: VmReceiptPhase.Suspending,
          provider,
          binding: binding.digest,
          vmId: null,
        },
        VmReceiptPhase.Suspending,
      );
      fs.mkdirSync(this.dataDir, { recursive: true });
      writeFile(this.file, receipt);
      const result = await this.perform('suspend', binding, receipt);
      if (!includesValue([VmPowerState.Suspended, VmPowerState.Off], result.state))
        throw failure('unconfirmed');
      if (result.changed || previous)
        writeFile(this.file, { ...receipt, phase: VmReceiptPhase.Suspended, vmId: result.vmId });
      else fs.rmSync(this.file, { force: true });
      return { ok: true, supported: true, vmSuspended: true, state: result.state };
    });
  }
  private refreshEndpoint(binding: VmIdentity, result: VmCommandResult) {
    if (
      result.provider !== VmProviderId.HyperV ||
      result.state !== VmPowerState.Running ||
      result.addresses?.length !== 1 ||
      typeof binding.value.host !== 'string' ||
      result.addresses.includes(binding.value.host)
    )
      return;
    const host = result.addresses[0];
    if (!host) return;
    const file = path.join(this.dataDir, 'vm.json'),
      temporary = path.join(this.dataDir, `.vm-endpoint-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...binding.value, host }), {
        flag: 'wx',
        mode: 0o600,
      });
      renameAtomicFileSync(temporary, file, {
        renameSync: (source, destination) => {
          if (this.binding()?.digest !== binding.digest) throw failure('binding_changed');
          fs.renameSync(source, destination);
        },
      });
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  private async resumeManaged(explicit: boolean): Promise<VmResumeResult> {
    const previous = this.receipt();
    if (!previous && !explicit) return { ok: true, resumed: false };
    const binding = this.binding();
    const provider = this.managed(binding);
    if (!previous && (!binding || !provider || !this.host.capabilities.managedVm))
      return { ok: true, resumed: false };
    if (
      !binding ||
      !provider ||
      (previous && (previous.binding !== binding.digest || provider !== previous.provider)) ||
      !this.host.capabilities.managedVm
    )
      throw failure('binding_changed');
    const receipt = this.intent(
      previous || {
        version: 1,
        phase: VmReceiptPhase.Resuming,
        provider,
        binding: binding.digest,
        vmId: null,
      },
      VmReceiptPhase.Resuming,
    );
    writeFile(this.file, receipt);
    const result = await this.perform('resume', binding, receipt);
    if (result.state !== VmPowerState.Running && result.state !== VmPowerState.Off)
      throw failure('unconfirmed');
    if (this.binding()?.digest !== binding.digest) throw failure('binding_changed');
    if (!this.currentIntent(receipt)) throw failure('intent_changed');
    fs.rmSync(this.file, { force: true });
    // Power completion belongs to the old binding. Remove that exact receipt
    // before refreshing its DHCP endpoint so it cannot become a stale identity.
    this.refreshEndpoint(binding, result);
    return { ok: true, resumed: result.changed, state: result.state };
  }
  resume(): Promise<VmResumeResult> {
    return this.exclusive(() => this.resumeManaged(false));
  }
  /** Explicit Reconnect may restore an owned legacy Saved VM without a prior receipt. */
  resumeForReconnect(): Promise<VmResumeResult> {
    return this.exclusive(() => this.resumeManaged(true));
  }
}
