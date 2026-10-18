import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Engine} from '../src/engine.mjs';
import {NativeRealtimeVoice} from '../src/realtime.mjs';
import {Store} from '../src/store.mjs';
import {CredentialRequests,CredentialVault} from '../src/credentials.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
class Worker extends EventEmitter{
 constructor(dir){super();this.status='online';this.workspaceRoot=path.join(dir,'workspaces');this.desktopPath=path.join(dir,'desktop.py');this.calls=[];this.responses=[];this.terminated=0;this.nextTurn=0;this.rpc={reply:(id,result)=>this.responses.push({id,result}),send:value=>this.responses.push(value)};}
 event(method,params={}){this.emit('event',{method,params:{threadId:'thread',...params}});}
 async request(method,params){
  this.calls.push({method,params});
  if(method==='thread/start')return {thread:{id:'thread'}};
  if(method==='thread/realtime/start'){queueMicrotask(()=>{this.event('thread/realtime/started',{version:'v3',realtimeSessionId:'rt-'+params.voiceSessionId});this.event('thread/realtime/sdp',{sdp});});return {};}
  if(method==='thread/realtime/stop'){queueMicrotask(()=>this.event('thread/realtime/closed'));return {};}
  if(method==='thread/read'){const turns=[...(this.engine.nativeVoice?.session?.turns.values()||[])].map(turn=>({id:turn.turnId,status:turn.done?'completed':'inProgress'}));return {thread:{id:'thread',status:{type:turns.some(turn=>turn.status==='inProgress')?'active':'idle'},turns}};}
  if(method==='turn/start')return {turn:{id:'typed-'+ ++this.nextTurn}};
  if(method==='turn/interrupt'){queueMicrotask(()=>this.event('turn/completed',{turn:{id:params.turnId,status:'interrupted'}}));return {};}
  return {};
 }
 async terminateConfirmed(){this.terminated++;this.status='offline';this.emit('status');return {terminated:true};}
}
function fixture(t,{credentials=false,deliverables}={}){
 const dir=fs.mkdtempSync(path.join(base,'call-background-')),store=new Store(dir),worker=new Worker(dir),vault=credentials?new CredentialRequests({vault:new CredentialVault({dataDir:dir}),timeoutMs:5000}):null,engine=new Engine(store,worker,{credentials:vault,deliverables}),voice=new NativeRealtimeVoice({worker,engine,connectTimeoutMs:1000,stopTimeoutMs:1000}),notices=[];
 store.state.settings.language='en';worker.engine=engine;engine.on('notice',message=>notices.push(message));
 t.after(()=>{vault?.close();engine.pauseQueue();clearTimeout(engine.streamingSaveTimer);fs.rmSync(dir,{recursive:true,force:true});});
 const event=(method,params={},id)=>engine.handle({method,params:{threadId:'thread',...params},...(id===undefined?{}:{id})});
 return {store,worker,engine,voice,credentials:vault,notices,event,begin:id=>event('turn/started',{turn:{id,status:'inProgress'}}),output:(id,text)=>event('item/completed',{turnId:id,item:{id:id+'-answer',type:'agentMessage',text}}),finish:(id,status='completed',error)=>event('turn/completed',{turn:{id,status,...(error?{error:{message:error}}:{})}})};
}

test('normal native hangup ends media, keeps the accepted turn, and sends final output plus its completion to chat',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp);f.engine.confirmCallConnected(call.callId);await f.begin('accepted');await f.output('accepted','Verified background result');
 const result=await f.engine.stopCall(call.callId);assert.equal(result.workContinues,true);assert.equal(f.engine.call,null);assert.equal(f.voice.call,null);assert.equal(f.voice.active.turnId,'accepted');assert.equal(f.voice.active.background,true);assert.equal(f.store.state.messages.filter(item=>item.role==='assistant').length,0);assert.equal(f.worker.terminated,0);assert.equal(f.worker.calls.some(call=>call.method==='turn/interrupt'),false);
 assert.equal(f.worker.calls.filter(call=>call.method==='thread/realtime/start').length,1);
 const queued=f.store.add({role:'user',text:'Next request'});f.engine.enqueue(queued);await tick();assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);
 await f.finish('accepted');await tick();assert.equal(f.voice.session,null);assert.equal(f.store.state.messages.filter(item=>item.text==='Verified background result').length,1);assert.equal(f.store.state.completions.filter(item=>item.turnId==='accepted').length,1);assert.equal(f.store.state.messages.filter(item=>item.kind==='call').length,1);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);await f.finish('typed-1');
});

