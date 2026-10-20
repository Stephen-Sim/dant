import { isRecord } from '../shared/json.mts';
import { BACKUP_MAX_BYTES, BACKUP_MAX_FILES } from './backup-limits.mts';
import type { BackupMetadata } from './backup-types.ts';

export const backupId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export function isBackupMetadata(value: unknown): value is BackupMetadata {
  return (
    isRecord(value) &&
    backupId(value.id) &&
    integer(value.createdAt, 1, Number.MAX_SAFE_INTEGER) &&
    typeof value.appVersion === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/.test(value.appVersion) &&
    integer(value.bytes, 0, BACKUP_MAX_BYTES) &&
    integer(value.files, 0, BACKUP_MAX_FILES) &&
    typeof value.source === 'string' &&
    /^[0-9a-f]{12}$/.test(value.source)
  );
}
