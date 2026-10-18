import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {WorkContinuationSupervisor} from '../src/work-continuation.mjs';
import {NativeRealtimeVoice} from '../src/realtime.mjs';
import {continuationEligible} from '../src/work-continuation-state.mjs';

const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});
const event=(method,params={})=>({method,params:{threadId:'thread',...params}});
const plan=()=>[{step:'Inspect the actual result',status:'completed'},{step:'Finish and verify the requested change',status:'inProgress'}];
class Worker extends EventEmitter{
 constructor(){super();this.status='online';this.calls=[];this.rpc={reply(){},send(){}};this.count=0;}
 async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread'}};if(method==='thread/read')return {thread:{id:'thread',status:{type:'idle'},turns:this.engine.store.state.workTasks.map(record=>({id:record.turnId,status:'completed'}))}};if(method==='turn/start')return {turn:{id:'auto-'+ ++this.count}};return {};}
}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(root,'engine-continuation-')),store=new Store(dir),worker=new Worker(),engine=new Engine(store,worker),notices=[];worker.engine=engine;engine.on('notice',text=>notices.push(text));store.state.threadId='thread';store.state.threadRuntime=engine.runtimeId;store.state.threadConversationId=store.state.conversationId;engine.loaded=true;
 t.after(()=>{engine.continuationStopped=true;clearTimeout(engine.streamingSaveTimer);fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,worker,engine,notices};
}
function unfinished(f,id='original'){
 const message=f.store.add({role:'user',text:'Finish the requested project',turnId:id,status:'review',submission:'confirmed',workKind:'task'}),record=f.store.registerWork({turnId:id,messageId:message.id,title:'Finish the requested project',source:'chat',plan:{steps:plan()}});f.store.updateRegisteredWork(id,{status:'continuing',executionEnded:true,at:Date.now()-10000});return {message,record:f.store.state.workTasks.find(item=>item.id===record.id)};
}
const terminal=(f,status='completed')=>f.engine.handle(event('turn/completed',{turn:{id:f.engine.active.turnId,status}}));
const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
async function callFixture(t){
 const f=fixture(t),request=f.worker.request.bind(f.worker);f.worker.request=async(method,params)=>{
  if(method==='thread/realtime/start'){queueMicrotask(()=>{f.worker.emit('event',event('thread/realtime/started',{version:'v3'}));f.worker.emit('event',event('thread/realtime/sdp',{sdp}));});return {};}
  if(method==='thread/realtime/stop'){queueMicrotask(()=>f.worker.emit('event',event('thread/realtime/closed')));return {};}
  return request(method,params);
 };f.voice=new NativeRealtimeVoice({engine:f.engine,worker:f.worker,connectTimeoutMs:1000,stopTimeoutMs:1000});const call=await f.engine.startCall(sdp);f.engine.confirmCallConnected(call.callId);f.call=f.engine.call;return f;
}

test('idle unfinished work continues with one durable identity and no new human message or attachment replay',async t=>{
 const f=fixture(t),{record,message}=unfinished(f),before=structuredClone(f.store.state.messages),scheduler=new WorkContinuationSupervisor({engine:f.engine});
 const ack=await scheduler.tick();assert.equal(ack.workId,record.id);assert.equal(f.engine.active.workRecord.id,record.id);assert.equal(f.engine.active.messageId,null);assert.deepEqual(f.store.state.messages,before);assert.deepEqual(f.store.state.workTasks[0].turnIds,['original',ack.turnId]);assert.equal(f.store.state.workTasks[0].messageId,message.id);assert.equal(f.store.state.workTasks[0].continuation.dispatch.phase,'acknowledged');
 const request=f.worker.calls.find(call=>call.method==='turn/start');assert.match(request.params.input[0].text,/<dant_work_continuation>/);assert.equal(request.params.input.length,1);assert.equal(request.params.threadId,'thread');assert.match(request.params.input[0].text,/verify which steps remain/);
 await assert.rejects(f.engine.tool('task_plan',{title:'Another work',steps:plan()}),/exact registered workId/);await assert.rejects(f.engine.tool('task_plan',{workId:'different',title:'Another work',steps:plan()}),/exact registered workId/);
 await f.engine.tool('task_plan',{workId:record.id,title:record.title,steps:plan().map(step=>({...step,status:'completed'}))});await f.engine.handle(event('item/completed',{turnId:ack.turnId,item:{id:'result',type:'agentMessage',text:'The requested change has been verified.'}}));await terminal(f);
 assert.equal(f.store.state.workTasks[0].status,'review');assert.equal(f.store.state.workTasks[0].continuation.dispatch,undefined);assert.equal(f.store.state.messages.filter(item=>item.role==='user').length,1);assert.equal(f.store.state.messages.at(-1).text,'The requested change has been verified.');assert.equal(await scheduler.tick(),null);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);
});

