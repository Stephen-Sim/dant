import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { VmBridge, vmSourceFingerprint } from '../../src/computer/vm-bridge.mts';
import type { VmBridgeOptions } from '../../src/computer/vm-bridge.mts';
import type { SpawnOptions } from 'node:child_process';
import { deferred, observedRecord, observedRecords } from '../support/service-fixtures.mts';
import { errorMessage } from '../../src/contracts/json.mts';

type FixtureFetch = (url: string, options?: RequestInit) => Promise<Response>;
type FixtureOptions = Omit<VmBridgeOptions, 'fetchImpl'> & {
  fetchImpl?: FixtureFetch;
  versionImpl?: FixtureFetch;
};
type SpawnCall = { command: string; args: readonly string[]; options: SpawnOptions };
type RequestCall = { url: string; options: RequestInit | undefined };
const fixtureDeploymentResult = { fingerprint: 'fixture-source', current: true };

const testRoot = path.resolve('.cache/tests');
fs.mkdirSync(testRoot, { recursive: true });
class Child extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kills: (NodeJS.Signals | undefined)[];
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
  }
  kill(signal?: NodeJS.Signals) {
    this.kills.push(signal);
    queueMicrotask(() => this.emit('close', null));
    return true;
  }
}
class Socket extends EventEmitter {
  url: string;
  terminated: number;
  constructor(url: string) {
    super();
    this.url = url;
    this.terminated = 0;
  }
  terminate() {
    this.terminated++;
  }
}
function fixture(t: NodeTestContext, overrides: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(testRoot, 'bridge-'));
  const dataDir = path.join(root, 'data'),
    projectRoot = path.join(root, 'project');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(dataDir, 'test-key'), 'TEST KEY ONLY; never a credential');
  fs.writeFileSync(
    path.join(dataDir, 'vm.json'),
    JSON.stringify({
      host: '192.0.2.15',
      user: 'dant',
      port: 2222,
      keyPath: 'test-key',
      knownHosts: 'known_hosts',
    }),
  );
  const calls: SpawnCall[] = [],
    children: Child[] = [],
    requests: RequestCall[] = [],
    sockets: Socket[] = [];
  const transport: { fetch: typeof fetch } = {
    fetch: async (input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/version'))
        return overrides.versionImpl
          ? overrides.versionImpl(url, options)
          : Response.json({ version: '0.4.7-beta.6' });
      if (overrides.fetchImpl) return overrides.fetchImpl(url, options);
      requests.push({ url, options });
      return Response.json(
        url.endsWith('/api/session')
          ? { token: 'fixture token' }
          : { messages: [{ id: 'from-vm' }] },
      );
    },
  };
  const bridge = new VmBridge({
    dataDir,
    projectRoot,
    spawnProcess(command, args, options) {
      const child = new Child();
      calls.push({ command, args, options });
      children.push(child);
      return child;
    },
    WebSocketImpl: class extends Socket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    },
    ...overrides,
    fetchImpl: (...args) => transport.fetch(...args),
  });
  t.after(() => {
    bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { bridge, transport, root, dataDir, projectRoot, calls, children, requests, sockets };
}
function resources(directory: string) {
  for (const name of [
    'src/server.mts',
    'dist/index.html',
    'LICENSE',
    'package.json',
    'package-lock.json',
    'vm/install-worker.sh',
    'vm/install-speech.sh',
    'vm/install-transcription.sh',
    'vm/transcription-requirements.txt',
    'vm/migrate-state.mts',
    'vm/start-codex.sh',
    'vm/guest.py',
    'vm/desktop.py',
    'vm/control.py',
    'vm/voice_message.py',
    'vm/transcribe_audio.py',
    'vm/desktop_mcp.py',
  ]) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), `fixture ${name}`);
  }
}

test('bridge connects through an SSH tunnel and forwards VM state and events', async (t) => {
  const { bridge, calls, requests, sockets, children } = fixture(t);
  const events: Record<string, unknown>[] = [],
    states: unknown[] = [];
  bridge.on('event', (event) => events.push(event));
  bridge.on('state', (state) => states.push(state));
  assert.deepEqual(await bridge.connect({ deploy: false }), { messages: [{ id: 'from-vm' }] });
  assert.equal(bridge.status, 'online');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(defined(call).command, 'ssh');
  assert.equal(defined(call).options.shell, false);
  assert.ok(defined(call).args.includes(`127.0.0.1:${bridge.port}:127.0.0.1:4317`));
  assert.ok(defined(call).args.includes('BatchMode=yes'));
  assert.ok(defined(call).args.includes('ExitOnForwardFailure=yes'));
  assert.equal(defined(call).args.at(-1), 'dant@192.0.2.15');
  assert.equal(
    new Headers(defined(requests[1]).options?.headers).get('X-Dant-Token'),
    'fixture token',
  );
  assert.match(defined(sockets[0]).url, /token=fixture%20token$/);
  defined(children[0]).stderr.write('PRIVATE TEST DIAGNOSTIC');
  defined(sockets[0]).emit('message', Buffer.from('{bad json'));
  defined(sockets[0]).emit('error', Error('ignored socket diagnostic'));
  defined(sockets[0]).emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'state', data: { messages: [{ id: 'updated' }] } })),
  );
  defined(sockets[0]).emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'notice', data: { message: 'VM notice' } })),
  );
  assert.equal(defined(observedRecords(observedRecord(states.at(-1)).messages)[0]).id, 'updated');
  assert.deepEqual(events, [{ type: 'notice', data: { message: 'VM notice' } }]);
  bridge.disconnect();
  defined(sockets[0]).emit('message', JSON.stringify({ type: 'state', data: { messages: [] } }));
  defined(sockets[0]).emit('close');
  assert.equal(bridge.status, 'offline');
  assert.equal(defined(observedRecords(defined(bridge.cached).messages)[0]).id, 'updated');
  assert.equal(defined(sockets[0]).terminated, 1);
  assert.equal(defined(children[0]).kills.length, 1);
  bridge.close();
  await assert.rejects(bridge.connect(), /closed/);
});

