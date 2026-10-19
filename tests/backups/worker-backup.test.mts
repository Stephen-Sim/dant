import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkerBackup } from '../../src/backups/worker-archive.mts';
import { validateWorkerBackup } from '../../src/backups/archive-stream.mts';
import {
  restoreWorkerBackup,
  inspectWorkerRestore,
  loadedWorkerRestoreInfo,
  recoverWorkerRestore,
  inspectWorkerRestoreRejection,
} from '../../src/backups/worker-restore.mts';
import { runWorkerBackupCli } from '../../src/backups/worker-cli.mts';
import { LocalBackupVault } from '../../src/backups/local-backup-vault.mts';
import { Store } from '../../src/conversation/store.mts';
import { MemoryStore } from '../../src/conversation/memory.mts';
import {
  TaskStatus,
  PlanStepStatus,
  ScheduleStatus,
  TaskPriority,
} from '../../src/contracts/states.mts';
import { observedRecord, observedRecords } from '../support/service-fixtures.mts';
import { defined } from '../support/fixture-assertions.mts';
import type { WorkerRestoreOwnerLock } from '../../src/backups/worker-restore.mts';
import type { withWorkerRestoreLock } from '../../src/backups/worker-lock.mts';
const run = promisify(execFile);
const GIT_CONFIG_SENTINEL = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n';
const GIT_LOCAL_REF = 'ab' + 'c'.repeat(38) + '\n';
const GIT_LOCAL_OBJECT = Buffer.from(
  'local-only history\0retained opaque object bytes\xff',
  'utf8',
);
const GIT_LOCAL_OBJECT_PATH = '.git/objects/ab/' + 'c'.repeat(38);
/** The child has already exited; this test owns the entire isolated directory and has one reconciler. */
function retiredProcessOwnerLock(root: string): WorkerRestoreOwnerLock {
  return {
    acquire(file, restoreId) {
      assert.equal(path.dirname(file), root);
      if (fs.existsSync(file)) {
        const previous = observedRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
        const pid = previous.pid;
        assert.ok(typeof pid === 'number');
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        fs.unlinkSync(file);
      }
      const descriptor = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, restoreId }));
      } finally {
        fs.closeSync(descriptor);
      }
      return () => fs.unlinkSync(file);
    },
  };
}

