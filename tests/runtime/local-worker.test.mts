import type { RpcParams, RpcEnvelope, RpcInput } from '../../src/runtime/protocol.ts';
import { operationError } from '../../src/runtime/errors.mts';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { RpcFixture } from '../support/protocol-fixtures.mts';
import {
  deferred as fixtureDeferred,
  observedRecord,
  observedRecords,
} from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LocalWorker, assertVmRuntime } from '../../src/runtime/local-worker.mts';

function fixtureText(value: unknown): string {
  assert.equal(typeof value, 'string');
  return String(value);
}
function fixtureJson(value: unknown): unknown {
  return JSON.parse(fixtureText(value));
}
function inputText(value: RpcInput | undefined): string {
  assert.ok(value?.type === 'text');
  return value.text;
}
const testRoot = path.resolve('.cache/tests');
fs.mkdirSync(testRoot, { recursive: true });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
class Child extends EventEmitter {
  autoClose: boolean;
  kills: Array<NodeJS.Signals | undefined>;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  constructor({ autoClose = true } = {}) {
    super();
    this.autoClose = autoClose;
    this.kills = [];
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal);
    if (this.autoClose) queueMicrotask(() => this.emit('close', null));
    return true;
  }
}
class FakeRpc extends RpcFixture {
  child: Child | null;
  handler?: ((method: string, params: RpcParams) => unknown | Promise<unknown>) | undefined;
  requests: Array<{ method: string; params: RpcParams }>;
  sent: RpcEnvelope[];
  closeCount: number;
  constructor({
    child = new Child(),
    handler,
  }: {
    child?: Child | null;
    handler?: (method: string, params: RpcParams) => unknown | Promise<unknown>;
  } = {}) {
    super();
    this.child = child;
    this.handler = handler;
    this.requests = [];
    this.sent = [];
    this.closeCount = 0;
  }
  override request = async (method: string, params: RpcParams = {}) => {
    this.requests.push({ method, params });
    if (this.handler) return await this.handler(method, params);
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
    if (method === 'model/list') return { data: [{ id: 'fixture-model' }] };
    return { ok: true };
  };
  override send = (message: RpcEnvelope) => {
    this.sent.push(message);
  };
  override close = () => {
    this.closeCount++;
    this.closed = true;
    this.child?.kill();
    this.emit('disconnected', Error('Worker stopped'));
  };
}
function fixture(
  t: NodeTestContext,
  options: Omit<NonNullable<ConstructorParameters<typeof LocalWorker>[1]>, 'rpcFactory'> & {
    rpc?: FakeRpc;
    rpcFactory?: NonNullable<
      NonNullable<ConstructorParameters<typeof LocalWorker>[1]>['rpcFactory']
    >;
  } = {},
) {
  const home = fs.mkdtempSync(path.join(testRoot, 'worker-'));
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local/bin/codex'), 'fake executable, never run');
  const rpc = options.rpc || new FakeRpc(),
    calls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];
  const worker = new LocalWorker(
    { state: { conversationId: 'test-conversation' } },
    {
      platform: 'linux',
      home,
      verifyRuntime: async () => {},
      rpcFactory(command, args, options) {
        calls.push({ command, args, options });
        return rpc;
      },
      ...options,
    },
  );
  // Tests must never inherit a real service workspace from the environment.
  worker.workspaceRoot = path.join(home, 'dant', 'workspaces');
  t.after(() => {
    worker.disconnect();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, rpc, worker, calls };
}
function replaceSpawn(
  t: NodeTestContext,
  implementation: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => Child,
) {
  t.mock.method(childProcess, 'spawn', implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('LocalWorker forwards current RPC lifecycle metadata without forwarding raw stderr or obsolete connections', async (t) => {
  const { worker, rpc } = fixture(t),
    lifecycle: unknown[] = [],
    raw: unknown[] = [];
  worker.on('lifecycle', (event) => lifecycle.push(event));
  worker.on('diagnostic', (value) => raw.push(value));
  await worker.connect();
  rpc.emit('diagnostic', 'private stderr and credential');
  rpc.emit('lifecycle', { code: 'rpc.timeout', method: 'turn/start', count: 1 });
  assert.deepEqual(lifecycle, [{ code: 'rpc.timeout', method: 'turn/start', count: 1 }]);
  assert.deepEqual(raw, []);
  worker.disconnect();
  rpc.emit('lifecycle', { code: 'rpc.disconnected', reason: 'process-closed', count: 0 });
  assert.equal(lifecycle.length, 1);
});

test('runtime verification requires non-root Linux virtualization and a working PNG desktop', async () => {
  for (const options of [
    { platform: 'win32', uid: 1000 },
    { platform: 'linux', uid: 0 },
  ] as const)
    await assert.rejects(assertVmRuntime(options), /ordinary user inside a Linux VM/);
  for (const detect of [
    () => 'none',
    () => '',
    () => {
      throw Error('not installed');
    },
  ])
    await assert.rejects(
      assertVmRuntime({ platform: 'linux', uid: 1000, detect }),
      /No virtual machine/,
    );
  const requests: Array<{ url: URL | RequestInfo; options: RequestInit | undefined }> = [];
  await assertVmRuntime({
    platform: 'linux',
    uid: 1000,
    detect: () => 'microsoft',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return String(url).endsWith('/health') ? Response.json({ ok: true }) : new Response(png);
    },
  });
  assert.deepEqual(
    requests.map((request) => request.url),
    ['http://127.0.0.1:4320/health', 'http://127.0.0.1:4320/screen'],
  );
  assert.ok(requests.every((request) => defined(request.options).signal instanceof AbortSignal));
  for (const [health, screen, pattern] of [
    [Response.json({ ok: false }), new Response(png), /not healthy/],
    [new Response('', { status: 503 }), new Response(png), /not healthy/],
    [Response.json({ ok: true }), new Response('not PNG'), /display is unavailable/],
    [Response.json({ ok: true }), new Response(png, { status: 503 }), /display is unavailable/],
  ] as const) {
    await assert.rejects(
      assertVmRuntime({
        platform: 'linux',
        uid: 1000,
        detect: () => 'kvm',
        fetchImpl: async (url) => (String(url).endsWith('/health') ? health : screen),
      }),
      pattern,
    );
  }
});

test('local stdio startup initializes Codex and binds desktop tools to the conversation workspace', async (t) => {
  const { worker, rpc, calls, home } = fixture(t);
  const events: unknown[] = [],
    statuses: unknown[] = [];
  worker.on('event', (event) => events.push(event));
  worker.on('status', () => statuses.push(worker.status));
  const account = await worker.connect();
  assert.equal(defined(account.account).planType, 'pro');
  assert.equal(worker.status, 'online');
  assert.equal(worker.error, null);
  assert.deepEqual(
    rpc.requests.map((request) => request.method),
    ['initialize', 'account/read', 'model/list'],
  );
  assert.equal(defined(defined(rpc.requests[0]).params.capabilities).experimentalApi, true);
  assert.deepEqual(rpc.sent, [{ method: 'initialized' }]);
  assert.equal(calls.length, 1);
  const { command, args, options } = defined(calls[0]);
  assert.equal(command, path.join(home, '.local/bin/codex'));
  assert.deepEqual(args.slice(-3), ['app-server', '--listen', 'stdio://']);
  assert.ok(args.includes('features.realtime_conversation=true'));
  const tools = fixtureJson(
    defined(args.find((arg) => arg.startsWith('mcp_servers.dant_desktop.args=')))
      .split('=')
      .slice(1)
      .join('='),
  );
  assert.deepEqual(tools, [
    path.join(home, 'dant/vm/desktop_mcp.py'),
    '--output-dir',
    path.join(worker.workspaceRoot, 'test-conversation', 'output'),
  ]);
  assert.equal(options.cwd, worker.workspaceRoot);
  assert.equal(defined(options.env).DISPLAY, ':0');
  assert.equal(defined(options.env).CODEX_HOME, path.join(home, '.dant-codex'));
  assert.ok(defined(defined(options.env).PATH).startsWith(path.join(home, '.local/bin') + ':'));
  assert.equal(
    observedRecord(defined(observedRecords(defined(worker.models).data)[0])).id,
    'fixture-model',
  );
  assert.ok(statuses.includes('connecting'));
  const event = { method: 'turn/completed', params: { threadId: 'owned' } };
  rpc.emit('event', event);
  assert.deepEqual(events, [event]);
  assert.deepEqual(await worker.request('thread/read', { threadId: 'owned' }), { ok: true });
  assert.equal(defined(rpc.requests.at(-1)).params.threadId, 'owned');
  worker.disconnect();
  rpc.emit('event', { method: 'late' });
  rpc.emit('disconnected', Error('stale executor error'));
  assert.equal(events.length, 1);
  assert.equal(worker.status, 'offline');
  assert.equal(worker.account, null);
  assert.equal(worker.models, null);
  assert.throws(() => worker.request('thread/read', {}), /offline/);
});

test('real Rpc framing over fake stdio exchanges responses without exposing stderr credentials', async (t) => {
  const child = new Child(),
    messages: unknown[] = [];
  let spawned = 0;
  replaceSpawn(t, (_command, _args, options) => {
    spawned++;
    assert.equal(defined(options.stdio)[0], 'pipe');
    return child;
  });
  let input = '';
  child.stdin.on('data', (bytes) => {
    input += bytes.toString();
    let newline;
    while ((newline = input.indexOf('\n')) !== -1) {
      const message = observedRecord(fixtureJson(input.slice(0, newline)));
      input = input.slice(newline + 1);
      messages.push(message);
      if (message.id)
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({
              id: message.id,
              result:
                message.method === 'account/read' ? { account: { type: 'chatgpt' } } : { ok: true },
            }) + '\n',
          ),
        );
    }
  });
  const { worker } = fixture(t);
  // Use the production factory, while the only process primitive is intercepted above.
  const realWorker = new LocalWorker(worker.store, {
    platform: 'linux',
    home: worker.home,
    verifyRuntime: async () => {},
  });
  realWorker.workspaceRoot = worker.workspaceRoot;
  t.after(() => realWorker.disconnect());
  const published: unknown[] = [];
  for (const name of ['event', 'diagnostic', 'error'])
    realWorker.on(name, (value) => published.push(value));
  realWorker.on('status', () =>
    published.push({ status: realWorker.status, error: realWorker.error }),
  );
  await realWorker.connect();
  child.stderr.write('TEST-ONLY-KEY=do-not-expose');
  await realWorker.request('thread/read', { threadId: 'same-thread' });
  assert.equal(spawned, 1);
  assert.equal(observedRecord(observedRecord(messages.at(-1)).params).threadId, 'same-thread');
  assert.doesNotMatch(JSON.stringify(published), /TEST-ONLY-KEY|do-not-expose/);
  child.emit('close', 7);
  assert.equal(realWorker.status, 'offline');
  assert.match(defined(realWorker.error), /disconnected \(7\)/);
  assert.doesNotMatch(defined(realWorker.error), /do-not-expose/);
});

