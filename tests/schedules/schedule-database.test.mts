import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ScheduleDatabase } from '../../src/schedules/schedule-database.mts';
import { Store } from '../../src/conversation/store.mts';
import {
  ScheduleStatus,
  ScheduleDispatchPhase,
  TaskStatus,
  TaskPriority,
} from '../../src/contracts/states.mts';
import type { ScheduleRecord } from '../../src/schedules/schedule-types.ts';
import type { ScheduleClaim } from '../../src/schedules/schedule-database-types.ts';
import { defined } from '../support/fixture-assertions.mts';

const run = promisify(execFile);
function fixture(t: TestContext) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'schedule-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const item: ScheduleRecord = {
    id: randomUUID(),
    text: 'Verify the isolated scheduled result',
    at: 1000,
    status: ScheduleStatus.Pending,
    enabled: true,
    priority: TaskPriority.Normal,
  };
  return { dir, item, database: new ScheduleDatabase(dir, { schedules: [item] }) };
}
function intent(
  database: ScheduleDatabase,
  item: ScheduleRecord,
  owner = randomUUID(),
): ScheduleClaim {
  const id = randomUUID();
  return {
    revision: database.snapshot().revision,
    candidate: item,
    claimed: {
      ...item,
      status: ScheduleStatus.Dispatched,
      enabled: false,
      messageId: id,
      lastRunAt: item.at,
    },
    message: {
      id,
      role: 'user',
      text: item.text,
      status: TaskStatus.Queued,
      scheduled: true,
      scheduleId: item.id,
      scheduledAt: item.at,
      progressPriority: TaskPriority.Normal,
    },
    owner,
  };
}

test('two real Node processes competing for one durable occurrence commit only one dispatch intent', async (t) => {
  const { dir, item, database } = fixture(t);
  const first = intent(database, item),
    second = intent(database, item);
  const moduleUrl = pathToFileURL(path.resolve('src/schedules/schedule-database.mts')).href;
  const code = `import {ScheduleDatabase} from ${JSON.stringify(moduleUrl)}; const input=JSON.parse(process.argv[1]); const database=new ScheduleDatabase(input.dir); process.stdout.write(JSON.stringify(database.claim(input.claim)));`;
  const results = await Promise.all(
    [first, second].map((claim) =>
      run(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ dir, claim })], {
        timeout: 15000,
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), ['false', 'true']);
  assert.equal(database.dispatches().length, 1);
  assert.equal(defined(database.dispatches()[0]).phase, ScheduleDispatchPhase.Prepared);
  assert.equal(
    defined(database.snapshot().items[0]).messageId,
    defined(database.dispatches()[0]).message.id,
  );
});

test('external SQLite edits advance revision and reject a stale edit instead of discarding newer data', (t) => {
  const { database, item } = fixture(t),
    before = database.snapshot(),
    external = new DatabaseSync(database.file);
  try {
    external
      .prepare('UPDATE schedules SET record_json=? WHERE id=?')
      .run(JSON.stringify({ ...item, text: 'A newly confirmed instruction' }), item.id);
  } finally {
    external.close();
  }
  assert.throws(() => database.replace(before.revision, [item], []), { status: 409 });
  assert.equal(defined(database.snapshot().items[0]).text, 'A newly confirmed instruction');
});

test('a failed cross-store metadata write rolls back SQLite edits and retains the prior job and tombstones', (t) => {
  const { database, item } = fixture(t),
    before = database.snapshot(),
    requestId = randomUUID();
  assert.throws(
    () =>
      database.replace(
        before.revision,
        [{ ...item, text: 'Unsaved instruction' }],
        [requestId],
        () => {
          throw Error('Injected chat write failure');
        },
      ),
    /Injected chat/,
  );
  assert.deepEqual(database.snapshot(), before);
});

test('a SQLite writer timeout preserves the existing due job and does not authorize another occurrence', (t) => {
  const { database, item } = fixture(t),
    before = database.snapshot(),
    other = new DatabaseSync(database.file);
  try {
    other.exec('BEGIN IMMEDIATE');
    assert.throws(() => database.claim(intent(database, item)), /locked/);
    other.exec('ROLLBACK');
  } finally {
    other.close();
  }
  assert.deepEqual(database.snapshot(), before);
  assert.deepEqual(database.dispatches(), []);
});

