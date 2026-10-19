import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/conversation/store.mts';
import { TaskStatus, SubmissionStatus, PlanStepStatus } from '../../src/contracts/states.mts';
import { observedRecord, observedRecords } from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';

test('Store reload retains unknown work and submission fences instead of making a safe paused task', (t) => {
  const parent = path.resolve('.cache/tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'store-unknown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    work = store.registerWork({
      turnId: 'owned-unconfirmed-turn',
      title: 'Reconcile the result',
      source: 'voice',
      status: TaskStatus.Unknown,
      plan: { steps: [{ step: 'Read the actual result', status: PlanStepStatus.Pending }] },
    });
  const plain = store.registerWork({
    turnId: 'owned-stopped-turn',
    title: 'Safely stopped work',
    source: 'voice',
    status: TaskStatus.Running,
    plan: { steps: [{ step: 'Continue explicitly', status: PlanStepStatus.Pending }] },
  });
  const message = store.add({
    role: 'user',
    text: 'An unacknowledged accepted input',
    status: TaskStatus.Running,
    submission: SubmissionStatus.Submitting,
  });
  for (const submission of [
    SubmissionStatus.Submitting,
    SubmissionStatus.Unknown,
    'unrecognized-wire-state',
  ]) {
    const raw = observedRecord(JSON.parse(fs.readFileSync(store.file, 'utf8'))),
      record = defined(observedRecords(raw.workTasks).find((item) => item.id === work.id));
    record.submission = submission;
    record.unknownOutcome = true;
    record.executionEndedAt = Date.now();
    fs.writeFileSync(store.file, JSON.stringify(raw));
    const restored = new Store(dir),
      current = defined(restored.state.workTasks.find((item) => item.id === work.id));
    assert.equal(current.status, TaskStatus.Unknown);
    assert.equal(current.unknownOutcome, true);
    assert.equal(current.submission, SubmissionStatus.Unknown);
    assert.equal(
      restored.state.workTasks.find((item) => item.id === plain.id)?.status,
      TaskStatus.Paused,
    );
    assert.equal(
      restored.state.messages.find((item) => item.id === message.id)?.status,
      TaskStatus.Unknown,
    );
    assert.equal(
      restored.state.messages.find((item) => item.id === message.id)?.submission,
      SubmissionStatus.Unknown,
    );
    assert.throws(
      () =>
        restored.registerWork({
          workId: work.id,
          turnId: 'must-not-replay',
          title: current.title,
          plan: current.plan,
        }),
      { code: 'work_not_continuable' },
    );
    const twice = new Store(dir);
    assert.equal(
      twice.state.workTasks.find((item) => item.id === work.id)?.status,
      TaskStatus.Unknown,
    );
  }
});
