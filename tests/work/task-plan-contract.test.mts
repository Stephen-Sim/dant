import { defined } from '../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_PLAN_SCHEMA, taskPlanInput } from '../../src/work/task-progress.mts';

const step = (status = 'pending', text = 'Confirm the requested destination') => ({
  step: text,
  status,
});
const input = <Extra extends Record<string, unknown>>(extra: Extra) => ({
  title: 'Send the requested link',
  steps: [step()],
  ...extra,
});

test('task plan status is optional and omitted legacy calls retain their exact parsed shape', () => {
  const args = input({ workId: 'actual-existing-work' }),
    before = structuredClone(args),
    parsed = taskPlanInput(args);
  assert.deepEqual(parsed, {
    title: args.title,
    plan: { total: 1, completed: 0, currentStep: defined(args.steps[0]).step, steps: args.steps },
    workId: args.workId,
  });
  assert.equal(Object.hasOwn(parsed, 'status'), false);
  assert.equal(Object.hasOwn(taskPlanInput(input({ status: undefined })), 'status'), false);
  assert.deepEqual(args, before);
  assert.equal(Object.hasOwn(TASK_PLAN_SCHEMA.status, 'default'), false);
  assert.deepEqual(TASK_PLAN_SCHEMA.status.enum, ['running', 'waiting_user']);
});

test('an explicitly waiting task preserves its matching work ID and actual unfinished checklist', () => {
  const args = input({
      workId: 'known-link-request',
      status: 'waiting_user',
      steps: [
        step('completed', 'Locate the requested page'),
        step('pending', 'Ask which channel should receive the link'),
      ],
    }),
    before = structuredClone(args),
    parsed = taskPlanInput(args);
  assert.equal(parsed.status, 'waiting_user');
  assert.equal(parsed.workId, args.workId);
  assert.equal(parsed.plan.total, 2);
  assert.equal(parsed.plan.completed, 1);
  assert.equal(parsed.plan.currentStep, defined(args.steps[1]).step);
  assert.deepEqual(parsed.plan.steps, args.steps);
  assert.deepEqual(args, before);
});

test('running remains an explicit progress state rather than completing or rewriting the checklist', () => {
  for (const steps of [[step('pending')], [step('inProgress')], [step('completed')]]) {
    const parsed = taskPlanInput(input({ status: 'running', steps }));
    assert.equal(parsed.status, 'running');
    assert.deepEqual(parsed.plan.steps, steps);
  }
});

test('waiting_user cannot claim executing steps or an already complete checklist', () => {
  for (const steps of [
    [step('inProgress')],
    [step('pending'), step('inProgress')],
    [step('completed')],
    [step('completed'), step('completed')],
  ])
    assert.throws(
      () => taskPlanInput(input({ status: 'waiting_user', steps })),
      /pending step and no inProgress/,
    );
  assert.throws(() => taskPlanInput(input({ status: 'waiting_user', steps: [] })), /actual steps/);
});

test('unsupported task statuses and forged control fields are rejected instead of becoming progress metadata', () => {
  for (const status of [
    null,
    false,
    0,
    {},
    [],
    '',
    'paused',
    'completed',
    'continuing',
    'waiting-user',
    'WAITING_USER',
  ])
    assert.throws(() => taskPlanInput(input({ status })), /status must be/);
  for (const extra of [
    { observed: true },
    { turnId: 'forged-turn' },
    { source: 'voice' },
    { executionEndedAt: 1 },
  ])
    assert.throws(() => taskPlanInput(input({ status: 'waiting_user', ...extra })), /task plan/);
});

test('waiting plan validation keeps the existing public redaction and step-count bounds', () => {
  const args = {
      title: 'Send synthetic-secret\nlink',
      status: 'waiting_user',
      steps: [
        step('completed', 'Find synthetic-secret'),
        step('pending', 'Ask synthetic-secret\nrecipient'),
      ],
    },
    parsed = taskPlanInput(args, {
      redact: (text) => text.replaceAll('synthetic-secret', '[redacted]'),
    });
  assert.equal(parsed.title, 'Send [redacted] link');
  assert.equal(parsed.plan.currentStep, 'Ask [redacted] recipient');
  assert.equal(JSON.stringify(parsed).includes('synthetic-secret'), false);
  const steps = Array.from({ length: 128 }, (_, index) =>
    step(index === 127 ? 'pending' : 'completed', 'Actual step ' + index),
  );
  assert.equal(taskPlanInput(input({ status: 'waiting_user', steps })).plan.completed, 127);
  assert.throws(
    () => taskPlanInput(input({ status: 'waiting_user', steps: [...steps, step()] })),
    /actual steps/,
  );
});
