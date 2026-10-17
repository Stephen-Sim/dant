import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {NativeRealtimeVoice} from '../src/realtime.mjs';
import {TASK_PLAN_SCHEMA,taskPlanInput,isTaskExecutionEvent,registeredWorkFinalStatus,taskProgressSnapshot,startTaskProgress} from '../src/task-progress.mjs';

const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const steps=()=>[{step:'Create a private room',status:'completed'},{step:'Verify the match with the human',status:'inProgress'}];
const plan=()=>({title:'Private room match test',steps:steps()});
function storeFixture(t){const dir=fs.mkdtempSync(path.join(base,'work-continuity-')),store=new Store(dir);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {store,dir};}
function register(store,turnId,extra={}){return store.registerWork({turnId,source:'voice',title:plan().title,plan:taskPlanInput(plan()).plan,...extra});}

test('task plan continuations use an explicit work ID rather than interpreting a title or every conversational sentence as a task',()=>{
 const parsed=taskPlanInput({...plan(),workId:'stable-work'});assert.equal(parsed.workId,'stable-work');assert.equal(TASK_PLAN_SCHEMA.workId.type,'string');assert.deepEqual(parsed.plan.steps,steps());
 for(const workId of [null,7,'','with spaces','x'.repeat(129)])assert.throws(()=>taskPlanInput({...plan(),workId}),/task plan/);
 assert.equal(Object.hasOwn(taskPlanInput(plan()),'workId'),false);
});

test('unfinished registered work remains continuing after a successful executor turn without claiming an executor is active',()=>{
 const task={workRecord:{plan:{steps:steps()}}};assert.equal(registeredWorkFinalStatus(task,'review'),'continuing');task.awaitingChatInput=true;assert.equal(registeredWorkFinalStatus(task,'review'),'waiting_user');task.awaitingChatInput=false;task.credentialWaits=1;assert.equal(registeredWorkFinalStatus(task,'review'),'waiting_user');for(const status of ['paused','failed','completed'])assert.equal(registeredWorkFinalStatus(task,status),status);
 task.workRecord.plan.steps=steps().map(step=>({...step,status:'completed'}));assert.equal(registeredWorkFinalStatus(task,'review'),'review');assert.equal(registeredWorkFinalStatus({},'review'),'review');
});

test('a task explicitly continues across owned turns with one stable ID, original start and accumulated turn history',t=>{
 const {store}=storeFixture(t),first=register(store,'turn-one',{startedAt:100,messageId:'original-message'});store.updateRegisteredWork(first.turnId,{status:'continuing'});const next=register(store,'turn-two',{workId:first.id,source:'chat',startedAt:500,messageId:'followup-message'});assert.equal(next.id,first.id);assert.equal(next.turnId,'turn-two');assert.deepEqual(next.turnIds,['turn-one','turn-two']);assert.equal(next.startedAt,100);assert.equal(next.messageId,'original-message');assert.equal(next.source,'voice');assert.equal(store.state.workTasks.length,1);assert.equal(next.status,'running');
 store.updateRegisteredWork(next.turnId,{status:'waiting_user'});const third=register(store,'turn-three',{workId:first.id});assert.equal(third.id,first.id);assert.deepEqual(third.turnIds,['turn-one','turn-two','turn-three']);const task={turnId:'turn-three',workRecord:third};startTaskProgress(task,{at:900});assert.equal(taskProgressSnapshot(task).startedAt,100);assert.equal(store.updateRegisteredWork('turn-one',{status:'failed'}),null,'a late older turn cannot change the rebound task');
});

test('unrelated work with the same title creates a separate task and never steals the unfinished record',t=>{
 const {store}=storeFixture(t),first=register(store,'first');store.updateRegisteredWork(first.turnId,{status:'continuing'});const unrelated=register(store,'unrelated');assert.notEqual(unrelated.id,first.id);assert.equal(store.state.workTasks.length,2);assert.equal(store.state.workTasks[0].status,'continuing');assert.deepEqual(store.state.workTasks[0].turnIds,['first']);
});

