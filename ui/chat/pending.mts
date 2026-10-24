// Preserve ambiguous mutations until the user checks or explicitly submits again.
import type { Attachment, WorkReplyTarget } from '../shared/contracts.mts';
import { requestError } from '../shared/contracts.mts';
export interface MessageSubmission {
  scope: string;
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
  conversationId?: string;
  text: string;
  callId?: string | undefined;
  attachments?: string[];
  replyTo?: string | null;
  workReply?: WorkReplyTarget;
}
export function createMessageSubmissions({
  newId = () => crypto.randomUUID(),
  getScope = () => '',
}: { newId?: () => string; getScope?: () => string } = {}) {
  const attempts = new Map<string, MessageSubmission>(),
    unknowns = new Map<string, MessageSubmission>();
  return {
    get unknown() {
      return unknowns.get(getScope()) ?? null;
    },
    prepare(route: string, payload: SubmissionPayload, { confirmResend = false } = {}) {
      const scope = getScope(),
        unknown = unknowns.get(scope);
      if (unknown && !confirmResend)
        throw Object.assign(new Error('Check the unconfirmed message before sending again'), {
          needsConfirmation: true,
        });
      if (confirmResend) {
        attempts.delete(scope);
        unknowns.delete(scope);
      }
      const signature = JSON.stringify({ route, payload });
      let attempt = attempts.get(scope);
      if (!attempt || attempt.signature !== signature) {
        attempt = {
          scope,
          route,
          payload: structuredClone(payload),
          signature,
          clientMessageId: newId(),
        };
        attempts.set(scope, attempt);
      }
      return attempt;
    },
    unconfirmed(value: MessageSubmission) {
      unknowns.set(value.scope, value);
    },
    acknowledged(clientMessageId: string) {
      for (const [scope, value] of unknowns)
        if (value.clientMessageId === clientMessageId) unknowns.delete(scope);
      for (const [scope, value] of attempts)
        if (value.clientMessageId === clientMessageId) attempts.delete(scope);
    },
    find<Message extends { clientMessageId?: string }>(
      messages: readonly Message[] | null | undefined,
    ) {
      const expected = unknowns.get(getScope());
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
