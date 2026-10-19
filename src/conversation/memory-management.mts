import type { Express, Request, Response } from 'express';
import type { MemoryStore } from './memory.mts';
import type { MemorySource } from './memory-types.ts';
import { isRecord } from '../contracts/json.mts';
import { MemoryEntryStatus } from '../contracts/states.mts';
import { containsMemorySecret, sanitizeMemoryText } from './memory-safety.mts';
import { DANT_IDENTITY_INSTRUCTIONS } from './identity.mts';
import {
  MEMORY_MAX_BYTES,
  MEMORY_SEARCH_QUERY_MAX_CHARS,
  MEMORY_MANAGEMENT_PAGE_SIZE,
} from './memory-constants.mts';
const EDITABLE_DOCUMENTS = ['identity.md', 'working-memory.md'];
const RECORD_KINDS = ['note', 'semantic', 'episodic'] as const;
interface Options {
  memory: Pick<MemoryStore, 'managementSnapshot' | 'manageRecord' | 'search'>;
  conversationId(): string;
  redact(text: string): string;
  containsSecret?(text: string): boolean;
  changed(): void;
}
const invalid = () => Object.assign(Error('Invalid memory operation.'), { status: 400 });
function sourceView(source: MemorySource, redact: Options['redact']): MemorySource {
  return Object.values(source).some((value) => typeof value === 'string' && redact(value) !== value)
    ? { kind: source.kind }
    : source;
}
export function installMemoryManagementRoutes(app: Express, options: Options) {
  const safe = (text: string) => options.redact(sanitizeMemoryText(text));
  app.get('/api/memory/manage', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const query = req.query.q ?? '',
        offsetText = req.query.offset ?? '0';
      if (
        Object.keys(req.query).some((key) => !['q', 'offset'].includes(key)) ||
        typeof query !== 'string' ||
        query.length > MEMORY_SEARCH_QUERY_MAX_CHARS ||
        query.includes('\0') ||
        typeof offsetText !== 'string' ||
        !/^(?:0|[1-9][0-9]{0,3})$/.test(offsetText)
      )
        throw invalid();
      const offset = Number(offsetText),
        snapshot = options.memory.managementSnapshot(),
        conversationId = options.conversationId(),
        matches = query.trim() ? options.memory.search(query, { limit: 50, conversationId }) : [],
        matched = new Set(matches.filter((item) => item.kind !== 'project').map((item) => item.id)),
        search = query.trim().toLocaleLowerCase(),
        visible = (id: string, text: string) =>
          !search || matched.has(id) || text.toLocaleLowerCase().includes(search),
        records = [
          ...snapshot.notes
            .filter((note) => EDITABLE_DOCUMENTS.includes(note.name))
            .map((note) => ({
              id: note.name,
              kind: 'note' as const,
              text: safe(note.text),
              status: null,
              source: null,
              redacted: safe(note.text) !== note.text,
            })),
          ...snapshot.entries
            .filter(
              (entry) =>
                !entry.source.conversationId || entry.source.conversationId === conversationId,
            )
            .map((entry) => ({
              id: entry.id,
              kind: entry.kind,
              text: safe(entry.text),
              status: entry.status,
              source: sourceView(entry.source, options.redact),
              redacted: safe(entry.text) !== entry.text,
            })),
        ].filter((record) => visible(record.id, record.text));
      res.json({
        storage: 'sqlite',
        conversationId,
        revision: snapshot.revision,
        query,
        offset,
        identity: { text: DANT_IDENTITY_INSTRUCTIONS },
        records: records.slice(offset, offset + MEMORY_MANAGEMENT_PAGE_SIZE),
        total: records.length,
        hasMore: offset + MEMORY_MANAGEMENT_PAGE_SIZE < records.length,
        projects: matches
          .filter((item) => item.kind === 'project' && item.conversationId === conversationId)
          .filter(
            (item) =>
              options.redact(item.id) === item.id &&
              (!item.workId || options.redact(item.workId) === item.workId),
          )
          .map((item) => ({ id: item.id, workId: item.workId ?? item.id, text: safe(item.text) })),
      });
    } catch (error) {
      res
        .status(isRecord(error) && error.status === 400 ? 400 : 503)
        .json({ code: 'memory_read_failed', error: 'Memory could not be read.' });
    }
  });
  const mutate = (action: 'update' | 'delete' | 'confirm') => (req: Request, res: Response) => {
    try {
      const body: unknown = req.body,
        kind = RECORD_KINDS.find((kind) => kind === req.params.kind),
        id = req.params.id;
      if (
        !kind ||
        typeof id !== 'string' ||
        !id ||
        id.length > 256 ||
        /[\x00-\x20\x7f]/.test(id) ||
        !isRecord(body) ||
        Object.keys(body).some(
          (key) =>
            !['conversationId', 'revision', ...(action === 'update' ? ['text'] : [])].includes(key),
        ) ||
        body.conversationId !== options.conversationId() ||
        typeof body.revision !== 'string' ||
        !/^[0-9]+:[0-9]+$/.test(body.revision)
      )
        throw invalid();
      if (
        action === 'update' &&
        (typeof body.text !== 'string' ||
          body.text.includes('\0') ||
          Buffer.byteLength(body.text) > MEMORY_MAX_BYTES ||
          containsMemorySecret(body.text) ||
          options.containsSecret?.(body.text))
      )
        throw invalid();
      const snapshot = options.memory.managementSnapshot();
      const original =
        kind === 'note'
          ? snapshot.notes.find((note) => note.name === id)?.text
          : snapshot.entries.find((entry) => entry.id === id && entry.kind === kind)?.text;
      const entry = snapshot.entries.find((entry) => entry.id === id && entry.kind === kind);
      if (entry?.source.conversationId && entry.source.conversationId !== options.conversationId())
        throw invalid();
      if (original === undefined || (action === 'update' && safe(original) !== original))
        throw invalid();
      if (
        action === 'confirm' &&
        (kind === 'note' ||
          !snapshot.entries.some(
            (entry) =>
              entry.id === id &&
              [MemoryEntryStatus.Candidate, MemoryEntryStatus.Conflicted].some(
                (status) => status === entry.status,
              ),
          ))
      )
        throw invalid();
      const saved = options.memory.manageRecord({
        revision: body.revision,
        kind,
        id,
        action,
        ...(action === 'update' && typeof body.text === 'string' ? { text: body.text } : {}),
      });
      options.changed();
      res.json({ saved: true, conversationId: body.conversationId, revision: saved.revision });
    } catch (error) {
      const conflict = isRecord(error) && error.code === 'memory_conflict';
      res.status(conflict ? 409 : 400).json({
        code: conflict ? 'memory_conflict' : 'memory_write_failed',
        error: 'Refresh memory and check the result before trying again.',
      });
    }
  };
  app.patch('/api/memory/manage/:kind/:id', mutate('update'));
  app.delete('/api/memory/manage/:kind/:id', mutate('delete'));
  app.post('/api/memory/manage/:kind/:id/confirm', mutate('confirm'));
}