test('task continuation rejects unknown IDs, conflicting owners, finalized tasks and historical-turn reuse',t=>{
 const {store}=storeFixture(t),first=register(store,'first');assert.throws(()=>register(store,'next',{workId:'unknown'}),/not found/);for(const status of ['running','unknown','pausing','review','completed','failed']){store.updateRegisteredWork('first',{status});assert.throws(()=>register(store,'next',{workId:first.id}),/inactive unfinished/);}
 store.updateRegisteredWork('first',{status:'paused'});const second=register(store,'second',{workId:first.id});const other=register(store,'other');assert.throws(()=>register(store,'other',{workId:first.id}),/different task/);assert.throws(()=>register(store,'second',{workId:other.id}),/different task/);store.updateRegisteredWork('second',{status:'continuing'});assert.throws(()=>register(store,'first',{workId:first.id}),/previous task turn/);assert.throws(()=>register(store,'first'),/different task/);assert.equal(store.state.workTasks[0].turnId,second.turnId);assert.equal(store.state.workTasks.length,2);
});

test('continuation rebinding rolls back atomically on save failure and continuing history survives restart',t=>{
 const {store,dir}=storeFixture(t),first=register(store,'first',{startedAt:100});store.updateRegisteredWork('first',{status:'continuing'});const before=structuredClone(store.state.workTasks),save=store.save;store.save=()=>{throw Error('Disk is full');};assert.throws(()=>register(store,'second',{workId:first.id}),/Disk is full/);assert.deepEqual(store.state.workTasks,before);store.save=save;const restored=new Store(dir);assert.equal(restored.state.workTasks[0].status,'continuing');assert.deepEqual(restored.state.workTasks[0].turnIds,['first']);assert.equal(restored.state.workTasks[0].startedAt,100);const next=register(restored,'second',{workId:first.id});assert.equal(next.id,first.id);assert.equal(next.status,'running');assert.equal(new Store(dir).state.workTasks[0].status,'paused');
});

test('historical task messages cannot resume an older execution, including an entire mixed resume batch',t=>{
 const {store}=storeFixture(t),record=register(store,'original-turn');store.updateRegisteredWork(record.turnId,{status:'continuing'});const current=register(store,'current-turn',{workId:record.id});store.updateRegisteredWork(current.turnId,{status:'paused'});
 const old=store.add({role:'user',text:'Original work',turnId:'original-turn',workId:record.id,status:'paused',submission:'confirmed'}),latest=store.add({role:'user',text:'Current step',turnId:'current-turn',workId:record.id,status:'paused',submission:'confirmed'}),independent=store.add({role:'user',text:'Independent paused work',status:'paused',submission:'confirmed'}),worker=new EventEmitter();worker.status='offline';worker.request=()=>{throw Error('Must not reach executor');};const engine=new Engine(store,worker),enqueued=[];engine.enqueue=message=>enqueued.push(message.id);
 assert.throws(()=>engine.resumePaused([old.id]),/earlier task step/);assert.equal(old.submission,'confirmed');assert.deepEqual(enqueued,[]);
 assert.throws(()=>engine.resumePaused([independent.id,old.id]),/earlier task step/);assert.equal(independent.submission,'confirmed','the whole selection must validate before any task is mutated');assert.deepEqual(enqueued,[]);
 assert.deepEqual(engine.resumePaused([latest.id]).map(message=>message.id),[latest.id]);assert.deepEqual(enqueued,[latest.id]);assert.equal(latest.submission,null);assert.equal(store.state.workTasks[0].turnId,'current-turn');
});

test('accepting a historical review cannot complete the current task while its actual current result can',t=>{
 const {store}=storeFixture(t),record=register(store,'original-turn');store.updateRegisteredWork(record.turnId,{status:'continuing'});register(store,'current-turn',{workId:record.id});store.updateRegisteredWork('current-turn',{status:'review',plan:{steps:steps().map(step=>({...step,status:'completed'}))}});
 const old=store.add({role:'user',text:'Original work',turnId:'original-turn',status:'review'}),latest=store.add({role:'user',text:'Current result',turnId:'current-turn',workId:record.id,status:'review'}),worker=new EventEmitter();worker.status='offline';const engine=new Engine(store,worker);
 assert.throws(()=>engine.confirm(old.id),/earlier task step/);assert.equal(old.status,'review');assert.equal(old.acceptedAt,undefined);assert.equal(latest.status,'review');assert.equal(store.state.workTasks[0].status,'review');
 assert.equal(engine.confirm(latest.id),latest);assert.equal(latest.status,'completed');assert.equal(store.state.workTasks[0].status,'completed');assert.equal(old.status,'review');
});

