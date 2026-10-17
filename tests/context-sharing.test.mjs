import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createWorkerApp} from '../src/server.mjs';
import {Store} from '../src/store.mjs';

const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(base,'shared-context-'));
 class Worker extends EventEmitter{
  constructor(){super();this.status='online';this.calls=[];this.rpc={reply(){},send(){}};this.workspaceRoot=path.join(dir,'workspaces');}
  async request(method,params){this.calls.push({method,params});if(method==='thread/start'||method==='thread/resume')return {thread:{id:'shared-thread'}};if(method==='thread/read')return {thread:{id:'shared-thread',turns:[{id:'old',startedAt:1,items:[{id:'old-text',type:'userMessage',content:[{type:'text',text:'Earlier typed fact'}]},{id:'spoken-tail',type:'userMessage',content:[{type:'text',text:'Native spoken tail fact'}]}]}]}};if(method==='turn/start')return {turn:{id:'typed-turn'}};if(method==='thread/inject_items'&&this.injectError)throw this.injectError;return {};}
  disconnect(){this.status='offline';this.emit('status');}
 }
 class Voice extends EventEmitter{
  constructor(options){super();this.options=options;this.contexts=[];this.memories=[];}
  async start(options){this.started=options;return {sdp:'synthetic-answer'};}
  async syncContext(value){this.contexts.push(value);return {callId:value.callId,messageId:value.message.id,kind:value.kind,status:'submitted'};}
  async syncMemory(value){this.memories.push(value);return {callId:value.callId,kind:'memory',status:'submitted'};}
  async conversationReady(callId){this.readyCall=callId;}
  async stop(){this.emit('closed');}
  async close(){}
 }
 const worker=new Worker(),instance=createWorkerApp({dataDir:dir,workerFactory:()=>worker,voiceFactory:options=>new Voice(options)});
 t.after(async()=>{instance.engine.active=null;instance.engine.call=null;await instance.close();fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(url+'/api/session').then(response=>response.json());
 const request=(route,{method='GET',body}={})=>fetch(url+'/api'+route,{method,headers:{'X-Dant-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {...instance,dir,request};
}

test('API speech enters the existing model thread privately, survives restart and appears in the next call without replay',async t=>{
 const {engine,voice,worker,store,dir}=await fixture(t),cid=store.state.conversationId;
 await engine.startCall('synthetic-offer',{provider:'api'});const callId=engine.call.id;
 assert.match(voice.started.context,/Earlier typed fact/);assert.match(voice.started.context,/Native spoken tail fact/);
 const item={callId,itemId:'spoken-user',previousItemId:null,role:'user',text:'The spoken test fruit is kumquat.'};await voice.options.onConversationItem(item);
 await voice.options.onConversationItem({...item,itemId:'spoken-assistant',previousItemId:item.itemId,role:'assistant',text:'I heard kumquat.'});
 assert.equal(worker.calls.filter(call=>call.method==='thread/inject_items').length,2);
 const injected=worker.calls.filter(call=>call.method==='thread/inject_items')[0];assert.equal(injected.params.threadId,'shared-thread');assert.match(injected.params.items[0].content[0].text,/kumquat/);
 assert.equal(store.state.messages.length,0);assert.equal(store.state.conversationId,cid);
 await voice.options.onConversationItem(item);assert.equal(worker.calls.filter(call=>call.method==='thread/inject_items').length,2);
 assert.equal(new Store(dir).state.voiceHistory.length,2);await engine.stopCall(callId);await engine.startCall('synthetic-offer',{provider:'api'});
 assert.match(voice.started.context,/kumquat/);assert.equal(worker.calls.filter(call=>call.method==='thread/inject_items').length,2);
 await assert.rejects(voice.options.onConversationItem({...item,itemId:'late'}),/active|changed/i);
 assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);
});

test('an uncertain API speech injection is retained privately but never automatically submitted again',async t=>{
 const {engine,voice,worker,store}=await fixture(t);await engine.startCall('offer',{provider:'api'});worker.injectError=Error('synthetic transport failure');
 const item={callId:engine.call.id,itemId:'uncertain',role:'user',text:'A finalized spoken fact'};await assert.rejects(voice.options.onConversationItem(item));
 await assert.rejects(voice.options.onConversationItem(item));assert.equal(worker.calls.filter(call=>call.method==='thread/inject_items').length,1);assert.equal(store.state.voiceHistory[0].status,'unknown');assert.equal(store.state.messages.length,0);
});

test('a memory write from either the model tool or settings refreshes the same active call and thread',async t=>{
 const {engine,voice,worker,store}=await fixture(t);await engine.startCall('offer',{provider:'api'});const callId=engine.call.id;
 assert.deepEqual(await engine.tool('memory_write',{text:'New durable preference'}),{saved:true,file:'working-memory.md'});
 assert.equal(voice.memories.length,1);assert.equal(voice.memories[0].callId,callId);assert.match(voice.memories[0].memory,/New durable preference/);
 const saved=await engine.saveMemory('working-memory.md','A replacement preference');assert.equal(saved.name,'working-memory.md');assert.match(voice.memories.at(-1).memory,/A replacement preference/);assert.doesNotMatch(voice.memories.at(-1).memory,/New durable preference/);
 assert.equal(store.state.threadId,'shared-thread');assert.equal(worker.calls.filter(call=>call.method==='thread/start').length,1);assert.equal(worker.calls.filter(call=>call.method==='thread/resume').length,0);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);
});

test('typed API work waits for speech context and completed assistant replies are forwarded as references',async t=>{
 const {engine,voice,worker,store}=await fixture(t);await engine.startCall('offer',{provider:'api'});const callId=engine.call.id;
 let release;voice.conversationReady=()=>new Promise(resolve=>release=resolve);engine.enqueue(store.add({role:'user',text:'Use what I said on the call.'}));await tick();assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);
 release();await tick();assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);
 await engine.handle({method:'item/completed',params:{threadId:'shared-thread',turnId:'typed-turn',item:{id:'reply',type:'agentMessage',text:'A completed chat answer'}}});await tick();
 assert.ok(voice.contexts.some(value=>value.callId===callId&&value.message.role==='assistant'&&value.message.text==='A completed chat answer'));
});

