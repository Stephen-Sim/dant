import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildPaths } from './ci/build-paths.mts';
import { readVersion } from './ci/version.mts';
import { errorCode, isRecord } from './core/manifest-json.mts';
import { buildCore, sourceCommit, type CoreBuildOptions } from './core/build.mts';
import type { GoRunner } from './core/go.mts';
import {
  CORE_WINDOWS,
  CORE_LINUX,
  CORE_GUEST_BINARY,
  CORE_LICENSE,
  CORE_LICENSE_SOURCE,
  CORE_UNICODE_LICENSE,
  CORE_UNICODE_LICENSE_SOURCE,
  CORE_BUILD_MANIFEST,
  CORE_RESOURCE_MANIFEST,
  CORE_BUNDLE_MANIFEST,
  VM_BUNDLE_FILES,
  HOST_HELPERS,
  describeFile,
  readManifest,
  verifyFiles,
  type BundleManifest,
} from './core/bundle.mts';

interface ReplaceOptions {
  renameSync?: typeof fs.renameSync;
  platform?: NodeJS.Platform;
  pause?: (milliseconds: number) => unknown;
}
interface ResourceOptions extends ReplaceOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  runGit?: GoRunner;
}
interface PrepareResourceOptions extends ResourceOptions {
  build?: typeof buildCore;
  buildOptions?: Omit<CoreBuildOptions, 'root'>;
}
const PACKAGING_RENAME_ATTEMPTS = 6;
const PACKAGING_RENAME_DELAY_MS = 25;

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = ['dist'],
  files = ['package.json', 'LICENSE'];
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
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0)
    throw Error('Missing or unsafe required packaging file: ' + path.basename(target));
}
function project(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0'))
    throw Error('Packaging project root must be absolute.');
  root = path.resolve(root);
  directory(root);
  for (const name of [
    ...files,
    'package-lock.json',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
    CORE_LICENSE_SOURCE,
    CORE_UNICODE_LICENSE_SOURCE,
  ])
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
const omitted = (name: string) =>
  name === '.cache' || name === '__pycache__' || /^\.env(?:\.|$)/i.test(name);
function copyDirectory(source: string, destination: string): void {
  directory(source);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (omitted(entry.name)) continue;
    const from = path.join(source, entry.name),
      to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else {
      file(from);
      fs.copyFileSync(from, to);
    }
  }
}
function validateSources(root: string): void {
  for (const name of directories) directory(path.join(root, name));
  for (const name of [
    'dist/index.html',
    ...HOST_HELPERS,
    ...VM_BUNDLE_FILES.filter((name) => name !== CORE_GUEST_BINARY),
  ])
    file(path.join(root, name));
}

const hostManifestPath = 'resources/core/' + CORE_BUILD_MANIFEST;
function copyFile(root: string, staging: string, name: string): void {
  const destination = path.join(staging, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, name), destination);
}

/** Stage validation accepts only compiled core, static UI and fixed VM helpers. */
function resourceInventory(root: string): string[] {
  const expected = new Set([
    ...files,
    CORE_WINDOWS,
    CORE_LICENSE,
    CORE_UNICODE_LICENSE,
    CORE_RESOURCE_MANIFEST,
    CORE_BUNDLE_MANIFEST,
    hostManifestPath,
    ...HOST_HELPERS,
    ...VM_BUNDLE_FILES,
  ]);
  const inventory: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name),
        relative = path.relative(root, target).split(path.sep).join('/');
      if (omitted(entry.name) || entry.isSymbolicLink())
        throw Error('Prepared backend contains unexpected files.');
      if (entry.isDirectory()) {
        if (
          relative !== 'dist' &&
          !relative.startsWith('dist/') &&
          ![...expected].some((name) => name.startsWith(relative + '/'))
        )
          throw Error('Prepared backend contains unexpected files.');
        directory(target);
        walk(target);
      } else {
        file(target);
        if (!relative.startsWith('dist/') && !expected.has(relative))
          throw Error('Prepared backend contains unexpected files.');
        inventory.push(relative);
      }
    }
  };
  walk(root);
  return inventory.sort();
}

