import type { Readable, Writable } from 'node:stream';
import type { BackupMetadata } from './backup-types.ts';

export interface PortableVaultSnapshot {
  metadata: BackupMetadata;
  archiveBytes: number;
  stream(): Readable;
  close(): Promise<void>;
}
export interface PortableVault {
  open(id: string, signal?: AbortSignal): Promise<PortableVaultSnapshot>;
  save(input: Readable, metadata: BackupMetadata, signal?: AbortSignal): Promise<BackupMetadata>;
}
export interface PortableExportInput {
  vault: PortableVault;
  id: string;
  passphrase: string;
  output: Writable;
  signal?: AbortSignal;
}
export interface PortableImportInput {
  vault: PortableVault;
  input: Readable;
  passphrase: string;
  signal?: AbortSignal;
}
