import { sourceIndex } from './source-fixtures.mjs';
import { languageContext } from './language-context.mjs';
import { createTaskReplyController } from '../ui/work/task-reply.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createUpdateDraft, updateDraftScope } from '../ui/settings/update-draft.js';

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const state = () => ({
  mode: 'vm-controller',
  conversationId: ids[0],
  controller: { status: 'online', cached: false },
  settings: { vm: { host: '192.0.2.1', user: 'dant', port: 22, keyPath: 'C:/private/key' } },
  messages: [{ id: ids[1], role: 'assistant' }],
});
const draft = () => ({
  text: '未发送的草稿 & a quote',
  replyTo: ids[1],
  attachments: [
    {
      id: ids[2],
      name: 'notes.txt',
      type: 'text/plain',
      size: 12,
      guestPath: '/private/guest/file',
      token: 'DO_NOT_PERSIST',
    },
  ],
});
function fixture() {
  const values = new Map(),
    storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
  let now = 1800000000000;
  const helper = createUpdateDraft({ storage, now: () => now });
  return {
    helper,
    storage,
    values,
    get record() {
      return JSON.parse([...values.values()][0]);
    },
    set record(value) {
      values.set('dant.updateDraft.v1', JSON.stringify(value));
    },
    advance: (ms) => (now += ms),
  };
}

test('update restart preserves only bounded unsent text, quote identity and attachment display metadata, once', async () => {
  const f = fixture(),
    current = state();
  await f.helper.save(current, draft());
  const encoded = [...f.values.values()][0];
  assert.doesNotMatch(encoded, /DO_NOT_PERSIST|guestPath|private|192\.0\.2|keyPath/);
  assert.match(f.record.scope, /^[a-f0-9]{64}$/);
  const result = await f.helper.take(current);
  assert.deepEqual(result, {
    text: draft().text,
    replyTo: ids[1],
    attachments: [{ id: ids[2], name: 'notes.txt', type: 'text/plain', size: 12 }],
  });
  assert.equal(f.values.size, 0);
  assert.equal(await f.helper.take(current), null);
});

test('an authoritative matching conversation is required and offline cache cannot consume a draft', async () => {
  const f = fixture(),
    current = state();
  await f.helper.save(current, draft());
  for (const offline of [
    { ...current, mode: 'vm-worker' },
    { ...current, controller: { status: 'offline', cached: true } },
    { ...current, controller: { status: 'online', cached: true } },
  ]) {
    assert.equal(updateDraftScope(offline), null);
    assert.equal(await f.helper.take(offline), null);
    assert.equal(f.values.size, 1);
  }
  assert.ok(await f.helper.take(current));
  for (const mutate of [
    (s) => (s.conversationId = ids[2]),
    (s) => (s.settings.vm.host = '192.0.2.2'),
    (s) => (s.settings.vm.user = 'other'),
    (s) => (s.settings.vm.port = 2222),
    (s) => (s.settings.vm.keyPath = 'C:/different/key'),
  ]) {
    await f.helper.save(current, draft());
    const other = structuredClone(current);
    mutate(other);
    assert.equal(await f.helper.take(other), null);
    assert.equal(f.values.size, 0);
  }
});

test('expired, future, malformed and oversized records cannot restore or linger', async () => {
  const f = fixture(),
    current = state();
  await f.helper.save(current, draft());
  f.advance(2 * 60 * 60 * 1000 + 1);
  assert.equal(await f.helper.take(current), null);
  assert.equal(f.values.size, 0);
  for (const mutate of [
    (r) => (r.savedAt += 1000),
    (r) => (r.version = 2),
    (r) => (r.token = 'FORBIDDEN'),
    (r) => (r.attachments[0].guestPath = '/outside'),
    (r) => (r.attachments = null),
    (r) => (r.text = 'x'.repeat(100001)),
  ]) {
    await f.helper.save(current, draft());
    const record = f.record;
    mutate(record);
    f.record = record;
    assert.equal(await f.helper.take(current), null);
    assert.equal(f.values.size, 0);
  }
  for (const text of ['not JSON', 'x'.repeat(512 * 1024 + 1)]) {
    f.values.set('dant.updateDraft.v1', text);
    assert.equal(await f.helper.take(current), null);
    assert.equal(f.values.size, 0);
  }
});