test('concurrent local connects merge and disconnect cancels runtime checks before spawning', async (t) => {
  const gate = fixtureDeferred<void>();
  let verified = 0;
  const { worker, calls } = fixture(t, {
    verifyRuntime: async () => {
      verified++;
      await gate.promise;
    },
  });
  const first = worker.connect(),
    second = worker.connect();
  assert.equal(verified, 1);
  gate.resolve();
  assert.strictEqual(await first, await second);
  assert.equal(calls.length, 1);
  const checking = fixtureDeferred<void>();
  worker.verifyRuntime = () => checking.promise;
  const pending = worker.connect();
  worker.disconnect();
  checking.resolve();
  await assert.rejects(pending, /cancelled/);
  assert.equal(worker.status, 'offline');
  assert.equal(calls.length, 1);
});

test('unsupported hosts and failed runtime checks cannot start an executor and allow a later retry', async (t) => {
  const { worker, calls } = fixture(t, { platform: 'win32' });
  await assert.rejects(worker.connect(), /only inside the Linux VM/);
  assert.equal(calls.length, 0);
  worker.platform = 'linux';
  worker.verifyRuntime = async () => {
    throw Error('desktop is down');
  };
  await assert.rejects(worker.connect(), /desktop is down/);
  assert.equal(worker.status, 'offline');
  assert.equal(worker.error, 'desktop is down');
  assert.equal(calls.length, 0);
  worker.verifyRuntime = async () => {};
  await worker.connect();
  assert.equal(worker.error, null);
  assert.equal(calls.length, 1);
});

