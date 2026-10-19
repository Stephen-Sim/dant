import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNodeRuntime, NODE_RUNTIME_PROBE } from '../scripts/ci/node-runtime.mjs';

test('native TypeScript preflight executes a bounded fixed probe and requires its exact acknowledgement', () => {
  const calls = [];
  assertNodeRuntime('fixture-node', {
    run: (...args) => {
      calls.push(args);
      return { status: 0, stdout: 'dant-typescript-runtime-ok' };
    },
  });
  assert.equal(calls[0][0], 'fixture-node');
  assert.deepEqual(calls[0][1], ['--input-type=module-typescript', '--eval', NODE_RUNTIME_PROBE]);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].timeout, 15000);
  for (const result of [
    { status: 1, stdout: 'dant-typescript-runtime-ok' },
    { status: 0, stdout: 'other' },
    { status: null, error: Error('private path') },
  ]) {
    assert.throws(
      () => assertNodeRuntime('fixture-node', { run: () => result }),
      /native TypeScript support is required/,
    );
  }
});

test('the current test runtime can execute erasable TypeScript without a loader', () =>
  assertNodeRuntime());