test('concurrent connects share one preparation and one SSH process', async (t) => {
  const { bridge, calls } = fixture(t),
    gate = deferred();
  let preparations = 0;
  bridge.prepare = async () => {
    preparations++;
    await gate.promise;
    return fixtureDeploymentResult;
  };
  const first = bridge.connect(),
    second = bridge.connect();
  assert.equal(preparations, 1);
  gate.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.strictEqual(one, two);
  assert.equal(calls.length, 1);
  assert.equal(bridge.connecting, null);
});

test('manual reconnect waits for an automatic connection and then performs its own authorized deployment once', async (t) => {
  const { bridge, calls } = fixture(t),
    gate = deferred(),
    options: Parameters<VmBridge['prepare']>[1][] = [];
  bridge.prepare = async (_vm, value) => {
    options.push(value);
    if (options.length === 1) await gate.promise;
    return fixtureDeploymentResult;
  };
  const automatic = bridge.connect(),
    manual = bridge.connect({ updateRunningWork: true }),
    secondClick = bridge.connect({ updateRunningWork: true });
  assert.deepEqual(options, [{ updateRunningWork: false }]);
  gate.resolve();
  await Promise.all([automatic, manual, secondClick]);
  assert.deepEqual(options, [{ updateRunningWork: false }, { updateRunningWork: true }]);
  assert.equal(calls.length, 2);
  assert.equal(bridge.manualConnectionPending, null);
});

test('disconnect cancels a queued explicit update instead of deploying after the user leaves', async (t) => {
  const { bridge, calls } = fixture(t),
    gate = deferred(),
    options: Parameters<VmBridge['prepare']>[1][] = [];
  bridge.prepare = async (_vm, value) => {
    options.push(value);
    await gate.promise;
    return fixtureDeploymentResult;
  };
  const automatic = bridge.connect(),
    manual = bridge.connect({ updateRunningWork: true });
  bridge.disconnect();
  gate.resolve();
  const results = await Promise.allSettled([automatic, manual]);
  assert.ok(
    results.every(
      (result) => result.status === 'rejected' && /cancelled/.test(errorMessage(result.reason)),
    ),
  );
  assert.deepEqual(options, [{ updateRunningWork: false }]);
  assert.equal(calls.length, 0);
});

test('preparation failure preserves cached history and never opens an SSH tunnel', async (t) => {
  const { bridge, calls } = fixture(t);
  bridge.cached = { messages: [{ id: 'retained' }] };
  bridge.prepare = async () => {
    throw Error('VM package is incomplete');
  };
  await assert.rejects(bridge.connect(), /package is incomplete/);
  assert.equal(bridge.status, 'offline');
  assert.match(defined(bridge.error), /incomplete/);
  assert.equal(calls.length, 0);
  assert.equal(defined(observedRecords(bridge.cached.messages)[0]).id, 'retained');
});

test('a busy VM defers deployment but still connects to its existing service', async (t) => {
  const { bridge, calls } = fixture(t),
    events: Record<string, unknown>[] = [];
  bridge.prepare = async () => {
    throw Object.assign(Error('DANT_WORK_ACTIVE'), { updateDeferred: true });
  };
  bridge.on('event', (event) => events.push(event));
  await bridge.connect();
  assert.equal(bridge.status, 'online');
  assert.equal(calls.length, 1);
  assert.equal(defined(events[0]).type, 'notice');
  assert.match(String(observedRecord(defined(events[0]).data).message), /deferred/);
});

test('only explicit reconnect carries permission to pause running work into preparation', async (t) => {
  const { bridge } = fixture(t),
    options: Parameters<VmBridge['prepare']>[1][] = [];
  bridge.prepare = async (_vm, value) => {
    options.push(value);
    return fixtureDeploymentResult;
  };
  await bridge.connect();
  // @ts-expect-error Intentional malformed input must never authorize a work pause.
  await bridge.connect({ updateRunningWork: 'true' });
  await bridge.connect({ updateRunningWork: true });
  assert.deepEqual(options, [
    { updateRunningWork: false },
    { updateRunningWork: false },
    { updateRunningWork: true },
  ]);
});

test('explicit reconnect reports a refused update instead of silently connecting to an old worker', async (t) => {
  const { bridge, calls } = fixture(t),
    events: Record<string, unknown>[] = [];
  bridge.prepare = async () => {
    throw Object.assign(Error('DANT_WORK_ACTIVE'), { updateDeferred: true });
  };
  bridge.on('event', (event) => events.push(event));
  await assert.rejects(bridge.connect({ updateRunningWork: true }), /DANT_WORK_ACTIVE/);
  assert.equal(bridge.status, 'offline');
  assert.equal(calls.length, 0);
  assert.deepEqual(events, []);
});

test('disconnect during preparation cancels the pending connection without starting SSH', async (t) => {
  const { bridge, calls } = fixture(t),
    gate = deferred();
  bridge.prepare = () => gate.promise.then(() => fixtureDeploymentResult);
  const pending = bridge.connect();
  bridge.disconnect();
  gate.resolve();
  await assert.rejects(pending, /cancelled/);
  assert.equal(calls.length, 0);
  assert.equal(bridge.status, 'offline');
});