test('an unfinished automatic turn is scheduled after a delay and repeated ticks cannot duplicate its live owner',async t=>{
 const f=fixture(t),{record}=unfinished(f),scheduler=new WorkContinuationSupervisor({engine:f.engine});await scheduler.tick();assert.equal(await scheduler.tick(),null);await terminal(f);const saved=f.store.state.workTasks[0];assert.equal(saved.status,'continuing');assert.equal(saved.continuation.noProgressCount,1);assert.ok(saved.continuation.nextAt>Date.now());assert.equal(await scheduler.tick(),null);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);assert.equal(new Store(f.dir).state.workTasks[0].id,record.id);
});

test('actual clarification blocks automatic continuation after its execution turn ends',async t=>{
 const f=fixture(t),{record}=unfinished(f);await f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId});await f.engine.tool('task_plan',{workId:record.id,title:record.title,status:'waiting_user',steps:[{step:'Ask which account should receive the result',status:'pending'}]});await terminal(f);assert.equal(f.store.state.workTasks[0].status,'waiting_user');assert.equal(f.store.state.workTasks[0].continuation.nextAt,null);assert.equal(f.engine.canContinueRegisteredWork(),true);assert.equal(continuationEligible(f.store.state.workTasks[0]),false);assert.equal(await new WorkContinuationSupervisor({engine:f.engine}).tick(),null);
});

test('an unconfirmed start is held across restart and cannot be retried by another heartbeat',async t=>{
 const f=fixture(t),{record}=unfinished(f),original=f.worker.request.bind(f.worker);f.worker.request=(method,params)=>method==='turn/start'?Promise.reject(Error('Lost acknowledgement private-token')):original(method,params);
 await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}),/Lost acknowledgement/);const saved=f.store.state.workTasks[0];assert.equal(saved.status,'unknown');assert.equal(saved.continuation.dispatch.phase,'unknown');assert.equal(f.engine.active,null);assert.equal(f.engine.canContinueRegisteredWork(),false);assert.equal(new Store(f.dir).state.workTasks[0].status,'unknown');assert.equal(await new WorkContinuationSupervisor({engine:f.engine}).tick(),null);assert.equal(JSON.stringify(saved).includes('private-token'),false);
});

test('claim save failure submits nothing and acknowledgement save failure retains an uncertain claim',async t=>{
 for(const phase of ['claim','ack']){
  const f=fixture(t),{record}=unfinished(f),save=f.store.save;let writes=0;f.store.save=function(){writes++;if(phase==='claim'||writes===3)throw Error('Disk unavailable');return save.call(this);};
  await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}),/Disk unavailable/);f.store.save=save;
  if(phase==='claim'){assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);assert.equal(f.store.state.workTasks[0].continuation,undefined);}
  else{assert.equal(f.store.state.workTasks[0].status,'unknown');assert.equal(f.store.state.workTasks[0].continuation.dispatch.phase,'unknown');assert.equal(f.engine.active.turnId,'auto-1');assert.equal(f.engine.progress.status,'unknown');assert.ok(f.worker.calls.some(call=>call.method==='turn/interrupt'&&call.params.turnId==='auto-1'));await terminal(f,'interrupted');assert.equal(f.engine.active,null);assert.equal(f.store.state.workTasks[0].status,'paused');assert.equal(f.store.state.workTasks[0].turnId,'auto-1');assert.equal(f.store.state.workTasks[0].continuation.dispatch,undefined);assert.equal(f.store.state.workTasks[0].continuation.nextAt,null);}
 }
});

