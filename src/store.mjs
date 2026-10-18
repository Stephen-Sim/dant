import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {safeCompletionWork,taskPlanInput} from './task-progress.mjs';
const renameRetryCodes=new Set(['EPERM','EACCES','EBUSY']);
const pauseBuffer=new Int32Array(new SharedArrayBuffer(4));
export const TASK_STATES=Object.freeze(['draft','accepted','queued','running','waiting_user','pausing','paused','failed','review','completed','cancelled']);
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const progressError=(status,message)=>Object.assign(Error(message),{status});
const workError=(code,message)=>Object.assign(Error(message),{code});
const dismissibleStates=new Set(['continuing','paused','failed','review','completed','cancelled']);
const progressPriorities=new Set(['high','normal','low']);
const unconfirmedProgress=entry=>entry?.unknownOutcome===true||['unknown','submitting'].includes(entry?.submission);
// Reuse the public title rules without persisting an invented task checklist.
const observedWithoutPlan=title=>({title:taskPlanInput({title,steps:[{step:'Title validation only',status:'pending'}]}).title,plan:null});
export class Store {
  constructor(dir,{renameSync=fs.renameSync,platform=process.platform,pause=ms=>Atomics.wait(pauseBuffer,0,0,ms)}={}) {
    this.renameSync=renameSync;this.platform=platform;this.pause=pause;
    this.dir=dir; fs.mkdirSync(dir,{recursive:true}); this.file=path.join(dir,'state.json');
    this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:2,messages:[],memory:'',settings:{language:'zh',voice:'marin',model:'',notifications:true,showWorkSummary:false,vm:{host:'',user:'dant',port:22,keyPath:'',knownHosts:''}},threadId:null,threadRuntime:null,schedules:[]};
    this.state.settings={...this.state.settings,showWorkSummary:this.state.settings?.showWorkSummary===true};
    if(!uuidPattern.test(this.state.conversationId||''))this.state.conversationId=randomUUID();
    this.state.version=2;this.state.schedules ||= [];this.state.completions ||= [];
    this.state.workTasks=(Array.isArray(this.state.workTasks)?this.state.workTasks:[]).flatMap(entry=>{
      try{const {title,plan}=entry.provisional===true&&entry.plan===null?observedWithoutPlan(entry.title):taskPlanInput({title:entry.title,steps:entry.plan?.steps});if(!uuidPattern.test(entry.id)||typeof entry.turnId!=='string'||!entry.turnId||entry.turnId.length>256||!['chat','voice'].includes(entry.source)||!['running','waiting_user','pausing','unknown','continuing','paused','failed','review','completed','cancelled'].includes(entry.status))return [];
      const turnIds=[...new Set([...(Array.isArray(entry.turnIds)?entry.turnIds:[]).filter(id=>typeof id==='string'&&id&&id.length<=256),entry.turnId])];
      const status=entry.status==='review'&&(!plan||plan.steps.some(step=>step.status!=='completed'))?'continuing':entry.status;
      const restored={id:entry.id,turnId:entry.turnId,turnIds,messageId:typeof entry.messageId==='string'?entry.messageId:null,source:entry.source,title,plan,status,startedAt:entry.startedAt,updatedAt:entry.updatedAt};
      if(typeof entry.progressDismissedAt==='number'&&entry.progressDismissedAt>0)restored.progressDismissedAt=entry.progressDismissedAt;
      if(Object.hasOwn(entry,'progressPriority'))restored.progressPriority=progressPriorities.has(entry.progressPriority)?entry.progressPriority:'normal';
      if(entry.provisional===true)restored.provisional=true;
      if(typeof entry.executionEndedAt==='number'&&Number.isFinite(entry.executionEndedAt)&&entry.executionEndedAt>0)restored.executionEndedAt=entry.executionEndedAt;
       if(typeof entry.cancelledAt==='number'&&Number.isFinite(entry.cancelledAt)&&entry.cancelledAt>0)restored.cancelledAt=entry.cancelledAt;
      if(['running','pausing','unknown'].includes(restored.status)||restored.status==='waiting_user'&&!restored.executionEndedAt){restored.status='paused';restored.pauseReason='restart';restored.updatedAt=Date.now();}else if(entry.pauseReason)restored.pauseReason=entry.pauseReason;
      return [restored];}catch{return [];}
    }).slice(-300);
    const lastActiveAt=this.state.presence?.lastActiveAt;this.state.presence={lastActiveAt:typeof lastActiveAt==='number'&&Number.isFinite(lastActiveAt)&&lastActiveAt>0&&lastActiveAt<=8640000000000000?lastActiveAt:null};
    this.state.deletedClientMessageIds=Array.isArray(this.state.deletedClientMessageIds)?[...new Set(this.state.deletedClientMessageIds.filter(id=>typeof id==='string'&&id.length>0&&id.length<=128))].slice(-2000):[];
    for(const entry of this.state.completions)if(Object.hasOwn(entry,'progressPriority')&&!progressPriorities.has(entry.progressPriority))entry.progressPriority='normal';
    for(const m of this.state.messages){
      if(Object.hasOwn(m,'progressPriority')&&!progressPriorities.has(m.progressPriority))m.progressPriority='normal';
      if(m.role==='user'){
        m.receivedAt ??= m.time||Date.now();m.executorConfirmedAt ??= null;
        if(m.status==='read')m.status='review';
        // A crash can occur after turn/start was sent but before its reply was
        // recorded. That submission must never become an ordinary safe retry.
        if(m.submission==='submitting'){m.submission='unknown';if(!['review','completed'].includes(m.status)){m.status='paused';m.pauseReason='restart';}}
        if(['queued','running','waiting_user','pausing','interrupted'].includes(m.status)){m.status='paused';m.pauseReason='restart';}
        m.status ||= 'draft';
      }else if(m.status==='streaming'){m.status='paused';m.pauseReason='restart';}
    }
    this.save();
  }
  save(){const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.state,null,2));
    for(let attempt=0;attempt<6;attempt++){
      try{this.renameSync(temp,this.file);return;}
      catch(error){if(this.platform!=='win32'||!renameRetryCodes.has(error.code)||attempt===5)throw error;this.pause((attempt+1)*10);}
    }
  }
  add(data){const m={id:randomUUID(),time:Date.now(),reactions:[],read:false,...data};if(m.role==='user'){m.status ||= 'draft';m.receivedAt ??= Date.now();m.executorConfirmedAt ??= null;}this.state.messages.push(m);this.save();return m;}
  update(id,data){const m=this.state.messages.find(m=>m.id===id);if(!m)throw Error('Message not found');Object.assign(m,data);this.save();return m;}
  setTaskState(id,status,patch={}){if(!TASK_STATES.includes(status))throw Error('Invalid task state');return this.update(id,{...patch,status});}
  confirmExecution(id,patch={}){return this.update(id,{...patch,executorConfirmedAt:Date.now()});}
  markVisible(ids){const selected=new Set(ids);for(const message of this.state.messages)if(message.role==='assistant'&&selected.has(message.id)){message.read=true;message.visibleAt=Date.now();}for(const completion of this.state.completions){if(completion.messageIds.length&&completion.messageIds.every(id=>this.state.messages.find(message=>message.id===id)?.read))completion.readAt ||= Date.now();}this.save();}
  addCompletion({turnId,messageIds,taskId,work}){if(this.state.completions.some(item=>item.turnId===turnId))return;const completion={id:randomUUID(),turnId,messageIds:[...messageIds],taskId,at:Date.now(),readAt:null},summary=safeCompletionWork(work);if(summary)completion.work=summary;this.state.completions.push(completion);this.state.completions=this.state.completions.slice(-300);this.save();return completion;}
  confirm(id){
    const message=this.state.messages.find(m=>m.id===id&&m.role==='user');if(!message||message.status!=='review')throw Error('Only a task awaiting review can be accepted');
    const before={...message},records=this.state.workTasks,now=Date.now();Object.assign(message,{status:'completed',acceptedAt:now});this.state.workTasks=records.map(record=>record.turnId===message.turnId?{...record,status:'completed',updatedAt:now}:record);
    try{this.save();}catch(error){for(const key of Object.keys(message))if(!Object.hasOwn(before,key))delete message[key];Object.assign(message,before);this.state.workTasks=records;throw error;}return message;
  }
  restoreWorkProgress(messageId){
    const records=this.state.workTasks,index=records.findLastIndex(record=>record.messageId===messageId);if(index<0||!records[index].progressDismissedAt)return;
    const next=[...records];next[index]={...next[index]};delete next[index].progressDismissedAt;this.state.workTasks=next;
    try{this.save();}catch(error){this.state.workTasks=records;throw error;}
  }
  registerWork({workId,turnId,messageId=null,source='chat',title,plan,startedAt,status='running',observed=false}){
    if(typeof turnId!=='string'||!turnId||turnId.length>256||!['chat','voice'].includes(source))throw workError('work_stale_turn','Registered work requires a real owned turn.');
    const observing=observed===true,withoutPlan=observing&&plan===null,safe=withoutPlan?observedWithoutPlan(title):taskPlanInput({title,steps:plan?.steps}),before=this.state.workTasks,current=before.findIndex(entry=>entry.turnId===turnId),index=workId===undefined?current:before.findIndex(entry=>entry.id===workId),previous=before[index],automatic=before[current],now=Date.now();
    if(workId!==undefined&&(!previous||typeof workId!=='string'))throw workError('work_not_found','The task to continue was not found.');
    if(previous?.status==='cancelled')throw workError('work_not_continuable','Cancelled work cannot be continued. Create a new task if needed.');
    const supersede=current>=0&&index!==current&&!observing&&automatic.provisional===true&&['running','waiting_user'].includes(automatic.status)&&Array.isArray(automatic.turnIds)&&automatic.turnIds.length===1&&automatic.turnIds[0]===turnId;
    if(current>=0&&index!==current&&!supersede)throw workError('work_conflict','This turn already belongs to a different task.');
    if(previous&&previous.turnId!==turnId){if(!['continuing','waiting_user','paused','review'].includes(previous.status))throw workError('work_not_continuable','Only inactive unfinished work can continue in a different turn.');if(previous.turnIds?.includes(turnId))throw workError('work_stale_turn','A previous task turn cannot replace its current turn.');}
    if(!previous&&before.some(entry=>entry.turnIds?.includes(turnId)))throw workError('work_stale_turn','This turn already belongs to a different task.');
    if(withoutPlan&&previous?.plan){safe.title=previous.title;safe.plan=previous.plan;}
    const turnIds=[...new Set([...(previous?.turnIds||[]),...(previous?[previous.turnId]:[]),turnId])];
    const priority=this.state.messages.find(message=>message.id===messageId&&message.role==='user')?.progressPriority;
    const record={...(previous||{id:randomUUID(),source,startedAt:typeof startedAt==='number'&&Number.isFinite(startedAt)&&startedAt>0?startedAt:now,...(progressPriorities.has(priority)?{progressPriority:priority}:{}),...(observing?{provisional:true}:{})}),turnId,turnIds,messageId:previous?.messageId||messageId||null,...safe,status:['running','waiting_user','pausing','unknown'].includes(status)?status:'running',updatedAt:now};
    if(withoutPlan&&record.plan===null)record.provisional=true;else if(!observing||record.provisional!==true)delete record.provisional;
    delete record.progressDismissedAt;delete record.pauseReason;delete record.executionEndedAt;let next=[...before];if(index<0)next.push(record);else next[index]=record;if(supersede)next=next.filter((entry,position)=>position!==current);this.state.workTasks=next.slice(-300);
    try{this.save();}catch(error){this.state.workTasks=before;throw error;}return record;
  }
  updateRegisteredWork(turnId,{status,plan,executionEnded=false}={}){
    const before=this.state.workTasks,index=before.findIndex(entry=>entry.turnId===turnId);if(index<0)return null;
    const previous=before[index],patch={};if(previous.status==='cancelled'&&(plan||status!==undefined&&status!=='cancelled'))throw workError('work_not_continuable','Cancelled work cannot be changed by an earlier execution.');if(status!==undefined){if(!['running','waiting_user','pausing','unknown','continuing','paused','failed','review','completed','cancelled'].includes(status))throw Error('Invalid registered work state.');patch.status=status;}
    if(plan)patch.plan=taskPlanInput({title:previous.title,steps:plan.steps}).plan;
    if(executionEnded)patch.executionEndedAt=Date.now();
    if((status===undefined||status===previous.status)&&!plan&&!executionEnded)return previous;
    const record={...previous,...patch,updatedAt:Date.now()},next=[...before];next[index]=record;this.state.workTasks=next;
    try{this.save();}catch(error){this.state.workTasks=before;throw error;}return record;
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
  cancelWork({turnId=null,messageIds=[],workId}={}){
    const record=workId?this.state.workTasks.find(item=>item.id===workId):turnId?this.state.workTasks.find(item=>item.turnId===turnId):null;
    if(workId&&(!record||record.turnId!==turnId))throw progressError(409,'The task to cancel changed.');
    const ids=new Set(messageIds);if(this.state.messages.some(item=>item.role==='user'&&ids.has(item.id)&&(item.turnId||null)!==turnId))throw progressError(409,'The task to cancel changed.');
    const messages=this.state.messages.filter(item=>item.role==='user'&&(ids.has(item.id)||turnId&&item.turnId===turnId)),entries=[...messages,...(record?[record]:[])];
    if(!entries.length||entries.some(unconfirmedProgress))throw progressError(409,'This task cancellation cannot be confirmed.');
    const now=Date.now(),patches=[];
    for(const entry of entries){
      const patch={status:'cancelled',cancelledAt:entry.cancelledAt||now,pauseReason:null,error:null,progressDismissedAt:null,...(entry===record?{executionEndedAt:entry.executionEndedAt||now,updatedAt:now}:{})};
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
    if(kind==='task')return entry.role==='user'&&entry.status==='completed'&&!unconfirmedProgress(entry);
    const related=this.state.messages.filter(message=>message.role==='user'&&(message.turnId&&message.turnId===entry.turnId||kind==='completion'&&message.id===entry.taskId));
    if(unconfirmedProgress(entry)||related.some(unconfirmedProgress))return false;
    if(kind!=='completion')return entry.status==='completed';
    const records=this.state.workTasks.filter(record=>record.turnId===entry.turnId||record.turnIds?.includes(entry.turnId));
    if(records.length)return records.some(record=>record.turnId===entry.turnId&&record.status==='completed');
    return related.some(message=>message.turnId===entry.turnId&&message.status==='completed'&&(!entry.taskId||message.id===entry.taskId));
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
