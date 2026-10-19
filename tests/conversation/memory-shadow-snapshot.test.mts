import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../../src/conversation/memory.mts';
import {
  prepareMemorySearch,
  prepareMemoryRetrieval,
} from '../../src/conversation/memory-search.mts';

function fixture(t: TestContext) {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'shadow-'));
  const snapshots = path.join(root, 'snapshots');
  fs.mkdirSync(snapshots);
  const memory = new MemoryStore(path.join(root, 'data'));
  t.after(() => {
    memory.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { memory, root, snapshots };
}

test('shadow snapshots synchronize stale FTS and export only redacted authoritative documents', (t) => {
  const { memory, snapshots } = fixture(t);
  const raw = new DatabaseSync(memory.databaseFile);
  try {
    raw
      .prepare('UPDATE notes SET text=? WHERE name=?')
      .run('Renderer preference; api_key="never-export-this-fixture-secret"', 'identity.md');
  } finally {
    raw.close();
  }
  const confirmed = memory.proposeEntry({
    kind: 'semantic',
    text: 'Renderer prefers TypeScript',
    source: { kind: 'user' },
    confidence: 0,
  });
  memory.confirmEntry(confirmed.id);
  const candidate = memory.proposeEntry({
    kind: 'semantic',
    text: 'Renderer unconfirmed inference',
    source: { kind: 'inference' },
  });
  const exported = memory.shadowSnapshot(snapshots);
  const db = new DatabaseSync(exported.file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
    const meta = db.prepare('SELECT revision,search_revision FROM memory_meta').get();
    assert.equal(meta?.revision, exported.revision);
    assert.equal(meta?.search_revision, exported.revision);
    const rows = db.prepare('SELECT * FROM memory_read_documents').all();
    assert.equal(rows.length, exported.documents);
    assert(!rows.some((row) => row.document_key === candidate.id));
    assert(
      rows.some(
        (row) =>
          row.document_key === confirmed.id && row.confidence === 0 && row.status === 'confirmed',
      ),
    );
    const json =
      JSON.stringify(rows) + JSON.stringify(db.prepare('SELECT * FROM memory_search').all());
    assert(!json.includes('never-export-this-fixture-secret'));
    assert(json.includes('[sensitive value omitted]'));
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='notes'").get(), undefined);
    assert.throws(() => db.exec('DELETE FROM memory_read_documents'), /readonly|read-only/);
    for (const row of rows)
      assert.equal(row.normalized_text, String(row.text).normalize('NFKC').toLowerCase());
  } finally {
    db.close();
  }
  const later = memory.shadowSnapshot(snapshots);
  assert.equal(later.revision, exported.revision);
  assert.notEqual(later.file, exported.file);
});

test('a snapshot remains at its captured revision when the live owner changes memory', (t) => {
  const { memory, snapshots } = fixture(t);
  memory.write('identity.md', 'Renderer version one');
  const first = memory.shadowSnapshot(snapshots);
  memory.write('identity.md', 'Renderer version two');
  const second = memory.shadowSnapshot(snapshots);
  assert(second.revision > first.revision);
  const db = new DatabaseSync(first.file, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT text FROM memory_read_documents WHERE document_key='identity.md'").get()
        ?.text,
      'Renderer version one',
    );
  } finally {
    db.close();
  }
});

test('shadow export refuses redirected directories and removes only its own failed output', (t) => {
  const { memory, root, snapshots } = fixture(t);
  const redirected = path.join(root, 'redirected');
  fs.symlinkSync(snapshots, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => memory.shadowSnapshot(redirected), /directory/);
  assert.deepEqual(fs.readdirSync(snapshots), []);
  memory.write('identity.md', 'Renderer fixture');
  memory.shadowSnapshot(snapshots);
  const source = new DatabaseSync(memory.databaseFile);
  try {
    source.exec("UPDATE memory_search SET kind='unsupported' WHERE document_key='identity.md'");
  } finally {
    source.close();
  }
  const existing = fs.readdirSync(snapshots);
  assert.throws(() => memory.shadowSnapshot(snapshots), /kind/);
  assert.deepEqual(fs.readdirSync(snapshots), existing);
});

test('shadow query preparation shares literal FTS, CJK and secret semantics', () => {
  assert.deepEqual(prepareMemorySearch('ＡＢＣ "OR" 编程语言'), [
    'abc',
    'or',
    '编程',
    '程语',
    '语言',
  ]);
  assert.deepEqual(prepareMemoryRetrieval('please remember TypeScript 我们如何编程'), [
    'typescript',
    '们如',
    '何编',
    '编程',
  ]);
  assert.deepEqual(prepareMemoryRetrieval('api_key="fixture-secret"'), ['api_key']);
  assert.throws(() => prepareMemorySearch('a\0b'));
  assert.throws(() => prepareMemorySearch('a'.repeat(257)));
  assert.throws(() => prepareMemoryRetrieval(null));
});