test('typed call input stays accepted while its actual delegated work continues after hangup and reports the final result',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp),sent=await f.voice.message({clientMessageId:'typed-work',text:'A typed task'});assert.equal(sent.message.status,'accepted');await f.begin('delegated-typed-work');await f.engine.stopCall(call.callId);assert.equal(sent.message.status,'accepted');await f.output('delegated-typed-work','The typed task finished');await f.finish('delegated-typed-work');assert.equal(sent.message.status,'accepted');assert.equal(f.store.state.messages.filter(item=>item.text==='The typed task finished').length,1);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,0);assert.equal(f.store.state.completions.filter(item=>item.turnId==='delegated-typed-work').length,1);
});

test('an exact adjustment cannot silently become new queued work after native media hangup',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp);await f.begin('owned-background');await f.engine.stopCall(call.callId);
 assert.equal(f.voice.progress.canSteer,true);const message=f.store.add({role:'user',text:'Adjust this same task'});
 await assert.rejects(f.engine.steer(message,'previous-background'),/active turn changed/);assert.equal(f.engine.queue.length,0);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'||call.method==='turn/steer'),false);
 await f.event('item/tool/requestUserInput',{turnId:'owned-background',questions:[{question:'Which project?'}]},701);assert.equal(f.voice.progress.canSteer,true);
 await f.engine.steer(message,'owned-background');assert.equal(f.engine.queue.length,0);assert.equal(f.worker.calls.filter(call=>call.method==='turn/steer').length,1);assert.equal(f.voice.progress.canSteer,true);assert.equal(f.voice.acceptsChatInput,false);await f.finish('owned-background');
});

test('explicit pause after media hangup waits for the matching turn stop before allowing desktop takeover',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp);await f.begin('pause-me');await f.engine.stopCall(call.callId);const request=f.worker.request.bind(f.worker);let interrupted;
 f.worker.request=(method,params)=>{if(method!=='turn/interrupt')return request(method,params);f.worker.calls.push({method,params});interrupted=params;return Promise.resolve({});};
 let acquired=false;const taking=f.engine.acquire().then(()=>acquired=true);await tick();assert.equal(interrupted.turnId,'pause-me');assert.equal(acquired,false);assert.equal(f.engine.takeover,false);assert.ok(f.voice.active);await f.event('turn/completed',{threadId:'foreign-thread',turn:{id:'foreign',status:'interrupted'}});assert.equal(acquired,false);await f.finish('pause-me','interrupted');await taking;assert.equal(f.voice.session,null);assert.equal(f.engine.takeover,true);assert.equal(f.worker.terminated,0);assert.match(f.store.state.messages.find(item=>item.role==='assistant').text,/stopped before completion/);assert.equal(f.store.state.completions.filter(item=>item.turnId==='pause-me').length,1);
});

