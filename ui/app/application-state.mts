import { isLanguage } from '../../src/i18n/languages.mts';
import {
  ChatTaskStatus,
  ComputerControlStatus,
  ConnectionStatus,
  ContinuationDispatchPhase,
  PlanStepStatus,
  ServiceUpdateStatus,
  SubmissionStatus,
  TaskPriority,
  TaskProgressStage,
  TaskStatus,
  WorkStatus,
  isEnumValue,
} from '../../src/contracts/states.mts';
import type { TaskPlan, TaskPlanSummary, WorkContinuation } from '../../src/contracts/contracts.ts';
import type {
  AppState,
  AppSettings,
  ControllerState,
  WorkerState,
  TelegramStatus,
  ProvisioningState,
  VmProvider,
  VmProviderInfo,
  VmProfiles,
  LoginDetails,
  FontInventory,
  TelegramPairing,
  CallStartResult,
  SendResult,
  VoiceCatalogue,
} from './application-types.ts';
import type {
  Attachment,
  ChatMessage,
  VmSettings,
  UiActiveTask,
  UiCompletion,
  UiWorkRecord,
  WorkReplyTarget,
  CallState,
  UsageCounters,
  UsageSnapshot,
  UiServiceUpdate,
} from '../shared/contracts.mts';
import { isRecord } from '../shared/contracts.mts';
import {
  arrayOf,
  booleanValue as boolean,
  nullable,
  numberValue as number,
  objectOf,
  optional,
  stringValue as string,
  unknownValue,
  validated,
} from '../shared/validation.mts';
import type { Validator } from '../shared/validation.mts';

const strings = arrayOf(string);
const source = (value: unknown): value is 'chat' | 'voice' => value === 'chat' || value === 'voice';
const taskStatus = (value: unknown): value is NonNullable<ChatMessage['status']> =>
  isEnumValue(TaskStatus, value) ||
  value === 'streaming' ||
  value === 'read' ||
  value === 'sent' ||
  value === 'received';
const priority = (value: unknown): value is NonNullable<ChatMessage['progressPriority']> =>
  isEnumValue(TaskPriority, value);
const planStep = objectOf<TaskPlan['steps'][number]>({
  step: string,
  status: (value): value is TaskPlan['steps'][number]['status'] =>
    isEnumValue(PlanStepStatus, value),
});
const planSummary = objectOf<TaskPlanSummary>({
  total: number,
  completed: number,
  currentStep: string,
});
const plan = objectOf<TaskPlan>({
  total: number,
  completed: number,
  currentStep: string,
  steps: arrayOf(planStep),
});
const planOrSummary = (value: unknown): value is TaskPlan | TaskPlanSummary =>
  plan(value) || planSummary(value);
