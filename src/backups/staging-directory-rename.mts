import fs from 'node:fs';
import path from 'node:path';
import { errorCode } from '../contracts/json.mts';
import {
  ATOMIC_RENAME_ATTEMPTS,
  ATOMIC_RENAME_DELAY_MS,
  pauseAtomicRename,
} from '../files/atomic-file-rename.mts';
import { archivePath } from './archive-stream.mts';
import { BACKUP_MAX_FILES } from './backup-constants.mts';

const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const STAGING_RENAME_ATTEMPTS = ATOMIC_RENAME_ATTEMPTS;
export const STAGING_RENAME_DELAY_MS = ATOMIC_RENAME_DELAY_MS;
// The archive's entries, the decoded data root and its generated restore receipt.
const STAGING_TREE_ENTRY_LIMIT = BACKUP_MAX_FILES + 2;

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}
interface SourceIdentity extends DirectoryIdentity {
  mtimeNs: bigint;
  ctimeNs: bigint;
}
interface TreeEntryIdentity {
  directory: boolean;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}
interface StagingRenameOptions {
  assertOffline(): void;
  renameSync?: (source: string, destination: string) => void;
  platform?: NodeJS.Platform;
  pause?: (milliseconds: number) => unknown;
}
const unsafe = () =>
  Object.assign(Error('The private restore staging directory could not be confirmed.'), {
    code: 'ERR_RESTORE_STAGE_CHANGED',
  });
function directory(file: string): fs.BigIntStats {
  const value = fs.lstatSync(file, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink()) throw unsafe();
  return value;
}
function ancestors(file: string): DirectoryIdentity[] {
  const root = path.parse(file).root,
    segments = path.relative(root, file).split(path.sep).filter(Boolean),
    result: DirectoryIdentity[] = [];
  let current = root;
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment);
    const stat = directory(current);
    result.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return result;
}
function overlaps(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}
function treeEntry(stat: fs.BigIntStats): TreeEntryIdentity {
  const directory = stat.isDirectory();
  if (
    stat.isSymbolicLink() ||
    (!directory && !stat.isFile()) ||
    stat.nlink < 1n ||
    (!directory && stat.nlink !== 1n)
  )
    throw unsafe();
  return {
    directory,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    nlink: stat.nlink,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}
function sameEntry(left: TreeEntryIdentity, right: TreeEntryIdentity): boolean {
  return (
    left.directory === right.directory &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
/** Metadata only: directory timestamps alone do not prove an unchanged Windows tree. */
function treeInventory(root: string): Map<string, TreeEntryIdentity> {
  const entries = new Map<string, TreeEntryIdentity>([['', treeEntry(directory(root))]]),
    pending = [''];
  while (pending.length) {
    const relative = pending.pop();
    if (relative === undefined) throw unsafe();
    const current = path.join(root, relative),
      expected = entries.get(relative);
    if (!expected || !sameEntry(expected, treeEntry(directory(current)))) throw unsafe();
    const handle = fs.opendirSync(current);
    try {
      for (let child = handle.readSync(); child; child = handle.readSync()) {
        const childPath = relative ? relative + '/' + child.name : child.name;
        if (
          !archivePath(childPath) ||
          entries.has(childPath) ||
          entries.size >= STAGING_TREE_ENTRY_LIMIT
        )
          throw unsafe();
        const entry = treeEntry(fs.lstatSync(path.join(root, childPath), { bigint: true }));
        entries.set(childPath, entry);
        if (entry.directory) pending.push(childPath);
      }
    } finally {
      handle.closeSync();
    }
    if (!sameEntry(expected, treeEntry(directory(current)))) throw unsafe();
  }
  return entries;
}
function sameTree(root: string, baseline: ReadonlyMap<string, TreeEntryIdentity>): boolean {
  try {
    const current = treeInventory(root);
    if (current.size !== baseline.size) return false;
    for (const [file, expected] of baseline) {
      const actual = current.get(file);
      if (!actual || !sameEntry(expected, actual)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** A local move of validated private staging only; never use for live roots or rollback. */
export function renamePrivateStagingDirectorySync(
  source: string,
  destination: string,
  {
    assertOffline,
    renameSync = fs.renameSync,
    platform = process.platform,
    pause = pauseAtomicRename,
  }: StagingRenameOptions,
): void {
  if (
    !path.isAbsolute(source) ||
    !path.isAbsolute(destination) ||
    source.includes('\0') ||
    destination.includes('\0')
  )
    throw unsafe();
  const from = path.resolve(source),
    to = path.resolve(destination);
  if (overlaps(from, to) || overlaps(to, from)) throw unsafe();
  // Walk from the filesystem root before inspecting a child: no ancestor is followed through a link.
  const parents = [...ancestors(path.dirname(from)), ...ancestors(path.dirname(to))],
    initial = directory(from),
    original: SourceIdentity = {
      path: from,
      dev: initial.dev,
      ino: initial.ino,
      mtimeNs: initial.mtimeNs,
      ctimeNs: initial.ctimeNs,
    };
  function unchanged(): boolean {
    try {
      for (const parent of parents) {
        const stat = directory(parent.path);
        if (stat.dev !== parent.dev || stat.ino !== parent.ino) return false;
      }
      if (fs.lstatSync(to, { bigint: true, throwIfNoEntry: false })) return false;
      const current = directory(original.path);
      return (
        current.dev === original.dev &&
        current.ino === original.ino &&
        current.mtimeNs === original.mtimeNs &&
        current.ctimeNs === original.ctimeNs
      );
    } catch {
      return false;
    }
  }
  let failure: unknown, baseline: ReadonlyMap<string, TreeEntryIdentity> | undefined;
  for (let attempt = 0; attempt < STAGING_RENAME_ATTEMPTS; attempt++) {
    assertOffline();
    if (!unchanged()) throw attempt ? failure : unsafe();
    if (platform === 'win32') {
      // Capture before the first attempt: a failed rename may itself have changed the source.
      if (!baseline) baseline = treeInventory(from);
      else if (!sameTree(from, baseline)) throw failure;
      if (!unchanged()) throw attempt ? failure : unsafe();
      assertOffline();
    }
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (
        platform !== 'win32' ||
        !code ||
        !RETRYABLE_CODES.has(code) ||
        attempt + 1 === STAGING_RENAME_ATTEMPTS ||
        !unchanged()
      )
        throw error;
      failure = error;
      pause(STAGING_RENAME_DELAY_MS * (attempt + 1));
    }
  }
}
