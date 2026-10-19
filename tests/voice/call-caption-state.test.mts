import test from 'node:test';
import assert from 'node:assert/strict';
import { readCallCaption, CALL_CAPTION_TEXT_LIMIT } from '../../src/contracts/call-caption.mts';
import { createCallCaptionState } from '../../src/voice/call-caption-state.mts';

const call = { id: 'current-call', provider: 'subscription', status: 'connected' };
const options = { scope: 'conversation:connection', connected: true };
const caption = (sequence = 1, patch: Record<string, unknown> = {}) => ({
  callId: call.id,
  provider: call.provider,
  sequence,
  text: 'Current spoken answer',
  final: false,
  ...patch,
});
const event = (sequence = 1, patch: Record<string, unknown> = {}) => ({
  method: 'dant/call/subtitle',
  params: caption(sequence, patch),
});

test('caption contract accepts only bounded valid current utterances and returns a detached copy', () => {
  const input = caption(),
    result = readCallCaption(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  for (const patch of [
    { callId: '' },
    { callId: 'x'.repeat(257) },
    { callId: 'bad\ncall' },
    { provider: 'user' },
    { sequence: 0 },
    { sequence: -1 },
    { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: '1' },
    { text: 'x'.repeat(CALL_CAPTION_TEXT_LIMIT + 1) },
    { text: 'unsafe\u0000text' },
    { text: null },
    { final: 'false' },
  ])
    assert.equal(readCallCaption(caption(1, patch)), null);
  assert.equal(readCallCaption(null), null);
  assert.equal(readCallCaption(caption(1, { text: '', final: true }))?.text, '');
});

test('RAM captions keep the last final answer, honor clear events and never regress sequence or provider', () => {
  const state = createCallCaptionState();
  state.sync(call, options);
  assert.equal(state.receive(event()), true);
  assert.equal(state.receive(event(2, { text: 'Finished answer', final: true })), true);
  state.sync({ ...call }, options);
  assert.equal(state.snapshot?.text, 'Finished answer');
  for (const late of [
    event(),
    event(2),
    event(3, { provider: 'api' }),
    event(3, { callId: 'old' }),
  ])
    assert.equal(state.receive(late), false);
  const detached = state.snapshot;
  assert.ok(detached);
  detached.text = 'Do not mutate retained caption';
  assert.equal(state.snapshot?.text, 'Finished answer');
  assert.equal(state.receive(event(3, { text: '', final: false })), true);
  assert.equal(state.snapshot?.text, '');
  assert.equal(state.receive(event(2, { text: 'Old final', final: true })), false);
  assert.equal(state.snapshot?.text, '');
});

test('call, connection and conversation fences discard old speech without reviving it from a cached snapshot', () => {
  const state = createCallCaptionState();
  state.sync(call, options);
  state.receive(event(5));
  state.sync(call, { ...options, connected: false });
  assert.equal(state.snapshot, null);
  assert.equal(state.receive(event(6)), false);
  state.sync(call, options);
  assert.equal(state.observe(caption(5)), false);
  assert.equal(state.snapshot, null);
  assert.equal(state.receive(event(6, { text: 'Fresh after reconnection' })), true);
  state.sync(call, { ...options, scope: 'different-conversation' });
  assert.equal(state.snapshot, null);
  state.sync({ ...call, id: 'new-call' }, { ...options, scope: 'different-conversation' });
  assert.equal(state.receive(event(100)), false);
  assert.equal(state.receive(event(1, { callId: 'new-call' })), true);
  state.sync(null, { ...options, scope: 'different-conversation' });
  state.sync({ ...call, id: 'new-call' }, { ...options, scope: 'different-conversation' });
  assert.equal(state.receive(event(2, { callId: 'new-call' })), false);
  assert.equal(state.snapshot, null);
});

test('credential redaction fails closed and both current state and retired call metadata stay bounded', () => {
  const state = createCallCaptionState({
    redact: (text) => text.replace('synthetic-private', '[credential redacted]'),
  });
  state.sync(call, options);
  state.receive(event(1, { text: 'Value synthetic-private' }));
  assert.equal(state.snapshot?.text, 'Value [credential redacted]');
  const failed = createCallCaptionState({
    redact: () => {
      throw Error('private error');
    },
  });
  failed.sync(call, options);
  assert.equal(failed.receive(event()), true);
  assert.equal(failed.snapshot?.text, '');
  assert.equal(failed.receive({ method: 'unrelated', params: caption(2) }), false);
  for (let index = 0; index < 100; index++) {
    state.sync({ ...call, id: 'next-' + index }, options);
    assert.equal(state.receive(event(1, { callId: 'next-' + index })), true);
    assert.equal(state.snapshot?.callId, 'next-' + index);
  }
  state.sync({ ...call, id: 'stopping-call', status: 'stopping' }, options);
  assert.equal(state.snapshot, null);
  state.sync({ ...call, id: 'unknown-status-call', status: 'new-unknown-status' }, options);
  assert.equal(state.receive(event(1, { callId: 'unknown-status-call' })), false);
  state.end();
  assert.equal(state.snapshot, null);
});
