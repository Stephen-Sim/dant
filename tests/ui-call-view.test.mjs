import {bindAttachmentImages} from '../ui/attachment-images.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as lucide from 'lucide';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {createCallDuration,formatCallDuration} from '../ui/call-duration.js';
import {createAppearance,appearanceDefaults} from '../ui/appearance.js';
import {createWorkDisclosures} from '../ui/work-disclosures.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');
const part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(language='en',theme='light'){
 const {document,Event}=parseHTML('<!doctype html><html><body><main id="app"></main></body></html>'),app=document.querySelector('#app'),intervals=new Map(),requests=[];let now=18000,nextTimer=0;
 const peer={connectionState:'connected',close(){throw Error('View changes must not close the peer');}},track={stop(){throw Error('View changes must not stop media');}},stream={getTracks:()=>[track]},audio={play:async()=>{},pause(){throw Error('View changes must not pause audio');}},call={id:'live-call',provider:'subscription',status:'connected',connectedAt:1000};
 const c={bindAttachmentImages,downloads:{bind(){}},filePreview:{bind(){},syncModal:value=>value},modal:null,managedSettings:{renderRequests:()=>'',renderCredentials:()=>'',renderSkills:()=>'',renderModal:()=>null,bind(){},load:async()=>{},onClose(){}},chatHistory:{renderActions:()=>'',renderEdited:()=>'',renderSettings:()=>'',renderModal:()=>null,bind(){},bindModal(){},onClose(){}},document,Event,window:{},icons:lucide,formatCallDuration,esc:value=>String(value??''),eyes:()=>'<i class="call-avatar"></i>',fallbackLanguage:language,state:{settings:{...appearanceDefaults,theme,language},call,messages:[]},eventConnected:true,pc:peer,stream,audio,callId:call.id,callConnected:true,callStarting:false,callChannel:{readyState:'open'},callMini:false,callMuted:false,callProvider:'subscription',callStops:{pending:false},page:'chat',chatMode:'voice',pendingActions:new Set(),render(){},toast(message){throw Error(message);},bindSteer(){},bindProvision(){},bindVoiceKey(){},bindTelegram(){},bindAppearance(){},bindVMSettings(){},bindComputerInput(){}};
 c.progressActions={bind(){},renderConfirmation:()=>'',onClose(){},busy:false};
 c.workDisclosures=createWorkDisclosures({getState:()=>c.state,document});
 c.createElement=definition=>{const previous=globalThis.document;globalThis.document=document;try{return lucide.createElement(definition);}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}};
 c.callDuration=createCallDuration({now:()=>now,schedule:fn=>{intervals.set(++nextTimer,fn);return nextTimer;},cancel:id=>intervals.delete(id)});c.callDuration.start(call.id,call.connectedAt);
 c.appearance=createAppearance({document,storage:null,matchMedia:()=>null});c.appearance.sync(c.state.settings);c.post=async(route,body)=>{requests.push({route,body});throw Error('View changes must not send an API request');};
 c.updateInstalling=false;c.chatScroll??={capture(){},restore(){},dispose(){},navigate:action=>action()};c.memorySettings??={setVisible(){},render:()=>'',bind(){},dispose(){}};vm.createContext(c);vm.runInContext(part('const zh={','const subscriptionVoiceUnavailable=')+'\n'+part('const iconCache=','const eyes=')+'\n'+part('function renderCall(){','function renderUnconfirmedMessage(){')+'\n'+part('function bind(){','async function taskRequest(')+'\n'+part('async function action(a){','async function checkUnconfirmedMessage(){')+'\nglobalThis.renderIcon=ico;',c);
 c.render=()=>{const template=document.createElement('template');template.innerHTML=c.renderCall()+'<input id="file-input" type="file" hidden>';reconcile(app,template.content);c.bind();};c.render();
 return {c,document,requests,intervals,peer,stream,audio,call,async click(node){node.dispatchEvent(new Event('pointerdown',{bubbles:true}));node.dispatchEvent(new Event('pointerup',{bubbles:true}));node.dispatchEvent(new Event('click',{bubbles:true}));await settle();},advance(ms){now+=ms;for(const fn of intervals.values())fn();}};
}