test('missing Codex and failed initialization report errors and close partially started RPC', async (t) => {
  const { worker, calls, rpc } = fixture(t);
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (file: fs.PathLike) =>
    /(?:^|[\\/])codex$/.test(String(file)) ? false : exists(file),
  );
  await assert.rejects(worker.connect(), /Codex is not installed/);
  assert.equal(calls.length, 0);
  t.mock.restoreAll();
  rpc.handler = async (method) => {
    if (method === 'initialize') throw Error('protocol rejected');
    return {};
  };
  await assert.rejects(worker.connect(), /protocol rejected/);
  assert.equal(worker.status, 'offline');
  assert.equal(worker.rpc, null);
  assert.equal(rpc.closeCount, 1);
});

test('cancelled handshake does not publish account data and old RPC cannot disconnect its replacement', async (t) => {
  const initialize = fixtureDeferred<unknown>(),
    old = new FakeRpc({
      handler: async (method) => (method === 'initialize' ? initialize.promise : {}),
    });
  const { worker } = fixture(t, { rpc: old });
  const first = worker.connect();
  await nextTurn();
  worker.disconnect();
  const replacement = new FakeRpc();
  worker.rpcFactory = () => replacement;
  await worker.connect();
  initialize.resolve({ ok: true });
  await assert.rejects(first, /cancelled/);
  old.emit('disconnected', Error('stale connection'));
  assert.equal(worker.status, 'online');
  assert.strictEqual(worker.rpc, replacement);
  assert.equal(defined(defined(worker.account).account).planType, 'pro');
});

