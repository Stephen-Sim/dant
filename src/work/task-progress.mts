import {
  isEnumValue,
  PlanStepStatus,
  TaskProgressStage,
  TaskStatus,
} from '../contracts/states.mts';
import { WorkLimits } from './work-limits.mts';
import type {
  ActiveTaskProgressStatus,
  PlanStep,
  TaskExecutionProgress,
  TaskPlan,
  TaskPlanInput,
  TaskProgressSnapshot,
  TaskProgressStageValue,
  TaskProgressTask,
  TaskStatusValue,
  VoiceCompletionStatus,
  VoiceCompletionWork,
} from '../contracts/contracts.ts';

type TextRedactor = (text: string) => unknown;
interface RedactOptions {
  redact?: TextRedactor;
}
interface ProgressTimeOptions {
  at?: unknown;
}
interface ProgressStartOptions extends ProgressTimeOptions {
  step?: unknown;
}
interface ProgressObserveOptions extends ProgressTimeOptions, RedactOptions {}
interface ProgressSnapshotOptions extends RedactOptions {
  source?: unknown;
  background?: unknown;
  status?: unknown;
  startedAt?: unknown;
  saving?: boolean;
}
// Unknown transport values are inspected only after checking that they can
// carry properties. Functions retain the same property semantics as objects.
function properties(value: unknown): Record<string, unknown> | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? (value as Record<string, unknown>)
    : null;
}
function validPlanStep(value: unknown): value is PlanStep {
  const item = properties(value);
  return (
    !!item &&
    typeof item.step === 'string' &&
    item.step.length <= WorkLimits.PlanInputStepLength &&
    isEnumValue(PlanStepStatus, item.status)
  );
}
function publicPlanStep(value: unknown): value is PlanStep {
  return validPlanStep(value) && !!value.step.trim();
}
const activeStatuses: ReadonlySet<unknown> = new Set([
  TaskStatus.Running,
  TaskStatus.WaitingUser,
  TaskStatus.Pausing,
  TaskStatus.Unknown,
]);
function activeStatus(value: unknown): value is ActiveTaskProgressStatus {
  return activeStatuses.has(value);
}
const completionStatuses: ReadonlySet<unknown> = new Set([
  TaskStatus.Review,
  TaskStatus.Failed,
  TaskStatus.Paused,
  TaskStatus.Cancelled,
]);
function completionStatus(value: unknown): value is VoiceCompletionStatus {
  return completionStatuses.has(value);
}
const itemSteps = new Map<string, TaskProgressStageValue>([
  ['commandExecution', TaskProgressStage.Command],
  ['fileChange', TaskProgressStage.Files],
  ['agentMessage', TaskProgressStage.Responding],
  ['imageView', TaskProgressStage.Computer],
  ['imageGeneration', TaskProgressStage.Files],
  ['webSearch', TaskProgressStage.Working],
  ['dynamicToolCall', TaskProgressStage.Working],
  ['collabAgentToolCall', TaskProgressStage.Working],
]);
const validTime = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > 0 &&
  value <= WorkLimits.MaxTimestamp;
const validItemId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= WorkLimits.ReferenceIdLength;
const planStatuses = new Set(Object.values(PlanStepStatus));
export const TASK_PLAN_SCHEMA = Object.freeze({
  workId: { type: 'string', minLength: 1, maxLength: WorkLimits.IdLength },
  status: {
    type: 'string',
    enum: [TaskStatus.Running, TaskStatus.WaitingUser],
    description:
      'Use waiting_user only when the accepted task needs information from the user. Its steps must contain at least one pending step and no inProgress step; an all-completed plan cannot wait for user input.',
  },
  title: { type: 'string', minLength: 1, maxLength: WorkLimits.PlanTitleLength },
  steps: {
    type: 'array',
    minItems: 1,
    maxItems: WorkLimits.PlanSteps,
    items: {
      type: 'object',
      properties: {
        step: { type: 'string', minLength: 1, maxLength: WorkLimits.PlanInputStepLength },
        status: { type: 'string', enum: [...planStatuses] },
      },
      required: ['step', 'status'],
      additionalProperties: false,
    },
  },
});
export const TASK_PLAN_DESCRIPTION =
  'Register every accepted real task in Work progress before action or clarification, including a simple request to send a link or file. Supply a concrete short title and actual steps; wait for saved:true before claiming registration. A saved:false work_conflict response identifies activeWorkId; keep that exact automatic-continuation binding and update only its actual task, never unrelated work. Before asking for missing task information, set status to waiting_user with at least one pending step and no inProgress step. Reuse the actual returned workId for semantically related follow-ups across turns, including human-requested revisions to an unaccepted result awaiting review; never guess the latest task. Ordinary conversation and requests only asking for progress create no new task. This records progress only: it never starts another executor, grants permission, or marks execution finished.';
