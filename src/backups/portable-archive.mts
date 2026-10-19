import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { isRecord } from '../contracts/json.mts';
import { archivePath, WORKER_ARCHIVE_MAGIC } from './archive-stream.mts';
import { backupError } from './backup-validation.mts';
import {
  BACKUP_SCHEMA_VERSION,
  BACKUP_CHUNK_BYTES,
  BACKUP_MANIFEST_MAX_BYTES,
  BACKUP_MAX_BYTES,
  BACKUP_MAX_FILE_BYTES,
  BACKUP_MAX_FILES,
} from './backup-constants.mts';
import type { WorkerBackupManifest } from './archive-types.ts';
import type { BackupMetadata } from './backup-types.ts';

const AUTHENTICATION_COMPONENTS = new Set([
  '.ssh',
  '.codex',
  '.openai',
  '.aws',
  '.azure',
  '.gnupg',
]);
const DATA_AUTHENTICATION_FILES = new Set([
  'telegram.json',
  'voice-key.dpapi',
  'auth.json',
  'credentials.json',
  'secrets.json',
  'master.key',
  'vm-key',
  'vm.json',
]);
const WORKSPACE_AUTHENTICATION_FILES = new Set([
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.netrc',
  '.npmrc',
  '.pypirc',
]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HASH = /^[a-f0-9]{64}$/;
type Frame =
  | { type: 'header'; manifest: WorkerBackupManifest }
  | { type: 'record'; value: Record<string, unknown> }
  | { type: 'footer'; files: number; bytes: number };
export interface PortableArchivePlan {
  original: WorkerBackupManifest;
  manifest: WorkerBackupManifest;
  sha256: string;
  archiveBytes: number;
}
const invalid = () => backupError('backup_invalid', 400);
const integer = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).length === allowed.length &&
  Object.keys(value).every((key) => allowed.includes(key));
