import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import type { PythonCoverageRunner } from '../../../scripts/ci/python-coverage.mts';
import {
  discoverPythonSources,
  parsePythonCoverage,
  pythonCoverageMarkdown,
  pythonCoverageFailures,
  runPythonCoverage,
} from '../../../scripts/ci/python-coverage.mts';

const summary = (covered: number, total: number, branches = 1, branchTotal = 2) => ({
  covered_lines: covered,
  num_statements: total,
  covered_branches: branches,
  num_branches: branchTotal,
  excluded_lines: 0,
});

const report = () => ({
  meta: { branch_coverage: true },
  files: {
    'vm\\worker-install.py': {
      summary: summary(2, 3),
      missing_lines: [8],
      missing_branches: [[5, -1]],
      excluded_lines: [],
    },
    'scripts/unexecuted.py': {
      summary: summary(0, 2, 0, 0),
      missing_lines: [1, 2],
      missing_branches: [],
      excluded_lines: [],
    },
  },
  totals: summary(2, 5),
});

test('Python reports retain unexecuted source and weight actual line and branch counts', () => {
  const result = parsePythonCoverage(report(), ['scripts/unexecuted.py', 'vm/worker-install.py']);
  assert.deepEqual(result.totals, {
    coveredLines: 2,
    totalLines: 5,
    coveredBranches: 1,
    totalBranches: 2,
  });
  const text = pythonCoverageMarkdown(result);
  assert.match(text, /\*\*Total\*\* \| 2 \/ 5 \| 40\.00% \| 1 \/ 2 \| 50\.00%/);
  assert.match(text, /scripts\/unexecuted.py \| 0 \/ 2 \| 0\.00%/);
  assert.match(text, /worker-install.py: lines 8; branches 5→exit/);
});

test('missing source, missing branches, corrupt totals and erased missing lines fail closed', () => {
  const names = ['scripts/unexecuted.py', 'vm/worker-install.py'];
  assert.throws(() => parsePythonCoverage(report(), [...names, 'vm/not-imported.py']), /inventory/);
  assert.throws(
    () => parsePythonCoverage({ ...report(), meta: { branch_coverage: false } }, names),
    /branch/,
  );
  assert.throws(
    () => parsePythonCoverage({ ...report(), totals: summary(3, 5) }, names),
    /totals disagree/,
  );
  const missing = report();
  missing.files['scripts/unexecuted.py'].missing_lines = [];
  assert.throws(() => parsePythonCoverage(missing, names), /counts disagree/);
  const corrupt = report();
  corrupt.files['vm\\worker-install.py'].summary.covered_branches = 3;
  assert.throws(() => parsePythonCoverage(corrupt, names), /totals/);
  const excluded = report();
  excluded.files['scripts/unexecuted.py'].summary.excluded_lines = 1;
  assert.throws(() => parsePythonCoverage(excluded, names), /excluded/);
});

