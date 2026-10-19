import { escapeHtml as escape } from '../shared/html.mts';
import {
  TaskStatus,
  PlanStepStatus,
  TaskPriority,
  ConnectionStatus,
  SubmissionStatus,
  isEnumValue,
} from '../../src/contracts/states.mts';
import type {
  TaskPriorityValue,
  TaskStatusValue,
  TaskPlanSummary,
  TaskPlan,
} from '../../src/contracts/contracts.ts';
import type { WorkReplyTarget } from '../shared/contracts.mts';
import { progressSnapshot } from './progress-snapshot.mts';
import type {
  ProgressMessage as ChatMessage,
  ProgressRecord as UiWorkRecord,
  ProgressCompletion as UiCompletion,
  ProgressPlan,
} from './progress-snapshot.mts';
import { localizeMessages, translateCount } from '../../src/i18n/i18n.mts';
import { formatCallDuration } from '../call/call-duration.mts';

const baseCopy = {
  en: {
    title: 'Work progress',
    idle: 'No task is running',
    offline: 'Work status is unavailable',
    running: 'Working',
    background: 'Continuing in the background',
    waiting_user: 'Waiting for your reply',
    pausing: 'Stopping safely',
    unknown: 'Status unconfirmed',
    review: 'Awaiting review',
    paused: 'Paused',
    failed: 'Failed',
    completed: 'Completed',
    queued: 'Queued',
    voice: 'Task from a call',
    chat: 'Chat task',
    task: 'Task',
    preparing: 'Preparing',
    working: 'Working',
    computer: 'Using the computer',
    command: 'Running a command',
    files: 'Working with files',
    responding: 'Preparing a reply',
    saving: 'Saving the result',
    elapsed: 'Elapsed',
    updated: 'Last update',
    steps: 'steps completed',
    plan: 'Task steps',
    pendingStep: 'Pending',
    inProgressStep: 'In progress',
    dismiss: 'Dismiss task',
    view: 'View result',
    unread: 'Unread result',
    stale: 'Reconnect to confirm the current state. The last known task is kept.',
    continues: 'Hanging up or closing the window keeps this task running.',
    queuedCount: (n: number) => `${n} queued`,
    reviewCount: (n: number) => `${n} awaiting review`,
  },
  zh: {
    title: '工作进度',
    idle: '当前没有正在执行的任务',
    offline: '暂时无法确认工作状态',
    running: '正在执行',
    background: '正在后台继续',
    waiting_user: '等待你回复',
    pausing: '正在安全停止',
    unknown: '状态未确认',
    review: '待验收',
    paused: '已暂停',
    failed: '失败',
    completed: '已完成',
    queued: '排队中',
    voice: '通话中交办的任务',
    chat: '聊天任务',
    task: '任务',
    preparing: '准备任务',
    working: '正在处理',
    computer: '正在操作电脑',
    command: '正在执行命令',
    files: '正在处理文件',
    responding: '正在准备回复',
    saving: '正在保存结果',
    elapsed: '已用时',
    updated: '最后更新',
    steps: '步已完成',
    plan: '任务步骤',
    pendingStep: '待处理',
    inProgressStep: '正在执行',
    dismiss: '收起任务',
    view: '查看结果',
    unread: '结果未读',
    stale: '重新连接后才能确认当前状态；保留上次已知任务。',
    continues: '挂断通话或关闭窗口后，这项任务会继续执行。',
    queuedCount: (n: number) => `${n} 项排队中`,
    reviewCount: (n: number) => `${n} 项待验收`,
  },
};
const copy = {
  en: Object.assign(
    baseCopy.en,
    {
      continuing: 'In progress',
      ongoing: 'Ongoing tasks',
      unfinished:
        'dant will continue the remaining work when the work computer is available, and notify you when it finishes, fails or needs your reply.',
      automaticNoProgress:
        'Paused because repeated attempts did not advance this task. Check it or send more instructions.',
      completedTasks: 'Completed tasks',
      clearCompleted: 'Clear all',
      priority: 'Priority',
      priorityHigh: 'High',
      priorityNormal: 'Normal',
      priorityLow: 'Low',
      cancelled: 'Cancelled',
      cancelTask: 'Cancel task',
      cancelCurrent: 'Cancel current work',
      stoppedStep: 'Stopped',
    },
    {
      pauseTask: 'Pause task',
      pauseCurrent: 'Pause current work',
      resumeTask: 'Resume task',
      pausedStep: 'Paused',
    },
    {
      replyTask: 'Reply to task',
      reopenTask: 'Reopen task',
      viewTask: 'View task',
      viewChat: 'View chat',
      replyServiceUpdate: 'Update the work computer service to reply to this task.',
    },
  ),
  zh: Object.assign(
    baseCopy.zh,
    {
      continuing: '进行中',
      ongoing: '进行中的任务',
      unfinished: 'dant 会在工作电脑可用时继续执行剩余工作；完成、失败或需要你回复时会通知你。',
      automaticNoProgress: '多次尝试仍未推进任务，已暂停；请检查任务或发送补充说明。',
      completedTasks: '已完成的任务',
      clearCompleted: '清空全部',
      priority: '优先级',
      priorityHigh: '高',
      priorityNormal: '普通',
      priorityLow: '低',
      cancelled: '已取消',
      cancelTask: '取消任务',
      cancelCurrent: '取消当前工作',
      stoppedStep: '已停止',
    },
    {
      pauseTask: '暂停任务',
      pauseCurrent: '暂停当前工作',
      resumeTask: '继续任务',
      pausedStep: '已暂停',
    },
    {
      replyTask: '回复任务',
      reopenTask: '重新打开',
      viewTask: '查看任务详情',
      viewChat: '查看聊天',
      replyServiceUpdate: '请更新工作电脑服务后，再回复这项任务。',
    },
  ),
};

