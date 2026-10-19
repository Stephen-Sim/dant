import {registerLocale} from '../src/i18n.mjs';
import {normalizeLanguage} from '../src/languages.mjs';
const loaders={
 'zh-TW':()=>import('../src/locales/zh-TW.json',{with:{type:'json'}}),ja:()=>import('../src/locales/ja.json',{with:{type:'json'}}),ko:()=>import('../src/locales/ko.json',{with:{type:'json'}}),
 es:()=>import('../src/locales/es.json',{with:{type:'json'}}),fr:()=>import('../src/locales/fr.json',{with:{type:'json'}}),de:()=>import('../src/locales/de.json',{with:{type:'json'}}),pt:()=>import('../src/locales/pt.json',{with:{type:'json'}}),
 ru:()=>import('../src/locales/ru.json',{with:{type:'json'}}),ar:()=>import('../src/locales/ar.json',{with:{type:'json'}}),hi:()=>import('../src/locales/hi.json',{with:{type:'json'}}),
 id:()=>import('../src/locales/id.json',{with:{type:'json'}}),ms:()=>import('../src/locales/ms.json',{with:{type:'json'}}),it:()=>import('../src/locales/it.json',{with:{type:'json'}}),tr:()=>import('../src/locales/tr.json',{with:{type:'json'}}),
};
const pending=new Map();
export async function loadLanguage(value){const code=normalizeLanguage(value);if(!loaders[code])return;if(!pending.has(code))pending.set(code,loaders[code]().then(module=>registerLocale(code,module.default)).catch(error=>{pending.delete(code);throw error;}));await pending.get(code);}
