import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverTests } from './test-files.mts';
import { TEST_CONCURRENCY } from './test-constants.mts';

export const coverageThresholds = Object.freeze({ lines: 90, branches: 80, functions: 80 });
const critical = [
  'src/app/controller.mts',
  'src/computer/vm-profiles.mts',
  'src/computer/vm-bridge.mts',
  'src/telegram/telegram.mts',
  'ui/settings/appearance.mts',
];
const COUNT_KEYS = ['LF', 'LH', 'BRF', 'BRH', 'FNF', 'FNH'] as const;
const COVERAGE_KINDS = ['lines', 'branches', 'functions'] as const;
type Counts = Record<(typeof COUNT_KEYS)[number], number>;
export interface CoverageRatios {
  lines: number;
  branches: number;
  functions: number;
}
export interface FileCoverage extends CoverageRatios {
  file: string;
  counts: Counts;
}
export interface CoverageResult {
  summary: CoverageRatios;
  thresholds: Readonly<CoverageRatios>;
  required: readonly string[];
  files: readonly FileCoverage[];
  failures: string[];
}
const ratio = (hit: number, total: number): number =>
  total ? Math.round((hit / total) * 10000) / 100 : 100;
export function parseLcov(text: string, root = process.cwd()): FileCoverage[] {
  const files: FileCoverage[] = [];
  for (const record of text.split('end_of_record')) {
    const values: Record<string, string> = {};
    for (const line of record.trim().split(/\r?\n/)) {
      const split = line.indexOf(':');
      if (split > 0) values[line.slice(0, split)] = line.slice(split + 1);
    }
    if (!values.SF) continue;
    const name = path.relative(root, path.resolve(root, values.SF)).replaceAll('\\', '/');
    const counts: Counts = {
      LF: Number(values.LF || 0),
      LH: Number(values.LH || 0),
      BRF: Number(values.BRF || 0),
      BRH: Number(values.BRH || 0),
      FNF: Number(values.FNF || 0),
      FNH: Number(values.FNH || 0),
    };
    if (
      Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0) ||
      counts.LH > counts.LF ||
      counts.BRH > counts.BRF ||
      counts.FNH > counts.FNF
    )
      throw Error('Invalid LCOV coverage counts');
    files.push({
      file: name,
      counts,
      lines: ratio(counts.LH, counts.LF),
      branches: ratio(counts.BRH, counts.BRF),
      functions: ratio(counts.FNH, counts.FNF),
    });
  }
  if (!files.length) throw Error('Coverage report has no application files');
  return files;
}
export function assessCoverage(
  files: readonly FileCoverage[],
  {
    thresholds = coverageThresholds,
    required = critical,
    modules = [],
  }: {
    thresholds?: Readonly<CoverageRatios>;
    required?: readonly string[];
    modules?: readonly string[];
  } = {},
): CoverageResult {
  const totals = { LF: 0, LH: 0, BRF: 0, BRH: 0, FNF: 0, FNH: 0 };
  for (const file of files) for (const key of COUNT_KEYS) totals[key] += file.counts[key];
  const summary = {
      lines: ratio(totals.LH, totals.LF),
      branches: ratio(totals.BRH, totals.BRF),
      functions: ratio(totals.FNH, totals.FNF),
    },
    failures: string[] = [];
  for (const kind of COVERAGE_KINDS) {
    const minimum = thresholds[kind];
    if (summary[kind] < minimum)
      failures.push(`Overall ${kind} coverage ${summary[kind]}% is below ${minimum}%`);
  }
  for (const name of required) {
    const file = files.find((file) => file.file === name);
    if (!file) failures.push(`Required module has no coverage: ${name}`);
    else if (file.lines < 90) failures.push(`${name} line coverage ${file.lines}% is below 90%`);
  }
  for (const name of modules)
    if (!required.includes(name) && !files.some((file) => file.file === name))
      failures.push(`Application module was never loaded by a test: ${name}`);
  return { summary, thresholds, required, files, failures };
}
export function coverageMarkdown(result: CoverageResult): string {
  return [
    '# TypeScript unit coverage',
    '',
    `Overall: lines ${result.summary.lines}%, branches ${result.summary.branches}%, functions ${result.summary.functions}%.`,
    '',
    '| Module | Lines | Branches | Functions |',
    '| --- | ---: | ---: | ---: |',
    ...result.files.map(
      (file) => `| ${file.file} | ${file.lines}% | ${file.branches}% | ${file.functions}% |`,
    ),
    '',
    'The browser entrypoint and native/VM device behavior have separate behavioral and device tests. This report measures loaded application TypeScript, not end-to-end device coverage.',
    '',
    ...result.failures.map((failure) => `- ${failure}`),
    '',
  ].join('\n');
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    output = path.join(root, '.cache/coverage');
  fs.mkdirSync(output, { recursive: true });
  const report = path.join(output, 'lcov.info'),
    log = path.join(output, 'tests.txt');
  // Never accept a report left by a previous successful run.
  for (const name of [
    report,
    log,
    path.join(output, 'summary.json'),
    path.join(output, 'summary.md'),
  ])
    fs.rmSync(name, { force: true });
  const tests = discoverTests(root);
  if (!tests.length) throw Error('No maintained Node tests were found.');
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-test-coverage',
      '--test-coverage-include=src/**/*.mts',
      '--test-coverage-include=ui/**/*.mts',
      '--test-reporter=spec',
      `--test-reporter-destination=${log}`,
      '--test-reporter=lcov',
      `--test-reporter-destination=${report}`,
      '--test',
      `--test-concurrency=${TEST_CONCURRENCY}`,
      ...tests,
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true, shell: false },
  );
  if (fs.existsSync(log)) process.stdout.write(fs.readFileSync(log, 'utf8'));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return;
  }
  const applicationModules = (directory: string): string[] =>
    fs
      .readdirSync(path.join(root, directory), { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? applicationModules(`${directory}/${entry.name}`)
          : /\.mts$/.test(entry.name) &&
              !['ui/main.mts', 'src/server.mts'].includes(`${directory}/${entry.name}`)
            ? [`${directory}/${entry.name}`]
            : [],
      );
  const modules = ['src', 'ui'].flatMap(applicationModules);
  const assessed = assessCoverage(parseLcov(fs.readFileSync(report, 'utf8'), root), { modules });
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(assessed, null, 2) + '\n');
  const markdown = coverageMarkdown(assessed);
  fs.writeFileSync(path.join(output, 'summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  for (const failure of assessed.failures) console.error(failure);
  console.log(`Coverage reports: ${path.relative(root, output)}`);
  if (assessed.failures.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
