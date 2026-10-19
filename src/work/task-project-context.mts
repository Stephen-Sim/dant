import { isRecord } from '../contracts/json.mts';
import type { ProjectContext, ProjectContextEntry } from '../conversation/types.ts';
export interface ProjectRecordObservation {
  id?: unknown;
  turnId?: unknown;
  turnIds?: unknown;
  messageId?: unknown;
  projectContext?: unknown;
  updatedAt?: unknown;
}
export interface ProjectMessageObservation {
  id?: unknown;
  role?: unknown;
  time?: unknown;
  text?: unknown;
  attachments?: unknown;
  turnId?: unknown;
  workId?: unknown;
  workReply?: unknown;
  taskId?: unknown;
  status?: unknown;
}
export interface ProjectContextOptions {
  redact?: (text: string) => string;
  messageIds?: string[];
  at?: number;
}
import { MAX_MESSAGE_ATTACHMENTS } from '../files/attachments.mts';

const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x20\x7f]/.test(value);
const fileId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validTime = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 8640000000000000;
const plain = isRecord;
const text = (value: unknown, limit: number, redact: (text: string) => string) =>
  typeof value === 'string' ? String(redact(value)).slice(0, limit) : '';
function boundedContext(value: ProjectContext): ProjectContext {
  // Keep the original request and newest real references. Never summarize or
  // guess dates just to fit the durable per-task byte limit.
  while (
    Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 &&
    (value.humanUpdates.length || value.results.length)
  ) {
    const updates = value.humanUpdates,
      results = value.results;
    if (
      updates.length &&
      (!results.length || (updates[0]?.at ?? Infinity) <= (results[0]?.at ?? Infinity))
    )
      updates.shift();
    else results.shift();
  }
  return value;
}
function entry(value: unknown, redact: (text: string) => string): ProjectContextEntry | null {
  if (!plain(value) || !validId(value.messageId) || !validTime(value.at)) return null;
  const attachments = (Array.isArray(value.attachments) ? value.attachments : [])
    .slice(0, MAX_MESSAGE_ATTACHMENTS)
    .flatMap((file) => {
      if (!plain(file) || typeof file.id !== 'string' || !fileId.test(file.id)) return [];
      return [
        {
          id: file.id,
          name: text(file.name, 200, redact),
          type: text(file.type, 100, redact),
          ...(typeof file.size === 'number' &&
          Number.isSafeInteger(file.size) &&
          file.size >= 0 &&
          file.size <= 10 * 1024 * 1024
            ? { size: file.size }
            : {}),
        },
      ];
    });
  return {
    messageId: value.messageId,
    ...(validId(value.turnId) ? { turnId: value.turnId } : {}),
    at: value.at,
    text: text(value.text, 4000, redact),
    attachments,
  };
}
export function safeProjectContext(
  value: unknown,
  { redact = (value) => value }: ProjectContextOptions = {},
): ProjectContext | null {
  if (!plain(value) || value.version !== 1 || !validTime(value.updatedAt)) return null;
  const entries = (values: unknown): ProjectContextEntry[] =>
    (Array.isArray(values) ? values : []).slice(-8).flatMap((value) => {
      const result = entry(value, redact);
      return result ? [result] : [];
    });
  return boundedContext({
    version: 1,
    referenceDataOnly: true,
    updatedAt: value.updatedAt,
    originalRequest: entry(value.originalRequest, redact),
    humanUpdates: entries(value.humanUpdates),
    results: entries(value.results),
  });
}
/** Exact saved chat excerpts, never a generated summary or a new authorization. */
export function captureProjectContext(
  record: ProjectRecordObservation,
  messages: readonly ProjectMessageObservation[],
  { redact = (value) => value, messageIds = [], at = Date.now() }: ProjectContextOptions = {},
) {
  const previous = safeProjectContext(record.projectContext, { redact }) || {
      version: 1,
      updatedAt: at,
      originalRequest: null,
      humanUpdates: [],
      results: [],
    },
    turns = new Set(
      [record.turnId, ...(Array.isArray(record.turnIds) ? record.turnIds : [])].filter(validId),
    ),
    owned = new Set(messageIds.filter(validId)),
    humanIds = new Set<unknown>();
  // An input can be retried for a different task. An old anchor/taskId is
  // weaker than explicit current ownership and must never import that result.
  const replyId = (message: ProjectMessageObservation) =>
    isRecord(message.workReply) ? message.workReply.workId : undefined;
  const ownsWork = (value: unknown) => validId(record.id) && value === record.id;
  const ownsHuman = (value: unknown) => validId(record.messageId) && value === record.messageId;
  const ownedId = (value: unknown) => validId(value) && owned.has(value);
  const compatible = (message: ProjectMessageObservation) =>
    !(
      (validId(message.workId) && message.workId !== record.id) ||
      (validId(replyId(message)) && replyId(message) !== record.id) ||
      (validId(message.turnId) && !(validId(message.turnId) && turns.has(message.turnId)))
    );
  const humans = messages.filter(
    (message) =>
      message.role === 'user' &&
      compatible(message) &&
      (ownsHuman(message.id) ||
        ownsWork(message.workId) ||
        ownsWork(replyId(message)) ||
        (validId(message.turnId) && turns.has(message.turnId)) ||
        ownedId(message.id)),
  );
  for (const message of humans) humanIds.add(message.id);
  const snapshot = (message: ProjectMessageObservation) =>
    entry(
      {
        messageId: message.id,
        turnId: message.turnId,
        at: message.time,
        text: message.text,
        attachments: message.attachments,
      },
      redact,
    );
  const original =
      previous.originalRequest || snapshot(humans.find((message) => ownsHuman(message.id)) || {}),
    updates = new Map(previous.humanUpdates.map((item) => [item.messageId, item])),
    results = new Map(previous.results.map((item) => [item.messageId, item]));
  for (const message of humans) {
    const saved = snapshot(message);
    if (saved && saved.messageId !== original?.messageId) updates.set(saved.messageId, saved);
  }
  for (const message of messages)
    if (
      message.role === 'assistant' &&
      message.status === 'completed' &&
      compatible(message) &&
      (ownsWork(message.workId) ||
        (validId(message.turnId) && turns.has(message.turnId)) ||
        humanIds.has(message.taskId) ||
        ownedId(message.id))
    ) {
      const saved = snapshot(message);
      if (saved) results.set(saved.messageId, saved);
    }
  const latest = (map: ReadonlyMap<string, ProjectContextEntry>) =>
    [...map.values()].sort((a, b) => a.at - b.at).slice(-8);
  return boundedContext({
    version: 1,
    referenceDataOnly: true,
    updatedAt: at,
    originalRequest: original,
    humanUpdates: latest(updates),
    results: latest(results),
  });
}
export function projectContextView(
  record: ProjectRecordObservation,
  messages: readonly ProjectMessageObservation[],
  options: ProjectContextOptions = {},
) {
  const savedAt =
    (isRecord(record.projectContext) ? record.projectContext.updatedAt : undefined) ??
    record.updatedAt;
  return captureProjectContext(record, messages, {
    ...options,
    at: options.at ?? (validTime(savedAt) ? savedAt : Date.now()),
  });
}
export function taskContextSnapshots<Value extends object>(records: readonly Value[]) {
  return records.map((record) => {
    if (!Object.hasOwn(record, 'projectContext') || !('projectContext' in record)) return record;
    const { projectContext, ...base } = record;
    return base;
  });
}
