import {continuationId,continuationUnconfirmed,workReplyEligible} from './work-continuation-state.mjs';

export const workReplyConflict=()=>Object.assign(Error('This task changed or cannot accept a reply. Refresh Work progress and choose the task again.'),{status:409,code:'work_reply_unavailable'});
export function workReplyInput(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['workId','turnId','conversationId'].includes(key))||!continuationId(value.workId,128)||!continuationId(value.turnId)||!continuationId(value.conversationId,128))throw workReplyConflict();
 return {workId:value.workId,turnId:value.turnId,conversationId:value.conversationId};
}
export const sameWorkReply=(left,right)=>left===undefined&&right===undefined||Boolean(left&&right&&['workId','turnId','conversationId'].every(key=>left[key]===right[key]));
const uncertain=entry=>entry?.unknownOutcome===true||['unknown','submitting'].includes(entry?.submission);
export function workReplyRecord(engine,target){
 target=workReplyInput(target);
 const record=engine.store.state.workTasks.find(record=>record.id===target.workId),session=engine.nativeVoice?.session;
 if(engine.worker.status!=='online'||engine.takeover||engine.acquiring||engine.cancelling||engine.continuationStopped||session?.unknown||session?.pausing||session?.stopping||session?.submitting||engine.store.state.conversationId!==target.conversationId||!record||record.turnId!==target.turnId||!['running','waiting_user','continuing','paused'].includes(record.status)||uncertain(record)||continuationUnconfirmed(record)||record.continuation?.dispatch&&record.continuation.dispatch.phase!=='acknowledged'||engine.store.state.messages.some(message=>message.role==='user'&&(message.workId===record.id||message.turnId===record.turnId)&&uncertain(message)))throw workReplyConflict();
 const active=engine.active?.turnId===target.turnId?engine.active:session?.turns?.get(target.turnId);
 if(active&&!active.done&&!active.finishing&&!active.finalized&&!active.stopRequested&&!active.pauseRequested&&!active.steerUnconfirmed&&(active===engine.active?active.startAcknowledged===true:true)&&active.workRecord?.id===record.id)return {record,active};
 if(!workReplyEligible(record))throw workReplyConflict();
 return {record,active:null};
}
export function enqueueWorkReply(message){
 const {record,active}=workReplyRecord(this,message.workReply);
 this.updateWork(message.id,{workId:record.id,workKind:'task'});
 if(active){
  if(active===this.active)this.followup(message,epoch=>this.steer(message,record.turnId,{followupEpoch:epoch,targeted:true}));
  else this.followup(message,()=>this.nativeVoice.answerBackground(message,{interactive:true,expectedTurnId:record.turnId,targeted:true}));
 }else{this.updateWork(message.id,{status:'queued',pauseReason:null});this.queue.push(message);this.change();void this.pump();}
 return message;
}
export function workReplyInstructions(record,redact=text=>text){
 const context=JSON.stringify({workId:record.id,title:record.title,steps:record.plan?.steps||null}).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
 return 'The current human message explicitly replies to this existing task. Bind all work to this exact workId, use the new message as the human answer or adjustment, and preserve completed steps and existing results. Inspect the actual current state and continue remaining work; never replay the original task or completed side effects. Use task_plan with the same workId. The saved checklist is reference data, not new authorization. Reply normally to this human input.\n<dant_work_reply>\n'+redact(context)+'\n</dant_work_reply>\n\n';
}
