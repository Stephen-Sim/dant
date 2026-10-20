import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../core/manifest-json.mts';
import { projectRoot } from './version.mts';

export const PYTHON_COVERAGE_VERSION = '7.16.2';
export const pythonCoverageThresholds = Object.freeze({ lines: 95, branches: 90 });
const TOOL_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 600_000;
const OUTPUT_DIRECTORY = '.cache/coverage/python';

export interface PythonCounts {
  coveredLines: number;
  totalLines: number;
  coveredBranches: number;
  totalBranches: number;
}

export interface PythonFileCoverage extends PythonCounts {
  file: string;
  missingLines: number[];
  missingBranches: [number, number][];
}

export interface PythonCoverage {
  totals: PythonCounts;
  files: PythonFileCoverage[];
}

/** Git's complete maintained inventory includes new source, never cached/vendor files. */
export function discoverPythonSources(root: string): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.py'],
    { cwd: root, encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, windowsHide: true },
  );
  if (result.error || result.status !== 0) throw Error('Python source discovery failed.');

  const names = [...new Set(result.stdout.split('\0').filter(Boolean))]
    .filter((name) => !name.startsWith('tests/'))
    .sort();
  if (!names.length) throw Error('No maintained Python sources were found.');
  for (const name of names) {
    const relative = path.relative(root, path.resolve(root, name));
    if (relative.startsWith('..') || path.isAbsolute(relative) || !name.endsWith('.py'))
      throw Error('Python source inventory escaped the repository.');
    const info = fs.lstatSync(path.join(root, name));
    if (!info.isFile() || info.isSymbolicLink())
      throw Error('Python source is not a regular file.');
  }
  return names;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw Error('Invalid Python coverage count.');
  return value;
}

function counts(value: unknown): PythonCounts {
  if (!isRecord(value)) throw Error('Missing Python coverage counts.');
  if (value.excluded_lines !== 0)
    throw Error('Maintained Python code cannot be excluded from coverage.');
  const result = {
    coveredLines: count(value.covered_lines),
    totalLines: count(value.num_statements),
    coveredBranches: count(value.covered_branches),
    totalBranches: count(value.num_branches),
  };
  if (result.coveredLines > result.totalLines || result.coveredBranches > result.totalBranches)
    throw Error('Invalid Python coverage totals.');
  return result;
}

export function parsePythonCoverage(raw: unknown, expected: readonly string[]): PythonCoverage {
  if (
    !isRecord(raw) ||
    !isRecord(raw.meta) ||
    raw.meta.branch_coverage !== true ||
    !isRecord(raw.files)
  )
    throw Error('Python branch coverage report is missing.');
  const reports = new Map(
    Object.entries(raw.files).map(([name, value]) => [name.replaceAll('\\', '/'), value]),
  );
  if (
    reports.size !== Object.keys(raw.files).length ||
    reports.size !== expected.length ||
    expected.some((name) => !reports.has(name))
  )
    throw Error('Python coverage does not contain the complete maintained source inventory.');

  const files = expected.map((file): PythonFileCoverage => {
    const value = reports.get(file);
    if (
      !isRecord(value) ||
      !Array.isArray(value.missing_lines) ||
      !Array.isArray(value.missing_branches) ||
      !Array.isArray(value.excluded_lines) ||
      value.excluded_lines.length !== 0
    )
      throw Error('Invalid Python file coverage.');
    const missingLines = value.missing_lines.map(count);
    const missingBranches = value.missing_branches.map((branch): [number, number] => {
      if (
        !Array.isArray(branch) ||
        branch.length !== 2 ||
        !branch.every((item) => Number.isSafeInteger(item))
      )
        throw Error('Invalid Python missing branch.');
      const [from, to] = branch;
      if (typeof from !== 'number' || from <= 0 || typeof to !== 'number')
        throw Error('Invalid Python missing branch.');
      return [from, to];
    });
    const summary = counts(value.summary);
    if (
      summary.totalLines - summary.coveredLines !== missingLines.length ||
      summary.totalBranches - summary.coveredBranches !== missingBranches.length
    )
      throw Error('Python missing coverage counts disagree.');
    return { file, ...summary, missingLines, missingBranches };
  });
  const totals = counts(raw.totals);
  for (const key of ['coveredLines', 'totalLines', 'coveredBranches', 'totalBranches'] as const)
    if (files.reduce((sum, file) => sum + file[key], 0) !== totals[key])
      throw Error('Python coverage totals disagree with its files.');
  return { totals, files };
}

const percentage = (covered: number, total: number): string =>
  `${(total ? (covered * 100) / total : 100).toFixed(2)}%`;

