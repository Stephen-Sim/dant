import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Engine} from '../src/engine.mjs';
import {NativeRealtimeVoice} from '../src/realtime.mjs';
import {Store} from '../src/store.mjs';
import {CredentialRequests,CredentialVault} from '../src/credentials.mjs';

const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
const wire=(method,params={})=>({method,params:{threadId:'thread',...params}});
class Worker extends EventEmitter{
 constructor(dir){super();this.status='online';this.workspaceRoot=path.join(dir,'workspaces');this.desktopPath=path.join(dir,'desktop.py');this.runtimeId='vm:call-coexistence';this.calls=[];this.responses=[];this.wire=[];this.turns=new Map();this.nextTurn=0;this.terminated=0;this.failMedia=null;this.emitClosed=true;this.rpc={reply:(id,result)=>this.responses.push({id,result}),send:value=>this.responses.push(value)};}
 record(event){this.wire.push(event);const turn=event.params?.turn;if(event.method==='turn/started')this.turns.set(turn.id,'inProgress');if(event.method==='turn/completed')this.turns.set(turn.id,turn.status);return event;}
 publish(method,params={}){this.emit('event',this.record(wire(method,params)));}
 async request(method,params){
  this.calls.push({method,params});
  if(method==='thread/start')return {thread:{id:'thread'}};
  if(method==='turn/start'){const id='typed-'+ ++this.nextTurn;this.turns.set(id,'inProgress');return {turn:{id}};}
  if(method==='thread/realtime/start'){
   if(this.failMedia){const mode=this.failMedia;this.failMedia=null;throw Object.assign(Error('Media startup rejected'),mode==='rejected'?{code:-32602}:{});}
   queueMicrotask(()=>{this.publish('thread/realtime/started',{version:'v3',realtimeSessionId:'rt-'+params.voiceSessionId});this.publish('thread/realtime/sdp',{sdp});});return {};
  }
  if(method==='thread/realtime/stop'){if(this.emitClosed)queueMicrotask(()=>this.publish('thread/realtime/closed',{reason:'requested'}));return {};}
  if(method==='turn/interrupt'){queueMicrotask(()=>this.publish('turn/completed',{turn:{id:params.turnId,status:'interrupted'}}));return {};}
  if(method==='thread/read'){const turns=[...this.turns].map(([id,status])=>({id,status}));return {thread:{id:'thread',status:{type:turns.some(turn=>turn.status==='inProgress')?'active':'idle'},turns}};}
  return {};
 }
 async terminateConfirmed(){this.terminated++;throw Error('Starting or ending media must not terminate accepted work');}
}
function fixture(t,{secure=false,stopTimeoutMs=2000}={}){
 const dir=fs.mkdtempSync(path.join(base,'native-coexistence-')),store=new Store(dir),worker=new Worker(dir),credentials=secure?new CredentialRequests({vault:new CredentialVault({dataDir:dir}),timeoutMs:30000}):undefined,engine=new Engine(store,worker,{credentials}),voice=new NativeRealtimeVoice({worker,engine,connectTimeoutMs:2000,stopTimeoutMs}),notices=[];store.state.settings.language='en';engine.on('notice',value=>notices.push(value));
 t.after(()=>{credentials?.close();clearTimeout(engine.streamingSaveTimer);fs.rmSync(dir,{recursive:true,force:true});});
 const event=(method,params={},id)=>{const value=worker.record(wire(method,params));if(id!==undefined)value.id=id;return engine.handle(value);};
 return {store,worker,engine,voice,credentials,notices,event,begin:id=>event('turn/started',{turn:{id,status:'inProgress'}}),finish:(id,status='completed')=>event('turn/completed',{turn:{id,status}})};
}
function register(f,owner){f.engine.observeRegisteredPlan(owner,[{step:'Continue the accepted task',status:'inProgress'},{step:'Verify its actual result',status:'pending'}]);return f.store.state.workTasks.find(record=>record.turnId===owner.turnId);}
async function background(f,id='accepted-work'){
 const call=await f.engine.startCall(sdp);f.engine.confirmCallConnected(call.callId);await f.begin(id);const session=f.voice.session,turn=session.turns.get(id),record=register(f,turn);await f.engine.stopCall(call.callId);assert.equal(f.engine.call,null);return {call,session,turn,record};
}
function untouched(f){assert.equal(f.worker.terminated,0);assert.equal(f.worker.calls.filter(call=>call.method==='turn/interrupt').length,0);}
async function until(check){for(let index=0;index<1000&&!check();index++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(check(),'the expected confirmed state did not arrive');}

test('new native media reuses background work and credential ownership without waiting for its blocked tool chain',{timeout:15000},async t=>{
 const f=fixture(t,{secure:true}),first=await f.engine.startCall(sdp);f.engine.confirmCallConnected(first.callId);await f.begin('credential-work');const session=f.voice.session,turn=session.turns.get('credential-work'),record=register(f,turn),pending=f.event('item/tool/call',{turnId:turn.turnId,callId:'credential-tool',tool:'credential_request',arguments:{name:'Existing login',service:'example.invalid',reason:'Continue accepted work'}},71);pending.catch(()=>{});await tick();const form=f.credentials.snapshot().requests[0];assert.ok(form);await f.engine.stopCall(first.callId);assert.equal(f.voice.active.status,'waiting_user');
 const second=await f.engine.startCall(sdp);f.engine.confirmCallConnected(second.callId);assert.notEqual(second.callId,first.callId);assert.equal(f.voice.session,session);assert.equal(session.id,first.callId,'the work and secure-form owner stays stable');assert.equal(session.mediaId,second.callId);assert.equal(session.turns.get(turn.turnId),turn);assert.equal(f.credentials.snapshot().requests[0].id,form.id);assert.equal(f.voice.active.turnId,turn.turnId);assert.notEqual(f.store.state.workTasks.find(item=>item.id===record.id).status,'paused');untouched(f);
 const closed=f.worker.wire.findIndex(event=>event.method==='thread/realtime/closed'),started=f.worker.wire.findIndex(event=>event.method==='thread/realtime/started'&&event.params.realtimeSessionId==='rt-'+second.callId);assert.ok(closed>=0&&started>closed);assert.ok(f.worker.wire.filter(event=>['thread/realtime/sdp','thread/realtime/closed'].includes(event.method)).every(event=>!Object.hasOwn(event.params,'callId')&&!Object.hasOwn(event.params,'realtimeSessionId')),'the real wire does not identify SDP or closed media');
 f.credentials.fulfill(form.id,{secret:'synthetic-coexistence-secret'});await pending;assert.equal(f.worker.responses.find(item=>item.id===71).result.success,true);assert.equal(JSON.stringify(f.store.state).includes('synthetic-coexistence-secret'),false);await f.engine.stopCall(second.callId);await f.finish(turn.turnId);untouched(f);
});

test('a rejected reconnect rolls back media only, preserving the same work owner for a later retry',{timeout:10000},async t=>{
 const f=fixture(t),{session,turn,record}=await background(f),before=structuredClone(f.store.state.workTasks);f.worker.failMedia='rejected';await assert.rejects(f.engine.startCall(sdp),/The new call could not be connected\. Existing work was preserved\./);assert.equal(f.voice.session,session);assert.equal(session.turns.get(turn.turnId),turn);assert.equal(f.engine.call,null);assert.deepEqual(f.store.state.workTasks,before);untouched(f);
 const retry=await f.engine.startCall(sdp);assert.equal(f.voice.active.turnId,turn.turnId);assert.equal(f.store.state.workTasks.find(item=>item.id===record.id).turnId,turn.turnId);await f.engine.stopCall(retry.callId);await f.finish(turn.turnId);untouched(f);
});

test('a lost reconnect acknowledgement keeps known work intact until media closure is actually confirmed',{timeout:10000},async t=>{
 const f=fixture(t),{call:first,session,turn,record}=await background(f),before=structuredClone(f.store.state.workTasks);f.worker.failMedia='unknown';await assert.rejects(f.engine.startCall(sdp),/The new call could not be connected\. Existing work was preserved\./);const reserved=f.engine.call.id;
 assert.notEqual(reserved,first.callId);assert.equal(f.engine.call.status,'stop-unconfirmed');assert.equal(f.voice.session,session);assert.equal(session.id,first.callId);assert.equal(session.mediaId,reserved);assert.equal(session.mediaUnconfirmed,true);assert.equal(session.unknown,false);assert.equal(session.turns.get(turn.turnId),turn);assert.equal(f.voice.active.turnId,turn.turnId);assert.deepEqual(f.store.state.workTasks,before);untouched(f);await assert.rejects(f.engine.startCall(sdp),/already active/);
 const reads=f.worker.calls.filter(call=>call.method==='thread/read').length,result=await f.engine.stopCall(reserved);assert.equal(result.stopped,true);assert.equal(result.workContinues,true);assert.equal(f.engine.call,null);assert.equal(session.mediaUnconfirmed,false);assert.equal(session.unknown,false);assert.equal(f.voice.session,session);assert.ok(f.worker.calls.filter(call=>call.method==='thread/read').length>reads,'closure also checks the actual accepted work history');assert.equal(f.store.state.workTasks.find(item=>item.id===record.id).status,before.find(item=>item.id===record.id).status);untouched(f);
 const retry=await f.engine.startCall(sdp);f.engine.confirmCallConnected(retry.callId);assert.equal(f.voice.active.turnId,turn.turnId);assert.notEqual(retry.callId,reserved);await f.engine.stopCall(retry.callId);await f.finish(turn.turnId);untouched(f);
});

test('a stop RPC acknowledgement without a closed event cannot falsely release uncertain new media or stop old work',{timeout:10000},async t=>{
 const f=fixture(t,{stopTimeoutMs:50}),{session,turn,record}=await background(f),before=structuredClone(f.store.state.workTasks);f.worker.failMedia='unknown';await assert.rejects(f.engine.startCall(sdp),/Existing work was preserved/);const reserved=f.engine.call.id,closed=f.worker.wire.filter(event=>event.method==='thread/realtime/closed').length;f.worker.emitClosed=false;
 await assert.rejects(f.engine.stopCall(reserved),/shutdown could not be confirmed/);assert.equal(f.worker.wire.filter(event=>event.method==='thread/realtime/closed').length,closed,'this provider acknowledged stop without emitting a closed event');assert.equal(f.engine.call.id,reserved);assert.equal(f.engine.call.status,'stop-unconfirmed');assert.equal(f.voice.session,session);assert.equal(session.mediaUnconfirmed,true);assert.equal(session.unknown,false);assert.equal(session.turns.get(turn.turnId),turn);assert.equal(f.voice.active.turnId,turn.turnId);assert.deepEqual(f.store.state.workTasks,before);assert.equal(f.store.state.workTasks.find(item=>item.id===record.id).status,before.find(item=>item.id===record.id).status);untouched(f);await assert.rejects(f.engine.startCall(sdp),/already active/);
 f.worker.emitClosed=true;await f.engine.stopCall(reserved);assert.equal(f.engine.call,null);assert.equal(f.voice.session,session);assert.equal(session.unknown,false);untouched(f);await f.finish(turn.turnId);
});

test('ordinary typed work keeps sole execution ownership while a native call and server-managed handoff coexist',{timeout:10000},async t=>{
 const f=fixture(t),message=f.store.add({role:'user',text:'Keep building my requested change'});f.engine.enqueue(message);await until(()=>f.engine.active?.startAcknowledged);const owner=f.engine.active,record=register(f,owner);f.engine.waitStopped=async()=>{throw Error('A new call must not pause typed work');};const call=await f.engine.startCall(sdp);f.engine.confirmCallConnected(call.callId);assert.equal(f.engine.active,owner);assert.equal(message.status,'running');assert.equal(owner.stopRequested,undefined);assert.equal(f.voice.session.turns.has(owner.turnId),false,'one executor turn has one owner');
 await f.event('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:'adjust-existing',item_id:'spoken-adjustment',input_transcript:'Keep going with the same requested change',active_transcript:[]}});assert.equal(f.voice.session.handoffs.get('adjust-existing').turnId,owner.turnId);assert.equal(f.voice.session.turns.has(owner.turnId),false);assert.equal(f.engine.active,owner);
 await f.event('item/tool/call',{turnId:owner.turnId,callId:'list-existing',tool:'task_list',arguments:{}},81);assert.equal(f.worker.responses.find(item=>item.id===81).result.success,true);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);assert.equal(f.worker.calls.filter(call=>call.method==='turn/steer').length,0,'Codex owns StartOrSteer routing for this announced handoff');
 await f.engine.stopCall(call.callId);assert.equal(f.engine.active,owner);assert.equal(message.status,'running');assert.equal(f.store.state.workTasks.find(item=>item.id===record.id).turnId,owner.turnId);untouched(f);await f.finish(owner.turnId);assert.equal(message.status,'review');
});

test('a spoken handoff after a typed execution ends never attaches to its still-archiving owner',{timeout:10000},async t=>{
 const f=fixture(t),message=f.store.add({role:'user',text:'Finish the existing change'});f.engine.enqueue(message);await until(()=>f.engine.active?.startAcknowledged);const owner=f.engine.active;register(f,owner);const call=await f.engine.startCall(sdp);f.engine.confirmCallConnected(call.callId);let finishArchive,archiveStarted;const archiving=new Promise(resolve=>archiveStarted=resolve),files=new Promise(resolve=>finishArchive=resolve);f.engine.deliverables={archive:()=>{archiveStarted();return files;}};
 const finishing=f.finish(owner.turnId);await archiving;assert.equal(f.engine.active,owner);assert.equal(owner.finalStatus,'review');assert.ok(owner.finishing);
 await f.event('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:'new-after-completion',item_id:'next-spoken-request',input_transcript:'Now verify this other requested change',active_transcript:[]}});const session=f.voice.session,handoff=session.handoffs.get('new-after-completion');assert.equal(handoff.turnId,null,'an archiving old execution cannot accept new steering');assert.equal(session.turns.has(owner.turnId),false);
 await f.begin('new-spoken-work');assert.equal(handoff.turnId,'new-spoken-work');assert.equal(session.turns.has('new-spoken-work'),true);assert.equal(session.unknown,false);assert.equal(f.engine.active,owner);finishArchive([]);await finishing;assert.equal(f.engine.active,null);assert.equal(message.status,'review');assert.equal(f.voice.active.turnId,'new-spoken-work');untouched(f);await f.engine.stopCall(call.callId);await f.finish('new-spoken-work');untouched(f);
});

test('taking control after media reconnection pauses exact accepted work and keeps the current call connected',{timeout:10000},async t=>{
 const f=fixture(t),{session,turn,record}=await background(f),second=await f.engine.startCall(sdp);f.engine.confirmCallConnected(second.callId);const call=f.engine.call,stops=f.worker.calls.filter(entry=>entry.method==='thread/realtime/stop').length;assert.doesNotThrow(()=>f.engine.assertTakeoverCall());await f.engine.acquire();
 assert.equal(f.engine.takeover,true);assert.equal(f.engine.acquiring,false);assert.equal(f.engine.call,call);assert.equal(call.id,second.callId);assert.equal(call.status,'connected');assert.equal(f.voice.session,session);assert.equal(session.mediaId,second.callId);assert.equal(turn.done,true);assert.equal(turn.finalStatus,'paused');assert.equal(f.store.state.workTasks.find(item=>item.id===record.id).status,'paused');assert.deepEqual(f.worker.calls.filter(entry=>entry.method==='turn/interrupt').map(entry=>entry.params),[{threadId:'thread',turnId:turn.turnId}]);assert.equal(f.worker.calls.filter(entry=>entry.method==='thread/realtime/stop').length,stops);assert.equal(f.worker.terminated,0);f.engine.release();assert.equal(f.engine.takeover,false);assert.equal(f.engine.call,call);await f.engine.stopCall(second.callId);
});

test('stale old hangup cannot end replacement media and replacement hangup keeps the original native task',{timeout:10000},async t=>{
 const f=fixture(t),{call:first,session,turn,record}=await background(f),second=await f.engine.startCall(sdp);f.engine.confirmCallConnected(second.callId);const stops=f.worker.calls.filter(call=>call.method==='thread/realtime/stop').length;await assert.rejects(f.engine.stopCall(first.callId),/call changed/);assert.equal(f.engine.call.id,second.callId);assert.equal(f.worker.calls.filter(call=>call.method==='thread/realtime/stop').length,stops);
 await f.engine.stopCall(second.callId);assert.equal(f.engine.call,null);assert.equal(f.voice.session,session);assert.equal(f.voice.active.turnId,turn.turnId);assert.notEqual(f.store.state.workTasks.find(item=>item.id===record.id).status,'paused');assert.equal(f.store.state.messages.filter(item=>item.kind==='call').length,2);untouched(f);await f.finish(turn.turnId);assert.equal(f.store.state.workTasks.filter(item=>item.id===record.id).length,1);
});

test('model cancellation after media reconnection cancels the exact work without hanging up the new call',{timeout:10000},async t=>{
 const f=fixture(t),{turn,record}=await background(f),second=await f.engine.startCall(sdp);f.engine.confirmCallConnected(second.callId);const stops=f.worker.calls.filter(call=>call.method==='thread/realtime/stop').length;
 await f.event('item/tool/call',{turnId:turn.turnId,callId:'cancel-existing-task',tool:'task_cancel',arguments:{workId:record.id}},91);const response=f.worker.responses.find(item=>item.id===91);assert.equal(response.result.success,true);assert.equal(JSON.parse(response.result.contentItems[0].text).cancelRequested,true);await until(()=>f.store.state.workTasks.find(item=>item.id===record.id)?.status==='cancelled');assert.equal(f.engine.call.id,second.callId);assert.equal(f.engine.call.status,'connected');assert.equal(f.worker.calls.filter(call=>call.method==='thread/realtime/stop').length,stops);assert.equal(f.worker.calls.filter(call=>call.method==='turn/interrupt').length,1);assert.equal(f.worker.terminated,0);await f.engine.stopCall(second.callId);
});

test('an old end_call tool queued behind credentials cannot hang up replacement media, while a fresh tool can',{timeout:15000},async t=>{
 const f=fixture(t,{secure:true}),first=await f.engine.startCall(sdp);f.engine.confirmCallConnected(first.callId);await f.begin('queued-call-control');const session=f.voice.session,turn=session.turns.get('queued-call-control');register(f,turn);const pending=f.event('item/tool/call',{turnId:turn.turnId,callId:'blocking-login',tool:'credential_request',arguments:{name:'Existing login',service:'example.invalid',reason:'Continue accepted work'}},101);pending.catch(()=>{});await tick();const form=f.credentials.snapshot().requests[0];assert.ok(form);const oldEnd=f.event('item/tool/call',{turnId:turn.turnId,callId:'old-end-call',tool:'end_call',arguments:{}},102);oldEnd.catch(()=>{});
 await f.engine.stopCall(first.callId);const second=await f.engine.startCall(sdp);f.engine.confirmCallConnected(second.callId);const stops=f.worker.calls.filter(call=>call.method==='thread/realtime/stop').length;f.credentials.fulfill(form.id,{secret:'synthetic-media-control-secret'});await pending;await oldEnd;await tick();await tick();assert.ok(f.worker.responses.find(item=>item.id===102),'the delayed tool must settle instead of blocking its task');assert.equal(f.engine.call?.id,second.callId);assert.equal(f.engine.call.status,'connected');assert.equal(f.worker.calls.filter(call=>call.method==='thread/realtime/stop').length,stops);assert.equal(f.voice.session,session);assert.equal(session.turns.get(turn.turnId),turn);untouched(f);
 await f.event('item/tool/call',{turnId:turn.turnId,callId:'current-end-call',tool:'end_call',arguments:{}},103);assert.equal(f.worker.responses.find(item=>item.id===103).result.success,true);await until(()=>f.engine.call===null);assert.equal(f.worker.calls.filter(call=>call.method==='thread/realtime/stop').length,stops+1);assert.equal(f.voice.session,session);assert.equal(f.voice.active.turnId,turn.turnId);assert.equal(JSON.stringify(f.store.state).includes('synthetic-media-control-secret'),false);untouched(f);await f.finish(turn.turnId);
});

test('connected replacement media with a missing closed event preserves the known native task and recovery lock',{timeout:10000},async t=>{
 const f=fixture(t,{stopTimeoutMs:100}),{session,turn}=await background(f),second=await f.engine.startCall(sdp);f.engine.confirmCallConnected(second.callId);const before=structuredClone(f.store.state.workTasks);f.worker.emitClosed=false;
 await assert.rejects(f.engine.stopCall(second.callId),/confirm|closure/i);assert.equal(f.engine.call.id,second.callId);assert.equal(f.engine.call.status,'stop-unconfirmed');assert.equal(f.voice.session,session);assert.equal(session.unknown,false);assert.equal(session.turns.get(turn.turnId),turn);assert.equal(turn.done,false);assert.deepEqual(f.store.state.workTasks,before);untouched(f);
 f.worker.emitClosed=true;await f.engine.stopCall(second.callId);assert.equal(f.engine.call,null);assert.equal(f.voice.active.turnId,turn.turnId);assert.equal(session.unknown,false);const retry=await f.engine.startCall(sdp);await f.engine.stopCall(retry.callId);await f.finish(turn.turnId);untouched(f);
});

test('missing media closure cannot terminate or downgrade a borrowed typed executor owner',{timeout:10000},async t=>{
 const f=fixture(t,{stopTimeoutMs:100}),message=f.store.add({role:'user',text:'Keep completing the existing typed task'});f.engine.enqueue(message);await until(()=>f.engine.active?.startAcknowledged);const owner=f.engine.active;register(f,owner);const call=await f.engine.startCall(sdp);f.engine.confirmCallConnected(call.callId);const session=f.voice.session,before=structuredClone(f.store.state.workTasks);f.worker.emitClosed=false;
 await assert.rejects(f.engine.stopCall(call.callId),/confirm|closure/i);assert.equal(f.engine.call.id,call.callId);assert.equal(f.engine.call.status,'stop-unconfirmed');assert.equal(f.engine.active,owner);assert.equal(message.status,'running');assert.equal(owner.stopRequested,undefined);assert.equal(f.voice.session,session);assert.equal(session.unknown,false);assert.deepEqual(f.store.state.workTasks,before);untouched(f);
 f.worker.emitClosed=true;await f.engine.stopCall(call.callId);assert.equal(f.engine.call,null);assert.equal(f.engine.active,owner);assert.equal(message.status,'running');untouched(f);await f.finish(owner.turnId);
});

test('hanging up while reconnect acknowledgement is pending preserves accepted work and late acceptance cannot revive media',{timeout:15000},async t=>{
 const f=fixture(t,{secure:true}),{session,turn}=await background(f),pending=f.event('item/tool/call',{turnId:turn.turnId,callId:'login-during-reconnect',tool:'credential_request',arguments:{name:'Existing login',service:'example.invalid',reason:'Continue accepted work'}},111);pending.catch(()=>{});await tick();const form=f.credentials.snapshot().requests[0];assert.ok(form);const request=f.worker.request.bind(f.worker);let releaseAck,held=false;const lateAck=new Promise(resolve=>releaseAck=resolve);f.worker.request=(method,params)=>{const result=request(method,params);if(method==='thread/realtime/start'&&!held){held=true;return Promise.resolve(result).then(()=>lateAck);}return result;};
 const connecting=f.engine.startCall(sdp),rejected=assert.rejects(connecting,/could not be connected|closed|cancelled/i);await until(()=>held&&session.started&&session.answer);const reserved=f.engine.call.id;assert.equal(session.reconnecting,true);await f.engine.stopCall(reserved);await rejected;assert.equal(f.engine.call,null);assert.equal(f.voice.session,session);assert.equal(session.closed,true);assert.equal(session.background,true);assert.equal(session.mediaUnconfirmed,false);assert.equal(session.unknown,false);assert.equal(session.turns.get(turn.turnId),turn);assert.equal(f.credentials.snapshot().requests[0].id,form.id);untouched(f);
 releaseAck({});await tick();await tick();assert.equal(f.engine.call,null);assert.equal(session.unknown,false);assert.equal(session.mediaUnconfirmed,false);assert.equal(turn.done,false);f.credentials.fulfill(form.id,{secret:'synthetic-pending-ack-secret'});await pending;const retry=await f.engine.startCall(sdp);f.engine.confirmCallConnected(retry.callId);assert.notEqual(retry.callId,reserved);await f.engine.stopCall(retry.callId);await f.finish(turn.turnId);untouched(f);
});

test('an unexpected close after media reconnection detaches speech and keeps accepted native work running',{timeout:10000},async t=>{
 const f=fixture(t),{session,turn}=await background(f),second=await f.engine.startCall(sdp);f.engine.confirmCallConnected(second.callId);const before=structuredClone(f.store.state.workTasks);await f.event('thread/realtime/closed');await until(()=>f.engine.call===null);
 assert.equal(f.voice.session,session);assert.equal(f.voice.active.turnId,turn.turnId);assert.equal(turn.done,false);assert.equal(session.unknown,false);assert.deepEqual(f.store.state.workTasks,before);untouched(f);await f.finish(turn.turnId);
});

test('a replacement media error without confirmed closure cannot interrupt known work or terminate its executor',{timeout:10000},async t=>{
 const f=fixture(t,{stopTimeoutMs:100}),{session,turn}=await background(f),second=await f.engine.startCall(sdp);f.engine.confirmCallConnected(second.callId);const before=structuredClone(f.store.state.workTasks);f.worker.emitClosed=false;await f.event('thread/realtime/error',{message:'The audio transport failed'});await until(()=>f.engine.call?.status==='stop-unconfirmed');
 assert.equal(f.engine.call.id,second.callId);assert.equal(f.voice.session,session);assert.equal(session.unknown,false);assert.equal(turn.done,false);assert.equal(session.turns.get(turn.turnId),turn);assert.deepEqual(f.store.state.workTasks,before);untouched(f);f.worker.emitClosed=true;await f.engine.stopCall(second.callId);assert.equal(f.engine.call,null);assert.equal(f.voice.active.turnId,turn.turnId);untouched(f);await f.finish(turn.turnId);
});

for(const ownerKind of ['native','typed'])for(const failure of ['rejection','timeout','malformed'])test('confirmed media closure with '+failure+' history read preserves the '+ownerKind+' task until detach is verified',{timeout:10000},async t=>{
 const f=fixture(t,{stopTimeoutMs:100});let owner;
 if(ownerKind==='native')owner=(await background(f)).turn;
 else{const message=f.store.add({role:'user',text:'Keep completing the existing typed task'});f.engine.enqueue(message);await until(()=>f.engine.active?.startAcknowledged);owner=f.engine.active;register(f,owner);}
 const call=await f.engine.startCall(sdp);f.engine.confirmCallConnected(call.callId);const session=f.voice.session,before=structuredClone(f.store.state.workTasks),closed=f.worker.wire.filter(event=>event.method==='thread/realtime/closed').length,request=f.worker.request.bind(f.worker);let failHistory=true,releaseLateRead;
 f.worker.request=async(method,params)=>{if(method==='thread/read'&&failHistory){f.worker.calls.push({method,params});if(failure==='rejection')throw Error('Thread history is temporarily unavailable');if(failure==='malformed')return {thread:{id:'thread',status:{type:'active'},turns:null}};return new Promise(resolve=>releaseLateRead=resolve);}return request(method,params);};
 await assert.rejects(f.engine.stopCall(call.callId),/confirm|preserv|closure|unavailable/i);assert.equal(f.worker.wire.filter(event=>event.method==='thread/realtime/closed').length,closed+1,'the media actually closed before its history read failed');assert.equal(session.closed,true);assert.equal(f.worker.status,'online');assert.equal(f.worker.turns.get(owner.turnId),'inProgress');assert.equal(f.engine.call.id,call.callId);assert.equal(f.engine.call.status,'stop-unconfirmed');assert.equal(f.voice.session,session);assert.equal(session.unknown,false);assert.deepEqual(f.store.state.workTasks,before);
 if(ownerKind==='native'){assert.equal(session.turns.get(owner.turnId),owner);assert.equal(owner.done,false);}else{assert.equal(f.engine.active,owner);assert.equal(owner.stopRequested,undefined);assert.equal(f.engine.task(owner.messageId).status,'running');}untouched(f);
 failHistory=false;await f.engine.stopCall(call.callId);assert.equal(f.engine.call,null);assert.equal(session.unknown,false);const retry=await f.engine.startCall(sdp);f.engine.confirmCallConnected(retry.callId);
 if(releaseLateRead){releaseLateRead({thread:{id:'thread',status:{type:'active'},turns:[...f.worker.turns].map(([id,status])=>({id,status}))}});await tick();await tick();assert.equal(f.engine.call?.id,retry.callId,'the old timed-out history read cannot detach replacement media');assert.equal(f.engine.call.status,'connected');assert.deepEqual(f.store.state.workTasks,before);untouched(f);}
 await f.engine.stopCall(retry.callId);await f.finish(owner.turnId);untouched(f);
});
