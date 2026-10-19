import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWorkerApp } from '../../src/app/server.mts';
import { DesktopLifecycle } from '../../src/app/desktop-lifecycle.mts';
import { ConnectionStatus, TaskStatus } from '../../src/contracts/states.mts';
import {
  WorkerServiceFixture,
  listeningPort,
  observedRecord,
} from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';

const installer = fs.readFileSync('vm/install-worker.sh', 'utf8').replaceAll('\r\n', '\n');
const check = defined(
  defined(installer.match(/python3 - "\$\{1:-check\}" <<'PY'\n([\s\S]*?)\nPY/))[1],
);
// Run the real embedded guard against the isolated production Worker routes.
// Only the fixture's ephemeral loopback port replaces the fixed VM endpoint.
const python = String.raw`
import sys, urllib.request
source, target, mode = sys.argv[1:]
original_urlopen = urllib.request.urlopen

def urlopen(request, timeout):
    if isinstance(request, str):
        request = request.replace('http://127.0.0.1:4317', target, 1)
    else:
        request = urllib.request.Request(
            request.full_url.replace('http://127.0.0.1:4317', target, 1),
            data=request.data, headers=dict(request.header_items()), method=request.get_method())
    return original_urlopen(request, timeout=timeout)

urllib.request.urlopen = urlopen
sys.argv = ['-', mode]
exec(compile(source, 'worker-update-check', 'exec'))
`;

async function runGuard(base: string, mode: string) {
  const child = spawn(process.env.PYTHON || 'python', ['-c', python, check, base, mode], {
    shell: false,
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { status, stdout, stderr };
}

class StoppedWorker extends WorkerServiceFixture {
  connections = 0;
  requests: string[] = [];
  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.runtimeId = 'fixture:stopped-executor';
    this.status = ConnectionStatus.Offline;
  }
  async connect() {
    this.connections++;
    this.status = ConnectionStatus.Online;
    return { ok: true };
  }
  async request(method: string): Promise<never> {
    this.requests.push(method);
    throw Error('The update fixture must not invoke a model.');
  }
  disconnect() {
    this.status = ConnectionStatus.Offline;
  }
}

async function fixture(t: TestContext) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'worker-update-recovery-'));
  const worker = new StoppedWorker(path.join(dir, 'workspaces'));
  const instance = createWorkerApp({
    dataDir: path.join(dir, 'data'),
    workerFactory: () => worker,
    secretFactory: () => ({
      status: () => ({ configured: false }),
      get: async () => null,
      set: async () => {
        throw Error('Unexpected fixture credential mutation.');
      },
      clear: async () => {
        throw Error('Unexpected fixture credential mutation.');
      },
    }),
  });
  const calls: string[] = [];
  instance.server.prependListener('request', (request) => {
    calls.push(request.method + ' ' + request.url);
  });
  t.after(async () => {
    await instance.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + listeningPort(instance.server);
  const { token } = observedRecord(await (await fetch(base + '/api/session')).json());
  assert.ok(typeof token === 'string');
  const headers = { 'X-Dant-Token': token };
  async function refresh(): Promise<unknown> {
    return await (await fetch(base + '/api/state', { headers })).json();
  }
  const bridge = {
    status: ConnectionStatus.Online,
    cached: { worker: { status: ConnectionStatus.Offline } },
    refresh,
    connect: async () => {
      throw Error('The isolated Worker transport is already connected.');
    },
    pauseWorkForUpdate: async () => {
      throw Error('Stopped executor must take the fresh snapshot path.');
    },
    disconnect() {},
  };
  const desktop = new DesktopLifecycle({
    bridge,
    binding: () => ({ host: 'fixture-vm' }),
    lifecycle: {
      suspend: async () => {
        throw Error('The fixture must not operate a VM.');
      },
      resume: async () => {
        throw Error('The fixture must not operate a VM.');
      },
    },
  });
  t.after(() => desktop.close());
  return { ...instance, worker, desktop, base, calls };
}

test('explicit install composes Desktop preparation and real Worker guard without reviving paused tasks', async (t) => {
  const { worker, desktop, engine, store, base, calls } = await fixture(t);
  const paused = store.add({
    role: 'user',
    text: 'Keep this task paused',
    status: TaskStatus.Paused,
  });
  const before = structuredClone(paused);
  assert.deepEqual(await desktop.prepare(), { ok: true, workPaused: true });
  assert.equal(worker.connections, 0);
  calls.length = 0;
  const result = await runGuard(base, 'pause');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    'GET /api/session',
    'GET /api/state',
    'POST /api/tasks/pause',
    'GET /api/state',
    'POST /api/tasks/pause',
    'GET /api/state',
    'POST /api/connect',
    'GET /api/state',
  ]);
  assert.equal(worker.connections, 1);
  assert.equal(worker.status, ConnectionStatus.Online);
  assert.deepEqual(worker.requests, []);
  assert.deepEqual(engine.queue, []);
  assert.equal(engine.active, null);
  assert.deepEqual(paused, before);
  // This is the separate final guard immediately before the installer swaps files.
  calls.length = 0;
  const final = await runGuard(base, 'final');
  assert.equal(final.status, 0, final.stderr);
  assert.deepEqual(calls, ['GET /api/session', 'GET /api/state']);
  assert.equal(worker.connections, 1);
  assert.deepEqual(worker.requests, []);
});

test('automatic update observes a real stopped Worker without issuing pause or connect', async (t) => {
  const { worker, store, base, calls } = await fixture(t);
  const paused = store.add({ role: 'user', text: 'Still paused', status: TaskStatus.Paused });
  const before = structuredClone(paused);
  calls.length = 0;
  const result = await runGuard(base, 'check');
  assert.equal(result.status, 79, result.stderr);
  assert.match(result.stderr, /^DANT_UPDATE_DEFERRED:executor-offline:initial$/m);
  assert.deepEqual(calls, ['GET /api/session', 'GET /api/state']);
  assert.equal(worker.connections, 0);
  assert.deepEqual(worker.requests, []);
  assert.deepEqual(paused, before);
});

test('legacy snapshot omissions cannot hide finalization from the real Worker recovery witness', async (t) => {
  const { worker, engine, base, calls } = await fixture(t);
  // A pending finalizer is deliberately absent from /api/state in older Workers.
  engine.finishing = Promise.resolve();
  calls.length = 0;
  const result = await runGuard(base, 'pause');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^DANT_UPDATE_FAILED:idle-unconfirmed:final$/m);
  assert.equal(calls.filter((call) => call === 'POST /api/connect').length, 1);
  assert.equal(calls.filter((call) => call === 'POST /api/tasks/pause').length, 2);
  assert.equal(worker.connections, 0);
  assert.deepEqual(worker.requests, []);
  engine.finishing = null;
});