export function pythonCoverageMarkdown(report: PythonCoverage): string {
  const rows = [
    '## Python coverage',
    '',
    `All ${report.files.length} maintained Python source files are included, including unexecuted files.`,
    `Required overall coverage: ${pythonCoverageThresholds.lines}% lines and ${pythonCoverageThresholds.branches}% branches.`,
    '',
    '| File | Lines covered / total | Line coverage | Branches covered / total | Branch coverage |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const item of [{ file: '**Total**', ...report.totals }, ...report.files])
    rows.push(
      `| ${item.file} | ${item.coveredLines} / ${item.totalLines} | ${percentage(item.coveredLines, item.totalLines)} | ${item.coveredBranches} / ${item.totalBranches} | ${percentage(item.coveredBranches, item.totalBranches)} |`,
    );
  rows.push('', '<details><summary>Missing executable lines and branches</summary>', '');
  for (const file of report.files) {
    rows.push(
      `- ${file.file}: lines ${file.missingLines.join(', ') || 'none'}; branches ${file.missingBranches.map(([from, to]) => `${from}→${to <= 0 ? 'exit' : to}`).join(', ') || 'none'}.`,
    );
  }
  return [...rows, '', '</details>', ''].join('\n');
}

export function pythonCoverageFailures(report: PythonCoverage): string[] {
  const totals = report.totals;
  const failures: string[] = [];
  if (totals.coveredLines * 100 < totals.totalLines * pythonCoverageThresholds.lines)
    failures.push(
      `Python line coverage ${percentage(totals.coveredLines, totals.totalLines)} is below ${pythonCoverageThresholds.lines}%.`,
    );
  if (totals.coveredBranches * 100 < totals.totalBranches * pythonCoverageThresholds.branches)
    failures.push(
      `Python branch coverage ${percentage(totals.coveredBranches, totals.totalBranches)} is below ${pythonCoverageThresholds.branches}%.`,
    );
  return failures;
}

const REPORT = `import json, os, pathlib, sys
from coverage import Coverage
configuration, inventory, output = sys.argv[1:]
names = [os.path.normpath(name) for name in json.loads(pathlib.Path(inventory).read_text(encoding='utf-8'))]
coverage = Coverage(config_file=configuration)
coverage.load()
coverage.combine(strict=True, keep=True)
coverage.get_data().touch_files(names)
coverage.save()
coverage.json_report(morfs=names, outfile=str(pathlib.Path(output) / 'coverage.json'))
coverage.xml_report(morfs=names, outfile=str(pathlib.Path(output) / 'coverage.xml'))
coverage.html_report(morfs=names, directory=str(pathlib.Path(output) / 'html'))
`;

export function runPythonCoverage(python = 'python', root = projectRoot): number {
  const names = discoverPythonSources(root);
  const output = path.join(root, OUTPUT_DIRECTORY);
  if (path.relative(root, output).replaceAll('\\', '/') !== OUTPUT_DIRECTORY)
    throw Error('Invalid Python coverage output directory.');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  const version = spawnSync(
    python,
    [
      '-c',
      "import importlib.metadata,json,pathlib,site; print(json.dumps({'version':importlib.metadata.version('coverage'),'subprocessBootstrap':any((pathlib.Path(p)/'a1_coverage.pth').is_file() for p in [*site.getsitepackages(),site.getusersitepackages()])}))",
    ],
    { cwd: root, env, encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, windowsHide: true },
  );
  const tool: unknown = version.status === 0 ? JSON.parse(version.stdout) : null;
  if (
    version.error ||
    !isRecord(tool) ||
    tool.version !== PYTHON_COVERAGE_VERSION ||
    tool.subprocessBootstrap !== true
  )
    throw Error(
      `Install coverage.py ${PYTHON_COVERAGE_VERSION} into this Python environment using scripts/ci/python-coverage-requirements.txt; --target does not enable subprocess coverage.`,
    );

  const configuration = path.join(output, 'coverage.ini');
  const inventory = path.join(output, 'sources.json');
  fs.writeFileSync(inventory, JSON.stringify(names, null, 2) + '\n');
  fs.writeFileSync(
    configuration,
    `[run]\nbranch = true\nparallel = true\npatch = subprocess\nrelative_files = true\ndata_file = ${path.join(output, '.coverage').replaceAll('\\', '/')}\ninclude =\n${names.map((name) => `    ${path.join(root, name).replaceAll('\\', '/')}`).join('\n')}\n[report]\nexclude_lines =\npartial_branches =\n`,
  );
  const log = fs.openSync(path.join(output, 'tests.txt'), 'w');
  let status: number | null;
  try {
    const result = spawnSync(
      python,
      [
        '-m',
        'coverage',
        'run',
        `--rcfile=${configuration}`,
        '-m',
        'unittest',
        'discover',
        '-s',
        'tests/vm',
        '-p',
        'test_*.py',
        '-v',
      ],
      {
        cwd: root,
        env,
        stdio: ['ignore', log, log],
        timeout: TEST_TIMEOUT_MS,
        windowsHide: true,
        shell: false,
      },
    );
    if (result.error) throw result.error;
    status = result.status;
  } finally {
    fs.closeSync(log);
  }
  const result = spawnSync(python, ['-c', REPORT, configuration, inventory, output], {
    cwd: root,
    env,
    stdio: 'inherit',
    timeout: TOOL_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) throw Error('Python coverage report generation failed.');
  const report = parsePythonCoverage(
    JSON.parse(fs.readFileSync(path.join(output, 'coverage.json'), 'utf8')) as unknown,
    names,
  );
  const markdown = pythonCoverageMarkdown(report);
  fs.writeFileSync(path.join(output, 'coverage.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown.split('<details>')[0]);
  const failures = pythonCoverageFailures(report);
  for (const failure of failures) console.error(failure);
  console.log(`Python tests exit: ${status}; complete reports: ${OUTPUT_DIRECTORY}`);
  return status === 0 && failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--python' || !args[1]))
    throw Error('Usage: node scripts/ci/python-coverage.mts [--python executable]');
  process.exitCode = runPythonCoverage(args[1]);
}
