import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import {
  assertNodeRuntime,
  NODE_RUNTIME_PROBE,
  NODE_RUNTIME_ACK,
} from '../../../scripts/ci/node-runtime.mts';
import type { NodeProbeRunner } from '../../../scripts/ci/node-runtime.mts';
test('TypeScript tooling preflight executes a bounded fixed probe and requires its exact acknowledgement', () => {
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
      /native TypeScript support is required for development tooling/,
    );
  }
});

test('the current test runtime executes erasable TypeScript without a loader', () =>
  assertNodeRuntime());

test('runtime admission checks the supported version boundary and native TypeScript capability', () => {
  const source = stripTypeScriptTypes(NODE_RUNTIME_PROBE);
  for (const [node, typescript, supported] of [
    ['22.17.0', 'strip', false],
    ['22.18.0', 'strip', true],
    ['23.9.0', 'transform', false],
    ['24.0.0', 'transform', true],
    ['25.1.0', 'strip', true],
    ['24.0.0', undefined, false],
    ['24.0.0', 'disabled', false],
  ] as const) {
    let stdout = '';
    const probe = () =>
      runInNewContext(
        source,
        {
          process: {
            versions: { node },
            features: { typescript },
            exit: (status: number) => {
              assert.equal(status, 1);
              throw Error('fixture_runtime_rejected');
            },
            stdout: { write: (value: string) => (stdout += value) },
          },
        },
        { timeout: 1_000 },
      );
    if (supported) {
      probe();
      assert.equal(stdout, NODE_RUNTIME_ACK);
    } else {
      assert.throws(probe, /fixture_runtime_rejected/);
      assert.equal(stdout, '');
    }
  }
});
