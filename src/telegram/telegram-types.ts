import type fs from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { WorkMessage } from '../work/engine-types.ts';
import type { MessagePatch } from '../conversation/types.ts';
import type { Store } from '../conversation/store.mts';
import type { AttachmentStore } from '../files/attachments.mts';
import type { ChatMessage } from '../conversation/types.ts';
import type { TaskPlan } from '../contracts/contracts.ts';
export interface TelegramActive {
  messageIds?: string[];
  messageId?: string | null;
  turnId?: string | null;
}
export interface TelegramSession {
  background?: boolean;
  unknown?: boolean;
  submitting?: unknown;
  stopping?: boolean;
  pausing?: boolean;
  turns?: Map<string, { done?: boolean; resultSaved?: boolean; pendingSubmissions?: number }>;
}
export interface TelegramEngine extends Pick<EventEmitter, 'on' | 'off'> {
  worker?: { status?: string };
  queue: WorkMessage[];
  active: TelegramActive | null;
  call?: { provider?: string } | null;
  progress?: TelegramCurrent | null;
  nativeVoice?: {
    active?: TelegramCurrent | null;
    progress?: TelegramCurrent | null;
    session?: TelegramSession | null;
    pendingHandoffs?(session: TelegramSession): boolean;
  } | null;
  takeover?: boolean;
  acquiring?: boolean;
  pendingFollowups?: { size: number };
  callReferences?: { size: number };
  redact?(text: string): string;
  task(id: string): WorkMessage | null | undefined;
  safeUpdate(id: string, patch: MessagePatch): unknown;
  waitStopped(active: TelegramActive): Promise<unknown>;
  change(): void;
  pause(): unknown;
  resumePaused(ids: string[], options: { confirmUnknown: boolean }): unknown;
  enqueue(message: WorkMessage, options?: { interactive?: boolean }): unknown;
}
export interface TelegramOptions {
  dataDir?: string;
  store?: Pick<Store, 'state' | 'save' | 'update' | 'add'>;
  engine?: TelegramEngine;
  attachments?: Pick<AttachmentStore, 'read' | 'put'>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  delay?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  autoPoll?: boolean;
  pollTimeout?: number;
  retryBaseMs?: number;
  mirrorGraceMs?: number;
  renameSync?: typeof fs.renameSync;
  platform?: NodeJS.Platform;
  pause?: (ms: number) => unknown;
}
export interface TelegramOwner {
  chatId: string;
  userId: string;
  pairingId: string;
  syncVersion?: number;
  conversationId?: string;
}
export interface TelegramBot {
  id: string;
  username: string;
}
export interface OutboxMetadata {
  id: string;
  deliveryId?: string;
  localMessageId?: string;
  taskId?: string;
  mirrorRole?: ChatMessage['role'];
  caption?: string;
}
export type OutboxBase = OutboxMetadata &
  ({ kind: 'text'; text: string } | { kind: 'document'; attachmentId: string });
export type TelegramOutboxItem = OutboxBase & {
  botId: string;
  chatId: string;
  userId: string;
  pairingId?: string;
  status: string;
  attempts: number;
  at: number;
  error?: string | null | undefined;
  failureAt?: number;
  failureReason?: string;
  lastAttemptAt?: number;
  notBefore?: number;
  sentAt?: number;
  documentFallback?: boolean;
  notificationSilent?: boolean;
  telegramMessageId?: string | null;
};
export interface TelegramReceipt {
  id: number;
  status: string;
  at?: number;
}
export interface TelegramConfig {
  version: number;
  deliveryVersion: number;
  forwardMode: 'unread' | 'all';
  combineReplies: boolean;
  enabled: boolean;
  token: string | null;
  bot: TelegramBot | null;
  owner: TelegramOwner | null;
  offset: number;
  pairing: { hash: string; expiresAt: number } | null;
  outbox: TelegramOutboxItem[];
  receipts: TelegramReceipt[];
  resultKeys: string[];
  lastError: string | null | undefined;
  pollError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}
export interface TelegramFile {
  file_id?: string;
  file_size?: number;
  file_name?: string;
  width?: number;
  height?: number;
}
export interface TelegramMessage {
  message_id?: unknown;
  text?: string;
  caption?: string;
  chat?: { id?: unknown; type?: string };
  from?: { id?: unknown; is_bot?: boolean };
  photo?: TelegramFile[];
  voice?: TelegramFile;
  document?: TelegramFile;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}
export interface TelegramResult {
  id?: unknown;
  is_bot?: unknown;
  username?: unknown;
  url?: unknown;
  file_path?: unknown;
  file_size?: unknown;
  message_id?: unknown;
}
export interface TelegramApiOptions {
  token?: string | null;
  signal?: AbortSignal;
}
export interface TelegramConfigureInput {
  token?: unknown;
  enabled?: unknown;
  forwardMode?: unknown;
  combineReplies?: unknown;
}
export interface TelegramRecent {
  title: string;
  status: string | undefined;
  at: number | null;
  taskId: string | null;
  voice?: boolean;
}
export interface TelegramCurrent {
  messageId?: string | null | undefined;
  messageIds?: string[];
  turnId?: string | null | undefined;
  workId?: string;
  status?: string;
  visible?: boolean;
  title?: string;
  background?: boolean;
  source?: string;
  startedAt?: number | null;
  updatedAt?: number | null;
  plan?:
    | TaskPlan
    | { steps?: TaskPlan['steps']; total?: number; completed?: number; currentStep?: string }
    | undefined;
}
