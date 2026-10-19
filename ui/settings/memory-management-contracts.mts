import { isRecord } from '../shared/contracts.mts';
import { MemoryEntryStatus, isEnumValue } from '../../src/contracts/states.mts';
import type { MemoryEntryStatusValue } from '../../src/contracts/states.mts';
import {
  MEMORY_MANAGEMENT_PAGE_SIZE,
  MEMORY_ENTRY_LIMIT,
  MEMORY_MAX_BYTES,
  MEMORY_SEARCH_QUERY_MAX_CHARS,
} from '../../src/conversation/memory-constants.mts';
export interface ManagedMemoryRecord {
  id: string;
  kind: 'note' | 'semantic' | 'episodic';
  text: string;
  status: MemoryEntryStatusValue | null;
  source: { kind: 'user' | 'task' | 'inference'; conversationId?: string; workId?: string } | null;
  redacted: boolean;
}
export interface ManagedMemoryView {
  storage: 'sqlite';
  conversationId: string;
  revision: string;
  query: string;
  offset: number;
  total: number;
  hasMore: boolean;
  identity: { text: string };
  records: ManagedMemoryRecord[];
  projects: { id: string; workId: string; text: string }[];
}
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x20\x7f]/.test(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MEMORY_MAX_BYTES && !value.includes('\0');
export function readManagedMemory(value: unknown, conversationId: string): ManagedMemoryView {
  const bad = () => Error('Invalid memory response');
  if (
    !isRecord(value) ||
    value.storage !== 'sqlite' ||
    value.conversationId !== conversationId ||
    typeof value.revision !== 'string' ||
    !/^[0-9]+:[0-9]+$/.test(value.revision) ||
    typeof value.query !== 'string' ||
    value.query.length > MEMORY_SEARCH_QUERY_MAX_CHARS ||
    typeof value.offset !== 'number' ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.total !== 'number' ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    value.total > MEMORY_ENTRY_LIMIT + 2 ||
    typeof value.hasMore !== 'boolean' ||
    !isRecord(value.identity) ||
    !text(value.identity.text) ||
    !Array.isArray(value.records) ||
    value.records.length > MEMORY_MANAGEMENT_PAGE_SIZE ||
    !Array.isArray(value.projects) ||
    value.projects.length > 50
  )
    throw bad();
  const records = value.records.map((record: unknown): ManagedMemoryRecord => {
    if (
      !isRecord(record) ||
      !id(record.id) ||
      !text(record.text) ||
      (record.kind !== 'note' && record.kind !== 'semantic' && record.kind !== 'episodic') ||
      !(record.status === null || isEnumValue(MemoryEntryStatus, record.status)) ||
      typeof record.redacted !== 'boolean'
    )
      throw bad();
    const kind =
      record.kind === 'note' ? 'note' : record.kind === 'semantic' ? 'semantic' : 'episodic';
    if (kind === 'note' && !['identity.md', 'working-memory.md'].includes(record.id)) throw bad();
    if (
      kind === 'note'
        ? record.status !== null || record.source !== null
        : record.status === null || record.source === null
    )
      throw bad();
    let source: ManagedMemoryRecord['source'] = null;
    if (record.source !== null) {
      if (
        !isRecord(record.source) ||
        (record.source.kind !== 'user' &&
          record.source.kind !== 'task' &&
          record.source.kind !== 'inference')
      )
        throw bad();
      const sourceKind =
        record.source.kind === 'user'
          ? 'user'
          : record.source.kind === 'task'
            ? 'task'
            : 'inference';
      source = { kind: sourceKind };
      for (const key of ['conversationId', 'workId'] as const) {
        if (record.source[key] === undefined) continue;
        if (!id(record.source[key])) throw bad();
        source[key] = record.source[key];
      }
    }
    return {
      id: record.id,
      kind,
      text: record.text,
      status: record.status,
      source,
      redacted: record.redacted,
    };
  });
  if (new Set(records.map((record) => record.kind + ':' + record.id)).size !== records.length)
    throw bad();
  const projects = value.projects.map((project: unknown) => {
    if (!isRecord(project) || !id(project.id) || !id(project.workId) || !text(project.text))
      throw bad();
    return { id: project.id, workId: project.workId, text: project.text };
  });
  return {
    storage: 'sqlite',
    conversationId,
    revision: value.revision,
    query: value.query,
    offset: value.offset,
    total: value.total,
    hasMore: value.hasMore,
    identity: { text: value.identity.text },
    records,
    projects,
  };
}