function fixture(t: TestContext) {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'worker-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'source-data'),
    workspaceRoot = path.join(root, 'source-workspaces');
  fs.mkdirSync(workspaceRoot);
  const store = new Store(dataDir),
    memory = new MemoryStore(dataDir);
  memory.write('working-memory.md', 'Retained project decision');
  const queued = store.add({
      role: 'user',
      text: 'Continue only after explicit reply',
      status: TaskStatus.Queued,
    }),
    unknown = store.add({
      role: 'user',
      text: 'Reconcile the unconfirmed result',
      status: TaskStatus.Unknown,
      unknownOutcome: true,
    }),
    work = store.registerWork({
      turnId: 'retained-owned-turn',
      title: 'Unconfirmed project',
      status: TaskStatus.Unknown,
      source: 'voice',
      plan: { steps: [{ step: 'Verify the existing result', status: PlanStepStatus.Pending }] },
    });
  store.state.threadId = 'old-thread';
  store.state.threadRuntime = 'old-runtime';
  store.save();
  const initial = store.scheduleDatabase.snapshot();
  store.scheduleDatabase.replace(
    initial.revision,
    [
      {
        id: randomUUID(),
        text: 'Do not dispatch automatically after restoring',
        at: 1000,
        status: ScheduleStatus.Pending,
        enabled: true,
        priority: TaskPriority.Normal,
      },
    ],
    [],
  );
  const conversation = path.join(workspaceRoot, store.state.conversationId);
  for (const directory of [
    '.agents/skills/active',
    '.dant-disabled-skills/retained',
    'node_modules/pkg',
    '.git/objects/ab',
    '.git/refs/heads',
    '.ssh',
    '.codex',
    '.openai',
    '.cache',
    'output',
  ])
    fs.mkdirSync(path.join(conversation, directory), { recursive: true });
  fs.writeFileSync(path.join(conversation, '.agents/skills/active/SKILL.md'), '# Active skill');
  fs.writeFileSync(
    path.join(conversation, '.dant-disabled-skills/retained/SKILL.md'),
    '# Disabled skill',
  );
  fs.writeFileSync(path.join(conversation, 'node_modules/pkg/cache'), 'regenerable');
  fs.writeFileSync(path.join(conversation, '.git/config'), GIT_CONFIG_SENTINEL);
  fs.writeFileSync(path.join(conversation, '.git/HEAD'), 'ref: refs/heads/local-only\n');
  fs.writeFileSync(path.join(conversation, '.git/refs/heads/local-only'), GIT_LOCAL_REF);
  fs.writeFileSync(path.join(conversation, GIT_LOCAL_OBJECT_PATH), GIT_LOCAL_OBJECT);
  for (const name of ['.ssh/id_ed25519', '.codex/auth.json', '.openai/auth.json', '.cache/result'])
    fs.writeFileSync(
      path.join(conversation, name),
      'isolated excluded authentication or cache fixture',
    );
  fs.writeFileSync(path.join(conversation, 'output/result.txt'), 'Retained artifact');
  fs.mkdirSync(path.join(dataDir, 'credentials'));
  fs.writeFileSync(path.join(dataDir, 'credentials/vault.enc'), 'isolated encrypted fixture');
  fs.writeFileSync(path.join(dataDir, 'credentials/master.key'), 'isolated fixture key');
  fs.writeFileSync(
    path.join(dataDir, 'telegram.json'),
    JSON.stringify({ enabled: true, outbox: [{ id: 'delivery', status: 'sending' }] }),
  );
  const options = {
    dataDir,
    workspaceRoot,
    appVersion: '0.4.7-beta.8',
    sourceId: 'isolated-source',
    temporaryRoot: root,
  };
  return {
    root,
    dataDir,
    workspaceRoot,
    store,
    memory,
    queued,
    unknown,
    work,
    conversation,
    options,
  };
}
async function buffer(input: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const value of input) {
    assert.ok(Buffer.isBuffer(value) || typeof value === 'string');
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
test('backup captures actual SQLite memory, schedules, attachments and both enabled and disabled skills', async (t) => {
  const { root, options, store } = fixture(t),
    snapshot = createWorkerBackup(options),
    staging = path.join(root, 'decoded');
  fs.mkdirSync(staging);
  try {
    const decoded = await validateWorkerBackup({ input: snapshot.stream, stagingDir: staging }),
      names = decoded.entries.map((entry) => entry.domain + '/' + entry.path);
    assert.ok(names.includes('data/memory/dant/memory.sqlite'));
    assert.ok(names.includes('data/schedules/schedules.sqlite'));
    assert.ok(names.includes('data/credentials/vault.enc'));
    assert.ok(names.includes('data/credentials/master.key'));
    assert.ok(
      names.includes('workspace/' + store.state.conversationId + '/.agents/skills/active/SKILL.md'),
    );
    assert.ok(
      names.includes(
        'workspace/' + store.state.conversationId + '/.dant-disabled-skills/retained/SKILL.md',
      ),
    );
    assert.ok(names.includes('workspace/' + store.state.conversationId + '/.git/config'));
    assert.ok(
      names.includes('workspace/' + store.state.conversationId + '/.git/refs/heads/local-only'),
    );
    assert.ok(
      names.includes('workspace/' + store.state.conversationId + '/' + GIT_LOCAL_OBJECT_PATH),
    );
    assert.ok(
      !names.some(
        (name) =>
          name.includes('/node_modules/') ||
          name.includes('/.cache/') ||
          name.includes('/.ssh/') ||
          name.includes('/.codex/') ||
          name.includes('/.openai/') ||
          /-(wal|shm|journal)$/.test(name),
      ),
    );
    assert.equal(
      new MemoryStore(path.join(staging, 'data')).read('working-memory.md'),
      'Retained project decision',
    );
    assert.equal(new Store(path.join(staging, 'data')).scheduleDatabase.snapshot().items.length, 1);
    assert.equal(
      snapshot.metadata.files,
      names.filter(
        (name) =>
          decoded.entries.find((entry) => entry.domain + '/' + entry.path === name)?.directory ===
          false,
      ).length,
    );
  } finally {
    snapshot.cleanup();
    snapshot.cleanup();
  }
});
test('source file replacement and a concurrent SQLite commit invalidate staging without changing source work', (t) => {
  const { options, store, queued } = fixture(t);
  let validations = 0;
  assert.throws(
    () =>
      createWorkerBackup({
        ...options,
        validateCurrent() {
          if (++validations === 2) {
            const previous = fs.readFileSync(store.file);
            fs.writeFileSync(store.file + '.replacement', previous);
            fs.renameSync(store.file + '.replacement', store.file);
          }
        },
      }),
    { code: 'source_changed' },
  );
  validations = 0;
  assert.throws(
    () =>
      createWorkerBackup({
        ...options,
        validateCurrent() {
          if (++validations === 2) {
            const db = new DatabaseSync(store.scheduleDatabase.file);
            try {
              db.exec('UPDATE schedule_meta SET revision=revision+1');
            } finally {
              db.close();
            }
          }
        },
      }),
    { code: 'source_changed' },
  );
  assert.equal(
    store.state.messages.find((message) => message.id === queued.id)?.status,
    TaskStatus.Queued,
  );
});
test('restore replaces both owned roots after validation, keeps history and unknown outcomes, and disables future work', async (t) => {
  const { root, options, store, queued, unknown, work } = fixture(t),
    snapshot = createWorkerBackup(options),
    targetData = path.join(root, 'target-data'),
    targetWorkspace = path.join(root, 'target-workspaces');
  fs.mkdirSync(targetData);
  fs.mkdirSync(targetWorkspace);
  fs.writeFileSync(path.join(targetData, 'old.txt'), 'existing target');
  const restoreId = randomUUID(),
    target = { dataDir: targetData, workspaceRoot: targetWorkspace, restoreId, assertOffline() {} };
  try {
    assert.deepEqual(await restoreWorkerBackup({ ...target, input: snapshot.stream }), {
      restored: true,
      restoreId,
    });
    assert.equal(fs.existsSync(path.join(targetData, 'old.txt')), false);
    const restored = new Store(targetData);
    assert.equal(restored.state.conversationId, store.state.conversationId);
    assert.equal(restored.state.threadId, null);
    assert.equal(restored.state.threadRuntime, null);
    assert.equal(
      restored.state.messages.find((message) => message.id === queued.id)?.status,
      TaskStatus.Paused,
    );
    assert.equal(
      restored.state.messages.find((message) => message.id === unknown.id)?.status,
      TaskStatus.Unknown,
    );
    assert.equal(
      restored.state.messages.find((message) => message.id === unknown.id)?.unknownOutcome,
      true,
    );
    assert.equal(
      restored.state.workTasks.find((record) => record.id === work.id)?.status,
      TaskStatus.Unknown,
    );
    const schedule = defined(restored.scheduleDatabase.snapshot().items[0]);
    assert.equal(schedule.enabled, false);
    assert.equal(schedule.status, ScheduleStatus.Paused);
    assert.equal(
      new MemoryStore(targetData).read('working-memory.md'),
      'Retained project decision',
    );
    assert.equal(
      fs.readFileSync(
        path.join(targetWorkspace, store.state.conversationId, '.agents/skills/active/SKILL.md'),
        'utf8',
      ),
      '# Active skill',
    );
    const telegram = observedRecord(
      JSON.parse(fs.readFileSync(path.join(targetData, 'telegram.json'), 'utf8')),
    );
    assert.equal(telegram.enabled, false);
    assert.equal(defined(observedRecords(telegram.outbox)[0]).status, 'unknown');
    assert.deepEqual(inspectWorkerRestore(target), { restored: true, restoreId });
    const loaded = loadedWorkerRestoreInfo(target);
    assert.deepEqual(loaded, { restored: true, restoreId });
    assert.deepEqual(
      await restoreWorkerBackup({
        ...target,
        input: Readable.from(['never consumed after committed id']),
      }),
      { restored: true, restoreId },
    );
  } finally {
    snapshot.cleanup();
  }
});
test('each failed installation rename rolls both roots back and leaves no restored receipt', async (t) => {
  for (const failAt of [2, 3, 4, 5]) {
    const { root, options } = fixture(t),
      snapshot = createWorkerBackup(options),
      dataDir = path.join(root, 'target-data'),
      workspaceRoot = path.join(root, 'target-workspaces');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(workspaceRoot);
    fs.writeFileSync(path.join(dataDir, 'original'), 'data');
    fs.writeFileSync(path.join(workspaceRoot, 'original'), 'workspace');
    let calls = 0;
    const target = {
      dataDir,
      workspaceRoot,
      restoreId: randomUUID(),
      assertOffline() {},
      rename(from: string, to: string) {
        if (++calls === failAt) throw Error('isolated rename failure');
        fs.renameSync(from, to);
      },
    };
    try {
      await assert.rejects(restoreWorkerBackup({ ...target, input: snapshot.stream }), {
        code: 'restore_failed',
      });
      assert.equal(fs.readFileSync(path.join(dataDir, 'original'), 'utf8'), 'data');
      assert.equal(fs.readFileSync(path.join(workspaceRoot, 'original'), 'utf8'), 'workspace');
      assert.deepEqual(inspectWorkerRestore(target), {
        restored: false,
        restoreId: target.restoreId,
      });
    } finally {
      snapshot.cleanup();
    }
  }
});
test('offline guards and malformed input reject without replacing live roots', async (t) => {
  const { root } = fixture(t),
    dataDir = path.join(root, 'live-data'),
    workspaceRoot = path.join(root, 'live-workspace');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(dataDir, 'original'), 'keep');
  const target = {
    dataDir,
    workspaceRoot,
    restoreId: randomUUID(),
    assertOffline() {
      throw Error('still running');
    },
  };
  await assert.rejects(
    restoreWorkerBackup({ ...target, input: Readable.from(['bad']) }),
    /still running/,
  );
  await assert.rejects(
    restoreWorkerBackup({ ...target, assertOffline() {}, input: Readable.from(['bad']) }),
    { code: 'restore_failed' },
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'original'), 'utf8'), 'keep');
});
test('the CLI emits only a bounded JSON receipt and inspect never replays the archive', async (t) => {
  const { root, options } = fixture(t),
    snapshot = createWorkerBackup(options),
    dataDir = path.join(root, 'cli-data'),
    workspaceRoot = path.join(root, 'cli-workspace');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  const restoreId = randomUUID(),
    args = ['--data-dir', dataDir, '--workspace-root', workspaceRoot, '--restore-id', restoreId];
  const withLock: typeof withWorkerRestoreLock = async (_options, operation) =>
    operation(retiredProcessOwnerLock(root));
  const output: Buffer[] = [],
    sink = new Writable({
      write(chunk: unknown, _encoding, done) {
        assert.ok(Buffer.isBuffer(chunk));
        output.push(chunk);
        done();
      },
    });
  try {
    const encoded = await buffer(snapshot.stream);
    await runWorkerBackupCli(['restore', ...args], {
      input: Readable.from([encoded]),
      output: sink,
      assertOffline() {},
      withLock,
    });
    await runWorkerBackupCli(['inspect', ...args], {
      output: sink,
      assertOffline() {
        throw Error('inspect does not stop or change the service');
      },
      withLock,
    });
    assert.equal(
      Buffer.concat(output).toString(),
      (JSON.stringify({ restored: true, restoreId }) + '\n').repeat(2),
    );
    await assert.rejects(
      runWorkerBackupCli(['restore', ...args, '--unknown', 'value'], { output: sink }),
      { code: 'invalid_backup' },
    );
  } finally {
    snapshot.cleanup();
  }
});

