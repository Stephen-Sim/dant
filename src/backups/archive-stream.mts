import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { isRecord } from '../contracts/json.mts';
import { ordinaryDirectory } from '../files/managed-path.mts';
import {
  BACKUP_SCHEMA_VERSION,
  BACKUP_CHUNK_BYTES,
  BACKUP_MANIFEST_MAX_BYTES,
  BACKUP_MAX_BYTES,
  BACKUP_MAX_FILE_BYTES,
  BACKUP_MAX_FILES,
} from './backup-constants.mts';
import type {
  ArchiveDomain,
  ArchiveEntry,
  WorkerBackupManifest,
  ValidatedWorkerArchive,
} from './archive-types.ts';

export const WORKER_ARCHIVE_MAGIC = 'DANT-BACKUP/1';
const PATH_MAX_BYTES = 4096;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const jsonLine = (value: unknown) => JSON.stringify(value) + '\n';
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
export function backupError(
  code: 'backup_busy' | 'source_changed' | 'invalid_backup' | 'restore_failed',
): Error & { code: string; status: number } {
  return Object.assign(
    Error(
      code === 'backup_busy' || code === 'source_changed'
        ? 'The work computer changed during backup. Try again when it is idle.'
        : code === 'restore_failed'
          ? 'The backup could not be restored. Existing data was preserved.'
          : 'The backup is invalid or unsupported.',
    ),
    { code, status: code === 'backup_busy' || code === 'source_changed' ? 409 : 400 },
  );
}
export function archivePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= PATH_MAX_BYTES &&
    !/[\\\x00-\x1f\x7f:]/.test(value) &&
    !value.startsWith('/') &&
    value
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}
function manifest(value: unknown): WorkerBackupManifest {
  if (
    !isRecord(value) ||
    value.type !== 'header' ||
    value.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    !integer(value.createdAt, Number.MAX_SAFE_INTEGER) ||
    value.createdAt === 0 ||
    typeof value.appVersion !== 'string' ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(value.appVersion) ||
    typeof value.sourceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.sourceId) ||
    !integer(value.files, BACKUP_MAX_FILES) ||
    !integer(value.bytes, BACKUP_MAX_BYTES)
  )
    throw backupError('invalid_backup');
  return {
    schemaVersion: value.schemaVersion,
    createdAt: value.createdAt,
    appVersion: value.appVersion,
    sourceId: value.sourceId,
    files: value.files,
    bytes: value.bytes,
  };
}
function entry(value: Record<string, unknown>): ArchiveEntry {
  if (
    (value.domain !== 'data' && value.domain !== 'workspace') ||
    !archivePath(value.path) ||
    (value.type !== 'file' && value.type !== 'directory') ||
    !integer(value.size, BACKUP_MAX_FILE_BYTES) ||
    typeof value.executable !== 'boolean' ||
    (value.type === 'directory' && value.size !== 0)
  )
    throw backupError('invalid_backup');
  return {
    domain: value.domain,
    path: value.path,
    directory: value.type === 'directory',
    size: value.size,
    executable: value.executable,
  };
}
/** A staged archive has bounded JSON frames and never buffers an entire file. */
export function archiveStream(
  directory: string,
  header: WorkerBackupManifest,
  entries: readonly ArchiveEntry[],
): Readable {
  async function* encode() {
    yield WORKER_ARCHIVE_MAGIC + '\n';
    yield jsonLine({ type: 'header', ...header });
    for (const item of entries) {
      yield jsonLine({
        type: item.directory ? 'directory' : 'file',
        domain: item.domain,
        path: item.path,
        size: item.size,
        executable: item.executable,
      });
      if (item.directory) continue;
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const value of fs.createReadStream(
        path.join(directory, item.domain, ...item.path.split('/')),
        { highWaterMark: BACKUP_CHUNK_BYTES },
      )) {
        const chunk: unknown = value;
        if (!Buffer.isBuffer(chunk)) throw backupError('invalid_backup');
        bytes += chunk.length;
        hash.update(chunk);
        yield jsonLine({ type: 'chunk', data: chunk.toString('base64') });
      }
      const sha256 = hash.digest('hex');
      if (bytes !== item.size || sha256 !== item.sha256) throw backupError('source_changed');
      yield jsonLine({ type: 'end', sha256 });
    }
    yield jsonLine({ type: 'footer', files: header.files, bytes: header.bytes });
  }
  return Readable.from(encode());
}
async function* lines(input: AsyncIterable<unknown>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: Buffer[] = [],
    length = 0;
  for await (const value of input) {
    if (!Buffer.isBuffer(value) && typeof value !== 'string' && !(value instanceof Uint8Array))
      throw backupError('invalid_backup');
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start),
        end = newline < 0 ? chunk.length : newline,
        piece = chunk.subarray(start, end);
      length += piece.length;
      if (length > BACKUP_MANIFEST_MAX_BYTES) throw backupError('invalid_backup');
      parts.push(piece);
      if (newline >= 0) {
        yield decoder.decode(Buffer.concat(parts, length));
        parts = [];
        length = 0;
      }
      start = end + 1;
    }
  }
  if (length) throw backupError('invalid_backup');
}
function fileTarget(directory: string, domain: ArchiveDomain, relative: string) {
  const root = path.join(directory, domain),
    target = path.join(root, ...relative.split('/'));
  ordinaryDirectory(path.dirname(target), { create: true });
  return target;
}
/** Decode into a new private staging directory; no archive path can select a live target. */
export async function validateWorkerBackup({
  input,
  stagingDir,
}: {
  input: AsyncIterable<unknown>;
  stagingDir: string;
}): Promise<ValidatedWorkerArchive> {
  ordinaryDirectory(path.resolve(stagingDir));
  if (fs.readdirSync(stagingDir).length) throw backupError('invalid_backup');
  fs.mkdirSync(path.join(stagingDir, 'data'), { mode: 0o700 });
  fs.mkdirSync(path.join(stagingDir, 'workspace'), { mode: 0o700 });
  let header: WorkerBackupManifest | undefined,
    index = 0,
    bytes = 0,
    files = 0,
    footer = false,
    current:
      | { item: ArchiveEntry; fd: number; written: number; hash: ReturnType<typeof createHash> }
      | undefined;
  const entries: ArchiveEntry[] = [],
    seen = new Map<string, boolean>(),
    parents = new Set<string>();
  try {
    for await (const line of lines(input)) {
      if (index++ === 0) {
        if (line !== WORKER_ARCHIVE_MAGIC) throw backupError('invalid_backup');
        continue;
      }
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || footer) throw backupError('invalid_backup');
      if (!header) {
        header = manifest(value);
        continue;
      }
      if (current) {
        if (value.type === 'chunk') {
          if (
            typeof value.data !== 'string' ||
            value.data.length === 0 ||
            value.data.length > 4 * Math.ceil(BACKUP_CHUNK_BYTES / 3) ||
            !BASE64_PATTERN.test(value.data)
          )
            throw backupError('invalid_backup');
          const chunk = Buffer.from(value.data, 'base64');
          if (
            chunk.length > BACKUP_CHUNK_BYTES ||
            chunk.toString('base64') !== value.data ||
            current.written + chunk.length > current.item.size
          )
            throw backupError('invalid_backup');
          let written = 0;
          while (written < chunk.length)
            written += fs.writeSync(current.fd, chunk, written, chunk.length - written);
          current.hash.update(chunk);
          current.written += chunk.length;
          continue;
        }
        if (
          value.type !== 'end' ||
          typeof value.sha256 !== 'string' ||
          !HASH_PATTERN.test(value.sha256) ||
          current.written !== current.item.size ||
          current.hash.digest('hex') !== value.sha256
        )
          throw backupError('invalid_backup');
        fs.fsyncSync(current.fd);
        fs.closeSync(current.fd);
        current.item.sha256 = value.sha256;
        current = undefined;
        continue;
      }
      if (value.type === 'footer') {
        if (
          value.files !== files ||
          value.bytes !== bytes ||
          files !== header.files ||
          bytes !== header.bytes
        )
          throw backupError('invalid_backup');
        footer = true;
        continue;
      }
      const item = entry(value),
        key = item.domain + '/' + item.path;
      if (seen.has(key) || entries.length >= BACKUP_MAX_FILES) throw backupError('invalid_backup');
      const segments = key.split('/');
      for (let length = 1; length < segments.length; length++) {
        const parent = segments.slice(0, length).join('/');
        if (seen.get(parent) === false) throw backupError('invalid_backup');
        parents.add(parent);
      }
      if (!item.directory && parents.has(key)) throw backupError('invalid_backup');
      seen.set(key, item.directory);
      entries.push(item);
      const target = fileTarget(stagingDir, item.domain, item.path);
      if (item.directory) {
        ordinaryDirectory(target, { create: true });
        continue;
      }
      files++;
      bytes += item.size;
      if (files > header.files || bytes > header.bytes || bytes > BACKUP_MAX_BYTES)
        throw backupError('invalid_backup');
      const fd = fs.openSync(
        target,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          (fs.constants.O_NOFOLLOW || 0),
        item.executable ? 0o700 : 0o600,
      );
      current = { item, fd, written: 0, hash: createHash('sha256') };
    }
    if (!header || !footer || current || !seen.has('data/state.json'))
      throw backupError('invalid_backup');
    return { manifest: header, directory: stagingDir, entries };
  } catch {
    throw backupError('invalid_backup');
  } finally {
    if (current) fs.closeSync(current.fd);
  }
}
