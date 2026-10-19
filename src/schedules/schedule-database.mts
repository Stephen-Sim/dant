import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { errorCode, isRecord } from '../contracts/json.mts';
import {
  ScheduleDispatchPhase,
  ScheduleStatus,
  TaskPriority,
  TaskStatus,
  isEnumValue,
} from '../contracts/states.mts';
import { isScheduleRecord, restoreScheduledRecords } from './schedule-records.mts';
import {
  SCHEDULE_DATABASE_FILE,
  SCHEDULE_RECORD_MAX_BYTES,
  SCHEDULE_SCHEMA_VERSION,
  SCHEDULE_SQLITE_BUSY_TIMEOUT_MS,
  SCHEDULE_ID_MAX_LENGTH,
  SCHEDULE_MAX_TIME,
} from './schedule-constants.mts';
import type {
  ScheduleClaim,
  ScheduleDispatch,
  ScheduleSnapshot,
  ScheduledMessage,
} from './schedule-database-types.ts';
import type { ScheduleRecord } from './schedule-types.ts';

const conflict = () =>
  Object.assign(Error('The scheduled task changed. Refresh before changing it again.'), {
    status: 409,
  });
const revisionTriggers = ['schedules', 'schedule_tombstones'].flatMap((table) =>
  ['INSERT', 'UPDATE', 'DELETE'].map((action) => {
    const name = `schedules_${table}_${action.toLowerCase()}`;
    return {
      name,
      sql: `CREATE TRIGGER ${name} AFTER ${action} ON ${table} BEGIN UPDATE schedule_meta SET revision=revision+1 WHERE id=1; END`,
    };
  }),
);
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= SCHEDULE_ID_MAX_LENGTH &&
  !/[\x00-\x20\x7f]/.test(value);
function ordinaryDirectory(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error('Schedule directories must be ordinary directories');
  return stat;
}
function parseRecord(value: unknown): ScheduleRecord {
  if (typeof value !== 'string' || Buffer.byteLength(value) > SCHEDULE_RECORD_MAX_BYTES)
    throw Error('Invalid stored schedule');
  const parsed: unknown = JSON.parse(value);
  if (!isScheduleRecord(parsed) || !validId(parsed.id)) throw Error('Invalid stored schedule');
  return parsed;
}
function validMessage(value: unknown): value is ScheduledMessage {
  return (
    isRecord(value) &&
    validId(value.id) &&
    validId(value.scheduleId) &&
    value.role === 'user' &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    !value.text.includes('\0') &&
    value.status === TaskStatus.Queued &&
    value.scheduled === true &&
    typeof value.scheduledAt === 'number' &&
    Number.isSafeInteger(value.scheduledAt) &&
    value.scheduledAt > 0 &&
    isEnumValue(TaskPriority, value.progressPriority)
  );
}
function readDispatch(value: unknown): ScheduleDispatch {
  if (
    !isRecord(value) ||
    typeof value.message_json !== 'string' ||
    Buffer.byteLength(value.message_json) > SCHEDULE_RECORD_MAX_BYTES ||
    !validId(value.owner) ||
    !isEnumValue(ScheduleDispatchPhase, value.phase)
  )
    throw Error('Invalid stored schedule dispatch');
  const message: unknown = JSON.parse(value.message_json);
  if (
    !validMessage(message) ||
    message.id !== value.message_id ||
    message.scheduleId !== value.schedule_id ||
    message.scheduledAt !== value.scheduled_at
  )
    throw Error('Invalid stored schedule dispatch');
  return { message, owner: value.owner, phase: value.phase };
}

