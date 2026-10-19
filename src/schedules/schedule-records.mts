import { isRecord } from '../contracts/json.mts';
import { ScheduleStatus, TaskPriority, ChatTaskStatus, isEnumValue } from '../contracts/states.mts';
import type { ScheduleRecord, ScheduleRunReceipt } from './schedule-types.ts';

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}
function isRunReceipt(value: unknown): value is ScheduleRunReceipt {
  return (
    isRecord(value) &&
    typeof value.messageId === 'string' &&
    optionalString(value.workId) &&
    optionalString(value.turnId) &&
    optionalNumber(value.at) &&
    optionalNumber(value.dispatchedAt) &&
    optionalString(value.terminalStatus) &&
    optionalNumber(value.terminalAt)
  );
}
/** Disk data is an observation; unknown statuses never become runnable jobs. */
export function isScheduleRecord(value: unknown): value is ScheduleRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    optionalNumber(value.createdAt) &&
    optionalNumber(value.updatedAt) &&
    isEnumValue(ScheduleStatus, value.status) &&
    (value.cron === undefined || value.cron === null || typeof value.cron === 'string') &&
    (value.priority === undefined || isEnumValue(TaskPriority, value.priority)) &&
    optionalString(value.timeZone) &&
    (value.enabled === undefined || typeof value.enabled === 'boolean') &&
    optionalString(value.clientRequestId) &&
    (value.creationFingerprint === null || optionalString(value.creationFingerprint)) &&
    optionalString(value.messageId) &&
    optionalNumber(value.lastRunAt) &&
    optionalNumber(value.dispatchedAt) &&
    (value.runHistory === undefined ||
      (Array.isArray(value.runHistory) && value.runHistory.every(isRunReceipt))) &&
    (value.taskStatus === undefined || isEnumValue(ChatTaskStatus, value.taskStatus))
  );
}
export function restoreScheduledRecords(value: unknown): ScheduleRecord[] {
  return Array.isArray(value) ? value.filter(isScheduleRecord) : [];
}