test('a late session response cannot revive a cancelled or failed tunnel', async (t) => {
  for (const reason of ['disconnect', 'spawn-error', 'ssh-close']) {
    await t.test(reason, async (t) => {
      const session = deferred<Response>(),
        requested = deferred();
      const { bridge, children, sockets } = fixture(t, {
        fetchImpl: async (url) => {
          if (url.endsWith('/api/session')) {
            requested.resolve();
            return session.promise;
          }
          return Response.json({ messages: [] });
        },
      });
      const pending = bridge.connect({ deploy: false });
      await requested.promise;
      if (reason === 'disconnect') bridge.disconnect();
      else
        defined(children[0]).emit(
          reason === 'spawn-error' ? 'error' : 'close',
          reason === 'spawn-error' ? Error('fixture secret stderr') : 255,
        );
      session.resolve(Response.json({ token: 'late token' }));
      await assert.rejects(
        pending,
        reason === 'spawn-error'
          ? /Could not start the SSH/
          : reason === 'ssh-close'
            ? /connection was lost/
            : /cancelled/,
      );
      assert.equal(bridge.status, 'offline');
      assert.equal(bridge.token, null);
      assert.equal(sockets.length, 0);
      assert.doesNotMatch(bridge.error || '', /fixture secret/);
    });
  }
});

test('disconnect while initial state is loading cannot open an event socket afterwards', async (t) => {
  const state = deferred<Response>(),
    requested = deferred();
  const { bridge, sockets } = fixture(t, {
    fetchImpl: async (url) => {
      if (url.endsWith('/api/session')) return Response.json({ token: 'test' });
      requested.resolve();
      return state.promise;
    },
  });
  const pending = bridge.connect({ deploy: false });
  await requested.promise;
  bridge.disconnect();
  state.resolve(Response.json({ messages: [{ id: 'last snapshot' }] }));
  await assert.rejects(pending, /cancelled/);
  assert.equal(bridge.status, 'offline');
  assert.equal(sockets.length, 0);
});

test('event disconnection reconnects after a delay without redeploying or discarding history', async (t) => {
  const { bridge, calls, sockets } = fixture(t);
  let preparations = 0;
  bridge.prepare = async () => {
    preparations++;
    return fixtureDeploymentResult;
  };
  await bridge.connect();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  defined(sockets[0]).emit('close');
  assert.equal(bridge.status, 'offline');
  assert.equal(defined(observedRecords(defined(bridge.cached).messages)[0]).id, 'from-vm');
  assert.match(defined(bridge.error), /event connection was lost/);
  const online = new Promise<void>((resolve) =>
    bridge.on('change', () => {
      if (bridge.status === 'online') resolve();
    }),
  );
  t.mock.timers.tick(4999);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await online;
  await bridge.connecting;
  assert.equal(calls.length, 2);
  assert.equal(preparations, 1);
  assert.equal(sockets.length, 2);
  defined(sockets[0]).emit('close');
  assert.equal(bridge.status, 'online');
});

test('state refresh shares requests, retains a two second cache and reports non-success responses', async (t) => {
  const { bridge, transport } = fixture(t);
  bridge.status = 'online';
  bridge.token = 'token';
  bridge.port = 1234;
  const gate = deferred<Response>();
  let requests = 0;
  transport.fetch = async () => {
    requests++;
    return gate.promise;
  };
  const first = bridge.refresh(),
    second = bridge.refresh();
  assert.equal(requests, 1);
  gate.resolve(Response.json({ messages: [{ id: 'cached' }] }));
  assert.strictEqual(await first, await second);
  await bridge.refresh();
  assert.equal(requests, 1);
  transport.fetch = async () => {
    requests++;
    return Response.json({ messages: [] });
  };
  bridge.cachedAt -= 2001;
  await bridge.refresh();
  assert.equal(requests, 2);
  transport.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(bridge.refresh(true), /VM state unavailable \(503\)/);
  assert.equal(bridge.refreshing, null);
});

test('fresh VM state clears an old connection error without reconnecting or replacing its conversation', async (t) => {
  const { bridge, transport, sockets, calls } = fixture(t);
  await bridge.connect({ deploy: false });
  const before = bridge.cached;
  bridge.error = 'An earlier state request failed';
  transport.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(bridge.refresh(true), /503/);
  assert.equal(bridge.error, 'An earlier state request failed');
  assert.equal(bridge.cached, before);
  transport.fetch = async () =>
    Response.json({ conversationId: 'original', messages: [{ id: 'preserved' }] });
  const state = await bridge.refresh(true);
  assert.equal(bridge.error, null);
  assert.equal(state.conversationId, 'original');
  assert.equal(bridge.status, 'online');
  assert.equal(calls.length, 1);
  bridge.error = 'A later request timed out';
  defined(sockets[0]).emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'notice', data: { message: 'Unrelated notice' } })),
  );
  assert.equal(bridge.error, 'A later request timed out');
  defined(sockets[0]).emit('message', Buffer.from(JSON.stringify({ type: 'state', data: state })));
  assert.equal(bridge.error, null);
  assert.deepEqual(defined(bridge.cached).messages, [{ id: 'preserved' }]);
  assert.equal(calls.length, 1);
});

test('late refresh responses cannot overwrite or publish state after a new connection succeeds', async (t) => {
  for (const phase of ['response', 'json']) {
    await t.test(phase, async (t) => {
      const oldResponse = deferred<Response>(),
        oldJson = deferred<unknown>(),
        oldStarted = deferred();
      const oldState = { messages: [{ id: 'old-VM' }] },
        newState = { messages: [{ id: 'new-VM' }] },
        tokens: (string | null)[] = [],
        states: unknown[] = [];
      let sessions = 0,
        stateRequests = 0,
        oldDecodes = 0;
      const old = Object.assign(Response.json({}), {
        json: async () => {
          oldDecodes++;
          oldStarted.resolve();
          return oldJson.promise;
        },
      });
      const { bridge, sockets } = fixture(t, {
        fetchImpl: async (url, options) => {
          if (url.endsWith('/api/session'))
            return Response.json({ token: `session-${++sessions}` });
          tokens.push(new Headers(options?.headers).get('X-Dant-Token'));
          if (++stateRequests === 1) {
            if (phase === 'response') {
              oldStarted.resolve();
              return oldResponse.promise;
            }
            return old;
          }
          return Response.json(newState);
        },
      });
      bridge.on('state', (state) => states.push(state));
      const previous = bridge.connect({ deploy: false }),
        rejected = assert.rejects(previous, /cancelled/);
      await oldStarted.promise;
      bridge.disconnect();
      const current = bridge.connect({ deploy: false });
      assert.deepEqual(await current, newState);
      assert.equal(sessions, 2);
      assert.equal(stateRequests, 2);
      assert.deepEqual(tokens, ['session-1', 'session-2']);
      oldJson.resolve(oldState);
      oldResponse.resolve(old);
      await rejected;
      assert.deepEqual(bridge.cached, newState);
      assert.deepEqual(states, [newState]);
      assert.equal(bridge.status, 'online');
      assert.equal(bridge.token, 'session-2');
      assert.equal(sockets.length, 1);
      assert.match(defined(sockets[0]).url, /token=session-2$/);
      assert.equal(oldDecodes, phase === 'json' ? 1 : 0);
    });
  }
});

