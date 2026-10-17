import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Engine} from '../src/engine.mjs';
import {NativeRealtimeVoice} from '../src/realtime.mjs';
import {Store} from '../src/store.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
class Worker extends EventEmitter{
 constructor(dir){super();this.status='online';this.workspaceRoot=path.join(dir,'workspaces');this.desktopPath=path.join(dir,'desktop.py');this.calls=[];this.rpc={reply(){},send(){}};}
 async request(method,params){
  this.calls.push({method,params});
  const event=(method,params={})=>this.emit('event',{method,params:{threadId:'thread',...params}});
  if(method==='thread/start')return {thread:{id:'thread'}};
  if(method==='thread/realtime/start'){queueMicrotask(()=>{event('thread/realtime/started',{version:'v3'});event('thread/realtime/sdp',{sdp});});return {};}
  if(method==='thread/realtime/stop'){queueMicrotask(()=>event('thread/realtime/closed'));return {};}
  if(method==='thread/read')return {thread:{id:'thread',status:{type:'active'},turns:[...this.engine.nativeVoice.session.turns.values()].map(turn=>({id:turn.turnId,status:turn.done?'completed':'inProgress'}))}};
  return {};
 }
}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(base,'native-interactive-')),store=new Store(dir),worker=new Worker(dir),engine=new Engine(store,worker),voice=new NativeRealtimeVoice({worker,engine,connectTimeoutMs:1000,stopTimeoutMs:1000});worker.engine=engine;
 t.after(()=>{engine.pauseQueue();clearTimeout(engine.streamingSaveTimer);fs.rmSync(dir,{recursive:true,force:true});});
 const event=(method,params={},id)=>engine.handle({method,params:{threadId:'thread',...params},...(id===undefined?{}:{id})});
 const call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);await event('turn/started',{turn:{id:'owned',status:'inProgress'}});await engine.stopCall(call.callId);
 return {store,worker,engine,voice,event,session:voice.session,turn:voice.session.turns.get('owned'),message:(text='Open a room now',extra={})=>store.add({role:'user',text,...extra}),finish:()=>event('turn/completed',{turn:{id:'owned',status:'completed'}}),steers:()=>worker.calls.filter(call=>call.method==='turn/steer')};
}

test('opted-in native chat follows the exact running background turn and confirms receipt only after its steer acknowledgement',async t=>{
 const f=await fixture(t);assert.equal(f.voice.acceptsChatInput,false);assert.equal(f.voice.acceptsInteractiveChatInput,true);assert.equal(f.voice.progress.canSteer,true);
 const ordinary=f.message('An automatic scheduled task');await assert.rejects(f.voice.answerBackground(ordinary),/changed/);assert.equal(f.engine.queue.length,0);assert.equal(f.steers().length,0);
 let acknowledge;const request=f.worker.request.bind(f.worker);f.worker.request=(method,params)=>{if(method!=='turn/steer')return request(method,params);f.worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};
 const message=f.message(),pending=f.voice.answerBackground(message,{interactive:true,expectedTurnId:'owned'});while(!acknowledge)await tick();assert.equal(message.submission,'submitting');assert.equal(message.executorConfirmedAt,null);assert.equal(f.steers()[0].params.expectedTurnId,'owned');assert.ok(f.steers()[0].params.input[0].text.includes(message.text));acknowledge({});
 assert.deepEqual(await pending,{queued:false,turnId:'owned'});assert.equal(message.submission,'confirmed');assert.ok(message.executorConfirmedAt>0);assert.equal(f.voice.acceptsChatInput,false);assert.equal(f.voice.acceptsInteractiveChatInput,true);assert.equal(f.engine.queue.length,0);await f.finish();assert.equal(message.status,'review');assert.equal(f.voice.session,null);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);
});

