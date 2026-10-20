import type { BackupModeValue, BackupPhaseValue } from '../shared/states.mts';
import type { BACKUP_WARNING_CODES } from './backup-limits.mts';

export interface BackupSettings {
  mode: BackupModeValue;
  intervalMinutes: number;
  onConnect: boolean;
  beforeVmChange: boolean;
  retainCount: number;
}
export interface BackupMetadata {
  id: string;
  createdAt: number;
  appVersion: string;
  bytes: number;
  files: number;
  source: string;
}
export interface BackupAvailability {
  online: boolean;
  supported: boolean;
  reason?: string;
}
export interface BackupStatus {
  settings: BackupSettings;
  availability: BackupAvailability;
  backups: BackupMetadata[];
  phase: BackupPhaseValue;
  lastBackupAt: number | null;
  lastError: string | null;
  nextAt: number | null;
  lastRestoredId: string | null;
}
export interface BackupPreview {
  backup: BackupMetadata;
  confirmation: string;
  expiresAt: number;
  target: { id: string; empty: boolean };
  warnings: (typeof BACKUP_WARNING_CODES)[number][];
}
