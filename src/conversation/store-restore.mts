import { isRecord, includesValue } from '../contracts/json.mts';
import { TaskStatus, TaskPriority, SubmissionStatus, isEnumValue } from '../contracts/states.mts';
import { normalizeLanguage } from '../i18n/languages.mts';
import { safeCompletionWork } from '../work/task-progress.mts';
import type {
  ChatMessage,
  ChatAttachment,
  MessageSource,
  TelegramMirrorMarker,
  TelegramDeliveryMarker,
  ChatCompletion,
  ConversationStoreState,
  ConversationSettings,
  SpokenReference,
  CallInputReference,
} from './types.ts';
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry: unknown): entry is string => typeof entry === 'string')
    : [];
function attachment(value: unknown): ChatAttachment | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const result: ChatAttachment = { id: value.id };
  for (const key of [
    'name',
    'type',
    'hash',
    'sha256',
    'guestPath',
    'path',
    'sourcePath',
    'transcription',
  ] as const)
    if (typeof value[key] === 'string') result[key] = value[key];
  if (typeof value.size === 'number') result.size = value.size;
  if (typeof value.unavailable === 'boolean') result.unavailable = value.unavailable;
  return result;
}
function source(value: unknown): MessageSource | undefined {
  if (!isRecord(value) || !includesValue(['telegram', 'voice-call', 'desktop'], value.type))
    return undefined;
  const result: MessageSource = { type: value.type };
  for (const key of ['conversationId', 'pairingId'] as const)
    if (typeof value[key] === 'string') result[key] = value[key];
  for (const key of ['botId', 'chatId', 'userId', 'messageId'] as const)
    if (typeof value[key] === 'string' || typeof value[key] === 'number' || value[key] === null)
      result[key] = value[key];
  if (typeof value.updateId === 'number') result.updateId = value.updateId;
  return result;
}
function mirror(value: unknown): TelegramMirrorMarker | undefined {
  if (!isRecord(value) || typeof value.pairingId !== 'string') return undefined;
  const result: TelegramMirrorMarker = { pairingId: value.pairingId };
  if (typeof value.historical === 'boolean') result.historical = value.historical;
  if (typeof value.text === 'string' || value.text === null) result.text = value.text;
  if (typeof value.textAt === 'number') result.textAt = value.textAt;
  if (Array.isArray(value.files))
    result.files = value.files.flatMap((file: unknown) =>
      isRecord(file) && typeof file.id === 'string' && typeof file.status === 'string'
        ? [{ id: file.id, status: file.status }]
        : [],
    );
  return result;
}
function delivery(value: unknown): TelegramDeliveryMarker | undefined {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.pairingId !== 'string')
    return undefined;
  const result: TelegramDeliveryMarker = { key: value.key, pairingId: value.pairingId };
  if (typeof value.replyThroughId === 'string' || value.replyThroughId === null)
    result.replyThroughId = value.replyThroughId;
  if (typeof value.scheduledAt === 'number') result.scheduledAt = value.scheduledAt;
  if (includesValue(['scheduling', 'scheduled', 'historical', 'unknown', 'failed'], value.status))
    result.status = value.status;
  return result;
}
export function restoreChatMessage(value: unknown): ChatMessage | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !includesValue(['user', 'assistant', 'system'], value.role)
  )
    return null;
  const result: ChatMessage = {
    id: value.id,
    role: value.role,
    time: typeof value.time === 'number' ? value.time : 0,
    reactions: strings(value.reactions),
    read: value.read === true,
  };
  for (const key of [
    'text',
    'voiceCallId',
    'callId',
    'clientMessageId',
    'kind',
    'scheduleId',
    'workId',
    'parentTaskId',
  ] as const)
    if (typeof value[key] === 'string') result[key] = value[key];
  for (const key of [
    'turnId',
    'taskId',
    'messageId',
    'replyTo',
    'pauseReason',
    'error',
    'assistantReaction',
  ] as const)
    if (typeof value[key] === 'string' || value[key] === null) result[key] = value[key];
  for (const key of [
    'cancelledAt',
    'executionEndedAt',
    'receivedAt',
    'editedAt',
    'reactionUpdatedAt',
    'assistantReactionUpdatedAt',
    'readAt',
    'visibleAt',
    'scheduledAt',
    'seconds',
  ] as const)
    if (typeof value[key] === 'number') result[key] = value[key];
  for (const key of [
    'progressDismissedAt',
    'executorConfirmedAt',
    'queuedAt',
    'acceptedAt',
  ] as const)
    if (typeof value[key] === 'number' || value[key] === null) result[key] = value[key];
  for (const key of ['unknownOutcome', 'voice', 'scheduled', 'starred', 'pinned'] as const)
    if (typeof value[key] === 'boolean') result[key] = value[key];
  if (Array.isArray(value.attachments))
    result.attachments = value.attachments
      .map(attachment)
      .filter((file): file is ChatAttachment => file !== null);
  if (Array.isArray(value.visibleAttachmentIds))
    result.visibleAttachmentIds = strings(value.visibleAttachmentIds);
  if (Array.isArray(value.messageIds)) result.messageIds = strings(value.messageIds);
  if (Array.isArray(value.turnIds)) result.turnIds = strings(value.turnIds);
  if (isEnumValue(TaskStatus, value.status) || includesValue(['read', 'streaming'], value.status))
    result.status = value.status;
  else if (value.status !== undefined) {
    result.status = TaskStatus.Unknown;
    result.unknownOutcome = true;
  }
  if (isEnumValue(SubmissionStatus, value.submission) || value.submission === null)
    result.submission = value.submission;
  else if (value.submission !== undefined) {
    result.submission = SubmissionStatus.Unknown;
    result.unknownOutcome = true;
  }
  if (Object.hasOwn(value, 'progressPriority'))
    result.progressPriority = isEnumValue(TaskPriority, value.progressPriority)
      ? value.progressPriority
      : TaskPriority.Normal;
  if (includesValue(['task', 'voice', 'conversation'], value.workKind))
    result.workKind = value.workKind;
  if (includesValue(['subscription', 'api'], value.provider)) result.provider = value.provider;
  const origin = source(value.source),
    mirrorMarker = mirror(value.telegramMirror),
    deliveryMarker = delivery(value.telegramDelivery),
    work = safeCompletionWork(value.work);
  if (origin) result.source = origin;
  if (mirrorMarker) result.telegramMirror = mirrorMarker;
  if (deliveryMarker) result.telegramDelivery = deliveryMarker;
  if (work) result.work = work;
  if (isRecord(value.receipt) && typeof value.receipt.readAt === 'number')
    result.receipt = { readAt: value.receipt.readAt };
  if (
    isRecord(value.workReply) &&
    typeof value.workReply.workId === 'string' &&
    typeof value.workReply.turnId === 'string' &&
    typeof value.workReply.conversationId === 'string'
  )
    result.workReply = {
      workId: value.workReply.workId,
      turnId: value.workReply.turnId,
      conversationId: value.workReply.conversationId,
    };
  if (
    isRecord(value.callContext) &&
    typeof value.callContext.callId === 'string' &&
    includesValue(['pending', 'submitted', 'unknown', 'failed'], value.callContext.status)
  )
    result.callContext = { callId: value.callContext.callId, status: value.callContext.status };
  if (isRecord(value.voiceContext) && typeof value.voiceContext.status === 'string') {
    const context: NonNullable<ChatMessage['voiceContext']> = { status: value.voiceContext.status };
    for (const key of ['callId', 'messageId', 'contextId', 'kind', 'error'] as const)
      if (typeof value.voiceContext[key] === 'string') context[key] = value.voiceContext[key];
    result.voiceContext = context;
  }
  return result;
}
function completion(value: unknown): ChatCompletion | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const result: ChatCompletion = { id: value.id, messageIds: strings(value.messageIds) };
  if (typeof value.turnId === 'string') result.turnId = value.turnId;
  if (typeof value.at === 'number') result.at = value.at;
  if (typeof value.readAt === 'number' || value.readAt === null) result.readAt = value.readAt;
  if (typeof value.taskId === 'string' || value.taskId === null) result.taskId = value.taskId;
  if (typeof value.progressDismissedAt === 'number' || value.progressDismissedAt === null)
    result.progressDismissedAt = value.progressDismissedAt;
  if (Object.hasOwn(value, 'progressPriority'))
    result.progressPriority = isEnumValue(TaskPriority, value.progressPriority)
      ? value.progressPriority
      : TaskPriority.Normal;
  const work = safeCompletionWork(value.work);
  if (work) result.work = work;
  return result;
}
function settings(value: unknown): ConversationSettings {
  const raw = isRecord(value) ? value : {},
    vm = isRecord(raw.vm) ? raw.vm : {};
  const result: ConversationSettings = {
    language: normalizeLanguage(raw.language),
    voice: typeof raw.voice === 'string' ? raw.voice : 'marin',
    model: typeof raw.model === 'string' ? raw.model : '',
    notifications: raw.notifications !== false,
    showWorkSummary: raw.showWorkSummary === true,
    showCallCaptions: raw.showCallCaptions !== false,
    vm: {
      host: typeof vm.host === 'string' ? vm.host : '',
      user: typeof vm.user === 'string' ? vm.user : 'dant',
      port: typeof vm.port === 'number' ? vm.port : 22,
      keyPath: typeof vm.keyPath === 'string' ? vm.keyPath : '',
      knownHosts: typeof vm.knownHosts === 'string' ? vm.knownHosts : '',
    },
  };
  for (const key of ['nativeVoice', 'apiVoice', 'timeZone'] as const)
    if (typeof raw[key] === 'string') result[key] = raw[key];
  return result;
}
function spoken(value: unknown): SpokenReference | null {
  if (
    !isRecord(value) ||
    !includesValue(['user', 'assistant'], value.role) ||
    typeof value.text !== 'string'
  )
    return null;
  return {
    role: value.role,
    text: value.text,
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
    ...(typeof value.itemId === 'string' ? { itemId: value.itemId } : {}),
    ...(typeof value.at === 'number' ? { at: value.at } : {}),
    ...(includesValue(['pending', 'submitted', 'unknown', 'failed'], value.status)
      ? { status: value.status }
      : {}),
  };
}
function inputReference(value: unknown): CallInputReference | null {
  if (
    !isRecord(value) ||
    typeof value.conversationId !== 'string' ||
    typeof value.callId !== 'string' ||
    typeof value.messageId !== 'string' ||
    value.role !== 'user' ||
    typeof value.text !== 'string' ||
    typeof value.at !== 'number' ||
    !includesValue(['pending', 'submitted', 'unknown', 'failed'], value.submission)
  )
    return null;
  const result: CallInputReference = {
    conversationId: value.conversationId,
    callId: value.callId,
    messageId: value.messageId,
    role: value.role,
    text: value.text,
    at: value.at,
    replyTo: typeof value.replyTo === 'string' ? value.replyTo : null,
    quotedMessage: null,
    attachments: strings(value.attachments),
    submission: value.submission,
  };
  const quote = value.quotedMessage;
  if (
    isRecord(quote) &&
    typeof quote.messageId === 'string' &&
    includesValue(['user', 'assistant'], quote.role) &&
    typeof quote.text === 'string'
  )
    result.quotedMessage = {
      messageId: quote.messageId,
      role: quote.role,
      text: quote.text,
      attachments: strings(quote.attachments),
    };
  return result;
}
export function restoreConversationState(value: unknown): {
  state: ConversationStoreState;
  rawWorkTasks: unknown[];
  rawSchedules: unknown;
  rawTokenUsage: unknown;
} {
  if (!isRecord(value)) throw Error('Conversation state is invalid');
  const result: ConversationStoreState = {
    version: 2,
    conversationId: typeof value.conversationId === 'string' ? value.conversationId : '',
    messages: (Array.isArray(value.messages) ? value.messages : [])
      .map(restoreChatMessage)
      .filter((message): message is ChatMessage => message !== null),
    memory: typeof value.memory === 'string' ? value.memory : '',
    settings: settings(value.settings),
    threadId: typeof value.threadId === 'string' ? value.threadId : null,
    threadRuntime: typeof value.threadRuntime === 'string' ? value.threadRuntime : null,
    schedules: [],
    completions: (Array.isArray(value.completions) ? value.completions : [])
      .map(completion)
      .filter((entry): entry is ChatCompletion => entry !== null),
    workTasks: [],
    deletedClientMessageIds: strings(value.deletedClientMessageIds),
  };
  if (typeof value.threadConversationId === 'string')
    result.threadConversationId = value.threadConversationId;
  if (isRecord(value.presence))
    result.presence = {
      lastActiveAt:
        typeof value.presence.lastActiveAt === 'number' ? value.presence.lastActiveAt : null,
    };
  if (Array.isArray(value.deletedScheduleRequestIds))
    result.deletedScheduleRequestIds = strings(value.deletedScheduleRequestIds);
  if (Array.isArray(value.voiceHistory))
    result.voiceHistory = value.voiceHistory
      .map(spoken)
      .filter((entry): entry is SpokenReference => entry !== null);
  if (Array.isArray(value.callInputHistory))
    result.callInputHistory = value.callInputHistory
      .map(inputReference)
      .filter((entry): entry is CallInputReference => entry !== null);
  if (
    isRecord(value.memoryMigration) &&
    typeof value.memoryMigration.version === 'number' &&
    typeof value.memoryMigration.completedAt === 'number' &&
    typeof value.memoryMigration.truncated === 'boolean'
  )
    result.memoryMigration = {
      version: value.memoryMigration.version,
      completedAt: value.memoryMigration.completedAt,
      truncated: value.memoryMigration.truncated,
    };
  return {
    state: result,
    rawWorkTasks: Array.isArray(value.workTasks) ? value.workTasks : [],
    rawSchedules: value.schedules,
    rawTokenUsage: value.tokenUsage,
  };
}
