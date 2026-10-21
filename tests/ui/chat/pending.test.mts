import { defined } from '../../support/fixture-assertions.mts';
import { isRecord } from '../../../ui/shared/contracts.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageSubmissions, createCallStops } from '../../../ui/chat/pending.mts';

test('a message attempt keeps its id and an ambiguous result blocks default resubmission', () => {
  let next = 0;
  const submissions = createMessageSubmissions({ newId: () => `attempt-${++next}` }),
    payload = { text: 'Run once', attachments: ['file'], replyTo: null };
  const first = submissions.prepare('/messages', payload);
  assert.equal(
    submissions.prepare('/messages', structuredClone(payload)).clientMessageId,
    first.clientMessageId,
  );
  submissions.unconfirmed(first);
  assert.throws(
    () => submissions.prepare('/messages', payload),
    (error) => isRecord(error) && error.needsConfirmation === true,
  );
  assert.throws(
    () => submissions.prepare('/messages', { text: 'Another draft' }),
    (error) => isRecord(error) && error.needsConfirmation === true,
    'an unresolved attempt must remain visible',
  );
  assert.equal(next, 1);
  const found = { clientMessageId: first.clientMessageId, status: 'running' };
  assert.equal(submissions.find([{ clientMessageId: 'other' }, found]), found);
  submissions.acknowledged(found.clientMessageId);
  assert.equal(submissions.unknown, null);
  assert.equal(submissions.prepare('/messages', payload).clientMessageId, 'attempt-2');
});

test('only explicit resubmission creates a fresh id after an unknown outcome', () => {
  let next = 0;
  const submissions = createMessageSubmissions({ newId: () => `attempt-${++next}` }),
    payload = { callId: 'call-a', text: 'Task during a call' };
  const first = submissions.prepare('/realtime/message', payload);
  submissions.unconfirmed(first);
  assert.equal(submissions.find([]), null);
  assert.equal(submissions.unknown, first);
  const second = submissions.prepare('/realtime/message', payload, { confirmResend: true });
  assert.equal(second.clientMessageId, 'attempt-2');
  assert.notEqual(first.clientMessageId, second.clientMessageId);
  assert.equal(submissions.unknown, null);
  submissions.unconfirmed(second);
  submissions.acknowledged(first.clientMessageId);
  assert.equal(
    submissions.unknown,
    second,
    'a stale acknowledgement cannot clear the newer ambiguous attempt',
  );
});

test('disconnect keeps the exact call id, stop requests serialize, and a failed stop remains recoverable', async () => {
  const sent: string[] = [];
  let release: (() => void) | undefined;
  const stops = createCallStops((callId) => {
    sent.push(callId);
    return new Promise<void>((resolve) => (release = resolve));
  });
  stops.add('old-call');
  stops.add('old-call');
  assert.equal(stops.pending, true);
  const first = stops.flush(),
    second = stops.flush();
  assert.equal(first, second);
  assert.deepEqual(sent, ['old-call']);
  defined(release)();
  assert.deepEqual(await first, []);
  assert.equal(stops.pending, false);
  let calls = 0;
  const retry = createCallStops(async (callId) => {
    calls++;
    assert.equal(callId, 'exact-call');
    if (calls === 1) throw Object.assign(Error('Unknown result'), { unknownOutcome: true });
  });
  retry.add('exact-call');
  assert.equal((await retry.flush()).length, 1);
  assert.deepEqual(retry.ids, ['exact-call']);
  await retry.flush();
  assert.equal(retry.pending, false);
  assert.equal(calls, 2);
});

test('a changed call rejects the old id without attempting to stop the newer call', async () => {
  const sent: string[] = [],
    stops = createCallStops(async (callId) => {
      sent.push(callId);
      throw Object.assign(Error('The voice call changed'), { status: 400 });
    });
  stops.add('old-call');
  assert.deepEqual(await stops.flush(), []);
  assert.deepEqual(sent, ['old-call']);
  assert.equal(stops.pending, false);
});
