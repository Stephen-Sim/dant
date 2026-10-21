import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadLanguage } from '../../../ui/i18n/localization.mts';
import { formatPresence } from '../../../ui/chat/presence.mts';
import { createCallDuration, formatCallDuration } from '../../../ui/call/call-duration.mts';
import { languages } from '../../../ui/i18n/languages.mts';
import { translate } from '../../../ui/i18n/messages.mts';

test('the typed browser catalog loader registers every choice and shares concurrent requests', async () => {
  for (const { code } of languages) {
    const values = await Promise.all([loadLanguage(code), loadLanguage(code), loadLanguage(code)]);
    assert.deepEqual(values, [undefined, undefined, undefined]);
    const phrase = 'The background task has finished.';
    const expected =
      code === 'en'
        ? phrase
        : code === 'zh'
          ? '后台任务已结束。'
          : JSON.parse(
              fs.readFileSync(
                new URL(`../../../resources/i18n/locales/${code}.json`, import.meta.url),
                'utf8',
              ),
            )[phrase];
    assert.equal(translate(code, phrase, '后台任务已结束。'), expected);
  }
  for (const unknown of [null, undefined, {}, 1, 'unsupported']) await loadLanguage(unknown);
});

test('typed presence accepts partial and unknown boundary data without inventing activity', () => {
  for (const state of [
    undefined,
    null,
    1,
    'old snapshot',
    [],
    { worker: null, presence: 1, controller: null, workTasks: [undefined, null, 'invalid'] },
  ]) {
    assert.deepEqual(formatPresence(state, 'en'), {
      label: 'Disconnected',
      detail: '',
      title: '',
      online: false,
      active: false,
    });
  }
  const partial = {
    workerStatus: 'online',
    lastActiveAt: 1000,
    active: { visible: false, status: 'future-state' },
    workTasks: [{ status: 'future-state' }, null],
  };
  const before = structuredClone(partial);
  const display = formatPresence(partial, 'en', 28_801_000);
  assert.equal(display.label, 'Online');
  assert.equal(display.detail, 'Idle');
  assert.ok(display.title.includes('Last active 8 hours ago'));
  assert.equal(display.active, false);
  assert.deepEqual(partial, before);
  assert.equal(formatPresence({ workerStatus: 'online', active: true }, 'en').detail, 'Working');
});

test('live bridge authority and uncertain durable tasks survive unknown-field normalization', () => {
  const state = {
    workerStatus: 'online',
    lastActiveAt: 1000,
    controller: { status: 'online', cached: true },
    active: { turnId: 'cached' },
    call: { status: 'connected' },
    workTasks: [{ status: 'waiting_user' }],
  };
  assert.equal(formatPresence(state, 'en', 28_801_000).online, false);
  assert.equal(formatPresence(state, 'en', 28_801_000).active, false);
  const partial = {
    workerStatus: 'online',
    workTasks: [
      null,
      { status: 'waiting_user', continuation: { dispatch: { phase: 'future-phase' } } },
    ],
  };
  assert.equal(formatPresence(partial, 'en').detail, 'Work status unconfirmed');
  assert.equal(
    formatPresence({ ...partial, workTasks: [{ status: 'waiting_user' }] }, 'en').detail,
    'Waiting for your reply',
  );
});

test('relative presence dates use the selected locale and leave user content untouched', async () => {
  for (const code of ['fr', 'ja', 'ar']) {
    await loadLanguage(code);
    const state = {
      workerStatus: 'offline',
      lastActiveAt: 1000,
      messages: [{ text: 'Working 原始消息' }],
      workTasks: [{ title: 'The background task has finished.' }],
    };
    const before = structuredClone(state);
    const result = formatPresence(state, code, 28_801_000);
    const locale = defined(languages.find((item) => item.code === code)).locale;
    assert.ok(
      result.detail.includes(
        new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-8, 'hour'),
      ),
    );
    assert.ok(result.title.includes(new Date(1000).toLocaleString(locale)));
    assert.deepEqual(state, before);
  }
});

test('typed clock owns one matching scheduler handle and freezes before accepting final history', () => {
  let now = 1000,
    sequence = 0;
  const timers = new Map<number, () => void>(),
    cancelled: number[] = [];
  const clock = createCallDuration({
    now: () => now,
    schedule: (tick, milliseconds) => {
      assert.equal(milliseconds, 1000);
      timers.set(++sequence, tick);
      return sequence;
    },
    cancel: (handle) => {
      cancelled.push(handle);
      timers.delete(handle);
    },
  });
  clock.start('current', 1000);
  clock.sync({ id: 'current', connectedAt: 1000 });
  assert.equal(timers.size, 1);
  now += 2500;
  defined(timers.get(1))();
  assert.equal(clock.snapshot.seconds, 3);
  const detached = clock.snapshot;
  detached.seconds = 900;
  assert.equal(clock.snapshot.seconds, 3);
  clock.stop('other', 50);
  assert.equal(timers.size, 1);
  clock.stop('current');
  assert.deepEqual(cancelled, [1]);
  clock.sync({ id: 'current', connectedAt: 1000 }, [
    null,
    'old record',
    { kind: 'call', callId: 'other', seconds: 50 },
  ]);
  assert.equal(timers.size, 0);
  assert.equal(clock.snapshot.finalized, false);
  clock.sync(null, [{ kind: 'call', callId: 'current', seconds: 7 }]);
  assert.equal(clock.snapshot.seconds, 7);
  assert.equal(clock.snapshot.finalized, true);
  clock.dispose();
});

test('typed clock tolerates malformed snapshots and default timer disposal retains its exact handle', (t) => {
  const scheduled: Array<{ tick: unknown; milliseconds: number | undefined }> = [],
    cancelled: unknown[] = [];
  t.mock.method(globalThis, 'setInterval', (tick: unknown, milliseconds?: number) => {
    scheduled.push({ tick, milliseconds });
    return 41;
  });
  t.mock.method(globalThis, 'clearInterval', (handle: unknown) => cancelled.push(handle));
  const clock = createCallDuration({ now: () => 1000 });
  clock.start('current', 1000);
  for (const [id, at] of [
    [null, 1000],
    ['current', '1000'],
    ['current', NaN],
    ['current', -1],
  ])
    clock.start(id, at);
  clock.sync({ id: 9, connectedAt: 1000 }, {});
  assert.equal(clock.snapshot.callId, 'current');
  assert.equal(scheduled.length, 1);
  assert.equal(defined(scheduled[0]).milliseconds, 1000);
  clock.dispose();
  assert.deepEqual(cancelled, [41]);
  assert.equal(clock.snapshot.running, false);
  assert.equal(formatCallDuration('61'), '1:01');
});
