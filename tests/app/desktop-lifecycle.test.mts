import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopLifecycle } from '../../src/app/desktop-lifecycle.mts';
import type { DesktopBridge, OwnedVmLifecycle } from '../../src/app/desktop-lifecycle.mts';
import { deferred } from '../support/service-fixtures.mts';
function fixture() {
  const calls: [string, unknown?][] = [];
  let binding: { host?: string } = { host: '192.0.2.1' };
  const bridge: DesktopBridge = {
      status: 'online',
      connect: async (options) => {
        calls.push(['connect', options]);
        bridge.status = 'online';
      },
      pauseWorkForUpdate: async (options) => calls.push(['pause', options]),
      refresh: async () => {
        throw Error('Fresh state was not configured in this fixture.');
      },
      disconnect: () => {
        calls.push(['disconnect']);
        bridge.status = 'offline';
      },
    },
    lifecycle: OwnedVmLifecycle = {
      suspend: async () => {
        calls.push(['suspend']);
        return { ok: true, supported: true, vmSuspended: true };
      },
      resume: async () => calls.push(['resume']),
    };
  return {
    calls,
    bridge,
    lifecycle,
    service: new DesktopLifecycle({ bridge, lifecycle, binding: () => binding }),
    setBinding: (value: { host?: string }) => (binding = value),
  };
}
test('explicit Exit confirms pause before suspending and disconnects only after acknowledgement', async () => {
  const f = fixture(),
    result = await f.service.exit();
  assert.equal(result.vmSuspended, true);
  assert.deepEqual(
    f.calls.map((row) => row[0]),
    ['pause', 'suspend', 'disconnect'],
  );
  assert.equal(f.service.phase, 'suspended');
});
test('pause failure keeps the VM and app connected', async () => {
  const f = fixture();
  f.bridge.pauseWorkForUpdate = async () => {
    throw Error('pause-unconfirmed');
  };
  await assert.rejects(f.service.exit(), /pause-unconfirmed/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.phase, 'idle');
});
test('suspension failure retains the running connection and permits a deliberate retry', async () => {
  const f = fixture();
  f.lifecycle.suspend = async () => {
    throw Error('suspend-unconfirmed');
  };
  await assert.rejects(f.service.exit());
  assert.equal(f.bridge.status, 'online');
  assert.equal(f.service.blocked, false);
});
test('installation cancellation restores the owned VM without resuming paused tasks', async () => {
  const f = fixture();
  await f.service.exit();
  await f.service.cancel();
  assert.deepEqual(f.calls.slice(-2), [['resume'], ['connect', { deploy: false }]]);
  assert.equal(f.service.blocked, false);
});
test('an unmanaged SSH VM pauses work and reports unsupported suspension', async () => {
  const f = fixture();
  f.lifecycle.suspend = async () => ({ ok: true, supported: false, vmSuspended: false });
  const result = await f.service.exit();
  assert.equal(result.unsupported, true);
  assert.equal(result.vmSuspended, false);
  assert.equal(f.bridge.status, 'online');
});
test('disconnected work computers reconcile VM restoration and reconnect without deployment before pausing', async () => {
  const f = fixture();
  f.bridge.status = 'offline';
  await f.service.prepare();
  assert.deepEqual(f.calls, [
    ['resume'],
    ['connect', { deploy: false }],
    ['pause', { reason: 'install' }],
  ]);
  assert.equal(f.service.blocked, true);
});
test('concurrent transitions and changed connections never reach suspension', async () => {
  const f = fixture();
  const gate = deferred();
  f.bridge.pauseWorkForUpdate = () => gate.promise;
  const pending = f.service.exit();
  await Promise.resolve();
  assert.throws(() => f.service.cancel(), { code: 'desktop_transition_busy' });
  f.setBinding({ host: '192.0.2.2' });
  gate.resolve();
  await assert.rejects(pending, { code: 'desktop_transition_busy' });
  assert.equal(f.calls.length, 0);
});
test('a closed application and a profile without a computer do not initiate VM work', async () => {
  const f = fixture();
  f.setBinding({});
  assert.equal((await f.service.prepare()).workPaused, true);
  assert.equal(f.calls.length, 0);
  f.service.close();
  assert.throws(() => f.service.exit(), { code: 'desktop_transition_busy' });
});

test('a prepared installation rechecks fresh idle authority before suspension', async () => {
  const f = fixture();
  await f.service.prepare();
  let reads = 0;
  f.bridge.refresh = async () => {
    reads++;
    return { active: { turnId: 'unexpected-work' } };
  };
  await assert.rejects(f.service.exit(), { code: 'desktop_transition_busy' });
  assert.equal(reads, 1);
  assert.deepEqual(
    f.calls.map((row) => row[0]),
    ['pause'],
  );
  assert.equal(f.bridge.status, 'online');
});

test('a denied startup restoration can be retried through explicit Reconnect preparation', async () => {
  const f = fixture();
  f.bridge.status = 'offline';
  f.lifecycle.resume = async () => {
    throw Error('restoration declined');
  };
  await assert.rejects(f.service.prepare(), /declined/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.phase, 'idle');
  f.lifecycle.resume = async () => f.calls.push(['resume']);
  await f.service.prepare();
  assert.deepEqual(
    f.calls.map((row) => row[0]),
    ['resume', 'connect', 'pause'],
  );
});

test('only explicit Reconnect preparation can recover an owned legacy saved VM without a receipt', async () => {
  const ordinary = fixture();
  ordinary.bridge.status = 'offline';
  ordinary.lifecycle.resumeForReconnect = async () => ordinary.calls.push(['recover-owned']);
  await ordinary.service.prepare();
  assert.deepEqual(
    ordinary.calls.map((row) => row[0]),
    ['resume', 'connect', 'pause'],
  );

  const explicit = fixture();
  explicit.bridge.status = 'offline';
  explicit.lifecycle.resumeForReconnect = async () => explicit.calls.push(['recover-owned']);
  await explicit.service.prepare({ recoverManagedVm: true });
  assert.deepEqual(
    explicit.calls.map((row) => row[0]),
    ['recover-owned', 'connect', 'pause'],
  );
  assert.deepEqual(explicit.calls[1], ['connect', { deploy: false }]);
});

test('unconfirmed legacy recovery does not connect, deploy or pause another executor', async () => {
  const f = fixture();
  f.bridge.status = 'offline';
  f.lifecycle.resumeForReconnect = async () => {
    throw Error('identity-unconfirmed');
  };
  await assert.rejects(f.service.prepare({ recoverManagedVm: true }), /identity-unconfirmed/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.service.phase, 'idle');
});
