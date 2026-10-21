import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMarkdownCache,
  formatMessageTime,
  MARKDOWN_CACHE_CHARACTER_LIMIT,
  MARKDOWN_CACHE_ENTRY_LIMIT,
} from '../../../ui/chat/render-cache.mts';
import { escapeHtml } from '../../../ui/shared/html.mts';

test('hundreds of unchanged messages reuse sanitized output and edited text goes through rendering again', () => {
  let renders = 0;
  const cache = createMarkdownCache((text) => {
      renders++;
      return '<p>' + escapeHtml(text) + '</p>';
    }),
    messages = Array.from(
      { length: 623 },
      (_, index) => `Message ${index}: <script>unsafe</script>`,
    );
  const first = messages.map((text) => cache.render(text));
  for (let update = 0; update < 4; update++)
    assert.deepEqual(
      messages.map((text) => cache.render(text)),
      first,
    );
  assert.equal(renders, messages.length);
  assert.ok(first.every((html) => !html.includes('<script>')));
  assert.equal(cache.render('Edited <img src=x>'), '<p>Edited &lt;img src=x&gt;</p>');
  assert.equal(renders, messages.length + 1);
  cache.clear();
  assert.equal(cache.render(messages[0] ?? ''), first[0]);
  assert.equal(renders, messages.length + 2);
});

test('entry and character bounds evict old output without caching an oversized message or failed render', () => {
  let renders = 0;
  const cache = createMarkdownCache((text) => {
    renders++;
    if (text === 'failed') throw Error('Sanitizer unavailable');
    return text;
  });
  for (let index = 0; index < MARKDOWN_CACHE_ENTRY_LIMIT; index++) cache.render('entry-' + index);
  cache.render('entry-0');
  cache.render('new-entry');
  cache.render('entry-0');
  assert.equal(renders, MARKDOWN_CACHE_ENTRY_LIMIT + 1);
  cache.render('entry-1');
  assert.equal(renders, MARKDOWN_CACHE_ENTRY_LIMIT + 2);
  const large = 'x'.repeat(MARKDOWN_CACHE_CHARACTER_LIMIT / 2);
  cache.render(large);
  cache.render(large);
  assert.equal(renders, MARKDOWN_CACHE_ENTRY_LIMIT + 3);
  cache.render('small');
  cache.render(large);
  assert.equal(renders, MARKDOWN_CACHE_ENTRY_LIMIT + 5);
  const oversized = large + 'x';
  cache.render(oversized);
  cache.render(oversized);
  assert.equal(renders, MARKDOWN_CACHE_ENTRY_LIMIT + 7);
  assert.throws(() => cache.render('failed'), /Sanitizer unavailable/);
  assert.throws(() => cache.render('failed'), /Sanitizer unavailable/);
  assert.equal(renders, MARKDOWN_CACHE_ENTRY_LIMIT + 9);
});

test('message time formatting preserves each locale and full/short display across cache reuse and eviction', () => {
  const date = new Date('2026-10-19T10:20:00Z');
  for (const locale of [
    'en',
    'zh-CN',
    'ar',
    ...Array.from({ length: 70 }, (_, index) => 'en-x-t' + index),
  ])
    for (const full of [false, true]) {
      const expected = new Intl.DateTimeFormat(
        locale,
        full
          ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
          : { hour: '2-digit', minute: '2-digit' },
      ).format(date);
      assert.equal(formatMessageTime(date, locale, full), expected);
      assert.equal(formatMessageTime(date, locale, full), expected);
    }
});

test('cached message times follow OS timezone changes, including equal-current-offset zones', async () => {
  const previous = process.env.TZ,
    date = new Date('2026-01-19T12:00:00Z');
  try {
    for (const timeZone of ['UTC', 'Asia/Tokyo', 'Africa/Johannesburg', 'Europe/Berlin', 'UTC']) {
      process.env.TZ = timeZone;
      await Promise.resolve();
      for (const full of [false, true]) {
        const expected = new Intl.DateTimeFormat(
          'en-GB',
          full
            ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }
            : { hour: '2-digit', minute: '2-digit', timeZone },
        ).format(date);
        assert.equal(formatMessageTime(date, 'en-GB', full), expected);
        assert.equal(formatMessageTime(date, 'en-GB', full), expected);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
    await Promise.resolve();
  }
});
