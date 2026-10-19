import { isRecord } from '../../src/contracts/json.mts';
interface ControlCall {
  route: string;
  action?: unknown;
  sessionId?: unknown;
}
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerSession } from '../../src/computer/computer-session.mts';

function fixture(t: NodeTestContext, { stopFailure = false } = {}) {
  const calls: (string | ControlCall)[] = [],
    engine: ConstructorParameters<typeof ComputerSession>[0] & {
      call: { id: string; status: string; provider?: string; connectedAt?: number } | null;
    } = {
      takeover: false,
      acquiring: false,
      call: null,
      assertTakeoverCall() {
        if (this.call && this.call.status !== 'connected')
          throw Error('Wait for the voice call to connect');
      },
      pauseQueue() {
        calls.push('pause');
      },
      async acquire() {
        calls.push('interrupt-confirmed');
        if (stopFailure) throw Error('Agent has not stopped yet');
        this.takeover = true;
      },
      release() {
        this.takeover = false;
        calls.push('released');
      },
    };
  const worker = {
    async guest(route: string, body: unknown) {
      assert.ok(isRecord(body));
      calls.push({ route, ...body });
      if (route === '/control')
        return Response.json(
          body.action === 'release'
            ? { status: 'dant', sessionId: null, expiresAt: 0 }
            : {
                status: body.action === 'acquire' ? 'taking-over' : 'human',
                sessionId: 'session-1',
                expiresAt: Date.now() + 120000,
              },
        );
      return Response.json({ ok: true, expiresAt: Date.now() + 120000 });
    },
  };
  const session = new ComputerSession(engine, worker);
  t.after(() => session.close());
  return { session, engine, calls };
}

test('desktop reservation precedes interruption and input requires the confirmed session', async (t) => {
  const { session, engine, calls } = fixture(t);
  const result = await session.acquire();
  assert.equal(result.status, 'human');
  assert.deepEqual(calls.slice(0, 3), [
    'pause',
    { route: '/control', action: 'acquire' },
    'interrupt-confirmed',
  ]);
  assert.equal(engine.takeover, true);
  await assert.rejects(session.input({ type: 'key', key: 'a', sessionId: 'old' }), /expired/);
  assert.equal(
    (await session.input({ type: 'key', key: 'a', sessionId: result.sessionId })).ok,
    true,
  );
  await session.release(result.sessionId);
  assert.equal(engine.takeover, false);
  assert.equal(session.snapshot().status, 'dant');
  await assert.rejects(session.input({ sessionId: result.sessionId }), /expired/);
});

test('unconfirmed interruption never grants human input and releases its reservation', async (t) => {
  const { session, engine, calls } = fixture(t, { stopFailure: true });
  await assert.rejects(session.acquire(), /not stopped/);
  assert.equal(engine.takeover, false);
  assert.equal(session.snapshot().sessionId, null);
  assert.ok(!calls.some((call) => typeof call === 'object' && call.action === 'confirm'));
  assert.ok(calls.some((call) => typeof call === 'object' && call.action === 'release'));
});

test('a call that has not established its media prevents takeover before reaching the guest', async (t) => {
  const { session, engine, calls } = fixture(t);
  engine.call = { id: 'active', status: 'connecting' };
  await assert.rejects(session.acquire(), /Wait for the voice call/);
  assert.deepEqual(calls, []);
});

test('connected media survives reservation, confirmation, input and return for either provider', async (t) => {
  for (const provider of ['subscription', 'api']) {
    const { session, engine, calls } = fixture(t),
      call = { id: 'live-' + provider, status: 'connected', provider, connectedAt: 123 };
    engine.call = call;
    const result = await session.acquire();
    assert.equal(result.status, 'human');
    assert.equal(engine.call, call);
    assert.equal(engine.takeover, true);
    await session.input({ type: 'text', text: 'Manual login', sessionId: result.sessionId });
    await session.release(result.sessionId);
    assert.equal(engine.call, call);
    assert.equal(engine.takeover, false);
    assert.deepEqual(
      calls
        .filter(
          (item): item is ControlCall => typeof item === 'object' && item.route === '/control',
        )
        .map((item) => item.action),
      ['acquire', 'confirm', 'release'],
    );
  }
});
