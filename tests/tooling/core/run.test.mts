import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { coreLaunch, runCoreDevelopment, runCoreProcesses } from '../../../scripts/core/run.mts';
import type { CoreLaunch, CoreProcessServices } from '../../../scripts/core/run.mts';
import { CORE_GUEST_BINARY, CORE_WINDOWS } from '../../../scripts/core/bundle.mts';

test('development launches the verified Go binary with separate dynamic resource and config roots', () => {
  const root = path.resolve('.cache/tests/不同用户 dant');
  const env = { DANT_PORT: '4417', DANT_MANAGED: '1', DANT_DATA: path.join(root, 'private') };
  let verified = false;
  const launch = coreLaunch({
    root,
    env,
    platform: 'win32',
    version: () => '1.2.3',
    verify: (directory, version) => {
      assert.equal(directory, path.join(root, 'src-tauri/resources'));
      assert.equal(version, '1.2.3');
      verified = true;
      return { schemaVersion: 1, version, sourceCommit: 'a'.repeat(40), files: [] };
    },
  });

  assert.equal(verified, true);
  assert.equal(launch.executable, path.join(launch.cwd, CORE_WINDOWS));
  assert.deepEqual(launch.args, ['--role=controller', '--root', launch.cwd, '--config-root', root]);
  assert.equal(launch.env.DANT_DATA, env.DANT_DATA);
  assert.equal(launch.env.DANT_MANAGED_STDIN, '1');
  assert.equal(launch.env.DANT_MANAGED, undefined);
  assert.equal(launch.env.DANT_PORT, '4417');
  assert.equal(env.DANT_MANAGED, '1', 'the caller environment is not mutated');
});

test('Linux development selects its compiled artifact and defaults data to the project root', () => {
  const root = path.resolve('.cache/tests/linux-core-launch');
  const launch = coreLaunch({
    root,
    env: {},
    platform: 'linux',
    version: () => '1.2.3',
    verify: (_directory, version) => ({
      schemaVersion: 1,
      version,
      sourceCommit: 'a'.repeat(40),
      files: [],
    }),
  });

  assert.equal(launch.executable, path.join(launch.cwd, CORE_GUEST_BINARY));
  assert.equal(launch.env.DANT_DATA, path.join(root, 'data'));
});

test('missing or changed compiled resources fail before launching the runtime', () => {
  const root = path.resolve('.cache/tests/rejected-core-launch');
  assert.throws(
    () =>
      coreLaunch({
        root,
        platform: 'win32',
        version: () => '1.2.3',
        verify: () => {
          throw Error('isolated artifact mismatch');
        },
      }),
    /artifact mismatch/,
  );
  assert.throws(() => coreLaunch({ root, platform: 'darwin' }), /not available/);
});

class FixtureChild extends ChildProcess {
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];

  constructor(managed: boolean, pid: number | null = 123) {
    super();
    Object.defineProperty(this, 'pid', { value: pid ?? undefined });
    this.stdin = managed ? new PassThrough() : null;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    Object.defineProperties(this, {
      exitCode: { value: code, configurable: true },
      signalCode: { value: signal, configurable: true },
    });
    this.emit('exit', code, signal);
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    this.finish(null, 'SIGTERM');
    return true;
  }
}

