import test from 'node:test';
import type { TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { VmBackupTransport } from '../../src/backups/vm-backup-transport.mts';
import type { VmBinding } from '../../src/computer/computer-types.ts';
import type { VmObservation } from '../../src/computer/vm-observation-types.ts';
import type { VmConnectOptions, VmRequestOptions } from '../../src/computer/vm-bridge.mts';
import {
  ConnectionStatus,
  ComputerControlStatus,
  SubmissionStatus,
} from '../../src/contracts/states.mts';
import { ControllerBridgeFixture, deferred } from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';

const idle = (): VmObservation => ({
  active: null,
  call: null,
  queue: [],
  takeover: false,
  acquiring: false,
  worker: { status: ConnectionStatus.Online },
  computer: { status: ComputerControlStatus.Dant, sessionId: null },
  messages: [],
  workTasks: [],
  capabilities: { backups: true },
});
const metadata = { createdAt: 1, appVersion: '0.4.7-beta.8', bytes: 15, files: 1 };
class Bridge extends ControllerBridgeFixture {
  override status: ControllerBridgeFixture['status'] = ConnectionStatus.Online;
  override generation = 1;
  override cached: VmObservation | undefined = idle();
  override serviceUpdate = {
    status: 'current' as const,
    targetVersion: '0.4.7-beta.8',
    runningVersion: '0.4.7-beta.8',
    confirmed: true,
    reason: null,
  };
  connects: (VmConnectOptions | undefined)[] = [];
  pauses: unknown[] = [];
  requests: { route: string; options: VmRequestOptions | undefined }[] = [];
  refreshHook = async (): Promise<VmObservation | undefined> => this.cached;
  pauseHook = async (): Promise<unknown> => this.cached;
  requestHook = async (_route: string, _options?: VmRequestOptions): Promise<Response> =>
    Response.json({});
  override async refresh() {
    return this.refreshHook();
  }
  override async pauseWorkForUpdate(options?: { reason?: 'install' | 'exit' }) {
    this.pauses.push(options);
    return this.pauseHook();
  }
  override async request(route: string, options?: VmRequestOptions) {
    this.requests.push({ route, options });
    return this.requestHook(route, options);
  }
  override async connect(options?: VmConnectOptions) {
    this.connects.push(options);
    this.status = ConnectionStatus.Online;
    this.generation++;
  }
}
class SshChild extends ChildProcess {
  override stdin = new PassThrough();
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  override stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [
    this.stdin,
    this.stdout,
    this.stderr,
    undefined,
    undefined,
  ];
  killedCount = 0;
  override kill() {
    this.killedCount++;
    queueMicrotask(() => this.emit('close', 1, null));
    return true;
  }
}
function fixture(t: TestContext) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'backup-transport-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, 'fixture-key');
  fs.writeFileSync(keyPath, 'ISOLATED FIXTURE ONLY');
  const bridge = new Bridge();
  let binding: VmBinding | { host?: never } = {
    host: '192.0.2.10',
    user: 'fixture',
    port: 22,
    keyPath,
    knownHosts: '/isolated/hosts',
    provider: 'ssh',
  };
  const calls: { command: string; args: readonly string[]; child: SshChild; bytes: Buffer[] }[] =
    [];
  let result: unknown;
  let exitCode = 0;
  let beforeResult = () => {};
  const transport = new VmBackupTransport({
    bridge,
    binding: () => binding,
    spawnProcess: (command, args) => {
      const child = new SshChild(),
        bytes: Buffer[] = [];
      calls.push({ command, args, child, bytes });
      child.stdin.on('data', (chunk: Buffer) => bytes.push(Buffer.from(chunk)));
      child.stdin.on('finish', () =>
        queueMicrotask(() => {
          beforeResult();
          child.stdout.end(typeof result === 'string' ? result : JSON.stringify(result));
          child.stderr.end('isolated private subprocess output');
          child.emit('close', exitCode, null);
        }),
      );
      return child;
    },
  });
  return {
    bridge,
    transport,
    calls,
    setBinding(value: typeof binding) {
      binding = value;
    },
    setResult(value: unknown, code = 0) {
      result = value;
      exitCode = code;
    },
    setBeforeResult(callback: () => void) {
      beforeResult = callback;
    },
  };
}
async function bytes(input: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of input) {
    assert.ok(Buffer.isBuffer(value));
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

test('target capabilities require observed backup support and confirmed version without calling SSH', async (t) => {
  const f = fixture(t);
  const target = await f.transport.target();
  assert.match(target.identity, /^[0-9a-f]{64}$/);
  assert.equal(target.online, true);
  assert.equal(target.supported, true);
  assert.equal(target.empty, false);
  assert.equal(target.version, '0.4.7-beta.8');
  f.bridge.serviceUpdate.confirmed = false;
  assert.equal((await f.transport.target()).version, null);
  f.bridge.cached = { ...idle(), capabilities: { backups: 'yes' } };
  assert.equal((await f.transport.target()).supported, false);
  f.setBinding({});
  assert.deepEqual(await f.transport.target(), {
    identity: '',
    generation: 1,
    online: false,
    supported: false,
    empty: false,
    version: null,
  });
  assert.equal(f.calls.length, 0);
});

test('a refresh cannot apply target observations after a generation or binding change', async (t) => {
  for (const change of ['generation', 'binding'] as const) {
    const f = fixture(t),
      gate = deferred<VmObservation>();
    f.bridge.refreshHook = () => gate.promise;
    const pending = f.transport.target(true);
    if (change === 'generation') f.bridge.generation++;
    else
      f.setBinding({
        host: '192.0.2.11',
        user: 'fixture',
        port: 22,
        keyPath: '/new/key',
        knownHosts: '/new/hosts',
      });
    gate.resolve(idle());
    await assert.rejects(pending, { code: 'backup_connection_changed' });
    assert.equal(f.calls.length, 0);
  }
});

test('snapshot export streams exact bytes and closes its request without any SSH operation', async (t) => {
  const f = fixture(t),
    payload = Buffer.from('fixture archive');
  let signal: AbortSignal | undefined;
  f.bridge.requestHook = async (route, options) => {
    assert.equal(route, '/api/backups/export');
    signal = options?.signal ?? undefined;
    return new Response(payload, {
      headers: {
        'X-Dant-Backup-Metadata': Buffer.from(JSON.stringify(metadata)).toString('base64'),
      },
    });
  };
  const exported = await f.transport.export(new AbortController().signal);
  assert.deepEqual(exported.metadata, metadata);
  assert.deepEqual(await bytes(exported.stream), payload);
  await exported.close();
  assert.equal(defined(signal).aborted, true);
  assert.equal(f.calls.length, 0);
});

test('invalid metadata cancels successful HTTP bodies and aborts their snapshot request', async (t) => {
  for (const encoded of [
    undefined,
    'not base64!',
    'a'.repeat(4097),
    Buffer.from('invalid JSON').toString('base64'),
    Buffer.from(JSON.stringify({ ...metadata, bytes: -1 })).toString('base64'),
  ]) {
    const f = fixture(t);
    let cancelled = 0,
      signal: AbortSignal | undefined;
    f.bridge.requestHook = async (_route, options) => {
      signal = options?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      });
      // A real fetch abort cancels its body. Keep that transport behavior in this fixture.
      signal?.addEventListener(
        'abort',
        () => {
          void body.cancel();
        },
        { once: true },
      );
      return new Response(body, { headers: encoded ? { 'X-Dant-Backup-Metadata': encoded } : {} });
    };
    await assert.rejects(f.transport.export(new AbortController().signal), {
      code: 'backup_invalid',
    });
    assert.equal(defined(signal).aborted, true);
    assert.equal(cancelled, 1);
    assert.equal(f.calls.length, 0);
  }
});

