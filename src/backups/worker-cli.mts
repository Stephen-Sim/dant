import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import packageInfo from '../../package.json' with { type: 'json' };
import { createWorkerBackup } from './worker-archive.mts';
import { backupError } from './archive-stream.mts';
import { withWorkerRestoreLock } from './worker-lock.mts';
import {
  inspectWorkerRestore,
  inspectWorkerRestoreRejection,
  recoverWorkerRestore,
  restoreWorkerBackup,
} from './worker-restore.mts';

const SYSTEMD_CHECK_TIMEOUT_MS = 5_000;
const SYSTEMD_START_TIMEOUT_MS = 30_000;
const SYSTEMD_OUTPUT_LIMIT = 4_096;
export interface WorkerServiceControl {
  state(): { running: boolean };
  start(): void;
}
const systemdService: WorkerServiceControl = {
  state() {
    if (process.platform !== 'linux') throw backupError('restore_failed');
    const result = spawnSync(
      'systemctl',
      [
        '--user',
        'show',
        'dant-worker.service',
        '--property=ActiveState',
        '--property=MainPID',
        '--no-pager',
      ],
      {
        encoding: 'utf8',
        timeout: SYSTEMD_CHECK_TIMEOUT_MS,
        maxBuffer: SYSTEMD_OUTPUT_LIMIT,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) throw backupError('backup_busy');
    const fields = new Map<string, string>();
    for (const line of result.stdout.trim().split('\n')) {
      const match = /^(ActiveState|MainPID)=(.*)$/.exec(line);
      if (!match || !match[1] || match[2] === undefined || fields.has(match[1]))
        throw backupError('backup_busy');
      fields.set(match[1], match[2]);
    }
    const state = fields.get('ActiveState'),
      pid = fields.get('MainPID');
    if (fields.size !== 2 || !pid || !/^(?:0|[1-9][0-9]{0,9})$/.test(pid))
      throw backupError('backup_busy');
    if (state === 'active' && Number(pid) > 0) return { running: true };
    if ((state === 'inactive' || state === 'failed') && pid === '0') return { running: false };
    throw backupError('backup_busy');
  },
  start() {
    if (process.platform !== 'linux') throw backupError('restore_failed');
    const result = spawnSync('systemctl', ['--user', 'start', 'dant-worker.service'], {
      stdio: 'ignore',
      timeout: SYSTEMD_START_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) throw backupError('restore_failed');
  },
};
/** Fixed CLI fields select owned roots only; stdin is an authenticated, decrypted archive, never commands. */
export async function runWorkerBackupCli(
  args: readonly string[],
  {
    input = process.stdin,
    output = process.stdout,
    service = systemdService,
    assertOffline = () => {
      if (service.state().running) throw backupError('backup_busy');
    },
    withLock = withWorkerRestoreLock,
  }: {
    input?: AsyncIterable<unknown>;
    output?: Writable;
    assertOffline?: () => void;
    service?: WorkerServiceControl;
    withLock?: typeof withWorkerRestoreLock;
  } = {},
) {
  const command = args[0],
    values = new Map<string, string>();
  if (
    !['restore', 'inspect', 'recover', 'export', 'finish', 'outcome'].includes(command || '') ||
    args.length % 2 !== 1
  )
    throw backupError('invalid_backup');
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !key ||
      !value ||
      !['--data-dir', '--workspace-root', '--restore-id', '--source-id'].includes(key) ||
      values.has(key)
    )
      throw backupError('invalid_backup');
    values.set(key, value);
  }
  const dataDir = values.get('--data-dir'),
    workspaceRoot = values.get('--workspace-root');
  if (
    !dataDir ||
    !workspaceRoot ||
    !path.isAbsolute(dataDir) ||
    !path.isAbsolute(workspaceRoot) ||
    dataDir.includes('\0') ||
    workspaceRoot.includes('\0')
  )
    throw backupError('invalid_backup');
  return withLock({ dataDir, workspaceRoot }, async (ownerLock) => {
    if (command === 'export') {
      if (values.has('--restore-id')) throw backupError('invalid_backup');
      assertOffline();
      const sourceId = values.get('--source-id');
      if (!sourceId) throw backupError('invalid_backup');
      const archive = createWorkerBackup({
        dataDir,
        workspaceRoot,
        sourceId,
        appVersion: packageInfo.version,
        validateCurrent: assertOffline,
      });
      try {
        await pipeline(archive.stream, output);
      } finally {
        archive.cleanup();
      }
      return;
    }
    const restoreId = values.get('--restore-id');
    if (!restoreId || values.has('--source-id')) throw backupError('invalid_backup');
    const options = { dataDir, workspaceRoot, restoreId, assertOffline, ownerLock };
    if (command === 'outcome') {
      output.write(JSON.stringify(inspectWorkerRestoreRejection(options)) + '\n');
      return;
    }
    if (command === 'finish') {
      const receipt = inspectWorkerRestore(options);
      if (!receipt.restored) throw backupError('restore_failed');
      if (!service.state().running) service.start();
      output.write(JSON.stringify(receipt) + '\n');
      return;
    }
    const receipt =
      command === 'inspect'
        ? inspectWorkerRestore(options)
        : command === 'recover'
          ? recoverWorkerRestore(options)
          : await restoreWorkerBackup({ ...options, input });
    output.write(JSON.stringify(receipt) + '\n');
  });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runWorkerBackupCli(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      'The work computer backup operation failed. Existing work was not resumed.\n',
    );
    process.exitCode = 1;
  });
}