function processFixture(children: FixtureChild[]) {
  const launches: { launch: CoreLaunch; managed: boolean }[] = [];
  const deadlines = new Set<() => void>();
  let terminate = () => {};
  let subscriptions = 0;
  const services: CoreProcessServices = {
    spawn(launch, managed) {
      launches.push({ launch, managed });
      const child = children[launches.length - 1];
      assert.ok(child, 'The fixture admits only the explicitly supplied synthetic children.');
      return child;
    },
    subscribeTermination(listener) {
      terminate = listener;
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
    shutdownDeadline(listener) {
      deadlines.add(listener);
      return () => {
        deadlines.delete(listener);
      };
    },
  };
  return {
    services,
    launches,
    deadlines,
    terminate: () => terminate(),
    subscriptions: () => subscriptions,
  };
}

const fixtureLaunch: CoreLaunch = {
  executable: 'synthetic-compiled-core',
  args: ['--role=controller'],
  cwd: path.resolve('.cache/tests/launcher'),
  env: { DANT_MANAGED_STDIN: '1' },
};

test('a completed core preserves its exit result and releases parent signal ownership', async () => {
  for (const code of [0, 7, null]) {
    const child = new FixtureChild(true);
    const fixture = processFixture([child]);
    const running = runCoreProcesses(fixtureLaunch, undefined, fixture.services);
    child.finish(code, code === null ? 'SIGTERM' : null);

    assert.equal(await running, code ?? 1);
    assert.deepEqual(fixture.launches, [{ launch: fixtureLaunch, managed: true }]);
    assert.equal(fixture.subscriptions(), 0);
    assert.equal(fixture.deadlines.size, 0);
    assert.deepEqual(child.kills, []);
  }
});

test('a dev server exit closes managed stdin and joins the core without a forced kill', async () => {
  const core = new FixtureChild(true);
  const server = new FixtureChild(false);
  const fixture = processFixture([core, server]);
  const development = { ...fixtureLaunch, executable: 'synthetic-dev-server' };
  core.stdin?.once('finish', () => core.finish(0));
  const running = runCoreProcesses(fixtureLaunch, development, fixture.services);
  core.stdin?.emit('error', Object.assign(Error('Synthetic closed pipe'), { code: 'EPIPE' }));
  server.finish(9);

  assert.equal(await running, 9);
  assert.deepEqual(fixture.launches, [
    { launch: fixtureLaunch, managed: true },
    { launch: development, managed: false },
  ]);
  assert.equal(core.stdin?.writableEnded, true);
  assert.deepEqual(core.kills, []);
  assert.equal(fixture.deadlines.size, 0);
  assert.equal(fixture.subscriptions(), 0);
});

test('parent termination stops both children and bounds a core that ignores EOF', async () => {
  const core = new FixtureChild(true);
  const server = new FixtureChild(false);
  const fixture = processFixture([core, server]);
  const running = runCoreProcesses(fixtureLaunch, fixtureLaunch, fixture.services);
  fixture.terminate();
  fixture.terminate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(core.stdin?.writableEnded, true);
  assert.deepEqual(server.kills, [undefined]);
  assert.equal(fixture.deadlines.size, 1);
  for (const deadline of [...fixture.deadlines]) deadline();

  assert.equal(await running, 0);
  assert.deepEqual(core.kills, ['SIGKILL']);
  assert.equal(fixture.subscriptions(), 0);
  assert.equal(fixture.deadlines.size, 0);
});

test('a child spawn error returns failure and releases signal handlers without a timer', async () => {
  const child = new FixtureChild(true, null);
  const fixture = processFixture([child]);
  const running = runCoreProcesses(fixtureLaunch, undefined, fixture.services);
  child.emit('error', Error('Synthetic missing executable'));

  assert.equal(await running, 1);
  assert.deepEqual(child.kills, []);
  assert.equal(fixture.deadlines.size, 0);
  assert.equal(fixture.subscriptions(), 0);
});

test('a synchronous second-child failure still joins the first and releases ownership', async () => {
  const core = new FixtureChild(true);
  const fixture = processFixture([core]);
  const spawn = fixture.services.spawn;
  fixture.services.spawn = (launch, managed) => {
    if (!managed) throw Error('Synthetic process admission failure');
    return spawn(launch, managed);
  };
  core.stdin?.once('finish', () => core.finish(0));

  await assert.rejects(
    runCoreProcesses(fixtureLaunch, fixtureLaunch, fixture.services),
    /admission failure/,
  );
  assert.equal(core.stdin?.writableEnded, true);
  assert.equal(fixture.deadlines.size, 0);
  assert.equal(fixture.subscriptions(), 0);
});

test('an unconfirmed forced stop fails explicitly and releases every cleanup listener', async () => {
  for (const failure of ['false', 'error', 'throw'] as const) {
    const child = new FixtureChild(true);
    const fixture = processFixture([child]);
    let attempts = 0;
    child.kill = () => {
      attempts++;
      if (failure === 'throw') throw Error('Synthetic permission failure');
      if (failure === 'error') child.emit('error', Error('Synthetic permission failure'));
      return false;
    };
    const running = runCoreProcesses(fixtureLaunch, undefined, fixture.services);
    const rejected = assert.rejects(running, /shutdown is unconfirmed/);
    fixture.terminate();
    await new Promise((resolve) => setImmediate(resolve));
    for (const deadline of [...fixture.deadlines]) deadline();
    await rejected;

    assert.equal(attempts, 1, 'An unknown stop outcome never causes repeated kill attempts.');
    assert.equal(fixture.deadlines.size, 0);
    assert.equal(fixture.subscriptions(), 0);
    assert.equal(child.exitCode, null, 'The launcher does not invent an exit acknowledgement.');
  }
});

test('invalid launcher arguments are rejected before environment or process effects', async () => {
  await assert.rejects(runCoreDevelopment(['--unexpected']), /Usage:/);
  await assert.rejects(runCoreDevelopment(['--dev', '--unexpected']), /Usage:/);
});

test('the real process adapter joins harmless fixture children and removes both signal handlers', async () => {
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const before = signals.map((signal) => process.listenerCount(signal));
  const core: CoreLaunch = {
    executable: process.execPath,
    args: ['--input-type=module', '-e', 'process.stdin.resume();'],
    cwd: process.cwd(),
    env: { ...process.env },
  };
  const development = { ...core, args: ['--input-type=module', '-e', 'process.exitCode = 6;'] };

  assert.equal(await runCoreProcesses(core, development), 6);
  assert.deepEqual(
    signals.map((signal) => process.listenerCount(signal)),
    before,
  );
});
