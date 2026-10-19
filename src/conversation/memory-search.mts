import { MemoryEntryStatus } from '../contracts/states.mts';
import { isRecord } from '../contracts/json.mts';
import type { DatabaseSync } from 'node:sqlite';
import { safeProjectContext } from '../work/task-project-context.mts';
import { sanitizeMemoryText } from './memory-safety.mts';
import { listMemoryEntries, entryById } from './memory-entries.mts';
import {
  MEMORY_SEARCH_QUERY_MAX_CHARS,
  MEMORY_SEARCH_TERM_LIMIT,
  MEMORY_SEARCH_RESULT_LIMIT,
  MEMORY_SEARCH_EXCERPT_CHARS,
  MEMORY_RETRIEVAL_INPUT_MAX_CHARS,
  MEMORY_RETRIEVAL_RESULT_LIMIT,
  MEMORY_RETRIEVAL_TEXT_BUDGET,
  MEMORY_RETRIEVAL_EXCERPT_LEAD_CHARS,
  MEMORY_RETRIEVAL_ID_MAX_CHARS,
} from './memory-constants.mts';
import type {
  MemorySearchResult,
  MemoryRetrievalScope,
  MemoryRetrievalOptions,
  MemoryRetrievalReference,
  MemorySource,
} from './memory-types.ts';

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
const safeQuery = (text: string) =>
  sanitizeMemoryText(text).replace(
    /\[(?:sensitive value|API key|token|private key) omitted\]/gi,
    ' ',
  );
const visibleIndexedText = (text: string) =>
  sanitizeMemoryText(
    text.slice(0, text.lastIndexOf('\n') < 0 ? undefined : text.lastIndexOf('\n')),
  );
export function synchronizeSearchIndex(db: DatabaseSync) {
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
  { limit = 10, conversationId }: { limit?: number; conversationId?: string } = {},
): MemorySearchResult[] {
  if (
    typeof query !== 'string' ||
    query.length > MEMORY_SEARCH_QUERY_MAX_CHARS ||
    query.includes('\0')
  )
    throw Error('Memory search query must be bounded text');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_SEARCH_RESULT_LIMIT)
    throw Error('Invalid memory search result limit');
  if (
    conversationId !== undefined &&
    (typeof conversationId !== 'string' ||
      !conversationId ||
      conversationId.length > MEMORY_RETRIEVAL_ID_MAX_CHARS ||
      /[\x00-\x20\x7f]/.test(conversationId))
  )
    throw Error('Invalid memory search scope');
  const terms = prepareMemorySearch(query);
  if (!terms.length) return [];
  synchronizeSearchIndex(db);
  // FTS operators are never accepted from input; every normalized term is a literal.
  const expression = terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' AND ');
  const statement = db.prepare(
    'SELECT document_key, kind, text, updated_at, conversation_id, work_id, bm25(memory_search) AS rank FROM memory_search WHERE memory_search MATCH ?' +
      (conversationId === undefined
        ? ''
        : ' AND (conversation_id IS NULL OR conversation_id = ?)') +
      ' ORDER BY bm25(memory_search), CAST(updated_at AS INTEGER) DESC, document_key LIMIT ?',
  );
  const values =
    conversationId === undefined
      ? statement.all(expression, limit)
      : statement.all(expression, conversationId, limit);
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
    const text = visibleIndexedText(value.text).slice(0, MEMORY_SEARCH_EXCERPT_CHARS);
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

const retrievalStopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'let',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'recall',
  'remember',
  'remind',
  'should',
  'so',
  'some',
  'tell',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'us',
  'use',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  '请问',
  '请你',
  '帮我',
  '我们',
  '之前',
  '继续',
  '一下',
  '什么',
  '怎么',
  '如何',
  '这个',
  '那个',
  '现在',
  '已经',
  '需要',
  '可以',
  '请帮',
  '能否',
]);
const validScopeId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MEMORY_RETRIEVAL_ID_MAX_CHARS &&
  !/[\x00-\x20\x7f]/.test(value);