test('a process crash during the two-root swap is reconciled offline by rollback, never by replaying the import', async (t) => {
  const { root, options } = fixture(t),
    snapshot = createWorkerBackup(options),
    archiveFile = path.join(root, 'fixture.backup'),
    dataDir = path.join(root, 'crash-data'),
    workspaceRoot = path.join(root, 'crash-workspaces'),
    restoreId = randomUUID();
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(dataDir, 'original'), 'data');
  fs.writeFileSync(path.join(workspaceRoot, 'original'), 'workspace');
  try {
    fs.writeFileSync(archiveFile, await buffer(snapshot.stream));
    const moduleUrl = pathToFileURL(path.resolve('src/backups/worker-restore.mts')).href;
    const code = `import fs from 'node:fs';import {restoreWorkerBackup} from ${JSON.stringify(moduleUrl)};const [archive,dataDir,workspaceRoot,restoreId]=process.argv.slice(1);await restoreWorkerBackup({dataDir,workspaceRoot,restoreId,input:fs.createReadStream(archive),assertOffline(){},rename(from,to){if(to===workspaceRoot&&from.endsWith('-workspace.new'))process.exit(23);fs.renameSync(from,to)}});`;
    await assert.rejects(
      run(
        process.execPath,
        ['--input-type=module', '-e', code, archiveFile, dataDir, workspaceRoot, restoreId],
        { timeout: 15000 },
      ),
      { code: 23 },
    );
    const target = { dataDir, workspaceRoot, restoreId, assertOffline() {} };
    assert.throws(
      () => inspectWorkerRestore(target),
      { code: 'restore_failed' },
      'a staged receipt cannot confirm an uncommitted multi-root swap',
    );
    assert.equal(
      inspectWorkerRestoreRejection(target).rejected,
      false,
      'a process crash has no completed rejection witness',
    );
    assert.deepEqual(
      recoverWorkerRestore({ ...target, ownerLock: retiredProcessOwnerLock(root) }),
      { restored: false, restoreId },
    );
    assert.equal(fs.readFileSync(path.join(dataDir, 'original'), 'utf8'), 'data');
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'original'), 'utf8'), 'workspace');
    assert.deepEqual(inspectWorkerRestore(target), { restored: false, restoreId });
  } finally {
    snapshot.cleanup();
  }
});