test('long-running work retains its original turn anchor beyond 1024 continuations and restart',t=>{
 const {store,dir}=storeFixture(t),record=register(store,'turn-0',{messageId:'original-message'}),turnIds=Array.from({length:1026},(_,index)=>'turn-'+index);Object.assign(record,{turnId:turnIds.at(-1),turnIds,status:'continuing'});store.add({id:'original-message',role:'user',text:'Original request',turnId:'turn-0',status:'paused',submission:'confirmed'});store.save();
 const restored=new Store(dir);assert.deepEqual(restored.state.workTasks[0].turnIds,turnIds);const next=register(restored,'turn-1026',{workId:record.id});assert.equal(next.messageId,'original-message');assert.equal(next.turnIds.length,1027);assert.equal(next.turnIds[0],'turn-0');assert.equal(next.turnIds.at(-1),'turn-1026');assert.throws(()=>register(restored,'turn-0'),/different task/);
 const worker=new EventEmitter();worker.status='offline';const engine=new Engine(restored,worker);assert.throws(()=>engine.resumePaused(['original-message']),/earlier task step/);assert.equal(engine.queue.length,0);
});

test('ended work waiting for a human survives restart while an in-flight wait pauses, and continuation clears the ended marker',t=>{
 const {store,dir}=storeFixture(t),ended=register(store,'ended-wait'),live=register(store,'live-wait');
 store.updateRegisteredWork('ended-wait',{status:'waiting_user',executionEnded:true});store.updateRegisteredWork('live-wait',{status:'waiting_user'});const endedAt=store.state.workTasks.find(record=>record.id===ended.id).executionEndedAt;assert.ok(endedAt);
 const restored=new Store(dir),waiting=restored.state.workTasks.find(record=>record.id===ended.id),interrupted=restored.state.workTasks.find(record=>record.id===live.id);
 assert.equal(waiting.status,'waiting_user');assert.equal(waiting.executionEndedAt,endedAt);assert.equal(waiting.pauseReason,undefined);assert.equal(interrupted.status,'paused');assert.equal(interrupted.pauseReason,'restart');assert.equal(interrupted.executionEndedAt,undefined);
 const continued=register(restored,'human-answer',{workId:ended.id});assert.equal(continued.id,ended.id);assert.equal(continued.status,'running');assert.equal(continued.executionEndedAt,undefined);assert.deepEqual(continued.turnIds,['ended-wait','human-answer']);assert.equal(new Store(dir).state.workTasks.find(record=>record.id===ended.id).status,'paused','the new execution turn is active again and cannot be restored as an ended wait');
});

test('legacy unfinished review migrates to continuing while accepted completion is preserved and inactive continuing can be hidden',t=>{
 const {store,dir}=storeFixture(t),unfinished=register(store,'unfinished'),accepted=register(store,'accepted');store.updateRegisteredWork('unfinished',{status:'review'});store.updateRegisteredWork('accepted',{status:'completed'});const restored=new Store(dir);assert.equal(restored.state.workTasks.find(record=>record.id===unfinished.id).status,'continuing');assert.equal(restored.state.workTasks.find(record=>record.id===accepted.id).status,'completed');assert.deepEqual(restored.dismissProgress(unfinished.id,'work',{confirmUnfinished:true}),{ok:true});assert.ok(restored.state.workTasks.find(record=>record.id===unfinished.id).progressDismissedAt);const next=register(restored,'continued',{workId:unfinished.id});assert.equal(next.progressDismissedAt,undefined);assert.equal(next.id,unfinished.id);assert.equal(next.status,'running');
});