export type ProgressLabels = typeof copy.en;
export type ProgressKind = 'task' | 'work' | 'active' | 'completion';
export interface CancelTarget {
  id: string;
  kind: 'task' | 'work' | 'active';
  turnId: string | null;
  callId: string | null;
}
export interface ProgressItem {
  id?: string | undefined;
  turnId?: string | null | undefined;
  work?: boolean;
  registered?: boolean;
  voice?: boolean;
  source?: 'voice' | 'chat';
  message?: ChatMessage | undefined;
  messageId?: string | null | undefined;
  taskId?: string | null;
  status: TaskStatusValue;
  knownStatus?: TaskStatusValue;
  title: string;
  time?: number | null;
  progressCompleted?: boolean;
  progressPriority: TaskPriorityValue;
  background?: boolean;
  stale?: boolean;
  startedAt?: number | null;
  updatedAt?: number | null;
  step?: keyof ProgressLabels;
  plan?: (TaskPlanSummary & { steps?: TaskPlan['steps'] }) | null;
  pauseReason?: string | null;
  unread?: boolean;
  canSteer?: boolean;
  canCancel?: boolean;
  canPause?: boolean;
  canResume?: boolean;
  canDismiss?: boolean;
  cancelTarget?: CancelTarget;
  replyTarget?: WorkReplyTarget | null;
  detailsTarget?: WorkReplyTarget | null;
  replyReopens?: boolean;
  replySupported?: boolean;
  canReply?: boolean;
}
export type ProgressRenderItem = Omit<ProgressItem, 'progressPriority' | 'plan'> & {
  progressPriority?: TaskPriorityValue;
  plan?: ProgressPlan | null;
};
const includesStatus = (values: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && values.includes(value);
const priority = (value: unknown): TaskPriorityValue =>
  isEnumValue(TaskPriority, value) ? value : TaskPriority.Normal;
const priorityOrder = { high: 0, normal: 1, low: 2 };
const compareProgress = (a: ProgressItem, b: ProgressItem) =>
  priorityOrder[a.progressPriority] - priorityOrder[b.progressPriority] ||
  Number(a.progressCompleted) - Number(b.progressCompleted) ||
  (b.time || 0) - (a.time || 0);
const unconfirmed = (
  value: { unknownOutcome?: unknown; submission?: string | null } | null | undefined,
) =>
  value?.unknownOutcome === true ||
  value?.submission === SubmissionStatus.Unknown ||
  value?.submission === SubmissionStatus.Submitting;
const time = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8640000000000000
    ? value
    : null;
const text = (message: ChatMessage | null | undefined, fallback: string) =>
  String(
    message?.text || message?.attachments?.map((file) => file.name).join(', ') || fallback,
  ).slice(0, 240);
const statuses = new Set<string>([
  TaskStatus.Draft,
  TaskStatus.Running,
  TaskStatus.Continuing,
  TaskStatus.WaitingUser,
  TaskStatus.Pausing,
  TaskStatus.Unknown,
  TaskStatus.Review,
  TaskStatus.Paused,
  TaskStatus.Failed,
  TaskStatus.Completed,
  TaskStatus.Queued,
  TaskStatus.Cancelled,
  TaskStatus.Interrupted,
]);
const status = (value: unknown): TaskStatusValue =>
  value === 'read'
    ? TaskStatus.Review
    : typeof value === 'string' && statuses.has(value) && isEnumValue(TaskStatus, value)
      ? value
      : TaskStatus.Unknown;
const finalStatuses = new Set<string>([
  TaskStatus.Review,
  TaskStatus.Paused,
  TaskStatus.Failed,
  TaskStatus.Completed,
  TaskStatus.Continuing,
  TaskStatus.Cancelled,
]);
const terminalStatuses = new Set<string>([
  TaskStatus.Review,
  TaskStatus.Failed,
  TaskStatus.Completed,
  TaskStatus.Cancelled,
]);
const identity = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x20\x7f]/.test(value);
const read = (message: ChatMessage | undefined) =>
  message?.read === true ||
  Boolean(message?.readAt || message?.receipt?.readAt || message?.visibleAt);
const elapsedTime = (startedAt: number, now: number) =>
  formatCallDuration(Math.max(0, Math.floor((now - startedAt) / 1000)));
