// Stable preference IDs are shared by the desktop, worker and UI.
import registry from './language-registry.json' with {type:'json'};
export const languages=Object.freeze(registry.map(item=>Object.freeze({...item})));
const byCode=new Map(languages.map(item=>[item.code,item]));
export const isLanguage=value=>typeof value==='string'&&byCode.has(value);
export const normalizeLanguage=(value,fallback='zh')=>isLanguage(value)?value:isLanguage(fallback)?fallback:'zh';
export const languageInfo=value=>byCode.get(normalizeLanguage(value));
export const isChinese=value=>value==='zh'||value==='zh-TW';
// Compatibility with native components which expose only these two UI copies.
export const legacyLanguage=value=>isChinese(value)?'zh':'en';
