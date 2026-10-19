import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNodeRuntime,
  NODE_RUNTIME_PROBE,
  NODE_RUNTIME_ACK,
} from '../../scripts/ci/node-runtime.mts';
import type { NodeProbeRunner } from '../../scripts/ci/node-runtime.mts';
import { sqliteProbeRunner, unavailableSqliteModules } from '../support/runtime-probe-fixtures.mts';

test('TypeScript and SQLite preflight executes a bounded fixed probe and requires its exact acknowledgement', () => {
  const calls: Parameters<NodeProbeRunner>[] = [];
  assertNodeRuntime('fixture-node', {
    run: (...args) => {
      calls.push(args);
      return { status: 0, stdout: NODE_RUNTIME_ACK };
    },
  });
  const call = calls[0];
  assert.ok(call);
  assert.equal(call[0], 'fixture-node');
  assert.deepEqual(call[1], ['--input-type=module-typescript', '--eval', NODE_RUNTIME_PROBE]);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].timeout, 15000);
  for (const result of [
    { status: 1, stdout: NODE_RUNTIME_ACK },
    { status: 0, stdout: 'other' },
    { status: null, error: Error('private path') },
  ]) {
    assert.throws(
      () => assertNodeRuntime('fixture-node', { run: () => result }),
      /native TypeScript, built-in SQLite and FTS5 support is required/,
    );
  }
});

test('the current test runtime can execute erasable TypeScript and query FTS5 without a loader', () =>
  assertNodeRuntime());

test('an unavailable SQLite module, FTS5 index or actual MATCH result cannot pass runtime admission', () => {
  for (const source of unavailableSqliteModules) {
    assert.throws(
      () => assertNodeRuntime(process.execPath, { run: sqliteProbeRunner(source) }),
      (error: unknown) =>
        error instanceof Error &&
        /native TypeScript, built-in SQLite and FTS5 support is required/.test(error.message) &&
        !error.message.includes('PRIVATE'),
    );
  }
});
