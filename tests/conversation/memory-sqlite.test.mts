import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, MEMORY_MAX_BYTES } from '../../src/conversation/memory.mts';
import { MemoryEntryStatus } from '../../src/contracts/states.mts';
import { defined } from '../support/fixture-assertions.mts';

function fixture(t: TestContext) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'memory-sqlite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, memory: new MemoryStore(dir) };
}
function database<Result>(memory: MemoryStore, operation: (db: DatabaseSync) => Result) {
  const db = new DatabaseSync(memory.databaseFile);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}
const project = (text = 'Verified keyboard controls', at = 1234) => ({
  version: 1,
  referenceDataOnly: true,
  updatedAt: at,
  originalRequest: { messageId: 'human-real', at: 1000, text, attachments: [] },
  humanUpdates: [],
  results: [],
});
const proposal = (text = 'Prefers concise answers', key?: string) => ({
  kind: 'semantic',
  text,
  source: { kind: 'inference' },
  ...(key === undefined ? {} : { key }),
});

test('SQLite is the sole durable authority and Markdown changes require explicit import', (t) => {
  const { dir, memory } = fixture(t),
    initial = fs.readFileSync(memory.file('identity.md'), 'utf8');
  memory.write('identity.md', 'Use Chinese.');
  assert.equal(fs.readFileSync(memory.file('identity.md'), 'utf8'), initial);
  assert.equal(new MemoryStore(dir).read('identity.md'), 'Use Chinese.');
  fs.writeFileSync(memory.file('identity.md'), 'Independent Markdown edit');
  assert.equal(memory.read('identity.md'), 'Use Chinese.');
  memory.importMarkdown('identity.md');
  assert.equal(memory.read('identity.md'), 'Independent Markdown edit');
  memory.write('identity.md', 'Confirmed database note');
  memory.exportMarkdown('identity.md');
  assert.equal(fs.readFileSync(memory.file('identity.md'), 'utf8'), 'Confirmed database note');
  assert.equal(
    fs.readFileSync(memory.databaseFile).subarray(0, 16).toString(),
    'SQLite format 3\0',
  );
});

test('existing Markdown is backed up before transactional migration and never reimports over newer SQLite', (t) => {
  const { dir, memory: initialized } = fixture(t);
  initialized.close();
  fs.unlinkSync(initialized.databaseFile);
  fs.writeFileSync(initialized.file('identity.md'), 'Legacy identity');
  fs.writeFileSync(initialized.file('working-memory.md'), 'Legacy working notes');
  const memory = new MemoryStore(dir),
    backup = defined(
      fs.readdirSync(memory.dir).find((name) => name.startsWith('markdown-backup-')),
    );
  assert.equal(
    fs.readFileSync(path.join(memory.dir, backup, 'identity.md'), 'utf8'),
    'Legacy identity',
  );
  assert.equal(memory.read('working-memory.md'), 'Legacy working notes');
  memory.write('working-memory.md', 'New SQLite notes');
  assert.equal(new MemoryStore(dir).read('working-memory.md'), 'New SQLite notes');
});

test('a failed Markdown backup leaves originals intact and initialization can be retried', (t) => {
  const { dir, memory } = fixture(t);
  fs.unlinkSync(memory.databaseFile);
  fs.writeFileSync(memory.file('identity.md'), 'Do not lose this legacy preference');
  const open = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes('markdown-backup-')) throw Error('Injected backup failure');
    return open(...args);
  });
  assert.throws(() => new MemoryStore(dir), /Injected backup failure/);
  assert.equal(
    fs.readFileSync(memory.file('identity.md'), 'utf8'),
    'Do not lose this legacy preference',
  );
  mock.mock.restore();
  assert.equal(new MemoryStore(dir).read('identity.md'), 'Do not lose this legacy preference');
});

test('hot context reads reuse loaded text and sanitized context while checking SQLite revision', (t) => {
  const { memory } = fixture(t);
  memory.context();
  const before = memory.cacheStats();
  for (let index = 0; index < 20; index++) memory.context();
  const after = memory.cacheStats();
  assert.equal(after.loads, before.loads);
  assert.equal(after.contextBuilds, before.contextBuilds);
  assert.equal(after.contextHits - before.contextHits, 20);
  assert.equal(after.hits - before.hits, 20);
});

