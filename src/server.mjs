import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApplication } from './app/server.mjs';

// Stable entrypoint used by the desktop launcher, VM service and npm scripts.
export { createApp, createWorkerApp, startApplication } from './app/server.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startApplication();
}
