import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {NativeRealtimeVoice,NATIVE_REALTIME_MODEL} from '../src/realtime.mjs';
import {CredentialVault,CredentialRequests} from '../src/credentials.mjs';
import {DANT_IDENTITY_INSTRUCTIONS} from '../src/identity.mjs';
import {ComputerSession} from '../src/computer-session.mjs';

const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
class FakeWorker extends EventEmitter{
 constructor(dir){super();this.status='online';this.workspaceRoot=path.join(dir,'workspaces');this.calls=[];this.responses=[];this.terminated=0;this.nextTurn=0;this.rpc={reply:(id,result)=>this.responses.push({id,result}),send:result=>this.responses.push(result)};}
 event(method,params={}){this.emit('event',{method,params:{threadId:'thread',...params}});}
 async request(method,params){
  this.calls.push({method,params});
  if(method==='thread/start')return {thread:{id:'thread'}};
  if(method==='thread/realtime/listVoices')return {voices:{v3:['ember','cove'],v2:['marin']}};
  if(method==='thread/realtime/start'){queueMicrotask(()=>{this.event('thread/realtime/started',{version:'v3',realtimeSessionId:'native-'+params.voiceSessionId});this.event('thread/realtime/sdp',{sdp});});return {};}
  if(method==='thread/realtime/stop'){queueMicrotask(()=>this.event('thread/realtime/closed'));return {};}
  if(method==='thread/read'){const turns=[...(this.engine?.nativeVoice?.session?.turns.values()||[])].map(turn=>({id:turn.turnId,status:turn.done?'completed':'inProgress'}));return {thread:{id:'thread',status:{type:turns.some(turn=>turn.status==='inProgress')?'active':'idle'},turns}};}
  if(method==='turn/start')return {turn:{id:'typed-'+ ++this.nextTurn}};
  if(method==='turn/interrupt'){queueMicrotask(()=>this.event('turn/completed',{turn:{id:params.turnId,status:'interrupted'}}));return {};}
  return {};
 }
 async terminateConfirmed(){this.terminated++;this.status='offline';this.emit('status');return {terminated:true};}
}
function setup(t,options={}){
 const dir=fs.mkdtempSync(path.join(base,'realtime-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),worker=new FakeWorker(dir),engine=new Engine(store,worker,options.engine);
 const voice=new NativeRealtimeVoice({worker,engine,connectTimeoutMs:1000,stopTimeoutMs:1000,...options.voice});worker.engine=engine;return {dir,store,worker,engine,voice};
}
const event=(method,params={},id)=>({method,params:{threadId:'thread',...params},...(id===undefined?{}:{id})});
const begin=(engine,id)=>engine.handle(event('turn/started',{turn:{id,status:'inProgress'}}));
const tool=(engine,id,name,args,requestId)=>engine.handle(event('item/tool/call',{turnId:id,callId:'call-'+requestId,tool:name,arguments:args},requestId));
const handoff=(id,patch={})=>event('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:id,item_id:'item-'+id,input_transcript:'Private spoken computer instruction',active_transcript:[],...patch}});
const liveReferences=worker=>worker.calls.filter(call=>call.method==='thread/realtime/appendText'&&call.params.text.includes('<dant_live_reference>'));

test('a valid server-managed handoff attaches to its announced turn without disconnecting the executor',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'delegated-turn');await engine.handle(handoff('delegated'));assert.equal(voice.session.unknown,false);
 await engine.handle(event('turn/completed',{turn:{id:'delegated-turn',status:'completed'}}));await engine.stopCall(call.callId);assert.equal(worker.terminated,0);assert.equal(worker.status,'online');assert.equal(voice.state.lastStop.executorStopped,false);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
});

test('a valid handoff preceding its announced turn is reconciled without submitting duplicate work',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await engine.handle(handoff('before-turn'));await begin(engine,'later-turn');assert.equal(voice.session.unknown,false);
 await engine.stopCall(call.callId);assert.equal(worker.terminated,0);assert.equal(worker.calls.filter(call=>call.method==='turn/interrupt').length,0);assert.equal(voice.active.turnId,'later-turn');assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
});

test('a valid handoff published after the routed turn completed does not poison hangup',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'fast-turn');await engine.handle(event('turn/completed',{turn:{id:'fast-turn',status:'completed'}}));await engine.handle(handoff('after-completion'));assert.equal(voice.session.unknown,false);
 await engine.stopCall(call.callId);assert.equal(worker.terminated,0);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
});

test('a completed task followed by its handoff still accepts the next typed message in the same call',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'fast-before-text');await engine.handle(event('turn/completed',{turn:{id:'fast-before-text',status:'completed'}}));await engine.handle(handoff('receipt-before-text'));
 const sent=await voice.message({clientMessageId:'after-fast-completion',text:'A fresh typed request'});assert.equal(sent.submission,'confirmed');assert.equal(sent.message.status,'accepted');assert.equal(sent.turnId,undefined);assert.equal(engine.call.id,call.callId);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('pause after a completed-task handoff proves live idle and keeps the call and executor connected',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);await begin(engine,'fast-before-pause');await engine.handle(event('turn/completed',{turn:{id:'fast-before-pause',status:'completed'}}));await engine.handle(handoff('receipt-before-pause'));
 const result=await engine.pause();assert.equal(result.paused,true);assert.deepEqual(result.turnIds,[]);assert.equal(engine.call.status,'connected');assert.equal(voice.session.unknown,false);assert.equal(worker.terminated,0);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('a stale live idle read cannot clear a newer receipt or submit the waiting typed task',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);let reply;await engine.handle(handoff('older-pending'));
 worker.request=(method,params)=>method==='thread/read'?new Promise(resolve=>reply=resolve):request(method,params);const sending=voice.message({clientMessageId:'stale-read-task',text:'Do not submit based on an older receipt'}),rejected=assert.rejects(sending,/waiting for its task/);await tick();await engine.handle(handoff('newer-pending'));reply({thread:{id:'thread',status:{type:'idle'},turns:[]}});await rejected;
 assert.equal(voice.session.handoffs.get('older-pending').idleConfirmed,true);assert.equal(voice.session.handoffs.get('newer-pending').idleConfirmed,undefined);assert.equal(voice.session.unknown,false);assert.equal(store.state.messages.length,0);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);worker.request=request;await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('server managed steering and duplicate handoffs stay scoped to one announced turn without retaining speech',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp),startupReads=worker.calls.filter(call=>call.method==='thread/read').length;await begin(engine,'steered-voice-turn');await engine.handle(handoff('first'));await engine.handle(handoff('second'));await engine.handle(handoff('first'));
 assert.equal(voice.session.handoffs.size,2);assert.ok([...voice.session.handoffs.values()].every(item=>item.turnId==='steered-voice-turn'));assert.equal(JSON.stringify([...voice.session.handoffs]).includes('Private spoken'),false);assert.equal(worker.calls.some(call=>['turn/start','turn/steer'].includes(call.method)),false);
 await engine.stopCall(call.callId);assert.equal(worker.terminated,0);assert.equal(worker.calls.filter(call=>call.method==='turn/interrupt').length,0);assert.equal(voice.active.turnId,'steered-voice-turn');assert.equal(worker.calls.filter(call=>call.method==='thread/read').length-startupReads,1);
});

test('an unannounced handoff blocks competing typed submission until its own announced turn arrives',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);worker.request=(method,params)=>method==='thread/read'&&voice.pendingHandoffs(voice.session)?Promise.resolve({thread:{id:'thread',status:{type:'active'},turns:[]}}):request(method,params);await engine.handle(handoff('pending'));
 assert.equal(voice.active.status,'running');await assert.rejects(voice.message({clientMessageId:'competing',text:'A different task'}),/waiting for its task/);assert.equal(store.state.messages.length,0);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
 await begin(engine,'pending-turn');await voice.message({clientMessageId:'correction-after-start',text:'A correction'});assert.equal(worker.calls.filter(call=>call.method==='turn/steer').length,0);assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('closing drains a handoff and continues its late announced accepted task',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);
 worker.request=(method,params)=>{if(method!=='thread/realtime/stop')return request(method,params);worker.calls.push({method,params});queueMicrotask(()=>{worker.event('turn/started',{turn:{id:'late-admitted',status:'inProgress'}});const raw=handoff('late-admission');worker.event(raw.method,raw.params);worker.event('thread/realtime/closed');});return Promise.resolve({});};
 await engine.stopCall(call.callId);assert.equal(engine.call,null);assert.equal(worker.terminated,0);assert.equal(voice.state.lastStop.executorStopped,false);assert.deepEqual(worker.calls.filter(call=>call.method==='turn/interrupt'),[]);assert.equal(voice.active.turnId,'late-admitted');assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
});

test('empty delegation receipts create no work, and foreign or previously closed call handoffs are ignored',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await engine.handle(handoff('empty',{input_transcript:''}));await engine.handle({...handoff('foreign'),params:{...handoff('foreign').params,threadId:'another-thread'}});await engine.handle({...handoff('old-session'),params:{...handoff('old-session').params,realtimeSessionId:'different-session'}});assert.equal(voice.session.handoffs.size,0);assert.equal(voice.session.unknown,false);
 await begin(engine,'first-call-turn');await engine.handle(handoff('known-old'));await engine.stopCall(call.callId);assert.equal(worker.terminated,0);await engine.pause();const next=await engine.startCall(sdp);await engine.handle(handoff('known-old'));assert.equal(voice.session.handoffs.size,0);assert.equal(voice.session.unknown,false);await engine.stopCall(next.callId);assert.equal(worker.terminated,0);
});

test('malformed handoffs and conflicting duplicate identities retain confirmed executor termination',async t=>{
 for(const patch of [{handoff_id:''},{item_id:'bad id'},{handoff_id:'x'.repeat(257)},{input_transcript:7},{active_transcript:null},{active_transcript:[{}]},{active_transcript:[null]},{item_id:undefined}]){
  const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'guarded-turn');await engine.handle(handoff('invalid',patch));assert.equal(voice.session.unknown,true);await engine.stopCall(call.callId);assert.equal(worker.terminated,1);assert.equal(voice.state.lastStop.confirmed,true);
 }
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'conflict-turn');await engine.handle(handoff('conflict'));await engine.handle(handoff('conflict',{item_id:'different-item'}));assert.equal(voice.session.unknown,true);await engine.stopCall(call.callId);assert.equal(worker.terminated,1);
});

test('completed-before-receipt and valid no-task handoffs require explicit live idle after closed',async t=>{
 for(const status of ['idle','notLoaded','systemError','active',undefined]){
  const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));await engine.handle(handoff('valid-no-task'));
  assert.equal(voice.session.unknown,false);assert.equal(voice.pendingHandoffs(voice.session),true);worker.request=(method,params)=>method==='thread/read'?Promise.resolve({thread:{id:'thread',...(status?{status:{type:status}}:{}),turns:[]}}):request(method,params);
  await engine.stopCall(call.callId);assert.equal(worker.terminated,status==='idle'?0:1);assert.equal(diagnostics.some(entry=>entry.code==='voice_handoff_confirmed'),status==='idle');
 }
});

