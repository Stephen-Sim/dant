import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isRecord, errorCode } from '../contracts/json.mts';
import { WorkerRestorePhase, isEnumValue } from '../contracts/states.mts';
import type { WorkerRestorePhaseValue } from '../contracts/states.mts';
import { ordinaryDirectory } from '../files/managed-path.mts';
import { backupError, validateWorkerBackup } from './archive-stream.mts';
import { prepareRestoredWorkerState } from './worker-state.mts';
import { renamePrivateStagingDirectorySync } from './staging-directory-rename.mts';

export const WORKER_RESTORE_RECEIPT_FILE = '.dant-restore-receipt.json';
const JOURNAL_MAX_BYTES = 16 * 1024;
const RESTORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Identity = { dev: string; ino: string };
interface RestoreJournal {
  restoreId: string;
  phase: WorkerRestorePhaseValue;
  data: Identity;
  workspace: Identity;
}
export interface WorkerRestoreOptions {
  dataDir: string;
  workspaceRoot: string;
  restoreId: string;
  assertOffline(): void;
  rename?: (from: string, to: string) => void;
  ownerLock?: WorkerRestoreOwnerLock;
}
export interface WorkerRestoreOwnerLock {
  acquire(file: string, restoreId: string): () => void;
}
const identity = (stat: fs.BigIntStats): Identity => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
});
const matches = (stat: fs.BigIntStats, wanted: Identity) =>
  String(stat.dev) === wanted.dev && String(stat.ino) === wanted.ino;
