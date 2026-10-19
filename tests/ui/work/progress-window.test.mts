import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { parseHTML } from 'linkedom';
import { TaskStatus, PlanStepStatus, SubmissionStatus } from '../../../src/contracts/states.mts';
import { workProgress } from '../../../ui/work/work-progress.mts';
import { createTaskReplyController } from '../../../ui/work/task-reply.mts';
import {
  progressWindow,
  COMPLETED_PROGRESS_RETENTION_MS,
} from '../../../ui/work/progress-window.mts';
import type { ProgressSnapshot } from '../../../ui/work/progress-snapshot.mts';
import { sourceSection } from '../../support/source-fixtures.mts';

const NOW = Date.UTC(2026, 9, 19, 12);
const completed = (acceptedAt?: unknown): ProgressSnapshot => ({
  conversationId: 'conversation-one',
  capabilities: { workReply: true, taskReopen: true },
  messages: [
    {
      id: 'request',
      role: 'user',
      text: 'Keep the project and chat',
      turnId: 'turn-one',
      status: TaskStatus.Completed,
      time: NOW - 10 * COMPLETED_PROGRESS_RETENTION_MS,
      ...(acceptedAt === undefined ? {} : { acceptedAt }),
    },
  ],
  workTasks: [
    {
      id: 'project-one',
      turnId: 'turn-one',
      turnIds: ['turn-one'],
      messageId: 'request',
      title: 'Keep the project memory',
      status: TaskStatus.Completed,
      startedAt: NOW - 10 * COMPLETED_PROGRESS_RETENTION_MS,
      executionEndedAt: NOW - 9 * COMPLETED_PROGRESS_RETENTION_MS,
      updatedAt: NOW,
      plan: { steps: [{ step: 'Verified result', status: PlanStepStatus.Completed }] },
    },
  ],
});

test('completed tasks disappear at exactly three days after acceptance without mutating durable history or reply references', () => {
  const acceptedAt = NOW - COMPLETED_PROGRESS_RETENTION_MS,
    data = completed(acceptedAt),
    before = structuredClone(data),
    prior = workProgress(data, { now: NOW - 1 }),
    expired = workProgress(data, { now: NOW });
  assert.equal(prior.completedCount, 1);
  assert.equal(prior.nextExpiryAt, NOW);
  assert.equal(expired.completedCount, 0);
  assert.equal(expired.items.length, 1, 'hidden progress keeps the exact action target available');
  assert.equal(expired.history.length, 0);
  assert.equal(expired.nextExpiryAt, null);
  assert.equal(expired.replyReferences[0]?.workId, 'project-one');
  const replies = createTaskReplyController({
    document: parseHTML('<textarea id="composer"></textarea>').document,
    getModel: () => expired,
  });
  assert.equal(
    replies.select({
      workId: 'project-one',
      turnId: 'turn-one',
      conversationId: 'conversation-one',
    }),
    true,
  );
  assert.deepEqual(replies.prepare(), {
    workId: 'project-one',
    turnId: 'turn-one',
    conversationId: 'conversation-one',
  });
  assert.deepEqual(data, before);
});

test('old execution and request timestamps do not expire a recently accepted task', () => {
  const model = workProgress(completed(NOW - 100), { now: NOW });
  assert.equal(model.completedCount, 1);
  assert.equal(model.nextExpiryAt, NOW - 100 + COMPLETED_PROGRESS_RETENTION_MS);
});

test('missing, invalid or future acceptance times keep completed legacy tasks visible', () => {
  for (const acceptedAt of [undefined, null, 0, -1, 'yesterday', NaN, Infinity, NOW + 1]) {
    const model = workProgress(completed(acceptedAt), { now: NOW });
    assert.equal(model.completedCount, 1, String(acceptedAt));
    assert.equal(model.nextExpiryAt, null, String(acceptedAt));
  }
  const data = completed(NOW - COMPLETED_PROGRESS_RETENTION_MS - 1),
    model = workProgress(data, { now: NaN });
  assert.equal(model.completedCount, 1);
});

