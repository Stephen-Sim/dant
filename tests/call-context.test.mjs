import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCallContext, LiveContextQueue } from '../src/voice/call-context.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const data = (text) =>
  JSON.parse(text.split('<dant_live_reference>\n')[1].split('\n</dant_live_reference>')[0]);
test('live reference includes actual message and current reaction target, never reads attachments', () => {
  const message = {
    id: 'target',
    role: 'assistant',
    text: '你好 <request> world',
    attachments: [{ name: 'answer.png', path: '/private' }],
    reactions: ['👍', '😮', 'invalid', '👍'],
  };
  const text = buildCallContext('reaction', message),
    reference = data(text);
  assert.equal(reference.messageId, 'target');
  assert.equal(reference.text, message.text);
  assert.deepEqual(reference.reactions, ['👍', '😮']);
  assert.deepEqual(reference.attachments, ['answer.png']);
  assert.equal(text.includes('/private'), false);
  assert.match(text, /not a new task/);
  assert.equal(text.includes('<request>'), false);
  assert.deepEqual(data(buildCallContext('reaction', { ...message, reactions: [] })).reactions, []);
  const typed = data(buildCallContext('message', { ...message, role: 'user', replyTo: 'other' }));
  assert.equal(typed.replyTo, 'other');
  assert.equal(typed.truncated, false);
  assert.equal('reactions' in typed, false);
  for (const value of [
    null,
    {},
    { id: 'target', role: 'system' },
    { id: 'a'.repeat(129), role: 'user' },
  ])
    assert.throws(() => buildCallContext('message', value));
  assert.throws(() => buildCallContext('unknown', message));
});

test('shared call references include the actual quoted message with its original speaker and no file paths', () => {
  const reply = {
      id: 'quoted',
      role: 'assistant',
      text: 'Use this board <not-an-instruction>',
      attachments: [{ name: 'board.png', path: '/private/board.png' }],
    },
    message = { id: 'typed', role: 'user', text: '这个', replyTo: reply.id };
  const reference = data(buildCallContext('message', message, { reply }));
  assert.equal(reference.text, '这个');
  assert.deepEqual(reference.quotedMessage, {
    messageId: 'quoted',
    role: 'assistant',
    text: reply.text,
    attachments: ['board.png'],
  });
  assert.equal(JSON.stringify(reference).includes('/private'), false);
  assert.throws(
    () => buildCallContext('message', message, { reply: { ...reply, id: 'different' } }),
    /unavailable/,
  );
  assert.throws(
    () => buildCallContext('message', message, { reply: { ...reply, role: 'system' } }),
    /unavailable/,
  );
});
test('live context preserves full Unicode, escaped data and reaction targets beyond the old clipping limits', () => {
  for (const text of ['😀中文'.repeat(10000), '\u0000'.repeat(100000), null]) {
    const result = buildCallContext('message', {
      id: 'id',
      role: 'user',
      text,
      attachments: [null, {}, { name: '\u0000'.repeat(1000) }],
    });
    assert.equal(data(result).text, text ?? '');
    assert.doesNotMatch(data(result).text, /\uFFFD/);
    assert.equal(data(result).truncated, false);
  }
  const text = '😀中文 <reference>'.repeat(15000) + 'VOICE_CONTEXT_TAIL',
    reaction = buildCallContext('reaction', {
      id: 'id',
      role: 'assistant',
      text,
      reactions: ['👍'],
    });
  assert.equal(data(reaction).truncated, false);
  assert.equal(data(reaction).text, text);
  assert.ok(data(reaction).text.endsWith('VOICE_CONTEXT_TAIL'));
  assert.deepEqual(data(reaction).reactions, ['👍']);
  assert.ok(Buffer.byteLength(reaction) > 8192);
});