test('invalid drafts fail explicitly without truncation or an installation-safe false acknowledgement', async () => {
  for (const change of [
    (d) => (d.text = 'x'.repeat(100001)),
    (d) => (d.replyTo = 'bad-id'),
    (d) => (d.attachments = Array.from({ length: 6 }, () => draft().attachments[0])),
    (d) => (d.attachments[0].id = '../path'),
    (d) => (d.attachments[0].size = 11 * 1024 * 1024),
    (d) => (d.attachments[0].type = 'text/plain\nsecret'),
    (d) => d.attachments.push({ ...d.attachments[0] }),
  ]) {
    const f = fixture(),
      value = draft();
    change(value);
    await assert.rejects(f.helper.save(state(), value), /draft could not be saved/);
    assert.equal(f.values.size, 0);
  }
  const f = fixture(),
    current = state();
  current.controller.cached = true;
  await assert.rejects(f.helper.save(current, draft()), /draft could not be saved/);
  assert.equal(f.values.size, 0);
});

test('new input wins over saved input, missing quotes are dropped, and simultaneous restores cannot duplicate', async () => {
  const f = fixture(),
    current = state();
  await f.helper.save(current, draft());
  assert.equal(await f.helper.take(current, { occupied: true }), null);
  assert.equal(f.values.size, 0);
  await f.helper.save(current, draft());
  const [first, second] = await Promise.all([f.helper.take(current), f.helper.take(current)]);
  assert.ok(first);
  assert.equal(second, null);
  await f.helper.save(current, draft());
  current.messages = [];
  const result = await f.helper.take(current);
  assert.equal(result.replyTo, null);
  assert.equal(result.text, draft().text);
});

test('installation cleanup removes only its own saved attempt and storage failure never permits recovery twice', async () => {
  const f = fixture(),
    current = state(),
    old = await f.helper.save(current, draft()),
    latest = await f.helper.save(current, { ...draft(), text: 'newer draft' });
  f.helper.discard(old);
  f.helper.discard(null);
  assert.equal(f.record.receipt, latest);
  f.helper.discard(latest);
  assert.equal(f.values.size, 0);
  const broken = createUpdateDraft({
    storage: {
      getItem() {
        throw Error('PRIVATE_TOKEN');
      },
      setItem() {
        throw Error('PRIVATE_TOKEN');
      },
      removeItem() {},
    },
  });
  await assert.rejects(
    broken.save(current, draft()),
    (error) =>
      /draft could not be saved/.test(error.message) && !error.message.includes('PRIVATE_TOKEN'),
  );
  await f.helper.save(current, draft());
  f.storage.removeItem = () => {
    throw Error('No storage access');
  };
  assert.equal(await f.helper.take(current), null);
  assert.equal(f.values.size, 1);
});

test('an empty composer must clear a stale restart draft successfully before installation can proceed', async () => {
  const f = fixture(),
    current = state(),
    empty = { text: '', replyTo: null, attachments: [] };
  await f.helper.save(current, draft());
  f.storage.removeItem = () => {};
  await assert.rejects(f.helper.save(current, empty), /draft could not be saved/);
  assert.equal(
    await f.helper.take(current),
    null,
    'a no-op removal cannot acknowledge one-shot restoration',
  );
  assert.equal(f.values.size, 1);
  f.storage.removeItem = (key) => f.values.delete(key);
  assert.equal(await f.helper.save(current, empty), null);
  assert.equal(f.values.size, 0);
});

