import {
  languages,
  isLanguage,
  normalizeLanguage,
  languageInfo,
  languageForWorker,
} from '../src/i18n/languages.mts';
import { translate, localizeMessages } from '../src/i18n/i18n.mts';
// VM fixtures run selected UI functions without loading browser assets.
export const languageContext = {
  languages,
  isLanguage,
  normalizeLanguage,
  languageInfo,
  languageForWorker,
  translate,
  localizeMessages,
  loadLanguage: async () => {},
};
