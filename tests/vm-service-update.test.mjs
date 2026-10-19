import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VmServiceUpdateLoop,
  serviceUpdateIdle,
  serviceUpdatePaused,
} from '../src/computer/vm-service-update.mts';

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
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { resolve, promise };
};
function fixture(t, { online = false, status = 'checking', reason = null } = {}) {
  let binding = { host: '192.0.2.10' },
    allowed = true;
  const timers = new Map(),
    calls = [];
  const bridge = {
    status: online ? 'online' : 'offline',
    generation: 1,
    serviceUpdate: { status, reason },
    refresh: async () => idle(),
  };
  const loop = new VmServiceUpdateLoop({
    bridge,
    binding: () => binding,
    allowed: () => allowed,
    connect: async (options) => {
      calls.push(options);
      if (bridge.connect) await bridge.connect(options);
      else {
        bridge.status = 'online';
        bridge.serviceUpdate = { status: 'current', reason: 'source-current' };
      }
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, unref() {} };
      timers.set(timer, timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
  });
  t.after(() => loop.close());
  return {
    bridge,
    loop,
    timers,
    calls,
    setBinding: (value) => (binding = value),
    setAllowed: (value) => (allowed = value),
    fire: async () => {
      const timer = [...timers.values()][0];
      assert.ok(timer);
      timers.delete(timer);
      timer.callback();
      await loop.pending;
    },
  };
}

test('automatic service upgrades require fresh fully idle execution and control state', () => {
  assert.equal(serviceUpdateIdle(idle()), true);
  for (const change of [
    { active: {} },
    { active: undefined },
    { call: {} },
    { queue: null },
    { queue: ['work'] },
    { takeover: true },
    { acquiring: true },
    { worker: { status: 'offline' } },
    { worker: { status: 'connecting' } },
    { computer: { status: 'human' } },
    { computer: { status: 'dant', sessionId: 'lease' } },
    { computer: { status: 'dant', pending: true } },
    { messages: null },
    { workTasks: null },
  ])
    assert.equal(serviceUpdateIdle({ ...idle(), ...change }), false, JSON.stringify(change));
  for (const entry of [
    { status: 'continuing' },
    { status: 'running' },
    { status: 'queued' },
    { status: 'accepted' },
    { status: 'pausing' },
    { status: 'unknown' },
    { status: 'waiting_user' },
    { status: 'paused', unknownOutcome: true },
    { status: 'paused', submission: 'submitting' },
    { status: 'paused', continuation: { invalid: true } },
    { status: 'paused', continuation: { dispatch: { phase: 'acknowledged' } } },
  ])
    for (const key of ['messages', 'workTasks'])
      assert.equal(serviceUpdateIdle({ ...idle(), [key]: [entry] }), false, JSON.stringify(entry));
  for (const entry of [
    { status: 'paused' },
    { status: 'waiting_user', executionEndedAt: 123 },
    { status: 'completed' },
    { status: 'review' },
    { status: 'cancelled' },
  ])
    assert.equal(serviceUpdateIdle({ ...idle(), workTasks: [entry] }), true);
  for (const executionEndedAt of [true, '123', -1, 0, NaN, Infinity])
    assert.equal(
      serviceUpdateIdle({ ...idle(), workTasks: [{ status: 'waiting_user', executionEndedAt }] }),
      false,
    );
});

test('unknown snapshots are narrowed record by record and malformed history never authorizes an update', () => {
  for (const guard of [serviceUpdateIdle, serviceUpdatePaused]) {
    for (const snapshot of [null, undefined, false, 0, 'online', [], {}])
      assert.equal(guard(snapshot), false);
    for (const change of [
      { worker: null },
      { worker: [] },
      { worker: 'online' },
      { computer: null },
      { computer: [] },
      { computer: 'dant' },
    ])
      assert.equal(guard({ ...idle(), ...change }), false);
    for (const entry of [
      null,
      undefined,
      false,
      0,
      'paused',
      [],
      { status: 'paused', continuation: [] },
      { status: 'paused', continuation: false },
      { status: 'paused', continuation: 'ended' },
    ])
      for (const key of ['messages', 'workTasks'])
        assert.equal(guard({ ...idle(), [key]: [entry] }), false);
    assert.equal(guard({ ...idle(), workTasks: [{ status: 'paused', continuation: null }] }), true);
  }
  const stopped = { ...idle(), worker: { status: 'offline' } };
  assert.equal(serviceUpdateIdle(stopped), false);
  assert.equal(serviceUpdatePaused(stopped), true);
  assert.equal(serviceUpdatePaused({ ...stopped, worker: { status: 'connecting' } }), false);
});

test('first connection failure retries with bounded backoff and one passive update intent', async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.bridge.connect = async () => {
    if (++attempts < 5) {
      f.bridge.serviceUpdate = { status: 'failed', reason: 'connection-unavailable' };
      throw Error('offline');
    }
    f.bridge.status = 'online';
    f.bridge.serviceUpdate = { status: 'current' };
  };
  await f.loop.start();
  for (const delay of [5000, 10000, 20000, 40000]) {
    assert.equal([...f.timers.values()][0].ms, delay);
    await f.fire();
  }
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every((value) => value.deploy === true && value.automatic === true));
  assert.equal(f.loop.checked, true);
  assert.equal(f.timers.size, 0);
});

