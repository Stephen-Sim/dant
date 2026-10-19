import { languageInfo } from '../../src/i18n/languages.mts';
import { localizeMessages, translateCount } from '../../src/i18n/i18n.mts';
const DAY = 86400000;
const modes = ['daily', 'weekly', 'cumulative'];
const providers = ['subscription', 'apiVoice'];
const words = {
  en: {
    activity: 'Token activity',
    subscription: 'ChatGPT work',
    apiVoice: 'API voice',
    provider: 'Usage source',
    lifetime: 'Lifetime tokens',
    peak: 'Peak daily tokens',
    longest: 'Longest streak',
    current: 'Current streak',
    days: (value) => `${value} ${value === 1 ? 'day' : 'days'}`,
    daily: 'Daily',
    weekly: 'Weekly',
    cumulative: 'Cumulative',
    missing: 'No report',
    unavailable: 'Unavailable',
    tokens: 'tokens',
    less: 'Less',
    more: 'More',
    empty: 'Daily history starts with new usage reports. Earlier totals are not assigned to dates.',
    hint: 'Hover or focus a day to see exact usage.',
    weekHint: 'Hover or focus a week to see exact usage.',
    cumulativeHint: 'Hover or focus a point to see the recorded total.',
    history: 'Charts and streaks use dated reports from the last 365 days.',
    undated:
      'Earlier or undated usage is included in lifetime tokens, but excluded from charts and streaks.',
    timezone: 'Calendar time zone',
    recorded: 'Recorded',
    reportDays: 'reported days',
    unreported: 'Days without a report are unknown, not zero.',
    streakHint:
      'Consecutive days with recorded usage in this 365-day view. The current streak may end today or yesterday.',
    cumulativeTitle: 'Cumulative dated tokens',
    weekOf: 'Week of',
    chartYear: 'Past 365 days',
    zero: '0 tokens reported',
  },
  zh: {
    activity: 'Token 活跃度',
    subscription: 'ChatGPT 工作',
    apiVoice: 'API 语音',
    provider: '用量来源',
    lifetime: '累计 Token',
    peak: '单日最高 Token',
    longest: '最长连续天数',
    current: '当前连续天数',
    days: (value) => `${value} 天`,
    daily: '每日',
    weekly: '每周',
    cumulative: '累计',
    missing: '未记录',
    unavailable: '暂无数据',
    tokens: 'Token',
    less: '少',
    more: '多',
    empty: '收到新用量报告后开始记录每日历史，旧的累计用量不会分配到日期。',
    hint: '悬停或用键盘选中日期，查看精确用量。',
    weekHint: '悬停或用键盘选中周，查看精确用量。',
    cumulativeHint: '悬停或用键盘选中数据点，查看已记录累计用量。',
    history: '图表与连续天数使用最近 365 天有日期的用量记录。',
    undated: '较早或无日期的用量计入累计 Token，不计入图表与连续天数。',
    timezone: '日历时区',
    recorded: '已记录',
    reportDays: '个记录日',
    unreported: '未收到报告的日期显示为未记录，不代表用量为 0。',
    streakHint: '此 365 天视图中，有用量记录的连续日期；当前连续天数可截至今天或昨天。',
    cumulativeTitle: '按日期记录的累计 Token',
    weekOf: '周起始日',
    chartYear: '最近 365 天',
    zero: '已记录 0 Token',
  },
};
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const dateNumber = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? at : null;
};
const iso = (at) => new Date(at).toISOString().slice(0, 10);
const safeAdd = (left, right) => (Number.isSafeInteger(left + right) ? left + right : null);
function calendarToday(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(now));
    return dateNumber(
      ['year', 'month', 'day']
        .map((key) => parts.find((part) => part.type === key)?.value)
        .join('-'),
    );
  } catch {
    return Math.floor(now / DAY) * DAY;
  }
}
function validZone(value) {
  try {
    if (typeof value !== 'string' || value.length > 100) return 'UTC';
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return value;
  } catch {
    return 'UTC';
  }
}