const continuation = objectOf<WorkContinuation>({
  nextAt: nullable(number),
  attempts: number,
  noProgressCount: number,
  lastCheckpoint: string,
  invalid: optional((value): value is true => value === true),
  dispatch: optional(
    objectOf<NonNullable<WorkContinuation['dispatch']>>({
      id: string,
      fromTurnId: string,
      runtimeId: string,
      threadId: string,
      phase: (value): value is NonNullable<WorkContinuation['dispatch']>['phase'] =>
        isEnumValue(ContinuationDispatchPhase, value),
      createdAt: number,
      turnId: optional(string),
    }),
  ),
});
export const attachment = objectOf<Attachment>({
  id: string,
  name: string,
  type: string,
  size: optional(number),
  sourcePath: optional(string),
  url: optional(string),
  text: optional(string),
});
const replyTarget = objectOf<WorkReplyTarget>({
  workId: string,
  turnId: string,
  conversationId: string,
});
const message = objectOf<ChatMessage>({
  id: string,
  role: (value): value is ChatMessage['role'] =>
    value === 'user' || value === 'assistant' || value === 'system',
  text: string,
  time: optional(number),
  status: optional(taskStatus),
  kind: optional(string),
  callId: optional(string),
  turnId: optional(nullable(string)),
  workId: optional(string),
  workKind: optional(string),
  voiceCallId: optional(string),
  clientMessageId: optional(string),
  attachments: optional(arrayOf(attachment)),
  editedAt: optional(number),
  read: optional(boolean),
  readAt: optional(nullable(number)),
  visibleAt: optional(nullable(number)),
  receipt: optional(
    objectOf<NonNullable<ChatMessage['receipt']>>({
      readAt: optional(nullable(number)),
      deliveredAt: optional(nullable(number)),
    }),
  ),
  replyTo: optional(nullable(string)),
  reactions: optional(strings),
  assistantReaction: optional(nullable(string)),
  receivedAt: optional(number),
  executorConfirmedAt: optional(nullable(number)),
  visibleAttachmentIds: optional(strings),
  seconds: optional(number),
  error: unknownValue,
  unknownOutcome: optional(boolean),
  submission: optional(nullable(string)),
  progressPriority: optional(priority),
  progressCompleted: optional(boolean),
  progressDismissed: optional(boolean),
  progressDismissedAt: optional(nullable(number)),
  workReply: optional(replyTarget),
});
const workRecord = objectOf<UiWorkRecord>({
  id: string,
  turnId: string,
  turnIds: strings,
  title: string,
  status: (value): value is UiWorkRecord['status'] => isEnumValue(WorkStatus, value),
  source,
  plan: nullable(plan),
  startedAt: number,
  updatedAt: number,
  executionEndedAt: optional(number),
  progressPriority: optional(priority),
  unknownOutcome: optional(boolean),
  submission: optional((value): value is NonNullable<UiWorkRecord['submission']> =>
    isEnumValue(SubmissionStatus, value),
  ),
  continuation: optional(continuation),
  messageId: optional(nullable(string)),
  provisional: optional(boolean),
  progressDismissedAt: optional(nullable(number)),
  pauseReason: optional(nullable(string)),
  projectContext: unknownValue,
});
const completion = objectOf<UiCompletion>({
  id: optional(string),
  turnId: string,
  taskId: optional(nullable(string)),
  messageIds: optional(strings),
  at: optional(number),
  work: optional(
    objectOf<NonNullable<UiCompletion['work']>>({
      source,
      status: (value): value is NonNullable<UiCompletion['work']>['status'] =>
        isEnumValue(TaskStatus, value),
      updatedAt: optional(number),
    }),
  ),
  progressPriority: optional(priority),
  progressDismissedAt: optional(nullable(number)),
  unknownOutcome: optional(boolean),
  submission: optional(nullable(string)),
  status: optional((value): value is NonNullable<UiCompletion['status']> =>
    isEnumValue(ChatTaskStatus, value),
  ),
});
const active = objectOf<UiActiveTask>({
  messageId: optional(nullable(string)),
  turnId: optional(nullable(string)),
  source: optional(source),
  background: optional(boolean),
  status: optional(
    (value): value is NonNullable<UiActiveTask['status']> =>
      value === TaskStatus.Running ||
      value === TaskStatus.WaitingUser ||
      value === TaskStatus.Pausing ||
      value === TaskStatus.Unknown,
  ),
  startedAt: optional(nullable(number)),
  updatedAt: optional(nullable(number)),
  step: optional((value): value is NonNullable<UiActiveTask['step']> =>
    isEnumValue(TaskProgressStage, value),
  ),
  plan: optional(planOrSummary),
  workId: optional(string),
  title: optional(string),
  visible: optional(boolean),
  messageIds: optional(strings),
  callId: optional(string),
  progressPriority: optional(priority),
  canSteer: optional(boolean),
});
const call = objectOf<CallState>({
  id: optional(string),
  callId: optional(string),
  provider: (value): value is CallState['provider'] => value === 'subscription' || value === 'api',
  status: optional(string),
  connectedAt: optional(nullable(number)),
  startedAt: optional(nullable(number)),
  seconds: optional(number),
});
export const vmSettings = objectOf<VmSettings>({
  host: optional(string),
  user: optional(string),
  port: optional(number),
  keyPath: optional(string),
  knownHosts: optional(string),
  provider: optional(string),
});
const theme = (value: unknown): value is 'light' | 'dark' | 'system' =>
  value === 'light' || value === 'dark' || value === 'system';
