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

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
function fixture({language='en',online=true,live=false}={}){
 const {document,Event}=parseHTML('<!doctype html><html><body><div id="app"></div></body></html>'),requests=[],toasts=[],timers=new Map();let nextTimer=0;
 const peer={connectionState:'connected',close(){throw Error('Navigation must preserve the peer');}},stream={getTracks:()=>[{stop(){throw Error('Navigation must preserve media');}}]},audio={play:async()=>{},pause(){throw Error('Navigation must preserve audio');}},call={id:'same-call',provider:'subscription',status:'connected',connectedAt:1000};
 const c={document,Event,window:{},app:document.querySelector('#app'),reconcile,icons:lucide,formatPresence,formatCallDuration,fallbackLanguage:language,state:{conversationId:'same-vm',settings:{...appearanceDefaults,language,vm:{host:'vm.test',port:22,user:'dant'}},worker:{status:online?'online':'offline',models:[]},controller:{status:online?'online':'offline'},messages:[],queue:[],active:null,call:live?call:null,credentials:{items:[],requests:[]},skills:{items:[{name:'computer-check',description:'Inspect the computer',path:'.agents/skills/computer-check',enabled:true}]}},vmDraft:null,eventConnected:online,page:'chat',modal:null,emojiFor:null,showComputer:false,chatMode:live?'voice':'text',callMini:false,callMuted:false,callConnected:live,callStarting:false,callStops:{pending:false},callChannel:{readyState:'open'},pc:live?peer:null,stream:live?stream:null,audio:live?audio:null,callId:live?call.id:null,callProvider:'subscription',composerDraft:'Keep my draft',attachmentMenu:false,dictating:false,speakingId:null,pendingActions:new Set(),localStorage:{setItem(){}},chatHistory:{onClose(){},bind(){},bindModal(){},renderSettings:()=>''},toast:message=>toasts.push(message),errorText:error=>error.message||String(error),humanControl:()=>false,resizeComposer(){},positionReactionMenus(){},updateRead(){},restartScreen(){},bindSteer(){},bindProvision(){},bindVoiceKey(){},bindTelegram(){},bindAppearance(){},bindVMSettings(){},bindComputerInput(){},clearTelegramPairing(){},loadTelegram:async()=>{},loadFonts:async()=>{},renderAppearance:()=>'',renderVoiceSettings:()=>'',renderVMSettings:()=>'',renderLoginDetails:()=>'',renderTelegramSettings:()=>'',renderMemory:()=>'',renderSchedules:()=>'',renderCallReady:()=>'',renderComputer:()=>'',eyes:()=>'<i class="call-avatar"></i>'};
 c.createElement=definition=>{const previous=globalThis.document;globalThis.document=document;try{return lucide.createElement(definition);}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}};
 c.appearance=createAppearance({document,storage:null,matchMedia:()=>null});
 c.callDuration=createCallDuration({now:()=>18000,schedule:fn=>{timers.set(++nextTimer,fn);return nextTimer;},cancel:id=>timers.delete(id)});if(live)c.callDuration.start(call.id,call.connectedAt);
 c.renderChat=()=>`<div id="messages"></div><textarea id="composer">${c.composerDraft}</textarea>`;
 c.openModal=next=>{c.modal=next;c.render();};c.closeModal=()=>{c.managedSettings.onClose(c.modal);c.modal=null;c.render();};
 c.managedSettings=createManagedSettings({getState:()=>c.state,getModal:()=>c.modal,document,connected:()=>c.eventConnected,render:()=>c.render(),toast:c.toast,openModal:c.openModal,closeModal:c.closeModal,request:async(route,options={})=>{requests.push({route,...options});if(route==='/skills')return structuredClone(c.state.skills);if(route==='/credentials')return structuredClone(c.state.credentials);throw Error('Unexpected request: '+route);}});
 c.renderModal=()=>c.managedSettings.renderModal(c.modal)||'';
 vm.createContext(c);vm.runInContext([
  part('const zh={','const subscriptionVoiceUnavailable='),part('const esc=','const eyes='),part('function render(){','function renderChat(){'),part('function renderSettings(){','const appearanceFields='),part('function renderCall(){','function renderUnconfirmedMessage(){'),part('function bind(){','async function taskRequest('),part('async function action(a){','async function checkUnconfirmedMessage(){'),
 ].join('\n'),c);c.render();
 return {c,document,requests,toasts,peer,stream,audio,call,timers,async click(selector){const node=document.querySelector(selector);assert.ok(node,selector);node.dispatchEvent(new Event('click',{bubbles:true}));await settle();assert.deepEqual(toasts,[]);}};
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
