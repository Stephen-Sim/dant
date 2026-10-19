import type { AtomicFileRenameOptions } from '../files/atomic-file-rename.mts';
import { isRecord } from '../contracts/json.mts';
interface NotificationRecord {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  at: number;
  observedAt: number;
  eligible: boolean;
  readAt?: number;
  deliveredAt?: number;
}
interface NotificationState {
  enabled: boolean;
  enabledAt: number | null;
  records: Record<string, NotificationRecord>;
}
interface NotificationOptions extends AtomicFileRenameOptions {
  now?: () => number;
  graceMs?: number;
}
interface NotificationMessage {
  id: string;
  role?: string;
  status?: string;
  text?: string;
  source?: { conversationId: string };
  attachments?: Array<{ name: string }>;
  read?: boolean;
  visibleAt?: number;
  receipt?: { readAt: number };
}
interface NotificationCompletion {
  id: string;
  at: number;
  messageIds: string[];
  readAt?: number | null;
}
interface NotificationSnapshot {
  messages: NotificationMessage[];
  completions: NotificationCompletion[];
  conversationId: string | null;
}
function restoreNotificationState(value: unknown): NotificationState {
  const result: NotificationState = { enabled: false, enabledAt: null, records: {} };
  if (!isRecord(value)) return result;
  result.enabled = value.enabled === true;
  result.enabledAt = typeof value.enabledAt === 'number' ? value.enabledAt : null;
  if (!isRecord(value.records)) return result;
  for (const [key, raw] of Object.entries(value.records)) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== 'string' ||
      typeof raw.at !== 'number' ||
      typeof raw.observedAt !== 'number' ||
      typeof raw.eligible !== 'boolean'
    )
      continue;
    const record: NotificationRecord = {
      id: raw.id,
      at: raw.at,
      observedAt: raw.observedAt,
      eligible: raw.eligible,
      conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : null,
      messageId: typeof raw.messageId === 'string' ? raw.messageId : null,
    };
    if (typeof raw.readAt === 'number') record.readAt = raw.readAt;
    if (typeof raw.deliveredAt === 'number') record.deliveredAt = raw.deliveredAt;
    result.records[key] = record;
  }
  return result;
}
function readSnapshot(value: unknown): NotificationSnapshot {
  if (!isRecord(value)) throw Error('Invalid notification snapshot.');
  const conversation = isRecord(value.conversation) ? value.conversation : {};
  const rawCompletions = value.completions || conversation.completions || [];
  const completions: NotificationCompletion[] = (
    Array.isArray(rawCompletions) ? rawCompletions : []
  ).flatMap((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.at !== 'number' ||
      !Number.isFinite(item.at)
    )
      return [];
    return [
      {
        id: item.id,
        at: item.at,
        messageIds: (Array.isArray(item.messageIds) ? item.messageIds : []).filter(
          (id: unknown): id is string => typeof id === 'string',
        ),
        ...(typeof item.readAt === 'number' || item.readAt === null ? { readAt: item.readAt } : {}),
      },
    ];
  });
  const messages: NotificationMessage[] = (
    Array.isArray(value.messages) ? value.messages : []
  ).flatMap((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string') return [];
    const source = isRecord(item.source) ? item.source : {},
      receipt = isRecord(item.receipt) ? item.receipt : {};
    return [
      {
        id: item.id,
        ...(typeof item.role === 'string' ? { role: item.role } : {}),
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        ...(typeof item.text === 'string' ? { text: item.text } : {}),
        ...(typeof source.conversationId === 'string'
          ? { source: { conversationId: source.conversationId } }
          : {}),
        ...(typeof item.read === 'boolean' ? { read: item.read } : {}),
        ...(typeof item.visibleAt === 'number' ? { visibleAt: item.visibleAt } : {}),
        ...(typeof receipt.readAt === 'number' ? { receipt: { readAt: receipt.readAt } } : {}),
        attachments: (Array.isArray(item.attachments) ? item.attachments : []).flatMap(
          (file: unknown) =>
            isRecord(file) && typeof file.name === 'string' ? [{ name: file.name }] : [],
        ),
      },
    ];
  });
  const conversationId =
    typeof value.conversationId === 'string'
      ? value.conversationId
      : typeof conversation.id === 'string'
        ? conversation.id
        : null;
  return { messages, completions, conversationId };
}
import fs from 'node:fs';
import path from 'node:path';
import { renameAtomicFileSync, pauseAtomicRename } from '../files/atomic-file-rename.mts';