test('Python discovery includes new and unimported maintained paths while ignoring caches and tests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-python-inventory-'));
  try {
    const git = spawnSync('git', ['init', '--quiet', root], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(git.status, 0, git.stderr);
    fs.writeFileSync(path.join(root, '.gitignore'), '.cache/\n');
    for (const file of [
      'scripts/never-imported.py',
      'vm/worker-install.py',
      'other/tool.py',
      'tests/vm/test_tool.py',
      '.cache/fixture.py',
    ]) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'raise RuntimeError("Discovery must never execute source")\n');
    }
    assert.deepEqual(discoverPythonSources(root), [
      'other/tool.py',
      'scripts/never-imported.py',
      'vm/worker-install.py',
    ]);
    const add = spawnSync('git', ['-C', root, 'add', 'scripts/never-imported.py'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(add.status, 0, add.stderr);
    assert.deepEqual(discoverPythonSources(root), [
      'other/tool.py',
      'scripts/never-imported.py',
      'vm/worker-install.py',
    ]);
    fs.rmSync(path.join(root, 'scripts/never-imported.py'));
    assert.throws(() => discoverPythonSources(root), /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Python gates require 95% lines and 90% branches without rounding a shortfall into success', () => {
  const result = parsePythonCoverage(report(), ['scripts/unexecuted.py', 'vm/worker-install.py']);
  assert.equal(pythonCoverageFailures(result).length, 2);
  result.totals = {
    coveredLines: 18999,
    totalLines: 20000,
    coveredBranches: 90,
    totalBranches: 100,
  };
  assert.equal(pythonCoverageFailures(result).length, 1);
  result.totals.coveredLines = 19000;
  assert.deepEqual(pythonCoverageFailures(result), []);
});

function collectorFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-python-collector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  fs.mkdirSync(path.join(root, 'vm'));
  fs.writeFileSync(path.join(root, '.gitignore'), '.cache/\n');
  fs.writeFileSync(
    path.join(root, 'vm/example.py'),
    'raise RuntimeError("Never execute fixture source")\n',
  );
  const output = path.join(root, '.cache/coverage/python');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'coverage.json'), 'stale previous report');
  const missingLines: number[] = [];
  const missingBranches: [number, number][] = [];
  const measured = {
    meta: { branch_coverage: true },
    files: {
      'vm/example.py': {
        summary: summary(2, 2, 2, 2),
        missing_lines: missingLines,
        missing_branches: missingBranches,
        excluded_lines: [],
      },
    },
    totals: summary(2, 2, 2, 2),
  };
  const calls: { args: readonly string[]; options: Parameters<PythonCoverageRunner>[2] }[] = [];
  const messages: string[] = [];
  const errors: string[] = [];
  let testStatus: number | null = 0;
  let testError: Error | undefined;
  let version = JSON.stringify({ version: '7.16.2', subprocessBootstrap: true });
  let generate = () =>
    fs.writeFileSync(path.join(output, 'coverage.json'), JSON.stringify(measured));
  let reportStatus = 0;
  const run: PythonCoverageRunner = (executable, args, options) => {
    assert.equal(executable, 'synthetic-python');
    assert.equal(options.cwd, root);
    assert.equal(options.shell, false);
    assert.equal(options.env?.PYTHONDONTWRITEBYTECODE, '1');
    calls.push({ args, options });
    if (calls.length === 1) {
      assert.equal(fs.existsSync(path.join(output, 'coverage.json')), false);
      return { status: 0, stdout: version };
    }
    if (calls.length === 2)
      return { status: testStatus, ...(testError ? { error: testError } : {}) };
    assert.equal(calls.length, 3, 'A failed or unknown process is never retried.');
    generate();
    return { status: reportStatus };
  };
  const options = {
    run,
    environment: { GITHUB_STEP_SUMMARY: path.join(root, 'summary.md') },
    write: (message: string) => messages.push(message),
    writeError: (message: string) => errors.push(message),
  };
  return {
    root,
    output,
    calls,
    measured,
    messages,
    errors,
    options,
    version: (value: string) => {
      version = value;
    },
    testResult: (status: number | null, error?: Error) => {
      testStatus = status;
      testError = error;
    },
    reportResult: (status: number, create: () => void = generate) => {
      reportStatus = status;
      generate = create;
    },
  };
}

test('Python collection uses fresh source, pinned subprocess instrumentation and exact isolated commands', (t) => {
  const f = collectorFixture(t);
  assert.equal(runPythonCoverage('synthetic-python', f.root, f.options), 0);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output, 'sources.json'), 'utf8')), [
    'vm/example.py',
  ]);
  assert.match(fs.readFileSync(path.join(f.output, 'coverage.ini'), 'utf8'), /patch = subprocess/);
  assert.match(
    fs.readFileSync(path.join(f.output, 'coverage.ini'), 'utf8'),
    /exclude_lines =\npartial_branches =\n/,
  );
  assert.deepEqual(f.calls[1]?.args, [
    '-m',
    'coverage',
    'run',
    `--rcfile=${path.join(f.output, 'coverage.ini')}`,
    '-m',
    'unittest',
    'discover',
    '-s',
    'tests/vm',
    '-p',
    'test_*.py',
    '-v',
  ]);
  const log = f.calls[1]?.options.stdio;
  assert.ok(Array.isArray(log));
  assert.equal(log[1], log[2]);
  assert.equal(typeof log[1], 'number');
  assert.throws(() => fs.fstatSync(Number(log[1])), /EBADF/);
  assert.match(fs.readFileSync(path.join(f.root, 'summary.md'), 'utf8'), /All 1 maintained Python/);
  assert.deepEqual(f.errors, []);
});