test('a secure form pending before native hangup stays usable and creates one durable blocker receipt',async t=>{
 const f=fixture(t,{credentials:true}),call=await f.engine.startCall(sdp);await f.begin('credential-task');const pending=f.event('item/tool/call',{turnId:'credential-task',callId:'form-call',tool:'credential_request',arguments:{name:'Test login',service:'example.invalid',reason:'Continue accepted work'}},41);await tick();const request=f.credentials.snapshot().requests[0];assert.ok(request);assert.equal(f.store.state.messages.length,0);
 await f.engine.stopCall(call.callId);assert.equal(f.engine.call,null);assert.equal(f.voice.active.status,'waiting_user');assert.equal(f.credentials.snapshot().requests[0].id,request.id);const blocker=f.store.state.messages.find(item=>item.role==='assistant');assert.match(blocker.text,/secure credential form/);assert.equal(f.store.state.completions.filter(item=>item.turnId==='credential-task:credential:1').length,1);
 f.credentials.fulfill(request.id,{username:'fixture',secret:'synthetic-private-credential'});await pending;assert.equal(f.worker.responses.find(item=>item.id===41).result.success,true);assert.equal(f.voice.active.status,'running');await f.output('credential-task','Task finished');await f.finish('credential-task');assert.equal(f.store.state.completions.filter(item=>item.turnId==='credential-task').length,1);assert.equal(JSON.stringify(f.store.state).includes('synthetic-private-credential'),false);assert.equal(f.worker.calls.some(call=>call.method==='turn/interrupt'),false);
});

test('new background credential waits and input questions notify chat without starting a second turn',async t=>{
 const f=fixture(t,{credentials:true}),call=await f.engine.startCall(sdp);await f.begin('needs-input');await f.engine.stopCall(call.callId);
 const first=f.event('item/tool/call',{turnId:'needs-input',callId:'one',tool:'credential_request',arguments:{name:'First credential'}},51);await tick();f.credentials.fulfill(f.credentials.snapshot().requests[0].id,{secret:'synthetic-one'});await first;
 const second=f.event('item/tool/call',{turnId:'needs-input',callId:'two',tool:'credential_request',arguments:{name:'Second credential'}},52);await tick();f.credentials.fulfill(f.credentials.snapshot().requests[0].id,{secret:'synthetic-two'});await second;
 await f.event('item/tool/requestUserInput',{turnId:'needs-input',questions:[{question:'Which project should I use?'}]},53);assert.match(f.store.state.messages.at(-1).text,/Which project/);assert.ok(f.worker.responses.find(item=>item.id===53).error);assert.deepEqual(f.store.state.completions.map(item=>item.turnId),['needs-input:credential:1','needs-input:credential:2','needs-input:input:3']);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);await f.finish('needs-input');
});

test('failed background native work reports a redacted durable problem and completion receipt',async t=>{
 const f=fixture(t,{credentials:true}),call=await f.engine.startCall(sdp);f.credentials.upsert({name:'Test value',secret:'synthetic-private-value'});await f.begin('failed-background');await f.engine.stopCall(call.callId);await f.finish('failed-background','failed','Rejected synthetic-private-value');const message=f.store.state.messages.find(item=>item.role==='assistant');assert.match(message.text,/stopped before completion/);assert.match(message.text,/credential redacted/);assert.equal(JSON.stringify(f.store.state).includes('synthetic-private-value'),false);assert.equal(f.store.state.completions.filter(item=>item.turnId==='failed-background').length,1);assert.equal(f.voice.session,null);
});

test('hangup while result archiving is pending retains output and blocks a competing task until final persistence',async t=>{
 let releaseArchive,entered;const archiving=new Promise(resolve=>entered=resolve),f=fixture(t,{deliverables:{archive:()=>{if(releaseArchive)return [];entered();return new Promise(resolve=>releaseArchive=resolve);}}}),call=await f.engine.startCall(sdp);await f.begin('archive-race');await f.output('archive-race','Result that must survive hangup');const finishing=f.finish('archive-race');await archiving;
 await f.engine.stopCall(call.callId);assert.equal(f.engine.call,null);assert.equal(f.voice.active.turnId,'archive-race');assert.equal(f.voice.session.background,true);const next=f.store.add({role:'user',text:'Wait for archive'});f.engine.enqueue(next);await tick();assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);releaseArchive([]);await finishing;await tick();assert.equal(f.store.state.messages.filter(item=>item.text==='Result that must survive hangup').length,1);assert.equal(f.store.state.completions.filter(item=>item.turnId==='archive-race').length,1);assert.equal(f.voice.session,null);assert.equal(f.worker.terminated,0);await f.finish('typed-1');
});

