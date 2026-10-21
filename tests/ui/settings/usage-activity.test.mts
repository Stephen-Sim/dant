import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  buildUsageActivity,
  createUsageActivityController,
  renderUsageActivity,
  usageActivityScope,
} from '../../../ui/settings/usage-activity.mts';
import { renderUsageSettings } from '../../../ui/settings/usage-settings.mts';
import { reconcile } from '../../../ui/shared/dom.mts';

const now = Date.parse('2026-10-18T16:15:00Z'); // Already Oct 19 in the persisted history zone.
const counts = (input: number, output = 0) => ({
  inputTokens: input,
  cachedInputTokens: input,
  outputTokens: output,
  reasoningOutputTokens: output,
  totalTokens: input + output,
});
const usage = {
  recordedSince: now,
  subscription: {
    available: true,
    totals: counts(1000000000, 20),
    lastResponse: { ...counts(20), at: now },
  },
  apiVoice: { available: true, totals: counts(150), lastResponse: { ...counts(50), at: now } },
  activity: {
    timeZone: 'Asia/Kuala_Lumpur',
    recordedSince: now,
    retainedFrom: '2025-09-15',
    days: [
      { date: '2026-10-15', subscription: counts(10, 5), apiVoice: counts(50) },
      { date: '2026-10-16', subscription: counts(20, 10), apiVoice: null },
      { date: '2026-10-17', subscription: null, apiVoice: counts(100) },
      { date: '2026-10-18', subscription: counts(0), apiVoice: null },
      { date: '2026-10-19', subscription: counts(40, 10), apiVoice: null },
    ],
    unallocated: { subscription: counts(999999925), apiVoice: null },
  },
};
const dom = (html: string) => parseHTML(`<html><body>${html}</body></html>`);

test('usage charts reuse a bounded set of Intl formatters while preserving localized point labels', (context) => {
  const NativeDate = Intl.DateTimeFormat,
    NativeNumber = Intl.NumberFormat;
  let dates = 0,
    numbers = 0;
  context.mock.method(
    Intl,
    'DateTimeFormat',
    new Proxy(NativeDate, {
      construct(target, args) {
        dates++;
        return Reflect.construct(target, args);
      },
    }),
  );
  context.mock.method(
    Intl,
    'NumberFormat',
    new Proxy(NativeNumber, {
      construct(target, args) {
        numbers++;
        return Reflect.construct(target, args);
      },
    }),
  );
  for (const language of ['en', 'zh', 'ar']) {
    for (const mode of ['daily', 'weekly', 'cumulative']) {
      dates = 0;
      numbers = 0;
      const html = renderUsageActivity({ usage, now, language, mode });
      assert.ok(dates <= 4, `${language}/${mode}: ${dates} date formatters`);
      assert.ok(numbers <= 6, `${language}/${mode}: ${numbers} number formatters`);
      const document = dom(html).document,
        locale = language === 'zh' ? 'zh-CN' : language === 'ar' ? 'ar' : 'en-US',
        date = new NativeDate(locale, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        }),
        number = new NativeNumber(locale),
        point = document.querySelector<HTMLElement>('[data-usage-date="2026-10-15"]');
      if (mode === 'daily' || mode === 'cumulative') {
        assert.ok(point);
        assert.ok(
          defined(point)
            .getAttribute('aria-label')
            ?.includes(date.format(new Date('2026-10-15T00:00:00Z'))),
        );
        assert.ok(defined(point).getAttribute('aria-label')?.includes(number.format(15)));
      } else assert.ok(document.querySelector('.usage-week-bar'));
    }
  }
});

