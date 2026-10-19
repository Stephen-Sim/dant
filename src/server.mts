import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCoreDevelopment } from '../scripts/core/run.mts';

// Compatibility exports remain available to the isolated reference tests.
// Executing this historical path starts the same verified compiled Go role.
export { createApp, createWorkerApp, startApplication } from './app/server.mts';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCoreDevelopment(process.argv.slice(2));
}
