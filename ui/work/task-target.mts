import { isRecord } from '../shared/contracts.mts';
import type { WorkReplyTarget } from '../shared/contracts.mts';
const RECORD_ID_LIMIT = 128;
const TURN_ID_LIMIT = 256;
const validIdentity = (value: unknown, limit: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= limit &&
  !/[\x00-\x20\x7f]/.test(value);
export const validWorkTarget = (value: unknown): value is WorkReplyTarget =>
  isRecord(value) &&
  validIdentity(value.workId, RECORD_ID_LIMIT) &&
  validIdentity(value.turnId, TURN_ID_LIMIT) &&
  validIdentity(value.conversationId, RECORD_ID_LIMIT);
export const sameWorkTarget = (left: unknown, right: unknown): boolean =>
  validWorkTarget(left) &&
  validWorkTarget(right) &&
  left.workId === right.workId &&
  left.turnId === right.turnId &&
  left.conversationId === right.conversationId;
export const copyWorkTarget = (value: WorkReplyTarget): WorkReplyTarget => ({
  workId: value.workId,
  turnId: value.turnId,
  conversationId: value.conversationId,
});