// Calendar arithmetic uses date-only UTC numbers after choosing the stored history zone.
// It never interprets a historical bucket in the viewer's local time zone.
export function buildUsageActivity({ usage, provider = 'subscription', now = Date.now() } = {}) {
  provider = providers.includes(provider) ? provider : 'subscription';
  const timeZone = validZone(usage?.activity?.timeZone),
    today = calendarToday(Number.isFinite(now) ? now : Date.now(), timeZone),
    start = today - 364 * DAY,
    recorded = new Map();
  for (const row of Array.isArray(usage?.activity?.days) ? usage.activity.days : []) {
    const at = dateNumber(row?.date),
      counts = row?.[provider];
    if (
      at === null ||
      at < start ||
      at > today ||
      recorded.has(at) ||
      !counts ||
      !integer(counts.inputTokens) ||
      !integer(counts.outputTokens)
    )
      continue;
    const total = safeAdd(counts.inputTokens, counts.outputTokens);
    if (total !== null) recorded.set(at, total);
  }
  const dates = Array.from({ length: 365 }, (_, index) => {
    const at = start + index * DAY;
    return { at, date: iso(at), value: recorded.get(at) ?? null };
  });
  const known = dates.filter((day) => day.value !== null),
    peak = known.length ? Math.max(...known.map((day) => day.value)) : null;
  let longest = 0,
    current = 0,
    run = 0;
  for (const day of dates) {
    run = day.value > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let cursor = recorded.get(today) > 0 ? today : today - DAY;
  while (cursor >= start && recorded.get(cursor) > 0) {
    current++;
    cursor -= DAY;
  }
  const firstWeek = start - ((new Date(start).getUTCDay() + 6) % 7) * DAY,
    weeks = [];
  for (let at = firstWeek; at <= today; at += 7 * DAY) {
    const days = dates.filter((day) => day.at >= at && day.at < at + 7 * DAY),
      reports = days.filter((day) => day.value !== null);
    let value = reports.length ? 0 : null;
    for (const day of reports) value = value === null ? null : safeAdd(value, day.value);
    weeks.push({
      at,
      date: iso(at),
      end: iso(Math.min(at + 6 * DAY, today)),
      value,
      reports: reports.length,
    });
  }
  let running = 0;
  const cumulative = [];
  for (const day of known) {
    running = safeAdd(running, day.value);
    if (running === null) break;
    cumulative.push({ ...day, total: running });
  }
  const totals = usage?.[provider]?.totals,
    lifetime =
      usage?.[provider]?.available === true &&
      integer(totals?.inputTokens) &&
      integer(totals?.outputTokens)
        ? safeAdd(totals.inputTokens, totals.outputTokens)
        : null;
  const undated = usage?.activity?.unallocated?.[provider];
  return {
    provider,
    timeZone,
    today,
    start,
    firstWeek,
    dates,
    weeks,
    cumulative,
    known,
    peak,
    lifetime,
    longest: known.length ? longest : null,
    current: known.length ? current : null,
    hasUndated: integer(undated?.totalTokens) && undated.totalTokens > 0,
  };
}

export function renderUsageActivity({
  usage,
  language = 'en',
  provider = 'subscription',
  mode = 'daily',
  now = Date.now(),
} = {}) {
  const tr = {
      ...localizeMessages(words, language),
      days: (value) => translateCount(language, value, '{count} day', '{count} days', '{count} 天'),
    },
    locale = languageInfo(language).locale,
    model = buildUsageActivity({ usage, provider, now });
  mode = modes.includes(mode) ? mode : 'daily';
  const number = (value) =>
    integer(value) ? new Intl.NumberFormat(locale).format(value) : tr.unavailable;
  const compact = (value) =>
    integer(value)
      ? new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
          value,
        )
      : '—';
  const date = (value) =>
    new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(value));
  const month = (value) =>
    new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(value));
  const valueLabel = (value) => (value === null ? tr.missing : `${number(value)} ${tr.tokens}`);
  const summary = (key, label, value, streak = false) =>
    `<div class="usage-stat"${streak ? ` title="${escape(tr.streakHint)}"` : ''}><strong data-usage-stat="${key}" title="${escape(value === null ? tr.unavailable : streak ? tr.days(value) : `${number(value)} ${tr.tokens}`)}">${value === null ? '—' : streak ? escape(tr.days(value)) : compact(value)}</strong><span>${label}</span></div>`;
  const summaryHtml = `<div class="usage-statistics">${summary('lifetime', tr.lifetime, model.lifetime)}${summary('peak', tr.peak, model.peak)}${summary('longest', tr.longest, model.longest, true)}${summary('current', tr.current, model.current, true)}</div>`;
  let chart = '';
  if (mode === 'daily') {
    const columns = model.weeks.length,
      peak = model.peak ?? 0;
    let previousMonth = -1;
    const labels = [];
    for (let index = 0; index < columns; index++) {
      const day = Math.max(model.weeks[index].at, model.start),
        current = new Date(day).getUTCMonth();
      if (current !== previousMonth) {
        labels.push(`<span style="grid-column:${index + 1}">${escape(month(day))}</span>`);
        previousMonth = current;
      }
    }
    const cells = [];
    for (let at = model.firstWeek; at < model.firstWeek + columns * 7 * DAY; at += DAY) {
      if (at < model.start || at > model.today) {
        cells.push('<span class="usage-cell usage-cell-outside" aria-hidden="true"></span>');
        continue;
      }
      const item = model.dates[Math.round((at - model.start) / DAY)],
        level =
          item.value === null
            ? 'unknown'
            : item.value === 0
              ? '0'
              : String(Math.max(1, Math.min(4, Math.ceil((item.value / peak) * 4)))),
        label = `${date(at)} · ${valueLabel(item.value)}`;
      cells.push(
        `<button type="button" class="usage-cell" data-usage-point data-usage-level="${level}" data-usage-date="${item.date}" data-usage-label="${escape(label)}" aria-label="${escape(label)}" title="${escape(label)}" tabindex="${at === model.today ? '0' : '-1'}"></button>`,
      );
    }
    chart = `<div class="usage-calendar-scroll"><div class="usage-calendar" style="--usage-columns:${columns}"><div class="usage-calendar-months" aria-hidden="true">${labels.join('')}</div><div class="usage-calendar-grid" role="group" aria-label="${escape(`${tr.activity} · ${tr.chartYear}`)}">${cells.join('')}</div></div></div>`;
  } else {
    const width = 800,
      height = 224,
      left = 50,
      right = 16,
      top = 14,
      bottom = 34,
      plotWidth = width - left - right,
      plotHeight = height - top - bottom;
    const items = mode === 'weekly' ? model.weeks : model.cumulative,
      highest = Math.max(
        1,
        ...items.map((item) => (mode === 'weekly' ? (item.value ?? 0) : item.total)),
      );
    const x = (at) =>
        left + ((at - model.firstWeek) / (model.today - model.firstWeek || DAY)) * plotWidth,
      y = (value) => top + (1 - value / highest) * plotHeight;
    const grid = [0, 0.5, 1]
      .map((ratio) => {
        const value = Math.round(highest * ratio),
          at = y(value);
        return `<line x1="${left}" y1="${at}" x2="${width - right}" y2="${at}"/><text x="${left - 9}" y="${at + 4}" text-anchor="end">${escape(compact(value))}</text>`;
      })
      .join('');
    let previousMonth = -1;
    const labels = [];
    for (const week of model.weeks) {
      const current = new Date(week.at).getUTCMonth();
      if (current !== previousMonth) {
        labels.push(
          `<text x="${Math.max(left, Math.min(width - right - 12, x(week.at)))}" y="${height - 9}">${escape(month(week.at))}</text>`,
        );
        previousMonth = current;
      }
    }
    let marks = '';
    if (mode === 'weekly') {
      const barWidth = Math.max(3, plotWidth / model.weeks.length - 3);
      marks = items
        .map((item, index) => {
          const label = `${date(item.at)} – ${date(dateNumber(item.end))} · ${valueLabel(item.value)} · ${number(item.reports)} ${tr.reportDays}`,
            barHeight = item.value === null ? 3 : Math.max(2, (plotHeight * item.value) / highest);
          return `<g data-usage-point data-usage-label="${escape(label)}" data-usage-date="${item.date}" tabindex="${index === items.length - 1 ? '0' : '-1'}" role="button" aria-label="${escape(label)}"><title>${escape(label)}</title><rect class="usage-week-bar${item.value === null ? ' usage-week-unknown' : ''}" x="${left + index * (plotWidth / items.length)}" y="${top + plotHeight - barHeight}" width="${barWidth}" height="${barHeight}" rx="2"/></g>`;
        })
        .join('');
    } else {
      const points = items.map((item) => `${x(item.at)},${y(item.total)}`).join(' ');
      marks = `${items.length > 1 ? `<polyline class="usage-cumulative-line" points="${points}"/>` : ''}${items
        .map((item, index) => {
          const label = `${date(item.at)} · ${tr.recorded} ${number(item.total)} ${tr.tokens} · ${valueLabel(item.value)}`;
          return `<g data-usage-point data-usage-label="${escape(label)}" data-usage-date="${item.date}" tabindex="${index === items.length - 1 ? '0' : '-1'}" role="button" aria-label="${escape(label)}"><title>${escape(label)}</title><circle class="usage-cumulative-point" cx="${x(item.at)}" cy="${y(item.total)}" r="3"/><circle class="usage-point-target" cx="${x(item.at)}" cy="${y(item.total)}" r="8"/></g>`;
        })
        .join('')}`;
    }
    chart = `<div class="usage-plot-scroll"><svg class="usage-plot" viewBox="0 0 ${width} ${height}" role="group" aria-label="${escape(mode === 'weekly' ? tr.weekly : tr.cumulativeTitle)}"><g class="usage-plot-axis">${grid}${labels.join('')}</g>${marks}</svg></div>`;
  }
  const hint = mode === 'daily' ? tr.hint : mode === 'weekly' ? tr.weekHint : tr.cumulativeHint;
  return `<div data-usage-activity data-usage-current-mode="${mode}"><div class="usage-source" role="group" aria-label="${escape(tr.provider)}">${providers.map((key) => `<button type="button" data-usage-source="${key}" aria-pressed="${model.provider === key}">${tr[key]}</button>`).join('')}</div>${summaryHtml}<div class="usage-chart-heading"><div><h3>${tr.activity}</h3><small>${tr.chartYear} · ${escape(model.timeZone)}</small></div><div class="usage-mode" role="group" aria-label="${escape(tr.activity)}">${modes.map((key) => `<button type="button" data-usage-mode="${key}" aria-pressed="${mode === key}">${tr[key]}</button>`).join('')}</div></div>${chart}<div class="usage-chart-footer"><p class="usage-tooltip" data-usage-tooltip aria-live="polite">${escape(hint)}</p>${mode === 'daily' ? `<div class="usage-legend"><span class="usage-cell" data-usage-level="unknown" title="${escape(tr.missing)}"></span><span>${tr.missing}</span><span class="usage-legend-gap">${tr.less}</span>${[0, 1, 2, 3, 4].map((level) => `<span class="usage-cell" data-usage-level="${level}" aria-hidden="true"></span>`).join('')}<span>${tr.more}</span></div>` : ''}</div>${!model.known.length ? `<p class="usage-history-note">${tr.empty}</p>` : ''}<p class="usage-history-note">${tr.history} ${tr.unreported}${model.hasUndated ? ` ${tr.undated}` : ''}</p></div>`;
}