test('an early terminal event is retained when saving its acknowledged binding fails',async t=>{
 const f=fixture(t),{record}=unfinished(f),request=f.worker.request.bind(f.worker),save=f.store.save;let writes=0;f.store.save=function(){if(++writes===3)throw Error('Binding save failed');return save.call(this);};f.worker.request=async(method,params)=>{if(method==='turn/start'){await f.engine.handle(event('turn/completed',{turn:{id:'early-finished',status:'completed'}}));return {turn:{id:'early-finished'}};}return request(method,params);};await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}),/Binding save failed/);assert.equal(f.engine.active,null);assert.equal(f.store.state.workTasks[0].turnId,'early-finished');assert.equal(f.store.state.workTasks[0].status,'paused');assert.equal(f.store.state.workTasks[0].continuation.dispatch,undefined);
});

test('fresh executor evidence must prove the previous task turn is terminal and the shared thread is idle',async t=>{
 for(const thread of [{id:'other',status:{type:'idle'},turns:[]},{id:'thread',status:{type:'active'},turns:[{id:'original',status:'inProgress'}]},{id:'thread',status:{type:'idle'},turns:[]},{id:'thread',status:{type:'idle'},turns:[{id:'original',status:'completed'},{id:'original',status:'completed'}]}]){
  const f=fixture(t),{record}=unfinished(f),request=f.worker.request.bind(f.worker);f.worker.request=(method,params)=>method==='thread/read'?Promise.resolve({thread}):request(method,params);await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}));assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);assert.equal(f.store.state.workTasks[0].status,'continuing');assert.equal(f.store.state.workTasks[0].continuation.dispatch,undefined);assert.ok(f.store.state.workTasks[0].continuation.nextAt>Date.now());
 }
});

test('a repeated historical conversation turn ID is never accepted as new work or interrupted',async t=>{
 const f=fixture(t),{record}=unfinished(f),request=f.worker.request.bind(f.worker);f.worker.request=(method,params)=>method==='thread/read'?Promise.resolve({thread:{id:'thread',status:{type:'idle'},turns:[{id:'original',status:'completed'},{id:'old-conversation',status:'completed'}]}}):method==='turn/start'?Promise.resolve({turn:{id:'old-conversation'}}):request(method,params);await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}),/new turn/);assert.equal(f.engine.active,null);assert.equal(f.store.state.workTasks[0].status,'unknown');assert.equal(f.worker.calls.some(call=>call.method==='turn/interrupt'),false);
});

test('new human input wins while automatic preflight is awaiting an idle check',async t=>{
 const f=fixture(t),{record}=unfinished(f),request=f.worker.request.bind(f.worker);let resolveRead,reading;const readStarted=new Promise(resolve=>reading=resolve);f.worker.request=(method,params)=>method==='thread/read'?new Promise(resolve=>{resolveRead=resolve;reading();}):request(method,params);
 const pending=f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId});await readStarted;const human=f.store.add({role:'user',text:'A new immediate request'});f.engine.enqueue(human);resolveRead({thread:{id:'thread',status:{type:'idle'},turns:[{id:'original',status:'completed'}]}});await assert.rejects(pending);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.store.state.workTasks[0].status,'continuing');assert.equal(f.store.state.workTasks[0].continuation.dispatch,undefined);const starts=f.worker.calls.filter(call=>call.method==='turn/start');assert.equal(starts.length,1);assert.doesNotMatch(starts[0].params.input[0].text,/<dant_work_continuation>/);assert.equal(f.engine.active.messageId,human.id);
});

