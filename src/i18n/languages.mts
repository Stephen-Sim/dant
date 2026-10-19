// Stable preference IDs are shared by the desktop, worker and UI.
import registry from './language-registry.json' with { type: 'json' };

export type LanguageCode =
  | 'en'
  | 'zh'
  | 'zh-TW'
  | 'ja'
  | 'ko'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'
  | 'ru'
  | 'ar'
  | 'hi'
  | 'id'
  | 'ms'
  | 'it'
  | 'tr';

export interface LanguageInfo {
  readonly code: LanguageCode;
  readonly label: string;
  readonly name: string;
  readonly locale: string;
  readonly speech: string;
  readonly direction: 'ltr' | 'rtl';
}

export const languages: readonly LanguageInfo[] = Object.freeze(
  registry.map((item) => {
    if (item.direction !== 'ltr' && item.direction !== 'rtl')
      throw Error('The language registry contains an invalid writing direction.');
    return Object.freeze({ ...item, code: item.code as LanguageCode, direction: item.direction });
  }),
);
const byCode = new Map(languages.map((item) => [item.code, item]));
export const isLanguage = (value: unknown): value is LanguageCode =>
  typeof value === 'string' && byCode.has(value as LanguageCode);
export const normalizeLanguage = (value: unknown, fallback: unknown = 'zh'): LanguageCode =>
  isLanguage(value) ? value : isLanguage(fallback) ? fallback : 'zh';
export function languageInfo(value: unknown): LanguageInfo {
  const info = byCode.get(normalizeLanguage(value));
  if (!info) throw Error('The language registry is incomplete.');
  return info;
}
export const isChinese = (value: unknown): value is 'zh' | 'zh-TW' =>
  value === 'zh' || value === 'zh-TW';
// Only an old Worker lacking the language capability needs a fallback. Current
// Workers advertise the full registry; UI and native components use it directly.
export function languageForWorker(
  value: unknown,
  supportedCodes: unknown = ['en', 'zh'],
): LanguageCode {
  const selected = normalizeLanguage(value);
  if (Array.isArray(supportedCodes) && supportedCodes.includes(selected)) return selected;
  return isChinese(selected) ? 'zh' : 'en';
}