test('native interactive replies require text and the explicit current turn without accepting attachments',async t=>{
 const f=await fixture(t);
 for(const [text,extra,expectedTurnId] of [['Open room',{},'old-owner'],['Open room',{},undefined],['Open room',{attachments:[{id:'image'}]},'owned'],[' ',{},'owned']]){
  const message=f.message(text,extra);await assert.rejects(f.voice.answerBackground(message,{interactive:true,expectedTurnId}));assert.equal(message.submission,'preparing');assert.equal(message.status,'failed');assert.equal(message.executorConfirmedAt,null);
 }
 assert.equal(f.steers().length,0);assert.equal(f.engine.queue.length,0);await f.finish();
});

test('native interactive followups serialize on one confirmed owner and duplicate message IDs execute once',async t=>{
 const f=await fixture(t),acknowledgements=[],request=f.worker.request.bind(f.worker);f.worker.request=(method,params)=>{if(method!=='turn/steer')return request(method,params);f.worker.calls.push({method,params});return new Promise(resolve=>acknowledgements.push(resolve));};
 const first=f.message('Create room'),second=f.message('Share its code'),options={interactive:true,expectedTurnId:'owned'},one=f.voice.answerBackground(first,options);assert.equal(f.voice.answerBackground(first,options),one);const two=f.voice.answerBackground(second,options);while(!acknowledgements.length)await tick();assert.equal(f.steers().length,1);assert.equal(f.voice.acceptsInteractiveChatInput,true);acknowledgements[0]({});await one;while(acknowledgements.length<2)await tick();assert.equal(first.submission,'confirmed');assert.equal(second.submission,'submitting');acknowledgements[1]({});await two;
 await f.voice.answerBackground(first,options);assert.equal(f.steers().length,2);assert.deepEqual(f.steers().map(call=>call.params.expectedTurnId),['owned','owned']);assert.deepEqual(f.turn.explicitMessageIds,[first.id,second.id]);assert.equal(f.engine.queue.length,0);await f.finish();assert.equal(first.status,'review');assert.equal(second.status,'review');
});

test('a captured native owner finishing before dispatch fails visibly instead of becoming a queued or new task',async t=>{
 const f=await fixture(t);let release;f.session.messageChain=new Promise(resolve=>release=resolve);const message=f.message(),pending=f.voice.answerBackground(message,{interactive:true,expectedTurnId:'owned'});await f.finish();release();await assert.rejects(pending,error=>error.submission==='not-submitted');assert.equal(message.status,'failed');assert.equal(message.submission,'preparing');assert.equal(message.executorConfirmedAt,null);assert.equal(f.engine.queue.length,0);assert.equal(f.steers().length,0);assert.equal(f.voice.session,null);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);
});

test('native interactive input rejects unsafe ownership states before dispatch',async t=>{
 const mutations=[['unknown',f=>f.session.unknown=true],['new turn submitting',f=>f.session.submitting={message:{id:'pending'}}],['pausing',f=>f.session.pausing=true],['stopping',f=>f.session.stopping=true],['human control',f=>f.engine.takeover=true],['acquiring control',f=>f.engine.acquiring=true],['offline',f=>f.worker.status='offline'],['turn pause',f=>f.turn.pauseRequested=true],['pending handoff',f=>f.session.handoffs.set('pending',{turnId:null,idleConfirmed:false})],['multiple turns',f=>f.session.turns.set('another',{turnId:'another',done:false})]];
 for(const [name,mutate] of mutations)await t.test(name,async t=>{const f=await fixture(t);mutate(f);assert.equal(f.voice.acceptsInteractiveChatInput,false);const message=f.message();await assert.rejects(f.voice.answerBackground(message,{interactive:true,expectedTurnId:'owned'}),error=>error.submission==='not-submitted');assert.equal(message.status,'failed');assert.equal(f.steers().length,0);assert.equal(f.engine.queue.length,0);});
});

