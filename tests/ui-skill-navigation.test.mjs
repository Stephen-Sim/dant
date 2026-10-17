import {bindAttachmentImages} from '../ui/attachment-images.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as lucide from 'lucide';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {createManagedSettings} from '../ui/managed-settings.js';
import {createCallDuration,formatCallDuration} from '../ui/call-duration.js';
import {createAppearance,appearanceDefaults} from '../ui/appearance.js';
import {formatPresence} from '../ui/presence.js';
import {workProgress,renderWorkEntry} from '../ui/work-progress.js';
import {createUpdates} from '../ui/updates.js';
import {createSettingsNavigation} from '../ui/settings-navigation.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
function fixture({language='en',online=true,live=false}={}){
 const {document,Event}=parseHTML('<!doctype html><html><body><div id="app"></div></body></html>'),requests=[],updateRequests=[],toasts=[],timers=new Map();let nextTimer=0;
 const peer={connectionState:'connected',close(){throw Error('Navigation must preserve the peer');}},stream={getTracks:()=>[{stop(){throw Error('Navigation must preserve media');}}]},audio={play:async()=>{},pause(){throw Error('Navigation must preserve audio');}},call={id:'same-call',provider:'subscription',status:'connected',connectedAt:1000};
 const c={bindAttachmentImages,workProgress,renderWorkEntry,textEditor:{renderSettings:()=>'',bind(){},load:async()=>{},dispose(){}},nativeTray:{sync(){},dispose(){}},downloads:{bind(){}},filePreview:{bind(){},syncModal:value=>value},document,Event,window:{},app:document.querySelector('#app'),reconcile,icons:lucide,formatPresence,formatCallDuration,fallbackLanguage:language,state:{conversationId:'same-vm',settings:{...appearanceDefaults,language,vm:{host:'vm.test',port:22,user:'dant'}},worker:{status:online?'online':'offline',models:[]},controller:{status:online?'online':'offline'},messages:[],queue:[],active:null,call:live?call:null,credentials:{items:[],requests:[]},skills:{items:[{name:'computer-check',description:'Inspect the computer',path:'.agents/skills/computer-check',enabled:true}]}},vmDraft:null,eventConnected:online,page:'chat',modal:null,emojiFor:null,showComputer:false,chatMode:live?'voice':'text',callMini:false,callMuted:false,callConnected:live,callStarting:false,callStops:{pending:false},callChannel:{readyState:'open'},pc:live?peer:null,stream:live?stream:null,audio:live?audio:null,callId:live?call.id:null,callProvider:'subscription',composerDraft:'Keep my draft',attachmentMenu:false,dictating:false,speakingId:null,pendingActions:new Set(),localStorage:{setItem(){}},chatHistory:{onClose(){},bind(){},bindModal(){},renderSettings:()=>''},toast:message=>toasts.push(message),errorText:error=>error.message||String(error),humanControl:()=>false,resizeComposer(){},positionReactionMenus(){},updateRead(){},restartScreen(){},bindSteer(){},bindProvision(){},bindVoiceKey(){},bindTelegram(){},bindAppearance(){},bindVMSettings(){},bindComputerInput(){},clearTelegramPairing(){},loadTelegram:async()=>{},loadFonts:async()=>{},loadVoices:async()=>{},renderAppearance:()=>'',renderVoiceSettings:()=>'',renderVMSettings:()=>'',renderLoginDetails:()=>'',renderTelegramSettings:()=>'',renderMemory:()=>'',renderSchedules:()=>'',renderCallReady:()=>'',renderComputer:()=>'',eyes:()=>'<i class="call-avatar"></i>'};
 c.createElement=definition=>{const previous=globalThis.document;globalThis.document=document;try{return lucide.createElement(definition);}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}};
 c.appearance=createAppearance({document,storage:null,matchMedia:()=>null});c.floatingCall={sync(){}};c.nativeCallOverlay={update(){}};
 c.callDuration=createCallDuration({now:()=>18000,schedule:fn=>{timers.set(++nextTimer,fn);return nextTimer;},cancel:id=>timers.delete(id)});if(live)c.callDuration.start(call.id,call.connectedAt);
 c.renderChat=()=>`<div id="messages"></div><textarea id="composer">${c.composerDraft}</textarea>`;
 c.openModal=next=>{c.modal=next;c.render();};c.closeModal=()=>{c.managedSettings.onClose(c.modal);c.modal=null;c.render();};
 c.managedSettings=createManagedSettings({getState:()=>c.state,getModal:()=>c.modal,document,connected:()=>c.eventConnected,render:()=>c.render(),toast:c.toast,openModal:c.openModal,closeModal:c.closeModal,request:async(route,options={})=>{requests.push({route,...options});if(route==='/skills')return structuredClone(c.state.skills);if(route==='/credentials')return structuredClone(c.state.credentials);throw Error('Unexpected request: '+route);}});
 c.renderModal=()=>c.managedSettings.renderModal(c.modal)||'';
 c.settingsNavigation=createSettingsNavigation({document,getLanguage:()=>c.state.settings.language,onChange:()=>c.render(),onCategory:category=>c.loadSettingsCategory(category),onError:error=>toasts.push(error.message)});
 c.appUpdates=createUpdates({version:'1.0.0',document,getLanguage:()=>c.state.settings.language,onChange:()=>{if(c.page==='settings')c.render();},request:async route=>{updateRequests.push(route);return route==='/version'?{version:'1.0.0'}:{currentVersion:'1.0.0',latestVersion:'1.1.0',updateAvailable:true,releaseUrl:'https://github.com/Stephen-Sim/dant/releases/tag/v1.1.0'};}});
 vm.createContext(c);vm.runInContext([
  part('const zh={','const subscriptionVoiceUnavailable='),part('const esc=','const eyes='),part('function render(){','function renderChat(){'),part('function renderSettings(){','const appearanceFields='),part('function renderCall(){','function renderUnconfirmedMessage(){'),part('function bind(){','async function taskRequest('),part('async function action(a){','async function checkUnconfirmedMessage(){'),
 ].join('\n'),c);c.render();
 return {c,document,requests,updateRequests,toasts,peer,stream,audio,call,timers,async click(selector){const node=document.querySelector(selector);assert.ok(node,selector);node.dispatchEvent(new Event('click',{bubbles:true}));await settle();assert.deepEqual(toasts,[]);}};
}