test('whitespace input and valid transcript-only handoffs are tracked and confirmed without saving speech',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));await begin(engine,'transcript-turn');await engine.handle(handoff('whitespace',{input_transcript:' '}));await engine.handle(handoff('transcript-only',{input_transcript:'',active_transcript:[{role:'user',text:'Private transcript reference'}]}));
 await engine.stopCall(call.callId);assert.equal(worker.terminated,0);assert.equal(store.state.messages.length,0);assert.deepEqual(diagnostics.map(entry=>entry.code),['voice_handoff_tracked','voice_handoff_tracked','voice_handoff_confirmed','voice_shutdown']);assert.equal(diagnostics.find(entry=>entry.code==='voice_handoff_confirmed').count,2);assert.equal(JSON.stringify(diagnostics).includes('Private'),false);
});

test('a live thread snapshot can acknowledge an owned completed turn before its terminal notification arrives',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);await begin(engine,'already-terminal');await engine.handle(handoff('terminal-proof'));worker.request=(method,params)=>method==='thread/read'?Promise.resolve({thread:{id:'thread',status:{type:'idle'},turns:[{id:'already-terminal',status:'completed'}]}}):request(method,params);
 await engine.stopCall(call.callId);assert.equal(worker.terminated,0);assert.equal(worker.calls.some(call=>call.method==='turn/interrupt'),false);assert.equal(voice.state.lastStop.executorStopped,false);await engine.handle(event('turn/completed',{turn:{id:'already-terminal',status:'completed'}}));assert.equal(engine.call,null);
});

test('a stalled or late reconciliation cannot unlock before termination or mutate a later call',async t=>{
 const {engine,voice,worker,store}=setup(t,{voice:{stopTimeoutMs:15}}),call=await engine.startCall(sdp),request=worker.request.bind(worker);let reply;
 await begin(engine,'reconciliation-timeout');await engine.handle(handoff('slow-proof'));worker.request=(method,params)=>method==='thread/read'?new Promise(resolve=>reply=resolve):request(method,params);
 await engine.stopCall(call.callId);assert.equal(worker.terminated,1);assert.equal(voice.state.lastStop.confirmed,true);const history=JSON.stringify(store.state.messages);reply({thread:{id:'thread',status:{type:'idle'},turns:[{id:'reconciliation-timeout',status:'completed'}]}});await tick();assert.equal(JSON.stringify(store.state.messages),history);assert.equal(worker.calls.some(call=>call.method==='turn/interrupt'),false);
});

test('handoff ledger stays bounded and unresolved or invalid authoritative snapshots cannot unlock work',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'limited-turn');for(let index=0;index<129;index++)await engine.handle(handoff('handoff-'+index));assert.equal(voice.session.handoffs.size,128);assert.equal(voice.session.unknown,true);await engine.stopCall(call.callId);assert.equal(worker.terminated,1);
 for(const snapshot of [{thread:{id:'foreign-thread',turns:[]}},{thread:{id:'thread',turns:null}},{thread:{id:'thread',turns:[{id:'known-turn',status:'inProgress'},{id:'known-turn',status:'inProgress'}]}},{thread:{id:'thread',turns:[{id:'known-turn',status:'unexpected'}]}},{thread:{id:'thread',turns:[{id:'unknown-active',status:'inProgress'}]}},{thread:{id:'thread',turns:[]}}]){
  const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);await begin(engine,'known-turn');await engine.handle(handoff('snapshot-validation'));worker.request=(method,params)=>method==='thread/read'?Promise.resolve(snapshot):request(method,params);await engine.stopCall(call.callId);assert.equal(worker.terminated,1);assert.equal(voice.state.lastStop.confirmed,true);
 }
});

test('subscription uses exact V3 WebRTC RPC and counts only confirmed connected calls',async t=>{
 const {store,worker,engine,voice}=setup(t);assert.deepEqual((await voice.listVoices()).voices.v3,['ember','cove']);
 const result=await engine.startCall(sdp),request=worker.calls.find(call=>call.method==='thread/realtime/start');
 assert.equal(result.provider,'subscription');assert.equal(request.params.version,'v3');assert.equal(request.params.model,NATIVE_REALTIME_MODEL);assert.equal(request.params.voice,'ember');assert.deepEqual(request.params.transport,{type:'webrtc',sdp});assert.equal(engine.call.status,'negotiating');
 assert.equal(store.state.messages.filter(message=>message.kind==='call').length,0);
 await assert.rejects(engine.stopCall('old-call'),/changed/);assert.throws(()=>engine.confirmCallConnected('old-call'),/changed/);
 const connected=engine.confirmCallConnected(result.callId);assert.equal(engine.call.status,'connected');assert.equal(connected.connectedAt,engine.call.connectedAt);assert.equal(engine.confirmCallConnected(result.callId).connectedAt,connected.connectedAt);engine.call.connectedAt-=2100;
 await engine.stopCall(result.callId);assert.equal(engine.call,null);assert.equal(voice.call,null);assert.equal(worker.terminated,0);
 const records=store.state.messages.filter(message=>message.kind==='call');assert.equal(records.length,1);assert.equal(records[0].provider,'subscription');assert.equal(records[0].seconds,2);assert.equal(records[0].text,'');
});

test('native startup receives the same full sanitized memory and records the speech tail before releasing its thread',async t=>{
 const {engine,voice,worker,store}=setup(t),memory='Shared preference 中文😀 '.repeat(1800)+'SHARED_MEMORY_TAIL\nsk-fake_reference_token_do_not_use';engine.memory.write('working-memory.md',memory);const conversation=store.state.conversationId,call=await engine.startCall(sdp),start=worker.calls.find(item=>item.method==='thread/realtime/start');assert.equal(start.params.flushTranscriptTailOnSessionEnd,true);
 const reference=JSON.parse(start.params.prompt.split('<dant_shared_memory>\n')[1].split('\n</dant_shared_memory>')[0]);assert.equal(reference.memory,engine.memory.context());assert.ok(reference.memory.includes('SHARED_MEMORY_TAIL'));assert.equal(start.params.prompt.includes('sk-fake_reference_token_do_not_use'),false);assert.equal(start.params.threadId,'thread');assert.equal(worker.calls.some(item=>item.method==='thread/realtime/appendText'),false,'Codex owns native startup history without a redundant full-history replay');
 await engine.handle(event('thread/realtime/transcriptDone',{role:'user',text:'Synthetic spoken fact stays in model history, not a visible chat message'}));const request=worker.request.bind(worker);let persisted=false,release;worker.request=(method,params)=>{if(method!=='thread/realtime/stop')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>release=()=>{persisted=true;worker.event('thread/realtime/closed');resolve({});});};const stopping=engine.stopCall(call.callId);await tick();assert.ok(engine.call);assert.equal(persisted,false);release();await stopping;assert.equal(persisted,true);assert.equal(engine.call,null);assert.equal(store.state.messages.length,0);assert.equal(worker.terminated,0);assert.equal(store.state.conversationId,conversation);assert.equal(store.state.threadId,'thread');assert.equal(worker.calls.filter(item=>item.method==='thread/start').length,1);assert.equal(worker.calls.some(item=>['turn/start','turn/steer'].includes(item.method)),false);assert.equal(voice.state.lastStop.executorStopped,false);
});

test('native startup retains Codex default history context and returns its acknowledged SDP without replaying history',async t=>{
 const {engine,voice,worker,store}=setup(t),memory='Current shared memory 中文😀 '.repeat(1800)+'MEMORY_TAIL',request=worker.request.bind(worker);let accept,returned=false;
 worker.request=(method,params)=>{if(method==='thread/realtime/start'){worker.calls.push({method,params});queueMicrotask(()=>worker.event('thread/realtime/started',{version:'v3'}));return new Promise(resolve=>accept=resolve);}if(method==='thread/realtime/appendText')throw Error('Native startup must not replay full history');return request(method,params);};
 const starting=voice.start({sdp,memory}).then(result=>{returned=true;return result;});await tick();assert.equal(returned,false);accept({});await tick();assert.equal(returned,false,'start acknowledgement alone is not an SDP-ready session');worker.event('thread/realtime/sdp',{sdp});const call=await starting;assert.equal(call.sdp,sdp);assert.equal(engine.call.status,'negotiating');
 const start=worker.calls.find(item=>item.method==='thread/realtime/start');assert.ok(start.params.prompt.startsWith(DANT_IDENTITY_INSTRUCTIONS+'\n\n'));assert.equal(JSON.parse(start.params.prompt.split('<dant_shared_memory>\n')[1].split('\n</dant_shared_memory>')[0]).memory,memory);assert.equal(Object.hasOwn(start.params,'includeStartupContext'),false,'the executor chooses its own startup history policy');assert.equal(voice.session.contextQueue,undefined);assert.equal(store.state.messages.length,0);assert.equal(worker.calls.filter(item=>item.method==='thread/start').length,1);assert.equal(worker.calls.some(item=>['turn/start','turn/steer','thread/inject_items'].includes(item.method)),false);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('native live memory snapshots replace unsent snapshots in the same owned reference queue without chat tasks',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker),baseline=worker.calls.length;let acknowledge;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return acknowledge?Promise.resolve({}):new Promise(resolve=>acknowledge=resolve);};
 const first=voice.syncMemory({memory:'Earlier memory',callId:call.callId});await tick();const middle=voice.syncMemory({memory:'Unsent obsolete memory',callId:call.callId}),latest='Latest memory 中文😀 '.repeat(1000)+'CURRENT_MEMORY_TAIL',last=voice.syncMemory({memory:latest,callId:call.callId});assert.equal((await middle).status,'superseded');assert.equal((await voice.syncMemory({memory:'Wrong call',callId:'other'})).status,'cancelled');acknowledge({});assert.deepEqual((await Promise.all([first,last])).map(item=>item.status),['submitted','submitted']);const calls=worker.calls.slice(baseline).filter(item=>item.method==='thread/realtime/appendText');assert.equal(calls.length,2);assert.ok(calls.every(item=>item.params.threadId==='thread'));assert.equal(JSON.parse(calls[1].params.text.split('<dant_shared_memory>\n')[1].split('\n</dant_shared_memory>')[0]).memory,latest);assert.match(calls[1].params.text,/replaces earlier memory snapshots/);assert.match(calls[1].params.text,/not new work/);assert.equal(store.state.messages.length,0);assert.equal(worker.calls.some(item=>['turn/start','turn/steer'].includes(item.method)),false);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('native uncertain or cancelled memory delivery never retries or crosses into another call',async t=>{
 const {engine,voice,worker,store}=setup(t,{voice:{contextTimeoutMs:10}}),call=await engine.startCall(sdp),request=worker.request.bind(worker);let late;const delayed=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>late=resolve);};worker.request=delayed;const baseline=worker.calls.length;assert.equal((await voice.syncMemory({memory:'Unconfirmed',callId:call.callId})).status,'unknown');assert.equal((await voice.syncMemory({memory:'Do not retry',callId:call.callId})).status,'unknown');late({});await tick();assert.equal(worker.calls.slice(baseline).filter(item=>item.method==='thread/realtime/appendText').length,1);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
 voice.contextTimeoutMs=1000;worker.request=request;const next=await engine.startCall(sdp);worker.request=delayed;const nextBaseline=worker.calls.length,pending=voice.syncMemory({memory:'In flight',callId:next.callId});await tick();const queued=voice.syncMemory({memory:'Queued old memory',callId:next.callId});await engine.stopCall(next.callId);assert.deepEqual((await Promise.all([pending,queued])).map(item=>item.status),['cancelled','cancelled']);worker.request=request;const third=await engine.startCall(sdp);late({});await tick();assert.equal(worker.calls.slice(nextBaseline).filter(item=>item.method==='thread/realtime/appendText').length,1,'only the old in-flight memory was sent; the queued old snapshot cannot cross calls');assert.equal((await voice.syncMemory({memory:'Old owner',callId:next.callId})).status,'cancelled');assert.equal(store.state.messages.length,0);assert.equal((await voice.syncMemory({memory:'Fresh current memory',callId:third.callId})).status,'submitted');await engine.stopCall(third.callId);assert.equal(worker.terminated,0);
});

