// Explicit integration tool. Ordinary Node tests do not require a Go compiler.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveGoToolchain, GO_VERSION } from '../../scripts/core/go.mts';
import { startShadowClient } from '../../scripts/core/shadow-client.mts';
import { fingerprintCoreSources } from '../../scripts/core/source-fingerprint.mts';
import type { ShadowClient } from '../../scripts/core/shadow-client.mts';
import { MemoryStore } from '../../src/conversation/memory.mts';
import {
  prepareMemorySearch,
  prepareMemoryRetrieval,
} from '../../src/conversation/memory-search.mts';
import type {
  MemorySearchResult,
  MemorySource,
  MemoryRetrievalScope,
} from '../../src/conversation/memory-types.ts';
import type { JsonObject } from '../../src/contracts/json.mts';
import { isRecord } from '../../src/contracts/json.mts';
import { renameAtomicFileSync } from '../../src/files/atomic-file-rename.mts';
import protocol from '../../src/contracts/core-protocol.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_COUNT = 200;
const WARMUP_COUNT = 20;
const SCORE_TOLERANCE = 1e-10;
const BUILD_TIMEOUT_MS = 600_000;
const BUILD_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const baseScope = { conversationId: 'fixture-conversation', workId: 'fixture-work' };
class ParityFailure extends Error {
  readonly code: string;
  readonly statistics: Record<string, number>;
  constructor(code: string, statistics: Record<string, number> = {}) {
    super('Memory shadow parity failed');
    this.code = code;
    this.statistics = statistics;
  }
}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ParityFailure(code);
}
interface ReadCase {
  name: string;
  method: 'search' | 'retrieve';
  params: JsonObject;
  node: () => MemorySearchResult[];
}
function cases(memory: MemoryStore): ReadCase[] {
  const search = (
    name: string,
    query: string,
    options: { limit?: number; conversationId?: string } = {},
  ): ReadCase => ({
    name,
    method: 'search',
    node: () => memory.search(query, options),
    params: { query: { terms: prepareMemorySearch(query) }, ...options },
  });
  const retrieve = (
    name: string,
    query: string,
    scope: MemoryRetrievalScope = baseScope,
    limit = 6,
  ): ReadCase => ({
    name,
    method: 'retrieve',
    node: () => memory.retrieve(query, scope, { limit }),
    params: { query: { terms: prepareMemoryRetrieval(query) }, scope: { ...scope }, limit },
  });
  return [
    search('search-basic', 'cobalt'),
    search('search-cjk', '编程语言'),
    search('search-utf16-split', 'surrogateprobe'),
    search('search-nfkc-expanded', 'ﬃ'.repeat(256)),
    search('search-fullwidth', 'ＣＯＢＡＬＴ'),
    search('search-readme', 'manualonlytoken'),
    search('search-before-limit', 'limitguard', {
      conversationId: baseScope.conversationId,
      limit: 1,
    }),
    search('search-candidate', 'candidateonlytoken'),
    search('search-deleted', 'deletedonlytoken'),
    search('search-conflict', 'conflicttoken'),
    search('search-empty', ''),
    search('search-index-only', 'ftsghostprobe'),
    retrieve('retrieve-basic', 'cobalt'),
    retrieve('retrieve-cjk', '请帮我回忆编程语言'),
    retrieve('retrieve-deep-excerpt', 'deepexcerptprobe'),
    retrieve('retrieve-normalized-offset', 'normalizationprobe'),
    retrieve('retrieve-zero-confidence', 'zeroconfidencetoken'),
    retrieve('retrieve-null-confidence', 'nullconfidencetoken'),
    retrieve('retrieve-readme-excluded', 'manualonlytoken'),
    retrieve('retrieve-before-limit', 'limitguard', baseScope, 1),
    retrieve('retrieve-global-episode-excluded', 'scopeepisodeprobe'),
    retrieve('retrieve-orphan-work-excluded', 'orphanworkprobe'),
    retrieve('retrieve-candidate', 'candidateonlytoken'),
    retrieve('retrieve-deleted', 'deletedonlytoken'),
    retrieve('retrieve-conflict', 'conflicttoken'),
    retrieve('retrieve-budget', 'budgetprobe'),
    retrieve('retrieve-index-only-excluded', 'ftsghostprobe'),
    retrieve('retrieve-unicode-scope', 'unicodeidprobe', {
      conversationId: 'fixture-😀',
      workId: 'work-😀',
    }),
    retrieve('retrieve-stopwords', 'please can you tell me'),
    retrieve('retrieve-other-conversation', 'cobalt', { conversationId: 'another-fixture' }),
  ];
}
function seed(memory: MemoryStore): void {
  const confirmed = (
    text: string,
    source: MemorySource = { kind: 'user' },
    confidence: number | null = null,
    kind: 'semantic' | 'episodic' = 'semantic',
  ) => {
    const entry = memory.proposeEntry({ kind, text, source, confidence });
    return memory.confirmEntry(entry.id);
  };
  memory.write('README.md', 'manualonlytoken is available to explicit search only.');
  memory.write('identity.md', 'Cobalt global preferences. 长期记忆采用关键词检索，测试编程语言。');
  memory.write(
    'working-memory.md',
    'x'.repeat(511) +
      '😀 surrogateprobe\n' +
      'Ordinary introduction. '.repeat(300) +
      'deepexcerptprobe is a verified deep result.',
  );
  confirmed('cobalt shared preference');
  confirmed('编程语言采用关键词检索');
  confirmed('ﬃ'.repeat(256));
  confirmed('ﬃ'.repeat(80) + ' normalizationprobe ' + 'trailing fixture context '.repeat(90));
  confirmed(
    'zeroconfidencetoken is confirmed with measured zero confidence',
    { kind: 'user', conversationId: baseScope.conversationId, messageId: 'fixture-zero', at: 1000 },
    0,
  );
  confirmed(
    'nullconfidencetoken is confirmed without a confidence measure',
    { kind: 'task', ...baseScope, messageId: 'fixture-null', at: 1000 },
    null,
  );
  confirmed('scopeepisodeprobe is an unscoped episode', { kind: 'inference' }, null, 'episodic');
  confirmed('orphanworkprobe has no conversation', { kind: 'task', workId: baseScope.workId });
  confirmed('unicodeidprobe belongs to a Unicode scope', {
    kind: 'task',
    conversationId: 'fixture-😀',
    workId: 'work-😀',
  });
  memory.proposeEntry({
    kind: 'semantic',
    text: 'candidateonlytoken is not confirmed',
    source: { kind: 'inference' },
  });
  const deleted = confirmed('deletedonlytoken must no longer participate');
  memory.deleteEntry(deleted.id);
  const older = confirmed('conflicttoken is an older preference');
  const replacement = memory.proposeEntry({
    kind: 'semantic',
    text: 'conflicttoken is the confirmed replacement',
    key: older.key,
    source: { kind: 'user' },
  });
  memory.confirmEntry(replacement.id, { resolveConflicts: true });
  for (let index = 0; index < 10; index++)
    confirmed(`budgetprobe fixture ${index}: ` + 'bounded reference context '.repeat(100));
  const project = (conversationId: string, workId: string, text: string) =>
    memory.writeProject(conversationId, workId, {
      version: 1,
      updatedAt: 1000,
      originalRequest: { messageId: 'message-' + workId, at: 1000, text, attachments: [] },
      humanUpdates: [],
      results: [],
    });
  for (let index = 0; index < 24; index++)
    project('other-conversation', 'other-work-' + index, 'limitguard');
  project(
    baseScope.conversationId,
    baseScope.workId,
    'The limitguard target project has a longer verified result that must survive scope before LIMIT.',
  );
  const ghost = confirmed('This authoritative entry contains different factual text.');
  // Explicitly prepare FTS before exporting; this last fixture tests authority revalidation.
  memory.search('cobalt');
  const database = new DatabaseSync(memory.databaseFile);
  try {
    database
      .prepare('UPDATE memory_search SET text=? WHERE document_key=?')
      .run('ftsghostprobe\nftsghostprobe', ghost.id);
  } finally {
    database.close();
  }
}
function compareReferences(
  actual: unknown,
  expected: readonly MemorySearchResult[],
  name: string,
): number {
  if (!Array.isArray(actual) || actual.length !== expected.length)
    throw new ParityFailure(name + '-count', {
      expectedReferences: expected.length,
      actualReferences: Array.isArray(actual) ? actual.length : -1,
    });
  let maximumDifference = 0;
  for (let index = 0; index < expected.length; index++) {
    const value: unknown = actual[index],
      reference = expected[index];
    if (
      !isRecord(value) ||
      !reference ||
      typeof value.score !== 'number' ||
      !Number.isFinite(value.score)
    )
      throw new ParityFailure(name + '-shape', { entryIndex: index });
    const { score, ...received } = value;
    const { score: expectedScore, ...authoritative } = reference;
    if (!isDeepStrictEqual(received, authoritative))
      throw new ParityFailure(name + '-reference', {
        entryIndex: index,
        expectedTextUnits: reference.text.length,
        actualTextUnits: typeof value.text === 'string' ? value.text.length : -1,
      });
    const difference = Math.abs(score - expectedScore);
    if (difference > SCORE_TOLERANCE)
      throw new ParityFailure(name + '-score', { entryIndex: index, scoreDifference: difference });
    maximumDifference = Math.max(maximumDifference, difference);
  }
  return maximumDifference;
}
async function rejection(promise: Promise<unknown>, code: string, expected: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && error.message === expected) return;
    throw new ParityFailure(code);
  }
  throw new ParityFailure(code);
}
function refuses(operation: () => unknown, code: string): void {
  let rejected = false;
  try {
    operation();
  } catch {
    rejected = true;
  }
  check(rejected, code);
}
function summarize(samples: number[]) {
  const ordered = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    Number((ordered[Math.ceil(ordered.length * fraction) - 1] ?? 0).toFixed(6));
  return { samples: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}
function removeFixture(base: string, directory: string, identity: fs.Stats): void {
  const relative = path.relative(base, directory),
    current = fs.lstatSync(directory);
  check(
    relative &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === identity.dev &&
      current.ino === identity.ino,
    'fixture-cleanup-identity',
  );
  fs.rmSync(directory, { recursive: true, force: true });
}

export async function memoryParity(): Promise<JsonObject> {
  const toolchain = resolveGoToolchain(ROOT);
  const cache = path.join(ROOT, '.cache/core'),
    host = path.join(cache, 'host');
  const fixtureBase = path.join(ROOT, '.cache/tests');
  fs.mkdirSync(host, { recursive: true });
  fs.mkdirSync(fixtureBase, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtureBase, 'core-parity-'));
  const identity = fs.lstatSync(directory);
  const snapshots = path.join(directory, 'snapshots');
  fs.mkdirSync(snapshots, { mode: 0o700 });
  const executable = path.join(
    host,
    'parity-' + randomUUID() + (process.platform === 'win32' ? '.exe' : ''),
  );
  const clients: ShadowClient[] = [];
  let memory: MemoryStore | undefined, binaryIdentity: fs.Stats | undefined;
  let stage = 'static-build';
  try {
    stage = 'source-before-build';
    const source = fingerprintCoreSources(ROOT);
    stage = 'static-build';
    check(!fs.existsSync(executable), 'build-output-identity');
    const build = spawnSync(
      toolchain.go,
      ['build', '-trimpath', '-buildvcs=false', '-o', executable, './cmd/dant-core'],
      {
        cwd: path.join(ROOT, 'core'),
        env: { ...toolchain.env, CGO_ENABLED: '0' },
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: BUILD_OUTPUT_MAX_BYTES,
      },
    );
    check(!build.error && build.status === 0, 'static-build');
    binaryIdentity = fs.lstatSync(executable);
    check(
      binaryIdentity.isFile() && !binaryIdentity.isSymbolicLink() && binaryIdentity.nlink === 1,
      'binary-identity',
    );
    stage = 'source-after-build';
    check(isDeepStrictEqual(fingerprintCoreSources(ROOT), source), 'source-changed-after-build');
    memory = new MemoryStore(path.join(directory, 'data'));
    stage = 'fixture-seed';
    seed(memory);
    stage = 'snapshot';
    const reads = cases(memory),
      snapshot = memory.shadowSnapshot(snapshots);
    const client = startShadowClient(executable, snapshot);
    clients.push(client);
    const ping = await client.request('ping');
    stage = 'parity';
    check(
      isDeepStrictEqual(ping, {
        protocolVersion: protocol.version,
        role: 'memory-shadow',
        revision: snapshot.revision,
      }),
      'ping-contract',
    );
    let maximumDifference = 0,
      referencesCompared = 0;
    const expected = new Map<string, MemorySearchResult[]>();
    for (const read of reads) {
      stage = read.name;
      const references = read.node();
      expected.set(read.name, references);
      const actual = await client.request(read.method, read.params);
      maximumDifference = Math.max(
        maximumDifference,
        compareReferences(actual, references, read.name),
      );
      referencesCompared += references.length;
    }
    check(
      expected.get('search-utf16-split')?.[0]?.text.length === 512 &&
        expected.get('search-utf16-split')?.[0]?.text.charCodeAt(511) === 0xd83d,
      'fixture-utf16-boundary',
    );
    check(expected.get('search-nfkc-expanded')?.length, 'fixture-nfkc-expanded');
    check(
      expected.get('search-readme')?.length === 1 &&
        expected.get('retrieve-readme-excluded')?.length === 0,
      'fixture-readme-boundary',
    );
    check(
      expected.get('retrieve-before-limit')?.[0]?.id === baseScope.workId,
      'fixture-scope-before-limit',
    );
    check(
      expected
        .get('retrieve-zero-confidence')
        ?.some((value) => isRecord(value) && value.confidence === 0),
      'fixture-zero-confidence',
    );
    check(
      expected
        .get('retrieve-null-confidence')
        ?.some(
          (value) =>
            isRecord(value) && Object.hasOwn(value, 'confidence') && value.confidence === null,
        ),
      'fixture-null-confidence',
    );
    check(expected.get('retrieve-index-only-excluded')?.length === 0, 'fixture-authority-boundary');
    const budget = expected.get('retrieve-budget') ?? [];
    check(
      budget.length > 0 && budget.reduce((sum, value) => sum + value.text.length, 0) <= 2048,
      'fixture-retrieval-budget',
    );
    for (const method of ['search', 'retrieve'] as const) {
      const params: JsonObject = {
        query: { terms: [] },
        limit: 0,
        ...(method === 'retrieve' ? { scope: { ...baseScope } } : {}),
      };
      refuses(
        () =>
          method === 'search'
            ? memory?.search('', { limit: 0 })
            : memory?.retrieve('', baseScope, { limit: 0 }),
        'node-zero-limit',
      );
      await rejection(client.request(method, params), 'go-zero-limit', 'invalid_params');
      await rejection(
        client.request(method, { ...params, limit: null }),
        'go-null-limit',
        'invalid_params',
      );
    }
    refuses(
      () => memory?.retrieve('cobalt', { conversationId: baseScope.conversationId, workId: null }),
      'node-null-scope',
    );
    await rejection(
      client.request('retrieve', {
        query: { terms: ['cobalt'] },
        scope: { conversationId: baseScope.conversationId, workId: null },
      }),
      'go-null-scope',
      'invalid_params',
    );
    const controller = new AbortController();
    const cancelled = client.request(
      'retrieve',
      { query: { terms: ['cobalt'] }, scope: { ...baseScope } },
      { signal: controller.signal },
    );
    controller.abort();
    await rejection(cancelled, 'cancel-request', 'core_cancelled');
    await client.request('ping');
    const benchmark = reads.filter(
      (read) => read.name === 'search-basic' || read.name === 'retrieve-basic',
    );
    check(benchmark.length === 2, 'benchmark-workload');
    for (let index = 0; index < WARMUP_COUNT; index++) {
      const read = benchmark[index % benchmark.length];
      check(read, 'benchmark-case');
      read.node();
      await client.request(read.method, read.params);
    }
    const nodeSamples: number[] = [],
      goSamples: number[] = [];
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      const read = benchmark[index % benchmark.length];
      check(read, 'benchmark-case');
      const before = performance.now();
      const result = read.node();
      nodeSamples.push(performance.now() - before);
      compareReferences(result, expected.get(read.name) ?? [], 'benchmark-node');
    }
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      const read = benchmark[index % benchmark.length];
      check(read, 'benchmark-case');
      const before = performance.now();
      const result = await client.request(read.method, read.params);
      goSamples.push(performance.now() - before);
      maximumDifference = Math.max(
        maximumDifference,
        compareReferences(result, expected.get(read.name) ?? [], 'benchmark-go'),
      );
    }
    memory.write('identity.md', 'The fixture owner changed its authoritative revision.');
    const newer = memory.shadowSnapshot(snapshots);
    check(newer.revision > snapshot.revision, 'fixture-new-revision');
    const stale = startShadowClient(executable, { ...snapshot, revision: newer.revision });
    clients.push(stale);
    await rejection(stale.request('ping'), 'stale-revision', 'core_closed');
    stage = 'source-after-reads';
    check(isDeepStrictEqual(fingerprintCoreSources(ROOT), source), 'source-changed-after-reads');
    return {
      sourceFingerprint: source.digest,
      sourceFingerprintAlgorithm: source.algorithm,
      sourceFingerprintVersion: source.version,
      sourceFiles: source.files,
      goVersion: GO_VERSION,
      nodeVersion: process.versions.node,
      cgoEnabled: false,
      protocolVersion: protocol.version,
      platform: process.platform,
      arch: process.arch,
      searchCases: reads.filter((read) => read.method === 'search').length,
      retrievalCases: reads.filter((read) => read.method === 'retrieve').length,
      boundaryChecks: 7,
      referencesCompared,
      maximumScoreDifference: maximumDifference,
      scoreTolerance: SCORE_TOLERANCE,
      snapshotDocuments: snapshot.documents,
      timingIsolation: 'host-load-not-controlled',
      workload:
        'Alternating search/retrieve; Node authoritative API and prepared Go snapshot IPC measured separately; not a production performance claim.',
      node: summarize(nodeSamples),
      goIPC: summarize(goSamples),
    };
  } catch (error) {
    const codes = [
      'invalid_params',
      'invalid_snapshot',
      'stale_snapshot',
      'unavailable',
      'core_closed',
      'core_invalid_response',
      'core_deadline',
      'deadline_exceeded',
    ];
    const suffix =
      error instanceof Error && codes.includes(error.message) ? '-' + error.message : '';
    throw error instanceof ParityFailure ? error : new ParityFailure(stage + suffix);
  } finally {
    for (const client of clients) await client.close();
    memory?.close();
    removeFixture(fixtureBase, directory, identity);
    if (binaryIdentity) {
      const current = fs.lstatSync(executable);
      check(
        current.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === binaryIdentity.dev &&
          current.ino === binaryIdentity.ino,
        'binary-cleanup-identity',
      );
      fs.unlinkSync(executable);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 2, 'unexpected-options');
    const summary = await memoryParity();
    const cache = path.join(ROOT, '.cache/core');
    const temporary = path.join(cache, 'parity-' + randomUUID() + '.json');
    const report = JSON.stringify(summary, null, 2) + '\n';
    fs.writeFileSync(temporary, report, { flag: 'wx', mode: 0o600 });
    renameAtomicFileSync(temporary, path.join(cache, 'parity.json'));
    process.stdout.write(report);
  } catch (error) {
    const failure =
      error instanceof ParityFailure
        ? { code: error.code, ...error.statistics }
        : { code: 'integration_failure' };
    process.stderr.write(JSON.stringify({ failed: failure }) + '\n');
    process.exitCode = 1;
  }
}
