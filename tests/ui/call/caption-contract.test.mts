import test from 'node:test';
import assert from 'node:assert/strict';
import { readCallCaption, CALL_CAPTION_TEXT_LIMIT } from '../../../ui/call/caption-contracts.mts';
const caption = (sequence = 1, patch: Record<string, unknown> = {}) => ({
  callId: 'current-call',
  provider: 'subscription',
  sequence,
  text: 'Current spoken answer',
  final: false,
  ...patch,
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
