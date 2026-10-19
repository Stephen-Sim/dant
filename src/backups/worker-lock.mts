import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { errorCode, isRecord } from '../contracts/json.mts';
import { HostPlatformId } from '../contracts/states.mts';
import { ordinaryDirectory } from '../files/managed-path.mts';
import { backupError } from './archive-stream.mts';
import type { WorkerRestoreOwnerLock } from './worker-restore.mts';

const KERNEL_LOCK_CHILD_FD = 3;
const KERNEL_LOCK_BUSY_EXIT = 79;
const KERNEL_LOCK_TIMEOUT_MS = 5_000;
const OWNER_FILE_MAX_BYTES = 16 * 1024;
const RESTORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface FlockOptions {
  stdio: ['ignore', 'ignore', 'ignore', number];
  shell: false;
  windowsHide: true;
  timeout: number;
}
type FlockRunner = (
  command: string,
  args: readonly string[],
  options: FlockOptions,
) => { status: number | null; error?: unknown };
export interface WorkerRestoreKernelLockOptions {
  dataDir: string;
  workspaceRoot: string;
  platform?: NodeJS.Platform;
  runFlock?: FlockRunner;
}
const unavailable = () =>
  Object.assign(Error('Kernel locking for work computer restoration is unavailable.'), {
    code: 'restore_lock_unavailable',
    status: 503,
  });
const same = (left: fs.BigIntStats, right: fs.BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino;
function ordinaryFile(file: string) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw backupError('restore_failed');
  return stat;
}
function paths(dataDir: string, workspaceRoot: string) {
  const data = path.resolve(dataDir),
    workspace = path.resolve(workspaceRoot);
  const within = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    );
  };
  if (
    path.parse(data).root === data ||
    path.parse(workspace).root === workspace ||
    within(data, workspace) ||
    within(workspace, data)
  )
    throw backupError('restore_failed');
  const parent = ordinaryDirectory(path.dirname(data));
  ordinaryDirectory(path.dirname(workspace));
  const pair = createHash('sha256')
    .update(data)
    .update('\0')
    .update(workspace)
    .digest('hex')
    .slice(0, 24);
  return {
    parent,
    kernel: path.join(parent, '.dant-restore-' + pair + '.flock'),
    owner: path.join(parent, '.dant-restore-' + pair + '.lock'),
  };
}

/**
 * Linux flock(2) locks the shared open-file description. The inherited fd 3
 * acquires it in util-linux; this parent's fd retains it after that child exits.
 * https://man7.org/linux/man-pages/man2/flock.2.html
 * The persistent lock inode must never be unlinked to reclaim a dead process.
 */
export async function withWorkerRestoreLock<Value>(
  {
    dataDir,
    workspaceRoot,
    platform = process.platform,
    runFlock = spawnSync,
  }: WorkerRestoreKernelLockOptions,
  operation: (ownerLock: WorkerRestoreOwnerLock) => Value | Promise<Value>,
): Promise<Value> {
  if (platform !== HostPlatformId.Linux) throw unavailable();
  const locations = paths(dataDir, workspaceRoot);
  const parentIdentity = fs.lstatSync(locations.parent, { bigint: true });
  const fd = fs.openSync(
    locations.kernel,
    fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  let held = false;
  const releases = new Set<() => void>();
  try {
    const kernelIdentity = ordinaryFile(locations.kernel);
    if (!same(kernelIdentity, fs.fstatSync(fd, { bigint: true })))
      throw backupError('restore_failed');
    let result: ReturnType<FlockRunner>;
    try {
      result = runFlock(
        'flock',
        ['-n', '-E', String(KERNEL_LOCK_BUSY_EXIT), String(KERNEL_LOCK_CHILD_FD)],
        {
          stdio: ['ignore', 'ignore', 'ignore', fd],
          shell: false,
          windowsHide: true,
          timeout: KERNEL_LOCK_TIMEOUT_MS,
        },
      );
    } catch {
      throw unavailable();
    }
    if (result.error || result.status !== 0) {
      if (!result.error && result.status === KERNEL_LOCK_BUSY_EXIT)
        throw backupError('backup_busy');
      throw unavailable();
    }
    held = true;
    const current = () => {
      if (!held) throw backupError('restore_failed');
      ordinaryDirectory(locations.parent);
      if (
        !same(parentIdentity, fs.lstatSync(locations.parent, { bigint: true })) ||
        !same(kernelIdentity, ordinaryFile(locations.kernel)) ||
        !same(kernelIdentity, fs.fstatSync(fd, { bigint: true }))
      )
        throw backupError('restore_failed');
    };
    current();
    const ownerLock: WorkerRestoreOwnerLock = {
      acquire(file, restoreId) {
        current();
        if (file !== locations.owner || !RESTORE_ID.test(restoreId))
          throw backupError('restore_failed');
        const previous = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
        if (previous) {
          ordinaryFile(file);
          if (previous.size > BigInt(OWNER_FILE_MAX_BYTES)) throw backupError('restore_failed');
          const input = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          try {
            if (!same(previous, fs.fstatSync(input, { bigint: true })))
              throw backupError('restore_failed');
            const value: unknown = JSON.parse(fs.readFileSync(input, 'utf8'));
            if (
              !isRecord(value) ||
              typeof value.pid !== 'number' ||
              !Number.isSafeInteger(value.pid) ||
              value.pid <= 0
            )
              throw backupError('restore_failed');
            try {
              process.kill(value.pid, 0);
              throw backupError('backup_busy');
            } catch (error) {
              if (errorCode(error) !== 'ESRCH') throw error;
            }
          } finally {
            fs.closeSync(input);
          }
          current();
          if (!same(previous, ordinaryFile(file))) throw backupError('restore_failed');
          // Kernel ownership serializes all cooperating reclaimers. A live
          // legacy owner above is still refused even if it predates flock.
          fs.unlinkSync(file);
        }
        const owner = fs.openSync(file, 'wx', 0o600);
        let ownerIdentity: fs.BigIntStats;
        try {
          fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, restoreId }));
          fs.fsyncSync(owner);
          ownerIdentity = fs.fstatSync(owner, { bigint: true });
        } finally {
          fs.closeSync(owner);
        }
        let released = false;
        const release = () => {
          if (released) return;
          current();
          if (!same(ownerIdentity, ordinaryFile(file))) throw backupError('restore_failed');
          fs.unlinkSync(file);
          released = true;
          releases.delete(release);
        };
        releases.add(release);
        return release;
      },
    };
    return await operation(ownerLock);
  } finally {
    try {
      for (const release of releases) release();
    } finally {
      held = false;
      fs.closeSync(fd);
    }
  }
}
