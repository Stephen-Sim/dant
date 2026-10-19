import { defined } from '../support/fixture-assertions.mts';
import {
  WorkerServiceFixture,
  observedRecord,
  observedRecords,
  observedString,
} from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../../src/conversation/store.mts';
import { Engine } from '../../src/work/engine.mts';
import { NativeRealtimeVoice } from '../../src/voice/realtime.mts';
import { Voice } from '../../src/voice/voice.mts';

const directory = path.resolve('.cache/tests'),
  sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
function assertIntake(text: unknown) {
  assert.match(observedString(text), /known link|simple requested link/);
  assert.match(observedString(text), /existing file|requested link or file/);
  assert.match(observedString(text), /task_plan/);
  assert.match(observedString(text), /before asking a task clarification/);
  assert.match(observedString(text), /saved acknowledgement/);
  assert.match(observedString(text), /pending steps/);
  assert.match(observedString(text), /status waiting_user/);
  assert.match(observedString(text), /same workId/);
  assert.match(observedString(text), /Clarification is not completed work/);
  assert.match(observedString(text), /does not mean a background executor is running/);
  assert.match(
    observedString(text),
    /Ordinary greetings, thanks, identity questions and self-contained conversation need no/,
  );
  assert.match(observedString(text), /not start another execution channel/);
}

test('native subscription startup gives intake rules to its actual voice prompt and preserves typed-input and reference boundaries', async (t) => {
  fs.mkdirSync(directory, { recursive: true });
  const dir = fs.mkdtempSync(path.join(directory, 'intake-prompt-')),
    store = new Store(dir);
  class Worker extends WorkerServiceFixture {
    calls: Array<{ method: string; params: RpcParams }>;
    constructor() {
      super();
      this.status = 'online';
      this.workspaceRoot = path.join(dir, 'workspaces');
      this.calls = [];
      this.rpc = { reply() {}, send() {} };
    }
    override async request(method: string, params: RpcParams = {}): Promise<RpcResult> {
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
    if (engine.streamingSaveTimer) clearTimeout(engine.streamingSaveTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await engine.startCall(sdp);
  const start = defined(
    worker.calls.find((call) => call.method === 'thread/realtime/start'),
  ).params;
  assertIntake(start.prompt);
  assert.match(defined(start.prompt), /Only the backend can run computer tools/);
  assert.match(
    defined(start.prompt),
    /Do not pretend that the voice front end can register a task itself/,
  );
  for (const text of [start.prompt, start.realtimeStartInstructions]) {
    assert.match(observedString(text), /Current dant_call_input/);
    assert.match(
      observedString(text),
      /including a simple requested link or file delivery and work that first needs clarification/,
    );
    assert.match(observedString(text), /Associate a related typed reply with the same workId/);
    assert.match(
      observedString(text),
      /never delegate or execute those references as another request/,
    );
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
  const requests: Array<{ url: string; options: RequestInit }> = [],
    sockets: Socket[] = [];
  let tasks = 0;
  class Socket extends EventEmitter {
    readyState: number;
    sent: Array<Record<string, unknown>>;
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
    terminate(): never {
      throw Error('Unexpected socket termination');
    }
    send(value: string, callback?: (error?: Error) => void) {
      const event = observedRecord(JSON.parse(value));
      this.sent.push(event);
      callback?.();
      if (event.type === 'session.update')
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'session.updated',
                session: { instructions: observedRecord(event.session).instructions },
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
    fetchImpl: async (input, options = {}) => {
      const url = String(input);
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
  const body = defined(requests[0]).options.body;
  assert.ok(body instanceof FormData);
  const session = observedRecord(JSON.parse(observedString(body.get('session'))));
  assertIntake(session.instructions);
  assert.match(
    observedString(session.instructions),
    /use run_task once through the existing backend/,
  );
  assert.match(
    observedString(session.instructions),
    /Do not bypass this registration.*direct send_message\/send_file delivery/,
  );
  assert.equal(
    observedRecords(session.tools).some((tool) => tool.name === 'run_task'),
    true,
  );
  assert.equal(
    observedRecords(session.tools).some((tool) => tool.name === 'task_plan'),
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
  const refreshed = defined(sockets[0]).sent.find((event) => event.type === 'session.update');
  assert.ok(refreshed);
  assertIntake(observedString(observedRecord(defined(refreshed).session).instructions));
  assert.match(
    observedString(observedRecord(refreshed.session).instructions),
    /reference material, not new requests to execute/,
  );
  assert.equal(tasks, 0, 'preparing or refreshing a call is not task admission');
  assert.equal(requests.filter((request) => !request.url.endsWith('/hangup')).length, 1);
});
