import fs from 'node:fs';
import path from 'node:path';

export const ATOMIC_RENAME_ATTEMPTS = 6;
export const ATOMIC_RENAME_DELAY_MS = 10;
const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pauseBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface AtomicFileRenameOptions {
  readonly renameSync?: (source: string, destination: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly pause?: (milliseconds: number) => unknown;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export function pauseAtomicRename(milliseconds: number): void {
  Atomics.wait(pauseBuffer, 0, 0, milliseconds);
}

function unsafePath(): Error {
  return Object.assign(Error('Atomic file replacement requires unchanged ordinary local files.'), {
    code: 'ERR_ATOMIC_RENAME_UNSAFE',
  });
}

function fileIdentity(file: string): FileIdentity | undefined {
  const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw unsafePath();
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
}

function directoryIdentities(directory: string): DirectoryIdentity[] {
  const directories: DirectoryIdentity[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafePath();
    directories.push({ path: current, dev: stat.dev, ino: stat.ino });
    if (path.dirname(current) === current) return directories;
  }
}

function sameFile(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs;
}

function retryable(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_CODES.has(error.code)
  );
}

/** Retry only a failed local rename whose source, destination and paths are unchanged. */
export function renameAtomicFileSync(
  source: string,
  destination: string,
  {
    renameSync = fs.renameSync,
    platform = process.platform,
    pause = pauseAtomicRename,
  }: AtomicFileRenameOptions = {},
): void {
  const from = path.resolve(source);
  const to = path.resolve(destination);
  if (
    source.includes('\0') ||
    destination.includes('\0') ||
    from === to ||
    path.dirname(from) !== path.dirname(to)
  )
    throw unsafePath();
  const originalSource = fileIdentity(from);
  const originalTarget = fileIdentity(to);
  if (!originalSource) throw unsafePath();
  let unchanged: (() => boolean) | undefined;
  try {
    const directories = directoryIdentities(path.dirname(from));
    unchanged = (): boolean => {
      try {
        return (
          path.resolve(source) === from &&
          path.resolve(destination) === to &&
          directories.every((directory) => {
            const stat = fs.lstatSync(directory.path, { bigint: true });
            return (
              stat.isDirectory() &&
              !stat.isSymbolicLink() &&
              stat.dev === directory.dev &&
              stat.ino === directory.ino
            );
          }) &&
          sameFile(originalSource, fileIdentity(from)) &&
          sameFile(originalTarget, fileIdentity(to))
        );
      } catch {
        return false;
      }
    };
  } catch {
    // Preserve the first rename's behavior when a retry cannot be proven safe.
    unchanged = undefined;
  }
  let originalFailure: unknown;
  for (let attempt = 0; attempt < ATOMIC_RENAME_ATTEMPTS; attempt++) {
    if (attempt > 0 && !unchanged?.()) throw originalFailure;
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (
        platform !== 'win32' ||
        !retryable(error) ||
        attempt + 1 === ATOMIC_RENAME_ATTEMPTS ||
        !unchanged?.()
      )
        throw error;
      originalFailure = error;
      pause((attempt + 1) * ATOMIC_RENAME_DELAY_MS);
    }
  }
}
