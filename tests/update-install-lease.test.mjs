import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  UpdateInstallLease,
  installStateSafe,
  updateSensitiveRequest,
} from '../src/updates/update-install-lease.mts';
import { createControllerApp } from '../src/app/controller.mjs';

const safe = () => ({
  mode: 'vm-controller',
  controller: { status: 'online', cached: false, authority: 'vm' },
  worker: { status: 'online' },
  messages: [],
  workTasks: [],
  call: null,
  takeover: false,
  computer: { status: 'dant', sessionId: null, pending: false },
  provisioning: { status: 'ready', running: false },
  active: null,
  queue: [],
});
test('install admission requires fresh confirmed paused work and no call/control/setup authority', () => {
  const state = safe();
  assert.equal(installStateSafe(state), true);
  for (const patch of [
    { active: { turnId: 'work' } },
    { queue: ['work'] },
    { workTasks: [{ status: 'continuing' }] },
    { messages: [{ status: 'unknown' }] },
    { call: { id: 'call' } },
    { call: undefined },
    { takeover: true },
    { acquiring: true },
    { controller: { status: 'online', cached: true, authority: 'vm' } },
    { computer: { status: 'human' } },
    { computer: { status: 'dant', pending: true } },
    { computer: { status: 'dant', sessionId: 'human' } },
    { provisioning: { running: true, status: 'installing' } },
    { mode: 'vm-worker' },
  ])
    assert.equal(installStateSafe({ ...state, ...patch }), false);
});
test('mutation admission includes queued input so a late request cannot arrive after pause confirmation', () => {
  for (const originalUrl of [
    '/api/call',
    '/api/CALL/',
    '/api/x/../call',
    '/api/%63all',
    '/api/takeover',
    '/api/provision',
    '/api/connect',
    '/api/prepare',
    '/api/vm/import',
  ])
    assert.equal(updateSensitiveRequest({ method: 'POST', originalUrl }), true, originalUrl);
  assert.equal(
    updateSensitiveRequest({
      method: 'PATCH',
      path: '/api/settings',
      body: { vm: { host: 'changed' } },
    }),
    true,
  );
  for (const [method, path, body] of [
    ['POST', '/api/messages'],
    ['POST', '/api/tasks/work/cancel'],
    ['POST', '/api/call/stop'],
    ['PATCH', '/api/settings', { theme: 'dark' }],
  ])
    assert.equal(updateSensitiveRequest({ method, path, body }), true, path);
  for (const [method, path] of [
    ['GET', '/api/state'],
    ['POST', '/api/desktop/exit'],
    ['POST', '/api/updates/install-lease'],
    ['DELETE', '/api/updates/install-lease/identity'],
  ])
    assert.equal(updateSensitiveRequest({ method, path }), false, path);
});
test('refresh reserves admission atomically and release/expiry permit later calls', async () => {
  let finish,
    now = 100;
  const state = safe(),
    lease = new UpdateInstallLease({
      snapshot: () => state,
      refresh: () => new Promise((resolve) => (finish = resolve)),
      now: () => now,
      id: () => 'lease-one',
    });
  const acquired = lease.acquire();
  assert.throws(
    () => lease.enter(),
    (error) => error.status === 409,
  );
  finish();
  assert.deepEqual(await acquired, { leaseId: 'lease-one', expiresAt: 30100 });
  assert.throws(() => lease.enter());
  assert.equal(state.active, null);
  assert.deepEqual(state.queue, []);
  assert.throws(() => lease.release('stale'));
  assert.deepEqual(lease.release('lease-one'), { released: true });
  const done = lease.enter();
  done();
  const again = lease.acquire();
  finish();
  await again;
  now = 30100;
  lease.enter()();
  lease.close();
  assert.throws(() => lease.enter());
  await assert.rejects(lease.acquire());
});
test('pending or uncertain critical delivery prevents install and completion cannot decrement twice', async () => {
  const lease = new UpdateInstallLease({ snapshot: safe, refresh: async () => {} }),
    done = lease.enter();
  await assert.rejects(lease.acquire());
  assert.equal(lease.pending, 1);
  done();
  done();
  assert.equal(lease.pending, 0);
  const unknown = lease.enter();
  unknown({ unknownOutcome: true });
  await assert.rejects(lease.acquire());
});
test('failed refresh, call discovered after refresh and shutdown release checking reservation', async () => {
  let state = safe(),
    fail = true;
  const lease = new UpdateInstallLease({
    snapshot: () => state,
    refresh: async () => {
      if (fail) throw Error('offline');
      state = { ...state, call: { id: 'new-call' } };
    },
  });
  await assert.rejects(lease.acquire());
  lease.enter()();
  fail = false;
  await assert.rejects(lease.acquire());
  lease.enter()();
  let finish;
  const closing = new UpdateInstallLease({
      snapshot: safe,
      refresh: () => new Promise((resolve) => (finish = resolve)),
    }),
    pending = closing.acquire();
  closing.close();
  finish();
  await assert.rejects(pending);
});

