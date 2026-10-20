import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const C8_VERSION = '12.0.0';
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
// v8-to-istanbul represents a branch starting on the preceding newline this way.
const BRANCH_NEWLINE_COLUMN = -1;
type Metric = 'lines' | 'branches' | 'functions';
interface Count {
  covered: number;
  total: number;
}
type Counts = Record<Metric, Count>;
export interface TypeScriptCoverage {
  files: { file: string; counts: Counts }[];
  overall: Counts;
  missing: string[];
}
export type TypeScriptCoverageRunner = (
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { status: number | null; error?: Error };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validHit = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const matchingKeys = (left: Record<string, unknown>, right: Record<string, unknown>): boolean =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.keys(left).every((key) => Object.hasOwn(right, key));

function validLocation(
  value: unknown,
  branch = false,
): value is {
  start: { line: number; column: number };
  end: { line: number; column: number };
} {
  if (!object(value) || !object(value.start) || !object(value.end)) return false;
  const { start, end } = value;
  return (
    validHit(start.line) &&
    start.line > 0 &&
    (validHit(start.column) || (branch && start.column === BRANCH_NEWLINE_COLUMN)) &&
    validHit(end.line) &&
    validHit(end.column) &&
    (end.line > start.line || (end.line === start.line && end.column >= start.column))
  );
}

/** Include entrypoints/tools even if the test suite never imports them. Type-only declarations emit no code. */
export function typeScriptSources(root: string): string[] {
  const walk = (directory: string): string[] =>
    fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const file = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw Error('TypeScript source inventory contains a symbolic link.');
      return entry.isDirectory()
        ? walk(file)
        : entry.isFile() && file.endsWith('.mts')
          ? [file]
          : [];
    });
  const vite = fs.lstatSync(path.join(root, 'vite.config.mts'));
  if (!vite.isFile() || vite.isSymbolicLink())
    throw Error('TypeScript entrypoint is not a regular file.');
  return [...walk('ui'), ...walk('scripts'), 'vite.config.mts'].sort();
}

export function parseTypeScriptCoverage(
  input: unknown,
  root: string,
  expected: readonly string[],
): TypeScriptCoverage {
  if (
    !object(input) ||
    !expected.length ||
    new Set(expected).size !== expected.length ||
    expected.some(
      (file) => !/^(?:(?:ui|scripts)\/(?:[\w-]+\/)*[\w.-]+\.mts|vite\.config\.mts)$/.test(file),
    )
  )
    throw Error('Invalid TypeScript coverage report.');
  const files: TypeScriptCoverage['files'] = [];
  const overall: Counts = {
    lines: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
  };
  for (const value of Object.values(input)) {
    if (!object(value) || typeof value.path !== 'string')
      throw Error('Invalid TypeScript coverage source.');
    const file = path.relative(root, path.resolve(root, value.path)).replaceAll('\\', '/');
    if (!expected.includes(file)) continue;
    if (
      files.some((entry) => entry.file === file) ||
      !object(value.s) ||
      !object(value.f) ||
      !object(value.b) ||
      !object(value.statementMap) ||
      !object(value.fnMap) ||
      !object(value.branchMap) ||
      !matchingKeys(value.s, value.statementMap) ||
      !matchingKeys(value.f, value.fnMap) ||
      !matchingKeys(value.b, value.branchMap)
    )
      throw Error('Invalid TypeScript coverage counters.');
    const lines = new Map<number, number>();
    const functionsByID = value.fnMap;
    const branchesByID = value.branchMap;
    for (const [id, hit] of Object.entries(value.s)) {
      const location = value.statementMap[id];
      if (!validHit(hit) || !validLocation(location))
        throw Error('Invalid TypeScript coverage statement.');
      const line = Number(location.start.line);
      lines.set(line, Math.max(lines.get(line) ?? 0, hit));
    }
    const functions = Object.entries(value.f).map(([id, hit]) => {
      const location = functionsByID[id];
      if (
        !validHit(hit) ||
        !object(location) ||
        !validLocation(location.loc) ||
        !validLocation(location.decl) ||
        typeof location.name !== 'string' ||
        !validHit(location.line) ||
        location.line < 1
      )
        throw Error('Invalid TypeScript coverage function.');
      return hit;
    });
    const branches = Object.entries(value.b).flatMap(([id, hits]) => {
      const location = branchesByID[id];
      if (
        !Array.isArray(hits) ||
        !hits.every(validHit) ||
        !object(location) ||
        !validLocation(location.loc, true) ||
        typeof location.type !== 'string' ||
        !location.type ||
        !validHit(location.line) ||
        location.line < 1 ||
        !Array.isArray(location.locations) ||
        !location.locations.length ||
        location.locations.length !== hits.length ||
        !location.locations.every((entry) => validLocation(entry, true))
      )
        throw Error('Invalid TypeScript coverage branch.');
      return hits as number[];
    });
    const measure = (hits: readonly number[]): Count => ({
      covered: hits.filter((hit) => hit > 0).length,
      total: hits.length,
    });
    const counts = {
      lines: measure([...lines.values()]),
      branches: measure(branches),
      functions: measure(functions),
    };
    files.push({ file, counts });
    for (const metric of ['lines', 'branches', 'functions'] as const) {
      overall[metric].total += counts[metric].total;
      overall[metric].covered += counts[metric].covered;
      if (!Number.isSafeInteger(overall[metric].total))
        throw Error('Invalid TypeScript coverage totals.');
    }
  }
  if (!files.length || !overall.lines.total) throw Error('Empty TypeScript coverage report.');
  return {
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
    overall,
    missing: expected.filter((file) => !files.some((entry) => entry.file === file)),
  };
}