test('writes from another MemoryStore invalidate note and whole-context caches immediately', (t) => {
  const { dir, memory } = fixture(t),
    other = new MemoryStore(dir);
  memory.write('working-memory.md', 'Before shared write');
  memory.context();
  other.write('working-memory.md', 'After shared write');
  assert.match(memory.context(), /After shared write/);
  assert.doesNotMatch(memory.context(), /Before shared write/);
});

test('external SQLite updates invalidate caches and lazily refresh the FTS index', (t) => {
  const { memory } = fixture(t);
  memory.write('working-memory.md', 'Old keyword');
  assert.equal(memory.search('keyword').length, 1);
  memory.context();
  database(memory, (db) =>
    db
      .prepare('UPDATE notes SET text = ? WHERE name = ?')
      .run('External bamboo preference', 'working-memory.md'),
  );
  assert.match(memory.context(), /External bamboo/);
  assert.equal(memory.search('keyword').length, 0);
  assert.equal(memory.search('bamboo').length, 1);
});

test('failed SQLite writes preserve authoritative content and the next read never serves a false success', (t) => {
  const { memory } = fixture(t);
  memory.write('identity.md', 'Original');
  memory.context();
  database(memory, (db) =>
    db.exec(
      "CREATE TRIGGER reject_identity BEFORE UPDATE ON notes BEGIN SELECT RAISE(ABORT, 'Injected write failure'); END",
    ),
  );
  assert.throws(() => memory.write('identity.md', 'Uncommitted'), /Injected write failure/);
  assert.equal(memory.read('identity.md'), 'Original');
  assert.doesNotMatch(memory.context(), /Uncommitted/);
});

test('a busy writer fails without changing prior data and succeeds only after explicit later submission', (t) => {
  const { memory } = fixture(t);
  memory.write('working-memory.md', 'Before lock');
  database(memory, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => memory.write('working-memory.md', 'Not committed'), /locked/);
    } finally {
      db.exec('ROLLBACK');
    }
  });
  assert.equal(memory.read('working-memory.md'), 'Before lock');
  memory.write('working-memory.md', 'Explicit later save');
  assert.equal(memory.read('working-memory.md'), 'Explicit later save');
});

test('tampered revision triggers are rejected even on a warm cache', (t) => {
  const { memory } = fixture(t);
  memory.context();
  database(memory, (db) => db.exec('DROP TRIGGER memory_notes_update'));
  assert.throws(() => memory.context(), /revision tracking changed/);
});

test('a database path replacement is rejected rather than serving the previous cache', (t) => {
  const { memory } = fixture(t);
  memory.context();
  fs.renameSync(memory.databaseFile, memory.databaseFile + '.original');
  fs.writeFileSync(memory.databaseFile, 'Replacement');
  assert.throws(() => memory.context(), /identity changed/);
});