class Provisioning extends EventEmitter {
  snapshot() {
    return { status: 'ready', running: false };
  }
  resumeMonitoring() {
    return this.snapshot();
  }
  close() {}
}
class Bridge extends EventEmitter {
  constructor() {
    super();
    this.status = 'online';
    this.cached = {
      ...safe(),
      settings: { language: 'zh', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      active: { turnId: 'keep-running' },
      queue: ['keep-queued'],
    };
    this.requests = [];
    this.pauses = 0;
  }
  async pauseWorkForUpdate() {
    this.pauses++;
    if (this.cached.call) throw Error('call pause unconfirmed');
    this.cached = {
      ...this.cached,
      active: null,
      queue: [],
      workTasks: [{ id: 'saved-work', status: 'paused', executionEndedAt: 1 }],
    };
    this.emit('state', this.cached);
  }
  async refresh() {
    if (this.refreshFailure) throw Error('offline');
    this.emit('state', this.cached);
    return this.cached;
  }
  async request(route, options) {
    this.requests.push({ route, ...options });
    if (this.pending) await this.pending;
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  }
  close() {}
}
async function fixture(t) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'update-lease-')),
    bridge = new Bridge();
  fs.writeFileSync(path.join(dir, 'test-key'), 'fixture');
  fs.writeFileSync(
    path.join(dir, 'vm.json'),
    JSON.stringify({ host: '192.0.2.1', user: 'dant', port: 22, keyPath: 'test-key' }),
  );
  const operations = [],
    lifecycle = {
      suspend: async () => {
        operations.push('suspend');
        return { ok: true, supported: true, vmSuspended: true };
      },
      resume: async () => operations.push('resume'),
    };
  bridge.disconnect = () => {
    operations.push('disconnect');
    bridge.status = 'offline';
  };
  bridge.connect = async () => {
    operations.push('connect');
    bridge.status = 'online';
  };
  const app = createControllerApp({
    dataDir: dir,
    projectRoot: path.resolve('.'),
    bridgeFactory: () => bridge,
    lifecycleFactory: () => lifecycle,
    provisioningFactory: () => new Provisioning(),
    profileOptions: {
      registryFile: path.join(dir, 'registry.json'),
      candidateDirs: [],
      includeProject: false,
      env: {},
    },
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`,
    session = await fetch(base + '/api/session').then((r) => r.json()),
    headers = { 'Content-Type': 'application/json', 'X-Dant-Token': session.token };
  const call = (route, method = 'POST', body = {}) =>
    fetch(base + '/api/' + route, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
  return { base, headers, bridge, app, call, operations };
}
test('authenticated Controller installation pauses work, retains task records and fences all new mutations', async (t) => {
  const { base, headers, bridge, call } = await fixture(t);
  assert.equal(
    (
      await fetch(base + '/api/updates/install-lease', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(base + '/api/updates/install-lease', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  for (const value of [null, [], { unexpected: true }])
    assert.equal((await call('updates/install-lease', 'POST', value)).status, 400);
  const response = await call('updates/install-lease');
  assert.equal(response.status, 200);
  const lease = await response.json();
  assert.equal(typeof lease.leaseId, 'string');
  assert.ok(lease.expiresAt > Date.now());
  for (const route of ['call', 'CALL/', 'takeover', 'prepare', 'connect', 'provision', 'vm/import'])
    assert.equal((await call(route)).status, 409, route);
  assert.equal((await call('settings', 'PATCH', { vm: { host: '192.0.2.1' } })).status, 409);
  assert.equal((await call('messages', 'POST', { text: 'new work' })).status, 409);
  assert.equal((await call('tasks/work/cancel')).status, 409);
  assert.equal(bridge.cached.active, null);
  assert.deepEqual(bridge.cached.queue, []);
  assert.equal(bridge.cached.workTasks[0].status, 'paused');
  assert.equal(bridge.pauses, 1);
  assert.equal((await call('updates/install-lease/not-the-lease', 'DELETE')).status, 409);
  assert.equal((await call('updates/install-lease/' + lease.leaseId, 'DELETE')).status, 200);
  assert.equal((await call('takeover')).status, 200);
});
test('aborting a connecting call cannot drop its in-flight install barrier before upstream completion', async (t) => {
  const { base, headers, bridge, call } = await fixture(t);
  let finish;
  bridge.pending = new Promise((resolve) => (finish = resolve));
  const abort = new AbortController(),
    request = fetch(base + '/api/call', {
      method: 'POST',
      headers,
      body: '{}',
      signal: abort.signal,
    }).catch(() => null);
  for (let tries = 0; !bridge.requests.length && tries < 200; tries++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(bridge.requests.length, 'the call must be admitted upstream');
  abort.abort();
  await request;
  assert.equal((await call('updates/install-lease')).status, 409);
  bridge.pending = null;
  finish();
  for (let tries = 0; tries < 100; tries++) {
    const result = await call('updates/install-lease');
    if (result.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('finished upstream call did not release admission');
});
test('fresh call/control state or failed refresh denies install, then permits a later confirmed safe retry', async (t) => {
  const { bridge, call } = await fixture(t);
  bridge.cached.call = { id: 'live-call' };
  assert.equal((await call('updates/install-lease')).status, 409);
  bridge.cached.call = null;
  bridge.refreshFailure = true;
  assert.equal((await call('updates/install-lease')).status, 409);
  bridge.refreshFailure = false;
  assert.equal((await call('updates/install-lease')).status, 200);
});
test(
  'lease waits out an older pending poll and requests a new authoritative state before allowing restart',
  { timeout: 10000 },
  async (t) => {
    const { bridge, call } = await fixture(t);
    let finish,
      noticed,
      waited = false;
    const oldPoll = new Promise((resolve) => (finish = resolve)),
      observed = new Promise((resolve) => (noticed = resolve));
    Object.defineProperty(bridge, 'refreshing', {
      get() {
        noticed();
        return oldPoll;
      },
    });
    t.after(() => finish());
    bridge.refresh = async (force) => {
      assert.equal(force, true);
      assert.equal(waited, true);
      bridge.cached.call = { id: 'call-observed-after-old-poll' };
      bridge.emit('state', bridge.cached);
      return bridge.cached;
    };
    const pending = call('updates/install-lease');
    await observed;
    waited = true;
    finish();
    assert.equal((await pending).status, 409);
  },
);

test('native installation suspends only after confirmed pause and a valid lease, cancellation restores the VM', async (t) => {
  const { call, app, bridge, operations } = await fixture(t);
  assert.equal(
    (await call('desktop/exit', 'POST', { reason: 'install', leaseId: 'stale' })).status,
    409,
  );
  assert.deepEqual(operations, []);
  const lease = await (await call('updates/install-lease')).json();
  assert.equal(bridge.pauses, 1);
  const response = await call('desktop/exit', 'POST', {
      reason: 'install',
      leaseId: lease.leaseId,
    }),
    result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.leaseId, lease.leaseId);
  assert.equal(result.workPaused, true);
  assert.equal(result.vmSuspended, true);
  assert.ok(result.expiresAt > Date.now());
  assert.deepEqual(operations, ['suspend', 'disconnect']);
  assert.equal(bridge.pauses, 1, 'fresh confirmation does not repeat a pause');
  assert.equal(
    (await call('messages', 'POST', { text: 'cannot run while suspended' })).status,
    409,
  );
  assert.equal((await call('desktop/cancel-exit')).status, 409);
  assert.deepEqual(operations, ['suspend', 'disconnect']);
  assert.equal((await call('desktop/open')).status, 409);
  assert.deepEqual(operations, ['suspend', 'disconnect']);
  assert.equal((await call('desktop/cancel-exit', 'POST', { leaseId: lease.leaseId })).status, 409);
  assert.deepEqual(operations, ['suspend', 'disconnect']);
  assert.equal(
    (await call('desktop/cancel-exit', 'POST', { reason: 'install', leaseId: lease.leaseId }))
      .status,
    200,
  );
  assert.deepEqual(operations, ['suspend', 'disconnect', 'resume', 'connect']);
  assert.equal(app.desktop.blocked, false);
  assert.equal(bridge.cached.workTasks[0].status, 'paused');
});

test('explicit Exit pauses ongoing work; a plain server shutdown never operates the VM', async (t) => {
  const { call, app, bridge, operations } = await fixture(t);
  assert.equal((await call('desktop/exit')).status, 200);
  assert.equal(bridge.pauses, 1);
  assert.deepEqual(operations, ['suspend', 'disconnect']);
  await app.close();
  assert.deepEqual(operations, ['suspend', 'disconnect']);
});

test('failed pause and malformed desktop requests cannot suspend a VM', async (t) => {
  const { call, bridge, operations, app } = await fixture(t);
  for (const body of [
    [],
    { reason: 'bad' },
    { leaseId: 'not-install' },
    { reason: 'exit', extra: true },
  ])
    assert.equal((await call('desktop/exit', 'POST', body)).status, 400);
  bridge.pauseWorkForUpdate = async () => {
    throw Object.assign(Error('pause not confirmed'), { status: 409 });
  };
  assert.equal((await call('desktop/exit')).status, 409);
  assert.equal(app.desktop.blocked, false);
  assert.deepEqual(operations, []);
});

test('automatic service updates can be paused persistently without stopping current work', async (t) => {
  const { call, app, bridge } = await fixture(t);
  assert.equal((await call('service-update', 'POST', { action: 'pause' })).status, 200);
  assert.equal(app.snapshot().controller.updatesPaused, true);
  assert.equal(bridge.pauses, 0);
  assert.deepEqual(bridge.cached.active, { turnId: 'keep-running' });
  assert.equal((await call('service-update', 'POST', { action: 'resume' })).status, 200);
  assert.equal(app.snapshot().controller.updatesPaused, false);
  assert.equal(bridge.pauses, 0);
  for (const body of [{ action: 'x' }, { action: 'pause', extra: 1 }, []])
    assert.equal((await call('service-update', 'POST', body)).status, 400);
});

test('lease suspension pins its admission deadline and renews only the same identity', async () => {
  let now = 100,
    releases = 0;
  const lease = new UpdateInstallLease({
    snapshot: safe,
    refresh: async () => {},
    now: () => now,
    id: () => 'identity',
    onRelease: () => releases++,
  });
  await lease.acquire();
  now = 30000;
  assert.equal(lease.pin('identity').expiresAt, 180000);
  now = 100000;
  assert.equal(lease.renew('identity').expiresAt, 130000);
  assert.throws(() => lease.renew('old'));
  now = 130000;
  assert.equal(lease.current(), null);
  assert.equal(releases, 1);
  assert.equal(lease.current(), null);
  assert.equal(releases, 1);
  lease.close();
});

test('an already submitted message must settle before Exit or a service replacement can pause work', async (t) => {
  const { call, bridge, operations } = await fixture(t);
  let finish;
  bridge.pending = new Promise((resolve) => (finish = resolve));
  const message = call('messages', 'POST', { text: 'queued before Exit' });
  for (let i = 0; !bridge.requests.length && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(bridge.requests.length, 1);
  for (const [route, body] of [
    ['desktop/exit', {}],
    ['connect', {}],
    ['service-update', { action: 'install' }],
  ])
    assert.equal((await call(route, 'POST', body)).status, 409, route);
  assert.equal(bridge.pauses, 0);
  assert.deepEqual(operations, []);
  finish();
  bridge.pending = null;
  assert.equal((await message).status, 200);
  assert.equal((await call('desktop/exit')).status, 200);
});

test('an idle stopped executor can install without restarting it; connecting state never authorizes suspend', async (t) => {
  const { call, bridge, operations } = await fixture(t);
  Object.assign(bridge.cached, { worker: { status: 'connecting' }, active: null, queue: [] });
  bridge.emit('state', bridge.cached);
  assert.equal((await call('updates/install-lease')).status, 409);
  assert.equal(bridge.pauses, 0);
  assert.deepEqual(operations, []);
  bridge.cached.worker.status = 'offline';
  const response = await call('updates/install-lease');
  assert.equal(response.status, 200);
  const lease = await response.json();
  assert.equal(
    (await call('desktop/exit', 'POST', { reason: 'install', leaseId: lease.leaseId })).status,
    200,
  );
  assert.equal(bridge.pauses, 0);
  assert.deepEqual(operations, ['suspend', 'disconnect']);
  assert.equal(bridge.cached.worker.status, 'offline');
});

test('reopening against the same external Controller restores the owned VM while paused work stays paused', async (t) => {
  const { call, app, bridge, operations } = await fixture(t);
  assert.equal((await call('desktop/exit')).status, 200);
  assert.equal(app.desktop.phase, 'suspended');
  assert.equal((await call('desktop/open')).status, 200);
  assert.equal(app.desktop.phase, 'idle');
  assert.deepEqual(operations.slice(0, 4), ['suspend', 'disconnect', 'resume', 'connect']);
  assert.equal(bridge.cached.workTasks[0].status, 'paused');
  assert.equal(bridge.pauses, 1);
  const before = operations.length;
  assert.equal((await call('desktop/open')).status, 200);
  assert.equal(
    operations.length,
    before,
    'an already online attached controller is left untouched',
  );
  assert.equal((await call('desktop/open', 'POST', [])).status, 400);
});