export function createUsageActivityController({ document, onChange = () => {} } = {}) {
  let mode = 'daily',
    provider = 'subscription',
    detailsOpen = false;
  const bound = new WeakSet();
  return {
    get state() {
      return { mode, provider, detailsOpen };
    },
    bind() {
      const root = document?.querySelector('[data-usage-dashboard]');
      if (!root || bound.has(root)) return;
      bound.add(root);
      root.addEventListener('click', (event) => {
        const modeButton = event.target?.closest?.('[data-usage-mode]'),
          sourceButton = event.target?.closest?.('[data-usage-source]');
        if (
          modeButton &&
          modes.includes(modeButton.dataset.usageMode) &&
          mode !== modeButton.dataset.usageMode
        ) {
          mode = modeButton.dataset.usageMode;
          onChange();
          document.querySelector(`[data-usage-mode="${mode}"]`)?.focus();
        } else if (
          sourceButton &&
          providers.includes(sourceButton.dataset.usageSource) &&
          provider !== sourceButton.dataset.usageSource
        ) {
          provider = sourceButton.dataset.usageSource;
          onChange();
          document.querySelector(`[data-usage-source="${provider}"]`)?.focus();
        }
      });
      const tooltip = (event) => {
        const point = event.target?.closest?.('[data-usage-point]'),
          label = root.querySelector('[data-usage-tooltip]');
        if (point && label) {
          label.textContent = point.dataset.usageLabel;
          for (const peer of root.querySelectorAll('[data-usage-point]'))
            peer.tabIndex = peer === point ? 0 : -1;
        }
      };
      root.addEventListener('pointerover', tooltip);
      root.addEventListener('focusin', tooltip);
      root.addEventListener('keydown', (event) => {
        const point = event.target?.closest?.('[data-usage-point]');
        if (!point) return;
        const points = [...root.querySelectorAll('[data-usage-point]')],
          index = points.indexOf(point),
          step = mode === 'daily' ? 7 : 1;
        const offsets = { ArrowLeft: -step, ArrowRight: step, ArrowUp: -1, ArrowDown: 1 };
        let next;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = points.length - 1;
        else if (event.key in offsets)
          next = Math.max(0, Math.min(points.length - 1, index + offsets[event.key]));
        if (next !== undefined) {
          event.preventDefault();
          for (const peer of points) peer.tabIndex = -1;
          points[next].tabIndex = 0;
          points[next].focus();
          tooltip({ target: points[next] });
        }
      });
      root.querySelector('[data-usage-details]')?.addEventListener('toggle', (event) => {
        detailsOpen = event.currentTarget.open;
      });
    },
  };
}
