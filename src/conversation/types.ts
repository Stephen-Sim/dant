import type {
  WorkRecord as SharedWorkRecord,
  WorkContinuation,
  VoiceCompletionWork,
} from '../contracts/contracts.ts';
import type { TaskStatusValue, TaskPriorityValue } from '../contracts/states.mts';
import type { LanguageCode } from '../i18n/languages.mts';

/** Persisted messages can contain legacy or unavailable attachment references. */
export interface ChatAttachment {
  id: string;
  name?: string;
  type?: string;
  size?: number;
  hash?: string;
  sha256?: string;
  guestPath?: string;
  path?: string;
  sourcePath?: string;
  transcription?: string;
  unavailable?: boolean;
}
export interface WorkReplyTarget {
  workId: string;
  turnId: string;
  conversationId: string;
}
export interface ProgressMetadata {
  id: string;
  turnId?: string | null | undefined;
  turnIds?: string[];
  workId?: string | undefined;
  taskId?: string | null | undefined;
  messageId?: string | null;
  messageIds?: string[];
  role?: 'user' | 'assistant' | 'system';
  parentTaskId?: string | null | undefined;
  voiceCallId?: string;
  status?: TaskStatusValue | 'streaming' | 'read';
  work?: VoiceCompletionWork;
  progressPriority?: TaskPriorityValue | undefined;
  progressDismissedAt?: number | null | undefined;
  unknownOutcome?: boolean;
  submission?:
    'preparing' | 'submitting' | 'confirmed' | 'unknown' | 'not-submitted' | 'rejected' | null;
  continuation?: WorkContinuation;
  executionEndedAt?: number;
}
export interface MessageSource {
  type: 'telegram' | 'voice-call' | 'desktop';
  conversationId?: string;
  botId?: string | number | null;
  userId?: string | number | null;
  chatId?: string | number | null;
  pairingId?: string;
  updateId?: number;
  messageId?: string | number | null;
}
export interface TelegramDeliveryMarker {
  key: string;
  pairingId: string;
  replyThroughId?: string | null;
  scheduledAt?: number;
  status?: 'scheduling' | 'scheduled' | 'historical' | 'unknown' | 'failed';
}
export interface TelegramMirrorMarker {
  pairingId: string;
  historical?: boolean;
  text?: string | null;
  files?: Array<{ id: string; status: string }>;
  textAt?: number;
}
export interface ChatMessage extends ProgressMetadata {
  role: 'user' | 'assistant' | 'system';
  cancelledAt?: number;
  time: number;
  text?: string;
  attachments?: ChatAttachment[];
  reactions: string[];
  assistantReaction?: string | null;
  reactionUpdatedAt?: number;
  assistantReactionUpdatedAt?: number;
  read: boolean;
  readAt?: number;
  visibleAt?: number;
  visibleAttachmentIds?: string[];
  receipt?: { readAt?: number };
  replyTo?: string | null;
  clientMessageId?: string;
  receivedAt?: number;
  queuedAt?: number | null;
  executorConfirmedAt?: number | null;
  acceptedAt?: number | null;
  editedAt?: number;
  starred?: boolean;
  pinned?: boolean;
  parentTaskId?: string | null | undefined;
  pauseReason?: string | null;
  error?: string | null | undefined;
  source?: MessageSource;
  workKind?: 'task' | 'voice' | 'conversation';
  workReply?: WorkReplyTarget;
  callId?: string;
  voiceCallId?: string;
  voice?: boolean;
  kind?: string;
  provider?: 'subscription' | 'api';
  seconds?: number;
  voiceContext?: {
    callId?: string | undefined;
    messageId?: string | undefined;
    contextId?: string | undefined;
    kind?: string | undefined;
    status: string;
    error?: string;
  };
  scheduled?: boolean;
  scheduledAt?: number;
  scheduleId?: string;
  callContext?: { callId: string; status: 'pending' | 'submitted' | 'unknown' | 'failed' };
  telegramDelivery?: TelegramDeliveryMarker;
  telegramMirror?: TelegramMirrorMarker;
}
export interface ProjectContextEntry {
  messageId: string;
  turnId?: string;
  at: number;
  text: string;
  attachments: Array<{ id: string; name: string; type: string; size?: number }>;
}
export interface ProjectContext {
  version: 1;
  referenceDataOnly: true;
  updatedAt: number;
  originalRequest: ProjectContextEntry | null;
  humanUpdates: ProjectContextEntry[];
  results: ProjectContextEntry[];
}
export interface StoredWorkRecord extends SharedWorkRecord {
  messageId: string | null;
  progressDismissedAt?: number | null | undefined;
  role?: 'user' | 'assistant' | 'system';
  taskId?: string | null | undefined;
  messageIds?: string[];
  pauseReason?: string | null;
  cancelledAt?: number;
  provisional?: boolean;
  projectContext?: ProjectContext;
}
export interface ChatCompletion extends ProgressMetadata {
  turnId?: string;
  messageIds: string[];
  taskId?: string | null | undefined;
  at?: number;
  readAt?: number | null;
  work?: VoiceCompletionWork;
}
export interface VmSettings {
  host: string;
  user: string;
  port: number;
  keyPath: string;
  knownHosts: string;
}
export interface ConversationSettings {
  language: LanguageCode;
  voice: string;
  nativeVoice?: string;
  apiVoice?: string;
  model: string;
  notifications: boolean;
  showWorkSummary: boolean;
  showCallCaptions: boolean;
  vm: VmSettings;
  timeZone?: string;
}
export interface SpokenReference {
  status?: 'pending' | 'submitted' | 'unknown' | 'failed';
  callId?: string;
  itemId?: string;
  role: 'user' | 'assistant';
  text: string;
  at?: number;
}
export interface QuotedCallMessage {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  attachments: string[];
}
export interface CallInputReference {
  conversationId: string;
  callId: string;
  messageId: string;
  role: 'user';
  text: string;
  at: number;
  replyTo: string | null;
  quotedMessage: QuotedCallMessage | null;
  attachments: string[];
  submission: 'pending' | 'submitted' | 'unknown' | 'failed';
}
export interface ConversationStoreState {
  version: number;
  conversationId: string;
  messages: ChatMessage[];
  memory: string;
  memoryMigration?: { version: number; completedAt: number; truncated: boolean };
  settings: ConversationSettings;
  threadId: string | null;
  threadRuntime: string | null;
  threadConversationId?: string;
  schedules: import('../schedules/schedule-types.ts').ScheduleRecord[];
  completions: ChatCompletion[];
  workTasks: StoredWorkRecord[];
  presence?: { lastActiveAt: number | null } | undefined;
  deletedClientMessageIds: string[];
  deletedScheduleRequestIds?: string[];
  voiceHistory?: SpokenReference[];
  callInputHistory?: CallInputReference[];
  tokenUsage?: import('../settings/token-usage-types.ts').TokenUsageState;
}
export type MessageInput = Pick<ChatMessage, 'role'> & Partial<Omit<ChatMessage, 'role'>>;
export type MessagePatch = {
  [Key in keyof Omit<ChatMessage, 'id' | 'role' | 'time'>]?: ChatMessage[Key] | undefined;
};
export type ProgressKind = 'task' | 'work' | 'completion';
export interface ProgressDismissOptions {
  confirmUnfinished?: unknown;
  expectedTurnId?: unknown;
  expectedConversationId?: unknown;
}
export type RegisterWorkOptions = {
  workId?: string | undefined;
  turnId: string;
  messageId?: string | null | undefined;
  source?: 'chat' | 'voice';
  title: unknown;
  plan: unknown;
  startedAt?: number | undefined;
  status?: TaskStatusValue;
  observed?: unknown;
};
