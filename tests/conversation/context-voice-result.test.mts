import { inputText } from '../support/engine-fixtures.mts';
import { TracingWorkerFixture } from '../support/worker-fixtures.mts';
import { RpcFixture } from '../support/protocol-fixtures.mts';
import { CredentialFixture } from '../support/engine-fixtures.mts';
import { engineCallFixture } from '../support/service-fixtures.mts';
import type { RpcParams, RpcResult } from '../../src/runtime/protocol.ts';
import type { EngineDeliverables } from '../../src/work/engine.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../../src/work/engine.mts';
import { Store } from '../../src/conversation/store.mts';
import { CredentialRequests, CredentialVault } from '../../src/security/credentials.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
class Worker extends TracingWorkerFixture {
  startWait?: () => Promise<RpcResult>;
  cancelStatus?: string;
  constructor(root: string) {
    super();
    this.status = 'online';
    this.workspaceRoot = path.join(root, 'workspaces');
    this.desktopPath = path.join(root, 'desktop.py');
    this.calls = [];
    this.rpc = Object.assign(new RpcFixture(), { send() {}, reply() {} });
  }
  async request(method: string, params: RpcParams = {}): Promise<RpcResult> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'voice-context-thread' } };
    if (method === 'turn/start') {
      if (this.startWait) return this.startWait();
      return { turn: { id: 'voice-context-turn' } };
    }
    if (method === 'turn/interrupt')
      queueMicrotask(() =>
        this.emit('event', {
          method: 'turn/completed',
          params: {
            threadId: params.threadId,
            turn: { id: params.turnId, status: this.cancelStatus || 'interrupted' },
          },
        }),
      );
    return {};
  }
}
function fixture(
  t: NodeTestContext,
  {
    redact,
    deliverables,
  }: { redact?: (text: unknown) => string; deliverables?: EngineDeliverables } = {},
) {
  const dir = fs.mkdtempSync(path.join(base, 'voice-result-')),
    store = new Store(dir),
    worker = new Worker(dir),
    engine = new Engine(store, worker, {
      ...(redact ? { credentials: Object.assign(new CredentialFixture(), { redact }) } : {}),
      ...(deliverables ? { deliverables } : {}),
    }),
    notices: string[] = [];
  engine.on('notice', (notice) => notices.push(notice));
  engine.call = engineCallFixture({ id: 'same-api-call', provider: 'api' });
  t.after(() => {
    engine.call = null;
    engine.pauseQueue();
    clearTimeout(engine.streamingSaveTimer ?? undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const event = (method: string, params: Record<string, unknown>) =>
    engine.handle({
      method,
      params: { threadId: 'voice-context-thread', turnId: 'voice-context-turn', ...params },
    });
  return {
    store,
    worker,
    engine,
    notices,
    event,
    async start() {
      const result = engine.runVoiceTask('Produce the complete task result'),
        active = engine.active;
      await defined(active).starting;
      return { result, active };
    },
    finish: (status: string) =>
      event('turn/completed', { turn: { id: 'voice-context-turn', status } }),
  };
}

test('API voice receives the exact complete redacted task result beyond the chat output budget without persisting it', async (t) => {
  const secret = 'fake-sensitive-value',
    redact = (text: unknown) => String(text).replaceAll(secret, '[redacted]'),
    f = fixture(t, { redact }),
    { result, active } = await f.start(),
    text = '中'.repeat(140000) + secret + 'tail',
    expected = redact(text);
  await f.event('item/completed', { item: { id: 'large-result', type: 'agentMessage', text } });
  assert.ok(
    [...defined(active).outputs.values()].join('').length <= 120000,
    'the post-model UI observer remains bounded',
  );
  await f.finish('completed');
  const response = await result;
  assert.equal(response.result.length, expected.length);
  assert.equal(response.result, expected);
  assert.equal(f.store.state.messages.length, 0);
  assert.equal(JSON.stringify(f.store.state).includes(secret), false);
  assert.equal(f.engine.voiceTasks.size, 0);
  assert.equal(
    f.notices.some((notice) => notice.includes('120,000 character limit')),
    false,
  );
});

test('API voice forwards an input larger than 100,000 characters intact to the owned Codex turn', async (t) => {
  const f = fixture(t),
    text = '中'.repeat(110000) + ' complete input tail',
    result = f.engine.runVoiceTask(text),
    active = f.engine.active;
  await defined(active).starting;
  const submitted = f.worker.calls.find((call) => call.method === 'turn/start');
  assert.ok(inputText(defined(defined(defined(submitted).params.input)[0])).endsWith(text));
  assert.equal(
    inputText(defined(defined(defined(submitted).params.input)[0])).slice(-text.length),
    text,
  );
  await f.finish('completed');
  assert.deepEqual(await result, { result: 'Task completed.' });
  assert.equal(f.store.state.messages.length, 0);
});

test('API voice collects every output item even after the observer reaches its 128-item cap', async (t) => {
  const f = fixture(t),
    { result, active } = await f.start(),
    items = Array.from({ length: 140 }, (_, index) => `item-${index}: result`);
  for (const [index, text] of items.entries())
    await f.event('item/completed', {
      item: { id: 'result-' + index, type: 'agentMessage', text },
    });
  assert.equal(defined(active).outputs.size, 128);
  await f.finish('completed');
  const response = await result;
  assert.equal(response.result.split('\n\n').length, items.length);
  assert.equal(response.result, items.join('\n\n'));
  assert.equal(f.store.state.messages.length, 0);
  assert.equal(
    f.notices.some((notice) => notice.includes('128 item limit')),
    false,
  );
});

test('final item text replaces streamed deltas and redaction spans chunk boundaries without duplicating output', async (t) => {
  const secret = 'fake-private-value',
    f = fixture(t, { redact: (text) => String(text).replaceAll(secret, '[redacted]') }),
    { result } = await f.start();
  await f.event('item/agentMessage/delta', {
    itemId: 'first',
    delta: 'provisional-' + secret.slice(0, 8),
  });
  await f.event('item/agentMessage/delta', { itemId: 'first', delta: secret.slice(8) });
  await f.event('item/completed', {
    item: { id: 'second', type: 'agentMessage', text: 'second item' },
  });
  await f.event('item/completed', {
    item: { id: 'first', type: 'agentMessage', text: 'final ' + secret },
  });
  await f.event('item/agentMessage/delta', { itemId: 'first', delta: 'stale duplicate' });
  await f.finish('completed');
  assert.deepEqual(await result, { result: 'final [redacted]\n\nsecond item' });
  assert.equal(f.store.state.messages.length, 0);
});

test('delta-only confirmed output is complete and redacts secrets split across chunks', async (t) => {
  const secret = 'fake-private-value',
    f = fixture(t, { redact: (text) => String(text).replaceAll(secret, '[redacted]') }),
    { result } = await f.start();
  await f.event('item/agentMessage/delta', {
    itemId: 'streamed',
    delta: 'x'.repeat(130000) + secret.slice(0, 7),
  });
  await f.event('item/agentMessage/delta', { itemId: 'streamed', delta: secret.slice(7) + ' end' });
  await f.finish('completed');
  const response = await result;
  assert.equal(response.result.length, 130000 + '[redacted] end'.length);
  assert.equal(response.result, 'x'.repeat(130000) + '[redacted] end');
  assert.equal(f.store.state.messages.length, 0);
});

test('failed and cancelled API voice tasks reject instead of returning captured partial output or replaying work', async (t) => {
  for (const status of ['failed', 'interrupted'])
    await t.test(status, async (t) => {
      const f = fixture(t),
        { result } = await f.start(),
        rejected = assert.rejects(result, /Task (failed|paused)/);
      await f.event('item/completed', {
        item: { id: 'partial', type: 'agentMessage', text: 'Do not return this partial result' },
      });
      await f.finish(status);
      await rejected;
      assert.equal(f.engine.voiceTasks.size, 0);
      assert.equal(f.engine.queue.length, 0);
      assert.equal(f.store.state.messages.length, 0);
      assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
    });
});

test('a cancellation racing a completed turn still rejects the API voice task', async (t) => {
  const f = fixture(t),
    { result, active } = await f.start();
  f.worker.cancelStatus = 'completed';
  const rejected = assert.rejects(result, /Task paused/);
  await f.event('item/completed', {
    item: {
      id: 'answer',
      type: 'agentMessage',
      text: 'A result that must not override cancellation',
    },
  });
  await f.engine.interrupt(active);
  await rejected;
  assert.equal(f.engine.voiceTasks.size, 0);
  assert.equal(f.engine.queue.length, 0);
});

test('cancellation during awaited deliverable archiving cannot resolve the API voice task successfully', async (t) => {
  let releaseArchive:
      ((value: import('../../src/conversation/types.ts').ChatAttachment[]) => void) | undefined,
    notifyArchive: (() => void) | undefined;
  const enteredArchive = new Promise<void>((resolve) => (notifyArchive = resolve)),
    f = fixture(t, {
      deliverables: {
        archive: () => {
          defined(notifyArchive)();
          return new Promise((resolve) => (releaseArchive = resolve));
        },
      },
    }),
    { result, active } = await f.start(),
    rejected = assert.rejects(result, /Task paused/);
  await f.event('item/completed', {
    item: { id: 'answer', type: 'agentMessage', text: 'Finished before archive' },
  });
  const finishing = f.finish('completed');
  await enteredArchive;
  await f.engine.interrupt(active);
  defined(releaseArchive)([]);
  await finishing;
  await rejected;
  await defined(active).stopped;
  assert.equal(f.engine.active, null);
  assert.equal(f.engine.finishing, null);
  assert.equal(defined(defined(active).voiceOutputs).size, 0);
  assert.equal(f.engine.voiceTasks.size, 0);
  assert.equal(f.engine.queue.length, 0);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(f.store.state.messages.length, 0);
});

test('unconfirmed task submission rejects and a foreign turn never enters the voice result', async (t) => {
  const unknown = fixture(t);
  let fail: ((reason: unknown) => void) | undefined;
  unknown.worker.startWait = () => new Promise((_resolve, reject) => (fail = reject));
  const result = unknown.engine.runVoiceTask('Task with uncertain submission'),
    rejected = assert.rejects(result, /Submission confirmation lost/);
  while (!fail) await new Promise((resolve) => setImmediate(resolve));
  defined(fail)(Error('Submission confirmation lost'));
  await rejected;
  assert.equal(unknown.engine.voiceTasks.size, 0);
  assert.equal(unknown.store.state.messages.length, 0);
  const f = fixture(t),
    started = await f.start();
  await f.event('item/completed', {
    turnId: 'foreign-turn',
    item: { id: 'wrong', type: 'agentMessage', text: 'Wrong turn' },
  });
  await f.event('item/completed', {
    item: { id: 'owned', type: 'agentMessage', text: 'Owned turn' },
  });
  await f.finish('completed');
  assert.deepEqual(await started.result, { result: 'Owned turn' });
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('API hangup preserves the acknowledged turn and delivers its complete redacted result to chat exactly once', async (t) => {
  const f = fixture(t, {
      redact: (text) => String(text).replaceAll('synthetic-private-token', '[redacted]'),
    }),
    { result, active } = await f.start(),
    text = '中'.repeat(130000) + 'synthetic-private-token done';
  await f.event('item/completed', {
    item: { id: 'background-result', type: 'agentMessage', text },
  });
  await f.engine.stopCall('same-api-call');
  assert.equal(f.engine.call, null);
  assert.equal(f.engine.active, active);
  assert.equal(defined(active).backgroundVoice, true);
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/interrupt'),
    false,
  );
  await assert.rejects(
    f.engine.startCall('offer', { provider: 'subscription' }),
    /Background work|unavailable/,
  );
  await f.finish('completed');
  assert.equal((await result).result, '中'.repeat(130000) + '[redacted] done');
  assert.equal(
    f.store.state.messages
      .filter((item) => item.role === 'assistant')
      .map((item) => item.text)
      .join(''),
    '中'.repeat(130000) + '[redacted] done',
  );
  assert.equal(f.store.state.completions.length, 1);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(JSON.stringify(f.store.state).includes('synthetic-private-token'), false);
});

test('API transport loss retains accepted work but shutdown explicitly interrupts and reports its failure', async (t) => {
  for (const reason of ['connection-lost', 'shutdown'])
    await t.test(reason, async (t) => {
      const f = fixture(t),
        { result, active } = await f.start(),
        rejected = reason === 'shutdown' ? assert.rejects(result, /Task paused/) : null;
      f.engine.handleVoiceClosed({ callId: 'wrong-call', reason });
      assert.ok(f.engine.call);
      f.engine.handleVoiceClosed({ callId: 'same-api-call', reason });
      assert.equal(f.engine.call, null);
      assert.equal(defined(active).backgroundVoice, true);
      if (reason === 'connection-lost') {
        assert.equal(
          f.worker.calls.some((call) => call.method === 'turn/interrupt'),
          false,
        );
        await f.event('item/completed', {
          item: { id: 'result', type: 'agentMessage', text: 'Finished after media loss' },
        });
        await f.finish('completed');
        assert.equal((await result).result, 'Finished after media loss');
        assert.equal(defined(f.store.state.messages.at(-1)).text, 'Finished after media loss');
      } else {
        await rejected;
        assert.equal(f.worker.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
        assert.match(
          defined(defined(f.store.state.messages.at(-1)).text),
          /stopped before completion|任务尚未完成/,
        );
      }
      assert.equal(f.store.state.completions.length, 1);
      assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
    });
});

test('API background credential requests retain their secure form and issue a durable blocker completion', async (t) => {
  const f = fixture(t),
    credentials = new CredentialRequests({
      vault: new CredentialVault({ dataDir: f.store.dir }),
      timeoutMs: 5000,
    });
  f.engine.credentials = credentials;
  t.after(() => credentials.close());
  const { result, active } = await f.start(),
    pending = f.engine.tool('credential_request', { name: 'Synthetic login' });
  await new Promise((resolve) => setImmediate(resolve));
  const request = credentials.snapshot().requests[0];
  await f.engine.stopCall('same-api-call');
  assert.equal(defined(credentials.snapshot().requests[0]).id, defined(request).id);
  assert.equal(defined(active).credentialWaits, 1);
  assert.equal(f.store.state.completions.length, 1);
  assert.match(defined(defined(f.store.state.completions[0]).turnId), /:credential:1$/);
  credentials.fulfill(defined(request).id, { secret: 'synthetic-secret-never-chat' });
  await pending;
  await f.event('item/completed', {
    item: { id: 'answer', type: 'agentMessage', text: 'Login task finished' },
  });
  await f.finish('completed');
  await result;
  assert.equal(f.store.state.completions.length, 2);
  assert.equal(JSON.stringify(f.store.state).includes('synthetic-secret-never-chat'), false);
});

test('an API background input request accepts the human reply through one exact turn steer', async (t) => {
  const f = fixture(t),
    { result } = await f.start();
  await f.engine.stopCall('same-api-call');
  await f.engine.handle({
    id: 91,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'voice-context-thread',
      turnId: 'voice-context-turn',
      questions: [{ question: 'Which project?' }],
    },
  });
  const answer = f.store.add({ role: 'user', text: 'Use the demo project' });
  f.engine.enqueue(answer, { interactive: true });
  await defined(f.engine.active).steerChain;
  assert.equal(answer.submission, 'confirmed');
  const steers = f.worker.calls.filter((call) => call.method === 'turn/steer');
  assert.equal(steers.length, 1);
  assert.equal(defined(steers[0]).params.expectedTurnId, 'voice-context-turn');
  assert.ok(
    inputText(defined(defined(defined(steers[0]).params.input)[0])).includes(
      'Use the demo project',
    ),
  );
  await f.event('item/completed', {
    item: { id: 'answer', type: 'agentMessage', text: 'Demo project completed' },
  });
  await f.finish('completed');
  await result;
  assert.equal(answer.status, 'review');
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('hangup cannot bypass an unconfirmed speech reference or submit a preparing API task', async (t) => {
  const f = fixture(t);
  let rejectContext: ((reason: unknown) => void) | undefined;
  f.engine.voice = {
    start: async () => {
      throw Error('Unexpected media startup');
    },
    conversationReady: () => new Promise((_resolve, reject) => (rejectContext = reject)),
    stop: async () => defined(rejectContext)(Error('Speech context was not confirmed')),
  };
  const result = f.engine.runVoiceTask('Never submit without confirmed speech context'),
    rejected = assert.rejects(result, /Speech context|Task paused/);
  await new Promise((resolve) => setImmediate(resolve));
  await f.engine.stopCall('same-api-call');
  await rejected;
  assert.equal(
    f.worker.calls.some((call) => call.method === 'turn/start'),
    false,
  );
  assert.equal(f.engine.active, null);
  assert.equal(f.store.state.messages.filter((item) => item.role === 'assistant').length, 1);
  assert.equal(f.store.state.completions.length, 1);
});

test('a completed background API task with no text or files still sends a durable completion notice', async (t) => {
  const f = fixture(t),
    { result } = await f.start();
  await f.engine.stopCall('same-api-call');
  await f.finish('completed');
  await result;
  assert.equal(f.store.state.messages.filter((item) => item.role === 'assistant').length, 1);
  assert.equal(f.store.state.completions.length, 1);
});

test('an API background archive failure persists an actionable problem and completion without exposing the raw error', async (t) => {
  const privateError = 'synthetic-private-api-archive-error',
    f = fixture(t, {
      deliverables: {
        archive: async () => {
          throw Error(privateError);
        },
      },
    });
  f.store.state.settings.language = 'en';
  const { result } = await f.start();
  await f.event('item/completed', {
    item: { id: 'answer', type: 'agentMessage', text: 'Verified task result' },
  });
  await f.engine.stopCall('same-api-call');
  await f.finish('completed');
  await result;
  const problem = f.store.state.messages.find(
    (message) =>
      message.text ===
      "The output files could not be added to chat. Check the work computer for the task's files.",
  );
  assert.ok(problem);
  assert.equal(f.store.state.completions.length, 1);
  assert.ok(defined(f.store.state.completions[0]).messageIds.includes(problem.id));
  assert.equal(JSON.stringify(f.store.state).includes(privateError), false);
  assert.equal(
    f.notices.some((message) => message.includes(privateError)),
    false,
  );
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('API voice work has progress without a stored user bubble, ignores foreign events and saves only final voice result metadata', async (t) => {
  const f = fixture(t),
    { result } = await f.start();
  assert.equal(f.store.state.messages.length, 0);
  assert.equal(defined(f.engine.progress).source, 'voice');
  assert.equal(defined(f.engine.progress).turnId, 'voice-context-turn');
  assert.ok(defined(defined(f.engine.progress).startedAt) > 0);
  await f.event('item/started', {
    item: { id: 'command', type: 'commandExecution', command: 'private-command' },
  });
  assert.equal(defined(f.engine.progress).step, 'command');
  const before = f.engine.progress;
  await f.event('item/started', {
    turnId: 'foreign',
    item: { id: 'foreign-item', type: 'fileChange' },
  });
  assert.deepEqual(f.engine.progress, before);
  await f.engine.stopCall('same-api-call');
  assert.equal(defined(f.engine.progress).background, true);
  const quiet = f.engine.progress;
  for (let index = 0; index < 50; index++) assert.deepEqual(f.engine.progress, quiet);
  await f.event('item/completed', {
    item: { id: 'answer', type: 'agentMessage', text: 'Completed voice work' },
  });
  await f.finish('completed');
  await result;
  assert.equal(f.engine.progress, null);
  const completion = f.store.state.completions[0];
  assert.equal(defined(defined(completion).work).source, 'voice');
  assert.equal(defined(defined(completion).work).status, 'review');
  assert.ok(
    defined(defined(defined(completion).work).updatedAt) >=
      defined(defined(defined(completion).work).startedAt),
  );
  assert.equal(JSON.stringify(completion).includes('private-command'), false);
  assert.equal(f.worker.calls.filter((call) => call.method === 'turn/start').length, 1);
});
