import {languages,isLanguage,normalizeLanguage,languageInfo,legacyLanguage} from '../src/languages.mjs';
import {translate,localizeMessages} from '../src/i18n.mjs';
// VM fixtures run selected UI functions without loading browser assets.
export const languageContext={languages,isLanguage,normalizeLanguage,languageInfo,legacyLanguage,translate,localizeMessages,loadLanguage:async()=>{}};