test('activity uses dated input plus output exactly once and preserves unknown days and provider separation', () => {
  const model = buildUsageActivity({ usage, now });
  assert.equal(model.timeZone, 'Asia/Kuala_Lumpur');
  assert.equal(new Date(model.today).toISOString().slice(0, 10), '2026-10-19');
  assert.equal(model.dates.length, 365);
  assert.equal(defined(model.dates.find((day) => day.date === '2026-10-15')).value, 15);
  assert.equal(defined(model.dates.find((day) => day.date === '2026-10-17')).value, null);
  assert.equal(defined(model.dates.find((day) => day.date === '2026-10-18')).value, 0);
  assert.equal(model.lifetime, 1000000020);
  assert.equal(model.peak, 50);
  assert.equal(model.longest, 2);
  assert.equal(model.current, 1);
  assert.equal(model.hasUndated, true);
  assert.equal(defined(model.cumulative.at(-1)).total, 95);
  assert.equal(defined(model.weeks.find((week) => week.date === '2026-10-12')).value, 45);
  assert.equal(defined(model.weeks.at(-1)).value, 50);
  const voice = buildUsageActivity({ usage, provider: 'apiVoice', now });
  assert.equal(defined(voice.cumulative.at(-1)).total, 150);
  assert.equal(defined(voice.dates.at(-1)).value, null);
  assert.equal(voice.current, 0);
});

test('current streak may end yesterday, but never crosses an unknown or zero day', () => {
  const history = (days: [string, number][]) => ({
    ...usage,
    activity: {
      ...usage.activity,
      days: days.map(([date, total]) => ({ date, subscription: counts(total) })),
    },
  });
  assert.equal(
    buildUsageActivity({
      usage: history([
        ['2026-10-17', 1],
        ['2026-10-18', 2],
      ]),
      now,
    }).current,
    2,
  );
  assert.equal(
    buildUsageActivity({
      usage: history([
        ['2026-10-16', 1],
        ['2026-10-18', 2],
      ]),
      now,
    }).current,
    1,
  );
  assert.equal(
    buildUsageActivity({
      usage: history([
        ['2026-10-17', 1],
        ['2026-10-18', 0],
      ]),
      now,
    }).current,
    0,
  );
});

test('earlier totals are never fabricated into a daily bucket and future, invalid, duplicate and outside dates are ignored', () => {
  const legacy = { subscription: { available: true, totals: counts(9000000) } };
  const model = buildUsageActivity({ usage: legacy, now });
  assert.equal(model.known.length, 0);
  assert.equal(model.peak, null);
  assert.equal(model.longest, null);
  assert.equal(model.lifetime, 9000000);
  const invalid = {
    ...usage,
    activity: {
      ...usage.activity,
      timeZone: '<invalid>',
      days: [
        { date: '2026-02-30', subscription: counts(1) },
        { date: '2026-10-20', subscription: counts(2) },
        { date: '2025-01-01', subscription: counts(3) },
        { date: '2026-10-18', subscription: counts(4) },
        { date: '2026-10-18', subscription: counts(5) },
        { date: '2026-10-17', subscription: counts(Number.MAX_SAFE_INTEGER, 1) },
        { date: '2026-10-16', subscription: counts(-1) },
      ],
    },
  };
  const checked = buildUsageActivity({ usage: invalid, now });
  assert.equal(checked.timeZone, 'UTC');
  assert.equal(checked.known.length, 1);
  assert.equal(defined(checked.known[0]).value, 4);
  for (const language of ['en', 'zh']) {
    const { document } = dom(renderUsageSettings({ usage: legacy, language, now }));
    assert.equal(
      document.querySelectorAll<HTMLButtonElement>('[data-usage-level="unknown"][data-usage-point]')
        .length,
      365,
    );
    assert.match(
      document.body.textContent,
      language === 'zh' ? /旧的累计用量不会分配到日期/ : /Earlier totals are not assigned to dates/,
    );
    assert.equal(
      defined(document.querySelector<HTMLButtonElement>('[data-usage-stat="peak"]')).textContent,
      '—',
    );
  }
});

