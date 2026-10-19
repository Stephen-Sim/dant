import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildPaths } from './ci/build-paths.mts';
import { readVersion } from './ci/version.mts';
import { assertNodeRuntime } from './ci/node-runtime.mts';
import { spawnSync } from 'node:child_process';
import type { NodeProbeRunner } from './ci/node-runtime.mts';
import { errorCode, isRecord } from '../src/contracts/json.mts';

interface ReplaceOptions {
  renameSync?: typeof fs.renameSync;
  platform?: NodeJS.Platform;
  pause?: (milliseconds: number) => unknown;
}
interface ResourceOptions extends ReplaceOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}
interface PrepareResourceOptions extends ResourceOptions {
  nodeExecutable?: string;
  runNode?: NodeProbeRunner;
}
const PACKAGING_RENAME_ATTEMPTS = 6;
const PACKAGING_RENAME_DELAY_MS = 25;

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = ['src', 'dist', 'node_modules', 'scripts', 'vm'],
  files = ['package.json', 'package-lock.json', 'LICENSE'];
const retryCodes = new Set(['EPERM', 'EACCES', 'EBUSY']),
  pauseBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    !!relative &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep)
  );
};

// Reject junctions as well as symlinks on the output and every existing ancestor.
// A lexical prefix alone is insufficient before a recursive Windows cleanup.
function ordinaryAncestors(target: string): void {
  for (let current = target; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw Error('Packaging directories must be ordinary directories, never links or junctions.');
    if (path.dirname(current) === current) break;
  }
}
function directory(target: string): void {
  ordinaryAncestors(target);
  if (!fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory())
    throw Error('Missing required packaging directory: ' + path.basename(target));
}
function file(target: string): void {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  ordinaryAncestors(path.dirname(target));
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size === 0)
    throw Error('Missing or unsafe required packaging file: ' + path.basename(target));
}
function project(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0'))
    throw Error('Packaging project root must be absolute.');
  root = path.resolve(root);
  directory(root);
  for (const name of [...files, 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml'])
    file(path.join(root, name));
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')),
    lock: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (
    !isRecord(pkg) ||
    !isRecord(lock) ||
    pkg.name !== 'dant' ||
    lock.name !== 'dant' ||
    lock.version !== pkg.version
  )
    throw Error('Packaging requires the matching dant project package and lockfile.');
  readVersion(root, {});
  return root;
}
export function assertGeneratedPath(root: string, target: unknown, env = process.env): string {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0'))
    throw Error('Generated packaging path must be absolute.');
  const paths = resolveBuildPaths(root, env),
    resolved = path.resolve(target);
  let base;
  if (samePath(resolved, paths.resources)) base = path.resolve(root);
  else if (samePath(resolved, paths.backend)) base = paths.target;
  else throw Error('Refusing to clean a directory outside the generated packaging outputs.');
  if (!inside(base, resolved))
    throw Error('Generated packaging output must stay inside its intended root.');
  ordinaryAncestors(resolved);
  return resolved;
}
function removeStaging(parent: string, staging: string): void {
  const relative = path.relative(parent, staging);
  if (
    !relative ||
    relative.includes(path.sep) ||
    !relative.startsWith('.dant-resources-') ||
    path.isAbsolute(relative)
  )
    throw Error('Refusing to clean an unowned packaging staging directory.');
  ordinaryAncestors(staging);
  fs.rmSync(staging, { recursive: true, force: true });
}
function replaceTree(
  root: string,
  target: string,
  env: NodeJS.ProcessEnv,
  copy: (staging: string) => void,
  {
    renameSync = fs.renameSync,
    platform = process.platform,
    pause = (ms: number) => Atomics.wait(pauseBuffer, 0, 0, ms),
  }: ReplaceOptions = {},
): string {
  const destination = assertGeneratedPath(root, target, env),
    parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  ordinaryAncestors(parent);
  const staging = fs.mkdtempSync(path.join(parent, '.dant-resources-'));
  try {
    copy(staging);
    // Revalidate immediately before removing only this exact generated directory.
    assertGeneratedPath(root, destination, env);
    fs.rmSync(destination, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    for (let attempt = 0; attempt < PACKAGING_RENAME_ATTEMPTS; attempt++) {
      try {
        renameSync(staging, destination);
        break;
      } catch (error) {
        if (
          platform !== 'win32' ||
          !retryCodes.has(errorCode(error) ?? '') ||
          attempt + 1 === PACKAGING_RENAME_ATTEMPTS
        )
          throw error;
        pause((attempt + 1) * PACKAGING_RENAME_DELAY_MS);
      }
    }
  } finally {
    if (fs.existsSync(staging)) removeStaging(parent, staging);
  }
  return destination;
}
const copyDirectory = (source: string, destination: string): void =>
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) =>
      !path
        .relative(source, entry)
        .split(path.sep)
        .some(
          (part) => part === '.cache' || part === '__pycache__' || /^\.env(?:\.|$)/i.test(part),
        ),
  });