test('crashes before staging and journal replacement always recover from the last durable journal', async (t) => {
  for (const crash of ['prepared', 'staged-data', 'installing', 'committed']) {
    const { root, options } = fixture(t),
      snapshot = createWorkerBackup(options),
      archiveFile = path.join(root, 'fixture.backup'),
      dataDir = path.join(root, 'crash-data'),
      workspaceRoot = path.join(root, 'crash-workspaces'),
      restoreId = randomUUID();
    fs.mkdirSync(dataDir);
    fs.mkdirSync(workspaceRoot);
    fs.writeFileSync(path.join(dataDir, 'original'), 'data');
    fs.writeFileSync(path.join(workspaceRoot, 'original'), 'workspace');
    try {
      const encoded = await buffer(snapshot.stream);
      fs.writeFileSync(archiveFile, encoded);
      const moduleUrl = pathToFileURL(path.resolve('src/backups/worker-restore.mts')).href;
      const code = `import fs from 'node:fs';import {restoreWorkerBackup} from ${JSON.stringify(moduleUrl)};const [archive,dataDir,workspaceRoot,restoreId,crash]=process.argv.slice(1);const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(from).endsWith('.json.tmp')&&JSON.parse(fs.readFileSync(from,'utf8')).phase===crash)process.exit(24);rename(from,to);if(crash==='staged-data'&&String(to).endsWith('-data.new'))process.exit(24)};await restoreWorkerBackup({dataDir,workspaceRoot,restoreId,input:fs.createReadStream(archive),assertOffline(){}});`;
      await assert.rejects(
        run(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            code,
            archiveFile,
            dataDir,
            workspaceRoot,
            restoreId,
            crash,
          ],
          { timeout: 15000 },
        ),
        { code: 24 },
      );
      const target = { dataDir, workspaceRoot, restoreId, assertOffline() {} };
      assert.deepEqual(
        recoverWorkerRestore({ ...target, ownerLock: retiredProcessOwnerLock(root) }),
        { restored: false, restoreId },
      );
      assert.equal(fs.readFileSync(path.join(dataDir, 'original'), 'utf8'), 'data', crash);
      assert.equal(
        fs.readFileSync(path.join(workspaceRoot, 'original'), 'utf8'),
        'workspace',
        crash,
      );
      assert.ok(
        !fs
          .readdirSync(root)
          .some(
            (name) =>
              name.endsWith('.json.tmp') ||
              (name.includes(restoreId) && /\.(new|previous|failed)$/.test(name)),
          ),
      );
      assert.deepEqual(
        await restoreWorkerBackup({ ...target, input: Readable.from([encoded]) }),
        { restored: true, restoreId },
        'the first explicitly authorized retry works after reconciliation',
      );
    } finally {
      snapshot.cleanup();
    }
  }
});

test('a stale owner file is fail closed without an independently held kernel lock capability', async (t) => {
  const { root } = fixture(t),
    dataDir = path.join(root, 'locked-data'),
    workspaceRoot = path.join(root, 'locked-workspaces');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  const pair = createHash('sha256')
      .update(dataDir)
      .update('\0')
      .update(workspaceRoot)
      .digest('hex')
      .slice(0, 24),
    file = path.join(root, '.dant-restore-' + pair + '.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, restoreId: randomUUID() }));
  const previous = fs.readFileSync(file),
    target = { dataDir, workspaceRoot, restoreId: randomUUID(), assertOffline() {} };
  assert.throws(() => recoverWorkerRestore(target), { code: 'backup_busy' });
  await assert.rejects(restoreWorkerBackup({ ...target, input: Readable.from([]) }), {
    code: 'backup_busy',
  });
  assert.deepEqual(
    fs.readFileSync(file),
    previous,
    "no stale-read unlink can delete a different reconciler's ownership",
  );
});

test('overlapping restore targets and simultaneous imports cannot overwrite an admitted restore', async (t) => {
  const { root, options } = fixture(t),
    snapshot = createWorkerBackup(options),
    dataDir = path.join(root, 'concurrent-data'),
    workspaceRoot = path.join(root, 'concurrent-workspaces');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  let release = () => {},
    started = () => {};
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
  const encoded = await buffer(snapshot.stream);
  async function* input() {
    started();
    await gate;
    yield encoded;
  }
  const target = { dataDir, workspaceRoot, restoreId: randomUUID(), assertOffline() {} };
  try {
    const first = restoreWorkerBackup({ ...target, input: input() });
    await admitted;
    await assert.rejects(
      restoreWorkerBackup({ ...target, restoreId: randomUUID(), input: Readable.from([encoded]) }),
      { code: 'backup_busy' },
    );
    release();
    await first;
    await assert.rejects(
      restoreWorkerBackup({
        ...target,
        workspaceRoot: path.join(dataDir, 'nested'),
        input: Readable.from([encoded]),
      }),
      { code: 'invalid_backup' },
    );
  } finally {
    release();
    snapshot.cleanup();
  }
});

test('linked sources are rejected and data WAL databases use SQLite snapshots without raw sidecars', async (t) => {
  const { root, options, dataDir, workspaceRoot } = fixture(t),
    external = path.join(root, 'outside');
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(workspaceRoot, 'linked'), 'junction');
  assert.throws(() => createWorkerBackup(options), { code: 'invalid_backup' });
  fs.unlinkSync(path.join(workspaceRoot, 'linked'));
  const file = path.join(dataDir, 'artifact.sqlite'),
    db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE artifact(value TEXT); INSERT INTO artifact VALUES ('committed artifact')",
  );
  const snapshot = createWorkerBackup(options),
    stagingDir = path.join(root, 'wal-decoded');
  fs.mkdirSync(stagingDir);
  try {
    const decoded = await validateWorkerBackup({ input: snapshot.stream, stagingDir });
    assert.ok(
      !decoded.entries.some((entry) => entry.path.endsWith('-wal') || entry.path.endsWith('-shm')),
    );
    const restored = new DatabaseSync(path.join(stagingDir, 'data', 'artifact.sqlite'), {
      readOnly: true,
    });
    try {
      assert.equal(
        restored.prepare('SELECT value FROM artifact').get()?.value,
        'committed artifact',
      );
    } finally {
      restored.close();
    }
  } finally {
    snapshot.cleanup();
    db.close();
  }
});