test('the sidebar skill entry opens its own bilingual page and loads only skills',async()=>{
 for(const language of ['zh','en']){
  const f=fixture({language}),entry=f.document.querySelector('.rail .rail-skills');assert.ok(entry.querySelector('svg').childNodes.length);assert.equal(entry.getAttribute('aria-label'),language==='zh'?'技能':'Skills');assert.equal(entry.previousElementSibling.dataset.action,'chat');
  await f.click('.rail [data-action="skills"]');assert.equal(f.c.page,'skills');assert.equal(f.document.querySelector('.app-header h1').textContent,language==='zh'?'技能':'Skills');assert.equal(f.document.querySelector('.rail-skills').getAttribute('aria-current'),'page');assert.ok(f.document.querySelector('.skills-full-page [data-skill-edit="computer-check"]'));assert.equal(f.document.querySelector('.settings-stack'),null);assert.deepEqual(f.requests.map(item=>item.route),['/skills']);assert.ok(f.document.querySelector('#file-input'));
  await f.click('.rail [data-action="settings"]');assert.ok(f.document.querySelector('.credentials-settings'));assert.equal(f.document.querySelector('[data-skill-add]'),null,'settings must not duplicate the independent skills page');f.c.callDuration.dispose();
 }
});

test('opening skills and returning to chat preserves draft, live media and elapsed call time',async()=>{
 const f=fixture({live:true}),clock=f.c.callDuration;f.document.querySelector('#composer').value='Unsent message';
 await f.click('.rail [data-action="skills"]');assert.equal(f.c.composerDraft,'Unsent message');assert.ok(f.document.querySelector('.header-actions [data-action="hangup"]'));assert.equal(f.c.pc,f.peer);assert.equal(f.c.stream,f.stream);assert.equal(f.c.audio,f.audio);assert.equal(f.c.state.call,f.call);assert.equal(clock.snapshot.seconds,17);assert.equal(f.timers.size,1);
 await f.click('.rail [data-action="chat"]');assert.equal(f.c.page,'chat');assert.equal(f.document.querySelector('#composer').value,'Unsent message');assert.equal(f.c.callMini,true);assert.equal(f.document.querySelector('.call-view').classList.contains('mini'),true);assert.equal(f.c.pc,f.peer);assert.equal(f.c.callId,f.call.id);assert.equal(f.c.callDuration,clock);assert.equal(clock.snapshot.running,true);assert.equal(f.timers.size,1);assert.deepEqual(f.requests.map(item=>item.route),['/skills']);clock.dispose();
});

