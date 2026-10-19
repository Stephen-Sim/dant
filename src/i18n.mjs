import {isLanguage,normalizeLanguage,languageInfo} from './languages.mjs';
const catalogs=new Map(),dictionaryCache=new WeakMap();
export function registerLocale(language,catalog){
 if(!isLanguage(language)||!catalog||typeof catalog!=='object'||Array.isArray(catalog))throw Error('Invalid language catalog');
 const copy=Object.create(null);for(const [key,value]of Object.entries(catalog)){if(!key||typeof value!=='string'||!value.trim())throw Error('Invalid language translation');copy[key]=value;}
 catalogs.set(language,Object.freeze(copy));return catalogs.get(language);
}
export function translate(language,english,chinese){
 const selected=normalizeLanguage(language,'en');
 if(selected==='zh'&&typeof chinese==='string')return chinese;
 return catalogs.get(selected)?.[english]??english;
}
// Only fixed application templates are translated. Dynamic values are bounded
// numeric counts, never user messages or other text supplied by the user.
export function translateCount(language,count,singular,plural,chinese){
 if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid localized count');
 const selected=normalizeLanguage(language,'en'),template=translate(selected,count===1?singular:plural,chinese);
 return template.replaceAll('{count}',new Intl.NumberFormat(languageInfo(selected).locale).format(count));
}
// Called only for application-owned dictionaries. User messages, filenames,
// task titles, memory, previews and server diagnostics are never passed here.
export function localizeMessages(dictionary,language){
 const selected=normalizeLanguage(language,'en');
 if(selected==='zh'&&dictionary.zh)return dictionary.zh;
 if(selected==='en')return dictionary.en;
 let cache=dictionaryCache.get(dictionary);if(!cache){cache=new Map();dictionaryCache.set(dictionary,cache);}
 const catalog=catalogs.get(selected),previous=cache.get(selected);if(previous&&previous.catalog===catalog)return previous.value;
 const visit=value=>typeof value==='string'?translate(selected,value):Array.isArray(value)?value.map(visit):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)])):value;
 const value=visit(dictionary.en);cache.set(selected,{catalog,value});return value;
}
