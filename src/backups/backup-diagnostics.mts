const SQLITE_ERROR_CODE = 'ERR_SQLITE_ERROR';
const SQLITE_PRIMARY_RESULT_MASK = 0xff;
const SQLITE_BUSY_RESULT = 5;
const SQLITE_LOCKED_RESULT = 6;
const MAX_SQLITE_RESULT = 0x7fffffff;
const PERMISSION_CODES = new Set(['EACCES', 'EPERM']);
const INVALID_SOURCE_CODES = new Set(['invalid_backup', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP']);

export interface WorkerBackupFailure {
  reason:
    'busy' | 'sqlite_busy' | 'fs_permission' | 'invalid_source' | 'source_changed' | 'generic';
  status: 400 | 409;
  code: 'backup_failed' | 'backup_busy';
}
const FAILURE_REASONS = [
  'busy',
  'sqlite_busy',
  'fs_permission',
  'invalid_source',
  'source_changed',
  'generic',
] as const;

export class WorkerBackupStagingError extends Error {
  readonly reason: WorkerBackupFailure['reason'];
  constructor(reason: unknown) {
    super('The work computer backup could not be created.');
    this.reason = FAILURE_REASONS.find((value) => value === reason) ?? 'generic';
  }
}

function ownValue(error: unknown, key: string): unknown {
  if (error === null || typeof error !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

/** Only fixed error codes enter diagnostics; error text and filesystem paths are never read. */
export function workerBackupFailure(error: unknown): WorkerBackupFailure {
  if (error instanceof WorkerBackupStagingError) {
    const reason =
        FAILURE_REASONS.find((value) => value === ownValue(error, 'reason')) ?? 'generic',
      busy = ['busy', 'sqlite_busy', 'source_changed'].includes(reason);
    return {
      reason,
      status: busy ? 409 : 400,
      code: busy ? 'backup_busy' : 'backup_failed',
    };
  }
  const code = ownValue(error, 'code'),
    sqliteResult = ownValue(error, 'errcode');
  if (
    code === SQLITE_ERROR_CODE &&
    typeof sqliteResult === 'number' &&
    Number.isSafeInteger(sqliteResult) &&
    sqliteResult >= 0 &&
    sqliteResult <= MAX_SQLITE_RESULT &&
    [SQLITE_BUSY_RESULT, SQLITE_LOCKED_RESULT].includes(sqliteResult & SQLITE_PRIMARY_RESULT_MASK)
  )
    return { reason: 'sqlite_busy', status: 409, code: 'backup_busy' };
  if (code === 'backup_busy' || code === 'source_changed')
    return {
      reason: code === 'backup_busy' ? 'busy' : 'source_changed',
      status: 409,
      code: 'backup_busy',
    };
  return {
    reason:
      typeof code === 'string' && PERMISSION_CODES.has(code)
        ? 'fs_permission'
        : typeof code === 'string' && INVALID_SOURCE_CODES.has(code)
          ? 'invalid_source'
          : 'generic',
    status: 400,
    code: 'backup_failed',
  };
}