test('offline navigation keeps cached skills visible and never starts a request or task',async()=>{
 const f=fixture({online:false});await f.click('.rail [data-action="skills"]');assert.equal(f.c.page,'skills');assert.match(f.document.querySelector('.skills-full-page').textContent,/computer-check/);assert.equal(f.document.querySelector('[data-skill-add]').disabled,true);assert.equal(f.document.querySelector('[data-skill-toggle]').disabled,true);assert.deepEqual(f.requests,[]);f.c.callDuration.dispose();
});

test('skill path disclosures survive status refresh and filtering until that card is explicitly closed',async()=>{
 const f=fixture({live:true});f.c.state.skills.items.push({name:'browser-check',description:'Inspect the browser',path:'.agents/skills/browser-check',enabled:true});await f.click('.rail [data-action="skills"]');const details=name=>f.document.querySelector('[data-key="skill-card-'+name+'"] .skill-card-path'),toggle=(node,open)=>{node.toggleAttribute('open',open);node.dispatchEvent(new f.c.Event('toggle'));};
 const computer=details('computer-check');toggle(computer,true);for(let n=0;n<3;n++){f.c.state={...f.c.state,worker:{...f.c.state.worker,status:n===1?'connecting':'online'}};f.c.render();assert.equal(details('computer-check').hasAttribute('open'),true,'status refresh must preserve the chosen open state');assert.equal(details('browser-check').hasAttribute('open'),false);}
 const search=f.document.querySelector('#skills-search');search.value='browser';search.dispatchEvent(new f.c.Event('input',{bubbles:true}));assert.equal(details('computer-check'),null);assert.equal(computer.isConnected,false);toggle(computer,false);search.value='';search.dispatchEvent(new f.c.Event('input',{bubbles:true}));assert.equal(details('computer-check').hasAttribute('open'),true,'a detached toggle from reconciliation cannot collapse the saved card');assert.equal(f.document.querySelector('#skills-search'),search);assert.equal(search.value,'');
 toggle(details('browser-check'),true);toggle(details('computer-check'),false);f.c.render();assert.equal(details('computer-check').hasAttribute('open'),false);assert.equal(details('browser-check').hasAttribute('open'),true,'closing one card must not change another card');await f.click('.rail [data-action="chat"]');assert.equal(f.document.querySelector('#composer').value,'Keep my draft');await f.click('.rail [data-action="skills"]');assert.equal(details('computer-check').hasAttribute('open'),false);assert.equal(details('browser-check').hasAttribute('open'),true);assert.equal(f.c.pc,f.peer);assert.equal(f.c.stream,f.stream);assert.equal(f.c.callDuration.snapshot.seconds,17);f.c.callDuration.dispose();
});

