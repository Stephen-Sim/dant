import { isRecord } from '../contracts/json.mts';
import { BackupMode, isEnumValue } from '../contracts/states.mts';
import {
  BACKUP_INTERVAL_MINUTES,
  BACKUP_RETENTION_COUNT,
  BACKUP_MAX_BYTES,
  BACKUP_MAX_FILES,
} from './backup-constants.mts';
import type { BackupMetadata, BackupSettings } from './backup-types.ts';

export const backupError = (code: string, status = 409, unknownOutcome = false) =>
  Object.assign(Error(code), { code, status, unknownOutcome });
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
export const defaultBackupSettings = (): BackupSettings => ({
  mode: BackupMode.Automatic,
  intervalMinutes: BACKUP_INTERVAL_MINUTES.default,
  onConnect: true,
  beforeVmChange: true,
  retainCount: BACKUP_RETENTION_COUNT.default,
});
export function backupSettings(value: unknown, base = defaultBackupSettings()): BackupSettings {
  if (!isRecord(value) || Object.keys(value).some((key) => !Object.hasOwn(base, key)))
    throw backupError('backup_settings_invalid', 400);
  const result = { ...base, ...value };
  if (
    !isEnumValue(BackupMode, result.mode) ||
    !integer(
      result.intervalMinutes,
      BACKUP_INTERVAL_MINUTES.minimum,
      BACKUP_INTERVAL_MINUTES.maximum,
    ) ||
    !integer(result.retainCount, BACKUP_RETENTION_COUNT.minimum, BACKUP_RETENTION_COUNT.maximum) ||
    typeof result.onConnect !== 'boolean' ||
    typeof result.beforeVmChange !== 'boolean'
  )
    throw backupError('backup_settings_invalid', 400);
  return {
    mode: result.mode,
    intervalMinutes: result.intervalMinutes,
    onConnect: result.onConnect,
    beforeVmChange: result.beforeVmChange,
    retainCount: result.retainCount,
  };
}
