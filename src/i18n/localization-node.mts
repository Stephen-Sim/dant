import fs from 'node:fs';
import { isLanguage } from './languages.mts';
import { registerLocale } from './i18n.mts';
export function loadSystemLanguage(language: unknown): void {
  if (!isLanguage(language) || ['en', 'zh'].includes(language)) return;
  const file = new URL('./locales/' + language + '.json', import.meta.url),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
    throw Error('The language catalog is unavailable.');
  registerLocale(language, JSON.parse(fs.readFileSync(file, 'utf8')));
}
