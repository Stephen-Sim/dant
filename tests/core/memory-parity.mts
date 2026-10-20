// Explicit integration tool. Ordinary Node tests do not require a Go compiler.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { resolveGoToolchain, GO_VERSION } from '../../scripts/core/go.mts';
import { startShadowClient } from '../../scripts/core/shadow-client.mts';
import { fingerprintCoreSources } from '../../scripts/core/source-fingerprint.mts';
import { isRecord } from '../../scripts/core/manifest-json.mts';
import type { JsonObject, JsonValue } from '../../scripts/core/manifest-json.mts';
import type { ShadowClient } from '../../scripts/core/shadow-client.mts';
import protocol from '../../resources/contracts/core-protocol.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GOLDEN_FILE = 'tests/go/internal/memory/testdata/node-shadow-golden.json';
const GOLDEN_MAX_BYTES = 1024 * 1024;
const SCORE_TOLERANCE = 1e-10;
const BUILD_TIMEOUT_MS = 600_000;
const BUILD_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const EXPECTED_NODE = '22.23.3';
const EXPECTED_COMMIT = 'd058bdc7509efce90bd9d96cc367b04e11c98bae';
const SNAPSHOT_TABLES = Object.freeze({
  memory_meta: ['rowid', 'id', 'revision', 'search_revision'],
  memory_search: [
    'rowid',
    'document_key',
    'kind',
    'text',
    'updated_at',
    'conversation_id',
    'work_id',
  ],
  memory_read_documents: [
    'rowid',
    'search_rowid',
    'document_key',
    'kind',
    'text',
    'normalized_text',
    'updated_at',
    'conversation_id',
    'work_id',
    'status',
    'source_json',
    'confidence',
  ],
});

class ParityFailure extends Error {
  readonly code: string;
  readonly statistics: Record<string, number>;

  constructor(code: string, statistics: Record<string, number> = {}) {
    super('Memory golden parity failed');
    this.code = code;
    this.statistics = statistics;
  }
}

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ParityFailure(code);
}

function jsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item: unknown) => jsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => jsonValue(item, depth + 1));
}

interface GoldenCase {
  name: string;
  method: 'search' | 'retrieve';
  params: JsonObject;
  expected: Record<string, unknown>[];
}

interface GoldenTable {
  name: keyof typeof SNAPSHOT_TABLES;
  sql: string;
  columns: string[];
  rows: (string | number | null)[][];
}

function referenceArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.every(
      (reference: unknown) =>
        isRecord(reference) &&
        typeof reference.score === 'number' &&
        Number.isFinite(reference.score) &&
        typeof reference.text === 'string',
    )
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function sqlRows(value: unknown, columns: number): value is (string | number | null)[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (row: unknown) =>
        Array.isArray(row) &&
        row.length === columns &&
        row.every(
          (item: unknown) =>
            item === null ||
            typeof item === 'string' ||
            (typeof item === 'number' && Number.isFinite(item)),
        ),
    )
  );
}

function readGolden(): {
  cases: GoldenCase[];
  tables: GoldenTable[];
  revision: number;
  documents: number;
} {
  const file = path.join(ROOT, GOLDEN_FILE);
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= GOLDEN_MAX_BYTES, 'golden-file');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(isRecord(value) && value.version === 1 && isRecord(value.provenance), 'golden-version');
  check(
    value.provenance.node === EXPECTED_NODE &&
      value.provenance.commit === EXPECTED_COMMIT &&
      Array.isArray(value.provenance.sources) &&
      value.provenance.sources.length > 0 &&
      value.provenance.sources.every(
        (source: unknown) =>
          isRecord(source) &&
          typeof source.file === 'string' &&
          typeof source.sha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(source.sha256) &&
          source.matchesCommit === true,
      ),
    'golden-provenance',
  );
  check(
    typeof value.revision === 'number' &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      typeof value.documents === 'number' &&
      Number.isSafeInteger(value.documents) &&
      value.documents > 0,
    'golden-snapshot-metadata',
  );
  check(
    Array.isArray(value.cases) &&
      value.cases.length === 30 &&
      isRecord(value.snapshot) &&
      value.snapshot.userVersion === 1 &&
      Array.isArray(value.snapshot.tables),
    'golden-shape',
  );

  const names = new Set<string>();
  const cases: GoldenCase[] = value.cases.map((read: unknown) => {
    check(
      isRecord(read) &&
        typeof read.name === 'string' &&
        /^[a-z0-9-]{1,64}$/.test(read.name) &&
        !names.has(read.name) &&
        (read.method === 'search' || read.method === 'retrieve') &&
        isRecord(read.params) &&
        jsonValue(read.params) &&
        referenceArray(read.expected),
      'golden-case',
    );
    names.add(read.name);
    return { name: read.name, method: read.method, params: read.params, expected: read.expected };
  });

  const tableNames = new Set<string>();
  const tables: GoldenTable[] = value.snapshot.tables.map((table: unknown) => {
    check(
      isRecord(table) &&
        typeof table.name === 'string' &&
        Object.hasOwn(SNAPSHOT_TABLES, table.name) &&
        !tableNames.has(table.name) &&
        typeof table.sql === 'string' &&
        stringArray(table.columns) &&
        Array.isArray(table.rows),
      'golden-table',
    );
    const name = table.name as keyof typeof SNAPSHOT_TABLES;
    check(
      isDeepStrictEqual(table.columns, SNAPSHOT_TABLES[name]) &&
        sqlRows(table.rows, table.columns.length),
      'golden-table-rows',
    );
    tableNames.add(name);
    return { name, sql: table.sql, columns: table.columns, rows: table.rows };
  });
  check(tableNames.size === Object.keys(SNAPSHOT_TABLES).length, 'golden-table-count');
  return { cases, tables, revision: value.revision, documents: value.documents };
}