function mainFixture() {
  const source = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8'),
    start = sourceIndex(source, 'function updateInstallState(){'),
    end = sourceIndex(source, 'function toast(', start),
    calls = [],
    current = state(),
    input = { value: 'Current composer text' },
    context = {
      state: current,
      eventConnected: true,
      pc: null,
      callStarting: false,
      callStops: { pending: false },
      recording: null,
      recordStarting: false,
      dictating: false,
      recordDraft: null,
      sending: false,
      uploading: 0,
      messageSubmissions: { unknown: null },
      document: { querySelector: () => input },
      composerDraft: 'older render text',
      replyTo: ids[1],
      attachments: draft().attachments,
      updateInstalling: false,
      restoringUpdateDraft: false,
      unloading: false,
      render() {},
      updateDraftScope,
      updateDraft: {
        save: async (...args) => {
          calls.push(args);
          return ids[0];
        },
        discard: (id) => calls.push(['discard', id]),
        take: async () => null,
      },
    };
  context.taskReplies ??= createTaskReplyController({
    document: context.document,
    getModel: () => ({}),
  });
  vm.createContext(Object.assign(context, languageContext));
  vm.runInContext(source.slice(start, end), context);
  return { source, context, calls, input };
}

test('main maps actual controller state and every call/media/input guard without treating VM work as an install blocker', () => {
  const f = mainFixture(),
    c = f.context;
  assert.equal(c.updateInstallState().mode, 'controller');
  c.state.active = { turnId: 'ongoing' };
  c.state.queue = ['next'];
  assert.equal(c.updateInstallState().unsafeLocalInput, false);
  for (const name of ['pc', 'callStarting']) {
    c[name] = true;
    assert.equal(c.updateInstallState().call, true);
    c[name] = false;
  }
  c.callStops.pending = true;
  assert.equal(c.updateInstallState().call, true);
  c.callStops.pending = false;
  c.state.call = { id: 'remote-call' };
  assert.equal(c.updateInstallState().call, true);
  c.state.call = null;
  for (const name of [
    'recording',
    'recordStarting',
    'dictating',
    'recordDraft',
    'sending',
    'uploading',
  ]) {
    c[name] = true;
    assert.equal(c.updateInstallState().unsafeLocalInput, true);
    c[name] = false;
  }
  c.messageSubmissions.unknown = { clientMessageId: 'unconfirmed' };
  assert.equal(c.updateInstallState().unsafeLocalInput, true);
  c.messageSubmissions.unknown = null;
  c.eventConnected = false;
  assert.equal(c.updateInstallState().mode, 'offline');
  c.eventConnected = true;
  c.state.controller.cached = true;
  assert.equal(
    c.updateInstallState().mode,
    'controller',
    'the local app can confirm work by reconnecting before installing',
  );
});

test('main saves only composer data then fences new calls/sends/uploads until failed-install cleanup releases it', async () => {
  const f = mainFixture(),
    c = f.context,
    cleanup = await c.saveUpdateDraft();
  assert.equal(c.updateInstalling, true);
  assert.equal(f.calls[0][1].text, 'Current composer text');
  assert.deepEqual(Object.keys(f.calls[0][1]), ['text', 'replyTo', 'attachments']);
  const action = f.source.slice(
    sourceIndex(f.source, 'async function action(a){'),
    sourceIndex(f.source, 'async function checkUnconfirmedMessage(){'),
  );
  vm.runInContext(action, c);
  await c.action('call');
  assert.equal(c.pc, null);
  assert.equal(f.calls.length, 1);
  cleanup();
  assert.equal(c.updateInstalling, false);
  assert.deepEqual(f.calls[1], ['discard', ids[0]]);
  c.recordDraft = { previewURL: 'blob:unsaved' };
  await assert.rejects(c.saveUpdateDraft(), /pending input/);
  assert.equal(f.calls.length, 2);
});

test('install admission locks input before asynchronous draft storage and releases immediately on save failure', async () => {
  const f = mainFixture(),
    c = f.context;
  let finish;
  c.updateDraft.save = () => new Promise((resolve) => (finish = resolve));
  const pending = c.saveUpdateDraft();
  assert.equal(
    c.updateInstalling,
    true,
    'typing and action admission must be locked before the first await',
  );
  const action = f.source.slice(
    sourceIndex(f.source, 'async function action(a){'),
    sourceIndex(f.source, 'async function checkUnconfirmedMessage(){'),
  );
  vm.runInContext(action, c);
  await c.action('call');
  assert.equal(c.pc, null);
  await assert.rejects(
    c.saveUpdateDraft(),
    /pending input/,
    'a second save cannot replace the admitted snapshot',
  );
  finish(ids[0]);
  const cleanup = await pending;
  cleanup();
  assert.equal(c.updateInstalling, false);
  c.updateDraft.save = async () => {
    throw Error('Draft storage unavailable');
  };
  await assert.rejects(c.saveUpdateDraft(), /Draft storage unavailable/);
  assert.equal(
    c.updateInstalling,
    false,
    'failed persistence cannot leave the app locked or admit the installer',
  );
});

