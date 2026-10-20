import { isRecord } from '../shared/json.mts';

export const CALL_CAPTION_EVENT_METHOD = 'dant/call/subtitle';
export const CALL_CAPTION_TEXT_LIMIT = 4_000;
export const CALL_CAPTION_ID_LIMIT = 256;
export type CallCaptionProvider = 'subscription' | 'api';
export interface CallCaption {
  callId: string;
  provider: CallCaptionProvider;
  sequence: number;
  text: string;
  final: boolean;
}
export const isCallCaptionId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= CALL_CAPTION_ID_LIMIT &&
  !/[\x00-\x1f\x7f]/.test(value);
export const isCallCaptionProvider = (value: unknown): value is CallCaptionProvider =>
  value === 'subscription' || value === 'api';

/** Only the bounded, already sanitized current assistant utterance crosses this boundary. */
export function readCallCaption(value: unknown): CallCaption | null {
  if (
    !isRecord(value) ||
    !isCallCaptionId(value.callId) ||
    !isCallCaptionProvider(value.provider) ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence <= 0 ||
    typeof value.text !== 'string' ||
    value.text.length > CALL_CAPTION_TEXT_LIMIT ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text) ||
    typeof value.final !== 'boolean'
  )
    return null;
  return {
    callId: value.callId,
    provider: value.provider,
    sequence: value.sequence,
    text: value.text,
    final: value.final,
  };
}