test('daily calendar is compact, labelled and keyboard reachable without 365 tab stops', () => {
  const { document } = dom(renderUsageSettings({ usage, now }));
  assert.equal(document.querySelectorAll<HTMLButtonElement>('[data-usage-point]').length, 365);
  assert.equal(
    document.querySelectorAll<HTMLButtonElement>('[data-usage-point][tabindex="0"]').length,
    1,
  );
  const zero = document.querySelector<HTMLButtonElement>('[data-usage-date="2026-10-18"]'),
    missing = document.querySelector<HTMLButtonElement>('[data-usage-date="2026-10-17"]');
  assert.equal(defined(zero).dataset.usageLevel, '0');
  assert.match(defined(zero).title, /0 tokens/);
  assert.equal(defined(missing).dataset.usageLevel, 'unknown');
  assert.match(defined(missing).title, /No report/);
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-usage-stat="lifetime"]')).getAttribute(
      'title',
    ),
    '1,000,000,020 tokens',
  );
  assert.match(document.body.textContent, /Earlier or undated/);
  assert.equal(
    defined(document.querySelector<HTMLDetailsElement>('[data-usage-details]')).hasAttribute(
      'open',
    ),
    false,
  );
});

test('weekly bars and cumulative points show only accurately dated records with exact tooltips', () => {
  const weekly = dom(renderUsageActivity({ usage, now, mode: 'weekly' })).document;
  assert.ok(weekly.querySelectorAll<HTMLElement>('.usage-week-bar').length >= 52);
  assert.match(
    defined(weekly.querySelector<HTMLButtonElement>('[data-usage-date="2026-10-12"]')).getAttribute(
      'aria-label',
    ) || '',
    /45 tokens · 3 reported days/,
  );
  const cumulative = dom(renderUsageActivity({ usage, now, mode: 'cumulative' })).document;
  assert.equal(cumulative.querySelectorAll<HTMLButtonElement>('[data-usage-point]').length, 4);
  assert.match(
    defined(
      cumulative.querySelector<HTMLButtonElement>('[data-usage-point]:last-child'),
    ).getAttribute('aria-label') || '',
    /Recorded 95 tokens/,
  );
  assert.ok(cumulative.querySelector<HTMLElement>('.usage-cumulative-line'));
  assert.doesNotMatch(
    defined(cumulative.querySelector<HTMLElement>('svg')).textContent,
    /1,000,000,020/,
  );
  const empty = dom(renderUsageActivity({ now, mode: 'cumulative' })).document;
  assert.equal(empty.querySelectorAll<HTMLButtonElement>('[data-usage-point]').length, 0);
  assert.equal(empty.querySelectorAll<HTMLElement>('.usage-cumulative-line').length, 0);
});

test('controller preserves mode, provider and detail disclosure through state rerenders and binds each root once', () => {
  const { document, Event } = dom('');
  let renders = 0,
    controller: ReturnType<typeof createUsageActivityController>;
  const render = () => {
    renders++;
    document.body.innerHTML = renderUsageSettings({ usage, now, ...controller.state });
    controller.bind();
    controller.bind();
  };
  controller = createUsageActivityController({ document, onChange: render });
  controller.bind();
  render();
  defined(document.querySelector<HTMLButtonElement>('[data-usage-mode="weekly"]')).click();
  assert.equal(controller.state.mode, 'weekly');
  assert.equal(renders, 2);
  assert.ok(document.querySelector<HTMLElement>('.usage-week-bar'));
  defined(document.querySelector<HTMLButtonElement>('[data-usage-source="apiVoice"]')).click();
  assert.equal(controller.state.provider, 'apiVoice');
  assert.equal(renders, 3);
  assert.match(
    defined(
      document.querySelector<HTMLButtonElement>('[data-usage-date="2026-10-12"]'),
    ).getAttribute('aria-label') || '',
    /150 tokens/,
  );
  const details = document.querySelector<HTMLDetailsElement>('[data-usage-details]');
  defined(details).open = true;
  defined(details).dispatchEvent(new Event('toggle'));
  render();
  assert.equal(
    defined(document.querySelector<HTMLDetailsElement>('[data-usage-details]')).hasAttribute(
      'open',
    ),
    true,
  );
  defined(document.querySelector<HTMLButtonElement>('[data-usage-mode="daily"]')).click();
  assert.equal(controller.state.mode, 'daily');
  assert.equal(controller.state.provider, 'apiVoice');
  const points = [...document.querySelectorAll<HTMLButtonElement>('[data-usage-point]')],
    point = points.at(-1),
    key = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(key, 'key', { value: 'ArrowLeft' });
  defined(point).dispatchEvent(key);
  assert.equal(key.defaultPrevented, true);
  assert.equal(defined(points.at(-8)).getAttribute('tabindex'), '0');
  assert.equal(
    document.querySelectorAll<HTMLButtonElement>('[data-usage-point][tabindex="0"]').length,
    1,
  );
  assert.match(
    defined(document.querySelector<HTMLButtonElement>('[data-usage-tooltip]')).textContent,
    /Oct 12, 2026/,
  );
  defined(points[5]).dispatchEvent(new Event('pointerover', { bubbles: true }));
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-usage-tooltip]')).textContent,
    defined(points[5]).dataset.usageLabel,
  );
});

