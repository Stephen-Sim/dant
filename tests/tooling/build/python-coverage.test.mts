import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  discoverPythonSources,
  parsePythonCoverage,
  pythonCoverageMarkdown,
  pythonCoverageFailures,
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
