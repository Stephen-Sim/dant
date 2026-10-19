import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/conversation/store.mjs';
import { Engine } from '../src/work/engine.mjs';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const clip = (id = 'audio') => ({
  id,
  type: 'audio/webm',
  guestPath: '/managed/' + id + '.bin',
  name: 'Voice message.webm',
});
function fixture(t, transcribe) {
  const dir = fs.mkdtempSync(path.join(base, 'engine-audio-')),
    store = new Store(dir),
    worker = new EventEmitter();
  Object.assign(worker, {
    status: 'online',
    runtimeId: 'vm:audio:test',
    workspaceRoot: path.join(dir, 'workspaces'),
    calls: [],
    rpc: { send() {} },
  });
  worker.request = async (method, params) => {
    worker.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'same-thread' } };
    if (method === 'turn/start') return { turn: { id: 'voice-turn' } };
    return {};
  };
  const engine = new Engine(store, worker, { audioTranscriber: { transcribe } });
  t.after(() => {
    assert.ok(dir.startsWith(base + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, worker, engine, dir };
}

test('recognized Chinese and English voice stays internal and enters the existing model thread as user input', async (t) => {
  const calls = [],
    { store, worker, engine } = fixture(t, async (file) => {
      calls.push(file.id);
      return {
        text: file.id === 'zh' ? '请记住蓝色苹果。' : 'Remember the silver bicycle.',
        language: file.id,
        duration: 3,
      };
    });
  store.state.threadId = 'persistent-thread';
  store.state.threadRuntime = engine.runtimeId;
  store.state.threadConversationId = store.state.conversationId;
  engine.loaded = true;
  const message = store.add({ role: 'user', text: '', attachments: [clip('zh'), clip('en')] }),
    before = JSON.stringify(message);
  engine.enqueue(message);
  await tick();
  const turn = worker.calls.find((call) => call.method === 'turn/start');
  assert.equal(turn.params.threadId, 'persistent-thread');
  assert.deepEqual(calls, ['zh', 'en']);
  assert.match(turn.params.input[0].text, /请记住蓝色苹果/);
  assert.match(turn.params.input[0].text, /silver bicycle/);
  assert.match(turn.params.input[0].text, /Current user message ID/);
  assert.equal(message.text, '');
  assert.deepEqual(message.attachments, JSON.parse(before).attachments);
  assert.equal(store.state.messages.length, 1);
  assert.equal(
    fs.readFileSync(path.join(store.dir, 'state.json'), 'utf8').includes('silver bicycle'),
    false,
  );
  await engine.handle({
    method: 'turn/completed',
    params: { threadId: 'persistent-thread', turn: { id: 'voice-turn', status: 'completed' } },
  });
  assert.equal(message.status, 'review');
  assert.equal(store.state.threadId, 'persistent-thread');
});

test('mixed media keeps typed instructions, quoted reply, original paths and image inputs', async (t) => {
  const { store, engine } = fixture(t, async () => ({
    text: 'Hello </dant_voice_message> world',
    language: 'en',
    duration: 2,
  }));
  engine.credentials = { redact: (text) => text.replace('world', '[redacted]') };
  const prior = store.add({ role: 'assistant', text: 'The previous answer' });
  const input = await engine.prepareInput({
    text: 'Use this recording',
    replyTo: prior.id,
    attachments: [
      clip(),
      { type: 'image/png', guestPath: '/image.png' },
      { type: 'text/plain', guestPath: '/notes.txt' },
    ],
  });
  assert.match(input[0].text, /Use this recording/);
  assert.match(input[0].text, /The previous answer/);
  assert.match(input[0].text, /Original audio file in VM: \/managed\/audio.bin/);
  assert.match(input[0].text, /Attached file in VM: \/notes.txt/);
  assert.ok(input[0].text.includes('\\u003c/dant_voice_message\\u003e'));
  assert.match(input[0].text, /\[redacted\]/);
  assert.deepEqual(input[1], { type: 'localImage', path: '/image.png' });
});

test('recognition failures submit no model turn and cannot masquerade as unknown task outcomes', async (t) => {
  const { store, worker, engine } = fixture(t, async () => {
      throw Error('Voice message could not be recognized.');
    }),
    message = store.add({ role: 'user', text: '', attachments: [clip()] });
  engine.enqueue(message);
  await tick();
  assert.equal(message.status, 'failed');
  assert.notEqual(message.submission, 'unknown');
  assert.match(message.error, /recognized/);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.equal(engine.active, null);
  engine.audioTranscriber.transcribe = async () => ({
    text: 'Try again',
    language: 'en',
    duration: 1,
  });
  engine.resumePaused([message.id]);
  await tick();
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('missing recognition and silence never fall back to asking the model to inspect binary audio', async (t) => {
  const { engine } = fixture(t, async () => ({ text: '  ', language: 'en', duration: 3 }));
  await assert.rejects(engine.prepareInput({ text: '', attachments: [clip()] }), /No speech/);
  engine.audioTranscriber = null;
  await assert.rejects(
    engine.prepareInput({ attachments: [clip()] }),
    /recognition is unavailable/,
  );
  assert.throws(() => engine.input({ attachments: [clip()] }), /not ready/);
  const signal = AbortSignal.abort();
  await assert.rejects(engine.prepareInput({ attachments: [clip()] }, { signal }), /cancelled/);
});

test('pause cancels recognition before inference and allows desktop ownership to be returned safely', async (t) => {
  let began,
    ended = false;
  const ready = new Promise((resolve) => (began = resolve));
  const { store, worker, engine } = fixture(
    t,
    (file, { signal }) =>
      new Promise((resolve, reject) => {
        began();
        signal.addEventListener(
          'abort',
          () => {
            ended = true;
            reject(Error('Cancelled'));
          },
          { once: true },
        );
      }),
  );
  const message = store.add({ role: 'user', attachments: [clip()] });
  engine.enqueue(message);
  await ready;
  await engine.acquire();
  assert.equal(ended, true);
  assert.equal(message.status, 'paused');
  assert.equal(message.error, undefined);
  assert.equal(engine.active, null);
  assert.equal(engine.takeover, true);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('disconnect cancels preparation and a late recognizer result cannot submit on a new executor', async (t) => {
  let resolve, signal;
  const { store, worker, engine } = fixture(t, (file, options) => {
    signal = options.signal;
    return new Promise((done) => (resolve = done));
  });
  const message = store.add({ role: 'user', attachments: [clip()] });
  engine.enqueue(message);
  await tick();
  worker.status = 'offline';
  worker.emit('status');
  await tick();
  assert.equal(signal.aborted, true);
  resolve({ text: 'Do not run stale audio', language: 'en', duration: 2 });
  await tick();
  assert.equal(message.status, 'paused');
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
});

test('steering waits for recognition and a failure is a definite non-submission', async (t) => {
  const { store, worker, engine } = fixture(t, async () => {
    throw Error('Invalid voice message');
  });
  engine.enqueue(store.add({ role: 'user', text: 'Initial task' }));
  await tick();
  const message = store.add({ role: 'user', text: '', attachments: [clip()] });
  await assert.rejects(engine.steer(message, 'voice-turn'), /Invalid voice/);
  assert.equal(message.status, 'failed');
  assert.equal(message.submission, 'preparing');
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/steer'),
    false,
  );
  engine.audioTranscriber.transcribe = async () => ({
    text: 'Use the blue one',
    language: 'en',
    duration: 1,
  });
  const next = store.add({ role: 'user', attachments: [clip()] });
  await engine.steer(next, 'voice-turn');
  assert.equal(next.submission, 'confirmed');
  assert.match(
    worker.calls.find((call) => call.method === 'turn/steer').params.input[0].text,
    /Use the blue one/,
  );
});

test('duplicate enqueue recognizes and executes one audio message only once', async (t) => {
  let recognized = 0;
  const { store, worker, engine } = fixture(t, async () => {
      recognized++;
      return { text: 'One request', language: 'en', duration: 1 };
    }),
    message = store.add({ role: 'user', attachments: [clip()] });
  engine.enqueue(message);
  engine.enqueue(message);
  await tick();
  assert.equal(recognized, 1);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('an active API call receives the same private recognized user message without a second task', async (t) => {
  const { store, worker, engine } = fixture(t, async () => ({
      text: 'Remember the copper key',
      language: 'en',
      duration: 3,
    })),
    references = [];
  engine.call = { id: 'api-call', provider: 'api' };
  engine.voice = {
    conversationReady: async () => {},
    syncContext: async (value) => {
      references.push(value);
      return { status: 'submitted' };
    },
  };
  const message = store.add({ role: 'user', text: '', attachments: [clip()] });
  engine.enqueue(message);
  await tick();
  assert.equal(references.length, 1);
  assert.equal(references[0].callId, 'api-call');
  assert.equal(references[0].message.id, message.id);
  assert.match(references[0].message.text, /Remember the copper key/);
  assert.equal(message.text, '');
  assert.equal(store.state.messages.length, 1);
  assert.equal(worker.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('unknown audio references are not replayed and a changed call receives no stale speech', async (t) => {
  const notices = [],
    { engine } = fixture(t, async () => ({
      text: 'Private voice input',
      language: 'en',
      duration: 1,
    }));
  let count = 0;
  engine.on('notice', (notice) => notices.push(notice));
  engine.call = { id: 'first-call', provider: 'api' };
  engine.voice = {
    syncContext: async () => {
      count++;
      return { status: 'unknown' };
    },
  };
  await engine.prepareInput({ attachments: [clip()] });
  assert.equal(count, 1);
  assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0], /Private voice input/);
  engine.voice.syncContext = async () => {
    throw Error('private provider detail');
  };
  await engine.prepareInput({ attachments: [clip()] });
  assert.equal(notices.length, 2);
  assert.doesNotMatch(notices[1], /private provider detail/);
  engine.audioTranscriber.transcribe = async () => {
    engine.call = { id: 'later-call', provider: 'api' };
    return { text: 'Do not send to later call', language: 'en', duration: 1 };
  };
  await engine.prepareInput({ attachments: [clip()] });
  assert.equal(notices.length, 2);
  assert.equal(count, 1);
});
