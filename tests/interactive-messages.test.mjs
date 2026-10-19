import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/conversation/store.mjs';
import { Engine } from '../src/work/engine.mjs';
import { ConversationHistory } from '../src/conversation/history.mjs';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'interactive-messages-')),
    store = new Store(dir),
    worker = new EventEmitter();
  Object.assign(worker, {
    status: 'online',
    runtimeId: 'vm:interactive:test',
    workspaceRoot: path.join(dir, 'workspaces'),
    calls: [],
    turns: 0,
    rpc: { send() {} },
  });
  worker.request = async (method, params) => {
    worker.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'shared-thread' } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + ++worker.turns } };
    if (method === 'turn/interrupt')
      queueMicrotask(() =>
        worker.emit('event', {
          method: 'turn/completed',
          params: { threadId: 'shared-thread', turn: { id: params.turnId, status: 'interrupted' } },
        }),
      );
    return {};
  };
  const engine = new Engine(store, worker, options),
    notices = [];
  engine.on('notice', (notice) => notices.push(notice));
  t.after(() => {
    clearTimeout(engine.streamingSaveTimer);
    assert.ok(dir.startsWith(base + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const message = (text, extra = {}) =>
    store.add({ role: 'user', text, status: 'queued', ...extra });
  const finish = (id = 'turn-1') =>
    engine.handle({
      method: 'turn/completed',
      params: { threadId: 'shared-thread', turn: { id, status: 'completed' } },
    });
  const calls = (method) => worker.calls.filter((call) => call.method === method);
  return { dir, store, worker, engine, notices, message, finish, calls };
}

test('retrying a failed call input cannot switch it into a separate text executor during a call', async (t) => {
  const h = fixture(t),
    input = h.message('This one', {
      status: 'failed',
      voiceCallId: 'api-call',
      workKind: 'conversation',
      submission: 'rejected',
    });
  h.engine.call = { id: 'api-call', provider: 'api' };
  assert.throws(() => h.engine.resumePaused([input.id]), /new message in the current call/);
  assert.equal(h.engine.queue.length, 0);
  assert.equal(input.status, 'failed');
  assert.equal(h.calls('turn/start').length, 0);
  h.engine.call = null;
  h.engine.resumePaused([input.id]);
  await tick();
  assert.equal(h.calls('turn/start').length, 1);
  await h.finish();
});
async function start(f) {
  const initial = f.message('Continue working on the existing task');
  f.engine.enqueue(initial);
  await tick();
  assert.equal(initial.submission, 'confirmed');
  return initial;
}

test('ordinary interactive followups reach an ongoing task and gain a receipt only after acknowledgement', async (t) => {
  const f = fixture(t),
    initial = await start(f),
    ack = deferred(),
    request = f.worker.request;
  f.worker.request = (method, params) =>
    method === 'turn/steer'
      ? (f.worker.calls.push({ method, params }), ack.promise)
      : request(method, params);
  const followup = f.message('你开一个 room 给我');
  f.engine.enqueue(followup, { interactive: true });
  await tick();
  assert.equal(f.calls('turn/steer').length, 1);
  assert.equal(f.calls('turn/start').length, 1);
  assert.equal(f.engine.queue.length, 0);
  assert.equal(followup.submission, 'submitting');
  assert.equal(followup.executorConfirmedAt, null);
  assert.equal(followup.read, false);
  assert.equal(f.calls('turn/steer')[0].params.expectedTurnId, initial.turnId);
  assert.match(f.calls('turn/steer')[0].params.input[0].text, /你开一个 room 给我/);
  ack.resolve({});
  await f.engine.active.steerChain;
  await tick();
  assert.equal(followup.submission, 'confirmed');
  assert.ok(followup.executorConfirmedAt);
  assert.equal(followup.parentTaskId, initial.id);
  assert.equal(followup.turnId, initial.turnId);
  assert.equal(followup.read, false);
  await f.finish();
  assert.equal(followup.status, 'review');
});

test('rapid distinct interactive messages serialize on the captured turn and pending duplicate IDs are not resubmitted', async (t) => {
  const f = fixture(t);
  await start(f);
  const ack = deferred(),
    request = f.worker.request;
  f.worker.request = (method, params) => {
    if (method !== 'turn/steer') return request(method, params);
    f.worker.calls.push({ method, params });
    return f.calls(method).length === 1 ? ack.promise : Promise.resolve({});
  };
  const first = f.message('First adjustment'),
    second = f.message('Second adjustment');
  f.engine.enqueue(first, { interactive: true });
  f.engine.enqueue(first, { interactive: true });
  f.engine.enqueue(second, { interactive: true });
  await tick();
  assert.equal(f.calls('turn/steer').length, 1);
  assert.equal(second.executorConfirmedAt, null);
  assert.equal(f.engine.queue.length, 0);
  ack.resolve({});
  await f.engine.active.steerChain;
  await tick();
  assert.equal(f.calls('turn/steer').length, 2);
  assert.ok(f.calls('turn/steer').every((call) => call.params.expectedTurnId === 'turn-1'));
  assert.ok(first.executorConfirmedAt);
  assert.ok(second.executorConfirmedAt);
  f.engine.enqueue(first, { interactive: true });
  assert.equal(f.calls('turn/steer').length, 2);
  await f.finish();
});

test('scheduled and resumed tasks retain independent queue semantics while interactive followups steer', async (t) => {
  const f = fixture(t);
  await start(f);
  const scheduled = f.message('Scheduled job', { scheduled: true }),
    resumed = f.message('Paused independent job', { status: 'paused' });
  f.engine.enqueue(scheduled);
  f.engine.resumePaused([resumed.id]);
  const followup = f.message('Use the updated requirements');
  f.engine.enqueue(followup, { interactive: true });
  await tick();
  assert.deepEqual(
    f.engine.queue.map((message) => message.id),
    [scheduled.id, resumed.id],
  );
  assert.equal(f.calls('turn/steer').length, 1);
  assert.equal(followup.turnId, 'turn-1');
  await f.finish();
  await tick();
  assert.equal(scheduled.turnId, 'turn-2');
  assert.equal(resumed.executorConfirmedAt, null);
  await f.finish('turn-2');
  await tick();
  assert.equal(resumed.turnId, 'turn-3');
  await f.finish('turn-3');
});

test('a background input blocker never consumes an independent scheduled or resumed task as its answer', async (t) => {
  const f = fixture(t);
  await start(f);
  Object.assign(f.engine.active, { backgroundVoice: true, awaitingChatInput: true });
  const scheduled = f.message('Independent reminder', { scheduled: true }),
    resumed = f.message('Independent paused work', { status: 'paused' });
  f.engine.enqueue(scheduled);
  f.engine.resumePaused([resumed.id]);
  await tick();
  assert.equal(f.calls('turn/steer').length, 0);
  assert.equal(f.engine.active.awaitingChatInput, true);
  assert.deepEqual(
    f.engine.queue.map((message) => message.id),
    [scheduled.id, resumed.id],
  );
  assert.equal(scheduled.executorConfirmedAt, null);
  assert.equal(resumed.executorConfirmedAt, null);
  const answer = f.message('The actual answer from chat');
  f.engine.enqueue(answer, { interactive: true });
  await f.engine.active.steerChain;
  assert.equal(answer.submission, 'confirmed');
  assert.equal(f.engine.active.awaitingChatInput, false);
  assert.equal(f.calls('turn/steer').length, 1);
  f.engine.pauseQueue();
  await f.finish();
});

test('a followup before initial turn acknowledgement remains queued and does not guess an owner', async (t) => {
  const f = fixture(t),
    ack = deferred(),
    request = f.worker.request;
  f.worker.request = (method, params) =>
    method === 'turn/start' && f.worker.turns === 0
      ? (f.worker.calls.push({ method, params }), f.worker.turns++, ack.promise)
      : request(method, params);
  const initial = f.message('Original task');
  f.engine.enqueue(initial);
  await tick();
  const next = f.message('Not yet bound to an accepted owner');
  f.engine.enqueue(next, { interactive: true });
  assert.equal(f.engine.queue.length, 1);
  assert.equal(next.executorConfirmedAt, null);
  assert.equal(f.calls('turn/steer').length, 0);
  ack.resolve({ turn: { id: 'turn-1' } });
  await tick();
  assert.equal(next.executorConfirmedAt, null);
  await f.finish();
  await tick();
  assert.equal(next.turnId, 'turn-2');
  await f.finish('turn-2');
});

test('an owned turn that finishes before dispatch safely queues the unsent followup as a new task', async (t) => {
  const f = fixture(t);
  await start(f);
  const next = f.message('Follow up after completion');
  f.engine.enqueue(next, { interactive: true });
  await f.finish();
  await tick();
  assert.equal(f.calls('turn/steer').length, 0);
  assert.equal(f.calls('turn/start').length, 2);
  assert.equal(next.turnId, 'turn-2');
  assert.equal(next.submission, 'confirmed');
  assert.equal(next.parentTaskId, null);
  assert.equal(next.error, null);
  await f.finish('turn-2');
});

test('completion while a steer acknowledgement is in flight never starts another task or loses the receipt', async (t) => {
  const f = fixture(t);
  await start(f);
  const ack = deferred(),
    request = f.worker.request;
  f.worker.request = (method, params) =>
    method === 'turn/steer'
      ? (f.worker.calls.push({ method, params }), ack.promise)
      : request(method, params);
  const next = f.message('Adjustment accepted just before completion');
  f.engine.enqueue(next, { interactive: true });
  await tick();
  const active = f.engine.active;
  await f.finish();
  assert.equal(next.executorConfirmedAt, null);
  ack.resolve({});
  await active.steerChain;
  await tick();
  assert.equal(f.calls('turn/start').length, 1);
  assert.equal(f.calls('turn/steer').length, 1);
  assert.equal(next.status, 'review');
  assert.equal(next.submission, 'confirmed');
  assert.ok(next.executorConfirmedAt);
  assert.equal(f.engine.queue.length, 0);
});

test('takeover during a pending adjustment pauses later unsent followups instead of replaying them', async (t) => {
  const f = fixture(t);
  await start(f);
  const ack = deferred(),
    request = f.worker.request;
  f.worker.request = (method, params) =>
    method === 'turn/steer'
      ? (f.worker.calls.push({ method, params }), ack.promise)
      : request(method, params);
  const first = f.message('Already submitting'),
    second = f.message('Must not execute after takeover');
  f.engine.enqueue(first, { interactive: true });
  f.engine.enqueue(second, { interactive: true });
  await tick();
  const active = f.engine.active;
  await f.engine.acquire();
  assert.equal(f.engine.takeover, true);
  ack.resolve({});
  await active.steerChain;
  await tick();
  assert.equal(f.calls('turn/steer').length, 1);
  assert.equal(first.submission, 'confirmed');
  assert.equal(second.status, 'paused');
  assert.equal(second.submission, 'preparing');
  assert.equal(second.executorConfirmedAt, null);
  assert.equal(f.engine.queue.length, 0);
  assert.equal(f.calls('turn/start').length, 1);
  f.engine.release();
  await tick();
  assert.equal(f.calls('turn/start').length, 1);
});

test('an explicit pause after the owner completes still cancels serialized unsent followups', async (t) => {
  const f = fixture(t);
  await start(f);
  const ack = deferred(),
    request = f.worker.request;
  f.worker.request = (method, params) =>
    method === 'turn/steer'
      ? (f.worker.calls.push({ method, params }), ack.promise)
      : request(method, params);
  const first = f.message('Acknowledgement still pending'),
    second = f.message('Do not restart after pause');
  f.engine.enqueue(first, { interactive: true });
  f.engine.enqueue(second, { interactive: true });
  await tick();
  const retired = f.engine.active;
  await f.finish();
  assert.equal(f.engine.active, null);
  await f.engine.pause();
  ack.resolve({});
  await retired.steerChain;
  await tick();
  assert.equal(first.submission, 'confirmed');
  assert.equal(first.status, 'review');
  assert.equal(second.submission, 'preparing');
  assert.equal(second.status, 'paused');
  assert.equal(second.pauseReason, 'user-paused');
  assert.equal(second.executorConfirmedAt, null);
  assert.equal(f.calls('turn/steer').length, 1);
  assert.equal(f.calls('turn/start').length, 1);
  assert.equal(f.engine.queue.length, 0);
});

test('queue cancellation prevents a serialized interactive adjustment from dispatching on a still-running owner', async (t) => {
  const f = fixture(t);
  await start(f);
  const ack = deferred(),
    request = f.worker.request;
  f.worker.request = (method, params) =>
    method === 'turn/steer'
      ? (f.worker.calls.push({ method, params }), ack.promise)
      : request(method, params);
  const first = f.message('First adjustment'),
    second = f.message('Cancelled pending adjustment');
  f.engine.enqueue(first, { interactive: true });
  f.engine.enqueue(second, { interactive: true });
  await tick();
  f.engine.cancelQueue();
  ack.resolve({});
  await f.engine.active.steerChain;
  await tick();
  assert.equal(f.calls('turn/steer').length, 1);
  assert.equal(second.status, 'paused');
  assert.equal(second.pauseReason, 'user-paused');
  assert.equal(second.executorConfirmedAt, null);
  assert.equal(f.engine.queue.length, 0);
  await f.finish();
});

test('a removed pending message can never be queued later by a completion race', async (t) => {
  const f = fixture(t);
  await start(f);
  const ack = deferred(),
    request = f.worker.request;
  f.worker.request = (method, params) =>
    method === 'turn/steer'
      ? (f.worker.calls.push({ method, params }), ack.promise)
      : request(method, params);
  const first = f.message('First adjustment'),
    removed = f.message('Removed before submission');
  f.engine.enqueue(first, { interactive: true });
  f.engine.enqueue(removed, { interactive: true });
  await tick();
  const retired = f.engine.active;
  await f.finish();
  f.store.state.messages = f.store.state.messages.filter((message) => message.id !== removed.id);
  f.store.save();
  ack.resolve({});
  await retired.steerChain;
  await tick();
  assert.equal(f.engine.queue.length, 0);
  assert.equal(f.calls('turn/start').length, 1);
  assert.equal(f.calls('turn/steer').length, 1);
  assert.equal(
    f.store.state.messages.some((message) => message.id === removed.id),
    false,
  );
});

test('unknown adjustment acknowledgement blocks later automatic steering and never replays uncertain input', async (t) => {
  const f = fixture(t);
  await start(f);
  const ack = deferred(),
    request = f.worker.request;
  f.worker.request = (method, params) =>
    method === 'turn/steer'
      ? (f.worker.calls.push({ method, params }), ack.promise)
      : request(method, params);
  const uncertain = f.message('May have reached the executor'),
    waiting = f.message('Waiting behind acknowledgement');
  f.engine.enqueue(uncertain, { interactive: true });
  f.engine.enqueue(waiting, { interactive: true });
  await tick();
  ack.reject(Error('Connection lost after dispatch'));
  await f.engine.active.steerChain;
  await tick();
  assert.equal(uncertain.status, 'paused');
  assert.equal(uncertain.submission, 'unknown');
  assert.equal(uncertain.executorConfirmedAt, null);
  assert.equal(waiting.status, 'paused');
  assert.equal(waiting.submission, 'preparing');
  assert.equal(f.engine.progress.canSteer, false);
  assert.equal(f.engine.progress.status, 'unknown');
  const later = f.message('A later instruction');
  f.engine.enqueue(later, { interactive: true });
  f.engine.enqueue(uncertain, { interactive: true });
  await tick();
  assert.equal(later.status, 'paused');
  assert.equal(later.pauseReason, 'submission-unknown');
  assert.equal(uncertain.submission, 'unknown');
  assert.equal(f.calls('turn/steer').length, 1);
  assert.equal(f.calls('turn/start').length, 1);
  assert.equal(f.engine.queue.length, 0);
  await f.finish();
});

test('a definite steering rejection fails that message without claiming read and does not poison the accepted task', async (t) => {
  const f = fixture(t);
  await start(f);
  const request = f.worker.request;
  let rejected = false;
  f.worker.request = (method, params) => {
    if (method === 'turn/steer' && !rejected) {
      rejected = true;
      f.worker.calls.push({ method, params });
      return Promise.reject(Object.assign(Error('Invalid input'), { code: -32602 }));
    }
    return request(method, params);
  };
  const bad = f.message('Rejected adjustment');
  f.engine.enqueue(bad, { interactive: true });
  await f.engine.active.steerChain;
  await tick();
  assert.equal(bad.status, 'failed');
  assert.equal(bad.submission, 'rejected');
  assert.equal(bad.executorConfirmedAt, null);
  assert.equal(f.engine.progress.canSteer, true);
  const good = f.message('A corrected adjustment');
  f.engine.enqueue(good, { interactive: true });
  await f.engine.active.steerChain;
  await tick();
  assert.equal(good.submission, 'confirmed');
  assert.equal(f.calls('turn/steer').length, 2);
  await f.finish();
});

test('interactive media retains reply context, image and file paths, and private recognized speech', async (t) => {
  const f = fixture(t, {
    audioTranscriber: { transcribe: async () => ({ text: '用蓝色的那个。 Use the blue one.' }) },
  });
  await start(f);
  const prior = f.store.add({
      role: 'assistant',
      text: 'Which example should I use?',
      status: 'completed',
    }),
    files = [
      { id: 'audio', type: 'audio/webm', guestPath: '/managed/voice.webm' },
      { id: 'image', type: 'image/png', guestPath: '/managed/example.png' },
      { id: 'text', type: 'text/plain', guestPath: '/managed/notes.txt' },
    ];
  const next = f.message('These are the updated examples', {
    replyTo: prior.id,
    attachments: files,
  });
  f.engine.enqueue(next, { interactive: true });
  await f.engine.active.steerChain;
  await tick();
  const input = f.calls('turn/steer')[0].params.input;
  assert.match(input[0].text, /Which example should I use/);
  assert.match(input[0].text, /These are the updated examples/);
  assert.match(input[0].text, /用蓝色的那个/);
  assert.match(input[0].text, /Use the blue one/);
  assert.match(input[0].text, /\/managed\/notes.txt/);
  assert.deepEqual(input[1], { type: 'localImage', path: '/managed/example.png' });
  assert.deepEqual(next.attachments, files);
  assert.equal(
    f.store.state.messages.some((message) => message.text.includes('Use the blue one')),
    false,
  );
  assert.equal(fs.readFileSync(f.store.file, 'utf8').includes('Use the blue one'), false);
  assert.equal(next.submission, 'confirmed');
  assert.equal(f.calls('turn/start').length, 1);
  await f.finish();
});

test('failed media preparation is a definite non-submission without an orphaned queued message', async (t) => {
  const f = fixture(t, {
    audioTranscriber: {
      transcribe: async () => {
        throw Error('No speech recognized');
      },
    },
  });
  await start(f);
  const next = f.message('', {
    attachments: [{ id: 'audio', type: 'audio/webm', guestPath: '/managed/voice.webm' }],
  });
  f.engine.enqueue(next, { interactive: true });
  await f.engine.active.steerChain;
  await tick();
  assert.equal(next.status, 'failed');
  assert.equal(next.submission, 'preparing');
  assert.equal(next.executorConfirmedAt, null);
  assert.equal(f.calls('turn/steer').length, 0);
  assert.equal(f.engine.queue.length, 0);
  await f.finish();
});

test('executor loss during preparation never replays an unsent followup when the connection returns', async (t) => {
  const recognition = deferred(),
    f = fixture(t, { audioTranscriber: { transcribe: () => recognition.promise } });
  await start(f);
  const active = f.engine.active,
    next = f.message('', {
      attachments: [{ id: 'audio', type: 'audio/webm', guestPath: '/managed/voice.webm' }],
    });
  f.engine.enqueue(next, { interactive: true });
  await tick();
  assert.equal(next.submission, 'preparing');
  f.worker.status = 'offline';
  f.worker.emit('status');
  await tick();
  f.worker.status = 'online';
  f.worker.emit('status');
  recognition.resolve({ text: 'Never submit after this interruption' });
  await active.steerChain;
  await tick();
  assert.ok(['paused', 'failed'].includes(next.status));
  assert.equal(next.submission, 'preparing');
  assert.equal(next.executorConfirmedAt, null);
  assert.equal(f.calls('turn/steer').length, 0);
  assert.equal(f.calls('turn/start').length, 1);
  assert.equal(f.engine.queue.length, 0);
});

test('native background interactive routing is opted in while default tasks and attached media stay queued', async (t) => {
  const f = fixture(t),
    received = [];
  f.engine.nativeVoice = {
    session: { background: true },
    active: { turnId: 'native-owned' },
    acceptsChatInput: true,
    acceptsInteractiveChatInput: true,
    answerBackground: async (message, options) => {
      received.push({ message, options });
    },
  };
  const normal = f.message('Adjust native background work'),
    scheduled = f.message('Independent schedule', { scheduled: true }),
    media = f.message('Keep original attachment handling', {
      attachments: [{ type: 'text/plain', guestPath: '/managed/file.txt' }],
    });
  f.engine.enqueue(normal, { interactive: true });
  f.engine.enqueue(normal, { interactive: true });
  f.engine.enqueue(scheduled);
  f.engine.enqueue(media, { interactive: true });
  await tick();
  assert.equal(received.length, 1);
  assert.equal(received[0].message, normal);
  assert.deepEqual(received[0].options, { interactive: true, expectedTurnId: 'native-owned' });
  assert.deepEqual(
    f.engine.queue.map((message) => message.id),
    [scheduled.id, media.id],
  );
  assert.equal(f.calls('turn/start').length, 0);
});

test('interactive messages during human control and uncertain restored submissions never acquire a task owner', async (t) => {
  const f = fixture(t);
  f.engine.takeover = true;
  const controlled = f.message('Wait for my control');
  f.engine.enqueue(controlled, { interactive: true });
  assert.equal(controlled.status, 'paused');
  assert.equal(controlled.pauseReason, 'human-control');
  f.engine.takeover = false;
  for (const submission of ['submitting', 'unknown']) {
    const uncertain = f.message('Do not replay', { submission, status: 'paused' });
    f.engine.enqueue(uncertain, { interactive: true });
    assert.equal(uncertain.status, 'paused');
    assert.equal(uncertain.submission, submission);
    assert.equal(uncertain.pauseReason, 'submission-unknown');
  }
  assert.equal(f.worker.calls.length, 0);
  assert.equal(f.engine.queue.length, 0);
});

test('current API call text reaches its voice peer after canonical context, with one read receipt and no separate task', async (t) => {
  const f = fixture(t),
    ack = deferred(),
    received = [];
  f.engine.call = { id: 'api-call', provider: 'api', status: 'connected' };
  f.engine.voice = {
    state: {},
    message: async (input) => {
      received.push(input);
      return ack.promise;
    },
  };
  const quoted = f.store.add({
      role: 'assistant',
      text: 'The blue example in the current conversation',
      status: 'completed',
    }),
    message = f.message('这个', { replyTo: quoted.id });
  f.engine.enqueue(message, { interactive: true });
  f.engine.enqueue(message, { interactive: true });
  await tick();
  assert.equal(received.length, 1);
  assert.equal(received[0].message, message);
  assert.equal(received[0].reply, quoted);
  assert.equal(received[0].callId, 'api-call');
  assert.equal(message.status, 'accepted');
  assert.equal(message.executorConfirmedAt, null);
  assert.deepEqual(message.callContext, { callId: 'api-call', status: 'submitted' });
  const injections = f.calls('thread/inject_items');
  assert.equal(injections.length, 1);
  const reference = injections[0].params.items[0].content[0].text;
  assert.match(reference, /这个/);
  assert.match(reference, /The blue example in the current conversation/);
  assert.match(reference, /"role":"assistant"/);
  assert.equal(f.calls('turn/start').length, 0);
  assert.equal(f.calls('turn/steer').length, 0);
  ack.resolve({ submission: 'confirmed', confirmedAt: 1234 });
  await Promise.all([...f.engine.pendingFollowups.values()]);
  assert.equal(message.submission, 'confirmed');
  assert.equal(message.executorConfirmedAt, 1234);
  assert.equal(message.voiceCallId, 'api-call');
  assert.equal(message.turnId, undefined);
  assert.equal(f.engine.queue.length, 0);
  f.engine.enqueue(message, { interactive: true });
  await tick();
  assert.equal(received.length, 1);
  assert.equal(f.calls('thread/inject_items').length, 1);
  f.engine.call = { id: 'later-api-call', provider: 'api' };
  f.engine.enqueue(message, { interactive: true });
  await tick();
  assert.equal(received.length, 1);
  assert.equal(message.voiceCallId, 'api-call');
  assert.equal(f.calls('thread/inject_items').length, 1);
});

test('API typed context enters the canonical thread only after preceding finalized speech has been saved', async (t) => {
  const f = fixture(t),
    speech = deferred(),
    order = [];
  f.engine.call = { id: 'call', provider: 'api' };
  f.engine.voice = {
    state: {},
    conversationReady: async () => {
      order.push('speech-barrier');
      await speech.promise;
    },
    message: async () => {
      order.push('voice-input');
      return { submission: 'confirmed' };
    },
  };
  const request = f.worker.request;
  f.worker.request = (method, params) => {
    if (method === 'thread/inject_items') order.push('canonical-input');
    return request(method, params);
  };
  const message = f.message('Use the previous spoken fact');
  f.engine.enqueue(message, { interactive: true });
  await tick();
  assert.deepEqual(order, ['speech-barrier']);
  assert.equal(f.calls('thread/inject_items').length, 0);
  speech.resolve();
  await Promise.all([...f.engine.pendingFollowups.values()]);
  assert.deepEqual(order, ['speech-barrier', 'canonical-input', 'voice-input']);
  assert.equal(message.submission, 'confirmed');
  assert.equal(f.calls('turn/start').length, 0);
});

test('Stop during an API speech barrier cancels the unsent typed call input even when the same call remains active', async (t) => {
  const f = fixture(t),
    speech = deferred(),
    received = [];
  f.engine.call = { id: 'call', provider: 'api' };
  f.engine.voice = {
    state: {},
    conversationReady: () => speech.promise,
    message: async (input) => {
      received.push(input);
      return { submission: 'confirmed' };
    },
  };
  const message = f.message('Do not send after Stop');
  f.engine.enqueue(message, { interactive: true });
  await tick();
  await f.engine.pause();
  speech.resolve();
  await Promise.all([...f.engine.pendingFollowups.values()]);
  assert.equal(message.status, 'paused');
  assert.equal(message.submission, 'preparing');
  assert.equal(message.pauseReason, 'user-paused');
  assert.equal(message.executorConfirmedAt, null);
  assert.equal(received.length, 0);
  assert.equal(f.calls('thread/inject_items').length, 0);
  assert.equal(f.calls('turn/start').length, 0);
  assert.equal(f.engine.call.id, 'call');
});

test('Stop during canonical reference acknowledgement preserves the reference but never admits typed voice input', async (t) => {
  const f = fixture(t),
    reference = deferred(),
    received = [],
    request = f.worker.request;
  f.engine.call = { id: 'call', provider: 'api' };
  f.engine.voice = {
    state: {},
    message: async (input) => {
      received.push(input);
      return { submission: 'confirmed' };
    },
  };
  f.worker.request = (method, params) =>
    method === 'thread/inject_items'
      ? (f.worker.calls.push({ method, params }), reference.promise)
      : request(method, params);
  const message = f.message('This should remain reference only after Stop');
  f.engine.enqueue(message, { interactive: true });
  await tick();
  assert.equal(message.callContext.status, 'pending');
  await f.engine.pause();
  reference.resolve({});
  await Promise.all([...f.engine.pendingFollowups.values()]);
  assert.equal(message.callContext.status, 'submitted');
  assert.equal(message.status, 'paused');
  assert.equal(message.submission, 'preparing');
  assert.equal(message.pauseReason, 'user-paused');
  assert.equal(message.executorConfirmedAt, null);
  assert.equal(received.length, 0);
  assert.equal(f.store.state.callInputHistory[0].submission, 'submitted');
  assert.equal(f.calls('turn/start').length, 0);
});

test('native in-call text uses the existing stored message and leaves canonical context and voice admission to one owner', async (t) => {
  const f = fixture(t),
    received = [];
  f.engine.call = { id: 'native-call', provider: 'subscription', status: 'connected' };
  f.engine.nativeVoice = {
    submitCallMessage: async (message, { callId }) => {
      received.push({ message, callId });
      await f.engine.rememberCallInput(message, callId);
      return { submission: 'confirmed' };
    },
  };
  const message = f.message('Reply to me in the current call');
  f.engine.enqueue(message, { interactive: true });
  await Promise.all([...f.engine.pendingFollowups.values()]);
  assert.equal(received.length, 1);
  assert.equal(received[0].message, message);
  assert.equal(received[0].callId, 'native-call');
  assert.equal(message.status, 'accepted');
  assert.equal(message.submission, 'confirmed');
  assert.equal(f.calls('thread/inject_items').length, 1);
  assert.equal(f.calls('turn/start').length, 0);
  assert.equal(f.calls('turn/steer').length, 0);
  assert.equal(f.store.state.messages.length, 1);
});

test('canonical call references deduplicate pending and submitted IDs without pretending that reference injection is a read receipt', async (t) => {
  const f = fixture(t),
    ack = deferred(),
    request = f.worker.request;
  f.engine.call = { id: 'call', provider: 'api' };
  f.worker.request = (method, params) =>
    method === 'thread/inject_items'
      ? (f.worker.calls.push({ method, params }), ack.promise)
      : request(method, params);
  const message = f.message('Keep this exact shared fact'),
    first = f.engine.rememberCallInput(message, 'call'),
    second = f.engine.rememberCallInput(message, 'call');
  assert.equal(first, second);
  await tick();
  assert.equal(f.calls('thread/inject_items').length, 1);
  assert.equal(message.callContext.status, 'pending');
  assert.equal(message.executorConfirmedAt, null);
  ack.resolve({});
  assert.deepEqual(await first, { callId: 'call', status: 'submitted' });
  assert.deepEqual(await f.engine.rememberCallInput(message, 'call'), {
    callId: 'call',
    status: 'submitted',
  });
  assert.equal(f.calls('thread/inject_items').length, 1);
  assert.equal(message.executorConfirmedAt, null);
  assert.equal(f.calls('turn/start').length, 0);
});

test('an uncertain canonical call-reference submission prevents voice admission and is never replayed', async (t) => {
  const f = fixture(t),
    received = [],
    request = f.worker.request;
  f.engine.call = { id: 'call', provider: 'api' };
  f.engine.voice = {
    state: {},
    message: async (input) => {
      received.push(input);
      return { submission: 'confirmed' };
    },
  };
  f.worker.request = (method, params) => {
    if (method !== 'thread/inject_items') return request(method, params);
    f.worker.calls.push({ method, params });
    return Promise.reject(Error('Shared reference acknowledgement lost'));
  };
  const message = f.message('A fact that might already be shared');
  f.engine.enqueue(message, { interactive: true });
  await Promise.all([...f.engine.pendingFollowups.values()]);
  assert.equal(message.submission, 'unknown');
  assert.equal(message.status, 'paused');
  assert.equal(message.callContext.status, 'unknown');
  assert.equal(message.executorConfirmedAt, null);
  assert.equal(received.length, 0);
  await assert.rejects(
    f.engine.rememberCallInput(message, 'call'),
    (error) => error.unknownOutcome,
  );
  f.engine.enqueue(message, { interactive: true });
  const later = f.message('A later message');
  f.engine.enqueue(later, { interactive: true });
  await Promise.all([...f.engine.pendingFollowups.values()]);
  assert.equal(f.calls('thread/inject_items').length, 1);
  assert.equal(received.length, 0);
  assert.equal(f.calls('turn/start').length, 0);
  assert.equal(f.engine.queue.length, 0);
});

test('known canonical-reference rejection or human ownership cannot start a separate call task', async (t) => {
  const f = fixture(t),
    received = [],
    request = f.worker.request;
  f.engine.call = { id: 'call', provider: 'api' };
  f.engine.voice = {
    state: {},
    message: async (input) => {
      received.push(input);
      return { submission: 'confirmed' };
    },
  };
  f.worker.request = (method, params) => {
    if (method !== 'thread/inject_items') return request(method, params);
    f.worker.calls.push({ method, params });
    return Promise.reject(Object.assign(Error('Invalid reference'), { code: -32602 }));
  };
  const rejected = f.message('A rejected shared reference');
  f.engine.enqueue(rejected, { interactive: true });
  await Promise.all([...f.engine.pendingFollowups.values()]);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.submission, 'preparing');
  assert.equal(rejected.callContext.status, 'failed');
  await assert.rejects(
    f.engine.rememberCallInput(rejected, 'call'),
    (error) => error.submission === 'not-submitted',
  );
  assert.equal(f.calls('thread/inject_items').length, 1);
  f.engine.takeover = true;
  const controlled = f.message('Still under human control');
  f.engine.enqueue(controlled, { interactive: true });
  assert.equal(controlled.status, 'paused');
  assert.equal(controlled.pauseReason, 'human-control');
  assert.equal(received.length, 0);
  assert.equal(f.calls('turn/start').length, 0);
  assert.equal(f.engine.queue.length, 0);
});

test('private typed-call context retains full role-bound quotes across visible history clear and restart despite an empty thread projection', async (t) => {
  const f = fixture(t),
    secret = 'saved-test-credential',
    request = f.worker.request;
  f.engine.credentials = { redact: (value) => String(value).replaceAll(secret, '[redacted]') };
  f.engine.call = { id: 'call', provider: 'api' };
  const quotedText = '完整引用内容😀 '.repeat(11000) + 'FULL_QUOTE_TAIL ' + secret,
    text = 'Current typed fact '.repeat(7000) + 'FULL_TYPED_TAIL ' + secret,
    reply = f.store.add({
      role: 'assistant',
      text: quotedText,
      status: 'completed',
      attachments: [{ name: 'board.png', path: '/private/not-a-reference' }],
    }),
    message = f.message(text, { replyTo: reply.id });
  await f.engine.rememberCallInput(message, 'call');
  const entry = f.store.state.callInputHistory[0];
  assert.equal(entry.text, text.replaceAll(secret, '[redacted]'));
  assert.equal(entry.quotedMessage.role, 'assistant');
  assert.equal(entry.quotedMessage.text, quotedText.replaceAll(secret, '[redacted]'));
  assert.deepEqual(entry.quotedMessage.attachments, ['board.png']);
  assert.equal(JSON.stringify(entry).includes(secret), false);
  assert.equal(JSON.stringify(entry).includes('/private/'), false);
  f.engine.call = null;
  new ConversationHistory({ store: f.store, engine: f.engine }).clear({ confirm: true });
  assert.equal(f.store.state.messages.length, 0);
  assert.equal(f.store.state.callInputHistory.length, 1);
  const restored = new Store(f.dir),
    restarted = new Engine(restored, f.worker);
  f.worker.request = (method, params) => {
    if (method === 'thread/read') {
      f.worker.calls.push({ method, params });
      return Promise.resolve({ thread: { id: 'shared-thread', turns: [] } });
    }
    return request(method, params);
  };
  const context = await restarted.conversationContext();
  assert.match(context, /FULL_TYPED_TAIL/);
  assert.match(context, /FULL_QUOTE_TAIL/);
  assert.match(context, /"source":"call-text"/);
  assert.match(context, /"role":"assistant"/);
  assert.match(context, /not new requests/);
  assert.equal(context.includes(secret), false);
  assert.equal(f.calls('thread/inject_items').length, 1);
  assert.equal(f.calls('turn/start').length, 0);
});

test('a crash during a canonical call reference restores an unknown private record without replaying it', async (t) => {
  const f = fixture(t);
  f.engine.call = { id: 'call', provider: 'api' };
  const message = f.message('Pending typed fact');
  f.engine.saveCallInputReference(message, 'call', 'pending');
  f.store.update(message.id, { callContext: { callId: 'call', status: 'pending' } });
  const restored = new Store(f.dir),
    restarted = new Engine(restored, f.worker);
  restarted.call = { id: 'call', provider: 'api' };
  assert.equal(restored.state.callInputHistory[0].submission, 'unknown');
  await assert.rejects(
    restarted.rememberCallInput(restored.state.messages[0], 'call'),
    (error) => error.unknownOutcome,
  );
  assert.equal(f.calls('thread/inject_items').length, 0);
  assert.equal(f.calls('turn/start').length, 0);
});

test('a native canonical-reference acknowledgement pending after hangup protects history and new calls until it settles', async (t) => {
  const f = fixture(t),
    ack = deferred(),
    request = f.worker.request;
  f.engine.call = { id: 'native-call', provider: 'subscription' };
  f.worker.request = (method, params) =>
    method === 'thread/inject_items'
      ? (f.worker.calls.push({ method, params }), ack.promise)
      : request(method, params);
  const message = f.message('A typed fact from the ended call'),
    pending = f.engine.rememberCallInput(message, 'native-call');
  await tick();
  assert.equal(f.engine.callReferences.size, 1);
  assert.equal(f.engine.pendingFollowups.size, 0);
  f.engine.call = null;
  const history = new ConversationHistory({ store: f.store, engine: f.engine });
  for (const change of [
    () => history.edit(message.id, { text: 'Changed' }),
    () => history.remove(message.id),
    () => history.clear({ confirm: true }),
  ])
    assert.throws(change, (error) => error.status === 409);
  await assert.rejects(
    f.engine.startCall('unused', { provider: 'api' }),
    /pending message delivery/,
  );
  assert.equal(f.calls('turn/start').length, 0);
  ack.resolve({});
  await pending;
  assert.equal(f.engine.callReferences.size, 0);
  assert.equal(history.edit(message.id, { text: 'Safe after delivery' }).edited, true);
  assert.equal(f.calls('thread/inject_items').length, 1);
});
