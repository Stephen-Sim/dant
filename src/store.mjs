import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {safeCompletionWork,taskPlanInput} from './task-progress.mjs';
const renameRetryCodes=new Set(['EPERM','EACCES','EBUSY']);
const pauseBuffer=new Int32Array(new SharedArrayBuffer(4));
export const TASK_STATES=Object.freeze(['draft','queued','running','waiting_user','pausing','paused','failed','review','completed']);
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const progressError=(status,message)=>Object.assign(Error(message),{status});
const dismissibleStates=new Set(['paused','failed','review','completed']);
export class Store {
  constructor(dir,{renameSync=fs.renameSync,platform=process.platform,pause=ms=>Atomics.wait(pauseBuffer,0,0,ms)}={}) {
    this.renameSync=renameSync;this.platform=platform;this.pause=pause;
    this.dir=dir; fs.mkdirSync(dir,{recursive:true}); this.file=path.join(dir,'state.json');
    this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:2,messages:[],memory:'',settings:{language:'zh',voice:'marin',model:'',notifications:true,vm:{host:'',user:'dant',port:22,keyPath:'',knownHosts:''}},threadId:null,threadRuntime:null,schedules:[]};
    if(!uuidPattern.test(this.state.conversationId||''))this.state.conversationId=randomUUID();
    this.state.version=2;this.state.schedules ||= [];this.state.completions ||= [];
    this.state.workTasks=(Array.isArray(this.state.workTasks)?this.state.workTasks:[]).flatMap(entry=>{
      try{const {title,plan}=taskPlanInput({title:entry.title,steps:entry.plan?.steps});if(!uuidPattern.test(entry.id)||typeof entry.turnId!=='string'||!entry.turnId||entry.turnId.length>256||!['chat','voice'].includes(entry.source)||!['running','waiting_user','pausing','unknown','paused','failed','review','completed'].includes(entry.status))return [];
      const restored={id:entry.id,turnId:entry.turnId,messageId:typeof entry.messageId==='string'?entry.messageId:null,source:entry.source,title,plan,status:entry.status,startedAt:entry.startedAt,updatedAt:entry.updatedAt};
      if(typeof entry.progressDismissedAt==='number'&&entry.progressDismissedAt>0)restored.progressDismissedAt=entry.progressDismissedAt;
      if(['running','waiting_user','pausing','unknown'].includes(restored.status)){restored.status='paused';restored.pauseReason='restart';restored.updatedAt=Date.now();}else if(entry.pauseReason)restored.pauseReason=entry.pauseReason;
      return [restored];}catch{return [];}
    }).slice(-300);
    const lastActiveAt=this.state.presence?.lastActiveAt;this.state.presence={lastActiveAt:typeof lastActiveAt==='number'&&Number.isFinite(lastActiveAt)&&lastActiveAt>0&&lastActiveAt<=8640000000000000?lastActiveAt:null};
    this.state.deletedClientMessageIds=Array.isArray(this.state.deletedClientMessageIds)?[...new Set(this.state.deletedClientMessageIds.filter(id=>typeof id==='string'&&id.length>0&&id.length<=128))].slice(-2000):[];
    for(const m of this.state.messages){
      if(m.role==='user'){
        m.receivedAt ??= m.time||Date.now();m.executorConfirmedAt ??= null;
        if(m.status==='read')m.status='review';
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
  registerWork({turnId,messageId=null,source='chat',title,plan,startedAt,status='running'}){
    if(typeof turnId!=='string'||!turnId||turnId.length>256||!['chat','voice'].includes(source))throw Error('Registered work requires a real owned turn.');
    const safe=taskPlanInput({title,steps:plan?.steps}),before=this.state.workTasks,index=before.findIndex(entry=>entry.turnId===turnId),previous=before[index],now=Date.now();
    const record={...(previous||{id:randomUUID(),turnId,source,startedAt:typeof startedAt==='number'&&Number.isFinite(startedAt)&&startedAt>0?startedAt:now}),messageId:messageId||previous?.messageId||null,...safe,status:['running','waiting_user','pausing','unknown'].includes(status)?status:'running',updatedAt:now};
    delete record.progressDismissedAt;delete record.pauseReason;const next=[...before];if(index<0)next.push(record);else next[index]=record;this.state.workTasks=next.slice(-300);
    try{this.save();}catch(error){this.state.workTasks=before;throw error;}return record;
  }
  updateRegisteredWork(turnId,{status,plan}={}){
    const before=this.state.workTasks,index=before.findIndex(entry=>entry.turnId===turnId);if(index<0)return null;
    const previous=before[index],patch={};if(status!==undefined){if(!['running','waiting_user','pausing','unknown','paused','failed','review','completed'].includes(status))throw Error('Invalid registered work state.');patch.status=status;}
    if(plan)patch.plan=taskPlanInput({title:previous.title,steps:plan.steps}).plan;
    if((status===undefined||status===previous.status)&&!plan)return previous;
    const record={...previous,...patch,updatedAt:Date.now()},next=[...before];next[index]=record;this.state.workTasks=next;
    try{this.save();}catch(error){this.state.workTasks=before;throw error;}return record;
  }
  progressEntry(id,kind){
    if(typeof id!=='string'||!id||id.length>128||!['task','completion','work'].includes(kind))throw progressError(400,'Invalid work progress request.');
    const entry=(kind==='task'?this.state.messages:kind==='work'?this.state.workTasks:this.state.completions).find(item=>item.id===id);
    if(!entry)throw progressError(404,'Work progress entry not found.');
    if(kind==='work'){
      if(!dismissibleStates.has(entry.status))throw progressError(409,'Only inactive task history can be dismissed.');
    }else if(kind==='task'){
      if(entry.role!=='user'||!dismissibleStates.has(entry.status))throw progressError(409,'Only inactive task history can be dismissed.');
    }else if(!safeCompletionWork(entry.work)||typeof entry.turnId!=='string'||/:(input|credential):/.test(entry.turnId)||!Array.isArray(entry.messageIds)||!entry.messageIds.some(messageId=>this.state.messages.some(message=>message.id===messageId&&message.role==='assistant'&&message.status!=='streaming'))){
      throw progressError(409,'Only final voice task history can be dismissed.');
    }
    return entry;
  }
  dismissProgress(id,kind){
    const entry=this.progressEntry(id,kind);
    if(typeof entry.progressDismissedAt==='number'&&Number.isFinite(entry.progressDismissedAt)&&entry.progressDismissedAt>0)return {ok:true};
    const hadValue=Object.hasOwn(entry,'progressDismissedAt'),previous=entry.progressDismissedAt;entry.progressDismissedAt=Date.now();
    try{this.save();}catch(error){if(hadValue)entry.progressDismissedAt=previous;else delete entry.progressDismissedAt;throw error;}
    return {ok:true};
  }
}
