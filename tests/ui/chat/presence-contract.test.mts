import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPresence } from '../../../ui/chat/presence.mts';
test('ordinary conversation activity does not advertise a work task while real call presence remains visible', () => {
  const state: {
    worker: { status: string };
    active: { status: string; visible: boolean };
    call?: { status: string } | null;
  } = { worker: { status: 'online' }, active: { status: 'running', visible: false } };
  assert.equal(formatPresence(state, 'en').detail, 'Idle');
  state.call = { status: 'connected' };
  assert.equal(formatPresence(state, 'en').detail, 'In a call');
  state.call = null;
  state.active.visible = true;
  assert.equal(formatPresence(state, 'en').detail, 'Working');
});

test('presence helper distinguishes current task/call from idle and suppresses stale local calls', () => {
  const base = {
    worker: { status: 'online' },
    controller: { status: 'online' },
    presence: { lastActiveAt: 1000 },
  };
  assert.deepEqual(
    { ...formatPresence({ ...base, active: {} }, 'en', 61000), title: '' },
    { label: 'Online', detail: 'Working', title: '', online: true, active: true },
  );
  assert.equal(
    formatPresence({ ...base, call: { status: 'connected' } }, 'zh', 61000).detail,
    '正在通话',
  );
  assert.equal(
    formatPresence({ ...base, call: { status: 'connected' }, callActiveNow: false }, 'en', 61000)
      .detail,
    'Idle',
  );
  assert.equal(
    formatPresence({ ...base, call: { status: 'negotiating' } }, 'en', 61000).active,
    false,
  );
  assert.equal(formatPresence({ workerStatus: 'connecting' }, 'en').label, 'Connecting');
});

test('relative activity text is bilingual, handles unit boundaries and clamps future clocks', () => {
  const at = 1000;
  for (const [elapsed, en, zh] of [
    [0, 'just now', '刚刚'],
    [59999, 'just now', '刚刚'],
    [60000, '1 minute ago', '1 分钟前'],
    [120000, '2 minutes ago', '2 分钟前'],
    [3600000, '1 hour ago', '1 小时前'],
    [7200000, '2 hours ago', '2 小时前'],
    [86400000, '1 day ago', '1 天前'],
    [172800000, '2 days ago', '2 天前'],
  ] as const) {
    assert.equal(
      formatPresence({ lastActiveAt: at, workerStatus: 'offline' }, 'en', at + elapsed).detail,
      'Last active ' + en,
    );
    assert.equal(
      formatPresence({ lastActiveAt: at, workerStatus: 'offline' }, 'zh', at + elapsed).detail,
      '最近活跃：' + zh,
    );
  }
  assert.equal(formatPresence({ lastActiveAt: 100000 }, 'en', 1000).detail, 'Last active just now');
  for (const lastActiveAt of [null, 0, -1, '1000', NaN, Infinity, 1e30])
    assert.equal(formatPresence({ lastActiveAt }, 'zh', at).detail, '');
  assert.equal(formatPresence().title, '');
  assert.match(formatPresence({ lastActiveAt: at }, 'en', NaN).title, /^Last active:/);
});

test('an eight-hour idle connection is online and labels inactivity separately in both languages', () => {
  const state = {
      worker: { status: 'online' },
      controller: { status: 'online', cached: false },
      presence: { lastActiveAt: 1000 },
    },
    before = structuredClone(state);
  for (const [language, label, detail, activity, explanation] of [
    [
      'en',
      'Online',
      'Idle',
      'Last active 8 hours ago',
      'The work computer is connected. No task is running.',
    ],
    ['zh', '在线', '空闲', '最近活跃：8 小时前', '工作电脑已连接，当前没有任务在执行。'],
  ] as const) {
    const value = formatPresence(state, language, 28801000);
    assert.equal(value.label, label);
    assert.equal(value.detail, detail);
    assert.equal(value.online, true);
    assert.equal(value.active, false);
    assert.ok(value.title.includes(activity));
    assert.ok(value.title.includes(explanation));
  }
  assert.deepEqual(state, before);
});

test('a reliable waiting task explains idle presence without pretending execution has resumed', () => {
  const state = {
      worker: { status: 'online' },
      controller: { status: 'online', cached: false },
      presence: { lastActiveAt: 1000 },
      workTasks: [
        { id: 'waiting', turnId: 'ended', status: 'waiting_user', executionEndedAt: 1000 },
      ],
    },
    before = structuredClone(state);
  for (const [language, detail] of [
    ['en', 'Waiting for your reply'],
    ['zh', '等待你回复'],
  ] as const) {
    const value = formatPresence(state, language, 28801000);
    assert.equal(value.detail, detail);
    assert.equal(value.online, true);
    assert.equal(value.active, false);
    assert.doesNotMatch(value.detail, /Working|正在工作/);
  }
  assert.deepEqual(state, before);
  assert.equal(
    formatPresence({ ...state, active: { turnId: 'live', status: 'running' } }, 'en').detail,
    'Working',
  );
  assert.equal(
    formatPresence({ ...state, call: { status: 'connected' } }, 'en').detail,
    'In a call',
  );
});