test('failed snapshot HTTP responses are bounded errors and cancel their body', async (t) => {
  for (const [status, code] of [
    [404, 'backup_service_update_required'],
    [409, 'backup_busy'],
    [500, 'backup_failed'],
  ] as const) {
    const f = fixture(t);
    let cancelled = 0;
    f.bridge.requestHook = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status },
      );
    await assert.rejects(f.transport.export(new AbortController().signal), { code });
    assert.equal(cancelled, 1);
  }
});

test('restoration captures one identity, confirms pause, uses a stop witness and reconnects without deployment', async (t) => {
  const f = fixture(t),
    restoreId = randomUUID(),
    target = await f.transport.target();
  f.setResult({ restored: true, restoreId });
  await f.transport.restore(
    Readable.from(['fixture archive']),
    restoreId,
    target,
    new AbortController().signal,
  );
  assert.deepEqual(f.bridge.pauses, [{ reason: 'install' }]);
  assert.deepEqual(f.bridge.connects, [{ deploy: false }]);
  assert.equal(f.calls.length, 1);
  const call = defined(f.calls[0]),
    script = defined(call.args.at(-1));
  assert.equal(call.command, 'ssh');
  assert.equal(Buffer.concat(call.bytes).toString(), 'fixture archive');
  assert.ok(script.startsWith('set -eu\n'));
  assert.ok(
    script.indexOf('systemctl --user stop dant-worker.service') <
      script.indexOf('is-active dant-worker.service'),
  );
  assert.ok(script.indexOf('= inactive') < script.indexOf('worker-cli.mts restore'));
  assert.ok(script.indexOf('worker-cli.mts restore') < script.indexOf('worker-cli.mts finish'));
  assert.ok(script.includes(' >/dev/null'), 'Only the final loaded receipt is written to stdout');
  assert.doesNotMatch(script, /systemctl --user start/);
  assert.ok(script.includes('--restore-id ' + restoreId));
});