test('ordinary new human input queues after the current automatic round without being forced into its work ID',async t=>{
 const f=fixture(t),{record}=unfinished(f);await f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId});const automatic=f.engine.active,human=f.store.add({role:'user',text:'Find a different document'});f.engine.enqueue(human,{interactive:true});assert.equal(f.engine.active,automatic);assert.equal(f.engine.queue[0],human);assert.equal(human.workId,undefined);assert.equal(f.worker.calls.some(call=>call.method==='turn/steer'),false);await terminal(f);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.engine.active.messageId,human.id);assert.equal(f.store.state.workTasks[0].status,'continuing');assert.equal(human.workId,undefined);
});

test('service close and human takeover during preflight cannot submit an automatic turn',async t=>{
 for(const flag of ['continuationStopped','takeover']){
  const f=fixture(t),{record}=unfinished(f),request=f.worker.request.bind(f.worker);f.worker.request=async(method,params)=>{if(method==='thread/read')f.engine[flag]=true;return request(method,params);};await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}));assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);assert.equal(f.store.state.workTasks[0].continuation.dispatch,undefined);
 }
});

test('executor disconnection cannot retire an acknowledged continuation without a terminal event',async t=>{
 const f=fixture(t),{record}=unfinished(f);await f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId});f.worker.status='offline';f.worker.emit('status');await f.engine.finishing;assert.equal(f.store.state.workTasks[0].status,'unknown');assert.equal(f.store.state.workTasks[0].continuation.dispatch.phase,'unknown');assert.equal(f.store.state.workTasks[0].continuation.nextAt,null);
});

test('global pause parks idle unfinished tasks instead of letting the periodic monitor restart them',async t=>{
 const f=fixture(t),{record}=unfinished(f);await f.engine.pause();assert.equal(f.store.state.workTasks[0].status,'paused');assert.equal(f.store.state.workTasks[0].pauseReason,'user-paused');assert.equal(await new WorkContinuationSupervisor({engine:f.engine}).tick(),null);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);assert.equal(new Store(f.dir).state.workTasks[0].id,record.id);
});

test('unknown submissions block automatic continuation while automatic claims also hold the ordinary queue',async t=>{
 for(const automatic of [false,true]){
  const f=fixture(t),{record}=unfinished(f);
  if(automatic){const request=f.worker.request.bind(f.worker);f.worker.request=(method,params)=>method==='turn/start'?Promise.reject(Error('Acknowledgement lost')):request(method,params);await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}));}
  else f.store.add({role:'user',text:'Earlier unconfirmed request',status:'paused',submission:'unknown'});
  assert.equal(f.engine.canContinueRegisteredWork(),false);const human=f.store.add({role:'user',text:'A later human request'});f.engine.enqueue(human);await f.engine.pump();if(automatic){assert.equal(f.engine.active,null);assert.equal(f.engine.queue[0].id,human.id);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,0);assert.equal(human.status,'queued');}else assert.equal(f.engine.active.messageId,human.id,'a new explicit human request retains the existing recovery behavior without replaying the old one');
 }
});

test('a stable live call can continue its registered task without a new user message, handoff or media restart',async t=>{
 const f=await callFixture(t),{record}=unfinished(f),session=f.voice.session,call=f.engine.call;assert.equal(f.engine.canContinueRegisteredWork(),true);const ack=await f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId});assert.equal(ack.continued,true);assert.equal(f.engine.call,call);assert.equal(f.voice.session,session);assert.equal(session.externalTurns.get(ack.turnId),f.engine.active);assert.equal(f.store.state.messages.filter(item=>item.role==='user').length,1);assert.equal(session.handoffs.size,0);
 await f.engine.tool('task_plan',{workId:record.id,title:record.title,steps:plan().map(step=>({...step,status:'completed'}))});await terminal(f);assert.equal(f.store.state.workTasks[0].status,'review');assert.equal(f.engine.call,call);assert.equal(call.status,'connected');assert.equal(f.worker.calls.some(item=>item.method==='thread/realtime/stop'),false);assert.equal(session.unknown,false);
});