test('a memory change during media negotiation is refreshed before call startup returns',async t=>{
 const {engine,voice}=await fixture(t);let ready,release;
 const entered=new Promise(resolve=>ready=resolve);voice.start=async options=>{voice.started=options;ready();await new Promise(resolve=>release=resolve);return {sdp:'answer'};};
 const starting=engine.startCall('offer',{provider:'api'});await entered;
 const original=voice.syncMemory.bind(voice);let negotiating=true;voice.syncMemory=options=>negotiating?Promise.resolve({status:'cancelled'}):original(options);
 await engine.saveMemory('working-memory.md','Updated while negotiating');negotiating=false;release();await starting;
 assert.match(voice.memories.at(-1).memory,/Updated while negotiating/);assert.equal(voice.memories.at(-1).callId,engine.call.id);
});

test('the authenticated settings memory route refreshes the current voice call and existing model thread without starting work',async t=>{
 const {engine,voice,worker,store,request,dir}=await fixture(t);await engine.startCall('offer',{provider:'api'});const callId=engine.call.id,cid=store.state.conversationId;
 const text='Settings changed the shared preference: 请用中英文回答。',response=await request('/memory/working-memory.md',{method:'PATCH',body:{text}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{name:'working-memory.md',bytes:Buffer.byteLength(text)});
 assert.equal(store.state.memory,text);assert.equal(fs.readFileSync(path.join(dir,'memory','dant','working-memory.md'),'utf8'),text);
 assert.equal(voice.memories.length,1);assert.equal(voice.memories[0].callId,callId);assert.ok(voice.memories[0].memory.includes(text));assert.equal(engine.call.id,callId);
 const injected=worker.calls.filter(call=>call.method==='thread/inject_items');assert.equal(injected.length,1);assert.equal(injected[0].params.threadId,'shared-thread');assert.ok(injected[0].params.items[0].content[0].text.includes(text));
 assert.equal(store.state.threadId,'shared-thread');assert.equal(store.state.conversationId,cid);assert.equal(worker.calls.filter(call=>call.method==='thread/start').length,1);assert.equal(worker.calls.filter(call=>call.method==='thread/resume'||call.method==='turn/start').length,0);
});

test('private speech stays outside state snapshots and visible history clearing preserves shared context and thread identity',async t=>{
 const {engine,voice,worker,store,credentials,request,dir}=await fixture(t),secret='synthetic-shared-context-secret-7349',privateFact='The private spoken test flower is freesia.';
 credentials.upsert({name:'Synthetic context credential',secret});store.add({role:'user',text:'A visible earlier message',status:'completed'});store.add({role:'assistant',text:'A visible earlier reply',status:'completed'});
 await engine.startCall('offer',{provider:'api'});const callId=engine.call.id;
 await voice.options.onConversationItem({callId,itemId:'private-human',role:'user',text:privateFact+' '+secret});await voice.options.onConversationItem({callId,itemId:'private-assistant',previousItemId:'private-human',role:'assistant',text:'I heard the spoken flower.'});
 assert.equal(store.state.voiceHistory.length,2);assert.ok(store.state.voiceHistory.every(item=>item.status==='submitted'));assert.match(store.state.voiceHistory[0].text,/\[credential redacted\]/);assert.equal(JSON.stringify(store.state.voiceHistory).includes(secret),false);
 let response=await request('/state');assert.equal(response.status,200);let snapshot=await response.json();assert.equal(Object.hasOwn(snapshot,'voiceHistory'),false);assert.equal(JSON.stringify(snapshot).includes(privateFact),false);assert.equal(JSON.stringify(snapshot).includes(secret),false);assert.equal(snapshot.messages.length,2);
 await engine.stopCall(callId);const privateHistory=structuredClone(store.state.voiceHistory),identity={threadId:store.state.threadId,threadRuntime:store.state.threadRuntime,threadConversationId:store.state.threadConversationId,conversationId:store.state.conversationId},loaded=engine.loaded,callsBefore=worker.calls.length;
 response=await request('/history',{method:'DELETE',body:{confirm:true}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{cleared:true,count:2});assert.deepEqual(store.state.messages,[]);assert.deepEqual(store.state.voiceHistory,privateHistory);assert.equal(engine.loaded,loaded);assert.equal(worker.calls.length,callsBefore);
 for(const [key,value] of Object.entries(identity))assert.equal(store.state[key],value);assert.deepEqual(new Store(dir).state.voiceHistory,privateHistory);
 response=await request('/state');assert.equal(response.status,200);snapshot=await response.json();assert.deepEqual(snapshot.messages,[]);assert.equal(Object.hasOwn(snapshot,'voiceHistory'),false);assert.equal(JSON.stringify(snapshot).includes(privateFact),false);
 await engine.startCall('offer',{provider:'api'});assert.ok(voice.started.context.includes(privateFact));assert.equal(voice.started.context.includes(secret),false);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);assert.equal(worker.calls.filter(call=>call.method==='thread/inject_items').length,2);
});