test('an exclusively locked workspace database and its rollback journal roundtrip without opening SQLite', async (t) => {
  const { root, options, workspaceRoot } = fixture(t),
    project = path.join(workspaceRoot, 'browser-profile');
  fs.mkdirSync(project);
  const file = path.join(project, 'external.sqlite'),
    db = new DatabaseSync(file);
  let snapshot: ReturnType<typeof createWorkerBackup> | undefined;
  try {
    db.exec(
      "CREATE TABLE artifact(value TEXT); INSERT INTO artifact VALUES ('committed'); BEGIN EXCLUSIVE; UPDATE artifact SET value='uncommitted'",
    );
    assert.throws(
      () => {
        const other = new DatabaseSync(file, { readOnly: true });
        try {
          other.prepare('PRAGMA data_version').get();
        } finally {
          other.close();
        }
      },
      (error: unknown) => observedRecord(error).errcode === 5,
    );
    const expected = new Map(
      ['', '-journal'].map((suffix) => [suffix, fs.readFileSync(file + suffix)]),
    );
    snapshot = createWorkerBackup(options);
    const dataDir = path.join(root, 'locked-roundtrip-data'),
      restoredWorkspace = path.join(root, 'locked-roundtrip-workspaces');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(restoredWorkspace);
    await restoreWorkerBackup({
      dataDir,
      workspaceRoot: restoredWorkspace,
      restoreId: randomUUID(),
      assertOffline() {},
      input: snapshot.stream,
    });
    for (const [suffix, bytes] of expected) {
      assert.deepEqual(fs.readFileSync(file + suffix), bytes, 'capture leaves source bytes intact');
      assert.deepEqual(
        fs.readFileSync(
          path.join(restoredWorkspace, 'browser-profile', 'external.sqlite' + suffix),
        ),
        bytes,
      );
    }
    assert.ok(
      new Store(dataDir).state.workTasks.every((work) => work.status === TaskStatus.Unknown),
    );
  } finally {
    snapshot?.cleanup();
    db.exec('ROLLBACK');
    db.close();
  }
});

test('workspace WAL and SHM files are preserved with their database as exact ordinary bytes', async (t) => {
  const { root, options, workspaceRoot } = fixture(t),
    file = path.join(workspaceRoot, 'external.sqlite'),
    db = new DatabaseSync(file);
  let snapshot: ReturnType<typeof createWorkerBackup> | undefined;
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE artifact(value TEXT); INSERT INTO artifact VALUES ('retained external data')",
    );
    const expected = new Map(
      ['', '-wal', '-shm'].map((suffix) => [suffix, fs.readFileSync(file + suffix)]),
    );
    snapshot = createWorkerBackup(options);
    const stagingDir = path.join(root, 'workspace-wal-decoded');
    fs.mkdirSync(stagingDir);
    const decoded = await validateWorkerBackup({ input: snapshot.stream, stagingDir });
    for (const [suffix, bytes] of expected) {
      const relative = 'external.sqlite' + suffix;
      assert.ok(
        decoded.entries.some((entry) => entry.domain === 'workspace' && entry.path === relative),
      );
      assert.deepEqual(fs.readFileSync(path.join(stagingDir, 'workspace', relative)), bytes);
      assert.deepEqual(fs.readFileSync(file + suffix), bytes);
    }
  } finally {
    snapshot?.cleanup();
    db.close();
  }
});

test('whole-capture checks reject changed, added or removed external database group members', async (t) => {
  for (const change of ['main', 'wal', 'shm', 'journal', 'add-journal', 'remove-wal'] as const)
    await t.test(change, (child) => {
      const { options, workspaceRoot } = fixture(child),
        file = path.join(workspaceRoot, 'opaque.sqlite');
      fs.writeFileSync(file, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(128)]));
      for (const suffix of ['-wal', '-shm', '-journal'])
        if (change !== 'add-journal' || suffix !== '-journal')
          fs.writeFileSync(file + suffix, 'isolated opaque sidecar');
      let validations = 0;
      assert.throws(
        () =>
          createWorkerBackup({
            ...options,
            validateCurrent() {
              if (++validations !== 2) return;
              if (change === 'remove-wal') fs.unlinkSync(file + '-wal');
              else if (change === 'add-journal') fs.writeFileSync(file + '-journal', 'new sidecar');
              else fs.appendFileSync(file + (change === 'main' ? '' : '-' + change), 'changed');
            },
          }),
        { code: 'source_changed' },
      );
    });
});

