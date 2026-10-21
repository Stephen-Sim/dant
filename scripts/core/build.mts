import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGoToolchain, type GoRunner } from './go.mts';
import { readVersion } from '../ci/version.mts';
import { isRecord } from './manifest-json.mts';
import {
  captureCoreBuildStaging,
  publishCoreBuild,
  removeCoreBuildStaging,
  type CorePublishOptions,
} from './publish-build.mts';
import {
  CORE_BUILD_MANIFEST,
  CORE_LINUX,
  CORE_WINDOWS,
  SOURCE_COMMIT,
  describeFile,
  ordinaryDirectories,
  type BundleManifest,
} from './bundle.mts';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD_TIMEOUT_MS = 300_000;
const BUILD_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

export interface CoreBuildOptions extends CorePublishOptions {
  root?: string;
  outputDir?: string;
  run?: GoRunner;
  runGit?: GoRunner;
  fileExists?: (file: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface CoreBuildResult {
  directory: string;
  manifest: BundleManifest;
}

export function sourceCommit(
  root: string,
  { runGit = spawnSync, env = process.env }: Pick<CoreBuildOptions, 'runGit' | 'env'> = {},
): string {
  const options = {
    cwd: root,
    env,
    encoding: 'utf8' as const,
    shell: false,
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: BUILD_OUTPUT_BYTES,
  };
  const head = runGit('git', ['rev-parse', '--verify', 'HEAD'], options);
  const commit = head.stdout?.trim() ?? '';
  if (
    head.error ||
    head.status !== 0 ||
    !SOURCE_COMMIT.test(commit) ||
    (env.GITHUB_SHA !== undefined && env.GITHUB_SHA !== commit)
  )
    throw Error('A verified Git source commit is required for the core build.');
  const status = runGit('git', ['status', '--porcelain=v1', '--untracked-files=all'], options);
  if (
    status.error ||
    status.status !== 0 ||
    typeof status.stdout !== 'string' ||
    status.stdout.trim()
  )
    throw Error(
      'The Go core production build requires a clean source checkout. Commit changes first.',
    );
  return commit;
}

function buildDirectory(root: string, supplied?: string): string {
  const base = path.join(root, '.cache', 'core');
  const output = supplied ?? path.join(base, 'build');
  const relative = path.relative(base, output);
  if (
    !path.isAbsolute(output) ||
    !relative ||
    relative.includes(path.sep) ||
    !/^build(?:-[a-zA-Z0-9_-]+)?$/.test(relative)
  )
    throw Error('The Go build output must be an owned build directory inside .cache/core.');
  ordinaryDirectories(output);
  return path.resolve(output);
}

/** A clean Git status cannot prove the origin of an ignored go:embed input. */
function verifyEmbeddedSources(
  root: string,
  tool: string,
  environment: NodeJS.ProcessEnv,
  run: GoRunner,
  runGit: GoRunner,
): void {
  const options = {
    cwd: path.join(root, 'core'),
    env: environment,
    encoding: 'utf8' as const,
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: BUILD_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  };
  const listed = run(
    tool,
    [
      'list',
      '-f',
      '{"directory":{{printf "%q" .Dir}},"files":[{{range $index,$file := .EmbedFiles}}{{if $index}},{{end}}{{printf "%q" $file}}{{end}}]}',
      './...',
    ],
    options,
  );
  const tracked = runGit('git', ['ls-files', '-z', '--', 'core'], {
    ...options,
    cwd: root,
    timeout: GIT_TIMEOUT_MS,
  });
  if (
    listed.error ||
    listed.status !== 0 ||
    typeof listed.stdout !== 'string' ||
    tracked.error ||
    tracked.status !== 0 ||
    typeof tracked.stdout !== 'string'
  )
    throw Error('The embedded Go source inventory could not be verified.');

  const paths = new Set(tracked.stdout.split('\0'));
  const records = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (!records.length) throw Error('The embedded Go source inventory is empty.');
  for (const line of records) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw Error('The embedded Go source inventory is invalid.');
    }
    if (!isRecord(record) || typeof record.directory !== 'string')
      throw Error('The embedded Go source inventory is invalid.');
    const directory = path.relative(path.join(root, 'core'), record.directory);
    if (path.isAbsolute(directory) || directory === '..' || directory.startsWith('..' + path.sep))
      throw Error('The embedded Go source directory is outside the core.');
    if (record.files === null) continue;
    if (!Array.isArray(record.files)) throw Error('The embedded Go source inventory is invalid.');

    for (const file of record.files) {
      if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.includes('\0'))
        throw Error('The embedded Go source inventory is invalid.');
      const name = path
        .relative(root, path.resolve(record.directory, file))
        .split(path.sep)
        .join('/');
      if (!name.startsWith('core/') || !paths.has(name))
        throw Error(
          'Every embedded Go input must belong to the source commit, including ignored files.',
        );
      describeFile(root, name);
    }
  }
}

