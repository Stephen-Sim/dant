import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RUST_VERSION = '1.99.1';
export const LLVM_COV_VERSION = '0.9.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const METRICS = ['lines', 'functions', 'regions'] as const;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
type Metric = (typeof METRICS)[number];
interface Count {
  covered: number;
  total: number;
}
type Counts = Record<Metric, Count>;
export interface NativeCoverageFile {
  file: string;
  counts: Counts;
}
export interface NativeCoverageReport {
  files: NativeCoverageFile[];
  overall: Counts;
  expected: string[];
  missing: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function count(value: unknown): Count {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.covered) ||
    !Number.isSafeInteger(value.count) ||
    Number(value.covered) < 0 ||
    Number(value.count) < Number(value.covered)
  )
    throw Error('Invalid LLVM coverage counts.');
  return { covered: Number(value.covered), total: Number(value.count) };
}

/** The denominator is every owned Rust source, including the native entrypoint/build script. */
export function nativeSources(root: string): string[] {
  const walk = (directory: string): string[] =>
    fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const file = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw Error('Native source inventory contains a symbolic link.');
      return entry.isDirectory()
        ? walk(file)
        : entry.isFile() && file.endsWith('.rs')
          ? [file]
          : [];
    });
  return ['src-tauri/build.rs', ...walk('src-tauri/src')].sort();
}

export function parseNativeCoverage(
  input: unknown,
  root: string,
  expected: readonly string[],
): NativeCoverageReport {
  if (
    !object(input) ||
    input.type !== 'llvm.coverage.json.export' ||
    !Array.isArray(input.data) ||
    input.data.length !== 1 ||
    !object(input.data[0]) ||
    !Array.isArray(input.data[0].files) ||
    !expected.length ||
    new Set(expected).size !== expected.length ||
    expected.some((file) => !/^src-tauri\/(?:src\/[\w/-]+\.rs|build\.rs)$/.test(file))
  )
    throw Error('Invalid LLVM coverage report or native source inventory.');

  const files: NativeCoverageFile[] = [];
  const seen = new Set<string>();
  for (const value of input.data[0].files) {
    if (!object(value) || typeof value.filename !== 'string' || !object(value.summary))
      throw Error('Invalid LLVM coverage file.');
    const file = path.relative(root, path.resolve(root, value.filename)).replaceAll('\\', '/');
    // LLVM may also name generated/dependency or external test sources. They are not native code.
    if (!expected.includes(file)) continue;
    if (seen.has(file)) throw Error('Duplicate native source in LLVM coverage report.');
    seen.add(file);
    files.push({
      file,
      counts: {
        lines: count(value.summary.lines),
        functions: count(value.summary.functions),
        regions: count(value.summary.regions),
      },
    });
  }
  if (!files.length || !files.some((file) => file.counts.lines.total > 0))
    throw Error('LLVM coverage contains no executable native source.');
  const overall: Counts = {
    lines: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    regions: { covered: 0, total: 0 },
  };
  for (const file of files)
    for (const metric of METRICS) {
      overall[metric].covered += file.counts[metric].covered;
      overall[metric].total += file.counts[metric].total;
      if (!Number.isSafeInteger(overall[metric].total))
        throw Error('Invalid LLVM coverage totals.');
    }
  return {
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
    overall,
    expected: [...expected],
    missing: expected.filter((file) => !seen.has(file)),
  };
}

function display(value: Count): string {
  return value.total
    ? `${((100 * value.covered) / value.total).toFixed(2)}% (${value.covered}/${value.total})`
    : 'No executable points (0/0)';
}

export function nativeCoverageMarkdown(report: NativeCoverageReport): string {
  return [
    '# Rust native LLVM coverage',
    '',
    ...METRICS.map((metric) => `- ${metric}: ${display(report.overall[metric])}`),
    '',
    '| Source | Lines | Functions | Regions |',
    '| --- | ---: | ---: | ---: |',
    ...report.files.map(
      (file) =>
        `| \`${file.file}\` | ${METRICS.map((key) => display(file.counts[key])).join(' | ')} |`,
    ),
    ...report.missing.map((file) => `| \`${file}\` | Not measured | Not measured | Not measured |`),
    '',
    'Actual LLVM instrumentation on this platform; unit test counts are not coverage. Stable Rust reports lines, functions and regions, not branch coverage. Other platform-only code still needs its own instrumented run.',
    '',
    ...(report.missing.length
      ? [
          'FAIL: Some native source files were not represented; this is not complete native coverage.',
          '',
        ]
      : []),
  ].join('\n');
}

export function runNativeCoverage(root = ROOT): void {
  const output = path.join(root, '.cache/coverage/rust');
  fs.mkdirSync(output, { recursive: true });
  for (const file of ['coverage.json', 'lcov.info', 'coverage.md', 'summary.json'])
    fs.rmSync(path.join(output, file), { force: true });

  const environment = {
    ...process.env,
    RUSTUP_TOOLCHAIN: RUST_VERSION,
    CARGO_LLVM_COV_TARGET_DIR: path.join(root, '.cache/coverage/rust-target'),
    CARGO_INCREMENTAL: '0',
  };
  const run = (args: string[], capture = false): string => {
    const result = spawnSync('cargo', args, {
      cwd: root,
      env: environment,
      windowsHide: true,
      shell: false,
      timeout: 30 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      stdio: capture ? 'pipe' : 'inherit',
    });
    if (result.error || result.status !== 0) throw Error('Native coverage command failed.');
    return capture ? result.stdout.trim() : '';
  };
  if (run(['llvm-cov', '--version'], true) !== `cargo-llvm-cov ${LLVM_COV_VERSION}`)
    throw Error(
      `cargo-llvm-cov ${LLVM_COV_VERSION} is required; use the documented locked installation.`,
    );
  const manifest = [
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--locked',
    '--include-build-script',
  ];
  run(['llvm-cov', ...manifest, '--json', '--output-path', path.join(output, 'coverage.json')]);
  run([
    'llvm-cov',
    'report',
    ...manifest,
    '--lcov',
    '--output-path',
    path.join(output, 'lcov.info'),
  ]);
  const raw = path.join(output, 'coverage.json');
  if (fs.statSync(raw).size > MAX_REPORT_BYTES) throw Error('Native coverage report is too large.');
  const parsed: unknown = JSON.parse(fs.readFileSync(raw, 'utf8'));
  const report = parseNativeCoverage(parsed, root, nativeSources(root));
  const markdown = nativeCoverageMarkdown(report);
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'coverage.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  if (report.missing.length) throw Error('Native coverage source inventory is incomplete.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runNativeCoverage();