test('late account and model responses from a cancelled handshake cannot overwrite its replacement', async (t) => {
  for (const phase of ['account/read', 'model/list']) {
    await t.test(phase, async (t) => {
      const response = fixtureDeferred<unknown>(),
        requested = fixtureDeferred<void>();
      const old = new FakeRpc({
        handler: async (method) => {
          if (method === phase) {
            requested.resolve();
            return response.promise;
          }
          return method === 'account/read' ? { account: { type: 'chatgpt', planType: 'old' } } : {};
        },
      });
      const { worker } = fixture(t, { rpc: old }),
        pending = worker.connect();
      await requested.promise;
      worker.disconnect();
      const replacement = new FakeRpc();
      worker.rpcFactory = () => replacement;
      await worker.connect();
      response.resolve(
        phase === 'account/read'
          ? { account: { type: 'chatgpt', planType: 'stale' } }
          : { data: [{ id: 'stale-model' }] },
      );
      await assert.rejects(pending, /cancelled/);
      assert.equal(defined(defined(worker.account).account).planType, 'pro');
      assert.equal(
        observedRecord(defined(observedRecords(defined(worker.models).data)[0])).id,
        'fixture-model',
      );
      assert.equal(worker.status, 'online');
    });
  }
});

test('an old executor closing after reconnect cannot confirm the replacement process has stopped', async (t) => {
  const oldChild = new Child({ autoClose: false }),
    oldRpc = new FakeRpc({ child: oldChild }),
    { worker } = fixture(t, { rpc: oldRpc });
  await worker.connect();
  worker.disconnect();
  const currentChild = new Child({ autoClose: false }),
    currentRpc = new FakeRpc({ child: currentChild });
  worker.rpcFactory = () => currentRpc;
  await worker.connect();
  oldChild.emit('close', 0);
  assert.equal(worker.executorClosed, false);
  await assert.rejects(worker.terminateConfirmed({ timeoutMs: 5 }), /has not confirmed/);
  currentChild.emit('close', 0);
  assert.deepEqual(await worker.terminateConfirmed(), { terminated: true });
});

test('executor termination waits for actual child close and fails closed on timeout', async (t) => {
  const child = new Child({ autoClose: false }),
    rpc = new FakeRpc({ child }),
    { worker } = fixture(t, { rpc });
  assert.deepEqual(await worker.terminateConfirmed(), { terminated: true });
  await worker.connect();
  const pending = worker.terminateConfirmed({ timeoutMs: 1000 });
  let resolved = false;
  pending.then(() => {
    resolved = true;
  });
  await nextTurn();
  assert.equal(resolved, false);
  child.emit('close', 0);
  assert.deepEqual(await pending, { terminated: true });
  assert.deepEqual(await worker.terminateConfirmed(), { terminated: true });
  const unconfirmed = new Child({ autoClose: false }),
    nextRpc = new FakeRpc({ child: unconfirmed });
  worker.rpcFactory = () => nextRpc;
  await worker.connect();
  await assert.rejects(
    worker.terminateConfirmed({ timeoutMs: 5 }),
    /has not confirmed.*control remains blocked/,
  );
  assert.ok(unconfirmed.kills.length > 0);
  assert.equal(worker.executorClosed, false);
  assert.equal(worker.executorClosed, false);
});