test('uncertain ownership still confirms executor termination instead of continuing or replaying unknown work',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp);await f.begin('known');f.voice.unknown(f.voice.session,'untracked-handoff');await f.engine.stopCall(call.callId);assert.equal(f.worker.terminated,1);assert.equal(f.engine.call,null);assert.equal(f.voice.session,null);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);
});

test('a missing final turn event is reconciled from owned terminal history without interrupting or replaying it',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp);await f.begin('terminal-history');await f.output('terminal-history','Done before notification');const request=f.worker.request.bind(f.worker);f.worker.request=(method,params)=>method==='thread/read'?Promise.resolve({thread:{id:'thread',status:{type:'idle'},turns:[{id:'terminal-history',status:'completed'}]}}):request(method,params);await f.engine.stopCall(call.callId);await tick();assert.equal(f.voice.session,null);assert.equal(f.store.state.messages.filter(item=>item.text==='Done before notification').length,1);assert.equal(f.worker.calls.some(call=>call.method==='turn/interrupt'),false);assert.equal(f.worker.terminated,0);
});

test('the next chat message answers a background input blocker by steering the exact accepted native turn',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp);await f.begin('input-blocker');await f.engine.stopCall(call.callId);await f.event('item/tool/requestUserInput',{turnId:'input-blocker',questions:[{question:'Which folder?'}]},71);const message=f.store.add({role:'user',text:'Use the demo folder'});f.engine.enqueue(message,{interactive:true});await f.voice.session.messageChain;assert.equal(message.submission,'confirmed');assert.equal(f.engine.queue.length,0);const steers=f.worker.calls.filter(call=>call.method==='turn/steer');assert.equal(steers.length,1);assert.equal(steers[0].params.expectedTurnId,'input-blocker');assert.ok(steers[0].params.input[0].text.includes('Use the demo folder'));assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);await f.output('input-blocker','Folder task finished');await f.finish('input-blocker');assert.equal(message.status,'review');assert.equal(f.voice.session,null);
});

test('shutdown during a pending normal hangup overrides continuation and confirms the accepted task stopped',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp);await f.begin('shutdown-task');const request=f.worker.request.bind(f.worker);let releaseRead,reads=0;f.worker.request=(method,params)=>method==='thread/read'&&++reads===1?new Promise(resolve=>releaseRead=resolve):request(method,params);const stopping=f.engine.stopCall(call.callId);while(!releaseRead)await tick();const closing=f.voice.close();assert.equal(f.voice.session.continueWork,false);releaseRead({thread:{id:'thread',status:{type:'active'},turns:[{id:'shutdown-task',status:'inProgress'}]}});await stopping;await closing;assert.equal(f.voice.session,null);assert.equal(f.engine.call,null);assert.equal(f.worker.calls.filter(call=>call.method==='turn/interrupt').length,1);assert.equal(f.worker.terminated,0);
});

test('a completed background native task with no text or files still sends a durable completion notice',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp);await f.begin('quiet-task');await f.engine.stopCall(call.callId);await f.finish('quiet-task');assert.equal(f.store.state.messages.filter(item=>item.role==='assistant').length,1);assert.equal(f.store.state.completions.length,1);
});

test('a lost background reply acknowledgement stays locked until explicit Stop confirms executor termination',async t=>{
 const f=fixture(t),call=await f.engine.startCall(sdp);await f.begin('unknown-reply');await f.engine.stopCall(call.callId);await f.event('item/tool/requestUserInput',{turnId:'unknown-reply',questions:[{question:'Choose a project'}]},81);const request=f.worker.request.bind(f.worker);f.worker.request=(method,params)=>{if(method==='turn/steer'){f.worker.calls.push({method,params});return Promise.reject(Error('Reply acknowledgment lost'));}return request(method,params);};
 const answer=f.store.add({role:'user',text:'Use demo'});await assert.rejects(f.engine.steer(answer,'unknown-reply'),/acknowledgment lost/);assert.equal(answer.submission,'unknown');assert.equal(f.voice.session.unknown,true);assert.equal(f.engine.call,null);await assert.rejects(f.engine.startCall(sdp),/ownership to be confirmed/);
 let confirm;f.worker.terminateConfirmed=()=>new Promise(resolve=>confirm=resolve);let stopped=false;const stopping=f.engine.pause().then(()=>stopped=true);while(!confirm)await tick();assert.equal(stopped,false);assert.ok(f.voice.session);assert.equal(f.engine.takeover,false);confirm({terminated:true});await stopping;assert.equal(f.voice.session,null);assert.equal(f.worker.calls.filter(call=>call.method==='turn/steer').length,1);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);assert.equal(answer.submission,'unknown');
});

