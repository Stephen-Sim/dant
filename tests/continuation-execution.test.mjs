import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContinuationExecutionTracker,
  inheritContinuationExecutionEvidence,
  CONTINUATION_EXECUTION_EXTENSION_LIMIT,
} from '../src/work/continuation-execution.mjs';

const context = (attemptId = 'round-1', workId = 'work', checkpoint = 'a'.repeat(64)) => ({
  workId,
  attemptId,
  checkpoint,
});
const event = (item) => ({
  method: 'item/completed',
  params: {
    threadId: 'thread',
    turnId: 'turn',
    item: { id: 'item', status: 'completed', ...item },
  },
});
const command = (output = 'Actual new output', patch = {}) =>
  event({ type: 'commandExecution', exitCode: 0, aggregatedOutput: output, ...patch });
const file = (diff = '-old\n+new', patch = {}) =>
  event({
    type: 'fileChange',
    changes: [{ path: 'result.txt', kind: { type: 'update' }, diff }],
    ...patch,
  });
const desktop = (id = 'click-1', patch = {}) =>
  event({
    id,
    type: 'mcpToolCall',
    server: 'dant_desktop',
    tool: 'click',
    result: { isError: false, structuredContent: { ok: true } },
    ...patch,
  });

test('only successful completed evidence extends a continuation, never started, failed, observation or status tools', () => {
  const tracker = createContinuationExecutionTracker();
  for (const value of [
    { ...command(), method: 'item/started' },
    command('failure', { status: 'failed' }),
    command('failure', { exitCode: 1 }),
    command('failure', { error: { message: 'private' } }),
    command(''),
    command('   '),
    file('', {}),
    file('change', { status: 'declined' }),
    file('change', { changes: [] }),
    desktop('failure', { result: { isError: true, structuredContent: { ok: true } } }),
    desktop('failure', { result: { structuredContent: { ok: false } } }),
    desktop('status', { tool: 'screenshot' }),
    desktop('read', { tool: 'task_list' }),
    desktop('read', { server: 'other' }),
    event({ type: 'imageView' }),
    event({ type: 'webSearch' }),
  ])
    assert.equal(tracker.observe(context(), value), false, JSON.stringify(value));
  for (const type of ['read', 'search', 'listFiles'])
    assert.equal(
      tracker.observe(context(), command('read output', { commandActions: [{ type }] })),
      false,
      type,
    );
  assert.equal(tracker.observe(context(), command('Actual new output')), true);
});

test('repeated identical command output and duplicate file notifications do not invent progress', () => {
  const tracker = createContinuationExecutionTracker(),
    first = command('unchanged probe output');
  assert.equal(tracker.observe(context(), first), true);
  assert.equal(
    tracker.observe(context('round-2'), command('unchanged probe output', { id: 'different' })),
    false,
  );
  assert.equal(tracker.observe(context('round-2'), file()), true);
  assert.equal(tracker.observe(context('round-3'), file()), false);
  assert.equal(tracker.observe(context('round-3'), file('-new\n+verified')), true);
});

test('fourteen rounds of actual changing process output can proceed but changing probes stop earning grace after twenty rounds', () => {
  const tracker = createContinuationExecutionTracker();
  for (let round = 1; round <= CONTINUATION_EXECUTION_EXTENSION_LIMIT + 4; round++)
    assert.equal(
      tracker.observe(context('round-' + round), command('Processed batch ' + round)),
      round <= CONTINUATION_EXECUTION_EXTENSION_LIMIT,
      'round ' + round,
    );
  assert.equal(tracker.observe(context('round-new'), file('Verified actual file change')), true);
  assert.equal(
    tracker.observe(context('round-after-change'), command('New real output')),
    true,
    'strong actual change renews finite execution grace',
  );
});

