import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
function fixture(language='en'){
 const {document,Event}=parseHTML('<main id="app"></main>'),app=document.querySelector('#app'),requests=[],screens=[],toasts=[],intervals=new Map(),timeouts=new Map(),revoked=[];let sequence=0,screenSequence=0,wait=null;
 document.hasFocus=()=>true;
 const c={document,Event,window:{},AbortController,innerWidth:1440,base:'',token:'test',localStorage:{getItem:()=>null,setItem(){}},fallbackLanguage:language,state:{controller:{status:'online',cached:false},settings:{language,vm:{host:'192.0.2.10',user:'dant',port:22,keyPath:'C:/vm-key'}},worker:{status:'offline'},computer:{status:'agent',sessionId:'lease-1'},messages:[],call:null},eventConnected:true,unloading:false,page:'chat',chatMode:'text',showComputer:true,pc:null,callStarting:false,callStops:{pending:false},pendingActions:new Set(),screenURL:'blob:existing-frame',screenError:'',screenFailures:0,screenTimer:null,screenLoad:null,screenAbort:null,screenBusy:false,screenEpoch:0,vmDraft:null,voiceLoadedFor:'',modal:null,managedSettings:{bind(){}},chatHistory:{bind(){},bindModal(){}},icons:{},createElement:()=>({outerHTML:'<svg></svg>'}),toast:value=>toasts.push(value),bindSteer(){},bindProvision(){},bindVoiceKey(){},bindTelegram(){},bindAppearance(){},bindVMSettings(){},setInterval:(callback,ms)=>{assert.equal(ms,1200);intervals.set(++sequence,callback);return sequence;},clearInterval:id=>intervals.delete(id),setTimeout:(callback,ms)=>{timeouts.set(++sequence,{callback,ms});return sequence;},clearTimeout:id=>timeouts.delete(id),URL:{createObjectURL:()=>`blob:screen-${++screenSequence}`,revokeObjectURL:url=>revoked.push(url)}};
 c.fetch=async(url,options)=>{screens.push({url,options});if(wait)await wait();return {ok:true,blob:async()=>({type:'image/png'})};};c.post=async(route,body)=>{requests.push({route,body});if(route==='/connect')c.state.worker.status='online';if(route==='/takeover')c.state.computer.status=body.enabled?'human':'agent';return {ok:true};};c.api=async route=>{requests.push({route});assert.equal(route,'/state');return c.state;};
 vm.createContext(c);vm.runInContext([
  part('const zh={','const subscriptionVoiceUnavailable='),part('const subscriptionVoiceUnavailable=','const eyes='),part('function renderComputer(){','function renderSettings(){'),part('function hasVMConnection(){','function renderVMSettings(){'),part('async function connectVM(){','async function saveAndConnectVM(){'),part('let inputChain=','async function taskRequest('),part('function bindComputerInput(){','async function openExternal('),part('async function action(a){','async function checkUnconfirmedMessage(){'),part('function screenVisible(){','async function loadVoices(){'),
 ].join('\n'),c);
 c.render=()=>{const template=document.createElement('template');template.innerHTML=c.renderComputer()+'<input type="file" id="file-input" hidden>';reconcile(app,template.content);const img=document.querySelector('#screen');if(img){Object.defineProperty(img,'naturalWidth',{configurable:true,value:1280});Object.defineProperty(img,'naturalHeight',{configurable:true,value:960});img.getBoundingClientRect=()=>({left:0,top:0,right:640,bottom:480,width:640,height:480});}c.bind();};c.render();
 return {c,document,requests,screens,toasts,intervals,timeouts,revoked,set wait(value){wait=value;},async click(selector){const node=document.querySelector(selector);assert.ok(node,selector);node.dispatchEvent(new Event('click',{bubbles:true}));await settle();},async tick(){for(const callback of intervals.values())callback();await settle();}};
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

test('manual Reconnect restores the executor path explicitly without resuming or replaying a task',async()=>{
 const f=fixture();await f.click('.computer-agent-notice [data-action="connect"]');assert.deepEqual(f.requests.map(item=>item.route),['/connect','/state']);assert.equal(f.c.state.worker.status,'online');f.c.render();assert.equal(f.document.querySelector('.computer-agent-notice'),null);assert.equal(f.document.querySelector('[data-action="takeover"]').disabled,false);assert.equal(f.screens.length,0);
});

test('older snapshots without a controller retain their previous online-only preview contract',()=>{
 const f=fixture();delete f.c.state.controller;assert.equal(f.c.screenVisible(),false);f.c.state.worker.status='online';f.c.render();assert.equal(f.c.screenVisible(),true);assert.ok(f.document.querySelector('#screen'));
});