test('typed native call messages stay in the current voice session without replaying finalized speech or creating a chat task',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),spoken='Spoken context 中文😀 '.repeat(1500)+'HIDDEN_SPOKEN_TAIL',answer='Assistant spoken answer';
 await engine.handle(event('thread/realtime/transcript/done',{role:'user',text:spoken}));await engine.handle(event('thread/realtime/transcript/done',{role:'assistant',text:answer}));assert.equal(store.state.messages.length,0);await voice.message({clientMessageId:'spoken-reference-task',text:'Recall what I just said aloud.',callId:call.callId});
 await engine.handle(event('thread/realtime/transcript/done',{role:'user',text:'Another spoken fact'}));await voice.message({clientMessageId:'spoken-reference-steer',text:'Use the latest spoken fact too.',callId:call.callId});const inputs=worker.calls.filter(item=>item.method==='thread/realtime/appendText');assert.equal(inputs.length,2);assert.ok(inputs.every(item=>item.params.text.includes('<dant_call_input>')));assert.equal(inputs.some(item=>item.params.text.includes('HIDDEN_SPOKEN_TAIL')||item.params.text.includes(answer)),false);assert.equal(worker.calls.some(item=>['turn/start','turn/steer'].includes(item.method)),false);assert.equal(worker.calls.filter(item=>item.method==='thread/inject_items').length,2);assert.equal(store.state.messages.some(item=>item.text.includes('HIDDEN_SPOKEN_TAIL')||item.text===answer),false);assert.equal(JSON.stringify(voice.state).includes('HIDDEN_SPOKEN_TAIL'),false);const session=voice.session;await engine.stopCall(call.callId);assert.deepEqual(session.spokenContext,[]);assert.equal(worker.terminated,0);
});

test('native call input never replays private speech and quotes only redacted authoritative message context',async t=>{
 const {dir,engine,voice,worker,store}=setup(t),vault=new CredentialVault({dataDir:dir}),secret='synthetic-secret-crossing-finalized-parts';vault.upsert({name:'Synthetic test credential',service:'test.invalid',username:'fixture',secret});engine.credentials=new CredentialRequests({vault});const call=await engine.startCall(sdp),session=voice.session;
 for(const params of [{threadId:'foreign-thread',role:'user',text:'wrong-thread'},{realtimeSessionId:'foreign-session',role:'user',text:'wrong-session'},{callId:'foreign-call',role:'user',text:'wrong-call'},{role:'system',text:'wrong-role'},{role:'user',text:42},{role:'user',text:''}])await engine.handle(event('thread/realtime/transcript/done',params));
 await engine.handle(event('thread/realtime/transcript/done',{role:'user',text:secret.slice(0,17)}));await engine.handle(event('thread/realtime/transcript/done',{role:'user',text:secret.slice(17)}));await engine.handle(event('thread/realtime/transcript/done',{role:'assistant',text:'Acknowledged'}));for(let n=0;n<2;n++)await engine.handle(event('thread/realtime/transcript/done',{role:'user',text:'A repeated real utterance'}));assert.equal(session.spokenContext.filter(item=>item.text==='A repeated real utterance').length,2);assert.equal(session.spokenContext.some(item=>item.text.includes('wrong-')),false);
 const reply=store.add({role:'assistant',text:'A referenced answer containing '+secret});await voice.message({clientMessageId:'redacted-spoken-context',text:'Use this context.',replyTo:reply.id,callId:call.callId});const input=worker.calls.find(item=>item.method==='thread/realtime/appendText').params.text;assert.equal(input.includes(secret),false);assert.match(input,/credential redacted/);assert.equal(input.includes('A repeated real utterance'),false);assert.equal(store.state.messages.length,2);
 const request=worker.request.bind(worker);let release;worker.request=(method,params)=>method==='thread/realtime/stop'?new Promise(resolve=>release=()=>{worker.event('thread/realtime/closed');resolve({});}):request(method,params);const stopping=engine.stopCall(call.callId);await tick();const before=session.spokenContext.length;await engine.handle(event('thread/realtime/transcript/done',{role:'user',text:'during-stop'}));assert.equal(session.spokenContext.length,before);release();await stopping;assert.deepEqual(session.spokenContext,[]);worker.request=request;await engine.pause();const next=await engine.startCall(sdp);await engine.handle(event('thread/realtime/transcript/done',{realtimeSessionId:'native-'+call.callId,role:'user',text:'old-call'}));assert.deepEqual(voice.session.spokenContext,[]);await engine.stopCall(next.callId);assert.equal(worker.terminated,0);
});

test('native subscription startup anchors the same assistant identity for English and Chinese without reversing live chat roles',async t=>{
 for(const language of ['en','zh']){
  const {engine,voice,worker,store}=setup(t);store.state.settings.language=language;const human=store.add({role:'user',text:language==='zh'?'你是谁？我没有告诉过你我的姓名。':'Who are you? I have not supplied my name.',status:'review'}),assistant=store.add({role:'assistant',text:language==='zh'?'我是 dant，你的数字伙伴。':"I'm dant, your digital coworker.",status:'completed'});
  const conversation=store.state.conversationId,call=await engine.startCall(sdp),request=worker.calls.find(item=>item.method==='thread/realtime/start');
  assert.ok(request.params.realtimeStartInstructions.startsWith(DANT_IDENTITY_INSTRUCTIONS+'\n\n'));assert.ok(request.params.prompt?.startsWith(DANT_IDENTITY_INSTRUCTIONS+'\n\n'),'the actual voice-model prompt must bind dant to the assistant, independently of backend mode instructions');
  assert.match(request.params.prompt,/dant_spoken_reference data uses its explicit inner speaker role/);assert.match(request.params.prompt,/transport-user wrapper does not turn quoted assistant speech into human speech/);
  assert.match(request.params.prompt,/\[USER\].*human/);assert.match(request.params.prompt,/\[BACKEND\].*backend/);assert.match(request.params.prompt,/delegate to the backend immediately using native delegation/);assert.match(request.params.prompt,/Do not merely promise or narrate/);assert.match(request.params.prompt,/Only the backend can run computer tools or call send_message, send_file, and end_call/);assert.match(request.params.prompt,/Wait for a successful backend result before saying an action or delivery succeeded/);assert.match(request.params.prompt,/Current dant_call_input messages are the human typing into this same call/);assert.match(request.params.prompt,/never delegate or execute those references as another request/);assert.match(request.params.prompt,/Do not copy speech transcripts into chat/);
  assert.notEqual(request.params.includeStartupContext,false);assert.equal(request.params.threadId,'thread');assert.equal(request.params.clientManagedHandoffs,false);assert.equal(request.params.flushTranscriptTailOnSessionEnd,true);
  for(const message of [human,assistant]){const result=await voice.syncContext({kind:'message',message,callId:call.callId});assert.equal(result.status,'submitted');}
  const contexts=liveReferences(worker).map(item=>{assert.equal(item.params.threadId,'thread');const json=item.params.text.split('<dant_live_reference>\n')[1].split('\n</dant_live_reference>')[0];return JSON.parse(json);});assert.deepEqual(contexts.map(item=>item.role),['user','assistant']);assert.deepEqual(contexts.map(item=>item.messageId),[human.id,assistant.id]);assert.equal(worker.calls.some(item=>['turn/start','turn/steer'].includes(item.method)),false);assert.equal(store.state.conversationId,conversation);assert.deepEqual(store.state.messages.map(item=>item.role),['user','assistant']);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
 }
});

test('started and SDP events preceding the start acknowledgement are retained',async t=>{
 const {worker,engine}=setup(t);let acknowledge;const request=worker.request.bind(worker);
 worker.request=(method,params)=>{if(method!=='thread/realtime/start')return request(method,params);worker.calls.push({method,params});worker.event('thread/realtime/started',{version:'v3'});worker.event('thread/realtime/sdp',{sdp});return new Promise(resolve=>acknowledge=resolve);};
 let returned=false;const starting=engine.startCall(sdp).then(result=>{returned=true;return result;});await tick();assert.equal(returned,false);assert.ok(engine.call);acknowledge({});const call=await starting;assert.equal(call.sdp,sdp);await engine.stopCall(call.callId);
});

test('negotiation close has no call record and never falls back to API billing',async t=>{
 const {store,engine}=setup(t);let apiStarts=0;engine.voice={start:()=>{apiStarts++;throw Error('unexpected API fallback');}};
 const result=await engine.startCall(sdp);await engine.stopCall(result.callId);assert.equal(apiStarts,0);assert.equal(store.state.messages.length,0);
});