test('external database sidecars still reject hard links and symbolic links', async (t) => {
  for (const link of ['hard', 'symbolic'] as const)
    await t.test(link, (child) => {
      const { root, options, workspaceRoot } = fixture(child),
        file = path.join(workspaceRoot, 'opaque.sqlite'),
        external = path.join(root, 'external');
      fs.writeFileSync(file, Buffer.from('SQLite format 3\0isolated opaque database'));
      if (link === 'hard') {
        fs.writeFileSync(external, 'retained external bytes');
        fs.linkSync(external, file + '-wal');
      } else {
        fs.mkdirSync(external);
        fs.symlinkSync(external, file + '-wal', 'junction');
      }
      assert.throws(() => createWorkerBackup(options), { code: 'invalid_backup' });
      assert.ok(fs.existsSync(external));
    });
});

function firefoxProfileFixture(t: TestContext, domain: 'data' | 'workspace' = 'workspace') {
  const source = fixture(t),
    profile = path.join(
      domain === 'data' ? source.dataDir : source.workspaceRoot,
      'browser-profile',
    ),
    external = path.join(source.root, 'external-lock-target');
  fs.mkdirSync(profile);
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'must-not-follow.txt'), 'outside retained source');
  for (const marker of ['prefs.js', 'times.json', 'compatibility.ini'])
    fs.writeFileSync(path.join(profile, marker), 'isolated profile marker');
  fs.writeFileSync(
    path.join(profile, 'places.sqlite'),
    Buffer.from('SQLite format 3\0opaque external database'),
  );
  const lock = path.join(profile, 'lock');
  // Junction creation is available without symbolic-link privileges on Windows.
  // The readlink fixture models Firefox's Linux dangling host/PID target exactly.
  fs.symlinkSync(external, lock, 'junction');
  let target = 'profile-host:+123';
  t.mock.method(fs, 'readlinkSync', (file: fs.PathLike) => {
    assert.equal(file, lock, 'only the lock itself may be inspected');
    return target;
  });
  return {
    ...source,
    profile,
    external,
    lock,
    setTarget(value: string) {
      target = value;
    },
  };
}

test('validated Firefox PID locks are omitted without following their target or omitting profile data', async (t) => {
  const { root, options, external } = firefoxProfileFixture(t),
    snapshot = createWorkerBackup(options),
    stagingDir = path.join(root, 'firefox-decoded');
  fs.mkdirSync(stagingDir);
  try {
    const decoded = await validateWorkerBackup({ input: snapshot.stream, stagingDir });
    assert.equal(
      fs.existsSync(path.join(stagingDir, 'workspace', 'browser-profile', 'lock')),
      false,
    );
    for (const marker of ['prefs.js', 'times.json', 'compatibility.ini', 'places.sqlite'])
      assert.ok(
        decoded.entries.some(
          (entry) => entry.domain === 'workspace' && entry.path === 'browser-profile/' + marker,
        ),
      );
    assert.ok(!decoded.entries.some((entry) => entry.path.includes('must-not-follow')));
    assert.equal(
      fs.readFileSync(path.join(external, 'must-not-follow.txt'), 'utf8'),
      'outside retained source',
    );
  } finally {
    snapshot.cleanup();
  }
});

test('unknown lock targets and incomplete or linked Firefox profile markers are rejected', async (t) => {
  for (const target of [
    'outside/path',
    'profile-host:123',
    'profile-host:+0',
    'profile-host:+123/path',
    'profile-host:+123\n',
  ])
    await t.test(target, (child) => {
      const source = firefoxProfileFixture(child);
      source.setTarget(target);
      assert.throws(() => createWorkerBackup(source.options), { code: 'invalid_backup' });
    });
  for (const marker of ['missing', 'linked', 'not-sqlite'] as const)
    await t.test(marker, (child) => {
      const source = firefoxProfileFixture(child),
        file = path.join(source.profile, marker === 'not-sqlite' ? 'places.sqlite' : 'prefs.js');
      if (marker === 'not-sqlite') fs.writeFileSync(file, 'not a SQLite profile');
      else {
        fs.unlinkSync(file);
        if (marker === 'linked')
          fs.linkSync(path.join(source.external, 'must-not-follow.txt'), file);
      }
      assert.throws(() => createWorkerBackup(source.options), { code: 'invalid_backup' });
    });
  await t.test('data-tree profile lock', (child) => {
    const source = firefoxProfileFixture(child, 'data');
    assert.throws(() => createWorkerBackup(source.options), { code: 'invalid_backup' });
  });
});

test('Firefox lock identity, target and profile marker changes invalidate the whole capture', async (t) => {
  for (const change of ['identity', 'target', 'marker'] as const)
    await t.test(change, (child) => {
      const source = firefoxProfileFixture(child);
      let validations = 0;
      assert.throws(
        () =>
          createWorkerBackup({
            ...source.options,
            validateCurrent() {
              if (++validations !== 2) return;
              if (change === 'identity') {
                fs.unlinkSync(source.lock);
                fs.symlinkSync(source.external, source.lock, 'junction');
              } else if (change === 'target') source.setTarget('profile-host:+456');
              else fs.appendFileSync(path.join(source.profile, 'prefs.js'), 'changed');
            },
          }),
        { code: 'source_changed' },
      );
    });
});

