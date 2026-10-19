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
} from '../../../src/contracts/states.mts';
import type { AppState } from '../../../ui/app/application-types.ts';

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
