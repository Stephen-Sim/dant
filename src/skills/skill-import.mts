import {
  SKILL_DESCRIPTION_BYTES,
  SKILL_INSTRUCTION_BYTES,
  SKILL_FILE_BYTES,
  SKILL_TOTAL_BYTES,
  SKILL_MAX_DEPTH,
  SKILL_RELATIVE_PATH_CHARACTERS,
  SKILL_NAME_PATTERN,
  SKILL_ARCHIVE_BYTES,
} from './skill-limits.mts';
import { isRecord, errorCode, includesValue } from '../contracts/json.mts';
import type { Readable } from 'node:stream';
import type { SkillLibrary } from './skill-library.mts';
import type { SkillBinaryFile } from './skill-types.ts';
import { skillFileFromBytes } from './skill-files.mts';
interface SkillCandidate {
  name: string;
  description: string;
  instructions: string;
}
interface ImportPreview {
  value: SkillCandidate & {
    files: Record<string, string>;
    binaryFiles: Record<string, SkillBinaryFile>;
  };
  source: string;
  expiresAt: number;
}
type SkillFetch = (
  url: string,
  options: Omit<RequestInit, 'headers' | 'signal'> & {
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  },
) => Promise<Response>;
export interface SkillImporterOptions {
  skills?: Pick<SkillLibrary, 'containsSecret' | 'locate' | 'save'>;
  fetchImpl?: SkillFetch;
  now?: () => number;
  timeoutMs?: number;
}
interface GitEntry {
  path: unknown;
  type: unknown;
  mode: unknown;
  sha: unknown;
  size: unknown;
}
function githubObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw remoteFailure();
  return value;
}
function githubTree(value: unknown): { truncated: unknown; tree: GitEntry[] } {
  const object = githubObject(value);
  if (!Array.isArray(object.tree)) throw limited();
  return {
    truncated: object.truncated,
    tree: object.tree.map((raw: unknown) => {
      const entry = githubObject(raw);
      return {
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        sha: entry.sha,
        size: entry.size,
      };
    }),
  };
}
import { randomUUID, createHash } from 'node:crypto';
import yauzl from 'yauzl';
import { SKILL_SUPPORT_FILE_LIMIT, SKILL_TREE_ENTRY_LIMIT } from './skill-limits.mts';

const MAX_ARCHIVE = SKILL_ARCHIVE_BYTES,
  MAX_FILE = SKILL_FILE_BYTES,
  MAX_TOTAL = SKILL_TOTAL_BYTES,
  // A GitHub blob carries base64, escaped line separators and JSON metadata.
  MAX_BLOB_RESPONSE = MAX_FILE * 2,
  TTL = 10 * 60 * 1000;
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const slug = (value: unknown): value is string =>
  typeof value === 'string' && SKILL_NAME_PATTERN.test(value);
const rootDoc = /^(?:README\.md|(?:LICENSE|NOTICE)(?:\.(?:txt|md))?)$/;
const fail = (code: string, message: string, status = 400) =>
  Object.assign(Error(message), { code, status });
const invalid = () =>
  fail('invalid_skill', 'The skill has invalid or unsupported instructions or metadata.');
const limited = () =>
  fail('size_limit', 'The skill exceeds the supported file count or size limit.');
const remoteFailure = () =>
  fail(
    'fetch_failed',
    'Could not read the public GitHub skill. Check the source or try again later.',
    502,
  );
const safePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 512 &&
  !/[\\\x00-\x1f\x7f]/.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes(':'));
