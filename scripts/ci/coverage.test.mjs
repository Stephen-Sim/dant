import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLcov, assessCoverage, coverageMarkdown } from './coverage.mjs';

const record = (file, lineHit = 10) =>
  `SF:${file}\nLF:10\nLH:${lineHit}\nBRF:4\nBRH:4\nFNF:3\nFNH:3\nend_of_record\n`;
test('LCOV coverage is weighted by executable counts and normalizes source paths', () => {
  const files = parseLcov(record('src/a.mjs', 10) + record('src/b.mjs', 8));
  assert.equal(files[0].file, 'src/a.mjs');
  const result = assessCoverage(files, { required: [] });
  assert.equal(result.summary.lines, 90);
  assert.deepEqual(result.failures, []);
  assert.match(coverageMarkdown(result), /src\/b.mjs \| 80%/);
});
test('missing modules and insufficient branch, function, or line coverage fail the gate', () => {
  const files = parseLcov(
    record('src/a.mjs', 5).replace('BRH:4', 'BRH:1').replace('FNH:3', 'FNH:1'),
  );
  const result = assessCoverage(files, {
    required: ['src/telegram/telegram.mjs', 'src/a.mjs'],
    modules: ['src/never-tested.mjs'],
  });
  assert.equal(result.failures.length, 6);
  assert.match(result.failures.join('\n'), /Required module has no coverage: src\/telegram/);
  assert.match(result.failures.join('\n'), /Application module was never loaded by a test/);
});
test('empty or malformed LCOV cannot masquerade as complete coverage', () => {
  assert.throws(() => parseLcov(''), /no application files/);
  assert.throws(() => parseLcov(record('src/a.mjs', 11)), /Invalid LCOV/);
  assert.throws(
    () => parseLcov(record('src/a.mjs').replace('LF:10', 'LF:not-a-number')),
    /Invalid LCOV/,
  );
});
