import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {NativeRealtimeVoice,NATIVE_REALTIME_MODEL} from '../src/realtime.mjs';

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
  if(method==='thread/realtime/start'){queueMicrotask(()=>{this.event('thread/realtime/started',{version:'v3'});this.event('thread/realtime/sdp',{sdp});});return {};}
  if(method==='thread/realtime/stop'){queueMicrotask(()=>this.event('thread/realtime/closed'));return {};}
  if(method==='turn/start')return {turn:{id:'typed-'+ ++this.nextTurn}};
  if(method==='turn/interrupt'){queueMicrotask(()=>this.event('turn/completed',{turn:{id:params.turnId,status:'interrupted'}}));return {};}
  return {};
 }
 async terminateConfirmed(){this.terminated++;this.status='offline';this.emit('status');return {terminated:true};}
}
function setup(t,options={}){
 const dir=fs.mkdtempSync(path.join(base,'realtime-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),worker=new FakeWorker(dir),engine=new Engine(store,worker,options.engine);
 const voice=new NativeRealtimeVoice({worker,engine,connectTimeoutMs:1000,stopTimeoutMs:1000,...options.voice});return {dir,store,worker,engine,voice};
}
const event=(method,params={},id)=>({method,params:{threadId:'thread',...params},...(id===undefined?{}:{id})});
const begin=(engine,id)=>engine.handle(event('turn/started',{turn:{id,status:'inProgress'}}));
const tool=(engine,id,name,args,requestId)=>engine.handle(event('item/tool/call',{turnId:id,callId:'call-'+requestId,tool:name,arguments:args},requestId));

test('subscription uses exact V3 WebRTC RPC and counts only confirmed connected calls',async t=>{
 const {store,worker,engine,voice}=setup(t);assert.deepEqual((await voice.listVoices()).voices.v3,['ember','cove']);
 const result=await engine.startCall(sdp),request=worker.calls.find(call=>call.method==='thread/realtime/start');
 assert.equal(result.provider,'subscription');assert.equal(request.params.version,'v3');assert.equal(request.params.model,NATIVE_REALTIME_MODEL);assert.equal(request.params.voice,'ember');assert.deepEqual(request.params.transport,{type:'webrtc',sdp});assert.equal(engine.call.status,'negotiating');
 assert.equal(store.state.messages.filter(message=>message.kind==='call').length,0);
 await assert.rejects(engine.stopCall('old-call'),/changed/);assert.throws(()=>engine.confirmCallConnected('old-call'),/changed/);
 engine.confirmCallConnected(result.callId);assert.equal(engine.call.status,'connected');engine.call.connectedAt-=2100;
 await engine.stopCall(result.callId);assert.equal(engine.call,null);assert.equal(voice.call,null);assert.equal(worker.terminated,0);
 const records=store.state.messages.filter(message=>message.kind==='call');assert.equal(records.length,1);assert.equal(records[0].provider,'subscription');assert.equal(records[0].seconds,2);assert.equal(records[0].text,'');
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

test('normal work and takeover cannot enter the reserved native execution channel',async t=>{
 const {store,worker,engine}=setup(t),call=await engine.startCall(sdp),message=store.add({role:'user',text:'Later task'});engine.enqueue(message);assert.equal(message.status,'paused');assert.equal(message.pauseReason,'voice-call');await assert.rejects(engine.acquire(),/End the voice call/);
 await engine.stopCall(call.callId);await tick();assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);assert.equal(message.status,'paused');
});

test('stop waits for a known background turn interrupt completion before release',async t=>{
 const {worker,engine}=setup(t),call=await engine.startCall(sdp);await begin(engine,'background');let interrupt;
 const request=worker.request.bind(worker);worker.request=(method,params)=>{if(method!=='turn/interrupt')return request(method,params);interrupt=params;return Promise.resolve({});};
 let ended=false;const stopping=engine.stopCall(call.callId).then(()=>ended=true);await tick();assert.ok(interrupt);assert.equal(ended,false);assert.ok(engine.call);
 await engine.handle(event('turn/completed',{turn:{id:'background',status:'interrupted'}}));await stopping;assert.equal(engine.call,null);assert.equal(worker.terminated,0);
});

test('unknown background handoff rejects effects and confirms process termination before unlock',async t=>{
 const {store,worker,engine}=setup(t),call=await engine.startCall(sdp);await tool(engine,'unannounced','send_message',{text:'must not be sent'},1);assert.equal(store.state.messages.length,0);assert.ok(worker.responses[0].error);
 let confirm;worker.terminateConfirmed=()=>new Promise(resolve=>confirm=resolve);let ended=false;const stopping=engine.stopCall(call.callId).then(()=>ended=true);await tick();assert.ok(confirm);assert.equal(ended,false);assert.ok(engine.call);
 confirm({terminated:true});await stopping;assert.equal(engine.call,null);assert.equal(engine.loaded,false);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
});

test('missing closed confirmation terminates executor and failed termination retains the call lock',async t=>{
 const {worker,engine,voice}=setup(t,{voice:{stopTimeoutMs:10}}),call=await engine.startCall(sdp);const request=worker.request.bind(worker);worker.request=(method,params)=>method==='thread/realtime/stop'?Promise.resolve({}):request(method,params);
 worker.terminateConfirmed=async()=>{throw Error('Actual process exit not confirmed');};await assert.rejects(engine.stopCall(call.callId),/not confirmed/);assert.ok(engine.call);assert.equal(engine.call.status,'stop-unconfirmed');assert.equal(voice.call.status,'stop-unconfirmed');await assert.rejects(engine.acquire(),/End the voice call/);
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
 await engine.stopCall(call.callId);assert.equal(worker.terminated,1);assert.equal(engine.call,null);
});

test('explicit native text waits for turn acknowledgement, persists final, and deduplicates client IDs',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);let acknowledge;
 worker.request=(method,params)=>{if(method!=='turn/start')return request(method,params);worker.calls.push({method,params});return new Promise(resolve=>acknowledge=resolve);};
 const sending=voice.message({clientMessageId:'explicit-one',text:'Calculate a result',callId:call.callId});await tick();
 await begin(engine,'accepted-text');await engine.handle(event('item/completed',{turnId:'accepted-text',item:{id:'answer',type:'agentMessage',text:'The result is 42'}}));await engine.handle(event('turn/completed',{turn:{id:'accepted-text',status:'completed'}}));
 assert.equal(voice.session.turns.size,0);assert.equal(store.state.messages[0].executorConfirmedAt,null);assert.equal(store.state.messages.length,1);
 acknowledge({turn:{id:'accepted-text'}});const result=await sending;assert.equal(result.message.status,'review');assert.ok(result.message.executorConfirmedAt);assert.equal(result.message.read,false);assert.equal(store.state.messages[1].text,'The result is 42');assert.equal(store.state.completions.length,1);
 const repeated=await voice.message({clientMessageId:'explicit-one',text:'Calculate a result',callId:call.callId});assert.equal(repeated.duplicate,true);assert.equal(repeated.message.id,result.message.id);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);
 await engine.stopCall(call.callId);
});

