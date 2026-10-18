import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {createSettingsNavigation} from '../ui/settings-navigation.js';

const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
function fixture({language='en'}={}){
 const {document,Event}=parseHTML('<main id="app"></main>'),app=document.querySelector('#app'),loads=[],errors=[],focus=[],scroll=[];let host='',fontOpen=false,voiceDisabled=false,handler=async()=>{};
 const ui=createSettingsNavigation({document,getLanguage:()=>language,onChange:render,onCategory:async category=>{loads.push(category);await handler(category);},onError:error=>errors.push(error)});
 function sections(){return {
  general:'<section class="settings-section"><button data-language="zh">中文</button><input type="checkbox" id="notifications"><input type="checkbox" id="showWorkSummary"></section><section class="settings-section text-editor-settings"><button data-editor-choose>Choose editor</button></section>',
  appearance:`<section class="settings-section"><button data-theme="light">Light</button><details id="appearance-font-picker" ${fontOpen?'open':''}><summary>System font</summary><input id="font-local-search" value="Arial"></details><details id="appearance-advanced"><summary>Advanced</summary><input id="appearance-size" type="number" value="13"></details></section>`,
  voice:`<section class="settings-section"><select id="nativeVoice" ${voiceDisabled?'disabled':''}><option>Ember</option></select><details><summary>API</summary><input type="password" id="voice-api-key"></details></section>`,
  computer:`<section class="settings-section vm-settings"><input id="vm-host-draft" value="${host}"></section>`,
  account:'<section class="settings-section" data-setting-card="account">private-account@example.test<select id="model"><option>Default</option></select></section>',
  credentials:'<section class="settings-section credentials-settings"><input type="password" id="private-vault">Private credential nickname</section>',
  history:'<section class="settings-section conversation-settings">Private conversation text<button data-action="memory">Memory</button></section>',
  telegram:'<section class="settings-section telegram-settings"><input type="password" id="telegram-token"></section>',
  about:'<section class="settings-section"><strong data-app-version>1.0.0</strong><button data-check-updates>Check for updates</button></section>',
 };}
 function render(){const template=document.createElement('template');template.innerHTML=ui.render(sections());reconcile(app,template.content);for(const node of document.querySelectorAll('button,input,select,summary,[tabindex],.settings-section,[data-settings-panel]')){node.focus=()=>focus.push(node);node.scrollIntoView=options=>scroll.push({node,options});}document.querySelector('#vm-host-draft').oninput=event=>host=event.target.value;document.querySelector('#appearance-font-picker').ontoggle=event=>fontOpen=event.target.open;ui.bind();}
 render();ui.sync(true);return {ui,document,Event,loads,errors,focus,scroll,render,disableVoice(){voiceDisabled=true;render();},set handler(value){handler=value;},set language(value){language=value;},async click(selector){const node=document.querySelector(selector);assert.ok(node,selector);node.dispatchEvent(new Event('click',{bubbles:true,cancelable:true}));await settle();},async search(value){const input=document.querySelector('#settings-search');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));await settle();},async key(selector,key,extra={}){const event=new Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key,...extra});document.querySelector(selector).dispatchEvent(event);await settle();return event;}};
}
const visiblePanels=f=>[...f.document.querySelectorAll('[data-settings-panel]')].filter(node=>!node.hidden).map(node=>node.dataset.settingsPanel);