test('many events in one attempt earn only one bounded round and successful desktop actions are also finite', () => {
  const tracker = createContinuationExecutionTracker();
  for (let eventNumber = 0; eventNumber < 90; eventNumber++)
    assert.equal(tracker.observe(context(), command('Output ' + eventNumber)), true);
  for (let round = 2; round <= CONTINUATION_EXECUTION_EXTENSION_LIMIT; round++)
    assert.equal(tracker.observe(context('round-' + round), desktop('click-' + round)), true);
  assert.equal(tracker.observe(context('round-over-limit'), desktop('click-too-many')), false);
  assert.equal(
    tracker.observe(context('round-over-limit'), command('Fresh output but no verified change')),
    false,
  );
  const parsed = createContinuationExecutionTracker();
  assert.equal(
    parsed.observe(
      context(),
      desktop('parsed', {
        tool: 'key',
        result: { content: [{ type: 'text', text: '{"ok":true}' }] },
      }),
    ),
    true,
  );
  assert.equal(
    parsed.observe(
      context('another'),
      desktop('parsed', {
        tool: 'key',
        result: { content: [{ type: 'text', text: '{"ok":true}' }] },
      }),
    ),
    false,
  );
});

test('actual plan progress resets grace, while work identities and lifecycle cleanup stay isolated and bounded', () => {
  const tracker = createContinuationExecutionTracker({ maxWorks: 2 });
  for (let round = 1; round <= 20; round++)
    assert.equal(tracker.observe(context('round-' + round), command('Status ' + round)), true);
  assert.equal(tracker.observe(context('old-plan'), command('over bound')), false);
  assert.equal(
    tracker.observe(context('new-plan', 'work', 'b'.repeat(64)), command('new plan output')),
    true,
  );
  assert.equal(tracker.observe(context('one', 'second'), command('same output')), true);
  assert.equal(tracker.observe(context('one', 'third'), command('same output')), true);
  assert.equal(tracker.observe(context('two', 'second'), command('same output')), false);
  tracker.forget('second');
  assert.equal(tracker.observe(context('three', 'second'), command('same output')), true);
  tracker.clear();
  assert.equal(tracker.observe(context('four', 'second'), command('same output')), true);
  assert.throws(() => createContinuationExecutionTracker({ maxWorks: 301 }), /bound/);
  for (const input of [
    {},
    { workId: 'bad id', attemptId: 'one', checkpoint: 'a'.repeat(64) },
    { workId: 'work', attemptId: 'one', checkpoint: 'invalid' },
  ])
    assert.equal(tracker.observe(input, command()), false);
});

test('native projections retain only private hashed evidence while raw command and output stay unchanged', () => {
  const tracker = createContinuationExecutionTracker(),
    original = command('private-output-' + 'x'.repeat(150000), {
      command: 'private-command',
      arguments: { token: 'private-token' },
    }),
    before = JSON.stringify(original),
    projected = {
      method: 'item/completed',
      params: { item: { id: 'item', type: 'commandExecution', status: 'completed', exitCode: 0 } },
    },
    serialized = JSON.stringify(projected);
  assert.equal(tracker.observe(context(), projected), false);
  assert.equal(inheritContinuationExecutionEvidence(original, projected), projected);
  assert.equal(JSON.stringify(projected), serialized);
  assert.equal(JSON.stringify(original), before);
  assert.equal(tracker.observe(context(), projected), true);
  assert.equal(tracker.observe(context('round-2'), original), false);
  assert.equal(JSON.stringify(tracker).includes('private'), false);
  const second = {
    method: 'item/completed',
    params: { item: { id: 'item', type: 'commandExecution', status: 'completed', exitCode: 0 } },
  };
  inheritContinuationExecutionEvidence(projected, second);
  assert.equal(tracker.observe(context('round-3', 'other-work'), second), true);
});

test('malformed mutation and tool results cannot earn evidence or leak their fields', () => {
  const tracker = createContinuationExecutionTracker();
  for (const value of [
    file('x', { changes: [{ path: 'file', kind: 'unknown', diff: 'private' }] }),
    file('x', {
      changes: Array.from({ length: 129 }, () => ({ path: 'file', kind: 'add', diff: 'x' })),
    }),
    desktop('bad', { result: { content: [{ type: 'text', text: 'not JSON' }] } }),
    desktop('bad', { result: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }),
    event({
      id: 'bad id',
      type: 'fileChange',
      changes: [{ path: 'file', kind: 'add', diff: 'x' }],
    }),
  ])
    assert.equal(tracker.observe(context(), value), false);
});
