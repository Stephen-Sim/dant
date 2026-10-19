import type { PlanStep } from '../../src/contracts/contracts.ts';
import type { RegisterWorkOptions, StoredWorkRecord } from '../../src/conversation/types.ts';
import { observedRecord } from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/conversation/store.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const steps = (): PlanStep[] => [
  { step: 'Inspect the requested file', status: 'completed' },
  { step: 'Verify and deliver the requested result', status: 'pending' },
];
function fixture(t: NodeTestContext) {
  const dir = fs.mkdtempSync(path.join(base, 'observed-work-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new Store(dir) };
}
const observed = (store: Store, turnId: string, extra: Partial<RegisterWorkOptions> = {}) =>
  store.registerWork({
    turnId,
    title: 'Observed work',
    source: 'chat',
    observed: true,
    plan: null,
    ...extra,
  });
const planned = (store: Store, turnId: string, extra: Partial<RegisterWorkOptions> = {}) =>
  store.registerWork({
    turnId,
    title: 'Actual entrusted work',
    source: 'chat',
    plan: { steps: steps() },
    ...extra,
  });

test('actual observed work persists a validated title and no invented plan, step or completion ratio', (t) => {
  const { store, dir } = fixture(t),
    record = observed(store, 'owned-turn', {
      title: '  Inspect\nrequested profile\u0001  ',
      startedAt: 100,
    });
  assert.equal(record.title, 'Inspect requested profile');
  assert.equal(record.provisional, true);
  assert.equal(record.plan, null);
  assert.equal(record.status, 'running');
  assert.equal(record.startedAt, 100);
  assert.deepEqual(record.turnIds, ['owned-turn']);
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8')).workTasks[0];
  assert.deepEqual(saved, record);
  for (const field of ['steps', 'completed', 'total', 'percentage'])
    assert.equal(Object.hasOwn(saved, field), false);
  assert.equal(JSON.stringify(saved).includes('Title validation only'), false);
  store.updateRegisteredWork(record.turnId, { status: 'continuing', executionEnded: true });
  const restored = new Store(dir).state.workTasks[0];
  assert.equal(defined(restored).id, record.id);
  assert.equal(defined(restored).plan, null);
  assert.equal(defined(restored).provisional, true);
  assert.equal(defined(restored).status, 'continuing');
});

test('planless registration is restricted to strict observed provenance and rejects invalid titles atomically', (t) => {
  const { store } = fixture(t),
    before = fs.readFileSync(store.file),
    records = store.state.workTasks;
  for (const observedFlag of [undefined, false, 'true', 1, {}, []])
    assert.throws(
      () =>
        store.registerWork({
          turnId: 'not-observed',
          title: 'Actual work',
          plan: null,
          observed: observedFlag,
        }),
      /task plan/,
    );
  for (const title of ['', '   ', '\u0001\n', 'x'.repeat(241), null, 5, {}])
    assert.throws(() => observed(store, 'bad-title', { title }), /task (?:plan|title)|Task title/);
  for (const plan of [undefined, {}, { steps: [] }])
    assert.throws(() => observed(store, 'missing-plan', { plan }), /task plan/);
  assert.equal(store.state.workTasks, records);
  assert.equal(records.length, 0);
  assert.deepEqual(fs.readFileSync(store.file), before);
});

test('a formal plan upgrades its observed record in place and later planless observations cannot erase it', (t) => {
  const { store } = fixture(t),
    first = observed(store, 'owned', { startedAt: 100, messageId: 'original-message' });
  store.setProgressPriority(defined(first).id, 'work', 'high');
  const again = observed(store, 'owned', { startedAt: 900 });
  assert.equal(again.id, defined(first).id);
  assert.equal(store.state.workTasks.length, 1);
  assert.equal(again.startedAt, 100);
  const upgraded = planned(store, 'owned', { startedAt: 1000, messageId: 'later-message' });
  assert.equal(upgraded.id, defined(first).id);
  assert.equal(upgraded.provisional, undefined);
  assert.deepEqual(defined(upgraded.plan).steps, steps());
  assert.equal(upgraded.messageId, 'original-message');
  assert.equal(upgraded.startedAt, 100);
  assert.equal(upgraded.progressPriority, 'high');
  const later = observed(store, 'owned', {
    title: 'Generic fallback must not replace a real title',
  });
  assert.equal(later.id, upgraded.id);
  assert.equal(later.title, upgraded.title);
  assert.deepEqual(later.plan, upgraded.plan);
  assert.equal(later.provisional, undefined);
  assert.equal(store.state.workTasks.length, 1);
});

test('public plan updates supply real steps without changing observer identity until explicit registration', (t) => {
  const { store, dir } = fixture(t),
    first = observed(store, 'public-plan');
  const updated = store.updateRegisteredWork(first.turnId, {
    plan: { steps: steps() },
    status: 'waiting_user',
  });
  assert.equal(defined(updated).id, defined(first).id);
  assert.deepEqual(defined(defined(updated).plan).steps, steps());
  assert.equal(defined(updated).provisional, true);
  store.updateRegisteredWork(first.turnId, { status: 'waiting_user', executionEnded: true });
  const restored = new Store(dir);
  assert.equal(defined(restored.state.workTasks[0]).status, 'waiting_user');
  assert.equal(defined(restored.state.workTasks[0]).provisional, true);
  assert.deepEqual(defined(defined(restored.state.workTasks[0]).plan).steps, steps());
  const explicit = planned(restored, 'public-plan');
  assert.equal(explicit.id, defined(first).id);
  assert.equal(explicit.provisional, undefined);
  assert.equal(explicit.executionEndedAt, undefined);
});

test('restoration accepts a null plan only with strict provisional true and still validates title and plan shape', (t) => {
  const { store, dir } = fixture(t),
    first = observed(store, 'seed');
  store.updateRegisteredWork(first.turnId, { status: 'continuing', executionEnded: true });
  const template = structuredClone(defined(store.state.workTasks[0])),
    values = [true, false, 'true', 1, {}, [], undefined];
  store.state.workTasks = values.map((provisional, index) =>
    Object.assign(
      {
        ...template,
        provisional: true,
        id: randomUUID(),
        turnId: 'flag-' + index,
        turnIds: ['flag-' + index],
      },
      { provisional },
    ),
  );
  const validId = defined(store.state.workTasks[0]).id;
  for (const [index, patch] of [
    { plan: undefined },
    { plan: {} },
    { plan: { steps: [] } },
    { title: '' },
    { title: 'x'.repeat(241) },
  ].entries())
    store.state.workTasks.push(
      Object.assign(
        {
          ...template,
          id: randomUUID(),
          turnId: 'invalid-' + index,
          turnIds: ['invalid-' + index],
        },
        patch,
      ),
    );
  const normal = planned(store, 'ordinary-planned');
  store.save();
  const restored = new Store(dir);
  assert.deepEqual(
    restored.state.workTasks.map((record) => record.id),
    [validId, normal.id],
  );
  assert.equal(defined(restored.state.workTasks[0]).plan, null);
  assert.equal(defined(restored.state.workTasks[0]).provisional, true);
  assert.equal(defined(restored.state.workTasks[1]).provisional, undefined);
});

test('unplanned review restores as unfinished and ended waits survive without reviving live execution', (t) => {
  const { store, dir } = fixture(t);
  for (const [index, status, ended] of [
    [0, 'review', true],
    [1, 'waiting_user', true],
    [2, 'waiting_user', false],
    [3, 'running', false],
    [4, 'unknown', false],
    [5, 'pausing', false],
    [6, 'continuing', true],
    [7, 'failed', true],
    [8, 'cancelled', true],
    [9, 'completed', true],
  ] as const) {
    const record = observed(store, 'state-' + index);
    store.updateRegisteredWork(record.turnId, { status, executionEnded: ended });
  }
  const restored = new Store(dir),
    byTurn = new Map(restored.state.workTasks.map((record) => [record.turnId, record]));
  for (const [id, status] of [
    ['state-0', 'continuing'],
    ['state-1', 'waiting_user'],
    ['state-2', 'paused'],
    ['state-3', 'paused'],
    ['state-4', 'paused'],
    ['state-5', 'paused'],
    ['state-6', 'continuing'],
    ['state-7', 'failed'],
    ['state-8', 'cancelled'],
    ['state-9', 'completed'],
  ] as const) {
    assert.equal(defined(byTurn.get(id)).status, status, id);
    assert.equal(defined(byTurn.get(id)).plan, null);
    assert.equal(defined(byTurn.get(id)).provisional, true);
  }
  assert.equal(defined(byTurn.get('state-1')).pauseReason, undefined);
  assert.ok(defined(byTurn.get('state-1')).executionEndedAt);
  assert.equal(defined(byTurn.get('state-2')).pauseReason, 'restart');
  assert.equal(defined(byTurn.get('state-2')).executionEndedAt, undefined);
});

test('explicit continuation can replace its own planless provisional record while preserving the older work history', (t) => {
  for (const targetPlanless of [false, true]) {
    const { store } = fixture(t),
      older = targetPlanless
        ? observed(store, 'original', { startedAt: 100, messageId: 'original-message' })
        : planned(store, 'original', { startedAt: 100, messageId: 'original-message' });
    store.setProgressPriority(older.id, 'work', 'low');
    store.updateRegisteredWork(older.turnId, { status: 'continuing', executionEnded: true });
    const automatic = observed(store, 'current', { startedAt: 900 });
    store.setProgressPriority(automatic.id, 'work', 'high');
    const continued = planned(store, 'current', { workId: older.id, startedAt: 900 });
    assert.equal(continued.id, older.id);
    assert.equal(continued.provisional, undefined);
    assert.equal(continued.startedAt, 100);
    assert.equal(continued.messageId, 'original-message');
    assert.equal(continued.progressPriority, 'low');
    assert.deepEqual(continued.turnIds, ['original', 'current']);
    assert.deepEqual(defined(continued.plan).steps, steps());
    assert.equal(continued.executionEndedAt, undefined);
    assert.equal(store.state.workTasks.length, 1);
    assert.equal(store.updateRegisteredWork('original', { status: 'failed' }), null);
  }
});

test('a failed planless insert, real-plan upgrade or continuation replacement rolls back all records and disk bytes', (t) => {
  for (const operation of ['insert', 'upgrade', 'supersede']) {
    const { store } = fixture(t);
    let first: StoredWorkRecord | undefined;
    if (operation === 'upgrade') first = observed(store, 'current');
    if (operation === 'supersede') {
      first = planned(store, 'older');
      store.updateRegisteredWork(first.turnId, { status: 'continuing' });
      observed(store, 'current');
    }
    const records = store.state.workTasks,
      before = structuredClone(records),
      bytes = fs.readFileSync(store.file),
      save = store.save;
    store.save = () => {
      throw Error('Storage unavailable');
    };
    assert.throws(
      () =>
        operation === 'insert'
          ? observed(store, 'current')
          : planned(
              store,
              'current',
              operation === 'supersede' ? { workId: defined(first).id } : {},
            ),
      /Storage unavailable/,
    );
    assert.equal(store.state.workTasks, records);
    assert.deepEqual(records, before);
    assert.deepEqual(fs.readFileSync(store.file), bytes);
    store.save = save;
    const retried: StoredWorkRecord =
      operation === 'insert'
        ? observed(store, 'current')
        : planned(store, 'current', operation === 'supersede' ? { workId: defined(first).id } : {});
    assert.equal(store.state.workTasks.length, 1);
    assert.equal(retried.plan === null, operation === 'insert');
  }
});

test('confirmed cancellation preserves an unplanned record and cannot be undone by stale observation or registration', (t) => {
  const { store, dir } = fixture(t),
    record = observed(store, 'cancelled-turn');
  assert.deepEqual(store.cancelWork({ turnId: record.turnId, workId: record.id }), {
    ok: true,
    cancelled: true,
  });
  const restored = new Store(dir),
    cancelled = restored.state.workTasks[0];
  assert.equal(defined(cancelled).id, record.id);
  assert.equal(defined(cancelled).status, 'cancelled');
  assert.equal(defined(cancelled).plan, null);
  assert.equal(defined(cancelled).provisional, true);
  assert.ok(defined(cancelled).cancelledAt);
  assert.ok(defined(cancelled).executionEndedAt);
  assert.throws(
    () => observed(restored, record.turnId),
    (error) => observedRecord(error).code === 'work_not_continuable',
  );
  assert.throws(
    () => planned(restored, 'later', { workId: record.id }),
    (error) => observedRecord(error).code === 'work_not_continuable',
  );
  assert.throws(
    () => restored.updateRegisteredWork(record.turnId, { plan: { steps: steps() } }),
    (error) => observedRecord(error).code === 'work_not_continuable',
  );
});

test('unrelated observed work stays separate and historical planless owners cannot take back a continued task', (t) => {
  const { store } = fixture(t),
    first = observed(store, 'first', { startedAt: 100 });
  store.updateRegisteredWork(first.turnId, { status: 'continuing' });
  const unrelated = observed(store, 'unrelated');
  assert.notEqual(unrelated.id, defined(first).id);
  assert.equal(store.state.workTasks.length, 2);
  assert.deepEqual(defined(store.state.workTasks[0]).turnIds, ['first']);
  const continued = planned(store, 'latest', { workId: defined(first).id });
  store.updateRegisteredWork(continued.turnId, { status: 'continuing' });
  assert.throws(
    () => observed(store, 'first'),
    (error) => observedRecord(error).code === 'work_stale_turn',
  );
  assert.throws(
    () => planned(store, 'first', { workId: defined(first).id }),
    (error) => observedRecord(error).code === 'work_stale_turn',
  );
  assert.equal(store.state.workTasks.length, 2);
  assert.equal(defined(store.state.workTasks[0]).turnId, 'latest');
});