test('invalid, unpinned, oversized or non-subprocess Python metadata fails without exposing it', (t) => {
  for (const raw of [
    'private malformed output',
    JSON.stringify({ version: '0.0.0', subprocessBootstrap: true }),
    JSON.stringify({ version: '7.16.2', subprocessBootstrap: false }),
    'x'.repeat(16 * 1024 + 1),
  ]) {
    const f = collectorFixture(t);
    f.version(raw);
    assert.throws(
      () => runPythonCoverage('synthetic-python', f.root, f.options),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Install coverage.py 7\.16\.2/);
        assert.doesNotMatch(error.message, /private malformed|xxxx/);
        return true;
      },
    );
    assert.equal(f.calls.length, 1);
    assert.equal(fs.existsSync(path.join(f.output, 'coverage.json')), false);
  }
});

test('a failed Python test process cannot become success through a full-coverage report', (t) => {
  for (const status of [7, null]) {
    const f = collectorFixture(t);
    f.testResult(status);
    assert.equal(runPythonCoverage('synthetic-python', f.root, f.options), 1);
    assert.match(f.messages.at(-1) ?? '', new RegExp(`Python tests exit: ${status}`));
    assert.equal(f.calls.length, 3);
  }
  const f = collectorFixture(t);
  f.testResult(null, Error('private process output'));
  assert.throws(
    () => runPythonCoverage('synthetic-python', f.root, f.options),
    /^Error: Python coverage test process failed\.$/,
  );
  assert.equal(f.calls.length, 2);
  assert.equal(fs.existsSync(path.join(f.output, 'coverage.md')), false);
});

test('fresh Python report failure, invalid JSON, excessive size and low coverage never reuse a prior pass', (t) => {
  for (const mode of ['failed', 'json', 'large', 'low'] as const) {
    const f = collectorFixture(t);
    f.reportResult(mode === 'failed' ? 4 : 0, () => {
      const file = path.join(f.output, 'coverage.json');
      if (mode === 'json') fs.writeFileSync(file, 'private malformed report');
      if (mode === 'large') {
        fs.writeFileSync(file, '');
        fs.truncateSync(file, 64 * 1024 * 1024 + 1);
      }
      if (mode === 'low') {
        f.measured.files['vm/example.py'].summary = summary(1, 2, 1, 2);
        f.measured.files['vm/example.py'].missing_lines = [1];
        f.measured.files['vm/example.py'].missing_branches = [[1, 2]];
        f.measured.totals = summary(1, 2, 1, 2);
        fs.writeFileSync(file, JSON.stringify(f.measured));
      }
    });
    if (mode === 'low') {
      assert.equal(runPythonCoverage('synthetic-python', f.root, f.options), 1);
      assert.equal(f.errors.length, 2);
    } else {
      assert.throws(
        () => runPythonCoverage('synthetic-python', f.root, f.options),
        /report generation failed|invalid JSON|bounded regular file/,
      );
      assert.equal(fs.existsSync(path.join(f.output, 'coverage.md')), false);
      assert.equal(fs.existsSync(path.join(f.root, 'summary.md')), false);
    }
    assert.equal(f.calls.length, 3);
  }
});

test('failed Python source discovery clears old reports before reporting its prerequisite failure', (t) => {
  const f = collectorFixture(t);
  fs.rmSync(path.join(f.root, 'vm/example.py'));
  assert.throws(
    () => runPythonCoverage('synthetic-python', f.root, f.options),
    /No maintained Python/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.output, 'coverage.json')), false);
});