test('explicit native text steers the exact known background turn serially and preserves accepted finals',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp);await begin(engine,'known-turn');const request=worker.request.bind(worker);let firstAck,steers=0;
 worker.request=(method,params)=>{if(method!=='turn/steer')return request(method,params);worker.calls.push({method,params});if(++steers===1)return new Promise(resolve=>firstAck=resolve);return Promise.resolve({});};
 const first=voice.message({clientMessageId:'steer-one',text:'First correction'}),second=voice.message({clientMessageId:'steer-two',text:'Second correction'});await tick();assert.equal(steers,1);firstAck({});await Promise.all([first,second]);assert.equal(steers,2);assert.ok(worker.calls.filter(call=>call.method==='turn/steer').every(call=>call.params.expectedTurnId==='known-turn'));
 await engine.handle(event('item/completed',{turnId:'known-turn',item:{id:'answer',type:'agentMessage',text:'Both corrections applied'}}));await engine.handle(event('turn/completed',{turn:{id:'known-turn',status:'completed'}}));
 assert.deepEqual(store.state.messages.filter(message=>message.role==='user').map(message=>message.status),['review','review']);assert.deepEqual(store.state.messages.filter(message=>message.role==='assistant').map(message=>message.text),['Both corrections applied']);await engine.stopCall(call.callId);
});

test('background completion before a steer acknowledgement retains output until acceptance',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp);await begin(engine,'known-turn');const request=worker.request.bind(worker);let acknowledge;
 worker.request=(method,params)=>method==='turn/steer'?new Promise(resolve=>acknowledge=resolve):request(method,params);
 const sending=voice.message({clientMessageId:'late-steer-ack',text:'Use this correction'});await tick();await engine.handle(event('item/completed',{turnId:'known-turn',item:{id:'answer',type:'agentMessage',text:'Accepted correction result'}}));await engine.handle(event('turn/completed',{turn:{id:'known-turn',status:'completed'}}));assert.equal(store.state.messages.length,1);
 acknowledge({});await sending;assert.equal(store.state.messages[0].status,'review');assert.equal(store.state.messages[1].text,'Accepted correction result');await engine.stopCall(call.callId);
});

