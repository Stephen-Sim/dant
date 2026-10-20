import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ChatTaskStatus,
  DesktopPhase,
  isEnumValue,
  PlanStepStatus,
  ServiceUpdateStatus,
  TaskPriority,
  TaskStatus,
  VmPowerState,
  VmReceiptPhase,
  WorkStatus,
} from '../../ui/shared/states.mts';
import {
  rawStateLiterals,
  checkUIStateContracts,
  checkGoStateContracts,
  checkStateContracts,
} from '../../scripts/ci/check-state-contracts.mts';

test('named enum domains retain existing persisted values and immutable narrow validators', () => {
  assert.deepEqual(Object.values(ChatTaskStatus), [
    'draft',
    'accepted',
    'queued',
    'running',
    'waiting_user',
    'pausing',
    'paused',
    'failed',
    'review',
    'completed',
    'cancelled',
  ]);
  assert.equal(isEnumValue(ChatTaskStatus, TaskStatus.Continuing), false);
  assert.equal(isEnumValue(WorkStatus, TaskStatus.Continuing), true);
  assert.equal(isEnumValue(WorkStatus, TaskStatus.Draft), false);
  for (const domain of [
    ChatTaskStatus,
    WorkStatus,
    DesktopPhase,
    PlanStepStatus,
    TaskPriority,
    ServiceUpdateStatus,
  ]) {
    assert.equal(Object.isFrozen(domain), true);
    for (const value of Object.values(domain)) assert.equal(isEnumValue(domain, value), true);
    for (const value of [undefined, null, 0, false, {}, [], 'invented-state'])
      assert.equal(isEnumValue(domain, value), false);
  }
  assert.throws(() => {
    Object.defineProperty(DesktopPhase, 'Idle', { value: 'changed' });
  }, TypeError);
});
test('browser plan vocabulary preserves its exact wire values and rejects unknown values', () => {
  assert.deepEqual(Object.values(PlanStepStatus), ['pending', 'inProgress', 'completed']);
  assert.equal(isEnumValue(PlanStepStatus, 'in_progress'), false);
  assert.equal(isEnumValue(PlanStepStatus, undefined), false);
});
test('adopted modules forbid new raw state values while property keys and user-facing prose remain valid', () => {
  assert.deepEqual(checkUIStateContracts(), []);
  assert.equal(rawStateLiterals("const value={status:'paused'};")[0]?.value, 'paused');
  assert.equal(rawStateLiterals("if (task.status === 'running') {};").length, 1);
  assert.deepEqual(
    rawStateLiterals("const copy={'paused':'Paused',description:'This task is paused.'};"),
    [],
  );
  assert.deepEqual(rawStateLiterals('const value={status:TaskStatus.Paused};'), []);
  assert.equal(rawStateLiterals("const value={state:'suspended'};", [VmPowerState]).length, 1);
  assert.equal(rawStateLiterals("const value={phase:'suspending'};", [VmReceiptPhase]).length, 1);
  assert.deepEqual(
    rawStateLiterals('const value={phase:VmReceiptPhase.Suspended};', [VmReceiptPhase]),
    [],
  );
  assert.equal(
    rawStateLiterals("const value: {status: string} = {status: 'paused'} as const;")[0]?.value,
    'paused',
  );
  assert.deepEqual(
    rawStateLiterals(
      "interface Labels {'paused': string}; const value: Labels = {'paused': 'Paused'};",
    ),
    [],
  );
  assert.equal(rawStateLiterals("const value = {['paused']: 'Paused'};").length, 1);
  assert.throws(() => rawStateLiterals('const value = {status:'), SyntaxError);
});

test('combined state gate always includes recursive Go checks without invoking a compiler in unit tests', () => {
  let calls = 0;
  const failures = checkStateContracts(undefined, () => {
    calls++;
    return {
      checkedFiles: 125,
      violations: [
        { file: 'core/internal/store/messages.go', line: 8, column: 12, value: 'paused' },
      ],
    };
  });
  assert.equal(calls, 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? '', /core\/internal\/store\/messages.go:8:12/);
  assert.throws(
    () =>
      checkStateContracts(undefined, () => {
        throw Error('unavailable');
      }),
    /unavailable/,
  );
});

test('Go gate uses the pinned compiler environment and validates its bounded report', () => {
  const root = path.resolve('isolated-state-check');
  const environment = {
    GOTOOLCHAIN: 'local',
    GOENV: 'off',
    GOWORK: 'off',
    GOFLAGS: '-mod=readonly',
  };
  const compiler = {
    go: path.join(root, 'pinned-go'),
    gofmt: path.join(root, 'pinned-gofmt'),
    env: environment,
  };
  let runs = 0;
  const result = checkGoStateContracts(root, {
    toolchain: (resolved) => {
      assert.equal(resolved, root);
      return compiler;
    },
    run: (executable, args, options) => {
      runs++;
      assert.equal(executable, compiler.go);
      assert.deepEqual(args, ['run', '-p=1', './cmd/dant-checks', '--root', root]);
      assert.equal(options.cwd, path.join(root, 'core'));
      assert.equal(options.env, environment);
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.maxBuffer, 4 * 1024 * 1024);
      return { status: 0, stdout: JSON.stringify({ checkedFiles: 2, violations: [] }) };
    },
  });
  assert.equal(runs, 1);
  assert.deepEqual(result, { checkedFiles: 2, violations: [] });
  for (const raw of [
    '{}',
    '{',
    '{"checkedFiles":0,"violations":[]}',
    '{"checkedFiles":2,"violations":[{"file":"../outside.go","line":1,"column":1,"value":"paused"}]}',
    '{"checkedFiles":2,"violations":[{"file":"core/internal/store/store.go","line":0,"column":1,"value":"paused"}]}',
  ]) {
    assert.throws(() =>
      checkGoStateContracts(root, {
        toolchain: () => compiler,
        run: () => ({ status: 0, stdout: raw }),
      }),
    );
  }
  for (const response of [
    { status: 1, stdout: '{"checkedFiles":2,"violations":[]}' },
    { status: null, error: Error('fixture') },
    { status: 0, stdout: '' },
  ]) {
    assert.throws(
      () =>
        checkGoStateContracts(root, {
          toolchain: () => compiler,
          run: () => response,
        }),
      /could not be completed/,
    );
  }
  assert.equal(
    checkGoStateContracts(root, {
      toolchain: () => compiler,
      run: () => ({
        status: 1,
        stdout: JSON.stringify({
          checkedFiles: 2,
          violations: [
            { file: 'core/internal/work/input.go', line: 1, column: 1, value: 'running' },
          ],
        }),
      }),
    }).violations.length,
    1,
  );
});