test('settings default to General, render a bilingual category menu, and load only the chosen category',async()=>{
 for(const [language,labels]of [['en',['General','Appearance','Voice','Work computer','ChatGPT','Credentials','Chat & data','Telegram','About dant']],['zh',['通用','外观','语音','工作电脑','ChatGPT 账号','凭据与密钥','聊天与数据','Telegram 集成','关于 dant']]]){
  const f=fixture({language});await settle();assert.deepEqual([...f.document.querySelectorAll('[data-settings-category]')].map(node=>node.textContent),labels);assert.deepEqual(visiblePanels(f),['general']);assert.equal(f.document.querySelector('[aria-current]').dataset.settingsCategory,'general');assert.deepEqual(f.loads,['general']);assert.ok(f.document.querySelector('label[for="settings-search"]'));assert.equal(f.document.querySelector('#settings-search-hint'),null);assert.equal(f.document.querySelector('#settings-search').getAttribute('aria-describedby'),null);assert.doesNotMatch(f.document.body.textContent,/Search setting names in English or Chinese|支持搜索中文或英文设置名称/);
  await f.click('[data-settings-category="appearance"]');assert.deepEqual(visiblePanels(f),['appearance']);assert.deepEqual(f.loads,['general','appearance']);f.render();await settle();assert.deepEqual(f.loads,['general','appearance']);assert.equal(f.ui.isVisible('about'),false);
 }
});

test('English and Chinese search find settings in every category without requiring its visible panel or network data',async()=>{
 const f=fixture();await settle();for(const [query,result,category]of [['font','font','appearance'],['字体','font','appearance'],['voice key','voice-key','voice'],['重连','connection','computer'],['login','subscription','account'],['密钥管理','vault','credentials'],['清空','clear-history','history'],['telegram bot','telegram-token','telegram'],['version','version','about'],['语言','language','general']]){
  await f.search(query);const node=f.document.querySelector(`[data-settings-result="${result}"]`);assert.ok(node,query);assert.ok(node.querySelector('small').textContent);assert.ok(node.querySelector('strong').textContent);assert.deepEqual(visiblePanels(f),[]);await f.click(`[data-settings-result="${result}"]`);assert.equal(f.ui.category,category);assert.deepEqual(visiblePanels(f),[category]);assert.equal(f.document.querySelector('#settings-search').value,'');
 }
 assert.equal(f.errors.length,0);
});

test('search result selection expands advanced details and focuses and scrolls the concrete setting control',async()=>{
 const f=fixture();await f.search('UI font size');await f.click('[data-settings-result="ui-size"]');const input=f.document.querySelector('#appearance-size');assert.equal(f.document.querySelector('#appearance-advanced').open,true);assert.equal(f.focus.at(-1),input);assert.equal(f.scroll.at(-1).node,input);assert.deepEqual(f.scroll.at(-1).options,{block:'center'});assert.equal(f.ui.category,'appearance');
});

test('English and Chinese editor searches reveal the fixed General setting without indexing a configured private path',async()=>{
 const f=fixture();for(const query of ['VS Code','text editor','编辑器','记事本']){await f.search(query);assert.ok(f.document.querySelector('[data-settings-result="text-editor"]'));await f.click('[data-settings-result="text-editor"]');assert.equal(f.ui.category,'general');assert.equal(f.scroll.at(-1).node,f.document.querySelector('.text-editor-settings'));}
});

test('work summary search finds its General preference and focuses the actual checkbox in either language',async()=>{
 const f=fixture();for(const query of ['work progress','show work','任务进度','隐藏']){await f.search(query);assert.ok(f.document.querySelector('[data-settings-result="work-summary"]'));await f.click('[data-settings-result="work-summary"]');assert.equal(f.ui.category,'general');assert.equal(f.focus.at(-1),f.document.querySelector('#showWorkSummary'));}
});

test('category switches and settings search preserve real DOM nodes, unsaved VM and secret inputs, and an open font picker',async()=>{
 const f=fixture();await f.click('[data-settings-category="computer"]');const host=f.document.querySelector('#vm-host-draft');host.value='192.0.2.123';host.dispatchEvent(new f.Event('input',{bubbles:true}));
 const password=f.document.querySelector('#telegram-token');let secret='private-live-token',writes=0;Object.defineProperty(password,'value',{configurable:true,get:()=>secret,set:value=>{writes++;secret=value;}});
 await f.click('[data-settings-category="appearance"]');const picker=f.document.querySelector('#appearance-font-picker');picker.open=true;picker.dispatchEvent(new f.Event('toggle'));await f.search('密钥');await f.click('[data-settings-category="telegram"]');
 assert.equal(f.document.querySelector('#telegram-token'),password);assert.equal(password.value,'private-live-token');assert.equal(writes,0);assert.equal(f.document.querySelector('#vm-host-draft'),host);assert.equal(host.value,'192.0.2.123');assert.equal(f.document.querySelector('#appearance-font-picker'),picker);assert.equal(picker.open,true);await f.click('[data-settings-category="computer"]');assert.equal(host.value,'192.0.2.123');
});