test('a cancelled refresh cannot detach the new in-flight refresh or emit after close', async (t) => {
  const old = deferred<unknown>(),
    current = deferred<Response>(),
    started = deferred();
  const states: unknown[] = [];
  let requests = 0;
  const { bridge } = fixture(t, {
    fetchImpl: async () => {
      if (++requests === 1)
        return Object.assign(Response.json({}), {
          json: () => {
            started.resolve();
            return old.promise;
          },
        });
      return current.promise;
    },
  });
  bridge.on('state', (state) => states.push(state));
  bridge.status = 'online';
  bridge.token = 'old-token';
  bridge.port = 1234;
  const previous = bridge.refresh(true),
    rejected = assert.rejects(previous, /cancelled/);
  await started.promise;
  bridge.disconnect();
  bridge.status = 'online';
  bridge.token = 'new-token';
  const pending = bridge.refresh(true),
    shared = bridge.refreshing;
  old.resolve({ messages: [{ id: 'old' }] });
  await rejected;
  assert.strictEqual(bridge.refreshing, shared);
  assert.equal(requests, 2);
  assert.deepEqual(states, []);
  bridge.close();
  current.resolve(Response.json({ messages: [{ id: 'closed' }] }));
  await assert.rejects(pending, /cancelled/);
  assert.equal(bridge.cached, undefined);
  assert.deepEqual(states, []);
});

test('API requests validate destinations and never replay mutations after an unknown outcome', async (t) => {
  const { bridge, transport } = fixture(t);
  await assert.rejects(
    bridge.request('/api/state'),
    (error) => observedRecord(error).status === 503,
  );
  bridge.status = 'online';
  bridge.token = 'private token';
  bridge.port = 1234;
  for (const route of [
    'https://example.com',
    '//example.com/api/state',
    '/events',
    '/api/http://evil',
  ])
    await assert.rejects(bridge.request(route), /Invalid VM API/);
  let requests = 0;
  transport.fetch = async () => {
    requests++;
    throw Error('private token upstream diagnostic');
  };
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    await assert.rejects(
      bridge.request('/api/messages', { method }),
      (error) =>
        observedRecord(error).status === 502 &&
        observedRecord(error).unknownOutcome === (method !== 'GET') &&
        !errorMessage(error).includes('private token'),
    );
  }
  assert.equal(requests, 4);
  const controller = new AbortController();
  let forwarded: RequestInit | undefined;
  transport.fetch = async (_url, options) => {
    forwarded = options;
    return Response.json({ ok: true });
  };
  await bridge.request('/api/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dant-Token': 'untrusted' },
    body: '{}',
    signal: controller.signal,
  });
  assert.equal(new Headers(defined(forwarded).headers).get('X-Dant-Token'), 'private token');
  assert.equal(defined(forwarded).body, '{}');
  assert.strictEqual(defined(forwarded).signal, controller.signal);
});