test('native owns only its thread and announced background turns; speech is ephemeral',async t=>{
 const {store,worker,engine}=setup(t);const call=await engine.startCall(sdp);assert.equal(engine.active,null);
 await engine.handle(event('thread/realtime/transcriptDone',{role:'user',text:'private speech'}));
 await engine.handle(event('item/completed',{turnId:'other-turn',item:{id:'foreign',type:'agentMessage',text:'wrong thread'},threadId:'other-thread'}));
 await begin(engine,'background');
 await engine.handle(event('item/agentMessage/delta',{turnId:'background',itemId:'speech',delta:'Do not store my transcript'}));
 await tool(engine,'background','send_message',{text:'Requested useful link'},1);
 await engine.handle(event('turn/completed',{turn:{id:'background',status:'completed'}}));
 assert.deepEqual(store.state.messages.map(message=>message.text),['Requested useful link']);assert.equal(worker.responses.find(response=>response.id===1).result.success,true);
 await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('background file delivery archives only explicit output and never duplicates final archive',async t=>{
 const collector=new EventEmitter(),captures=[],archives=[];collector.captureBaseline=async args=>{captures.push(args);return 'baseline';};collector.archive=async args=>{archives.push(args);return [{id:'file',name:'result.wav',sha256:'hash'}];};
 const {store,engine,worker}=setup(t,{engine:{deliverables:collector}}),call=await engine.startCall(sdp);await begin(engine,'background');
 worker.createVoiceMessage=async ({text,outputDir})=>{assert.equal(text,'Hello');assert.equal(outputDir,engine.outputDir);return {path:path.join(outputDir,'result.wav')};};
 await tool(engine,'background','create_voice_message',{text:'Hello'},1);await engine.handle(event('turn/completed',{turn:{id:'background',status:'completed'}}));
 assert.equal(captures.length,1);assert.equal(archives[0].onlyExplicit,true);assert.equal(archives[0].baseline,'baseline');assert.equal(worker.responses[0].result.success,true);assert.equal(store.state.messages.flatMap(message=>message.attachments||[]).length,1);
 await engine.stopCall(call.callId);
});

test('normal work stays paused and takeover waits for established native media',async t=>{
 const {store,worker,engine}=setup(t),call=await engine.startCall(sdp),message=store.add({role:'user',text:'Later task'});engine.enqueue(message);assert.equal(message.status,'paused');assert.equal(message.pauseReason,'voice-call');await assert.rejects(engine.acquire(),/Wait for the voice call/);
 await engine.stopCall(call.callId);await tick();assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);assert.equal(message.status,'paused');
});

test('desktop takeover pauses actual native work while retaining speech and storing typed control context without execution',async t=>{
 const {store,worker,engine,voice}=setup(t),call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);const sent=await voice.message({clientMessageId:'manual-login-task',text:'Open the login page'});await begin(engine,'manual-login-work');const session=voice.session,liveCall=engine.call;
 const lease=[];worker.guest=async(route,body)=>{lease.push({route,...body});return Response.json({status:body.action==='release'?'dant':body.action==='acquire'?'taking-over':'human',sessionId:body.action==='release'?null:'human-lease',expiresAt:Date.now()+120000});};const computer=new ComputerSession(engine,worker);t.after(()=>computer.close());const taken=await computer.acquire();
 assert.equal(taken.status,'human');assert.equal(engine.takeover,true);assert.equal(voice.session,session);assert.equal(engine.call,liveCall);assert.equal(engine.call.status,'connected');assert.equal(sent.message.status,'accepted');assert.equal(session.turns.get('manual-login-work').finalStatus,'paused');assert.equal(worker.terminated,0);assert.deepEqual(worker.calls.filter(entry=>entry.method==='turn/interrupt').map(entry=>entry.params),[{threadId:'thread',turnId:'manual-login-work'}]);assert.equal(worker.calls.some(entry=>entry.method==='thread/realtime/stop'),false);
 const paused=await voice.message({clientMessageId:'typed-while-manual',text:'I am entering the password myself'});assert.equal(paused.message.status,'paused');assert.equal(paused.message.pauseReason,'human-control');assert.equal(paused.voiceContext.status,'submitted');assert.equal(liveReferences(worker).at(-1).params.text.includes('I am entering the password myself'),true);await computer.input({sessionId:taken.sessionId,type:'key',key:'Tab'});await computer.release(taken.sessionId);await tick();assert.equal(engine.takeover,false);assert.equal(engine.call,liveCall);assert.equal(voice.session,session);assert.equal(paused.message.status,'paused');
 const fresh=await voice.message({clientMessageId:'continue-after-manual',text:'I have finished. Continue now.'});assert.equal(fresh.message.status,'accepted');assert.equal(worker.calls.some(entry=>['turn/start','turn/steer'].includes(entry.method)),false);assert.equal(store.state.messages.some(message=>message.id===sent.message.id),true);await engine.pause();await engine.stopCall(call.callId);assert.deepEqual(lease.filter(entry=>entry.route==='/control').map(entry=>entry.action),['acquire','confirm','release']);
});

test('new native spoken work is interrupted during human control without closing media or replaying late admissions',async t=>{
 const {worker,engine,voice}=setup(t),call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);await engine.acquire();const session=voice.session;
 await begin(engine,'while-held');await tick();await engine.handle(handoff('held-receipt'));await session.eventChain;
 assert.equal(session.turns.get('while-held').done,true);assert.equal(session.turns.get('while-held').pauseRequested,true);assert.equal(engine.takeover,true);assert.equal(engine.call.id,call.callId);assert.equal(engine.call.status,'connected');
 await engine.handle(handoff('late-held-receipt'));assert.equal(session.handoffs.get('late-held-receipt').humanControl,true);engine.release();
 await begin(engine,'late-after-return');await tick();await session.eventChain;
 assert.equal(session.turns.get('late-after-return').done,true);assert.equal(session.turns.get('late-after-return').pauseRequested,true);assert.equal(engine.call.status,'connected');assert.equal(worker.terminated,0);
 assert.deepEqual(worker.calls.filter(entry=>entry.method==='turn/interrupt').map(entry=>entry.params.turnId),['while-held','late-after-return']);assert.equal(worker.calls.some(entry=>entry.method==='thread/realtime/stop'||entry.method==='turn/start'||entry.method==='turn/steer'),false);await engine.stopCall(call.callId);
});

test('native ownership uncertainty blocks takeover before requesting a guest lease',async t=>{
 const {worker,engine,voice}=setup(t),call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);const guest=[];worker.guest=async(route,body)=>{guest.push({route,body});throw Error('Must not reach guest');};const computer=new ComputerSession(engine,worker);t.after(()=>computer.close());
 for(const patch of [{unknown:true},{stopping:true},{closed:true},{submitting:{}},{pausing:true},{background:true},{status:'negotiating'}]){
  const previous=Object.fromEntries(Object.keys(patch).map(key=>[key,voice.session[key]]));Object.assign(voice.session,patch);await assert.rejects(computer.acquire(),/Wait for the voice call/);Object.assign(voice.session,previous);assert.equal(engine.takeover,false);assert.equal(engine.acquiring,false);
 }
 await engine.handle(handoff('unresolved-before-takeover'));await assert.rejects(computer.acquire(),/Wait for the voice call/);assert.deepEqual(guest,[]);await engine.stopCall(call.callId);
});

test('takeover never grants ownership after the captured call changes while its task pauses',async t=>{
 const {worker,engine,voice}=setup(t),call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);await begin(engine,'pause-before-call-change');const request=worker.request.bind(worker);let interrupt;
 worker.request=(method,params)=>method==='turn/interrupt'?new Promise(resolve=>interrupt=()=>{worker.event('turn/completed',{turn:{id:params.turnId,status:'interrupted'}});resolve({});}):request(method,params);
 const taking=engine.acquire(),rejected=assert.rejects(taking,/voice call changed/);while(!interrupt)await tick();engine.call=null;interrupt();await rejected;assert.equal(engine.takeover,false);assert.equal(engine.acquiring,false);assert.equal(voice.session.unknown,false);assert.equal(worker.terminated,0);engine.call={id:call.callId,provider:'subscription',connectedAt:123,status:'connected'};await engine.stopCall(call.callId);
});

test('connected API media survives matched task pause and blocks new computer work until explicit return',async t=>{
 const {engine,worker}=setup(t),call={id:'api-live',provider:'api',status:'connected',connectedAt:123};engine.call=call;let mediaStops=0;engine.voice={call:{callId:call.id,status:'active'},async stop(){mediaStops++;}};
 const task=engine.runVoiceTask('Open the sign-in screen'),paused=assert.rejects(task,/paused/);await tick();const turnId=engine.active.turnId;await engine.acquire();await paused;
 assert.equal(engine.takeover,true);assert.equal(engine.call,call);assert.equal(mediaStops,0);assert.deepEqual(worker.calls.filter(entry=>entry.method==='turn/interrupt').map(entry=>entry.params),[{threadId:'thread',turnId}]);await assert.rejects(engine.runVoiceTask('Do not run while I type'),/Return the desktop/);
 engine.release();await tick();assert.equal(engine.call,call);assert.equal(worker.calls.filter(entry=>entry.method==='turn/start').length,1);assert.equal(worker.terminated,0);engine.voice.call.status='stopping';await assert.rejects(engine.acquire(),/Wait for the voice call/);assert.equal(engine.takeover,false);
});

test('explicit safety stop waits for a known background turn interrupt completion before release',async t=>{
 const {worker,engine}=setup(t),call=await engine.startCall(sdp);await begin(engine,'background');let interrupt;
 const request=worker.request.bind(worker);worker.request=(method,params)=>{if(method!=='turn/interrupt')return request(method,params);interrupt=params;return Promise.resolve({});};
 let ended=false;const stopping=engine.stopCall(call.callId,{continueWork:false}).then(()=>ended=true);await tick();assert.ok(interrupt);assert.equal(ended,false);assert.ok(engine.call);
 await engine.handle(event('turn/completed',{turn:{id:'background',status:'interrupted'}}));await stopping;assert.equal(engine.call,null);assert.equal(worker.terminated,0);
});

test('unknown background handoff rejects effects and confirms process termination before unlock',async t=>{
 const {store,worker,engine}=setup(t),call=await engine.startCall(sdp);await tool(engine,'unannounced','send_message',{text:'must not be sent'},1);assert.equal(store.state.messages.length,0);assert.ok(worker.responses[0].error);
 let confirm;worker.terminateConfirmed=()=>new Promise(resolve=>confirm=resolve);let ended=false;const stopping=engine.stopCall(call.callId).then(()=>ended=true);await tick();assert.ok(confirm);assert.equal(ended,false);assert.ok(engine.call);
 confirm({terminated:true});await stopping;assert.equal(engine.call,null);assert.equal(engine.loaded,false);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
});

test('missing closed confirmation terminates executor and failed termination retains the call lock',async t=>{
 const {worker,engine,voice}=setup(t,{voice:{stopTimeoutMs:10}}),call=await engine.startCall(sdp);const request=worker.request.bind(worker);worker.request=(method,params)=>method==='thread/realtime/stop'?Promise.resolve({}):request(method,params);
 worker.terminateConfirmed=async()=>{throw Error('Actual process exit not confirmed');};await assert.rejects(engine.stopCall(call.callId),/not confirmed/);assert.ok(engine.call);assert.equal(engine.call.status,'stop-unconfirmed');assert.equal(voice.call.status,'stop-unconfirmed');await assert.rejects(engine.acquire(),/Wait for the voice call/);
 worker.terminateConfirmed=async()=>({terminated:true});await engine.stopCall(call.callId);assert.equal(engine.call,null);assert.equal(voice.call,null);
});

