import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const CORE_SOURCE_FINGERPRINT_VERSION = 4;
export const CORE_PARITY_SOURCE_FILES = Object.freeze([
  'tests/core/memory-parity.mts',
  'scripts/core/source-fingerprint.mts',
  'scripts/core/go.mts',
  'scripts/core/test-layout.mts',
  'scripts/core/shadow-client.mts',
]);
export interface CoreSourceFingerprint {
  algorithm: 'sha256';
  version: number;
  digest: string;
  files: number;
}
function requireSource(condition: unknown): asserts condition {
  if (!condition) throw Error('core_source_unstable');
}
function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
function sourceStat(root: string, relative: string): fs.BigIntStats {
  let current = root;
  const rootStat = fs.lstatSync(root, { bigint: true });
  requireSource(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const segments = relative.split('/');
  for (const [index, segment] of segments.entries()) {
    requireSource(segment !== '' && segment !== '.' && segment !== '..');
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { bigint: true });
    requireSource(!stat.isSymbolicLink());
    if (index === segments.length - 1) return stat;
    requireSource(stat.isDirectory());
  }
  throw Error('core_source_unstable');
}
function collectSources(
  root: string,
  relative: string,
  files: string[],
  included: (name: string) => boolean,
): void {
  const before = sourceStat(root, relative);
  requireSource(before.isDirectory());
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative + '/' + entry.name;
    const stat = sourceStat(root, child);
    if (stat.isDirectory()) collectSources(root, child, files, included);
    else {
      requireSource(stat.isFile());
      if (included(entry.name)) files.push(child);
    }
  }
  requireSource(sameFile(before, sourceStat(root, relative)));
}

/** Deterministic source provenance; no Git state, timestamps or file contents are emitted. */
export function fingerprintCoreSources(root: string): CoreSourceFingerprint {
  try {
    const resolved = path.resolve(root);
    const files = [...CORE_PARITY_SOURCE_FILES];
    collectSources(
      resolved,
      'core',
      files,
      (name) => /\.(?:go|json|txt)$/.test(name) || name === 'go.mod' || name === 'go.sum',
    );
    collectSources(resolved, 'src', files, (name) => /\.(?:mts|ts|json)$/.test(name));
    collectSources(resolved, 'tests/go', files, (name) => /\.(?:go|json|txt)$/.test(name));
    requireSource(files.includes('core/go.mod') && files.includes('core/go.sum'));
    files.sort();
    const hash = createHash('sha256');
    hash.update('dant-core-parity-source-v' + CORE_SOURCE_FINGERPRINT_VERSION + '\0');
    for (const relative of files) {
      const before = sourceStat(resolved, relative);
      requireSource(before.isFile());
      const descriptor = fs.openSync(path.join(resolved, relative), 'r');
      try {
        requireSource(sameFile(before, fs.fstatSync(descriptor, { bigint: true })));
        const bytes = fs.readFileSync(descriptor);
        requireSource(
          BigInt(bytes.length) === before.size &&
            sameFile(before, fs.fstatSync(descriptor, { bigint: true })) &&
            sameFile(before, sourceStat(resolved, relative)),
        );
        const name = Buffer.from(relative, 'utf8');
        hash.update(String(name.length) + '\0');
        hash.update(name);
        hash.update('\0' + bytes.length + '\0');
        hash.update(bytes);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    return {
      algorithm: 'sha256',
      version: CORE_SOURCE_FINGERPRINT_VERSION,
      digest: hash.digest('hex'),
      files: files.length,
    };
  } catch {
    throw Error('core_source_unstable');
  }
}
