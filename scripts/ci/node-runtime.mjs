import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_RUNTIME_PROBE = `
const [major, minor] = process.versions.node.split('.').map(Number);
const supported: boolean = ((major === 22 && minor >= 18) || major >= 24)
  && ['strip', 'transform'].includes(process.features.typescript);
if (!supported) process.exit(1);
process.stdout.write('dant-typescript-runtime-ok');
`;

export function assertNodeRuntime(executable = process.execPath, { run = spawnSync } = {}) {
  const result = run(executable, ['--input-type=module-typescript', '--eval', NODE_RUNTIME_PROBE], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0 || result.stdout !== 'dant-typescript-runtime-ok') {
    throw Error('Node.js 22.18+ LTS or 24+ with native TypeScript support is required.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeRuntime();
  console.log('Native TypeScript runtime verified.');
}
