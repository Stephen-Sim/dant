import { isLanguage } from '../../src/i18n/languages.mts';
import type { LanguageCode } from '../../src/i18n/languages.mts';
import { isFiniteNumber, isRecord, isSafeInteger } from '../shared/contracts.mts';

export type OverlayStatus = 'calling' | 'talking' | 'recovering' | 'stopping';
export type OverlayActionName = 'mute' | 'hangup' | 'restore';
export interface OverlayState {
  callId: string;
  status: OverlayStatus;
  connectedAt: number | null;
  seconds: number;
  confirmed: boolean;
  running: boolean;
  muted: boolean;
  canMute: boolean;
  language: LanguageCode;
  theme: 'light' | 'dark';
}
export type OverlayAction = { callId: string } & (
  { action: 'mute'; muted: boolean } | { action: 'hangup' | 'restore' }
);
export const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_:.-]{1,128}$/.test(value);
export const isOverlayAction = (value: unknown): value is OverlayActionName =>
  value === 'mute' || value === 'hangup' || value === 'restore';
const isStatus = (value: unknown): value is OverlayStatus =>
  value === 'calling' || value === 'talking' || value === 'recovering' || value === 'stopping';
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const MAX_SECONDS = 9_007_199_254_740;

export function overlaySnapshot(value: unknown): OverlayState | null {
  if (
    !isRecord(value) ||
    !identifier(value.callId) ||
    !isStatus(value.status) ||
    !isLanguage(value.language) ||
    (value.theme !== 'light' && value.theme !== 'dark')
  )
    return null;
  return {
    callId: value.callId,
    status: value.status,
    connectedAt:
      isSafeInteger(value.connectedAt) &&
      value.connectedAt >= 0 &&
      value.connectedAt <= MAX_TIMESTAMP
        ? value.connectedAt
        : null,
    seconds: isFiniteNumber(value.seconds)
      ? Math.min(MAX_SECONDS, Math.max(0, Math.floor(value.seconds)))
      : 0,
    confirmed: Boolean(value.confirmed),
    running: Boolean(value.running),
    muted: Boolean(value.muted),
    canMute: Boolean(value.canMute),
    language: value.language,
    theme: value.theme,
  };
}
