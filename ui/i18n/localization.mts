import { registerLocale } from './messages.mts';
import type { TranslationCatalog } from './messages.mts';
import { normalizeLanguage } from './languages.mts';
import type { LanguageCode } from './languages.mts';

type CatalogLanguage = Exclude<LanguageCode, 'en' | 'zh'>;
type CatalogLoader = () => Promise<{ default: unknown }>;
const loaders: Record<CatalogLanguage, CatalogLoader> = {
  'zh-TW': () => import('../../resources/i18n/locales/zh-TW.json', { with: { type: 'json' } }),
  ja: () => import('../../resources/i18n/locales/ja.json', { with: { type: 'json' } }),
  ko: () => import('../../resources/i18n/locales/ko.json', { with: { type: 'json' } }),
  es: () => import('../../resources/i18n/locales/es.json', { with: { type: 'json' } }),
  fr: () => import('../../resources/i18n/locales/fr.json', { with: { type: 'json' } }),
  de: () => import('../../resources/i18n/locales/de.json', { with: { type: 'json' } }),
  pt: () => import('../../resources/i18n/locales/pt.json', { with: { type: 'json' } }),
  ru: () => import('../../resources/i18n/locales/ru.json', { with: { type: 'json' } }),
  ar: () => import('../../resources/i18n/locales/ar.json', { with: { type: 'json' } }),
  hi: () => import('../../resources/i18n/locales/hi.json', { with: { type: 'json' } }),
  id: () => import('../../resources/i18n/locales/id.json', { with: { type: 'json' } }),
  ms: () => import('../../resources/i18n/locales/ms.json', { with: { type: 'json' } }),
  it: () => import('../../resources/i18n/locales/it.json', { with: { type: 'json' } }),
  tr: () => import('../../resources/i18n/locales/tr.json', { with: { type: 'json' } }),
};
const pending = new Map<CatalogLanguage, Promise<TranslationCatalog>>();
export async function loadLanguage(value: unknown): Promise<void> {
  const code = normalizeLanguage(value);
  if (code === 'en' || code === 'zh') return;
  let request = pending.get(code);
  if (!request) {
    request = loaders[code]()
      .then((module) => registerLocale(code, module.default))
      .catch((error: unknown) => {
        pending.delete(code);
        throw error;
      });
    pending.set(code, request);
  }
  await request;
}
