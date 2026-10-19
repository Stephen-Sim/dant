import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { isRecord } from '../contracts/json.mts';
import { MemoryEntryStatus as EntryStatus } from '../contracts/states.mts';
import { searchMemory } from './memory-search.mts';
import {
  listMemoryEntries,
  proposeMemoryEntry,
  confirmMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry,
} from './memory-entries.mts';
import { sanitizeMemoryText } from './memory-safety.mts';
import { safeProjectContext } from '../work/task-project-context.mts';
import {
  MEMORY_DATABASE_FILE,
  MEMORY_FILES,
  MEMORY_CONTEXT_ENTRY_LIMIT,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_MAX_BYTES,
  MEMORY_PROJECT_CACHE_LIMIT,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SQLITE_BUSY_TIMEOUT_MS,
} from './memory-constants.mts';
import type { MemoryFileName } from './memory-constants.mts';
import type {
  MemoryNote,
  MemoryProjectInput,
  MemoryEntry,
  MemoryEntryStatus,
  MemorySnapshot,
} from './memory-types.ts';
import type { ProjectContext } from './types.ts';

const triggers = Object.freeze(
  ['notes', 'projects', 'memory_entries'].flatMap((table) =>
    ['INSERT', 'UPDATE', 'DELETE'].map((action) => {
      const name = `memory_${table}_${action.toLowerCase()}`;
      return {
        name,
        sql: `CREATE TRIGGER ${name} AFTER ${action} ON ${table} BEGIN UPDATE memory_meta SET revision = revision + 1 WHERE id = 1; END`,
      };
    }),
  ),
);
const validId = (value: string) =>
  value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);
const validText = (value: unknown): value is string =>
  typeof value === 'string' &&
  !value.includes('\0') &&
  Buffer.byteLength(value) <= MEMORY_MAX_BYTES;
const row = (statement: StatementSync): Record<string, unknown> => {
  const result = statement.get();
  if (!isRecord(result)) throw Error('Invalid memory database metadata');
  return result;
};