test('review, waiting, paused, failed and unknown work remains visible regardless of completed checklist or age', () => {
  for (const status of [
    TaskStatus.Review,
    TaskStatus.WaitingUser,
    TaskStatus.Paused,
    TaskStatus.Failed,
    TaskStatus.Unknown,
  ]) {
    const data = completed(NOW - 2 * COMPLETED_PROGRESS_RETENTION_MS),
      record = data.workTasks?.[0];
    assert.ok(record);
    record.status = status;
    assert.equal(workProgress(data, { now: NOW }).items.length, 1, status);
  }
  const uncertain = completed(NOW - 2 * COMPLETED_PROGRESS_RETENTION_MS),
    record = uncertain.workTasks?.[0];
  assert.ok(record);
  record.submission = SubmissionStatus.Unknown;
  assert.equal(workProgress(uncertain, { now: NOW }).items.length, 1);
});

test('a reopened task immediately reappears under its current turn and cannot borrow another turn acceptance time', () => {
  const data = completed(NOW - 2 * COMPLETED_PROGRESS_RETENTION_MS),
    record = data.workTasks?.[0];
  assert.ok(record);
  record.status = TaskStatus.Continuing;
  record.turnId = 'reopened-turn';
  record.turnIds = ['turn-one', 'reopened-turn'];
  const reopened = workProgress(data, { now: NOW });
  assert.equal(reopened.ongoing[0]?.id, 'project-one');
  assert.equal(reopened.ongoing[0]?.turnId, 'reopened-turn');
  record.status = TaskStatus.Completed;
  assert.equal(
    workProgress(data, { now: NOW }).completedCount,
    1,
    'unrelated old acceptance is not completion proof',
  );
});

test('legacy chat tasks use their own acceptance and voice receipts use the exact accepted current-turn authority', () => {
  const acceptedAt = NOW - COMPLETED_PROGRESS_RETENTION_MS,
    legacy = completed(acceptedAt);
  delete legacy.workTasks;
  assert.equal(workProgress(legacy, { now: NOW }).completedCount, 0);
  const voice: ProgressSnapshot = {
    messages: [
      {
        id: 'accepted',
        role: 'user',
        turnId: 'voice-turn',
        workKind: 'conversation',
        status: TaskStatus.Completed,
        acceptedAt,
      },
      { id: 'answer', role: 'assistant' },
    ],
    completions: [
      {
        id: 'receipt',
        turnId: 'voice-turn',
        taskId: 'accepted',
        at: NOW,
        messageIds: ['answer'],
        work: { source: 'voice', status: TaskStatus.Review },
      },
    ],
  };
  assert.equal(workProgress(voice, { now: NOW }).completedCount, 0);
  const request = voice.messages?.[0];
  assert.ok(request);
  request.acceptedAt = NOW - 1;
  assert.equal(
    workProgress(voice, { now: NOW }).completedCount,
    1,
    'receipt time does not override acceptance',
  );
});

test('expiry projection preserves exact item objects and recalculates without remembered conversation or VM scope', () => {
  const first = completed(NOW - 2 * COMPLETED_PROGRESS_RETENTION_MS),
    second = completed(NOW - 1);
  second.conversationId = 'conversation-two';
  assert.equal(workProgress(first, { now: NOW }).completedCount, 0);
  assert.equal(workProgress(second, { now: NOW }).completedCount, 1);
  const item = { id: 'active', status: TaskStatus.Running, progressCompleted: false },
    projection = progressWindow([item], null, NOW);
  assert.equal(projection.items[0], item);
});

test('the existing presence ticker refreshes only a visible due progress window and schedules no extra polling', () => {
  const { document } = parseHTML(
    '<main><aside data-progress-panel><div data-progress-expires-at="100"></div></aside></main>',
  );
  let callback = () => {},
    renders = 0,
    now = 99;
  const context = {
    document,
    presenceTimer: undefined,
    updatePresence() {},
    updateWorkTimers() {},
    clearInterval() {},
    setInterval(fn: () => void, interval: number) {
      assert.equal(interval, 30000);
      callback = fn;
      return 1;
    },
    Date: { now: () => now },
    render() {
      renders++;
      document
        .querySelector('[data-progress-expires-at]')
        ?.removeAttribute('data-progress-expires-at');
    },
  };
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
  vm.createContext(context);
  vm.runInContext(
    stripTypeScriptTypes(
      sourceSection(source, 'function startPresenceTicker()', 'function recordingSeconds()') +
        '\nstartPresenceTicker();',
    ),
    context,
  );
  callback();
  assert.equal(renders, 0);
  document.querySelector('[data-progress-panel]')?.classList.add('work-progress-body');
  callback();
  assert.equal(renders, 0);
  now = 100;
  callback();
  callback();
  assert.equal(renders, 1);
});
