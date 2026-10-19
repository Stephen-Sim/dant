import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readAppState,
  read,
  attachment,
  telegram,
  pairing,
  login,
  provisioning,
  profiles,
  providerInfo,
  fonts,
  voices,
  callStart,
  sendResult,
} from '../../../ui/app/application-state.mts';
import {
  TaskStatus,
  ConnectionStatus,
  ServiceUpdateStatus,
  PlanStepStatus,
  SubmissionStatus,
  WorkStatus,
} from '../../../src/contracts/states.mts';
import type { AppState } from '../../../ui/app/application-types.ts';
import { workProgress } from '../../../ui/work/work-progress.mts';
import { renderUsageSettings } from '../../../ui/settings/usage-settings.mts';

const snapshot = (): AppState => ({
  mode: 'vm-controller',
  conversationId: 'conversation-a',
  settings: { language: 'en', vm: {} },
  worker: { status: ConnectionStatus.Offline, models: [], account: null },
  controller: { status: ConnectionStatus.Offline, cached: true },
  messages: [],
  active: null,
  queue: [],
  call: null,
});

test('application state validates the actual offline controller and partial legacy active projection without inventing work fields', () => {
  const value = snapshot();
  assert.equal(readAppState(value), value);
  value.active = { messageId: 'human-a', turnId: 'turn-a' };
  assert.equal(readAppState(value).active, value.active);
  value.messages.push({
    id: 'human-a',
    role: 'user',
    text: 'Keep 原始内容',
    turnId: 'turn-a',
    status: TaskStatus.Running,
  });
  assert.equal(readAppState(value).messages[0]?.text, 'Keep 原始内容');
});

test('cached service status remains an observation and storage failures do not discard usable history', () => {
  const value = snapshot();
  value.controller = {
    status: ConnectionStatus.Offline,
    cached: true,
    serviceUpdate: {
      status: ServiceUpdateStatus.Current,
      confirmed: false,
      targetVersion: '0.4.7-beta.7',
      runningVersion: '0.4.7-beta.7',
      reason: '',
    },
  };
  value.credentials = {
    items: [],
    requests: [],
    error: 'Credential storage cannot be unlocked. Existing data was preserved.',
  };
  value.skills = {
    items: [],
    error: 'Managed skills could not be read. Existing files were preserved.',
  };
  assert.equal(readAppState(value).controller?.serviceUpdate?.confirmed, false);
  assert.equal(readAppState(value).credentials?.error, value.credentials?.error);
  assert.equal(readAppState(value).skills?.error, value.skills?.error);
});

test('usage distinguishes unreported provider days from real zero counts through the state boundary', () => {
  const value = snapshot();
  value.usage = {
    recordedSince: 10,
    activity: {
      timeZone: 'Asia/Kuala_Lumpur',
      days: [
        { date: '2026-10-19', subscription: { inputTokens: 0, outputTokens: 0 }, apiVoice: null },
      ],
      unallocated: { subscription: null, apiVoice: { totalTokens: 5 } },
    },
  };
  assert.equal(readAppState(value).usage?.activity?.days?.[0]?.apiVoice, null);
  assert.equal(readAppState(value).usage?.activity?.days?.[0]?.subscription?.inputTokens, 0);
});

test('a current controller can render an older worker snapshot with explicit unconfirmed and absent identity fields', () => {
  const value = snapshot();
  value.worker = {
    status: ConnectionStatus.Online,
    models: [],
    realtime: { available: true, key: { configured: false, source: null } },
  };
  value.controller = {
    status: ConnectionStatus.Online,
    cached: false,
    serviceUpdate: {
      status: ServiceUpdateStatus.Failed,
      targetVersion: '0.4.7-beta.8',
      runningVersion: '0.4.7-beta.5',
      confirmed: true,
      reason: 'update-unconfirmed',
    },
  };
  value.provisioning = { status: 'ready', error: null, connection: null };
  value.messages = [
    {
      id: 'user-a',
      role: 'user',
      text: 'Preserve 原始请求',
      status: TaskStatus.Queued,
      executorConfirmedAt: null,
      progressDismissedAt: null,
      assistantReaction: null,
      submission: null,
    },
    { id: 'result-a', role: 'assistant', text: 'Preserve 原始结果', turnId: 'turn-a' },
  ];
  value.workTasks = [
    {
      id: 'work-a',
      turnId: 'turn-a',
      turnIds: ['turn-a'],
      messageId: null,
      title: 'Preserve 原始项目',
      status: WorkStatus.WaitingUser,
      source: 'voice',
      plan: null,
      startedAt: 1,
      updatedAt: 2,
      pauseReason: null,
      progressDismissedAt: null,
    },
  ];
  value.completions = [
    {
      id: 'completion-a',
      turnId: 'turn-a',
      taskId: null,
      messageIds: ['result-a'],
      progressDismissedAt: null,
      submission: null,
      work: { source: 'voice', status: TaskStatus.Review },
    },
  ];
  value.telegram = {
    enabled: true,
    configured: true,
    connected: true,
    paired: true,
    sync: {},
  };
  value.usage = {
    apiVoice: { available: false, totals: null, lastResponse: null },
  };

  const decoded = readAppState(value),
    model = workProgress(decoded);
  assert.equal(decoded, value);
  assert.equal(decoded.messages[0]?.executorConfirmedAt, null);
  assert.equal(decoded.messages[0]?.receipt, undefined);
  assert.equal(decoded.messages[0]?.status, TaskStatus.Queued);
  assert.equal(decoded.workTasks?.[0]?.messageId, null);
  assert.equal(decoded.workTasks?.[0]?.turnId, 'turn-a');
  assert.equal(decoded.completions?.[0]?.taskId, null);
  assert.equal(decoded.telegram?.sync?.combineReplies, undefined);
  assert.equal(decoded.controller?.serviceUpdate?.status, ServiceUpdateStatus.Failed);
  assert.equal(decoded.controller?.serviceUpdate?.reason, 'update-unconfirmed');
  assert.equal(model.ongoing.length, 1);
  assert.equal(model.ongoing[0]?.id, 'work-a');
  assert.equal(model.ongoing[0]?.title, 'Preserve 原始项目');
});