export const TASK_PLAN_INSTRUCTIONS =
  'Before executing any accepted real entrusted task, including a simple request to send a link or file, use task_plan (also available through dant_desktop MCP) to record its concrete title and actual steps in Work progress. Wait for its saved acknowledgement before doing that work or claiming the task is registered. Require saved:true before claiming registration. A saved:false result means the plan was not saved. When it returns code work_conflict and activeWorkId, this automatic continuation must keep that exact workId and only its own actual task steps; do not switch to, overwrite or start unrelated work. Retry the corrected task_plan only after this explicit saved:false rejection; an unconfirmed result must never be retried automatically. If an accepted request needs clarification or missing information, register it before asking the user: explicitly set status to waiting_user, keep at least one step pending, and mark no step inProgress. A waiting_user plan cannot have every step completed. Explicit status running records work that can proceed; omitting status preserves the existing status behavior. Update the same plan as steps advance or the task changes. Keep the returned workId and supply it when the same entrusted task continues in another turn or call; use the saved acknowledgement or task_list to identify the actual matching workId, never guess or select the most recent task. Do not create a new task for each sentence, acknowledgement or progress report. Associate a follow-up with existing work only when its actual meaning continues that task; this includes requested revisions to an unaccepted result awaiting review. Accepted completed work stays closed; an unrelated real request needs a separate task. Ordinary conversation does not need a task plan; a question only asking for task progress does not create a new task. Do not substitute a promise, speech transcript, internal reasoning, or invented percentage for task registration. Finishing one response does not finish the entrusted task. Keep working until the real result is verified, update verified steps to completed, or record waiting_user before asking the user about an actual information blocker. An unfinished checklist remains continuing after an executor turn ends. The application periodically checks eligible unfinished work and may continue it in the same conversation when the executor is confirmed idle; this does not mean an executor is already running between turns. Record waiting_user for an actual information blocker, and respect paused, cancelled, review and unconfirmed states instead of starting another execution channel. A plan never grants new permissions or creates another execution channel.';
export function publicTaskPlan(
  plan: unknown,
  { redact = (text) => text }: RedactOptions = {},
): TaskPlan {
  if (
    !Array.isArray(plan) ||
    !plan.length ||
    plan.length > WorkLimits.PlanSteps ||
    !plan.every(publicPlanStep)
  )
    throw Error('A task plan requires 1–128 actual steps with valid statuses.');
  const clean = plan.map((item) => ({
    step: String(redact(item.step))
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, WorkLimits.PublicStepLength),
    status: item.status,
  }));
  if (clean.some((item) => !item.step)) throw Error('Task steps must have visible text.');
  const current =
    clean.find((item) => item.status === PlanStepStatus.InProgress) ||
    clean.find((item) => item.status === PlanStepStatus.Pending);
  return {
    total: clean.length,
    completed: clean.filter((item) => item.status === PlanStepStatus.Completed).length,
    currentStep: current?.step || '',
    steps: clean,
  };
}
export function taskPlanInput(
  value: unknown,
  { redact = (text) => text }: RedactOptions = {},
): TaskPlanInput {
  const args = properties(value);
  if (
    !args ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(args).some((key) => !['workId', 'title', 'steps', 'status'].includes(key)) ||
    typeof args.title !== 'string' ||
    !args.title.trim() ||
    args.title.length > WorkLimits.PlanTitleLength ||
    (args.workId !== undefined &&
      (typeof args.workId !== 'string' ||
        !args.workId ||
        args.workId.length > WorkLimits.IdLength ||
        /[\x00-\x20\x7f]/.test(args.workId)))
  )
    throw Error('A task plan requires a short concrete title and steps.');
  const title = String(redact(args.title))
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, WorkLimits.PlanTitleLength);
  if (!title) throw Error('Task title must have visible text.');
  if (
    args.status !== undefined &&
    args.status !== TaskStatus.Running &&
    args.status !== TaskStatus.WaitingUser
  )
    throw Error('Task plan status must be running or waiting_user.');
  const plan = publicTaskPlan(args.steps, { redact });
  if (
    args.status === TaskStatus.WaitingUser &&
    (plan.steps.some((step) => step.status === PlanStepStatus.InProgress) ||
      !plan.steps.some((step) => step.status === PlanStepStatus.Pending))
  )
    throw Error(
      'A waiting_user task plan requires at least one pending step and no inProgress steps.',
    );
  return {
    title,
    plan,
    ...(args.workId !== undefined ? { workId: args.workId } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
  };
}