test('locked or corrupt data SQLite databases still prevent backup', async (t) => {
  await t.test('locked', (child) => {
    const { options, dataDir } = fixture(child),
      file = path.join(dataDir, 'owned.sqlite'),
      db = new DatabaseSync(file);
    try {
      db.exec(
        "CREATE TABLE artifact(value TEXT); INSERT INTO artifact VALUES ('retained'); BEGIN EXCLUSIVE; UPDATE artifact SET value='uncommitted'",
      );
      assert.throws(
        () => createWorkerBackup(options),
        (error: unknown) => observedRecord(error).errcode === 5,
      );
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
  });
  await t.test('corrupt schedule database', (child) => {
    const { options, store } = fixture(child);
    fs.writeFileSync(
      store.scheduleDatabase.file,
      Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(128)]),
    );
    assert.throws(() => createWorkerBackup(options), { code: 'ERR_SQLITE_ERROR' });
  });
});

test('a real Worker stream survives the encrypted Controller vault and restores only as paused or unknown work', async (t) => {
  const { root, options, store, queued, unknown } = fixture(t),
    snapshot = createWorkerBackup(options),
    vaultDir = path.join(root, 'controller'),
    dataDir = path.join(root, 'roundtrip-data'),
    workspaceRoot = path.join(root, 'roundtrip-workspaces');
  fs.mkdirSync(vaultDir);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  const vault = new LocalBackupVault(vaultDir, {
      async protect(secret) {
        return Buffer.from('isolated-protection:' + secret);
      },
      async unprotect(blob) {
        const wrapped = blob.toString('utf8');
        assert.ok(wrapped.startsWith('isolated-protection:'));
        return wrapped.slice('isolated-protection:'.length);
      },
    }),
    id = randomUUID(),
    restoreId = randomUUID();
  try {
    await vault.save(snapshot.stream, {
      ...snapshot.metadata,
      id,
      source: createHash('sha256').update(options.sourceId).digest('hex').slice(0, 12),
    });
    assert.equal(fs.readFileSync(vault.file(id)).includes(Buffer.from('DANT-BACKUP/1\n')), false);
    const opened = await vault.open(id);
    try {
      assert.equal(opened.metadata.files, snapshot.metadata.files);
      assert.equal(opened.metadata.bytes, snapshot.metadata.bytes);
      assert.deepEqual(
        await restoreWorkerBackup({
          dataDir,
          workspaceRoot,
          restoreId,
          input: opened.stream(),
          assertOffline() {},
        }),
        { restored: true, restoreId },
      );
    } finally {
      await opened.close();
    }
    const restored = new Store(dataDir);
    assert.equal(restored.state.conversationId, store.state.conversationId);
    assert.equal(
      restored.state.messages.find((message) => message.id === queued.id)?.status,
      TaskStatus.Paused,
    );
    assert.equal(
      restored.state.messages.find((message) => message.id === unknown.id)?.status,
      TaskStatus.Unknown,
    );
    assert.equal(restored.scheduleDatabase.snapshot().items[0]?.enabled, false);
    assert.equal(new MemoryStore(dataDir).read('working-memory.md'), 'Retained project decision');
    const restoredRepository = path.join(workspaceRoot, store.state.conversationId);
    assert.equal(
      fs.readFileSync(path.join(restoredRepository, '.git/config'), 'utf8'),
      GIT_CONFIG_SENTINEL,
    );
    assert.equal(
      fs.readFileSync(path.join(restoredRepository, '.git/HEAD'), 'utf8'),
      'ref: refs/heads/local-only\n',
    );
    assert.equal(
      fs.readFileSync(path.join(restoredRepository, '.git/refs/heads/local-only'), 'utf8'),
      GIT_LOCAL_REF,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(restoredRepository, GIT_LOCAL_OBJECT_PATH)),
      GIT_LOCAL_OBJECT,
    );
    for (const name of ['node_modules', '.cache', '.ssh', '.codex', '.openai'])
      assert.equal(fs.existsSync(path.join(restoredRepository, name)), false, name);
  } finally {
    snapshot.cleanup();
  }
});

test('finish continues only a proven committed restore under the kernel lease and never consumes input or reapplies data', async (t) => {
  const { root, options } = fixture(t),
    snapshot = createWorkerBackup(options),
    dataDir = path.join(root, 'finish-data'),
    workspaceRoot = path.join(root, 'finish-workspaces'),
    restoreId = randomUUID();
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  const target = { dataDir, workspaceRoot, restoreId, assertOffline() {} },
    args = ['--data-dir', dataDir, '--workspace-root', workspaceRoot, '--restore-id', restoreId];
  let held = false,
    running = false,
    starts = 0,
    states = 0,
    consumed = false;
  const withLock: typeof withWorkerRestoreLock = async (_options, operation) => {
    assert.equal(held, false);
    held = true;
    try {
      return await operation(retiredProcessOwnerLock(root));
    } finally {
      held = false;
    }
  };
  const service = {
    state() {
      assert.equal(held, true);
      states++;
      return { running };
    },
    start() {
      assert.equal(held, true);
      starts++;
      running = true;
    },
  };
  const output: Buffer[] = [],
    sink = new Writable({
      write(chunk: unknown, _encoding, done) {
        assert.ok(Buffer.isBuffer(chunk));
        output.push(chunk);
        done();
      },
    });
  async function* forbiddenInput() {
    consumed = true;
    throw Error('finish must never replay an import');
  }
  try {
    await assert.rejects(
      runWorkerBackupCli(['finish', ...args], {
        output: sink,
        withLock,
        service,
        input: forbiddenInput(),
      }),
      { code: 'restore_failed' },
    );
    assert.equal(states, 0);
    assert.equal(starts, 0);
    await restoreWorkerBackup({ ...target, input: snapshot.stream });
    const before = fs.readFileSync(path.join(dataDir, 'state.json'));
    await runWorkerBackupCli(['finish', ...args], {
      output: sink,
      withLock,
      service,
      input: forbiddenInput(),
    });
    await runWorkerBackupCli(['finish', ...args], {
      output: sink,
      withLock,
      service,
      input: forbiddenInput(),
    });
    assert.equal(starts, 1);
    assert.equal(states, 2);
    assert.equal(consumed, false);
    assert.equal(held, false);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'state.json')), before);
    assert.equal(
      Buffer.concat(output).toString(),
      (JSON.stringify({ restored: true, restoreId }) + '\n').repeat(2),
    );
    await assert.rejects(
      runWorkerBackupCli(['finish', ...args], {
        output: sink,
        withLock,
        service: {
          state() {
            throw Error('service state unconfirmed');
          },
          start() {
            assert.fail('unknown state cannot start the service');
          },
        },
      }),
      /service state unconfirmed/,
    );
    const busyLock: typeof withWorkerRestoreLock = async () => {
      throw Object.assign(Error('isolated held kernel lock'), { code: 'backup_busy' });
    };
    await assert.rejects(
      runWorkerBackupCli(['finish', ...args], { output: sink, withLock: busyLock, service }),
      { code: 'backup_busy' },
    );
    assert.equal(starts, 1);
  } finally {
    snapshot.cleanup();
  }
});