test('unknown explicit text submission is paused and duplicate client delivery never replays it',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp),request=worker.request.bind(worker);
 worker.request=(method,params)=>{if(method!=='turn/start')return request(method,params);worker.calls.push({method,params});return Promise.reject(Error('Connection lost after send'));};
 await assert.rejects(voice.message({clientMessageId:'unknown-text',text:'Maybe submitted'}),error=>error.unknownOutcome===true&&/may have been submitted/.test(error.message));assert.equal(store.state.messages[0].status,'paused');assert.equal(store.state.messages[0].submission,'unknown');
 const duplicate=await voice.message({clientMessageId:'unknown-text',text:'Maybe submitted'});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.unknownOutcome,true);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);await engine.stopCall(call.callId);assert.equal(worker.terminated,1);
});

test('a stale Codex realtime event cannot close a later independently billed API call',async t=>{
 const {engine}=setup(t);engine.voice={start:async()=>({sdp}),stop:async()=>{}};const call=await engine.startCall(sdp,{provider:'api'});await engine.handle(event('thread/realtime/closed'));await engine.handle(event('thread/realtime/error',{message:'old native call error'}));assert.equal(engine.call.id,call.callId);await engine.stopCall(call.callId);
});

test('automatic voice final delivers useful links without narration, repeated tool links or credential URLs',async t=>{
 const {engine,store}=setup(t),call=await engine.startCall(sdp);await begin(engine,'background');await tool(engine,'background','send_message',{text:'Requested link https://example.test/one'},1);
 await engine.handle(event('item/completed',{turnId:'background',item:{id:'final',type:'agentMessage',text:'Spoken narration remains private. [One](https://example.test/one) [Two](https://example.test/two). https://example.test/private?token=sensitive https://name:password@example.test/private'}}));
 await engine.handle(event('turn/completed',{turn:{id:'background',status:'completed'}}));assert.deepEqual(store.state.messages.map(message=>message.text),['Requested link https://example.test/one','https://example.test/two']);await engine.stopCall(call.callId);
});

test('pause routes to exact native work, leaves the call connected and requires fresh action to work again',async t=>{
 const {engine,voice,worker,store}=setup(t),call=await engine.startCall(sdp);engine.confirmCallConnected(call.callId);
 const first=await voice.message({clientMessageId:'pause-first',text:'Work on this'});assert.deepEqual(voice.active,{messageId:first.message.id,turnId:'typed-1',source:'voice',status:'running'});
 const result=await engine.pause();assert.deepEqual(result,{paused:true,callId:call.callId,callContinues:true,turnIds:['typed-1']});assert.equal(first.message.status,'paused');assert.equal(voice.active,null);assert.equal(engine.call.status,'connected');assert.equal(worker.terminated,0);assert.equal(worker.calls.some(call=>call.method==='thread/realtime/stop'),false);
 await tick();assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);const duplicate=await voice.message({clientMessageId:'pause-first',text:'Work on this'});assert.equal(duplicate.duplicate,true);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);
 const next=await voice.message({clientMessageId:'pause-fresh',text:'A new task'});assert.equal(next.turnId,'typed-2');assert.equal(store.state.messages.filter(message=>message.role==='user').length,2);await engine.pause();await engine.stopCall(call.callId);
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

test('pause invalidates not-yet-submitted native text instead of replaying it after baseline preparation',async t=>{
 const collector=new EventEmitter();let release;collector.captureBaseline=()=>new Promise(resolve=>release=resolve);collector.archive=()=>[];
 const {engine,voice,worker,store}=setup(t,{engine:{deliverables:collector}}),call=await engine.startCall(sdp);const sending=voice.message({clientMessageId:'queued-before-pause',text:'Do not submit after pause'});const rejected=assert.rejects(sending,/paused before submission/);await tick();assert.equal(typeof release,'function');
 const result=await engine.pause();assert.equal(result.paused,true);assert.equal(store.state.messages[0].status,'paused');release({});await rejected;assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);assert.ok(engine.call);await engine.stopCall(call.callId);
});
