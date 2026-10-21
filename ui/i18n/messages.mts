import { isLanguage, normalizeLanguage, languageInfo } from './languages.mts';
import type { LanguageCode } from './languages.mts';

export type TranslationCatalog = Readonly<Record<string, string>>;
export type Localized<T> = T extends string
  ? string
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { [Key in keyof T]: Localized<T[Key]> }
      : T;
export interface MessageDictionary<T extends object> {
  readonly en: T;
  readonly zh?: Localized<T>;
}
interface CachedDictionary {
  catalog: TranslationCatalog | undefined;
  value: unknown;
}

const catalogs = new Map<LanguageCode, TranslationCatalog>(),
  dictionaryCache = new WeakMap<object, Map<LanguageCode, CachedDictionary>>();
export function registerLocale(language: unknown, catalog: unknown): TranslationCatalog {
  if (!isLanguage(language) || !catalog || typeof catalog !== 'object' || Array.isArray(catalog))
    throw Error('Invalid language catalog');
  const copy: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(catalog as Record<string, unknown>)) {
    if (!key || typeof value !== 'string' || !value.trim())
      throw Error('Invalid language translation');
    copy[key] = value;
  }
  const registered = Object.freeze(copy);
  catalogs.set(language, registered);
  return registered;
}
export function translate(language: unknown, english: string, chinese?: string): string {
  const selected = normalizeLanguage(language, 'en');
  if (selected === 'zh' && typeof chinese === 'string') return chinese;
  return catalogs.get(selected)?.[english] ?? english;
}
// Only fixed application templates are translated. Dynamic values are bounded
// numeric counts, never user messages or other text supplied by the user.
export function translateCount(
  language: unknown,
  count: number,
  singular: string,
  plural: string,
  chinese?: string,
): string {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    throw Error('Invalid localized count');
  const selected = normalizeLanguage(language, 'en'),
    template = translate(selected, count === 1 ? singular : plural, chinese);
  return template.replaceAll(
    '{count}',
    new Intl.NumberFormat(languageInfo(selected).locale).format(count),
  );
}
// Called only for application-owned dictionaries. User messages, filenames,
// task titles, memory, previews and server diagnostics are never passed here.
export function localizeMessages<T extends object>(
  dictionary: MessageDictionary<T>,
  language: unknown,
): Localized<T> {
  const selected = normalizeLanguage(language, 'en');
  if (selected === 'zh' && dictionary.zh) return dictionary.zh;
  if (selected === 'en') return dictionary.en as Localized<T>;
  let cache = dictionaryCache.get(dictionary);
  if (!cache) {
    cache = new Map();
    dictionaryCache.set(dictionary, cache);
  }
  const catalog = catalogs.get(selected),
    previous = cache.get(selected);
  if (previous && previous.catalog === catalog) return previous.value as Localized<T>;
  const visit = (value: unknown): unknown =>
    typeof value === 'string'
      ? translate(selected, value)
      : Array.isArray(value)
        ? value.map(visit)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]))
          : value;
  const value = visit(dictionary.en) as Localized<T>;
  cache.set(selected, { catalog, value });
  return value;
}
