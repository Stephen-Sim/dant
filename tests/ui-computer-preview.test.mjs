import {sourceIndex,sourceSection} from './source-fixtures.mjs';
import {languageContext} from './language-context.mjs';
import {createTaskReplyController} from '../ui/task-reply.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {bindAttachmentImages} from '../ui/attachment-images.js';
import {createWorkDisclosures} from '../ui/work-disclosures.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),part=(start,end)=>sourceSection(source,start,end),settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
function fixture(language='en'){
 const {document,Event}=parseHTML('<main id="app"></main>'),app=document.querySelector('#app'),requests=[],screens=[],toasts=[],intervals=new Map(),timeouts=new Map(),revoked=[],images=[];let sequence=0,screenSequence=0,wait=null,decode='ok';
 class FrameImage{constructor(){this.naturalWidth=1280;this.naturalHeight=960;images.push(this);}get src(){return this.value||'';}set src(value){this.value=value;if(value&&decode!=='pending')queueMicrotask(()=>decode==='error'?this.onerror?.():this.onload?.());}}
 document.hasFocus=()=>true;
 const c={downloads:{bind(){}},document,Event,window:{},AbortController,innerWidth:1440,base:'',token:'test',localStorage:{getItem:()=>null,setItem(){}},fallbackLanguage:language,state:{controller:{status:'online',cached:false},settings:{language,vm:{host:'192.0.2.10',user:'dant',port:22,keyPath:'C:/vm-key'}},worker:{status:'offline'},computer:{status:'agent',sessionId:'lease-1'},messages:[],call:null},eventConnected:true,unloading:false,page:'chat',chatMode:'text',showComputer:true,pc:null,callStarting:false,callStops:{pending:false},pendingActions:new Set(),screenURL:'blob:existing-frame',screenError:'',screenFailures:0,screenTimer:null,screenLoad:null,screenAbort:null,screenBusy:false,screenEpoch:0,vmDraft:null,voiceLoadedFor:'',modal:null,managedSettings:{bind(){}},chatHistory:{bind(){},bindModal(){}},icons:{},createElement:()=>({outerHTML:'<svg></svg>'}),toast:value=>toasts.push(value),bindSteer(){},bindProvision(){},bindVoiceKey(){},bindTelegram(){},bindAppearance(){},bindVMSettings(){},setInterval:(callback,ms)=>{assert.equal(ms,1200);intervals.set(++sequence,callback);return sequence;},clearInterval:id=>intervals.delete(id),setTimeout:(callback,ms)=>{timeouts.set(++sequence,{callback,ms});return sequence;},clearTimeout:id=>timeouts.delete(id),URL:{createObjectURL:()=>`blob:screen-${++screenSequence}`,revokeObjectURL:url=>revoked.push(url)}};
 c.progressActions={bind(){},renderConfirmation:()=>'',onClose(){},busy:false};
 c.workDisclosures=createWorkDisclosures({getState:()=>c.state,document});
 c.bindAttachmentImages=bindAttachmentImages;c.Image=FrameImage;c.fetch=async(url,options)=>{screens.push({url,options});if(wait)await wait();return {ok:true,blob:async()=>({type:'image/png'})};};c.post=async(route,body)=>{requests.push({route,body});if(route==='/connect')c.state.worker.status='online';if(route==='/takeover')c.state.computer.status=body.enabled?'human':'agent';return {ok:true};};c.api=async route=>{requests.push({route});assert.equal(route,'/state');return c.state;};
 c.filePreview={bind(){}};c.updateInstalling=false;c.chatScroll??={capture(){},restore(){},dispose(){},navigate:action=>action()};c.memorySettings??={setVisible(){},render:()=>'',bind(){},dispose(){}};c.taskReplies??=createTaskReplyController({document:c.document,getModel:()=>({})});vm.createContext(Object.assign(c,languageContext));vm.runInContext([
  part('const zh={','const subscriptionVoiceUnavailable='),part('const subscriptionVoiceUnavailable=','const eyes='),part('function renderComputer(){','function renderSettings(){'),part('function hasVMConnection(){','function renderVMSettings(){'),part('async function connectVM(){','async function saveAndConnectVM(){'),part('let inputChain=','async function taskRequest('),part('function bindComputerInput(){','async function openExternal('),part('async function action(a){','async function checkUnconfirmedMessage(){'),part('function screenVisible(){','async function loadVoices(){'),
 ].join('\n'),c);
 c.render=()=>{const template=document.createElement('template');template.innerHTML=c.renderComputer()+'<input type="file" id="file-input" hidden>';reconcile(app,template.content);const img=document.querySelector('#screen');if(img){Object.defineProperty(img,'naturalWidth',{configurable:true,value:1280});Object.defineProperty(img,'naturalHeight',{configurable:true,value:960});img.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:480,width:640,height:480});}c.bind();};c.render();
 return {c,document,requests,screens,toasts,intervals,timeouts,revoked,images,set wait(value){wait=value;},set decode(value){decode=value;},async click(selector){const node=document.querySelector(selector);assert.ok(node,selector);node.dispatchEvent(new Event('click',{bubbles:true}));await settle();},async tick(){for(const callback of intervals.values())callback();await settle();}};
}

