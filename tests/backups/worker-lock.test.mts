import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { withWorkerRestoreLock } from '../../src/backups/worker-lock.mts';
import type { WorkerRestoreOwnerLock } from '../../src/backups/worker-restore.mts';
import { defined } from '../support/fixture-assertions.mts';

function fixture(t: TestContext) {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'worker-kernel-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'),
    workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  const pair = createHash('sha256')
    .update(dataDir)
    .update('\0')
    .update(workspaceRoot)
    .digest('hex')
    .slice(0, 24);
  const owner = path.join(root, '.dant-restore-' + pair + '.lock');
  const kernel = path.join(root, '.dant-restore-' + pair + '.flock');
  const options = {
    dataDir,
    workspaceRoot,
    platform: 'linux' as const,
    runFlock: () => ({ status: 0 }),
  };
  return { root, owner, kernel, options };
}

test('kernel helper inherits the same fd into a fixed nonblocking flock and retains its stable inode', async (t) => {
  const f = fixture(t);
  let descriptor: number | undefined, capability: WorkerRestoreOwnerLock | undefined;
  const options = {
    ...f.options,
    runFlock(
      command: string,
      args: readonly string[],
      options: Parameters<NonNullable<Parameters<typeof withWorkerRestoreLock>[0]['runFlock']>>[2],
    ) {
      assert.equal(command, 'flock');
      assert.deepEqual(args, ['-n', '-E', '79', '3']);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 5000);
      assert.deepEqual(options.stdio.slice(0, 3), ['ignore', 'ignore', 'ignore']);
      descriptor = options.stdio[3];
      assert.equal(fs.fstatSync(descriptor).isFile(), true);
      return { status: 0 };
    },
  };
  const value = await withWorkerRestoreLock(options, async (ownerLock) => {
    capability = ownerLock;
    const release = ownerLock.acquire(f.owner, randomUUID());
    const record: unknown = JSON.parse(fs.readFileSync(f.owner, 'utf8'));
    assert.equal(typeof record, 'object');
    assert.ok(fs.existsSync(f.owner));
    release();
    release();
    assert.equal(fs.existsSync(f.owner), false);
    return 42;
  });
  assert.equal(value, 42);
  assert.throws(() => fs.fstatSync(defined(descriptor)), { code: 'EBADF' });
  assert.throws(() => defined(capability).acquire(f.owner, randomUUID()), {
    code: 'restore_failed',
  });
  const inode = fs.statSync(f.kernel, { bigint: true }).ino;
  await withWorkerRestoreLock(options, () => {});
  assert.equal(fs.statSync(f.kernel, { bigint: true }).ino, inode);
});

test('another platform or missing, failed, or busy kernel facility cannot enter restoration', async (t) => {
  const f = fixture(t);
  for (const platform of ['win32', 'darwin'] as const)
    await assert.rejects(
      withWorkerRestoreLock(
        {
          ...f.options,
          platform,
          runFlock: () => assert.fail('No kernel command on another platform'),
        },
        () => assert.fail('Unsupported host cannot restore'),
      ),
      { code: 'restore_lock_unavailable' },
    );
  assert.equal(fs.existsSync(f.kernel), false);
  for (const status of [79, 1, null])
    await assert.rejects(
      withWorkerRestoreLock(
        {
          ...f.options,
          runFlock: () => ({ status }),
        },
        () => assert.fail('No restore without a proven kernel lock'),
      ),
      { code: status === 79 ? 'backup_busy' : 'restore_lock_unavailable' },
    );
  await assert.rejects(
    withWorkerRestoreLock(
      { ...f.options, runFlock: () => ({ status: null, error: Error('private utility failure') }) },
      () => assert.fail('No PID fallback'),
    ),
    { code: 'restore_lock_unavailable' },
  );
  await assert.rejects(
    withWorkerRestoreLock(
      {
        ...f.options,
        runFlock: () => {
          throw Error('private command output');
        },
      },
      () => assert.fail('No PID fallback'),
    ),
    { code: 'restore_lock_unavailable' },
  );
});

test('owner file acquisition rejects live legacy owners, malformed records and unrelated paths', async (t) => {
  const f = fixture(t),
    restoreId = randomUUID();
  const live = JSON.stringify({ pid: process.pid, restoreId });
  fs.writeFileSync(f.owner, live);
  await withWorkerRestoreLock(f.options, (lock) => {
    assert.throws(() => lock.acquire(f.owner, restoreId), { code: 'backup_busy' });
    assert.equal(fs.readFileSync(f.owner, 'utf8'), live);
    assert.throws(() => lock.acquire(path.join(f.root, 'unrelated'), restoreId), {
      code: 'restore_failed',
    });
    assert.throws(() => lock.acquire(f.owner, 'invalid-id'), { code: 'restore_failed' });
  });
  for (const record of ['not JSON', JSON.stringify({ pid: -1 }), 'x'.repeat(17000)]) {
    fs.writeFileSync(f.owner, record);
    await withWorkerRestoreLock(f.options, (lock) => {
      assert.throws(() => lock.acquire(f.owner, restoreId));
      assert.equal(fs.readFileSync(f.owner, 'utf8'), record);
    });
  }
});

