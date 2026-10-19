import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VmBridge } from '../../src/computer/vm-bridge.mts';
import { observedRecord } from '../support/service-fixtures.mts';

interface Reply {
  route: string;
  value?: unknown;
  body?: unknown;
  error?: boolean;
  status?: number;
}

const idle = () => ({
  active: null,
  call: null,
  queue: [],
  takeover: false,
  worker: { status: 'online' },
  computer: { status: 'dant', sessionId: null },
  messages: [],
  workTasks: [],
});
const get = (value: unknown) => ({ route: '/api/state', value });
const pause = () => ({ route: '/api/tasks/pause', value: { ok: true }, body: {} });
const witness = () => ({
  route: '/api/connect',
  value: { ok: true },
  body: { idleRecovery: true },
});
function fixture(t: NodeTestContext, replies: Reply[]) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(root, 'vm-pause-')),
    calls: { route: string; body: unknown }[] = [];
  const make = () => {
    const bridge = new VmBridge({
      dataDir,
      projectRoot: process.cwd(),
      fetchImpl: async (url, options) => {
        const route = new URL(typeof url === 'string' || url instanceof URL ? url : url.url)
          .pathname;
        let body: unknown;
        if (options?.method === 'POST') {
          assert.equal(typeof options.body, 'string');
          assert.ok(typeof options.body === 'string');
          body = observedRecord(JSON.parse(options.body));
        }
        calls.push({ route, body });
        const expected = replies.shift();
        assert.ok(expected, 'Unexpected request ' + route);
        assert.equal(route, expected.route);
        assert.deepEqual(body, expected.body);
        if (expected.error) throw Error('private network details');
        return Response.json(expected.value, { status: expected.status || 200 });
      },
    });
    bridge.binding = () => ({
      host: '192.0.2.1',
      user: 'dant',
      port: 22,
      keyPath: 'fixture-key',
      knownHosts: 'fixture-host',
    });
    bridge.status = 'online';
    bridge.port = 12345;
    bridge.token = 'fixture-token';
    return bridge;
  };
  const bridge = make();
  t.after(() => {
    bridge.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { bridge, calls, replies, dataDir, make };
}

test('explicit install and Exit pause work, retain task history and confirm authoritative idle state', async (t) => {
  for (const reason of ['install', 'exit'] as const) {
    const saved = { ...idle(), workTasks: [{ id: 'saved', turnId: 'turn', status: 'paused' }] },
      f = fixture(t, [
        get({ ...idle(), active: { turnId: 'turn' } }),
        pause(),
        get(saved),
        pause(),
        get(saved),
        witness(),
        get(saved),
      ]);
    const state = await f.bridge.pauseWorkForUpdate({ reason });
    assert.deepEqual(state, saved);
    assert.equal(f.replies.length, 0);
    assert.equal(f.bridge.pauseReceipt(f.bridge.binding()), false);
    assert.ok(
      f.calls.every((call) => !call.route.includes('delete') && !call.route.includes('resume')),
    );
  }
});

test('legacy continuing history is paused with its precise task and turn ownership', async (t) => {
  const old = {
      ...idle(),
      workTasks: [
        { id: 'old/task', turnId: 'finished-turn', status: 'continuing', plan: { steps: [] } },
      ],
    },
    saved = { ...idle(), workTasks: [{ ...old.workTasks[0], status: 'paused' }] };
  const f = fixture(t, [
    get(old),
    pause(),
    get(old),
    pause(),
    get(old),
    {
      route: '/api/tasks/old%2Ftask/pause',
      body: { kind: 'work', turnId: 'finished-turn' },
      value: { ok: true, paused: true },
    },
    witness(),
    get(saved),
  ]);
  assert.deepEqual(await f.bridge.pauseWorkForUpdate(), saved);
  assert.equal(f.replies.length, 0);
});

test('a current call stops once through its known owner before the second saved-work pause', async (t) => {
  const call = { ...idle(), call: { id: 'call-one' } };
  const f = fixture(t, [
    get(call),
    pause(),
    get(call),
    { route: '/api/call/stop', body: { callId: 'call-one' }, value: { stopped: true } },
    pause(),
    get(idle()),
    witness(),
    get(idle()),
  ]);
  await f.bridge.pauseWorkForUpdate({ reason: 'exit' });
  assert.equal(f.replies.length, 0);
});

test('explicit Exit returns the exact current human-control lease before pausing', async (t) => {
  const human = {
    ...idle(),
    takeover: true,
    computer: { status: 'human', sessionId: 'owned-session' },
  };
  const f = fixture(t, [
    get(human),
    {
      route: '/api/takeover',
      body: { enabled: false, sessionId: 'owned-session' },
      value: { ok: true },
    },
    get(idle()),
    pause(),
    get(idle()),
    pause(),
    get(idle()),
    witness(),
    get(idle()),
  ]);
  await f.bridge.pauseWorkForUpdate({ reason: 'exit' });
  assert.equal(f.replies.length, 0);
});

test('a changed call is preserved and prevents installation or suspension', async (t) => {
  const f = fixture(t, [
    get({ ...idle(), call: { id: 'first' } }),
    pause(),
    get({ ...idle(), call: { id: 'replacement' } }),
  ]);
  await assert.rejects(f.bridge.pauseWorkForUpdate(), { code: 'vm_pause_unconfirmed' });
  assert.equal(f.calls.filter((call) => call.route === '/api/call/stop').length, 0);
  assert.equal(f.bridge.pauseReceipt(f.bridge.binding()), true);
});

test('unconfirmed pauses persist across restarts and are only reconciled through a fresh idle read', async (t) => {
  const f = fixture(t, [
    get({ ...idle(), active: { turnId: 'turn' } }),
    { ...pause(), error: true },
  ]);
  await assert.rejects(f.bridge.pauseWorkForUpdate(), { unknownOutcome: true });
  assert.equal(f.bridge.pauseReceipt(f.bridge.binding()), true);
  const resumed = f.make();
  t.after(() => resumed.close());
  f.replies.push(get({ ...idle(), active: { turnId: 'turn' } }));
  await assert.rejects(resumed.pauseWorkForUpdate(), { unknownOutcome: true });
  assert.equal(f.calls.filter((call) => call.route === '/api/tasks/pause').length, 1);
  f.replies.push(get(idle()));
  assert.deepEqual(await resumed.pauseWorkForUpdate(), idle());
  assert.equal(f.calls.filter((call) => call.route === '/api/tasks/pause').length, 1);
  assert.equal(resumed.pauseReceipt(resumed.binding()), false);
  const text = fs.readFileSync(path.join(f.dataDir, 'vm-work-pause.json'), 'utf8');
  assert.doesNotMatch(text, /fixture-key|192\.0\.2|turn|token/);
});

test('pending submissions, control leases and invalid state prevent all mutations', async (t) => {
  for (const current of [
    { ...idle(), workTasks: [{ status: 'unknown' }] },
    { ...idle(), messages: [{ submission: 'unknown' }] },
    {
      ...idle(),
      workTasks: [{ status: 'continuing', continuation: { dispatch: { phase: 'acknowledged' } } }],
    },
    { ...idle(), computer: { status: 'human' } },
    { ...idle(), computer: { status: 'dant', pending: true } },
    { ...idle(), worker: { status: 'offline' } },
    { ...idle(), active: undefined },
  ]) {
    const f = fixture(t, [get(current)]);
    await assert.rejects(f.bridge.pauseWorkForUpdate());
    assert.equal(f.calls.length, 1);
    assert.equal(f.bridge.pauseReceipt(f.bridge.binding()), false);
  }
});

test('fresh activity after pauses blocks updating or suspending the VM', async (t) => {
  const f = fixture(t, [
    get(idle()),
    pause(),
    get(idle()),
    pause(),
    get(idle()),
    witness(),
    get({ ...idle(), active: { turnId: 'new-turn' } }),
  ]);
  await assert.rejects(f.bridge.pauseWorkForUpdate(), { code: 'vm_pause_unconfirmed' });
  assert.equal(f.bridge.pauseReceipt(f.bridge.binding()), true);
});

test('concurrent install and Exit share a single pause operation', async (t) => {
  const f = fixture(t, [
    get(idle()),
    pause(),
    get(idle()),
    pause(),
    get(idle()),
    witness(),
    get(idle()),
  ]);
  const one = f.bridge.pauseWorkForUpdate(),
    two = f.bridge.pauseWorkForUpdate({ reason: 'exit' });
  assert.strictEqual(one, two);
  await Promise.all([one, two]);
  assert.equal(f.calls.length, 7);
});

test('a changed bridge generation aborts before sending a pause', async (t) => {
  const f = fixture(t, [get(idle())]);
  const pending = f.bridge.pauseWorkForUpdate();
  f.bridge.generation++;
  await assert.rejects(pending, { code: 'vm_pause_unconfirmed' });
  assert.equal(f.calls.length, 1);
});

test('malformed persisted pause metadata never authorizes another interruption', async (t) => {
  const f = fixture(t, [get(idle())]);
  fs.writeFileSync(path.join(f.dataDir, 'vm-work-pause.json'), '{invalid');
  await assert.rejects(f.bridge.pauseWorkForUpdate(), { code: 'vm_pause_unconfirmed' });
  assert.equal(f.calls.length, 1);
});
