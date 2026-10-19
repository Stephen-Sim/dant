import type { TaskProgressTask } from '../../src/contracts/contracts.ts';
import { defined } from '../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startTaskProgress,
  advanceTaskProgress,
  observeTaskProgress,
  taskProgressSnapshot,
  voiceCompletionWork,
  safeCompletionWork,
} from '../../src/work/task-progress.mts';
import { Store } from '../../src/conversation/store.mts';

test('progress exposes fixed execution categories and timestamps without commands, reasoning, transcripts or tool arguments', () => {
  const task: TaskProgressTask = { messageId: 'message', turnId: 'turn' };
  startTaskProgress(task, { at: 100 });
  assert.equal(taskProgressSnapshot(task).step, 'preparing');
  assert.equal(
    observeTaskProgress(
      task,
      {
        method: 'item/started',
        params: {
          item: {
            id: 'command',
            type: 'commandExecution',
            command: 'private-command',
            arguments: { token: 'private-token' },
          },
        },
      },
      { at: 200 },
    ),
    true,
  );
  let snapshot = taskProgressSnapshot(task, { source: 'voice', background: true });
  assert.equal(snapshot.step, 'command');
  assert.equal(snapshot.startedAt, 100);
  assert.equal(snapshot.updatedAt, 200);
  assert.equal(snapshot.background, true);
  assert.equal(JSON.stringify(snapshot).includes('private-'), false);
  assert.equal(
    observeTaskProgress(
      task,
      {
        method: 'item/started',
        params: { item: { id: 'reasoning', type: 'reasoning', text: 'private-reasoning' } },
      },
      { at: 300 },
    ),
    false,
  );
  assert.equal(taskProgressSnapshot(task).updatedAt, 200);
  observeTaskProgress(
    task,
    {
      method: 'item/started',
      params: {
        item: {
          id: 'desktop',
          type: 'mcpToolCall',
          server: 'dant_desktop',
          tool: 'private-tool',
          arguments: { secret: 'private-secret' },
        },
      },
    },
    { at: 350 },
  );
  assert.equal(taskProgressSnapshot(task).step, 'computer');
  observeTaskProgress(
    task,
    {
      method: 'item/completed',
      params: {
        item: {
          id: 'desktop',
          type: 'mcpToolCall',
          server: 'dant_desktop',
          result: { private: 'output' },
        },
      },
    },
    { at: 400 },
  );
  assert.equal(taskProgressSnapshot(task).step, 'command');
  observeTaskProgress(
    task,
    { method: 'item/completed', params: { item: { id: 'command', type: 'commandExecution' } } },
    { at: 450 },
  );
  assert.equal(taskProgressSnapshot(task).step, 'working');
  observeTaskProgress(
    task,
    { method: 'item/agentMessage/delta', params: { delta: 'private-transcript' } },
    { at: 500 },
  );
  snapshot = taskProgressSnapshot(task, { saving: true });
  assert.equal(snapshot.step, 'saving');
  assert.equal(snapshot.updatedAt, 500);
  assert.equal(JSON.stringify(snapshot).includes('private-'), false);
});

