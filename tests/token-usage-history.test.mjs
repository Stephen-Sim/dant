import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenUsageStore } from '../src/settings/token-usage.mjs';

const fields = [
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens',
];
const counts = (input = 100, output = 20, cached = 30, reasoning = 10) => ({
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
  totalTokens: input + output,
});
const native = (total = counts(), last = counts(10, 2, 3, 1), threadId = 'thread') => ({
  threadId,
  turnId: 'turn',
  tokenUsage: { total, last },
});
const api = (responseId = 'response', input = 5, output = 2, cached = undefined) => ({
  callId: 'call',
  responseId,
  usage: {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    ...(cached === undefined ? {} : { input_token_details: { cached_tokens: cached } }),
  },
});
const runtime = { runtimeId: 'runtime' };
const at = (value) => Date.parse(value);
function fixture({ timeZone = 'UTC', time = at('2026-10-18T16:07:00Z'), saved } = {}) {
  let clock = time,
    persisted = saved;
  const store = {
    state: { settings: { timeZone }, ...(saved ? { tokenUsage: structuredClone(saved) } : {}) },
    save() {
      persisted = structuredClone(this.state.tokenUsage);
    },
  };
  const usage = new TokenUsageStore(store, { now: () => clock });
  return { usage, store, setTime: (value) => (clock = value), persisted: () => persisted };
}

test('a first large native cumulative receipt attributes only its latest response to the current local day', () => {
  const { usage } = fixture({ timeZone: 'Asia/Kuala_Lumpur' }),
    total = counts(500000000, 9000000, 20000000, 1000000),
    last = counts(100, 20, 30, 10);
  usage.observeCodex(native(total, last), runtime);
  const snapshot = usage.snapshot();
  assert.deepEqual(snapshot.subscription.totals, total);
  assert.equal(snapshot.activity.timeZone, 'Asia/Kuala_Lumpur');
  assert.deepEqual(snapshot.activity.days, [
    { date: '2026-10-19', subscription: last, apiVoice: null },
  ]);
  assert.equal(
    snapshot.activity.unallocated.subscription.totalTokens,
    total.totalTokens - last.totalTokens,
  );
  assert.equal(
    snapshot.activity.days[0].subscription.totalTokens,
    120,
    'cached and reasoning subsets are not added to the total again',
  );
});

test('after an existing high-water mark only genuine cumulative increments enter daily activity, including after restart', () => {
  const app = fixture(),
    first = counts(1000, 200, 300, 100);
  app.usage.observeCodex(native(first, counts(10, 2, 3, 1)), runtime);
  app.setTime(at('2026-10-19T02:00:00Z'));
  assert.equal(app.usage.observeCodex(native(first), runtime), false);
  const total = counts(1100, 220, 330, 110);
  assert.equal(app.usage.observeCodex(native(total), runtime), true);
  const restored = fixture({ saved: app.persisted(), time: at('2026-10-20T02:00:00Z') });
  assert.equal(restored.usage.observeCodex(native(total), runtime), false);
  assert.equal(restored.usage.observeCodex(native(counts(100, 20, 30, 10)), runtime), false);
  assert.deepEqual(restored.usage.snapshot().activity.days, [
    { date: '2026-10-18', subscription: counts(10, 2, 3, 1), apiVoice: null },
    { date: '2026-10-19', subscription: counts(100, 20, 30, 10), apiVoice: null },
  ]);
  assert.equal(restored.usage.snapshot().activity.unallocated.subscription.totalTokens, 1188);
});

test('API receipts are attributed independently and preserve unknown subsets and real reported zero', () => {
  const { usage } = fixture();
  usage.observeApiVoice(api());
  usage.observeApiVoice(api('second', 3, 1, 2));
  const snapshot = usage.snapshot(),
    day = snapshot.activity.days[0];
  assert.equal(day.subscription, null);
  assert.equal(day.apiVoice.totalTokens, 11);
  assert.equal(day.apiVoice.cachedInputTokens, null);
  assert.equal(day.apiVoice.reasoningOutputTokens, null);
  assert.equal(snapshot.activity.unallocated.apiVoice, null);
  assert.equal(usage.observeApiVoice(api()), false);
  usage.observeCodex(native(counts(0, 0, 0, 0), counts(0, 0, 0, 0), 'zero-thread'), runtime);
  assert.deepEqual(usage.snapshot().activity.days[0].subscription, counts(0, 0, 0, 0));
});

