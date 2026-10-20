import { translate } from '../i18n/messages.mts';
import { languageInfo } from '../i18n/languages.mts';
import { ConnectionStatus, WorkStatus, SubmissionStatus } from '../shared/states.mts';

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

export interface PresenceDisplay {
  label: string;
  detail: string;
  title: string;
  online: boolean;
  active: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

// Status comes from the live bridge first. Cached work must never appear online.
export function formatPresence(
  value: unknown = {},
  language: unknown = 'zh',
  now: unknown = Date.now(),
): PresenceDisplay {
  const state = record(value) ?? {},
    work = state.active,
    workRecord = record(work),
    call = record(state.call),
    controller = record(state.controller),
    lastActiveAt = record(state.presence)?.lastActiveAt ?? state.lastActiveAt,
    workerStatus = record(state.worker)?.status ?? state.workerStatus;
  const english = language !== 'zh',
    bridge = controller?.status;
  const disconnected =
    controller?.cached === true || (bridge !== undefined && bridge !== ConnectionStatus.Online);
  const online = !disconnected && workerStatus === ConnectionStatus.Online;
  const connecting =
    !online &&
    (bridge === ConnectionStatus.Connecting ||
      (!disconnected && workerStatus === ConnectionStatus.Connecting));
  const inCall = online && call?.status === 'connected' && state.callActiveNow !== false;
  const working =
    online &&
    Boolean(work) &&
    (workRecord?.visible !== false ||
      workRecord.status === WorkStatus.Unknown ||
      workRecord.status === WorkStatus.Pausing ||
      workRecord.status === WorkStatus.WaitingUser);
  const active = inCall || working;
  const unconfirmed =
    online &&
    !active &&
    Array.isArray(state.workTasks) &&
    state.workTasks.some((value: unknown) => {
      const task = record(value),
        continuation = record(task?.continuation);
      return (
        task &&
        !task.progressDismissedAt &&
        (task.status === WorkStatus.Unknown ||
          task.unknownOutcome === true ||
          task.submission === SubmissionStatus.Unknown ||
          task.submission === SubmissionStatus.Submitting ||
          continuation?.invalid ||
          continuation?.dispatch)
      );
    });
  const waiting =
    online &&
    !active &&
    Array.isArray(state.workTasks) &&
    state.workTasks.some((value: unknown) => {
      const task = record(value),
        continuation = record(task?.continuation);
      return (
        task?.status === WorkStatus.WaitingUser &&
        !task.progressDismissedAt &&
        !task.unknownOutcome &&
        task.submission !== SubmissionStatus.Unknown &&
        task.submission !== SubmissionStatus.Submitting &&
        !continuation?.invalid &&
        !continuation?.dispatch
      );
    });
  const validAt =
    typeof lastActiveAt === 'number' &&
    Number.isFinite(lastActiveAt) &&
    lastActiveAt > 0 &&
    lastActiveAt <= MAX_DATE_TIMESTAMP;
  const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  let detail = '',
    title = '',
    activity = '';
  if (validAt) {
    const seconds = Math.floor(Math.max(0, clock - lastActiveAt) / MILLISECONDS_PER_SECOND);
    let ago;
    if (seconds < SECONDS_PER_MINUTE) ago = translate(language, 'just now', '刚刚');
    else {
      const count = Math.floor(
        seconds /
          (seconds < SECONDS_PER_HOUR
            ? SECONDS_PER_MINUTE
            : seconds < SECONDS_PER_DAY
              ? SECONDS_PER_HOUR
              : SECONDS_PER_DAY),
      );
      const unit =
        seconds < SECONDS_PER_HOUR
          ? translate(language, 'minute', '分钟')
          : seconds < SECONDS_PER_DAY
            ? translate(language, 'hour', '小时')
            : translate(language, 'day', '天');
      ago = english ? `${count} ${unit}${count === 1 ? '' : 's'} ago` : `${count} ${unit}前`;
    }
    if (language !== 'en' && language !== 'zh') {
      const unit =
          seconds < SECONDS_PER_HOUR ? 'minute' : seconds < SECONDS_PER_DAY ? 'hour' : 'day',
        count =
          seconds < SECONDS_PER_MINUTE
            ? 0
            : Math.floor(
                seconds /
                  (seconds < SECONDS_PER_HOUR
                    ? SECONDS_PER_MINUTE
                    : seconds < SECONDS_PER_DAY
                      ? SECONDS_PER_HOUR
                      : SECONDS_PER_DAY),
              );
      ago = new Intl.RelativeTimeFormat(languageInfo(language).locale, { numeric: 'auto' }).format(
        -count,
        unit,
      );
    }
    detail = translate(language, 'Last active ', '最近活跃：') + ago;
    title =
      translate(language, 'Last active: ', '最近活跃：') +
      new Date(lastActiveAt).toLocaleString(languageInfo(language).locale);
    activity =
      detail + ' (' + new Date(lastActiveAt).toLocaleString(languageInfo(language).locale) + ')';
  }
  if (inCall) detail = translate(language, 'In a call', '正在通话');
  else if (working) detail = translate(language, 'Working', '正在工作');
  else if (online) {
    detail = unconfirmed
      ? translate(language, 'Work status unconfirmed', '工作状态未确认')
      : waiting
        ? translate(language, 'Waiting for your reply', '等待你回复')
        : translate(language, 'Idle', '空闲');
    const explanation = unconfirmed
      ? translate(
          language,
          'The work computer is connected, but a task execution status has not been confirmed. Check Work progress before retrying.',
          '工作电脑已连接，但有任务的执行状态尚未确认，请先查看工作进度再重试。',
        )
      : waiting
        ? translate(
            language,
            'The work computer is connected. A task is waiting for your reply.',
            '工作电脑已连接，有任务正在等待你回复。',
          )
        : translate(
            language,
            'The work computer is connected. No task is running.',
            '工作电脑已连接，当前没有任务在执行。',
          );
    title = explanation + (activity ? '\n' + activity : '');
  }
  const label = online
    ? translate(language, 'Online', '在线')
    : connecting
      ? translate(language, 'Connecting', '连接中')
      : translate(language, 'Disconnected', '未连接');
  return { label, detail, title, online, active };
}