test('prepare merges concurrent deployment and resets its latch after failure', async (t) => {
  const { bridge } = fixture(t),
    gate = deferred();
  let deployments = 0;
  bridge.deploy = async () => {
    deployments++;
    await gate.promise;
    throw Error('fixture install rejected');
  };
  const one = bridge.prepare(),
    two = bridge.prepare();
  gate.resolve();
  const results = await Promise.allSettled([one, two]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(deployments, 1);
  assert.equal(bridge.preparing, null);
  bridge.deploy = async () => {
    deployments++;
    return fixtureDeploymentResult;
  };
  await bridge.prepare();
  assert.equal(deployments, 2);
});

test('prepare forwards an exact explicit update option to deployment', async (t) => {
  const { bridge } = fixture(t),
    options: Parameters<VmBridge['prepare']>[1][] = [];
  bridge.deploy = async (_vm, value) => {
    options.push(value);
    return fixtureDeploymentResult;
  };
  await bridge.prepare();
  // @ts-expect-error Intentional malformed input must never authorize a work pause.
  await bridge.prepare(bridge.binding(), { updateRunningWork: 'true' });
  await bridge.prepare(bridge.binding(), { updateRunningWork: true });
  assert.deepEqual(options, [
    { updateRunningWork: false },
    { updateRunningWork: false },
    { updateRunningWork: true },
  ]);
});

test('an explicit preparation waits for automatic preparation and is not merged into its defer result', async (t) => {
  const { bridge } = fixture(t),
    gate = deferred(),
    options: Parameters<VmBridge['prepare']>[1][] = [];
  bridge.deploy = async (_vm, value) => {
    options.push(value);
    if (options.length === 1) {
      await gate.promise;
      throw Object.assign(Error('busy'), { updateDeferred: true });
    }
    return fixtureDeploymentResult;
  };
  const automatic = bridge.prepare(),
    manual = bridge.prepare(bridge.binding(), { updateRunningWork: true }),
    repeat = bridge.prepare(bridge.binding(), { updateRunningWork: true });
  gate.resolve();
  const results = await Promise.allSettled([automatic, manual, repeat]);
  assert.equal(results[0].status, 'rejected');
  assert.ok(results.slice(1).every((result) => result.status === 'fulfilled'));
  assert.deepEqual(options, [{ updateRunningWork: false }, { updateRunningWork: true }]);
  assert.equal(bridge.manualPreparationPending, null);
});

test('queued explicit preparation is cancelled on close, disconnect or VM profile changes', async (t) => {
  for (const action of ['close', 'disconnect', 'binding'] as const)
    await t.test(action, async (t) => {
      const { bridge } = fixture(t),
        gate = deferred();
      let deployments = 0;
      bridge.deploy = async () => {
        deployments++;
        await gate.promise;
        return fixtureDeploymentResult;
      };
      const automatic = bridge.prepare(),
        manual = bridge.prepare(bridge.binding(), { updateRunningWork: true });
      if (action === 'binding') {
        const before = bridge.binding();
        bridge.binding = () => ({ ...before, host: '192.0.2.99' });
      } else bridge[action]();
      gate.resolve();
      await automatic;
      await assert.rejects(manual, /connection changed/);
      assert.equal(deployments, 1);
    });
});

test('preparation subprocess streams bounded output and stdin without a shell', async (t) => {
  const { bridge, calls, children, dataDir } = fixture(t),
    input = path.join(dataDir, 'archive');
  fs.writeFileSync(input, 'archive bytes');
  const pending = bridge.run('fixture-tar', ['--safe'], { input });
  const child = children[0];
  let received = '';
  defined(child).stdin.on('data', (chunk: Buffer) => {
    received += chunk;
  });
  await once(defined(child).stdin, 'finish');
  defined(child).stdout.write('normal output');
  defined(child).stderr.write(' warning');
  defined(child).emit('close', 0);
  assert.equal(await pending, 'normal output warning');
  assert.equal(received, 'archive bytes');
  assert.equal(defined(calls[0]).options.shell, false);
  assert.equal(defined(calls[0]).options.cwd, bridge.projectRoot);
  assert.equal(defined(bridge.preparationChildren).size, 0);
  const large = bridge.run('fixture-tar', []);
  defined(children[1]).stdout.write('x'.repeat(7000));
  defined(children[1]).emit('close', 0);
  assert.equal((await large).length, 6000);
});

test('preparation reports spawn, active-work, missing-input, timeout and close failures', async (t) => {
  const { bridge, children, dataDir } = fixture(t);
  let pending = bridge.run('not-installed', []);
  defined(children.at(-1)).emit('error', Error('raw sensitive diagnostic'));
  await assert.rejects(
    pending,
    (error) => errorMessage(error) === 'Could not start VM preparation.',
  );
  pending = bridge.run('fixture-ssh', []);
  defined(children.at(-1)).stderr.write('DANT_WORK_ACTIVE');
  defined(children.at(-1)).emit('close', 75);
  await assert.rejects(
    pending,
    (error) => observedRecord(error).updateDeferred === true && /75/.test(errorMessage(error)),
  );
  pending = bridge.run('fixture-ssh', [], { input: path.join(dataDir, 'does-not-exist') });
  await assert.rejects(pending, { code: 'ENOENT' });
  assert.equal(defined(children.at(-1)).kills.length, 1);
  pending = bridge.run('fixture-ssh', [], { timeoutMs: 5 });
  await assert.rejects(pending, /timed out.*preserved/);
  assert.equal(defined(children.at(-1)).kills.length, 1);
  pending = bridge.run('fixture-ssh', []);
  defined(children.at(-1)).stdin.emit('error', Error('closed stdin'));
  bridge.close();
  await assert.rejects(pending, /VM preparation failed/);
  assert.equal(defined(bridge.preparationChildren).size, 0);
});

function archiveRecorder(bridge: VmBridge, onInstall: () => unknown = () => {}) {
  const calls: {
      command: string;
      args: readonly string[];
      options: Parameters<VmBridge['run']>[2];
    }[] = [],
    migrations: {
      state: Record<string, unknown>;
      manifest: Record<string, unknown>;
      files: string[];
    }[] = [],
    manifests: Record<string, unknown>[] = [];
  let probes = 0;
  bridge.deployedSource = async () =>
    ++probes % 2
      ? { sha256: null, active: true }
      : { sha256: defined(bridge.desiredSource), active: true };
  bridge.run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args[0] === '-cf') fs.writeFileSync(defined(args[1]), 'source archive fixture');
    if (args.at(-1) === 'deploy-manifest.json')
      manifests.push(
        observedRecord(
          JSON.parse(fs.readFileSync(path.join(defined(args[3]), 'deploy-manifest.json'), 'utf8')),
        ),
      );
    if (args.at(-1) === 'migration') {
      const directory = path.join(defined(args[3]), 'migration');
      migrations.push({
        state: observedRecord(
          JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')),
        ),
        manifest: observedRecord(
          JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')),
        ),
        files: fs.existsSync(path.join(directory, 'files'))
          ? fs.readdirSync(path.join(directory, 'files'))
          : [],
      });
    }
    if (command === 'ssh') {
      assert.ok(fs.existsSync(defined(options.input)));
      await onInstall();
    }
    return '';
  };
  return { calls, migrations, manifests };
}