function plain(data: Buffer | Uint8Array) {
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw fail('unsupported_file', 'Skill files must contain valid UTF-8 text.');
  }
  if (
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) ||
    /^(?:%PDF-|PK\x03\x04|RIFF|OggS|GIF8[79]a)/.test(value)
  )
    throw fail('unsupported_file', 'Binary skill files are not supported.');
  return value.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
}
function scalar(value: string) {
  value = value.trim();
  if (value.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:\s*#.*)?$/.exec(value);
    try {
      if (!match) throw Error();
      const parsed = JSON.parse(match[1] ?? '');
      if (typeof parsed !== 'string') throw Error();
      return parsed;
    } catch {
      throw invalid();
    }
  }
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:\s*#.*)?$/.exec(value);
    if (!match) throw invalid();
    return (match[1] ?? '').replaceAll("''", "'");
  }
  if (!value || /^[#!&*[{]/.test(value) || /\s[&*][\w-]+/.test(value)) throw invalid();
  return value.replace(/\s+#.*$/, '').trim();
}
function manifest(data: Buffer, source: string): SkillCandidate {
  const text = plain(data);
  if (!text.startsWith('---\n')) throw invalid();
  const boundary = text.indexOf('\n---\n', 4);
  if (boundary < 0 || boundary > 8192) throw invalid();
  const lines = text.slice(4, boundary).split('\n'),
    fields: Record<string, string | true> = Object.create(null);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index++] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([a-z][a-z-]*):(?:\s+(.*))?$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1] ?? '')) throw invalid();
    const key = match[1] ?? '';
    const raw = match[2] ?? '';
    if (!['name', 'description', 'license', 'compatibility', 'metadata'].includes(key))
      throw fail(
        'invalid_skill',
        'This skill uses unsupported behavioral metadata. Import it only after reviewing those requirements.',
      );
    if (key === 'metadata') {
      fields[key] = true;
      while (
        index < lines.length &&
        (/^\s/.test(lines[index] ?? '') || !(lines[index] ?? '').trim())
      )
        index++;
      continue;
    }
    if (/^[|>][-+]?$/.test(raw.trim())) {
      const pieces = [];
      let indent: number | null = null;
      while (
        index < lines.length &&
        (/^\s/.test(lines[index] ?? '') || !(lines[index] ?? '').trim())
      ) {
        const item = lines[index++] ?? '';
        if (item.trim()) {
          const spaces = /^ */.exec(item)?.[0].length ?? 0;
          if (!spaces || item.startsWith('\t')) throw invalid();
          indent = indent === null ? spaces : Math.min(indent, spaces);
        }
        pieces.push(item);
      }
      if (indent === null) throw invalid();
      const body = pieces.map((item) => (item.trim() ? item.slice(indent ?? 0) : ''));
      fields[key] = (
        raw.startsWith('>')
          ? body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ')
          : body.join('\n')
      ).trim();
    } else fields[key] = scalar(raw);
  }
  if (
    !slug(fields.name) ||
    typeof fields.description !== 'string' ||
    !fields.description.trim() ||
    Buffer.byteLength(fields.description) > SKILL_DESCRIPTION_BYTES
  )
    throw invalid();
  let instructions = text.slice(boundary + 5).trim();
  if (!instructions) throw invalid();
  const provenance = [
    ...(source.startsWith('https://github.com/') ? ['Source: ' + source] : []),
    ...['license', 'compatibility']
      .filter((key) => fields[key])
      .map((key) => key.charAt(0).toUpperCase() + key.slice(1) + ': ' + fields[key]),
  ];
  if (provenance.length)
    instructions += '\n\n---\nImported skill reference metadata:\n' + provenance.join('\n');
  if (Buffer.byteLength(instructions) > SKILL_INSTRUCTION_BYTES) throw limited();
  return { name: fields.name, description: fields.description.trim(), instructions };
}
function supported(relative: unknown): asserts relative is string {
  if (
    !safePath(relative) ||
    relative.length > SKILL_RELATIVE_PATH_CHARACTERS ||
    !(/^(scripts|references|assets)\//.test(relative) || rootDoc.test(relative))
  )
    throw fail(
      'unsupported_file',
      'Use SKILL.md, README/LICENSE/NOTICE documents, or supporting files in scripts, references, or assets.',
    );
}
function select<Value>(files: ReadonlyMap<string, Value>): Map<string, Value> {
  const candidates = [...files.keys()].filter((name) => name.split('/').at(-1) === 'SKILL.md');
  if (candidates.length !== 1)
    throw fail(
      'invalid_skill',
      candidates.length
        ? 'Multiple skills were found. Choose one specific skill directory.'
        : 'No SKILL.md was found in the source.',
    );
  const skillPath = candidates[0];
  if (!skillPath) throw invalid();
  const prefix = skillPath.slice(0, -8),
    selected = new Map<string, Value>();
  for (const [name, value] of files)
    if (name.startsWith(prefix)) {
      const relative = name.slice(prefix.length);
      if (relative !== 'SKILL.md') supported(relative);
      selected.set(relative, value);
    }
  if (selected.size > SKILL_SUPPORT_FILE_LIMIT + 1) throw limited();
  const paths = new Set([...selected.keys()].map((value) => value.toLowerCase()));
  for (const file of paths) {
    const parts = file.split('/');
    for (let count = 1; count < parts.length; count++)
      if (paths.has(parts.slice(0, count).join('/')))
        throw fail('invalid_skill', 'The skill contains conflicting file and directory paths.');
  }
  return selected;
}
async function withSignal<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(remoteFailure());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
async function bytes(response: Response, limit: number, signal: AbortSignal) {
  if (Number(response.headers?.get('content-length')) > limit) throw limited();
  const reader = response.body?.getReader();
  if (!reader) throw remoteFailure();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await withSignal(reader.read(), signal);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) throw limited();
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    void reader.cancel().catch(() => {});
  }
}
function githubSource(value: unknown) {
  if (typeof value !== 'string')
    throw fail(
      'invalid_source',
      'Use a public github.com repository, skill directory, or SKILL.md URL.',
    );
  try {
    const rawPath = /^https:\/\/[^/]+(\/[^?#]*)/.exec(value)?.[1] || '';
    if (
      rawPath
        .split('/')
        .map(decodeURIComponent)
        .some((part) => part === '.' || part === '..')
    )
      throw Error();
  } catch {
    throw fail('invalid_source', 'The GitHub source URL contains an invalid path.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail(
      'invalid_source',
      'Use a public github.com repository, skill directory, or SKILL.md URL.',
    );
  }
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\\\x00-\x20\x7f]/.test(value) ||
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw fail(
      'invalid_source',
      'Use a public github.com URL without credentials, queries, or fragments.',
    );
  let parts;
  try {
    parts = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent);
  } catch {
    throw fail('invalid_source', 'The GitHub source URL is invalid.');
  }
  const [owner, repoPart, ...rest] = parts,
    repo = repoPart?.replace(/\.git$/, '');
  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(owner || '') ||
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo || '') ||
    repo === '.' ||
    repo === '..'
  )
    throw fail('invalid_source', 'The GitHub repository URL is invalid.');
  let ref = 'HEAD',
    directory = '';
  if (rest.length) {
    const [kind, branch, ...location] = rest;
    if (
      !includesValue(['tree', 'blob'], kind) ||
      !branch ||
      branch.length > 128 ||
      !/^[a-zA-Z0-9._/-]+$/.test(branch) ||
      branch.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw fail(
        'invalid_source',
        'Choose a GitHub repository, tree directory, or SKILL.md blob URL.',
      );
    ref = branch;
    if (kind === 'blob' && location.pop() !== 'SKILL.md')
      throw fail('invalid_source', 'A GitHub file URL must point to SKILL.md.');
    directory = location.join('/');
    if (
      location.some((part) => part.includes('/')) ||
      (directory && (!safePath(directory) || directory.split('/').length > SKILL_MAX_DEPTH))
    )
      throw fail('invalid_source', 'The GitHub skill directory is invalid.');
  }
  const candidates = [];
  if (!rest.length) candidates.push({ ref, directory });
  else {
    const parts = directory ? directory.split('/') : [];
    for (let length = parts.length; length >= 0; length--) {
      const candidate = [ref, ...parts.slice(0, length)].join('/');
      if (candidate.length <= 128)
        candidates.push({ ref: candidate, directory: parts.slice(length).join('/') });
    }
  }
  return { owner, repo, candidates };
}
function crc32(data: Buffer) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
async function unzip(data: Buffer, signal: AbortSignal) {
  let zip: yauzl.ZipFile;
  try {
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.fromBuffer(
        data,
        { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
        (error, value) => (error || !value ? reject(error ?? remoteFailure()) : resolve(value)),
      ),
    );
  } catch {
    throw fail('invalid_skill', 'The ZIP archive is invalid or unsupported.');
  }
  const files = new Map<string, Buffer>(),
    entries: yauzl.Entry[] = [];
  let stream: Readable | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      let count = 0,
        total = 0;
      const names = new Set(),
        abort = () => reject(remoteFailure());
      signal.addEventListener('abort', abort, { once: true });
      const cleanup = () => signal.removeEventListener('abort', abort);
      zip.once('end', () => {
        cleanup();
        resolve();
      });
      zip.once('error', () => {
        cleanup();
        reject(fail('invalid_skill', 'The ZIP archive is invalid or unsupported.'));
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          if (++count > SKILL_TREE_ENTRY_LIMIT || zip.entryCount > SKILL_TREE_ENTRY_LIMIT)
            throw limited();
          const directory = entry.fileName.endsWith('/'),
            name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
          if (!safePath(name) || names.has(name.toLowerCase()))
            throw fail('invalid_skill', 'The ZIP contains unsafe or duplicate paths.');
          names.add(name.toLowerCase());
          const mode = (entry.externalFileAttributes >>> SKILL_MAX_DEPTH) & 0xf000;
          if (entry.isEncrypted() || (mode && mode !== (directory ? 0x4000 : 0x8000)))
            throw fail(
              'unsupported_file',
              'Encrypted archives, links, and special files are not supported.',
            );
          if (
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize < 0 ||
            entry.uncompressedSize > MAX_FILE ||
            !Number.isSafeInteger(entry.compressedSize) ||
            entry.compressedSize < 0 ||
            entry.compressedSize > MAX_ARCHIVE
          )
            throw limited();
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL + MAX_FILE) throw limited();
          if (!directory) entries.push(entry);
          else if (entry.uncompressedSize) throw invalid();
          zip.readEntry();
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      zip.readEntry();
      if (signal.aborted) abort();
    });
    const selected = select(new Map(entries.map((entry) => [entry.fileName, entry])));
    for (const [relative, entry] of selected) {
      if (signal.aborted) throw remoteFailure();
      stream = await new Promise<Readable>((resolve, reject) =>
        zip.openReadStream(entry, (error, value) =>
          error || !value ? reject(error ?? remoteFailure()) : resolve(value),
        ),
      );
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for await (const rawChunk of stream) {
          const chunk: unknown = rawChunk;
          if (!Buffer.isBuffer(chunk)) throw invalid();
          if (signal.aborted) throw remoteFailure();
          length += chunk.length;
          if (length > MAX_FILE || length > entry.uncompressedSize) throw limited();
          chunks.push(chunk);
        }
      } catch (error) {
        if (errorCode(error)) throw error;
        throw fail('invalid_skill', 'The ZIP file contents are invalid.');
      } finally {
        stream.destroy();
        stream = null;
      }
      const content = Buffer.concat(chunks, length);
      if (length !== entry.uncompressedSize || crc32(content) !== entry.crc32)
        throw fail('invalid_skill', 'The ZIP file contents failed their integrity check.');
      files.set(relative, content);
    }
    return files;
  } catch (error) {
    if (isRecord(error) && typeof error.status === 'number') throw error;
    throw fail('invalid_skill', 'The ZIP archive is invalid or unsupported.');
  } finally {
    stream?.destroy();
    zip.close();
  }
}