test('a proven exited owner is reclaimed only under kernel ownership and replacement identities are preserved', async (t) => {
  const f = fixture(t),
    dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(dead.status, 0);
  assert.ok(dead.pid > 0);
  fs.writeFileSync(f.owner, JSON.stringify({ pid: dead.pid, restoreId: randomUUID() }));
  await withWorkerRestoreLock(f.options, (lock) => {
    const release = lock.acquire(f.owner, randomUUID());
    assert.ok(fs.existsSync(f.owner));
    release();
    assert.equal(fs.existsSync(f.owner), false);
  });
  let replacement = '';
  await assert.rejects(
    withWorkerRestoreLock(f.options, (lock) => {
      const release = lock.acquire(f.owner, randomUUID());
      fs.renameSync(f.owner, f.owner + '.previous');
      replacement = JSON.stringify({ pid: process.pid, restoreId: randomUUID() });
      fs.writeFileSync(f.owner, replacement);
      assert.throws(release, { code: 'restore_failed' });
    }),
    { code: 'restore_failed' },
  );
  assert.equal(fs.readFileSync(f.owner, 'utf8'), replacement);
});

test('kernel helper cleans owned PID files on callback failure and rejects unsafe root overlap', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    withWorkerRestoreLock(f.options, (lock) => {
      lock.acquire(f.owner, randomUUID());
      throw Error('Isolated restore failed');
    }),
    /Isolated restore failed/,
  );
  assert.equal(fs.existsSync(f.owner), false);
  await assert.rejects(
    withWorkerRestoreLock({ ...f.options, workspaceRoot: f.options.dataDir }, () =>
      assert.fail('No shared roots'),
    ),
    { code: 'restore_failed' },
  );
  await assert.rejects(
    withWorkerRestoreLock(
      { ...f.options, workspaceRoot: path.join(f.options.dataDir, 'nested') },
      () => assert.fail('No nested roots'),
    ),
    { code: 'restore_failed' },
  );
});

test(
  'Linux keeps the kernel lock after the utility exits and excludes a second open-file description',
  {
    skip: process.platform !== 'linux',
  },
  async (t) => {
    const f = fixture(t),
      options = { dataDir: f.options.dataDir, workspaceRoot: f.options.workspaceRoot };
    await withWorkerRestoreLock(options, async () => {
      await assert.rejects(
        withWorkerRestoreLock(options, () => assert.fail('A second owner cannot enter')),
        { code: 'backup_busy' },
      );
    });
    await withWorkerRestoreLock(options, () => {});
  },
);

test(
  'Linux process death releases flock so a new owner can safely reclaim its old PID file',
  {
    skip: process.platform !== 'linux',
    timeout: 15_000,
  },
  async (t) => {
    const f = fixture(t),
      module = pathToFileURL(path.resolve('src/backups/worker-lock.mts')).href;
    const code = `import{withWorkerRestoreLock}from ${JSON.stringify(module)};const[dataDir,workspaceRoot,owner,restoreId]=process.argv.slice(1);await withWorkerRestoreLock({dataDir,workspaceRoot},async(lock)=>{lock.acquire(owner,restoreId);console.log('locked');await new Promise(()=>setInterval(()=>{},1000));});`;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        code,
        f.options.dataDir,
        f.options.workspaceRoot,
        f.owner,
        randomUUID(),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const closed = once(child, 'close');
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const [chunk] = await Promise.race([
      once(defined(child.stdout), 'data'),
      closed.then(() => {
        throw Error('The isolated lock holder exited before acquiring flock.');
      }),
    ]);
    assert.equal(String(chunk).trim(), 'locked');
    await assert.rejects(
      withWorkerRestoreLock(
        { dataDir: f.options.dataDir, workspaceRoot: f.options.workspaceRoot },
        () => assert.fail('Live process holds kernel lock'),
      ),
      { code: 'backup_busy' },
    );
    child.kill('SIGKILL');
    await closed;
    await withWorkerRestoreLock(
      { dataDir: f.options.dataDir, workspaceRoot: f.options.workspaceRoot },
      (lock) => {
        const release = lock.acquire(f.owner, randomUUID());
        release();
      },
    );
    assert.equal(fs.existsSync(f.owner), false);
  },
);
