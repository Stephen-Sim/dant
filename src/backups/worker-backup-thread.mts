import { parentPort, workerData } from 'node:worker_threads';
import { Readable } from 'node:stream';
import { createWorkerBackup } from './worker-archive.mts';
import { readBackupThreadOptions } from './async-worker-backup-protocol.mts';
import { workerBackupFailure } from './backup-diagnostics.mts';

if (parentPort) {
  const port = parentPort;
  try {
    const input: unknown = workerData,
      snapshot = createWorkerBackup(readBackupThreadOptions(input)),
      stream = Readable.toWeb(snapshot.stream);
    // Keep the producing isolate alive while the transferred stream applies
    // backpressure. The owner terminates it only after closing the reader.
    port.on('message', () => {});
    port.postMessage({ type: 'ready', manifest: snapshot.manifest, stream }, [stream]);
  } catch (error) {
    port.postMessage({ type: 'failed', reason: workerBackupFailure(error).reason });
  }
}
