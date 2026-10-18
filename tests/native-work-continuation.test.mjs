import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Engine} from '../src/engine.mjs';
import {NativeRealtimeVoice} from '../src/realtime.mjs';
import {Store} from '../src/store.mjs';
import {startTaskProgress} from '../src/task-progress.mjs';

const base=path.resolve('.cache/tests'),sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';fs.mkdirSync(base,{recursive:true});
const wire=(method,params={},id)=>({method,params:{threadId:'thread',...params},...(id===undefined?{}:{id})});
const handoff=key=>wire('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:key,item_id:key+'-input',input_transcript:'A separate spoken request',active_transcript:[]}});
class Worker extends EventEmitter{
 constructor(dir){super();this.status='online';this.runtimeId='fixture:continuation';this.workspaceRoot=path.join(dir,'workspaces');this.calls=[];this.responses=[];this.rpc={reply:(id,result)=>this.responses.push({id,result}),send:value=>this.responses.push(value)};}
 async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread'}};if(method==='thread/realtime/start'){queueMicrotask(()=>{this.emit('event',wire('thread/realtime/started',{version:'v3',realtimeSessionId:'realtime'}));this.emit('event',wire('thread/realtime/sdp',{sdp}));});}return {};}
 async terminateConfirmed(){throw Error('Continuation admission must not terminate the executor');}
}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(base,'native-work-continuation-')),store=new Store(dir),worker=new Worker(dir),engine=new Engine(store,worker),voice=new NativeRealtimeVoice({worker,engine,connectTimeoutMs:1000}),notices=[];engine.on('notice',value=>notices.push(value));
 const result=await engine.startCall(sdp);engine.confirmCallConnected(result.callId);const session=voice.session,call=engine.call;
 t.after(()=>{clearTimeout(engine.streamingSaveTimer);fs.rmSync(dir,{recursive:true,force:true});});
 return {store,worker,engine,voice,session,call,notices};
}
function owner(f){
 const record=f.store.registerWork({turnId:'previous',source:'voice',title:'Continue the entrusted work',plan:{steps:[{step:'Verify the remaining result',status:'pending'}]}});f.store.updateRegisteredWork('previous',{status:'continuing',executionEnded:true});
 const active={messageId:null,messageIds:[],threadId:'thread',turnId:null,continuation:{workId:record.id,attemptId:'attempt',fromTurnId:'previous',epoch:0},startSubmitted:false,startAcknowledged:false,early:[],earlyBytes:0,outputs:new Map(),assistantIds:[],explicitPaths:[],workRecord:record};startTaskProgress(active);f.engine.active=active;return active;
}
function acknowledge(active,id='automatic'){active.turnId=id;active.startAcknowledged=true;}
function mediaUntouched(f){assert.equal(f.engine.call,f.call);assert.equal(f.voice.session,f.session);assert.equal(f.call.status,'connected');assert.equal(f.session.status,'connected');assert.equal(f.session.closed,false);assert.equal(f.worker.calls.filter(call=>['thread/realtime/stop','turn/interrupt','turn/steer'].includes(call.method)).length,0);}

test('a confirmed automatic continuation owns only its exact turn and leaves native media and chat input history unchanged',async t=>{
 const f=await fixture(t),active=owner(f),messages=f.store.state.messages.length;assert.equal(f.voice.canContinueWhileIdle(active),true);assert.equal(f.voice.beginContinuationAdmission(active),true);assert.equal(f.voice.beginContinuationAdmission(active),false);assert.equal(active.continuationAdmission.callId,f.call.id);active.startSubmitted=true;
 const events=[wire('turn/started',{turn:{id:'automatic',status:'inProgress'}}),wire('item/agentMessage/delta',{turnId:'automatic',itemId:'answer',delta:'Checking the remaining result.'})];for(const event of events)await f.engine.handle(event);assert.equal(active.early.length,2);assert.equal(f.session.turns.size,0);
 acknowledge(active);const replay=await f.voice.replayContinuationEvents(active,active.early.map(item=>item.event));assert.equal(replay.conflict,false);assert.deepEqual(replay.owned,events);assert.equal(f.session.externalTurns.has('automatic'),false,'asynchronous replay is not the final binding fence');assert.equal(f.voice.confirmContinuationAdmission(active),true);assert.equal(f.session.externalTurns.get('automatic'),active);assert.equal(f.session.turns.has('automatic'),false);assert.equal(f.store.state.messages.length,messages,'admission never invents a human message');
 f.voice.finishContinuationAdmission(active);assert.equal(active.continuationAdmission,undefined);assert.equal(f.session.continuationAdmission,undefined);assert.equal(f.voice.continuationAdmissions.has(active),false);mediaUntouched(f);
});