test('the remote installation receives a fixed update flag only for an explicitly authorized reconnect', async (t) => {
  const { bridge, projectRoot } = fixture(t);
  resources(projectRoot);
  const { calls } = archiveRecorder(bridge);
  await bridge.deploy(bridge.binding());
  // @ts-expect-error Intentional malformed input must not become an installer flag.
  await bridge.deploy(bridge.binding(), { updateRunningWork: '--anything' });
  await bridge.deploy(bridge.binding(), { updateRunningWork: true });
  const commands = calls.filter((call) => call.command === 'ssh').map((call) => call.args.at(-1));
  assert.ok(commands.slice(0, 2).every((command) => defined(command).endsWith('"$stage"')));
  assert.ok(defined(commands[2]).endsWith('"$stage" --update-running-work'));
});
test('deployment uses a source allowlist, preserves host data and migrates only once after confirmation', async (t) => {
  const { bridge, dataDir, projectRoot } = fixture(t);
  resources(projectRoot);
  const original = JSON.stringify({
    messages: [{ id: 'history', text: 'retain this' }],
    settings: { vm: { host: 'old', keyPath: 'private path' }, language: 'en' },
  });
  fs.writeFileSync(path.join(dataDir, 'state.json'), original);
  fs.mkdirSync(path.join(dataDir, 'files'));
  fs.writeFileSync(path.join(dataDir, 'files', 'result.txt'), 'keep this attachment');
  // These are deliberate isolated sentinels, never real host credentials or runtime files.
  for (const name of [
    'data/private-key',
    '.dant-codex/credential-sentinel',
    'node_modules/excluded',
    'runtime/node.exe',
  ]) {
    fs.mkdirSync(path.dirname(path.join(projectRoot, name)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, name), 'must not enter source archive');
  }
  const recorded = archiveRecorder(bridge);
  await bridge.deploy(bridge.binding());
  const sourceCall = recorded.calls.find((call) => call.args[0] === '-cf');
  assert.ok(defined(sourceCall).args.includes('src'));
  assert.ok(defined(sourceCall).args.includes('dist'));
  assert.ok(defined(sourceCall).args.includes('vm/desktop_mcp.py'));
  assert.ok(defined(sourceCall).args.includes('LICENSE'));
  assert.ok(
    defined(sourceCall)
      .args.slice(4)
      .every(
        (name) =>
          !['data', '.dant-codex', 'node_modules', 'runtime'].some((excluded) =>
            name.startsWith(excluded),
          ),
      ),
  );
  assert.equal(recorded.migrations.length, 1);
  assert.equal(
    defined(observedRecords(defined(recorded.migrations[0]).state.messages)[0]).text,
    'retain this',
  );
  assert.deepEqual(observedRecord(defined(recorded.migrations[0]).state.settings).vm, {
    host: '',
    user: 'dant',
    port: 22,
    keyPath: '',
    knownHosts: '',
  });
  assert.equal(observedRecord(defined(recorded.migrations[0]).state.settings).language, 'en');
  assert.deepEqual(defined(recorded.migrations[0]).files, ['result.txt']);
  const digest = createHash('sha256').update(original).digest('hex');
  assert.equal(defined(recorded.migrations[0]).manifest.id, digest);
  assert.equal(defined(recorded.migrations[0]).manifest.messages, 1);
  assert.equal(defined(recorded.manifests[0]).schemaVersion, 2);
  assert.equal(defined(recorded.manifests[0]).sha256, vmSourceFingerprint(projectRoot));
  const backups = fs.readdirSync(path.join(dataDir, 'migration-backups'));
  assert.equal(backups.length, 1);
  const backup = path.join(dataDir, 'migration-backups', defined(backups[0]));
  assert.equal(fs.readFileSync(path.join(backup, 'state.json'), 'utf8'), original);
  assert.equal(
    fs.readFileSync(path.join(backup, 'files/result.txt'), 'utf8'),
    'keep this attachment',
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), original);
  const receipt = observedRecord(
    JSON.parse(fs.readFileSync(path.join(dataDir, 'vm-migration.json'), 'utf8')),
  );
  assert.equal(receipt.id, digest);
  assert.equal(receipt.host, '192.0.2.15');
  assert.ok(!fs.readdirSync(dataDir).some((name) => name.startsWith('deploy-')));
  await bridge.deploy(bridge.binding());
  assert.equal(recorded.migrations.length, 1);
  assert.equal(fs.readdirSync(path.join(dataDir, 'migration-backups')).length, 1);
});