const conversationTools = new Set([
  'task_plan',
  'task_list',
  'task_cancel',
  'send_message',
  'send_chat_message',
  'end_call',
  'react_message',
  'memory_write',
  'skill_list',
  'skill_get',
  'credential_find',
  'credential_get',
  'schedule_list',
  'schedule_save',
  'schedule_delete',
]);
const observedExecutionEvents = new WeakSet<object>();
// Observer copies omit bulk tool fields; retain only their validated category
// in process memory, never on the wire or in serialized task progress.
export function inheritTaskExecutionEvent<Projected>(
  original: unknown,
  projected: Projected,
): Projected {
  if (projected && typeof projected === 'object' && isTaskExecutionEvent(original))
    observedExecutionEvents.add(projected);
  return projected;
}
export function isTaskExecutionEvent(event: unknown): boolean {
  const input = properties(event);
  if (input && observedExecutionEvents.has(input)) return true;
  const method = input?.method,
    params = properties(input?.params) || {};
  if (method === 'item/tool/call')
    return (
      typeof params.tool === 'string' &&
      [
        'skill_save',
        'send_file',
        'create_voice_message',
        'credential_request',
        'credential_store',
      ].includes(params.tool)
    );
  if (method !== 'item/started' && method !== 'item/completed') return false;
  const item = properties(params.item);
  if (!item || !validItemId(item.id)) return false;
  if (
    typeof item.type === 'string' &&
    [
      'commandExecution',
      'fileChange',
      'imageView',
      'imageGeneration',
      'webSearch',
      'collabAgentToolCall',
    ].includes(item.type)
  )
    return true;
  return (
    (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') &&
    typeof item.tool === 'string' &&
    !!item.tool &&
    !conversationTools.has(item.tool)
  );
}
export function registeredWorkFinalStatus<Status extends TaskStatusValue>(
  task: TaskProgressTask | null | undefined,
  status: Status,
): Status | typeof TaskStatus.WaitingUser | typeof TaskStatus.Continuing {
  const plan = task?.workRecord?.plan;
  if (status === TaskStatus.Review && task?.workRecord) {
    if (task.awaitingChatInput || task.credentialWaits || task.planWaitingForUser)
      return TaskStatus.WaitingUser;
    if (
      !plan ||
      (Array.isArray(plan.steps) &&
        plan.steps.some((step) => step.status !== PlanStepStatus.Completed))
    )
      return TaskStatus.Continuing;
  }
  return status;
}

export function startTaskProgress(
  task: TaskProgressTask,
  { at = Date.now(), step = TaskProgressStage.Preparing }: ProgressStartOptions = {},
): TaskExecutionProgress {
  const time = validTime(at) ? at : Date.now();
  task.workProgress = {
    startedAt: time,
    updatedAt: time,
    step: isEnumValue(TaskProgressStage, step) ? step : TaskProgressStage.Working,
    items: new Map(),
  };
  return task.workProgress;
}
export function advanceTaskProgress(
  task: TaskProgressTask,
  step: unknown,
  { at = Date.now() }: ProgressTimeOptions = {},
): boolean {
  if (!isEnumValue(TaskProgressStage, step)) return false;
  const progress = task.workProgress || startTaskProgress(task, { at, step });
  progress.step = step;
  if (validTime(at)) progress.updatedAt = Math.max(progress.updatedAt, at);
  return true;
}

// Only explicit public plans and fixed item categories become UI progress.
// Reasoning, explanations, command text, output, tool arguments and speech stay out.
export function observeTaskProgress(
  task: TaskProgressTask,
  event: unknown,
  { at = Date.now(), redact = (text) => text }: ProgressObserveOptions = {},
): boolean {
  const input = properties(event),
    method = input?.method,
    params = properties(input?.params) || {};
  if (isTaskExecutionEvent(event)) task.workObserved = true;
  if (method === 'turn/plan/updated') {
    const plan = params.plan;
    if (!Array.isArray(plan) || plan.length > WorkLimits.PlanSteps || !plan.every(validPlanStep))
      return false;
    const progress =
        task.workProgress || startTaskProgress(task, { at, step: TaskProgressStage.Working }),
      current =
        plan.find((item) => item.status === PlanStepStatus.InProgress) ||
        plan.find((item) => item.status === PlanStepStatus.Pending);
    progress.plan = {
      total: plan.length,
      completed: plan.filter((item) => item.status === PlanStepStatus.Completed).length,
      currentStep: current
        ? String(redact(current.step))
            .replace(/[\x00-\x1f\x7f]/g, ' ')
            .trim()
            .slice(0, WorkLimits.PublicStepLength)
        : '',
    };
    if (validTime(at)) progress.updatedAt = Math.max(progress.updatedAt, at);
    return true;
  }
  if (method === 'item/agentMessage/delta' && typeof params.delta === 'string')
    return advanceTaskProgress(task, TaskProgressStage.Responding, { at });
  if (method === 'item/tool/call' || method === 'item/tool/requestUserInput')
    return advanceTaskProgress(task, TaskProgressStage.Working, { at });
  if (method !== 'item/started' && method !== 'item/completed') return false;
  const item = properties(params.item);
  if (!item || !validItemId(item.id)) return false;
  const step =
    item.type === 'mcpToolCall'
      ? item.server === 'dant_desktop'
        ? TaskProgressStage.Computer
        : TaskProgressStage.Working
      : typeof item.type === 'string'
        ? itemSteps.get(item.type)
        : undefined;
  if (!step) return false;
  const progress =
    task.workProgress || startTaskProgress(task, { at, step: TaskProgressStage.Working });
  if (method === 'item/started') {
    if (progress.items.has(item.id) || progress.items.size < WorkLimits.ObservedItems)
      progress.items.set(item.id, step);
  } else progress.items.delete(item.id);
  const current = [...progress.items.values()].at(-1);
  return advanceTaskProgress(task, current || TaskProgressStage.Working, { at });
}

export function taskProgressSnapshot(
  task: TaskProgressTask | null | undefined,
  {
    source = 'chat',
    background = false,
    status = TaskStatus.Running,
    startedAt,
    redact = (text) => text,
    saving = false,
  }: ProgressSnapshotOptions = {},
): TaskProgressSnapshot {
  const progress = task?.workProgress,
    progressStartedAt = progress?.startedAt,
    progressUpdatedAt = progress?.updatedAt,
    progressStep = progress?.step,
    start = validTime(progressStartedAt)
      ? progressStartedAt
      : validTime(startedAt)
        ? startedAt
        : null,
    updated = validTime(progressUpdatedAt) ? progressUpdatedAt : start;
  const result: TaskProgressSnapshot = {
    messageId: task?.messageId || null,
    turnId: task?.turnId || null,
    source: source === 'voice' ? 'voice' : 'chat',
    background: background === true,
    status: activeStatus(status) ? status : TaskStatus.Running,
    startedAt: start,
    updatedAt: updated,
    step: saving
      ? TaskProgressStage.Saving
      : isEnumValue(TaskProgressStage, progressStep)
        ? progressStep
        : TaskProgressStage.Working,
  };
  if (progress?.plan)
    result.plan = {
      total: progress.plan.total,
      completed: progress.plan.completed,
      currentStep: String(redact(progress.plan.currentStep)).slice(0, WorkLimits.PublicStepLength),
    };
  if (task?.workRecord) {
    result.workId = task.workRecord.id;
    result.title = String(redact(task.workRecord.title)).slice(0, WorkLimits.PlanTitleLength);
    if (task.workRecord.plan) result.plan = publicTaskPlan(task.workRecord.plan.steps, { redact });
    else delete result.plan;
    if (validTime(task.workRecord.startedAt)) result.startedAt = task.workRecord.startedAt;
  }
  return result;
}
export function voiceCompletionWork(
  task: TaskProgressTask | null | undefined,
  status: unknown,
  { at = Date.now() }: ProgressTimeOptions = {},
): VoiceCompletionWork | undefined {
  if (!completionStatus(status)) return undefined;
  const work: VoiceCompletionWork = { source: 'voice', status },
    startedAt = task?.workProgress?.startedAt;
  if (validTime(startedAt)) work.startedAt = startedAt;
  if (validTime(at)) work.updatedAt = at;
  return work;
}
export function safeCompletionWork(work: unknown): VoiceCompletionWork | undefined {
  if (
    !work ||
    typeof work !== 'object' ||
    Array.isArray(work) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(work))
  )
    return undefined;
  const fields = Object.getOwnPropertyDescriptors(work as Record<string, unknown>),
    source = fields.source?.value,
    status = fields.status?.value;
  if (source !== 'voice' || !completionStatus(status)) return undefined;
  const result: VoiceCompletionWork = { source, status };
  for (const key of ['startedAt', 'updatedAt'] as const) {
    const value: unknown = fields[key]?.value;
    if (validTime(value)) result[key] = value;
  }
  return result;
}