test('automatic admission excludes busy, uncertain, incomplete-media and pending-context states',async t=>{
 const cases=[['handoff',f=>f.session.handoffs.set('pending',{turnId:null})],['native execution',f=>f.session.turns.set('native',{done:false})],['unsaved result',f=>f.session.turns.set('native',{done:true,resultSaved:false})],['native submission',f=>f.session.submitting={}],['unknown',f=>f.session.unknown=true],['pausing',f=>f.session.pausing=true],['stopping',f=>f.session.stopping=true],['reconnecting',f=>f.session.reconnecting=true],['media unknown',f=>f.session.mediaUnconfirmed=true],['closed media',f=>f.session.closed=true],['background session',f=>f.session.background=true],['unprocessed notification',f=>f.session.queuedEvents++],['pending typed input',f=>f.session.callInputs=new Map([['input',{settled:false}]])],['running context',f=>f.session.contextQueue={running:true,pending:[]}],['pending context',f=>f.session.contextQueue={running:false,pending:[{}]}],['unknown context',f=>f.session.contextQueue={running:false,pending:[],uncertain:true}],['closed context',f=>f.session.contextQueue={running:false,pending:[],closed:true}],['takeover',f=>f.engine.takeover=true],['acquiring control',f=>f.engine.acquiring=true],['offline',f=>f.worker.status='offline'],['different active owner',f=>f.engine.active={}],['wrong shared thread',f=>f.store.state.threadId='different'],['unconfirmed call',f=>f.call.connectedAt=null]];
 for(const [name,change]of cases)await t.test(name,async t=>{const f=await fixture(t),active=owner(f);change(f);assert.equal(f.voice.canContinueWhileIdle(active),false);assert.equal(f.voice.beginContinuationAdmission(active),false);assert.equal(active.continuationAdmission,undefined);});
 const f=await fixture(t);f.voice.session=null;f.engine.call=null;assert.equal(f.voice.canContinueWhileIdle(),true,'non-native execution keeps the Engine admission policy');
});

test('a handoff winning before submission aborts automatic admission and remains a separate native task',async t=>{
 const f=await fixture(t),active=owner(f);assert.equal(f.voice.beginContinuationAdmission(active),true);await f.engine.handle(handoff('spoken-first'));assert.equal(f.voice.canContinueWhileIdle(active),false);assert.equal(f.session.handoffs.get('spoken-first').turnId,null);
 const foreign=wire('turn/started',{turn:{id:'spoken',status:'inProgress'}}),result=await f.voice.replayContinuationEvents(active,[foreign],{notSubmitted:true});assert.equal(result.conflict,false);assert.equal(result.owned.length,0);f.voice.finishContinuationAdmission(active);await f.session.eventChain;assert.equal(f.session.handoffs.get('spoken-first').turnId,'spoken');assert.equal(f.session.turns.has('spoken'),true);assert.equal(f.session.unknown,false);assert.equal(active.workRecord.turnId,'previous');assert.equal(f.store.state.workTasks[0].turnId,'previous');mediaUntouched(f);
});

test('definitive automatic RPC rejection replays a racing native turn and its tool once without binding the old work',async t=>{
 const f=await fixture(t),active=owner(f);assert.equal(f.voice.beginContinuationAdmission(active),true);active.startSubmitted=true;await f.engine.handle(handoff('native-wins'));
 const events=[wire('turn/started',{turn:{id:'spoken',status:'inProgress'}}),wire('item/tool/call',{turnId:'spoken',callId:'deliver',tool:'send_message',arguments:{text:'A real spoken result'}},71)];for(const event of events)await f.engine.handle(event);assert.equal(active.early.length,2);
 const result=await f.voice.replayContinuationEvents(active,events,{notSubmitted:true});assert.equal(result.conflict,false);assert.deepEqual(result.owned,[]);f.voice.finishContinuationAdmission(active);await f.session.eventChain;assert.equal(f.session.turns.has('spoken'),true);assert.equal(f.session.handoffs.get('native-wins').turnId,'spoken');assert.equal(f.session.unknown,false);assert.equal(f.worker.responses.find(item=>item.id===71).result.success,true);assert.equal(f.store.state.messages.filter(message=>message.text==='A real spoken result').length,1);assert.equal(f.session.turns.get('spoken').workRecord,undefined);assert.equal(f.store.state.workTasks[0].turnId,'previous');mediaUntouched(f);
});