const title = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 240) : '');
function workPlan(plan: ProgressPlan | null | undefined): Exclude<ProgressItem['plan'], undefined> {
  if (!plan) return null;
  const steps = Array.isArray(plan.steps)
    ? plan.steps
        .slice(0, 128)
        .filter(
          (item) =>
            title(item?.step) &&
            [PlanStepStatus.Pending, PlanStepStatus.InProgress, PlanStepStatus.Completed].includes(
              item.status,
            ),
        )
        .map((item) => ({ step: title(item.step), status: item.status }))
    : [];
  if (steps.length)
    return {
      total: steps.length,
      completed: steps.filter((item) => item.status === PlanStepStatus.Completed).length,
      currentStep: steps.find((item) => item.status === PlanStepStatus.InProgress)?.step || '',
      steps,
    };
  const total =
      typeof plan.total === 'number' &&
      Number.isSafeInteger(plan.total) &&
      plan.total > 0 &&
      plan.total <= 128
        ? plan.total
        : 0,
    completed =
      typeof plan.completed === 'number' &&
      Number.isSafeInteger(plan.completed) &&
      plan.completed >= 0 &&
      plan.completed <= total
        ? plan.completed
        : 0;
  return total ? { total, completed, currentStep: title(plan.currentStep) } : null;
}
export function updateWorkTimers(document: Document, now = Date.now()) {
  for (const node of document.querySelectorAll<HTMLElement>('[data-work-started]')) {
    const started = time(Number(node.dataset.workStarted));
    if (started) node.textContent = elapsedTime(started, now);
  }
}

