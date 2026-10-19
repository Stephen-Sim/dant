import { registerLocale } from '../../src/i18n/i18n.mts';
import type { TranslationCatalog } from '../../src/i18n/i18n.mts';
import { normalizeLanguage } from '../../src/i18n/languages.mts';
import type { LanguageCode } from '../../src/i18n/languages.mts';

type CatalogLanguage = Exclude<LanguageCode, 'en' | 'zh'>;
type CatalogLoader = () => Promise<{ default: unknown }>;
const loaders: Record<CatalogLanguage, CatalogLoader> = {
  'zh-TW': () => import('../../src/i18n/locales/zh-TW.json', { with: { type: 'json' } }),
  ja: () => import('../../src/i18n/locales/ja.json', { with: { type: 'json' } }),
  ko: () => import('../../src/i18n/locales/ko.json', { with: { type: 'json' } }),
  es: () => import('../../src/i18n/locales/es.json', { with: { type: 'json' } }),
  fr: () => import('../../src/i18n/locales/fr.json', { with: { type: 'json' } }),
  de: () => import('../../src/i18n/locales/de.json', { with: { type: 'json' } }),
  pt: () => import('../../src/i18n/locales/pt.json', { with: { type: 'json' } }),
  ru: () => import('../../src/i18n/locales/ru.json', { with: { type: 'json' } }),
  ar: () => import('../../src/i18n/locales/ar.json', { with: { type: 'json' } }),
  hi: () => import('../../src/i18n/locales/hi.json', { with: { type: 'json' } }),
  id: () => import('../../src/i18n/locales/id.json', { with: { type: 'json' } }),
  ms: () => import('../../src/i18n/locales/ms.json', { with: { type: 'json' } }),
  it: () => import('../../src/i18n/locales/it.json', { with: { type: 'json' } }),
  tr: () => import('../../src/i18n/locales/tr.json', { with: { type: 'json' } }),
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
