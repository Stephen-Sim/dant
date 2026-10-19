import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createWorkerApp } from '../src/app/server.mjs';
import { Voice } from '../src/voice/voice.mjs';
import { DANT_IDENTITY_INSTRUCTIONS } from '../src/conversation/identity.mjs';
import { buildCallContext } from '../src/voice/call-context.mjs';

const base = path.resolve('.cache/tests'),
  sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
fs.mkdirSync(base, { recursive: true });
class Worker extends EventEmitter {
  constructor() {
    super();
    this.status = 'online';
    this.calls = [];
    this.rpc = { reply() {}, send() {} };
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'identity-thread' } };
    if (method === 'thread/read') {
      assert.equal(params.threadId, 'identity-thread');
      assert.equal(params.includeTurns, true);
      return {
        thread: {
          id: 'identity-thread',
          turns: this.store.state.messages
            .filter((message) => ['user', 'assistant'].includes(message.role))
            .map((message) => ({
              id: 'turn-' + message.id,
              startedAt: message.time / 1000,
              items: [
                message.role === 'user'
                  ? {
                      id: message.id,
                      type: 'userMessage',
                      content: [{ type: 'text', text: message.text }],
                    }
                  : { id: message.id, type: 'agentMessage', text: message.text },
              ],
            })),
        },
      };
    }
    throw Error('Unexpected simulated worker method: ' + method);
  }
  disconnect() {
    this.status = 'offline';
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(base, 'voice-identity-')),
    worker = new Worker(),
    requests = [],
    sockets = [];
  let voiceContext;
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }
    send(value, callback) {
      const event = JSON.parse(value);
      this.sent.push(event);
      callback?.();
      if (event.type === 'session.update')
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'session.updated',
                session: { instructions: event.session.instructions },
              }),
            ),
          ),
        );
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }
  }
  const instance = createWorkerApp({
    dataDir: dir,
    workerFactory: (store) => {
      worker.store = store;
      return worker;
    },
    voiceFactory: (options) => {
      voiceContext = options.context;
      return new Voice({
        ...options,
        getKey: () => 'sk-synthetic-identity-test-only',
        WebSocketImpl: Socket,
        fetchImpl: async (url, request) => {
          requests.push({ url, request });
          assert.ok(url.startsWith('https://api.openai.com/v1/realtime/calls'));
          return url.endsWith('/hangup')
            ? new Response(null, { status: 204 })
            : new Response(sdp, {
                status: 201,
                headers: { Location: '/v1/realtime/calls/rtc_identity' },
              });
        },
        connectTimeoutMs: 1000,
        hangupTimeoutMs: 1000,
      });
    },
  });
  t.after(async () => {
    await instance.close();
    assert.ok(path.resolve(dir).startsWith(base + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const human = instance.store.add({
      role: 'user',
      text: 'Who are you? 你是谁？',
      status: 'completed',
    }),
    assistant = instance.store.add({
      role: 'assistant',
      text: 'I am dant. 我是 dant。',
      status: 'completed',
      reactions: ['👍'],
    });
  return { instance, worker, requests, sockets, human, assistant, context: voiceContext };
}
function referenceData(text) {
  const match = text.match(/<dant_live_reference>\n([^]*?)\n<\/dant_live_reference>/);
  assert.ok(match, 'Actual live call reference should retain its data envelope');
  return JSON.parse(match[1]);
}

test('the actual text thread and optional voice session share an explicit assistant identity distinct from the human', async (t) => {
  const f = await fixture(t);
  await f.instance.engine.thread();
  const text = f.worker.calls.find((call) => call.method === 'thread/start').params
    .developerInstructions;
  assert.ok(text.startsWith(DANT_IDENTITY_INSTRUCTIONS));
  assert.match(text, /AI digital companion/);
  assert.match(text, /consistent personality/);
  assert.match(text, /Continue accepted work until you have a verified result/);
  assert.match(text, /name dant identifies YOU, the assistant/);
  assert.match(text, /The user is the human/);
  assert.match(text, /我是 dant，你的数字伙伴/);
  await f.instance.engine.startCall(sdp, { provider: 'api' });
  const session = JSON.parse(
    f.requests.find((request) => !request.url.endsWith('/hangup')).request.body.get('session'),
  );
  assert.ok(session.instructions.startsWith(DANT_IDENTITY_INSTRUCTIONS));
  assert.equal(session.output_modalities[0], 'audio');
  assert.ok(session.instructions.includes('"role":"user","text":"Who are you? 你是谁？"'));
  assert.ok(session.instructions.includes('"role":"assistant","text":"I am dant. 我是 dant。"'));
  assert.equal(
    f.worker.calls.filter((call) => call.method === 'turn/start').length,
    0,
    'Preparing identity must never start a computer task',
  );
});

test('actual API voice context refresh preserves identity and the assistant target of human feedback', async (t) => {
  const f = await fixture(t);
  await f.instance.engine.startCall(sdp, { provider: 'api' });
  const callId = f.instance.engine.call.id;
  const result = await f.instance.voice.syncContext({
    kind: 'reaction',
    message: f.assistant,
    callId,
  });
  assert.equal(result.status, 'submitted');
  const sent = f.sockets[0].sent.find((event) => event.type === 'session.update');
  assert.ok(sent);
  assert.ok(sent.session.instructions.startsWith(DANT_IDENTITY_INSTRUCTIONS));
  const data = referenceData(sent.session.instructions);
  assert.equal(data.role, 'assistant');
  assert.equal(data.messageId, f.assistant.id);
  assert.equal(data.text, f.assistant.text);
  assert.deepEqual(data.reactions, ['👍']);
  assert.match(
    sent.session.instructions,
    /In saved chat reference objects, role assistant identifies your previous messages and role user identifies human chat input/,
  );
  assert.match(
    sent.session.instructions,
    /Transport messages explicitly marked as task or tool results are your work results, not a new human speaker/,
  );
  assert.equal(
    f.instance.store.state.messages.find((message) => message.id === f.assistant.id).role,
    'assistant',
  );
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 0);
});

test('server startup references and live call messages preserve authoritative human and assistant roles', async (t) => {
  const f = await fixture(t),
    startup = await f.context(),
    messages = startup
      .split('\n')
      .filter((line) => line.startsWith('{"messageId"'))
      .map((line) => JSON.parse(line));
  assert.deepEqual(
    messages.map((message) => [message.messageId, message.role]),
    [
      [f.human.id, 'user'],
      [f.assistant.id, 'assistant'],
    ],
  );
  for (const message of [f.human, f.assistant]) {
    const data = referenceData(buildCallContext('message', message));
    assert.equal(data.role, message.role);
    assert.equal(data.messageId, message.id);
    assert.equal(data.text, message.text);
  }
  assert.equal(f.human.role, 'user');
  assert.equal(f.assistant.role, 'assistant');
  assert.equal(f.worker.calls.length, 0);
});

test('API startup includes the full saved conversation and each message tail without app context clipping', async (t) => {
  const f = await fixture(t),
    longText = '完整上下文'.repeat(21000) + 'MESSAGE_TAIL',
    long = f.instance.store.add({ role: 'user', text: longText, status: 'completed' });
  for (let index = 0; index < 20; index++)
    f.instance.store.add({
      role: index % 2 ? 'assistant' : 'user',
      text: 'Saved message ' + index,
      status: 'completed',
    });
  const startup = await f.context(),
    references = startup
      .split('\n')
      .filter((line) => line.startsWith('{"messageId"'))
      .map((line) => JSON.parse(line));
  assert.equal(references.length, 23);
  assert.equal(references[0].messageId, f.human.id);
  assert.equal(references.find((message) => message.messageId === long.id).text, longText);
  await f.instance.engine.startCall(sdp, { provider: 'api' });
  const session = JSON.parse(f.requests[0].request.body.get('session'));
  assert.ok(session.instructions.includes(longText));
  assert.ok(session.instructions.includes('Saved message 19'));
  const shared = JSON.parse(
    session.instructions
      .split('<dant_conversation_context>\n')[1]
      .split('\n</dant_conversation_context>')[0],
  );
  assert.equal(shared.threadId, 'identity-thread');
  assert.equal(shared.entries.length, 23);
  assert.deepEqual(
    shared.entries.slice(0, 2).map((item) => [item.itemId, item.role]),
    [
      [f.human.id, 'user'],
      [f.assistant.id, 'assistant'],
    ],
  );
  assert.equal(shared.entries.find((item) => item.itemId === long.id).text, longText);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 0);
});
