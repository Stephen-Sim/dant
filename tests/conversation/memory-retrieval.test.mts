import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../../src/conversation/memory.mts';
import type { MemorySource } from '../../src/conversation/memory-types.ts';
import {
  MEMORY_RETRIEVAL_RESULT_LIMIT,
  MEMORY_RETRIEVAL_TEXT_BUDGET,
} from '../../src/conversation/memory-constants.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(base, 'memory-retrieval-'));
  const memory = new MemoryStore(dir);
  t.after(() => {
    memory.close();
    const relative = path.relative(base, dir);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { memory, dir };
}
function confirmed(
  memory: MemoryStore,
  text: string,
  source: MemorySource = { kind: 'user' },
  kind: 'semantic' | 'episodic' = 'semantic',
) {
  const entry = memory.proposeEntry({ kind, text, source });
  return memory.confirmEntry(entry.id);
}
function project(memory: MemoryStore, conversationId: string, workId: string, text: string) {
  return memory.writeProject(conversationId, workId, {
    version: 1,
    updatedAt: 1000,
    originalRequest: { messageId: 'message-' + workId, at: 1000, text, attachments: [] },
    humanUpdates: [],
    results: [],
  });
}

test('recall validates exact conversation and optional project identities before reading reference data', (t) => {
  const { memory } = fixture(t);
  for (const scope of [
    null,
    {},
    { conversationId: '' },
    { conversationId: 'wrong scope' },
    { conversationId: 'conv', workId: null },
    { conversationId: 'conv', workId: '' },
    { conversationId: 'conv', extra: true },
    { conversationId: 'x'.repeat(257) },
  ])
    assert.throws(() => memory.retrieve('Python', scope), /scope/);
  assert.throws(() => memory.retrieve(42, { conversationId: 'conv' }), /query/);
  for (const limit of [0, -1, 1.5, Infinity, MEMORY_RETRIEVAL_RESULT_LIMIT + 1])
    assert.throws(() => memory.retrieve('Python', { conversationId: 'conv' }, { limit }), /limit/);
});

test('global semantic preferences and conversation facts are recalled while work-specific and episodic memories retain their scope', (t) => {
  const { memory } = fixture(t);
  const global = confirmed(memory, 'Python global preference');
  const conversation = confirmed(memory, 'Python conversation fact', {
    kind: 'user',
    conversationId: 'conv-a',
  });
  const scoped = confirmed(memory, 'Python project fact', {
    kind: 'task',
    conversationId: 'conv-a',
    workId: 'work-a',
  });
  const episodic = confirmed(
    memory,
    'Python episode',
    { kind: 'task', conversationId: 'conv-a' },
    'episodic',
  );
  confirmed(memory, 'Python other conversation', { kind: 'user', conversationId: 'conv-b' });
  confirmed(memory, 'Python other project', {
    kind: 'task',
    conversationId: 'conv-a',
    workId: 'work-b',
  });
  confirmed(memory, 'Python unscoped episode', { kind: 'inference' }, 'episodic');
  confirmed(memory, 'Python orphan project source', { kind: 'task', workId: 'work-a' });
  project(memory, 'conv-a', 'work-a', 'Python project outcome');
  project(memory, 'conv-a', 'work-b', 'Python unrelated outcome');
  const plain = memory.retrieve('Python', { conversationId: 'conv-a' });
  assert.deepEqual(
    new Set(plain.map((entry) => entry.id)),
    new Set([global.id, conversation.id, episodic.id]),
  );
  const target = memory.retrieve('Python', { conversationId: 'conv-a', workId: 'work-a' });
  assert.deepEqual(
    new Set(target.map((entry) => entry.id)),
    new Set([global.id, conversation.id, scoped.id, episodic.id, 'work-a']),
  );
  assert.deepEqual(target.find((entry) => entry.id === scoped.id)?.source, scoped.source);
  assert.equal(target.find((entry) => entry.id === 'work-a')?.conversationId, 'conv-a');
});

test('scope filters apply before ranking and LIMIT so unrelated projects cannot crowd out the actual project', (t) => {
  const { memory } = fixture(t);
  for (let index = 0; index < 20; index++)
    project(memory, index % 2 ? 'conv-b' : 'conv-a', 'outsider-' + index, 'renderer');
  project(
    memory,
    'conv-a',
    'wanted',
    'The renderer project has a longer verified result that must remain available.',
  );
  const result = memory.retrieve(
    'renderer',
    { conversationId: 'conv-a', workId: 'wanted' },
    { limit: 1 },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, 'wanted');
  assert.match(result[0]?.text ?? '', /verified result/);
  assert.deepEqual(memory.retrieve('renderer', { conversationId: 'conv-a' }), []);
});

test('only confirmed live entries participate; candidate, conflicted, rejected and deleted facts stay out', (t) => {
  const { memory } = fixture(t);
  const rejected = confirmed(memory, 'Cairo renderer old preference', { kind: 'user' });
  const conflict = memory.proposeEntry({
    kind: 'semantic',
    text: 'Cairo renderer replacement',
    key: rejected.key,
    source: { kind: 'user' },
  });
  memory.proposeEntry({
    kind: 'semantic',
    text: 'Cairo renderer candidate',
    source: { kind: 'inference' },
  });
  assert.equal(conflict.status, 'conflicted');
  assert.deepEqual(
    memory.retrieve('Cairo', { conversationId: 'conv' }).map((entry) => entry.id),
    [rejected.id],
  );
  memory.confirmEntry(conflict.id, { resolveConflicts: true });
  assert.deepEqual(
    memory.retrieve('Cairo', { conversationId: 'conv' }).map((entry) => entry.id),
    [conflict.id],
  );
  memory.deleteEntry(conflict.id);
  assert.deepEqual(memory.retrieve('Cairo', { conversationId: 'conv' }), []);
});

test('natural multilingual or long queries use bounded meaningful terms while explicit search preserves its strict AND contract', (t) => {
  const { memory } = fixture(t);
  const entry = confirmed(memory, 'Python renderer uses Cairo with concise logs.');
  for (const query of [
    'Please remind me how we configured the Python renderer',
    '请帮我回忆Python renderer配置',
    'Please '.repeat(200) + 'Python renderer',
  ]) {
    assert.equal(memory.retrieve(query, { conversationId: 'conv' })[0]?.id, entry.id);
  }
  assert.deepEqual(memory.search('Please remind me how we configured the Python renderer'), []);
  assert.throws(() => memory.search('x'.repeat(257)), /bounded/);
  assert.deepEqual(memory.retrieve('please can you tell me', { conversationId: 'conv' }), []);
  assert.deepEqual(memory.retrieve('unrelatedquasarword', { conversationId: 'conv' }), []);
  assert.deepEqual(
    memory.retrieve('secret="fixture_private_query"', { conversationId: 'conv' }),
    [],
  );
  assert.doesNotThrow(() => memory.retrieve('x'.repeat(40_000), { conversationId: 'conv' }));
});

test('relevant excerpts find deep matches and bound the total returned reference text', (t) => {
  const { memory } = fixture(t);
  memory.write(
    'working-memory.md',
    'Ordinary introduction. '.repeat(150) + 'Python renderer uses Cairo for vector output.',
  );
  const note = memory
    .retrieve('How does the Python renderer use Cairo?', { conversationId: 'conv' })
    .find((entry) => entry.kind === 'note');
  assert.ok(note);
  assert.match(note.text, /Python renderer uses Cairo/);
  assert.ok(note.text.startsWith('…'));
  for (let index = 0; index < 10; index++)
    confirmed(memory, `Python renderer fact ${index}: ` + 'bounded reference text '.repeat(100));
  const references = memory.retrieve('Python renderer', { conversationId: 'conv' });
  assert.ok(references.length <= MEMORY_RETRIEVAL_RESULT_LIMIT);
  assert.ok(
    references.reduce((total, entry) => total + entry.text.length, 0) <=
      MEMORY_RETRIEVAL_TEXT_BUDGET,
  );
  assert.ok(references.every((entry) => entry.text.length <= 512));
});

test('another database connection invalidates recall after entry and project changes without serving deleted references', (t) => {
  const { memory, dir } = fixture(t);
  const entry = confirmed(memory, 'Bamboo renderer global preference');
  const other = new MemoryStore(dir);
  t.after(() => other.close());
  assert.equal(memory.retrieve('Bamboo', { conversationId: 'conv' })[0]?.id, entry.id);
  other.deleteEntry(entry.id);
  assert.deepEqual(memory.retrieve('Bamboo', { conversationId: 'conv' }), []);
  project(memory, 'conv', 'work', 'Bamboo project baseline');
  assert.equal(
    memory.retrieve('Bamboo', { conversationId: 'conv', workId: 'work' })[0]?.id,
    'work',
  );
  const external = new DatabaseSync(memory.databaseFile);
  try {
    external
      .prepare('DELETE FROM projects WHERE conversation_id = ? AND work_id = ?')
      .run('conv', 'work');
  } finally {
    external.close();
  }
  assert.deepEqual(memory.retrieve('Bamboo', { conversationId: 'conv', workId: 'work' }), []);
});

test('historical indexed secrets and stale index-only matches cannot enter retrieved text or provenance', (t) => {
  const { memory } = fixture(t);
  const external = new DatabaseSync(memory.databaseFile);
  try {
    external
      .prepare('UPDATE notes SET text = ? WHERE name = ?')
      .run('Python renderer\npassword: fixture_legacy_secret', 'working-memory.md');
  } finally {
    external.close();
  }
  assert.ok(memory.retrieve('Python', { conversationId: 'conv' }).length);
  const stale = new DatabaseSync(memory.databaseFile);
  try {
    stale
      .prepare(
        "UPDATE memory_search SET text = ? WHERE document_key = 'working-memory.md' AND kind = 'note'",
      )
      .run(
        'Python renderer\npassword: fixture_index_secret\nindexonlykeyword fixture_index_secret',
      );
  } finally {
    stale.close();
  }
  assert.deepEqual(memory.retrieve('indexonlykeyword', { conversationId: 'conv' }), []);
  const results = memory.retrieve('password: fixture_query_secret Python renderer', {
    conversationId: 'conv',
  });
  assert.doesNotMatch(
    JSON.stringify(results),
    /fixture_legacy_secret|fixture_index_secret|fixture_query_secret/,
  );
  assert.doesNotMatch(
    JSON.stringify(memory.search('Python')),
    /fixture_legacy_secret|fixture_index_secret/,
  );
});

test('agent-facing base context preserves durable notes without blindly adding unrelated confirmed entries', (t) => {
  const { memory, dir } = fixture(t);
  memory.write('identity.md', 'Use concise English.');
  memory.write('working-memory.md', 'Durable user reference.');
  confirmed(memory, 'Unrelated private project preference', {
    kind: 'task',
    conversationId: 'other-conv',
    workId: 'other-work',
  });
  assert.match(memory.context(), /Unrelated private project preference/);
  const base = memory.context({ includeEntries: false });
  assert.match(base, /Use concise English/);
  assert.match(base, /Durable user reference/);
  assert.doesNotMatch(base, /Unrelated private project preference/);
  assert.equal(memory.context({ includeEntries: false }), base);
  const other = new MemoryStore(dir);
  t.after(() => other.close());
  other.write('working-memory.md', 'New durable reference.');
  assert.match(memory.context({ includeEntries: false }), /New durable reference/);
  assert.match(memory.context(), /Unrelated private project preference/);
});