test('a native background archive failure persists a localized actionable problem without exposing the raw error',async t=>{
 const privateError='synthetic-private-archive-error',f=fixture(t,{deliverables:{archive:async()=>{throw Error(privateError);}}});f.store.state.settings.language='zh';const call=await f.engine.startCall(sdp);await f.begin('archive-failure');await f.output('archive-failure','Verified task result');await f.engine.stopCall(call.callId);await f.finish('archive-failure');const problem=f.store.state.messages.find(message=>message.text==='任务输出文件未能添加到聊天，请到工作电脑检查。');assert.ok(problem);assert.equal(f.store.state.completions.length,1);assert.ok(f.store.state.completions[0].messageIds.includes(problem.id));assert.equal(JSON.stringify(f.store.state).includes(privateError),false);assert.equal(f.notices.some(message=>message.includes(privateError)),false);assert.equal(f.voice.session,null);assert.equal(f.worker.calls.some(call=>call.method==='turn/interrupt'),false);
});

test('native task progress tracks only its exact owned events, survives quiet background work and leaves durable voice result metadata',async t=>{
 const f=fixture(t,{credentials:true}),call=await f.engine.startCall(sdp);assert.equal(f.voice.progress,null);await f.begin('progress-native');let progress=f.voice.progress;assert.equal(progress.source,'voice');assert.equal(progress.turnId,'progress-native');assert.equal(progress.step,'working');assert.ok(progress.startedAt>0);
 await f.event('item/started',{turnId:'progress-native',item:{id:'command-progress',type:'commandExecution',command:'private-command',arguments:{token:'private-arguments'}}});assert.equal(f.voice.progress.step,'command');const before=f.voice.progress;await f.event('item/started',{threadId:'foreign-thread',turnId:'progress-native',item:{id:'foreign',type:'fileChange'}});assert.deepEqual(f.voice.progress,before);await f.event('turn/plan/updated',{turnId:'progress-native',explanation:'private-reasoning',plan:[{step:'Inspect desktop',status:'completed'},{step:'Verify files',status:'inProgress'}]});assert.deepEqual(f.voice.progress.plan,{total:2,completed:1,currentStep:'Verify files',steps:[{step:'Inspect desktop',status:'completed'},{step:'Verify files',status:'inProgress'}]});assert.equal(f.voice.progress.title,'Inspect desktop');assert.equal(f.store.state.workTasks.find(item=>item.turnId==='progress-native').plan.steps.length,2);assert.equal(JSON.stringify(f.store.state.workTasks).includes('private-'),false);
 await f.engine.stopCall(call.callId);assert.equal(f.voice.progress.background,true);const quiet=f.voice.progress;for(let index=0;index<50;index++)assert.deepEqual(f.voice.progress,quiet);assert.equal(f.worker.calls.some(call=>call.method==='turn/interrupt'),false);await f.output('progress-native','Verified task result');await f.finish('progress-native');assert.equal(f.voice.progress,null);const completion=f.store.state.completions.find(item=>item.turnId==='progress-native');assert.equal(completion.work.source,'voice');assert.equal(completion.work.status,'review');assert.ok(completion.work.updatedAt>=completion.work.startedAt);assert.equal(f.store.state.messages.find(item=>item.text==='Verified task result').source.type,'voice-call');assert.equal(JSON.stringify(completion).includes('private-'),false);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);
});
