export const defaultReactions = Object.freeze(
  [
    { id: 'like', emoji: '👍', en: 'Like', zh: '赞' },
    { id: 'love', emoji: '❤️', en: 'Love', zh: '爱' },
    { id: 'haha', emoji: '😆', en: 'Haha', zh: '大笑' },
    { id: 'wow', emoji: '😮', en: 'Wow', zh: '惊讶' },
    { id: 'sad', emoji: '😢', en: 'Sad', zh: '难过' },
    { id: 'angry', emoji: '😡', en: 'Angry', zh: '生气' },
  ].map((reaction) => Object.freeze(reaction)),
);

// Stored reactions from earlier versions remain valid. The Unicode string
// property recognizes full emoji sequences, including skin tones, ZWJ and flags.
const compatible = new Set([
  ...defaultReactions.map((reaction) => reaction.emoji),
  '😂',
  '👀',
  '🎉',
]);
let unicodeEmoji: RegExp | undefined;
try {
  unicodeEmoji = new RegExp('^(?:\\p{RGI_Emoji})(?![\\s\\S])', 'v');
} catch {
  /* Older webviews retain the default and legacy set. */
}
export function isReaction(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    !/[\s\p{Cc}]/u.test(value) &&
    !/^\p{Emoji_Component}$/u.test(value) &&
    (compatible.has(value) || Boolean(unicodeEmoji?.test(value)))
  );
}