const PREVIEW_LENGTH = 240;
function plainText(value: unknown) {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, 8192)
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!?\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:amp|lt|gt|quot|apos|#39);/g,
      (entity) =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" })[
          entity
        ] ?? entity,
    )
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~)([\s\S]*?)\1/g, '$2')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function boundedPreview(value: unknown) {
  const characters = Array.from(plainText(value));
  return characters.length > PREVIEW_LENGTH
    ? characters.slice(0, PREVIEW_LENGTH - 1).join('') + '…'
    : characters.join('');
}
function completionPreview(
  completion: NotificationCompletion,
  messages: ReadonlyMap<string, NotificationMessage>,
  conversationId: string | null,
) {
  // Only chat deliveries belong in a banner, never live speech or observer payloads.
  const deliveries = [...(completion.messageIds || [])]
    .reverse()
    .map((id) => messages.get(id))
    .filter(
      (message): message is NotificationMessage =>
        message?.role === 'assistant' &&
        message.status === 'completed' &&
        (!message.source?.conversationId || message.source.conversationId === conversationId),
    );
  for (const message of deliveries) {
    const text = boundedPreview(message.text);
    if (text) return text;
  }
  for (const message of deliveries) {
    const names = (message.attachments || [])
      .slice(0, 3)
      .map((file) => plainText(path.posix.basename(String(file.name || '').replace(/\\/g, '/'))))
      .filter(Boolean);
    if (names.length) return boundedPreview(names.join(' · '));
  }
  return '';
}

export class NotificationHub {
  readonly file: string;
  readonly now: () => number;
  readonly graceMs: number;
  readonly renameSync: (source: string, destination: string) => void;
  readonly platform: NodeJS.Platform;
  readonly pause: (milliseconds: number) => unknown;
  state: NotificationState;
  latest: NotificationCompletion[];
  previews: Map<string, string>;
  constructor(
    dataDir: string,
    {
      now = () => Date.now(),
      graceMs = 3000,
      renameSync = fs.renameSync,
      platform = process.platform,
      pause = pauseAtomicRename,
    }: NotificationOptions = {},
  ) {
    this.file = path.join(dataDir, 'notifications.json');
    this.now = now;
    this.graceMs = graceMs;
    this.renameSync = renameSync;
    this.platform = platform;
    this.pause = pause;
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = restoreNotificationState(saved);
    } catch {
      this.state = { enabled: false, enabledAt: null, records: {} };
    }
    this.state.records ||= {};
    this.latest = [];
    this.previews = new Map();
  }
  save() {
    const file = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.state), { mode: 0o600 });
    renameAtomicFileSync(file, this.file, {
      renameSync: this.renameSync,
      platform: this.platform,
      pause: this.pause,
    });
  }
  configure(enabled: boolean) {
    if (this.state.enabled === enabled) return;
    this.state.enabled = enabled;
    if (enabled) this.state.enabledAt = this.now();
    this.save();
  }
  observe(value: unknown) {
    const snapshot = readSnapshot(value),
      completions = snapshot.completions;
    this.latest = completions;
    const messages = new Map((snapshot.messages || []).map((message) => [message.id, message])),
      conversationId = snapshot.conversationId;
    this.previews = new Map();
    let changed = false;
    for (const completion of completions) {
      if (!completion.id || !Number.isFinite(completion.at)) continue;
      let record = this.state.records[completion.id];
      if (!record) {
        record = this.state.records[completion.id] = {
          id: completion.id,
          conversationId: snapshot.conversationId,
          messageId: completion.messageIds?.at(-1) || null,
          at: completion.at,
          observedAt: this.now(),
          eligible:
            this.state.enabled &&
            this.state.enabledAt !== null &&
            completion.at >= this.state.enabledAt,
        };
        changed = true;
      }
      if (record.conversationId === conversationId)
        this.previews.set(completion.id, completionPreview(completion, messages, conversationId));
      const ids = completion.messageIds || [],
        read =
          !!completion.readAt ||
          (ids.length > 0 &&
            ids.every((id) => {
              const message = messages.get(id);
              return message && (message.read || message.visibleAt || message.receipt?.readAt);
            }));
      if (read && !record.readAt) {
        record.readAt = this.now();
        changed = true;
      }
    }
    const all = Object.values(this.state.records);
    if (all.length > 1000) {
      const keep = new Set(completions.map((item) => item.id));
      for (const record of all.sort((a, b) => b.at - a.at).slice(1000))
        if (!keep.has(record.id)) delete this.state.records[record.id];
      changed = true;
    }
    if (changed) this.save();
  }
  pending() {
    if (!this.state.enabled) return [];
    return Object.values(this.state.records)
      .filter(
        (record) =>
          record.eligible &&
          !record.readAt &&
          !record.deliveredAt &&
          this.now() - record.observedAt >= this.graceMs,
      )
      .map(({ id, conversationId, messageId }) => ({
        id,
        conversationId,
        messageId,
        title: 'dant',
        body: this.previews.get(id) || '',
      }));
  }
  acknowledge(id: string) {
    const record = this.state.records[id];
    if (!record) throw Error('Unknown completion notification.');
    if (!record.deliveredAt) {
      record.deliveredAt = this.now();
      this.save();
    }
    return { ok: true };
  }
}
