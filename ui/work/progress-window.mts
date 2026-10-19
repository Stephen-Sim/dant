import { TaskStatus, SubmissionStatus } from '../../src/contracts/states.mts';
import type { ProgressMessage, ProgressSnapshot } from './progress-snapshot.mts';

interface ProgressWindowItem {
  id?: string | undefined;
  turnId?: string | null | undefined;
  status: unknown;
  progressCompleted?: boolean;
  message?: ProgressMessage | undefined;
  registered?: boolean;
  voice?: boolean;
}

export const COMPLETED_PROGRESS_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const validTime = (value: unknown, now: number): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= now &&
  value <= MAX_TIMESTAMP;

/** This is a display projection only: task identities, durable state and project memory stay intact. */
export function progressWindow<Item extends ProgressWindowItem>(
  items: readonly Item[],
  snapshot: ProgressSnapshot | null,
  now: number,
): { items: Item[]; nextExpiryAt: number | null } {
  if (!validTime(now, now)) return { items: [...items], nextExpiryAt: null };
  const acceptedByTurn = new Map<string, ProgressMessage[]>(),
    receipts = new Map<string, { turnId: string; taskId?: string | null } | null>(),
    confirmedMessage = (message: ProgressMessage) =>
      message.role === 'user' &&
      message.status === TaskStatus.Completed &&
      message.unknownOutcome !== true &&
      message.submission !== SubmissionStatus.Unknown &&
      message.submission !== SubmissionStatus.Submitting;
  for (const message of snapshot?.messages || [])
    if (confirmedMessage(message) && message.turnId) {
      const related = acceptedByTurn.get(message.turnId) || [];
      related.push(message);
      acceptedByTurn.set(message.turnId, related);
    }
  for (const receipt of snapshot?.completions || []) {
    const id = receipt.id || receipt.turnId;
    receipts.set(id, receipts.has(id) ? null : receipt);
  }
  let nextExpiryAt: number | null = null;
  const visible = items.filter((item) => {
    if (item.status !== TaskStatus.Completed || item.progressCompleted !== true) return true;
    let turnId = item.turnId,
      taskId: string | null | undefined;
    if (item.voice && !item.registered && item.id) {
      const receipt = receipts.get(item.id);
      if (!receipt) return true;
      turnId = receipt.turnId;
      taskId = receipt.taskId;
    }
    const related = (turnId ? acceptedByTurn.get(turnId) || [] : []).filter(
        (message) => !taskId || message.id === taskId,
      ),
      own = item.message,
      candidates =
        own && confirmedMessage(own) && (!item.registered || !own.turnId || own.turnId === turnId)
          ? [...related, own]
          : related;
    const accepted = candidates.filter((message) => message.acceptedAt !== undefined);
    if (!accepted.length || accepted.some((message) => !validTime(message.acceptedAt, now)))
      return true;
    let completedAt = 0;
    for (const message of accepted)
      if (validTime(message.acceptedAt, now))
        completedAt = Math.max(completedAt, message.acceptedAt);
    const expiresAt = completedAt + COMPLETED_PROGRESS_RETENTION_MS;
    if (expiresAt > MAX_TIMESTAMP) return true;
    if (now >= expiresAt) return false;
    nextExpiryAt = nextExpiryAt === null ? expiresAt : Math.min(nextExpiryAt, expiresAt);
    return true;
  });
  return { items: visible, nextExpiryAt };
}