function validateSources(root: string): void {
  for (const name of directories) directory(path.join(root, name));
  for (const name of ['src/server.mts', 'dist/index.html', 'node_modules/express/package.json'])
    file(path.join(root, name));
}
export function prepareResources({
  projectRoot = defaultRoot,
  nodeExecutable = process.execPath,
  runNode = spawnSync,
  env = process.env,
  ...replaceOptions
}: PrepareResourceOptions = {}) {
  const root = project(projectRoot);
  validateSources(root);
  file(nodeExecutable);
  assertNodeRuntime(nodeExecutable, { run: runNode });
  const { resources } = resolveBuildPaths(root, env);
  return replaceTree(
    root,
    resources,
    env,
    (staging) => {
      for (const name of directories)
        copyDirectory(path.join(root, name), path.join(staging, name));
      for (const name of files) fs.copyFileSync(path.join(root, name), path.join(staging, name));
      fs.copyFileSync(nodeExecutable, path.join(staging, 'node.exe'));
    },
    replaceOptions,
  );
}
export function stageReleaseResources({
  projectRoot = defaultRoot,
  env = process.env,
  ...replaceOptions
}: ResourceOptions = {}) {
  const root = project(projectRoot),
    { resources, backend } = resolveBuildPaths(root, env);
  assertGeneratedPath(root, resources, env);
  directory(resources);
  validateSources(resources);
  for (const name of [...files, 'node.exe']) file(path.join(resources, name));
  const expected = new Set([...directories, ...files, 'node.exe']);
  if (fs.readdirSync(resources).some((name) => !expected.has(name)))
    throw Error(
      'Prepared backend contains unexpected files. Prepare clean resources before staging.',
    );
  const sourcePackage: unknown = JSON.parse(
      fs.readFileSync(path.join(resources, 'package.json'), 'utf8'),
    ),
    currentPackage: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (
    !isRecord(sourcePackage) ||
    !isRecord(currentPackage) ||
    sourcePackage.name !== 'dant' ||
    sourcePackage.version !== currentPackage.version
  )
    throw Error('Prepared backend version does not match the current dant project.');
  if (inside(resources, backend) || inside(backend, resources) || samePath(resources, backend))
    throw Error('Generated backend and resources directories must not overlap.');
  return replaceTree(
    root,
    backend,
    env,
    (staging) => {
      for (const name of directories)
        copyDirectory(path.join(resources, name), path.join(staging, name));
      for (const name of [...files, 'node.exe'])
        fs.copyFileSync(path.join(resources, name), path.join(staging, name));
    },
    replaceOptions,
  );
}
if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--stage-release')) {
    stageReleaseResources();
    console.log('Standalone desktop runtime staged beside dant.exe.');
  } else {
    prepareResources();
    console.log('Desktop backend resources prepared. User data and VM keys excluded.');
  }
}
