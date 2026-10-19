import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/conversation/store.mjs';
import { Engine } from '../src/work/engine.mjs';
import { NativeRealtimeVoice } from '../src/voice/realtime.mjs';
import { Voice } from '../src/voice/voice.mjs';

const directory = path.resolve('.cache/tests'),
  sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
function assertIntake(text) {
  assert.match(text, /known link|simple requested link/);
  assert.match(text, /existing file|requested link or file/);
  assert.match(text, /task_plan/);
  assert.match(text, /before asking a task clarification/);
  assert.match(text, /saved acknowledgement/);
  assert.match(text, /pending steps/);
  assert.match(text, /status waiting_user/);
  assert.match(text, /same workId/);
  assert.match(text, /Clarification is not completed work/);
  assert.match(text, /does not mean a background executor is running/);
  assert.match(
    text,
    /Ordinary greetings, thanks, identity questions and self-contained conversation need no/,
  );
  assert.match(text, /not start another execution channel/);
}

test('native subscription startup gives intake rules to its actual voice prompt and preserves typed-input and reference boundaries', async (t) => {
  fs.mkdirSync(directory, { recursive: true });
  const dir = fs.mkdtempSync(path.join(directory, 'intake-prompt-')),
    store = new Store(dir);
  class Worker extends EventEmitter {
    constructor() {
      super();
      this.status = 'online';
      this.workspaceRoot = path.join(dir, 'workspaces');
      this.calls = [];
      this.rpc = { reply() {}, send() {} };
    }
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'intake-thread' } };
      if (method === 'thread/realtime/start')
        queueMicrotask(() => {
          this.emit('event', {
            method: 'thread/realtime/started',
            params: {
              threadId: 'intake-thread',
              version: 'v3',
              realtimeSessionId: 'intake-realtime',
            },
          });
          this.emit('event', {
            method: 'thread/realtime/sdp',
            params: { threadId: 'intake-thread', sdp },
          });
        });
      if (method === 'thread/realtime/stop')
        queueMicrotask(() =>
          this.emit('event', {
            method: 'thread/realtime/closed',
            params: { threadId: 'intake-thread' },
          }),
        );
      if (method === 'thread/read')
        return { thread: { id: 'intake-thread', status: { type: 'idle' }, turns: [] } };
      return {};
    }
  }
  const worker = new Worker(),
    engine = new Engine(store, worker);
  new NativeRealtimeVoice({ worker, engine, connectTimeoutMs: 2000, stopTimeoutMs: 2000 });
  t.after(async () => {
    if (engine.call) await engine.stopCall(engine.call.id);
    engine.pauseQueue();
    clearTimeout(engine.streamingSaveTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await engine.startCall(sdp);
  const start = worker.calls.find((call) => call.method === 'thread/realtime/start').params;
  assertIntake(start.prompt);
  assert.match(start.prompt, /Only the backend can run computer tools/);
  assert.match(start.prompt, /Do not pretend that the voice front end can register a task itself/);
  for (const text of [start.prompt, start.realtimeStartInstructions]) {
    assert.match(text, /Current dant_call_input/);
    assert.match(
      text,
      /including a simple requested link or file delivery and work that first needs clarification/,
    );
    assert.match(text, /Associate a related typed reply with the same workId/);
    assert.match(text, /never delegate or execute those references as another request/);
  }
  assert.equal(start.clientManagedHandoffs, false);
  assert.equal(
    worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.equal(
    store.state.workTasks.length,
    0,
    'starting a conversational call cannot itself register work',
  );
});

test('API voice creation and context refresh retain backend-first intake without exposing a fictitious frontend task_plan tool', async (t) => {
  const requests = [],
    sockets = [];
  let tasks = 0;
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
  const voice = new Voice({
    getKey: () => 'sk-synthetic-prompt-test',
    runTask: async () => {
      tasks++;
      return {};
    },
    tool: async () => ({}),
    context: () => 'Saved reference only',
    WebSocketImpl: Socket,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return url.endsWith('/hangup')
        ? new Response(null, { status: 204 })
        : new Response(sdp, {
            status: 201,
            headers: { Location: '/v1/realtime/calls/rtc_intake' },
          });
    },
    connectTimeoutMs: 2000,
    hangupTimeoutMs: 1000,
  });
  t.after(() => voice.close());
  await voice.start({ sdp, callId: 'intake-api-call' });
  const session = JSON.parse(requests[0].options.body.get('session'));
  assertIntake(session.instructions);
  assert.match(session.instructions, /use run_task once through the existing backend/);
  assert.match(
    session.instructions,
    /Do not bypass this registration.*direct send_message\/send_file delivery/,
  );
  assert.equal(
    session.tools.some((tool) => tool.name === 'run_task'),
    true,
  );
  assert.equal(
    session.tools.some((tool) => tool.name === 'task_plan'),
    false,
  );
  await voice.syncContext({
    kind: 'message',
    callId: 'intake-api-call',
    message: {
      id: 'reference-message',
      role: 'assistant',
      text: 'Earlier reference, not a new task',
    },
  });
  const refreshed = sockets[0].sent.find((event) => event.type === 'session.update');
  assert.ok(refreshed);
  assertIntake(refreshed.session.instructions);
  assert.match(refreshed.session.instructions, /reference material, not new requests to execute/);
  assert.equal(tasks, 0, 'preparing or refreshing a call is not task admission');
  assert.equal(requests.filter((request) => !request.url.endsWith('/hangup')).length, 1);
});