test('stop while only reserved cancels the pending start without reviving it',async t=>{
 const {engine,worker}=setup(t);let stopped;engine.waitStopped=()=>new Promise(resolve=>stopped=resolve);const starting=engine.startCall(sdp);const callId=engine.call.id;await engine.stopCall(callId);assert.equal(engine.call,null);stopped();await assert.rejects(starting,/cancelled/);assert.equal(worker.calls.some(call=>call.method==='thread/realtime/start'),false);
});

test('stop while opening a thread does not send realtime start or kill an idle executor',async t=>{
 const {engine,worker}=setup(t);let acknowledge;const request=worker.request.bind(worker);worker.request=(method,params)=>method==='thread/start'?new Promise(resolve=>acknowledge=resolve):request(method,params);
 const starting=engine.startCall(sdp);await tick();const callId=engine.call.id;await engine.stopCall(callId);assert.equal(engine.call,null);acknowledge({thread:{id:'thread'}});await assert.rejects(starting,/cancelled/);assert.equal(worker.calls.some(call=>call.method==='thread/realtime/start'),false);assert.equal(worker.terminated,0);
});

test('lost start acknowledgement terminates the old process and never retries the start',async t=>{
 const {worker,engine}=setup(t,{voice:{connectTimeoutMs:10}}),request=worker.request.bind(worker);worker.request=(method,params)=>{if(method==='thread/realtime/start'){worker.calls.push({method,params});return new Promise(()=>{});}return request(method,params);};
 await assert.rejects(engine.startCall(sdp),/timed out/);assert.equal(worker.terminated,1);assert.equal(engine.call,null);assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/start').length,1);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
});

test('only validated owned MCP delivery payloads publish chat once; ordinary final speech stays ephemeral',async t=>{
 const {store,engine}=setup(t),call=await engine.startCall(sdp);await begin(engine,'background');
 const item={id:'mcp-message',type:'mcpToolCall',server:'dant_desktop',tool:'send_chat_message',status:'completed',arguments:{text:'Useful result'},result:{structuredContent:{dantMessage:{text:'Useful result'}}}};
 await engine.handle(event('item/completed',{turnId:'background',item:{...item,server:'untrusted'}}));
 await engine.handle(event('item/completed',{turnId:'background',item:{...item,result:{structuredContent:{dantMessage:{text:'mismatch'}}}}}));assert.equal(store.state.messages.length,0);
 await engine.handle(event('item/completed',{turnId:'background',item}));await engine.handle(event('item/completed',{turnId:'background',item}));
 await engine.handle(event('item/completed',{turnId:'background',item:{id:'ordinary',type:'agentMessage',text:'Useful result'}}));assert.deepEqual(store.state.messages.map(message=>message.text),['Useful result']);
 await engine.handle(event('turn/completed',{turn:{id:'background',status:'completed'}}));await engine.stopCall(call.callId);
});

test('MCP voice result follows explicit archive and all native background outputs share a 120k budget',async t=>{
 const collector=new EventEmitter(),archives=[];collector.captureBaseline=async()=>({});collector.archive=async options=>{archives.push(options);return [{id:'voice',name:'voice.wav',sha256:'wav'}];};
 const {engine,store,voice}=setup(t,{engine:{deliverables:collector}}),call=await engine.startCall(sdp);await begin(engine,'background');
 const file=path.join(engine.outputDir,'voice.wav'),payload={voiceFile:{path:file}};
 await engine.handle(event('item/completed',{turnId:'background',item:{id:'mcp-voice',type:'mcpToolCall',server:'dant_desktop',tool:'create_voice_message',status:'completed',arguments:{text:'Hello'},result:{content:[{type:'text',text:JSON.stringify(payload)}]}}}));
 assert.equal(archives[0].onlyExplicit,true);assert.deepEqual(archives[0].explicitPaths,[file]);assert.equal(store.state.messages[0].attachments[0].id,'voice');
 for(let index=0;index<3;index++)await engine.handle(event('item/agentMessage/delta',{turnId:'background',itemId:'item-'+index,delta:'x'.repeat(80000)}));
 assert.equal([...voice.session.turns.get('background').outputs.values()].reduce((sum,text)=>sum+text.length,0),120000);
 await engine.handle(event('turn/completed',{turn:{id:'background',status:'completed'}}));await engine.stopCall(call.callId);
});

test('raw handoff_request forces confirmed executor termination even with no announced background turn',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp);
 await engine.handle(event('thread/realtime/itemAdded',{item:{type:'handoff_request',handoff_id:'unobservable'}}));
 await assert.rejects(voice.message({clientMessageId:'message-after-handoff',text:'Do something'}),/handoff.*unconfirmed/);assert.equal(store.state.messages.length,0);
 await engine.stopCall(call.callId);assert.equal(worker.terminated,1);assert.equal(engine.call,null);assert.equal(voice.state.lastStop.reason,'untracked-handoff');assert.equal(voice.state.lastStop.executorStopped,true);assert.equal(voice.state.lastStop.confirmed,true);assert.equal(voice.state.lastStop.method,'thread/realtime/itemAdded');assert.match(voice.state.error,/Only the Codex executor was stopped/);
});

test('typed native input waits for current voice admission, preserves quoted context and deduplicates client IDs without a chat task',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),reply=store.add({role:'assistant',text:'I can create a room and give you its code.'}),request=worker.request.bind(worker);let acknowledge;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};
 const sending=voice.message({clientMessageId:'explicit-one',text:'这个',replyTo:reply.id,callId:call.callId});await tick();assert.equal(typeof acknowledge,'function');assert.equal(store.state.messages[1].executorConfirmedAt,null);assert.equal(voice.session.turns.size,0);acknowledge({});const result=await sending;assert.equal(result.message.status,'accepted');assert.ok(result.message.executorConfirmedAt);assert.equal(result.turnId,undefined);assert.equal(store.state.completions.length,0);const live=worker.calls.find(call=>call.method==='thread/realtime/appendText'),input=JSON.parse(live.params.text.split('<dant_call_input>\n')[1].split('\n</dant_call_input>')[0]);assert.equal(input.text,'这个');assert.deepEqual(input.quotedMessage,{messageId:reply.id,role:'assistant',text:reply.text,attachments:[]});assert.match(live.params.text,/Respond naturally aloud/);
 await begin(engine,'voice-delegated');await engine.handle(event('item/completed',{turnId:'voice-delegated',item:{id:'answer',type:'agentMessage',text:'The room is ready'}}));await engine.handle(event('turn/completed',{turn:{id:'voice-delegated',status:'completed'}}));assert.equal(store.state.messages.length,2);assert.equal(store.state.completions.length,0);const repeated=await voice.message({clientMessageId:'explicit-one',text:'这个',replyTo:reply.id,callId:call.callId});assert.equal(repeated.duplicate,true);assert.equal(repeated.message.id,result.message.id);assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);assert.equal(worker.calls.filter(call=>call.method==='thread/inject_items').length,1);assert.equal(worker.calls.some(call=>['turn/start','turn/steer'].includes(call.method)),false);await engine.stopCall(call.callId);
});

test('reaction changes reach the existing call without creating a chat task or accepting work',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);
 const target=store.add({role:'assistant',text:'Here is your picture',attachments:[{name:'picture.png'}],reactions:['👍']});
 const first=await voice.syncContext({kind:'reaction',message:target,callId:call.callId});assert.equal(first.status,'submitted');
 store.update(target.id,{reactions:[]});await voice.syncContext({kind:'reaction',message:target,callId:call.callId});
 const requests=liveReferences(worker);assert.equal(requests.length,2);assert.match(requests[0].params.text,/picture\.png/);assert.match(requests[0].params.text,/👍/);assert.match(requests[1].params.text,/"reactions":\[\]/);assert.equal(worker.calls.some(call=>['turn/start','turn/steer','response.create'].includes(call.method)),false);assert.equal(store.state.messages.length,1);assert.equal(target.status,undefined);
 const stale=await voice.syncContext({kind:'reaction',message:target,callId:'previous'});assert.equal(stale.status,'cancelled');assert.equal(requests.length,2);await engine.stopCall(call.callId);
 assert.equal((await voice.syncContext({kind:'reaction',message:target,callId:call.callId})).status,'cancelled');
});

test('lost authoritative voice admission pauses typed input and duplicate delivery never replays it',async t=>{
 const {engine,voice,worker,store}=setup(t,{voice:{contextTimeoutMs:10}}),call=await engine.startCall(sdp),request=worker.request.bind(worker);let acknowledge;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};
 await assert.rejects(voice.message({clientMessageId:'live-timeout',text:'Use the blue background',callId:call.callId}),error=>error.unknownOutcome===true);const message=store.state.messages[0];assert.equal(message.submission,'unknown');assert.equal(message.status,'paused');assert.equal(message.voiceContext.status,'unknown');assert.equal(message.executorConfirmedAt,null);assert.equal(voice.session.unknown,true);const duplicate=await voice.message({clientMessageId:'live-timeout',text:'Use the blue background',callId:call.callId});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.unknownOutcome,true);acknowledge({});await tick();assert.equal(message.submission,'unknown');assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);await engine.stopCall(call.callId);assert.equal(worker.terminated,1);
});

test('ending a call cancels live context immediately and never forwards it into the next call',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);let acknowledge;
 worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};
 const target=store.add({role:'assistant',text:'reference'}),first=voice.syncContext({kind:'reaction',message:target,callId:call.callId});await tick();
 const second=voice.syncContext({kind:'reaction',message:{...target,reactions:['❤️']},callId:call.callId});await engine.stopCall(call.callId);assert.equal((await first).status,'cancelled');assert.equal((await second).status,'cancelled');
 worker.request=request;const next=await engine.startCall(sdp);acknowledge({});await tick();assert.equal(liveReferences(worker).length,1);assert.equal(engine.call.id,next.callId);await engine.stopCall(next.callId);
});

test('stored native call input validates exact ownership, deduplicates its pending admission and cannot cross calls',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),message=store.add({role:'user',text:'Tell me about this',replyTo:null}),request=worker.request.bind(worker);let acknowledge;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};
 await assert.rejects(voice.submitCallMessage({...message},{callId:call.callId}),/stored nonempty text/);await assert.rejects(voice.submitCallMessage(message,{callId:'other'}),/changed/);const sending=voice.submitCallMessage(message,{callId:call.callId});assert.equal(voice.submitCallMessage(message,{callId:call.callId}),sending);await tick();assert.equal(message.executorConfirmedAt,null);acknowledge({});await sending;assert.equal(message.status,'accepted');assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);await engine.stopCall(call.callId);worker.request=request;const next=await engine.startCall(sdp);await assert.rejects(voice.submitCallMessage(message,{callId:next.callId}),/another call/);assert.equal(message.status,'accepted');await engine.stopCall(next.callId);
});

