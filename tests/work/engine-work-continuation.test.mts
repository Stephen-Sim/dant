import { NativeVoiceFixture } from '../support/native-service-fixtures.mts';
import { nativeSessionFixture, nativeTurnFixture } from '../support/service-fixtures.mts';
import { observedRecord, observedRecords } from '../support/service-fixtures.mts';
import { TracingWorkerFixture } from '../support/worker-fixtures.mts';
import { activeTaskFixture } from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { taskPlanInput } from '../../src/work/task-progress.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const steps = [
  { step: 'Apply the requested revision', status: 'inProgress' },
  { step: 'Verify the updated result', status: 'pending' },
];
function fixture(t: NodeTestContext) {
  const dir = fs.mkdtempSync(path.join(base, 'engine-work-continuation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    worker = new TracingWorkerFixture();
  worker.status = 'online';
  const engine = new Engine(store, worker);
  return { store, engine };
}
function oldWork(
  store: Store,
  status: import('../../src/contracts/states.mts').WorkStatusValue = 'review',
) {
  const message = store.add({
    role: 'user',
    text: 'Original entrusted work',
    turnId: 'original',
    status: 'review',
    progressPriority: 'high',
  });
  const record = store.registerWork({
    turnId: 'original',
    messageId: message.id,
    title: 'Original task',
    plan: taskPlanInput({
      title: 'Original task',
      steps: steps.map((step) => ({ ...step, status: 'completed' })),
    }).plan,
    startedAt: 100,
  });
  store.updateRegisteredWork('original', { status, executionEnded: true });
  return record;
}
function ownCurrent({ store, engine }: ReturnType<typeof fixture>, source: 'chat' | 'voice') {
  const message = store.add({
      role: 'user',
      text: 'Revise that result',
      turnId: 'revision',
      status: 'running',
      submission: 'confirmed',
      workKind: 'conversation',
    }),
    task = activeTaskFixture({
      messageId: message.id,
      messageIds: [message.id],
      turnId: 'revision',
      startAcknowledged: true,
      source,
    });
  if (source === 'chat') {
    engine.active = task;
    return { task, message, scope: undefined };
  }
  const session = nativeSessionFixture({ id: 'existing-call' });
  const turn = Object.assign(task, nativeTurnFixture({ turnId: defined(task.turnId) }));
  session.turns.set(turn.turnId, turn);
  engine.nativeVoice = Object.assign(new NativeVoiceFixture(), { session });
  return {
    task,
    message,
    scope: {
      task,
      isCurrent: () =>
        defined(engine.nativeVoice).session === session &&
        session.turns.get(defined(task.turnId)) === task,
    },
  };
}

test('chat and native owned unfinished revisions keep one original work ID after an automatic public plan arrives first', async (t) => {
  for (const source of ['chat', 'voice'] as const)
    for (const status of ['continuing', 'waiting_user', 'paused'] as const) {
      const f = fixture(t),
        original = oldWork(f.store, status),
        { task, message, scope } = ownCurrent(f, source);
      f.engine.observeRegisteredPlan(task, steps);
      const provisional = defined(task.workRecord).id;
      assert.notEqual(provisional, original.id);
      assert.equal(defined(task.workRecord).provisional, true);
      assert.equal(message.workId, provisional);
      const result = observedRecord(
        await f.engine.tool(
          'task_plan',
          { workId: original.id, title: 'Revise the same entrusted task', steps },
          scope,
        ),
      );
      assert.equal(result.workId, original.id);
      assert.equal(f.store.state.workTasks.length, 1);
      assert.equal(defined(task.workRecord).id, original.id);
      assert.equal(message.workId, original.id);
      assert.equal(defined(task.workRecord).provisional, undefined);
      assert.equal(defined(task.workRecord).startedAt, 100);
      assert.equal(defined(task.workRecord).progressPriority, 'high');
      assert.deepEqual(defined(task.workRecord).turnIds, ['original', 'revision']);
      f.engine.observeRegisteredPlan(task, [{ step: 'Updated progress', status: 'inProgress' }]);
      assert.equal(defined(task.workRecord).id, original.id);
      assert.equal(
        defined(task.workRecord).provisional,
        undefined,
        'later public plans do not downgrade explicit registration',
      );
    }
});

test('an explicit current task cannot be reassigned, and failed atomic continuation leaves its provisional owner and messages intact', (t) => {
  const f = fixture(t),
    original = oldWork(f.store, 'continuing'),
    { task, message } = ownCurrent(f, 'chat');
  f.engine.observeRegisteredPlan(task, steps);
  const provisional = task.workRecord,
    before = structuredClone(f.store.state.workTasks),
    save = f.store.save;
  f.store.save = () => {
    throw Error('Storage unavailable');
  };
  assert.throws(
    () => f.engine.registerTaskPlan({ workId: original.id, title: 'Revision', steps }),
    /Storage unavailable/,
  );
  assert.deepEqual(f.store.state.workTasks, before);
  assert.equal(task.workRecord, provisional);
  assert.equal(message.workId, defined(provisional).id);
  f.store.save = save;
  f.engine.registerTaskPlan({ title: 'A separate explicitly registered task', steps });
  assert.equal(defined(task.workRecord).provisional, undefined);
  assert.throws(
    () =>
      f.engine.registerTaskPlan({
        workId: original.id,
        title: 'Cannot steal explicit work',
        steps,
      }),
    (error) => observedRecord(error).code === 'work_conflict',
  );
  assert.equal(message.workId, defined(provisional).id);
  assert.equal(f.store.state.workTasks.length, 2);
  assert.throws(
    () =>
      f.engine.registerTaskPlan({ title: 'Cannot spoof observer state', steps, observed: true }),
    /task plan/,
  );
});

test('conversation references include a bounded set of unaccepted results and never restart work or offer accepted records', (t) => {
  const f = fixture(t),
    plan = taskPlanInput({ title: 'Reference', steps }).plan;
  for (let index = 0; index < 25; index++) {
    const record = f.store.registerWork({
      turnId: 'review-' + index,
      title: 'Review ' + index,
      plan,
    });
    f.store.updateRegisteredWork(defined(record.turnId), { status: 'review' });
  }
  const ongoing = f.store.registerWork({ turnId: 'unfinished', title: 'Unfinished work', plan });
  f.store.updateRegisteredWork(ongoing.turnId, { status: 'continuing' });
  const accepted = f.store.registerWork({ turnId: 'accepted', title: 'Accepted work', plan });
  f.store.updateRegisteredWork(accepted.turnId, { status: 'completed' });
  const instructions = f.engine.instructions(),
    reference = observedRecords(
      JSON.parse(
        defined(instructions.split('unrelated work needs its own plan.\n')[1]).split(
          '\nDurable reference memory:',
        )[0] ?? '',
      ),
    );
  assert.equal(reference.filter((record) => record.status === 'review').length, 20);
  assert.equal(
    reference.some((record) => record.workId === ongoing.id),
    true,
  );
  assert.equal(
    reference.some((record) => record.workId === accepted.id),
    false,
  );
  assert.equal(f.engine.active, null);
  assert.equal(f.engine.queue.length, 0);
});