test('a connected VM retains the real desktop while its agent is offline, with localized manual recovery and no automatic connect',async()=>{
 for(const [language,status,hint]of [['zh','VM 已连接 · 执行器离线','执行器离线时只能查看桌面。请重新连接后再接管。'],['en','VM connected · agent offline','The agent is offline. Reconnect before taking control.']]){
  const f=fixture(language),img=f.document.querySelector('#screen');assert.ok(img);assert.match(f.document.querySelector('.computer-meta').textContent,new RegExp(status));assert.equal(img.getAttribute('src'),'blob:existing-frame');assert.equal(f.document.querySelector('[data-action="takeover"]').disabled,true);assert.equal(f.document.querySelector('[data-action="takeover"]').title,hint);assert.ok(f.document.querySelector('.computer-agent-notice [data-action="connect"]'));assert.equal(f.c.screenVisible(),true);
  f.c.restartScreen();await settle();assert.equal(f.screens.length,1);assert.equal(f.document.querySelector('#screen'),img);assert.equal(img.getAttribute('src'),'blob:screen-1');assert.equal(f.intervals.size,1);await f.tick();assert.equal(f.screens.length,2);assert.equal(f.requests.length,0,'previewing must not reconnect or replay work');
 }
});

test('screen requests stay serialized and abort immediately when controller or events disconnect, regardless of cached agent state',async()=>{
 const f=fixture();let release;f.wait=()=>new Promise(resolve=>release=resolve);f.c.restartScreen();assert.equal(f.screens.length,1);await f.tick();assert.equal(f.screens.length,1);const signal=f.screens[0].options.signal;f.c.eventConnected=false;f.c.restartScreen();assert.equal(signal.aborted,true);assert.equal(f.intervals.size,0);release();await settle();assert.equal(f.c.screenURL,'blob:existing-frame');assert.equal(f.requests.length,0);
 const cached=fixture();cached.c.state.controller={status:'offline',cached:true};cached.c.state.worker.status='online';cached.c.render();assert.equal(cached.c.screenVisible(),false);assert.equal(cached.document.querySelector('#screen'),null);cached.c.restartScreen();assert.equal(cached.screens.length,0);
});

test('agent-offline takeover and all input routes stay blocked even while the desktop is reachable',async()=>{
 const f=fixture();await f.click('[data-action="takeover"]');assert.equal(f.requests.length,0);assert.match(f.toasts.at(-1),/agent is offline/);f.c.state.computer.status='human';f.c.render();const ime=f.document.querySelector('#vm-ime');ime.value='must not type';ime.dispatchEvent(new f.document.defaultView.Event('input',{bubbles:true}));await f.c.vmInput({type:'click',x:1,y:1});assert.equal(f.requests.length,0);assert.equal(f.document.querySelector('#screen-target').classList.contains('controlling'),false);
 f.c.state.worker.status='online';f.c.callStops.pending=true;f.c.render();await f.c.vmInput({type:'key',key:'Return'});assert.equal(f.requests.length,0,'a pending unknown call stop never enables human input');
});