/** Short SQLite transactions release Windows handles; every cache lookup checks durable revision. */
export class MemoryDatabase {
  readonly file: string;
  private readonly identity: fs.Stats;
  private revision: number | null = null;
  private schemaVersion: number | null = null;
  private notes: MemoryNote[] | null = null;
  private entries: MemoryEntry[] | null = null;
  private readonly projects = new Map<string, ProjectContext | null>();
  private hits = 0;
  private loads = 0;
  private readonly guardDirectory: () => void;
  constructor(dir: string, guardDirectory: () => void) {
    this.guardDirectory = guardDirectory;
    this.file = path.join(dir, MEMORY_DATABASE_FILE);
    guardDirectory();
    try {
      const fd = fs.openSync(this.file, 'wx', 0o600);
      fs.closeSync(fd);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    }
    this.identity = this.validateFile();
    this.connection((db) => {
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
      const version = row(db.prepare('PRAGMA user_version')).user_version;
      if (version !== 0 && version !== MEMORY_SCHEMA_VERSION)
        throw Error('Unsupported memory database version');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), markdown_imported INTEGER NOT NULL CHECK(markdown_imported IN (0, 1)), search_revision INTEGER NOT NULL DEFAULT -1);
          INSERT OR IGNORE INTO memory_meta (id, revision, markdown_imported) VALUES (1, 0, 0);
          CREATE TABLE IF NOT EXISTS notes (name TEXT PRIMARY KEY CHECK(name IN ('README.md', 'identity.md', 'working-memory.md')), text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) <= ${MEMORY_MAX_BYTES}));
          CREATE TABLE IF NOT EXISTS projects (conversation_id TEXT NOT NULL, work_id TEXT NOT NULL, context_json TEXT NOT NULL CHECK(length(CAST(context_json AS BLOB)) <= ${MEMORY_MAX_BYTES}), PRIMARY KEY(conversation_id, work_id));
          CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('semantic', 'episodic')), text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) <= ${MEMORY_ENTRY_MAX_BYTES}), memory_key TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('candidate', 'confirmed', 'conflicted', 'rejected')), source_json TEXT NOT NULL, confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)), conflicts_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(document_key UNINDEXED, kind UNINDEXED, text, updated_at UNINDEXED, conversation_id UNINDEXED, work_id UNINDEXED);`);
        if (
          !db
            .prepare('PRAGMA table_info(memory_meta)')
            .all()
            .some((column) => column.name === 'search_revision')
        )
          db.exec('ALTER TABLE memory_meta ADD COLUMN search_revision INTEGER NOT NULL DEFAULT -1');
        for (const trigger of triggers)
          db.exec(trigger.sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS '));
        db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`);
        db.exec('UPDATE memory_meta SET search_revision = -1 WHERE id = 1');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      this.validateSchema(db);
      if (row(db.prepare('PRAGMA quick_check')).quick_check !== 'ok')
        throw Error('Memory database integrity check failed');
    }, false);
  }
  private validateFile() {
    this.guardDirectory();
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw Error('Memory database must be an ordinary, unlinked file');
    return stat;
  }
  private guardFile() {
    const current = this.validateFile();
    if (current.ino !== this.identity.ino || current.dev !== this.identity.dev)
      throw Error('Memory database identity changed');
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try {
        const stat = fs.lstatSync(this.file + suffix);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw Error('Memory database sidecars must be ordinary, unlinked files');
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      }
    }
  }
  private validateSchema(db: DatabaseSync) {
    const version = row(db.prepare('PRAGMA schema_version')).schema_version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version))
      throw Error('Invalid memory database schema');
    if (version === this.schemaVersion) return;
    if (row(db.prepare('PRAGMA user_version')).user_version !== MEMORY_SCHEMA_VERSION)
      throw Error('Unsupported memory database version');
    const columns = {
      memory_meta: ['id', 'revision', 'markdown_imported', 'search_revision'],
      notes: ['name', 'text'],
      projects: ['conversation_id', 'work_id', 'context_json'],
      memory_entries: [
        'id',
        'kind',
        'text',
        'memory_key',
        'dedupe',
        'status',
        'source_json',
        'confidence',
        'conflicts_json',
        'created_at',
        'updated_at',
      ],
    };
    for (const [table, expected] of Object.entries(columns)) {
      const actual = db
        .prepare('PRAGMA table_info(' + table + ')')
        .all()
        .map((column) => column.name);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw Error('Memory database schema changed');
    }
    for (const trigger of triggers) {
      const saved = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
        .get(trigger.name);
      if (saved?.sql !== trigger.sql) throw Error('Memory database revision tracking changed');
    }
    this.schemaVersion = version;
    this.invalidate();
  }
  private connection<Result>(operation: (db: DatabaseSync) => Result, verify = true): Result {
    this.guardFile();
    const db = new DatabaseSync(this.file, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    try {
      db.exec(
        `PRAGMA busy_timeout = ${MEMORY_SQLITE_BUSY_TIMEOUT_MS}; PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL;`,
      );
      if (verify) this.validateSchema(db);
      const result = operation(db);
      this.guardFile();
      return result;
    } finally {
      db.close();
    }
  }
  private transaction<Result>(
    write: boolean,
    operation: (db: DatabaseSync) => Result,
    invalidate = write,
  ): Result {
    return this.connection((db) => {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        this.validateSchema(db);
        const result = operation(db);
        db.exec('COMMIT');
        if (invalidate) this.invalidate();
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }, false);
  }
  private epoch(db: DatabaseSync) {
    const value = row(db.prepare('SELECT revision FROM memory_meta WHERE id = 1')).revision;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw Error('Invalid memory database revision');
    if (value !== this.revision) {
      this.invalidate();
      this.revision = value;
    }
    return `${this.schemaVersion}:${value}`;
  }
  invalidate() {
    this.revision = null;
    this.notes = null;
    this.entries = null;
    this.projects.clear();
  }
  cacheStats() {
    return { hits: this.hits, loads: this.loads };
  }
  initialized() {
    return this.transaction(
      false,
      (db) =>
        row(db.prepare('SELECT markdown_imported FROM memory_meta WHERE id = 1'))
          .markdown_imported === 1,
    );
  }
  initialize(notes: readonly MemoryNote[]) {
    this.transaction(true, (db) => {
      if (
        row(db.prepare('SELECT markdown_imported FROM memory_meta WHERE id = 1'))
          .markdown_imported === 1
      )
        return;
      const save = db.prepare('INSERT OR IGNORE INTO notes (name, text) VALUES (?, ?)');
      for (const note of notes) {
        if (!validText(note.text)) throw Error('Memory must be text no larger than 64 KiB');
        save.run(note.name, sanitizeMemoryText(note.text));
      }
      db.exec('UPDATE memory_meta SET markdown_imported = 1 WHERE id = 1');
    });
  }
  snapshot(): MemorySnapshot {
    return this.transaction(false, (db) => {
      const revision = this.epoch(db);
      if (this.notes && this.entries) {
        this.hits++;
        return {
          revision,
          notes: this.notes.map((note) => ({ ...note })),
          entries: structuredClone(this.entries),
        };
      }
      const stored = db.prepare('SELECT name, text FROM notes').all();
      const notes = MEMORY_FILES.map((name) => {
        const saved = stored.find((value) => value.name === name);
        if (!saved || !validText(saved.text)) throw Error('Invalid memory database note');
        return { name, text: saved.text };
      });
      this.loads++;
      this.notes = notes;
      this.entries = listMemoryEntries(db, EntryStatus.Confirmed).slice(
        0,
        MEMORY_CONTEXT_ENTRY_LIMIT,
      );
      return {
        revision,
        notes: notes.map((note) => ({ ...note })),
        entries: structuredClone(this.entries),
      };
    });
  }
  write(name: MemoryFileName, text: string) {
    this.transaction(true, (db) => {
      const saved = db.prepare('UPDATE notes SET text = ? WHERE name = ?').run(text, name);
      if (saved.changes !== 1) throw Error('Memory note is missing');
    });
  }
  private projectIds(conversationId: string, workId: string) {
    if (!validId(conversationId) || !validId(workId))
      throw Error('Invalid project memory identity');
    return JSON.stringify([conversationId, workId]);
  }
  private projectValue(value: unknown) {
    const context = safeProjectContext(value, { redact: sanitizeMemoryText });
    if (!context || Buffer.byteLength(JSON.stringify(context)) > MEMORY_MAX_BYTES)
      throw Error('Invalid project memory context');
    return context;
  }
  readProject(conversationId: string, workId: string) {
    const key = this.projectIds(conversationId, workId);
    return this.transaction(false, (db) => {
      this.epoch(db);
      if (this.projects.has(key)) {
        this.hits++;
        return structuredClone(this.projects.get(key) ?? null);
      }
      const saved = db
        .prepare('SELECT context_json FROM projects WHERE conversation_id = ? AND work_id = ?')
        .get(conversationId, workId);
      if (saved && typeof saved.context_json !== 'string')
        throw Error('Invalid stored project memory');
      const stored = saved?.context_json;
      const value = typeof stored === 'string' ? this.projectValue(JSON.parse(stored)) : null;
      this.loads++;
      if (this.projects.size >= MEMORY_PROJECT_CACHE_LIMIT) {
        const oldest = this.projects.keys().next().value;
        if (oldest !== undefined) this.projects.delete(oldest);
      }
      this.projects.set(key, value);
      return structuredClone(value);
    });
  }
  writeProject(conversationId: string, workId: string, value: unknown) {
    this.projectIds(conversationId, workId);
    const context = this.projectValue(value);
    this.transaction(true, (db) =>
      db
        .prepare(
          'INSERT INTO projects (conversation_id, work_id, context_json) VALUES (?, ?, ?) ON CONFLICT(conversation_id, work_id) DO UPDATE SET context_json = excluded.context_json',
        )
        .run(conversationId, workId, JSON.stringify(context)),
    );
    return structuredClone(context);
  }
  migrateProjects(
    conversationId: string,
    records: readonly MemoryProjectInput[],
    beforeImport: (pending: readonly MemoryProjectInput[]) => void,
  ) {
    this.transaction(true, (db) => {
      const save = db.prepare(
        'INSERT OR IGNORE INTO projects (conversation_id, work_id, context_json) VALUES (?, ?, ?)',
      );
      const pending = records.filter(
        (record) =>
          record.projectContext !== undefined &&
          !db
            .prepare('SELECT 1 FROM projects WHERE conversation_id = ? AND work_id = ?')
            .get(conversationId, record.id),
      );
      const validated = pending.map((record) => {
        this.projectIds(conversationId, record.id);
        return { id: record.id, context: this.projectValue(record.projectContext) };
      });
      if (pending.length) beforeImport(pending);
      for (const record of validated)
        save.run(conversationId, record.id, JSON.stringify(record.context));
    });
  }
  search(query: unknown, options: { limit?: number } = {}) {
    return this.transaction(true, (db) => searchMemory(db, query, options), false);
  }
  listEntries({ status }: { status?: MemoryEntryStatus } = {}) {
    return this.transaction(false, (db) => listMemoryEntries(db, status));
  }
  proposeEntry(value: unknown) {
    return this.transaction(true, (db) => proposeMemoryEntry(db, value));
  }
  confirmEntry(id: unknown, options: { resolveConflicts?: unknown } = {}) {
    return this.transaction(true, (db) => confirmMemoryEntry(db, id, options));
  }
  updateEntry(id: unknown, patch: unknown) {
    return this.transaction(true, (db) => updateMemoryEntry(db, id, patch));
  }
  deleteEntry(id: unknown) {
    return this.transaction(true, (db) => deleteMemoryEntry(db, id));
  }
}
