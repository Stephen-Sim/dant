import { isRecord } from '../contracts/json.mts';
interface SubtitleEvent {
  method: 'dant/call/subtitle';
  params: { callId: string; provider: string; sequence: number; text: string; final: boolean };
}
interface SubtitleOptions {
  callId: string;
  provider: string;
  redact?: (text: string) => string;
  emit?: (event: SubtitleEvent) => unknown;
}
const MAX_RAW = 65536,
  MAX_VISIBLE = 4000;
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x1f\x7f]/.test(value);

/** One transient spoken assistant utterance. Never reads or saves chat/history. */
export function createSpokenSubtitles({
  callId,
  provider,
  redact = (text) => text,
  emit = () => {},
}: SubtitleOptions) {
  let raw = '',
    text = '',
    final = false,
    sequence = 0,
    responseId: string | null = null,
    itemKey: string | null = null,
    partOrder = -1;
  const retired = new Set<string>();
  function retire(value: string | null) {
    if (value) retired.add(value);
    while (retired.size > 64) {
      const first = retired.values().next();
      if (!first.done) retired.delete(first.value);
    }
  }
  function publish(next: string, done: boolean) {
    let safe;
    try {
      safe = String(redact(next))
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .slice(-MAX_VISIBLE);
      if (/[\uDC00-\uDFFF]/.test(safe[0] || '')) safe = safe.slice(1);
    } catch {
      safe = '';
    }
    if (text === safe && final === done) return;
    text = safe;
    final = done;
    emit({
      method: 'dant/call/subtitle',
      params: { callId, provider, sequence: ++sequence, text, final },
    });
  }
  function clear() {
    raw = '';
    itemKey = null;
    partOrder = -1;
    publish('', false);
  }
  function write(value: unknown, done: boolean, { append = false }: { append?: boolean } = {}) {
    if (typeof value !== 'string') return;
    if (final && append) raw = '';
    raw = (append ? raw + value : value).slice(-MAX_RAW);
    publish(raw, done);
  }
  function native(method: string, p: unknown) {
    if (!isRecord(p)) return;
    if (!['thread/realtime/transcript/delta', 'thread/realtime/transcript/done'].includes(method))
      return;
    if (p.role === 'user') {
      clear();
      return;
    }
    if (p.role !== 'assistant') return;
    if (method.endsWith('/delta')) write(p.delta, false, { append: true });
    else write(p.text, true);
  }
  function api(event: unknown) {
    if (!isRecord(event)) return;
    const type = typeof event.type === 'string' ? event.type : '';
    const response = isRecord(event.response) ? event.response : {};
    if (type === 'response.created') {
      const next = response.id;
      if (
        !id(next) ||
        response.conversation_id === null ||
        retired.has(next) ||
        next === responseId
      )
        return;
      retire(responseId);
      responseId = next;
      clear();
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      retire(responseId);
      responseId = null;
      clear();
      return;
    }
    if (['conversation.item.deleted', 'conversation.item.truncated'].includes(type)) {
      if (itemKey?.startsWith(event.item_id + ':')) {
        retire(responseId);
        responseId = null;
        clear();
      }
      return;
    }
    if (type === 'response.done') {
      if (response.id !== responseId) return;
      if (response.status !== 'completed') clear();
      else if (raw) publish(raw, true);
      retire(responseId);
      responseId = null;
      return;
    }
    const delta = [
        'response.output_audio_transcript.delta',
        'response.audio_transcript.delta',
      ].includes(type),
      done = ['response.output_audio_transcript.done', 'response.audio_transcript.done'].includes(
        type,
      );
    if ((!delta && !done) || !responseId || event.response_id !== responseId || !id(event.item_id))
      return;
    const output = event.output_index ?? 0,
      content = event.content_index ?? 0;
    if (
      typeof output !== 'number' ||
      !Number.isSafeInteger(output) ||
      output < 0 ||
      output > 128 ||
      typeof content !== 'number' ||
      !Number.isSafeInteger(content) ||
      content < 0 ||
      content > 128
    )
      return;
    const order = output * 129 + content,
      key = event.item_id + ':' + content;
    if (order < partOrder || (order === partOrder && itemKey && key !== itemKey)) return;
    if (key !== itemKey) {
      raw = '';
      final = false;
      itemKey = key;
      partOrder = order;
    } else if (final) return;
    write(delta ? event.delta : event.transcript, done, { append: delta });
  }
  return {
    native,
    api,
    clear,
    get snapshot() {
      return { callId, provider, sequence, text, final };
    },
  };
}