test('an existing human lease may still be returned while the agent is offline or a call stop is pending',async()=>{
 const f=fixture();f.c.state.computer.status='human';f.c.callStops.pending=true;f.c.render();const release=f.document.querySelector('[data-action="takeover"]');assert.equal(release.disabled,false);assert.equal(release.textContent,'Return to dant');await f.click('[data-action="takeover"]');assert.equal(f.requests[0].route,'/takeover');assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0].body)),{enabled:false,sessionId:'lease-1'});assert.equal(f.c.state.computer.status,'agent');
});
test('human input keeps its exact lease during a connected call without sending a media stop',async()=>{
 const f=fixture(),call={id:'live',provider:'subscription',status:'connected'},peer={close(){throw Error('Call media must stay connected');}};f.c.state.worker.status='online';f.c.state.computer.status='human';f.c.state.call=call;f.c.pc=peer;f.c.render();
 await f.c.vmInput({type:'click',x:12,y:34});await f.c.vmInput({type:'text',text:'ordinary test input'});assert.deepEqual(JSON.parse(JSON.stringify(f.requests)),[{route:'/input',body:{type:'click',x:12,y:34,sessionId:'lease-1'}},{route:'/input',body:{type:'text',text:'ordinary test input',sessionId:'lease-1'}}]);assert.equal(f.c.state.call,call);assert.equal(f.c.pc,peer);
 f.c.state.computer.status='agent';await f.c.vmInput({type:'key',key:'Return'});assert.equal(f.requests.length,2,'returning the lease immediately blocks further human input');
});

test('manual Reconnect restores the executor path explicitly without resuming or replaying a task',async()=>{
 const f=fixture();await f.click('.computer-agent-notice [data-action="connect"]');assert.deepEqual(f.requests.map(item=>item.route),['/connect','/state']);assert.equal(f.c.state.worker.status,'online');f.c.render();assert.equal(f.document.querySelector('.computer-agent-notice'),null);assert.equal(f.document.querySelector('[data-action="takeover"]').disabled,false);assert.equal(f.screens.length,0);
});

test('older snapshots without a controller retain their previous online-only preview contract',()=>{
 const f=fixture();delete f.c.state.controller;assert.equal(f.c.screenVisible(),false);f.c.state.worker.status='online';f.c.render();assert.equal(f.c.screenVisible(),true);assert.ok(f.document.querySelector('#screen'));
});

test('a slow frame decodes before publication while the prior image survives state reconciliation',async()=>{
 const f=fixture(),img=f.document.querySelector('#screen');f.decode='pending';f.c.restartScreen();await settle();assert.equal(f.images.length,1);assert.equal(f.images[0].src,'blob:screen-1');assert.equal(f.c.screenBusy,true);assert.equal(f.c.screenURL,'blob:existing-frame');assert.equal(img.src,'blob:existing-frame');assert.deepEqual(f.revoked,[]);
 await f.tick();assert.equal(f.screens.length,1,'decode remains part of the serialized frame request');f.c.state.settings.language='zh';f.c.render();assert.ok(f.document.querySelector('#screen')===img);assert.equal(img.src,'blob:existing-frame');f.images[0].onload();await settle();assert.equal(f.c.screenURL,'blob:screen-1');assert.equal(img.src,'blob:screen-1');assert.equal(f.c.screenBusy,false);assert.deepEqual(f.revoked,['blob:existing-frame']);assert.equal(f.images[0].onload,null);assert.equal(f.images[0].onerror,null);
});

test('decode errors keep the last good frame, report localized retry status and recover on a valid refresh',async()=>{
 for(const language of ['en','zh']){
  const f=fixture(language),img=f.document.querySelector('#screen');f.decode='error';f.c.restartScreen();await settle();assert.equal(f.c.screenURL,'blob:existing-frame');assert.equal(img.src,'blob:existing-frame');assert.equal(f.c.screenFailures,1);assert.deepEqual(f.revoked,['blob:screen-1']);await f.tick();assert.equal(f.c.screenURL,'blob:existing-frame');assert.ok(f.document.querySelector('#screen')===img);assert.match(f.document.querySelector('.screen-status').textContent,language==='en'?/could not refresh/:/暂时无法刷新/);assert.deepEqual(f.revoked,['blob:screen-1','blob:screen-2']);
  f.decode='ok';await f.click('[data-action="screen-refresh"]');assert.equal(f.c.screenURL,'blob:screen-3');assert.equal(img.src,'blob:screen-3');assert.equal(f.c.screenError,'');assert.equal(f.c.screenFailures,0);assert.ok(f.document.querySelector('.screen-status')===null);assert.deepEqual(f.revoked,['blob:screen-1','blob:screen-2','blob:existing-frame']);assert.equal(f.requests.length,0,'frame recovery never reconnects, hangs up or replays work');
 }
});