const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
};
function syncDirectory(directory: string) {
  // The offline CLI runs on Linux; Windows does not expose fsync on directory handles.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function durableRename(
  from: string,
  to: string,
  operation: (from: string, to: string) => void = fs.renameSync,
) {
  operation(from, to);
  syncDirectory(path.dirname(from));
  if (path.dirname(from) !== path.dirname(to)) syncDirectory(path.dirname(to));
}
function flushTree(directory: string) {
  ordinaryDirectory(directory);
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name),
      before = fs.lstatSync(file, { bigint: true });
    if (before.isSymbolicLink()) throw backupError('restore_failed');
    if (before.isDirectory()) flushTree(file);
    else {
      if (!before.isFile() || before.nlink !== 1n) throw backupError('restore_failed');
      const fd = fs.openSync(file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
      try {
        if (!matches(fs.fstatSync(fd, { bigint: true }), identity(before)))
          throw backupError('restore_failed');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  syncDirectory(directory);
}
function roots(options: Pick<WorkerRestoreOptions, 'dataDir' | 'workspaceRoot' | 'restoreId'>) {
  if (!RESTORE_ID.test(options.restoreId)) throw backupError('invalid_backup');
  const data = path.resolve(options.dataDir),
    workspace = path.resolve(options.workspaceRoot);
  if (
    path.parse(data).root === data ||
    path.parse(workspace).root === workspace ||
    within(data, workspace) ||
    within(workspace, data)
  )
    throw backupError('invalid_backup');
  const dataParent = ordinaryDirectory(path.dirname(data)),
    workspaceParent = ordinaryDirectory(path.dirname(workspace)),
    pair = createHash('sha256')
      .update(data)
      .update('\0')
      .update(workspace)
      .digest('hex')
      .slice(0, 24),
    prefix = '.dant-restore-' + options.restoreId;
  return {
    data,
    workspace,
    dataParent,
    workspaceParent,
    journal: path.join(dataParent, '.dant-restore-' + pair + '.json'),
    lock: path.join(dataParent, '.dant-restore-' + pair + '.lock'),
    rejection: path.join(dataParent, '.dant-restore-' + pair + '.rejected.json'),
    dataNew: path.join(dataParent, prefix + '-data.new'),
    workspaceNew: path.join(workspaceParent, prefix + '-workspace.new'),
    dataPrevious: path.join(dataParent, prefix + '-data.previous'),
    workspacePrevious: path.join(workspaceParent, prefix + '-workspace.previous'),
    dataFailed: path.join(dataParent, prefix + '-data.failed'),
    workspaceFailed: path.join(workspaceParent, prefix + '-workspace.failed'),
  };
}
function readObject(file: string): Record<string, unknown> {
  const before = fs.lstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(JOURNAL_MAX_BYTES)
  )
    throw backupError('restore_failed');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!matches(fs.fstatSync(fd, { bigint: true }), identity(before)))
      throw backupError('restore_failed');
    const value: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!isRecord(value)) throw backupError('restore_failed');
    return value;
  } finally {
    fs.closeSync(fd);
  }
}
function atomicJson(file: string, value: unknown) {
  const temporary = file + '.tmp';
  if (fs.existsSync(temporary)) throw backupError('restore_failed');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  durableRename(temporary, file);
}
/** Only the live journal is authority. An interrupted temporary write never proves commit. */
function discardJournalTemporary(file: string) {
  const temporary = file + '.tmp',
    before = fs.lstatSync(temporary, { throwIfNoEntry: false, bigint: true });
  if (!before) return;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(JOURNAL_MAX_BYTES)
  )
    throw backupError('restore_failed');
  const fd = fs.openSync(temporary, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (
      !matches(fs.fstatSync(fd, { bigint: true }), identity(before)) ||
      !matches(fs.lstatSync(temporary, { bigint: true }), identity(before))
    )
      throw backupError('restore_failed');
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(temporary);
  syncDirectory(path.dirname(file));
}
function isIdentity(value: unknown): value is Identity {
  return (
    isRecord(value) &&
    typeof value.dev === 'string' &&
    /^[0-9]{1,40}$/.test(value.dev) &&
    typeof value.ino === 'string' &&
    /^[0-9]{1,40}$/.test(value.ino)
  );
}
function readJournal(file: string): RestoreJournal | null {
  if (!fs.existsSync(file)) return null;
  const value = readObject(file);
  if (
    typeof value.restoreId !== 'string' ||
    !RESTORE_ID.test(value.restoreId) ||
    !isEnumValue(WorkerRestorePhase, value.phase) ||
    !isIdentity(value.data) ||
    !isIdentity(value.workspace)
  )
    throw backupError('restore_failed');
  return {
    restoreId: value.restoreId,
    phase: value.phase,
    data: value.data,
    workspace: value.workspace,
  };
}
function removeDirectory(file: string) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw backupError('restore_failed');
  fs.rmSync(file, { recursive: true, force: true });
}
function acquireLock(file: string, restoreId: string) {
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, restoreId }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    // Reclaiming a stale PID file is unsafe without an independently held kernel lock.
    throw backupError('backup_busy');
  }
  return () => fs.unlinkSync(file);
}
function recoverPending(options: WorkerRestoreOptions, journal: RestoreJournal) {
  const locations = roots({ ...options, restoreId: journal.restoreId }),
    rename = (from: string, to: string) => durableRename(from, to, options.rename);
  if (journal.phase !== WorkerRestorePhase.Committed) {
    atomicJson(locations.journal, { ...journal, phase: WorkerRestorePhase.RollingBack });
    for (const [live, previous, failed, wanted] of [
      [
        locations.workspace,
        locations.workspacePrevious,
        locations.workspaceFailed,
        journal.workspace,
      ],
      [locations.data, locations.dataPrevious, locations.dataFailed, journal.data],
    ] as const) {
      const old = fs.lstatSync(previous, { throwIfNoEntry: false, bigint: true });
      if (old) {
        if (!old.isDirectory() || old.isSymbolicLink() || !matches(old, wanted))
          throw backupError('restore_failed');
        const current = fs.lstatSync(live, { throwIfNoEntry: false, bigint: true });
        if (current) {
          if (!current.isDirectory() || current.isSymbolicLink())
            throw backupError('restore_failed');
          rename(live, failed);
        }
        rename(previous, live);
      } else {
        const current = fs.lstatSync(live, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || !matches(current, wanted))
          throw backupError('restore_failed');
      }
    }
  }
  for (const file of [
    locations.dataNew,
    locations.workspaceNew,
    locations.dataPrevious,
    locations.workspacePrevious,
    locations.dataFailed,
    locations.workspaceFailed,
  ])
    removeDirectory(file);
  fs.unlinkSync(locations.journal);
}
/** Explicit offline reconciliation rolls back an interrupted uncommitted swap; it never replays input. */
export function recoverWorkerRestore(options: WorkerRestoreOptions) {
  options.assertOffline();
  const locations = roots(options);
  const release = options.ownerLock
    ? options.ownerLock.acquire(locations.lock, options.restoreId)
    : acquireLock(locations.lock, options.restoreId);
  try {
    discardJournalTemporary(locations.journal);
    const journal = readJournal(locations.journal);
    if (journal) recoverPending(options, journal);
  } finally {
    release();
  }
  return inspectWorkerRestore(options);
}
export function inspectWorkerRestore(
  options: Pick<WorkerRestoreOptions, 'dataDir' | 'workspaceRoot' | 'restoreId'>,
) {
  const locations = roots(options),
    pending = readJournal(locations.journal);
  if (pending && pending.phase !== WorkerRestorePhase.Committed)
    throw backupError('restore_failed');
  const file = path.join(locations.data, WORKER_RESTORE_RECEIPT_FILE);
  if (!fs.existsSync(file)) return { restored: false, restoreId: options.restoreId };
  const receipt = readObject(file);
  return {
    restored: receipt.restored === true && receipt.restoreId === options.restoreId,
    restoreId: options.restoreId,
  };
}
/** Read only a durable failure witness written outside both restored roots.
 * No missing receipt, CLI exit code or unfinished journal proves rejection. */
