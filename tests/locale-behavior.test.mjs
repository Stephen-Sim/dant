import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {languages,isLanguage,normalizeLanguage,languageInfo} from '../src/languages.mjs';
import {registerLocale,translate,localizeMessages,translateCount} from '../src/i18n.mjs';
import {loadLanguage} from '../ui/localization.js';
import {telegramDeliveryNotice} from '../ui/telegram-delivery.js';
import {trayStatus} from '../ui/native-tray.js';
import {createNativeCallOverlay} from '../ui/native-call-overlay.js';
import {SpeechHelper} from '../ui/speech.js';
import {workProgress} from '../ui/work-progress.js';
import {renderUsageActivity} from '../ui/usage-activity.js';
import {createSchedules} from '../ui/schedules.js';
import {sourceDeclaration,sourceSection,sourceSelectorBinding} from './source-fixtures.mjs';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const codes=languages.map(item=>item.code);
const readCatalog=code=>JSON.parse(fs.readFileSync(new URL(`../src/locales/${code}.json`,import.meta.url),'utf8'));
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

function mainFixture(){
 const {document}=parseHTML('<html><body><div id="app"></div></body></html>'),stored=new Map(),requests=[],errors=[];
 const empty=()=>'',noop=()=>{},same=value=>value;
 const context={document,app:document.querySelector('#app'),languages,isLanguage,normalizeLanguage,languageInfo,translate,loadLanguage,Intl,Date,
  fallbackLanguage:'en',pendingActions:new Set(),state:{settings:{language:'en',notifications:false,vm:{}},worker:{status:'online',models:[]},messages:[{id:'user',role:'user',text:'Language',status:'completed',time:1000}],memory:'Language'},
  localStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)},
  api:async(route,options)=>{requests.push({route,...options});return {ok:true};},toast:error=>errors.push(error),
  esc:escape,ico:empty,button:empty,renderAppearance:empty,renderVoiceSettings:empty,renderVMSettings:empty,renderLoginDetails:empty,renderUsageSettings:empty,renderTelegramSettings:empty,
  textEditor:{renderSettings:empty},usageActivity:{state:{}},provisionDraft:{adminSudo:false},managedSettings:{renderCredentials:empty,syncModal:same},filePreview:{syncModal:same},
  chatHistory:{renderSettings:empty,renderActions:empty,renderEdited:empty},settingsNavigation:{sync:noop,isVisible:()=>false,render:sections=>sections.general},
  memorySettings:{setVisible:noop},workDisclosures:{capture:noop},appUpdates:{setVisible:noop,render:empty},appearance:{sync:noop},chatScroll:{capture:noop,restore:noop},
  modal:null,page:'settings',eventConnected:true,humanControl:()=>false,composerDraft:'Language',updateInstalling:false,renderRail:empty,renderHeader:empty,renderModal:empty,
  reconcile:(app,fragment)=>app.replaceChildren(fragment.cloneNode(true)),bind:noop,resizeComposer:noop,floatingCall:{sync:noop},nativeTray:{sync:noop},
  pc:null,callId:null,callStarting:false,callStops:{pending:false},callDuration:{snapshot:{}},showComputer:false,chatMode:'text',publishCallOverlay:noop,positionReactionMenus:noop,updateRead:noop,restartScreen:noop,
  emojiFor:null,defaultReactions:[],taskReplies:{renderMessageReference:empty},renderAttachments:empty,md:escape,renderAssistantReadState:empty,
  fileURL:file=>'/fixture/'+file.id,canPreviewFile:()=>true,
 };
 vm.createContext(context);
 vm.runInContext([
  sourceSection(source,'const zh={','const subscriptionVoiceUnavailable='),
  ...['function renderSettings','function render','function messageDate','function formatTime','function renderMessages','function renderAttachment'].map(marker=>sourceDeclaration(source,marker)),
 ].join('\n'),context);
 return {context,stored,requests,errors,document};
}

test('the 16 registered choices have complete matching catalogs and intact placeholders',async()=>{
 assert.deepEqual(codes,['en','zh','zh-TW','ja','ko','es','fr','de','pt','ru','ar','hi','id','ms','it','tr']);
 const expected=Object.keys(readCatalog('es')).sort();assert.ok(expected.length>=914);
 for(const code of codes.filter(code=>!['en','zh'].includes(code))){
  const catalog=readCatalog(code);assert.deepEqual(Object.keys(catalog).sort(),expected,code);
  for(const [english,value]of Object.entries(catalog)){
   assert.equal(typeof value,'string');assert.ok(value.trim(),code+' '+english);
   for(const placeholder of english.match(/\{[^{}]+\}/g)||[])assert.ok(value.includes(placeholder),code+' '+english);
  }
  await loadLanguage(code);assert.equal(translate(code,'Language'),catalog.Language);assert.notEqual(translate(code,'Language'),'Language');
 }
 for(const code of codes){assert.ok(isLanguage(code));assert.equal(normalizeLanguage(code),code);assert.ok(languageInfo(code).speech);}
 assert.equal(languageInfo('ar').direction,'rtl');assert.equal(isLanguage('private text'),false);
});