test('the initial settings time zone is frozen across setting changes and restarts', () => {
  const app = fixture({ timeZone: 'Asia/Kuala_Lumpur' });
  app.usage.observeApiVoice(api());
  app.store.state.settings.timeZone = 'UTC';
  app.setTime(at('2026-10-19T16:10:00Z'));
  app.usage.observeApiVoice(api('second'));
  const restored = fixture({
    saved: app.persisted(),
    timeZone: 'America/New_York',
    time: at('2026-10-19T16:11:00Z'),
  });
  assert.equal(restored.usage.snapshot().activity.timeZone, 'Asia/Kuala_Lumpur');
  assert.deepEqual(
    restored.usage.snapshot().activity.days.map((day) => day.date),
    ['2026-10-19', '2026-10-20'],
  );
  const invalid = fixture({ timeZone: 'Not/a zone' });
  assert.equal(invalid.usage.snapshot().activity.timeZone, 'UTC');
});

test('v1 migration keeps native historical totals unallocated and uses API receipt original times', () => {
  const app = fixture({ time: at('2026-10-17T16:07:00Z') });
  app.usage.observeCodex(native(), runtime);
  app.usage.observeApiVoice(api());
  const legacy = structuredClone(app.persisted());
  legacy.version = 1;
  delete legacy.activity;
  const migrated = fixture({
      saved: legacy,
      timeZone: 'Asia/Kuala_Lumpur',
      time: at('2026-10-18T16:07:00Z'),
    }),
    snapshot = migrated.usage.snapshot();
  assert.deepEqual(snapshot.subscription.totals, counts());
  assert.deepEqual(snapshot.activity.unallocated.subscription, counts());
  assert.deepEqual(snapshot.activity.days, [
    {
      date: '2026-10-18',
      subscription: null,
      apiVoice: { ...counts(5, 2, 0, 0), cachedInputTokens: null, reasoningOutputTokens: null },
    },
  ]);
  assert.equal(
    migrated.usage.observeCodex(native(), runtime),
    false,
    'loading a prior notification never invents today activity',
  );
  migrated.usage.observeCodex(native(counts(110, 22, 33, 11)), runtime);
  assert.deepEqual(migrated.usage.snapshot().activity.days[1], {
    date: '2026-10-19',
    subscription: counts(10, 2, 3, 1),
    apiVoice: null,
  });
  assert.equal(migrated.persisted().version, 2);
});

test('v1 native totals without a complete daily history never become a dated bar', () => {
  const app = fixture();
  app.usage.observeCodex(native(), runtime);
  const legacy = structuredClone(app.persisted());
  legacy.version = 1;
  delete legacy.activity;
  const migrated = fixture({ saved: legacy }),
    activity = migrated.usage.snapshot().activity;
  assert.deepEqual(activity.days, []);
  assert.equal(activity.recordedSince, null);
  assert.deepEqual(activity.unallocated.subscription, counts());
});

test('daily history retains at most 400 calendar days without losing lifetime totals or replay receipts', () => {
  const start = at('2025-01-01T12:00:00Z'),
    app = fixture({ time: start });
  for (let day = 0; day < 401; day++) {
    app.setTime(start + day * 86400000);
    app.usage.observeCodex(native(counts(day + 1, 0, 0, 0), counts(1, 0, 0, 0)), runtime);
  }
  const snapshot = app.usage.snapshot();
  assert.equal(snapshot.activity.days.length, 400);
  assert.equal(snapshot.activity.retainedFrom, '2025-01-02');
  assert.equal(snapshot.activity.days[0].date, '2025-01-02');
  assert.equal(snapshot.activity.unallocated.subscription.totalTokens, 1);
  assert.equal(snapshot.subscription.totals.totalTokens, 401);
  assert.equal(snapshot.activity.recordedSince, start);
  const restored = fixture({ saved: app.persisted(), time: start + 400 * 86400000 });
  assert.equal(restored.usage.observeCodex(native(counts(401, 0, 0, 0)), runtime), false);
  assert.deepEqual(restored.usage.snapshot(), snapshot);
});