function reconstructSnapshot(file: string, tables: GoldenTable[]): void {
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  const database = new DatabaseSync(file, { enableDoubleQuotedStringLiterals: false });
  try {
    database.exec(
      'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA user_version=1; BEGIN IMMEDIATE;',
    );
    for (const table of tables) {
      // These CREATE statements and rows are immutable synthetic Node baseline data,
      // pinned by repository provenance. No live database or user SQL is accepted.
      database.exec(table.sql);
      const statement = database.prepare(
        `INSERT INTO ${table.name}(${table.columns.join(',')}) VALUES(${table.columns.map(() => '?').join(',')})`,
      );
      for (const row of table.rows) statement.run(...row);
    }
    database.exec('COMMIT');
  } finally {
    database.close();
  }
}

function compareReferences(
  actual: unknown,
  expected: readonly Record<string, unknown>[],
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
    check(
      isRecord(value) &&
        reference &&
        typeof value.score === 'number' &&
        Number.isFinite(value.score) &&
        typeof reference.score === 'number',
      name + '-shape',
    );
    const { score, ...received } = value;
    const { score: expectedScore, ...authoritative } = reference;
    check(isDeepStrictEqual(received, authoritative), name + '-reference');
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
  const toolchain = resolveGoToolchain(ROOT),
    golden = readGolden();
  const cache = path.join(ROOT, '.cache/core'),
    host = path.join(cache, 'host'),
    fixtureBase = path.join(ROOT, '.cache/tests');
  fs.mkdirSync(host, { recursive: true });
  fs.mkdirSync(fixtureBase, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtureBase, 'core-parity-')),
    identity = fs.lstatSync(directory);
  const executable = path.join(
    host,
    'parity-' + randomUUID() + (process.platform === 'win32' ? '.exe' : ''),
  );
  const clients: ShadowClient[] = [];
  let binaryIdentity: fs.Stats | undefined;
  let stage = 'static-build';
  try {
    const source = fingerprintCoreSources(ROOT);
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
    check(isDeepStrictEqual(fingerprintCoreSources(ROOT), source), 'source-changed-after-build');

    stage = 'snapshot';
    const file = path.join(directory, 'synthetic-shadow.sqlite');
    reconstructSnapshot(file, golden.tables);
    const snapshot = { file, revision: golden.revision };
    const before = fs.readFileSync(file);
    const client = startShadowClient(executable, snapshot);
    clients.push(client);
    check(
      isDeepStrictEqual(await client.request('ping'), {
        protocolVersion: protocol.version,
        role: 'memory-shadow',
        revision: snapshot.revision,
      }),
      'ping-contract',
    );
    let maximumDifference = 0,
      referencesCompared = 0;
    for (const read of golden.cases) {
      stage = read.name;
      const actual = await client.request(read.method, read.params);
      maximumDifference = Math.max(
        maximumDifference,
        compareReferences(actual, read.expected, read.name),
      );
      referencesCompared += read.expected.length;
    }

    stage = 'protocol-boundaries';
    const scope = { conversationId: 'fixture-conversation', workId: 'fixture-work' };
    for (const method of ['search', 'retrieve'] as const) {
      const params: JsonObject = {
        query: { terms: [] },
        ...(method === 'retrieve' ? { scope } : {}),
      };
      await rejection(
        client.request(method, { ...params, limit: 0 }),
        'zero-limit',
        'invalid_params',
      );
      await rejection(
        client.request(method, { ...params, limit: null }),
        'null-limit',
        'invalid_params',
      );
    }
    await rejection(
      client.request('retrieve', {
        query: { terms: ['cobalt'] },
        scope: { ...scope, workId: null },
      }),
      'null-scope',
      'invalid_params',
    );
    await rejection(
      client.request('search', { query: { terms: ['cobalt'] }, conversationId: null }),
      'null-conversation',
      'invalid_params',
    );
    await rejection(
      client.request('search', { query: { terms: [] }, unknown: true }),
      'unknown-parameter',
      'invalid_params',
    );
    const controller = new AbortController();
    const cancelled = client.request(
      'retrieve',
      { query: { terms: ['cobalt'] }, scope },
      { signal: controller.signal },
    );
    controller.abort();
    await rejection(cancelled, 'cancel-request', 'core_cancelled');
    await client.request('ping');
    const stale = startShadowClient(executable, { ...snapshot, revision: snapshot.revision + 1 });
    clients.push(stale);
    await rejection(stale.request('ping'), 'stale-revision', 'core_closed');
    check(fs.readFileSync(file).equals(before), 'snapshot-was-written');
    check(
      !fs.existsSync(file + '-journal') &&
        !fs.existsSync(file + '-wal') &&
        !fs.existsSync(file + '-shm'),
      'snapshot-sidecars-written',
    );
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
      oracle: {
        kind: 'frozen-synthetic-node-golden',
        nodeVersion: EXPECTED_NODE,
        sourceCommit: EXPECTED_COMMIT,
        file: GOLDEN_FILE,
      },
      searchCases: golden.cases.filter((read) => read.method === 'search').length,
      retrievalCases: golden.cases.filter((read) => read.method === 'retrieve').length,
      boundaryChecks: 11,
      referencesCompared,
      maximumScoreDifference: maximumDifference,
      scoreTolerance: SCORE_TOLERANCE,
      snapshotDocuments: golden.documents,
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
    const cache = path.join(ROOT, '.cache/core'),
      report = JSON.stringify(summary, null, 2) + '\n';
    // This is disposable developer evidence, not a production persistence boundary.
    fs.writeFileSync(path.join(cache, 'parity.json'), report, { mode: 0o600 });
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
