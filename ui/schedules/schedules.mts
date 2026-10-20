import { escapeHtml as escape } from '../shared/html.mts';
import { isRecord, isSafeInteger, requestError } from '../shared/contracts.mts';
import { ScheduleStatus, TaskPriority, ConnectionStatus, isEnumValue } from '../shared/states.mts';
import type { TaskPriorityValue } from '../shared/api-types.ts';
import type { UiSchedule, UiState, ApiRequest } from '../shared/contracts.mts';
interface ScheduleBody {
  text: string;
  at?: number | null;
  timeZone: string;
  cron?: string | null;
  priority?: TaskPriorityValue;
}
interface ScheduleDraft {
  id: string | null;
  text: string;
  at: string;
  timeZone: string;
  repeat: string;
  time: string;
  weekday: string;
  cron: string;
  originalCron: string | null;
  ruleDirty: boolean;
  priority: TaskPriorityValue;
  clientRequestId: string | null;
  creation?: ScheduleBody & { clientRequestId: string | null };
}
export type ScheduleObservation = Omit<UiSchedule, 'at' | 'status'> & {
  at: number | string;
  status: string;
};
type ScheduleState = Omit<UiState, 'schedules'> & { schedules?: ScheduleObservation[] };
interface ScheduleOptions {
  getState: () => ScheduleState | null;
  request: ApiRequest;
  render: () => void;
  toast: (message: string) => void;
  document?: Document;
  connected?: () => boolean;
  icon?: (name: string) => string;
  now?: () => number;
  timeZone?: () => string;
  getID?: () => string;
}
const isSchedule = (value: unknown): value is UiSchedule =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.text === 'string' &&
  isSafeInteger(value.at) &&
  isEnumValue(ScheduleStatus, value.status) &&
  (value.cron === undefined || value.cron === null || typeof value.cron === 'string') &&
  (value.timeZone === undefined || typeof value.timeZone === 'string') &&
  (value.priority === undefined || isEnumValue(TaskPriority, value.priority));
