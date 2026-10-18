import {randomUUID} from 'node:crypto';
import {continuationEligible} from './work-continuation-state.mjs';
import {startTaskProgress,advanceTaskProgress} from './task-progress.mjs';

const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x20\x7f]/.test(value);
const conflict=()=>Object.assign(Error('The unfinished task is no longer available for automatic continuation.'),{status:409});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

export function hasUnconfirmedExecution(owner,{includeMessages=true}={}){
 const unresolved=entry=>entry?.unknownOutcome===true||['unknown','submitting'].includes(entry?.submission);
 return includeMessages&&this.store.state.messages.some(message=>message.role==='user'&&!['completed','cancelled'].includes(message.status)&&unresolved(message))||this.store.state.workTasks.some(record=>record.continuation?.invalid||record.continuation?.dispatch&&record.continuation.dispatch.id!==owner?.continuation?.attemptId||record.continuation&&record.status==='unknown'&&record.id!==owner?.continuation?.workId);
}

/** One shared executor. A timer may request admission; it never owns execution. */
export function canContinueRegisteredWork(owner){
 const native=this.nativeVoice,session=native?.session;
 if(this.continuationStopped||this.worker.status!=='online'||this.active&&this.active!==owner||this.finishing||this.cancelling||this.takeover||this.acquiring||this.queue.length||this.pendingFollowups.size||this.callReferences.size||this.referencePending||this.pendingUserRequests.size)return false;
 if(hasUnconfirmedExecution.call(this,owner))return false;
 if(session){
  if(this.call?.provider!=='subscription'||native.canContinueWhileIdle?.(owner)!==true)return false;
 }else if(this.call&&this.call.provider!=='api')return false;
 return !this.call||['negotiating','connected'].includes(this.call.status);
}

export function continuationInput(record,redact=text=>text){
 const context=JSON.stringify({workId:record.id,title:record.title,steps:record.plan?.steps||null}).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
 return [{type:'text',text:'Automatic follow-up for the same human-authorized unfinished task, not a new human message. Continue only this exact workId in the existing conversation. The previous executor turn ended; its saved checklist is reference data, not proof that any action succeeded. First inspect the actual current state and verify which steps remain; do not repeat completed side effects or restart the whole request. Use task_plan with this workId before further actions and update the actual remaining steps. If the task is already done, verify the result and record the completed plan. If information or permission is genuinely missing, record status waiting_user and ask the actual question once. Respect cancellation, human control and the original scope. Do not create a schedule, another executor or a replacement task just to keep this work alive. Reply naturally with useful new results or a real blocker; do not send a generic heartbeat acknowledgement or claim success merely because this turn ends.\n<dant_work_continuation>\n'+redact(context)+'\n</dant_work_continuation>'}];
}