test('only valid explicit public plans supply a redacted bounded current step, and quiet reads never change progress', () => {
  const task = { turnId: 'owned' };
  startTaskProgress(task, { at: 100, step: 'working' });
  const redact = (text: string) => text.replaceAll('synthetic-token', '[redacted]');
  observeTaskProgress(
    task,
    {
      method: 'turn/plan/updated',
      params: {
        explanation: 'private-explanation',
        plan: [
          { step: 'Inspect project', status: 'completed' },
          { step: 'Use synthetic-token\nfor authorized work', status: 'inProgress' },
          { step: 'Verify', status: 'pending' },
        ],
      },
    },
    { at: 200, redact },
  );
  const snapshot = taskProgressSnapshot(task, { redact });
  assert.deepEqual(snapshot.plan, {
    total: 3,
    completed: 1,
    currentStep: 'Use [redacted] for authorized work',
  });
  assert.equal(JSON.stringify(snapshot).includes('synthetic-token'), false);
  assert.equal(JSON.stringify(snapshot).includes('private-explanation'), false);
  for (let index = 0; index < 50; index++)
    assert.deepEqual(taskProgressSnapshot(task, { redact }), snapshot);
  for (const plan of [
    null,
    [{ step: 5, status: 'pending' }],
    [{ step: 'bad', status: 'private-status' }],
    Array.from({ length: 129 }, () => ({ step: 'oversized', status: 'pending' })),
  ])
    assert.equal(
      observeTaskProgress(task, { method: 'turn/plan/updated', params: { plan } }, { at: 300 }),
      false,
    );
  assert.deepEqual(taskProgressSnapshot(task), snapshot);
  observeTaskProgress(
    task,
    {
      method: 'turn/plan/updated',
      params: { plan: [{ step: 'x'.repeat(300), status: 'pending' }] },
    },
    { at: 400 },
  );
  assert.equal(defined(taskProgressSnapshot(task).plan).currentStep.length, 240);
  observeTaskProgress(
    task,
    { method: 'turn/plan/updated', params: { plan: [{ step: 'Done', status: 'completed' }] } },
    { at: 450 },
  );
  assert.equal(defined(taskProgressSnapshot(task).plan).currentStep, '');
});

test('progress helpers contain invalid metadata and retain a bounded item observer without affecting execution', () => {
  const task: TaskProgressTask = {};
  startTaskProgress(task, { at: NaN, step: 'invalid' });
  assert.equal(taskProgressSnapshot(task).step, 'working');
  assert.ok(defined(taskProgressSnapshot(task).startedAt) > 0);
  assert.equal(advanceTaskProgress(task, 'private-phase'), false);
  assert.equal(observeTaskProgress(task, { method: 'unrelated' }), false);
  assert.equal(
    observeTaskProgress(task, {
      method: 'item/started',
      params: { item: { type: 'commandExecution' } },
    }),
    false,
  );
  for (let index = 0; index < 129; index++)
    observeTaskProgress(task, {
      method: 'item/started',
      params: { item: { id: 'item-' + index, type: 'fileChange' } },
    });
  assert.equal(defined(task.workProgress).items.size, 128);
  assert.equal(taskProgressSnapshot(task).step, 'files');
  assert.equal(
    taskProgressSnapshot(null, { source: 'unexpected', status: 'unexpected', startedAt: 50 })
      .startedAt,
    50,
  );
});

test('existing completion receipts accept only optional validated voice result metadata and preserve deduplication and restart history', (t) => {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'task-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    task = {};
  startTaskProgress(task, { at: 100 });
  const work = voiceCompletionWork(task, 'review', { at: 200 });
  assert.deepEqual(work, { source: 'voice', status: 'review', startedAt: 100, updatedAt: 200 });
  assert.equal(voiceCompletionWork(task, 'waiting_user'), undefined);
  const first = store.addCompletion({
    turnId: 'voice',
    messageIds: ['result'],
    work: { ...work, secret: 'private-value', text: 'private-content' },
  });
  assert.deepEqual(defined(first).work, work);
  store.addCompletion({
    turnId: 'voice',
    messageIds: ['duplicate'],
    work: { source: 'voice', status: 'failed' },
  });
  assert.equal(store.state.completions.length, 1);
  const ordinary = store.addCompletion({ turnId: 'ordinary', messageIds: ['chat'] });
  assert.equal(Object.hasOwn(defined(ordinary), 'work'), false);
  const restored = new Store(dir);
  assert.deepEqual(defined(restored.state.completions[0]).work, work);
  assert.equal(JSON.stringify(restored.state).includes('private-'), false);
  for (const invalid of [
    null,
    [],
    { source: 'chat', status: 'review' },
    { source: 'voice', status: 'running' },
    Object.create({ source: 'voice', status: 'review' }),
  ])
    assert.equal(safeCompletionWork(invalid), undefined);
  const getters = { status: 'review' };
  Object.defineProperty(getters, 'source', {
    get() {
      throw Error('Getter must never run');
    },
  });
  assert.equal(safeCompletionWork(getters), undefined);
  assert.deepEqual(
    safeCompletionWork({ source: 'voice', status: 'paused', startedAt: NaN, updatedAt: 'private' }),
    { source: 'voice', status: 'paused' },
  );
});
