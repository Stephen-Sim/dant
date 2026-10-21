import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMessages } from '../../../ui/chat/chat-search.mts';
test('chat search matches Chinese, case-insensitive English, normalized fullwidth text and attachment names', () => {
  const messages = [
    {
      id: 'old',
      role: 'user',
      time: 1,
      text: 'Hello 中文聊天记录',
      attachments: [{ name: 'Report.PDF', path: '/not-for-search' }],
    },
    { id: 'new', role: 'assistant', time: 2, text: 'ＨＥＬＬＯ 完成' },
    { id: 'call', role: 'system', text: 'hello' },
    null,
  ];
  assert.deepEqual(
    searchMessages(messages, 'hello').map((item) => item.messageId),
    ['new', 'old'],
  );
  assert.equal(defined(searchMessages(messages, '聊天记录')[0]).messageId, 'old');
  const file = searchMessages(messages, 'report.pdf')[0];
  assert.equal(defined(file).matchedField, 'attachment');
  assert.equal(defined(file).snippet, 'Report.PDF');
  assert.equal(searchMessages(messages, 'not-for-search').length, 0);
  assert.equal(searchMessages(messages, 'Ｎｏｔ　ｆｏｕｎｄ').length, 0);
  assert.equal(defined(searchMessages(messages, 'Hello', { limit: 1 })[0]).messageId, 'new');
});
test('chat search updates from edited and removed records, bounds results and uses literal text', () => {
  const records = [{ id: 'id', role: 'user', text: 'Need [text].* exactly' }];
  assert.equal(searchMessages(records, '[text].*').length, 1);
  defined(records[0]).text = 'Edited message';
  assert.equal(searchMessages(records, '[text].*').length, 0);
  assert.equal(searchMessages(records, 'edited').length, 1);
  records.length = 0;
  assert.deepEqual(searchMessages(records, 'edited'), []);
  for (const value of ['', null, ' '.repeat(4), 'a'.repeat(201)])
    assert.deepEqual(searchMessages(records, value), []);
  assert.deepEqual(searchMessages(null, 'a'), []);
  const many = Array.from({ length: 110 }, (_, n) => ({
    id: String(n),
    role: 'assistant',
    text: 'target',
  }));
  assert.equal(searchMessages(many, 'target', { limit: 1000 }).length, 100);
  assert.equal(searchMessages(many, 'target', { limit: 0 }).length, 1);
  assert.equal(searchMessages(many, 'target', { limit: NaN }).length, 50);
});
test('chat search produces bounded text snippets without interpreting markup', () => {
  const text = 'a'.repeat(100) + '<script>literal</script>' + 'z'.repeat(200);
  const [result] = searchMessages(
    [{ id: 'id', role: 'assistant', text, attachments: [null, {}] }],
    'literal',
  );
  assert.match(defined(result).snippet, /^…/);
  assert.match(defined(result).snippet, /…$/);
  assert.ok(defined(defined(result).snippet).length < 180);
  assert.equal(defined(result).text, text);
  assert.equal(defined(result).time, null);
});
