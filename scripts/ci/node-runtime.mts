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

export const NODE_RUNTIME_ACK = 'dant-typescript-sqlite-runtime-ok';
export const NODE_RUNTIME_PROBE = `
const [major, minor] = process.versions.node.split('.').map(Number);
const supported: boolean = ((major === 22 && minor >= 18) || major >= 24)
  && ['strip', 'transform'].includes(process.features.typescript);
if (!supported) process.exit(1);
const {DatabaseSync} = await import("node:sqlite");
const database = new DatabaseSync(":memory:", {enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false});
try {
  database.exec("CREATE VIRTUAL TABLE runtime_search USING fts5(text)");
  database.prepare("INSERT INTO runtime_search(text) VALUES (?)").run("dant");
  if (database.prepare("SELECT text FROM runtime_search WHERE runtime_search MATCH ?").get("dant")?.text !== "dant") process.exitCode = 1;
} finally {
  database.close();
}
if (process.exitCode) process.exit(process.exitCode);
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
      'Node.js 22.18+ LTS or 24+ with native TypeScript, built-in SQLite and FTS5 support is required.',
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNodeRuntime();
  console.log('Native TypeScript, SQLite and FTS5 runtime verified.');
}
