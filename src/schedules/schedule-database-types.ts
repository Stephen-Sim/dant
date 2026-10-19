import type { ScheduleDispatchPhaseValue, TaskStatus } from '../contracts/states.mts';
import type { TaskPriorityValue } from '../contracts/contracts.ts';
import type { ScheduleRecord } from './schedule-types.ts';

export interface ScheduledMessage {
  id: string;
  role: 'user';
  text: string;
  status: typeof TaskStatus.Queued;
  scheduled: true;
  scheduleId: string;
  scheduledAt: number;
  progressPriority: TaskPriorityValue;
}
export interface ScheduleDispatch {
  message: ScheduledMessage;
  owner: string;
  phase: ScheduleDispatchPhaseValue;
}
export interface ScheduleSnapshot {
  revision: number;
  items: ScheduleRecord[];
  deletedRequestIds: string[];
}
export interface ScheduleClaim {
  revision: number;
  candidate: ScheduleRecord;
  claimed: ScheduleRecord;
  message: ScheduledMessage;
  owner: string;
}
