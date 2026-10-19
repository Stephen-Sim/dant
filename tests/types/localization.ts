import {
  isLanguage,
  languageForWorker,
  languageInfo,
  normalizeLanguage,
} from '../../src/i18n/languages.mts';
import type { LanguageCode } from '../../src/i18n/languages.mts';
import { localizeMessages, translate, translateCount } from '../../src/i18n/i18n.mts';

const source: unknown = 'fr';
if (isLanguage(source)) {
  const selected: LanguageCode = source;
  languageInfo(selected);
}
const normalized: LanguageCode = normalizeLanguage(source);
const compatible: LanguageCode = languageForWorker(normalized, ['fr', 'ja']);
const direction: 'ltr' | 'rtl' = languageInfo(compatible).direction;
void direction;

const words = localizeMessages(
  {
    en: { heading: 'Heading', count: (value: number) => String(value), nested: { label: 'Label' } },
    zh: { heading: '标题', count: (value: number) => String(value), nested: { label: '标签' } },
  },
  source,
);
const title: string = words.heading;
const count: string = words.count(2);
const label: string = words.nested.label;
translate(compatible, title, label);
translateCount(compatible, 2, '{count} day', '{count} days');
void count;

// @ts-expect-error Unsupported language IDs must not become a typed preference.
const invalidLanguage: LanguageCode = 'unsupported';
void invalidLanguage;
// @ts-expect-error Localization retains the dictionary's actual keys.
words.missing;
// @ts-expect-error Function-valued messages retain their parameter contract.
words.count('two');
// @ts-expect-error Dynamic counts must be numbers.
translateCount('fr', 'two', '{count} day', '{count} days');
// @ts-expect-error Fixed translation sources must be strings.
translate('fr', { message: 'Heading' });
