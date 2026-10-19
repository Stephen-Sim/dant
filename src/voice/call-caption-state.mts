import { isRecord } from '../contracts/json.mts';
import {
  CALL_CAPTION_EVENT_METHOD,
  CALL_CAPTION_TEXT_LIMIT,
  isCallCaptionId,
  isCallCaptionProvider,
  readCallCaption,
} from '../contracts/call-caption.mts';
import type { CallCaption, CallCaptionProvider } from '../contracts/call-caption.mts';

interface CaptionOwner {
  callId: string;
  provider: CallCaptionProvider;
}
const RETIRED_CALL_LIMIT = 64;
const liveCallStatuses = new Set(['connecting', 'negotiating', 'connected']);
const ownerKey = (owner: CaptionOwner) => JSON.stringify([owner.callId, owner.provider]);

/** RAM only. A display snapshot never writes conversation, call, cache or transcript history. */
export function createCallCaptionState({
  redact = (text: string) => text,
}: { redact?: (text: string) => string } = {}) {
  let owner: CaptionOwner | null = null,
    caption: CallCaption | null = null,
    sequence = 0,
    connected = false,
    scope: string | null = null;
  const retired = new Set<string>();
  function retire() {
    if (owner) retired.add(ownerKey(owner));
    while (retired.size > RETIRED_CALL_LIMIT) {
      const first = retired.values().next();
      if (!first.done) retired.delete(first.value);
    }
  }
  function end() {
    retire();
    owner = null;
    caption = null;
    sequence = 0;
    connected = false;
  }
  function sync(call: unknown, options: { scope: string; connected: boolean }) {
    if (options.scope !== scope) {
      end();
      retired.clear();
      scope = options.scope;
    }
    if (
      !isRecord(call) ||
      !isCallCaptionId(call.id) ||
      !isCallCaptionProvider(call.provider) ||
      typeof call.status !== 'string' ||
      !liveCallStatuses.has(call.status) ||
      retired.has(ownerKey({ callId: call.id, provider: call.provider }))
    ) {
      end();
      return;
    }
    if (owner?.callId !== call.id || owner.provider !== call.provider) {
      end();
      owner = { callId: call.id, provider: call.provider };
    }
    connected = options.connected;
    // Retain the high-water sequence so a repeated cached snapshot cannot bring
    // the old text back after a temporary transport disconnection.
    if (!connected) caption = null;
  }
  function observe(value: unknown) {
    const next = readCallCaption(value);
    if (
      !next ||
      !connected ||
      !owner ||
      next.callId !== owner.callId ||
      next.provider !== owner.provider ||
      next.sequence <= sequence
    )
      return false;
    let text = '';
    try {
      text = redact(next.text)
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .slice(-CALL_CAPTION_TEXT_LIMIT);
      if (/[\uDC00-\uDFFF]/.test(text[0] || '')) text = text.slice(1);
    } catch {}
    sequence = next.sequence;
    caption = { ...next, text };
    return true;
  }
  return {
    sync,
    observe,
    receive(event: unknown) {
      return isRecord(event) && event.method === CALL_CAPTION_EVENT_METHOD && observe(event.params);
    },
    end,
    get snapshot(): CallCaption | null {
      return caption ? { ...caption } : null;
    },
  };
}