test('native interactive input rechecks its captured owner and pending handoffs after serialization',async t=>{
 for(const [name,mutate] of [['replaced session',f=>f.voice.session={...f.session,turns:new Map()}],['new handoff',f=>f.session.handoffs.set('late',{turnId:null,idleConfirmed:false})],['human control',f=>f.engine.acquiring=true]])await t.test(name,async t=>{const f=await fixture(t);let release;f.session.messageChain=new Promise(resolve=>release=resolve);const message=f.message(),pending=f.voice.answerBackground(message,{interactive:true,expectedTurnId:'owned'});mutate(f);release();await assert.rejects(pending,error=>error.submission==='not-submitted');assert.equal(message.status,'failed');assert.equal(message.submission,'preparing');assert.equal(f.steers().length,0);assert.equal(f.engine.queue.length,0);});
});

test('lost native followup acknowledgement locks the owner and never dispatches or replays the serialized next reply',async t=>{
 const f=await fixture(t);let rejectFirst;const request=f.worker.request.bind(f.worker);f.worker.request=(method,params)=>{if(method!=='turn/steer')return request(method,params);f.worker.calls.push({method,params});return new Promise((resolve,reject)=>rejectFirst=reject);};
 const first=f.message('Create room'),second=f.message('Share code'),options={interactive:true,expectedTurnId:'owned'},one=f.voice.answerBackground(first,options),two=f.voice.answerBackground(second,options);const firstRejected=assert.rejects(one,error=>error.unknownOutcome===true&&error.submission==='unknown'),secondRejected=assert.rejects(two,error=>error.submission==='not-submitted');while(!rejectFirst)await tick();rejectFirst(Error('The acknowledgement was lost'));await Promise.all([firstRejected,secondRejected]);
 assert.equal(first.submission,'unknown');assert.equal(first.status,'paused');assert.equal(first.executorConfirmedAt,null);assert.equal(second.submission,'preparing');assert.equal(second.status,'failed');assert.equal(f.session.unknown,true);assert.equal(f.voice.acceptsInteractiveChatInput,false);await assert.rejects(f.voice.answerBackground(first,options));assert.equal(f.steers().length,1);assert.equal(f.engine.queue.length,0);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);
});

test('an explicit native steer rejection stays failed and allows a distinct followup without replay',async t=>{
 const f=await fixture(t),request=f.worker.request.bind(f.worker);let rejected=false;f.worker.request=(method,params)=>{if(method!=='turn/steer'||rejected)return request(method,params);rejected=true;f.worker.calls.push({method,params});return Promise.reject(Object.assign(Error('Turn rejected the adjustment'),{code:-32000}));};
 const first=f.message(),options={interactive:true,expectedTurnId:'owned'};await assert.rejects(f.voice.answerBackground(first,options),error=>error.submission==='rejected');assert.equal(first.status,'failed');assert.equal(first.submission,'rejected');assert.equal(first.executorConfirmedAt,null);assert.equal(f.session.unknown,false);assert.equal(f.voice.acceptsInteractiveChatInput,true);await assert.rejects(f.voice.answerBackground(first,options));const second=f.message('Use another room');await f.voice.answerBackground(second,options);assert.equal(second.submission,'confirmed');assert.equal(f.steers().length,2);await f.finish();assert.equal(first.status,'failed');assert.equal(second.status,'review');
});

test('a terminal event during native steer acknowledgement persists the acknowledged followup with the same final result',async t=>{
 const f=await fixture(t),request=f.worker.request.bind(f.worker);let acknowledge;f.worker.request=(method,params)=>{if(method!=='turn/steer')return request(method,params);f.worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};const message=f.message(),pending=f.voice.answerBackground(message,{interactive:true,expectedTurnId:'owned'});while(!acknowledge)await tick();await f.finish();assert.equal(f.turn.resultSaved,undefined);acknowledge({});await pending;assert.equal(message.submission,'confirmed');assert.equal(message.status,'review');assert.ok(message.executorConfirmedAt>0);assert.equal(f.voice.session,null);assert.equal(f.steers().length,1);
});