test('finished-call conversation receipts do not keep an idle computer busy', () => {
  const receipt = {
    role: 'user',
    workKind: 'conversation',
    voiceCallId: 'ended-call',
    status: 'accepted',
  };
  assert.equal(serviceUpdateIdle({ ...idle(), messages: [receipt] }), true);
  for (const change of [
    { turnId: 'execution' },
    { workId: 'work' },
    { unknownOutcome: true },
    { submission: 'unknown' },
    { continuation: { dispatch: { phase: 'acknowledged' } } },
  ])
    assert.equal(serviceUpdateIdle({ ...idle(), messages: [{ ...receipt, ...change }] }), false);
  assert.equal(
    serviceUpdateIdle({ ...idle(), messages: [receipt], call: { id: 'ended-call' } }),
    false,
  );
});

test('ordinary transport loss reconnects without uploading or pausing work', async (t) => {
  const f = fixture(t);
  await f.loop.start();
  f.bridge.status = 'offline';
  f.loop.changed();
  await f.fire();
  assert.deepEqual(f.calls, [
    { deploy: true, automatic: true },
    { deploy: false, automatic: true },
  ]);
});

test('busy update stays pending and only a fresh idle snapshot enables one deployment', async (t) => {
  const f = fixture(t, { online: true, status: 'pending', reason: 'work-active' });
  let reads = 0,
    state = { ...idle(), active: { turnId: 'working' } };
  f.bridge.refresh = async (force) => {
    assert.equal(force, true);
    reads++;
    return state;
  };
  await f.loop.start();
  assert.equal(f.calls.length, 0);
  assert.equal(reads, 1);
  state = idle();
  await f.fire();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { deploy: true, automatic: true });
  assert.equal(reads, 2);
  assert.equal(f.timers.size, 0);
});

test('a safely stopped executor remains connected without update or recovery requests', async (t) => {
  const f = fixture(t, { online: true, status: 'pending', reason: 'executor-offline' });
  f.bridge.refresh = async () => ({ ...idle(), worker: { status: 'offline' } });
  await f.loop.start();
  await f.fire();
  assert.deepEqual(f.calls, []);
  assert.equal(f.bridge.serviceUpdate.reason, 'executor-offline');
});

test('unknown installer outcomes only reconcile read-only and are never installed again automatically', async (t) => {
  for (const online of [true, false]) {
    const f = fixture(t, { online, status: 'failed', reason: 'update-unconfirmed' });
    let probes = 0;
    f.bridge.reconcileServiceUpdate = async () => {
      probes++;
    };
    f.bridge.connect = async () => {
      f.bridge.status = 'online';
    };
    await f.loop.start();
    await f.fire();
    assert.ok(probes >= 2);
    assert.ok(f.calls.every((options) => options.deploy === false));
    assert.equal(f.calls.length, online ? 0 : 1);
  }
});

test('version confirmation failure retries a read without running deployment again', async (t) => {
  const f = fixture(t, { online: true, status: 'pending', reason: 'version-unconfirmed' });
  f.bridge.sourceVerified = true;
  let reads = 0;
  f.bridge.confirmServiceVersion = async () => {
    reads++;
    f.bridge.serviceUpdate = { status: 'current' };
  };
  await f.loop.start();
  assert.equal(reads, 1);
  assert.equal(f.calls.length, 0);
});

test('configuration change, generation change and close cancel late idle observations', async (t) => {
  for (const reason of ['binding', 'generation', 'close']) {
    const f = fixture(t, { online: true, status: 'pending', reason: 'work-active' }),
      gate = deferred();
    f.bridge.refresh = () => gate.promise;
    const pending = f.loop.start();
    if (reason === 'binding') f.setBinding({ host: '192.0.2.11' });
    if (reason === 'generation') f.bridge.generation++;
    if (reason === 'close') f.loop.close();
    gate.resolve(idle());
    await pending;
    assert.equal(f.calls.length, 0, reason);
  }
});

test('concurrent startup and idle events share one deployment and installation admission defers it', async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.bridge.connect = async () => {
    await gate.promise;
    f.bridge.status = 'online';
    f.bridge.serviceUpdate = { status: 'current' };
  };
  const first = f.loop.start(),
    second = f.loop.start();
  f.loop.changed();
  assert.equal(f.calls.length, 1);
  gate.resolve();
  await Promise.all([first, second]);
  const blocked = fixture(t);
  blocked.setAllowed(false);
  await blocked.loop.start();
  assert.equal(blocked.calls.length, 0);
  blocked.setAllowed(true);
  await blocked.fire();
  assert.equal(blocked.calls.length, 1);
});

test('a binding reset cannot lose the new connection intent when its first timer fires before an old read finishes', async (t) => {
  const f = fixture(t, { online: true, status: 'pending', reason: 'work-active' }),
    gate = deferred();
  let reads = 0;
  f.bridge.refresh = async () => (++reads === 1 ? gate.promise : idle());
  const old = f.loop.start();
  f.setBinding({ host: '192.0.2.88' });
  f.loop.reset();
  const timer = [...f.timers.values()][0];
  f.timers.delete(timer);
  timer.callback();
  assert.equal(f.calls.length, 0);
  gate.resolve(idle());
  await old;
  assert.equal([...f.timers.values()][0].ms, 0);
  await f.fire();
  assert.equal(f.calls.length, 1);
  assert.equal(reads, 2);
});