test('dismissed, paused, completed and review records do not advertise a current wait or work', () => {
  const base = { worker: { status: 'online' }, controller: { status: 'online', cached: false } };
  for (const record of [
    { status: 'paused' },
    { status: 'review' },
    { status: 'completed' },
    { status: 'cancelled' },
    { status: 'continuing' },
    { status: 'waiting_user', progressDismissedAt: 1000 },
    { status: 'unknown', progressDismissedAt: 1000 },
  ]) {
    const value = formatPresence({ ...base, workTasks: [record] }, 'en');
    assert.equal(value.detail, 'Idle', JSON.stringify(record));
    assert.equal(value.active, false);
  }
  assert.equal(formatPresence({ ...base, workTasks: {} }, 'en').detail, 'Idle');
});

test('unconfirmed saved execution takes precedence over a wait without claiming working or idle in either language', () => {
  const base = {
    worker: { status: 'online' },
    controller: { status: 'online', cached: false },
    presence: { lastActiveAt: 1000 },
  };
  const records = [
    { status: 'unknown' },
    { status: 'paused', unknownOutcome: true },
    { status: 'waiting_user', submission: 'unknown' },
    { status: 'waiting_user', submission: 'submitting' },
    { status: 'waiting_user', unknownOutcome: true },
    { status: 'waiting_user', continuation: { invalid: true } },
    { status: 'waiting_user', continuation: { dispatch: { phase: 'unknown' } } },
    { status: 'continuing', continuation: { dispatch: { phase: 'acknowledged' } } },
  ];
  for (const record of records)
    for (const [language, detail, explanation] of [
      ['en', 'Work status unconfirmed', 'a task execution status has not been confirmed'],
      ['zh', '工作状态未确认', '有任务的执行状态尚未确认'],
    ] as const) {
      const state = { ...base, workTasks: [{ status: 'waiting_user' }, record] },
        before = structuredClone(state),
        value = formatPresence(state, language, 28801000);
      assert.equal(value.detail, detail, JSON.stringify(record));
      assert.equal(value.active, false);
      assert.equal(value.online, true);
      assert.ok(value.title.includes(explanation));
      assert.doesNotMatch(value.title, /No task is running|当前没有任务在执行/);
      assert.deepEqual(state, before);
    }
  const state = { ...base, workTasks: [{ status: 'unknown' }] };
  assert.equal(
    formatPresence({ ...state, active: { turnId: 'live', status: 'running' } }, 'en').detail,
    'Working',
  );
  assert.equal(
    formatPresence({ ...state, call: { status: 'connected' } }, 'zh').detail,
    '正在通话',
  );
  for (const controller of [
    { status: 'offline', cached: true },
    { status: 'online', cached: true },
    { status: 'offline', cached: false },
  ])
    for (const [language, detail] of [
      ['en', 'Last active 8 hours ago'],
      ['zh', '最近活跃：8 小时前'],
    ] as const) {
      const value = formatPresence({ ...state, controller }, language, 28801000);
      assert.equal(value.detail, detail);
      assert.equal(value.online, false);
      assert.equal(value.active, false);
    }
});

test('disconnected and cached snapshots preserve eight-hour history without advertising cached waits', () => {
  const base = {
    worker: { status: 'online' },
    presence: { lastActiveAt: 1000 },
    workTasks: [{ id: 'waiting', status: 'waiting_user' }],
  };
  for (const controller of [
    { status: 'offline', cached: true },
    { status: 'online', cached: true },
    { status: 'offline', cached: false },
  ])
    for (const [language, label, detail] of [
      ['en', 'Disconnected', 'Last active 8 hours ago'],
      ['zh', '未连接', '最近活跃：8 小时前'],
    ] as const) {
      const value = formatPresence({ ...base, controller }, language, 28801000);
      assert.equal(value.label, label);
      assert.equal(value.detail, detail);
      assert.equal(value.online, false);
      assert.equal(value.active, false);
    }
  const connecting = formatPresence(
    { ...base, controller: { status: 'connecting' } },
    'en',
    28801000,
  );
  assert.equal(connecting.label, 'Connecting');
  assert.equal(connecting.detail, 'Last active 8 hours ago');
  assert.equal(connecting.active, false);
});

test('presence helper gives live connection authority over cached tasks and calls', () => {
  const state = {
    worker: { status: 'online' },
    presence: { lastActiveAt: 1000 },
    active: { turnId: 'cached' },
    call: { status: 'connected' },
    controller: { status: 'offline', cached: true },
  };
  const value = formatPresence(state, 'en', 181000);
  assert.equal(value.label, 'Disconnected');
  assert.equal(value.detail, 'Last active 3 minutes ago');
  assert.equal(value.online, false);
  assert.equal(value.active, false);
  assert.equal(
    formatPresence({ ...state, controller: { status: 'connecting' } }, 'en', 181000).label,
    'Connecting',
  );
  assert.equal(
    formatPresence({ ...state, controller: { status: 'online', cached: true } }, 'en', 181000)
      .online,
    false,
  );
  assert.equal(
    formatPresence({ worker: { status: 'offline' }, controller: { status: 'online' } }, 'zh').label,
    '未连接',
  );
});