export function buildCore({
  root = PROJECT_ROOT,
  outputDir,
  run = spawnSync,
  runGit = spawnSync,
  fileExists,
  env = process.env,
  platform = process.platform,
  renameSync,
  pause,
}: CoreBuildOptions = {}): CoreBuildResult {
  if (!path.isAbsolute(root) || root.includes('\0'))
    throw Error('The Go core project root must be absolute.');
  ordinaryDirectories(root);
  const version = readVersion(root, env);
  const commit = sourceCommit(root, { runGit, env });
  const directory = buildDirectory(root, outputDir);
  const toolchain = resolveGoToolchain(root, {
    run,
    ...(fileExists ? { fileExists } : {}),
    env,
    platform,
  });
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  ordinaryDirectories(path.dirname(directory));
  const staging = fs.mkdtempSync(path.join(path.dirname(directory), '.dant-core-'));
  const ownedStaging = captureCoreBuildStaging(staging);
  let publicationStarted = false;
  try {
    for (const [os, name] of [
      ['windows', CORE_WINDOWS],
      ['linux', CORE_LINUX],
    ] as const) {
      const environment = {
        ...toolchain.env,
        CGO_ENABLED: '0',
        GOOS: os,
        GOARCH: 'amd64',
        GOAMD64: 'v1',
      };
      verifyEmbeddedSources(root, toolchain.go, environment, run, runGit);
      const result = run(
        toolchain.go,
        [
          'build',
          '-trimpath',
          '-buildvcs=false',
          '-ldflags',
          `-s -w -X github.com/Stephen-Sim/dant/core/internal/buildinfo.Version=${version} -X github.com/Stephen-Sim/dant/core/internal/buildinfo.Source=${commit}`,
          '-o',
          path.join(staging, name),
          './cmd/dant-core',
        ],
        {
          cwd: path.join(root, 'core'),
          env: environment,
          encoding: 'utf8',
          timeout: BUILD_TIMEOUT_MS,
          maxBuffer: BUILD_OUTPUT_BYTES,
          shell: false,
          windowsHide: true,
        },
      );
      if (result.error || result.status !== 0) throw Error(`Go core ${os} build failed.`);
      if (os === 'linux') fs.chmodSync(path.join(staging, name), 0o755);
    }
    if (sourceCommit(root, { runGit, env }) !== commit)
      throw Error('The source checkout changed during the core build.');
    const manifest: BundleManifest = {
      schemaVersion: 1,
      version,
      sourceCommit: commit,
      files: [describeFile(staging, CORE_WINDOWS), describeFile(staging, CORE_LINUX)],
    };
    fs.writeFileSync(
      path.join(staging, CORE_BUILD_MANIFEST),
      JSON.stringify(manifest, null, 2) + '\n',
      { mode: 0o600 },
    );
    buildDirectory(root, directory);
    fs.rmSync(directory, { recursive: true, force: true });
    publicationStarted = true;
    publishCoreBuild(ownedStaging, directory, manifest, {
      platform,
      ...(renameSync ? { renameSync } : {}),
      ...(pause ? { pause } : {}),
    });
    return { directory, manifest };
  } finally {
    if (!publicationStarted) removeCoreBuildStaging(ownedStaging);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out'))
    throw Error('Usage: node scripts/core/build.mts [--out absolute-build-directory]');
  buildCore(args[1] ? { outputDir: args[1] } : {});
  console.log(
    'Windows Controller and Linux Worker core binaries built from the verified source commit.',
  );
}