test('decode abort and late load callbacks cannot publish or revoke a different frame',async()=>{
 const f=fixture();f.decode='pending';f.c.restartScreen();await settle();const pending=f.images[0],lateLoad=pending.onload;f.c.page='settings';f.c.restartScreen();await settle();assert.equal(f.screens[0].options.signal.aborted,true);assert.equal(pending.src,'');assert.equal(f.c.screenBusy,false);assert.equal(f.c.screenURL,'blob:existing-frame');assert.equal(f.c.screenFailures,0);assert.deepEqual(f.revoked,['blob:screen-1']);
 f.c.page='chat';f.decode='ok';f.c.restartScreen();await settle();assert.equal(f.c.screenURL,'blob:screen-2');lateLoad();await settle();assert.equal(f.c.screenURL,'blob:screen-2');assert.deepEqual(f.revoked,['blob:screen-1','blob:existing-frame']);assert.equal(f.document.querySelector('#screen').src,'blob:screen-2');
});

test('the request timeout also bounds image decoding and zero-sized frames are rejected',async()=>{
 const f=fixture();f.decode='pending';f.c.restartScreen();await settle();const timeout=[...f.timeouts.values()].find(value=>value.ms===10000);assert.ok(timeout);timeout.callback();await settle();assert.equal(f.c.screenBusy,false);assert.equal(f.c.screenURL,'blob:existing-frame');assert.equal(f.c.screenFailures,1);assert.deepEqual(f.revoked,['blob:screen-1']);
 await f.tick();assert.equal(f.screens.length,2);f.images[1].naturalWidth=0;f.images[1].onload();await settle();assert.equal(f.c.screenURL,'blob:existing-frame');assert.equal(f.c.screenFailures,2);assert.ok(f.document.querySelector('.screen-status'));assert.deepEqual(f.revoked,['blob:screen-1','blob:screen-2']);
});

test('a decoded candidate from an older epoch or removed panel is released without replacing the active URL',async()=>{
 const f=fixture();f.decode='pending';f.c.restartScreen();await settle();f.c.screenEpoch++;f.images[0].onload();await settle();assert.equal(f.c.screenURL,'blob:existing-frame');assert.deepEqual(f.revoked,['blob:screen-1']);await f.tick();f.document.querySelector('#screen').remove();f.images[1].onload();await settle();assert.equal(f.c.screenURL,'blob:existing-frame');assert.deepEqual(f.revoked,['blob:screen-1','blob:screen-2']);
});

test('loaded image bytes must finish pixel decoding before publication, and decode failures retain the prior frame',async()=>{
 const f=fixture();f.decode='pending';f.c.restartScreen();await settle();let finishDecode;f.images[0].decode=()=>new Promise(resolve=>finishDecode=resolve);f.images[0].onload();await settle();assert.equal(f.c.screenURL,'blob:existing-frame');assert.equal(f.c.screenBusy,true);finishDecode();await settle();assert.equal(f.c.screenURL,'blob:screen-1');assert.deepEqual(f.revoked,['blob:existing-frame']);
 await f.tick();f.images[1].decode=async()=>{throw Error('Invalid pixel data');};f.images[1].onload();await settle();assert.equal(f.c.screenURL,'blob:screen-1');assert.equal(f.c.screenFailures,1);assert.deepEqual(f.revoked,['blob:existing-frame','blob:screen-2']);
 await f.tick();let lateDecode;f.images[2].decode=()=>new Promise(resolve=>lateDecode=resolve);f.images[2].onload();await settle();f.c.showComputer=false;f.c.restartScreen();await settle();assert.equal(f.c.screenURL,'blob:screen-1');assert.equal(f.c.screenBusy,false);lateDecode();await settle();assert.deepEqual(f.revoked,['blob:existing-frame','blob:screen-2','blob:screen-3']);assert.equal(f.c.screenURL,'blob:screen-1');
});