test('unknown providers and modes fall back safely and localized labels escape untrusted history strings', () => {
  for (const language of ['zh', 'en']) {
    const { document } = dom(
      renderUsageSettings({ usage, now, language, provider: 'bad', mode: 'bad' }),
    );
    assert.equal(
      defined(
        document.querySelector<HTMLButtonElement>('[data-usage-source="subscription"]'),
      ).getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      defined(document.querySelector<HTMLButtonElement>('[data-usage-mode="daily"]')).getAttribute(
        'aria-pressed',
      ),
      'true',
    );
    assert.match(
      document.body.textContent,
      language === 'zh' ? /单日最高 Token/ : /Peak daily tokens/,
    );
    assert.match(
      document.body.textContent,
      language === 'zh' ? /不代表用量为 0/ : /unknown, not zero/,
    );
  }
});

test('usage disclosure survives queued toggle and partial reconciliation, while foreign details and replaced nodes stay separate', () => {
  const { document, Event } = dom(
      '<details data-unrelated open><summary>Other disclosure</summary></details><main></main>',
    ),
    app = defined(document.querySelector('main')),
    state = {
      conversationId: 'one',
      settings: { vm: { host: 'one', user: 'dant', port: 22 } },
      usage,
    };
  let controller: ReturnType<typeof createUsageActivityController>;
  const render = () => {
    const template = document.createElement('template');
    template.innerHTML = renderUsageSettings({ usage: state.usage, now, ...controller.state });
    reconcile(app, template.content);
    controller.bind();
  };
  controller = createUsageActivityController({
    document,
    getScope: () => usageActivityScope(state),
    onChange: render,
  });
  const details = () => defined(document.querySelector<HTMLDetailsElement>('[data-usage-details]'));
  render();
  assert.equal(details().hasAttribute('open'), false);
  details().setAttribute('open', '');
  state.usage = {
    ...state.usage,
    subscription: { ...state.usage.subscription, totals: counts(999) },
  };
  render();
  assert.equal(
    details().hasAttribute('open'),
    true,
    'fresh state cannot beat the queued native toggle',
  );
  const old = details(),
    replacement = old.cloneNode(true) as HTMLDetailsElement;
  old.replaceWith(replacement);
  controller.bind();
  replacement.removeAttribute('open');
  replacement.dispatchEvent(new Event('toggle'));
  old.setAttribute('open', '');
  old.dispatchEvent(new Event('toggle'));
  assert.equal(
    controller.state.detailsOpen,
    false,
    'a detached prior disclosure cannot overwrite its replacement',
  );
  replacement.setAttribute('open', '');
  render();
  assert.equal(details().hasAttribute('open'), true);
  state.conversationId = 'two';
  render();
  assert.equal(details().hasAttribute('open'), false);
  details().setAttribute('open', '');
  render();
  state.settings.vm.host = 'other-vm';
  render();
  assert.equal(details().hasAttribute('open'), false);
  details().setAttribute('open', '');
  render();
  state.usage = { ...state.usage, recordedSince: now + 1 };
  render();
  assert.equal(
    details().hasAttribute('open'),
    false,
    'a new usage recording starts with details closed',
  );
  assert.equal(document.querySelector('[data-unrelated]')?.hasAttribute('open'), true);
  assert.equal(usageActivityScope(null), usageActivityScope({}));
});
