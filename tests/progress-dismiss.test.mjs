import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {createWorkerApp} from '../src/server.mjs';

const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});
const status=expected=>error=>error.status===expected;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Worker extends EventEmitter{
 constructor(){super();this.status='offline';this.calls=[];}
 async request(method,params){this.calls.push({method,params});return method==='thread/start'?{thread:{id:'thread'}}:method==='turn/start'?{turn:{id:'new-turn'}}:{};}
 disconnect(){this.status='offline';this.emit('status');}
}
function setup(t){
 const dir=fs.mkdtempSync(path.join(root,'progress-dismiss-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),worker=new Worker(),engine=new Engine(store,worker);store.state.threadId='retained-thread';store.state.threadRuntime=engine.runtimeId;store.state.threadConversationId=store.state.conversationId;store.state.voiceHistory=[{text:'Retained spoken context',status:'submitted'}];store.save();
 return {dir,store,worker,engine};
}
function withoutDismissal(state){
 const copy=structuredClone(state);for(const entry of [...copy.messages,...copy.completions])delete entry.progressDismissedAt;return copy;
}
function voiceResult(store,{turnId='voice-turn',taskId,work={source:'voice',status:'review'}}={}){
 const answer=store.add({role:'assistant',text:'Task result',status:'completed',source:{type:'voice-call'},read:false});
 return store.addCompletion({turnId,taskId,messageIds:[answer.id],work});
}

test('dismissing inactive task history changes only persistent progress metadata, including after restart',t=>{
 const {dir,store,engine,worker}=setup(t);
 for(const taskState of ['paused','failed','review','completed']){
  const task=store.add({role:'user',text:'Keep this conversation',status:taskState,turnId:'old-'+taskState,acceptedAt:taskState==='completed'?123:null,read:false});
  const before=withoutDismissal(store.state);assert.deepEqual(engine.dismissProgress(task.id,'task'),{ok:true});assert.ok(task.progressDismissedAt>0);const at=task.progressDismissedAt;
  assert.deepEqual(engine.dismissProgress(task.id,'task'),{ok:true});assert.equal(task.progressDismissedAt,at);assert.deepEqual(withoutDismissal(store.state),before);
 }
 const reopened=new Store(dir);assert.ok(reopened.state.messages.every(message=>message.progressDismissedAt>0));assert.deepEqual(withoutDismissal(reopened.state),withoutDismissal(store.state));assert.equal(worker.calls.length,0);assert.equal(engine.active,null);assert.equal(engine.queue.length,0);
});

test('only final voice result receipts can be dismissed, without marking results read or accepting work',t=>{
 const {dir,store,engine}=setup(t),result=voiceResult(store),before=withoutDismissal(store.state);
 assert.deepEqual(engine.dismissProgress(result.id,'completion'),{ok:true});assert.deepEqual(withoutDismissal(store.state),before);assert.equal(result.readAt,null);assert.equal(result.work.status,'review');assert.equal(store.state.messages[0].read,false);assert.ok(new Store(dir).state.completions[0].progressDismissedAt>0);
 for(const receipt of [store.addCompletion({turnId:'ordinary',messageIds:[store.state.messages[0].id]}),voiceResult(store,{turnId:'turn:input:1'}),voiceResult(store,{turnId:'turn:credential:1'}),store.addCompletion({turnId:'gone-result',messageIds:['missing'],work:{source:'voice',status:'failed'}})])assert.throws(()=>engine.dismissProgress(receipt.id,'completion'),status(409));
 const malformed=voiceResult(store,{turnId:'malformed'});malformed.work.status='running';assert.throws(()=>engine.dismissProgress(malformed.id,'completion'),status(409));
});

test('invalid, missing, non-user and unfinished entries cannot be dismissed',t=>{
 const {store,engine}=setup(t);
 for(const id of [undefined,'','x'.repeat(129)])assert.throws(()=>engine.dismissProgress(id,'task'),status(400));
 for(const kind of [undefined,'message','constructor',null])assert.throws(()=>engine.dismissProgress('id',kind),status(400));
 for(const kind of ['task','completion'])assert.throws(()=>engine.dismissProgress('missing',kind),status(404));
 for(const taskState of ['draft','queued','running','waiting_user','pausing']){
  const task=store.add({role:'user',text:'Unfinished work',status:taskState});assert.throws(()=>engine.dismissProgress(task.id,'task'),status(409));assert.equal(task.progressDismissedAt,undefined);
 }
 const assistant=store.add({role:'assistant',text:'Keep',status:'completed'});assert.throws(()=>engine.dismissProgress(assistant.id,'task'),status(409));
});

test('active task aliases, steered turns, pending output persistence and queue ownership remain visible',t=>{
 const {store,engine,worker}=setup(t),original=store.add({role:'user',text:'Original task',status:'review',turnId:'owned'}),steered=store.add({role:'user',text:'Steered task',status:'paused',turnId:'owned'}),pending=store.add({role:'user',text:'Pending steer',status:'paused',parentTaskId:original.id}),old=store.add({role:'user',text:'Earlier unrelated task',status:'review',turnId:'old'}),result=voiceResult(store,{turnId:'owned',taskId:original.id});
 engine.active={messageId:original.id,messageIds:[original.id],turnId:'owned',finishing:Promise.resolve()};
 for(const task of [original,steered,pending])assert.throws(()=>engine.dismissProgress(task.id,'task'),status(409));assert.throws(()=>engine.dismissProgress(result.id,'completion'),status(409));
 assert.deepEqual(engine.dismissProgress(old.id,'task'),{ok:true});assert.equal(engine.active.turnId,'owned');assert.equal(worker.calls.length,0);
 engine.active=null;engine.queue=[original];assert.throws(()=>engine.dismissProgress(original.id,'task'),status(409));assert.throws(()=>engine.dismissProgress(steered.id,'task'),status(409));engine.queue=[];
 assert.deepEqual(engine.dismissProgress(original.id,'task'),{ok:true});
});

test('native owned turns, aliases and unresolved same-call submissions cannot be hidden',t=>{
 const {store,engine}=setup(t),alias=store.add({role:'user',text:'Steered native task',status:'paused',turnId:'native-turn'}),explicit=store.add({role:'user',text:'Accepted native input',status:'review'}),unknown=store.add({role:'user',text:'Unconfirmed native reply',status:'paused',submission:'unknown',voiceCallId:'call'}),result=voiceResult(store,{turnId:'native-turn'});
 const turn={turnId:'native-turn',messageId:null,explicitMessageIds:[explicit.id],done:false,resultSaved:false};engine.nativeVoice={active:{turnId:'native-turn'},session:{id:'call',unknown:true,turns:new Map([['native-turn',turn]])}};
 for(const task of [alias,explicit,unknown])assert.throws(()=>engine.dismissProgress(task.id,'task'),status(409));assert.throws(()=>engine.dismissProgress(result.id,'completion'),status(409));
 engine.nativeVoice.active=null;engine.nativeVoice.session.unknown=false;turn.done=true;assert.throws(()=>engine.dismissProgress(result.id,'completion'),status(409));turn.resultSaved=true;turn.pendingSubmissions=1;assert.throws(()=>engine.dismissProgress(result.id,'completion'),status(409));turn.pendingSubmissions=0;
 assert.deepEqual(engine.dismissProgress(alias.id,'task'),{ok:true});assert.deepEqual(engine.dismissProgress(result.id,'completion'),{ok:true});
});

test('dismissal persistence failure rolls back only its marker and does not mutate the task',t=>{
 const {store,engine}=setup(t),task=store.add({role:'user',text:'Keep task',status:'review'}),before=structuredClone(store.state),save=store.save;
 store.save=()=>{throw Error('Storage unavailable');};assert.throws(()=>engine.dismissProgress(task.id,'task'),/Storage unavailable/);assert.deepEqual(store.state,before);
 task.progressDismissedAt='invalid';assert.throws(()=>engine.dismissProgress(task.id,'task'),/Storage unavailable/);assert.equal(task.progressDismissedAt,'invalid');store.save=save;
});

test('explicitly resuming dismissed work clears its marker and surfaces the actual next run',async t=>{
 const {dir,store,engine,worker}=setup(t),task=store.add({role:'user',text:'Resume me',status:'paused',submission:'unknown'});engine.dismissProgress(task.id,'task');const dismissed=task.progressDismissedAt;
 assert.throws(()=>engine.resumePaused([task.id]),/explicitly confirm/);assert.equal(task.progressDismissedAt,dismissed);assert.equal(engine.queue.length,0);
 engine.resumePaused([task.id],{confirmUnknown:true});assert.equal(task.progressDismissedAt,null);assert.equal(task.status,'queued');assert.equal(engine.queue[0].id,task.id);assert.equal(worker.calls.length,0);
 const reopened=new Store(dir);assert.equal(reopened.state.messages[0].progressDismissedAt,null);assert.equal(reopened.state.messages[0].status,'paused');
 worker.status='online';worker.emit('status');await tick();assert.equal(engine.active.messageId,task.id);assert.equal(task.progressDismissedAt,null);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);
 await engine.handle({method:'turn/completed',params:{threadId:'retained-thread',turn:{id:'new-turn',status:'completed'}}});assert.equal(task.status,'review');assert.equal(task.progressDismissedAt,null);assert.equal(engine.active,null);
});

test('enqueue clears history dismissal only once the task may enter accepted work paths',t=>{
 const {store,engine}=setup(t),task=store.add({role:'user',text:'Run again',status:'paused'});engine.dismissProgress(task.id,'task');const dismissed=task.progressDismissedAt;
 engine.takeover=true;engine.enqueue(task);assert.equal(task.progressDismissedAt,dismissed);engine.takeover=false;engine.call={provider:'subscription'};engine.enqueue(task);assert.equal(task.progressDismissedAt,dismissed);engine.call=null;
 let received;engine.nativeVoice={acceptsChatInput:true,answerBackground:async message=>{received=message;}};engine.enqueue(task);assert.equal(received,task);assert.equal(task.progressDismissedAt,null);assert.equal(engine.queue.length,0);
});

async function apiSetup(t){
 const dir=fs.mkdtempSync(path.join(root,'progress-dismiss-api-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 class Provider extends EventEmitter{constructor(){super();this.state={available:true};this.active=null;this.progress=null;this.session=null;}async close(){}}
 const worker=new Worker(),nativeVoice=new Provider(),voice=new Provider(),instance=createWorkerApp({dataDir:dir,workerFactory:()=>worker,voiceFactory:()=>voice,nativeVoiceFactory:()=>nativeVoice});
 t.after(async()=>{instance.engine.active=null;nativeVoice.active=null;nativeVoice.progress=null;nativeVoice.session=null;await instance.close();});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(base+'/api/session').then(response=>response.json());
 const post=(id,body,authorized=true)=>fetch(base+'/api/tasks/'+encodeURIComponent(id)+'/dismiss',{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Dant-Token':token}:{})},body:JSON.stringify(body)});
 return {instance,worker,nativeVoice,post};
}

test('authenticated dismiss API persists idempotent task and final voice history metadata only',async t=>{
 const {instance,worker,post}=await apiSetup(t),{store,engine}=instance,task=store.add({role:'user',text:'Keep chat',status:'review'}),completion=voiceResult(store),before=withoutDismissal(store.state);let changes=0;engine.on('change',()=>changes++);
 assert.equal((await post(task.id,{kind:'task'},false)).status,401);assert.equal(task.progressDismissedAt,undefined);
 for(const [id,kind] of [[task.id,'task'],[completion.id,'completion']]){
  const response=await post(id,{kind});assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.deepEqual(await (await post(id,{kind})).json(),{ok:true});
 }
 assert.equal(changes,4);assert.deepEqual(withoutDismissal(store.state),before);assert.equal(worker.calls.length,0);assert.equal(engine.active,null);assert.equal(engine.queue.length,0);
});

test('dismiss API returns safe errors for invalid, missing, owned and persistence-failed requests',async t=>{
 const {instance,post,nativeVoice}=await apiSetup(t),{store,engine}=instance,task=store.add({role:'user',text:'SYNTHETIC_PRIVATE_CONTENT',status:'paused',turnId:'active-turn'}),completion=voiceResult(store,{turnId:'active-turn'});
 assert.equal((await post(task.id,{})).status,400);assert.equal((await post('missing',{kind:'task'})).status,404);
 engine.queue=[task];assert.equal((await post(task.id,{kind:'task'})).status,409);engine.queue=[];
 nativeVoice.session={turns:new Map([['active-turn',{turnId:'active-turn',done:true,resultSaved:false}]])};assert.equal((await post(completion.id,{kind:'completion'})).status,409);nativeVoice.session=null;
 const save=store.save;store.save=()=>{throw Error('SYNTHETIC_SECRET_PATH');};const response=await post(task.id,{kind:'task'}),body=await response.json();store.save=save;
 assert.equal(response.status,409);assert.equal(JSON.stringify(body).includes('SYNTHETIC_'),false);assert.equal(task.progressDismissedAt,undefined);assert.equal(completion.progressDismissedAt,undefined);assert.equal(task.status,'paused');
});
