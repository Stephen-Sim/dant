import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultReactions } from '../../../ui/chat/reactions.mts';
test('the six shared default reactions have stable IDs and Chinese and English labels', () => {
  assert.deepEqual(defaultReactions, [
    { id: 'like', emoji: '👍', en: 'Like', zh: '赞' },
    { id: 'love', emoji: '❤️', en: 'Love', zh: '爱' },
    { id: 'haha', emoji: '😆', en: 'Haha', zh: '大笑' },
    { id: 'wow', emoji: '😮', en: 'Wow', zh: '惊讶' },
    { id: 'sad', emoji: '😢', en: 'Sad', zh: '难过' },
    { id: 'angry', emoji: '😡', en: 'Angry', zh: '生气' },
  ]);
  assert.ok(Object.isFrozen(defaultReactions));
  assert.ok(defaultReactions.every(Object.isFrozen));
  const vocabulary = new Set(
    fs
      .readFileSync(
        new URL('../../../core/internal/history/assets/reactions.txt', import.meta.url),
        'utf8',
      )
      .trimEnd()
      .split('\n'),
  );
  assert.ok(defaultReactions.every((reaction) => vocabulary.has(reaction.emoji)));
});