test('rejection proof requires exact attempt and unchanged roots, survives restart, and is cleared before another restore', async (t) => {
  const { root, options } = fixture(t),
    dataDir = path.join(root, 'rejected-data'),
    workspaceRoot = path.join(root, 'rejected-workspaces'),
    restoreId = randomUUID();
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(dataDir, 'original'), 'original');
  const target = { dataDir, workspaceRoot, restoreId, assertOffline() {} };
  assert.equal(inspectWorkerRestoreRejection(target).rejected, false);
  await assert.rejects(
    restoreWorkerBackup({ ...target, input: Readable.from(['invalid fixture archive']) }),
  );
  assert.equal(inspectWorkerRestoreRejection(target).rejected, true);
  assert.equal(
    inspectWorkerRestoreRejection({ ...target, restoreId: randomUUID() }).rejected,
    false,
  );
  const output: Buffer[] = [];
  const withLock: typeof withWorkerRestoreLock = async (_options, operation) =>
    operation(retiredProcessOwnerLock(root));
  await runWorkerBackupCli(
    [
      'outcome',
      '--data-dir',
      dataDir,
      '--workspace-root',
      workspaceRoot,
      '--restore-id',
      restoreId,
    ],
    {
      input: {
        async *[Symbol.asyncIterator]() {
          assert.fail('outcome must never consume archive input');
        },
      },
      output: new Writable({
        write(chunk: unknown, _encoding, done) {
          assert.ok(Buffer.isBuffer(chunk));
          output.push(chunk);
          done();
        },
      }),
      withLock,
      service: {
        state() {
          assert.fail('outcome does not inspect or start a service');
        },
        start() {
          assert.fail('outcome never starts a service');
        },
      },
    },
  );
  const observed: unknown = JSON.parse(Buffer.concat(output).toString());
  assert.deepEqual(observed, { rejected: true, restoreId });
  const proofFile = path.join(
    root,
    defined(fs.readdirSync(root).find((name) => name.endsWith('.rejected.json'))),
  );
  const proof = fs.readFileSync(proofFile);
  fs.writeFileSync(
    proofFile,
    JSON.stringify({
      rejected: true,
      restoreId,
      data: { dev: '0', ino: '0' },
      workspace: { dev: '0', ino: '0' },
    }),
  );
  assert.equal(inspectWorkerRestoreRejection(target).rejected, false);
  fs.writeFileSync(proofFile, proof);
  fs.writeFileSync(path.join(options.dataDir, path.basename(proofFile)), proof);
  const snapshot = createWorkerBackup(options);
  try {
    await restoreWorkerBackup({ ...target, input: snapshot.stream });
    assert.equal(inspectWorkerRestoreRejection(target).rejected, false);
    assert.equal(inspectWorkerRestore(target).restored, true);
  } finally {
    snapshot.cleanup();
  }
});

test('a completed rollback records rejection while an unconfirmed pause or failed rollback cannot', async (t) => {
  const { root, options } = fixture(t),
    dataDir = path.join(root, 'rollback-proof-data'),
    workspaceRoot = path.join(root, 'rollback-proof-workspace'),
    restoreId = randomUUID();
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(dataDir, 'original'), 'data');
  fs.writeFileSync(path.join(workspaceRoot, 'original'), 'workspace');
  const target = { dataDir, workspaceRoot, restoreId, assertOffline() {} };
  const snapshot = createWorkerBackup(options);
  try {
    await assert.rejects(
      restoreWorkerBackup({
        ...target,
        input: snapshot.stream,
        rename(from, to) {
          if (from.endsWith('-workspace.new') && to === workspaceRoot)
            throw Error('isolated swap failure');
          fs.renameSync(from, to);
        },
      }),
    );
    assert.equal(inspectWorkerRestoreRejection(target).rejected, true);
    assert.equal(fs.readFileSync(path.join(dataDir, 'original'), 'utf8'), 'data');
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'original'), 'utf8'), 'workspace');
    fs.renameSync(dataDir, dataDir + '.old');
    fs.mkdirSync(dataDir);
    assert.equal(inspectWorkerRestoreRejection(target).rejected, false);
    const unpaused = {
      ...target,
      restoreId: randomUUID(),
      assertOffline() {
        throw Error('Pause is unknown');
      },
    };
    await assert.rejects(restoreWorkerBackup({ ...unpaused, input: Readable.from([]) }));
    assert.equal(inspectWorkerRestoreRejection(unpaused).rejected, false);
  } finally {
    snapshot.cleanup();
  }
});