test('search indexes only the fixed labels, never account, credential, input or conversation contents',async()=>{
 const f=fixture();f.document.querySelector('#private-vault').value='super-private-secret';for(const query of ['private-account@example.test','Private credential nickname','Private conversation text','super-private-secret']){await f.search(query);assert.equal(f.document.querySelectorAll('[data-settings-result]').length,0);assert.match(f.document.querySelector('.settings-search-empty').textContent,/No matching settings/);}assert.deepEqual(f.loads,['general']);
 await f.search('<img src=x onerror=alert(1)>');assert.equal(f.document.querySelector('img'),null);assert.equal(f.document.querySelector('#settings-search').value,'<img src=x onerror=alert(1)>');assert.equal(f.document.querySelectorAll('[data-settings-result]').length,0);
});

test('keyboard navigation selects categories and search results; Escape and clear restore the selected view',async()=>{
 const f=fixture();await f.key('[data-settings-category="general"]','ArrowDown');assert.equal(f.ui.category,'appearance');assert.equal(f.focus.at(-1).dataset.settingsCategory,'appearance');await f.key('[data-settings-category="appearance"]','End');assert.equal(f.ui.category,'about');await f.key('[data-settings-category="about"]','Home');assert.equal(f.ui.category,'general');await f.key('[data-settings-category="general"]','ArrowLeft');assert.equal(f.ui.category,'about');
 await f.search('字体');await f.key('#settings-search','ArrowDown');assert.equal(f.focus.at(-1).dataset.settingsResult,'font');await f.key('#settings-search','Enter');assert.equal(f.ui.category,'appearance');assert.equal(f.focus.at(-1),f.document.querySelector('#appearance-font-picker>summary'));
 await f.search('no match');await f.key('#settings-search','Escape',{isComposing:true});assert.equal(f.document.querySelector('#settings-search').value,'no match');const event=await f.key('#settings-search','Escape');assert.equal(event.defaultPrevented,true);assert.deepEqual(visiblePanels(f),['appearance']);await f.search('telegram');await f.click('[data-settings-clear]');assert.equal(f.document.querySelector('#settings-search').value,'');assert.equal(f.focus.at(-1).id,'settings-search');
});

test('rapid switches load only the final category, and late failures after leaving settings cannot change it',async()=>{
 const f=fixture();await settle();f.ui.select('appearance');f.ui.select('telegram');await settle();assert.deepEqual(f.loads,['general','telegram']);let reject;f.handler=()=>new Promise((resolve,no)=>reject=no);f.ui.select('about');await settle();f.ui.sync(false);reject(Error('old category failed'));await settle();assert.deepEqual(f.errors,[]);assert.equal(f.ui.isVisible('about'),false);f.handler=async()=>{throw Error('current category failed');};f.ui.sync(true);await settle();assert.equal(f.errors.length,1);
});

test('deep links select their category and focus a real card, with safe fallback for absent or disabled controls',async()=>{
 const f=fixture();f.ui.sync(false);assert.equal(f.ui.select('unknown'),false);f.ui.select('voice','.settings-section');assert.equal(f.ui.category,'voice');f.ui.sync(true);f.render();await settle();assert.equal(f.ui.isVisible('voice'),true);assert.equal(f.focus.at(-1).closest('[data-settings-panel]').dataset.settingsPanel,'voice');
 f.disableVoice();f.ui.select('voice','#nativeVoice');assert.equal(f.focus.at(-1).classList.contains('settings-section'),true);f.ui.select('computer','#missing-control');assert.equal(f.focus.at(-1).dataset.settingsPanel,'computer');
});