test('catalog registration updates nested application dictionaries without touching reference objects',()=>{
 const real=readCatalog('fr'),dictionary={en:{label:'Language',nested:{label:'Settings'},items:['Language']},zh:{label:'语言'}},before=structuredClone(dictionary);
 try{
  registerLocale('fr',{Language:'Langue test',Settings:'Paramètres test'});
  assert.deepEqual(localizeMessages(dictionary,'fr'),{label:'Langue test',nested:{label:'Paramètres test'},items:['Langue test']});
  registerLocale('fr',{Language:'Langue actuelle',Settings:'Paramètres actuels'});
  assert.equal(localizeMessages(dictionary,'fr').label,'Langue actuelle');assert.deepEqual(dictionary,before);
  assert.throws(()=>registerLocale('xx',{}),/Invalid language/);assert.throws(()=>registerLocale('fr',{Language:''}),/Invalid language/);
 }finally{registerLocale('fr',real);}
});

test('the actual main language combobox saves all choices and renders native labels, metadata and locale dates',async()=>{
 const f=mainFixture();
 for(const item of languages){
  await f.context.changeLanguage(item.code);
  const select=f.document.querySelector('select[data-language]');assert.ok(select);assert.equal(select.getAttribute('aria-label'),translate(item.code,'Language','语言'));
  assert.equal(select.querySelectorAll('option').length,16);assert.equal(select.querySelector('option[selected]').value,item.code);
  assert.deepEqual([...select.querySelectorAll('option')].map(option=>option.textContent),languages.map(language=>language.label));
  assert.equal(f.document.documentElement.lang,item.locale);assert.equal(f.document.documentElement.dir,item.direction);
  assert.equal(f.stored.get('dant.language'),item.code);assert.equal(f.context.state.settings.language,item.code);
  assert.equal(f.requests.at(-1).body.language,item.code);assert.equal(f.context.pendingActions.size,0);
 }
 for(const code of ['fr','ja']){
  await f.context.changeLanguage(code);const at=Date.UTC(2026,9,19,8,15);
  assert.equal(f.context.formatTime(at,true),new Intl.DateTimeFormat(languageInfo(code).locale,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(at)));
 }
 await f.context.changeLanguage('ar');
 assert.equal(f.context.state.messages[0].text,'Language');assert.equal(f.context.state.memory,'Language');assert.equal(f.context.composerDraft,'Language');
 const messages=parseHTML('<body>'+f.context.renderMessages()+'</body>').document;assert.equal(messages.querySelector('.markdown').textContent,'Language');
 const file=parseHTML('<body>'+f.context.renderAttachment({id:'file',name:'Language',type:'text/plain',size:100})+'</body>').document;
 assert.equal(file.querySelector('.file-attachment-name').textContent,'Language');
});

test('the actual change handler retains the chosen preference and draft when a save fails',async()=>{
 const f=mainFixture();f.context.render();f.stored.set('dant.language','en');
 let finish;f.context.api=()=>new Promise((_resolve,reject)=>{finish=reject;});
 vm.runInContext(sourceSelectorBinding(source,'select[data-language]'),f.context);
 const select=f.document.querySelector('select[data-language]');select.querySelector('[selected]').removeAttribute('selected');select.querySelector('[value=fr]').setAttribute('selected','');
 const sending=select.onchange();await settle();assert.ok(f.context.pendingActions.has('setting:language'));
 assert.equal(f.document.querySelector('select[data-language]').hasAttribute('disabled'),true);
 finish(Error('synthetic save failure'));await sending;
 assert.equal(f.stored.get('dant.language'),'en');assert.equal(f.context.state.settings.language,'en');assert.equal(f.context.fallbackLanguage,'en');
 assert.equal(f.context.pendingActions.size,0);assert.equal(f.context.composerDraft,'Language');assert.equal(f.errors.length,1);
 const before=f.requests.length;await f.context.changeLanguage('unknown');assert.equal(f.requests.length,before);
});

test('Telegram issue summaries use real locale strings and numbers without mutating delivery records',async()=>{
 const status={enabled:true,configured:true,connected:true,paired:true,delivery:{unknown:1234,failed:1,lastIssue:{status:'unknown',at:1000,reason:'timeout'}}},before=structuredClone(status);
 for(const item of languages){await loadLanguage(item.code);const notice=telegramDeliveryNotice(status,{language:item.code});
  assert.ok(notice.summary.includes(new Intl.NumberFormat(item.locale).format(1234)));
  if(!['en','zh'].includes(item.code)){assert.ok(notice.latest.includes(readCatalog(item.code)['Request timed out']));assert.ok(notice.hint.includes(readCatalog(item.code)['Check Telegram to see whether these messages arrived before sending again, to avoid duplicates. They will not be resent automatically.']));}
 }
 assert.deepEqual(status,before);
});

