import { isRecord } from '../shared/json.mts';
import type { ApiRequest } from '../shared/contracts.mts';

const SECRET_MAX_UNITS = 16_384;
export interface CredentialRevealDTO {
  id: string;
  conversationId: string;
  secret: string;
}
export interface RevealIdentity {
  credentialId: string;
  conversationId: string;
  computer: string;
  modal: object;
}
function readReveal(value: unknown, owner: RevealIdentity): CredentialRevealDTO {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.id !== owner.credentialId ||
    value.conversationId !== owner.conversationId ||
    typeof value.secret !== 'string' ||
    !value.secret.length ||
    value.secret.length > SECRET_MAX_UNITS
  )
    throw Error('Invalid credential reveal response');
  return { id: owner.credentialId, conversationId: owner.conversationId, secret: value.secret };
}
const same = (left: RevealIdentity | null, right: RevealIdentity | null) =>
  left !== null &&
  right !== null &&
  left.credentialId === right.credentialId &&
  left.conversationId === right.conversationId &&
  left.computer === right.computer &&
  left.modal === right.modal;

// Fetched plaintext has no path into drafts, snapshots, markup, or Save payloads.
// The live editor display is its consumer; replacement intent is owned separately.
// Every async result is fenced before it can reach that display.
export function createCredentialReveal({
  request,
  identity,
  changed,
  clear,
}: {
  request: ApiRequest;
  identity: () => RevealIdentity | null;
  changed: () => void;
  clear: () => void;
}) {
  let owner: RevealIdentity | null = null;
  let revision = 0;
  let plaintext = '';
  let visible = false;
  let pending = false;
  let failed = false;
  const reset = () => {
    revision++;
    plaintext = '';
    visible = pending = failed = false;
    clear();
  };
  const sync = () => {
    const current = identity();
    if (!same(owner, current)) {
      reset();
      owner = current;
    }
    return current;
  };
  return {
    get state() {
      sync();
      return { visible, pending, failed, available: owner !== null };
    },
    reset() {
      reset();
      owner = null;
    },
    apply(input: HTMLInputElement | HTMLTextAreaElement | null) {
      sync();
      if (input) {
        input.value = visible ? plaintext : '';
        input.hidden = !visible;
      }
    },
    async toggle() {
      const current = sync();
      if (visible || pending) {
        reset();
        changed();
        return;
      }
      if (!current) return;
      const captured = ++revision;
      const isCurrent = () => captured === revision && same(current, identity());
      pending = true;
      failed = false;
      changed();
      let value: unknown;
      try {
        value = await request('/credentials/reveal/' + encodeURIComponent(current.credentialId), {
          method: 'POST',
          body: { conversationId: current.conversationId },
          beforeSend: isCurrent,
        });
        if (!isCurrent()) return;
        const result = readReveal(value, current);
        plaintext = result.secret;
        result.secret = '';
        visible = true;
      } catch {
        if (isCurrent()) failed = true;
      } finally {
        // Drop the response's copy too, including a late or invalid response.
        // Transport ordering promises must never become a plaintext cache.
        if (isRecord(value) && Object.hasOwn(value, 'secret')) {
          try {
            value.secret = '';
          } catch {
            /* Immutable responses are released without mutation. */
          }
        }
        if (isCurrent()) {
          pending = false;
          changed();
        }
      }
    },
  };
}
