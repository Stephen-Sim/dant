import { restoreTelegramConfig } from './telegram-config.mts';
import { isRecord, includesValue } from '../contracts/json.mts';
import { operationError } from '../runtime/errors.mts';
import type {
  TelegramOptions,
  TelegramConfig,
  TelegramOutboxItem,
  TelegramOwner,
  TelegramUpdate,
  TelegramMessage,
  TelegramResult,
  TelegramApiOptions,
  TelegramConfigureInput,
  TelegramReceipt,
  OutboxBase,
  OutboxMetadata,
  TelegramFile,
  TelegramCurrent,
  TelegramRecent,
} from './telegram-types.ts';
import type {
  ChatMessage,
  TelegramMirrorMarker,
  TelegramDeliveryMarker,
} from '../conversation/types.ts';
import type { WorkMessage } from '../work/engine-types.ts';
import type { JsonObject } from '../contracts/json.mts';
import { localizeMessages } from '../i18n/i18n.mts';
import { normalizeLanguage } from '../i18n/languages.mts';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  readBounded,
  inspectContent,
} from '../files/attachments.mts';
import { telegramFailureReason } from './telegram-errors.mts';

const API = 'https://api.telegram.org',
  MAX_CONFIG = 1024 * 1024,
  MAX_OUTBOX = 128;
const retryRenameCodes = new Set(['EPERM', 'EACCES', 'EBUSY']),
  pauseBuffer = new Int32Array(new SharedArrayBuffer(4));