const settings = objectOf<AppSettings>({
  vm: vmSettings,
  language: optional(isLanguage),
  timeZone: optional(string),
  model: optional(string),
  nativeVoice: optional(string),
  voice: optional(string),
  apiVoice: optional(string),
  notifications: optional(boolean),
  showWorkSummary: optional(boolean),
  theme: optional(theme),
  themePreset: optional(
    (value): value is NonNullable<AppSettings['themePreset']> =>
      value === 'dant' || value === 'chatgpt' || value === 'warm' || value === 'custom',
  ),
  font: optional(
    (value): value is NonNullable<AppSettings['font']> =>
      value === 'system' || value === 'sans' || value === 'mono',
  ),
  fontFamily: optional(string),
  fontSize: optional(number),
  contentFontSize: optional(number),
  codeFontSize: optional(number),
  accentColor: optional(nullable(string)),
  backgroundColor: optional(nullable(string)),
  foregroundColor: optional(nullable(string)),
  reduceMotion: optional(
    (value): value is NonNullable<AppSettings['reduceMotion']> =>
      value === 'system' || value === 'reduce' || value === 'full',
  ),
});
const telegramSync = objectOf<NonNullable<TelegramStatus['sync']>>({
  forwardMode: optional(
    (value): value is 'unread' | 'all' => value === 'unread' || value === 'all',
  ),
  combineReplies: optional(boolean),
  readState: optional((value): value is 'independent' => value === 'independent'),
});
const identifier = (value: unknown): value is string | number => string(value) || number(value);
export const telegram = objectOf<TelegramStatus>({
  enabled: boolean,
  configured: boolean,
  connected: boolean,
  paired: boolean,
  bot: optional(nullable(objectOf<{ username?: string }>({ username: optional(string) }))),
  owner: optional(
    nullable(
      objectOf<{ userId?: string | number; chatId?: string | number }>({
        userId: optional(identifier),
        chatId: optional(identifier),
      }),
    ),
  ),
  pairing: optional(nullable(objectOf<{ expiresAt: number }>({ expiresAt: number }))),
  lastError: optional(nullable(string)),
  connectionError: optional(nullable(string)),
  delivery: optional(
    objectOf<NonNullable<TelegramStatus['delivery']>>({
      failed: number,
      unknown: number,
      lastIssue: optional(
        nullable(
          objectOf<{ status: string; reason?: string; at?: number | null }>({
            status: string,
            reason: optional(string),
            at: optional(nullable(number)),
          }),
        ),
      ),
    }),
  ),
  sync: optional(telegramSync),
});
const serviceUpdate = (value: unknown): value is UiServiceUpdate =>
  isRecord(value) &&
  isEnumValue(ServiceUpdateStatus, value.status) &&
  typeof value.confirmed === 'boolean' &&
  typeof value.targetVersion === 'string' &&
  (typeof value.runningVersion === 'string' || value.runningVersion === null) &&
  (typeof value.reason === 'string' || value.reason === null);
const connection = (value: unknown): value is WorkerState['status'] =>
  isEnumValue(ConnectionStatus, value);