test('a foreign early turn after automatic acknowledgement is retained as native ownership and blocks ambiguous tool execution',async t=>{
 const f=await fixture(t),active=owner(f);f.voice.beginContinuationAdmission(active);active.startSubmitted=true;await f.engine.handle(handoff('racing-handoff'));
 const owned=wire('turn/started',{turn:{id:'automatic',status:'inProgress'}}),foreign=wire('turn/started',{turn:{id:'spoken',status:'inProgress'}}),tool=wire('item/tool/call',{turnId:'spoken',callId:'unsafe-delivery',tool:'send_message',arguments:{text:'Must not run while ownership is uncertain'}},72);acknowledge(active);
 const result=await f.voice.replayContinuationEvents(active,[owned,foreign,tool]);assert.equal(result.conflict,true);assert.deepEqual(result.owned,[owned]);assert.equal(active.continuationConflict,true);assert.equal(f.session.unknown,true);assert.equal(f.session.externalTurns.has('automatic'),false);f.voice.finishContinuationAdmission(active);await f.session.eventChain;assert.equal(f.session.turns.has('spoken'),true);assert.equal(f.session.handoffs.get('racing-handoff').turnId,'spoken');assert.equal(f.session.turns.get('spoken').workRecord,undefined);assert.equal(f.worker.responses.find(item=>item.id===72).result.success,false);assert.equal(f.store.state.messages.some(message=>message.text==='Must not run while ownership is uncertain'),false);mediaUntouched(f);
});

test('a handoff received before acknowledgement cannot be rebound when its event queue runs after the acknowledgement',async t=>{
 const f=await fixture(t),active=owner(f);f.voice.beginContinuationAdmission(active);active.startSubmitted=true;let release;f.session.eventChain=new Promise(resolve=>release=resolve);const pending=f.engine.handle(handoff('delayed-handoff'));assert.equal(f.session.continuationAdmission.conflict,true);acknowledge(active);const replay=await f.voice.replayContinuationEvents(active,[]);assert.equal(replay.conflict,true);release();await pending;assert.equal(f.session.handoffs.get('delayed-handoff').turnId,null);assert.equal(f.session.externalTurns.has('automatic'),false);f.voice.finishContinuationAdmission(active);mediaUntouched(f);
});

test('a handoff arriving after replay but before synchronous binding confirmation cannot acquire the original task',async t=>{
 const f=await fixture(t),active=owner(f);f.voice.beginContinuationAdmission(active);active.startSubmitted=true;acknowledge(active,'spoken-winner');active.continuation.bindingPending=true;
 const early=wire('turn/started',{turn:{id:'spoken-winner',status:'inProgress'}}),replay=await f.voice.replayContinuationEvents(active,[early]);assert.equal(replay.conflict,false);assert.equal(f.session.externalTurns.has('spoken-winner'),false);
 let release;f.session.eventChain=new Promise(resolve=>release=resolve);const handoffReceived=f.engine.handle(handoff('between-replay-and-bind'));assert.equal(f.session.continuationAdmission.conflict,true,'receipt fences binding even before the native event queue advances');assert.equal(f.voice.confirmContinuationAdmission(active),false);assert.equal(active.continuationConflict,true);assert.equal(f.session.unknown,true);assert.equal(f.session.externalTurns.has('spoken-winner'),false);assert.deepEqual(f.session.continuationUncertain.retained,[early]);release();await handoffReceived;assert.equal(f.session.handoffs.get('between-replay-and-bind').turnId,null);assert.equal(f.store.state.workTasks[0].turnId,'previous');f.voice.finishContinuationAdmission(active);mediaUntouched(f);
});

test('a queued foreign turn received after acknowledgement blocks the final fence before native ownership is materialized',async t=>{
 const f=await fixture(t),active=owner(f);f.voice.beginContinuationAdmission(active);active.startSubmitted=true;acknowledge(active);active.continuation.bindingPending=true;const replay=await f.voice.replayContinuationEvents(active,[]);assert.equal(replay.conflict,false);
 let release;f.session.eventChain=new Promise(resolve=>release=resolve);const incoming=f.engine.handle(wire('turn/started',{turn:{id:'queued-native',status:'inProgress'}}));assert.equal(f.session.queuedEvents,1);assert.equal(f.session.turns.has('queued-native'),false,'the native event has arrived but its blocked queue has not created the owner');assert.equal(f.voice.confirmContinuationAdmission(active),false);assert.equal(f.session.externalTurns.has('automatic'),false);assert.equal(active.continuationConflict,true);assert.equal(f.session.unknown,true);assert.equal(f.store.state.workTasks[0].turnId,'previous');
 release();await incoming;assert.equal(f.session.turns.has('queued-native'),true);assert.equal(f.session.turns.get('queued-native').workRecord,undefined);f.voice.finishContinuationAdmission(active);mediaUntouched(f);
});

