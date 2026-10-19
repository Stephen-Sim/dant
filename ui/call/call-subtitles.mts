import type { ScheduleTimer, CancelTimer } from '../shared/contracts.mts';
import { translate } from '../../src/i18n/i18n.mts';
import { escapeHtml as escape } from '../shared/html.mts';
import { isRecord, isSafeInteger } from '../shared/contracts.mts';
import type { Timer } from '../shared/contracts.mts';
const label = (language: unknown) => translate(language, 'dant live captions', 'dant 实时字幕');
const SUBTITLE_FINAL_DELAY_MS = 8_000;
const ENDED_CALL_LIMIT = 64;
const SUBTITLE_TEXT_LIMIT = 4_000;
interface SubtitleSnapshot {
  callId: string | null;
  provider: string | null;
  text: string;
  final: boolean;
  sequence: number;
}
interface SubtitleOptions {
  onChange?: (value: SubtitleSnapshot) => void;
  schedule?: ScheduleTimer;
  cancel?: CancelTimer;
  finalDelay?: number;
}

/** Ephemeral display only: no messages, storage, transport writes or history. */
export function createCallSubtitles({
  onChange = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
  finalDelay = SUBTITLE_FINAL_DELAY_MS,
}: SubtitleOptions = {}) {
  let callId: string | null = null,
    provider: string | null = null,
    text = '',
    final = false,
    sequence = 0,
    timer: Timer | null = null;
  const ended = new Set<string>();
  const snapshot = () => ({ callId, provider, text, final, sequence });
  function clearTimer() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }
  function clear() {
    clearTimer();
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
  function sync(value: unknown) {
    const call = isRecord(value) ? value : {};
    const next = call?.id || call?.callId;
    if (
      typeof next !== 'string' ||
      !next ||
      ended.has(next) ||
      (call.provider !== 'subscription' && call.provider !== 'api') ||
      call.status === 'stopping' ||
      call.status === 'stop-unconfirmed'
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
    if (!isRecord(event) || event.method !== 'dant/call/subtitle') return false;
    const value = event.params;
    if (
      !isRecord(value) ||
      !callId ||
      value?.callId !== callId ||
      value.provider !== provider ||
      !isSafeInteger(value.sequence) ||
      value.sequence <= sequence ||
      typeof value.text !== 'string' ||
      value.text.length > SUBTITLE_TEXT_LIMIT ||
      typeof value.final !== 'boolean'
    )
      return false;
    clearTimer();
    sequence = value.sequence;
    text = value.text;
    final = value.final;
    onChange(snapshot());
    if (final && text) {
      const current = callId,
        revision = sequence;
      timer = schedule(() => {
        if (current !== callId || revision !== sequence) return;
        timer = null;
        clear();
      }, finalDelay);
      if (typeof timer === 'object') timer.unref?.();
    }
    return true;
  }
  function render({ mini = false, language = 'en' } = {}) {
    return `<div class="call-subtitles" data-call-subtitles role="status" aria-live="polite" aria-atomic="true" aria-label="${label(language)}" aria-hidden="${!text || mini}" aria-busy="${Boolean(text && !final)}"${mini ? ' hidden' : ''}><span data-call-subtitle-text>${escape(text)}</span></div>`;
  }
  function update(document: Document) {
    for (const node of document.querySelectorAll<HTMLElement>('[data-call-subtitles]')) {
      const value = node.querySelector('[data-call-subtitle-text]');
      if (value) value.textContent = text;
      node.setAttribute('aria-hidden', String(!text || node.hidden));
      node.setAttribute('aria-busy', String(Boolean(text && !final)));
      if (text) node.scrollTop = node.scrollHeight;
    }
  }
  return {
    sync,
    receive,
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