test('an expired API receipt migrates to unallocated history and cannot be replayed into today', () => {
  const app = fixture({ time: at('2020-01-01T01:00:00Z') });
  app.usage.observeApiVoice(api());
  const legacy = structuredClone(app.persisted());
  legacy.version = 1;
  delete legacy.activity;
  const migrated = fixture({ saved: legacy }),
    snapshot = migrated.usage.snapshot();
  assert.deepEqual(snapshot.activity.days, []);
  assert.equal(snapshot.activity.unallocated.apiVoice.totalTokens, 7);
  assert.equal(snapshot.activity.recordedSince, at('2020-01-01T01:00:00Z'));
  assert.equal(migrated.usage.observeApiVoice(api()), false);
});

test('a failed atomic save rolls back daily history and its receipt, allowing one safe retry', () => {
  const app = fixture();
  app.usage.observeCodex(native(), runtime);
  app.setTime(at('2026-10-19T02:00:00Z'));
  const before = app.usage.snapshot(),
    saved = structuredClone(app.store.state.tokenUsage),
    save = app.store.save;
  app.store.save = () => {
    throw Error('disk unavailable');
  };
  assert.throws(() => app.usage.observeApiVoice(api()), /disk unavailable/);
  assert.deepEqual(app.usage.snapshot(), before);
  assert.deepEqual(app.store.state.tokenUsage, saved);
  app.store.save = save;
  assert.equal(app.usage.observeApiVoice(api()), true);
  assert.equal(app.usage.observeApiVoice(api()), false);
  assert.equal(app.usage.snapshot().activity.days.at(-1).apiVoice.totalTokens, 7);
});

test('unreliable first response subsets do not assign historical totals to a fabricated day', () => {
  const { usage } = fixture();
  usage.observeCodex(native(counts(100, 20, 30, 10), counts(101, 20, 30, 10)), runtime);
  const snapshot = usage.snapshot();
  assert.deepEqual(snapshot.activity.days, []);
  assert.deepEqual(snapshot.activity.unallocated.subscription, counts());
  assert.equal(snapshot.activity.recordedSince, null);
});

test('subset corrections do not inflate native daily input or output and cannot be claimed as known per-day cache or reasoning', () => {
  const { usage } = fixture();
  usage.observeCodex(native(counts(100, 20, 0, 0), counts(10, 2, 0, 0)), runtime);
  usage.observeCodex(native(counts(101, 21, 50, 20), counts(1, 1, 0, 0)), runtime);
  const day = usage.snapshot().activity.days[0].subscription;
  assert.equal(day.inputTokens, 11);
  assert.equal(day.outputTokens, 3);
  assert.equal(day.totalTokens, 14);
  assert.equal(day.cachedInputTokens, null);
  assert.equal(day.reasoningOutputTokens, null);
});

test('invalid saved daily history is discarded conservatively without attributing native cumulative usage to today', () => {
  const app = fixture();
  app.usage.observeCodex(native(), runtime);
  const corrupt = structuredClone(app.persisted());
  corrupt.activity.days['2026-02-31'] = { subscription: counts(), apiVoice: null };
  const restored = fixture({ saved: corrupt }),
    snapshot = restored.usage.snapshot();
  assert.deepEqual(snapshot.activity.days, []);
  assert.deepEqual(snapshot.activity.unallocated.subscription, counts());
  assert.deepEqual(snapshot.subscription.totals, counts());
});

test('snapshot activity is detached from internal receipts and persisted aggregates', () => {
  const { usage } = fixture();
  usage.observeCodex(native(), runtime);
  const before = usage.snapshot(),
    changed = usage.snapshot();
  changed.activity.days[0].subscription.inputTokens = 0;
  changed.activity.unallocated.subscription.totalTokens = 0;
  assert.deepEqual(usage.snapshot(), before);
  assert.deepEqual(Object.keys(changed.activity.days[0].subscription).sort(), [...fields].sort());
});
