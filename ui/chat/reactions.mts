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