test('uncertain canonical native input reference blocks live voice admission and is never reinjected on duplicate delivery',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);worker.request=(method,params)=>{if(method!=='thread/inject_items')return request(method,params);worker.calls.push({method,params});return Promise.reject(Error('Canonical acknowledgement lost'));};await assert.rejects(voice.message({clientMessageId:'canonical-unknown',text:'This one',callId:call.callId}),error=>error.unknownOutcome===true);const message=store.state.messages[0];assert.equal(message.callContext.status,'unknown');assert.equal(message.submission,'unknown');assert.equal(message.executorConfirmedAt,null);assert.equal(worker.calls.some(call=>call.method==='thread/realtime/appendText'),false);const duplicate=await voice.message({clientMessageId:'canonical-unknown',text:'This one',callId:call.callId});assert.equal(duplicate.unknownOutcome,true);assert.equal(worker.calls.filter(call=>call.method==='thread/inject_items').length,1);assert.equal(voice.session.unknown,false);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('public native message records a known canonical reference rejection as failed without a voice receipt or automatic retry',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);worker.request=(method,params)=>{if(method!=='thread/inject_items')return request(method,params);worker.calls.push({method,params});return Promise.reject(Object.assign(Error('Reference rejected'),{code:-32000}));};await assert.rejects(voice.message({clientMessageId:'canonical-rejected',text:'A new input',callId:call.callId}),error=>error.submission==='not-submitted'&&!error.unknownOutcome);const message=store.state.messages[0];assert.equal(message.callContext.status,'failed');assert.equal(message.status,'failed');assert.equal(message.submission,'preparing');assert.equal(message.executorConfirmedAt,null);assert.equal(worker.calls.some(call=>call.method==='thread/realtime/appendText'),false);const duplicate=await voice.message({clientMessageId:'canonical-rejected',text:'A new input',callId:call.callId});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.message.status,'failed');assert.equal(worker.calls.filter(call=>call.method==='thread/inject_items').length,1);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('public native message paused by immediate hangup cannot remain queued or dispatch canonical context into a later call',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),sending=voice.message({clientMessageId:'closed-before-canonical',text:'Do not send after hangup',callId:call.callId}),rejected=assert.rejects(sending,error=>error.submission==='not-submitted'&&!error.unknownOutcome);await engine.stopCall(call.callId);await rejected;const message=store.state.messages[0];assert.equal(message.status,'paused');assert.equal(message.submission,'preparing');assert.equal(message.executorConfirmedAt,null);assert.equal(worker.calls.some(call=>['thread/inject_items','thread/realtime/appendText','turn/start'].includes(call.method)),false);const next=await engine.startCall(sdp);await tick();assert.equal(message.status,'paused');assert.equal(worker.calls.some(call=>['thread/inject_items','thread/realtime/appendText','turn/start'].includes(call.method)),false);await assert.rejects(voice.message({clientMessageId:'closed-before-canonical',text:'Do not send after hangup',callId:next.callId}),/another call/);await engine.stopCall(next.callId);assert.equal(worker.terminated,0);
});

test('native hangup cancels unsent typed inputs without forwarding them into a later call or fabricating a receipt',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);let release;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>release=resolve);};const memory=voice.syncMemory({memory:'Hold the reference queue',callId:call.callId});await tick();const one=voice.message({clientMessageId:'unsent-one',text:'First old input'}),two=voice.message({clientMessageId:'unsent-two',text:'Second old input'}),rejections=[assert.rejects(one,error=>error.submission==='not-submitted'),assert.rejects(two,error=>error.submission==='not-submitted')];await tick();await engine.stopCall(call.callId);await Promise.all(rejections);assert.equal((await memory).status,'cancelled');assert.ok(store.state.messages.filter(message=>message.role==='user').every(message=>message.status==='paused'&&message.submission==='preparing'&&!message.executorConfirmedAt));assert.equal(worker.terminated,0);worker.request=request;const next=await engine.startCall(sdp);release({});await tick();assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);await voice.message({clientMessageId:'new-current',text:'Current call input',callId:next.callId});assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,2);await engine.stopCall(next.callId);
});

test('native hangup during unacknowledged typed input requires confirmed shutdown and late acknowledgement cannot mark it accepted',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);let acknowledge,confirm;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};const sending=voice.message({clientMessageId:'inflight-hangup',text:'An input already sent'}),rejected=assert.rejects(sending,error=>error.unknownOutcome===true);await tick();worker.terminateConfirmed=()=>new Promise(resolve=>confirm=resolve);let stopped=false;const stopping=engine.stopCall(call.callId).then(()=>stopped=true);await tick();assert.equal(typeof confirm,'function');assert.equal(stopped,false);assert.ok(engine.call);assert.equal(store.state.messages[0].submission,'unknown');confirm({terminated:true});await stopping;await rejected;acknowledge({});await tick();assert.equal(store.state.messages[0].submission,'unknown');assert.equal(store.state.messages[0].executorConfirmedAt,null);assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);assert.equal(engine.call,null);
});

test('a known native voice input rejection preserves failure and permits a different fresh input',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);let fail=true;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText'||!fail)return request(method,params);fail=false;worker.calls.push({method,params});return Promise.reject(Object.assign(Error('Input rejected'),{code:-32000}));};await assert.rejects(voice.message({clientMessageId:'voice-rejected',text:'Rejected input'}),error=>error.submission==='rejected');assert.equal(store.state.messages[0].status,'failed');assert.equal(store.state.messages[0].executorConfirmedAt,null);assert.equal(voice.session.unknown,false);const duplicate=await voice.message({clientMessageId:'voice-rejected',text:'Rejected input'});assert.equal(duplicate.duplicate,true);const next=await voice.message({clientMessageId:'voice-fresh',text:'A new request'});assert.equal(next.message.status,'accepted');assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,2);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('an uncertain older reference prevents unsent native input from claiming execution or being retried',async t=>{
 const {engine,voice,worker,store}=setup(t,{voice:{contextTimeoutMs:10}}),call=await engine.startCall(sdp),request=worker.request.bind(worker);worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(()=>{});};assert.equal((await voice.syncMemory({memory:'Uncertain old reference',callId:call.callId})).status,'unknown');await assert.rejects(voice.message({clientMessageId:'after-uncertain-reference',text:'This input was never sent'}),error=>error.submission==='not-submitted');const message=store.state.messages[0];assert.equal(message.submission,'preparing');assert.equal(message.status,'paused');assert.equal(message.executorConfirmedAt,null);assert.equal(voice.session.unknown,false);await voice.message({clientMessageId:'after-uncertain-reference',text:'This input was never sent'});assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('native credential requests cancel before waiting for the voice event chain on pause',async t=>{
 const {dir,engine,voice,worker}=setup(t);engine.credentials=new CredentialRequests({vault:new CredentialVault({dataDir:dir})});
 const call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);await begin(engine,'credential-turn');
 const pending=tool(engine,'credential-turn','credential_request',{name:'VM login',service:'example.test',reason:'Continue authorized work'},101);await tick();const request=engine.credentials.snapshot().requests[0];assert.ok(request);
 const result=await engine.pause();await pending;assert.equal(result.callContinues,true);assert.equal(engine.call.id,call.callId);assert.deepEqual(engine.credentials.snapshot().requests,[]);assert.throws(()=>engine.credentials.fulfill(request.id,{secret:'late-secret'}),/no longer/);assert.equal(worker.responses.find(response=>response.id===101).result.success,false);
 const oldTurn=voice.session.turns.get('credential-turn');await assert.rejects(voice.tool(voice.session,oldTurn,'credential_get',{id:'anything'}),/no longer/);await engine.stopCall(call.callId);
});

test('the LLM native reaction tool sets its own reaction without altering human feedback',async t=>{
 const {engine,store}=setup(t),call=await engine.startCall(sdp),message=store.add({role:'user',text:'A milestone worth celebrating',reactions:['❤️']});await begin(engine,'reaction-turn');
 await tool(engine,'reaction-turn','react_message',{messageId:message.id,emoji:'🎉'},102);assert.equal(message.assistantReaction,'🎉');assert.deepEqual(message.reactions,['❤️']);assert.equal(store.state.messages.length,1);await engine.stopCall(call.callId);
});

test('typed input during native work serializes through the same voice session without separately steering or echoing backend final text',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp);await begin(engine,'known-turn');const request=worker.request.bind(worker);let firstAck,inputs=0;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});if(++inputs===1)return new Promise(resolve=>firstAck=resolve);return Promise.resolve({});};
 const first=voice.message({clientMessageId:'steer-one',text:'First correction'}),second=voice.message({clientMessageId:'steer-two',text:'Second correction'});await tick();assert.equal(inputs,1);firstAck({});await Promise.all([first,second]);assert.equal(inputs,2);assert.ok(worker.calls.filter(call=>call.method==='thread/realtime/appendText').every(call=>call.params.threadId==='thread'));assert.equal(worker.calls.some(call=>['turn/start','turn/steer'].includes(call.method)),false);await engine.handle(event('item/completed',{turnId:'known-turn',item:{id:'answer',type:'agentMessage',text:'Both corrections applied'}}));await engine.handle(event('turn/completed',{turn:{id:'known-turn',status:'completed'}}));assert.deepEqual(store.state.messages.filter(message=>message.role==='user').map(message=>message.status),['accepted','accepted']);assert.equal(store.state.messages.some(message=>message.role==='assistant'),false);await engine.stopCall(call.callId);
});

test('backend completion before typed voice admission cannot create a second chat assistant response',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp);await begin(engine,'known-turn');const request=worker.request.bind(worker);let acknowledge;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};const sending=voice.message({clientMessageId:'late-steer-ack',text:'Use this correction'});await tick();await engine.handle(event('item/completed',{turnId:'known-turn',item:{id:'answer',type:'agentMessage',text:'Accepted correction result'}}));await engine.handle(event('turn/completed',{turn:{id:'known-turn',status:'completed'}}));assert.equal(store.state.messages.length,1);acknowledge({});const result=await sending;assert.equal(result.message.status,'accepted');assert.equal(store.state.messages.length,1);assert.equal(store.state.completions.length,0);await engine.stopCall(call.callId);
});

test('unknown typed voice submission is paused and duplicate client delivery never replays it',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return Promise.reject(Error('Connection lost after send'));};await assert.rejects(voice.message({clientMessageId:'unknown-text',text:'Maybe submitted'}),error=>error.unknownOutcome===true&&/may have been delivered/.test(error.message));assert.equal(store.state.messages[0].status,'paused');assert.equal(store.state.messages[0].submission,'unknown');const duplicate=await voice.message({clientMessageId:'unknown-text',text:'Maybe submitted'});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.unknownOutcome,true);assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);await engine.stopCall(call.callId);assert.equal(worker.terminated,1);
});