test('numeric Lucide icon names render their real SVG paths instead of empty buttons',()=>{
 const {c,document}=fixture();for(const name of ['minimize-2','maximize-2','volume-2']){const template=document.createElement('template');template.innerHTML=c.renderIcon(name);assert.ok(template.content.querySelector('svg'),name+' must produce an SVG');assert.ok(template.content.querySelector('svg').childNodes.length>0);}
});

test('icon-only minimize and expand controls preserve the live call through real bubbling button events',async()=>{
 for(const [language,theme,minimize,expand]of [['zh','light','缩小到聊天','展开通话'],['en','dark','Minimize to chat','Expand call']]){
  const f=fixture(language,theme),button=f.document.querySelector('.call-top [data-action="call-size"]'),clock=f.c.callDuration;
  assert.equal(button.textContent.trim(),'');assert.equal(button.querySelector('span'),null);assert.equal(button.type,'button');assert.equal(button.title,minimize);assert.equal(button.getAttribute('aria-label'),minimize);assert.ok(button.querySelector('svg'));assert.equal(button.hidden,false);assert.equal(button.disabled,false);assert.equal(button.classList.contains('icon-btn'),true);assert.equal(button.classList.contains('call-size-toggle'),true);assert.equal(f.document.documentElement.dataset.theme,theme);
  const foreground=f.document.documentElement.style.getPropertyValue('--appearance-foreground'),background=f.document.documentElement.style.getPropertyValue('--appearance-background');assert.notEqual(foreground,background);
  await f.click(button);assert.equal(f.c.callMini,true);assert.equal(f.c.chatMode,'text');assert.equal(f.c.pc,f.peer);assert.equal(f.c.stream,f.stream);assert.equal(f.c.audio,f.audio);assert.equal(f.c.state.call,f.call);assert.equal(f.c.callId,'live-call');assert.equal(f.c.callDuration,clock);assert.equal(f.intervals.size,1);assert.equal(clock.snapshot.seconds,17);assert.equal(f.requests.length,0);assert.equal(f.document.querySelector('.call-view').classList.contains('mini'),true);
  const restoring=f.document.querySelector('.call-top [data-action="call-size"]');assert.equal(restoring,button);assert.equal(restoring.textContent.trim(),'');assert.equal(restoring.querySelector('span'),null);assert.equal(restoring.title,expand);assert.equal(restoring.getAttribute('aria-label'),expand);assert.ok(restoring.querySelector('svg'));
  f.advance(1000);await f.click(restoring);assert.equal(f.c.callMini,false);assert.equal(f.c.chatMode,'voice');assert.equal(f.c.pc,f.peer);assert.equal(f.c.stream,f.stream);assert.equal(f.c.callId,'live-call');assert.equal(clock.snapshot.seconds,18);assert.equal(clock.snapshot.running,true);assert.equal(f.intervals.size,1);assert.equal(f.requests.length,0);clock.dispose();
 }
 const rule=css.match(/\.call-size-toggle\{([^}]+)\}/)?.[1]||'';assert.match(rule,/background:transparent/);assert.match(rule,/border:0/);assert.match(rule,/opacity:1/);assert.match(rule,/visibility:visible/);assert.match(css,/\.call-top\{[^}]*z-index:2/);
});

test('revealing a search result switches full-call layout to chat without changing the media session or clock',()=>{
 const f=fixture(),clock=f.c.callDuration;f.c.speechBlocked=()=>Boolean(f.c.pc||f.c.callStarting||f.c.state.call||f.c.callStops.pending);vm.runInContext(part('function revealMessage(){','function updatePresence(){'),f.c);assert.equal(f.c.callMini,false);assert.equal(f.c.chatMode,'voice');f.c.page='settings';f.c.revealMessage('search-target');assert.equal(f.c.page,'chat');assert.equal(f.c.chatMode,'text');assert.equal(f.c.callMini,true);assert.equal(f.document.querySelector('.call-view').classList.contains('mini'),true);assert.equal(f.c.pc,f.peer);assert.equal(f.c.stream,f.stream);assert.equal(f.c.audio,f.audio);assert.equal(f.c.state.call,f.call);assert.equal(f.c.callId,'live-call');assert.equal(f.c.callDuration,clock);assert.equal(clock.snapshot.seconds,17);assert.equal(f.intervals.size,1);assert.equal(f.requests.length,0);clock.dispose();
});
