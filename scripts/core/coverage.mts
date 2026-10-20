import fs from 'node:fs';
import path from 'node:path';

const MODULE = 'github.com/Stephen-Sim/dant/core/';
// Whole-module instrumentation repeats spans in each package's test binary.
const MAX_PROFILE_BYTES = 64 * 1024 * 1024;
const MAX_PROFILE_ROWS = 1_000_000;
const MAX_PROFILE_BLOCKS = 250_000;
const PROFILE_ERROR = 'The Go coverage report is incomplete or invalid.';
export const CORE_CRITICAL_COVERAGE = Object.freeze([
  'internal/controller',
  'internal/computer',
  'internal/telegram',
]);
export const CORE_MINIMUM_STATEMENTS = 90;

interface Block {
  file: string;
  statements: number;
  hit: boolean;
}
export interface GoPackageCoverage {
  package: string;
  statements: number;
  covered: number;
  percent: number;
}
export interface GoCoverageResult {
  metric: 'Go statements';
  minimum: number;
  required: readonly string[];
  packages: readonly GoPackageCoverage[];
  failures: readonly string[];
}
export interface GoCoverageReport {
  file: string;
  read(): string;
  save(result: GoCoverageResult): void;
  close(): void;
}

function requireProfile(condition: unknown): asserts condition {
  if (!condition) throw Error(PROFILE_ERROR);
}

/** Multiple test binaries can report the same instrumented block: count its union once. */
export function parseGoCoverage(profile: string): GoPackageCoverage[] {
  requireProfile(Buffer.byteLength(profile) <= MAX_PROFILE_BYTES);
  const lines = profile.trimEnd().split(/\r?\n/);
  requireProfile(/^mode: (?:set|count|atomic)$/.test(lines.shift() ?? ''));
  requireProfile(lines.length > 0 && lines.length <= MAX_PROFILE_ROWS);
  const blocks = new Map<string, Block>();
  for (const line of lines) {
    const match =
      /^(github\.com\/Stephen-Sim\/dant\/core\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.go):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/.exec(
        line,
      );
    requireProfile(match);
    const [, file, startLine, startColumn, endLine, endColumn, count, hits] = match;
    requireProfile(file && count && hits);
    const positions = [startLine, startColumn, endLine, endColumn].map(Number);
    requireProfile(positions.every((number) => Number.isSafeInteger(number) && number > 0));
    const [fromLine = 0, fromColumn = 0, toLine = 0, toColumn = 0] = positions;
    requireProfile(toLine > fromLine || (toLine === fromLine && toColumn >= fromColumn));
    const statements = Number(count),
      hitCount = Number(hits);
    requireProfile(Number.isSafeInteger(statements) && statements >= 0);
    requireProfile(Number.isSafeInteger(hitCount) && hitCount >= 0);
    const key = `${file}:${startLine}.${startColumn},${endLine}.${endColumn}`;
    const prior = blocks.get(key);
    requireProfile(!prior || prior.statements === statements);
    blocks.set(key, { file, statements, hit: !!prior?.hit || hitCount > 0 });
    requireProfile(blocks.size <= MAX_PROFILE_BLOCKS);
  }
  const packages = new Map<string, { statements: number; covered: number }>();
  for (const block of blocks.values()) {
    const name = path.posix.dirname(block.file.slice(MODULE.length));
    const item = packages.get(name) ?? { statements: 0, covered: 0 };
    item.statements += block.statements;
    if (block.hit) item.covered += block.statements;
    requireProfile(Number.isSafeInteger(item.statements) && Number.isSafeInteger(item.covered));
    packages.set(name, item);
  }
  return [...packages]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => ({
      package: name,
      ...item,
      percent: item.statements ? (item.covered / item.statements) * 100 : 100,
    }));
}

/** Missing packages fail independently of the critical threshold; no rounded-up pass. */
export function assessGoCoverage(
  packages: readonly GoPackageCoverage[],
  expected: readonly string[],
): GoCoverageResult {
  requireProfile(expected.length > 0 && new Set(expected).size === expected.length);
  requireProfile(expected.every((name) => name.startsWith(MODULE)));
  const expectedNames = expected.map((name) => name.slice(MODULE.length));
  requireProfile(packages.every((item) => expectedNames.includes(item.package)));
  const failures: string[] = [];
  for (const name of expectedNames) {
    // Thin process entrypoints have no separate feature policy or test package.
    if (name.startsWith('cmd/')) continue;
    if (!packages.some((item) => item.package === name && item.statements > 0 && item.covered > 0))
      failures.push(`Go package has no executable coverage: ${name}`);
  }
  for (const name of CORE_CRITICAL_COVERAGE) {
    const item = packages.find((item) => item.package === name);
    if (!item || !item.statements) failures.push(`Required Go package has no coverage: ${name}`);
    else if (
      BigInt(item.covered) * 100n <
      BigInt(CORE_MINIMUM_STATEMENTS) * BigInt(item.statements)
    )
      failures.push(
        `${name} statement coverage ${item.covered}/${item.statements} (${item.percent.toFixed(4)}%) is below ${CORE_MINIMUM_STATEMENTS}%`,
      );
  }
  return {
    metric: 'Go statements',
    minimum: CORE_MINIMUM_STATEMENTS,
    required: CORE_CRITICAL_COVERAGE,
    packages,
    failures,
  };
}

/** A private fresh path prevents a prior successful profile from satisfying a failed run. */
export function createGoCoverageReport(root: string): GoCoverageReport {
  requireProfile(path.isAbsolute(root));
  const rootStat = fs.lstatSync(root);
  requireProfile(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const parent = path.join(root, '.cache/core');
  for (const relative of ['.cache', '.cache/core']) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    const entry = fs.lstatSync(directory);
    requireProfile(entry.isDirectory() && !entry.isSymbolicLink());
  }
  // Failed checks must not upload a stale public summary from an earlier run.
  for (const name of ['coverage.out', 'coverage.json'])
    fs.rmSync(path.join(parent, name), { force: true });
  const directory = fs.mkdtempSync(path.join(parent, 'coverage-run-'));
  const file = path.join(directory, 'coverage.out');
  const initial = fs.lstatSync(directory);
  let closed = false;
  return {
    file,
    read() {
      const stat = fs.lstatSync(file);
      requireProfile(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1 &&
          stat.size <= MAX_PROFILE_BYTES,
      );
      return fs.readFileSync(file, 'utf8');
    },
    save(result) {
      fs.copyFileSync(file, path.join(parent, 'coverage.out'), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(parent, 'coverage.json'), JSON.stringify(result, null, 2) + '\n', {
        flag: 'wx',
      });
    },
    close() {
      if (closed) return;
      const current = fs.lstatSync(directory);
      requireProfile(
        current.isDirectory() &&
          !current.isSymbolicLink() &&
          current.ino === initial.ino &&
          current.dev === initial.dev,
      );
      if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.rmdirSync(directory);
      closed = true;
    },
  };
}
