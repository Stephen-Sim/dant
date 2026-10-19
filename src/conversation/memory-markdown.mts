import { errorCode } from '../contracts/json.mts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBounded } from '../files/attachments.mts';
import { renameManaged } from '../files/managed-path.mts';
import { MEMORY_FILES, MEMORY_MAX_BYTES } from './memory-constants.mts';

export function ordinaryMemoryDirectory(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error('Memory directories must be ordinary directories');
  return stat;
}

/** Markdown is an explicit interchange format, never a second memory authority. */
export class MemoryMarkdown {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  file(name: unknown) {
    if (!MEMORY_FILES.some((candidate) => candidate === name)) throw Error('Unknown memory file');
    if (typeof name !== 'string') throw Error('Unknown memory file');
    return path.join(this.dir, name);
  }
  validateFile(file: string) {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw Error('Memory must be stored in ordinary, unlinked files');
    if (stat.size > MEMORY_MAX_BYTES) throw Error('Memory file exceeds 64 KiB');
    return stat;
  }
  read(name: string) {
    const file = this.file(name),
      before = this.validateFile(file);
    if (!before) return '';
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      fd = fs.openSync(file, flags);
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > MEMORY_MAX_BYTES ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev
      )
        throw Error('Invalid memory file');
      const text = readBounded(fd, MEMORY_MAX_BYTES).toString('utf8'),
        after = fs.fstatSync(fd);
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw Error('Memory changed while reading');
      return text;
    } finally {
      fs.closeSync(fd);
    }
  }
  write(name: unknown, text: unknown) {
    if (
      typeof text !== 'string' ||
      text.includes('\0') ||
      Buffer.byteLength(text) > MEMORY_MAX_BYTES
    )
      throw Error('Memory must be text no larger than 64 KiB');
    const file = this.file(name);
    this.validateFile(file);
    const temporary = path.join(this.dir, '.memory-' + randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      renameManaged(temporary, file);
    } finally {
      if (fd != null) fs.closeSync(fd);
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    return { name, bytes: Buffer.byteLength(text) };
  }
}
