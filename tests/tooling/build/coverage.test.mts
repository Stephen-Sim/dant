import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLcov, assessCoverage, coverageMarkdown } from '../../../scripts/ci/coverage.mts';

const record = (file: string, lineHit = 10) =>
  `SF:${file}\nLF:10\nLH:${lineHit}\nBRF:4\nBRH:4\nFNF:3\nFNH:3\nend_of_record\n`;
test('LCOV coverage is weighted by executable counts and normalizes source paths', () => {
  const files = parseLcov(
    record('ui/chat/message-window.mts', 10) + record('ui/settings/appearance.mts', 8),
  );
  const first = files[0];
  assert.ok(first);
  assert.equal(first.file, 'ui/chat/message-window.mts');
  const result = assessCoverage(files, { required: [] });
  assert.equal(result.summary.lines, 90);
  assert.deepEqual(result.failures, []);
  assert.match(coverageMarkdown(result), /ui\/settings\/appearance.mts \| 80%/);
});
test('missing modules and insufficient branch, function, or line coverage fail the gate', () => {
  const files = parseLcov(
    record('ui/chat/message-window.mts', 5).replace('BRH:4', 'BRH:1').replace('FNH:3', 'FNH:1'),
  );
  const result = assessCoverage(files, {
    required: ['ui/settings/appearance.mts', 'ui/chat/message-window.mts'],
    modules: ['ui/work/progress-actions.mts'],
  });
  assert.equal(result.failures.length, 6);
  assert.match(
    result.failures.join('\n'),
    /Required module has no coverage: ui\/settings\/appearance.mts/,
  );
  assert.match(result.failures.join('\n'), /Application module was never loaded by a test/);
});
test('empty or malformed LCOV cannot masquerade as complete coverage', () => {
  assert.throws(() => parseLcov(''), /no application files/);
  assert.throws(() => parseLcov(record('ui/chat/message-window.mts', 11)), /Invalid LCOV/);
  assert.throws(
    () => parseLcov(record('ui/chat/message-window.mts').replace('LF:10', 'LF:not-a-number')),
    /Invalid LCOV/,
  );
});
