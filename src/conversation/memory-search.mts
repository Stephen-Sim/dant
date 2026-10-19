import { MemoryEntryStatus } from '../contracts/states.mts';
import type { DatabaseSync } from 'node:sqlite';
import { safeProjectContext } from '../work/task-project-context.mts';
import { sanitizeMemoryText } from './memory-safety.mts';
import { listMemoryEntries } from './memory-entries.mts';
import {
  MEMORY_SEARCH_QUERY_MAX_CHARS,
  MEMORY_SEARCH_TERM_LIMIT,
  MEMORY_SEARCH_RESULT_LIMIT,
  MEMORY_SEARCH_EXCERPT_CHARS,
} from './memory-constants.mts';
import type { MemorySearchResult } from './memory-types.ts';

function searchTokens(text: string) {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu) ?? []
  );
}
function cjkPairs(token: string) {
  if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(token)) return [token];
  const characters = Array.from(token);
  return characters.length < 2
    ? [token]
    : characters.slice(1).map((character, index) => characters[index] + character);
}
const indexedText = (text: string) => text + '\n' + searchTokens(text).flatMap(cjkPairs).join(' ');
function synchronizeSearchIndex(db: DatabaseSync) {
  const metadata = db
    .prepare('SELECT revision, search_revision FROM memory_meta WHERE id = 1')
    .get();
  if (
    !metadata ||
    typeof metadata.revision !== 'number' ||
    typeof metadata.search_revision !== 'number'
  )
    throw Error('Invalid memory search revision');
  if (metadata.revision === metadata.search_revision) return;
  db.exec('DELETE FROM memory_search');
  const insert = db.prepare(
    'INSERT INTO memory_search (document_key, kind, text, updated_at, conversation_id, work_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const note of db.prepare('SELECT name, text FROM notes').all()) {
    if (typeof note.name !== 'string' || typeof note.text !== 'string')
      throw Error('Invalid searchable memory note');
    insert.run(note.name, 'note', indexedText(sanitizeMemoryText(note.text)), null, null, null);
  }
  for (const project of db
    .prepare('SELECT conversation_id, work_id, context_json FROM projects')
    .all()) {
    if (
      typeof project.conversation_id !== 'string' ||
      typeof project.work_id !== 'string' ||
      typeof project.context_json !== 'string'
    )
      throw Error('Invalid searchable project memory');
    const context = safeProjectContext(JSON.parse(project.context_json));
    if (!context) throw Error('Invalid searchable project context');
    const text = [context.originalRequest, ...context.humanUpdates, ...context.results]
      .flatMap((entry) => (entry ? [sanitizeMemoryText(entry.text)] : []))
      .join('\n');
    insert.run(
      project.work_id,
      'project',
      indexedText(text),
      context.updatedAt,
      project.conversation_id,
      project.work_id,
    );
  }
  for (const entry of listMemoryEntries(db, MemoryEntryStatus.Confirmed))
    insert.run(
      entry.id,
      entry.kind,
      indexedText(entry.text),
      entry.updatedAt,
      entry.source.conversationId ?? null,
      entry.source.workId ?? null,
    );
  db.prepare('UPDATE memory_meta SET search_revision = ? WHERE id = 1').run(metadata.revision);
}
export function searchMemory(
  db: DatabaseSync,
  query: unknown,
  { limit = 10 }: { limit?: number } = {},
): MemorySearchResult[] {
  if (
    typeof query !== 'string' ||
    query.length > MEMORY_SEARCH_QUERY_MAX_CHARS ||
    query.includes('\0')
  )
    throw Error('Memory search query must be bounded text');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_SEARCH_RESULT_LIMIT)
    throw Error('Invalid memory search result limit');
  const terms = [...new Set(searchTokens(query).flatMap(cjkPairs))].slice(
    0,
    MEMORY_SEARCH_TERM_LIMIT,
  );
  if (!terms.length) return [];
  synchronizeSearchIndex(db);
  // FTS operators are never accepted from input; every normalized term is a literal.
  const expression = terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' AND ');
  const values = db
    .prepare(
      'SELECT document_key, kind, text, updated_at, conversation_id, work_id, bm25(memory_search) AS rank FROM memory_search WHERE memory_search MATCH ? ORDER BY bm25(memory_search), CAST(updated_at AS INTEGER) DESC, document_key LIMIT ?',
    )
    .all(expression, limit);
  return values.map((value) => {
    if (
      typeof value.document_key !== 'string' ||
      (value.kind !== 'note' &&
        value.kind !== 'project' &&
        value.kind !== 'semantic' &&
        value.kind !== 'episodic') ||
      typeof value.text !== 'string' ||
      typeof value.rank !== 'number'
    )
      throw Error('Invalid memory search result');
    // Indexed token expansions only aid matching and are never shown as a memory excerpt.
    const text = value.text
      .slice(0, value.text.lastIndexOf('\n'))
      .slice(0, MEMORY_SEARCH_EXCERPT_CHARS);
    return {
      kind: value.kind,
      id: value.document_key,
      text,
      score: -value.rank,
      ...(typeof value.updated_at === 'number' ? { updatedAt: value.updated_at } : {}),
      ...(typeof value.conversation_id === 'string'
        ? { conversationId: value.conversation_id }
        : {}),
      ...(typeof value.work_id === 'string' ? { workId: value.work_id } : {}),
    };
  });
}
