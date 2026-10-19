import { isRecord, includesValue } from '../contracts/json.mts';
import type { OutboxBase, TelegramConfig, TelegramOutboxItem } from './telegram-types.ts';
const outboxStatuses = ['queued', 'sending', 'sent', 'suppressed', 'failed', 'unknown'] as const;
const receiptStatuses = ['processing', 'done', 'failed', 'unknown'] as const;
const invalid = (): never => {
  throw Error('Telegram configuration is invalid');
};
function outboxEntry(value: unknown): TelegramOutboxItem {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.botId !== 'string' ||
    typeof value.chatId !== 'string' ||
    typeof value.userId !== 'string' ||
    !includesValue(outboxStatuses, value.status) ||
    typeof value.attempts !== 'number' ||
    typeof value.at !== 'number'
  )
    return invalid();
  let payload: OutboxBase;
  if (value.kind === 'text' && typeof value.text === 'string')
    payload = { id: value.id, kind: 'text', text: value.text };
  else if (value.kind === 'document' && typeof value.attachmentId === 'string')
    payload = { id: value.id, kind: 'document', attachmentId: value.attachmentId };
  else return invalid();
  const result: TelegramOutboxItem = {
    ...payload,
    botId: value.botId,
    chatId: value.chatId,
    userId: value.userId,
    status: value.status,
    attempts: value.attempts,
    at: value.at,
  };
  for (const key of [
    'deliveryId',
    'localMessageId',
    'taskId',
    'caption',
    'pairingId',
    'failureReason',
  ] as const)
    if (typeof value[key] === 'string') result[key] = value[key];
  for (const key of ['failureAt', 'lastAttemptAt', 'notBefore', 'sentAt'] as const)
    if (typeof value[key] === 'number') result[key] = value[key];
  for (const key of ['documentFallback', 'notificationSilent'] as const)
    if (typeof value[key] === 'boolean') result[key] = value[key];
  if (typeof value.error === 'string' || value.error === null) result.error = value.error;
  if (typeof value.telegramMessageId === 'string' || value.telegramMessageId === null)
    result.telegramMessageId = value.telegramMessageId;
  if (includesValue(['user', 'assistant', 'system'], value.mirrorRole))
    result.mirrorRole = value.mirrorRole;
  return result;
}
/** Restore only validated persisted metadata; interrupted operations remain unreplayable. */
export function restoreTelegramConfig(value: unknown, defaults: TelegramConfig): TelegramConfig {
  if (!isRecord(value)) return invalid();
  const result: TelegramConfig = { ...defaults };
  for (const key of ['version', 'deliveryVersion', 'offset'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'number') return invalid();
      result[key] = value[key];
    }
  }
  for (const key of ['combineReplies', 'enabled'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') return invalid();
      result[key] = value[key];
    }
  }
  if (value.forwardMode !== undefined) {
    if (!includesValue(['unread', 'all'], value.forwardMode)) return invalid();
    result.forwardMode = value.forwardMode;
  }
  if (value.token !== undefined) {
    if (typeof value.token !== 'string' && value.token !== null) return invalid();
    result.token = value.token;
  }
  for (const key of ['lastError', 'pollError'] as const)
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' && value[key] !== null) return invalid();
      result[key] = value[key];
    }
  for (const key of ['lastInboundAt', 'lastOutboundAt'] as const)
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'number' && value[key] !== null) return invalid();
      result[key] = value[key];
    }
  if (value.bot !== undefined && value.bot !== null) {
    if (
      !isRecord(value.bot) ||
      typeof value.bot.id !== 'string' ||
      typeof value.bot.username !== 'string'
    )
      return invalid();
    result.bot = { id: value.bot.id, username: value.bot.username };
  }
  if (value.owner !== undefined && value.owner !== null) {
    const owner = value.owner;
    if (
      !isRecord(owner) ||
      typeof owner.chatId !== 'string' ||
      typeof owner.userId !== 'string' ||
      typeof owner.pairingId !== 'string'
    )
      return invalid();
    result.owner = {
      chatId: owner.chatId,
      userId: owner.userId,
      pairingId: owner.pairingId,
      ...(typeof owner.syncVersion === 'number' ? { syncVersion: owner.syncVersion } : {}),
      ...(typeof owner.conversationId === 'string' ? { conversationId: owner.conversationId } : {}),
    };
  }
  if (value.pairing !== undefined && value.pairing !== null) {
    const pairing = value.pairing;
    if (
      !isRecord(pairing) ||
      typeof pairing.hash !== 'string' ||
      typeof pairing.expiresAt !== 'number'
    )
      return invalid();
    result.pairing = { hash: pairing.hash, expiresAt: pairing.expiresAt };
  }
  if (value.outbox !== undefined) {
    if (!Array.isArray(value.outbox)) return invalid();
    result.outbox = value.outbox.map(outboxEntry);
  }
  if (value.receipts !== undefined) {
    if (!Array.isArray(value.receipts)) return invalid();
    result.receipts = value.receipts.map((receipt) => {
      if (
        !isRecord(receipt) ||
        typeof receipt.id !== 'number' ||
        (receipt.at !== undefined && typeof receipt.at !== 'number') ||
        !includesValue(receiptStatuses, receipt.status)
      )
        return invalid();
      return {
        id: receipt.id,
        status: receipt.status,
        ...(typeof receipt.at === 'number' ? { at: receipt.at } : {}),
      };
    });
  }
  if (value.resultKeys !== undefined) {
    if (
      !Array.isArray(value.resultKeys) ||
      !value.resultKeys.every((key): key is string => typeof key === 'string')
    )
      return invalid();
    result.resultKeys = value.resultKeys;
  }
  return result;
}
