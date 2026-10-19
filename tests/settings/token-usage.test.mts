import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorkerServiceFixture } from '../support/service-fixtures.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';
import { TokenUsageStore } from '../../src/settings/token-usage.mts';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
function fixture(t: NodeTestContext) {
  const dir = fs.mkdtempSync(path.join(root, 'token-usage-'));
  t.after(() => {
    assert.equal(path.dirname(dir), root);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  return { dir, store, usage: new TokenUsageStore(store, { now: () => 1000 }) };
}
const values = (input = 100, output = 20, cached = 30, reasoning = 10) => ({
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
  totalTokens: input + output,
});
const notification = (
  total = values(),
  last = values(30, 5, 5, 2),
  threadId = 'thread',
  turnId = 'turn',
) => ({ threadId, turnId, tokenUsage: { total, last, modelContextWindow: 128000 } });
const runtime = { runtimeId: 'runtime' };

test('missing usage is unavailable while a reported zero remains a real zero', (t) => {
  const { usage } = fixture(t);
  assert.deepEqual(usage.snapshot(), {
    recordedSince: null,
    subscription: { available: false, totals: null, lastResponse: null },
    apiVoice: { available: false, totals: null, lastResponse: null },
    activity: {
      timeZone: 'UTC',
      recordedSince: null,
      retainedFrom: '1968-11-28',
      days: [],
      unallocated: { subscription: null, apiVoice: null },
    },
  });
  assert.equal(
    usage.observeCodex(notification(values(0, 0, 0, 0), values(0, 0, 0, 0)), runtime),
    true,
  );
  assert.equal(usage.snapshot().subscription.available, true);
  assert.deepEqual(usage.snapshot().subscription.totals, values(0, 0, 0, 0));
  assert.equal(usage.snapshot().apiVoice.available, false);
});

test('context-window fallback estimates are not recorded as measured token consumption', (t) => {
  const { usage } = fixture(t),
    synthetic = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 128000,
    };
  assert.equal(usage.observeCodex(notification(synthetic, synthetic), runtime), false);
  assert.equal(usage.snapshot().subscription.available, false);
});

test('cumulative native usage replaces its thread total and deduplicates updates across restart', (t) => {
  const { store, dir, usage } = fixture(t),
    first = notification();
  assert.equal(usage.observeCodex(first, runtime), true);
  assert.equal(usage.observeCodex(first, runtime), false);
  const next = notification(values(130, 25, 35, 12), values(30, 5, 5, 2));
  assert.equal(usage.observeCodex(next, runtime), true);
  assert.deepEqual(usage.snapshot().subscription.totals, next.tokenUsage.total);
  const restoredStore = new Store(dir);
  assert.deepEqual(
    restoredStore.state.tokenUsage,
    usage.state,
    'The conversation store validates usage without applying a different wall clock.',
  );
  const restored = new TokenUsageStore(restoredStore, { now: () => 2000 });
  assert.equal(restored.observeCodex(next, runtime), false);
  assert.deepEqual(restored.snapshot(), usage.snapshot());
  assert.equal(
    restored.observeCodex(notification(values(150, 30, 40, 14), values(20, 5, 5, 2)), runtime),
    true,
  );
  assert.equal(defined(restored.snapshot().subscription.totals).totalTokens, 180);
  assert.equal(
    restored.observeCodex(
      notification(values(10, 3, 2, 1), values(10, 3, 2, 1), 'another-thread'),
      runtime,
    ),
    true,
  );
  assert.equal(defined(restored.snapshot().subscription.totals).totalTokens, 193);
  assert.equal(defined(restored.snapshot().subscription.lastResponse).totalTokens, 13);
  assert.equal(
    JSON.stringify(store.state.tokenUsage).includes('runtime'),
    false,
    'persistent source IDs are digests rather than account/runtime strings',
  );
});

test('conversation restore validates legacy receipts while the usage owner alone applies retention', (t) => {
  const { store, dir, usage } = fixture(t);
  usage.observeCodex(notification(), runtime);
  usage.observeApiVoice({
    callId: 'call',
    responseId: 'response',
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  });
  const saved = structuredClone(usage.state);
  for (const raw of [
    saved,
    { ...saved, version: 1 },
    { ...saved, activity: { ...saved.activity, days: { 'invalid-date': {} } } },
  ]) {
    for (const time of [2000, Date.parse('2026-10-19T00:00:00Z')]) {
      fs.writeFileSync(store.file, JSON.stringify({ ...store.state, tokenUsage: raw }));
      const restored = new TokenUsageStore(new Store(dir), { now: () => time });
      const direct = new TokenUsageStore(
        { state: { tokenUsage: raw }, save() {} },
        { now: () => time },
      );
      assert.deepEqual(restored.snapshot(), direct.snapshot());
      assert.equal(restored.observeCodex(notification(), runtime), false);
    }
  }
});

test('stale, reset or malformed cumulative snapshots cannot inflate or reduce totals', (t) => {
  const { usage } = fixture(t);
  usage.observeCodex(notification(), runtime);
  const before = usage.snapshot();
  for (const event of [
    notification(values(90, 19, 20, 9)),
    notification({ ...values(200, 30, 0, 0), totalTokens: 128000 }),
    notification({ ...values(), inputTokens: -1 }),
    notification({ ...values(), cachedInputTokens: 101 }),
    notification({ ...values(), outputTokens: NaN }),
    notification({ ...values(), totalTokens: Number.MAX_SAFE_INTEGER + 1 }),
    { threadId: 'thread', turnId: 'turn', tokenUsage: { total: values() } },
    notification(values(), values(), '', 'turn'),
  ])
    assert.equal(usage.observeCodex(event, runtime), false);
  assert.deepEqual(usage.snapshot(), before);
  assert.equal(usage.observeCodex(notification(), { runtimeId: '' }), false);
});

test('API voice responses stay separate and durable receipts prevent replayed double counting', (t) => {
  const { usage, dir } = fixture(t),
    event = {
      callId: 'call',
      responseId: 'response',
      usage: {
        input_tokens: 40,
        output_tokens: 10,
        total_tokens: 50,
        input_token_details: { cached_tokens: 5 },
      },
    };
  assert.equal(usage.observeApiVoice(event), true);
  assert.equal(usage.observeApiVoice(event), false);
  assert.equal(usage.snapshot().subscription.available, false);
  assert.equal(defined(usage.snapshot().apiVoice.totals).totalTokens, 50);
  assert.equal(defined(usage.snapshot().apiVoice.totals).cachedInputTokens, 5);
  assert.equal(defined(usage.snapshot().apiVoice.totals).reasoningOutputTokens, null);
  const restored = new TokenUsageStore(new Store(dir), { now: () => 2000 });
  assert.equal(restored.observeApiVoice(event), false);
  assert.equal(
    restored.observeApiVoice({
      ...event,
      responseId: 'response-2',
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }),
    true,
  );
  assert.equal(defined(restored.snapshot().apiVoice.totals).totalTokens, 53);
  assert.equal(
    defined(restored.snapshot().apiVoice.totals).cachedInputTokens,
    null,
    'omitted cache data must not become zero',
  );
  assert.equal(restored.observeApiVoice({ ...event, callId: 'different-call' }), true);
  assert.equal(defined(restored.snapshot().apiVoice.totals).totalTokens, 103);
  for (const invalid of [
    { ...event, responseId: '' },
    { ...event, usage: null },
    { ...event, usage: { input_tokens: 1, output_tokens: 2, total_tokens: Infinity } },
    {
      ...event,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        total_tokens: 3,
        input_token_details: { cached_tokens: 4 },
      },
    },
  ])
    assert.equal(restored.observeApiVoice(invalid), false);
});

