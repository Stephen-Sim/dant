import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { checkReactions, reactionSequences } from '../../scripts/core/generate-reactions.mts';
import { isReaction } from '../../src/conversation/reactions.mts';

test('the Go reaction vocabulary retains every bundled sequence under the actual Node contract', () => {
  checkReactions();
  const values = fs
    .readFileSync(
      new URL('../../core/internal/history/assets/reactions.txt', import.meta.url),
      'utf8',
    )
    .trimEnd()
    .split('\n');
  assert.ok(values.every(isReaction));
  assert.deepEqual(
    reactionSequences(
      '231A..231B ; Basic_Emoji # range\n1F469 200D 1F680 ; RGI_Emoji_ZWJ_Sequence',
    ),
    ['⌚', '⌛', '👩‍🚀'],
  );
  assert.throws(() => reactionSequences('110000 ; Basic_Emoji'));
  assert.throws(() => reactionSequences('FFFF..FFFE ; Basic_Emoji'));
});