export function inspectWorkerRestoreRejection(
  options: Pick<WorkerRestoreOptions, 'dataDir' | 'workspaceRoot' | 'restoreId'>,
) {
  const locations = roots(options);
  if (readJournal(locations.journal)) return { rejected: false, restoreId: options.restoreId };
  if (!fs.existsSync(locations.rejection)) return { rejected: false, restoreId: options.restoreId };
  const proof = readObject(locations.rejection);
  const data = fs.lstatSync(locations.data, { bigint: true }),
    workspace = fs.lstatSync(locations.workspace, { bigint: true });
  return {
    rejected:
      proof.rejected === true &&
      proof.restoreId === options.restoreId &&
      isIdentity(proof.data) &&
      isIdentity(proof.workspace) &&
      data.isDirectory() &&
      !data.isSymbolicLink() &&
      workspace.isDirectory() &&
      !workspace.isSymbolicLink() &&
      matches(data, proof.data) &&
      matches(workspace, proof.workspace) &&
      !inspectWorkerRestore(options).restored,
    restoreId: options.restoreId,
  };
}
/** Capture this once when constructing a Worker, never infer loaded data from a marker changed later. */
export function loadedWorkerRestoreInfo(
  options: Pick<WorkerRestoreOptions, 'dataDir' | 'workspaceRoot'>,
): { restored: boolean; restoreId: string | null } {
  const file = path.join(options.dataDir, WORKER_RESTORE_RECEIPT_FILE);
  if (!fs.existsSync(file)) return { restored: false, restoreId: null };
  const value = readObject(file);
  if (
    value.restored !== true ||
    typeof value.restoreId !== 'string' ||
    !RESTORE_ID.test(value.restoreId)
  )
    throw backupError('restore_failed');
  return inspectWorkerRestore({ ...options, restoreId: value.restoreId });
}
/** The caller must stop the service before entry. Validation finishes before either live root moves. */
export async function restoreWorkerBackup(
  options: WorkerRestoreOptions & { input: AsyncIterable<unknown> },
) {
  options.assertOffline();
  const locations = roots(options),
    rename = (from: string, to: string) => durableRename(from, to, options.rename);
  ordinaryDirectory(locations.data, { create: true });
  ordinaryDirectory(locations.workspace, { create: true });
  const release = options.ownerLock
    ? options.ownerLock.acquire(locations.lock, options.restoreId)
    : acquireLock(locations.lock, options.restoreId);
  let decoding: string | undefined, original: { data: Identity; workspace: Identity } | undefined;
  try {
    discardJournalTemporary(locations.journal);
    const pending = readJournal(locations.journal);
    if (pending) recoverPending(options, pending);
    if (inspectWorkerRestore(options).restored)
      return { restored: true, restoreId: options.restoreId };
    // Forget any earlier attempt's witness before accepting this attempt's input.
    if (fs.existsSync(locations.rejection)) {
      readObject(locations.rejection);
      fs.unlinkSync(locations.rejection);
      syncDirectory(locations.dataParent);
    }
    for (const file of [
      locations.dataNew,
      locations.workspaceNew,
      locations.dataPrevious,
      locations.workspacePrevious,
      locations.dataFailed,
      locations.workspaceFailed,
    ])
      if (fs.existsSync(file)) throw backupError('restore_failed');
    original = {
      data: identity(fs.lstatSync(locations.data, { bigint: true })),
      workspace: identity(fs.lstatSync(locations.workspace, { bigint: true })),
    };
    decoding = fs.mkdtempSync(path.join(locations.dataParent, '.dant-restore-validate-'));
    fs.chmodSync(decoding, 0o700);
    const archive = await validateWorkerBackup({ input: options.input, stagingDir: decoding });
    prepareRestoredWorkerState(decoding);
    options.assertOffline();
    fs.writeFileSync(
      path.join(decoding, 'data', WORKER_RESTORE_RECEIPT_FILE),
      JSON.stringify({
        restored: true,
        restoreId: options.restoreId,
        sourceId: archive.manifest.sourceId,
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    const journal: RestoreJournal = {
      restoreId: options.restoreId,
      phase: WorkerRestorePhase.Prepared,
      data: identity(fs.lstatSync(locations.data, { bigint: true })),
      workspace: identity(fs.lstatSync(locations.workspace, { bigint: true })),
    };
    // Durable ownership precedes every named staging directory, including copies between devices.
    atomicJson(locations.journal, journal);
    renamePrivateStagingDirectorySync(path.join(decoding, 'data'), locations.dataNew, {
      assertOffline: () => options.assertOffline(),
      renameSync: rename,
    });
    // Copy to the workspace filesystem before its atomic rename, even when it is a different device.
    fs.cpSync(path.join(decoding, 'workspace'), locations.workspaceNew, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
      verbatimSymlinks: true,
    });
    flushTree(locations.dataNew);
    flushTree(locations.workspaceNew);
    syncDirectory(locations.dataParent);
    syncDirectory(locations.workspaceParent);
    options.assertOffline();
    atomicJson(locations.journal, { ...journal, phase: WorkerRestorePhase.Installing });
    rename(locations.data, locations.dataPrevious);
    rename(locations.workspace, locations.workspacePrevious);
    rename(locations.dataNew, locations.data);
    rename(locations.workspaceNew, locations.workspace);
    atomicJson(locations.journal, { ...journal, phase: WorkerRestorePhase.Committed });
    recoverPending(options, { ...journal, phase: WorkerRestorePhase.Committed });
    return { restored: true, restoreId: options.restoreId };
  } catch {
    discardJournalTemporary(locations.journal);
    const journal = readJournal(locations.journal);
    if (journal) recoverPending(options, journal);
    if (original && !readJournal(locations.journal) && !inspectWorkerRestore(options).restored) {
      options.assertOffline();
      const data = fs.lstatSync(locations.data, { bigint: true }),
        workspace = fs.lstatSync(locations.workspace, { bigint: true });
      if (
        data.isDirectory() &&
        !data.isSymbolicLink() &&
        workspace.isDirectory() &&
        !workspace.isSymbolicLink() &&
        matches(data, original.data) &&
        matches(workspace, original.workspace)
      )
        atomicJson(locations.rejection, {
          rejected: true,
          restoreId: options.restoreId,
          ...original,
        });
    }
    throw backupError('restore_failed');
  } finally {
    if (decoding) removeDirectory(decoding);
    release();
  }
}
