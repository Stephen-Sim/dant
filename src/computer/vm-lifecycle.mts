import { isRecord, errorCode, includesValue } from '../contracts/json.mts';
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
}
interface VmCommandResult {
  ok: true;
  provider: ManagedVmProvider;
  vmId: string;
  state: VmPowerStateValue;
  changed: boolean;
}
export type VmSuspendResult =
  | { ok: true; supported: false; vmSuspended: false }
  | { ok: true; supported: true; vmSuspended: true; state: VmPowerStateValue };
export interface VmLifecycleOptions {
  dataDir?: string;
  projectRoot?: string;
  platform?: NodeJS.Platform;
  run?: (
    command: string,
    args: readonly string[],
    options: ExecFileOptionsWithStringEncoding,
  ) => Promise<string>;
  timeoutMs?: number;
}
import { VM_OPERATION_TIMEOUT_MS } from '../config/limits.mts';
import { VmPowerState, VmReceiptPhase } from '../contracts/states.mts';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
  run: NonNullable<VmLifecycleOptions['run']>;
  readonly timeoutMs: number;
  readonly file: string;
  pending: Promise<unknown> | null;
  constructor({
    dataDir,
    projectRoot = root,
    platform = process.platform,
    run = execute,
    timeoutMs = VM_OPERATION_TIMEOUT_MS,
  }: VmLifecycleOptions = {}) {
    if (typeof dataDir !== 'string') throw failure('invalid_identity');
    this.dataDir = path.resolve(dataDir);
    this.projectRoot = projectRoot;
    this.platform = platform;
    this.run = run;
    this.timeoutMs = timeoutMs;
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
    if (vm.provider === 'ssh' || (vm.provider && !includesValue(['hyperv', 'vmware'], vm.provider)))
      return false;
    try {
      const base = path.dirname(vm.keyPath);
      if (vm.provider === 'vmware') {
        const manifest = jsonFile(path.join(base, 'manifest.json')),
          vmx = path.join(base, 'dant.vmx');
        if (
          !isRecord(manifest) ||
          manifest.owner !== 'dant-vmware-v1' ||
          manifest.provider !== 'vmware' ||
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
          ? 'vmware'
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
      return disk.isFile() && !disk.isSymbolicLink() ? 'hyperv' : false;
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
        !includesValue([VmReceiptPhase.Suspending, VmReceiptPhase.Suspended], value.phase) ||
        !includesValue(['hyperv', 'vmware'] as const, value.provider) ||
        typeof value.binding !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.binding) ||
        (value.vmId !== null &&
          (typeof value.vmId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.vmId)))
      )
        throw Error();
      return {
        version: 1,
        phase: value.phase,
        provider: value.provider,
        binding: value.binding,
        vmId: value.vmId,
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
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(this.projectRoot, 'scripts', 'vm-lifecycle.ps1'),
      '-Action',
      action,
      '-DataDirectory',
      this.dataDir,
      '-ExpectedBinding',
      binding.digest,
    ];
    if (receipt.vmId) args.push('-ExpectedVmId', receipt.vmId);
    let value: unknown;
    try {
      const output = await this.run('powershell.exe', args, {
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
      typeof value.changed !== 'boolean'
    )
      throw failure('unconfirmed');
    if (this.binding()?.digest !== binding.digest) throw failure('binding_changed');
    return {
      ok: true,
      provider: receipt.provider,
      vmId: value.vmId,
      state: value.state,
      changed: value.changed,
    };
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
      if (!binding || !provider || this.platform !== 'win32')
        return { ok: true, supported: false, vmSuspended: false };
      const previous = this.receipt();
      if (previous && previous.binding !== binding.digest) throw failure('binding_changed');
      const receipt: VmReceipt = previous || {
        version: 1,
        phase: VmReceiptPhase.Suspending,
        provider,
        binding: binding.digest,
        vmId: null,
      };
      fs.mkdirSync(this.dataDir, { recursive: true });
      writeFile(this.file, receipt);
      const result = await this.command('suspend', binding, receipt);
      if (!includesValue([VmPowerState.Suspended, VmPowerState.Off], result.state))
        throw failure('unconfirmed');
      if (result.changed || previous)
        writeFile(this.file, { ...receipt, phase: VmReceiptPhase.Suspended, vmId: result.vmId });
      else fs.rmSync(this.file, { force: true });
      return { ok: true, supported: true, vmSuspended: true, state: result.state };
    });
  }
  resume() {
    return this.exclusive(async () => {
      const receipt = this.receipt();
      if (!receipt) return { ok: true, resumed: false };
      const binding = this.binding();
      if (
        !binding ||
        receipt.binding !== binding.digest ||
        this.managed(binding) !== receipt.provider ||
        this.platform !== 'win32'
      )
        throw failure('binding_changed');
      const result = await this.command('resume', binding, receipt);
      if (result.state !== VmPowerState.Running && result.state !== VmPowerState.Off)
        throw failure('unconfirmed');
      fs.rmSync(this.file, { force: true });
      return { ok: true, resumed: result.changed, state: result.state };
    });
  }
}