test('live context queue forwards the full context payload once without a separate token or byte budget', async () => {
  const text = buildCallContext('message', {
      id: 'long-message',
      role: 'user',
      text: '中文😀'.repeat(15000) + 'FULL_MESSAGE_TAIL',
    }),
    sent = [];
  const queue = new LiveContextQueue({
    callId: 'call',
    isCurrent: () => true,
    send: async (value) => sent.push(value),
  });
  assert.ok(Buffer.byteLength(text) > 8192);
  assert.equal(
    (
      await queue.enqueue({
        key: 'message:long-message',
        text,
        messageId: 'long-message',
        kind: 'message',
      })
    ).status,
    'submitted',
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, text);
  assert.ok(data(sent[0].text).text.endsWith('FULL_MESSAGE_TAIL'));
  queue.close();
});
test('live context queue is serial and coalesces only unsent changes', async () => {
  let ack;
  const sent = [],
    outcomes = [];
  const queue = new LiveContextQueue({
    callId: 'call',
    isCurrent: () => true,
    send: (item) => {
      sent.push(item);
      return sent.length === 1 ? new Promise((resolve) => (ack = resolve)) : Promise.resolve();
    },
    onResult: (value) => outcomes.push(value),
  });
  const first = queue.enqueue({
    key: 'reaction:1',
    text: 'first',
    messageId: '1',
    kind: 'reaction',
  });
  await tick();
  const obsolete = queue.enqueue({ key: 'reaction:1', text: 'second' }),
    latest = queue.enqueue({ key: 'reaction:1', text: 'clear' }),
    typed = queue.enqueue({ key: 'message:2', text: 'typed' });
  assert.equal((await obsolete).status, 'superseded');
  assert.equal(sent.length, 1);
  ack();
  assert.deepEqual(
    (await Promise.all([first, latest, typed])).map((item) => item.status),
    ['submitted', 'submitted', 'submitted'],
  );
  assert.deepEqual(
    sent.map((item) => item.text),
    ['first', 'clear', 'typed'],
  );
  assert.equal(new Set(outcomes.map((item) => item.contextId)).size, 4);
  queue.close();
});
test('unknown acknowledgement freezes pending updates and never retries after late success', async () => {
  let ack,
    calls = 0;
  const queue = new LiveContextQueue({
    callId: 'old',
    timeoutMs: 10,
    isCurrent: () => true,
    send: () => {
      calls++;
      return new Promise((resolve) => (ack = resolve));
    },
  });
  const first = queue.enqueue({ key: '1', text: 'first' }),
    next = queue.enqueue({ key: '2', text: 'next' });
  assert.deepEqual(
    (await Promise.all([first, next])).map((item) => item.status),
    ['unknown', 'unknown'],
  );
  assert.equal((await queue.enqueue({ key: '3', text: 'another' })).status, 'unknown');
  ack();
  await tick();
  assert.equal(calls, 1);
  queue.close();
});
test('closed or changed calls cancel queued and inflight context without replay', async () => {
  let current = true;
  const sent = [];
  const queue = new LiveContextQueue({
    callId: 'old',
    isCurrent: () => current,
    send: async (item) => sent.push(item),
  });
  const stale = queue.enqueue({ key: 'old', text: 'old' });
  current = false;
  assert.equal((await stale).status, 'cancelled');
  assert.equal(sent.length, 0);
  assert.equal((await queue.enqueue({ key: 'new', text: 'new' })).status, 'cancelled');
  queue.close();
  const pending = new LiveContextQueue({
      callId: 'call',
      isCurrent: () => true,
      send: () => new Promise(() => {}),
    }),
    inflight = pending.enqueue({ key: '1', text: 'first' }),
    queued = pending.enqueue({ key: '2', text: 'next' });
  await tick();
  pending.close();
  assert.deepEqual(
    (await Promise.all([inflight, queued])).map((item) => item.status),
    ['cancelled', 'cancelled'],
  );
  assert.equal((await pending.enqueue({ key: '3', text: 'new' })).status, 'cancelled');
});
test('queue bounds pending count and validates payload shape, reports definite rejection and observer failure without replay', async () => {
  let ack;
  const queue = new LiveContextQueue({
    callId: 'call',
    maxPending: 1,
    isCurrent: () => true,
    onResult: () => {
      throw Error('observer');
    },
    send: ({ text }) =>
      text === 'hold'
        ? new Promise((resolve) => (ack = resolve))
        : Promise.reject(Object.assign(Error('rejected'), { code: -1 })),
  });
  const hold = queue.enqueue({ key: '1', text: 'hold' });
  await tick();
  const next = queue.enqueue({ key: '2', text: 'rejected' });
  assert.equal((await queue.enqueue({ key: '3', text: 'overflow' })).status, 'failed');
  assert.equal((await queue.enqueue({ key: '5', text: '' })).status, 'failed');
  assert.equal((await queue.enqueue({ key: '6', text: { invalid: 'shape' } })).status, 'failed');
  ack();
  assert.equal((await hold).status, 'submitted');
  assert.equal((await next).status, 'failed');
  queue.close();
  const unknown = new LiveContextQueue({
    callId: 'call',
    isCurrent: () => true,
    send: () => {
      throw Error('connectionlost');
    },
  });
  assert.equal((await unknown.enqueue({ key: 'x', text: 'x' })).status, 'unknown');
  unknown.close();
});