test('SQLite connections are released after every public operation on Windows', (t) => {
  const { dir, memory } = fixture(t);
  memory.write('working-memory.md', 'No open handle');
  memory.context();
  memory.search('handle');
  memory.close();
  memory.close();
  assert.doesNotThrow(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('project migration preserves exact identities and timestamps, backs up JSON, and does not overwrite SQLite', (t) => {
  const { dir, memory } = fixture(t),
    original = project();
  memory.migrateProjects('conversation-real', [{ id: 'work-real', projectContext: original }]);
  assert.deepEqual(memory.readProject('conversation-real', 'work-real'), original);
  const backup = defined(
    fs.readdirSync(memory.dir).find((name) => name.startsWith('projects-backup-')),
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(memory.dir, backup, 'memory.json'), 'utf8')),
    {
      conversationId: 'conversation-real',
      records: [{ id: 'work-real', projectContext: original }],
    },
  );
  memory.writeProject('conversation-real', 'work-real', project('New result', 2000));
  new MemoryStore(dir).migrateProjects('conversation-real', [
    { id: 'work-real', projectContext: original },
  ]);
  assert.equal(memory.readProject('conversation-real', 'work-real')?.updatedAt, 2000);
  assert.equal(memory.readProject('another-conversation', 'work-real'), null);
});

test('project migration rolls back as a whole and never invents missing source identities or times', (t) => {
  const { memory } = fixture(t);
  assert.throws(
    () =>
      memory.migrateProjects('conversation-real', [
        { id: 'first', projectContext: project() },
        { id: 'second', projectContext: { version: 1 } },
      ]),
    /Invalid project memory/,
  );
  assert.equal(memory.readProject('conversation-real', 'first'), null);
  assert.throws(
    () => memory.writeProject('conversation-real', 'work-real', { version: 1 }),
    /Invalid project memory/,
  );
  const saved = memory.writeProject('conversation-real', 'work-real', {
    ...project(),
    originalRequest: { text: 'No fabricated provenance' },
  });
  assert.equal(saved.originalRequest, null);
  assert.equal(saved.updatedAt, 1234);
  assert.throws(() => memory.readProject('', 'work-real'), /identity/);
});

test('external project updates refresh cache and project search retains real provenance', (t) => {
  const { memory } = fixture(t);
  memory.writeProject('conversation-real', 'work-real', project());
  memory.readProject('conversation-real', 'work-real');
  database(memory, (db) =>
    db
      .prepare('UPDATE projects SET context_json = ? WHERE conversation_id = ? AND work_id = ?')
      .run(
        JSON.stringify(project('Bamboo regression verified', 2000)),
        'conversation-real',
        'work-real',
      ),
  );
  assert.equal(memory.readProject('conversation-real', 'work-real')?.updatedAt, 2000);
  const result = defined(memory.search('bamboo regression')[0]);
  assert.equal(result.kind, 'project');
  assert.equal(result.conversationId, 'conversation-real');
  assert.equal(result.workId, 'work-real');
  assert.equal(result.updatedAt, 2000);
});

test('project memory redacts obvious credentials before persistence or indexing', (t) => {
  const { memory } = fixture(t),
    token = 'sk-this_is_a_long_synthetic_api_key';
  memory.writeProject('conversation-real', 'work-real', project('Use ' + token));
  assert.doesNotMatch(
    JSON.stringify(memory.readProject('conversation-real', 'work-real')),
    new RegExp(token),
  );
  assert.equal(memory.search('synthetic_api_key').length, 0);
});

test('inferred candidates stay outside effective context and FTS until explicitly confirmed', (t) => {
  const { dir, memory } = fixture(t),
    entry = memory.proposeEntry(proposal('Prefers bamboo responses'));
  assert.equal(entry.status, MemoryEntryStatus.Candidate);
  assert.equal(entry.confidence, null);
  assert.deepEqual(entry.source, { kind: 'inference' });
  assert.equal(memory.context().includes('bamboo'), false);
  assert.deepEqual(memory.search('bamboo'), []);
  assert.deepEqual(memory.listEntries({ status: MemoryEntryStatus.Candidate }), [entry]);
  const confirmed = memory.confirmEntry(entry.id);
  assert.equal(confirmed.status, MemoryEntryStatus.Confirmed);
  assert.match(memory.context(), /Prefers bamboo responses/);
  assert.equal(memory.search('bamboo')[0]?.id, entry.id);
  assert.equal(new MemoryStore(dir).listEntries()[0]?.id, entry.id);
});

test('proposal deduplication normalizes whitespace and Unicode without changing an existing confirmed fact', (t) => {
  const { memory } = fixture(t),
    entry = memory.proposeEntry(proposal('Prefers  Ｅｎｇｌｉｓｈ answers', ' language '));
  memory.confirmEntry(entry.id);
  const duplicate = memory.proposeEntry(proposal('prefers english   answers', 'LANGUAGE'));
  assert.equal(duplicate.id, entry.id);
  assert.equal(duplicate.status, MemoryEntryStatus.Confirmed);
  assert.equal(memory.listEntries().length, 1);
});

test('contradictory proposals require explicit conflict resolution and do not silently replace confirmed memory', (t) => {
  const { memory } = fixture(t),
    old = memory.proposeEntry(proposal('Prefer English', 'language'));
  memory.confirmEntry(old.id);
  const next = memory.proposeEntry(proposal('Prefer Chinese', 'language'));
  assert.equal(next.status, MemoryEntryStatus.Conflicted);
  assert.deepEqual(next.conflictsWith, [old.id]);
  assert.throws(() => memory.confirmEntry(next.id), /conflicting/);
  assert.throws(() => memory.confirmEntry(next.id, { resolveConflicts: 'true' }), /conflicting/);
  assert.match(memory.context(), /Prefer English/);
  assert.doesNotMatch(memory.context(), /Prefer Chinese/);
  memory.confirmEntry(next.id, { resolveConflicts: true });
  assert.equal(
    memory.listEntries().find((item) => item.id === old.id)?.status,
    MemoryEntryStatus.Rejected,
  );
  assert.match(memory.context(), /Prefer Chinese/);
  assert.equal(memory.search('English').length, 0);
});

test('editing confirmed memory returns it to candidate review and deletion removes current context and search', (t) => {
  const { memory } = fixture(t),
    entry = memory.proposeEntry(proposal('Bamboo preference'));
  memory.confirmEntry(entry.id);
  const changed = memory.updateEntry(entry.id, { text: 'Cedar preference' });
  assert.equal(changed.status, MemoryEntryStatus.Candidate);
  assert.equal(memory.search('bamboo').length, 0);
  assert.equal(memory.search('cedar').length, 0);
  memory.confirmEntry(entry.id);
  assert.equal(memory.search('cedar').length, 1);
  assert.equal(memory.deleteEntry(entry.id), true);
  assert.equal(memory.deleteEntry(entry.id), false);
  assert.equal(memory.search('cedar').length, 0);
  assert.doesNotMatch(memory.context(), /Cedar preference/);
});

test('secret-like candidates are rejected before SQLite persistence and errors never echo their values', (t) => {
  const { memory } = fixture(t);
  for (const text of [
    'sk-this_is_a_long_synthetic_api_key',
    'Bearer synthetic_long_test_token',
    'password=synthetic-private',
    '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----',
  ]) {
    assert.throws(
      () => memory.proposeEntry(proposal(text)),
      (error: unknown) =>
        error instanceof Error && !error.message.includes(text) && /Sensitive/.test(error.message),
    );
  }
  assert.equal(memory.listEntries().length, 0);
});

test('entry input validation preserves missing provenance and rejects invalid bounds', (t) => {
  const { memory } = fixture(t);
  for (const value of [
    null,
    {},
    { ...proposal(), confidence: 2 },
    { ...proposal(), confidence: NaN },
    { ...proposal(), source: { kind: 'inference', at: 0 } },
    { ...proposal(), source: { kind: 'inference', workId: '' } },
    { ...proposal(), text: 'x'.repeat(MEMORY_MAX_BYTES) },
  ])
    assert.throws(() => memory.proposeEntry(value));
  const entry = memory.proposeEntry({
    ...proposal(),
    source: {
      kind: 'task',
      conversationId: 'conversation-real',
      workId: 'work-real',
      messageId: 'message-real',
      at: 1000,
    },
    confidence: 0.9,
  });
  assert.equal(entry.source.at, 1000);
  assert.equal(entry.confidence, 0.9);
  assert.throws(() => memory.updateEntry(entry.id, { status: 'confirmed' }), /Invalid/);
  assert.throws(() => memory.updateEntry(entry.id, {}), /Invalid/);
  assert.throws(() => memory.confirmEntry('missing'), /not found/);
});

test('FTS query literals are bounded, safely parameterized, Unicode aware, and redact note excerpts', (t) => {
  const { memory } = fixture(t);
  memory.write(
    'identity.md',
    'Preference: 中文回复. Bamboo syntax. Bearer synthetic_long_test_token',
  );
  assert.equal(memory.search('中文').length, 1);
  assert.equal(memory.search('bamboo syntax', { limit: 1 }).length, 1);
  assert.equal(memory.search('" OR 1=1 --').length, 0);
  assert.deepEqual(memory.search('  '), []);
  assert.throws(() => memory.search('x'.repeat(257)), /bounded/);
  assert.throws(() => memory.search(null), /bounded/);
  assert.throws(() => memory.search('bamboo', { limit: 51 }), /limit/);
  const result = defined(memory.search('preference')[0]);
  assert.doesNotMatch(result.text, /synthetic_long_test_token/);
  assert.equal(Object.hasOwn(result, 'updatedAt'), false);
});
test('a changed SQLite schema is rejected before a warm context cache can be reused', (t) => {
  const { memory } = fixture(t);
  memory.context();
  database(memory, (db) => db.exec('ALTER TABLE notes ADD COLUMN unexpected TEXT'));
  assert.throws(() => memory.context(), /schema changed/);
});

test('confirmed context stays bounded while older confirmed entries remain searchable', (t) => {
  const { memory } = fixture(t);
  for (let index = 0; index < 33; index++) {
    const entry = memory.proposeEntry(proposal('Confirmed fact ' + index));
    memory.confirmEntry(entry.id);
  }
  const context = memory.context();
  assert.equal((context.match(/\[semantic\]/g) ?? []).length, 32);
  assert.equal(memory.search('Confirmed fact').length, 10);
  assert.equal(memory.listEntries({ status: MemoryEntryStatus.Confirmed }).length, 33);
});
