import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isRecord } from './manifest-json.mts';

export const CORE_WINDOWS = 'dant-core.exe';
export const CORE_LINUX = 'dant-core-linux-amd64';
export const CORE_BUILD_MANIFEST = 'build-manifest.json';
export const CORE_RESOURCE_MANIFEST = 'resource-manifest.json';
export const CORE_BUNDLE_MANIFEST = 'resources/core/bundle-manifest.json';
export const CORE_GUEST_BINARY = 'resources/core/' + CORE_LINUX;
export const CORE_LICENSE = 'GO-LICENSE.txt';
export const CORE_LICENSE_SOURCE = 'core/internal/platform/timezones/GO-LICENSE.txt';
export const CORE_UNICODE_LICENSE = 'UNICODE-LICENSE.txt';
export const CORE_UNICODE_LICENSE_SOURCE = 'core/internal/history/assets/UNICODE-LICENSE.txt';
export const MAX_CORE_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_CORE_MANIFEST_BYTES = 64 * 1024;
export const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const VM_BUNDLE_FILES = Object.freeze(
  [
    CORE_GUEST_BINARY,
    'resources/config/protocol.json',
    'vm/bootstrap.sh',
    'vm/control.py',
    'vm/desktop.py',
    'vm/desktop_mcp.py',
    'vm/guest.py',
    'vm/install-speech.sh',
    'vm/install-transcription.sh',
    'vm/install-worker.sh',
    'vm/worker-install.py',
    'vm/start-codex.sh',
    'vm/transcribe_audio.py',
    'vm/transcription-requirements.txt',
    'vm/voice_message.py',
  ].sort(),
);

export const HOST_HELPERS = Object.freeze([
  'scripts/check-vm.ps1',
  'scripts/create-vm.ps1',
  'scripts/create-vmware.ps1',
  'scripts/launch-vm.ps1',
  'scripts/patch-image.py',
  'scripts/prepare-vm.ps1',
  'scripts/prepare-vmware.ps1',
  'scripts/seed.py',
  'scripts/vm-key.py',
  'scripts/vm-lifecycle.ps1',
  'scripts/vmware.py',
]);

export interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BundleManifest {
  schemaVersion: 1;
  version: string;
  sourceCommit: string;
  files: BundleFile[];
}

export function ordinaryDirectories(target: string): void {
  for (let current = target; ; current = path.dirname(current)) {
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw Error('Packaging directories must be ordinary directories, never links or junctions.');
    if (path.dirname(current) === current) break;
  }
}

export function describeFile(root: string, name: string): BundleFile {
  const target = path.join(root, name);
  ordinaryDirectories(path.dirname(target));
  const before = fs.lstatSync(target);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size <= 0 ||
    before.size > MAX_CORE_FILE_BYTES
  )
    throw Error('The core bundle requires ordinary bounded files.');
  const descriptor = fs.openSync(target, 'r');
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw Error('A core bundle file changed.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_CORE_FILE_BYTES) throw Error('A core bundle file exceeded its limit.');
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(target);
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.nlink !== 1 ||
      current.mtimeMs !== before.mtimeMs
    )
      throw Error('A core bundle file changed.');
    return { path: name, bytes: total, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readManifest(
  file: string,
  allowed: readonly string[],
  version: string,
  source?: string,
): BundleManifest {
  const stat = fs.lstatSync(file);
  ordinaryDirectories(path.dirname(file));
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > MAX_CORE_MANIFEST_BYTES
  )
    throw Error('The core build manifest is invalid.');
  const descriptor = fs.openSync(file, 'r');
  let content: Buffer;
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw Error('The core build manifest changed.');
    const buffer = Buffer.alloc(MAX_CORE_MANIFEST_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(descriptor, buffer, total, buffer.length - total, null);
      if (!count) break;
      total += count;
    }
    const after = fs.fstatSync(descriptor),
      current = fs.lstatSync(file);
    if (
      total !== stat.size ||
      total > MAX_CORE_MANIFEST_BYTES ||
      after.mtimeMs !== stat.mtimeMs ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.nlink !== 1 ||
      current.size !== stat.size ||
      current.mtimeMs !== stat.mtimeMs
    )
      throw Error('The core build manifest changed.');
    content = buffer.subarray(0, total);
  } finally {
    fs.closeSync(descriptor);
  }
  const value: unknown = JSON.parse(content.toString('utf8'));
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    value.schemaVersion !== 1 ||
    value.version !== version ||
    typeof value.sourceCommit !== 'string' ||
    !SOURCE_COMMIT.test(value.sourceCommit) ||
    (source !== undefined && value.sourceCommit !== source) ||
    !Array.isArray(value.files) ||
    value.files.length !== allowed.length
  )
    throw Error('The core build manifest version or provenance does not match.');
  const entries: BundleFile[] = [];
  const seen = new Set<string>();
  for (const item of value.files) {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== 3 ||
      typeof item.path !== 'string' ||
      !allowed.includes(item.path) ||
      seen.has(item.path) ||
      !Number.isSafeInteger(item.bytes) ||
      typeof item.bytes !== 'number' ||
      item.bytes <= 0 ||
      item.bytes > MAX_CORE_FILE_BYTES ||
      typeof item.sha256 !== 'string' ||
      !SHA256.test(item.sha256)
    )
      throw Error('The core build manifest contains an invalid file.');
    seen.add(item.path);
    entries.push({ path: item.path, bytes: item.bytes, sha256: item.sha256 });
  }
  return { schemaVersion: 1, version, sourceCommit: value.sourceCommit, files: entries };
}

export function verifyFiles(root: string, manifest: BundleManifest): void {
  for (const expected of manifest.files) {
    const actual = describeFile(root, expected.path);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw Error('A core build file does not match its verified manifest.');
  }
}