test('execution detection excludes ordinary speech, acknowledgements, reactions and conversational memory tools',()=>{
 for(const method of ['item/started','item/completed']){
  for(const type of ['agentMessage','reasoning','userMessage'])assert.equal(isTaskExecutionEvent({method,params:{item:{id:'item',type}}}),false);
  for(const tool of ['send_message','send_chat_message','react_message','end_call','memory_write','skill_list','skill_get','credential_find','credential_get','task_plan','schedule_list','schedule_save','schedule_delete'])for(const type of ['mcpToolCall','dynamicToolCall'])assert.equal(isTaskExecutionEvent({method,params:{item:{id:'item',type,tool}}}),false);
  for(const type of ['commandExecution','fileChange','imageView','imageGeneration','webSearch','collabAgentToolCall'])assert.equal(isTaskExecutionEvent({method,params:{item:{id:'item',type}}}),true);
  assert.equal(isTaskExecutionEvent({method,params:{item:{id:'desktop',type:'mcpToolCall',server:'dant_desktop',tool:'screenshot'}}}),true);
 }
 assert.equal(isTaskExecutionEvent({method:'item/tool/call',params:{tool:'skill_save'}}),true);assert.equal(isTaskExecutionEvent({method:'item/tool/call',params:{tool:'send_message'}}),false);assert.equal(isTaskExecutionEvent({method:'item/tool/requestUserInput'}),false);
});

const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
class Worker extends EventEmitter{
 constructor(){super();this.status='online';this.calls=[];this.rpc={reply(){},send(){}};}
 async request(method,params){this.calls.push({method,params});const event=(method,params)=>this.emit('event',{method,params:{threadId:'thread',...params}});if(method==='thread/start')return {thread:{id:'thread'}};if(method==='thread/realtime/start'){queueMicrotask(()=>{event('thread/realtime/started',{version:'v3'});event('thread/realtime/sdp',{sdp});});return {};}if(method==='thread/realtime/stop'){queueMicrotask(()=>event('thread/realtime/closed',{}));return {};}if(method==='thread/read'){const turns=[...(this.engine.nativeVoice.session?.turns.values()||[])].map(turn=>({id:turn.turnId,status:turn.done?'completed':'inProgress'}));return {thread:{id:'thread',status:{type:turns.some(turn=>turn.status==='inProgress')?'active':'idle'},turns}};}return {};}
}
async function nativeFixture(t){const {store}=storeFixture(t),worker=new Worker(),engine=new Engine(store,worker),voice=new NativeRealtimeVoice({worker,engine,connectTimeoutMs:1000,stopTimeoutMs:1000}),event=(method,params={},id)=>engine.handle({method,params:{threadId:'thread',...params},...(id===undefined?{}:{id})});worker.engine=engine;const call=await engine.startCall(sdp);t.after(()=>{engine.pauseQueue();clearTimeout(engine.streamingSaveTimer);});return {store,worker,engine,voice,call,event,begin:id=>event('turn/started',{turn:{id,status:'inProgress'}}),finish:id=>event('turn/completed',{turn:{id,status:'completed'}})};}

test('native conversation ownership becomes visible when uncertain, pausing or actually waiting without creating work',async t=>{
 const f=await nativeFixture(t);await f.begin('conversation-turn');const turn=f.voice.session.turns.get('conversation-turn'),session=f.voice.session;assert.equal(f.voice.progress.visible,false);
 for(const [target,key,status]of [[session,'unknown','unknown'],[session,'pausing','pausing'],[turn,'pauseRequested','pausing'],[turn,'awaitingChatInput','waiting_user'],[turn,'credentialWaits','waiting_user']]){
  target[key]=true;assert.equal(f.voice.progress.status,status);assert.equal(f.voice.progress.visible,true);assert.equal(f.store.state.workTasks.length,0);target[key]=false;assert.equal(f.voice.progress.visible,false);
 }
 await f.finish('conversation-turn');await f.engine.stopCall(f.call.callId);assert.equal(f.store.state.workTasks.length,0);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);
});

test('engine conversation markers hide only known speech and preserve unknown, waiting and stopping ownership',t=>{
 const {store}=storeFixture(t),worker=new EventEmitter();worker.status='online';const engine=new Engine(store,worker),message=store.add({role:'user',text:'Ordinary conversation',turnId:'conversation-turn',workKind:'conversation',status:'running',submission:'confirmed'}),active={messageId:message.id,messageIds:[message.id],turnId:'conversation-turn',startAcknowledged:true,conversationalInput:true};startTaskProgress(active);engine.active=active;assert.equal(engine.progress.visible,false);
 message.submission='unknown';assert.equal(engine.progress.status,'unknown');assert.notEqual(engine.progress.visible,false);message.submission='confirmed';
 for(const [key,status]of [['steerUnconfirmed','unknown'],['stopRequested','pausing'],['awaitingChatInput','waiting_user'],['credentialWaits','waiting_user']]){active[key]=true;assert.equal(engine.progress.status,status);assert.notEqual(engine.progress.visible,false);active[key]=false;assert.equal(engine.progress.visible,false);}
 engine.pendingUserRequests.set('human-request',{});assert.equal(engine.progress.status,'waiting_user');assert.notEqual(engine.progress.visible,false);engine.pendingUserRequests.clear();assert.equal(engine.progress.visible,false);assert.equal(store.state.workTasks.length,0);engine.active=null;
});