export function schedulesSnapshot(value: unknown): UiSchedule[] {
  const items = Array.isArray(value) ? value : isRecord(value) ? value.items : null;
  if (!Array.isArray(items) || !items.every(isSchedule)) throw Error('Invalid schedule list');
  return items;
}
import { languageInfo } from '../i18n/languages.mts';
import { localizeMessages, translateCount } from '../i18n/messages.mts';
const baseCopy = {
  en: {
    title: 'Scheduled tasks',
    hint: 'Tell dant what to do and when, or create a task here.',
    create: 'Create task',
    search: 'Search scheduled tasks',
    placeholder: 'Search tasks…',
    upcoming: 'Upcoming',
    paused: 'Paused',
    history: 'History',
    all: 'All',
    pending: 'Scheduled',
    dispatched: 'Sent to work',
    unknown: 'Submission unconfirmed',
    task: 'Task',
    at: 'Run at',
    zone: 'Time zone',
    once: 'Runs once',
    save: 'Save task',
    cancel: 'Cancel',
    edit: 'Edit',
    pause: 'Pause',
    resume: 'Resume',
    remove: 'Remove',
    refresh: 'Refresh',
    empty: 'No scheduled tasks',
    emptyHint: 'Ask dant to schedule work in chat or during a call.',
    noMatch: 'No matching tasks',
    offline: 'Connect the work computer to manage scheduled tasks.',
    availability:
      'Runs while dant and its work computer are online. Missed tasks wait until they are available.',
    future: 'Choose a future date and time.',
    required: 'Describe what dant should do.',
    error: 'The scheduled task could not be saved. Your draft is kept.',
    count: (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`,
    editTitle: 'Edit scheduled task',
  },
  zh: {
    title: '定时任务',
    hint: '告诉 dant 做什么、什么时候做，也可以在这里创建。',
    create: '创建任务',
    search: '搜索定时任务',
    placeholder: '搜索任务…',
    upcoming: '即将执行',
    paused: '已暂停',
    history: '历史',
    all: '全部',
    pending: '已安排',
    dispatched: '已交给任务执行',
    unknown: '提交未确认',
    task: '任务内容',
    at: '执行时间',
    zone: '时区',
    once: '执行一次',
    save: '保存任务',
    cancel: '取消',
    edit: '编辑',
    pause: '暂停',
    resume: '继续',
    remove: '移除',
    refresh: '刷新',
    empty: '暂无定时任务',
    emptyHint: '在聊天或通话中告诉 dant，即可安排定时工作。',
    noMatch: '没有匹配的任务',
    offline: '连接工作电脑后可管理定时任务。',
    availability: 'dant 和工作电脑在线时执行，错过的任务会等待恢复可用后执行。',
    future: '请选择未来的日期和时间。',
    required: '请填写需要 dant 完成的工作。',
    error: '定时任务未能保存，草稿已保留。',
    count: (n: number) => `${n} 项任务`,
    editTitle: '编辑定时任务',
  },
};
const copy = {
  en: Object.assign(baseCopy.en, {
    repeat: 'Repeat',
    daily: 'Every day',
    weekly: 'Every week',
    custom: 'Custom cron',
    time: 'Time',
    weekday: 'Day of week',
    priority: 'Priority',
    high: 'High',
    normal: 'Normal',
    low: 'Low',
    next: 'Next run',
    calculated: 'The next run is calculated when you save.',
    updateNeeded: 'Update the work computer service to use repeating schedules and priorities.',
    cron: 'Cron expression',
    cronHint:
      'Five fields: minute · hour · day of month · month · day of week. Supports *, lists, ranges and steps; Sunday is 0 or 7. If both day fields are restricted, either may match.',
    cronInvalid: 'Enter a valid five-field cron expression.',
    timeRequired: 'Choose a valid time.',
    minute: 'Minute',
    hour: 'Hour',
    monthDay: 'Day',
    month: 'Month',
    weekDay: 'Weekday',
    weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  }),
  zh: Object.assign(baseCopy.zh, {
    repeat: '重复',
    daily: '每天',
    weekly: '每周',
    custom: '自定义 Cron',
    time: '时间',
    weekday: '星期',
    priority: '优先级',
    high: '高',
    normal: '普通',
    low: '低',
    next: '下次执行',
    calculated: '保存后会计算下一次执行时间。',
    updateNeeded: '请更新工作电脑服务后，使用重复定时与优先级。',
    cron: 'Cron 表达式',
    cronHint:
      '五个字段：分钟 · 小时 · 日期 · 月份 · 星期。支持 *、列表、范围和步长；周日用 0 或 7。日期和星期同时受限时，任一匹配即可。',
    cronInvalid: '请输入有效的五字段 Cron 表达式。',
    timeRequired: '请选择有效时间。',
    minute: '分钟',
    hour: '小时',
    monthDay: '日期',
    month: '月份',
    weekDay: '星期',
    weekdays: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
  }),
};

const priorities = [TaskPriority.High, TaskPriority.Normal, TaskPriority.Low] as const,
  repeatModes = ['once', 'daily', 'weekly', 'custom'] as const;
const priority = (value: unknown): TaskPriorityValue =>
  isEnumValue(TaskPriority, value) ? value : TaskPriority.Normal;
const clock = (value: unknown) =>
  typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
function recurrence(cron: unknown): Pick<ScheduleDraft, 'repeat' | 'time' | 'weekday'> {
  if (typeof cron !== 'string') return { repeat: 'once', time: '09:00', weekday: '1' };
  const fields = cron.trim().split(/\s+/),
    minute = Number(fields[0]),
    hour = Number(fields[1]);
  if (
    fields.length === 5 &&
    /^\d+$/.test(fields[0] ?? '') &&
    /^\d+$/.test(fields[1] ?? '') &&
    minute <= 59 &&
    hour <= 23 &&
    fields[2] === '*' &&
    fields[3] === '*'
  ) {
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (fields[4] === '*') return { repeat: 'daily', time, weekday: '1' };
    if (/^[0-7]$/.test(fields[4] ?? ''))
      return { repeat: 'weekly', time, weekday: String(Number(fields[4]) % 7) };
  }
  return { repeat: 'custom', time: '09:00', weekday: '1' };
}
function validCron(value: unknown) {
  if (typeof value !== 'string' || value.length > 256 || /[\r\n\0]/.test(value)) return false;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const limits: readonly (readonly [number, number])[] = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 7],
    ],
    months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
    days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return fields.every((field, index) =>
    field.split(',').every((term) => {
      const limit = limits[index];
      if (!limit) return false;
      const pieces = term.split('/');
      if (
        pieces.length > 2 ||
        (pieces.length === 2 &&
          (!/^\d{1,2}$/.test(pieces[1] ?? '') ||
            Number(pieces[1]) < 1 ||
            Number(pieces[1]) > limit[1] - limit[0] + 1))
      )
        return false;
      if (pieces[0] === '*') return true;
      const range = pieces[0]!.split('-');
      if (range.length > 2) return false;
      if (pieces.length === 2 && range.length === 1) return false;
      const numbers = range.map((part) =>
        /^\d{1,2}$/.test(part)
          ? Number(part)
          : index === 3
            ? months.indexOf(part.toUpperCase()) + 1
            : index === 4
              ? days.indexOf(part.toUpperCase())
              : -1,
      );
      return (
        numbers.every(
          (number) => Number.isInteger(number) && number >= limit[0] && number <= limit[1],
        ) &&
        (numbers.length === 1 || numbers[0]! <= numbers[1]!)
      );
    }),
  );
}
const featureBody = (body: unknown) =>
  isRecord(body) && ['cron', 'priority'].some((key) => Object.hasOwn(body, key));
const localValue = (at: number | string, timeZone: string) => {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return '';
  }
};
const isoValue = (at: number | string) => {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
};
// datetime-local has no zone. Convert its wall time using the zone shown beside it,
// then reject nonexistent DST dates instead of silently scheduling another time.
function timestamp(value: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN;
  const wall = Date.parse(value + 'Z');
  if (!Number.isFinite(wall)) return NaN;
  let at = wall;
  for (let attempt = 0; attempt < 4; attempt++) {
    const formatted = localValue(at, timeZone);
    if (!formatted) return NaN;
    const next = at + wall - Date.parse(formatted + 'Z');
    if (next === at) break;
    at = next;
  }
  return localValue(at, timeZone) === value ? at : NaN;
}
export function createSchedules({
  getState,
  request,
  render,
  toast,
  document = globalThis.document,
  connected = () => true,
  icon = () => '',
  now = () => Date.now(),
  timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  getID = () => globalThis.crypto.randomUUID(),
}: ScheduleOptions) {
  let scope: string | null = null,
    query = '',
    filter = 'upcoming',
    editor: ScheduleDraft | null = null,
    busy = false,
    error = '',
    generation = 0;
  const labels = () => {
    const language = getState()?.settings?.language;
    return {
      ...localizeMessages(copy, language),
      count: (value: number) =>
        translateCount(language, value, '{count} task', '{count} tasks', '{count} 项任务'),
    };
  };
  const currentScope = () => {
    const state = getState(),
      vm = state?.settings?.vm;
    return JSON.stringify([state?.conversationId, vm?.host, vm?.user, vm?.port]);
  };
  const online = () =>
    connected() &&
    getState()?.worker?.status === ConnectionStatus.Online &&
    (!getState()?.controller || getState()?.controller?.status === ConnectionStatus.Online) &&
    getState()?.controller?.cached !== true;
  const supported = () => getState()?.capabilities?.recurringSchedules === true;
  function sync() {
    const next = currentScope();
    if (scope !== next) {
      scope = next;
      query = '';
      filter = 'upcoming';
      editor = null;
      busy = false;
      error = '';
      generation++;
    }
  }
  function capture() {
    const form = document.querySelector<HTMLFormElement>('[data-schedule-editor]');
    if (editor && form?.dataset.scheduleScope === scope && !busy) {
      editor.text = form.querySelector<HTMLTextAreaElement>('[name="text"]')?.value ?? editor.text;
      const at = form.querySelector<HTMLInputElement>('[name="at"]');
      if (at) editor.at = at.value;
      for (const key of ['repeat', 'time', 'weekday', 'cron'] as const) {
        const node = form.querySelector<HTMLInputElement>(`[name="${key}"]`);
        if (node && node.value !== editor[key]) {
          editor[key] = node.value;
          editor.ruleDirty = true;
        }
      }
      const selected = form.querySelector<HTMLInputElement>('[name="priority"]');
      if (selected) editor.priority = priority(selected.value);
    }
  }
  const items = (): ScheduleObservation[] => getState()?.schedules ?? [];
  const dateText = (item: ScheduleObservation) => {
    const value = new Date(item.at);
    if (!Number.isFinite(value.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(languageInfo(getState()?.settings?.language).locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: item.timeZone || timeZone(),
      }).format(value);
    } catch {
      return value.toLocaleString();
    }
  };
  function controls(item: ScheduleObservation, locked: boolean) {
    locked ||= typeof item.cron === 'string' && !supported();
    return `<div class="schedule-card-actions">${([ScheduleStatus.Pending, ScheduleStatus.Paused] as readonly string[]).includes(item.status) ? `<button type="button" class="text-btn" data-schedule-edit="${escape(item.id)}" ${locked ? 'disabled' : ''}>${labels().edit}</button><button type="button" class="text-btn" data-schedule-toggle="${escape(item.id)}" ${locked ? 'disabled' : ''}>${labels()[item.status === ScheduleStatus.Pending ? 'pause' : 'resume']}</button>` : ''}<button type="button" class="text-btn" data-schedule-remove="${escape(item.id)}" ${locked ? 'disabled' : ''}>${labels().remove}</button></div>`;
  }
  const ruleText = (item: { cron?: string | null }) => {
    const rule = recurrence(item.cron),
      l = labels();
    return rule.repeat === 'daily'
      ? `${l.daily} · ${rule.time}`
      : rule.repeat === 'weekly'
        ? `${l.weekly} · ${l.weekdays[Number(rule.weekday)]} ${rule.time}`
        : rule.repeat === 'custom'
          ? `${l.custom} · ${item.cron}`
          : l.once;
  };
  function ruleValue(draft: ScheduleDraft) {
    if (draft.repeat === 'once') return null;
    if (!draft.ruleDirty && typeof draft.originalCron === 'string') return draft.originalCron;
    if (draft.repeat === 'custom') return draft.cron;
    const [hour, minute] = draft.time.split(':').map(Number);
    return `${minute} ${hour} * * ${draft.repeat === 'daily' ? '*' : draft.weekday}`;
  }
  function renderEditor() {
    if (!editor) return '';
    const l = labels(),
      enhanced = supported(),
      repeat = editor.repeat !== 'once',
      locked = busy || (repeat && !enhanced),
      scheduled = items().find((item) => item.id === editor?.id);
    const options = (
      values: readonly (readonly [string, string])[],
      selected: string,
      disabled: (value: string) => boolean = () => false,
    ) =>
      values
        .map(
          ([value, label]) =>
            `<option value="${value}" ${value === selected ? 'selected' : ''} ${disabled(value) ? 'disabled' : ''}>${escape(label)}</option>`,
        )
        .join('');
    const settings = `<div class="schedule-editor-options"><label>${l.repeat}<select name="repeat" ${busy ? 'disabled' : ''}>${options(
      repeatModes.map((value) => [value, l[value]] as const),
      editor.repeat,
      (value) => value !== 'once' && !enhanced,
    )}</select></label><label>${l.priority}<select name="priority" ${busy || !enhanced ? 'disabled' : ''}>${options(
      priorities.map((value) => [value, l[value]] as const),
      editor.priority,
    )}</select></label></div>`;
    const when =
      editor.repeat === 'once'
        ? `<label>${l.at}<input name="at" type="datetime-local" value="${escape(editor.at)}" required ${busy ? 'disabled' : ''}></label>`
        : editor.repeat === 'custom'
          ? `<label class="schedule-cron-input">${l.cron}<input name="cron" type="text" value="${escape(editor.cron)}" placeholder="0 9 * * 1-5" required spellcheck="false" autocomplete="off" aria-describedby="schedule-cron-help" ${locked ? 'disabled' : ''}></label>`
          : `<label>${l.time}<input name="time" type="time" value="${escape(editor.time)}" required ${locked ? 'disabled' : ''}></label>${
              editor.repeat === 'weekly'
                ? `<label>${l.weekday}<select name="weekday" ${locked ? 'disabled' : ''}>${options(
                    l.weekdays.map((label, index) => [String(index), label] as const),
                    editor.weekday,
                  )}</select></label>`
                : ''
            }`;
    const help =
      editor.repeat === 'custom'
        ? `<div class="schedule-cron-guide" id="schedule-cron-help"><div>${(['minute', 'hour', 'monthDay', 'month', 'weekDay'] as const).map((key) => `<span>${l[key]}</span>`).join('')}</div><p>${l.cronHint}</p></div>`
        : '';
    return `<section class="schedule-editor" data-key="schedule-editor"><div class="schedule-editor-heading"><h2>${l[editor.id ? 'editTitle' : 'create']}</h2><button type="button" class="icon-btn" data-schedule-cancel aria-label="${l.cancel}" ${busy ? 'disabled' : ''}>${icon('x') || '×'}</button></div><form data-schedule-editor data-schedule-scope="${escape(scope)}"><label>${l.task}<textarea name="text" rows="3" required ${busy ? 'disabled' : ''}>${escape(editor.text)}</textarea></label>${settings}<div class="schedule-editor-time">${when}<div><span>${l.zone}</span><strong>${escape(editor.timeZone)}</strong><small>${escape(ruleText({ cron: repeat ? ruleValue(editor) : null }))}</small></div></div>${help}${repeat ? `<p class="schedule-next-run">${scheduled && !editor.ruleDirty ? `${l.next} · ${escape(dateText(scheduled))}` : l.calculated}</p>` : ''}${!enhanced ? `<p class="schedule-capability-notice" role="status">${l.updateNeeded}</p>` : ''}${error ? `<p class="error" role="status">${escape(error)}</p>` : ''}<div class="form-actions"><button type="button" class="text-btn" data-schedule-cancel ${busy ? 'disabled' : ''}>${l.cancel}</button><button type="submit" class="text-btn primary" ${locked || !online() ? 'disabled' : ''}>${l.save}</button></div></form></section>`;
  }
  function renderPage() {
    sync();
    capture();
    const l = labels(),
      locked = busy || !online(),
      needle = query.normalize('NFKC').toLocaleLowerCase().trim(),
      matches = items()
        .filter(
          (item) =>
            (filter === 'all' ||
              (filter === 'upcoming' && item.status === ScheduleStatus.Pending) ||
              (filter === ScheduleStatus.Paused && item.status === ScheduleStatus.Paused) ||
              (filter === 'history' &&
                !([ScheduleStatus.Pending, ScheduleStatus.Paused] as readonly string[]).includes(
                  item.status,
                ))) &&
            String(item.text || '')
              .normalize('NFKC')
              .toLocaleLowerCase()
              .includes(needle),
        )
        .sort((a, b) =>
          filter === 'history' ? Number(b.at) - Number(a.at) : Number(a.at) - Number(b.at),
        );
    return `<section class="skills-page schedules-page" aria-labelledby="schedules-page-title"><div class="skills-page-heading"><div><h1 id="schedules-page-title">${l.title}</h1><p>${l.hint}</p></div><button type="button" class="text-btn primary skill-page-add" data-schedule-add ${locked ? 'disabled' : ''}><span aria-hidden="true">+</span>${l.create}</button></div>${renderEditor()}<div class="skills-page-toolbar"><label class="skills-search"><span>${l.search}</span><input id="schedules-search" type="search" value="${escape(query)}" placeholder="${l.placeholder}" aria-label="${l.search}"></label><span class="skills-count">${l.count(matches.length)}</span><button type="button" class="text-btn" data-schedules-refresh ${locked ? 'disabled' : ''}>${l.refresh}</button></div><div class="schedule-tabs" role="group" aria-label="${l.title}">${(['upcoming', ScheduleStatus.Paused, 'history', 'all'] as const).map((value) => `<button type="button" data-schedule-filter="${value}" class="${filter === value ? 'selected' : ''}" aria-pressed="${filter === value}">${l[value]}</button>`).join('')}</div><p class="skills-save-hint">${l.availability}</p>${!supported() && !editor ? `<p class="schedule-capability-notice" role="status">${l.updateNeeded}</p>` : ''}${!online() ? `<p class="skills-page-notice" role="status">${l.offline}</p>` : ''}${error && !editor ? `<p class="error" role="status">${escape(error)}</p>` : ''}<div class="scheduled-task-list" aria-busy="${busy}">${matches.map((item) => `<article class="schedule-card" data-key="schedule-${escape(item.id)}"><div class="schedule-card-main"><span class="skill-card-icon">${icon('clock')}</span><div><div class="schedule-card-meta"><span class="schedule-state ${escape(item.status)}">${escape(l[item.status as keyof typeof l] || l.unknown)}</span><span>${escape(ruleText(item))}</span>${supported() || item.priority ? `<span class="schedule-priority" data-schedule-priority="${priority(item.priority)}">${l.priority} · ${l[priority(item.priority)]}</span>` : ''}</div><p class="schedule-card-text">${escape(item.text)}</p><div class="schedule-card-date">${icon('clock')}<span class="schedule-date-label">${item.cron ? l.next : l.at}</span><time datetime="${escape(isoValue(item.at))}">${escape(dateText(item))}</time><span>${escape(item.timeZone || timeZone())}</span></div></div></div>${controls(item, locked)}</article>`).join('')}</div>${!matches.length ? `<div class="skills-page-empty">${icon('clock')}<p>${needle ? l.noMatch : l.empty}</p>${!needle ? `<span>${l.emptyHint}</span>` : ''}</div>` : ''}</section>`;
  }
  async function update(
    mutate?: (current: () => boolean) => Promise<unknown>,
    {
      closeEditor = null,
      removedId = null,
    }: { closeEditor?: ScheduleDraft | null; removedId?: string | null } = {},
  ) {
    if (busy || !online()) return;
    capture();
    const owner = scope,
      version = ++generation,
      current = () => scope === owner && currentScope() === owner && generation === version;
    busy = true;
    error = '';
    render();
    try {
      if (mutate) {
        await mutate(current);
        if (!current()) return;
      }
      const data = await request('/schedules');
      if (!current()) return;
      const refreshed = schedulesSnapshot(data);
      const state = getState();
      if (state) state.schedules = refreshed;
      if (editor === closeEditor || (removedId && editor?.id === removedId)) editor = null;
    } catch (failure) {
      if (current()) {
        error =
          requestError(failure).code === 'service_update_required'
            ? labels().updateNeeded
            : labels().error;
        toast?.(error);
      }
    } finally {
      if (current()) {
        busy = false;
        render();
      }
    }
  }
  function newEditor(item?: ScheduleObservation): ScheduleDraft {
    const zone = item?.timeZone || timeZone();
    return {
      id: item?.id || null,
      text: item?.text || '',
      at: item ? localValue(item.at, zone) : '',
      timeZone: zone,
      ...recurrence(item?.cron),
      cron: typeof item?.cron === 'string' ? item.cron : '0 9 * * *',
      originalCron: typeof item?.cron === 'string' ? item.cron : null,
      ruleDirty: false,
      priority: priority(item?.priority),
      clientRequestId: item ? null : getID(),
    };
  }
  async function save(draft: ScheduleDraft, body: ScheduleBody, current: () => boolean) {
    if (!draft.id) {
      // Keep the original POST payload as well as its key. A retry after a lost
      // acknowledgement recovers the same task before applying any later edits.
      draft.creation ||= { ...body, clientRequestId: draft.clientRequestId };
      const created = await request('/schedules', { method: 'POST', body: draft.creation });
      if (!current()) return;
      if (!isRecord(created) || typeof created.id !== 'string' || !created.id)
        throw Error('Unconfirmed schedule');
      draft.id = created.id;
      if (
        (['text', 'at', 'timeZone', 'cron', 'priority'] as const).every(
          (key) => draft.creation![key] === body[key],
        )
      )
        return;
    }
    const saved = await request('/schedules/' + encodeURIComponent(draft.id), {
      method: 'PATCH',
      body,
    });
    if (!current()) return;
    if (!isRecord(saved) || saved.id !== draft.id) throw Error('Unconfirmed schedule');
  }
  function bind() {
    sync();
    const owner = scope,
      valid = () => scope === owner && currentScope() === owner;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-schedule-add]'))
      button.onclick = () => {
        if (!valid() || busy || !online()) return;
        capture();
        if (editor) return;
        editor = newEditor();
        error = '';
        render();
        document.querySelector<HTMLInputElement>('[data-schedule-editor] textarea')?.focus();
      };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-schedule-cancel]'))
      button.onclick = () => {
        if (!valid() || busy) return;
        editor = null;
        error = '';
        render();
      };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-schedule-edit]'))
      button.onclick = () => {
        if (!valid() || busy || !online()) return;
        const item = items().find((item) => item.id === button.dataset.scheduleEdit);
        if (
          !item ||
          !([ScheduleStatus.Pending, ScheduleStatus.Paused] as readonly string[]).includes(
            item.status,
          )
        )
          return;
        if (typeof item.cron === 'string' && !supported()) {
          error = labels().updateNeeded;
          render();
          return;
        }
        capture();
        if (editor && editor.id !== item.id) return;
        editor ||= newEditor(item);
        error = '';
        render();
      };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-schedule-filter]'))
      button.onclick = () => {
        if (!valid()) return;
        capture();
        filter = button.dataset.scheduleFilter || 'upcoming';
        render();
      };
    const search = document.querySelector<HTMLInputElement>('#schedules-search');
    if (search)
      search.oninput = () => {
        if (!valid()) return;
        query = search.value;
        capture();
        render();
      };
    const form = document.querySelector<HTMLFormElement>('[data-schedule-editor]');
    if (form) {
      form.oninput = capture;
      for (const name of ['repeat', 'time', 'weekday']) {
        const field = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
        if (field)
          field.onchange = () => {
            if (!valid() || busy) return;
            capture();
            render();
          };
      }
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (!valid() || busy || !editor || !online()) return;
        capture();
        const needsFeature =
          editor.repeat !== 'once' || editor.priority !== 'normal' || featureBody(editor.creation);
        if (needsFeature && !supported()) {
          error = labels().updateNeeded;
          render();
          return;
        }
        if (!editor.text.trim()) {
          error = labels().required;
          render();
          return;
        }
        const repeat = editor.repeat !== 'once',
          at = repeat ? null : timestamp(editor.at, editor.timeZone);
        if (!repeat && (typeof at !== 'number' || !Number.isFinite(at) || at <= now())) {
          error = labels().future;
          render();
          return;
        }
        if (
          !(repeatModes as readonly string[]).includes(editor.repeat) ||
          (repeat &&
            (editor.repeat === 'custom'
              ? !validCron(editor.cron)
              : !clock(editor.time) ||
                (editor.repeat === 'weekly' && !/^[0-6]$/.test(editor.weekday))))
        ) {
          error = labels()[editor.repeat === 'custom' ? 'cronInvalid' : 'timeRequired'];
          render();
          return;
        }
        const draft = editor,
          body = {
            text: draft.text.trim(),
            ...(!repeat ? { at } : {}),
            timeZone: draft.timeZone,
            ...(supported() ? { cron: ruleValue(draft), priority: draft.priority } : {}),
          };
        await update((current) => save(draft, body, current), { closeEditor: draft });
      };
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-schedule-toggle]'))
      button.onclick = () => {
        if (!valid() || busy || !online()) return;
        const item = items().find((item) => item.id === button.dataset.scheduleToggle);
        if (
          !item ||
          !([ScheduleStatus.Pending, ScheduleStatus.Paused] as readonly string[]).includes(
            item.status,
          )
        )
          return;
        if (typeof item.cron === 'string' && !supported()) {
          error = labels().updateNeeded;
          render();
          return;
        }
        capture();
        if (
          item.status === ScheduleStatus.Paused &&
          typeof item.cron !== 'string' &&
          (!Number.isFinite(Number(item.at)) || Number(item.at) <= now())
        ) {
          if (!editor) {
            editor = newEditor(item);
            editor.at = '';
          }
          error = labels().future;
          render();
          return;
        }
        return update(() =>
          request('/schedules/' + encodeURIComponent(item.id), {
            method: 'PATCH',
            body: { enabled: item.status !== ScheduleStatus.Pending },
          }),
        );
      };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-schedule-remove]'))
      button.onclick = () => {
        if (valid()) {
          const id = button.dataset.scheduleRemove || '',
            item = items().find((item) => item.id === id);
          if (!item) return;
          if (typeof item.cron === 'string' && !supported()) {
            error = labels().updateNeeded;
            render();
            return;
          }
          return update(
            () => request('/schedules/' + encodeURIComponent(id), { method: 'DELETE' }),
            { removedId: id },
          );
        }
      };
    const refresh = document.querySelector<HTMLInputElement>('[data-schedules-refresh]');
    if (refresh)
      refresh.onclick = () => {
        if (valid()) return update();
      };
  }
  return { renderPage, bind };
}
