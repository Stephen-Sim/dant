import type { Readable } from 'node:stream';

export type ArchiveDomain = 'data' | 'workspace';
export interface WorkerBackupManifest {
  schemaVersion: number;
  createdAt: number;
  appVersion: string;
  sourceId: string;
  files: number;
  bytes: number;
}
export interface ArchiveEntry {
  domain: ArchiveDomain;
  path: string;
  directory: boolean;
  size: number;
  executable: boolean;
  sha256?: string;
}
export interface WorkerBackupSnapshot {
  metadata: Pick<WorkerBackupManifest, 'createdAt' | 'appVersion' | 'files' | 'bytes'>;
  manifest: WorkerBackupManifest;
  stream: Readable;
  cleanup(): void;
}
export interface WorkerBackupOptions {
  dataDir: string;
  workspaceRoot: string;
  appVersion: string;
  sourceId: string;
  temporaryRoot?: string;
  validateCurrent?: () => void;
}
export interface ValidatedWorkerArchive {
  manifest: WorkerBackupManifest;
  directory: string;
  entries: ArchiveEntry[];
}