/** The shadow reader shares normalization and secret handling with the authoritative owner. */
export function prepareMemorySearch(query: unknown): string[] {
  if (
    typeof query !== 'string' ||
    query.length > MEMORY_SEARCH_QUERY_MAX_CHARS ||
    query.includes('\0')
  )
    throw Error('Memory search query must be bounded text');
  return [...new Set(searchTokens(safeQuery(query)).flatMap(cjkPairs))].slice(
    0,
    MEMORY_SEARCH_TERM_LIMIT,
  );
}

export function prepareMemoryRetrieval(query: unknown): string[] {
  if (typeof query !== 'string') throw Error('Memory retrieval query must be text');
  const text = safeQuery(query.slice(0, MEMORY_RETRIEVAL_INPUT_MAX_CHARS))
    .normalize('NFKC')
    .replace(/\0/g, ' ');
  const tokens = searchTokens(
    text.replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+)/gu, ' $1 '),
  ).flatMap(cjkPairs);
  const terms: string[] = [];
  let termCharacters = 0;
  for (const term of new Set(tokens)) {
    if (
      retrievalStopWords.has(term) ||
      termCharacters + term.length > MEMORY_SEARCH_QUERY_MAX_CHARS
    )
      continue;
    terms.push(term);
    termCharacters += term.length;
    if (terms.length >= MEMORY_SEARCH_TERM_LIMIT) break;
  }
  return terms;
}
export function memoryRetrievalScope(value: unknown): MemoryRetrievalScope {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => key === 'conversationId' || key === 'workId') ||
    !validScopeId(value.conversationId) ||
    (Object.hasOwn(value, 'workId') && !validScopeId(value.workId))
  )
    throw Error('Invalid memory retrieval scope');
  return {
    conversationId: value.conversationId,
    ...(typeof value.workId === 'string' ? { workId: value.workId } : {}),
  };
}
function sourceMatches(
  kind: 'semantic' | 'episodic',
  source: MemorySource,
  scope: MemoryRetrievalScope,
) {
  if (source.conversationId === undefined && source.workId === undefined)
    return kind === 'semantic';
  return (
    source.conversationId === scope.conversationId &&
    (source.workId === undefined || source.workId === scope.workId)
  );
}
function relevantExcerpt(text: string, terms: readonly string[], maximum: number) {
  const safe = sanitizeMemoryText(text);
  const normalized = safe.normalize('NFKC').toLowerCase();
  const positions = terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0);
  if (!positions.length) return null;
  const starts = positions.map((position) =>
    Math.max(0, position - MEMORY_RETRIEVAL_EXCERPT_LEAD_CHARS),
  );
  const start = starts.reduce((best, candidate) => {
    const score = (offset: number) =>
      terms.filter((term) => normalized.slice(offset, offset + maximum).includes(term)).length;
    return score(candidate) > score(best) ? candidate : best;
  }, starts[0] ?? 0);
  if (maximum <= 2) return safe.slice(start, start + maximum);
  const leading = start > 0 ? '…' : '';
  const available = Math.max(0, maximum - leading.length);
  const end = Math.min(safe.length, start + available);
  const trailing = end < safe.length ? '…' : '';
  return leading + safe.slice(start, Math.max(start, end - trailing.length)) + trailing;
}
/** Automatic recall uses strict scope before ranking/limit; it never broadens to other projects. */
export function retrieveMemory(
  db: DatabaseSync,
  query: unknown,
  scopeValue: unknown,
  { limit = MEMORY_RETRIEVAL_RESULT_LIMIT }: MemoryRetrievalOptions = {},
): MemoryRetrievalReference[] {
  const scope = memoryRetrievalScope(scopeValue);
  if (typeof query !== 'string') throw Error('Memory retrieval query must be text');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_RETRIEVAL_RESULT_LIMIT)
    throw Error('Invalid memory retrieval result limit');
  const terms = prepareMemoryRetrieval(query);
  if (!terms.length) return [];
  synchronizeSearchIndex(db);
  const expression = terms.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' OR ');
  const workId = scope.workId ?? null;
  const rows = db
    .prepare(
      `SELECT document_key, kind, conversation_id, work_id, bm25(memory_search) AS rank
    FROM memory_search WHERE memory_search MATCH ? AND (
      (kind = 'note' AND document_key IN ('identity.md','working-memory.md')) OR
      (kind = 'semantic' AND conversation_id IS NULL AND work_id IS NULL) OR
      (kind IN ('semantic','episodic') AND conversation_id = ? AND (work_id IS NULL OR (work_id = ? AND ? IS NOT NULL))) OR
      (kind = 'project' AND conversation_id = ? AND work_id = ? AND ? IS NOT NULL)
    ) ORDER BY bm25(memory_search), document_key LIMIT ?`,
    )
    .all(
      expression,
      scope.conversationId,
      workId,
      workId,
      scope.conversationId,
      workId,
      workId,
      limit,
    );
  const results: MemoryRetrievalReference[] = [];
  let remaining = MEMORY_RETRIEVAL_TEXT_BUDGET;
  for (const row of rows) {
    if (
      typeof row.document_key !== 'string' ||
      typeof row.rank !== 'number' ||
      !Number.isFinite(row.rank)
    )
      throw Error('Invalid memory retrieval result');
    let reference: Omit<MemoryRetrievalReference, 'text'>;
    let content: string;
    if (row.kind === 'note') {
      if (row.document_key !== 'identity.md' && row.document_key !== 'working-memory.md') continue;
      const note = db.prepare('SELECT text FROM notes WHERE name = ?').get(row.document_key);
      if (!note || typeof note.text !== 'string') continue;
      content = note.text;
      reference = { kind: 'note', id: row.document_key, score: -row.rank };
    } else if (row.kind === 'project') {
      if (
        row.conversation_id !== scope.conversationId ||
        row.work_id !== scope.workId ||
        !scope.workId
      )
        continue;
      const project = db
        .prepare('SELECT context_json FROM projects WHERE conversation_id = ? AND work_id = ?')
        .get(scope.conversationId, scope.workId);
      if (!project || typeof project.context_json !== 'string') continue;
      const context = safeProjectContext(JSON.parse(project.context_json), {
        redact: sanitizeMemoryText,
      });
      if (!context) continue;
      content = [context.originalRequest, ...context.humanUpdates, ...context.results]
        .flatMap((entry) => (entry ? [entry.text] : []))
        .join('\n');
      reference = {
        kind: 'project',
        id: scope.workId,
        conversationId: scope.conversationId,
        workId: scope.workId,
        updatedAt: context.updatedAt,
        score: -row.rank,
      };
    } else if (row.kind === 'semantic' || row.kind === 'episodic') {
      const entry = entryById(db, row.document_key);
      if (
        !entry ||
        entry.status !== MemoryEntryStatus.Confirmed ||
        entry.kind !== row.kind ||
        !sourceMatches(entry.kind, entry.source, scope)
      )
        continue;
      content = entry.text;
      reference = {
        kind: entry.kind,
        id: entry.id,
        updatedAt: entry.updatedAt,
        source: entry.source,
        confidence: entry.confidence,
        score: -row.rank,
        ...(entry.source.conversationId ? { conversationId: entry.source.conversationId } : {}),
        ...(entry.source.workId ? { workId: entry.source.workId } : {}),
      };
    } else continue;
    const excerpt = relevantExcerpt(
      content,
      terms,
      Math.min(remaining, MEMORY_SEARCH_EXCERPT_CHARS),
    );
    if (excerpt) {
      results.push({ ...reference, text: excerpt });
      remaining -= excerpt.length;
    }
    if (remaining <= 0) break;
  }
  return results;
}
