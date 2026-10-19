import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ordinaryDirectory } from '../files/managed-path.mts';
import { archivePath, archiveStream, backupError } from './archive-stream.mts';
import {
  BACKUP_SCHEMA_VERSION,
  BACKUP_CHUNK_BYTES,
  BACKUP_MAX_BYTES,
  BACKUP_MAX_FILE_BYTES,
  BACKUP_MAX_FILES,
} from './backup-constants.mts';
import type {
  ArchiveDomain,
  ArchiveEntry,
  WorkerBackupOptions,
  WorkerBackupSnapshot,
} from './archive-types.ts';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
const SQLITE_CONNECTION_LIMIT = 128;
const COMMON_EXCLUDES = new Set(['node_modules', '.cache', '.ssh', '.codex', '.openai']);
const DATA_EXCLUDES = new Set([
  'runtime',
  'deploy',
  'diagnostics',
  'logs',
  'cache',
  'tmp',
  'updates',
  'backups',
  '.env',
]);
const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const;
const sameIdentity = (left: fs.BigIntStats, right: fs.BigIntStats) =>
  left.ino === right.ino && left.dev === right.dev;
const sameVersion = (left: fs.BigIntStats, right: fs.BigIntStats) =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
};
function ordinaryFile(file: string) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size > BigInt(BACKUP_MAX_FILE_BYTES)
  )
    throw backupError('invalid_backup');
  return stat;
}
function sqliteFile(file: string) {
  const stat = ordinaryFile(file);
  if (stat.size < BigInt(SQLITE_MAGIC.length)) return false;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameIdentity(stat, fs.fstatSync(fd, { bigint: true })))
      throw backupError('source_changed');
    const value = Buffer.alloc(SQLITE_MAGIC.length);
    return (
      fs.readSync(fd, value, 0, value.length, 0) === value.length && value.equals(SQLITE_MAGIC)
    );
  } finally {
    fs.closeSync(fd);
  }
}
function copyStable(file: string, target: string) {
  const before = ordinaryFile(file),
    input = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let output: number | undefined;
  try {
    if (!sameVersion(before, fs.fstatSync(input, { bigint: true })))
      throw backupError('source_changed');
    output = fs.openSync(target, 'wx', before.mode & 0o111n ? 0o700 : 0o600);
    const hash = createHash('sha256'),
      buffer = Buffer.allocUnsafe(BACKUP_CHUNK_BYTES);
    let bytes = 0,
      count;
    while ((count = fs.readSync(input, buffer, 0, buffer.length, null))) {
      bytes += count;
      if (bytes > Number(before.size)) throw backupError('source_changed');
      let written = 0;
      while (written < count) written += fs.writeSync(output, buffer, written, count - written);
      hash.update(buffer.subarray(0, count));
    }
    if (
      bytes !== Number(before.size) ||
      !sameVersion(before, fs.fstatSync(input, { bigint: true })) ||
      !sameVersion(before, ordinaryFile(file))
    )
      throw backupError('source_changed');
    fs.fsyncSync(output);
    return hash.digest('hex');
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}
function hashFile(file: string) {
  const fd = fs.openSync(file, 'r'),
    hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(BACKUP_CHUNK_BYTES);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
/** Synchronous staging prevents this Worker's admission callbacks interleaving with capture.
 * External writers are detected at both file and SQLite connection boundaries; this is not a distributed transaction. */
export function createWorkerBackup(options: WorkerBackupOptions): WorkerBackupSnapshot {
  const dataDir = ordinaryDirectory(path.resolve(options.dataDir)),
    workspaceRoot = ordinaryDirectory(path.resolve(options.workspaceRoot), { create: true });
  if (dataDir === workspaceRoot || within(workspaceRoot, dataDir))
    throw backupError('invalid_backup');
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.sourceId) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(options.appVersion)
  )
    throw backupError('invalid_backup');
  options.validateCurrent?.();
  ordinaryFile(path.join(dataDir, 'state.json'));
  const temporaryRoot = ordinaryDirectory(path.resolve(options.temporaryRoot || os.tmpdir())),
    staging = fs.mkdtempSync(path.join(temporaryRoot, 'dant-worker-backup-')),
    identity = fs.lstatSync(staging, { bigint: true }),
    entries: ArchiveEntry[] = [],
    observed: { file: string; stat: fs.BigIntStats | undefined }[] = [],
    databases: { db: DatabaseSync; version: unknown }[] = [];
  fs.chmodSync(staging, 0o700);
  let files = 0,
    bytes = 0,
    cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    const current = fs.lstatSync(staging, { throwIfNoEntry: false, bigint: true });
    if (
      current &&
      (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(identity, current))
    )
      throw backupError('source_changed');
    fs.rmSync(staging, { recursive: true, force: true });
    cleaned = true;
  };
  function capture(directory: string, domain: ArchiveDomain, prefix = '') {
    const before = fs.lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw backupError('invalid_backup');
    observed.push({ file: directory, stat: before });
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? prefix + '/' + name : name,
        source = path.join(directory, name);
      if (
        COMMON_EXCLUDES.has(name) ||
        (domain === 'data' && !prefix && DATA_EXCLUDES.has(name)) ||
        (domain === 'data' && within(workspaceRoot, source)) ||
        within(staging, source)
      )
        continue;
      if (!archivePath(relative)) throw backupError('invalid_backup');
      const suffix = SQLITE_SIDECARS.find((value) => source.endsWith(value));
      if (
        suffix &&
        fs.existsSync(source.slice(0, -suffix.length)) &&
        sqliteFile(source.slice(0, -suffix.length))
      )
        continue;
      const stat = fs.lstatSync(source, { bigint: true }),
        target = path.join(staging, domain, ...relative.split('/'));
      if (entries.length >= BACKUP_MAX_FILES || stat.isSymbolicLink())
        throw backupError('invalid_backup');
      if (stat.isDirectory()) {
        fs.mkdirSync(target, { mode: 0o700 });
        entries.push({ domain, path: relative, directory: true, size: 0, executable: false });
        capture(source, domain, relative);
        continue;
      }
      ordinaryFile(source);
      observed.push({ file: source, stat });
      let sha256;
      if (sqliteFile(source)) {
        if (databases.length >= SQLITE_CONNECTION_LIMIT) throw backupError('invalid_backup');
        for (const sidecar of SQLITE_SIDECARS) {
          const file = source + sidecar,
            sidecarStat = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
          if (
            sidecarStat &&
            (!sidecarStat.isFile() || sidecarStat.isSymbolicLink() || sidecarStat.nlink !== 1n)
          )
            throw backupError('invalid_backup');
          observed.push({ file, stat: sidecarStat });
        }
        const db = new DatabaseSync(source, {
          readOnly: true,
          enableDoubleQuotedStringLiterals: false,
        });
        databases.push({ db, version: db.prepare('PRAGMA data_version').get()?.data_version });
        if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
          throw backupError('invalid_backup');
        db.prepare('VACUUM INTO ?').run(target);
        fs.chmodSync(target, 0o600);
        sha256 = hashFile(target);
      } else sha256 = copyStable(source, target);
      const size = Number(ordinaryFile(target).size);
      files++;
      bytes += size;
      if (files > BACKUP_MAX_FILES || bytes > BACKUP_MAX_BYTES) throw backupError('invalid_backup');
      entries.push({
        domain,
        path: relative,
        directory: false,
        size,
        executable: Boolean(stat.mode & 0o111n),
        sha256,
      });
    }
  }
  try {
    for (const [domain, source] of [
      ['data', dataDir],
      ['workspace', workspaceRoot],
    ] as const) {
      fs.mkdirSync(path.join(staging, domain), { mode: 0o700 });
      capture(source, domain);
    }
    options.validateCurrent?.();
    for (const { file, stat } of observed) {
      const current = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
      if (stat ? !current || !sameVersion(stat, current) : current)
        throw backupError('source_changed');
    }
    for (const { db, version } of databases)
      if (db.prepare('PRAGMA data_version').get()?.data_version !== version)
        throw backupError('source_changed');
    const manifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: Date.now(),
      appVersion: options.appVersion,
      sourceId: options.sourceId,
      files,
      bytes,
    };
    return {
      manifest,
      metadata: { createdAt: manifest.createdAt, appVersion: manifest.appVersion, files, bytes },
      stream: archiveStream(staging, manifest, entries),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    for (const { db } of databases) db.close();
  }
}