test('failed persistence preserves prior totals and permits a later receipt retry', (t) => {
  const { usage, store } = fixture(t),
    save = store.save;
  store.save = () => {
    throw Error('private disk detail');
  };
  assert.throws(() => usage.observeCodex(notification(), runtime), /disk/);
  assert.equal(usage.snapshot().subscription.available, false);
  assert.equal(store.state.tokenUsage, undefined);
  store.save = save;
  assert.equal(usage.observeCodex(notification(), runtime), true);
});

test('Engine observes valid current-thread usage even when native voice owns the notification', (t) => {
  const { store } = fixture(t),
    worker = new WorkerServiceFixture();
  worker.status = 'online';
  const engine = new Engine(store, worker);
  store.state.threadId = 'thread';
  const voice = new NativeRealtimeVoice({ worker, engine });
  voice.ownsEvent = () => true;
  voice.handleEvent = async () => {};
  engine.nativeVoice = voice;
  t.after(() => voice.close());
  worker.emit('event', { method: 'thread/tokenUsage/updated', params: notification() });
  assert.equal(defined(engine.usage.snapshot().subscription.totals).totalTokens, 120);
  worker.emit('event', {
    method: 'thread/tokenUsage/updated',
    params: notification(values(900, 90, 0, 0), values(), 'other-thread'),
  });
  assert.equal(defined(engine.usage.snapshot().subscription.totals).totalTokens, 120);
  assert.equal(engine.active, null);
});
