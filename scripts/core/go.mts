import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

export const GO_VERSION = '1.27.2';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GO_PROBE_TIMEOUT_MS = 10_000;
const GO_COMMAND_TIMEOUT_MS = 300_000;
const GO_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const GO_ROOT_MAX_CHARS = 4096;
const GO_TEST_TIMEOUT = '120s';
const modes = ['format', 'format-check', 'vet', 'test', 'check', 'race'] as const;
export type CoreGoMode = (typeof modes)[number];
interface GoResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}
export type GoRunner = (
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => GoResult;
interface ToolOptions {
  run?: GoRunner;
  fileExists?: (file: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
export interface GoToolchain {
  go: string;
  gofmt: string;
  env: NodeJS.ProcessEnv;
}
const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** No ambient Go workspace, compiler download or saved Go environment participates. */
export function goEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...env,
    GOTOOLCHAIN: 'local',
    GOENV: 'off',
    GOWORK: 'off',
    GOFLAGS: '-mod=readonly',
    GOTELEMETRY: 'off',
  };
  delete result.GOROOT;
  return result;
}

/** Prefer the explicitly installed compiler; an old PATH Go is an error, not a fallback. */
export function resolveGoToolchain(
  root = PROJECT_ROOT,
  {
    run = spawnSync,
    fileExists = isFile,
    env = process.env,
    platform = process.platform,
  }: ToolOptions = {},
): GoToolchain {
  const suffix = platform === 'win32' ? '.exe' : '';
  const local = path.join(root, '.tools', `go${GO_VERSION}`, 'go', 'bin', 'go' + suffix);
  const go = fileExists(local) ? local : 'go';
  const environment = goEnvironment(env);
  const options = {
    cwd: root,
    env: environment,
    encoding: 'utf8' as const,
    timeout: GO_PROBE_TIMEOUT_MS,
    maxBuffer: GO_OUTPUT_LIMIT_BYTES,
    windowsHide: true,
    shell: false,
  };
  const version = run(go, ['version'], options);
  const reported = version.stdout?.match(
    /^go version go(\d+\.\d+\.\d+) [a-z0-9]+\/[a-z0-9]+\r?\n?$/,
  );
  if (version.error || version.status !== 0 || reported?.[1] !== GO_VERSION)
    throw Error(
      `Go ${GO_VERSION} is required. Install that exact official toolchain; automatic compiler downloads are disabled.`,
    );
  const location = run(go, ['env', 'GOROOT'], options);
  const goroot = location.stdout?.trim() ?? '';
  if (
    location.error ||
    location.status !== 0 ||
    !path.isAbsolute(goroot) ||
    goroot.length > GO_ROOT_MAX_CHARS ||
    /[\r\n\0]/.test(goroot)
  )
    throw Error('The pinned Go toolchain root could not be verified.');
  const gofmt = path.join(goroot, 'bin', 'gofmt' + suffix);
  if (!fileExists(gofmt)) throw Error('The matching pinned Go formatter is unavailable.');
  return { go, gofmt, env: environment };
}

export function coreGoMode(args: readonly string[]): CoreGoMode {
  const mode = args[0];
  if (args.length !== 1 || !modes.some((value) => value === mode))
    throw Error('Usage: node scripts/core/go.mts format|format-check|vet|test|check|race');
  return mode as CoreGoMode;
}

export function runCoreGo(
  mode: CoreGoMode,
  {
    root = PROJECT_ROOT,
    run = spawnSync,
    fileExists = isFile,
    env = process.env,
    platform = process.platform,
    write = (text: string) => {
      process.stdout.write(text);
    },
  }: ToolOptions & { root?: string; write?: (text: string) => void } = {},
): void {
  if (mode === 'race' && platform !== 'linux')
    throw Error('The core race check requires Linux and a working C compiler.');
  const toolchain = resolveGoToolchain(root, { run, fileExists, env, platform });
  const steps: readonly CoreGoMode[] = mode === 'check' ? ['format-check', 'vet', 'test'] : [mode];
  for (const step of steps) {
    const formatting = step === 'format' || step === 'format-check';
    const args =
      step === 'format'
        ? ['-w', '.']
        : step === 'format-check'
          ? ['-l', '.']
          : step === 'vet'
            ? ['vet', './...']
            : [
                'test',
                ...(step === 'race' ? ['-race'] : []),
                '-count=1',
                '-timeout=' + GO_TEST_TIMEOUT,
                './...',
              ];
    const result = run(formatting ? toolchain.gofmt : toolchain.go, args, {
      cwd: path.join(root, 'core'),
      env: step === 'race' ? { ...toolchain.env, CGO_ENABLED: '1' } : toolchain.env,
      encoding: 'utf8',
      timeout: GO_COMMAND_TIMEOUT_MS,
      maxBuffer: GO_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
      shell: false,
    });
    if (result.stdout) write(result.stdout);
    if (result.stderr) write(result.stderr);
    if (result.error || result.status !== 0) throw Error(`Go core ${step} failed.`);
    if (step === 'format-check' && result.stdout?.trim())
      throw Error('Go source formatting differs; run npm run format:go.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCoreGo(coreGoMode(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Go core check failed.');
    process.exitCode = 1;
  }
}