test('a spoken handoff racing automatic admission never binds or interrupts a possibly steered native owner',async t=>{
 const f=await callFixture(t),{record}=unfinished(f),request=f.worker.request.bind(f.worker),call=f.engine.call;let release;f.worker.request=(method,params)=>{
  if(method==='turn/start'){const pending=f.engine.handle(event('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:'spoken-handoff',item_id:'spoken-input',input_transcript:'A separate spoken request',active_transcript:[]}}));return pending.then(()=>({turn:{id:'automatic'}}));}
  if(method==='turn/interrupt'){queueMicrotask(()=>void f.engine.handle(event('turn/completed',{turn:{id:params.turnId,status:'interrupted'}})));return Promise.resolve({});}
  return request(method,params);
 };await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}),error=>error.unknownOutcome===true);assert.equal(f.store.state.workTasks[0].status,'unknown');assert.equal(f.store.state.workTasks[0].turnId,'original');assert.equal(f.engine.call,call);assert.equal(call.status,'connected');assert.equal(f.voice.session.handoffs.get('spoken-handoff').turnId,null);assert.equal(f.worker.calls.some(item=>item.method==='thread/realtime/stop'||item.method==='turn/interrupt'),false);assert.equal(f.voice.session.unknown,true);assert.equal(f.engine.active,null);
});

test('a spoken handoff after event replay but before durable binding cannot steal the native turn',async t=>{
 for(const failSave of [false,true]){
  const f=await callFixture(t),{record}=unfinished(f),call=f.engine.call,replay=f.voice.replayContinuationEvents.bind(f.voice),save=f.store.save;let writes=0;
  f.store.save=function(){if(failSave&&++writes===3)throw Error('Unknown admission save failed');return save.call(this);};
  f.voice.replayContinuationEvents=async(...args)=>{const result=await replay(...args);await f.engine.handle(event('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:'late-spoken',item_id:'late-input',input_transcript:'A new spoken request',active_transcript:[]}}));return result;};
  await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}));
  assert.equal(f.engine.active,null);assert.equal(f.store.state.workTasks[0].turnId,'original');assert.equal(f.store.state.workTasks[0].continuation.dispatch.phase,failSave?'submitting':'unknown');assert.equal(f.engine.canContinueRegisteredWork(),false);assert.equal(f.engine.call,call);assert.equal(call.status,'connected');assert.equal(f.voice.session.externalTurns?.has('auto-1')||false,false);assert.equal(f.voice.session.unknown,true);assert.equal(f.worker.calls.some(item=>item.method==='turn/interrupt'||item.method==='thread/realtime/stop'),false);
 }
});

test('a failed acknowledged admission replay releases its tentative owner without interrupting another turn',async t=>{
 const f=await callFixture(t),{record}=unfinished(f),call=f.engine.call;f.voice.replayContinuationEvents=async()=>{throw Error('Replay admission failed');};
 await assert.rejects(f.engine.continueRegisteredWork(record.id,{expectedTurnId:record.turnId}),/Replay admission failed/);assert.equal(f.engine.active,null);assert.equal(f.store.state.workTasks[0].turnId,'original');assert.equal(f.store.state.workTasks[0].status,'unknown');assert.equal(f.store.state.workTasks[0].continuation.dispatch.phase,'unknown');assert.equal(f.voice.session.unknown,true);assert.equal(f.engine.call,call);assert.equal(f.worker.calls.some(item=>item.method==='turn/interrupt'||item.method==='thread/realtime/stop'),false);
});