test('a stale Codex realtime event cannot close a later independently billed API call',async t=>{
 const {engine}=setup(t);engine.voice={start:async()=>({sdp}),stop:async()=>{}};const call=await engine.startCall(sdp,{provider:'api'});await engine.handle(event('thread/realtime/closed'));await engine.handle(event('thread/realtime/error',{message:'old native call error'}));assert.equal(engine.call.id,call.callId);await engine.stopCall(call.callId);
});

test('automatic voice final delivers useful links without narration, repeated tool links or credential URLs',async t=>{
 const {engine,store}=setup(t),call=await engine.startCall(sdp);await begin(engine,'background');await tool(engine,'background','send_message',{text:'Requested link https://example.test/one'},1);
 await engine.handle(event('item/completed',{turnId:'background',item:{id:'final',type:'agentMessage',text:'Spoken narration remains private. [One](https://example.test/one) [Two](https://example.test/two). https://example.test/private?token=sensitive https://name:password@example.test/private'}}));
 await engine.handle(event('turn/completed',{turn:{id:'background',status:'completed'}}));assert.deepEqual(store.state.messages.map(message=>message.text),['Requested link https://example.test/one','https://example.test/two']);await engine.stopCall(call.callId);
});

test('pause routes to actual delegated native work while admitted voice input stays accepted and never auto-replays',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);const first=await voice.message({clientMessageId:'pause-first',text:'Work on this'});await begin(engine,'voice-task');assert.deepEqual(voice.active,{messageId:null,turnId:'voice-task',source:'voice',status:'running'});const result=await engine.pause();assert.deepEqual(result,{paused:true,callId:call.callId,callContinues:true,turnIds:['voice-task']});assert.equal(first.message.status,'accepted');assert.equal(voice.active,null);assert.equal(engine.call.status,'connected');assert.equal(worker.terminated,0);assert.equal(worker.calls.some(call=>call.method==='thread/realtime/stop'),false);const duplicate=await voice.message({clientMessageId:'pause-first',text:'Work on this'});assert.equal(duplicate.duplicate,true);assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);const next=await voice.message({clientMessageId:'pause-fresh',text:'A new task'});assert.equal(next.message.status,'accepted');assert.equal(next.turnId,undefined);assert.equal(store.state.messages.filter(message=>message.role==='user').length,2);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);await engine.pause();await engine.stopCall(call.callId);
});

test('native pause waits for matching completion even when interrupt acknowledgement remains pending',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'owned-task');const request=worker.request.bind(worker);let interrupted;
 worker.request=(method,params)=>{if(method!=='turn/interrupt')return request(method,params);interrupted=params;return new Promise(()=>{});};
 let finished=false;const pausing=engine.pause().then(result=>{finished=true;return result;});await tick();assert.deepEqual(interrupted,{threadId:'thread',turnId:'owned-task'});assert.equal(finished,false);assert.equal(voice.active.status,'pausing');
 await engine.handle(event('turn/completed',{threadId:'different-thread',turn:{id:'owned-task',status:'interrupted'}}));await tick();assert.equal(finished,false);
 await engine.handle(event('turn/completed',{turn:{id:'owned-task',status:'interrupted'}}));const result=await pausing;assert.equal(result.paused,true);assert.ok(engine.call);assert.equal(voice.active,null);await engine.stopCall(call.callId);
});

test('unobservable voice handoff cannot report paused and keeps the call until explicit hangup',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await engine.handle(event('thread/realtime/itemAdded',{item:{type:'handoff_request'}}));assert.equal(voice.active.status,'unknown');
 await assert.rejects(engine.pause(),error=>error.unknownOutcome===true&&/End the call/.test(error.message));assert.equal(engine.call.id,call.callId);assert.equal(worker.calls.some(call=>call.method==='turn/interrupt'),false);assert.equal(worker.terminated,0);
 await engine.stopCall(call.callId);assert.equal(worker.terminated,1);
});

test('an unconfirmed native interruption reports unknown without pretending the task paused',async t=>{
 const {engine,voice,worker}=setup(t,{voice:{stopTimeoutMs:10}}),call=await engine.startCall(sdp);await begin(engine,'still-running');const request=worker.request.bind(worker);worker.request=(method,params)=>method==='turn/interrupt'?Promise.resolve({}):request(method,params);
 await assert.rejects(engine.pause(),error=>error.unknownOutcome===true);assert.ok(engine.call);assert.equal(voice.active.status,'unknown');assert.equal(worker.terminated,0);await engine.stopCall(call.callId);assert.equal(worker.terminated,1);
});

test('pause invalidates queued native voice input before dispatch without replaying it after the reference queue drains',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);let release;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>release=resolve);};const reference=voice.syncMemory({memory:'Pending reference',callId:call.callId});await tick();const sending=voice.message({clientMessageId:'queued-before-pause',text:'Do not submit after pause'}),rejected=assert.rejects(sending,/paused before submission/);await tick();const result=await engine.pause();assert.equal(result.paused,true);release({});await reference;await rejected;assert.equal(store.state.messages[0].status,'paused');assert.equal(store.state.messages[0].executorConfirmedAt,null);assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/appendText').length,1);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);assert.ok(engine.call);await engine.stopCall(call.callId);
});

test('a large screenshot completion does not overflow the voice observer or terminate its executor',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'screenshot-turn');
 const image=Buffer.alloc(900000,37).toString('base64'),notification=event('item/completed',{turnId:'screenshot-turn',item:{id:'large-screen',type:'mcpToolCall',server:'dant_desktop',tool:'screenshot',status:'completed',arguments:{},result:{content:[{type:'image',mimeType:'image/png',data:image}],isError:false}}});
 assert.ok(Buffer.byteLength(JSON.stringify(notification))>1024*1024);const original=JSON.stringify(notification);await engine.handle(notification);await tick();assert.equal(worker.terminated,0);assert.equal(worker.status,'online');assert.equal(voice.session.unknown,false);assert.equal(engine.call.id,call.callId);assert.equal(JSON.stringify(notification),original);await engine.stopCall(call.callId);
});

test('a full one-MiB command result remains available to Codex while native observation stays connected',async t=>{
 const {engine,voice,worker}=setup(t),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));const call=await engine.startCall(sdp);await begin(engine,'command-output-turn');
 const notification=event('item/completed',{turnId:'command-output-turn',item:{id:'large-command',type:'commandExecution',command:'existing-tool',cwd:'/workspace',processId:'123',source:'agent',status:'completed',commandActions:[],aggregatedOutput:'x'.repeat(1024*1024),exitCode:0,durationMs:12}}),before=JSON.stringify(notification);assert.ok(Buffer.byteLength(before)>1024*1024);
 await engine.handle(notification);await tick();assert.equal(worker.terminated,0);assert.equal(worker.status,'online');assert.equal(voice.session.unknown,false);assert.equal(engine.call.id,call.callId);assert.equal(JSON.stringify(notification),before);assert.equal(notification.params.item.aggregatedOutput.length,1024*1024);assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].code,'voice_observer_payload_omitted');assert.equal(diagnostics[0].itemType,'commandExecution');assert.equal(diagnostics[0].itemStatus,'completed');assert.equal(diagnostics[0].itemId,'large-command');assert.ok(diagnostics[0].bytes<1024);assert.equal(JSON.stringify(diagnostics).includes('aggregatedOutput'),false);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('a screenshot encoded inside a one-MiB JSON text result cannot stop an otherwise empty native queue',async t=>{
 const {engine,voice,worker}=setup(t),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));const call=await engine.startCall(sdp);await begin(engine,'json-screenshot-turn');assert.equal(voice.session.queuedBytes,0);assert.equal(voice.session.queuedEvents,0);
 const image={content:[{type:'image',data:'x'.repeat(1048460),mimeType:'image/png'}]},text=JSON.stringify(image),notification=event('item/completed',{turnId:'json-screenshot-turn',item:{id:'json-image-tool',type:'mcpToolCall',server:'dant_desktop',tool:'screenshot',status:'completed',arguments:{},result:{content:[{type:'text',text}],isError:false}}}),before=JSON.stringify(notification);assert.equal(text.length,1048523);assert.ok(Buffer.byteLength(before)>1024*1024);
 await engine.handle(notification);await tick();assert.equal(worker.terminated,0);assert.equal(worker.status,'online');assert.equal(voice.session.unknown,false);assert.equal(engine.call.id,call.callId);assert.equal(voice.session.queuedBytes,0);assert.equal(voice.session.queuedEvents,0);assert.equal(notification.params.item.result.content[0].text,text);assert.equal(JSON.stringify(notification),before);assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].code,'voice_observer_payload_omitted');assert.equal(diagnostics[0].itemType,'mcpToolCall');assert.equal(diagnostics[0].itemStatus,'completed');assert.equal(diagnostics[0].itemId,'json-image-tool');assert.ok(diagnostics[0].bytes<1024);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('large command results during typed voice admission retain only observer metadata and never replay the task',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));let acknowledge;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};const sending=voice.message({clientMessageId:'large-early-command',text:'Run the requested tool'});await tick();await begin(engine,'native-command');const output='x'.repeat(1024*1024),notification=event('item/completed',{turnId:'native-command',item:{id:'early-command',type:'commandExecution',status:'completed',aggregatedOutput:output,exitCode:0}});await engine.handle(notification);assert.equal(voice.session.queuedBytes,0);assert.equal(voice.session.unknown,false);assert.equal(notification.params.item.aggregatedOutput,output);assert.equal(diagnostics[0].code,'voice_observer_payload_omitted');assert.ok(diagnostics[0].bytes<1024);acknowledge({});await sending;assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);assert.equal(worker.terminated,0);assert.equal(engine.call.id,call.callId);await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('unknown oversized item completions still stop the executor with safe item metadata only',async t=>{
 const {engine,voice,worker}=setup(t),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));await engine.startCall(sdp);await begin(engine,'unknown-output-turn');const notification=event('item/completed',{turnId:'unknown-output-turn',item:{id:'unknown-output',type:'futureUnknownType',status:'completed',payload:'private-unrecognized-'+ 'x'.repeat(1024*1024)}});await engine.handle(notification);await tick();
 assert.equal(worker.terminated,1);assert.equal(voice.state.lastStop.reason,'notification-buffer');assert.equal(voice.state.lastStop.itemType,'other');assert.equal(voice.state.lastStop.itemStatus,'completed');assert.equal(voice.state.lastStop.itemId,'unknown-output');assert.equal(JSON.stringify(diagnostics).includes('private-unrecognized'),false);assert.equal(diagnostics.some(item=>item.code==='voice_observer_payload_omitted'),false);
});