const worker = objectOf<WorkerState>({
  status: connection,
  cached: optional(boolean),
  serviceUpdate: optional(serviceUpdate),
  error: optional(nullable(string)),
  account: optional(
    nullable(
      objectOf<NonNullable<WorkerState['account']>>({
        email: optional(string),
        planType: optional(string),
      }),
    ),
  ),
  models: arrayOf(
    objectOf<WorkerState['models'][number]>({ model: string, displayName: optional(string) }),
  ),
  realtime: optional(
    objectOf<NonNullable<WorkerState['realtime']>>({
      provider: optional(string),
      available: optional(boolean),
      key: optional(
        objectOf<{ configured?: boolean; source?: string | null }>({
          configured: optional(boolean),
          source: optional(nullable(string)),
        }),
      ),
      subscription: optional(objectOf<{ available?: boolean }>({ available: optional(boolean) })),
      api: optional(objectOf<{ available?: boolean }>({ available: optional(boolean) })),
    }),
  ),
  telegram: optional(telegram),
});
const controller = objectOf<ControllerState>({
  status: connection,
  cached: optional(boolean),
  serviceUpdate: optional(serviceUpdate),
  updatesPaused: optional(boolean),
  serviceUpdateBusy: optional(boolean),
});
const provider = objectOf<VmProvider>({
  id: string,
  available: boolean,
  reason: optional(nullable(string)),
});
export const providerInfo = objectOf<VmProviderInfo>({
  provider: optional(nullable(string)),
  availableProviders: arrayOf(provider),
});
export const provisioning = objectOf<ProvisioningState>({
  status: string,
  running: optional(boolean),
  provider: optional(nullable(string)),
  stage: optional(string),
  connection: optional(nullable(vmSettings)),
  availableProviders: optional(arrayOf(provider)),
  error: optional(nullable(string)),
});
const counters = objectOf<UsageCounters>({
  inputTokens: optional(nullable(number)),
  cachedInputTokens: optional(nullable(number)),
  outputTokens: optional(nullable(number)),
  reasoningOutputTokens: optional(nullable(number)),
  totalTokens: optional(nullable(number)),
  at: optional(number),
});
const usageSource = objectOf<NonNullable<UsageSnapshot['subscription']>>({
  available: optional(boolean),
  totals: optional(nullable(counters)),
  lastResponse: optional(nullable(counters)),
});
const usage = objectOf<UsageSnapshot>({
  recordedSince: optional(nullable(number)),
  subscription: optional(usageSource),
  apiVoice: optional(usageSource),
  activity: optional(
    objectOf<NonNullable<UsageSnapshot['activity']>>({
      timeZone: optional(string),
      days: optional(
        arrayOf(
          objectOf<NonNullable<NonNullable<UsageSnapshot['activity']>['days']>[number]>({
            date: string,
            subscription: optional(nullable(counters)),
            apiVoice: optional(nullable(counters)),
          }),
        ),
      ),
      unallocated: optional(
        objectOf<{ subscription?: UsageCounters | null; apiVoice?: UsageCounters | null }>({
          subscription: optional(nullable(counters)),
          apiVoice: optional(nullable(counters)),
        }),
      ),
    }),
  ),
});
const appState = objectOf<AppState>({
  mode: optional(
    (value): value is NonNullable<AppState['mode']> =>
      value === 'vm-controller' || value === 'vm-worker' || value === 'worker',
  ),
  conversationId: optional(string),
  settings,
  worker,
  controller: optional(controller),
  provisioning: optional(provisioning),
  computer: optional(
    objectOf<NonNullable<AppState['computer']>>({
      status: (value): value is string => isEnumValue(ComputerControlStatus, value),
      sessionId: optional(nullable(string)),
      acquiring: optional(boolean),
    }),
  ),
  messages: arrayOf(message),
  queue: optional(strings),
  active: optional(nullable(active)),
  call: optional(nullable(call)),
  work: optional(arrayOf(workRecord)),
  workTasks: optional(arrayOf(workRecord)),
  completions: optional(arrayOf(completion)),
  takeover: optional(boolean),
  capabilities: optional(
    objectOf<NonNullable<AppState['capabilities']>>({
      workReply: optional(boolean),
      taskReopen: optional(boolean),
      recurringSchedules: optional(boolean),
    }),
  ),
  memory: optional(string),
  memoryFiles: optional(
    arrayOf(objectOf<{ name: string; text: string }>({ name: string, text: string })),
  ),
  credentials: optional(
    (value): value is NonNullable<AppState['credentials']> =>
      isRecord(value) &&
      Array.isArray(value.items) &&
      value.items.every(
        (item: unknown) =>
          isRecord(item) &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          typeof item.service === 'string' &&
          (item.username === undefined || typeof item.username === 'string'),
      ) &&
      Array.isArray(value.requests) &&
      value.requests.every(
        (item: unknown) =>
          isRecord(item) &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          typeof item.service === 'string' &&
          (item.reason === undefined || typeof item.reason === 'string'),
      ) &&
      (value.error === undefined ||
        typeof value.error === 'boolean' ||
        typeof value.error === 'string'),
  ),
  skills: optional(
    (value): value is NonNullable<AppState['skills']> =>
      isRecord(value) &&
      Array.isArray(value.items) &&
      value.items.every(
        (item: unknown) =>
          isRecord(item) &&
          typeof item.name === 'string' &&
          typeof item.description === 'string' &&
          typeof item.enabled === 'boolean' &&
          (item.path === undefined || typeof item.path === 'string'),
      ) &&
      (value.error === undefined ||
        typeof value.error === 'boolean' ||
        typeof value.error === 'string'),
  ),
  schedules: optional(
    arrayOf(
      (value): value is NonNullable<AppState['schedules']>[number] =>
        isRecord(value) &&
        typeof value.id === 'string' &&
        typeof value.text === 'string' &&
        number(value.at) &&
        typeof value.status === 'string' &&
        ['pending', 'paused', 'dispatched', 'unknown'].includes(value.status) &&
        (value.cron === undefined || value.cron === null || string(value.cron)) &&
        (value.priority === undefined || priority(value.priority)) &&
        (value.timeZone === undefined || string(value.timeZone)),
    ),
  ),
  telegram: optional(telegram),
  usage: optional(usage),
});
export const readAppState = (value: unknown): AppState =>
  validated(value, appState, 'application state');