test('desktop operations are local, allowlisted, carry lease bodies and upload exact bytes', async (t) => {
  const requests: Array<{ url: URL | RequestInfo; options: RequestInit | undefined }> = [];
  const { worker, home } = fixture(t, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ guestPath: '/vm/file', ok: true });
    },
  });
  await assert.rejects(
    worker.guest('/input', { sessionId: 'owned-lease', type: 'key', value: 'ESC' }),
    /offline/,
  );
  await worker.connect();
  await assert.rejects(worker.guest('/shell', {}), /Unsupported desktop/);
  await worker.guest('/screen');
  await worker.guest('/input', { sessionId: 'owned-lease', type: 'key', value: 'ESC' });
  assert.equal(defined(requests[0]).url, 'http://127.0.0.1:4320/screen');
  assert.equal(defined(defined(requests[0]).options).method, 'GET');
  assert.equal(defined(defined(requests[0]).options).body, undefined);
  assert.equal(defined(defined(requests[1]).options).method, 'POST');
  assert.equal(
    observedRecord(fixtureJson(defined(defined(requests[1]).options).body)).sessionId,
    'owned-lease',
  );
  const file = path.join(home, 'upload.txt');
  fs.writeFileSync(file, Buffer.from([0, 1, 255]));
  assert.equal(
    (await worker.upload({ path: file, originalname: '结果.txt' })).guestPath,
    '/vm/file',
  );
  assert.deepEqual(fixtureJson(defined(defined(requests[2]).options).body), {
    name: '结果.txt',
    data: Buffer.from([0, 1, 255]).toString('base64'),
  });
  worker.fetchImpl = async () => new Response('', { status: 409 });
  await assert.rejects(
    worker.guest('/control', { action: 'renew' }),
    /Desktop operation failed \(409\)/,
  );
});

test('an offline Linux executor can fetch a live read-only desktop screenshot without reconnecting or changing status', async (t) => {
  const requests: Array<{ url: URL | RequestInfo; options: RequestInit | undefined }> = [],
    { worker, calls, rpc } = fixture(t, {
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      },
    });
  worker.error = 'Worker stopped';
  const generation = worker.generation,
    statuses: unknown[] = [];
  worker.on('status', () => statuses.push(worker.status));
  const response = await worker.guest('/screen');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(requests.length, 1);
  assert.equal(defined(requests[0]).url, 'http://127.0.0.1:4320/screen');
  assert.equal(defined(defined(requests[0]).options).method, 'GET');
  assert.equal(defined(defined(requests[0]).options).body, undefined);
  assert.ok(defined(defined(requests[0]).options).signal instanceof AbortSignal);
  assert.equal(worker.status, 'offline');
  assert.equal(worker.error, 'Worker stopped');
  assert.equal(worker.generation, generation);
  assert.equal(worker.rpc, undefined);
  assert.equal(calls.length, 0);
  assert.equal(rpc.requests.length, 0);
  assert.deepEqual(statuses, []);
});

test('offline screenshot bridge failures report their actual failure and never retry or imply executor recovery', async (t) => {
  let fetched = 0;
  const { worker, calls } = fixture(t, {
    fetchImpl: async () => {
      fetched++;
      return new Response('', { status: 503 });
    },
  });
  await assert.rejects(worker.guest('/screen'), /Desktop operation failed \(503\)/);
  assert.equal(fetched, 1);
  assert.equal(worker.status, 'offline');
  const unavailable = Error('TEST-ONLY-sensitive diagnostic');
  worker.fetchImpl = async () => {
    fetched++;
    throw unavailable;
  };
  await assert.rejects(
    worker.guest('/screen'),
    (error) =>
      operationError(error).message === 'The VM desktop bridge could not be reached' &&
      operationError(error).cause === unavailable,
  );
  assert.equal(fetched, 2);
  worker.fetchImpl = async () => {
    fetched++;
    throw new DOMException('Timed out', 'TimeoutError');
  };
  await assert.rejects(worker.guest('/screen'), /desktop bridge could not be reached/);
  assert.equal(fetched, 3);
  assert.equal(worker.status, 'offline');
  assert.equal(calls.length, 0);
});