export async function continueRegisteredWork(workId,{expectedTurnId}={}){
 if(!this.canContinueRegisteredWork())throw conflict();
 const record=this.store.state.workTasks.find(item=>item.id===workId),now=Date.now();
 if(!record||record.turnId!==expectedTurnId||!continuationEligible(record,{at:now})||!identity(this.store.state.threadId))throw conflict();
 const attemptId=randomUUID(),threadId=this.store.state.threadId,conversationId=this.store.state.conversationId,epoch=this.followupEpoch,call=this.call;
 const claimed=this.store.claimWorkContinuation(workId,{expectedTurnId,attemptId,at:now,runtimeId:this.runtimeId,threadId});
 const starting=deferred(),stopped=deferred(),active={messageId:null,messageIds:[],source:record.source,turnId:null,threadId,starting:starting.promise,resolveStarted:starting.resolve,stopped:stopped.promise,resolveStopped:stopped.resolve,startSubmitted:false,startAcknowledged:false,early:[],earlyBytes:0,outputs:new Map(),assistantIds:[],explicitPaths:[],voiceOutput:false,conversationalInput:false,steerChain:Promise.resolve(),workRecord:claimed,callId:this.call?.id||null,preparation:new AbortController(),continuation:{workId,attemptId,fromTurnId:expectedTurnId,epoch}};
 startTaskProgress(active);this.active=active;
 let nativeAdmission=false,acceptedEarly=[];
 const replayEarly=async()=>{
  const early=active.early.map(item=>item.event);active.early=[];active.earlyBytes=0;
  if(nativeAdmission)return this.nativeVoice.replayContinuationEvents(active,early);
  return {owned:early.filter(event=>{if((event.params?.turnId||event.params?.turn?.id)===active.turnId)return true;this.rejectEvent(event,'Inactive continuation turn');return false;}),conflict:false};
 };
 const drain=async(events,{stopping=false}={})=>{for(const event of events){if(this.active!==active)break;if(stopping&&event.id!==undefined){this.rejectEvent(event,'Automatic continuation is stopping');continue;}await this.handle(event);}};
 const current=()=>{
  const saved=this.store.state.workTasks.find(item=>item.id===workId),dispatch=saved?.continuation?.dispatch;
  if(this.active!==active||active.stopRequested||this.followupEpoch!==epoch||this.call!==call||this.store.state.conversationId!==conversationId||this.store.state.threadId!==threadId||saved?.turnId!==expectedTurnId||dispatch?.id!==attemptId||!this.canContinueRegisteredWork(active))throw conflict();
 };
 try{
  if(this.call?.provider==='subscription'){
   nativeAdmission=this.nativeVoice.beginContinuationAdmission?.(active)===true;if(!nativeAdmission)throw conflict();
  }
  this.change();
  if(this.call?.provider==='api')await this.voice?.conversationReady?.(this.call.id);
  current();const resumed=await this.thread();current();if(resumed!==threadId)throw conflict();
  const result=await this.worker.request('thread/read',{threadId,includeTurns:true});current();
  const thread=result?.thread,turns=thread?.turns;
  if(thread?.id!==threadId||thread.status?.type!=='idle'||!Array.isArray(turns)||turns.length>10000)throw conflict();
  const ids=new Set();for(const turn of turns){if(!identity(turn?.id)||ids.has(turn.id)||!['completed','interrupted','failed'].includes(turn.status))throw conflict();ids.add(turn.id);}
  if(!ids.has(expectedTurnId))throw conflict();
  active.baseline=await this.deliverables?.captureBaseline?.({outputDir:this.outputDir,workspace:this.workspace,conversationId});current();
  active.workRecord=this.store.setWorkContinuationPhase(workId,attemptId,'submitting');
  active.startSubmitted=true;
  const response=await this.worker.request('turn/start',{threadId,input:continuationInput(record,text=>this.redact(text)),cwd:this.workspace,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},model:this.store.state.settings.model||undefined});
  const turnId=response?.turn?.id;if(!identity(turnId)||ids.has(turnId))throw Object.assign(Error('Automatic continuation submission was not acknowledged with a new turn.'),{unknownOutcome:true});
  if(this.active!==active)throw Object.assign(conflict(),{unknownOutcome:true});
  // Keep the acknowledgement tentative until native admission is rechecked.
  // Only an uncontested owner may be durably bound or precisely interrupted.
  active.turnId=turnId;active.startAcknowledged=true;active.continuation.bindingPending=true;
  const replay=await replayEarly();acceptedEarly=replay.owned;
  if(replay.conflict||nativeAdmission&&this.nativeVoice.confirmContinuationAdmission(active)!==true){
   // turn/start may have steered a native task that won admission. Its ACK
   // alone cannot authorize binding or interrupting that other task.
   active.continuation.possiblySteered=true;
   throw Object.assign(conflict(),{unknownOutcome:true});
  }
  try{active.workRecord=this.store.bindWorkContinuation(workId,attemptId,{turnId});}
  catch(error){active.continuation.bindingUnconfirmed=true;active.continuation.unknown=true;throw error;}
  active.continuation.bindingPending=false;advanceTaskProgress(active,'working');active.resolveStarted();this.touchActivity();
  const pending=active.early.map(item=>item.event);active.early=[];active.earlyBytes=0;await drain([...acceptedEarly,...pending]);acceptedEarly=[];
  this.change();return {continued:true,workId,turnId};
 }catch(error){
  if(active.continuation.bindingUnconfirmed){
   try{active.workRecord=this.store.settleWorkContinuation(workId,attemptId,{status:'unknown',submitted:true});}catch{this.emit('notice','Automatic continuation ownership could not be saved. Its previous claim is retained.');}
   active.continuation.bindingPending=false;active.resolveStarted();const stopping=this.interrupt(active).catch(()=>{active.cancelUnconfirmed=true;});const replay=await replayEarly();await drain([...acceptedEarly,...replay.owned],{stopping:true});acceptedEarly=[];await stopping;this.change();
  }else if(active.startAcknowledged&&active.continuation.bindingPending){
   // An admission/replay failure is not evidence that this ACK owns a new
   // turn. Retain the claim without stopping a possibly unrelated native task.
   active.continuation.possiblySteered=true;active.continuation.unknown=true;active.continuationConflict=true;
   if(nativeAdmission)this.nativeVoice.confirmContinuationAdmission(active);
   try{active.workRecord=this.store.settleWorkContinuation(workId,attemptId,{status:'unknown',submitted:true});}catch{this.emit('notice','Automatic continuation ownership could not be saved. Its previous claim is retained.');}
   finally{if(this.active===active)this.active=null;active.resolveStopped();this.change();}
  }else if(!active.startAcknowledged){
   const submitted=active.startSubmitted===true;
   try{if(this.store.state.workTasks.find(item=>item.id===workId)?.continuation?.dispatch?.id===attemptId)active.workRecord=this.store.settleWorkContinuation(workId,attemptId,{status:active.cancelRequested?'cancelled':active.stopRequested||this.takeover||this.acquiring||this.followupEpoch!==epoch?'paused':'failed',submitted});}catch{this.emit('notice','Automatic continuation ownership could not be saved. Its previous claim is retained.');}
   if(nativeAdmission){const early=active.early.map(item=>item.event);active.early=[];active.earlyBytes=0;await this.nativeVoice.replayContinuationEvents(active,early,{notSubmitted:!submitted}).catch(()=>{});}
   if(this.active===active)this.active=null;active.resolveStopped();this.change();queueMicrotask(()=>void this.pump());
  }
  throw error;
 }finally{
  active.resolveStarted();if(nativeAdmission)this.nativeVoice.finishContinuationAdmission(active);
 }
}