export const profiles = objectOf<VmProfiles>({
  candidates: arrayOf(
    objectOf<VmProfiles['candidates'][number]>({
      id: string,
      host: optional(string),
      user: optional(string),
      port: optional(number),
      keyPath: optional(string),
      knownHosts: optional(string),
      provider: optional(string),
      label: optional(string),
      directory: optional(string),
    }),
  ),
  current: optional(
    nullable(
      objectOf<NonNullable<VmProfiles['current']>>({
        id: string,
        host: optional(string),
        user: optional(string),
        port: optional(number),
        keyPath: optional(string),
        knownHosts: optional(string),
        provider: optional(string),
        label: optional(string),
        directory: optional(string),
      }),
    ),
  ),
  error: optional(string),
});
export const login = objectOf<LoginDetails>({ userCode: string, verificationUrl: string });
export const fonts = objectOf<FontInventory>({ fonts: strings, source: optional(string) });
export const pairing = objectOf<TelegramPairing>({
  code: string,
  expiresAt: number,
  url: optional(string),
  botUrl: optional(string),
});
export const callStart = objectOf<CallStartResult>({
  callId: optional(string),
  sdp: optional(string),
  transport: optional(objectOf<{ sdp?: string }>({ sdp: optional(string) })),
});
export const sendResult = objectOf<SendResult>({
  unknownOutcome: optional(boolean),
  submission: optional(string),
  message: optional(objectOf<{ submission?: string }>({ submission: optional(string) })),
});
const voiceList = (value: unknown): value is NonNullable<VoiceCatalogue['voices']> =>
  strings(value) ||
  objectOf<{ v1?: string[]; v2?: string[]; v3?: string[] }>({
    v1: optional(strings),
    v2: optional(strings),
    v3: optional(strings),
  })(value);
export const voices = objectOf<VoiceCatalogue>({
  v1: optional(strings),
  v2: optional(strings),
  v3: optional(strings),
  voices: optional(voiceList),
  nativeV3: optional(strings),
  apiV2: optional(strings),
  api: optional(objectOf<{ voices?: string[] }>({ voices: optional(strings) })),
});
export const read = <T,>(value: unknown, validator: Validator<T>, label: string): T =>
  validated(value, validator, label);
