import type { Express } from 'express';
import type { ControllerBackups } from './controller-backups.mts';
import { isRecord } from '../contracts/json.mts';
import { backupError, backupId } from './backup-validation.mts';
import {
  PORTABLE_MAX_FILE_BYTES,
  PORTABLE_PASSPHRASE_MAX_BYTES as MAX_PASSPHRASE_BYTES,
} from './portable-backup.mts';

const PASSPHRASE_HEADER = 'x-dant-backup-passphrase';
type Transfer = Pick<ControllerBackups, 'exportPortable' | 'importPortable'>;

function importPassphrase(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(MAX_PASSPHRASE_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw backupError('backup_invalid', 400);
  try {
    const bytes = Buffer.from(value, 'base64');
    const passphrase = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    if (bytes.length > MAX_PASSPHRASE_BYTES || bytes.toString('base64') !== value)
      throw backupError('backup_invalid', 400);
    return passphrase;
  } catch {
    throw backupError('backup_invalid', 400);
  }
}

/** Portable transfers use only the existing authenticated Controller transport. */
export function installPortableBackupRoutes(app: Express, backups: Transfer) {
  app.post('/api/backups/import', async (req, res) => {
    if (!req.is('application/octet-stream')) throw backupError('backup_invalid', 400);
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > PORTABLE_MAX_FILE_BYTES))
      throw backupError('backup_size_limit');
    const passphrase = importPassphrase(req.headers[PASSPHRASE_HEADER]);
    const backup = await backups.importPortable(req, passphrase);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ backup });
  });
  app.post('/api/backups/:id/export', async (req, res) => {
    if (
      !backupId(req.params.id) ||
      !isRecord(req.body) ||
      typeof req.body.passphrase !== 'string' ||
      Object.keys(req.body).some((key) => key !== 'passphrase')
    )
      throw backupError('backup_invalid', 400);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="dant-backup-${req.params.id}.dant"`,
    );
    await backups.exportPortable(req.params.id, req.body.passphrase, res);
  });
}