test('native adapters retain each supported language and only emit bounded call metadata',async()=>{
 for(const code of codes){
  assert.equal(trayStatus({settings:{language:code}}).language,code);
  const calls=[],bridge=createNativeCallOverlay({desktop:true,loadCore:async()=>({invoke:async(command,args)=>calls.push({command,args})}),loadEvents:async()=>({listen:async()=>()=>{}})});
  bridge.update({callId:'call',status:'talking',language:code,theme:'light',seconds:1,privateText:'Language'});await settle();await settle();
  assert.equal(calls[0].args.state.language,code);assert.equal(JSON.stringify(calls).includes('privateText'),false);bridge.dispose();await settle();
 }
});

test('browser speech uses each shared BCP47 locale and preserves spoken and recognized user text',async()=>{
 for(const item of languages){
  let recognition,utterance;
  class Recognizer{constructor(){recognition=this;}start(){queueMicrotask(()=>{this.onresult({results:[Object.assign([{transcript:'Language'}],{isFinal:true})]});this.onend();});}}
  class Utterance{constructor(text){this.text=text;}}
  const matching={name:'fixture',lang:item.speech},helper=new SpeechHelper({desktop:false,recognizer:Recognizer,Utterance,synthesis:{cancel(){},getVoices:()=>[matching],speak:value=>{utterance=value;queueMicrotask(()=>value.onend());}}});
  assert.equal(await helper.dictate(item.code),'Language');assert.equal(recognition.lang,item.speech);
  await helper.speak('Language',item.code);assert.equal(utterance.lang,item.speech);assert.equal(utterance.text,'Language');assert.equal(utterance.voice,matching);
 }
});

test('missing native speech languages report translated guidance without retries or private errors',async()=>{
 for(const code of codes){await loadLanguage(code);const calls=[],helper=new SpeechHelper({desktop:true,invoke:async(command,args)=>{calls.push({command,args});if(command==='speech_start')throw Object.assign(Error('private device details'),{code:'speech-language-unavailable'});}});
  await assert.rejects(helper.speak('Language',code),error=>error.code==='speech-language-unavailable'&&error.message===translate(code,'The selected speech language is not installed. Add it in Windows Speech settings.','尚未安装所选语音语言，请在 Windows 语音设置中添加。'));
  assert.deepEqual(calls.map(call=>call.command),['speech_stop','speech_start']);assert.equal(calls[1].args.language,code);
 }
});

test('usage streaks, work badges and schedule counts translate their dynamic text and preserve user task names',async()=>{
 const now=Date.UTC(2026,9,19,12),at=now+86400000,usage={activity:{timeZone:'UTC',recordedSince:now,days:[{date:'2026-10-18',subscription:{inputTokens:1,outputTokens:0}},{date:'2026-10-19',subscription:{inputTokens:1,outputTokens:0}}]}};
 for(const code of codes.filter(code=>!['en','zh'].includes(code))){
  await loadLanguage(code);const catalog=readCatalog(code),number=new Intl.NumberFormat(languageInfo(code).locale).format(2);
  const chart=parseHTML('<body>'+renderUsageActivity({usage,language:code,now})+'</body>').document;
  assert.equal(chart.querySelector('[data-usage-stat=longest]').textContent,catalog['{count} days'].replace('{count}',number));
  const model=workProgress({messages:[],workTasks:[],worker:{status:'online'}},{language:code});
  assert.equal(model.labels.queuedCount(2),catalog['{count} queued'].replace('{count}',number));assert.equal(model.labels.reviewCount(2),catalog['{count} awaiting review'].replace('{count}',number));
  const state={settings:{language:code,vm:{}},worker:{status:'online'},schedules:[{id:'one',text:'Language',status:'pending',at,timeZone:'UTC'},{id:'two',text:'Settings',status:'pending',at,timeZone:'UTC'}]};
  const {document}=parseHTML('<body></body>');const schedules=createSchedules({getState:()=>state,document,now:()=>now,timeZone:()=>'UTC'});
  const page=parseHTML('<body>'+schedules.renderPage()+'</body>').document;
  assert.equal(page.querySelector('.skills-count').textContent,catalog['{count} tasks'].replace('{count}',number));
  assert.equal(page.querySelector('.schedule-card-text').textContent,'Language');assert.equal(page.querySelector('time').textContent,new Intl.DateTimeFormat(languageInfo(code).locale,{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(new Date(at)));
 }
 assert.equal(translateCount('fr',2,'{count} day','{count} days'), '2 jours');assert.equal(translateCount('ja',2,'{count} day','{count} days'),'2 日');
 for(const value of ['private text',-1,Infinity,NaN])assert.throws(()=>translateCount('fr',value,'{count} day','{count} days'),/Invalid localized count/);
});