function authenticationPath(domain: 'data' | 'workspace', relative: string) {
  const parts = relative.toLowerCase().split('/'),
    first = parts[0],
    name = parts.at(-1) ?? '';
  if (parts.some((part) => AUTHENTICATION_COMPONENTS.has(part))) return true;
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  if (domain === 'data')
    return (
      first === 'credentials' ||
      (parts.length === 1 &&
        (DATA_AUTHENTICATION_FILES.has(name) ||
          name.startsWith('voice-key') ||
          name.startsWith('telegram-token') ||
          name.startsWith('telegram-key')))
    );
  const git = parts.indexOf('.git');
  if (git >= 0 && parts.length === git + 2 && ['config', 'credentials'].includes(name)) return true;
  return WORKSPACE_AUTHENTICATION_FILES.has(name);
}
function readManifest(value: unknown): WorkerBackupManifest {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'type',
      'schemaVersion',
      'createdAt',
      'appVersion',
      'sourceId',
      'files',
      'bytes',
    ]) ||
    value.type !== 'header' ||
    value.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    !integer(value.createdAt, Number.MAX_SAFE_INTEGER) ||
    value.createdAt === 0 ||
    typeof value.appVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.appVersion) ||
    typeof value.sourceId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.sourceId) ||
    !integer(value.files, BACKUP_MAX_FILES) ||
    !integer(value.bytes, BACKUP_MAX_BYTES)
  )
    throw invalid();
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: value.createdAt,
    appVersion: value.appVersion,
    sourceId: value.sourceId,
    files: value.files,
    bytes: value.bytes,
  };
}
async function* lines(input: AsyncIterable<unknown>, hash: ReturnType<typeof createHash>) {
  let parts: Buffer[] = [],
    length = 0;
  const decoder = new TextDecoder('utf8', { fatal: true });
  for await (const value of input) {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array) && typeof value !== 'string')
      throw invalid();
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    hash.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      const next = chunk.indexOf(10, start),
        end = next < 0 ? chunk.length : next;
      const piece = chunk.subarray(start, end);
      length += piece.length;
      if (length > BACKUP_MANIFEST_MAX_BYTES) throw invalid();
      parts.push(piece);
      if (next >= 0) {
        yield decoder.decode(Buffer.concat(parts, length));
        parts = [];
        length = 0;
      }
      start = end + 1;
    }
  }
  if (length) throw invalid();
}
async function* frames(
  input: AsyncIterable<unknown>,
  rejectAuthentication: boolean,
  hash: ReturnType<typeof createHash>,
): AsyncGenerator<Frame> {
  let index = 0,
    manifest: WorkerBackupManifest | undefined,
    footer = false;
  let bytes = 0,
    files = 0,
    retainedBytes = 0,
    retainedFiles = 0;
  const seen = new Map<string, boolean>(),
    parents = new Set<string>();
  let current:
    | { size: number; written: number; hash: ReturnType<typeof createHash>; excluded: boolean }
    | undefined;
  for await (const line of lines(input, hash)) {
    if (index++ === 0) {
      if (line !== WORKER_ARCHIVE_MAGIC) throw invalid();
      continue;
    }
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || footer) throw invalid();
    if (!manifest) {
      manifest = readManifest(value);
      yield { type: 'header', manifest };
      continue;
    }
    if (current) {
      if (value.type === 'chunk') {
        if (
          !exactKeys(value, ['type', 'data']) ||
          typeof value.data !== 'string' ||
          !value.data.length ||
          value.data.length > 4 * Math.ceil(BACKUP_CHUNK_BYTES / 3) ||
          !BASE64.test(value.data)
        )
          throw invalid();
        const chunk = Buffer.from(value.data, 'base64');
        if (
          chunk.length > BACKUP_CHUNK_BYTES ||
          chunk.toString('base64') !== value.data ||
          current.written + chunk.length > current.size
        )
          throw invalid();
        current.written += chunk.length;
        current.hash.update(chunk);
        if (!current.excluded) yield { type: 'record', value: { type: 'chunk', data: value.data } };
        continue;
      }
      if (
        value.type !== 'end' ||
        !exactKeys(value, ['type', 'sha256']) ||
        typeof value.sha256 !== 'string' ||
        !HASH.test(value.sha256) ||
        current.written !== current.size ||
        current.hash.digest('hex') !== value.sha256
      )
        throw invalid();
      if (!current.excluded) yield { type: 'record', value: { type: 'end', sha256: value.sha256 } };
      current = undefined;
      continue;
    }
    if (value.type === 'footer') {
      if (
        !exactKeys(value, ['type', 'files', 'bytes']) ||
        value.files !== files ||
        value.bytes !== bytes ||
        files !== manifest.files ||
        bytes !== manifest.bytes
      )
        throw invalid();
      footer = true;
      yield { type: 'footer', files: retainedFiles, bytes: retainedBytes };
      continue;
    }
    if (
      !exactKeys(value, ['type', 'domain', 'path', 'size', 'executable']) ||
      (value.type !== 'file' && value.type !== 'directory') ||
      (value.domain !== 'data' && value.domain !== 'workspace') ||
      !archivePath(value.path) ||
      !integer(value.size, BACKUP_MAX_FILE_BYTES) ||
      typeof value.executable !== 'boolean' ||
      (value.type === 'directory' && value.size !== 0)
    )
      throw invalid();
    const key = value.domain + '/' + value.path,
      directory = value.type === 'directory';
    if (seen.has(key) || seen.size >= BACKUP_MAX_FILES) throw invalid();
    const segments = key.split('/');
    for (let n = 1; n < segments.length; n++) {
      const parent = segments.slice(0, n).join('/');
      if (seen.get(parent) === false) throw invalid();
      parents.add(parent);
    }
    if (!directory && parents.has(key)) throw invalid();
    seen.set(key, directory);
    const excluded = authenticationPath(value.domain, value.path);
    if (excluded && rejectAuthentication) throw invalid();
    if (!excluded)
      yield {
        type: 'record',
        value: {
          type: value.type,
          domain: value.domain,
          path: value.path,
          size: value.size,
          executable: value.executable,
        },
      };
    if (directory) continue;
    files++;
    bytes += value.size;
    if (files > manifest.files || bytes > manifest.bytes || bytes > BACKUP_MAX_BYTES)
      throw invalid();
    if (!excluded) {
      retainedFiles++;
      retainedBytes += value.size;
    }
    current = { size: value.size, written: 0, hash: createHash('sha256'), excluded };
  }
  if (!manifest || !footer || current || seen.get('data/state.json') !== false) throw invalid();
}
function matches(manifest: WorkerBackupManifest, metadata: BackupMetadata) {
  return (
    manifest.createdAt === metadata.createdAt &&
    manifest.appVersion === metadata.appVersion &&
    manifest.files === metadata.files &&
    manifest.bytes === metadata.bytes
  );
}
/** Inspect and hash an entire archive without materializing any plaintext file. */
export async function inspectPortableArchive(
  input: AsyncIterable<unknown>,
  metadata: BackupMetadata,
  rejectAuthentication = false,
): Promise<PortableArchivePlan> {
  const hash = createHash('sha256');
  let original: WorkerBackupManifest | undefined, filtered: WorkerBackupManifest | undefined;
  let recordBytes = 0;
  try {
    for await (const frame of frames(input, rejectAuthentication, hash)) {
      if (frame.type === 'header') {
        original = frame.manifest;
        if (!matches(original, metadata)) throw invalid();
      }
      if (frame.type === 'footer') {
        if (!original) throw invalid();
        filtered = { ...original, files: frame.files, bytes: frame.bytes };
      }
      if (frame.type === 'record') recordBytes += encode(frame.value).length;
    }
    if (!original || !filtered) throw invalid();
    return {
      original,
      manifest: filtered,
      sha256: hash.digest('hex'),
      archiveBytes:
        Buffer.byteLength(WORKER_ARCHIVE_MAGIC + '\n') +
        encode({ type: 'header', ...filtered }).length +
        recordBytes +
        encode({ type: 'footer', files: filtered.files, bytes: filtered.bytes }).length,
    };
  } catch {
    throw invalid();
  }
}
/** Revalidate the same source bytes while removing authentication records. */
export function portableArchiveStream(
  input: AsyncIterable<unknown>,
  plan: PortableArchivePlan,
): Readable {
  async function* encodeArchive() {
    const hash = createHash('sha256');
    yield Buffer.from(WORKER_ARCHIVE_MAGIC + '\n');
    for await (const frame of frames(input, false, hash)) {
      if (frame.type === 'header') {
        if (JSON.stringify(frame.manifest) !== JSON.stringify(plan.original)) throw invalid();
        yield encode({ type: 'header', ...plan.manifest });
      } else if (frame.type === 'record') yield encode(frame.value);
      else {
        if (frame.files !== plan.manifest.files || frame.bytes !== plan.manifest.bytes)
          throw invalid();
        yield encode({ type: 'footer', files: frame.files, bytes: frame.bytes });
      }
    }
    if (hash.digest('hex') !== plan.sha256) throw invalid();
  }
  return Readable.from(encodeArchive());
}