/** Previews hold bounded inert files in RAM. Only an explicit commit writes a managed skill. */
export class SkillImporter {
  readonly skills: Pick<SkillLibrary, 'containsSecret' | 'locate' | 'save'>;
  readonly fetch: SkillFetch;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly previews: Map<string, ImportPreview>;
  inflight: number;
  readonly controllers: Set<AbortController>;
  closed: boolean;
  constructor({
    skills,
    fetchImpl = fetch,
    now = Date.now,
    timeoutMs = 30000,
  }: SkillImporterOptions = {}) {
    if (!skills) throw invalid();
    this.skills = skills;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.previews = new Map();
    this.inflight = 0;
    this.controllers = new Set();
    this.closed = false;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
      throw fail('invalid_source', 'Invalid skill import deadline.');
  }
  clean() {
    for (const [id, item] of this.previews)
      if (item.expiresAt <= this.now()) this.previews.delete(id);
  }
  async request(route: string, signal: AbortSignal, limit = MAX_BLOB_RESPONSE) {
    let response;
    try {
      response = await withSignal(
        this.fetch('https://api.github.com' + route, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'dant-skill-import',
          },
          signal,
        }),
        signal,
      );
    } catch {
      throw remoteFailure();
    }
    if (
      response.status === 404 ||
      (response.status === 422 && /^\/repos\/[^/]+\/[^/]+\/commits(?:\/|\?)/.test(route))
    )
      throw fail(
        'not_found',
        'The public GitHub repository, revision, or skill was not found.',
        404,
      );
    if (!response.ok || response.redirected) throw remoteFailure();
    let data;
    try {
      data = await bytes(response, limit, signal);
    } catch (error) {
      if (errorCode(error) === 'size_limit') throw error;
      throw remoteFailure();
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
      throw remoteFailure();
    }
  }
  async github(url: unknown, signal: AbortSignal) {
    const { owner, repo, candidates } = githubSource(url),
      base = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
    let commit: Record<string, unknown> | undefined, directory: string | undefined;
    // GitHub URLs can contain slash-bearing branches. Match the longest existing
    // revision prefix, then freeze all reads to its immutable commit/tree/blob IDs.
    for (const candidate of candidates) {
      try {
        const commits = await this.request(
          base + '/commits?sha=' + encodeURIComponent(candidate.ref) + '&per_page=1',
          signal,
        );
        if (!Array.isArray(commits) || commits.length !== 1) throw remoteFailure();
        commit = githubObject(commits[0]);
        directory = candidate.directory;
        break;
      } catch (error) {
        if (errorCode(error) !== 'not_found') throw error;
      }
    }
    if (!commit)
      throw fail(
        'not_found',
        'The public GitHub repository, revision, or skill was not found.',
        404,
      );
    const commitMetadata = githubObject(commit.commit);
    const commitTree = githubObject(commitMetadata.tree);
    if (!sha(commit.sha) || !sha(commitTree.sha)) throw remoteFailure();
    let treeId = commitTree.sha;
    for (const segment of directory ? directory.split('/') : []) {
      const tree = githubTree(
        await this.request(base + '/git/trees/' + treeId, signal, MAX_ARCHIVE),
      );
      if (
        tree?.truncated !== false ||
        !Array.isArray(tree.tree) ||
        tree.tree.length > SKILL_TREE_ENTRY_LIMIT
      )
        throw limited();
      const item = tree.tree.find((item) => item.path === segment);
      if (!item || item.type !== 'tree' || item.mode !== '040000' || !sha(item.sha))
        throw fail('not_found', 'The selected GitHub skill directory was not found.', 404);
      treeId = item.sha;
    }
    const tree = githubTree(
      await this.request(base + '/git/trees/' + treeId + '?recursive=1', signal, MAX_ARCHIVE),
    );
    if (
      tree?.truncated !== false ||
      !Array.isArray(tree.tree) ||
      tree.tree.length > SKILL_TREE_ENTRY_LIMIT
    )
      throw limited();
    const files = new Map<string, GitEntry>(),
      names = new Set<string>();
    for (const entry of tree.tree) {
      if (!safePath(entry.path) || names.has(entry.path.toLowerCase())) throw remoteFailure();
      names.add(entry.path.toLowerCase());
      if (entry.type === 'tree' && entry.mode === '040000') continue;
      files.set(entry.path, entry);
    }
    const selected = select(files),
      result = new Map<string, Buffer>();
    let total = 0;
    for (const entry of selected.values()) {
      if (
        entry.type !== 'blob' ||
        !includesValue(['100644', '100755'], entry.mode) ||
        !sha(entry.sha)
      )
        throw fail(
          'unsupported_file',
          'GitHub links, submodules, and special files are not supported.',
        );
      if (
        typeof entry.size !== 'number' ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_FILE
      )
        throw limited();
      total += entry.size;
      if (total > MAX_TOTAL + MAX_FILE) throw limited();
    }
    for (const [name, entry] of selected) {
      const blob = githubObject(await this.request(base + '/git/blobs/' + entry.sha, signal));
      if (
        blob?.encoding !== 'base64' ||
        typeof blob.content !== 'string' ||
        blob.size !== entry.size ||
        blob.sha !== entry.sha
      )
        throw remoteFailure();
      const encoded = blob.content.replaceAll('\n', '');
      if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
        throw remoteFailure();
      const data = Buffer.from(encoded, 'base64');
      if (
        data.toString('base64') !== encoded ||
        data.length !== entry.size ||
        createHash('sha1')
          .update('blob ' + data.length + '\0')
          .update(data)
          .digest('hex') !== entry.sha
      )
        throw remoteFailure();
      result.set(name, data);
    }
    return {
      files: result,
      source:
        'https://github.com/' +
        owner +
        '/' +
        repo +
        '/tree/' +
        commit.sha +
        (directory ? '/' + directory.split('/').map(encodeURIComponent).join('/') : ''),
    };
  }
  async preview(input: unknown) {
    this.clean();
    if (this.closed) throw fail('expired', 'Skill importing has stopped.', 410);
    if (this.previews.size + this.inflight >= 3)
      throw fail(
        'import_busy',
        'Three import previews are already open. Finish one or wait for it to expire.',
        429,
      );
    if (!isRecord(input) || Boolean(input.url) === Boolean(input.data))
      throw fail('invalid_source', 'Choose one GitHub URL or local ZIP/SKILL.md file.');
    this.inflight++;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let files, source;
      if (input.url) {
        ({ files, source } = await this.github(input.url, controller.signal));
      } else {
        if (!Buffer.isBuffer(input.data) || input.data.length > MAX_ARCHIVE) throw limited();
        source =
          typeof input.name === 'string'
            ? (input.name.replaceAll('\\', '/').split('/').at(-1) ?? '')
            : '';
        if (source === 'SKILL.md') {
          if (input.data.length > MAX_FILE) throw limited();
          files = new Map([['SKILL.md', input.data]]);
        } else if (/\.zip$/i.test(source)) files = await unzip(input.data, controller.signal);
        else throw fail('unsupported_file', 'Choose a ZIP archive or a file named SKILL.md.');
        if (/[\x00-\x1f\x7f]/.test(source) || source.length > SKILL_RELATIVE_PATH_CHARACTERS)
          throw fail('invalid_source', 'The local skill file name is invalid.');
      }
      const skillFile = files.get('SKILL.md');
      if (!skillFile) throw invalid();
      const candidate = manifest(skillFile, source),
        support: Record<string, string> = Object.create(null),
        binaryFiles: Record<string, SkillBinaryFile> = Object.create(null),
        secretTexts: string[] = [];
      let total = Buffer.byteLength(candidate.instructions);
      const listed = [{ path: 'SKILL.md', size: skillFile.length }];
      for (const [name, data] of files)
        if (name !== 'SKILL.md') {
          supported(name);
          if (data.length > MAX_FILE) throw limited();
          const file = skillFileFromBytes(name, data);
          if (typeof file.value === 'string') {
            support[name] = file.value;
          } else {
            binaryFiles[name] = file.value;
          }
          total += file.data.length;
          listed.push({ path: name, size: file.data.length });
          if (total > MAX_TOTAL) throw limited();
          secretTexts.push(...file.secretTexts);
        }
      if (total > MAX_TOTAL || files.size > SKILL_SUPPORT_FILE_LIMIT + 1) throw limited();
      for (const value of [
        candidate.name,
        candidate.description,
        candidate.instructions,
        ...Object.keys(support),
        ...Object.keys(binaryFiles),
        ...secretTexts,
      ])
        if (this.skills?.containsSecret?.(value))
          throw fail(
            'invalid_skill',
            'Keep credentials in the credential vault, not in imported skills.',
          );
      if (this.closed || controller.signal.aborted) throw remoteFailure();
      const id = randomUUID(),
        expiresAt = this.now() + TTL,
        value = { ...candidate, files: support, binaryFiles };
      this.previews.set(id, { value, source, expiresAt });
      return { id, source, ...candidate, files: listed, expiresAt };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      this.inflight--;
    }
  }
  commit({ id, name, enabled }: { id?: unknown; name?: unknown; enabled?: unknown } = {}) {
    this.clean();
    const item = typeof id === 'string' ? this.previews.get(id) : undefined;
    if (!item)
      throw fail(
        'expired',
        'This import preview expired or was already used. Preview the source again.',
        410,
      );
    name = name ?? item.value.name;
    if (!slug(name) || (enabled !== undefined && typeof enabled !== 'boolean')) throw invalid();
    let existing;
    try {
      existing = this.skills.locate(name);
    } catch {
      throw fail(
        'name_exists',
        'A skill or unmanaged folder with this name already exists. Choose another name.',
        409,
      );
    }
    if (existing)
      throw fail('name_exists', 'A skill with this name already exists. Choose another name.', 409);
    this.previews.delete(String(id));
    try {
      return this.skills.save(
        { ...item.value, name, enabled: enabled ?? true },
        { overwrite: false },
      );
    } catch {
      throw fail(
        'invalid_skill',
        'The imported skill could not be saved. Check its contents and preview it again.',
      );
    }
  }
  discard(id: string) {
    this.previews.delete(id);
    return { discarded: true };
  }
  close() {
    this.closed = true;
    this.previews.clear();
    for (const controller of this.controllers) controller.abort();
  }
}