const display = ({ covered, total }: Count): string =>
  total
    ? `${((covered * 100) / total).toFixed(2)}% (${covered}/${total})`
    : 'No executable points (0/0)';
export function typeScriptCoverageMarkdown(report: TypeScriptCoverage): string {
  return [
    '# All maintained TypeScript coverage',
    '',
    ...(['lines', 'branches', 'functions'] as const).map(
      (metric) => `- ${metric}: ${display(report.overall[metric])}`,
    ),
    '',
    'V8/c8 includes every UI module, browser entrypoint, build/development script and Vite configuration. Unloaded code remains in the denominator with zero hits. Tests and type-only declarations are not production executable code. The existing UI feature gates remain independently enforced.',
    '',
    '| Source | Lines | Branches | Functions |',
    '| --- | ---: | ---: | ---: |',
    ...report.files.map(
      ({ file, counts }) =>
        `| \`${file}\` | ${display(counts.lines)} | ${display(counts.branches)} | ${display(counts.functions)} |`,
    ),
    ...report.missing.map((file) => `| \`${file}\` | Not measured | Not measured | Not measured |`),
    ...(report.missing.length ? ['', 'FAIL: TypeScript source inventory is incomplete.'] : []),
    '',
  ].join('\n');
}

export function runTypeScriptCoverage(
  root = ROOT,
  {
    run = spawnSync,
    env = process.env,
  }: { run?: TypeScriptCoverageRunner; env?: NodeJS.ProcessEnv } = {},
): void {
  const output = path.join(root, '.cache/coverage/typescript');
  fs.mkdirSync(output, { recursive: true });
  for (const file of ['coverage-final.json', 'lcov.info', 'coverage.md', 'summary.json'])
    fs.rmSync(path.join(output, file), { force: true });
  let packageFile: unknown;
  try {
    packageFile = JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules/c8/package.json'), 'utf8'),
    );
  } catch {
    throw Error(`The locked c8 ${C8_VERSION} dependency is required.`);
  }
  if (!object(packageFile) || packageFile.version !== C8_VERSION)
    throw Error(`The locked c8 ${C8_VERSION} dependency is required.`);
  let result: ReturnType<TypeScriptCoverageRunner>;
  try {
    result = run(
      process.execPath,
      [
        path.join(root, 'node_modules/c8/bin/c8.js'),
        '--all',
        '--extension=.mts',
        '--include=ui/**/*.mts',
        '--include=scripts/**/*.mts',
        '--include=vite.config.mts',
        '--exclude-node-modules',
        '--reporter=json',
        '--reporter=lcovonly',
        `--reports-dir=${output}`,
        `--temp-directory=${path.join(output, 'v8')}`,
        process.execPath,
        'scripts/ci/coverage.mts',
      ],
      { cwd: root, env, shell: false, windowsHide: true, stdio: 'inherit', encoding: 'utf8' },
    );
  } catch {
    throw Error('TypeScript tests or coverage collection failed.');
  }
  if (result.error || result.status !== 0)
    throw Error('TypeScript tests or coverage collection failed.');
  const raw = path.join(output, 'coverage-final.json');
  let info: fs.Stats;
  try {
    info = fs.lstatSync(raw);
  } catch {
    throw Error('TypeScript coverage report is missing.');
  }
  if (!info.isFile() || info.isSymbolicLink())
    throw Error('TypeScript coverage report is not a regular file.');
  if (info.size > MAX_REPORT_BYTES) throw Error('TypeScript coverage report is too large.');
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(raw, 'utf8'));
  } catch {
    throw Error('TypeScript coverage report is not valid JSON.');
  }
  const report = parseTypeScriptCoverage(input, root, typeScriptSources(root));
  const markdown = typeScriptCoverageMarkdown(report);
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'coverage.md'), markdown);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  if (report.missing.length) throw Error('TypeScript coverage source inventory is incomplete.');
  console.log(`Full TypeScript coverage: ${display(report.overall.lines)} lines.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runTypeScriptCoverage();