export function validatePreparedResources(
  root: string,
  version: string,
  source?: string,
): BundleManifest {
  const inventory = resourceInventory(root).filter((name) => name !== CORE_RESOURCE_MANIFEST);
  const resourceManifest = readManifest(
    path.join(root, CORE_RESOURCE_MANIFEST),
    inventory,
    version,
    source,
  );
  verifyFiles(root, resourceManifest);
  const bundle = readManifest(
    path.join(root, CORE_BUNDLE_MANIFEST),
    VM_BUNDLE_FILES,
    version,
    resourceManifest.sourceCommit,
  );
  verifyFiles(root, bundle);
  const host = readManifest(
    path.join(root, hostManifestPath),
    [CORE_WINDOWS, CORE_LINUX],
    version,
    bundle.sourceCommit,
  );
  for (const expected of host.files) {
    const actual = describeFile(
      root,
      expected.path === CORE_LINUX ? CORE_GUEST_BINARY : CORE_WINDOWS,
    );
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw Error('A prepared core binary does not match its build provenance.');
  }
  file(path.join(root, 'dist/index.html'));
  file(path.join(root, CORE_LICENSE));
  file(path.join(root, CORE_UNICODE_LICENSE));
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!isRecord(pkg) || pkg.name !== 'dant' || pkg.version !== version)
    throw Error('Prepared backend version does not match the current dant project.');
  return bundle;
}

export function prepareResources({
  projectRoot = defaultRoot,
  build = buildCore,
  buildOptions = {},
  runGit,
  env = process.env,
  ...replaceOptions
}: PrepareResourceOptions = {}) {
  const root = project(projectRoot);
  validateSources(root);
  const git = runGit ?? buildOptions.runGit;
  const version = readVersion(root, env),
    commit = sourceCommit(root, { ...(git ? { runGit: git } : {}), env });
  const built = build({ ...buildOptions, ...(git ? { runGit: git } : {}), root, env });
  const manifest = readManifest(
    path.join(built.directory, CORE_BUILD_MANIFEST),
    [CORE_WINDOWS, CORE_LINUX],
    version,
    commit,
  );
  verifyFiles(built.directory, manifest);
  const { resources } = resolveBuildPaths(root, env);
  return replaceTree(
    root,
    resources,
    env,
    (staging) => {
      for (const name of directories)
        copyDirectory(path.join(root, name), path.join(staging, name));
      for (const name of files) fs.copyFileSync(path.join(root, name), path.join(staging, name));
      fs.copyFileSync(path.join(root, CORE_LICENSE_SOURCE), path.join(staging, CORE_LICENSE));
      fs.copyFileSync(
        path.join(root, CORE_UNICODE_LICENSE_SOURCE),
        path.join(staging, CORE_UNICODE_LICENSE),
      );
      for (const name of HOST_HELPERS) copyFile(root, staging, name);
      for (const name of VM_BUNDLE_FILES) {
        if (name === CORE_GUEST_BINARY) {
          fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
          fs.copyFileSync(path.join(built.directory, CORE_LINUX), path.join(staging, name));
        } else copyFile(root, staging, name);
      }
      fs.copyFileSync(path.join(built.directory, CORE_WINDOWS), path.join(staging, CORE_WINDOWS));
      fs.copyFileSync(
        path.join(built.directory, CORE_BUILD_MANIFEST),
        path.join(staging, hostManifestPath),
      );
      const bundle: BundleManifest = {
        schemaVersion: 1,
        version,
        sourceCommit: commit,
        files: VM_BUNDLE_FILES.map((name) => describeFile(staging, name)),
      };
      fs.writeFileSync(
        path.join(staging, CORE_BUNDLE_MANIFEST),
        JSON.stringify(bundle, null, 2) + '\n',
      );
      const resourceManifest: BundleManifest = {
        schemaVersion: 1,
        version,
        sourceCommit: commit,
        files: resourceInventory(staging).map((name) => describeFile(staging, name)),
      };
      fs.writeFileSync(
        path.join(staging, CORE_RESOURCE_MANIFEST),
        JSON.stringify(resourceManifest, null, 2) + '\n',
      );
      validatePreparedResources(staging, version, commit);
    },
    replaceOptions,
  );
}
export function stageReleaseResources({
  projectRoot = defaultRoot,
  env = process.env,
  runGit,
  ...replaceOptions
}: ResourceOptions = {}) {
  const root = project(projectRoot),
    { resources, backend } = resolveBuildPaths(root, env);
  assertGeneratedPath(root, resources, env);
  directory(resources);
  validateSources(resources);
  const version = readVersion(root, env);
  const commit = sourceCommit(root, { ...(runGit ? { runGit } : {}), env });
  validatePreparedResources(resources, version, commit);
  if (inside(resources, backend) || inside(backend, resources) || samePath(resources, backend))
    throw Error('Generated backend and resources directories must not overlap.');
  return replaceTree(
    root,
    backend,
    env,
    (staging) => {
      copyDirectory(resources, staging);
      validatePreparedResources(staging, version);
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
