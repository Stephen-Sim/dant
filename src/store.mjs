import {ChatTaskStatus,ContinuationDispatchPhase,PlanStepStatus,SubmissionStatus,TaskPriority,TaskStatus} from './contracts/states.mjs';
import {normalizeLanguage} from './languages.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MAX_MESSAGE_ATTACHMENTS} from './attachments.mjs';
import {safeProjectContext,captureProjectContext} from './task-project-context.mjs';
import {safeCompletionWork,taskPlanInput} from './task-progress.mjs';
import {continuationTime,continuationId,continuationEligible,continuationUnconfirmed,safeWorkContinuation,restoreWorkContinuation,workContinuationCheckpoint,continuationDelay,workReplyEligible} from './work-continuation-state.mjs';
const renameRetryCodes=new Set(['EPERM','EACCES','EBUSY']);
const pauseBuffer=new Int32Array(new SharedArrayBuffer(4));
export const TASK_STATES=Object.freeze(Object.values(ChatTaskStatus));
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const attachmentIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const attachmentIds=files=>[...new Set((Array.isArray(files)?files:[]).slice(0,MAX_MESSAGE_ATTACHMENTS).map(file=>file?.id).filter(id=>typeof id==='string'&&attachmentIdPattern.test(id)))];
const visibleAttachmentIds=ids=>[...new Set((Array.isArray(ids)?ids:[]).filter(id=>typeof id==='string'&&attachmentIdPattern.test(id)))].slice(0,MAX_MESSAGE_ATTACHMENTS);
const progressError=(status,message)=>Object.assign(Error(message),{status});
const workError=(code,message)=>Object.assign(Error(message),{code});
const dismissibleStates=new Set([TaskStatus.Continuing,TaskStatus.Paused,TaskStatus.Failed,TaskStatus.Review,TaskStatus.Completed,TaskStatus.Cancelled]);
const progressPriorities=new Set(Object.values(TaskPriority));
const unconfirmedProgress=entry=>entry?.unknownOutcome===true||[SubmissionStatus.Unknown,SubmissionStatus.Submitting].includes(entry?.submission)||continuationUnconfirmed(entry);
const continuationConflict=()=>Object.assign(workError('work_continuation_conflict','The task continuation changed or its submission is unconfirmed.'),{status:409});
// Reuse the public title rules without persisting an invented task checklist.
const observedWithoutPlan=title=>({title:taskPlanInput({title,steps:[{step:'Title validation only',status:PlanStepStatus.Pending}]}).title,plan:null});
export class Store {
  constructor(dir,{renameSync=fs.renameSync,platform=process.platform,pause=ms=>Atomics.wait(pauseBuffer,0,0,ms)}={}) {
    this.renameSync=renameSync;this.platform=platform;this.pause=pause;
    this.dir=dir; fs.mkdirSync(dir,{recursive:true}); this.file=path.join(dir,'state.json');
    this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:2,messages:[],memory:'',settings:{language:'zh',voice:'marin',model:'',notifications:true,showWorkSummary:false,vm:{host:'',user:'dant',port:22,keyPath:'',knownHosts:''}},threadId:null,threadRuntime:null,schedules:[]};
    this.state.settings={...this.state.settings,language:normalizeLanguage(this.state.settings?.language),showWorkSummary:this.state.settings?.showWorkSummary===true};
    if(!uuidPattern.test(this.state.conversationId||''))this.state.conversationId=randomUUID();
    this.state.version=2;this.state.schedules ||= [];this.state.completions ||= [];
    this.state.workTasks=(Array.isArray(this.state.workTasks)?this.state.workTasks:[]).flatMap(entry=>{
      try{const {title,plan}=entry.provisional===true&&entry.plan===null?observedWithoutPlan(entry.title):taskPlanInput({title:entry.title,steps:entry.plan?.steps});if(!uuidPattern.test(entry.id)||typeof entry.turnId!=='string'||!entry.turnId||entry.turnId.length>256||!['chat','voice'].includes(entry.source)||![TaskStatus.Running,TaskStatus.WaitingUser,TaskStatus.Pausing,TaskStatus.Unknown,TaskStatus.Continuing,TaskStatus.Paused,TaskStatus.Failed,TaskStatus.Review,TaskStatus.Completed,TaskStatus.Cancelled].includes(entry.status))return [];
      const turnIds=[...new Set([...(Array.isArray(entry.turnIds)?entry.turnIds:[]).filter(id=>typeof id==='string'&&id&&id.length<=256),entry.turnId])];
      const status=entry.status===TaskStatus.Review&&(!plan||plan.steps.some(step=>step.status!==PlanStepStatus.Completed))?TaskStatus.Continuing:entry.status;
      const restored={id:entry.id,turnId:entry.turnId,turnIds,messageId:typeof entry.messageId==='string'?entry.messageId:null,source:entry.source,title,plan,status,startedAt:entry.startedAt,updatedAt:entry.updatedAt};
      if(typeof entry.progressDismissedAt==='number'&&entry.progressDismissedAt>0)restored.progressDismissedAt=entry.progressDismissedAt;
      if(Object.hasOwn(entry,'progressPriority'))restored.progressPriority=progressPriorities.has(entry.progressPriority)?entry.progressPriority:TaskPriority.Normal;
      if(entry.provisional===true)restored.provisional=true;
      if(typeof entry.executionEndedAt==='number'&&Number.isFinite(entry.executionEndedAt)&&entry.executionEndedAt>0)restored.executionEndedAt=entry.executionEndedAt;
       if(typeof entry.cancelledAt==='number'&&Number.isFinite(entry.cancelledAt)&&entry.cancelledAt>0)restored.cancelledAt=entry.cancelledAt;
      if([TaskStatus.Running,TaskStatus.Pausing,TaskStatus.Unknown].includes(restored.status)||restored.status===TaskStatus.WaitingUser&&!restored.executionEndedAt){restored.status=TaskStatus.Paused;restored.pauseReason='restart';restored.updatedAt=Date.now();}else if(entry.pauseReason)restored.pauseReason=entry.pauseReason;
      if(Object.hasOwn(entry,'continuation'))Object.assign(restored,restoreWorkContinuation(restored,entry.continuation));
      const projectContext=safeProjectContext(entry.projectContext);if(projectContext)restored.projectContext=projectContext;
      return [restored];}catch{return [];}
    }).slice(-300);
    const lastActiveAt=this.state.presence?.lastActiveAt;this.state.presence={lastActiveAt:typeof lastActiveAt==='number'&&Number.isFinite(lastActiveAt)&&lastActiveAt>0&&lastActiveAt<=8640000000000000?lastActiveAt:null};
    this.state.deletedClientMessageIds=Array.isArray(this.state.deletedClientMessageIds)?[...new Set(this.state.deletedClientMessageIds.filter(id=>typeof id==='string'&&id.length>0&&id.length<=128))].slice(-2000):[];
    for(const entry of this.state.completions)if(Object.hasOwn(entry,'progressPriority')&&!progressPriorities.has(entry.progressPriority))entry.progressPriority=TaskPriority.Normal;
    for(const m of this.state.messages){
      if(Object.hasOwn(m,'visibleAttachmentIds')){const current=new Set(attachmentIds(m.attachments));m.visibleAttachmentIds=visibleAttachmentIds(m.visibleAttachmentIds).filter(id=>current.has(id));}
      if(Object.hasOwn(m,'progressPriority')&&!progressPriorities.has(m.progressPriority))m.progressPriority=TaskPriority.Normal;
      if(m.role==='user'){
        m.receivedAt ??= m.time||Date.now();m.executorConfirmedAt ??= null;
        if(m.status==='read')m.status=TaskStatus.Review;
        // A crash can occur after turn/start was sent but before its reply was
        // recorded. That submission must never become an ordinary safe retry.
        if(m.submission===SubmissionStatus.Submitting){m.submission=SubmissionStatus.Unknown;if(![TaskStatus.Review,TaskStatus.Completed].includes(m.status)){m.status=TaskStatus.Paused;m.pauseReason='restart';}}
        if([TaskStatus.Queued,TaskStatus.Running,TaskStatus.WaitingUser,TaskStatus.Pausing,TaskStatus.Interrupted].includes(m.status)){m.status=TaskStatus.Paused;m.pauseReason='restart';}
        m.status ||= TaskStatus.Draft;
      }else if(m.status==='streaming'){m.status=TaskStatus.Paused;m.pauseReason='restart';}
    }
    this.save();
  }
  save(){const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.state,null,2));
    for(let attempt=0;attempt<6;attempt++){
      try{this.renameSync(temp,this.file);return;}
      catch(error){if(this.platform!=='win32'||!renameRetryCodes.has(error.code)||attempt===5)throw error;this.pause((attempt+1)*10);}
    }
  }
  add(data){const m={id:randomUUID(),time:Date.now(),reactions:[],read:false,...data};if(m.role==='user'){m.status ||= TaskStatus.Draft;m.receivedAt ??= Date.now();m.executorConfirmedAt ??= null;}this.state.messages.push(m);this.save();return m;}
  update(id,data){const m=this.state.messages.find(m=>m.id===id);if(!m)throw Error('Message not found');const previousIds=m.role==='assistant'&&m.read===true&&Object.hasOwn(data,'attachments')?new Set(attachmentIds(m.attachments)):null;const added=previousIds&&attachmentIds(data.attachments).some(id=>!previousIds.has(id));Object.assign(m,data);if(added){m.read=false;m.visibleAttachmentIds=visibleAttachmentIds(m.visibleAttachmentIds);}this.save();return m;}
  setTaskState(id,status,patch={}){if(!TASK_STATES.includes(status))throw Error('Invalid task state');return this.update(id,{...patch,status});}
  confirmExecution(id,patch={}){return this.update(id,{...patch,executorConfirmedAt:Date.now()});}
  markVisible(ids,attachmentSnapshots){
    const selected=new Set(ids),now=Date.now();
    for(const message of this.state.messages)if(message.role==='assistant'&&selected.has(message.id)){
      // Older clients acknowledge the text/label only. Preserve their read
      // behavior without inventing evidence that any attachment was viewed.
      if(attachmentSnapshots===undefined){message.read=true;message.visibleAt=now;continue;}
      const current=attachmentIds(message.attachments),seen=new Set(visibleAttachmentIds(message.visibleAttachmentIds));
      // The client reports the attachment IDs from the version it actually saw.
      // An older in-flight receipt must never mark a newly appended file read.
      const snapshot=attachmentSnapshots&&typeof attachmentSnapshots==='object'&&!Array.isArray(attachmentSnapshots)&&Object.hasOwn(attachmentSnapshots,message.id)?attachmentSnapshots[message.id]:null;
      for(const id of visibleAttachmentIds(snapshot))if(current.includes(id))seen.add(id);
      message.visibleAttachmentIds=current.filter(id=>seen.has(id));
      message.read=message.read===true||current.every(id=>seen.has(id));message.visibleAt=now;
    }
    for(const completion of this.state.completions){if(completion.messageIds.length&&completion.messageIds.every(id=>this.state.messages.find(message=>message.id===id)?.read))completion.readAt ||= now;}
    this.save();
  }
  addCompletion({turnId,messageIds,taskId,work}){if(this.state.completions.some(item=>item.turnId===turnId))return;const completion={id:randomUUID(),turnId,messageIds:[...messageIds],taskId,at:Date.now(),readAt:null},summary=safeCompletionWork(work);if(summary)completion.work=summary;this.state.completions.push(completion);this.state.completions=this.state.completions.slice(-300);this.save();return completion;}
  confirm(id){
    const message=this.state.messages.find(m=>m.id===id&&m.role==='user');if(!message||message.status!==TaskStatus.Review)throw Error('Only a task awaiting review can be accepted');
    if(this.state.workTasks.some(record=>(record.turnId===message.turnId||record.id===message.workId||record.messageId===message.id)&&record.continuation&&(continuationUnconfirmed(record)||record.continuation.dispatch)))throw continuationConflict();
    const before={...message},records=this.state.workTasks,now=Date.now();Object.assign(message,{status:TaskStatus.Completed,acceptedAt:now});this.state.workTasks=records.map(record=>record.turnId===message.turnId?{...record,status:TaskStatus.Completed,updatedAt:now}:record);
    try{this.save();}catch(error){for(const key of Object.keys(message))if(!Object.hasOwn(before,key))delete message[key];Object.assign(message,before);this.state.workTasks=records;throw error;}return message;
  }
  restoreWorkProgress(messageId){
    const records=this.state.workTasks,index=records.findLastIndex(record=>record.messageId===messageId);if(index<0||!records[index].progressDismissedAt)return;
    const next=[...records];next[index]={...next[index]};delete next[index].progressDismissedAt;this.state.workTasks=next;
    try{this.save();}catch(error){this.state.workTasks=records;throw error;}
  }
  registerWork({workId,turnId,messageId=null,source='chat',title,plan,startedAt,status=TaskStatus.Running,observed=false}){
    if(typeof turnId!=='string'||!turnId||turnId.length>256||!['chat','voice'].includes(source))throw workError('work_stale_turn','Registered work requires a real owned turn.');
    const observing=observed===true,withoutPlan=observing&&plan===null,safe=withoutPlan?observedWithoutPlan(title):taskPlanInput({title,steps:plan?.steps}),before=this.state.workTasks,current=before.findIndex(entry=>entry.turnId===turnId),index=workId===undefined?current:before.findIndex(entry=>entry.id===workId),previous=before[index],automatic=before[current],now=Date.now();
    if(workId!==undefined&&(!previous||typeof workId!=='string'))throw workError('work_not_found','The task to continue was not found.');
    if(previous?.status===TaskStatus.Cancelled)throw workError('work_not_continuable','Cancelled work cannot be continued. Create a new task if needed.');
    if(previous&&(continuationUnconfirmed(previous)||previous.continuation?.dispatch&&(previous.turnId!==turnId||previous.continuation.dispatch.phase!==ContinuationDispatchPhase.Acknowledged)))throw continuationConflict();
    const supersede=current>=0&&index!==current&&!observing&&!automatic.continuation?.dispatch&&automatic.provisional===true&&[TaskStatus.Running,TaskStatus.WaitingUser].includes(automatic.status)&&Array.isArray(automatic.turnIds)&&automatic.turnIds.length===1&&automatic.turnIds[0]===turnId;
    if(current>=0&&index!==current&&!supersede)throw workError('work_conflict','This turn already belongs to a different task.');
    if(previous&&previous.turnId!==turnId){if(![TaskStatus.Continuing,TaskStatus.WaitingUser,TaskStatus.Paused,TaskStatus.Review].includes(previous.status))throw workError('work_not_continuable','Only inactive unfinished work can continue in a different turn.');if(previous.turnIds?.includes(turnId))throw workError('work_stale_turn','A previous task turn cannot replace its current turn.');}
    if(!previous&&before.some(entry=>entry.turnIds?.includes(turnId)))throw workError('work_stale_turn','This turn already belongs to a different task.');
    if(withoutPlan&&previous?.plan){safe.title=previous.title;safe.plan=previous.plan;}
    const turnIds=[...new Set([...(previous?.turnIds||[]),...(previous?[previous.turnId]:[]),turnId])];
    const priority=this.state.messages.find(message=>message.id===messageId&&message.role==='user')?.progressPriority;
    const record={...(previous||{id:randomUUID(),source,startedAt:typeof startedAt==='number'&&Number.isFinite(startedAt)&&startedAt>0?startedAt:now,...(progressPriorities.has(priority)?{progressPriority:priority}:{}),...(observing?{provisional:true}:{})}),turnId,turnIds,messageId:previous?.messageId||messageId||null,...safe,status:[TaskStatus.Running,TaskStatus.WaitingUser,TaskStatus.Pausing,TaskStatus.Unknown].includes(status)?status:TaskStatus.Running,updatedAt:now};
    if(withoutPlan&&record.plan===null)record.provisional=true;else if(!observing||record.provisional!==true)delete record.provisional;
    if(previous&&previous.turnId!==turnId&&!previous.continuation?.dispatch)delete record.continuation;
    delete record.progressDismissedAt;delete record.pauseReason;delete record.executionEndedAt;let next=[...before];if(index<0)next.push(record);else next[index]=record;if(supersede)next=next.filter((entry,position)=>position!==current);this.state.workTasks=next.slice(-300);
    try{this.save();}catch(error){this.state.workTasks=before;throw error;}return record;
  }
  updateRegisteredWork(turnId,{status,plan,executionEnded=false,executionObserved=false,at=Date.now()}={}){
    const before=this.state.workTasks,index=before.findIndex(entry=>entry.turnId===turnId);if(index<0)return null;
    const previous=before[index],dispatch=previous.continuation?.dispatch,patch={};if(dispatch&&dispatch.phase!==ContinuationDispatchPhase.Acknowledged||previous.continuation?.invalid)throw continuationConflict();if(previous.status===TaskStatus.Cancelled&&(plan||status!==undefined&&status!==TaskStatus.Cancelled))throw workError('work_not_continuable','Cancelled work cannot be changed by an earlier execution.');if(status!==undefined){if(![TaskStatus.Running,TaskStatus.WaitingUser,TaskStatus.Pausing,TaskStatus.Unknown,TaskStatus.Continuing,TaskStatus.Paused,TaskStatus.Failed,TaskStatus.Review,TaskStatus.Completed,TaskStatus.Cancelled].includes(status))throw Error('Invalid registered work state.');patch.status=status;}
    if(plan)patch.plan=taskPlanInput({title:previous.title,steps:plan.steps}).plan;
    if(executionEnded){if(!continuationTime(at))throw Error('Invalid continuation time.');patch.executionEndedAt=at;}
    if((status===undefined||status===previous.status)&&!plan&&!executionEnded)return previous;
    const record={...previous,...patch,updatedAt:at};
    if(executionEnded&&dispatch){
      if(dispatch.turnId!==turnId||![TaskStatus.Continuing,TaskStatus.WaitingUser,TaskStatus.Paused,TaskStatus.Failed,TaskStatus.Review,TaskStatus.Completed,TaskStatus.Cancelled].includes(record.status))throw continuationConflict();
      const prior=safeWorkContinuation(previous.continuation);if(!prior)throw continuationConflict();const checkpoint=workContinuationCheckpoint(record.plan),noProgressCount=executionObserved===true?0:checkpoint===prior.lastCheckpoint?prior.noProgressCount+1:0;
      record.continuation={nextAt:record.status===TaskStatus.Continuing?Math.min(8640000000000000,at+continuationDelay(noProgressCount)):null,attempts:prior.attempts,noProgressCount,lastCheckpoint:checkpoint};
      if(record.status===TaskStatus.Continuing&&noProgressCount>=3){record.status=TaskStatus.Paused;record.pauseReason='automatic-no-progress';record.continuation.nextAt=null;}
    }
    const next=[...before];next[index]=record;this.state.workTasks=next;
    try{this.save();}catch(error){this.state.workTasks=before;throw error;}return record;
  }
  commitWorkContinuation(index,record){const before=this.state.workTasks,next=[...before];next[index]=record;this.state.workTasks=next;try{this.save();}catch(error){this.state.workTasks=before;throw error;}return record;}
  refreshProjectContext(workId,options={}){const index=this.state.workTasks.findIndex(record=>record.id===workId);if(index<0)return null;const previous=this.state.workTasks[index],projectContext=captureProjectContext(previous,this.state.messages,options);return this.commitWorkContinuation(index,{...previous,projectContext});}
  claimWorkContinuation(workId,{expectedTurnId,attemptId,at=Date.now(),runtimeId,threadId,humanReply=false}={}){
    const index=this.state.workTasks.findIndex(record=>record.id===workId),previous=this.state.workTasks[index];
    if(!continuationId(workId,128)||!continuationId(attemptId,128)||!continuationId(expectedTurnId)||!continuationTime(at)||typeof runtimeId!=='string'||!runtimeId.trim()||runtimeId.length>512||/[\x00-\x1f\x7f]/.test(runtimeId)||!continuationId(threadId)||previous?.turnId!==expectedTurnId||!(humanReply===true?workReplyEligible(previous,{at}):continuationEligible(previous,{at}))||this.state.workTasks.some(record=>record.continuation?.dispatch?.id===attemptId))throw continuationConflict();
    const prior=previous.continuation?safeWorkContinuation(previous.continuation):null;if(prior?.attempts===Number.MAX_SAFE_INTEGER)throw continuationConflict();
    const continuation={nextAt:humanReply===true?at:prior?.nextAt??previous.executionEndedAt+5000,attempts:(prior?.attempts||0)+1,noProgressCount:humanReply===true?0:prior?.noProgressCount||0,lastCheckpoint:prior?.lastCheckpoint||workContinuationCheckpoint(previous.plan),dispatch:{id:attemptId,fromTurnId:expectedTurnId,runtimeId,threadId,phase:ContinuationDispatchPhase.Claimed,createdAt:at}};
    return this.commitWorkContinuation(index,{...previous,...(humanReply===true?{status:TaskStatus.Continuing}:{}),continuation,updatedAt:at});
  }
  continuationAttempt(workId,attemptId){
    const index=this.state.workTasks.findIndex(record=>record.id===workId),record=this.state.workTasks[index],state=record&&safeWorkContinuation(record.continuation);
    if(!continuationId(workId,128)||!continuationId(attemptId,128)||!state?.dispatch||state.dispatch.id!==attemptId||record.status===TaskStatus.Cancelled||state.dispatch.turnId&&state.dispatch.turnId!==record.turnId||!state.dispatch.turnId&&state.dispatch.fromTurnId!==record.turnId)throw continuationConflict();
    return {index,record,state,dispatch:state.dispatch};
  }
  setWorkContinuationPhase(workId,attemptId,phase){
    const {index,record,state,dispatch}=this.continuationAttempt(workId,attemptId);
    if(dispatch.phase!==ContinuationDispatchPhase.Claimed||![ContinuationDispatchPhase.Submitting,ContinuationDispatchPhase.Unknown].includes(phase)||record.status!==TaskStatus.Continuing)throw continuationConflict();
    return this.commitWorkContinuation(index,{...record,status:phase===ContinuationDispatchPhase.Unknown?TaskStatus.Unknown:record.status,continuation:{...state,dispatch:{...dispatch,phase}},updatedAt:Date.now()});
  }
  bindWorkContinuation(workId,attemptId,{turnId}={}){
    const {index,record,state,dispatch}=this.continuationAttempt(workId,attemptId);
    if(dispatch.phase!==ContinuationDispatchPhase.Submitting||record.status!==TaskStatus.Continuing||!continuationId(turnId)||this.state.workTasks.some(entry=>entry.turnId===turnId||entry.turnIds?.includes(turnId)))throw continuationConflict();
    const bound={...record,turnId,turnIds:[...new Set([...(record.turnIds||[]),record.turnId,turnId])],status:TaskStatus.Running,continuation:{...state,dispatch:{...dispatch,phase:ContinuationDispatchPhase.Acknowledged,turnId}},updatedAt:Date.now()};delete bound.executionEndedAt;delete bound.pauseReason;delete bound.progressDismissedAt;delete bound.cancelledAt;
    return this.commitWorkContinuation(index,bound);
  }
  // Only the Engine's retained acknowledged owner may use this after observing
  // its exact terminal event when the original acknowledgement could not save.
  finishUnboundWorkContinuation(workId,attemptId,{turnId,status=TaskStatus.Paused,at=Date.now()}={}){
    const index=this.state.workTasks.findIndex(record=>record.id===workId),record=this.state.workTasks[index],state=record&&safeWorkContinuation(record.continuation),dispatch=state?.dispatch;
    if(!continuationId(workId,128)||!continuationId(attemptId,128)||!continuationId(turnId)||!continuationTime(at)||![TaskStatus.Paused,TaskStatus.Cancelled].includes(status)||!dispatch||dispatch.id!==attemptId||![ContinuationDispatchPhase.Submitting,ContinuationDispatchPhase.Unknown].includes(dispatch.phase)||dispatch.fromTurnId!==record.turnId||dispatch.turnId!==undefined&&dispatch.turnId!==turnId||record.status===TaskStatus.Cancelled||this.state.workTasks.some(entry=>entry.turnId===turnId||entry.turnIds?.includes(turnId)))throw continuationConflict();
    const continuation={...state,nextAt:null};delete continuation.dispatch;
    const finished={...record,turnId,turnIds:[...new Set([...(record.turnIds||[]),record.turnId,turnId])],status,pauseReason:'continuation-save-failed',executionEndedAt:at,updatedAt:at,continuation,...(status===TaskStatus.Cancelled?{cancelledAt:at}:{})};
    return this.commitWorkContinuation(index,finished);
  }
  settleWorkContinuation(workId,attemptId,{status=TaskStatus.Failed,at=Date.now(),submitted=false}={}){
    const {index,record,state,dispatch}=this.continuationAttempt(workId,attemptId);if(!continuationTime(at)||typeof submitted!=='boolean'||![TaskStatus.Failed,TaskStatus.Continuing,TaskStatus.Paused,TaskStatus.Cancelled,TaskStatus.Unknown].includes(status))throw continuationConflict();
    if(dispatch.phase!==ContinuationDispatchPhase.Claimed||submitted||status===TaskStatus.Unknown)return this.commitWorkContinuation(index,{...record,status:TaskStatus.Unknown,pauseReason:'continuation-unconfirmed',continuation:{...state,nextAt:null,dispatch:{...dispatch,phase:ContinuationDispatchPhase.Unknown}},updatedAt:at});
    const continuation={nextAt:[TaskStatus.Paused,TaskStatus.Cancelled].includes(status)?null:Math.min(8640000000000000,at+continuationDelay(state.noProgressCount)),attempts:state.attempts,noProgressCount:state.noProgressCount,lastCheckpoint:state.lastCheckpoint},settled={...record,status:[TaskStatus.Paused,TaskStatus.Cancelled].includes(status)?status:TaskStatus.Continuing,continuation,updatedAt:at};
    if(status===TaskStatus.Paused)settled.pauseReason='continuation-paused';if(status===TaskStatus.Cancelled){settled.cancelledAt=at;settled.executionEndedAt=at;}
    return this.commitWorkContinuation(index,settled);
  }
  pauseContinuingWork({at=Date.now(),reason='user-paused'}={}){
    if(!continuationTime(at)||typeof reason!=='string'||!/^[a-z][a-z0-9-]{0,127}$/.test(reason))throw continuationConflict();
    const before=this.state.workTasks,ids=[],next=before.map(record=>{
      if(record.status!==TaskStatus.Continuing||!continuationTime(record.executionEndedAt)||record.continuation?.dispatch||continuationUnconfirmed(record))return record;
      if(record.plan===null?record.provisional!==true:!record.plan?.steps.some(step=>step.status!==PlanStepStatus.Completed))return record;
      ids.push(record.id);return {...record,status:TaskStatus.Paused,pauseReason:reason,updatedAt:at,continuation:{...(record.continuation||{attempts:0,noProgressCount:0,lastCheckpoint:workContinuationCheckpoint(record.plan)}),nextAt:null}};
    });
    if(!ids.length)return ids;this.state.workTasks=next;try{this.save();}catch(error){this.state.workTasks=before;throw error;}return ids;
  }
  progressRecord(id,kind){
    if(typeof id!=='string'||!id||id.length>128||!['task','completion','work'].includes(kind))throw progressError(400,'Invalid work progress request.');
    const entry=(kind==='task'?this.state.messages:kind==='work'?this.state.workTasks:this.state.completions).find(item=>item.id===id);
    if(!entry)throw progressError(404,'Work progress entry not found.');
    if(kind==='task'&&entry.role!=='user')throw progressError(409,'Only user task progress can be changed.');
    if(kind==='completion'&&!this.isProgressCompletion(entry)){
      throw progressError(409,'Only final voice task history can be dismissed.');
    }
    return entry;
  }
  pauseWork({turnId=null,messageIds=[],workId}={}){
    const record=workId?this.state.workTasks.find(item=>item.id===workId):turnId?this.state.workTasks.find(item=>item.turnId===turnId):null;
    const conflict=()=>progressError(409,'The task pause cannot be confirmed.');
    if(workId&&(!record||record.turnId!==turnId))throw conflict();
    const ids=new Set(messageIds),messages=this.state.messages.filter(item=>item.role==='user'&&(ids.has(item.id)||turnId&&item.turnId===turnId)),entries=[...messages,...(record?[record]:[])];
    if(!entries.length||messages.some(item=>(item.turnId||null)!==turnId)||entries.some(entry=>unconfirmedProgress(entry)||!(entry===record?[TaskStatus.Running,TaskStatus.WaitingUser,TaskStatus.Continuing,TaskStatus.Paused,TaskStatus.Pausing]:[TaskStatus.Running,TaskStatus.WaitingUser,TaskStatus.Continuing,TaskStatus.Paused,TaskStatus.Pausing,TaskStatus.Review]).includes(entry.status)||entry.continuation?.invalid||entry.continuation?.dispatch))throw conflict();
    const now=Date.now(),patches=[];
    for(const entry of entries){
      const patch={status:TaskStatus.Paused,pauseReason:'user-paused',error:null,...(entry===record?{executionEndedAt:entry.executionEndedAt||now,updatedAt:now,...(entry.continuation?{continuation:{...entry.continuation,nextAt:null}}:{})}:{})};
      patches.push({entry,prior:Object.fromEntries(Object.keys(patch).map(key=>[key,{had:Object.hasOwn(entry,key),value:entry[key]}]))});Object.assign(entry,patch);
    }
    try{this.save();}catch(error){for(const {entry,prior} of patches)for(const [key,value] of Object.entries(prior)){if(value.had)entry[key]=value.value;else delete entry[key];}throw error;}
    return {ok:true,paused:true};
  }
  resumeWork({workId,turnId}={}){
    const index=this.state.workTasks.findIndex(item=>item.id===workId),record=this.state.workTasks[index];
    if(!record||record.turnId!==turnId||record.status!==TaskStatus.Paused||!continuationTime(record.executionEndedAt)||unconfirmedProgress(record)||record.continuation?.invalid||record.continuation?.dispatch||!record.plan&&record.provisional!==true||record.plan&&!record.plan.steps.some(step=>step.status!==PlanStepStatus.Completed)||this.state.messages.some(message=>message.role==='user'&&(message.turnId===turnId||message.workId===workId)&&unconfirmedProgress(message)))throw progressError(409,'This task cannot be resumed safely.');
    const now=Date.now(),next={...record,status:TaskStatus.Continuing,updatedAt:now,pauseReason:null,continuation:{nextAt:now,attempts:record.continuation?.attempts||0,noProgressCount:0,lastCheckpoint:workContinuationCheckpoint(record.plan)}};delete next.progressDismissedAt;
    this.commitWorkContinuation(index,next);return {ok:true,resumed:true,queued:true,workId:record.id,status:next.status};
  }
  cancelWork({turnId=null,messageIds=[],workId}={}){
    const record=workId?this.state.workTasks.find(item=>item.id===workId):turnId?this.state.workTasks.find(item=>item.turnId===turnId):null;
    if(workId&&(!record||record.turnId!==turnId))throw progressError(409,'The task to cancel changed.');
    const ids=new Set(messageIds);if(this.state.messages.some(item=>item.role==='user'&&ids.has(item.id)&&(item.turnId||null)!==turnId))throw progressError(409,'The task to cancel changed.');
    const messages=this.state.messages.filter(item=>item.role==='user'&&(ids.has(item.id)||turnId&&item.turnId===turnId)),entries=[...messages,...(record?[record]:[])];
    if(!entries.length||entries.some(unconfirmedProgress))throw progressError(409,'This task cancellation cannot be confirmed.');
    const now=Date.now(),patches=[];
    for(const entry of entries){
      const patch={status:TaskStatus.Cancelled,cancelledAt:entry.cancelledAt||now,pauseReason:null,error:null,progressDismissedAt:null,...(entry===record?{executionEndedAt:entry.executionEndedAt||now,updatedAt:now,...(entry.continuation?{continuation:{...entry.continuation,nextAt:null,...(entry.continuation.dispatch?{dispatch:undefined}:{})}}:{})}:{})};
      if(patch.continuation)delete patch.continuation.dispatch;
      patches.push({entry,prior:Object.fromEntries(Object.keys(patch).map(key=>[key,{had:Object.hasOwn(entry,key),value:entry[key]}]))});Object.assign(entry,patch);
    }
    try{this.save();}catch(error){for(const {entry,prior} of patches)for(const [key,value] of Object.entries(prior)){if(value.had)entry[key]=value.value;else delete entry[key];}throw error;}
    return {ok:true,cancelled:true};
  }
  isProgressCompletion(entry){return Boolean(safeCompletionWork(entry.work)&&typeof entry.turnId==='string'&&!/:(input|credential):/.test(entry.turnId)&&Array.isArray(entry.messageIds)&&entry.messageIds.some(messageId=>this.state.messages.some(message=>message.id===messageId&&message.role==='assistant'&&message.status!=='streaming')));}
  progressEntry(id,kind){
    const entry=this.progressRecord(id,kind);
    if(kind!=='completion'&&!dismissibleStates.has(entry.status))throw progressError(409,'Only inactive task history can be dismissed.');
    return entry;
  }
  isProgressCompleted(entry,kind){
    if(kind==='task')return entry.role==='user'&&entry.status===TaskStatus.Completed&&!unconfirmedProgress(entry)&&!this.state.workTasks.some(record=>(record.turnId===entry.turnId||record.id===entry.workId||record.messageId===entry.id)&&(unconfirmedProgress(record)||record.continuation?.dispatch));
    const related=this.state.messages.filter(message=>message.role==='user'&&(message.turnId&&message.turnId===entry.turnId||kind==='completion'&&message.id===entry.taskId));
    if(unconfirmedProgress(entry)||entry.continuation?.dispatch||related.some(unconfirmedProgress))return false;
    if(kind!=='completion')return entry.status===TaskStatus.Completed;
    const records=this.state.workTasks.filter(record=>record.turnId===entry.turnId||record.turnIds?.includes(entry.turnId));
    if(records.length)return records.some(record=>record.turnId===entry.turnId&&record.status===TaskStatus.Completed);
    return related.some(message=>message.turnId===entry.turnId&&message.status===TaskStatus.Completed&&(!entry.taskId||message.id===entry.taskId));
  }
  setProgressPriority(id,kind,priority){
    if(!progressPriorities.has(priority))throw progressError(400,'Invalid work progress priority.');
    const entry=this.progressRecord(id,kind);
    if(entry.progressPriority===priority)return {ok:true,progressPriority:priority};
    const hadValue=Object.hasOwn(entry,'progressPriority'),previous=entry.progressPriority;entry.progressPriority=priority;
    try{this.save();}catch(error){if(hadValue)entry.progressPriority=previous;else delete entry.progressPriority;throw error;}
    return {ok:true,progressPriority:priority};
  }
  dismissProgress(id,kind,{confirmUnfinished=false}={}){
    const entry=this.progressEntry(id,kind);
    if(!this.isProgressCompleted(entry,kind)&&confirmUnfinished!==true)throw Object.assign(progressError(409,'Confirm before hiding unfinished work.'),{confirmationRequired:true});
    if(typeof entry.progressDismissedAt==='number'&&Number.isFinite(entry.progressDismissedAt)&&entry.progressDismissedAt>0)return {ok:true};
    const hadValue=Object.hasOwn(entry,'progressDismissedAt'),previous=entry.progressDismissedAt;entry.progressDismissedAt=Date.now();
    try{this.save();}catch(error){if(hadValue)entry.progressDismissedAt=previous;else delete entry.progressDismissedAt;throw error;}
    return {ok:true};
  }
  clearCompletedProgress(candidates=[]){
    const requested={task:new Set(),work:new Set(),completion:new Set()},selected=[];
    for(const {id,kind} of candidates)requested[kind]?.add(id);
    for(const [kind,entries] of [['task',this.state.messages],['work',this.state.workTasks],['completion',this.state.completions]])for(const entry of entries){
      if(!requested[kind].has(entry.id)||kind==='completion'&&!this.isProgressCompletion(entry)||!this.isProgressCompleted(entry,kind)||typeof entry.progressDismissedAt==='number'&&Number.isFinite(entry.progressDismissedAt)&&entry.progressDismissedAt>0)continue;
      selected.push(entry);
    }
    if(!selected.length)return {ok:true,cleared:0};
    const before=selected.map(entry=>({entry,hadValue:Object.hasOwn(entry,'progressDismissedAt'),value:entry.progressDismissedAt})),at=Date.now();for(const entry of selected)entry.progressDismissedAt=at;
    try{this.save();}catch(error){for(const {entry,hadValue,value} of before){if(hadValue)entry.progressDismissedAt=value;else delete entry.progressDismissedAt;}throw error;}
    return {ok:true,cleared:selected.length};
  }
}