test('the synchronous continuation fence rejects new native peers and stale scopes without capturing an external owner',async t=>{
 for(const change of ['native-peer','scope','call-scope','typed-input','unconfirmed-context'])await t.test(change,async t=>{
  const f=await fixture(t),active=owner(f);f.voice.beginContinuationAdmission(active);active.startSubmitted=true;acknowledge(active);active.continuation.bindingPending=true;const replay=await f.voice.replayContinuationEvents(active,[]);assert.equal(replay.conflict,false);
  if(change==='native-peer')f.session.turns.set('spoken',{done:false});else if(change==='scope')f.session.workEpoch++;else if(change==='call-scope')f.call.id='replacement-call';else if(change==='typed-input')f.session.callInputs=new Map([['pending',{settled:false}]]);else f.session.contextQueue={uncertain:true};
  assert.equal(f.voice.confirmContinuationAdmission(active),false);assert.equal(f.session.externalTurns.has('automatic'),false);assert.equal(f.session.unknown,true);assert.equal(f.store.state.workTasks[0].turnId,'previous');f.voice.finishContinuationAdmission(active);mediaUntouched(f);
 });
});

test('a lost continuation acknowledgement keeps its events unclaimed and never replays them as a native task',async t=>{
 const f=await fixture(t),active=owner(f);f.voice.beginContinuationAdmission(active);active.startSubmitted=true;const event=wire('turn/started',{turn:{id:'maybe-automatic',status:'inProgress'}}),result=await f.voice.replayContinuationEvents(active,[event]);assert.equal(result.conflict,true);assert.deepEqual(result.owned,[]);assert.deepEqual(f.session.continuationUncertain.retained,[event]);assert.equal(f.session.turns.size,0);assert.equal(f.session.externalTurns.size,0);assert.equal(f.voice.canContinueWhileIdle(active),false);f.voice.finishContinuationAdmission(active);assert.equal(f.session.unknown,true);mediaUntouched(f);
});

test('a replaced session, thread, media generation or control epoch cannot receive replay from an older admission',async t=>{
 for(const change of ['session','thread','generation','epoch'])await t.test(change,async t=>{
  const f=await fixture(t),active=owner(f);f.voice.beginContinuationAdmission(active);active.startSubmitted=true;acknowledge(active);
  if(change==='session')f.voice.session={...f.session,id:'replacement',mediaId:'replacement',turns:new Map(),externalTurns:new Map(),unknown:false};else if(change==='thread')f.store.state.threadId='replacement-thread';else if(change==='generation')f.session.mediaGeneration++;else f.session.workEpoch++;
  const result=await f.voice.replayContinuationEvents(active,[wire('turn/started',{turn:{id:'foreign',status:'inProgress'}})]);assert.equal(result.conflict,true);assert.deepEqual(result.owned,[]);assert.equal(f.voice.session.turns.size,0);if(change==='session')assert.equal(f.voice.session.unknown,false,'an old operation cannot poison replacement media');f.voice.finishContinuationAdmission(active);assert.equal(active.continuationAdmission,undefined);
 });
});

test('replay rejects other threads and an absent live-call reservation cannot route any event',async t=>{
 const f=await fixture(t),active=owner(f),other=wire('item/tool/call',{threadId:'wrong',turnId:'foreign',tool:'send_message',arguments:{text:'Wrong thread'}},73);let result=await f.voice.replayContinuationEvents(active,[other]);assert.equal(result.conflict,true);assert.deepEqual(result.owned,[]);assert.equal(f.worker.responses.length,0);
 f.voice.beginContinuationAdmission(active);acknowledge(active);result=await f.voice.replayContinuationEvents(active,[other]);assert.equal(result.conflict,false);assert.deepEqual(result.owned,[]);assert.equal(f.worker.responses.find(item=>item.id===73).error.message,'Inactive continuation thread');assert.equal(f.store.state.messages.length,0);f.voice.finishContinuationAdmission(active);mediaUntouched(f);
});

test('replay maintains the observer buffer limit without dispatching oversized requests',async t=>{
 const f=await fixture(t),active=owner(f);f.voice.beginContinuationAdmission(active);active.startSubmitted=true;acknowledge(active);const large=wire('item/tool/call',{turnId:'foreign',tool:'send_message',arguments:{text:'x'.repeat(1024*1024)}},74);
 await assert.rejects(f.voice.replayContinuationEvents(active,[large]),/buffer exceeded/);await assert.rejects(f.voice.replayContinuationEvents(active,Array(129).fill(wire('turn/started',{turn:{id:'foreign'}}))),/Invalid automatic/);assert.equal(f.worker.responses.length,0);assert.equal(f.session.turns.size,0);f.voice.finishContinuationAdmission(active);mediaUntouched(f);
});
