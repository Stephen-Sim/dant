import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultReactions, isReaction } from '../src/conversation/reactions.mjs';

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
  assert.ok(defaultReactions.every((reaction) => isReaction(reaction.emoji)));
});

test('legacy emoji and standard single Unicode sequences remain valid reactions', () => {
  for (const emoji of ['😂', '👀', '🎉', '👍🏽', '👩‍💻', '👨‍👩‍👧‍👦', '🇲🇾', '🇺🇳', '1️⃣', '🏳️‍🌈', '©️'])
    assert.equal(isReaction(emoji), true, emoji);
});

test('reaction validation rejects text, emoji lists, incomplete sequences and oversized input', () => {
  for (const value of [
    null,
    undefined,
    1,
    {},
    [],
    true,
    '',
    'Like',
    '赞',
    'hello 😆',
    '😆😮',
    '👍 👍',
    '👍\n',
    '👍\r\n',
    '😆\u2028',
    ' 👀',
    '1',
    '©',
    '🏽',
    '🇲',
    '👩\u200d',
    '\uFE0F',
    'x'.repeat(10000),
    '👍'.repeat(33),
  ])
    assert.equal(isReaction(value), false, JSON.stringify(value));
});