test('changed identity, unresolved work, control, or an unconfirmed pause never reaches SSH restore', async (t) => {
  for (const mode of [
    'binding',
    'generation',
    'pause-failed',
    'active',
    'call',
    'queue',
    'unknown',
    'human',
  ] as const) {
    const f = fixture(t),
      target = await f.transport.target();
    if (mode === 'binding') f.setBinding({});
    if (mode === 'generation') f.bridge.generation++;
    if (mode === 'pause-failed')
      f.bridge.pauseHook = async () => {
        throw Error('Pause result unknown');
      };
    if (mode === 'active') f.bridge.cached = { ...idle(), active: { turnId: 'current' } };
    if (mode === 'call') f.bridge.cached = { ...idle(), call: { id: 'call' } };
    if (mode === 'queue') f.bridge.cached = { ...idle(), queue: [{}] };
    if (mode === 'unknown')
      f.bridge.cached = {
        ...idle(),
        workTasks: [{ status: 'paused', submission: SubmissionStatus.Unknown }],
      };
    if (mode === 'human')
      f.bridge.cached = {
        ...idle(),
        computer: { status: ComputerControlStatus.Human, sessionId: 'owned' },
      };
    await assert.rejects(
      f.transport.restore(
        Readable.from(['unsubmitted']),
        randomUUID(),
        target,
        new AbortController().signal,
      ),
    );
    assert.equal(f.calls.length, 0, mode);
    assert.deepEqual(f.bridge.connects, []);
  }
});

test('lost or mismatching restore output stays unknown and reconciliation never replays archive input', async (t) => {
  for (const result of [
    'not JSON',
    { restored: false },
    { restored: true, restoreId: randomUUID() },
    'x'.repeat(4097),
  ]) {
    const f = fixture(t),
      target = await f.transport.target(),
      restoreId = randomUUID();
    f.setResult(result);
    await assert.rejects(
      f.transport.restore(
        Readable.from(['fixture']),
        restoreId,
        target,
        new AbortController().signal,
      ),
      {
        code: 'backup_restore_unconfirmed',
        unknownOutcome: true,
      },
    );
    f.bridge.requestHook = async () => Response.json({ restored: false });
    assert.equal(await f.transport.reconcile(restoreId, target), false);
    assert.equal(await f.transport.reconcile(restoreId, target), false);
    assert.equal(f.calls.length, 3);
    assert.equal(
      f.calls.filter((call) => defined(call.args.at(-1)).includes('worker-cli.mts restore '))
        .length,
      1,
    );
    assert.ok(
      f.calls
        .slice(1)
        .every((call) => defined(call.args.at(-1)).includes('worker-cli.mts finish ')),
    );
    assert.ok(f.calls.slice(1).every((call) => Buffer.concat(call.bytes).length === 0));
    assert.deepEqual(f.bridge.connects, []);
  }
});

test('reconciliation accepts only fresh matching loaded restore proof for the same VM', async (t) => {
  const f = fixture(t),
    target = await f.transport.target(),
    restoreId = randomUUID();
  f.bridge.requestHook = async (route) => {
    assert.equal(route, '/api/backups/info');
    return Response.json({ restored: true, restoreId });
  };
  assert.equal(await f.transport.reconcile(restoreId, target), true);
  assert.equal(f.calls.length, 0, 'Loaded matching proof needs no SSH finish');
  f.bridge.requestHook = async () => Response.json({ restored: true, restoreId: randomUUID() });
  assert.equal(await f.transport.reconcile(restoreId, target), false);
  f.bridge.requestHook = async () => {
    f.setBinding({});
    return Response.json({ restored: true, restoreId });
  };
  assert.equal(await f.transport.reconcile(restoreId, target), false);
  assert.equal(f.calls.length, 1, 'A changed binding must not issue another finish');
});

