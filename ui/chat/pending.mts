// Preserve ambiguous mutations until the user checks or explicitly submits again.
import type { Attachment, WorkReplyTarget } from '../shared/contracts.mts';
import { requestError } from '../shared/contracts.mts';
export interface MessageSubmission {
  route: string;
  payload: SubmissionPayload;
  signature: string;
  clientMessageId: string;
  raw?: string | null;
  items?: Attachment[];
  reply?: string | null;
  workReply?: WorkReplyTarget | null;
  kind?: 'voice';
}
export interface SubmissionPayload {
  text: string;
  callId?: string | undefined;
  attachments?: string[];
  replyTo?: string | null;
  workReply?: WorkReplyTarget;
}
export function createMessageSubmissions({
  newId = () => crypto.randomUUID(),
}: { newId?: () => string } = {}) {
  let attempt: MessageSubmission | null = null,
    unknown: MessageSubmission | null = null;
  return {
    get unknown() {
      return unknown;
    },
    prepare(route: string, payload: SubmissionPayload, { confirmResend = false } = {}) {
      if (unknown && !confirmResend)
        throw Object.assign(new Error('Check the unconfirmed message before sending again'), {
          needsConfirmation: true,
        });
      if (confirmResend) {
        attempt = null;
        unknown = null;
      }
      const signature = JSON.stringify({ route, payload });
      if (!attempt || attempt.signature !== signature)
        attempt = { route, payload: structuredClone(payload), signature, clientMessageId: newId() };
      return attempt;
    },
    unconfirmed(value: MessageSubmission) {
      unknown = value;
    },
    acknowledged(clientMessageId: string) {
      if (unknown?.clientMessageId === clientMessageId) unknown = null;
      if (attempt?.clientMessageId === clientMessageId) attempt = null;
    },
    find<Message extends { clientMessageId?: string }>(
      messages: readonly Message[] | null | undefined,
    ) {
      const expected = unknown;
      return (
        (expected &&
          (messages || []).find(
            (message) => message.clientMessageId === expected.clientMessageId,
          )) ||
        null
      );
    },
  };
}

// A disconnected renderer may only stop the exact call that it owned.
export function createCallStops(stop: (callId: string) => Promise<unknown>) {
  const pending = new Set<string>();
  let running: Promise<unknown[]> | null = null;
  return {
    get ids() {
      return [...pending];
    },
    get pending() {
      return pending.size > 0;
    },
    add(callId: unknown) {
      if (typeof callId === 'string' && callId) pending.add(callId);
    },
    flush() {
      if (running) return running;
      running = (async () => {
        const errors: unknown[] = [];
        for (const callId of [...pending]) {
          try {
            await stop(callId);
            pending.delete(callId);
          } catch (cause) {
            const error = requestError(cause);
            // An authoritative rejection of an old ID proves it cannot stop a new call.
            if (error.status === 400 && /voice call changed/i.test(error.message))
              pending.delete(callId);
            else errors.push(error);
          }
        }
        return errors;
      })().finally(() => (running = null));
      return running;
    },
  };
}