test('failed deployment leaves a backup and source state intact, without a success receipt', async (t) => {
  const { bridge, dataDir, projectRoot } = fixture(t);
  resources(projectRoot);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{"messages":[{"id":"preserved"}]}');
  archiveRecorder(bridge, async () => {
    throw Error('remote install failed');
  });
  await assert.rejects(bridge.deploy(bridge.binding()), /remote install failed/);
  assert.equal(fs.existsSync(path.join(dataDir, 'vm-migration.json')), false);
  assert.equal(
    defined(
      observedRecords(
        observedRecord(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')))
          .messages,
      )[0],
    ).id,
    'preserved',
  );
  assert.equal(fs.readdirSync(path.join(dataDir, 'migration-backups')).length, 1);
  assert.ok(!fs.readdirSync(dataDir).some((name) => name.startsWith('deploy-')));
});

test('missing build resources and invalid legacy state fail before remote installation', async (t) => {
  const { bridge, dataDir, projectRoot, calls } = fixture(t);
  await assert.rejects(bridge.deploy(bridge.binding()), /Build resources are missing: src/);
  assert.equal(calls.length, 0);
  assert.ok(!fs.readdirSync(dataDir).some((name) => name.startsWith('deploy-')));
  resources(projectRoot);
  const recorded = archiveRecorder(bridge);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{');
  await assert.rejects(bridge.deploy(bridge.binding()), SyntaxError);
  assert.equal(
    recorded.calls.some((call) => call.command === 'ssh'),
    false,
  );
  assert.equal(fs.existsSync(path.join(dataDir, 'vm-migration.json')), false);
});

test('source identity depends on file names and bytes, never filesystem timestamps', (t) => {
  const { projectRoot } = fixture(t);
  resources(projectRoot);
  const first = vmSourceFingerprint(projectRoot),
    file = path.join(projectRoot, 'src/server.mts');
  fs.utimesSync(file, new Date(1), new Date(2));
  assert.equal(vmSourceFingerprint(projectRoot), first);
  fs.appendFileSync(file, '\nchanged');
  assert.notEqual(vmSourceFingerprint(projectRoot), first);
  fs.renameSync(file, path.join(projectRoot, 'src/renamed.mjs'));
  assert.notEqual(vmSourceFingerprint(projectRoot), first);
});

test('already deployed content skips archive upload, installation and pauses', async (t) => {
  const { bridge, projectRoot } = fixture(t);
  resources(projectRoot);
  let probes = 0;
  bridge.deployedSource = async () => {
    probes++;
    return { sha256: vmSourceFingerprint(projectRoot), active: true };
  };
  bridge.run = () => assert.fail('Matching source must not run tar or installer');
  assert.equal((await bridge.deploy(bridge.binding(), { updateRunningWork: true })).current, true);
  assert.equal(probes, 1);
});

test('a binding change during archive preparation cannot install old source into another VM', async (t) => {
  const { bridge, projectRoot, dataDir } = fixture(t);
  resources(projectRoot);
  const recorder = archiveRecorder(bridge),
    run = bridge.run;
  bridge.run = async (command, args, options) => {
    await run(command, args, options);
    if (args[0] === '-cf') {
      const file = path.join(dataDir, 'vm.json'),
        binding = observedRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
      binding.host = '192.0.2.99';
      fs.writeFileSync(file, JSON.stringify(binding));
      bridge.disconnect();
    }
    return '';
  };
  await assert.rejects(bridge.deploy(bridge.binding()), /connection changed/);
  assert.equal(
    recorder.calls.some((call) => call.command === 'ssh'),
    false,
  );
  assert.ok(!fs.readdirSync(dataDir).some((name) => name.startsWith('deploy-')));
});

test('unknown deployment is durable across bridge restart and only read-only remote confirmation clears it', async (t) => {
  const { bridge, dataDir, projectRoot } = fixture(t);
  resources(projectRoot);
  archiveRecorder(bridge, () => {
    throw Error('SSH disconnected during installation');
  });
  await assert.rejects(
    bridge.deploy(bridge.binding()),
    (error) => observedRecord(error).unknownOutcome === true,
  );
  const file = path.join(dataDir, 'vm-update-attempts.json'),
    saved = observedRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(observedRecords(saved.entries).length, 1);
  assert.equal(JSON.stringify(saved).includes('192.0.2.15'), false);
  const restarted = new VmBridge({ dataDir, projectRoot });
  t.after(() => restarted.close());
  restarted.deployedSource = async () => ({ sha256: null, active: true });
  restarted.run = () => assert.fail('An unknown installation must not be resent after restart');
  await assert.rejects(
    restarted.deploy(restarted.binding()),
    (error) => observedRecord(error).unknownOutcome === true,
  );
  assert.deepEqual(observedRecord(JSON.parse(fs.readFileSync(file, 'utf8'))), saved);
  fs.appendFileSync(path.join(projectRoot, 'src/server.mts'), 'new desktop version');
  await assert.rejects(
    restarted.deploy(restarted.binding()),
    (error) => observedRecord(error).unknownOutcome === true,
  );
  assert.deepEqual(
    observedRecord(JSON.parse(fs.readFileSync(file, 'utf8'))),
    saved,
    'a new source hash cannot bypass an older unknown update on the same VM',
  );
  fs.writeFileSync(path.join(projectRoot, 'src/server.mts'), 'fixture src/server.mts');
  restarted.deployedSource = async () => ({
    sha256: vmSourceFingerprint(projectRoot),
    active: true,
  });
  assert.equal((await restarted.deploy(restarted.binding())).current, true);
  assert.equal(
    observedRecords(observedRecord(JSON.parse(fs.readFileSync(file, 'utf8'))).entries).length,
    0,
  );
});

test('invalid or full unknown-update receipts fail closed without overwriting saved evidence', async (t) => {
  const { bridge, dataDir, projectRoot } = fixture(t);
  resources(projectRoot);
  bridge.deployedSource = async () => ({ sha256: null, active: true });
  bridge.run = () => assert.fail('Invalid receipts must prevent mutation');
  const file = path.join(dataDir, 'vm-update-attempts.json');
  for (const raw of [
    'not json',
    JSON.stringify({ schemaVersion: 1, entries: [{ binding: 'private host', source: 'bad' }] }),
  ]) {
    fs.writeFileSync(file, raw);
    await assert.rejects(
      bridge.deploy(bridge.binding()),
      (error) => observedRecord(error).unknownOutcome === true,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
  const entries = Array.from({ length: 64 }, (_, i) => ({
    binding: createHash('sha256').update(String(i)).digest('hex'),
    source: 'a'.repeat(64),
  }));
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries }));
  const raw = fs.readFileSync(file, 'utf8');
  assert.throws(
    () => bridge.updateAttempts(bridge.binding(), 'b'.repeat(64), 'start'),
    (error) => observedRecord(error).unknownOutcome === true,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('a definitely deferred installation permits a later idle attempt and preserves exact guard diagnostics', async (t) => {
  const { bridge, children, projectRoot, dataDir } = fixture(t);
  resources(projectRoot);
  let probes = 0;
  bridge.deployedSource = async () => {
    probes++;
    return { sha256: null, active: true };
  };
  const run = bridge.run;
  bridge.run = async (command, args, options) => {
    if (command !== 'ssh') {
      if (args[0] === '-cf') fs.writeFileSync(defined(args[1]), 'fixture');
      return '';
    }
    const pending = run.call(bridge, command, args, options);
    defined(children.at(-1)).stderr.write(
      'PRIVATE DETAIL\nDANT_WORK_ACTIVE\nDANT_UPDATE_DEFERRED:executor-offline:final\n',
    );
    defined(children.at(-1)).emit('close', 79);
    return pending;
  };
  await assert.rejects(
    bridge.deploy(bridge.binding()),
    (error) =>
      observedRecord(error).updateDeferred === true &&
      observedRecord(error).updateReason === 'executor-offline' &&
      observedRecord(error).updateGuardReason === 'executor-offline' &&
      observedRecord(error).updateStage === 'final' &&
      !errorMessage(error).includes('PRIVATE'),
  );
  assert.equal(
    observedRecords(
      observedRecord(
        JSON.parse(fs.readFileSync(path.join(dataDir, 'vm-update-attempts.json'), 'utf8')),
      ).entries,
    ).length,
    0,
  );
  assert.equal(probes, 1);
});

test('a confirmed pre-install guard rejection is distinct from an unknown pause or rollback', async (t) => {
  for (const [marker, notInstalled] of [
    ['work-still-active:final', true],
    ['state-invalid:initial', true],
    ['pause-unconfirmed:pause', false],
    ['saved-pause-unconfirmed:saved-pause', false],
    ['work-still-active:rollback', false],
  ]) {
    const { bridge, children, projectRoot, dataDir } = fixture(t);
    resources(projectRoot);
    bridge.deployedSource = async () => ({ sha256: null, active: true });
    const run = bridge.run;
    bridge.run = async (command, args, options) => {
      if (command !== 'ssh') {
        if (args[0] === '-cf') fs.writeFileSync(defined(args[1]), 'fixture');
        return '';
      }
      const pending = run.call(bridge, command, args, options);
      defined(children.at(-1)).stderr.write('DANT_UPDATE_FAILED:' + marker + '\n');
      defined(children.at(-1)).emit('close', 1);
      return pending;
    };
    await assert.rejects(
      bridge.deploy(bridge.binding()),
      (error) =>
        observedRecord(error).updateNotInstalled === notInstalled &&
        (notInstalled
          ? observedRecord(error).unknownOutcome !== true
          : observedRecord(error).unknownOutcome === true),
    );
    assert.equal(
      observedRecords(
        observedRecord(
          JSON.parse(fs.readFileSync(path.join(dataDir, 'vm-update-attempts.json'), 'utf8')),
        ).entries,
      ).length,
      notInstalled ? 0 : 1,
    );
  }
});

test('automatic deferred deployment keeps the old service connected and confirms its actual remote version', async (t) => {
  const { bridge, requests } = fixture(t, {
    versionImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ version: '0.4.7-beta.5' });
    },
  });
  bridge.serviceUpdate.targetVersion = '0.4.7-beta.6';
  bridge.prepare = async () => {
    throw Object.assign(Error('busy'), { updateDeferred: true, updateReason: 'work-active' });
  };
  const notices: unknown[] = [];
  bridge.on('event', (event) => notices.push(event));
  await bridge.connect({ autoUpdate: true });
  assert.equal(bridge.status, 'online');
  assert.deepEqual(bridge.serviceUpdate, {
    status: 'pending',
    targetVersion: '0.4.7-beta.6',
    runningVersion: '0.4.7-beta.5',
    confirmed: true,
    reason: 'work-active',
  });
  assert.equal(requests.filter((value) => value.url.endsWith('/api/version')).length, 1);
  assert.deepEqual(notices, []);
  bridge.disconnect();
  assert.equal(bridge.serviceUpdate.confirmed, false);
});

test('unknown automatic updates connect to existing chat without treating a matching version as deployment success', async (t) => {
  const { bridge } = fixture(t);
  bridge.serviceUpdate.targetVersion = '0.4.7-beta.6';
  bridge.prepare = async () => {
    throw Object.assign(Error('unconfirmed'), { unknownOutcome: true });
  };
  await bridge.connect({ autoUpdate: true });
  assert.equal(bridge.serviceUpdate.status, 'failed');
  assert.equal(bridge.serviceUpdate.reason, 'update-unconfirmed');
  assert.equal(bridge.serviceUpdate.confirmed, true);
  assert.equal(bridge.status, 'online');
});

test('remote version confirmation can recover without installing and stale replies cannot confirm a new connection', async (t) => {
  let available = false;
  const { bridge, transport } = fixture(t, {
    versionImpl: async () =>
      available ? Response.json({ version: '0.4.7-beta.6' }) : Response.json({}, { status: 503 }),
  });
  bridge.serviceUpdate.targetVersion = '0.4.7-beta.6';
  bridge.prepare = async () => {
    return fixtureDeploymentResult;
  };
  await bridge.connect({ autoUpdate: true });
  assert.equal(bridge.serviceUpdate.reason, 'version-unconfirmed');
  available = true;
  await bridge.confirmServiceVersion();
  assert.equal(bridge.serviceUpdate.status, 'current');
  assert.equal(bridge.serviceUpdate.confirmed, true);
  const gate = deferred<Response>();
  transport.fetch = () => gate.promise;
  const pending = bridge.confirmServiceVersion();
  bridge.disconnect();
  gate.resolve(Response.json({ version: '99.0.0' }));
  await pending;
  assert.equal(bridge.serviceUpdate.runningVersion, '0.4.7-beta.6');
  assert.equal(bridge.serviceUpdate.confirmed, false);
});

test('read-only deployment probe rejects invalid responses and never uploads source', async (t) => {
  const { bridge } = fixture(t);
  let calls = 0;
  bridge.run = async (command, args, options) => {
    calls++;
    assert.equal(command, 'ssh');
    assert.equal(defined(options).input, undefined);
    assert.equal(defined(args.at(-1)).includes('/api/connect'), false);
    return '{"sha256":null,"active":true}';
  };
  assert.deepEqual(await bridge.deployedSource(), { sha256: null, active: true });
  assert.equal(calls, 1);
  for (const raw of [
    'bad',
    '{}',
    '{"sha256":"bad","active":true}',
    '{"sha256":null,"active":"true"}',
  ]) {
    bridge.run = async () => raw;
    await assert.rejects(
      bridge.deployedSource(),
      (error) => observedRecord(error).updateRetryable === true,
    );
  }
});
