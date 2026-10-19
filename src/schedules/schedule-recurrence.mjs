const error = (message) => Object.assign(Error(message), { status: 400 });
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
const priorities = { high: 0, normal: 1, low: 2 };

export function schedulePriority(value = 'normal') {
  if (!Object.hasOwn(priorities, value))
    throw error('Schedule priority must be high, normal or low.');
  return value;
}

function field(source, min, max, names) {
  const values = new Set();
  const number = (value) => {
    const numeric = names?.has(value)
      ? names.get(value)
      : /^\d{1,2}$/.test(value)
        ? Number(value)
        : NaN;
    if (!Number.isInteger(numeric) || numeric < min || numeric > max)
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
      first = number(ends[0]);
      last = number(ends[1]);
      if (first > last) throw error('A cron range must be ascending.');
    } else {
      if (stepText !== undefined) throw error('Apply cron steps to an asterisk or range.');
      first = last = number(range);
    }
    for (let value = first; value <= last; value += step) values.add(value);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard: source.includes('*') };
}

export function parseScheduleCron(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\r\n\0]/.test(value))
    throw error('Use a five-field cron expression.');
  const expression = value.trim().toLowerCase().replace(/\s+/g, ' '),
    parts = expression.split(' ');
  if (parts.length !== 5)
    throw error('Use five cron fields: minute hour day-of-month month day-of-week.');
  const [minutes, hours, dates, month, weekday] = [
    field(parts[0], 0, 59),
    field(parts[1], 0, 23),
    field(parts[2], 1, 31),
    field(parts[3], 1, 12, months),
    field(parts[4], 0, 7, weekdays),
  ];
  weekday.values = [...new Set(weekday.values.map((value) => (value === 7 ? 0 : value)))].sort(
    (a, b) => a - b,
  );
  return { expression, minutes, hours, dates, months: month, weekdays: weekday };
}

function formatter(timeZone) {
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
function partsAt(at, format) {
  const values = Object.fromEntries(
    format
      .formatToParts(at)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}
const wallAt = (parts) =>
  Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
const sameMinute = (a, b) =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute;

/** The next real instant strictly after `after`, evaluated in the saved zone. */
export function nextScheduleAt(cron, { after = Date.now(), timeZone = 'UTC' } = {}) {
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
      offsets = new Set();
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
export function orderScheduledQueue(queue) {
  const scheduled = queue
    .filter((message) => message.scheduled === true)
    .map((message, index) => ({ message, index }))
    .sort(
      (a, b) =>
        (priorities[a.message.progressPriority] ?? 1) -
          (priorities[b.message.progressPriority] ?? 1) || a.index - b.index,
    );
  let next = 0;
  for (let index = 0; index < queue.length; index++)
    if (queue[index].scheduled === true) queue[index] = scheduled[next++].message;
  return queue;
}
