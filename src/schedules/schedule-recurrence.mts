import { TaskPriority, isEnumValue } from '../contracts/states.mts';
import type { TaskPriorityValue } from '../contracts/contracts.ts';
interface CronField {
  values: number[];
  wildcard: boolean;
}
export interface ParsedScheduleCron {
  expression: string;
  minutes: CronField;
  hours: CronField;
  dates: CronField;
  months: CronField;
  weekdays: CronField;
}
interface CalendarMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}
interface CalendarParts extends CalendarMinute {
  second: number;
}
interface ScheduledQueueItem {
  id?: unknown;
  scheduled?: unknown;
  progressPriority?: unknown;
}
const error = (message: string) => Object.assign(Error(message), { status: 400 });
const minute = 60000,
  day = 86400000,
  maxTime = 8640000000000000;
const months = new Map(
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map(
    (name, index) => [name, index + 1],
  ),
);
const weekdays = new Map(
  ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((name, index) => [name, index]),
);
const priorities: Record<TaskPriorityValue, number> = { high: 0, normal: 1, low: 2 };

export function schedulePriority(value: unknown = TaskPriority.Normal): TaskPriorityValue {
  if (!isEnumValue(TaskPriority, value))
    throw error('Schedule priority must be high, normal or low.');
  return value;
}

function field(
  source: string,
  min: number,
  max: number,
  names?: ReadonlyMap<string, number>,
): CronField {
  const values = new Set<number>();
  const number = (value: string) => {
    const numeric = names?.has(value)
      ? names.get(value)
      : /^\d{1,2}$/.test(value)
        ? Number(value)
        : NaN;
    if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < min || numeric > max)
      throw error('A cron field contains an out-of-range value.');
    return numeric;
  };
  for (const part of source.split(',')) {
    const [range, stepText, ...extra] = part.split('/');
    if (extra.length || !range || (stepText !== undefined && !/^\d{1,2}$/.test(stepText)))
      throw error('Use cron lists, ranges and positive steps.');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1 || step > max - min + 1) throw error('A cron step is out of range.');
    let first, last;
    if (range === '*') {
      first = min;
      last = max;
    } else if (range.includes('-')) {
      const ends = range.split('-');
      if (ends.length !== 2) throw error('A cron range requires a start and an end.');
      first = number(ends[0] ?? '');
      last = number(ends[1] ?? '');
      if (first > last) throw error('A cron range must be ascending.');
    } else {
      if (stepText !== undefined) throw error('Apply cron steps to an asterisk or range.');
      first = last = number(range);
    }
    for (let value = first; value <= last; value += step) values.add(value);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard: source.includes('*') };
}

export function parseScheduleCron(value: unknown): ParsedScheduleCron {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\r\n\0]/.test(value))
    throw error('Use a five-field cron expression.');
  const expression = value.trim().toLowerCase().replace(/\s+/g, ' '),
    parts = expression.split(' ');
  if (parts.length !== 5)
    throw error('Use five cron fields: minute hour day-of-month month day-of-week.');
  const [minutes, hours, dates, month, weekday] = [
    field(parts[0] ?? '', 0, 59),
    field(parts[1] ?? '', 0, 23),
    field(parts[2] ?? '', 1, 31),
    field(parts[3] ?? '', 1, 12, months),
    field(parts[4] ?? '', 0, 7, weekdays),
  ];
  weekday.values = [...new Set(weekday.values.map((value) => (value === 7 ? 0 : value)))].sort(
    (a, b) => a - b,
  );
  return { expression, minutes, hours, dates, months: month, weekdays: weekday };
}

function formatter(timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw error('Use a valid IANA timezone.');
  }
}
function partsAt(at: number, format: Intl.DateTimeFormat): CalendarParts {
  const values = Object.fromEntries(
    format
      .formatToParts(at)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year ?? NaN,
    month: values.month ?? NaN,
    day: values.day ?? NaN,
    hour: values.hour ?? NaN,
    minute: values.minute ?? NaN,
    second: values.second ?? NaN,
  };
}
const wallAt = (parts: CalendarParts) =>
  Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
const sameMinute = (a: CalendarMinute, b: CalendarMinute) =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute;

/** The next real instant strictly after `after`, evaluated in the saved zone. */
export function nextScheduleAt(
  cron: string | ParsedScheduleCron,
  { after = Date.now(), timeZone = 'UTC' }: { after?: number; timeZone?: string } = {},
) {
  const parsed = typeof cron === 'string' ? parseScheduleCron(cron) : cron;
  if (!Number.isSafeInteger(after) || after <= 0 || after >= maxTime)
    throw error('Use a valid current execution time.');
  const format = formatter(timeZone),
    current = partsAt(after, format),
    firstDay = Date.UTC(current.year, current.month - 1, current.day);
  // A leap-day schedule can be eight years apart across a non-leap century.
  for (let index = 0; index <= 366 * 8 + 2; index++) {
    const date = new Date(firstDay + index * day);
    if (!Number.isFinite(date.getTime())) break;
    const year = date.getUTCFullYear(),
      month = date.getUTCMonth() + 1,
      dateNumber = date.getUTCDate();
    if (!parsed.months.values.includes(month)) continue;
    const dateMatch = parsed.dates.values.includes(dateNumber),
      weekdayMatch = parsed.weekdays.values.includes(date.getUTCDay());
    if (
      parsed.dates.wildcard || parsed.weekdays.wildcard
        ? !(dateMatch && weekdayMatch)
        : !(dateMatch || weekdayMatch)
    )
      continue;
    const base = date.getTime(),
      offsets = new Set<number>();
    for (const hours of [-24, 0, 12, 24, 48]) {
      const sample = base + hours * 3600000;
      if (sample <= 0 || sample > maxTime) continue;
      offsets.add(wallAt(partsAt(sample, format)) - sample);
    }
    let earliest = Infinity;
    for (const offset of offsets) {
      search: for (const hour of parsed.hours.values)
        for (const min of parsed.minutes.values) {
          const candidate = base + hour * 3600000 + min * minute - offset;
          if (candidate <= after || candidate <= 0 || candidate > maxTime) continue;
          if (candidate >= earliest) break search;
          if (
            sameMinute(partsAt(candidate, format), {
              year,
              month,
              day: dateNumber,
              hour,
              minute: min,
            })
          ) {
            earliest = candidate;
            break search;
          }
        }
    }
    if (Number.isFinite(earliest)) return earliest;
  }
  throw error('This cron expression has no execution date within the next eight years.');
}

/** Reorder only queued scheduled slots; human messages keep their positions. */
export function orderScheduledQueue<Message extends ScheduledQueueItem>(
  queue: Message[],
): Message[] {
  const scheduled = queue
    .filter((message) => message.scheduled === true)
    .map((message, index) => ({ message, index }))
    .sort(
      (a, b) =>
        (priorityRank(a.message.progressPriority) ?? 1) -
          (priorityRank(b.message.progressPriority) ?? 1) || a.index - b.index,
    );
  let next = 0;
  for (let index = 0; index < queue.length; index++)
    if (queue[index]?.scheduled === true) {
      const entry = scheduled[next++];
      if (entry) queue[index] = entry.message;
    }
  return queue;
}

function priorityRank(value: unknown): number {
  return isEnumValue(TaskPriority, value) ? priorities[value] : priorities[TaskPriority.Normal];
}
