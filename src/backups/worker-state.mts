import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isRecord, includesValue } from '../contracts/json.mts';
import {
  TaskStatus,
  SubmissionStatus,
  ScheduleStatus,
  ScheduleDispatchPhase,
  ContinuationDispatchPhase,
} from '../contracts/states.mts';
import { backupError } from './archive-stream.mts';

const RESTORE_JSON_MAX_BYTES = 128 * 1024 * 1024;
const terminal = [
  TaskStatus.Completed,
  TaskStatus.Cancelled,
  TaskStatus.Failed,
  TaskStatus.Review,
] as const;
function objectFile(file: string): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > RESTORE_JSON_MAX_BYTES
  )
    throw backupError('invalid_backup');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(value)) throw backupError('invalid_backup');
  return value;
}
function save(file: string, value: unknown) {
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function pauseRecord(value: unknown) {
  if (!isRecord(value)) throw backupError('invalid_backup');
  if (
    value.status === TaskStatus.Unknown ||
    value.unknownOutcome === true ||
    value.submission === SubmissionStatus.Unknown ||
    value.submission === SubmissionStatus.Submitting
  ) {
    value.status = TaskStatus.Unknown;
    value.unknownOutcome = true;
    if (value.submission === SubmissionStatus.Submitting)
      value.submission = SubmissionStatus.Unknown;
  } else if (!includesValue(terminal, value.status)) value.status = TaskStatus.Paused;
  if (isRecord(value.continuation)) {
    value.continuation.nextAt = null;
    const dispatch = value.continuation.dispatch;
    if (isRecord(dispatch) && dispatch.phase !== ContinuationDispatchPhase.Acknowledged) {
      dispatch.phase = ContinuationDispatchPhase.Unknown;
      value.status = TaskStatus.Unknown;
      value.unknownOutcome = true;
    }
  }
}
function pauseSchedule(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw backupError('invalid_backup');
  value.enabled = false;
  // A dispatched one-shot remains a fenced historical run, not a newly pending task.
  if (value.status !== ScheduleStatus.Dispatched) value.status = ScheduleStatus.Paused;
  return value;
}
function checkSqlite(file: string, operation?: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file, { enableDoubleQuotedStringLiterals: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;');
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      throw backupError('invalid_backup');
    if (operation) {
      db.exec('BEGIN IMMEDIATE');
      try {
        operation(db);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  } finally {
    db.close();
  }
}
/** Runs only on validated private staging; historical IDs/results remain, execution bindings do not. */
export function prepareRestoredWorkerState(directory: string) {
  const data = path.join(directory, 'data'),
    file = path.join(data, 'state.json'),
    state = objectFile(file);
  if (
    typeof state.conversationId !== 'string' ||
    !state.conversationId ||
    !Array.isArray(state.messages) ||
    !Array.isArray(state.workTasks) ||
    !Array.isArray(state.completions) ||
    !isRecord(state.settings)
  )
    throw backupError('invalid_backup');
  state.threadId = null;
  state.threadRuntime = null;
  delete state.threadConversationId;
  for (const message of state.messages) {
    if (
      !isRecord(message) ||
      typeof message.id !== 'string' ||
      !includesValue(['user', 'assistant', 'system'], message.role)
    )
      throw backupError('invalid_backup');
    if (message.role === 'user') pauseRecord(message);
    else if (message.status === 'streaming') message.status = TaskStatus.Paused;
  }
  for (const work of state.workTasks) pauseRecord(work);
  if (Array.isArray(state.schedules)) state.schedules = state.schedules.map(pauseSchedule);
  if (Array.isArray(state.callInputHistory))
    for (const reference of state.callInputHistory)
      if (isRecord(reference) && reference.submission === 'pending')
        reference.submission = 'unknown';
  save(file, state);
  const schedules = path.join(data, 'schedules', 'schedules.sqlite');
  if (fs.existsSync(schedules))
    checkSqlite(schedules, (db) => {
      for (const row of db.prepare('SELECT id,record_json FROM schedules').all()) {
        if (typeof row.id !== 'string' || typeof row.record_json !== 'string')
          throw backupError('invalid_backup');
        const record: unknown = JSON.parse(row.record_json);
        db.prepare('UPDATE schedules SET record_json=? WHERE id=?').run(
          JSON.stringify(pauseSchedule(record)),
          row.id,
        );
      }
      // A prepared delivery was never fenced to an executor. Retain its original ID, held for explicit reconciliation.
      db.prepare('UPDATE schedule_dispatches SET phase=? WHERE phase IN (?,?)').run(
        ScheduleDispatchPhase.Held,
        ScheduleDispatchPhase.Prepared,
        ScheduleDispatchPhase.Materialized,
      );
    });
  const memory = path.join(data, 'memory', 'dant', 'memory.sqlite');
  if (fs.existsSync(memory)) checkSqlite(memory);
  const telegram = path.join(data, 'telegram.json');
  if (fs.existsSync(telegram)) {
    const config = objectFile(telegram);
    config.enabled = false;
    if (Array.isArray(config.outbox))
      for (const item of config.outbox)
        if (isRecord(item) && includesValue(['queued', 'sending'], item.status))
          item.status = 'unknown';
    save(telegram, config);
  }
}