test('observer projection never grants turn ownership or turns malformed screenshots into accepted notifications',async t=>{
 for(const turnId of [undefined,'foreign-turn']){
  const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'owned-turn');const notification=event('item/completed',{turnId,item:{id:'unowned-command',type:'commandExecution',status:'completed',aggregatedOutput:'x'.repeat(1024*1024)}});await engine.handle(notification);assert.equal(voice.session.unknown,true);assert.equal(voice.session.stopCause.reason,'untracked-turn');await engine.stopCall(call.callId);assert.equal(worker.terminated,1);
 }
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'owned-turn');await engine.handle(event('item/completed',{threadId:'another-thread',turnId:'owned-turn',item:{id:'foreign-thread-command',type:'commandExecution',aggregatedOutput:'x'.repeat(1024*1024)}}));assert.equal(voice.session.unknown,false);assert.equal(worker.terminated,0);await engine.stopCall(call.callId);
 const malformed=setup(t);await malformed.engine.startCall(sdp);await begin(malformed.engine,'valid-turn');await malformed.engine.handle(event('item/completed',{turnId:'valid-turn',item:{type:'mcpToolCall',server:'dant_desktop',tool:'screenshot',status:'completed',result:{content:[{type:'image',data:'x'.repeat(1024*1024)}]}}}));await tick();assert.equal(malformed.worker.terminated,1);assert.equal(malformed.voice.state.lastStop.reason,'notification-buffer');
});

test('large delivery marker mismatches remain invalid and zero or null RPC IDs cannot bypass control limits',async t=>{
 const {engine,store,worker}=setup(t),call=await engine.startCall(sdp);await begin(engine,'delivery-validation');const text='x'.repeat(90000),notification=event('item/completed',{turnId:'delivery-validation',item:{id:'mismatch',type:'mcpToolCall',server:'dant_desktop',tool:'send_chat_message',status:'completed',arguments:{text},result:{structuredContent:{dantMessage:{text:'different-'+text}},content:[{type:'text',text:'x'.repeat(100000)}]}}});await engine.handle(notification);assert.equal(store.state.messages.length,0);assert.equal(worker.terminated,0);await engine.stopCall(call.callId);
 for(const requestId of [0,null]){
  const state=setup(t);await state.engine.startCall(sdp);await begin(state.engine,'control-turn');await state.engine.handle(event('item/tool/call',{turnId:'control-turn',tool:'send_message',arguments:{text:'x'.repeat(1024*1024)}},requestId));await tick();assert.equal(state.worker.terminated,1);assert.equal(state.voice.state.lastStop.reason,'notification-buffer');assert.equal(state.store.state.messages.length,0);assert.equal(state.worker.responses.some(reply=>reply.result?.success),false);
 }
});

test('consecutive large screenshots queue only metadata while preserving validated MCP delivery',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp);await begin(engine,'screenshot-turn');
 let release;voice.session.eventChain=new Promise(resolve=>release=resolve);const image=Buffer.alloc(900000,41).toString('base64'),notifications=[];
 for(let index=0;index<8;index++)notifications.push(event('item/completed',{turnId:'screenshot-turn',item:{id:'screen-'+index,type:'mcpToolCall',server:'dant_desktop',tool:'screenshot',status:'completed',result:{content:[{type:'image',mimeType:'image/png',data:image}],isError:false}}}));
 const payload={dantMessage:{text:'Explicit requested result'}},delivery=event('item/completed',{turnId:'screenshot-turn',item:{id:'delivery',type:'mcpToolCall',server:'dant_desktop',tool:'send_chat_message',status:'completed',arguments:{text:payload.dantMessage.text},result:{content:[{type:'text',text:JSON.stringify(payload)},{type:'image',mimeType:'image/png',data:image}],structuredContent:payload,isError:false}}});notifications.push(delivery);
 const pending=notifications.map(notification=>engine.handle(notification));assert.equal(voice.session.queuedEvents,9);assert.ok(voice.session.queuedBytes<10000);assert.equal(voice.session.unknown,false);release();await Promise.all(pending);assert.equal(worker.terminated,0);assert.equal(voice.session.queuedBytes,0);assert.equal(voice.session.queuedEvents,0);assert.equal(store.state.messages[0].text,'Explicit requested result');assert.ok(notifications.every(notification=>notification.params.item.result.content.some(content=>content.type==='image'&&content.data===image)));await engine.stopCall(call.callId);assert.equal(worker.terminated,0);
});

test('three observed screenshots emit exactly three safe size diagnostics before queueing',async t=>{
 const {engine,voice,worker}=setup(t),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));const call=await engine.startCall(sdp);await begin(engine,'screenshot-diagnostics');
 const image=Buffer.alloc(900000,47).toString('base64');for(let index=0;index<3;index++)await engine.handle(event('item/completed',{turnId:'screenshot-diagnostics',item:{id:'diagnostic-image-'+index,type:'mcpToolCall',server:'dant_desktop',tool:'screenshot',status:'completed',result:{content:[{type:'image',mimeType:'image/png',data:image}]}}}));
 assert.equal(diagnostics.length,3);assert.ok(diagnostics.every(entry=>entry.code==='voice_observer_image_omitted'&&entry.callId===call.callId&&entry.method==='item/completed'&&entry.eventBytes>1024*1024&&entry.bytes<1000&&entry.count===1));assert.equal(JSON.stringify(diagnostics).includes(image.slice(0,100)),false);assert.equal(diagnostics.reduce((count,entry)=>count+entry.count,0),3);assert.equal(worker.terminated,0);await engine.stopCall(call.callId);
});

test('large screenshot results during typed voice admission stay bounded without mutating the model result',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));let acknowledge;worker.request=(method,params)=>{if(method!=='thread/realtime/appendText')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};const sending=voice.message({clientMessageId:'large-early-screenshot',text:'Observe the game'});await tick();await begin(engine,'native-screen');const image=Buffer.alloc(900000,43).toString('base64'),notification=event('item/completed',{turnId:'native-screen',item:{id:'early-screen',type:'mcpToolCall',server:'dant_desktop',tool:'screenshot',status:'completed',result:{content:[{type:'image',mimeType:'image/png',data:image}]}}});await engine.handle(notification);assert.equal(voice.session.queuedBytes,0);assert.equal(notification.params.item.result.content[0].data,image);assert.equal(voice.session.unknown,false);assert.equal(diagnostics[0].code,'voice_observer_image_omitted');assert.ok(diagnostics[0].bytes<1000);acknowledge({});const result=await sending;assert.equal(result.submission,'confirmed');assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);assert.equal(worker.terminated,0);assert.equal(engine.call.id,call.callId);await engine.stopCall(call.callId);
});

test('real critical notification overflow still waits for confirmed termination and never replays work',async t=>{
 const {engine,voice,worker,store}=setup(t),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));const call=await engine.startCall(sdp),sent=await voice.message({clientMessageId:'critical-overflow',text:'An owned task'});await begin(engine,'critical-owned');let confirm,terminations=0;worker.terminateConfirmed=()=>{terminations++;return new Promise(resolve=>confirm=resolve);};
 const privateText='never-publish-this-payload-'+ 'x'.repeat(1024*1024),notification=event('item/tool/call',{turnId:'critical-owned',tool:'send_message',arguments:{text:privateText}},900);
 await engine.handle(notification);await tick();assert.equal(terminations,1);assert.ok(engine.call);assert.equal(voice.state.lastStop.reason,'notification-buffer');assert.equal(voice.state.lastStop.confirmed,false);assert.equal(voice.state.lastStop.executorStopped,false);assert.equal(voice.state.lastStop.method,'item/tool/call');assert.ok(voice.state.lastStop.eventBytes>1024*1024);assert.equal(JSON.stringify(voice.state).includes('never-publish'),false);assert.equal(store.state.messages.length,1);
 const stopping=voice.session.stopPromise;confirm({terminated:true});await stopping;assert.equal(engine.call,null);assert.equal(voice.state.lastStop.confirmed,true);assert.equal(voice.state.lastStop.executorStopped,true);assert.equal(voice.state.lastStop.reason,'notification-buffer');assert.match(voice.state.error,/VM was not shut down/);assert.equal(store.state.messages[0].status,'accepted');assert.equal(engine.queue.length,0);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);assert.equal(worker.responses.some(response=>response.result?.success),false);assert.deepEqual(diagnostics.map(entry=>entry.code),['voice_executor_stop_required','voice_shutdown']);assert.equal(diagnostics[0].confirmed,false);assert.equal(diagnostics[1].confirmed,true);assert.equal(JSON.stringify(diagnostics).includes('never-publish'),false);
});

test('early control-event overflow retains its own reason and still requires confirmed executor stop',async t=>{
 const {engine,voice,worker}=setup(t),call=await engine.startCall(sdp),session=voice.session;session.submitting={message:{id:'pending'},early:[],bytes:0};
 for(let index=0;index<129;index++)await engine.handle(event('item/started',{turnId:'pending-turn',item:{id:'control-'+index,type:'mcpToolCall',server:'dant_desktop',tool:'click',arguments:{x:index,y:index}}}));
 assert.equal(session.unknown,true);assert.equal(session.submitting.early.length,128);assert.equal(session.stopCause.reason,'early-text-buffer');assert.equal(worker.terminated,0);await engine.stopCall(call.callId);assert.equal(worker.terminated,1);assert.equal(voice.state.lastStop.reason,'early-text-buffer');assert.equal(voice.state.lastStop.queuedEvents,128);assert.equal(voice.state.lastStop.confirmed,true);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
});

test('unconfirmed shutdown diagnostics retain a fixed reason without transport payloads or secrets',async t=>{
 const {engine,voice,worker}=setup(t),diagnostics=[];voice.on('diagnostic',entry=>diagnostics.push(entry));const call=await engine.startCall(sdp);await engine.handle(event('thread/realtime/itemAdded',{item:{type:'handoff_request',text:'private-handoff-payload'}}));worker.terminateConfirmed=async()=>{throw Error('private-termination-secret');};
 await assert.rejects(engine.stopCall(call.callId),/private-termination-secret/);assert.ok(engine.call);assert.equal(voice.state.lastStop.reason,'untracked-handoff');assert.equal(voice.state.lastStop.confirmed,false);assert.equal(voice.state.lastStop.executorStopped,false);assert.match(voice.state.error,/has not been confirmed/);assert.equal(JSON.stringify({state:voice.state,diagnostics}).includes('private-'),false);assert.deepEqual(diagnostics.map(entry=>entry.code),['voice_executor_stop_required','voice_shutdown_unconfirmed']);worker.terminateConfirmed=async()=>({terminated:true});await engine.stopCall(call.callId);assert.equal(voice.state.lastStop.confirmed,true);
});
