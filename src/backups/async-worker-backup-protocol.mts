import path from 'node:path';
import { isRecord } from '../contracts/json.mts';
import { backupError } from './archive-stream.mts';
import { BACKUP_SCHEMA_VERSION, BACKUP_MAX_FILES, BACKUP_MAX_BYTES } from './backup-constants.mts';
import type { AsyncWorkerBackupOptions, WorkerBackupManifest } from './archive-types.ts';

const boundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');

export function readBackupThreadOptions(value: unknown): AsyncWorkerBackupOptions {
  if (
    !isRecord(value) ||
    !absolutePath(value.dataDir) ||
    !absolutePath(value.workspaceRoot) ||
    !absolutePath(value.temporaryRoot) ||
    typeof value.appVersion !== 'string' ||
    value.appVersion.length > 64 ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(value.appVersion) ||
    typeof value.sourceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.sourceId)
  )
    throw backupError('invalid_backup');
  return {
    dataDir: value.dataDir,
    workspaceRoot: value.workspaceRoot,
    temporaryRoot: value.temporaryRoot,
    appVersion: value.appVersion,
    sourceId: value.sourceId,
  };
}

export function readBackupThreadManifest(
  value: unknown,
  expected: Pick<AsyncWorkerBackupOptions, 'appVersion' | 'sourceId'>,
): WorkerBackupManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    !boundedInteger(value.createdAt, 8_640_000_000_000_000) ||
    value.createdAt === 0 ||
    value.appVersion !== expected.appVersion ||
    value.sourceId !== expected.sourceId ||
    !boundedInteger(value.files, BACKUP_MAX_FILES) ||
    !boundedInteger(value.bytes, BACKUP_MAX_BYTES)
  )
    throw backupError('invalid_backup');
  return {
    schemaVersion: value.schemaVersion,
    createdAt: value.createdAt,
    appVersion: expected.appVersion,
    sourceId: expected.sourceId,
    files: value.files,
    bytes: value.bytes,
  };
}
