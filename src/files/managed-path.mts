import fs from 'node:fs';
import path from 'node:path';
import { errorCode } from '../contracts/json.mts';
const RENAME_ATTEMPTS = 6;
const RENAME_DELAY_MS = 20;
interface RenameManagedOptions {
  platform?: NodeJS.Platform;
  rename?: (source: string, destination: string) => void;
  pause?: (milliseconds: number) => unknown;
}
const retryable = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pauseBuffer = new Int32Array(new SharedArrayBuffer(4));

/** Windows scanners can briefly hold a just-written directory after its files close. */
export function renameManaged(
  source: string,
  destination: string,
  {
    platform = process.platform,
    rename = fs.renameSync,
    pause = (ms) => Atomics.wait(pauseBuffer, 0, 0, ms),
  }: RenameManagedOptions = {},
) {
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++)
    try {
      return rename(source, destination);
    } catch (error) {
      if (
        platform !== 'win32' ||
        !retryable.has(errorCode(error) ?? '') ||
        attempt + 1 === RENAME_ATTEMPTS
      )
        throw error;
      pause(RENAME_DELAY_MS * (attempt + 1));
    }
}

/** Check ancestors before creating anything: recursive mkdir must not traverse a junction. */
export function ordinaryDirectory(
  directory: unknown,
  { create = false }: { create?: boolean } = {},
) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0'))
    throw Error('An absolute managed directory is required.');
  const absolute = path.resolve(directory),
    root = path.parse(absolute).root;
  let current = root;
  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (!create) throw Error('Managed directory is missing.');
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error('Managed storage requires ordinary directories without links.');
  }
  return absolute;
}
