export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_INTERVAL_MINUTES = Object.freeze({ minimum: 15, maximum: 10_080, default: 60 });
export const BACKUP_RETENTION_COUNT = Object.freeze({ minimum: 1, maximum: 100, default: 10 });
export const BACKUP_CHECK_INTERVAL_MS = 30_000;
export const BACKUP_RETRY_DELAY_MS = 5 * 60_000;
export const BACKUP_PREVIEW_TTL_MS = 5 * 60_000;
export const BACKUP_IO_TIMEOUT_MS = 15 * 60_000;
export const BACKUP_MANIFEST_MAX_BYTES = 1024 * 1024;
export const BACKUP_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const BACKUP_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const BACKUP_MAX_FILES = 100_000;
export const BACKUP_CATALOG_LIMIT = 1000;
export const BACKUP_CHUNK_BYTES = 64 * 1024;
export const BACKUP_ERROR_CODES = Object.freeze([
  'backup_busy',
  'backup_source_changed',
  'backup_protection_unavailable',
  'backup_service_update_required',
  'backup_offline',
  'backup_failed',
  'backup_restore_unconfirmed',
  'backup_restore_rejected',
  'backup_invalid',
  'backup_passphrase_invalid',
  'backup_before_vm_change_required',
  'backup_running',
  'backup_settings_invalid',
  'backup_size_limit',
  'backup_connection_changed',
  'backup_preview_expired',
  'backup_catalog_limit',
  'backup_exists',
] as const);
export const BACKUP_WARNING_CODES = Object.freeze([
  'replaces-current-data',
  'different-computer',
  'service-version-differs',
  'tasks-remain-paused',
  'sign-in-required',
] as const);
