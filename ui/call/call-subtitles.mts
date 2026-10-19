import { escapeHtml as escape } from '../shared/html.mts';
import { isRecord } from '../shared/contracts.mts';
import { callCaptionCopy } from './call-caption-copy.mts';
import {
  CALL_CAPTION_EVENT_METHOD,
  isCallCaptionId,
  readCallCaption,
} from '../../src/contracts/call-caption.mts';
const ENDED_CALL_LIMIT = 64;
const LIVE_CALL_STATES = new Set(['connecting', 'negotiating', 'connected']);
interface SubtitleSnapshot {
  callId: string | null;
  provider: string | null;
  text: string;
  final: boolean;
  sequence: number;
}
interface SubtitleOptions {
  onChange?: (value: SubtitleSnapshot) => void;
}

/** Ephemeral display only: no messages, storage, transport writes or history. */
export function createCallSubtitles({ onChange = () => {} }: SubtitleOptions = {}) {
  let callId: string | null = null,
    provider: string | null = null,
    text = '',
    final = false,
    sequence = 0,
    scope: unknown = Symbol('initial-caption-scope');
  const ended = new Set<string>();
  const snapshot = () => ({ callId, provider, text, final, sequence });
  function clear() {
    if (!text && !final) return;
    text = '';
    final = false;
    onChange(snapshot());
  }
  function end() {
    if (callId) {
      ended.add(callId);
      while (ended.size > ENDED_CALL_LIMIT) {
        const oldest = ended.values().next().value;
        if (oldest !== undefined) ended.delete(oldest);
      }
    }
    clear();
    callId = null;
    provider = null;
    sequence = 0;
  }
  function sync(value: unknown, currentScope?: unknown) {
    if (scope !== currentScope) {
      end();
      ended.clear();
      scope = currentScope;
    }
    const call = isRecord(value) ? value : {};
    const next = call?.id || call?.callId;
    if (
      !isCallCaptionId(next) ||
      ended.has(next) ||
      (call.provider !== 'subscription' && call.provider !== 'api') ||
      (typeof call.status === 'string' && !LIVE_CALL_STATES.has(call.status))
    ) {
      end();
      return;
    }
    if (next === callId && call.provider === provider) return;
    end();
    callId = next;
    provider = call.provider;
  }
  function receive(event: unknown) {
    if (!isRecord(event) || event.method !== CALL_CAPTION_EVENT_METHOD) return false;
    const raw = event.params,
      value = readCallCaption(raw);
    if (
      !value ||
      !callId ||
      value?.callId !== callId ||
      value.provider !== provider ||
      value.sequence <= sequence ||
      (isRecord(raw) && raw.role !== undefined && raw.role !== 'assistant')
    )
      return false;
    sequence = value.sequence;
    text = value.text;
    final = value.final;
    onChange(snapshot());
    return true;
  }
  function receiveSnapshot(value: unknown) {
    if (value === undefined) return false; // Compatible with old work services.
    if (value === null) {
      clear();
      return true;
    }
    return receive({ method: CALL_CAPTION_EVENT_METHOD, params: value });
  }
  function render({ mini = false, language = 'en', enabled = true } = {}) {
    const words = callCaptionCopy(language),
      hidden = mini || !callId;
    return `<div class="call-subtitles" data-call-subtitles data-caption-enabled="${enabled}" role="status" aria-live="polite" aria-atomic="true" aria-label="${escape(words.label)}" aria-hidden="${hidden}" aria-busy="${Boolean(enabled && text && !final)}"${hidden ? ' hidden' : ''}><small data-call-subtitle-placeholder ${!enabled || text ? 'hidden' : ''}>${escape(words.waiting)}</small><small data-call-subtitle-disabled ${enabled ? 'hidden' : ''}>${escape(words.disabled)}</small><small data-call-subtitle-speaker ${!enabled || !text ? 'hidden' : ''}>dant</small><span data-call-subtitle-text>${enabled ? escape(text) : ''}</span></div>`;
  }
  function update(document: Document) {
    for (const node of document.querySelectorAll<HTMLElement>('[data-call-subtitles]')) {
      const value = node.querySelector('[data-call-subtitle-text]');
      const enabled = node.dataset.captionEnabled !== 'false',
        placeholder = node.querySelector<HTMLElement>('[data-call-subtitle-placeholder]'),
        speaker = node.querySelector<HTMLElement>('[data-call-subtitle-speaker]');
      if (value) value.textContent = enabled ? text : '';
      if (placeholder) placeholder.hidden = !enabled || !callId || Boolean(text);
      if (speaker) speaker.hidden = !enabled || !text;
      node.setAttribute('aria-hidden', String(!callId || node.hidden));
      node.setAttribute('aria-busy', String(Boolean(enabled && text && !final)));
      if (enabled && text) node.scrollTop = node.scrollHeight;
    }
  }
  return {
    sync,
    receive,
    receiveSnapshot,
    clear,
    end,
    render,
    update,
    get snapshot() {
      return snapshot();
    },
    dispose() {
      end();
    },
  };
}
