import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

export interface NodeProbeResult {
  status: number | null;
  stdout?: string;
  error?: Error;
}
export type NodeProbeRunner = (
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => NodeProbeResult;
export const NODE_RUNTIME_TIMEOUT_MS = 15_000;

export const NODE_RUNTIME_ACK = 'dant-typescript-tooling-ok';
export const NODE_RUNTIME_PROBE = `
const [major, minor] = process.versions.node.split('.').map(Number);
const supported: boolean = ((major === 22 && minor >= 18) || major >= 24)
  && ['strip', 'transform'].includes(process.features.typescript);
if (!supported) process.exit(1);
process.stdout.write("${NODE_RUNTIME_ACK}");
`;

export function assertNodeRuntime(
  executable = process.execPath,
  { run = spawnSync }: { run?: NodeProbeRunner } = {},
): void {
  const result = run(executable, ['--input-type=module-typescript', '--eval', NODE_RUNTIME_PROBE], {
    encoding: 'utf8',
    timeout: NODE_RUNTIME_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0 || result.stdout !== NODE_RUNTIME_ACK) {
    throw Error(
      'Node.js 22.18+ LTS or 24+ with native TypeScript support is required for development tooling.',
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeRuntime();
  console.log('Native TypeScript tooling runtime verified.');
}
