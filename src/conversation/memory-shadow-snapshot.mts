import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryEntryStatus } from '../contracts/states.mts';
import { synchronizeSearchIndex } from './memory-search.mts';
import { entryById } from './memory-entries.mts';
import { safeProjectContext } from '../work/task-project-context.mts';
import { sanitizeMemoryText } from './memory-safety.mts';
import { MEMORY_FILES } from './memory-constants.mts';
import coreProtocol from '../contracts/core-protocol.json' with { type: 'json' };
import type { MemorySource } from './memory-types.ts';

export const MEMORY_SHADOW_SCHEMA_VERSION = 1;
export const MEMORY_SHADOW_MAX_ROWS = 50_000;
export const MEMORY_SHADOW_MAX_BYTES = 64 * 1024 * 1024;

export interface MemoryShadowSnapshot {
  file: string;
  revision: number;
  documents: number;
}

/** Shadow snapshots contain only validated, redacted references, never a copy of the live DB. */
export function writeMemoryShadowSnapshot(
  db: DatabaseSync,
  directory: string,
): MemoryShadowSnapshot {
  const parent = path.resolve(directory);
  const parentIdentity = fs.lstatSync(parent);
  const guard = () => {
    const current = fs.lstatSync(parent);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== parentIdentity.dev ||
      current.ino !== parentIdentity.ino
    )
      throw Error('Memory shadow directory changed');
    // Reject redirected ancestors as well as the selected directory.
    let ancestor = parent;
    for (;;) {
      const stat = fs.lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('Memory shadow directory must be ordinary');
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
  };
  guard();
  synchronizeSearchIndex(db);
  const meta = db.prepare('SELECT revision, search_revision FROM memory_meta WHERE id = 1').get();
  if (
    !meta ||
    typeof meta.revision !== 'number' ||
    !Number.isSafeInteger(meta.revision) ||
    meta.revision < 0 ||
    meta.revision !== meta.search_revision
  )
    throw Error('Invalid memory shadow revision');
  const file = path.join(parent, 'shadow-' + randomUUID() + '.sqlite');
  const fd = fs.openSync(file, 'wx', 0o600);
  const identity = fs.fstatSync(fd);
  fs.closeSync(fd);
  const guardFile = () => {
    guard();
    const current = fs.lstatSync(file);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw Error('Memory shadow file changed');
  };
  let target: DatabaseSync | undefined;
  let completed = false;
  try {
    guardFile();
    target = new DatabaseSync(file, { enableDoubleQuotedStringLiterals: false });
    target.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;
      PRAGMA user_version=${MEMORY_SHADOW_SCHEMA_VERSION};
      CREATE TABLE memory_meta(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, search_revision INTEGER NOT NULL);
      CREATE VIRTUAL TABLE memory_search USING fts5(document_key UNINDEXED, kind UNINDEXED, text, updated_at UNINDEXED, conversation_id UNINDEXED, work_id UNINDEXED);
      CREATE TABLE memory_read_documents(search_rowid INTEGER PRIMARY KEY, document_key TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, normalized_text TEXT NOT NULL, updated_at INTEGER, conversation_id TEXT, work_id TEXT, status TEXT, source_json TEXT, confidence REAL);
      BEGIN IMMEDIATE;`);
    target.prepare('INSERT INTO memory_meta VALUES(1,?,?)').run(meta.revision, meta.revision);
    const insertSearch = target.prepare(
      'INSERT INTO memory_search(rowid,document_key,kind,text,updated_at,conversation_id,work_id) VALUES(?,?,?,?,?,?,?)',
    );
    const insertDocument = target.prepare(
      'INSERT INTO memory_read_documents(search_rowid,document_key,kind,text,normalized_text,updated_at,conversation_id,work_id,status,source_json,confidence) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    );
    let documents = 0;
    let bytes = 0;
    for (const row of db
      .prepare(
        'SELECT rowid,document_key,kind,text,updated_at,conversation_id,work_id FROM memory_search ORDER BY rowid',
      )
      .iterate()) {
      if (
        ++documents > MEMORY_SHADOW_MAX_ROWS ||
        typeof row.rowid !== 'number' ||
        !Number.isSafeInteger(row.rowid) ||
        typeof row.document_key !== 'string' ||
        typeof row.text !== 'string' ||
        typeof row.kind !== 'string'
      )
        throw Error('Invalid memory shadow index');
      const updatedAt = row.updated_at;
      if (
        (updatedAt !== null &&
          (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt))) ||
        (row.conversation_id !== null && typeof row.conversation_id !== 'string') ||
        (row.work_id !== null && typeof row.work_id !== 'string')
      )
        throw Error('Invalid memory shadow metadata');
      let text: string;
      let source: MemorySource | null = null;
      let status: string | null = null;
      let confidence: number | null = null;
      if (row.kind === 'note') {
        if (
          !MEMORY_FILES.some((name) => name === row.document_key) ||
          row.conversation_id !== null ||
          row.work_id !== null ||
          updatedAt !== null
        )
          throw Error('Invalid shadow note');
        const note = db.prepare('SELECT text FROM notes WHERE name=?').get(row.document_key);
        if (!note || typeof note.text !== 'string') throw Error('Missing shadow note');
        text = sanitizeMemoryText(note.text);
      } else if (row.kind === 'project') {
        if (typeof row.conversation_id !== 'string' || row.work_id !== row.document_key)
          throw Error('Invalid shadow project');
        const value = db
          .prepare('SELECT context_json FROM projects WHERE conversation_id=? AND work_id=?')
          .get(row.conversation_id, row.work_id);
        if (!value || typeof value.context_json !== 'string') throw Error('Missing shadow project');
        const context = safeProjectContext(JSON.parse(value.context_json), {
          redact: sanitizeMemoryText,
        });
        if (!context || context.updatedAt !== updatedAt)
          throw Error('Invalid shadow project context');
        text = [context.originalRequest, ...context.humanUpdates, ...context.results]
          .flatMap((entry) => (entry ? [entry.text] : []))
          .join('\n');
      } else if (row.kind === 'semantic' || row.kind === 'episodic') {
        const entry = entryById(db, row.document_key);
        if (
          !entry ||
          entry.kind !== row.kind ||
          entry.status !== MemoryEntryStatus.Confirmed ||
          entry.updatedAt !== updatedAt ||
          (entry.source.conversationId ?? null) !== row.conversation_id ||
          (entry.source.workId ?? null) !== row.work_id
        )
          throw Error('Invalid shadow entry');
        text = sanitizeMemoryText(entry.text);
        source = entry.source;
        status = entry.status;
        confidence = entry.confidence;
      } else throw Error('Invalid memory shadow kind');
      const indexed = sanitizeMemoryText(row.text);
      const normalized = text.normalize('NFKC').toLowerCase();
      const sourceJson = source ? JSON.stringify(source) : null;
      bytes +=
        Buffer.byteLength(text) +
        Buffer.byteLength(normalized) +
        Buffer.byteLength(indexed) +
        Buffer.byteLength(sourceJson ?? '');
      if (bytes > MEMORY_SHADOW_MAX_BYTES) throw Error('Memory shadow snapshot is too large');
      insertSearch.run(
        row.rowid,
        row.document_key,
        row.kind,
        indexed,
        updatedAt,
        row.conversation_id,
        row.work_id,
      );
      insertDocument.run(
        row.rowid,
        row.document_key,
        row.kind,
        text,
        normalized,
        updatedAt,
        row.conversation_id,
        row.work_id,
        status,
        sourceJson,
        confidence,
      );
    }
    target.exec('COMMIT');
    target.close();
    target = undefined;
    guardFile();
    if (fs.statSync(file).size > coreProtocol.snapshotMaxBytes)
      throw Error('Memory shadow snapshot is too large');
    completed = true;
    return { file, revision: meta.revision, documents };
  } finally {
    target?.close();
    if (!completed) {
      // Remove only our exact exclusive file; never remove a replacement or another user's path.
      guardFile();
      fs.unlinkSync(file);
    }
  }
}