test('native speech-only turns keep execution ownership but never appear as an entrusted task',async t=>{
 const f=await nativeFixture(t);await f.begin('speech-only');assert.equal(f.voice.active.turnId,'speech-only');assert.equal(f.voice.progress.visible,false);await f.event('item/agentMessage/delta',{turnId:'speech-only',itemId:'answer',delta:'Sure, I understand.'});assert.equal(f.voice.progress.visible,false);await f.finish('speech-only');assert.equal(f.voice.progress,null);assert.equal(f.store.state.workTasks.length,0);assert.equal(f.store.state.completions.length,0);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);await f.engine.stopCall(f.call.callId);
});

test('a registered native task survives handoff boundaries and only the completed full plan becomes review',async t=>{
 const f=await nativeFixture(t);await f.begin('room-created');let turn=f.voice.session.turns.get('room-created');const first=await f.voice.tool(f.voice.session,turn,'task_plan',plan());assert.equal(f.voice.progress.visible,true);const started=f.voice.progress.startedAt;await f.finish('room-created');assert.equal(f.voice.active,null);assert.equal(f.store.state.workTasks[0].status,'continuing');await f.begin('match-continued');assert.equal(f.voice.progress.visible,false);turn=f.voice.session.turns.get('match-continued');const second=await f.voice.tool(f.voice.session,turn,'task_plan',{...plan(),workId:first.workId});assert.equal(second.workId,first.workId);assert.equal(f.voice.progress.visible,true);assert.equal(f.voice.progress.startedAt,started);assert.deepEqual(f.store.state.workTasks[0].turnIds,['room-created','match-continued']);assert.equal(f.store.state.workTasks.length,1);await f.voice.tool(f.voice.session,turn,'task_plan',{...plan(),workId:first.workId,steps:steps().map(step=>({...step,status:'completed'}))});await f.finish('match-continued');assert.equal(f.store.state.workTasks[0].status,'review');assert.equal(f.voice.active,null);await f.begin('just-a-conversation');await f.event('item/agentMessage/delta',{turnId:'just-a-conversation',itemId:'speech',delta:'Thanks for testing.'});assert.equal(f.voice.progress.visible,false);await f.finish('just-a-conversation');assert.equal(f.store.state.workTasks.length,1);assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);await f.engine.stopCall(f.call.callId);
});

test('native finalization persists the execution boundary for unfinished work awaiting a human reply',async t=>{
 const f=await nativeFixture(t);await f.begin('need-human');const turn=f.voice.session.turns.get('need-human');await f.voice.tool(f.voice.session,turn,'task_plan',plan());turn.awaitingChatInput=true;await f.finish('need-human');
 assert.equal(f.store.state.workTasks[0].status,'waiting_user');assert.ok(f.store.state.workTasks[0].executionEndedAt);assert.equal(f.voice.active,null);assert.equal(new Store(f.store.dir).state.workTasks[0].status,'waiting_user');assert.equal(f.worker.calls.some(call=>call.method==='turn/start'),false);await f.engine.stopCall(f.call.callId);
});

test('actual native execution is visible even before its public plan arrives without creating speculative task records',async t=>{
 const f=await nativeFixture(t);await f.begin('actual-work');assert.equal(f.voice.progress.visible,false);await f.event('item/started',{turnId:'actual-work',item:{id:'command',type:'commandExecution',command:'private-command'}});assert.equal(f.voice.progress.visible,true);assert.equal(f.voice.progress.step,'command');assert.equal(f.store.state.workTasks.length,0);assert.equal(JSON.stringify(f.voice.progress).includes('private-command'),false);await f.finish('actual-work');await f.engine.stopCall(f.call.callId);
});
