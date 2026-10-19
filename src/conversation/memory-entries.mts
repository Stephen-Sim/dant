import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryEntryStatus as EntryStatus } from '../contracts/states.mts';
import { includesValue, isRecord } from '../contracts/json.mts';
import { MEMORY_ENTRY_MAX_BYTES, MEMORY_ENTRY_LIMIT } from './memory-constants.mts';
import { containsMemorySecret } from './memory-safety.mts';
import type {
  MemoryEntry,
  MemoryEntryKind,
  MemorySource,
  MemoryEntryStatus,
} from './memory-types.ts';

const kinds = ['semantic', 'episodic'] as const;
const statuses = Object.values(EntryStatus);
const sourceKinds = ['user', 'task', 'inference'] as const;
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x20\x7f]/.test(value);
const validTime = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 8640000000000000;
const normalize = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
function entryText(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value) > MEMORY_ENTRY_MAX_BYTES
  )
    throw Error('Memory entry must contain bounded text');
  if (containsMemorySecret(value))
    throw Error('Sensitive values cannot be saved as memory candidates');
  return value.trim();
}
function sourceValue(value: unknown): MemorySource {
  if (!isRecord(value) || !includesValue(sourceKinds, value.kind))
    throw Error('Invalid memory source');
  const source: MemorySource = { kind: value.kind };
  for (const key of ['conversationId', 'workId', 'messageId'] as const) {
    if (value[key] === undefined) continue;
    if (!validId(value[key])) throw Error('Invalid memory source identity');
    if (containsMemorySecret(value[key]))
      throw Error('Sensitive values cannot be saved as memory provenance');
    source[key] = value[key];
  }
  if (value.at !== undefined) {
    if (!validTime(value.at)) throw Error('Invalid memory source time');
    source.at = value.at;
  }
  return source;
}
function confidenceValue(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw Error('Invalid memory confidence');
  return value;
}
function entryKey(value: unknown, text: string) {
  if (value === undefined) return normalize(text);
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value) > MEMORY_ENTRY_MAX_BYTES
  )
    throw Error('Invalid memory key');
  if (containsMemorySecret(value)) throw Error('Sensitive values cannot be saved as memory keys');
  return normalize(value);
}
function dedupe(kind: MemoryEntryKind, key: string, text: string) {
  return createHash('sha256')
    .update(JSON.stringify([kind, key, normalize(text)]))
    .digest('hex');
}
export function decodeMemoryEntry(value: unknown): MemoryEntry {
  if (
    !isRecord(value) ||
    !validId(value.id) ||
    !includesValue(kinds, value.kind) ||
    !includesValue(statuses, value.status) ||
    typeof value.memory_key !== 'string' ||
    !validTime(value.created_at) ||
    !validTime(value.updated_at) ||
    typeof value.source_json !== 'string' ||
    typeof value.conflicts_json !== 'string'
  )
    throw Error('Invalid stored memory entry');
  const conflicts: unknown = JSON.parse(value.conflicts_json);
  if (!Array.isArray(conflicts) || !conflicts.every(validId))
    throw Error('Invalid memory conflicts');
  return {
    id: value.id,
    kind: value.kind,
    text: entryText(value.text),
    key: value.memory_key,
    status: value.status,
    source: sourceValue(JSON.parse(value.source_json)),
    confidence: confidenceValue(value.confidence),
    conflictsWith: conflicts,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}
export function entryById(db: DatabaseSync, id: unknown) {
  if (!validId(id)) throw Error('Invalid memory entry identity');
  const value = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id);
  return value ? decodeMemoryEntry(value) : null;
}
function liveConflicts(db: DatabaseSync, kind: MemoryEntryKind, key: string, id?: string) {
  return db
    .prepare(
      "SELECT id FROM memory_entries WHERE kind = ? AND memory_key = ? AND status = 'confirmed' AND id != ?",
    )
    .all(kind, key, id ?? '')
    .map((value) => {
      if (!validId(value.id)) throw Error('Invalid memory conflict identity');
      return value.id;
    });
}
export function listMemoryEntries(db: DatabaseSync, status?: MemoryEntryStatus) {
  if (status !== undefined && !includesValue(statuses, status))
    throw Error('Invalid memory entry status');
  const values =
    status === undefined
      ? db.prepare('SELECT * FROM memory_entries ORDER BY updated_at DESC, id').all()
      : db
          .prepare('SELECT * FROM memory_entries WHERE status = ? ORDER BY updated_at DESC, id')
          .all(status);
  return values.map(decodeMemoryEntry);
}
export function proposeMemoryEntry(db: DatabaseSync, value: unknown) {
  if (!isRecord(value) || !includesValue(kinds, value.kind))
    throw Error('Invalid memory entry proposal');
  const text = entryText(value.text),
    key = entryKey(value.key, text),
    source = sourceValue(value.source),
    confidence = confidenceValue(value.confidence),
    fingerprint = dedupe(value.kind, key, text);
  const existing = db.prepare('SELECT * FROM memory_entries WHERE dedupe = ?').get(fingerprint);
  if (existing) return decodeMemoryEntry(existing);
  const count = db.prepare('SELECT COUNT(*) AS count FROM memory_entries').get()?.count;
  if (typeof count !== 'number' || count >= MEMORY_ENTRY_LIMIT)
    throw Error('Memory candidate limit reached');
  const id = randomUUID(),
    at = Date.now(),
    conflicts = liveConflicts(db, value.kind, key);
  db.prepare(
    'INSERT INTO memory_entries (id, kind, text, memory_key, dedupe, status, source_json, confidence, conflicts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    value.kind,
    text,
    key,
    fingerprint,
    conflicts.length ? EntryStatus.Conflicted : EntryStatus.Candidate,
    JSON.stringify(source),
    confidence,
    JSON.stringify(conflicts),
    at,
    at,
  );
  const saved = entryById(db, id);
  if (!saved) throw Error('Memory candidate was not saved');
  return saved;
}
export function confirmMemoryEntry(
  db: DatabaseSync,
  id: unknown,
  { resolveConflicts = false }: { resolveConflicts?: unknown } = {},
) {
  const current = entryById(db, id);
  if (!current) throw Error('Memory entry not found');
  const conflicts = liveConflicts(db, current.kind, current.key, current.id),
    at = Date.now();
  if (conflicts.length && resolveConflicts !== true)
    throw Error('Resolve conflicting confirmed memory before confirming');
  for (const previous of conflicts)
    db.prepare("UPDATE memory_entries SET status = 'rejected', updated_at = ? WHERE id = ?").run(
      at,
      previous,
    );
  db.prepare(
    "UPDATE memory_entries SET status = 'confirmed', conflicts_json = '[]', updated_at = ? WHERE id = ?",
  ).run(at, current.id);
  const saved = entryById(db, current.id);
  if (!saved) throw Error('Memory confirmation was not saved');
  return saved;
}
export function updateMemoryEntry(db: DatabaseSync, id: unknown, patch: unknown) {
  const current = entryById(db, id);
  if (!current) throw Error('Memory entry not found');
  if (
    !isRecord(patch) ||
    !Object.keys(patch).length ||
    !Object.keys(patch).every((key) =>
      ['kind', 'text', 'key', 'source', 'confidence'].includes(key),
    )
  )
    throw Error('Invalid memory entry update');
  const kind = patch.kind === undefined ? current.kind : patch.kind;
  if (!includesValue(kinds, kind)) throw Error('Invalid memory entry kind');
  const text = patch.text === undefined ? current.text : entryText(patch.text),
    key = patch.key === undefined ? current.key : entryKey(patch.key, text),
    source = patch.source === undefined ? current.source : sourceValue(patch.source),
    confidence =
      patch.confidence === undefined ? current.confidence : confidenceValue(patch.confidence),
    conflicts = liveConflicts(db, kind, key, current.id);
  db.prepare(
    'UPDATE memory_entries SET kind = ?, text = ?, memory_key = ?, dedupe = ?, status = ?, source_json = ?, confidence = ?, conflicts_json = ?, updated_at = ? WHERE id = ?',
  ).run(
    kind,
    text,
    key,
    dedupe(kind, key, text),
    conflicts.length ? EntryStatus.Conflicted : EntryStatus.Candidate,
    JSON.stringify(source),
    confidence,
    JSON.stringify(conflicts),
    Date.now(),
    current.id,
  );
  const saved = entryById(db, current.id);
  if (!saved) throw Error('Memory update was not saved');
  return saved;
}
export function deleteMemoryEntry(db: DatabaseSync, id: unknown) {
  const current = entryById(db, id);
  if (!current) return false;
  return db.prepare('DELETE FROM memory_entries WHERE id = ?').run(current.id).changes === 1;
}