test('a call awaiting speech cleanup cannot start after installation admission is locked', async () => {
  const f = mainFixture(),
    c = f.context;
  let finish;
  c.state.worker = { status: 'online' };
  Object.assign(c, {
    apiVoiceUnavailable: () => false,
    subscriptionVoiceUnavailable: () => false,
    callGeneration: 1,
    speakingId: 'reading',
    navigator: {
      mediaDevices: {
        getUserMedia() {
          assert.fail('installation must not acquire microphone');
        },
      },
    },
    window: { RTCPeerConnection() {} },
    stopSpeech: () => new Promise((resolve) => (finish = resolve)),
  });
  vm.runInContext(
    f.source.slice(
      sourceIndex(f.source, "async function startCall(provider='subscription'){"),
      sourceIndex(f.source, 'function cleanupCall('),
    ),
    c,
  );
  const pending = c.startCall();
  await Promise.resolve();
  c.updateInstalling = true;
  finish();
  await pending;
  assert.equal(c.callStarting, false);
  assert.equal(c.pc, null);
  await c.startCall();
});

test('main restores once only into an empty matching draft and keeps new user input untouched', async () => {
  const f = mainFixture(),
    c = f.context;
  f.input.value = '';
  c.composerDraft = '';
  c.replyTo = null;
  c.attachments = [];
  c.updateDraft.take = async () => ({ text: 'Recovered text', replyTo: ids[1], attachments: [] });
  await c.restoreUpdateDraft();
  assert.equal(f.input.value, 'Recovered text');
  assert.equal(c.replyTo, ids[1]);
  f.input.value = 'New user input';
  await c.restoreUpdateDraft();
  assert.equal(f.input.value, 'New user input');
});

test('update drafts preserve an explicit task target without rebinding it to the latest task', async () => {
  const f = fixture(),
    current = state(),
    workReply = { workId: 'work-a', turnId: 'turn-a', conversationId: current.conversationId };
  await f.helper.save(current, { ...draft(), workReply });
  assert.deepEqual((await f.helper.take(current)).workReply, workReply);
  const empty = { text: '', replyTo: null, attachments: [], workReply };
  await f.helper.save(current, empty);
  assert.deepEqual(
    await f.helper.take(current),
    empty,
    'a selected task is itself part of the unsent draft',
  );
  for (const invalid of [
    { ...workReply, turnId: 'bad turn' },
    { ...workReply, extra: 'private' },
    null,
  ])
    await assert.rejects(
      f.helper.save(current, { ...draft(), workReply: invalid }),
      /draft could not be saved/,
    );
  const main = mainFixture(),
    c = main.context;
  c.taskReplies.restore(workReply);
  await c.saveUpdateDraft();
  assert.deepEqual(callsTarget(main), workReply);
  function callsTarget(app) {
    return app.calls[0][1].workReply;
  }
  const recovered = mainFixture();
  recovered.input.value = '';
  recovered.context.composerDraft = '';
  recovered.context.replyTo = null;
  recovered.context.attachments = [];
  recovered.context.updateDraft.take = async () => ({
    text: 'I finished verification',
    replyTo: null,
    attachments: [],
    workReply,
  });
  await recovered.context.restoreUpdateDraft();
  assert.deepEqual(recovered.context.taskReplies.target, workReply);
  assert.equal(recovered.input.value, 'I finished verification');
  assert.throws(
    () => recovered.context.taskReplies.prepare(),
    /Update the work computer/,
    'restoring a stale target cannot silently downgrade its text to ordinary chat',
  );
});