test('database and journal path hardlinks are rejected while external file bytes remain unchanged', (t) => {
  const { dir, database } = fixture(t),
    target = path.join(dir, 'unrelated.txt');
  fs.writeFileSync(target, 'Unrelated fixture data');
  fs.linkSync(target, database.file + '-journal');
  assert.throws(() => database.snapshot(), /sidecars/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Unrelated fixture data');
  fs.unlinkSync(database.file + '-journal');
  fs.linkSync(database.file, path.join(dir, 'duplicate.sqlite'));
  assert.throws(() => database.snapshot(), /ordinary, unlinked/);
});

test('replaced database identities and tampered revision tracking stop reads before a stale snapshot is used', (t) => {
  const { database } = fixture(t),
    external = new DatabaseSync(database.file);
  try {
    external.exec('DROP TRIGGER schedules_schedules_update');
  } finally {
    external.close();
  }
  assert.throws(() => database.snapshot(), /revision tracking/);
  fs.renameSync(database.file, database.file + '.original');
  fs.writeFileSync(database.file, 'Replacement bytes');
  assert.throws(() => database.snapshot(), /identity changed/);
});

test('failed legacy import keeps the original JSON authority available and a later explicit opening imports once', (t) => {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'schedule-backup-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'state.json'),
    item: ScheduleRecord = {
      id: randomUUID(),
      text: 'Original request',
      at: 1000,
      status: ScheduleStatus.Pending,
    };
  const bytes = JSON.stringify({ schedules: [item], messages: [{ id: 'existing-message' }] });
  fs.writeFileSync(original, bytes);
  // An invalid second row aborts the whole import after the backup has been persisted.
  const invalid = { ...item, id: '' };
  assert.throws(
    () => new ScheduleDatabase(dir, { schedules: [item, invalid] }),
    /Invalid schedule record/,
  );
  assert.equal(fs.readFileSync(original, 'utf8'), bytes);
  const database = new ScheduleDatabase(dir, { schedules: [item] });
  assert.deepEqual(database.snapshot().items, [item]);
  assert.equal(
    fs.readdirSync(database.dir).filter((name) => name.startsWith('legacy-schedules-')).length,
    2,
  );
  assert.deepEqual(new ScheduleDatabase(dir, { schedules: [] }).snapshot().items, [item]);
});

test('every public operation releases its SQLite file handles for Windows cleanup', (t) => {
  const { dir, database, item } = fixture(t),
    claim = intent(database, item);
  assert.equal(database.claim(claim), true);
  database.dispatches();
  database.snapshot();
  database.recoverPrepared('another-worker');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dir), false);
});

test('explicit pre-handoff recovery pauses an existing safe queued message while retaining its object and ID', (t) => {
  for (const missingFromDisk of [false, true]) {
    const { dir, database, item } = fixture(t),
      store = new Store(dir),
      claim = intent(database, item);
    assert.equal(database.claim(claim), true);
    let original: ReturnType<Store['materializeScheduledMessage']> | undefined;
    assert.equal(
      database.materialize(claim.message.id, claim.owner, (dispatch) => {
        original = store.materializeScheduledMessage(dispatch.message);
      }),
      true,
    );
    assert.equal(defined(original).status, TaskStatus.Queued);
    if (missingFromDisk) {
      const state: unknown = JSON.parse(fs.readFileSync(store.file, 'utf8'));
      assert.ok(state && typeof state === 'object');
      fs.writeFileSync(store.file, JSON.stringify({ ...state, messages: [] }));
    }
    database.recoverPrepared('replacement-worker');
    assert.equal(
      database.materializeHeld(claim.message.id, (dispatch) => {
        const recovered = store.materializeScheduledMessage(dispatch.message, { recovered: true });
        assert.equal(recovered, original);
        assert.equal(recovered.status, TaskStatus.Paused);
      }),
      true,
    );
    assert.equal(store.state.messages.length, 1);
    assert.equal(defined(new Store(dir).state.messages[0]).id, claim.message.id);
    assert.equal(defined(new Store(dir).state.messages[0]).status, TaskStatus.Paused);
  }
});