test('fresh preparation and unused providers retain null observations without inventing counts or errors', () => {
  const value = snapshot();
  value.provisioning = {
    status: 'idle',
    provider: null,
    connection: null,
    error: null,
    availableProviders: [{ id: 'hyperv', available: true, reason: null }],
  };
  value.usage = {
    recordedSince: null,
    subscription: { available: false, totals: null, lastResponse: null },
    apiVoice: { available: false, totals: null, lastResponse: null },
  };
  value.telegram = {
    enabled: false,
    configured: false,
    connected: false,
    paired: false,
    delivery: { failed: 0, unknown: 1, lastIssue: { status: 'unknown', at: null } },
  };
  assert.equal(readAppState(value).provisioning?.connection, null);
  assert.equal(readAppState(value).usage?.recordedSince, null);
  assert.equal(readAppState(value).usage?.subscription?.totals, null);
  assert.equal(readAppState(value).telegram?.delivery?.lastIssue?.at, null);
  const html = renderUsageSettings({ usage: value.usage, language: 'en' });
  assert.match(html, /No token usage has been reported yet/);
  assert.doesNotMatch(html, /data-usage-api>|data-usage-subscription>/);
  assert.equal(
    read(
      { availableProviders: [{ id: 'hyperv', available: true, reason: null }] },
      providerInfo,
      'VM providers',
    ).availableProviders[0]?.reason,
    null,
  );
});

test('service checks and active updates may have no failure reason without becoming confirmed current', () => {
  for (const status of [ServiceUpdateStatus.Checking, ServiceUpdateStatus.Updating]) {
    const value = snapshot();
    value.controller = {
      status: ConnectionStatus.Online,
      serviceUpdate: {
        status,
        confirmed: false,
        targetVersion: '0.4.7-beta.8',
        runningVersion: null,
        reason: null,
      },
    };
    const observed = readAppState(value).controller?.serviceUpdate;
    assert.equal(observed?.reason, null);
    assert.equal(observed?.confirmed, false);
    assert.equal(observed?.status, status);
    assert.equal(observed?.runningVersion, null);
  }
});

test('legacy forwarding observations may omit newer options while present options remain validated', () => {
  const base = { enabled: true, configured: true, connected: true, paired: true };
  for (const sync of [
    {},
    { forwardMode: 'unread' },
    { combineReplies: false },
    { readState: 'independent' },
    { forwardMode: 'all', combineReplies: true, readState: 'independent' },
  ]) {
    const value = { ...snapshot(), telegram: { ...base, sync } };
    assert.equal(readAppState(value), value);
  }
  for (const sync of [
    [],
    { forwardMode: 'unsupported' },
    { forwardMode: null },
    { combineReplies: 'true' },
    { readState: 'shared' },
  ])
    assert.throws(() => readAppState({ ...snapshot(), telegram: { ...base, sync } }));
});

