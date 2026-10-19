import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../../src/conversation/memory.mts';
import { Store } from '../../src/conversation/store.mts';
import { sanitizeMemoryText, containsMemorySecret } from '../../src/conversation/memory-safety.mts';

const fixtureSecrets = [
  'fixture_password_01',
  'fixture_api_02',
  'fixture_access_03',
  'fixture_secret_04',
];
const notes = `Project alpha uses Markdown.
password: fixture_password_01
"api_key": "fixture_api_02 with spaces"
access-token = 'fixture_access_03
second credential line'
secret: |
  fixture_secret_04
  indented credential continuation
preference: Keep concise replies.
`;
const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });

function directory(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(base, 'memory-sensitive-'));
  t.after(() => {
    const relative = path.relative(base, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function safeText(value: string): void {
  for (const secret of fixtureSecrets)
    assert.ok(!value.includes(secret), 'A sensitive value was exposed.');
  assert.doesNotMatch(value, /second credential line|indented credential continuation/);
  assert.match(value, /Project alpha uses Markdown/);
  assert.match(value, /preference: Keep concise replies/);
}
function effectiveMemory(memory: MemoryStore): void {
  safeText(memory.context());
  const matches = memory.search('Project alpha');
  assert.ok(matches.length);
  for (const match of matches) safeText(match.text);
  for (const secret of fixtureSecrets) assert.deepEqual(memory.search(secret), []);
}

test('sensitive assignments redact complete quoted and indented values while ordinary notes and line endings stay intact', () => {
  const ordinary =
    'User prefers Markdown.\r\nPassword policy discussions are ordinary reference notes.\r\n';
  assert.equal(sanitizeMemoryText(ordinary), ordinary);
  const sanitized = sanitizeMemoryText(notes);
  safeText(sanitized);
  assert.equal(
    sanitizeMemoryText(sanitized),
    sanitized,
    'Repeated context construction must be stable.',
  );
  for (const text of [
    'PASSWORD=fixture_password_01',
    'api key: "fixture_api_02 \\"quoted\\" tail"',
    'access_token = """fixture_access_03\ncontinued quoted value"""\nnext: retained',
    'secret: >-\n  fixture_secret_04\n  second line\nnext: retained',
    '  password:\n    fixture_password_01\n    indented continuation\n  next: retained',
    "'password': 'fixture_password_01'",
    '{"password":\n "fixture_password_01", "next": "retained"}',
    'access_token: `fixture_access_03\ncontinued backtick value`\nnext: retained',
    'secret="fixture_secret_04 without a closing quote',
    'secret: |\r\n  fixture_secret_04\r\nnext: retained',
  ]) {
    assert.equal(containsMemorySecret(text), true);
    const result = sanitizeMemoryText(text);
    for (const secret of fixtureSecrets) assert.ok(!result.includes(secret));
    if (text.includes('next: retained')) assert.match(result, /next: retained/);
    assert.equal(sanitizeMemoryText(result), result);
  }
});

test('new note writes and explicit Markdown imports sanitize durable notes and effective context', (t) => {
  const memory = new MemoryStore(directory(t));
  t.after(() => memory.close());
  memory.write('working-memory.md', notes);
  safeText(memory.read('working-memory.md'));
  effectiveMemory(memory);
  memory.write('working-memory.md', 'A previous ordinary note.');
  fs.writeFileSync(memory.file('working-memory.md'), notes, 'utf8');
  memory.importMarkdown('working-memory.md');
  safeText(memory.read('working-memory.md'));
  effectiveMemory(memory);
  assert.throws(
    () =>
      memory.proposeEntry({
        kind: 'semantic',
        text: 'password: fixture_password_01',
        source: { kind: 'user' },
      }),
    /Sensitive/,
  );
});

test('initial Markdown and legacy state migration keep ordinary context without persisting obvious note secrets', (t) => {
  const markdownRoot = directory(t);
  fs.mkdirSync(path.join(markdownRoot, 'memory/dant'), { recursive: true });
  fs.writeFileSync(path.join(markdownRoot, 'memory/dant/working-memory.md'), notes, 'utf8');
  const imported = new MemoryStore(markdownRoot);
  t.after(() => imported.close());
  safeText(imported.read('working-memory.md'));
  effectiveMemory(imported);
  const legacyRoot = directory(t);
  const store = new Store(legacyRoot);
  store.state.memory = notes;
  const migrated = new MemoryStore(legacyRoot);
  t.after(() => migrated.close());
  migrated.migrateLegacy(store);
  safeText(migrated.read('working-memory.md'));
  safeText(store.state.memory);
  effectiveMemory(migrated);
});

test('historical notes inserted by another SQLite connection invalidate caches and remain redacted in context and search', (t) => {
  const memory = new MemoryStore(directory(t));
  t.after(() => memory.close());
  memory.write('working-memory.md', 'Project alpha ordinary cached note.');
  memory.context();
  memory.search('Project alpha');
  const external = new DatabaseSync(memory.databaseFile);
  try {
    external.prepare('UPDATE notes SET text = ? WHERE name = ?').run(notes, 'working-memory.md');
  } finally {
    external.close();
  }
  effectiveMemory(memory);
  memory.context();
  effectiveMemory(memory);
  safeText(memory.read('working-memory.md'));
  const note = memory.snapshot().find((entry) => entry.name === 'working-memory.md');
  assert.ok(note);
  safeText(note.text);
  memory.exportMarkdown('working-memory.md');
  safeText(fs.readFileSync(memory.file('working-memory.md'), 'utf8'));
});