test('an offline committed restore finishes service startup without uploading or pausing again', async (t) => {
  const f = fixture(t),
    target = await f.transport.target(),
    restoreId = randomUUID();
  f.bridge.status = ConnectionStatus.Offline;
  f.setResult({ restored: true, restoreId, started: true });
  f.bridge.requestHook = async (route) => {
    assert.equal(route, '/api/backups/info');
    assert.equal(f.bridge.connects.length, 1, 'Proof must come from the reconnected Worker');
    return Response.json({ restored: true, restoreId });
  };
  assert.equal(await f.transport.reconcile(restoreId, target), true);
  assert.equal(f.calls.length, 1);
  const call = defined(f.calls[0]),
    command = defined(call.args.at(-1));
  assert.ok(command.includes('worker-cli.mts finish '));
  assert.ok(command.includes('--restore-id ' + restoreId));
  assert.doesNotMatch(command, /worker-cli\.mts (?:restore|recover)|systemctl/);
  assert.equal(Buffer.concat(call.bytes).length, 0);
  assert.deepEqual(f.bridge.pauses, []);
  assert.deepEqual(f.bridge.connects, [{ deploy: false }]);
});

test('a finish result never confirms restore without fresh startup-loaded proof', async (t) => {
  const f = fixture(t),
    target = await f.transport.target(),
    restoreId = randomUUID();
  f.bridge.status = ConnectionStatus.Offline;
  f.setResult({ restored: true, restoreId, started: true });
  f.bridge.requestHook = async () => Response.json({ restored: false, restoreId });
  assert.equal(await f.transport.reconcile(restoreId, target), false);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.bridge.connects, [{ deploy: false }]);
  assert.deepEqual(f.bridge.pauses, []);
});

test('finish failures and uncommitted or mismatching receipts remain unknown without reconnect or import', async (t) => {
  for (const [result, code] of [
    [{ restored: false, restoreId: randomUUID() }, 0],
    [{ restored: true, restoreId: randomUUID() }, 0],
    ['private process failure', 1],
  ] as const) {
    const f = fixture(t),
      target = await f.transport.target(),
      restoreId = randomUUID();
    f.bridge.status = ConnectionStatus.Offline;
    f.setResult(result, code);
    assert.equal(await f.transport.reconcile(restoreId, target), false);
    assert.equal(f.calls.length, 1);
    assert.ok(defined(defined(f.calls[0]).args.at(-1)).includes('worker-cli.mts finish '));
    assert.equal(Buffer.concat(defined(f.calls[0]).bytes).length, 0);
    assert.deepEqual(f.bridge.connects, []);
    assert.deepEqual(f.bridge.pauses, []);
  }
});

test('binding or connection generation changed during SSH finish keeps the restore unconfirmed', async (t) => {
  for (const change of ['binding', 'generation'] as const) {
    const f = fixture(t),
      target = await f.transport.target(),
      restoreId = randomUUID();
    f.bridge.status = ConnectionStatus.Offline;
    f.setResult({ restored: true, restoreId });
    f.setBeforeResult(() => {
      if (change === 'binding') f.setBinding({});
      else f.bridge.generation++;
    });
    assert.equal(await f.transport.reconcile(restoreId, target), false);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.bridge.connects, []);
  }
});

test('a changed generation while reading loaded proof does not authorize a finish on another connection', async (t) => {
  const f = fixture(t),
    target = await f.transport.target(),
    restoreId = randomUUID();
  f.setResult({ restored: true, restoreId });
  f.bridge.requestHook = async () => {
    f.bridge.generation++;
    return Response.json({ restored: true, restoreId });
  };
  assert.equal(await f.transport.reconcile(restoreId, target), false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.bridge.connects, []);
});

test('safe rejection accepts only exact read-only proof for the captured VM and never starts service or resends input', async (t) => {
  const f = fixture(t),
    target = await f.transport.target(),
    restoreId = randomUUID();
  f.setResult({ rejected: true, restoreId });
  assert.equal(await f.transport.rejected(restoreId, target), true);
  const command = defined(defined(f.calls[0]).args.at(-1));
  assert.match(command, /worker-cli\.mts outcome /);
  assert.doesNotMatch(command, /worker-cli\.mts (restore|recover|finish)|systemctl/);
  assert.equal(Buffer.concat(defined(f.calls[0]).bytes).length, 0);
  assert.deepEqual(f.bridge.connects, []);
  assert.deepEqual(f.bridge.pauses, []);
  for (const result of [
    { rejected: false, restoreId },
    { rejected: true, restoreId: randomUUID() },
    'bad JSON',
  ]) {
    f.setResult(result);
    assert.equal(await f.transport.rejected(restoreId, target), false);
  }
  f.setResult({ rejected: true, restoreId });
  f.setBeforeResult(() => {
    f.bridge.generation++;
  });
  assert.equal(await f.transport.rejected(restoreId, target), false);
});