test('a rapid refresh preserves the live disclosure state and a different work computer starts collapsed',async()=>{
 const f=fixture();await f.click('.rail [data-action="skills"]');const selector='[data-key="skill-card-computer-check"] .skill-card-path',details=f.document.querySelector(selector);details.setAttribute('open','');f.c.render();assert.equal(f.document.querySelector(selector).hasAttribute('open'),true,'refresh before the browser toggle event must preserve the live user choice');f.c.state={...f.c.state,conversationId:'different-computer'};f.c.render();assert.equal(f.document.querySelector(selector).hasAttribute('open'),false);details.dispatchEvent(new f.c.Event('toggle'));f.c.render();assert.equal(f.document.querySelector(selector).hasAttribute('open'),false);f.c.callDuration.dispose();
});


test('settings version and manual update checks preserve a live call and typed draft independently of the VM',async()=>{
 const f=fixture({live:true,online:false});
 f.document.querySelector('#composer').value='Preserve this unsent message';
 await f.click('.rail [data-action="settings"]');
 assert.deepEqual(f.updateRequests,[]);await f.click('[data-settings-category="about"]');
 assert.equal(f.document.querySelector('[data-app-version]').textContent,'1.0.0');
 assert.deepEqual(f.updateRequests,['/version']);
 assert.equal(f.document.querySelector('[data-check-updates]').disabled,false);
 await f.click('[data-check-updates]');
 assert.deepEqual(f.updateRequests,['/version','/updates']);
 assert.equal(f.document.querySelector('[data-update-release]').href,'https://github.com/Stephen-Sim/dant/releases/tag/v1.1.0');
 assert.equal(f.c.pc,f.peer);assert.equal(f.c.state.call,f.call);assert.equal(f.timers.size,1);
 await f.click('.rail [data-action="chat"]');
 assert.equal(f.document.querySelector('#composer').value,'Preserve this unsent message');
 assert.equal(f.c.pc,f.peer);assert.equal(f.c.stream,f.stream);assert.equal(f.c.audio,f.audio);assert.equal(f.c.callId,f.call.id);
 assert.equal(f.c.callDuration.snapshot.seconds,17);assert.deepEqual(f.requests,[]);f.c.callDuration.dispose();
});

test('settings categories and search deep links keep call media and drafts, and About alone loads app version',async()=>{
 const f=fixture({live:true,online:false});f.document.querySelector('#composer').value='Keep this draft through settings search';
 await f.c.action('voice-settings');await settle();assert.equal(f.c.page,'settings');assert.equal(f.c.settingsNavigation.category,'voice');assert.equal(f.document.querySelector('[data-settings-panel="voice"]').hidden,false);assert.deepEqual(f.updateRequests,[]);
 await f.click('[data-settings-category="general"]');const search=f.document.querySelector('#settings-search');search.value='更新';search.dispatchEvent(new f.c.Event('input',{bubbles:true}));await settle();assert.ok(f.document.querySelector('[data-settings-result="updates"]'));assert.deepEqual(f.updateRequests,[]);
 await f.click('[data-settings-result="updates"]');assert.equal(f.c.settingsNavigation.category,'about');assert.equal(f.document.querySelector('[data-settings-panel="about"]').hidden,false);assert.deepEqual(f.updateRequests,['/version']);
 await f.click('[data-settings-category="computer"]');assert.equal(f.document.querySelector('[data-settings-panel="about"]').hidden,true);assert.deepEqual(f.updateRequests,['/version']);assert.equal(f.c.pc,f.peer);assert.equal(f.c.stream,f.stream);assert.equal(f.c.audio,f.audio);assert.equal(f.c.callDuration.snapshot.seconds,17);
 await f.click('.rail [data-action="chat"]');assert.equal(f.document.querySelector('#composer').value,'Keep this draft through settings search');assert.equal(f.c.callId,f.call.id);assert.equal(f.c.state.call,f.call);assert.deepEqual(f.requests,[]);f.c.callDuration.dispose();
});
