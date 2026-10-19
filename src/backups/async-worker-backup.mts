import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import { isRecord } from '../contracts/json.mts';
import { ordinaryDirectory } from '../files/managed-path.mts';
import { backupError } from './archive-stream.mts';
import { BACKUP_IO_TIMEOUT_MS } from './backup-constants.mts';
import {
  readBackupThreadManifest,
  readBackupThreadOptions,
} from './async-worker-backup-protocol.mts';
import { WorkerBackupStagingError } from './backup-diagnostics.mts';
import type { AsyncWorkerBackupOptions, AsyncWorkerBackupSnapshot } from './archive-types.ts';

const WORKER_MEMORY_LIMIT_MB = 256;
const TEMPORARY_PREFIX = 'dant-worker-backup-job-';

/** Copying, SQLite snapshots, hashing and archive encoding stay off the Worker API event loop. */
export async function createWorkerBackupAsync(
  options: AsyncWorkerBackupOptions,
): Promise<AsyncWorkerBackupSnapshot> {
  const signal = options.signal;
  if (signal?.aborted) throw backupError('backup_busy');
  const temporaryRoot = ordinaryDirectory(path.resolve(options.temporaryRoot || os.tmpdir())),
    input = readBackupThreadOptions({
      dataDir: path.resolve(options.dataDir),
      workspaceRoot: path.resolve(options.workspaceRoot),
      temporaryRoot,
      appVersion: options.appVersion,
      sourceId: options.sourceId,
    }),
    directory = await fs.mkdtemp(path.join(temporaryRoot, TEMPORARY_PREFIX)),
    identity = await fs.lstat(directory, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw backupError('invalid_backup');
  let thread: Worker | undefined,
    stream: Readable | undefined,
    cleanupPromise: Promise<void> | undefined,
    settled = false,
    deadline: ReturnType<typeof setTimeout> | undefined,
    rejectSnapshot: ((error: unknown) => void) | undefined;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', aborted);
      stream?.destroy();
      if (thread) await thread.terminate();
      const current = await fs.lstat(directory, { bigint: true }).catch((error: unknown) => {
        if (isRecord(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!current) return;
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      )
        throw backupError('source_changed');
      await fs.rm(directory, { recursive: true });
    })();
    return cleanupPromise;
  };
  const fail = (error: unknown) => {
    if (!settled) {
      settled = true;
      void cleanup().then(
        () => rejectSnapshot?.(error),
        () => rejectSnapshot?.(backupError('invalid_backup')),
      );
    } else if (stream && !stream.destroyed) {
      stream.destroy(backupError('invalid_backup'));
    }
  };
  const aborted = () => fail(backupError('backup_busy'));
  try {
    await fs.chmod(directory, 0o700);
    return await new Promise<AsyncWorkerBackupSnapshot>((resolve, reject) => {
      rejectSnapshot = reject;
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) return aborted();
      thread = new Worker(new URL('./worker-backup-thread.mts', import.meta.url), {
        workerData: {
          dataDir: input.dataDir,
          workspaceRoot: input.workspaceRoot,
          temporaryRoot: directory,
          appVersion: input.appVersion,
          sourceId: input.sourceId,
        },
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_LIMIT_MB },
      });
      thread.stdout.resume();
      thread.stderr.resume();
      thread.on('error', () => fail(backupError('invalid_backup')));
      thread.on('exit', (code) => {
        if (!settled || code !== 0 || (stream && !stream.destroyed && !stream.readableEnded))
          fail(backupError('invalid_backup'));
      });
      thread.on('message', (value: unknown) => {
        if (settled) return;
        try {
          if (!isRecord(value)) throw backupError('invalid_backup');
          if (value.type === 'failed') throw new WorkerBackupStagingError(value.reason);
          if (value.type !== 'ready' || !(value.stream instanceof ReadableStream))
            throw backupError('invalid_backup');
          const manifest = readBackupThreadManifest(value.manifest, input);
          stream = Readable.fromWeb(value.stream);
          stream.on('error', () => {});
          stream.once('close', () => void cleanup().catch(() => {}));
          settled = true;
          resolve({
            manifest,
            metadata: {
              createdAt: manifest.createdAt,
              appVersion: manifest.appVersion,
              files: manifest.files,
              bytes: manifest.bytes,
            },
            stream,
            cleanup,
          });
        } catch (error) {
          fail(error);
        }
      });
      deadline = setTimeout(aborted, BACKUP_IO_TIMEOUT_MS);
      deadline.unref();
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}
