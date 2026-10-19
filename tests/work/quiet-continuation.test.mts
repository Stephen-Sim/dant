import { observedString } from '../support/service-fixtures.mts';
import { CredentialFixture } from '../support/engine-service-fixtures.mts';
import type { WorkerPublic } from '../../src/runtime/worker-types.ts';
import {
  WorkerServiceFixture,
  activeTaskFixture,
  listeningPort,
  observedRecord,
} from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/conversation/store.mts';
import { Engine, dynamicTools } from '../../src/work/engine.mts';
import { AttachmentStore } from '../../src/files/attachments.mts';
import { DeliverableCollector } from '../../src/files/deliverables.mts';
import { WorkContinuationSupervisor } from '../../src/work/work-continuation.mts';
import { TelegramGateway } from '../../src/telegram/telegram.mts';
import { createWorkerApp } from '../../src/app/server.mts';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=',
  'base64',
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plan = (): import('../../src/contracts/contracts.ts').TaskPlan['steps'] => [
  { step: 'Execute the remaining experiment', status: 'inProgress' },
  { step: 'Verify the requested result', status: 'pending' },
];
class Worker extends WorkerServiceFixture {
  declare calls: Array<{ method: string; params: RpcParams | undefined }>;
  declare responses: Array<{
    id?: string | number | null | undefined;
    result?: unknown;
    method?: string | undefined;
    params?: RpcParams | undefined;
    error?: unknown;
  }>;
  declare replies: unknown[];
  declare count: number;
  declare createVoiceMessage: NonNullable<WorkerPublic['createVoiceMessage']>;
  declare nextTurn: number;
  declare autoInterrupt: boolean;
  declare terminated: number;
  declare engine: Engine;
  constructor(dir: string) {
    super();
    this.status = 'online';
    this.workspaceRoot = path.join(dir, 'workspaces');
    this.calls = [];
    this.replies = [];
    this.count = 0;
    this.rpc = {
      reply: (...args) => this.replies.push(args),
      send: (event) => this.replies.push(event),
    };
  }
  async request(method: string, params?: RpcParams): Promise<RpcResult> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'thread/read')
      return {
        thread: {
          id: 'thread',
          status: { type: 'idle' },
          turns: this.engine.store.state.workTasks.map((record) => ({
            id: record.turnId,
            status: 'completed',
          })),
        },
      };
    if (method === 'turn/start') return { turn: { id: 'auto-' + ++this.count } };
    return {};
  }
  disconnect() {
    this.status = 'offline';
  }
}
function fixture(
  t: NodeTestContext,
  { credentials }: Pick<NonNullable<ConstructorParameters<typeof Engine>[2]>, 'credentials'> = {},
) {
  const dir = fs.mkdtempSync(path.join(root, 'quiet-continuation-')),
    store = new Store(dir),
    worker = new Worker(dir),
    attachments = new AttachmentStore(path.join(dir, 'attachments')),
    archiveCollector = new DeliverableCollector(attachments),
    collector: import('../../src/work/engine.mts').EngineDeliverables = {
      archive: (input) => archiveCollector.archive(input),
      captureBaseline: (input) => archiveCollector.captureBaseline(input),
    },
    engine = new Engine(store, worker, {
      deliverables: collector,
      ...(credentials ? { credentials } : {}),
    });
  worker.engine = engine;
  engine.on('notice', () => {});
  store.state.settings.language = 'en';
  store.state.threadId = 'thread';
  store.state.threadRuntime = engine.runtimeId;
  store.state.threadConversationId = store.state.conversationId;
  engine.loaded = true;
  fs.mkdirSync(engine.outputDir, { recursive: true });
  const message = store.add({
      role: 'user',
      text: 'Run the experiment and verify its result',
      turnId: 'original',
      status: 'review',
      submission: 'confirmed',
      workKind: 'task',
    }),
    record = store.registerWork({
      turnId: 'original',
      messageId: message.id,
      title: 'Verify the real experiment',
      source: 'chat',
      plan: { steps: plan() },
    });
  store.updateRegisteredWork('original', {
    status: 'continuing',
    executionEnded: true,
    at: Date.now() - 10000,
  });
  const supervisor = new WorkContinuationSupervisor({ engine }),
    deltas: unknown[] = [];
  engine.on('delta', (event) => deltas.push(event));
  t.after(() => {
    engine.continuationStopped = true;
    clearTimeout(engine.streamingSaveTimer ?? undefined);
    assert.equal(path.dirname(dir), root);
    assert.ok(path.basename(dir).startsWith('quiet-continuation-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    store,
    worker,
    engine,
    attachments,
    collector,
    message,
    record,
    supervisor,
    deltas,
  };
}
function event(f: ReturnType<typeof fixture>, method: string, params: RpcParams = {}) {
  return {
    method,
    params: { threadId: 'thread', turnId: defined(f.engine.active).turnId, ...params },
  };
}
const emit = (f: ReturnType<typeof fixture>, method: string, params: RpcParams = {}) =>
  f.engine.handle(event(f, method, params));
const finish = (f: ReturnType<typeof fixture>, status = 'completed', error?: string) =>
  emit(f, 'turn/completed', {
    turn: {
      id: defined(defined(f.engine.active).turnId),
      status,
      ...(error ? { error: { message: error } } : {}),
    },
  });
async function start(f: ReturnType<typeof fixture>) {
  const saved = f.store.state.workTasks.find((record) => record.id === f.record.id);
  if (defined(saved).continuation) defined(defined(saved).continuation).nextAt = Date.now() - 1;
  return f.supervisor.tick();
}
const savePlan = (f: ReturnType<typeof fixture>, steps = plan(), status?: string) =>
  f.engine.tool('task_plan', {
    workId: f.record.id,
    title: f.record.title,
    steps,
    ...(status ? { status } : {}),
  });
async function agent(
  f: ReturnType<typeof fixture>,
  text: string,
  id = 'narration',
  phase = 'commentary',
) {
  await emit(f, 'item/agentMessage/delta', { itemId: id, delta: text });
  await emit(f, 'item/completed', { item: { id, type: 'agentMessage', text, phase } });
}
const assistants = (f: ReturnType<typeof fixture>) =>
  f.store.state.messages.filter((message) => message.role === 'assistant');
const unread = (f: ReturnType<typeof fixture>) =>
  f.store.state.completions.filter((item) => !item.readAt).length;
async function telegram(t: NodeTestContext, f: ReturnType<typeof fixture>) {
  const calls: Array<{ method: string | undefined; body: RequestInit['body'] }> = [],
    fetchImpl = async (url: string | URL | Request, options: RequestInit = {}) => {
      const method = new URL(typeof url === 'string' || url instanceof URL ? url : url.url).pathname
        .split('/')
        .at(-1);
      calls.push({ method, body: options.body });
      return new Response(
        JSON.stringify({
          ok: true,
          result:
            method === 'getMe'
              ? { id: 123456, is_bot: true, username: 'quiet_test_bot' }
              : method === 'getWebhookInfo'
                ? { url: '' }
                : { message_id: calls.length },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    };
  const gateway = new TelegramGateway({
    dataDir: f.dir,
    store: f.store,
    engine: f.engine,
    attachments: f.attachments,
    fetchImpl,
    autoPoll: false,
    mirrorGraceMs: 0,
  });
  t.after(() => gateway.close());
  await gateway.configure({ token: '123456:abcdefghijklmnopqrstuvwxyz_123456789', enabled: true });
  const { code } = await gateway.pair();
  await gateway.receive({
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: 11, type: 'private' },
      from: { id: 11, is_bot: false },
      text: '/start ' + code,
    },
  });
  await gateway.flush();
  calls.length = 0;
  return { gateway, calls };
}

test('two actual unfinished automatic rounds stay silent, then the same work completes once with held files', async (t) => {
  const f = fixture(t),
    tg = await telegram(t, f),
    beforeMessages = f.store.state.messages.length,
    beforeCompletions = f.store.state.completions.length,
    beforeUnread = unread(f);
  let file;
  for (let round = 1; round <= 2; round++) {
    const ack = await start(f);
    assert.equal(observedRecord(ack).workId, f.record.id);
    await savePlan(f);
    await emit(f, 'item/completed', {
      item: {
        id: 'command-' + round,
        type: 'commandExecution',
        command: 'run-experiment',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'experiment actual result ' + round,
      },
    });
    await agent(f, 'Routine experiment update ' + round, 'ordinary-' + round);
    const receipt = await f.engine.tool('send_message', {
      text: 'Routine explicit progress ' + round,
    });
    assert.equal(observedRecord(receipt).sent, false);
    assert.equal(observedRecord(receipt).quiet, true);
    assert.equal(observedRecord(receipt).buffered, true);
    const item = {
      id: 'mcp-' + round,
      type: 'mcpToolCall',
      server: 'dant_desktop',
      tool: 'send_chat_message',
      status: 'completed',
      arguments: { text: 'Routine MCP update ' + round },
      result: {
        structuredContent: {
          dantMessage: { text: 'Routine MCP update ' + round },
          sent: false,
          quiet: true,
          buffered: true,
        },
      },
    };
    await emit(f, 'item/completed', { item });
    await emit(f, 'item/completed', { item });
    if (round === 1) {
      file = path.join(f.engine.outputDir, 'verified-result.png');
      fs.writeFileSync(file, png);
      const delivery = await f.engine.tool('send_file', { path: file });
      assert.equal(observedRecord(delivery).sent, false);
      assert.equal(observedRecord(delivery).quiet, true);
      fs.unlinkSync(file);
    }
    await finish(f);
    await tg.gateway.flush();
    assert.equal(defined(f.store.state.workTasks[0]).status, 'continuing');
    assert.equal(f.store.state.messages.length, beforeMessages);
    assert.equal(f.store.state.completions.length, beforeCompletions);
    assert.equal(unread(f), beforeUnread);
    assert.deepEqual(f.deltas, []);
    assert.equal(tg.calls.filter((call) => /^send/.test(defined(call.method))).length, 0);
  }
  await start(f);
  await savePlan(
    f,
    plan().map((step) => ({ ...step, status: 'completed' })),
  );
  await f.engine.tool('send_message', {
    text: 'Verified complete: the experiment passed with its evidence.',
  });
  await agent(
    f,
    'Verified complete: the experiment passed with its evidence.',
    'final',
    'final_answer',
  );
  await finish(f);
  await tg.gateway.flush();
  assert.equal(defined(f.store.state.workTasks[0]).id, f.record.id);
  assert.equal(defined(f.store.state.workTasks[0]).status, 'review');
  assert.deepEqual(defined(f.store.state.workTasks[0]).turnIds, [
    'original',
    'auto-1',
    'auto-2',
    'auto-3',
  ]);
  assert.equal(f.store.state.messages.filter((message) => message.role === 'user').length, 1);
  assert.equal(assistants(f).length, 1);
  assert.equal(
    defined(assistants(f)[0]).text,
    'Verified complete: the experiment passed with its evidence.',
  );
  assert.equal(defined(defined(assistants(f)[0]).attachments).length, 1);
  assert.equal(defined(defined(defined(assistants(f)[0]).attachments)[0]).sourcePath, file);
  assert.deepEqual(
    f.attachments.read(defined(defined(defined(assistants(f)[0]).attachments)[0]).id).data,
    png,
  );
  assert.equal(f.store.state.completions.length, beforeCompletions + 1);
  assert.equal(unread(f), beforeUnread + 1);
  assert.equal(tg.calls.filter((call) => call.method === 'sendMessage').length, 1);
  assert.equal(tg.calls.filter((call) => call.method === 'sendPhoto').length, 1);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 3);
  assert.equal(await f.supervisor.tick(), null);
});

test('waiting_user publishes the real question once and stops automatic admission', async (t) => {
  const f = fixture(t);
  await start(f);
  await savePlan(
    f,
    [{ step: 'Ask the user for the target account', status: 'pending' }],
    'waiting_user',
  );
  const first = await f.engine.tool('send_message', {
      text: 'Which account should receive the verified result?',
    }),
    again = await f.engine.tool('send_message', {
      text: 'Which account should receive the verified result?',
    });
  assert.equal(observedRecord(first).sent, true);
  assert.equal(observedRecord(again).sent, false);
  assert.equal(observedRecord(again).alreadyNotified, true);
  await agent(f, 'Which account should receive the verified result?', 'question', 'final_answer');
  await finish(f);
  assert.equal(assistants(f).length, 1);
  assert.match(defined(defined(assistants(f)[0]).text), /Which account/);
  assert.equal(defined(f.store.state.workTasks[0]).status, 'waiting_user');
  assert.equal(f.store.state.completions.length, 1);
  assert.equal(await f.supervisor.tick(), null);
});

test('a real second secure blocker in the same executor is visible after the first answer', async (t) => {
  const requests: Array<(value: { id: string }) => void> = [],
    credentials = {
      redact: (text: unknown) => String(text),
      cancelOwner() {},
      request: () => new Promise((resolve) => requests.push(resolve)),
    },
    f = fixture(t, { credentials: Object.assign(new CredentialFixture(), credentials) });
  await start(f);
  await savePlan(f);
  for (let index = 0; index < 2; index++) {
    const pending = f.engine.tool('credential_request', {
      name: 'Account ' + index,
      service: 'https://example.test',
      reason: 'Run the accepted experiment',
    });
    assert.equal(requests.length, index + 1);
    assert.equal(assistants(f).length, index + 1);
    assert.equal(defined(f.engine.active).credentialWaits, 1);
    defined(requests[index])({ id: 'credential-' + index });
    await pending;
    assert.equal(defined(f.engine.active).credentialWaits, 0);
    assert.equal(defined(f.engine.active).quietInputDelivered, false);
  }
  await agent(f, 'Routine post-credential progress');
  await finish(f);
  assert.equal(assistants(f).length, 2);
  assert.equal(f.store.state.completions.length, 2);
  assert.equal(defined(f.store.state.workTasks[0]).status, 'continuing');
});

test('confirmed human steering gets its normal answer and allows a later real question', async (t) => {
  const f = fixture(t);
  await start(f);
  await savePlan(f);
  const file = path.join(f.engine.outputDir, 'held-before-answer.png');
  fs.writeFileSync(file, png);
  await f.engine.tool('send_file', { path: file });
  fs.unlinkSync(file);
  await finish(f);
  await start(f);
  await savePlan(
    f,
    [{ step: 'Ask the user for the target account', status: 'pending' }],
    'waiting_user',
  );
  await f.engine.tool('send_message', { text: 'Which account?' });
  const human = f.store.add({ role: 'user', text: 'Use account A' });
  await f.engine.steer(human, defined(f.engine.active).turnId);
  assert.equal(defined(f.engine.active).quietInputDelivered, false);
  assert.equal(defined(f.engine.active).quietHumanResponse, true);
  await savePlan(
    f,
    plan().map((step) => ({ ...step, status: 'completed' })),
    'running',
  );
  await agent(f, 'I used account A and verified the requested result.', 'answer', 'final_answer');
  assert.equal(assistants(f).length, 2);
  await finish(f);
  assert.equal(assistants(f).length, 2);
  assert.equal(
    defined(assistants(f)[1]).text,
    'I used account A and verified the requested result.',
  );
  assert.equal(defined(assistants(f)[0]).attachments?.length || 0, 0);
  assert.equal(defined(defined(assistants(f)[1]).attachments).length, 1);
  assert.deepEqual(
    f.attachments.read(defined(defined(defined(assistants(f)[1]).attachments)[0]).id).data,
    png,
  );
  assert.equal(defined(f.engine.continuationDeliveries).has(f.record.id), false);
});

test('automatic requestUserInput cannot deadlock in an invisible form and does not repeat at finish', async (t) => {
  const f = fixture(t);
  await start(f);
  await savePlan(f);
  await f.engine.handle({
    ...event(f, 'item/tool/requestUserInput', {
      questions: [{ id: 'test-question', question: 'Which folder should I use?' }],
    }),
    id: 42,
  });
  assert.match(defined(defined(assistants(f)[0]).text), /Which folder/);
  assert.equal(observedRecord(f.worker.replies.at(-1)).id, 42);
  assert.match(
    observedString(observedRecord(observedRecord(f.worker.replies.at(-1)).error).message),
    /existing chat/,
  );
  await agent(f, 'Which folder should I use?', 'question', 'final_answer');
  await finish(f);
  assert.equal(assistants(f).length, 1);
  assert.equal(f.store.state.completions.length, 1);
  assert.equal(defined(f.store.state.workTasks[0]).status, 'waiting_user');
});

test('a fresh final human-response image wins over an older held snapshot of the same source', async (t) => {
  const f = fixture(t);
  await start(f);
  await savePlan(f);
  const file = path.join(f.engine.outputDir, 'same-source.png');
  fs.writeFileSync(file, png);
  await f.engine.tool('send_file', { path: file });
  await finish(f);
  await start(f);
  const human = f.store.add({ role: 'user', text: 'Send the verified current image' });
  await f.engine.steer(human, defined(f.engine.active).turnId);
  await savePlan(
    f,
    plan().map((step) => ({ ...step, status: 'completed' })),
  );
  const fresh = Buffer.concat([png, Buffer.from('new verified evidence')]);
  fs.writeFileSync(file, fresh);
  const archive = f.collector.archive.bind(f.collector);
  let release!: () => void;
  f.collector.archive = (options) =>
    new Promise((resolve) => (release = () => resolve(archive(options))));
  const pending = agent(
    f,
    `Verified final evidence [image](${file})`,
    'human-final',
    'final_answer',
  );
  await tick();
  assert.equal(typeof release, 'function');
  const ending = finish(f);
  await tick();
  assert.equal(defined(assistants(f).at(-1)).attachments?.length || 0, 0);
  const resolveFresh = release;
  f.collector.archive = archive;
  resolveFresh();
  await pending;
  await ending;
  assert.equal(assistants(f).length, 1);
  assert.equal(defined(defined(assistants(f)[0]).attachments).length, 1);
  assert.deepEqual(
    f.attachments.read(defined(defined(defined(assistants(f)[0]).attachments)[0]).id).data,
    fresh,
  );
  assert.equal(defined(f.engine.continuationDeliveries).has(f.record.id), false);
});

test('automatic failure remains visible once while routine partial narration and cancellation stay quiet', async (t) => {
  for (const cancelled of [false, true] as const) {
    const f = fixture(t);
    await start(f);
    await savePlan(f);
    await agent(f, 'Routine partial screenshot progress');
    if (cancelled) defined(f.engine.active).cancelRequested = true;
    await finish(
      f,
      cancelled ? 'interrupted' : 'failed',
      cancelled ? undefined : 'Experiment process exited with code 2',
    );
    assert.equal(assistants(f).length, cancelled ? 0 : 1);
    if (!cancelled) {
      assert.match(defined(defined(assistants(f)[0]).text), /code 2/);
      assert.doesNotMatch(defined(defined(assistants(f)[0]).text), /Routine partial/);
      assert.equal(f.store.state.completions.length, 1);
    } else assert.equal(f.store.state.completions.length, 0);
  }
});

test('three empty automatic rounds pause safely and do not invent a successful result', async (t) => {
  const f = fixture(t);
  for (let round = 0; round < 3; round++) {
    await start(f);
    await savePlan(f);
    await agent(f, 'A status check alone');
    await finish(f);
  }
  assert.equal(defined(f.store.state.workTasks[0]).status, 'paused');
  assert.equal(defined(f.store.state.workTasks[0]).pauseReason, 'automatic-no-progress');
  assert.equal(assistants(f).length, 0);
  assert.equal(f.store.state.completions.length, 0);
  assert.equal(await f.supervisor.tick(), null);
});

test('successful actual execution can span unchanged steps while starts and failed probes cannot reset the brake', async (t) => {
  for (const successful of [true, false] as const) {
    const f = fixture(t);
    for (let round = 0; round < (successful ? 4 : 3); round++) {
      await start(f);
      await savePlan(f);
      await emit(f, 'item/started', {
        item: { id: 'started-' + round, type: 'commandExecution', status: 'inProgress' },
      });
      await emit(f, 'item/completed', {
        item: {
          id: 'result-' + round,
          type: 'commandExecution',
          status: successful ? 'completed' : 'failed',
          exitCode: successful ? 0 : 1,
          aggregatedOutput: 'Actual process batch ' + round,
        },
      });
      await finish(f);
    }
    assert.equal(defined(f.store.state.workTasks[0]).status, successful ? 'continuing' : 'paused');
    assert.equal(
      defined(defined(f.store.state.workTasks[0]).continuation).noProgressCount,
      successful ? 0 : 3,
    );
    assert.equal(assistants(f).length, 0);
  }
});

test('ordinary automatic local image links retain immutable files for the final verified result', async (t) => {
  const f = fixture(t);
  await start(f);
  await savePlan(f);
  const file = path.join(f.engine.outputDir, 'ordinary-image.png');
  fs.writeFileSync(file, png);
  await agent(f, `Quiet evidence [image](${file})`);
  fs.unlinkSync(file);
  await finish(f);
  assert.equal(assistants(f).length, 0);
  await start(f);
  await savePlan(
    f,
    plan().map((step) => ({ ...step, status: 'completed' })),
  );
  await agent(f, 'Verified complete using the saved image.', 'final', 'final_answer');
  await finish(f);
  assert.equal(assistants(f).length, 1);
  assert.equal(defined(defined(assistants(f)[0]).attachments).length, 1);
  assert.deepEqual(
    f.attachments.read(defined(defined(defined(assistants(f)[0]).attachments)[0]).id).data,
    png,
  );
});

test('human-origin turns retain normal streaming and explicit delivery behavior', async (t) => {
  const f = fixture(t),
    message = f.store.add({ role: 'user', text: 'Tell me the current result' });
  f.engine.enqueue(message);
  await tick();
  assert.equal(defined(f.engine.active).continuation, undefined);
  await agent(f, 'Here is the current result.', 'human-answer', 'final_answer');
  const result = await f.engine.tool('send_message', {
    text: 'The requested evidence is available.',
  });
  assert.equal(observedRecord(result).sent, true);
  assert.equal(assistants(f).length, 2);
  assert.ok(f.deltas.length);
  await finish(f);
  assert.equal(f.store.state.completions.length, 1);
});

test('quiet linked-file archival pending at completion is awaited before the verified result publishes', async (t) => {
  const f = fixture(t);
  await start(f);
  await savePlan(f);
  const file = path.join(f.engine.outputDir, 'late-result.png');
  fs.writeFileSync(file, png);
  const archive = f.collector.archive.bind(f.collector);
  let resolveArchive!: () => void;
  f.collector.archive = (options) =>
    new Promise((resolve) => (resolveArchive = () => resolve(archive(options))));
  const pending = f.engine.tool('send_message', { text: `Routine evidence [image](${file})` });
  await savePlan(
    f,
    plan().map((step) => ({ ...step, status: 'completed' })),
  );
  await agent(f, 'Verified experiment result.', 'final', 'final_answer');
  const ending = finish(f);
  await tick();
  assert.equal(assistants(f).length, 0);
  resolveArchive();
  await pending;
  f.collector.archive = archive;
  await ending;
  assert.equal(assistants(f).length, 1);
  assert.equal(defined(defined(assistants(f)[0]).attachments).length, 1);
});

test('voice generation belongs to its captured executor and quiet completion waits for the whole file delivery', async (t) => {
  const f = fixture(t);
  await start(f);
  await savePlan(f);
  const file = path.join(f.engine.outputDir, 'generated-audio.png');
  fs.writeFileSync(file, png);
  let resolveGeneration!: (
    value: import('../../src/runtime/worker-types.ts').WorkerVoiceMessage,
  ) => void;
  f.worker.createVoiceMessage = () => new Promise((resolve) => (resolveGeneration = resolve));
  const pending = f.engine.tool('create_voice_message', { text: 'The verified result is ready.' });
  await savePlan(
    f,
    plan().map((step) => ({ ...step, status: 'completed' })),
  );
  await agent(f, 'The requested result has been verified.', 'final', 'final_answer');
  const ending = finish(f);
  await tick();
  assert.equal(assistants(f).length, 0);
  resolveGeneration({ path: file, type: 'image/png' });
  const receipt = await pending;
  assert.equal(observedRecord(receipt).sent, false);
  assert.equal(observedRecord(receipt).quiet, true);
  await ending;
  assert.equal(assistants(f).length, 1);
  assert.equal(defined(defined(assistants(f)[0]).attachments).length, 1);
  const human = f.store.add({ role: 'user', text: 'Say the next answer aloud' });
  f.engine.enqueue(human);
  await tick();
  let releaseOld!: (value: import('../../src/runtime/worker-types.ts').WorkerVoiceMessage) => void;
  f.worker.createVoiceMessage = () => new Promise((resolve) => (releaseOld = resolve));
  const old = f.engine.tool('create_voice_message', { text: 'Old task audio.' }),
    rejected = assert.rejects(old, /no longer belongs/);
  await finish(f);
  const next = f.store.add({ role: 'user', text: 'A different next request' });
  f.engine.enqueue(next);
  await tick();
  const nextActive = f.engine.active,
    before = assistants(f).length;
  releaseOld({ path: file, type: 'image/png' });
  await rejected;
  assert.equal(f.engine.active, nextActive);
  assert.equal(defined(nextActive).messageId, next.id);
  assert.deepEqual(defined(nextActive).assistantIds, []);
  assert.equal(assistants(f).length, before);
  await finish(f);
});

test('private delivery policy is read-only, owned-scope and never a model tool', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'quiet-policy-')),
    worker = new Worker(dir),
    instance = createWorkerApp({ dataDir: dir, workerFactory: () => worker });
  worker.engine = instance.engine;
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + listeningPort(instance.server),
    call = (args = {}, token = worker.credentialBridgeToken) =>
      fetch(base + '/api/internal/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dant-Credential-Token': token },
        body: JSON.stringify({ tool: 'chat_delivery_policy', arguments: args }),
      });
  t.after(async () => {
    instance.engine.active = null;
    await instance.close();
    assert.equal(path.dirname(dir), root);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    dynamicTools.some((tool) => tool.name === 'chat_delivery_policy'),
    false,
  );
  assert.equal((await call({}, 'forged')).status, 403);
  assert.equal((await call()).status, 409);
  const active = activeTaskFixture({
    turnId: 'owned',
    threadId: 'thread',
    startAcknowledged: true,
    assistantIds: [],
    messageIds: [],
  });
  Object.defineProperty(active, 'continuation', {
    value: { workId: 'bound' },
    writable: true,
    configurable: true,
  });
  instance.engine.active = active;
  const before = structuredClone(instance.store.state),
    starts = worker.calls.length;
  assert.deepEqual(await (await call()).json(), {
    quiet: true,
    pendingPublication: true,
    sent: false,
  });
  assert.deepEqual(instance.store.state, before);
  assert.equal(worker.calls.length, starts);
  assert.equal((await call({ quiet: false })).status, 400);
  delete active.continuation;
  assert.deepEqual(await (await call()).json(), {
    quiet: false,
    pendingPublication: true,
    sent: false,
  });
  active.stopRequested = true;
  assert.equal((await call()).status, 409);
});