/** SQLite owns schedules and durable dispatch fences. JSON chat storage is a separate authority. */
export class ScheduleDatabase {
  readonly file: string;
  readonly dir: string;
  private readonly identity: fs.Stats;
  private readonly directories: { dir: string; stat: fs.Stats }[];
  constructor(dataDir: string, legacy: { schedules?: unknown; deletedRequestIds?: unknown } = {}) {
    const root = path.resolve(dataDir);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.dir = path.join(root, 'schedules');
    this.directories = [root, this.dir].map((dir) => ({ dir, stat: ordinaryDirectory(dir) }));
    this.guardDirectories();
    this.file = path.join(this.dir, SCHEDULE_DATABASE_FILE);
    try {
      fs.closeSync(fs.openSync(this.file, 'wx', 0o600));
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    this.identity = this.ordinaryFile();
    this.connection((db) => {
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== SCHEDULE_SCHEMA_VERSION)
        throw Error('Unsupported schedule database version');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS schedule_meta (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0), imported INTEGER NOT NULL CHECK(imported IN (0,1)));
          INSERT OR IGNORE INTO schedule_meta VALUES (1,0,0);
          CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, client_request_id TEXT UNIQUE, record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) <= ${SCHEDULE_RECORD_MAX_BYTES}));
          CREATE TABLE IF NOT EXISTS schedule_tombstones (request_id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS schedule_dispatches (message_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL, owner TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('prepared','materialized','held','handed-off')), message_json TEXT NOT NULL, UNIQUE(schedule_id,scheduled_at));
          PRAGMA user_version = ${SCHEDULE_SCHEMA_VERSION};`);
        for (const trigger of revisionTriggers)
          db.exec(trigger.sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS '));
        if (db.prepare('SELECT imported FROM schedule_meta WHERE id=1').get()?.imported !== 1) {
          const schedules = restoreScheduledRecords(legacy.schedules),
            deleted = Array.isArray(legacy.deletedRequestIds)
              ? legacy.deletedRequestIds.filter(validId)
              : [];
          if ((Array.isArray(legacy.schedules) && legacy.schedules.length) || deleted.length)
            this.backup(legacy);
          for (const item of schedules) this.put(db, item);
          for (const id of deleted)
            db.prepare('INSERT OR IGNORE INTO schedule_tombstones VALUES (?)').run(id);
          db.exec('UPDATE schedule_meta SET imported=1, revision=revision+1 WHERE id=1');
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw Error('Schedule database integrity check failed');
    });
  }
  private guardDirectories() {
    for (const { dir, stat } of this.directories) {
      const current = fs.lstatSync(dir);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.ino !== stat.ino ||
        current.dev !== stat.dev
      )
        throw Error('Schedule directory identity changed');
    }
  }
  private ordinaryFile() {
    this.guardDirectories();
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw Error('Schedule database must be an ordinary, unlinked file');
    return stat;
  }
  private guardFile() {
    const current = this.ordinaryFile();
    if (current.ino !== this.identity.ino || current.dev !== this.identity.dev)
      throw Error('Schedule database identity changed');
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try {
        const stat = fs.lstatSync(this.file + suffix);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw Error('Schedule database sidecars must be ordinary, unlinked files');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }
  private connection<Result>(operation: (db: DatabaseSync) => Result): Result {
    this.guardFile();
    const db = new DatabaseSync(this.file, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    try {
      db.exec(
        `PRAGMA busy_timeout=${SCHEDULE_SQLITE_BUSY_TIMEOUT_MS}; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;`,
      );
      const result = operation(db);
      this.guardFile();
      return result;
    } finally {
      db.close();
    }
  }
  private transaction<Result>(operation: (db: DatabaseSync) => Result): Result {
    return this.connection((db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        this.validateSchema(db);
        const result = operation(db);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  private validateSchema(db: DatabaseSync) {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEDULE_SCHEMA_VERSION)
      throw Error('Unsupported schedule database version');
    for (const trigger of revisionTriggers)
      if (
        db
          .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
          .get(trigger.name)?.sql !== trigger.sql
      )
        throw Error('Schedule database revision tracking changed');
  }
  private backup(value: unknown) {
    this.guardDirectories();
    const file = path.join(this.dir, 'legacy-schedules-' + randomUUID() + '.json');
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  private revision(db: DatabaseSync) {
    const revision = db.prepare('SELECT revision FROM schedule_meta WHERE id=1').get()?.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
      throw Error('Invalid schedule database metadata');
    return revision;
  }
  private put(db: DatabaseSync, item: ScheduleRecord) {
    const json = JSON.stringify(item);
    if (
      !isScheduleRecord(item) ||
      !validId(item.id) ||
      Buffer.byteLength(json) > SCHEDULE_RECORD_MAX_BYTES
    )
      throw Error('Invalid schedule record');
    db.prepare(
      'INSERT INTO schedules (id,client_request_id,record_json) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET client_request_id=excluded.client_request_id, record_json=excluded.record_json',
    ).run(item.id, item.clientRequestId ?? null, json);
  }
  snapshot(): ScheduleSnapshot {
    return this.connection((db) => {
      db.exec('BEGIN');
      try {
        this.validateSchema(db);
        const result = {
          revision: this.revision(db),
          items: db
            .prepare('SELECT record_json FROM schedules ORDER BY rowid')
            .all()
            .map((row) => parseRecord(row.record_json)),
          deletedRequestIds: db
            .prepare('SELECT request_id FROM schedule_tombstones ORDER BY rowid')
            .all()
            .map((row) => {
              if (!validId(row.request_id)) throw Error('Invalid schedule tombstone');
              return row.request_id;
            }),
        };
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  replace(
    expectedRevision: number,
    items: readonly ScheduleRecord[],
    deletedRequestIds: readonly string[],
    beforeCommit?: () => void,
  ) {
    this.transaction((db) => {
      if (this.revision(db) !== expectedRevision) throw conflict();
      for (const item of items) this.put(db, item);
      const keep = new Set(items.map((item) => item.id));
      for (const row of db.prepare('SELECT id FROM schedules').all())
        if (typeof row.id === 'string' && !keep.has(row.id))
          db.prepare('DELETE FROM schedules WHERE id=?').run(row.id);
      for (const id of deletedRequestIds) {
        if (!validId(id)) throw Error('Invalid schedule tombstone');
        db.prepare('INSERT OR IGNORE INTO schedule_tombstones VALUES (?)').run(id);
      }
      db.exec('UPDATE schedule_meta SET revision=revision+1 WHERE id=1');
      beforeCommit?.();
    });
  }
  claim({ revision, candidate, claimed, message, owner }: ScheduleClaim) {
    return this.transaction((db) => {
      if (this.revision(db) !== revision) return false;
      const row = db.prepare('SELECT record_json FROM schedules WHERE id=?').get(candidate.id);
      if (!row || JSON.stringify(parseRecord(row.record_json)) !== JSON.stringify(candidate))
        return false;
      if (
        candidate.status !== ScheduleStatus.Pending ||
        candidate.enabled === false ||
        !Number.isSafeInteger(candidate.at) ||
        candidate.at <= 0 ||
        candidate.at > SCHEDULE_MAX_TIME
      )
        return false;
      if (
        !validMessage(message) ||
        !validId(owner) ||
        message.scheduleId !== candidate.id ||
        message.scheduledAt !== candidate.at ||
        message.text !== candidate.text ||
        message.progressPriority !== (candidate.priority ?? TaskPriority.Normal) ||
        claimed.id !== candidate.id ||
        claimed.messageId !== message.id ||
        claimed.text !== candidate.text ||
        claimed.lastRunAt !== candidate.at
      )
        throw Error('Invalid schedule dispatch claim');
      if (
        db
          .prepare('SELECT 1 FROM schedule_dispatches WHERE schedule_id=? AND scheduled_at=?')
          .get(candidate.id, candidate.at)
      )
        return false;
      this.put(db, claimed);
      db.prepare('INSERT INTO schedule_dispatches VALUES (?,?,?,?,?,?)').run(
        message.id,
        candidate.id,
        candidate.at,
        owner,
        ScheduleDispatchPhase.Prepared,
        JSON.stringify(message),
      );
      db.exec('UPDATE schedule_meta SET revision=revision+1 WHERE id=1');
      return true;
    });
  }
  dispatches(): ScheduleDispatch[] {
    return this.connection((db) =>
      db.prepare('SELECT * FROM schedule_dispatches ORDER BY rowid').all().map(readDispatch),
    );
  }
  materialize(messageId: string, owner: string, operation: (dispatch: ScheduleDispatch) => void) {
    return this.transaction((db) => {
      const row = db.prepare('SELECT * FROM schedule_dispatches WHERE message_id=?').get(messageId);
      if (!row) return false;
      const dispatch = readDispatch(row);
      if (dispatch.owner !== owner || dispatch.phase !== ScheduleDispatchPhase.Prepared)
        return false;
      operation(dispatch);
      db.prepare('UPDATE schedule_dispatches SET phase=? WHERE message_id=?').run(
        ScheduleDispatchPhase.Materialized,
        messageId,
      );
      return true;
    });
  }
  markMaterialized(messageId: string, owner: string) {
    return this.transition(
      messageId,
      owner,
      ScheduleDispatchPhase.Prepared,
      ScheduleDispatchPhase.Materialized,
    );
  }
  materializeHeld(messageId: string, operation: (dispatch: ScheduleDispatch) => void) {
    return this.transaction((db) => {
      const row = db.prepare('SELECT * FROM schedule_dispatches WHERE message_id=?').get(messageId);
      if (!row) return false;
      const dispatch = readDispatch(row);
      if (dispatch.phase !== ScheduleDispatchPhase.Held) return false;
      operation(dispatch);
      return true;
    });
  }
  fenceHandoff(messageId: string, owner: string) {
    return this.transition(
      messageId,
      owner,
      ScheduleDispatchPhase.Materialized,
      ScheduleDispatchPhase.HandedOff,
    );
  }
  private transition(
    messageId: string,
    owner: string,
    from: ScheduleDispatch['phase'],
    to: ScheduleDispatch['phase'],
  ) {
    return this.transaction(
      (db) =>
        db
          .prepare(
            'UPDATE schedule_dispatches SET phase=? WHERE message_id=? AND owner=? AND phase=?',
          )
          .run(to, messageId, owner, from).changes === 1,
    );
  }
  recoverPrepared(owner: string, { includeOwned = false }: { includeOwned?: boolean } = {}) {
    return this.transaction((db) => {
      db.prepare(
        'UPDATE schedule_dispatches SET phase=? WHERE (owner<>? OR ?=1) AND phase IN (?,?)',
      ).run(
        ScheduleDispatchPhase.Held,
        owner,
        includeOwned ? 1 : 0,
        ScheduleDispatchPhase.Prepared,
        ScheduleDispatchPhase.Materialized,
      );
      return db
        .prepare('SELECT * FROM schedule_dispatches WHERE phase=? ORDER BY rowid')
        .all(ScheduleDispatchPhase.Held)
        .map(readDispatch);
    });
  }
}
