import type { ChatMessage } from '../shared/contracts.mts';
import type { MessageSubmission } from './pending.mts';

export interface OutgoingMessage {
  attempt: MessageSubmission;
  scope: string;
  sending: boolean;
  unknown: boolean;
  observed: boolean;
}

/** Local display ownership only; canonical messages and receipts remain authoritative. */
export function createOutgoingMessages() {
  const entries = new Map<string, OutgoingMessage>();
  return {
    begin(attempt: MessageSubmission, scope: string): OutgoingMessage {
      const entry = { attempt, scope, sending: true, unknown: false, observed: false };
      entries.set(attempt.clientMessageId, entry);
      return entry;
    },
    sync(
      messages: readonly Pick<ChatMessage, 'role' | 'clientMessageId'>[],
      scope: string,
    ): OutgoingMessage[] {
      const matched: OutgoingMessage[] = [];
      for (const [id, entry] of entries)
        if (
          entry.scope === scope &&
          messages.some((message) => message.role === 'user' && message.clientMessageId === id)
        ) {
          entry.observed = true;
          entries.delete(id);
          matched.push(entry);
        }
      return matched;
    },
    visible(scope: string): readonly OutgoingMessage[] {
      return [...entries.values()].filter((entry) => entry.scope === scope);
    },
    acknowledged(entry: OutgoingMessage): void {
      entry.sending = false;
      entry.unknown = false;
    },
    unconfirmed(entry: OutgoingMessage): void {
      entry.sending = false;
      entry.unknown = true;
    },
    rejected(entry: OutgoingMessage): void {
      if (entries.get(entry.attempt.clientMessageId) === entry)
        entries.delete(entry.attempt.clientMessageId);
    },
  };
}
