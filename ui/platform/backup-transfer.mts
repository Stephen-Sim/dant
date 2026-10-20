import { apiPath } from './native-protocol.mts';
import type { BackupMetadata } from '../settings/backup-types.ts';
import { backupId, isBackupMetadata } from '../settings/backup-contracts.mts';
import { isRecord } from '../shared/json.mts';
import type { CoreModule } from '../shared/contracts.mts';

export const WEB_BACKUP_MAX_BYTES = 64 * 1024 * 1024;
export const BACKUP_PASSPHRASE_MIN_BYTES = 12;
export const BACKUP_PASSPHRASE_MAX_BYTES = 1024;
export const BACKUP_TRANSFER_TIMEOUT_MS = 30 * 60_000;
const RESPONSE_JSON_LIMIT = 64 * 1024;
const TRANSFER_CODES = new Set([
  'backup_passphrase_invalid',
  'backup_invalid',
  'backup_size_limit',
  'backup_exists',
  'backup_busy',
  'backup_transfer_failed',
  'backup_transfer_unconfirmed',
]);
export interface BackupTransfer {
  exportBackup(id: string, passphrase: string): Promise<boolean>;
  importBackup(passphrase: string, file?: File): Promise<BackupMetadata | null>;
}
interface TransferOptions {
  desktop?: boolean;
  getToken?: () => string;
  loadCore?: () => Promise<CoreModule>;
  fetchRequest?: (url: string, options: RequestInit) => Promise<Response>;
  saveBlob?: (blob: Blob, name: string) => void;
}
const failure = (code: string) => Object.assign(Error(code), { code });
export function validBackupPassphrase(value: string): boolean {
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes >= BACKUP_PASSPHRASE_MIN_BYTES && bytes <= BACKUP_PASSPHRASE_MAX_BYTES;
}
async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const raw = response.headers.get('Content-Length');
  if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) > maximum)) {
    await response.body?.cancel();
    throw failure('backup_size_limit');
  }
  if (!response.body) throw failure('backup_transfer_unconfirmed');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      received += item.value.byteLength;
      if (received > maximum) throw failure('backup_size_limit');
      chunks.push(item.value);
    }
    if (raw !== null && Number(raw) !== received) throw failure('backup_transfer_unconfirmed');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function responseFailure(response: Response): Promise<never> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf8', { fatal: true }).decode(
        await boundedBody(response, RESPONSE_JSON_LIMIT),
      ),
    );
    if (isRecord(value) && typeof value.code === 'string' && TRANSFER_CODES.has(value.code))
      throw failure(value.code);
  } catch (error) {
    if (isRecord(error) && typeof error.code === 'string' && TRANSFER_CODES.has(error.code))
      throw error;
  }
  throw failure('backup_transfer_failed');
}
export function createBackupTransfer({
  desktop = false,
  getToken = () => '',
  loadCore = () => import('@tauri-apps/api/core'),
  fetchRequest = fetch,
  saveBlob = (blob, name) => {
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  },
}: TransferOptions = {}): BackupTransfer {
  const token = () => {
    const value = getToken();
    if (!/^[a-f0-9]{64}$/i.test(value)) throw failure('backup_transfer_failed');
    return value;
  };
  const password = (value: string) => {
    if (!validBackupPassphrase(value)) throw failure('backup_passphrase_invalid');
    return value;
  };
  async function invoke(command: string, args: Record<string, unknown>) {
    try {
      return await (await loadCore()).invoke(command, args);
    } catch (error) {
      const code =
        typeof error === 'string'
          ? error
          : isRecord(error) && typeof error.code === 'string'
            ? error.code
            : '';
      throw failure(TRANSFER_CODES.has(code) ? code : 'backup_transfer_unconfirmed');
    }
  }
  return {
    async exportBackup(id, passphrase) {
      if (!backupId(id)) throw failure('backup_invalid');
      const value = password(passphrase),
        session = token();
      if (desktop) {
        const result = await invoke('export_dant_backup', {
          backupId: id,
          token: session,
          passphrase: value,
        });
        if (typeof result !== 'boolean') throw failure('backup_transfer_unconfirmed');
        return result;
      }
      const response = await fetchRequest(apiPath(`/backups/${id}/export`), {
        method: 'POST',
        headers: { 'X-Dant-Token': session, 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: value }),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(BACKUP_TRANSFER_TIMEOUT_MS),
      });
      if (!response.ok) return responseFailure(response);
      if (response.headers.get('Content-Type')?.split(';')[0] !== 'application/octet-stream')
        throw failure('backup_transfer_failed');
      const bytes = await boundedBody(response, WEB_BACKUP_MAX_BYTES);
      if (!bytes.byteLength) throw failure('backup_invalid');
      const blob = new Blob([new Uint8Array(bytes).buffer], { type: 'application/octet-stream' });
      saveBlob(blob, `dant-backup-${id}.dant`);
      return true;
    },
    async importBackup(passphrase, file) {
      const value = password(passphrase),
        session = token();
      if (desktop) {
        const result = await invoke('import_dant_backup', { token: session, passphrase: value });
        if (result === null) return null;
        if (!isBackupMetadata(result)) throw failure('backup_transfer_unconfirmed');
        return result;
      }
      if (!file || file.size === 0) throw failure('backup_invalid');
      if (file.size > WEB_BACKUP_MAX_BYTES) throw failure('backup_size_limit');
      const encoded = new TextEncoder().encode(value);
      let binary = '';
      for (const byte of encoded) binary += String.fromCharCode(byte);
      const response = await fetchRequest(apiPath('/backups/import'), {
        method: 'POST',
        headers: {
          'X-Dant-Token': session,
          'Content-Type': 'application/octet-stream',
          'X-Dant-Backup-Passphrase': btoa(binary),
        },
        body: file,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(BACKUP_TRANSFER_TIMEOUT_MS),
      });
      if (!response.ok) return responseFailure(response);
      const result: unknown = JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(
          await boundedBody(response, RESPONSE_JSON_LIMIT),
        ),
      );
      if (!isRecord(result) || !isBackupMetadata(result.backup))
        throw failure('backup_transfer_unconfirmed');
      return result.backup;
    },
  };
}