export function workProgress(
  input: unknown,
  {
    language = 'en',
    connected = true,
    now = Date.now(),
  }: { language?: string; connected?: boolean; now?: number } = {},
) {
  const state = progressSnapshot(input);
  const labels = {
      ...localizeMessages(copy, language),
      queuedCount: (value: number) =>
        translateCount(language, value, '{count} queued', '{count} queued', '{count} 项排队中'),
      reviewCount: (value: number) =>
        translateCount(
          language,
          value,
          '{count} awaiting review',
          '{count} awaiting review',
          '{count} 项待验收',
        ),
    },
    messages = state?.messages || [],
    users = messages.filter(
      (message) =>
        message.role === 'user' &&
        message.kind !== 'call' &&
        message.workKind !== 'conversation' &&
        !(message.voiceCallId && !message.turnId),
    ),
    byId = new Map(messages.map((message) => [message.id, message]));
  const userIds = new Set(users.map((message) => message.id)),
    usersByTurn = new Map<string, ChatMessage[]>(),
    userById = new Map<string, ChatMessage>(),
    unconfirmedTurns = new Set(),
    unconfirmedWorkIds = new Set(),
    completedUserTurns = new Set(),
    workByTurn = new Map<string, UiWorkRecord[]>(),
    completionsByTurn = new Map<string, { completion: UiCompletion; index: number }[]>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    userById.set(message.id, message);
    if (unconfirmed(message) && message.workId) unconfirmedWorkIds.add(message.workId);
    if (!message.turnId) continue;
    const owners = usersByTurn.get(message.turnId) || [];
    owners.push(message);
    usersByTurn.set(message.turnId, owners);
    if (unconfirmed(message)) unconfirmedTurns.add(message.turnId);
    if (message.status === TaskStatus.Completed) completedUserTurns.add(message.turnId);
  }
  for (const record of state?.workTasks || []) {
    if (!record?.turnId) continue;
    for (const turnId of new Set([record.turnId, ...(record.turnIds || [])])) {
      const records = workByTurn.get(turnId) || [];
      records.push(record);
      workByTurn.set(turnId, records);
    }
  }
  for (const [index, completion] of (state?.completions || []).entries()) {
    if (!completion?.turnId) continue;
    const receipts = completionsByTurn.get(completion.turnId) || [];
    receipts.push({ completion, index });
    completionsByTurn.set(completion.turnId, receipts);
  }
  const isCompleted = (
    entry: ChatMessage | UiWorkRecord | UiCompletion,
    kind: 'task' | 'work' | 'completion',
  ) => {
    if (unconfirmed(entry)) return false;
    if (kind === 'task') return entry.status === TaskStatus.Completed;
    if (unconfirmedTurns.has(entry.turnId)) return false;
    if (kind === 'work') return entry.status === TaskStatus.Completed;
    const requested = userById.get('taskId' in entry ? entry.taskId || '' : '');
    if (unconfirmed(requested)) return false;
    const records = workByTurn.get(entry.turnId || '');
    if (records?.length)
      return records.some(
        (record) => record.turnId === entry.turnId && record.status === TaskStatus.Completed,
      );
    return 'taskId' in entry && entry.taskId
      ? requested?.turnId === entry.turnId && requested?.status === TaskStatus.Completed
      : completedUserTurns.has(entry.turnId);
  };
  const reliable =
    connected &&
    state?.controller?.cached !== true &&
    (state?.controller?.status === undefined ||
      state.controller.status === ConnectionStatus.Online) &&
    (state?.worker?.status === undefined || state.worker.status === ConnectionStatus.Online);
  const current =
      state?.active?.visible === false &&
      !includesStatus(
        [TaskStatus.Unknown, TaskStatus.Pausing, TaskStatus.WaitingUser],
        state.active.status,
      )
        ? null
        : state?.active,
    activeIds = new Set([current?.messageId, ...(current?.messageIds || [])].filter(Boolean)),
    queueIds = new Set(state?.queue || []);
  const records: UiWorkRecord[] = [],
    registeredTurns = new Set(),
    registeredMessages = new Set(),
    recordIds = new Set();
  for (const record of [...(state?.workTasks || [])].sort(
    (a, b) => (time(b.updatedAt) || 0) - (time(a.updatedAt) || 0),
  )) {
    if (
      !record?.id ||
      !record.turnId ||
      registeredTurns.has(record.turnId) ||
      recordIds.has(record.id)
    )
      continue;
    records.push(record);
    for (const id of [record.turnId, ...(record.turnIds || [])]) registeredTurns.add(id);
    recordIds.add(record.id);
    const message = byId.get(record.messageId || '');
    if (message?.role === 'user' && (!message.turnId || registeredTurns.has(message.turnId)))
      registeredMessages.add(message.id);
  }
  const registered = records.find(
    (record) =>
      current &&
      record.turnId === current.turnId &&
      (!current.workId || record.id === current.workId),
  );
  const taskTarget = (record: UiWorkRecord | undefined): WorkReplyTarget | null =>
    identity(record?.id, 128) &&
    identity(record?.turnId, 256) &&
    identity(state?.conversationId, 128)
      ? { workId: record.id, turnId: record.turnId, conversationId: state!.conversationId! }
      : null;
  const replyData = (
    record: UiWorkRecord | undefined,
    message: ChatMessage | null | undefined,
    { live = false, known = status(record?.status) } = {},
  ) => {
    const replyTarget = taskTarget(record),
      replyReopens = terminalStatuses.has(known),
      replySupported =
        state?.capabilities?.workReply === true &&
        (!(replyReopens || live) || state?.capabilities?.taskReopen === true);
    const confirmed =
      !unconfirmed(record) &&
      !unconfirmed(message) &&
      !unconfirmedTurns.has(record?.turnId) &&
      !unconfirmedWorkIds.has(record?.id) &&
      !record?.continuation?.invalid &&
      (!record?.continuation?.dispatch ||
        (live && record.continuation.dispatch.phase === 'acknowledged'));
    const savedPlan =
      record?.plan === null
        ? record.provisional === true
        : Array.isArray(record?.plan?.steps) &&
          record.plan.steps.length > 0 &&
          record.plan.steps.length <= 128 &&
          record.plan.steps.every(
            (step) =>
              title(step?.step) &&
              [
                PlanStepStatus.Pending,
                PlanStepStatus.InProgress,
                PlanStepStatus.Completed,
              ].includes(step.status),
          );
    const ready = live
      ? includesStatus([TaskStatus.Running, TaskStatus.WaitingUser], known) &&
        current?.canSteer === true
      : includesStatus(
          [
            TaskStatus.Continuing,
            TaskStatus.WaitingUser,
            TaskStatus.Paused,
            TaskStatus.Review,
            TaskStatus.Completed,
            TaskStatus.Cancelled,
            TaskStatus.Failed,
          ],
          known,
        ) &&
        savedPlan &&
        Number.isSafeInteger(record?.executionEndedAt) &&
        time(record?.executionEndedAt) &&
        typeof record?.executionEndedAt === 'number' &&
        record.executionEndedAt <= now;
    return {
      replyTarget,
      replyReopens,
      replySupported,
      canReply: Boolean(
        replyTarget &&
        replySupported &&
        reliable &&
        !state?.takeover &&
        !time(record?.progressDismissedAt) &&
        confirmed &&
        ready,
      ),
      detailsTarget: replyTarget,
    };
  };
  if (current?.turnId)
    for (const message of users) if (message.turnId === current.turnId) activeIds.add(message.id);
  let active: ProgressItem | null = null;
  if (current) {
    const message = users.find((item) => activeIds.has(item.id)),
      source = current.source === 'voice' ? 'voice' : 'chat',
      known = status(
        current.status === undefined
          ? message?.status === TaskStatus.WaitingUser || message?.status === TaskStatus.Pausing
            ? message.status
            : TaskStatus.Running
          : current.status,
      );
    const kind = registered ? 'work' : current.messageId ? 'task' : 'active',
      id = registered?.id || current.messageId || 'current',
      turnId = current.turnId || null;
    active = {
      ...current,
      progressPriority: priority(
        current.progressPriority ?? registered?.progressPriority ?? message?.progressPriority,
      ),
      title:
        title(current.title) ||
        title(registered?.title) ||
        text(message, labels[source === 'voice' ? 'voice' : 'task']),
      source,
      canSteer:
        current.canSteer === true ||
        (current.canSteer === undefined && source === 'chat' && Boolean(current.turnId)),
      status: reliable ? known : TaskStatus.Unknown,
      knownStatus: known,
      stale: !reliable,
      startedAt: time(current.startedAt) || time(registered?.startedAt) || time(message?.time),
      updatedAt: time(current.updatedAt) || time(registered?.updatedAt),
      plan: workPlan(current.plan || registered?.plan),
      cancelTarget: { id, kind, turnId, callId: current.callId || null },
      canCancel:
        reliable &&
        includesStatus([TaskStatus.Running, TaskStatus.WaitingUser], known) &&
        (Boolean(turnId) || kind === 'task') &&
        !unconfirmed(message) &&
        !unconfirmed(registered),
    };
    active.canPause = active.canCancel === true;
    if (registered)
      Object.assign(active, {
        id: registered.id,
        registered: true,
        ...replyData(registered, message, { live: true, known }),
      });
  }
  const queue = (state?.queue || [])
    .map((id) => byId.get(id))
    .filter((message): message is ChatMessage => !!message && userIds.has(message.id))
    .map((message) => ({
      message,
      status: TaskStatus.Queued,
      progressPriority: priority(message.progressPriority),
      title: text(message, labels.task),
      time: time(message.time),
    }));
  const history: ProgressItem[] = users
    .filter(
      (message) =>
        !activeIds.has(message.id) &&
        !queueIds.has(message.id) &&
        !registeredMessages.has(message.id) &&
        !registeredTurns.has(message.turnId) &&
        !time(message.progressDismissedAt),
    )
    .map((message) => ({
      message,
      status: status(message.status),
      progressCompleted: isCompleted(message, 'task'),
      progressPriority: priority(message.progressPriority),
      title: text(message, labels.task),
      time: time(message.time),
      voice: false,
    }));
  for (const record of records) {
    const original = byId.get(record.messageId || ''),
      turnIds = new Set([record.turnId, ...(record.turnIds || [])]),
      message =
        usersByTurn.get(record.turnId)?.[0] ||
        (original?.role === 'user' && !original.turnId ? original : null),
      ownsMessage = message?.role === 'user';
    if (
      time(record.progressDismissedAt) ||
      record.id === current?.workId ||
      record.turnId === current?.turnId ||
      (!current?.turnId && activeIds.has(record.messageId)) ||
      (ownsMessage && queueIds.has(record.messageId || ''))
    )
      continue;
    const results = [...turnIds]
      .flatMap((turnId) => completionsByTurn.get(turnId) || [])
      .sort((a, b) => a.index - b.index)
      .flatMap(({ completion }) => completion.messageIds || [])
      .map((id) => byId.get(id))
      .filter((item): item is ChatMessage => item?.role === 'assistant' && item.kind !== 'call');
    const known = status(record.status),
      source = record.source === 'voice' ? 'voice' : 'chat';
    const canCancel = Boolean(
        reliable &&
        includesStatus([TaskStatus.Continuing, TaskStatus.WaitingUser], known) &&
        !unconfirmed(record) &&
        !unconfirmedTurns.has(record.turnId),
      ),
      plan = workPlan(record.plan),
      resumePlan =
        record.plan === null
          ? record.provisional === true
          : plan?.steps?.some((step) => step.status !== PlanStepStatus.Completed);
    const reply = replyData(record, message, { known });
    history.push({
      id: record.id,
      turnId: record.turnId,
      work: true,
      registered: true,
      voice: source === 'voice',
      source,
      progressCompleted: isCompleted(record, 'work'),
      progressPriority: priority(record.progressPriority ?? message?.progressPriority),
      taskId: ownsMessage ? message.id : null,
      message: ownsMessage ? message : undefined,
      messageId: results[0]?.id,
      status:
        !reliable &&
        includesStatus([TaskStatus.Running, TaskStatus.WaitingUser, TaskStatus.Pausing], known)
          ? TaskStatus.Unknown
          : known,
      knownStatus: known,
      stale: !reliable,
      pauseReason: record.pauseReason === 'automatic-no-progress' ? 'automatic-no-progress' : null,
      canDismiss: finalStatuses.has(known),
      cancelTarget: { id: record.id, kind: 'work', turnId: record.turnId, callId: null },
      canCancel,
      canPause: canCancel,
      ...reply,
      canResume: Boolean(
        reliable &&
        known === TaskStatus.Paused &&
        Number.isSafeInteger(record?.executionEndedAt) &&
        time(record?.executionEndedAt) &&
        resumePlan &&
        !unconfirmed(record) &&
        !unconfirmed(message) &&
        !unconfirmedTurns.has(record.turnId) &&
        !unconfirmedWorkIds.has(record.id) &&
        !record.continuation?.invalid &&
        !record.continuation?.dispatch,
      ),
      title: title(record.title) || text(message, labels[source === 'voice' ? 'voice' : 'task']),
      time: time(record.updatedAt) || time(record.startedAt) || time(message?.time),
      startedAt: time(record.startedAt),
      updatedAt: time(record.updatedAt),
      plan,
      unread: results.some((item) => !read(item)),
    });
  }
  const seen = new Set();
  for (const completion of state?.completions || []) {
    if (
      !completion?.turnId ||
      registeredTurns.has(completion.turnId) ||
      time(completion.progressDismissedAt) ||
      seen.has(completion.turnId) ||
      completion.turnId === current?.turnId ||
      userIds.has(completion.taskId || '')
    )
      continue;
    const result = (completion.messageIds || [])
      .map((id) => byId.get(id))
      .filter(
        (message): message is ChatMessage =>
          message?.role === 'assistant' && message.kind !== 'call',
      );
    if (
      !result.length ||
      completion.work?.source !== 'voice' ||
      !includesStatus(
        [TaskStatus.Review, TaskStatus.Failed, TaskStatus.Paused, TaskStatus.Cancelled],
        completion.work.status,
      )
    )
      continue;
    seen.add(completion.turnId);
    const accepted = isCompleted(completion, 'completion');
    history.push({
      id: completion.id || completion.turnId,
      voice: true,
      progressCompleted: accepted,
      progressPriority: priority(completion.progressPriority),
      status: accepted
        ? TaskStatus.Completed
        : status(completion.work?.status || TaskStatus.Review),
      title: labels.voice,
      time: time(completion.work?.updatedAt) || time(completion.at),
      messageId: result[0]!.id,
      unread: result.some((message) => !read(message)),
    });
  }
  history.sort(compareProgress);
  const isOngoing = (item: ProgressItem) =>
      item.registered &&
      includesStatus([TaskStatus.Continuing, TaskStatus.WaitingUser], item.knownStatus || ''),
    ongoing = history.filter(isOngoing),
    recent = history.filter((item) => !isOngoing(item));
  const reviewCount = recent.filter(
    (item) => item.status === TaskStatus.Review && (!item.voice || item.unread),
  ).length;
  const completed = recent.filter((item) => item.progressCompleted);
  const replyReferences = records
    .filter((record) => !time(record.progressDismissedAt))
    .map((record) => ({
      workId: record.id,
      conversationId: state?.conversationId || null,
      title: title(record.title) || text(byId.get(record.messageId || ''), labels.task),
    }));
  return {
    conversationId: state?.conversationId || null,
    taskReplySupported: state?.capabilities?.workReply === true,
    replyReferences,
    active,
    queue,
    ongoing,
    history: recent.slice(0, 12),
    recent: recent.filter((item) => !item.progressCompleted).slice(0, 12),
    completed,
    completedCount: completed.length,
    items: history,
    reviewCount,
    reliable,
    now,
    labels,
  };
}
export function renderWorkEntry(model: ReturnType<typeof workProgress>, icon = '') {
  const { labels, reviewCount } = model,
    label = labels.title + (reviewCount ? ' · ' + labels.reviewCount(reviewCount) : '');
  return `<button type="button" class="text-btn header-work" data-action="progress" title="${escape(label)}" aria-label="${escape(label)}">${icon}<span>${escape(labels.title)}</span>${reviewCount ? '<i class="work-review-marker" data-work-review-marker aria-hidden="true"></i>' : ''}</button>`;
}
export function renderWorkSummary(model: ReturnType<typeof workProgress>) {
  const { active, ongoing = [], queue = [], labels, reliable } = model,
    item = active || ongoing[0] || queue[0];
  if (!item) return '';
  const state = reliable
      ? active?.status || ongoing[0]?.status || TaskStatus.Queued
      : TaskStatus.Unknown,
    label =
      state === TaskStatus.Running && active?.background
        ? labels.background
        : '' + (labels[state as keyof ProgressLabels] || labels.unknown);
  const hint = !reliable ? labels.stale : labels.title;
  return `<button type="button" class="work-summary ${escape(state)}" data-key="work-summary" data-action="progress" title="${escape(hint)}" aria-label="${escape(labels.title + ': ' + label + ' · ' + item.title)}"><i class="work-status-dot" aria-hidden="true"></i><span class="work-summary-content"><small>${escape(label)}</small><strong>${escape(item.title)}</strong></span><span class="work-summary-chevron" aria-hidden="true">›</span></button>`;
}
function renderPlan(
  plan: ProgressRenderItem['plan'],
  labels: ProgressLabels,
  {
    history = false,
    workId,
    expanded = false,
    cancelled = false,
    paused = false,
  }: {
    history?: boolean;
    workId?: string | undefined;
    expanded?: boolean;
    cancelled?: boolean;
    paused?: boolean;
  } = {},
) {
  if (!plan) return '';
  const count = `${plan.completed} / ${plan.total} ${escape(labels.steps)}`;
  const checklist = plan.steps?.length
    ? `<ol class="work-checklist" aria-label="${escape(labels.plan)}">${plan.steps
        .map((item) => {
          const stopped = (cancelled || paused) && item.status === PlanStepStatus.InProgress,
            state = stopped ? (cancelled ? TaskStatus.Cancelled : TaskStatus.Paused) : item.status;
          return `<li data-work-step-status="${state}"><span class="work-step-icon" aria-hidden="true">${item.status === PlanStepStatus.Completed ? '✓' : stopped ? '−' : item.status === PlanStepStatus.InProgress ? '◉' : '○'}</span><span>${escape(item.step)}</span><small>${escape(item.status === PlanStepStatus.Completed ? labels.completed : stopped ? (cancelled ? labels.stoppedStep : labels.pausedStep) : item.status === PlanStepStatus.InProgress ? labels.inProgressStep : labels.pendingStep)}</small></li>`;
        })
        .join('')}</ol>`
    : plan.currentStep
      ? `<p>${escape(plan.currentStep)}</p>`
      : '';
  if (history)
    return `<details class="work-plan work-history-plan" data-key="work-plan-${escape(workId)}" data-work-plan="${escape(workId)}" ${expanded ? 'open' : ''}><summary>${count}</summary>${checklist}</details>`;
  return `<div class="work-plan"><div><span>${count}</span></div><progress max="${plan.total}" value="${plan.completed}" aria-label="${escape(labels.steps)}"></progress>${checklist}</div>`;
}
export function renderWorkCancel(
  item: ProgressRenderItem,
  labels: ProgressLabels,
  { pending = false, compact = false } = {},
) {
  const target = item.cancelTarget;
  if (!target) return '';
  return `<button type="button" class="${compact ? 'icon-btn progress-cancel' : 'text-btn current-work-cancel'}" data-task-cancel="${escape(target.id)}" data-progress-kind="${escape(target.kind)}" data-progress-turn="${escape(target.turnId || '')}" data-progress-call="${escape(target.callId || '')}" title="${escape(labels.cancelTask)}" aria-label="${escape(compact ? labels.cancelTask : labels.cancelCurrent)}" ${pending || !item.canCancel ? 'disabled' : ''}>${compact ? '<span aria-hidden="true">×</span>' : escape(labels.cancelCurrent)}</button>`;
}
function renderWorkPause(
  item: ProgressRenderItem,
  labels: ProgressLabels,
  { pending = false, active = false } = {},
) {
  const target = item.cancelTarget;
  if (!target) return '';
  return `<button type="button" class="text-btn" data-task-pause="${escape(target.id)}" data-progress-kind="${escape(target.kind)}" data-progress-turn="${escape(target.turnId || '')}" data-progress-call="${escape(target.callId || '')}" ${pending || !item.canPause ? 'disabled' : ''}>${escape(active ? labels.pauseCurrent : labels.pauseTask)}</button>`;
}
function renderWorkResume(
  item: ProgressRenderItem,
  labels: ProgressLabels,
  { pending = false } = {},
) {
  const target = item.cancelTarget;
  if (!target) return '';
  return `<button type="button" class="text-btn" data-task-work-resume="${escape(target.id)}" data-progress-kind="${escape(target.kind)}" data-progress-turn="${escape(target.turnId || '')}" ${pending || !item.canResume ? 'disabled' : ''}>${escape(labels.resumeTask)}</button>`;
}
export function renderWorkReply(
  item: ProgressRenderItem,
  labels: ProgressLabels,
  { pending = false } = {},
) {
  const target = item.replyTarget;
  if (!target) return '';
  return `<button type="button" class="text-btn" data-task-work-reply="${escape(target.workId)}" data-progress-turn="${escape(target.turnId)}" data-progress-conversation="${escape(target.conversationId)}"${item.replySupported === false ? ` title="${escape(labels.replyServiceUpdate)}"` : ''} ${pending || !item.canReply ? 'disabled' : ''}>${escape(labels.replyTask)}</button>`;
}
function renderWorkDetails(
  item: ProgressRenderItem,
  labels: ProgressLabels,
  { pending = false } = {},
) {
  const target = item.detailsTarget;
  if (target)
    return `<button type="button" class="text-btn" data-task-details="${escape(target.workId)}" data-progress-turn="${escape(target.turnId)}" data-progress-conversation="${escape(target.conversationId)}" ${pending ? 'disabled' : ''}>${escape(labels.viewTask)}</button>`;
  return item.messageId
    ? `<button type="button" class="text-btn" data-progress-message="${escape(item.messageId)}">${escape(labels.viewChat)}</button>`
    : '';
}
export function renderActiveWork(
  model: ReturnType<typeof workProgress>,
  { pending = false, planOpen = false } = {},
) {
  const { active, labels, now } = model;
  if (!active) return '';
  if (active.registered)
    return renderWorkTaskHistory(active, labels, { pending, planOpen, active: true, now });
  const state = active.status,
    label =
      state === TaskStatus.Running && active.background
        ? labels.background
        : '' + (labels[state as keyof ProgressLabels] || labels.unknown);
  const duration = active.startedAt ? elapsedTime(active.startedAt, now) : '';
  const updated = active.updatedAt
    ? new Intl.DateTimeFormat(labels === copy.zh ? 'zh-CN' : 'en', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(active.updatedAt)
    : '';
  return `<section class="current-work ${escape(state)}" data-key="current-work"><div class="current-work-status"><i class="work-status-dot" aria-hidden="true"></i><strong>${escape(label)}</strong><small>${escape(labels[active.source === 'voice' ? 'voice' : 'chat'])}</small>${renderWorkCancel(active, labels, { pending, compact: true })}</div><h3>${escape(active.title)}</h3><p class="work-step">${escape(active.step ? labels[active.step] : labels.working)}</p>${renderPlan(active.plan, labels)}<div class="work-time">${duration ? `<span>${escape(labels.elapsed)} · <time data-work-started="${active.startedAt}">${duration}</time></span>` : ''}${updated ? `<span>${escape(labels.updated)} · ${escape(updated)}</span>` : ''}</div><p class="work-continuation">${escape(active.stale ? labels.stale : labels.continues)}</p><div class="task-actions">${renderWorkDetails(active, labels, { pending })}${renderWorkPause(active, labels, { pending, active: true })}${renderWorkCancel(active, labels, { pending })}</div></section>`;
}
export function renderVoiceWorkHistory(
  item: ProgressRenderItem,
  labels: ProgressLabels,
  { pending = false } = {},
) {
  const dismiss = labels.dismiss;
  return `<div class="progress-item voice-work" data-key="voice-work-${escape(item.id)}"><span class="progress-state ${escape(item.status)}" aria-hidden="true">◷</span><div><p>${escape(item.title)}</p><small>${escape('' + (labels[item.status as keyof ProgressLabels] || labels.unknown))}${item.unread ? ' · ' + escape(labels.unread) : ''}</small><div class="task-actions">${renderWorkPriority({ ...item, voice: true }, labels, { pending })}${renderWorkDetails(item, labels, { pending })}</div></div><button type="button" class="icon-btn progress-dismiss" data-task-dismiss="${escape(item.id)}" data-progress-kind="completion" data-progress-status="${escape(item.knownStatus || item.status)}" title="${escape(dismiss)}" aria-label="${escape(dismiss)}" ${pending ? 'disabled' : ''}><span aria-hidden="true">×</span></button></div>`;
}
export function renderWorkPriority(
  item: {
    id?: string | undefined;
    registered?: boolean;
    work?: boolean;
    voice?: boolean;
    knownStatus?: unknown;
    status?: unknown;
    progressCompleted?: boolean;
    progressPriority?: unknown;
    message?: { id: string; status?: unknown; progressPriority?: unknown } | undefined;
  },
  labels: ProgressLabels,
  { pending = false } = {},
) {
  if (
    terminalStatuses.has(status(item.knownStatus || item.status || item.message?.status)) ||
    item.progressCompleted === true
  )
    return '';
  const kind = item.registered || item.work ? 'work' : item.voice ? 'completion' : 'task',
    id = kind === 'task' ? item.message?.id || item.id : item.id;
  if (!id) return '';
  const selected = priority(item.progressPriority ?? item.message?.progressPriority);
  return `<label class="work-priority"><span>${escape(labels.priority)}</span><select data-task-priority="${escape(id)}" data-progress-kind="${kind}" aria-label="${escape(labels.priority)}" ${pending ? 'disabled' : ''}>${([TaskPriority.High, TaskPriority.Normal, TaskPriority.Low] as const).map((value) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${escape(labels[({ high: 'priorityHigh', normal: 'priorityNormal', low: 'priorityLow' } as const)[value]])}</option>`).join('')}</select></label>`;
}
export function renderWorkTaskHistory(
  item: ProgressRenderItem,
  labels: ProgressLabels,
  { pending = false, actions = '', planOpen = false, active = false, now = Date.now() } = {},
) {
  const at = item.time
    ? new Intl.DateTimeFormat(labels === copy.zh ? 'zh-CN' : 'en', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(item.time)
    : '';
  const view = renderWorkDetails(item, labels, { pending });
  const ongoing = includesStatus(
    [TaskStatus.Continuing, TaskStatus.WaitingUser],
    item.knownStatus || '',
  );
  const continuationHint = active
    ? item.stale
      ? labels.stale
      : labels.continues
    : item.status === TaskStatus.Paused && item.pauseReason === 'automatic-no-progress'
      ? labels.automaticNoProgress
      : item.knownStatus === TaskStatus.Continuing
        ? item.stale
          ? labels.stale
          : labels.unfinished
        : '';
  const paused = (item.knownStatus || item.status) === TaskStatus.Paused,
    legacyActions = actions;
  const duration = active && item.startedAt ? elapsedTime(item.startedAt, now) : '',
    updated =
      active && item.updatedAt
        ? new Intl.DateTimeFormat(labels === copy.zh ? 'zh-CN' : 'en', {
            hour: '2-digit',
            minute: '2-digit',
          }).format(item.updatedAt)
        : '';
  const label =
    item.status === TaskStatus.Running && item.background
      ? labels.background
      : '' + (labels[item.status as keyof ProgressLabels] || labels.unknown);
  const timing = active
    ? `<div class="work-time">${duration ? `<span>${escape(labels.elapsed)} · <time data-work-started="${item.startedAt}">${duration}</time></span>` : ''}${updated ? `<span>${escape(labels.updated)} · ${escape(updated)}</span>` : ''}</div>`
    : '';
  return `<div class="progress-item registered-work${ongoing || active ? ' ongoing-work' : ''}${active ? ' current-work ' + escape(item.status) : ''}" data-key="${active ? 'current-work' : 'registered-work-' + escape(item.id)}"><span class="progress-state ${escape(item.status)}" aria-hidden="true">${item.status === PlanStepStatus.Completed ? '✓' : item.status === TaskStatus.Cancelled ? '−' : '◷'}</span><div><p>${escape(item.title)}</p><small>${escape(label)}${active ? ` · <span class="work-step">${escape(item.step ? labels[item.step] : labels.working)}</span>` : at ? ' · ' + escape(at) : ''}${item.unread ? ' · ' + escape(labels.unread) : ''}</small>${!active && continuationHint ? `<p class="work-continuation">${escape(continuationHint)}</p>` : ''}${renderPlan(item.plan, labels, { history: true, workId: item.id, expanded: planOpen, cancelled: item.status === TaskStatus.Cancelled, paused })}${timing}${active && continuationHint ? `<p class="work-continuation">${escape(continuationHint)}</p>` : ''}<div class="task-actions">${renderWorkReply(item, labels, { pending })}${renderWorkPriority({ ...item, registered: true }, labels, { pending })}${view}${active || ongoing ? renderWorkPause(item, labels, { pending, active }) : paused ? renderWorkResume(item, labels, { pending }) : ''}</div>${legacyActions}</div>${active || ongoing ? renderWorkCancel(item, labels, { pending, compact: true }) : item.canDismiss ? `<button type="button" class="icon-btn progress-dismiss" data-task-dismiss="${escape(item.id)}" data-progress-kind="work" data-progress-status="${escape(item.knownStatus || item.status)}" title="${escape(labels.dismiss)}" aria-label="${escape(labels.dismiss)}" ${pending ? 'disabled' : ''}><span aria-hidden="true">×</span></button>` : ''}</div>`;
}
