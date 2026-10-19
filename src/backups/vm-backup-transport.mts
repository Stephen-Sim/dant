import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ControllerBridge } from '../app/controller-types.ts';
import type { VmBinding } from '../computer/computer-types.ts';
import { ConnectionStatus } from '../contracts/states.mts';
import { isRecord } from '../contracts/json.mts';
import { serviceUpdatePaused } from '../computer/vm-service-update.mts';
import { sshArgs } from '../runtime/worker.mts';
import { BACKUP_IO_TIMEOUT_MS } from './backup-constants.mts';
import { backupError, backupId, isBackupMetadata } from './backup-validation.mts';
import type { BackupMetadata } from './backup-types.ts';
import type { BackupTarget, BackupTransport } from './controller-backups.mts';

interface Options {
  bridge: ControllerBridge;
  binding: () => VmBinding | { host?: never };
  spawnProcess?: (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;
}
const version = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/.test(value);
const digest = (binding: VmBinding) =>
  createHash('sha256').update(JSON.stringify(binding)).digest('hex');
const sourceMetadata = (value: unknown): value is Omit<BackupMetadata, 'id' | 'source'> =>
  isRecord(value) &&
  isBackupMetadata({
    ...value,
    id: '00000000-0000-4000-8000-000000000000',
    source: '000000000000',
  });
async function* responseChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield Buffer.from(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Authenticated HTTP for snapshots; offline, guarded SSH for explicit restoration. */
export class VmBackupTransport implements BackupTransport {
  readonly bridge: ControllerBridge;
  readonly binding: Options['binding'];
  readonly spawnProcess: NonNullable<Options['spawnProcess']>;
  constructor({
    bridge,
    binding,
    spawnProcess = (command, args) =>
      spawn(command, args, { shell: false, windowsHide: true, stdio: 'pipe' }),
  }: Options) {
    this.bridge = bridge;
    this.binding = binding;
    this.spawnProcess = spawnProcess;
  }
  async target(refresh = false): Promise<BackupTarget> {
    const vm = this.binding(),
      generation = this.bridge.generation ?? 0;
    if (!vm.host)
      return {
        identity: '',
        generation,
        online: false,
        supported: false,
        empty: false,
        version: null,
      };
    const identity = digest(vm);
    const state =
      refresh && this.bridge.status === ConnectionStatus.Online
        ? await this.bridge.refresh(true)
        : this.bridge.cached;
    if (
      !this.binding().host ||
      digest(vm) !== identity ||
      generation !== (this.bridge.generation ?? 0) ||
      JSON.stringify(vm) !== JSON.stringify(this.binding())
    )
      throw backupError('backup_connection_changed');
    return {
      identity,
      generation,
      online: this.bridge.status === ConnectionStatus.Online,
      supported: isRecord(state?.capabilities) && state.capabilities.backups === true,
      // An unobserved workspace is never described as an empty destination.
      empty: false,
      version:
        this.bridge.serviceUpdate?.confirmed && version(this.bridge.serviceUpdate.runningVersion)
          ? this.bridge.serviceUpdate.runningVersion
          : null,
    };
  }
  async export(signal: AbortSignal) {
    const controller = new AbortController();
    const response = await this.bridge.request('/api/backups/export', {
      signal: AbortSignal.any([signal, controller.signal]),
    });
    if (!response.ok) {
      void response.body?.cancel();
      throw backupError(
        response.status === 409
          ? 'backup_busy'
          : response.status === 404
            ? 'backup_service_update_required'
            : 'backup_failed',
      );
    }
    const encoded = response.headers.get('X-Dant-Backup-Metadata');
    if (
      !encoded ||
      encoded.length > 4096 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
      !response.body
    ) {
      controller.abort();
      void response.body?.cancel().catch(() => {});
      throw backupError('backup_invalid');
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(encoded, 'base64')),
      );
    } catch {
      controller.abort();
      throw backupError('backup_invalid');
    }
    if (!sourceMetadata(metadata)) {
      controller.abort();
      throw backupError('backup_invalid');
    }
    const stream = Readable.from(responseChunks(response.body));
    return {
      metadata,
      stream,
      close: async () => {
        controller.abort();
        stream.destroy();
      },
    };
  }
  private async ssh(
    vm: VmBinding,
    command: string,
    signal: AbortSignal,
    input?: Readable,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const child = this.spawnProcess('ssh', [...sshArgs(vm), `${vm.user}@${vm.host}`, command]);
    let output = '',
      settled = false;
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    const completion = new Promise<void>((resolve, reject) => {
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        success ? resolve() : reject(backupError('backup_restore_unconfirmed', 502, true));
      };
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (output.length + chunk.length > 4096) {
          child.kill();
          finish(false);
        } else output += chunk;
      });
      child.stderr.on('data', () => {});
    });
    try {
      if (input) await Promise.all([completion, pipeline(input, child.stdin, { signal })]);
      else {
        child.stdin.end();
        await completion;
      }
      signal.throwIfAborted();
      const result: unknown = JSON.parse(output);
      return result;
    } catch {
      child.kill();
      throw backupError('backup_restore_unconfirmed', 502, true);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async restore(input: Readable, restoreId: string, target: BackupTarget, signal: AbortSignal) {
    if (!backupId(restoreId)) throw backupError('backup_invalid');
    const vm = this.binding();
    if (
      !vm.host ||
      digest(vm) !== target.identity ||
      (this.bridge.generation ?? 0) !== target.generation
    )
      throw backupError('backup_connection_changed');
    await this.bridge.pauseWorkForUpdate({ reason: 'install' });
    const state = await this.bridge.refresh(true);
    if (
      !serviceUpdatePaused(state) ||
      JSON.stringify(vm) !== JSON.stringify(this.binding()) ||
      (this.bridge.generation ?? 0) !== target.generation
    )
      throw backupError('backup_busy');
    // restoreId is a locally generated validated UUID; no user content enters shell text.
    const command = [
      'set -eu',
      'cd "$HOME/dant/app"',
      'test -f src/backups/worker-cli.mts',
      'systemctl --user stop dant-worker.service',
      'test "$(systemctl --user is-active dant-worker.service || true)" = inactive',
      `"$HOME/dant/runtime/node/bin/node" src/backups/worker-cli.mts restore --data-dir "$HOME/dant/data" --workspace-root "$HOME/dant/workspaces" --restore-id ${restoreId} >/dev/null`,
      `"$HOME/dant/runtime/node/bin/node" src/backups/worker-cli.mts finish --data-dir "$HOME/dant/data" --workspace-root "$HOME/dant/workspaces" --restore-id ${restoreId}`,
    ].join('\n');
    const result = await this.ssh(vm, command, signal, input);
    if (!isRecord(result) || result.restored !== true || result.restoreId !== restoreId)
      throw backupError('backup_restore_unconfirmed', 502, true);
    await this.bridge.connect({ deploy: false });
  }
  async reconcile(restoreId: string, target: BackupTarget) {
    if (!backupId(restoreId)) return false;
    const vm = this.binding(),
      generation = this.bridge.generation ?? 0;
    if (!vm.host || digest(vm) !== target.identity) return false;
    const signal = AbortSignal.timeout(Math.min(BACKUP_IO_TIMEOUT_MS, 30_000));
    const loaded = async () => {
      const generation = this.bridge.generation ?? 0;
      if (this.bridge.status !== ConnectionStatus.Online) return false;
      const response = await this.bridge.request('/api/backups/info', { signal });
      if (!response.ok) return false;
      const result: unknown = await response.json();
      return (
        isRecord(result) &&
        result.restored === true &&
        result.restoreId === restoreId &&
        JSON.stringify(vm) === JSON.stringify(this.binding()) &&
        generation === (this.bridge.generation ?? 0)
      );
    };
    try {
      if (await loaded()) return true;
    } catch {
      /* A missing HTTP service can follow a confirmed offline commit. */
    }
    if (
      JSON.stringify(vm) !== JSON.stringify(this.binding()) ||
      generation !== (this.bridge.generation ?? 0)
    )
      return false;
    try {
      // finish holds the VM's kernel restore lock. It can only start the
      // service after proving this exact data commit; it never imports again.
      const command = [
        'set -eu',
        'cd "$HOME/dant/app"',
        `"$HOME/dant/runtime/node/bin/node" src/backups/worker-cli.mts finish --data-dir "$HOME/dant/data" --workspace-root "$HOME/dant/workspaces" --restore-id ${restoreId}`,
      ].join('\n');
      const result = await this.ssh(vm, command, signal);
      if (
        !isRecord(result) ||
        result.restored !== true ||
        result.restoreId !== restoreId ||
        JSON.stringify(vm) !== JSON.stringify(this.binding()) ||
        generation !== (this.bridge.generation ?? 0)
      )
        return false;
      await this.bridge.connect({ deploy: false });
      return await loaded();
    } catch {
      return false;
    }
  }
  async rejected(restoreId: string, target: BackupTarget) {
    if (!backupId(restoreId)) return false;
    const vm = this.binding(),
      generation = this.bridge.generation ?? 0;
    if (!vm.host || digest(vm) !== target.identity) return false;
    try {
      const command = [
        'set -eu',
        'cd "$HOME/dant/app"',
        `"$HOME/dant/runtime/node/bin/node" src/backups/worker-cli.mts outcome --data-dir "$HOME/dant/data" --workspace-root "$HOME/dant/workspaces" --restore-id ${restoreId}`,
      ].join('\n');
      const result = await this.ssh(vm, command, AbortSignal.timeout(30_000));
      return (
        isRecord(result) &&
        result.rejected === true &&
        result.restoreId === restoreId &&
        JSON.stringify(vm) === JSON.stringify(this.binding()) &&
        generation === (this.bridge.generation ?? 0)
      );
    } catch {
      return false;
    }
  }
}
