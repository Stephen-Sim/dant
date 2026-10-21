import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createCoreGoTestOverlay } from './test-layout.mts';
import type { CoreGoTestOverlay } from './test-layout.mts';
import {
  appendGoCoverageSummary,
  assessGoCoverage,
  createGoCoverageReport,
  parseGoCoverage,
} from './coverage.mts';
import type { GoCoverageReport } from './coverage.mts';

export const GO_VERSION = '1.27.2';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GO_PROBE_TIMEOUT_MS = 10_000;
const GO_COMMAND_TIMEOUT_MS = 600_000;
const GO_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const GO_ROOT_MAX_CHARS = 4096;
const GO_TEST_TIMEOUT = '120s';
const GO_TEST_PACKAGE_PARALLELISM = 2;
const GO_TEST_CASE_PARALLELISM = 4;
const modes = ['format', 'format-check', 'vet', 'test', 'coverage', 'check', 'race'] as const;
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
    throw Error('Usage: node scripts/core/go.mts format|format-check|vet|test|coverage|check|race');
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
    createTestOverlay = createCoreGoTestOverlay,
    createCoverageReport = createGoCoverageReport,
  }: ToolOptions & {
    root?: string;
    write?: (text: string) => void;
    createTestOverlay?: (root: string) => CoreGoTestOverlay;
    createCoverageReport?: (root: string) => GoCoverageReport;
  } = {},
): void {
  if (mode === 'race' && platform !== 'linux')
    throw Error('The core race check requires Linux and a working C compiler.');
  const coverage = mode === 'check' || mode === 'coverage' ? createCoverageReport(root) : undefined;
  let overlay: CoreGoTestOverlay | undefined;
  const steps: readonly CoreGoMode[] =
    mode === 'check' ? ['format-check', 'vet', 'coverage'] : [mode];
  try {
    const toolchain = resolveGoToolchain(root, { run, fileExists, env, platform });
    overlay = createTestOverlay(root);
    for (const step of steps) {
      if (step === 'coverage') {
        if (!coverage) throw Error('The Go coverage run has no fresh report.');
        const report = coverage;
        const options = {
          cwd: path.join(root, 'core'),
          env: toolchain.env,
          encoding: 'utf8' as const,
          timeout: GO_COMMAND_TIMEOUT_MS,
          maxBuffer: GO_OUTPUT_LIMIT_BYTES,
          windowsHide: true,
          shell: false,
        };
        const listed = run(toolchain.go, ['list', '-f={{.ImportPath}}', './...'], options);
        if (listed.error || listed.status !== 0)
          throw Error('Go coverage package discovery failed.');
        const expected = listed.stdout?.trim().split(/\r?\n/) ?? [];
        const result = run(
          toolchain.go,
          [
            'test',
            '-overlay=' + overlay.file,
            '-p=' + GO_TEST_PACKAGE_PARALLELISM,
            '-parallel=' + GO_TEST_CASE_PARALLELISM,
            '-count=1',
            '-timeout=' + GO_TEST_TIMEOUT,
            '-covermode=atomic',
            '-coverpkg=./...',
            '-coverprofile=' + report.file,
            './...',
          ],
          options,
        );
        if (result.stdout) write(result.stdout);
        if (result.stderr) write(result.stderr);
        if (result.error || result.status !== 0) throw Error('Go core coverage tests failed.');
        const assessed = assessGoCoverage(parseGoCoverage(report.read()), expected);
        report.save(assessed);
        appendGoCoverageSummary(assessed, env.GITHUB_STEP_SUMMARY);
        for (const name of assessed.required) {
          const item = assessed.packages.find((entry) => entry.package === name);
          if (item) write(`${name}: ${item.percent.toFixed(2)}% Go statements\n`);
        }
        if (assessed.failures.length) throw Error(assessed.failures.join('\n'));
        continue;
      }
      const formatting = step === 'format' || step === 'format-check';
      const args =
        step === 'format'
          ? ['-w', 'core', 'tests/go']
          : step === 'format-check'
            ? ['-l', 'core', 'tests/go']
            : step === 'vet'
              ? ['vet', '-overlay=' + overlay.file, './...']
              : [
                  'test',
                  '-overlay=' + overlay.file,
                  ...(step === 'race' ? ['-race'] : []),
                  '-p=' + GO_TEST_PACKAGE_PARALLELISM,
                  '-parallel=' + GO_TEST_CASE_PARALLELISM,
                  '-count=1',
                  '-timeout=' + GO_TEST_TIMEOUT,
                  './...',
                ];
      const result = run(formatting ? toolchain.gofmt : toolchain.go, args, {
        cwd: formatting ? root : path.join(root, 'core'),
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
  } finally {
    try {
      overlay?.close();
    } finally {
      coverage?.close();
    }
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
