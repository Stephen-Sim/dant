import type { ChatTaskStatusValue, TaskPriorityValue } from '../contracts/contracts.ts';

export type { ScheduleStatusValue as ScheduleStatus } from '../contracts/states.mts';
import type { ScheduleStatusValue } from '../contracts/states.mts';

export interface ScheduleRunReceipt {
  messageId: string;
  workId?: string;
  turnId?: string;
  at?: number | undefined;
  dispatchedAt?: number | undefined;
  terminalStatus?: string | undefined;
  terminalAt?: number | undefined;
}

export interface ScheduleRecord {
  id: string;
  text: string;
  at: number;
  cron?: string | null;
  priority?: TaskPriorityValue;
  timeZone?: string;
  status: ScheduleStatusValue;
  enabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
  clientRequestId?: string;
  creationFingerprint?: string | null;
  messageId?: string;
  lastRunAt?: number;
  dispatchedAt?: number;
  runHistory?: ScheduleRunReceipt[];
  taskStatus?: ChatTaskStatusValue;
}

export interface ScheduleSaveInput {
  id?: unknown;
  text?: unknown;
  at?: unknown;
  cron?: unknown;
  priority?: unknown;
  timeZone?: unknown;
  enabled?: unknown;
  clientRequestId?: unknown;
}