test('nullable legacy compatibility does not admit malformed values or unknown success and identity fields', () => {
  const base = snapshot();
  const invalid: unknown[] = [
    { ...base, worker: { status: null, models: [] } },
    { ...base, worker: { ...base.worker, realtime: { key: { source: false } } } },
    { ...base, provisioning: { status: 'idle', connection: false } },
    { ...base, provisioning: { status: 'idle', error: false } },
    {
      ...base,
      provisioning: {
        status: 'idle',
        availableProviders: [{ id: 'hyperv', available: true, reason: 0 }],
      },
    },
    { ...base, messages: [{ id: null, role: 'user', text: 'request' }] },
    {
      ...base,
      messages: [{ id: 'user-a', role: 'user', text: 'request', executorConfirmedAt: 'confirmed' }],
    },
    {
      ...base,
      messages: [{ id: 'user-a', role: 'user', text: 'request', executorConfirmedAt: NaN }],
    },
    {
      ...base,
      messages: [{ id: 'user-a', role: 'user', text: 'request', progressDismissedAt: true }],
    },
    { ...base, completions: [{ turnId: 'turn-a', taskId: false }] },
    { ...base, usage: { recordedSince: 'now' } },
    { ...base, usage: { apiVoice: { totals: [] } } },
    { ...base, usage: { apiVoice: { lastResponse: false } } },
    { ...base, usage: { subscription: { totals: { inputTokens: '0' } } } },
    {
      ...base,
      controller: {
        status: ConnectionStatus.Online,
        serviceUpdate: {
          status: ServiceUpdateStatus.Current,
          confirmed: null,
          targetVersion: '0.4.7-beta.8',
          runningVersion: '0.4.7-beta.8',
          reason: '',
        },
      },
    },
  ];
  for (const value of invalid)
    assert.throws(() => readAppState(value), /Invalid application state/);
});

test('work, receipts and attachment identity survive validation without copied or translated user content', () => {
  const value = snapshot(),
    file = {
      id: 'file-a',
      name: '原始报告.txt',
      type: 'text/plain',
      size: 5,
      sourcePath: '/home/dant/result.txt',
    };
  value.messages = [
    {
      id: 'assistant-a',
      role: 'assistant',
      text: 'Original result 原始结果',
      attachments: [file],
      status: TaskStatus.Completed,
      read: false,
      reactions: ['👍'],
    },
  ];
  value.workTasks = [
    {
      id: 'work-a',
      turnId: 'turn-a',
      turnIds: ['turn-a'],
      title: '原始任务',
      status: TaskStatus.Paused,
      source: 'voice',
      plan: {
        total: 1,
        completed: 0,
        currentStep: '继续验证',
        steps: [{ step: '继续验证', status: PlanStepStatus.Pending }],
      },
      startedAt: 1,
      updatedAt: 2,
      continuation: { nextAt: null, attempts: 0, noProgressCount: 0, lastCheckpoint: '' },
      submission: SubmissionStatus.Confirmed,
    },
  ];
  value.completions = [
    {
      turnId: 'turn-a',
      messageIds: ['assistant-a'],
      work: { source: 'voice', status: TaskStatus.Review },
    },
  ];
  assert.equal(readAppState(value).messages[0]?.attachments?.[0], file);
  assert.equal(readAppState(value).workTasks?.[0]?.title, '原始任务');
});

test('malformed application and nested transport fields cannot be asserted into known state', () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...snapshot(), messages: 'wrong' },
    { ...snapshot(), worker: { status: 'success', models: [] } },
    { ...snapshot(), active: { status: 'success' } },
    { ...snapshot(), settings: { vm: {}, language: 'unsupported' } },
    { ...snapshot(), messages: [{ id: 'bad', role: 'assistant', text: 5 }] },
    { ...snapshot(), credentials: { items: [{ id: 4 }], requests: [] } },
    { ...snapshot(), skills: { items: [{ name: 'bad', enabled: true }] } },
    { ...snapshot(), schedules: [{ id: 'bad', text: 'task', at: 1, status: 'success' }] },
  ];
  for (const value of invalid)
    assert.throws(() => readAppState(value), /Invalid application state/);
});

test('named API decoders validate their narrow result and preserve explicit optional compatibility fields', () => {
  const cases: readonly [unknown, (value: unknown) => boolean][] = [
    [{ id: 'file', name: 'report.txt', type: 'text/plain' }, attachment],
    [{ enabled: true, configured: true, connected: true, paired: false }, telegram],
    [{ code: '123456', expiresAt: 100, botUrl: 'https://t.me/example' }, pairing],
    [{ userCode: 'fixture-code', verificationUrl: 'https://example.invalid' }, login],
    [{ status: 'idle', running: false }, provisioning],
    [{ candidates: [], current: null }, profiles],
    [
      { availableProviders: [{ id: 'vmware', available: false, reason: 'Unavailable' }] },
      providerInfo,
    ],
    [{ fonts: ['Arial'], source: 'windows' }, fonts],
    [
      { v1: ['one'], voices: { v2: ['two'] }, nativeV3: ['three'], api: { voices: ['four'] } },
      voices,
    ],
    [{ callId: 'call-a', transport: { sdp: 'fixture' } }, callStart],
    [
      { submission: 'unknown', unknownOutcome: true, message: { submission: 'unknown' } },
      sendResult,
    ],
  ];
  for (const [value, validate] of cases) assert.equal(validate(value), true);
  assert.equal(voices({ voices: ['valid', 2] }), false);
  assert.equal(attachment({ id: 'file', name: 'report' }), false);
  assert.equal(telegram({ enabled: true }), false);
  assert.throws(() => read(null, attachment, 'attachment'), /Invalid attachment/);
  const file = { id: 'file', name: 'report.txt', type: 'text/plain' };
  assert.equal(read(file, attachment, 'attachment'), file);
});
