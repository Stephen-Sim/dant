import test from 'node:test';
import assert from 'node:assert/strict';
import { testFileConcurrency, TEST_CONCURRENCY } from '../../../scripts/ci/test-constants.mts';

test('Windows runs one maintained test file at a time', () => {
  assert.equal(testFileConcurrency('win32'), 1);
});

test('Linux, macOS and other supported platforms retain four concurrent test files', () => {
  const platforms: readonly NodeJS.Platform[] = [
    'linux',
    'darwin',
    'aix',
    'android',
    'freebsd',
    'haiku',
    'openbsd',
    'sunos',
    'cygwin',
    'netbsd',
  ];
  for (const platform of platforms) assert.equal(testFileConcurrency(platform), 4, platform);
});

test('the exported concurrency follows the current host policy', () => {
  assert.equal(TEST_CONCURRENCY, process.platform === 'win32' ? 1 : 4);
  assert.equal(TEST_CONCURRENCY, testFileConcurrency(process.platform));
});
