import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { BackupMode, BackupPhase } from '../contracts/states.mts';
import type { BackupPhaseValue } from '../contracts/states.mts';
import { isRecord, errorCode } from '../contracts/json.mts';
import { ordinaryDirectory } from '../files/managed-path.mts';
import { createHostPlatform } from '../platform/host-platform.mts';
import type { HostSecretProtection } from '../platform/host-types.ts';
import { LocalBackupVault } from './local-backup-vault.mts';
import { PortableBackup } from './portable-backup.mts';
import {
  backupError,
  backupSettings,
  defaultBackupSettings,
  backupId,
} from './backup-validation.mts';
import {
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_ERROR_CODES,
  BACKUP_IO_TIMEOUT_MS,
  BACKUP_PREVIEW_TTL_MS,
  BACKUP_RETRY_DELAY_MS,
} from './backup-constants.mts';
import type {
  BackupMetadata,
  BackupPreview,
  BackupSettings,
  BackupStatus,
} from './backup-types.ts';

export interface BackupTarget {
  /** Full binding hash and fresh connection generation; never serialized to the UI. */
  identity: string;
  generation: number;
  online: boolean;
  supported: boolean;
  empty: boolean;
  version: string | null;
}
export interface BackupTransport {
  target(refresh?: boolean): Promise<BackupTarget>;
  export(signal: AbortSignal): Promise<{
    metadata: Omit<BackupMetadata, 'id' | 'source'>;
    stream: Readable;
    close(): Promise<void>;
  }>;
  restore(
    input: Readable,
    restoreId: string,
    target: BackupTarget,
    signal: AbortSignal,
  ): Promise<void>;
  reconcile(restoreId: string, target: BackupTarget): Promise<boolean>;
  rejected(restoreId: string, target: BackupTarget): Promise<boolean>;
}
interface RestoreReceipt {
  backupId: string;
  restoreId: string;
  target: string;
  createdAt: number;
}
interface Options {
  dataDir: string;
  transport: BackupTransport;
  protection?: HostSecretProtection;
  allowed?: () => boolean;
  now?: () => number;
  changed?: () => void;
  automatic?: boolean;
}
const safeError = (error: unknown) => {
  const code = errorCode(error);
  if (BACKUP_ERROR_CODES.some((allowed) => allowed === code)) return code ?? 'backup_failed';
  if (code === 'source_changed') return 'backup_source_changed';
  return 'backup_failed';
};
function readObject(file: string): unknown {
  ordinaryDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024)
    throw backupError('backup_invalid');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeObject(file: string, value: unknown) {
  ordinaryDirectory(path.dirname(file));
  const current = fs.lstatSync(file, { throwIfNoEntry: false });
  if (current && (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1))
    throw backupError('backup_invalid');
  const temporary = path.join(path.dirname(file), `.backup-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
/** Local scheduling and storage only. The VM remains the execution authority. */
export class ControllerBackups {
  readonly vault: LocalBackupVault;
  readonly transport: BackupTransport;
  readonly allowed: () => boolean;
  readonly now: () => number;
  readonly notify: () => void;
  readonly settingsFile: string;
  readonly receiptFile: string;
  settings: BackupSettings;
  phase: BackupPhaseValue = BackupPhase.Idle;
  lastError: string | null = null;
  lastRestoredId: string | null = null;
  pending: Promise<void> | null = null;
  private target: BackupTarget | null = null;
  private closed = false;
  private enabled = false;
  private retryAt = 0;
  private scheduleSince: number;
  private connection: string | null = null;
  private connectedDue = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | null = null;
  private preview: { value: BackupPreview; target: BackupTarget } | null = null;
  private receipt: RestoreReceipt | null = null;
  constructor({
    dataDir,
    transport,
    protection,
    allowed = () => true,
    now = Date.now,
    changed = () => {},
    automatic = true,
  }: Options) {
    ordinaryDirectory(path.resolve(dataDir), { create: true });
    this.vault = new LocalBackupVault(dataDir, protection ?? createHostPlatform().secretProtection);
    this.transport = transport;
    this.allowed = allowed;
    this.now = now;
    this.notify = changed;
    this.scheduleSince = this.now();
    this.settingsFile = path.join(dataDir, 'backup-settings.json');
    this.receiptFile = path.join(dataDir, 'backup-restore.json');
    this.settings = defaultBackupSettings();
    try {
      this.settings = backupSettings(readObject(this.settingsFile));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        this.settings.mode = BackupMode.Manual;
        this.lastError = 'backup_settings_invalid';
      }
    }
    try {
      const receipt = readObject(this.receiptFile);
      if (
        !isRecord(receipt) ||
        !backupId(receipt.backupId) ||
        !backupId(receipt.restoreId) ||
        typeof receipt.target !== 'string' ||
        !/^[0-9a-f]{64}$/.test(receipt.target) ||
        typeof receipt.createdAt !== 'number' ||
        !Number.isSafeInteger(receipt.createdAt)
      )
        throw backupError('backup_restore_unconfirmed');
      this.receipt = {
        backupId: receipt.backupId,
        restoreId: receipt.restoreId,
        target: receipt.target,
        createdAt: receipt.createdAt,
      };
      this.phase = BackupPhase.Unknown;
      this.lastError = 'backup_restore_unconfirmed';
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        this.phase = BackupPhase.Unknown;
        this.lastError = 'backup_restore_unconfirmed';
      }
    }
    this.enabled = automatic;
  }
  get busy() {
    return this.pending !== null || this.phase === BackupPhase.Unknown;
  }
  private assertAvailable(target: BackupTarget) {
    if (this.closed || !this.allowed()) throw backupError('backup_busy');
    if (!target.online) throw backupError('backup_offline', 503);
    if (!target.supported) throw backupError('backup_service_update_required');
    if (!this.vault.protection) throw backupError('backup_protection_unavailable');
    if (!/^[0-9a-f]{64}$/.test(target.identity)) throw backupError('backup_connection_changed');
  }
  private same(left: BackupTarget, right: BackupTarget) {
    return left.identity === right.identity && left.generation === right.generation && right.online;
  }
  private metadata() {
    return this.vault.list();
  }
  async status(): Promise<BackupStatus> {
    this.target = await this.transport.target();
    let backups: BackupMetadata[] = [];
    try {
      const result = this.vault.listResult();
      backups = result.backups;
      if (result.invalidCount && this.lastError === null) this.lastError = 'backup_invalid';
    } catch {
      this.lastError = 'backup_invalid';
    }
    const target = this.target;
    const latest = backups.find((entry) => entry.source === target.identity.slice(0, 12));
    return {
      settings: { ...this.settings },
      availability: {
        online: target.online,
        supported: target.supported && !!this.vault.protection,
        ...(!this.vault.protection
          ? { reason: 'backup_protection_unavailable' }
          : !target.online
            ? { reason: 'backup_offline' }
            : !target.supported
              ? { reason: 'backup_service_update_required' }
              : {}),
      },
      backups,
      phase: this.phase,
      lastBackupAt: latest?.createdAt ?? null,
      lastError: this.lastError,
      lastRestoredId: this.lastRestoredId,
      nextAt:
        this.settings.mode === BackupMode.Automatic
          ? Math.max(
              this.retryAt,
              (latest?.createdAt ?? this.scheduleSince) + this.settings.intervalMinutes * 60_000,
            )
          : null,
    };
  }
  configure(input: unknown) {
    if (this.closed || this.pending) throw backupError('backup_running');
    const next = backupSettings(input, this.settings);
    writeObject(this.settingsFile, next);
    this.settings = next;
    this.preview = null;
    this.retryAt = 0;
    this.scheduleSince = this.now();
    this.changed();
  }
  private start(
    phase: BackupPhaseValue,
    operation: (signal: AbortSignal) => Promise<void>,
    propagate = false,
  ) {
    if (this.closed || this.busy || !this.allowed())
      throw backupError(
        this.phase === BackupPhase.Unknown ? 'backup_restore_unconfirmed' : 'backup_running',
      );
    this.abort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(BACKUP_IO_TIMEOUT_MS)]);
    this.phase = phase;
    this.lastError = null;
    this.preview = null;
    const pending = Promise.resolve()
      .then(() => operation(signal))
      .then(() => {
        if (this.lastError !== 'backup_restore_rejected') {
          this.phase = BackupPhase.Idle;
          this.lastError = null;
        }
        this.retryAt = 0;
      })
      .catch((error: unknown) => {
        this.phase = this.receipt ? BackupPhase.Unknown : BackupPhase.Failed;
        this.lastError = this.receipt ? 'backup_restore_unconfirmed' : safeError(error);
        this.retryAt = this.now() + BACKUP_RETRY_DELAY_MS;
        if (propagate) throw error;
      })
      .finally(() => {
        if (this.pending === pending) {
          this.pending = null;
          this.abort = null;
        }
        this.notify();
        this.changed();
      });
    this.pending = pending;
    this.notify();
    return pending;
  }
  async exportPortable(id: string, passphrase: string, output: Writable) {
    await this.start(
      BackupPhase.BackingUp,
      async (signal) => {
        await new PortableBackup(path.dirname(this.vault.directory)).export({
          vault: this.vault,
          id,
          passphrase,
          output,
          signal,
        });
      },
      true,
    );
  }
  async importPortable(input: Readable, passphrase: string): Promise<BackupMetadata> {
    let result: BackupMetadata | undefined;
    await this.start(
      BackupPhase.BackingUp,
      async (signal) => {
        result = await new PortableBackup(path.dirname(this.vault.directory)).import({
          vault: this.vault,
          input,
          passphrase,
          signal,
        });
      },
      true,
    );
    if (!result) throw backupError('backup_invalid');
    return result;
  }
  run() {
    this.start(BackupPhase.BackingUp, async (signal) => {
      const target = await this.transport.target(true);
      this.assertAvailable(target);
      const source = await this.transport.export(signal);
      try {
        if (!this.same(target, await this.transport.target()))
          throw backupError('backup_connection_changed');
        await this.vault.save(
          source.stream,
          { ...source.metadata, id: randomUUID(), source: target.identity.slice(0, 12) },
          signal,
        );
        // A completed archive belongs to its captured source even if the user disconnected.
        this.vault.retain(this.settings.retainCount);
        this.connectedDue = false;
      } finally {
        await source.close();
      }
    });
  }
  async previewRestore(id: string): Promise<BackupPreview> {
    if (this.busy) throw backupError('backup_running');
    const target = await this.transport.target(true);
    this.assertAvailable(target);
    const backup = this.vault.readHeader(id).value.metadata;
    const value: BackupPreview = {
      backup,
      confirmation: randomUUID(),
      expiresAt: this.now() + BACKUP_PREVIEW_TTL_MS,
      target: { id: target.identity.slice(0, 12), empty: target.empty },
      warnings: [
        ...(!target.empty ? ['replaces-current-data' as const] : []),
        ...(backup.source !== target.identity.slice(0, 12) ? ['different-computer' as const] : []),
        ...(backup.appVersion !== target.version ? ['service-version-differs' as const] : []),
        'tasks-remain-paused',
        'sign-in-required',
      ],
    };
    this.preview = { value, target };
    return value;
  }
  restore(id: string, confirmation: unknown) {
    const preview = this.preview;
    this.preview = null;
    if (
      !preview ||
      preview.value.backup.id !== id ||
      confirmation !== preview.value.confirmation ||
      preview.value.expiresAt <= this.now()
    )
      throw backupError('backup_preview_expired');
    this.start(BackupPhase.Restoring, async (signal) => {
      const target = await this.transport.target(true);
      this.assertAvailable(target);
      if (!this.same(preview.target, target)) throw backupError('backup_connection_changed');
      const opened = await this.vault.open(id, signal);
      try {
        // Reserve before the first pause/SSH operation; restarts may only reconcile.
        const receipt: RestoreReceipt = {
          backupId: id,
          restoreId: randomUUID(),
          target: target.identity,
          createdAt: this.now(),
        };
        writeObject(this.receiptFile, receipt);
        this.receipt = receipt;
        try {
          await this.transport.restore(opened.stream(), receipt.restoreId, target, signal);
        } catch (error) {
          if (await this.transport.rejected(receipt.restoreId, target)) {
            this.rejectRestore(receipt);
            return;
          }
          throw error;
        }
        if (await this.transport.reconcile(receipt.restoreId, target)) this.confirmRestore(receipt);
        else if (await this.transport.rejected(receipt.restoreId, target))
          this.rejectRestore(receipt);
        else throw backupError('backup_restore_unconfirmed', 502, true);
      } finally {
        await opened.close();
      }
    });
  }
  private confirmRestore(receipt: RestoreReceipt) {
    if (this.receipt?.restoreId !== receipt.restoreId)
      throw backupError('backup_restore_unconfirmed');
    // Only the exact durable receipt checked by this operation may be removed.
    const disk = readObject(this.receiptFile);
    if (!isRecord(disk) || disk.restoreId !== receipt.restoreId || disk.target !== receipt.target)
      throw backupError('backup_restore_unconfirmed');
    fs.unlinkSync(this.receiptFile);
    this.receipt = null;
    this.lastRestoredId = receipt.backupId;
    this.phase = BackupPhase.Idle;
    this.lastError = null;
  }
  private rejectRestore(receipt: RestoreReceipt) {
    if (this.receipt?.restoreId !== receipt.restoreId)
      throw backupError('backup_restore_unconfirmed');
    const disk = readObject(this.receiptFile);
    if (!isRecord(disk) || disk.restoreId !== receipt.restoreId || disk.target !== receipt.target)
      throw backupError('backup_restore_unconfirmed');
    fs.unlinkSync(this.receiptFile);
    this.receipt = null;
    this.phase = BackupPhase.Failed;
    this.lastError = 'backup_restore_rejected';
  }
  async beforeVmChange() {
    if (this.settings.mode !== BackupMode.Automatic || !this.settings.beforeVmChange) return;
    const target = await this.transport.target();
    if (!/^[0-9a-f]{64}$/.test(target.identity)) return;
    // First request starts the backup; retrying the explicit connection change
    // after success never leaves a long-running mutation queued behind the UI.
    const latest = this.metadata().find((entry) => entry.source === target.identity.slice(0, 12));
    if (latest && this.now() - latest.createdAt < BACKUP_PREVIEW_TTL_MS && !this.busy) return;
    if (!this.busy) this.run();
    throw backupError('backup_before_vm_change_required');
  }
  changed() {
    if (this.closed || !this.enabled || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, BACKUP_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }
  async tick() {
    if (this.closed || !this.enabled || this.pending) return;
    try {
      const target = await this.transport.target();
      const connection = target.online ? `${target.identity}:${target.generation}` : null;
      if (connection !== this.connection) {
        this.connection = connection;
        this.connectedDue = !!connection;
        this.scheduleSince = this.now();
      }
      if (this.phase === BackupPhase.Unknown) {
        const receipt = this.receipt;
        if (receipt && receipt.target === target.identity && this.now() >= this.retryAt) {
          this.retryAt = this.now() + BACKUP_RETRY_DELAY_MS;
          if (await this.transport.reconcile(receipt.restoreId, target))
            this.confirmRestore(receipt);
          else if (await this.transport.rejected(receipt.restoreId, target))
            this.rejectRestore(receipt);
        }
        return;
      }
      if (
        this.settings.mode !== BackupMode.Automatic ||
        !this.allowed() ||
        this.now() < this.retryAt ||
        !target.online ||
        !target.supported ||
        !this.vault.protection
      )
        return;
      const latest = this.metadata().find((entry) => entry.source === target.identity.slice(0, 12));
      const due =
        this.now() - (latest?.createdAt ?? this.scheduleSince) >=
        this.settings.intervalMinutes * 60_000;
      const connected =
        this.connectedDue &&
        this.settings.onConnect &&
        (!latest || this.now() - latest.createdAt >= BACKUP_PREVIEW_TTL_MS);
      if (due || connected) this.run();
    } catch {
      this.retryAt = this.now() + BACKUP_RETRY_DELAY_MS;
    } finally {
      this.changed();
    }
  }
  close() {
    this.closed = true;
    this.enabled = false;
    this.preview = null;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
  }
}
