const MAX_RAW = 65536,
  MAX_VISIBLE = 4000;
const id = (value) =>
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
}) {
  let raw = '',
    text = '',
    final = false,
    sequence = 0,
    responseId = null,
    itemKey = null,
    partOrder = -1;
  const retired = new Set();
  function retire(value) {
    if (value) retired.add(value);
    while (retired.size > 64) retired.delete(retired.values().next().value);
  }
  function publish(next, done) {
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
  function write(value, done, { append = false } = {}) {
    if (typeof value !== 'string') return;
    if (final && append) raw = '';
    raw = (append ? raw + value : value).slice(-MAX_RAW);
    publish(raw, done);
  }
  function native(method, p) {
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
  function api(event) {
    const type = event?.type;
    if (type === 'response.created') {
      const next = event.response?.id;
      if (
        !id(next) ||
        event.response.conversation_id === null ||
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
      if (event.response?.id !== responseId) return;
      if (event.response.status !== 'completed') clear();
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
      !Number.isSafeInteger(output) ||
      output < 0 ||
      output > 128 ||
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