const allowedMethods = new Set([
  'getMe',
  'getWebhookInfo',
  'getUpdates',
  'getFile',
  'sendMessage',
  'sendPhoto',
  'sendDocument',
]);
const terminal = new Set<string | undefined>(['review', 'completed', 'failed', 'paused']);
const failureReasons = new Set([
  'timeout',
  'network',
  'dns',
  'tls',
  'cancelled',
  'invalid-response',
  'response-too-large',
  'server',
  'rejected',
  'attachment',
  'unconfirmed',
]);
const telegramText = {
  zh: {
    help: '已连接 dant。发送文字、图片、文档或语音附件即可提交任务。\n/progress 工作进度（也支持 /porgress）\n/status 电脑、通话与队列状态\n/pause 暂停当前工作和队列，保留通话\n/resume [任务 ID] 继续已暂停任务\n/stop 仅停止本 Telegram 的任务\n/help 帮助',
    states: {
      running: '正在执行',
      continuing: '进行中',
      waiting_user: '等待你回复',
      pausing: '正在安全停止',
      unknown: '状态未确认',
      review: '待验收',
      paused: '已暂停',
      failed: '失败',
      completed: '已完成',
      cancelled: '已取消',
      queued: '排队中',
      draft: '草稿',
    },
    progress: '工作进度',
    computer: '电脑',
    online: '在线',
    offline: '离线或连接中',
    control: '电脑控制',
    human: '用户',
    call: '通话',
    inCall: '通话中',
    noCall: '未通话',
    delivery: '消息投递',
    awaitingConfirmation: '等待确认',
    current: '当前',
    state: '状态',
    background: '后台',
    elapsed: '已用时',
    lastUpdate: '最后更新',
    taskSteps: '任务步骤',
    steps: '步骤',
    noRunning: '当前没有正在执行的任务',
    unavailable: '无法确认工作状态，请在 dant 重新连接',
    ongoing: '进行中的任务',
    queued: '排队中',
    recent: '最近任务',
    voiceFollowup: '请在聊天中重新交办后续工作',
    task: '任务',
    voiceTask: '通话中交办的任务',
    receiveError: '消息未能执行。请在 dant 检查任务状态后再决定是否重新提交。',
    stopSuccess: '已停止此 Telegram 的当前任务，等待你重新决定下一步。',
    stopNone: '没有可停止的 Telegram 当前任务。桌面任务和通话保持原状。',
    pauseUsage: '用法：/pause（暂停当前工作及队列，通话保持连接）。',
    pauseNone: '当前没有可暂停的任务。',
    pauseSuccess: '工作和队列已暂停，通话保持原状。',
    pauseUnconfirmed: '尚未确认任务已经暂停，请在 dant 查看工作进度；通话不会由此命令挂断。',
    connectFirst: '请先在 dant 连接工作电脑。',
    returnControl: '请先归还电脑控制权。',
    endSubscription: '请先结束订阅语音通话，再继续已暂停的任务。',
    activeUnconfirmed: '当前任务仍在执行或状态未确认，请先在 dant 查看工作进度。',
    resumeNotFound: '没有找到该已暂停或失败的任务，请使用完整任务 ID。',
    resumeChoose: '有多项已暂停任务，请明确选择：',
    resumeNone: '没有可继续的已暂停任务。通话任务请在聊天中重新交办。',
    resumeUnknown: '这个任务的提交结果未确认，不能自动重试。请先在 dant 检查并明确确认重试。',
    resumeSuccess: '已请求继续任务。',
    resumeProgress: '/progress 查看进度',
    resumeFailed: '任务未能继续，请在 dant 检查任务状态和控制权。',
    attachmentPrompt: '请检查 Telegram 附件。',
    desktop: '你 · 桌面',
    workFinished: '任务已结束，等待你在 dant 验收。',
    submissionUnknown: '任务提交结果未确认，不会自动重试。请先在 dant 检查。',
    taskPaused: '任务已暂停，请在 dant 查看。',
    taskFailed: '任务未能完成，请在 dant 查看。',
  },
  en: {
    help: 'Connected to dant. Send text, photos, documents or voice files to request work.\n/progress Shared work progress (also /porgress)\n/status Computer, call and queue status\n/pause Pause shared work and queue, keep the call\n/resume [task ID] Resume a paused task\n/stop Stop only this Telegram’s tasks\n/help Help',
    states: {
      running: 'Working',
      continuing: 'In progress',
      waiting_user: 'Waiting for your reply',
      pausing: 'Stopping safely',
      unknown: 'Status unconfirmed',
      review: 'Awaiting review',
      paused: 'Paused',
      failed: 'Failed',
      completed: 'Completed',
      cancelled: 'Cancelled',
      queued: 'Queued',
      draft: 'Draft',
    },
    progress: 'Work progress',
    computer: 'Computer',
    online: 'Online',
    offline: 'Offline or connecting',
    control: 'Computer control',
    human: 'Human',
    call: 'Call',
    inCall: 'In a call',
    noCall: 'No call',
    delivery: 'Message delivery',
    awaitingConfirmation: 'Awaiting confirmation',
    current: 'Current',
    state: 'State',
    background: 'Background',
    elapsed: 'Elapsed',
    lastUpdate: 'Last update',
    taskSteps: 'Task steps',
    steps: 'Steps',
    noRunning: 'No task is running',
    unavailable: 'Work status is unavailable; reconnect in dant',
    ongoing: 'Ongoing tasks',
    queued: 'Queued',
    recent: 'Recent tasks',
    voiceFollowup: 'Continue with a new instruction in chat',
    task: 'Task',
    voiceTask: 'Task from a call',
    receiveError: 'This message could not be executed. Check dant before resubmitting.',
    stopSuccess: 'This Telegram task stopped. Resume it explicitly in dant if needed.',
    stopNone: 'No Telegram-owned active task to stop. Desktop work and calls were left alone.',
    pauseUsage: 'Usage: /pause (pause current work and queue, keep the call).',
    pauseNone: 'There is no current or queued work to pause.',
    pauseSuccess: 'Work and queue paused; the call was left unchanged.',
    pauseUnconfirmed:
      'Work has not confirmed it stopped. Check Work progress in dant; this command does not hang up the call.',
    connectFirst: 'Connect the work computer in dant first.',
    returnControl: 'Return computer control to dant before resuming.',
    endSubscription: 'End the subscription call before resuming paused work.',
    activeUnconfirmed:
      'Current work is still active or unconfirmed. Check Work progress in dant first.',
    resumeNotFound: 'No paused or failed task matches that full task ID.',
    resumeChoose: 'Choose a paused task explicitly:',
    resumeNone:
      'No paused chat task is available. Continue voice-only work with a new chat instruction.',
    resumeUnknown:
      'This task’s submission is unconfirmed and cannot be retried here. Inspect and explicitly confirm a retry in dant.',
    resumeSuccess: 'Task resume requested.',
    resumeProgress: '/progress Check progress',
    resumeFailed: 'The task could not resume. Check its state and computer ownership in dant.',
    attachmentPrompt: 'Please inspect the attached Telegram file.',
    desktop: 'You · desktop',
    workFinished: 'Work finished and awaits your review in dant.',
    submissionUnknown: 'Task submission is unconfirmed and will not be retried. Check dant first.',
    taskPaused: 'Task paused; check dant.',
    taskFailed: 'Task failed; check dant.',
  },
};
const validTime = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8640000000000000
    ? value
    : null;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identifier = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      resolve();
    };
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(Error('Telegram request cancelled'));
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
export function splitTelegramText(text: unknown) {
  const result = [];
  let remaining = String(text);
  while (remaining.length) {
    let end = Math.min(4096, remaining.length);
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining.charAt(end - 1))) end--;
    result.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return result;
}
// Telegram cannot open a VM filesystem path. The corresponding immutable
// attachment is delivered separately; keep its label, never fetch its URL.
export function telegramMirrorText(text: unknown) {
  return String(text).replace(/!?\[([^\]\n]*)\]\((<?[^)\n]+>?)\)/g, (match, label, target) => {
    let value = target.replace(/^<|>$/g, '');
    try {
      value = decodeURIComponent(value);
    } catch {
      return match;
    }
    return /^(?:file:|[a-z]:[/\\]|\/(?!\/)|\.{1,2}[/\\]|output[/\\])/i.test(value) ? label : match;
  });
}
async function responseBytes(response: Response, limit: number) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel?.().catch(() => {});
    throw Object.assign(Error('Telegram response exceeded its size limit'), {
      telegramPhase: 'response-too-large',
    });
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Telegram response body is unavailable');
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit)
        throw Object.assign(Error('Telegram response exceeded its size limit'), {
          telegramPhase: 'response-too-large',
        });
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (caughtError) {
    const error = telegramError(caughtError);
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

interface TelegramOperationError extends Error {
  code?: unknown;
  telegramCode?: number;
  telegramReason?: string;
  telegramPhase?: string;
  retryAfter?: number | null;
  unknownOutcome?: unknown;
}
function telegramError(value: unknown): TelegramOperationError {
  const error: TelegramOperationError = operationError(value);
  if (value && typeof value === 'object') {
    const code = Reflect.get(value, 'telegramCode'),
      retry = Reflect.get(value, 'retryAfter');
    if (typeof code === 'number') error.telegramCode = code;
    if (typeof retry === 'number' || retry === null) error.retryAfter = retry;
    for (const key of ['telegramReason', 'telegramPhase'] as const) {
      const field = Reflect.get(value, key);
      if (typeof field === 'string') error[key] = field;
    }
    if (typeof Reflect.get(value, 'unknownOutcome') === 'boolean')
      error.unknownOutcome = Reflect.get(value, 'unknownOutcome');
  }
  return error;
}
function readFile(value: unknown): TelegramFile | undefined {
  if (!isRecord(value)) return undefined;
  const file: TelegramFile = {};
  for (const key of ['file_id', 'file_name'] as const)
    if (typeof value[key] === 'string') file[key] = value[key];
  for (const key of ['file_size', 'width', 'height'] as const)
    if (typeof value[key] === 'number') file[key] = value[key];
  return file;
}
function readUpdate(value: unknown): TelegramUpdate | null {
  if (!isRecord(value) || typeof value.update_id !== 'number') return null;
  const update: TelegramUpdate = { update_id: value.update_id };
  if (isRecord(value.message)) {
    const raw = value.message,
      message: TelegramMessage = {};
    if (Object.hasOwn(raw, 'message_id')) message.message_id = raw.message_id;
    for (const key of ['text', 'caption'] as const)
      if (typeof raw[key] === 'string') message[key] = raw[key];
    if (isRecord(raw.chat))
      message.chat = {
        id: raw.chat.id,
        ...(typeof raw.chat.type === 'string' ? { type: raw.chat.type } : {}),
      };
    if (isRecord(raw.from))
      message.from = {
        id: raw.from.id,
        ...(typeof raw.from.is_bot === 'boolean' ? { is_bot: raw.from.is_bot } : {}),
      };
    for (const key of ['voice', 'document'] as const) {
      const file = readFile(raw[key]);
      if (file) message[key] = file;
    }
    if (Array.isArray(raw.photo))
      message.photo = raw.photo
        .map(readFile)
        .filter((file): file is TelegramFile => file !== undefined);
    update.message = message;
  }
  return update;
}
function readResult(value: unknown): TelegramResult {
  if (!isRecord(value)) return {};
  return {
    id: value.id,
    is_bot: value.is_bot,
    username: value.username,
    url: value.url,
    file_path: value.file_path,
    file_size: value.file_size,
    message_id: value.message_id,
  };
}
/** A disabled-by-default VM gateway. Only this private file contains the bot token. */
export class TelegramGateway extends EventEmitter {
  readonly mirrorGraceMs: number;
  readonly dir: string;
  readonly file: string;
  readonly store: NonNullable<TelegramOptions['store']>;
  readonly engine: NonNullable<TelegramOptions['engine']>;
  readonly attachments: NonNullable<TelegramOptions['attachments']>;
  readonly fetch: typeof fetch;
  now: () => number;
  readonly delay: NonNullable<TelegramOptions['delay']>;
  autoPoll: boolean;
  readonly pollTimeout: number;
  readonly retryBaseMs: number;
  renameSync: typeof fs.renameSync;
  platform: NodeJS.Platform;
  pause: NonNullable<TelegramOptions['pause']>;
  closed: boolean;
  connected: boolean;
  generation: number;
  closeAbort: AbortController;
  loopAbort: AbortController;
  mutations: Promise<unknown>;
  config: TelegramConfig;
  readonly engineListener: () => void;
  flushTimer: ReturnType<typeof setTimeout> | null = null;
  outboundTimer: ReturnType<typeof setTimeout> | null = null;
  loopTask: Promise<void> | null = null;
  outboundTask: Promise<void> | null = null;
  closePromise: Promise<void> | null = null;
  constructor({
    dataDir,
    store,
    engine,
    attachments,
    fetchImpl = fetch,
    now = Date.now,
    delay = sleep,
    autoPoll = true,
    pollTimeout = 25,
    retryBaseMs = 1000,
    mirrorGraceMs = 2500,
    renameSync = fs.renameSync,
    platform = process.platform,
    pause = (ms) => Atomics.wait(pauseBuffer, 0, 0, ms),
  }: TelegramOptions = {}) {
    super();
    if (!dataDir || !store || !engine || !attachments)
      throw Error('Telegram requires VM storage, engine and attachment storage');
    if (!Number.isFinite(mirrorGraceMs) || mirrorGraceMs < 0 || mirrorGraceMs > 30000)
      throw Error('Invalid Telegram mirror grace period');
    this.mirrorGraceMs = mirrorGraceMs;
    this.dir = path.resolve(dataDir);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.dir).isSymbolicLink())
      throw Error('Telegram data directory cannot be a link');
    this.file = path.join(this.dir, 'telegram.json');
    this.store = store;
    this.engine = engine;
    this.attachments = attachments;
    this.fetch = fetchImpl;
    this.now = now;
    this.delay = delay;
    this.autoPoll = autoPoll;
    this.pollTimeout = pollTimeout;
    this.retryBaseMs = retryBaseMs;
    this.renameSync = renameSync;
    this.platform = platform;
    this.pause = pause;
    this.closed = false;
    this.connected = false;
    this.generation = 0;
    this.closeAbort = new AbortController();
    this.loopAbort = new AbortController();
    this.mutations = Promise.resolve();
    this.config = {
      version: 1,
      deliveryVersion: 2,
      forwardMode: 'unread',
      combineReplies: true,
      enabled: false,
      token: null,
      bot: null,
      owner: null,
      offset: 0,
      pairing: null,
      outbox: [],
      receipts: [],
      resultKeys: [],
      lastError: null,
      pollError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    };
    if (fs.existsSync(this.file)) {
      const before = fs.lstatSync(this.file);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > MAX_CONFIG
      )
        throw Error('Telegram configuration must be a bounded regular private file');
      if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
      let legacyDeliveryHistory = false,
        forwardingDefaults = false;
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const opened = fs.fstatSync(fd);
        if (opened.ino !== before.ino || opened.dev !== before.dev)
          throw Error('Telegram configuration changed');
        const loaded: unknown = JSON.parse(readBounded(fd, MAX_CONFIG).toString('utf8'));
        if (!isRecord(loaded)) throw Error('Telegram configuration is invalid');
        legacyDeliveryHistory =
          !Object.hasOwn(loaded, 'deliveryVersion') &&
          Array.isArray(loaded.resultKeys) &&
          loaded.resultKeys.length > 0;
        forwardingDefaults =
          !Object.hasOwn(loaded, 'forwardMode') || !Object.hasOwn(loaded, 'combineReplies');
        this.config = restoreTelegramConfig(loaded, this.config);
      } finally {
        fs.closeSync(fd);
      }
      if (
        !Array.isArray(this.config.outbox) ||
        !Array.isArray(this.config.receipts) ||
        !Array.isArray(this.config.resultKeys) ||
        this.config.outbox.length > MAX_OUTBOX ||
        !Number.isSafeInteger(this.config.offset) ||
        this.config.offset < 0
      )
        throw Error('Telegram configuration is invalid');
      if (
        !includesValue(['unread', 'all'], this.config.forwardMode) ||
        typeof this.config.combineReplies !== 'boolean'
      )
        throw Error('Telegram forwarding configuration is invalid');
      let changed = forwardingDefaults;
      for (const item of this.config.outbox)
        if (item.status === 'sending') {
          item.status = 'unknown';
          item.error = 'Delivery was interrupted before confirmation and was not resent';
          changed = true;
        }
      for (const receipt of this.config.receipts)
        if (receipt.status === 'processing') {
          receipt.status = 'unknown';
          this.config.lastError = 'A Telegram update was interrupted; its task was not replayed';
          changed = true;
        }
      for (const item of this.config.outbox)
        if (!item.pairingId) {
          const owner = this.config.owner;
          if (
            owner &&
            item.botId === this.config.bot?.id &&
            item.chatId === owner.chatId &&
            item.userId === owner.userId
          )
            item.pairingId = owner.pairingId;
          else {
            item.status = 'failed';
            item.error = 'The Telegram pairing identity could not be confirmed';
          }
          changed = true;
        }
      if (legacyDeliveryHistory && this.config.owner) {
        for (const task of this.store.state.messages) {
          if (
            task.role !== 'user' ||
            !this.taskOwned(task) ||
            !terminal.has(task.status) ||
            task.telegramDelivery
          )
            continue;
          const legacyKey = `result:${task.id}:${task.turnId || 'unsubmitted'}:${includesValue(['review', 'completed'], task.status) ? 'result' : task.status}`,
            known = this.config.resultKeys.includes(legacyKey),
            replies = this.store.state.messages.filter(
              (message) =>
                message.role === 'assistant' &&
                message.taskId === task.id &&
                message.status === 'completed',
            );
          this.store.update(task.id, {
            telegramDelivery: {
              key: `result:${this.config.owner.pairingId}:${legacyKey.slice(7)}`,
              pairingId: this.config.owner.pairingId,
              replyThroughId: replies.at(-1)?.id || null,
              scheduledAt: this.now(),
              status: known ? 'scheduled' : 'unknown',
            },
          });
          if (!known)
            this.config.lastError =
              'Legacy Telegram delivery history was incomplete; past replies were not automatically resent';
        }
        this.config.deliveryVersion = 2;
        changed = true;
        if (this.config.owner) delete this.config.owner.syncVersion;
      }
      if (this.config.owner && this.ensureMirrorBaseline()) changed = true;
      if (changed) this.save();
    }
    this.engineListener = () => {
      if (this.closed || !this.config.enabled || !this.config.owner || this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        try {
          this.scanResults();
          this.kickOutbound();
        } catch {
          this.fail('Telegram results could not be queued');
        }
      }, 100);
      this.flushTimer.unref?.();
    };
    engine.on('change', this.engineListener);
  }
  words() {
    return localizeMessages(telegramText, normalizeLanguage(this.store.state.settings?.language));
  }
  status() {
    const c = this.config,
      issues = c.outbox.filter((item) => includesValue(['unknown', 'failed'], item.status)),
      latest = issues.reduce<TelegramOutboxItem | null>(
        (previous, item) =>
          !previous ||
          (validTime(item.failureAt) || validTime(item.lastAttemptAt) || validTime(item.at) || 0) >=
            (validTime(previous.failureAt) ||
              validTime(previous.lastAttemptAt) ||
              validTime(previous.at) ||
              0)
            ? item
            : previous,
        null,
      ),
      deliveryError = issues.some((item) => item.error === c.lastError),
      connectionError =
        c.enabled && !this.connected ? c.pollError || (!deliveryError ? c.lastError : null) : null;
    return {
      enabled: !!c.enabled,
      configured: !!c.token,
      connected: this.connected,
      bot: c.bot ? { id: c.bot.id, username: c.bot.username } : null,
      paired: !!c.owner,
      owner: c.owner ? { chatId: c.owner.chatId, userId: c.owner.userId } : null,
      pairing:
        c.pairing && c.pairing.expiresAt > this.now() ? { expiresAt: c.pairing.expiresAt } : null,
      lastError: c.lastError ? this.safe(c.lastError) : null,
      connectionError: connectionError ? this.safe(connectionError) : null,
      lastInboundAt: c.lastInboundAt || null,
      lastOutboundAt: c.lastOutboundAt || null,
      pendingOutbound: c.outbox.filter((item) => includesValue(['queued', 'sending'], item.status))
        .length,
      delivery: {
        failed: issues.filter((item) => item.status === 'failed').length,
        unknown: issues.filter((item) => item.status === 'unknown').length,
        lastIssue: latest
          ? {
              status: latest.status,
              at:
                validTime(latest.failureAt) ||
                validTime(latest.lastAttemptAt) ||
                validTime(latest.at),
              reason: failureReasons.has(latest.failureReason ?? '')
                ? latest.failureReason
                : latest.status === 'unknown'
                  ? 'unconfirmed'
                  : 'rejected',
            }
          : null,
      },
      sync: {
        mode: 'new-messages',
        forwardMode: c.forwardMode,
        combineReplies: c.combineReplies,
        readState: 'independent',
        active: !!c.enabled && !!c.owner && c.owner.syncVersion === 1,
        historyBackfill: false,
        edits: false,
        deletes: false,
        reactions: false,
      },
    };
  }
  connectionRestored() {
    const changed = !this.connected || !!this.config.pollError;
    this.connected = true;
    if (this.config.pollError) {
      if (this.config.lastError === this.config.pollError) this.config.lastError = null;
      this.config.pollError = null;
      this.save();
    }
    if (changed) this.change();
  }
  change() {
    this.emit('change', this.status());
  }
  safe(message: unknown) {
    let value = String(message);
    if (this.config.token) value = value.split(this.config.token).join('[redacted]');
    return value.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]').slice(0, 500);
  }
  fail(message: unknown) {
    this.config.lastError = this.safe(message);
    this.save();
    this.change();
  }
  save() {
    if (fs.existsSync(this.file)) {
      const info = fs.lstatSync(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw Error('Telegram configuration cannot be a link');
    }
    const content = JSON.stringify(this.config);
    if (Buffer.byteLength(content) > MAX_CONFIG)
      throw Error('Telegram configuration reached its storage limit');
    const temporary = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          this.renameSync(temporary, this.file);
          break;
        } catch (caughtError) {
          const error = telegramError(caughtError);
          if (
            this.platform !== 'win32' ||
            !(typeof error.code === 'string' && retryRenameCodes.has(error.code)) ||
            attempt === 5
          )
            throw error;
          this.pause((attempt + 1) * 10);
        }
      }
      if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(temporary);
      } catch (caughtError) {
        const error = telegramError(caughtError);
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  mutate<Result>(operation: () => Result | Promise<Result>) {
    const result = this.mutations.then(() => {
      if (this.closed) throw Error('Telegram gateway is closed');
      return operation();
    });
    this.mutations = result.catch(() => {});
    return result;
  }
  api(
    method: 'getUpdates',
    body?: JsonObject | FormData,
    options?: TelegramApiOptions,
  ): Promise<unknown>;
  api(
    method: string,
    body?: JsonObject | FormData,
    options?: TelegramApiOptions,
  ): Promise<TelegramResult>;
  async api(
    method: string,
    body: JsonObject | FormData = {},
    options: TelegramApiOptions = {},
  ): Promise<unknown> {
    if (!allowedMethods.has(method)) throw Error('Unsupported Telegram method');
    const token = options.token || this.config.token;
    if (!token) throw Error('Telegram token is not configured');
    const outgoing =
        method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument',
      signal = AbortSignal.any([
        this.closeAbort.signal,
        options.signal || this.loopAbort.signal,
        AbortSignal.timeout(method === 'getUpdates' ? (this.pollTimeout + 10) * 1000 : 30000),
      ]);
    let response: Response,
      data: unknown,
      phase = 'network';
    try {
      response = await this.fetch(`${API}/bot${token}/${method}`, {
        method: 'POST',
        redirect: 'error',
        ...(body instanceof FormData ? {} : { headers: { 'Content-Type': 'application/json' } }),
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal,
      });
      phase = 'parsing';
      data = JSON.parse((await responseBytes(response, 2 * 1024 * 1024)).toString('utf8'));
    } catch (caughtError) {
      const error = telegramError(caughtError);
      throw Object.assign(
        Error(
          outgoing
            ? 'Telegram delivery was not confirmed and was not resent'
            : 'Telegram could not be reached or returned an invalid response',
        ),
        {
          unknownOutcome: outgoing,
          telegramReason: telegramFailureReason(error, {
            signal,
            phase: error?.telegramPhase === 'response-too-large' ? 'response-too-large' : phase,
          }),
        },
      );
    }
    if (!isRecord(data))
      throw Object.assign(Error('Telegram returned an invalid delivery response'), {
        unknownOutcome: outgoing,
        telegramReason: 'invalid-response',
      });
    if (response.status >= 500 || !response.ok || data.ok !== true) {
      const apiCode =
          typeof data.error_code === 'number' &&
          Number.isInteger(data.error_code) &&
          data.error_code >= 400
            ? data.error_code
            : null,
        codes = [response.status, apiCode],
        code =
          codes.find((value) => value !== null && value >= 500) ||
          (codes.includes(429) ? 429 : response.status >= 400 ? response.status : apiCode),
        rejected = data?.ok === false && apiCode !== null;
      throw Object.assign(
        Error(
          rejected || response.status >= 500
            ? `Telegram rejected the request (${code})`
            : 'Telegram returned an invalid delivery response',
        ),
        {
          ...(code ? { telegramCode: code } : {}),
          retryAfter:
            rejected && code === 429
              ? Number(isRecord(data.parameters) ? data.parameters.retry_after : undefined) || null
              : null,
          unknownOutcome: outgoing && (!rejected || (code !== null && code >= 500)),
          telegramReason:
            code !== null && code >= 500 ? 'server' : rejected ? 'rejected' : 'invalid-response',
        },
      );
    }
    if (outgoing && !identifier(isRecord(data.result) ? data.result.message_id : undefined))
      throw Object.assign(
        Error('Telegram delivery did not return a valid acknowledgement and was not resent'),
        { unknownOutcome: true, telegramReason: 'invalid-response' },
      );
    return method === 'getUpdates' ? data.result : readResult(data.result);
  }
  async verify(token: string | null, enabled: boolean) {
    const me = await this.api('getMe', {}, { token, signal: this.closeAbort.signal });
    if (
      !identifier(me?.id) ||
      !me.is_bot ||
      typeof me.username !== 'string' ||
      !/^[a-zA-Z0-9_]{1,64}$/.test(me.username)
    )
      throw Error('Telegram did not return a valid bot identity');
    if (enabled) {
      const webhook = await this.api(
        'getWebhookInfo',
        {},
        { token, signal: this.closeAbort.signal },
      );
      if (webhook?.url)
        throw Error(
          'This bot already has a webhook. Remove it in the service currently using the bot before enabling dant',
        );
    }
    return { id: String(me.id), username: me.username };
  }
  configure({ token, enabled, forwardMode, combineReplies }: TelegramConfigureInput = {}) {
    return this.mutate(async () => {
      if (enabled !== undefined && typeof enabled !== 'boolean')
        throw Error('Telegram enabled must be a boolean');
      if (
        token !== undefined &&
        (typeof token !== 'string' ||
          token.length > 512 ||
          !/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token))
      )
        throw Error('Enter a valid Telegram bot token');
      if (forwardMode !== undefined && !includesValue(['unread', 'all'], forwardMode))
        throw Error('Telegram forwarding mode must be unread or all');
      if (combineReplies !== undefined && typeof combineReplies !== 'boolean')
        throw Error('Telegram combine replies must be a boolean');
      if (token === undefined && enabled === undefined) {
        const previous = {
          forwardMode: this.config.forwardMode,
          combineReplies: this.config.combineReplies,
        };
        Object.assign(this.config, {
          forwardMode: forwardMode ?? previous.forwardMode,
          combineReplies: combineReplies ?? previous.combineReplies,
        });
        try {
          this.save();
        } catch (caughtError) {
          const error = telegramError(caughtError);
          Object.assign(this.config, previous);
          throw error;
        }
        this.change();
        this.kickOutbound();
        return this.status();
      }
      const nextToken = token ?? this.config.token,
        nextEnabled = enabled ?? this.config.enabled;
      if (nextEnabled && !nextToken)
        throw Error('Configure a Telegram bot token before enabling it');
      const bot =
        nextToken && (token !== undefined || nextEnabled)
          ? await this.verify(nextToken, nextEnabled)
          : this.config.bot;
      await this.stopLoops();
      const previous = this.config;
      this.config = {
        ...previous,
        token: nextToken,
        bot,
        enabled: nextEnabled,
        forwardMode: forwardMode ?? previous.forwardMode,
        combineReplies: combineReplies ?? previous.combineReplies,
        lastError: null,
        pollError: null,
      };
      if (nextToken !== previous.token)
        Object.assign(this.config, {
          owner: null,
          offset: 0,
          pairing: null,
          outbox: [],
          receipts: [],
          resultKeys: [],
        });
      try {
        this.save();
      } catch (caughtError) {
        const error = telegramError(caughtError);
        this.config = previous;
        this.start();
        throw error;
      }
      this.change();
      this.start();
      return this.status();
    });
  }
  pair() {
    return this.mutate(async () => {
      if (!this.config.enabled || !this.config.token || !this.config.bot)
        throw Error('Enable a verified Telegram bot before pairing');
      if (this.config.owner)
        throw Error('Disconnect the current Telegram owner before pairing another');
      const code = randomBytes(16).toString('hex'),
        expiresAt = this.now() + 10 * 60 * 1000;
      this.config.pairing = { hash: digest(code), expiresAt };
      this.save();
      this.change();
      return { code, expiresAt, botUrl: `https://t.me/${this.config.bot.username}?start=${code}` };
    });
  }
  disconnect({ clearToken = false }: { clearToken?: unknown } = {}) {
    return this.mutate(async () => {
      if (typeof clearToken !== 'boolean') throw Error('clearToken must be a boolean');
      await this.stopLoops();
      Object.assign(this.config, { enabled: false, owner: null, pairing: null });
      if (clearToken) {
        this.config.token = null;
        this.config.bot = null;
        this.config.offset = 0;
      }
      for (const item of this.config.outbox)
        if (item.status === 'queued') {
          item.status = 'failed';
          item.error = 'Telegram was disconnected before delivery';
        }
      this.save();
      this.change();
      return this.status();
    });
  }
  start() {
    if (
      this.closed ||
      !this.autoPoll ||
      !this.config.enabled ||
      !this.config.token ||
      this.loopTask
    )
      return this.status();
    this.loopAbort = new AbortController();
    const generation = ++this.generation,
      signal = this.loopAbort.signal;
    this.loopTask = this.pollLoop(generation, signal)
      .catch(() => {
        this.config.lastError =
          'The Telegram gateway could not continue; check its VM configuration';
        this.change();
      })
      .finally(() => {
        if (this.generation === generation) {
          this.loopTask = null;
          this.connected = false;
          this.change();
        }
      });
    return this.status();
  }
  async pollLoop(generation: number, signal: AbortSignal) {
    let backoff = this.retryBaseMs,
      verified = false;
    while (
      !this.closed &&
      this.config.enabled &&
      generation === this.generation &&
      !signal.aborted
    ) {
      try {
        if (!verified) {
          const bot = await this.verify(this.config.token, true);
          if (generation !== this.generation || signal.aborted) return;
          this.config.bot = bot;
          this.save();
          this.connectionRestored();
          verified = true;
          this.scanResults();
          this.kickOutbound();
        }
        await this.pollOnce(signal);
        if (this.closed || signal.aborted || generation !== this.generation || !this.config.enabled)
          return;
        this.connectionRestored();
        backoff = this.retryBaseMs;
      } catch (caughtError) {
        const error = telegramError(caughtError);
        if (this.closed || signal.aborted || generation !== this.generation) return;
        this.connected = false;
        this.config.pollError = this.safe(error.message);
        this.fail(error.message);
        if (
          includesValue([401, 403, 409], error.telegramCode) ||
          /already has a webhook/.test(error.message)
        )
          return;
        try {
          await this.delay(
            Math.min(300000, Math.max(backoff, (error.retryAfter || 0) * 1000)),
            signal,
          );
        } catch {
          return;
        }
        backoff = Math.min(30000, backoff * 2);
      }
    }
  }
  async pollOnce(signal = this.loopAbort.signal) {
    if (!this.config.enabled || !this.config.token || !this.config.bot) return;
    const updates = await this.api(
      'getUpdates',
      {
        offset: this.config.offset,
        limit: 20,
        timeout: this.pollTimeout,
        allowed_updates: ['message'],
      },
      { signal },
    );
    if (!Array.isArray(updates) || updates.length > 100)
      throw Error('Telegram returned an invalid update list');
    for (const update of updates
      .map(readUpdate)
      .filter((update): update is TelegramUpdate => update !== null)
      .sort((a, b) => a.update_id - b.update_id)) {
      if (signal.aborted || this.closed) return;
      await this.receive(update);
    }
    if (!updates.length) await this.delay(200, signal);
  }
  owned(message: TelegramMessage | undefined) {
    const owner = this.config.owner;
    return (
      message?.chat?.type === 'private' &&
      !message.from?.is_bot &&
      owner &&
      identifier(message.chat.id) === owner.chatId &&
      identifier(message.from?.id) === owner.userId
    );
  }
  async receive(value: unknown) {
    const update = readUpdate(value);
    if (
      this.closed ||
      !this.config.enabled ||
      !this.config.bot ||
      !update ||
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0 ||
      update.update_id < this.config.offset
    )
      return;
    const id = update.update_id;
    if (this.config.receipts.some((item) => item.id === id)) {
      this.config.offset = Math.max(this.config.offset, id + 1);
      this.save();
      return;
    }
    const message = update.message;
    if (
      !message ||
      message.chat?.type !== 'private' ||
      !identifier(message.chat.id) ||
      !message.from ||
      !identifier(message.from.id) ||
      message.from.is_bot
    ) {
      this.config.offset = Math.max(this.config.offset, id + 1);
      this.save();
      return;
    }
    const text = typeof message.text === 'string' ? message.text : '',
      match = text.match(/^\/([a-z]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([^\n]*))?$/i),
      command = match?.[1]?.toLowerCase();
    if (!this.config.owner) {
      const pairing = this.config.pairing,
        code = match?.[2]?.trim() || '';
      if (
        command !== 'start' ||
        !pairing ||
        pairing.expiresAt <= this.now() ||
        !/^[0-9a-f]{32}$/.test(code) ||
        !/^[0-9a-f]{64}$/.test(pairing.hash || '') ||
        !timingSafeEqual(Buffer.from(digest(code), 'hex'), Buffer.from(pairing.hash, 'hex'))
      ) {
        this.config.offset = Math.max(this.config.offset, id + 1);
        this.save();
        return;
      }
      this.config.owner = {
        chatId: String(message.chat.id),
        userId: String(message.from.id),
        pairingId: randomBytes(16).toString('hex'),
      };
      this.ensureMirrorBaseline();
      this.config.pairing = null;
      this.save();
    }
    if (!this.owned(message)) {
      this.config.offset = Math.max(this.config.offset, id + 1);
      this.save();
      return;
    }
    const receipt: TelegramReceipt = { id, status: 'processing', at: this.now() };
    this.config.receipts.push(receipt);
    this.config.receipts = this.config.receipts.slice(-1000);
    this.config.lastInboundAt = this.now();
    this.save();
    try {
      if (command) await this.command(command, id, match?.[2]?.trim() || '');
      else await this.incoming(message, id);
      receipt.status = 'done';
    } catch {
      receipt.status = 'failed';
      this.config.lastError = 'A Telegram message could not be accepted; it was not replayed';
      if (
        !this.store.state.messages.some(
          (task) => task.clientMessageId === `tg:${this.config.bot?.id}:${id}`,
        )
      )
        this.queueText(`update:${id}:error`, this.words().receiveError);
    } finally {
      this.config.offset = Math.max(this.config.offset, id + 1);
      this.save();
      this.change();
      this.kickOutbound();
    }
  }
  publicText(value: unknown, limit = 240) {
    return this.safeText(this.engine.redact?.(String(value ?? '')) ?? String(value ?? ''))
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, limit);
  }
  workState() {
    const messages = this.store.state.messages,
      users = messages.filter(
        (message) =>
          message.role === 'user' &&
          message.kind !== 'call' &&
          message.workKind !== 'conversation' &&
          !(message.voiceCallId && !message.turnId),
      ),
      byId = new Map(messages.map((message) => [message.id, message])),
      native = this.engine.nativeVoice;
    const current: TelegramCurrent | null =
        this.engine.progress ||
        native?.progress ||
        (this.engine.active
          ? {
              messageId: this.engine.active.messageId,
              turnId: this.engine.active.turnId,
              status: 'unknown',
            }
          : native?.active
            ? { ...native.active, status: 'unknown' }
            : null),
      active =
        current?.visible === false &&
        !includesValue(['unknown', 'pausing', 'waiting_user'], current.status)
          ? null
          : current;
    const queue = this.engine.queue
        .map((message) => byId.get(message.id))
        .filter(
          (message): message is ChatMessage => message !== undefined && users.includes(message),
        ),
      queuedIds = new Set(queue.map((message) => message.id)),
      activeIds = new Set([active?.messageId, ...(active?.messageIds || [])].filter(Boolean));
    if (active?.turnId)
      for (const message of users) if (message.turnId === active.turnId) activeIds.add(message.id);
    const records = [],
      turns = new Set<string | null | undefined>(),
      recordIds = new Set(),
      registeredMessages = new Set();
    for (const record of [...(this.store.state.workTasks || [])].sort(
      (a, b) => (validTime(b.updatedAt) || 0) - (validTime(a.updatedAt) || 0),
    )) {
      if (!record?.id || !record.turnId || turns.has(record.turnId) || recordIds.has(record.id))
        continue;
      records.push(record);
      for (const id of [record.turnId, ...(record.turnIds || [])]) turns.add(id);
      recordIds.add(record.id);
      const message = record.messageId ? byId.get(record.messageId) : undefined;
      if (message?.role === 'user' && (!message.turnId || turns.has(message.turnId)))
        registeredMessages.add(message.id);
    }
    const currentRecord = records.find(
        (record) => active && (record.id === active.workId || record.turnId === active.turnId),
      ),
      currentMessage = users.find((message) => activeIds.has(message.id));
    const title = (
      entry: Pick<TelegramCurrent, 'title' | 'source'> | null,
      message?: ChatMessage | null,
    ) =>
      this.publicText(
        entry?.title ||
          message?.text ||
          message?.attachments?.map((file) => file.name).join(', ') ||
          (entry?.source === 'voice' ? this.words().voiceTask : this.words().task),
      );
    const recent: TelegramRecent[] = users
      .filter(
        (message) =>
          !activeIds.has(message.id) &&
          !queuedIds.has(message.id) &&
          !registeredMessages.has(message.id) &&
          !turns.has(message.turnId) &&
          !validTime(message.progressDismissedAt),
      )
      .map((message) => ({
        title: title(null, message),
        status: message.status === 'read' ? 'review' : message.status,
        at: validTime(message.time),
        taskId: message.id,
      }));
    for (const record of records) {
      const original = record.messageId ? byId.get(record.messageId) : undefined,
        message =
          messages.find((item) => item.role === 'user' && item.turnId === record.turnId) ||
          (original?.role === 'user' && !original.turnId ? original : null),
        ownsMessage = message?.role === 'user';
      if (
        validTime(record.progressDismissedAt) ||
        record.id === active?.workId ||
        record.turnId === active?.turnId ||
        (!active?.turnId && record.messageId !== null && activeIds.has(record.messageId)) ||
        (ownsMessage && record.messageId !== null && queuedIds.has(record.messageId))
      )
        continue;
      recent.push({
        title: title(record, ownsMessage ? message : null),
        status: record.status,
        at: validTime(record.updatedAt) || validTime(record.startedAt),
        taskId: ownsMessage ? message.id : null,
        voice: record.source === 'voice',
      });
    }
    for (const completion of this.store.state.completions || []) {
      if (
        !completion?.turnId ||
        turns.has(completion.turnId) ||
        validTime(completion.progressDismissedAt) ||
        completion.turnId === active?.turnId ||
        users.some((message) => message.id === completion.taskId) ||
        completion.work?.source !== 'voice' ||
        !includesValue(['review', 'failed', 'paused'], completion.work.status) ||
        !completion.messageIds?.some(
          (id) => byId.get(id)?.role === 'assistant' && byId.get(id)?.kind !== 'call',
        )
      )
        continue;
      turns.add(completion.turnId);
      recent.push({
        title: this.words().voiceTask,
        status: completion.work.status,
        at: validTime(completion.work.updatedAt) || validTime(completion.at),
        taskId: null,
        voice: true,
      });
    }
    recent.sort((a, b) => (b.at || 0) - (a.at || 0));
    const ongoing = recent.filter((item) =>
      includesValue(['continuing', 'waiting_user'], item.status),
    );
    return {
      active: active
        ? {
            ...active,
            title: title({ ...currentRecord, ...active }, currentMessage),
            plan: active.plan || currentRecord?.plan,
            startedAt:
              validTime(active.startedAt) ||
              validTime(currentRecord?.startedAt) ||
              validTime(currentMessage?.time),
            updatedAt: validTime(active.updatedAt) || validTime(currentRecord?.updatedAt),
          }
        : null,
      queue,
      ongoing,
      recent: recent.filter((item) => !ongoing.includes(item)).slice(0, 5),
      title,
    };
  }
  progressText({ brief = false } = {}) {
    const w = this.words(),
      { active, queue, ongoing, recent, title } = this.workState(),
      online = this.engine.worker?.status === 'online',
      stateLabel = (status: unknown) =>
        Object.entries(w.states).find(([key]) => key === status)?.[1] || w.states.unknown;
    const lines = [w.progress, `${w.computer}: ${online ? w.online : w.offline}`];
    if (this.engine.takeover || this.engine.acquiring) lines.push(`${w.control}: ${w.human}`);
    lines.push(`${w.call}: ${this.engine.call ? w.inCall : w.noCall}`);
    if (this.engine.pendingFollowups?.size || this.engine.callReferences?.size)
      lines.push(`${w.delivery}: ${w.awaitingConfirmation}`);
    if (active) {
      lines.push(
        `${w.current}: ${active.title}`,
        `${w.state}: ${stateLabel(online ? active.status : 'unknown')}${active.background ? ' · ' + w.background : ''}`,
      );
      if (active.startedAt) {
        const seconds = Math.max(0, Math.floor((this.now() - active.startedAt) / 1000));
        lines.push(
          `${w.elapsed}: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
        );
      }
      if (active.updatedAt)
        lines.push(`${w.lastUpdate}: ${new Date(active.updatedAt).toISOString()}`);
      if (!brief) {
        const steps = active.plan?.steps;
        if (Array.isArray(steps) && steps.length && steps.length <= 128) {
          lines.push(w.taskSteps + ':');
          for (const [index, item] of steps.entries())
            if (
              includesValue(['pending', 'inProgress', 'completed'], item?.status) &&
              typeof item.step === 'string'
            )
              lines.push(
                `${index + 1}. ${item.status === 'completed' ? '✓' : item.status === 'inProgress' ? '◉' : '○'} ${this.publicText(item.step)}`,
              );
        } else if (
          active.plan &&
          typeof active.plan.total === 'number' &&
          Number.isSafeInteger(active.plan.total) &&
          active.plan.total > 0 &&
          active.plan.total <= 128 &&
          typeof active.plan.completed === 'number' &&
          Number.isSafeInteger(active.plan.completed) &&
          active.plan.completed >= 0 &&
          active.plan.completed <= active.plan.total
        ) {
          lines.push(`${w.steps}: ${active.plan.completed}/${active.plan.total}`);
          if (active.plan.currentStep) lines.push(this.publicText(active.plan.currentStep));
        }
      }
    } else if (!ongoing.length) lines.push(online ? w.noRunning : w.unavailable);
    if (ongoing.length) {
      lines.push(w.ongoing + ':');
      for (const item of ongoing)
        lines.push(`• ${item.title} — ${stateLabel(!online ? 'unknown' : item.status)}`);
    }
    lines.push(`${w.queued}: ${queue.length}`);
    if (!brief) for (const message of queue) lines.push(`• ${title(null, message)}`);
    if (!brief && recent.length) {
      lines.push(w.recent + ':');
      for (const item of recent) {
        lines.push(
          `• ${item.title} — ${stateLabel(!online && includesValue(['running', 'waiting_user', 'pausing'], item.status) ? 'unknown' : item.status)}`,
        );
        if (item.taskId && includesValue(['paused', 'failed'], item.status))
          lines.push(`/resume ${item.taskId}`);
        else if (item.voice && item.status === 'paused') lines.push(w.voiceFollowup);
      }
    }
    return lines.join('\n');
  }
  async command(command: string, id: number, args = '') {
    const key = `command:${id}`,
      t = (key: Exclude<keyof typeof telegramText.en, 'states'>) => this.words()[key];
    if (command === 'stop') {
      const own = (message: WorkMessage | null | undefined) => this.taskOwned(message),
        active = this.engine.active;
      this.engine.queue = this.engine.queue.filter((message) => {
        if (!own(message)) return true;
        this.engine.safeUpdate(message.id, { status: 'paused', pauseReason: 'telegram-stop' });
        return false;
      });
      if (
        !this.engine.call &&
        active &&
        active.messageIds &&
        active.messageIds.every((messageId) => own(this.engine.task(messageId)))
      ) {
        await this.engine.waitStopped(active);
        this.queueText(key, t('stopSuccess'));
      } else this.queueText(key, t('stopNone'));
      this.engine.change();
      return;
    }
    if (command === 'progress' || command === 'porgress') {
      this.queueText(key, this.progressText());
      return;
    }
    if (command === 'status') {
      this.queueText(key, this.progressText({ brief: true }));
      return;
    }
    if (command === 'pause') {
      if (args) {
        this.queueText(key, t('pauseUsage'));
        return;
      }
      if (
        !this.engine.active &&
        !this.engine.nativeVoice?.active &&
        !this.engine.nativeVoice?.progress &&
        !this.engine.pendingFollowups?.size &&
        !this.engine.callReferences?.size &&
        !this.engine.queue.length
      ) {
        this.queueText(key, t('pauseNone'));
        return;
      }
      try {
        await this.engine.pause();
        this.queueText(key, t('pauseSuccess'));
      } catch {
        this.queueText(key, t('pauseUnconfirmed'));
      }
      return;
    }
    if (command === 'resume') {
      const session = this.engine.nativeVoice?.session;
      if (this.engine.worker?.status !== 'online') {
        this.queueText(key, t('connectFirst'));
        return;
      }
      if (this.engine.takeover || this.engine.acquiring) {
        this.queueText(key, t('returnControl'));
        return;
      }
      if (this.engine.call?.provider === 'subscription') {
        this.queueText(key, t('endSubscription'));
        return;
      }
      if (
        this.engine.active ||
        this.engine.progress ||
        this.engine.pendingFollowups?.size ||
        this.engine.callReferences?.size ||
        this.engine.nativeVoice?.active ||
        this.engine.nativeVoice?.progress ||
        (session &&
          (session.background ||
            session.unknown ||
            session.submitting ||
            session.stopping ||
            session.pausing ||
            this.engine.nativeVoice?.pendingHandoffs?.(session) ||
            [...(session.turns?.values?.() || [])].some(
              (turn) => !turn.done || !turn.resultSaved || turn.pendingSubmissions,
            )))
      ) {
        this.queueText(key, t('activeUnconfirmed'));
        return;
      }
      const paused = this.store.state.messages.filter(
          (message) =>
            message.role === 'user' && message.kind !== 'call' && message.status === 'paused',
        ),
        selected = args
          ? this.store.state.messages.find(
              (message) =>
                message.id === args &&
                message.role === 'user' &&
                message.kind !== 'call' &&
                includesValue(['paused', 'failed'], message.status),
            )
          : paused.length === 1
            ? paused[0]
            : null;
      if (!selected) {
        this.queueText(
          key,
          args
            ? t('resumeNotFound')
            : paused.length
              ? t('resumeChoose') +
                '\n' +
                paused
                  .map(
                    (message) =>
                      `/resume ${message.id} · ${this.publicText(message.text || t('task'))}`,
                  )
                  .join('\n')
              : t('resumeNone'),
        );
        return;
      }
      if (
        includesValue(['unknown', 'submitting'], selected.submission) ||
        selected.unknownOutcome
      ) {
        this.queueText(key, t('resumeUnknown'));
        return;
      }
      try {
        this.engine.resumePaused([selected.id], { confirmUnknown: false });
        this.queueText(key, `${t('resumeSuccess')}\n${selected.id}\n${t('resumeProgress')}`);
      } catch {
        this.queueText(key, t('resumeFailed'));
      }
      return;
    }
    this.queueText(key, t('help'));
  }
  taskOwned(message: WorkMessage | null | undefined) {
    const source = message?.source,
      owner = this.config.owner;
    return (
      source?.type === 'telegram' &&
      owner &&
      typeof owner.pairingId === 'string' &&
      source.pairingId === owner.pairingId &&
      source.botId === this.config.bot?.id &&
      source.chatId === owner.chatId &&
      source.userId === owner.userId
    );
  }
  async incoming(message: TelegramMessage, updateId: number) {
    const bot = this.config.bot,
      owner = this.config.owner;
    if (!bot || !owner) throw Error('Telegram pairing is unavailable');
    const clientMessageId = `tg:${bot.id}:${updateId}`;
    if (this.store.state.messages.some((item) => item.clientMessageId === clientMessageId)) return;
    const text = this.safeText(
      typeof message.text === 'string'
        ? message.text
        : typeof message.caption === 'string'
          ? message.caption
          : '',
    );
    if (text.length > 100000) throw Error('Telegram text exceeds the task limit');
    const candidates = [];
    if (Array.isArray(message.photo) && message.photo.length) {
      const photo = [...message.photo]
        .sort(
          (a, b) =>
            (b.file_size || (b.width ?? 0) * (b.height ?? 0)) -
            (a.file_size || (a.width ?? 0) * (a.height ?? 0)),
        )
        .find((file) => !file.file_size || file.file_size <= MAX_ATTACHMENT_BYTES);
      if (!photo) throw Error('Telegram photo exceeds 10 MiB');
      candidates.push({
        file: photo,
        name: `photo-${message.message_id || updateId}.jpg`,
        type: 'image/jpeg',
      });
    }
    for (const [key, name, type] of [
      ['document', 'document', undefined],
      ['voice', `voice-${message.message_id || updateId}.ogg`, 'audio/ogg'],
    ] as const)
      if (message[key])
        candidates.push({ file: message[key], name: message[key].file_name || name, type });
    if (!text.trim() && !candidates.length) return;
    if (candidates.length > MAX_MESSAGE_ATTACHMENTS) throw Error('Attach at most five files');
    const task = this.store.add({
      role: 'user',
      text: text || (message.voice ? '' : this.words().attachmentPrompt),
      attachments: [],
      clientMessageId,
      status: 'draft',
      source: {
        type: 'telegram',
        botId: bot.id,
        chatId: owner.chatId,
        userId: owner.userId,
        pairingId: owner.pairingId,
        updateId,
        ...(identifier(message.message_id) ? { messageId: identifier(message.message_id) } : {}),
      },
    });
    try {
      if (this.engine.queue.length >= 32) throw Error('The task queue is full');
      const attachments = [];
      for (const candidate of candidates) attachments.push(await this.download(candidate));
      this.store.update(task.id, { attachments, status: 'queued' });
      if (this.engine.queue.length >= 32) throw Error('The task queue is full');
      this.engine.enqueue(task, { interactive: true });
    } catch {
      this.engine.safeUpdate(task.id, {
        status: 'failed',
        error: 'Telegram attachment could not be received or the task queue is full',
      });
      throw Error('Telegram task was not queued');
    }
  }
  async download({
    file,
    name,
    type,
  }: {
    file: TelegramFile;
    name: string;
    type?: string | undefined;
  }) {
    if (
      typeof file?.file_id !== 'string' ||
      !file.file_id ||
      file.file_id.length > 1024 ||
      (file.file_size !== undefined &&
        (!Number.isSafeInteger(file.file_size) ||
          file.file_size < 0 ||
          file.file_size > MAX_ATTACHMENT_BYTES))
    )
      throw Error('Telegram file exceeds the attachment limit');
    const info = await this.api('getFile', { file_id: file.file_id });
    const remote = info?.file_path;
    if (
      typeof remote !== 'string' ||
      remote.length > 2048 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(remote) ||
      remote.split('/').some((part) => part === '.' || part === '..') ||
      (info.file_size !== undefined &&
        (typeof info.file_size !== 'number' ||
          !Number.isSafeInteger(info.file_size) ||
          info.file_size < 0 ||
          info.file_size > MAX_ATTACHMENT_BYTES))
    )
      throw Error('Telegram returned an unsafe file path or size');
    let data;
    try {
      const response = await this.fetch(`${API}/file/bot${this.config.token}/${remote}`, {
        redirect: 'error',
        signal: AbortSignal.any([
          this.closeAbort.signal,
          this.loopAbort.signal,
          AbortSignal.timeout(30000),
        ]),
      });
      if (!response.ok) throw Error('File request failed');
      data = await responseBytes(response, MAX_ATTACHMENT_BYTES);
    } catch {
      throw Error('Telegram file download failed or exceeded 10 MiB');
    }
    return this.attachments.put({ name, data, type });
  }
  queueText(id: string, text: unknown, extra: Partial<OutboxMetadata> = {}) {
    let accepted = true;
    for (const [index, chunk] of splitTelegramText(this.safeText(text)).entries())
      accepted =
        this.queue({ id: id + ':' + index, kind: 'text', text: chunk, ...extra }) && accepted;
    return accepted;
  }
  safeText(text: unknown) {
    return this.config.token
      ? String(text).split(this.config.token).join('[redacted]')
      : String(text);
  }
  queue(item: OutboxBase) {
    if (!this.config.owner || !this.config.bot) return false;
    if (this.config.outbox.some((prior) => prior.id === item.id)) return true;
    while (this.config.outbox.length >= MAX_OUTBOX) {
      const index = this.config.outbox.findIndex((prior) =>
        includesValue(['sent', 'suppressed'], prior.status),
      );
      if (index < 0) {
        this.config.lastError = 'Telegram delivery queue is full; new output was not sent';
        return false;
      }
      this.config.outbox.splice(index, 1);
    }
    this.config.outbox.push({
      ...item,
      botId: this.config.bot.id,
      chatId: this.config.owner.chatId,
      userId: this.config.owner.userId,
      pairingId: this.config.owner.pairingId,
      status: 'queued',
      attempts: 0,
      at: this.now(),
    });
    let accepted = true;
    if (Buffer.byteLength(JSON.stringify(this.config)) > MAX_CONFIG - 256 * 1024) {
      this.config.outbox.pop();
      this.config.lastError =
        'Telegram delivery queue reached its byte limit; new output was not sent';
      accepted = false;
    }
    this.save();
    return accepted;
  }
  resultKey(task: ChatMessage, owner: TelegramOwner | null = this.config.owner) {
    if (!owner) throw Error('Telegram pairing is unavailable');
    return `result:${owner.pairingId}:${task.id}:${task.turnId || 'unsubmitted'}:${includesValue(['review', 'completed'], task.status) ? 'result' : task.status}`;
  }
  ensureMirrorBaseline() {
    const owner = this.config.owner;
    if (
      !owner ||
      (owner.syncVersion === 1 && owner.conversationId === this.store.state.conversationId)
    )
      return false;
    if (typeof owner.pairingId !== 'string' || !owner.pairingId || owner.pairingId.length > 128)
      throw Error('Telegram pairing identity is invalid');
    const replies = new Map();
    for (const message of this.store.state.messages)
      if (message.role === 'assistant' && message.status === 'completed' && message.taskId)
        replies.set(message.taskId, message.id);
    const before = [];
    for (const message of this.store.state.messages) {
      before.push({ message, mirror: message.telegramMirror, delivery: message.telegramDelivery });
      message.telegramMirror = { pairingId: owner.pairingId, historical: true };
      if (message.role === 'user' && this.taskOwned(message) && terminal.has(message.status)) {
        const key = this.resultKey(message, owner);
        if (message.telegramDelivery?.key !== key)
          message.telegramDelivery = {
            key,
            pairingId: owner.pairingId,
            replyThroughId: replies.get(message.id) || null,
            scheduledAt: this.now(),
            status: 'historical',
          };
      }
    }
    // One atomic Store save preserves message identity, order, timestamps and the
    // model's conversation. Deleting history cannot move this per-message baseline.
    try {
      this.store.save();
    } catch (caughtError) {
      const error = telegramError(caughtError);
      for (const { message, mirror, delivery } of before) {
        if (mirror === undefined) delete message.telegramMirror;
        else message.telegramMirror = mirror;
        if (delivery === undefined) delete message.telegramDelivery;
        else message.telegramDelivery = delivery;
      }
      throw error;
    }
    owner.syncVersion = 1;
    owner.conversationId = this.store.state.conversationId;
    return true;
  }
  queueMirrorBatch(items: OutboxBase[]) {
    const owner = this.config.owner;
    if (!owner || !this.config.bot) return false;
    const old = this.config.outbox,
      next = [...old],
      ids = new Set(next.map((item) => item.id)),
      additions = items.filter((item) => !ids.has(item.id));
    while (next.length + additions.length > MAX_OUTBOX) {
      const index = next.findIndex((item) => includesValue(['sent', 'suppressed'], item.status));
      if (index < 0) {
        this.config.lastError = 'Telegram delivery queue is full; new chat messages are waiting';
        return false;
      }
      next.splice(index, 1);
    }
    for (const item of additions)
      next.push({
        ...item,
        botId: this.config.bot.id,
        chatId: owner.chatId,
        userId: owner.userId,
        pairingId: owner.pairingId,
        status: 'queued',
        attempts: 0,
        at: this.now(),
        ...(item.mirrorRole === 'assistant' ? { notBefore: this.now() + this.mirrorGraceMs } : {}),
      });
    if (
      Buffer.byteLength(JSON.stringify({ ...this.config, outbox: next })) >
      MAX_CONFIG - 256 * 1024
    ) {
      this.config.lastError =
        'Telegram delivery queue reached its byte limit; new chat messages are waiting';
      return false;
    }
    this.config.outbox = next;
    try {
      this.save();
    } catch (caughtError) {
      const error = telegramError(caughtError);
      this.config.outbox = old;
      throw error;
    }
    return true;
  }
  suppressMirror(message: ChatMessage | null | undefined, kind: string, attachmentId?: string) {
    const marker = message?.telegramMirror;
    if (
      marker &&
      marker.pairingId === this.config.owner?.pairingId &&
      (kind === 'text'
        ? marker.text === 'suppressed'
        : marker.files?.some((file) => file.id === attachmentId && file.status === 'suppressed'))
    )
      return true;
    if (this.config.forwardMode !== 'unread') return false;
    if (message?.role === 'user') return true;
    if (message?.role !== 'assistant') return false;
    // A later file can make the bubble unread again. Exact observed attachment
    // IDs remain evidence for older files; a legacy text receipt proves no file.
    return kind === 'text'
      ? message.read === true
      : Array.isArray(message.visibleAttachmentIds) &&
          attachmentId !== undefined &&
          message.visibleAttachmentIds.includes(attachmentId);
  }
  scanMirrors() {
    const owner = this.config.owner;
    if (!owner) return;
    const tasks = new Map(
      this.store.state.messages
        .filter((message) => message.role === 'user')
        .map((message) => [message.id, message]),
    );
    for (const message of this.store.state.messages) {
      if (
        !includesValue(['user', 'assistant'], message.role) ||
        message.kind === 'call' ||
        (message.role === 'assistant' && message.status !== 'completed') ||
        (message.role === 'user' && message.source?.type === 'telegram')
      )
        continue;
      const task = message.taskId ? tasks.get(message.taskId) : undefined,
        voiceDelivery =
          message.source?.type === 'voice-call' &&
          message.source.conversationId === this.store.state.conversationId;
      if (
        message.role === 'assistant' &&
        ((message.taskId && !task && !voiceDelivery) ||
          (task?.source?.type === 'telegram' && !this.taskOwned(task)))
      )
        continue;
      const priorMarker = message.telegramMirror;
      if (priorMarker?.historical || (priorMarker && priorMarker.pairingId !== owner.pairingId))
        continue;
      const marker: TelegramMirrorMarker & { files: Array<{ id: string; status: string }> } = {
        pairingId: owner.pairingId,
        text: priorMarker?.text || null,
        files: [...(priorMarker?.files || [])],
      };
      const group = `mirror:${owner.pairingId}:${message.id}`;
      if (
        marker.text === 'scheduling' ||
        marker.files.some((file) => file.status === 'scheduling')
      ) {
        if (marker.text === 'scheduling') marker.text = 'unknown';
        marker.files = marker.files.map((file) =>
          file.status === 'scheduling' ? { ...file, status: 'unknown' } : file,
        );
        this.store.update(message.id, { telegramMirror: marker });
        for (const item of this.config.outbox)
          if (item.deliveryId === group && item.status === 'queued') {
            item.status = 'failed';
            item.error = 'Chat mirror scheduling was interrupted; it was not repeated';
          }
        this.config.lastError =
          'Telegram chat mirror scheduling was interrupted; check delivery before resending';
        this.save();
        continue;
      }
      const text = typeof message.text === 'string' ? message.text : '',
        files = (Array.isArray(message.attachments) ? message.attachments : []).slice(
          0,
          MAX_MESSAGE_ATTACHMENTS,
        );
      let newText = (!!text && !marker.text) || marker.text === 'pending',
        pendingFiles = files.filter(
          (file) =>
            typeof file?.id === 'string' &&
            !marker.files.some((prior) => prior.id === file.id && prior.status !== 'pending'),
        );
      if (!newText && !pendingFiles.length) continue;
      // A previous ambiguous component freezes this message, including files
      // appended later; receiving new content never authorizes a resend.
      if (
        marker.text === 'unknown' ||
        marker.files.some((file) => file.status === 'unknown') ||
        this.config.outbox.some((item) => item.deliveryId === group && item.status === 'unknown')
      )
        continue;
      let suppressed = false;
      if (newText && this.suppressMirror(message, 'text')) {
        marker.text = 'suppressed';
        newText = false;
        suppressed = true;
      }
      pendingFiles = pendingFiles.filter((file) => {
        if (!this.suppressMirror(message, 'document', file.id)) return true;
        const prior = marker.files.find((item) => item.id === file.id);
        if (prior) prior.status = 'suppressed';
        else marker.files.push({ id: file.id, status: 'suppressed' });
        suppressed = true;
        return false;
      });
      if (suppressed) this.store.update(message.id, { telegramMirror: marker });
      if (!newText && !pendingFiles.length) continue;
      const items: OutboxBase[] = [];
      if (newText) {
        const value =
          message.role === 'user' ? this.words().desktop + ':\n' + text : telegramMirrorText(text);
        for (const [index, chunk] of splitTelegramText(this.safeText(value)).entries())
          items.push({
            id: group + ':text:' + index,
            kind: 'text',
            text: chunk,
            deliveryId: group,
            localMessageId: message.id,
            mirrorRole: message.role,
          });
      }
      for (const file of pendingFiles)
        items.push({
          id: group + ':file:' + file.id,
          kind: 'document',
          attachmentId: file.id,
          deliveryId: group,
          localMessageId: message.id,
          mirrorRole: message.role,
          ...(message.role === 'user' ? { caption: this.words().desktop } : {}),
        });
      if (newText) marker.text = 'scheduling';
      for (const file of pendingFiles) {
        const prior = marker.files.find((item) => item.id === file.id);
        if (prior) prior.status = 'scheduling';
        else marker.files.push({ id: file.id, status: 'scheduling' });
      }
      this.store.update(message.id, { telegramMirror: marker });
      const accepted = this.queueMirrorBatch(items),
        status = accepted ? 'scheduled' : 'pending';
      if (newText) marker.text = status;
      marker.files = marker.files.map((file) =>
        file.status === 'scheduling' ? { ...file, status } : file,
      );
      this.store.update(message.id, { telegramMirror: marker });
      if (!accepted) this.save();
    }
  }
  scanResults() {
    if (this.closed || !this.config.enabled || !this.config.owner) return;
    if (this.ensureMirrorBaseline()) this.save();
    this.scanMirrors();
    for (const task of this.store.state.messages) {
      if (task.role !== 'user' || !this.taskOwned(task) || !terminal.has(task.status)) continue;
      if (includesValue(['review', 'completed'], task.status)) {
        const work = (this.store.state.workTasks || []).filter(
          (record) =>
            record.messageId === task.id ||
            (task.turnId &&
              (record.turnId === task.turnId || record.turnIds?.includes(task.turnId))),
        );
        if (
          work.some(
            (record) =>
              !(
                record.status === 'completed' ||
                (record.status === 'review' &&
                  record.plan?.steps?.length &&
                  record.plan.steps.every((step) => step.status === 'completed'))
              ),
          )
        )
          continue;
      }
      const legacyKey = `result:${task.id}:${task.turnId || 'unsubmitted'}:${includesValue(['review', 'completed'], task.status) ? 'result' : task.status}`,
        key = `result:${this.config.owner.pairingId}:${legacyKey.slice(7)}`,
        previous = task.telegramDelivery;
      if (previous?.key === key) {
        if (previous.status === 'scheduling') {
          this.store.update(task.id, { telegramDelivery: { ...previous, status: 'unknown' } });
          this.config.lastError =
            'Telegram reply scheduling was interrupted; it was not automatically repeated';
          this.save();
        }
        continue;
      }
      const allReplies = this.store.state.messages.filter(
        (message) =>
          message.role === 'assistant' &&
          message.taskId === task.id &&
          message.status === 'completed',
      );
      const marker: TelegramDeliveryMarker = {
        key,
        pairingId: this.config.owner.pairingId,
        replyThroughId: allReplies.at(-1)?.id || null,
        scheduledAt: this.now(),
        status: 'scheduling',
      };
      // Legacy keys are migrated once; new identities live with their task, never in a sliding ledger.
      if (this.config.resultKeys.includes(legacyKey) || this.config.resultKeys.includes(key)) {
        this.store.update(task.id, { telegramDelivery: { ...marker, status: 'scheduled' } });
        continue;
      }
      const anchor =
        previous?.pairingId === marker.pairingId && previous.replyThroughId
          ? allReplies.findIndex((reply) => reply.id === previous.replyThroughId)
          : -1;
      const replies =
        previous?.pairingId === marker.pairingId && previous.replyThroughId
          ? anchor < 0
            ? []
            : allReplies.slice(anchor + 1)
          : allReplies;
      // Commit the attempt before queuing any part. A crash can withhold a reply, never replay it.
      this.store.update(task.id, { telegramDelivery: marker });
      let scheduled = true;
      if (includesValue(['review', 'completed'], task.status)) {
        const delivered = replies.some((reply) => !!reply.text || reply.attachments?.length);
        if (!delivered)
          scheduled = this.queueText(key, this.words().workFinished, {
            deliveryId: key,
            taskId: task.id,
          });
      } else
        scheduled = this.queueText(
          key,
          task.submission === 'unknown'
            ? this.words().submissionUnknown
            : task.status === 'paused'
              ? this.words().taskPaused
              : this.words().taskFailed,
          { deliveryId: key, taskId: task.id },
        );
      this.store.update(task.id, {
        telegramDelivery: { ...marker, status: scheduled ? 'scheduled' : 'failed' },
      });
      this.save();
    }
  }
  kickOutbound() {
    if (this.autoPoll && !this.closed && this.config.enabled && this.config.owner)
      void this.flush().catch(() => this.fail('Telegram output could not be delivered'));
  }
  clearOutboundWake() {
    if (this.outboundTimer) clearTimeout(this.outboundTimer);
    this.outboundTimer = null;
  }
  scheduleOutboundWake(at: number | null) {
    this.clearOutboundWake();
    if (
      !this.autoPoll ||
      this.closed ||
      !this.config.enabled ||
      !this.config.owner ||
      typeof at !== 'number' ||
      !Number.isFinite(at)
    )
      return;
    this.outboundTimer = setTimeout(
      () => {
        this.outboundTimer = null;
        this.kickOutbound();
      },
      Math.max(1, Math.min(30000, at - this.now())),
    );
    this.outboundTimer.unref?.();
  }
  mirrorRole(item: TelegramOutboxItem) {
    return item.localMessageId
      ? this.store.state.messages.find((message) => message.id === item.localMessageId)?.role ||
          item.mirrorRole
      : null;
  }
  prepareQueued() {
    let changed = false;
    const owner = this.config.owner,
      bot = this.config.bot;
    if (!owner || !bot) return;
    for (const item of this.config.outbox) {
      if (item.status !== 'queued') continue;
      if (
        item.botId !== bot.id ||
        item.chatId !== owner.chatId ||
        item.userId !== owner.userId ||
        item.pairingId !== owner.pairingId
      ) {
        item.status = 'failed';
        item.error = 'The Telegram pairing changed';
        changed = true;
        continue;
      }
      if (
        item.deliveryId &&
        this.config.outbox.some(
          (prior) => prior.deliveryId === item.deliveryId && prior.status === 'unknown',
        )
      ) {
        item.status = 'failed';
        item.error = 'An earlier part of this reply was unconfirmed; remaining parts were not sent';
        changed = true;
        continue;
      }
      const message = item.localMessageId
          ? this.store.state.messages.find((message) => message.id === item.localMessageId)
          : undefined,
        role = message?.role || item.mirrorRole;
      if (
        item.localMessageId &&
        (this.suppressMirror(
          message,
          item.kind,
          item.kind === 'document' ? item.attachmentId : undefined,
        ) ||
          (this.config.forwardMode === 'unread' && role === 'user'))
      ) {
        if (message) {
          const marker = {
            ...(message.telegramMirror || {}),
            pairingId: owner.pairingId,
            files: [...(message.telegramMirror?.files || [])],
          };
          if (item.kind === 'text') marker.text = 'suppressed';
          else {
            const file = marker.files.find((file) => file.id === item.attachmentId);
            if (file) file.status = 'suppressed';
            else marker.files.push({ id: item.attachmentId, status: 'suppressed' });
          }
          this.store.update(message.id, { telegramMirror: marker });
        }
        item.status = 'suppressed';
        item.error = null;
        delete item.failureReason;
        delete item.failureAt;
        changed = true;
        continue;
      }
      // Legacy, provably unsent mirror items also get one bounded visibility grace.
      if (role === 'assistant' && item.localMessageId && !Object.hasOwn(item, 'notBefore')) {
        item.notBefore = this.now() + this.mirrorGraceMs;
        item.mirrorRole = role;
        changed = true;
      }
    }
    if (changed) this.save();
  }
  nextOutbound() {
    const now = this.now();
    let wakeAt = Infinity,
      waiting = false;
    for (let index = 0; index < this.config.outbox.length; index++) {
      const first = this.config.outbox[index];
      if (!first || first.status !== 'queued') continue;
      if (waiting && (first.localMessageId || !/^(?:command:|update:)/.test(first.id))) continue;
      const items = [first];
      let length = first.kind === 'text' ? first.text.length : 0,
        readyAt = validTime(first.notBefore) || 0;
      if (
        this.config.combineReplies &&
        first.kind === 'text' &&
        this.mirrorRole(first) === 'assistant'
      ) {
        for (let next = index + 1; next < this.config.outbox.length; next++) {
          const item = this.config.outbox[next];
          if (
            !item ||
            item.status !== 'queued' ||
            item.kind !== 'text' ||
            this.mirrorRole(item) !== 'assistant' ||
            item.pairingId !== first.pairingId ||
            length + 2 + item.text.length > 4096
          )
            break;
          items.push(item);
          length += 2 + item.text.length;
          readyAt = Math.max(readyAt, validTime(item.notBefore) || 0);
        }
        // Continuous output cannot postpone one notification indefinitely.
        readyAt = Math.min(
          readyAt,
          (validTime(first.at) || now) + Math.max(10000, this.mirrorGraceMs),
        );
      }
      if (readyAt <= now) return { items, wakeAt: null };
      wakeAt = Math.min(wakeAt, readyAt);
      waiting = true;
      // Never send a newer constituent separately while its earlier batch waits.
      index += items.length - 1;
    }
    return { items: [], wakeAt: Number.isFinite(wakeAt) ? wakeAt : null };
  }
  silentOutbound(items: TelegramOutboxItem[]) {
    if (!items.length || items.some((item) => this.mirrorRole(item) !== 'assistant')) return false;
    const first = items[0];
    if (!first) return false;
    const index = this.config.outbox.indexOf(first),
      previous = this.config.outbox.slice(0, index).findLast((item) => item.status === 'sent');
    if (!previous || this.mirrorRole(previous) !== 'assistant') return false;
    const at =
      validTime(previous.sentAt) || validTime(previous.lastAttemptAt) || validTime(previous.at);
    return (
      !!at &&
      this.now() >= at &&
      this.now() - at <= 10000 &&
      (this.config.combineReplies || items.some((item) => item.deliveryId === previous.deliveryId))
    );
  }
  async drain() {
    for (;;) {
      if (
        this.closed ||
        !this.config.enabled ||
        !this.config.owner ||
        this.loopAbort.signal.aborted
      )
        return;
      this.scanResults();
      this.prepareQueued();
      const { items, wakeAt } = this.nextOutbound();
      if (!items.length) {
        this.scheduleOutboundWake(wakeAt);
        return;
      }
      this.clearOutboundWake();
      const item = items[0];
      if (!item) return;
      const silent = this.silentOutbound(items);
      for (const part of items) {
        part.status = 'sending';
        part.attempts++;
        part.lastAttemptAt = this.now();
        part.notificationSilent = silent;
      }
      this.save();
      this.change();
      let method,
        retryAfter = null;
      try {
        let delivered;
        if (item.kind === 'text')
          delivered = await this.api('sendMessage', {
            chat_id: item.chatId,
            text: items.map((part) => (part.kind === 'text' ? part.text : '')).join('\n\n'),
            link_preview_options: { is_disabled: true },
            ...(silent ? { disable_notification: true } : {}),
          });
        else {
          const { meta, data } = this.attachments.read(item.attachmentId),
            type = inspectContent(data, meta.name);
          method =
            !item.documentFallback &&
            data.length <= 10000000 &&
            includesValue(['image/png', 'image/jpeg'], type)
              ? 'sendPhoto'
              : 'sendDocument';
          const form = new FormData();
          form.set('chat_id', item.chatId);
          form.set(
            method === 'sendPhoto' ? 'photo' : 'document',
            new Blob([data], { type }),
            meta.name,
          );
          if (typeof item.caption === 'string') form.set('caption', item.caption);
          if (silent) form.set('disable_notification', 'true');
          delivered = await this.api(method, form);
        }
        for (const part of items) {
          if (identifier(delivered?.message_id))
            part.telegramMessageId = identifier(delivered.message_id);
          part.status = 'sent';
          part.sentAt = this.now();
          part.error = null;
          delete part.failureReason;
          delete part.failureAt;
        }
        this.config.lastOutboundAt = this.now();
      } catch (caughtError) {
        const error = telegramError(caughtError);
        if (
          method === 'sendPhoto' &&
          error.telegramCode === 400 &&
          !error.unknownOutcome &&
          !item.documentFallback
        ) {
          item.documentFallback = true;
          item.status = 'queued';
          item.error = 'Telegram rejected the photo format; sending the original file instead';
        } else if (
          error.telegramCode === 429 &&
          typeof error.retryAfter === 'number' &&
          Number.isFinite(error.retryAfter) &&
          error.retryAfter > 0 &&
          error.retryAfter <= 300 &&
          items.every((part) => part.attempts < 3)
        ) {
          for (const part of items) {
            part.status = 'queued';
            part.error = 'Telegram rate limit; waiting before a confirmed-safe retry';
          }
          retryAfter = error.retryAfter * 1000;
        } else {
          for (const part of items) {
            part.status = error.unknownOutcome ? 'unknown' : 'failed';
            part.error = this.safe(error.message);
            part.failureAt = this.now();
            part.failureReason = failureReasons.has(error.telegramReason ?? '')
              ? (error.telegramReason ?? 'unconfirmed')
              : telegramFailureReason(error, {
                  phase: item.kind === 'text' ? 'network' : method ? 'network' : 'attachment',
                });
          }
          this.config.lastError = item.error;
        }
      } finally {
        this.save();
        this.change();
      }
      // A safe 429 retry must re-evaluate current pairing, policy and read receipts.
      if (retryAfter !== null) {
        try {
          await this.delay(retryAfter, this.loopAbort.signal);
        } catch {
          return;
        }
      }
    }
  }
  flush() {
    this.scanResults();
    if (this.outboundTask) return this.outboundTask;
    const task = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        if (this.outboundTask === task) this.outboundTask = null;
      });
    this.outboundTask = task;
    return task;
  }
  async stopLoops() {
    this.generation++;
    this.loopAbort.abort();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.clearOutboundWake();
    const pending = [this.loopTask, this.outboundTask];
    this.loopTask = null;
    this.outboundTask = null;
    await Promise.allSettled(pending);
    this.connected = false;
    this.loopAbort = new AbortController();
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.clearOutboundWake();
    this.engine.off('change', this.engineListener);
    this.closeAbort.abort();
    this.loopAbort.abort();
    this.closePromise = Promise.allSettled([this.loopTask, this.outboundTask, this.mutations]).then(
      () => {
        this.connected = false;
      },
    );
    return this.closePromise;
  }
}
