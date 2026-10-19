import { isRecord } from '../shared/contracts.mts';
const normalized = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase();

/** Search already-loaded chat records and attachment names; no file reads or model calls. */
export function searchMessages(messages: unknown, query: unknown, { limit = 50 } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200 || !Array.isArray(messages))
    return [];
  const records: readonly unknown[] = messages;
  const needle = normalized(query.trim()),
    max = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50,
    results = [];
  for (let index = records.length - 1; index >= 0 && results.length < max; index--) {
    const message = records[index];
    if (
      !isRecord(message) ||
      typeof message.id !== 'string' ||
      (message.role !== 'user' && message.role !== 'assistant')
    )
      continue;
    const text = typeof message.text === 'string' ? message.text : '',
      files: readonly unknown[] = Array.isArray(message.attachments) ? message.attachments : [],
      attachments = files.flatMap((file) =>
        isRecord(file) && typeof file.name === 'string' ? [file.name] : [],
      ),
      offset = normalized(text).indexOf(needle),
      file = attachments.find((name) => normalized(name).includes(needle));
    if (offset < 0 && !file) continue;
    const start = Math.max(0, offset - 40),
      end = Math.min(text.length, Math.max(0, offset) + needle.length + 100),
      snippet =
        offset >= 0
          ? (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
          : (file ?? '');
    results.push({
      messageId: message.id,
      role: message.role,
      time: message.time || null,
      text,
      attachments,
      snippet,
      matchedField: offset >= 0 ? 'text' : 'attachment',
    });
  }
  return results;
}
