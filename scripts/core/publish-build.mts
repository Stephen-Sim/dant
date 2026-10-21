import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { errorCode } from './manifest-json.mts';
import {
  CORE_BUILD_MANIFEST,
  CORE_LINUX,
  CORE_WINDOWS,
  describeFile,
  ordinaryDirectories,
  readManifest,
  verifyFiles,
  type BundleFile,
  type BundleManifest,
} from './bundle.mts';

const PUBLISH_ATTEMPTS = 6;
const PUBLISH_DELAY_MS = 50;
const LOCK_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const BUILD_FILES = [CORE_BUILD_MANIFEST, CORE_LINUX, CORE_WINDOWS].sort();
const PUBLISH_CHANGED = 'The verified core build changed during publication.';
const PUBLISH_FAILED = 'The verified core build could not be published.';
const pauseBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface CorePublishOptions {
  renameSync?: typeof fs.renameSync;
  platform?: NodeJS.Platform;
  pause?: (milliseconds: number) => unknown;
}
export interface CoreBuildStaging {
  directory: string;
  identity: fs.BigIntStats;
  ancestors: readonly { directory: string; identity: fs.BigIntStats }[];
}
interface BuildFileSeal {
  identity: fs.BigIntStats;
  description: BundleFile;
}

function requireBuild(condition: unknown): asserts condition {
  if (!condition) throw Error(PUBLISH_CHANGED);
}
function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}
function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
function assertAncestors(staging: CoreBuildStaging): void {
  for (const ancestor of staging.ancestors) {
    const current = fs.lstatSync(ancestor.directory, { bigint: true });
    requireBuild(
      current.isDirectory() &&
        !current.isSymbolicLink() &&
        sameIdentity(current, ancestor.identity),
    );
  }
}
function requireStaging(staging: CoreBuildStaging): fs.BigIntStats {
  assertAncestors(staging);
  const current = fs.lstatSync(staging.directory, { bigint: true });
  requireBuild(
    current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, staging.identity),
  );
  return current;
}

/** Capture only the freshly-created sibling staging directory and its ordinary ancestors. */
export function captureCoreBuildStaging(directory: string): CoreBuildStaging {
  requireBuild(
    path.isAbsolute(directory) && /^\.dant-core-[A-Za-z0-9]{6}$/.test(path.basename(directory)),
  );
  ordinaryDirectories(directory);
  const ancestors: { directory: string; identity: fs.BigIntStats }[] = [];
  for (let current = path.dirname(directory); ; current = path.dirname(current)) {
    ancestors.push({ directory: current, identity: fs.lstatSync(current, { bigint: true }) });
    if (path.dirname(current) === current) break;
  }
  const result = { directory, identity: fs.lstatSync(directory, { bigint: true }), ancestors };
  requireStaging(result);
  return result;
}

function inventory(directory: string): Map<string, BuildFileSeal> {
  requireBuild(isDeepStrictEqual(fs.readdirSync(directory).sort(), BUILD_FILES));
  const result = new Map<string, BuildFileSeal>();
  for (const name of BUILD_FILES) {
    const file = path.join(directory, name);
    const before = fs.lstatSync(file, { bigint: true });
    const description = describeFile(directory, name);
    requireBuild(sameFile(before, fs.lstatSync(file, { bigint: true })));
    result.set(name, { identity: before, description });
  }
  return result;
}
function assertFiles(directory: string, expected: ReadonlyMap<string, BuildFileSeal>): void {
  const current = inventory(directory);
  for (const [name, before] of expected) {
    const after = current.get(name);
    requireBuild(
      after &&
        sameFile(before.identity, after.identity) &&
        isDeepStrictEqual(before.description, after.description),
    );
  }
}

/** Retry only a proven-unsent local directory rename, never compilation or an external action. */
export function publishCoreBuild(
  staging: CoreBuildStaging,
  destination: string,
  manifest: BundleManifest,
  {
    renameSync = fs.renameSync,
    platform = process.platform,
    pause = (ms) => Atomics.wait(pauseBuffer, 0, 0, ms),
  }: CorePublishOptions = {},
): void {
  requireBuild(
    path.dirname(destination) === path.dirname(staging.directory) &&
      /^build(?:-[a-zA-Z0-9_-]+)?$/.test(path.basename(destination)),
  );
  const source = requireStaging(staging);
  const files = inventory(staging.directory);
  const actual = readManifest(
    path.join(staging.directory, CORE_BUILD_MANIFEST),
    [CORE_WINDOWS, CORE_LINUX],
    manifest.version,
    manifest.sourceCommit,
  );
  requireBuild(isDeepStrictEqual(actual, manifest));
  verifyFiles(staging.directory, manifest);
  assertFiles(staging.directory, files);
  requireBuild(sameFile(source, requireStaging(staging)));

  const published = (): boolean => {
    assertAncestors(staging);
    const original = fs.lstatSync(staging.directory, { bigint: true, throwIfNoEntry: false });
    const target = fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false });
    if (original) {
      requireBuild(!target && sameFile(source, requireStaging(staging)));
      assertFiles(staging.directory, files);
      return false;
    }
    requireBuild(target?.isDirectory() && !target.isSymbolicLink() && sameIdentity(target, source));
    assertFiles(destination, files);
    return true;
  };
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    requireBuild(!published());
    try {
      renameSync(staging.directory, destination);
    } catch (error) {
      if (published()) return;
      if (
        platform !== 'win32' ||
        !LOCK_ERRORS.has(errorCode(error) ?? '') ||
        attempt + 1 === PUBLISH_ATTEMPTS
      ) {
        throw Error(PUBLISH_FAILED);
      }
      pause((attempt + 1) * PUBLISH_DELAY_MS);
      continue;
    }
    requireBuild(published());
    return;
  }
}

/** A compiler failure can clean only the original staging tree, never a replacement. */
export function removeCoreBuildStaging(staging: CoreBuildStaging): void {
  requireStaging(staging);
  for (const name of fs.readdirSync(staging.directory)) {
    requireBuild(BUILD_FILES.includes(name));
    const current = fs.lstatSync(path.join(staging.directory, name));
    requireBuild(current.isFile() && !current.isSymbolicLink() && current.nlink === 1);
  }
  requireStaging(staging);
  fs.rmSync(staging.directory, { recursive: true, force: true });
}
