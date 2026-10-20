import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseBashCoverage, bashCoverageMarkdown } from '../../../scripts/ci/bash-coverage.mts';

const expected = ['vm/bootstrap.sh', 'vm/start-codex.sh'];
const row = (file: string, covered = '1', total = '2') => ({
  file,
  covered_lines: covered,
  total_lines: total,
  percent_covered: '100.00',
});
test('original Bash entrypoints preserve readiness/failure and launch only synthetic fixture commands', () => {
  const bash =
    process.platform === 'win32'
      ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')
      : 'bash';
  const result = spawnSync(bash, ['--noprofile', '--norc', 'tests/bash/run.test.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Bash runtime fixtures passed/);
});
test('Bash coverage uses kcov executable counts, retains missing scripts and does not claim Python heredoc coverage', () => {
  const report = parseBashCoverage(
    { files: [row(expected[0]!, '1', '9'), row(expected[1]!, '1', '1')] },
    process.cwd(),
    expected,
  );
  assert.equal(report.covered, 2);
  assert.equal(report.total, 10);
  assert.deepEqual(report.missing, []);
  assert.match(bashCoverageMarkdown(report), /20\.00% \(2\/10\)/);
  assert.match(bashCoverageMarkdown(report), /does not prove that a Python heredoc was exercised/);
  const missing = parseBashCoverage({ files: [row(expected[0]!)] }, process.cwd(), expected);
  assert.deepEqual(missing.missing, [expected[1]]);
  assert.match(bashCoverageMarkdown(missing), /start-codex\.sh` \| Not measured/);
});
test('empty, impossible, duplicate or malformed Bash counts cannot imply full coverage', () => {
  for (const value of [
    null,
    {},
    { files: [] },
    { files: [row(expected[0]!, '3', '2')] },
    { files: [row(expected[0]!, '-1')] },
    { files: [row(expected[0]!, '1.5')] },
    { files: [row(expected[0]!), row(expected[0]!)] },
  ])
    assert.throws(() => parseBashCoverage(value, process.cwd(), expected));
  assert.throws(() =>
    parseBashCoverage({ files: [row(expected[0]!)] }, process.cwd(), ['vm/unsafe|.sh']),
  );
});