test('offline desktop exemption is only an exact bodyless Linux screen GET', async (t) => {
  let fetched = 0;
  const { worker } = fixture(t, {
    fetchImpl: async () => {
      fetched++;
      assert.fail('Non-read operations cannot reach the bridge while offline');
    },
  });
  for (const [route, body] of [
    ['/input', { sessionId: 'lease', type: 'key', key: 'Escape' }],
    ['/control', { action: 'acquire' }],
    ['/file', { name: 'x', data: '' }],
    ['/read-file', { path: '/home/dant/work/x' }],
    ['/screen', {}],
    ['/screen', null],
    ['/screen?anything', undefined],
    ['/shell', {}],
  ] as const)
    await assert.rejects(worker.guest(route, body), /executor is offline/);
  for (const platform of ['win32', 'darwin'] as const) {
    worker.platform = platform;
    await assert.rejects(worker.guest('/screen'), /executor is offline/);
  }
  assert.equal(fetched, 0);
});

test('read-only screenshots do not clear an unconfirmed executor termination or permit desktop control', async (t) => {
  const child = new Child({ autoClose: false }),
    rpc = new FakeRpc({ child }),
    { worker } = fixture(t, { rpc, fetchImpl: async () => new Response(png) });
  await worker.connect();
  await assert.rejects(
    worker.terminateConfirmed({ timeoutMs: 5 }),
    /has not confirmed.*control remains blocked/,
  );
  assert.equal(worker.executorClosed, false);
  assert.equal(worker.status, 'offline');
  assert.deepEqual(Buffer.from(await (await worker.guest('/screen')).arrayBuffer()), png);
  assert.equal(worker.executorClosed, false);
  assert.equal(worker.status, 'offline');
  await assert.rejects(worker.guest('/control', { action: 'acquire' }), /executor is offline/);
  await assert.rejects(
    worker.guest('/input', { sessionId: 'lease', type: 'key', key: 'Escape' }),
    /executor is offline/,
  );
  assert.throws(() => worker.request('turn/start', {}), /executor is offline/);
  child.emit('close', 0);
});

test('only an explicit task or call request receives fresh reactions from the authoritative VM Store', async (t) => {
  const { worker, rpc } = fixture(t);
  await worker.connect();
  const message = {
    id: 'answer',
    role: 'assistant',
    text: 'Result',
    reactions: ['👍'],
    attachments: [{ name: 'output.txt' }],
  };
  worker.store.state.messages = [message];
  const params = {
    threadId: 'thread',
    input: [{ type: 'text' as const, text: 'Continue', text_elements: [] }],
  };
  await worker.request('turn/start', params);
  assert.match(inputText(defined(defined(defined(rpc.requests.at(-1)).params.input)[0])), /👍/);
  assert.equal(params.input.length, 1);
  const requestCount = rpc.requests.length;
  message.reactions = ['❤️'];
  await nextTurn();
  assert.equal(rpc.requests.length, requestCount);
  await worker.request('turn/steer', { ...params, expectedTurnId: 'owned-turn' });
  assert.match(inputText(defined(defined(defined(rpc.requests.at(-1)).params.input)[0])), /❤️/);
  assert.doesNotMatch(
    inputText(defined(defined(defined(rpc.requests.at(-1)).params.input)[0])),
    /👍/,
  );
  assert.equal(defined(rpc.requests.at(-1)).params.expectedTurnId, 'owned-turn');
  message.reactions = [];
  await nextTurn();
  assert.equal(rpc.requests.length, requestCount + 1);
  await worker.request('turn/start', params);
  assert.match(
    inputText(defined(defined(defined(rpc.requests.at(-1)).params.input)[0])),
    /"entries":\[\]/,
  );
  assert.doesNotMatch(
    inputText(defined(defined(defined(rpc.requests.at(-1)).params.input)[0])),
    /👍|❤️/,
  );
  await worker.request('thread/realtime/start', {
    threadId: 'thread',
    realtimeStartInstructions: 'Call policy',
  });
  assert.match(
    defined(defined(rpc.requests.at(-1)).params.realtimeStartInstructions),
    /empty complete list clears/,
  );
  const thread = { developerInstructions: 'Stable policy' };
  await worker.request('thread/resume', thread);
  assert.strictEqual(defined(rpc.requests.at(-1)).params, thread);
  assert.equal(thread.developerInstructions, 'Stable policy');
});

