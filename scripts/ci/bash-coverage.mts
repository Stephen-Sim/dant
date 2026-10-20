import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KCOV_VERSION = '43';
export const KCOV_SOURCE_COMMIT = 'a39874f938ce13f7a65f253120d1ec946b349ffe';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
interface BashFileCoverage {
  file: string;
  covered: number;
  total: number;
}
export interface BashCoverage {
  tool: 'kcov 43';
  files: BashFileCoverage[];
  covered: number;
  total: number;
  missing: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseBashCoverage(
  input: unknown,
  root: string,
  expected: readonly string[],
): BashCoverage {
  if (
    !object(input) ||
    !Array.isArray(input.files) ||
    !expected.length ||
    new Set(expected).size !== expected.length ||
    expected.some((file) => !/^vm\/[\w-]+\.sh$/.test(file))
  )
    throw Error('Invalid Bash coverage report or source inventory.');
  const files: BashFileCoverage[] = [];
  for (const entry of input.files) {
    if (!object(entry) || typeof entry.file !== 'string')
      throw Error('Invalid Bash coverage file.');
    const file = path.relative(root, path.resolve(root, entry.file)).replaceAll('\\', '/');
    if (!expected.includes(file)) continue;
    const numeric = (value: unknown): number => {
      if (
        typeof value !== 'string' ||
        !/^(?:0|[1-9]\d*)$/.test(value) ||
        !Number.isSafeInteger(Number(value))
      )
        throw Error('Invalid Bash coverage counters.');
      return Number(value);
    };
    const covered = numeric(entry.covered_lines),
      total = numeric(entry.total_lines);
    if (covered > total || files.some((entry) => entry.file === file))
      throw Error('Invalid Bash coverage counters.');
    files.push({ file, covered, total });
  }
  const covered = files.reduce((sum, file) => sum + file.covered, 0),
    total = files.reduce((sum, file) => sum + file.total, 0);
  if (!total || !Number.isSafeInteger(total))
    throw Error('Bash coverage contains no executable source.');
  return {
    tool: 'kcov 43',
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
    covered,
    total,
    missing: expected.filter((file) => !files.some((entry) => entry.file === file)),
  };
}

export function bashCoverageMarkdown(report: BashCoverage): string {
  const display = (covered: number, total: number): string =>
    total
      ? `${((covered * 100) / total).toFixed(2)}% (${covered}/${total})`
      : 'No executable shell lines (0/0)';
  return [
    '# Bash shell coverage',
    '',
    `Overall: ${display(report.covered, report.total)} shell lines.`,
    '',
    '| Source | Covered/total shell lines |',
    '| --- | ---: |',
    ...report.files.map((file) => `| \`${file.file}\` | ${display(file.covered, file.total)} |`),
    ...report.missing.map((file) => `| \`${file}\` | Not measured |`),
    '',
    'Measured with kcov 43 DEBUG tracing against the complete maintained shell inventory. Shell lines and embedded Python programs are different scopes; shell coverage does not prove that a Python heredoc was exercised. Fixture commands do not install packages, contact services, start a model or operate a real VM.',
    '',
  ].join('\n');
}

export function runBashCoverage(root = ROOT): void {
  if (process.platform !== 'linux')
    throw Error(
      'Bash coverage requires the documented pinned kcov 43 Linux environment. No platform skip is counted as coverage.',
    );
  const output = path.join(root, '.cache/coverage/bash');
  fs.mkdirSync(output, { recursive: true });
  for (const file of ['coverage.json', 'coverage.md', 'summary.json'])
    fs.rmSync(path.join(output, file), { force: true });
  const local = path.join(root, '.tools/kcov/bin/kcov');
  const kcov = fs.existsSync(local) ? local : 'kcov';
  const probe = spawnSync(kcov, ['--version'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    maxBuffer: 4096,
  });
  if (probe.error || probe.status !== 0 || !/^kcov (?:version: )?43\s*$/.test(probe.stdout.trim()))
    throw Error('The pinned kcov 43 tool is required.');
  const expected = fs
    .readdirSync(path.join(root, 'vm'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
    .map((entry) => `vm/${entry.name}`)
    .sort();
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-bash-coverage-'));
  try {
    const result = spawnSync(
      kcov,
      [
        '--clean',
        '--bash-method=DEBUG',
        `--bash-parse-files-in-dir=${path.join(root, 'vm')}`,
        `--include-path=${path.join(root, 'vm')}`,
        output,
        path.join(root, 'tests/bash/runtime.test.sh'),
      ],
      {
        cwd: root,
        env: { ...process.env, DANT_BASH_FIXTURE_ROOT: fixture, DANT_BASH_REPOSITORY: root },
        shell: false,
        stdio: 'inherit',
        timeout: 120_000,
      },
    );
    if (result.error || result.status !== 0)
      throw Error('Bash fixture tests or instrumentation failed.');
    const generated = path.join(output, 'runtime.test.sh/coverage.json');
    if (fs.statSync(generated).size > 8 * 1024 * 1024)
      throw Error('Bash coverage report is too large.');
    const raw = fs.readFileSync(generated, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const report = parseBashCoverage(parsed, root, expected),
      markdown = bashCoverageMarkdown(report);
    fs.writeFileSync(path.join(output, 'coverage.json'), raw);
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'coverage.md'), markdown);
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(markdown);
    if (report.missing.length) throw Error('Bash coverage inventory is incomplete.');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runBashCoverage();