test('voice generation rejects host execution, invalid output directories and oversized text before spawn', async (t) => {
  let spawned = 0;
  replaceSpawn(t, () => {
    spawned++;
    assert.fail('Invalid voice requests must never spawn');
  });
  const { worker, home } = fixture(t);
  await assert.rejects(worker.createVoiceMessage({ text: 'hello' }), /connected VM/);
  await worker.connect();
  worker.platform = 'win32';
  await assert.rejects(worker.createVoiceMessage({ text: 'hello' }), /connected VM/);
  worker.platform = 'linux';
  for (const outputDir of [
    worker.workspaceRoot,
    path.join(home, 'outside'),
    path.join(worker.workspaceRoot, '../outside'),
  ])
    await assert.rejects(
      worker.createVoiceMessage({ text: 'hello', outputDir }),
      /inside the VM conversation workspace/,
    );
  for (const text of ['', '  ', 5, 'x'.repeat(2501)])
    await assert.rejects(
      worker.createVoiceMessage({
        text,
        outputDir: path.join(worker.workspaceRoot, 'conversation/output'),
      }),
      /1–2500/,
    );
  assert.equal(spawned, 0);
});

test('voice subprocess uses stdin JSON and only accepts a WAV in the requested output directory', async (t) => {
  const children: Child[] = [],
    invocations: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];
  replaceSpawn(t, (command, args, options) => {
    const child = new Child();
    children.push(child);
    invocations.push({ command, args, options });
    return child;
  });
  const { worker } = fixture(t);
  await worker.connect();
  const outputDir = path.join(worker.workspaceRoot, 'conversation', 'output');
  const pending = worker.createVoiceMessage({
      text: '你好; $(not a shell)',
      outputDir,
      language: 'zh',
    }),
    child = children[0];
  const input = defined(child).stdin.read().toString();
  assert.deepEqual(fixtureJson(input), { text: '你好; $(not a shell)', language: 'zh' });
  const result = { path: path.join(outputDir, 'spoken.wav'), type: 'audio/wav', size: 42 };
  defined(child).stdout.write(JSON.stringify(result));
  defined(child).stdin.emit('error', Error('already ended'));
  defined(child).emit('close', 0);
  assert.deepEqual(await pending, result);
  assert.equal(defined(invocations[0]).command, '/usr/bin/python3');
  assert.equal(defined(invocations[0]).options.shell, false);
  assert.deepEqual(defined(invocations[0]).args.slice(-2), [
    '--output-dir',
    path.resolve(outputDir),
  ]);
  for (const invalid of [
    'not JSON',
    JSON.stringify({ path: path.join(worker.workspaceRoot, 'outside.wav'), type: 'audio/wav' }),
    JSON.stringify({ path: path.join(outputDir, 'wrong.txt'), type: 'text/plain' }),
  ]) {
    const task = worker.createVoiceMessage({ text: 'hello', outputDir });
    defined(children.at(-1)).stdout.write(invalid);
    defined(children.at(-1)).emit('close', 0);
    await assert.rejects(task, /invalid output/);
  }
});

test('voice subprocess handles spawn failure, missing dependency, malformed diagnostics and timeout', async (t) => {
  const children: Child[] = [];
  replaceSpawn(t, () => {
    const child = new Child();
    children.push(child);
    return child;
  });
  const { worker } = fixture(t);
  await worker.connect();
  const options = {
    text: 'hello',
    outputDir: path.join(worker.workspaceRoot, 'conversation/output'),
  };
  let pending = worker.createVoiceMessage(options);
  defined(children.at(-1)).emit('error', Error('TEST-SECRET must not escape'));
  await assert.rejects(
    pending,
    (error) => operationError(error).message === 'Could not start VM speech generation.',
  );
  pending = worker.createVoiceMessage(options);
  defined(children.at(-1)).stderr.write(JSON.stringify({ error: 'espeak-ng missing from the VM' }));
  defined(children.at(-1)).emit('close', 2);
  await assert.rejects(pending, /espeak-ng missing/);
  pending = worker.createVoiceMessage(options);
  defined(children.at(-1)).stderr.write('not JSON; TEST-SECRET');
  defined(children.at(-1)).emit('close', 2);
  await assert.rejects(
    pending,
    (error) =>
      /check the local espeak-ng dependency/.test(operationError(error).message) &&
      !operationError(error).message.includes('TEST-SECRET'),
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pending = worker.createVoiceMessage(options);
  const timeout = assert.rejects(pending, /timed out/);
  t.mock.timers.tick(55000);
  await timeout;
  assert.equal(defined(children.at(-1)).kills.length, 1);
});
