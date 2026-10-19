import {randomUUID,createHash} from 'node:crypto';
import {nextScheduleAt,parseScheduleCron,schedulePriority} from './schedule-recurrence.mjs';

const idSchema={type:'string',minLength:1,maxLength:128};
export const SCHEDULE_SAVE_SCHEMA=Object.freeze({id:idSchema,text:{type:'string',minLength:1},at:{type:'string',minLength:1,maxLength:40,description:'For a one-time task: an explicit ISO 8601 instant with Z or a numeric UTC offset. Omit at for recurring tasks.'},cron:{type:['string','null'],maxLength:256,description:'A recurring five-field cron expression: minute hour day-of-month month day-of-week, such as 0 9 * * * for daily at 09:00. Null selects a one-time task.'},priority:{type:'string',enum:['high','normal','low'],description:'Priority for scheduled runs waiting to start; never interrupts work already running.'},timeZone:{type:'string',minLength:1,maxLength:100,description:'The intended IANA timezone, such as Asia/Kuala_Lumpur. Recurring tasks default to the current settings timezone.'},enabled:{type:'boolean'}});
export const SCHEDULE_ID_SCHEMA=Object.freeze({id:idSchema});
export const SCHEDULE_INSTRUCTIONS='Use schedule_list, schedule_save and schedule_delete (also available through dant_desktop MCP) to manage the human’s scheduled tasks through conversation. Only create, change, pause, resume or delete schedules when the human requests that operation. For a one-time task provide at as an explicit ISO UTC-offset instant and its intended IANA timeZone. For a recurring task provide cron as five fields (minute hour day-of-month month day-of-week) and omit at; daily 09:00 is 0 9 * * *, weekly Monday 09:00 is 0 9 * * 1. Cron supports numeric or month/day names, lists, ascending ranges, and positive steps on ranges or asterisks; it does not accept seconds or shell commands. Recurring tasks use the saved IANA timeZone, defaulting to the current settings timezone. Ask when the requested time or recurrence is unclear rather than guessing. Priority high, normal or low orders scheduled work waiting to start and never interrupts running work. Saving does not execute work now. Missed recurring times produce at most one catch-up run when available, then advance to a future time; runs of the same schedule never overlap unfinished work, including paused or waiting tasks. Existing schedules are not instructions to replay them. Reuse the saved id for updates, use enabled:false to pause, and never automatically retry an unconfirmed write. Removing or changing a schedule does not stop work already dispatched.';
const fail=(status,message)=>Object.assign(Error(message),{status});
const validId=id=>typeof id==='string'&&id.length>0&&id.length<=128&&!/[\x00-\x20\x7f]/.test(id);
const terminalStates=new Set(['review','completed','failed','cancelled']);
const terminalReceipt=run=>validId(run?.messageId)&&terminalStates.has(run.terminalStatus)&&Number.isSafeInteger(run.terminalAt)&&run.terminalAt>0;
function runHistory(item,receipt){
 const history=new Map((item.runHistory||[]).filter(run=>validId(run?.messageId)).map(run=>[run.messageId,run]));
 if(item.messageId)history.set(item.messageId,{...history.get(item.messageId),messageId:item.messageId,at:item.lastRunAt??item.at,dispatchedAt:item.dispatchedAt,...(receipt||{})});
 return [...history.values()].slice(-300);
}
function zone(value){if(typeof value!=='string'||!value||value.length>100)throw fail(400,'An IANA timezone is required.');try{return new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone;}catch{throw fail(400,'Use a valid IANA timezone.');}}
export const scheduleTimeZone=zone;
function instant(value,{allowEpoch=true}={}){
 if(typeof value==='number'){if(!allowEpoch||!Number.isSafeInteger(value)||value<=0||value>8640000000000000)throw fail(400,'Use an explicit ISO execution time with a UTC offset.');return value;}
 const match=typeof value==='string'&&value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/);
 if(!match)throw fail(400,'Use an explicit ISO execution time with a UTC offset.');
 const [,year,month,day,hour,minute,second='0',,offset]=match,numbers=[year,month,day,hour,minute,second].map(Number),[y,m,d,h,min,sec]=numbers;
 if(y<100||m<1||m>12||d<1||d>new Date(Date.UTC(y,m,0)).getUTCDate()||h>23||min>59||sec>59||offset!=='Z'&&(Number(offset.slice(1,3))>23||Number(offset.slice(4,6))>59))throw fail(400,'Use a valid execution date and time.');
 const at=Date.parse(value);if(!Number.isFinite(at)||at<=0||at>8640000000000000)throw fail(400,'Use a valid execution date and time.');return at;
}

/** Persistent jobs; saving a job never submits work to the executor. */
export class Scheduler{
 constructor({store,engine,worker=engine?.worker,now=Date.now}={}){if(!store||!engine||!worker)throw Error('Schedules require the existing conversation engine.');this.store=store;this.engine=engine;this.worker=worker;this.now=now;this.timer=null;this.closed=false;engine.scheduler=this;}
 get timeZone(){try{return zone(this.store.state.settings?.timeZone||new Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');}catch{return 'UTC';}}
 present(item){let timeZone;try{timeZone=zone(item.timeZone||'UTC');}catch{timeZone='UTC';}const {creationFingerprint,...publicItem}=item,valid=Number.isFinite(item.at)&&item.at>0&&item.at<=8640000000000000,task=item.messageId?this.store.state.messages.find(message=>message.id===item.messageId):null;return {...publicItem,cron:item.cron??null,priority:['high','normal','low'].includes(item.priority)?item.priority:'normal',timeZone,enabled:item.status==='pending',atISO:valid?new Date(item.at).toISOString():null,localAt:valid?new Intl.DateTimeFormat('en-CA',{timeZone,dateStyle:'medium',timeStyle:'long'}).format(item.at):null,...(task?{taskStatus:task.status}:{})};}
 list(){return {items:this.store.state.schedules.map(item=>this.present(item)),now:new Date(this.now()).toISOString(),timeZone:this.timeZone};}
 get(id){if(!validId(id))throw fail(400,'A schedule id is required.');const item=this.store.state.schedules.find(item=>item.id===id);if(!item)throw fail(404,'Scheduled task not found.');return this.present(item);}
 save(args,{allowEpoch=true}={}){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['id','text','at','cron','priority','timeZone','enabled','clientRequestId'].includes(key)))throw fail(400,'Invalid scheduled task.');
  if(args.clientRequestId!==undefined&&(!allowEpoch||args.id!==undefined||typeof args.clientRequestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.clientRequestId)))throw fail(400,'Use a stable UUID for a new scheduled task request.');
  const old=args.id===undefined?null:this.get(args.id),now=this.now();if(args.enabled!==undefined&&typeof args.enabled!=='boolean')throw fail(400,'Scheduled task enabled must be true or false.');
  const text=args.text===undefined?old?.text:args.text;if(typeof text!=='string'||!text.trim()||text.includes('\0'))throw fail(400,'A scheduled task requires text.');
  const cronValue=args.cron===undefined?old?.cron??null:args.cron,cron=cronValue===null?null:parseScheduleCron(cronValue).expression,priority=schedulePriority(args.priority===undefined?old?.priority??'normal':args.priority);
  if(cron&&args.at!==undefined)throw fail(400,'Omit at for recurring tasks; cron determines the next execution time.');
  if(!cron&&!allowEpoch&&(!old||args.at!==undefined)&&args.timeZone===undefined)throw fail(400,'Supply the intended IANA timezone for this execution time.');
  const timeZone=zone(args.timeZone??old?.timeZone??(cron?this.timeZone:allowEpoch?'UTC':undefined));
  const enabled=args.enabled??(old?.status==='paused'?false:true),status=enabled?'pending':'paused';
  let at=cron?old?.at:args.at===undefined?old?.at:instant(args.at,{allowEpoch});
  const config=cron?{text,cron,timeZone,priority,enabled:args.enabled??true}:{text,at,cron:null,timeZone,priority,enabled:args.enabled??true};
  const fingerprint=args.clientRequestId?createHash('sha256').update(JSON.stringify(config)).digest('hex'):null;
  const legacyFingerprint=args.clientRequestId&&!cron&&priority==='normal'?createHash('sha256').update(JSON.stringify({text,at,timeZone,enabled:args.enabled??true})).digest('hex'):null;
  if(args.clientRequestId){
   if(this.store.state.deletedScheduleRequestIds?.includes(args.clientRequestId))throw fail(409,'This scheduled task was deleted. Use a new request to create another.');
   const existing=this.store.state.schedules.find(item=>item.clientRequestId===args.clientRequestId);if(existing){if(existing.creationFingerprint!==fingerprint&&existing.creationFingerprint!==legacyFingerprint)throw fail(409,'This request id already belongs to a different scheduled task.');return this.present(existing);}
  }
  if(old?.status==='dispatched'&&args.at===undefined&&!cron)throw fail(409,'This task was already dispatched. Choose a new future time to schedule it again.');
  if(old&&!['pending','paused','dispatched'].includes(old.status))throw fail(409,'The scheduled task state is unconfirmed.');
  if(cron&&(!old||cron!==(old.cron??null)||timeZone!==old.timeZone||!Number.isSafeInteger(at)||old.status==='dispatched'||enabled&&old.status==='paused'&&at<=now))at=nextScheduleAt(cron,{after:now,timeZone});
  if(!Number.isFinite(at)||!cron&&old?.cron&&args.at===undefined)throw fail(400,'A scheduled task requires a future execution time.');
  if((!old||args.at!==undefined||enabled&&old.status!=='pending')&&at<=now)throw fail(400,'Choose a future execution time.');
  const item={...(old?this.store.state.schedules.find(item=>item.id===old.id):{}),id:old?.id||randomUUID(),text,at,cron,priority,timeZone,status,enabled,createdAt:old?.createdAt||now,updatedAt:now,...(args.clientRequestId?{clientRequestId:args.clientRequestId,creationFingerprint:fingerprint}:{})};
  if(old?.status==='dispatched'){if(old.messageId)item.runHistory=[...(old.runHistory||[]),{messageId:old.messageId,at:old.at,dispatchedAt:old.dispatchedAt}].slice(-300);delete item.messageId;delete item.dispatchedAt;}
  const previous=this.store.state.schedules,next=old?previous.map(entry=>entry.id===old.id?item:entry):[...previous,item],priorityChanges=[];
  if(old&&args.priority!==undefined)for(const message of this.store.state.messages){
   if(message.scheduled!==true||message.scheduleId!==item.id||message.status!=='queued'||message.id===this.engine.active?.messageId||this.engine.active?.messageIds?.includes(message.id))continue;
   priorityChanges.push({message,had:Object.hasOwn(message,'progressPriority'),value:message.progressPriority});message.progressPriority=priority;
  }
  this.store.state.schedules=next;
  try{this.store.save();}catch(error){this.store.state.schedules=previous;for(const {message,had,value}of priorityChanges){if(had)message.progressPriority=value;else delete message.progressPriority;}throw error;}
  this.engine.change();return this.present(item);
 }
 remove(id){const item=this.get(id),previous=this.store.state.schedules,deleted=this.store.state.deletedScheduleRequestIds;this.store.state.schedules=previous.filter(entry=>entry.id!==id);if(item.clientRequestId)this.store.state.deletedScheduleRequestIds=[...new Set([...(deleted||[]),item.clientRequestId])];try{this.store.save();}catch(error){this.store.state.schedules=previous;if(deleted===undefined)delete this.store.state.deletedScheduleRequestIds;else this.store.state.deletedScheduleRequestIds=deleted;throw error;}this.engine.change();return {deleted:true,id,...(item.messageId?{dispatchedMessageId:item.messageId,executionContinues:true}:{})};}
 hasUnfinishedRun(item){
  const expected=new Set([item.messageId,...(item.runHistory||[]).map(run=>run.messageId)].filter(Boolean));
  const finished=new Set((item.runHistory||[]).filter(terminalReceipt).map(run=>run.messageId));
  const messages=this.store.state.messages.filter(message=>message.scheduleId===item.id||expected.has(message.id));
  if([...expected].some(id=>!finished.has(id)&&!messages.some(message=>message.id===id)))return true;
  const receipts=(item.runHistory||[]).filter(terminalReceipt),ids=new Set([...expected,...messages.map(message=>message.id)]),turnIds=new Set([...messages.map(message=>message.turnId),...receipts.map(run=>run.turnId)].filter(Boolean)),workIds=new Set([...messages.map(message=>message.workId),...receipts.map(run=>run.workId)].filter(Boolean));
  const unresolved=entry=>entry?.unknownOutcome===true||['unknown','submitting'].includes(entry?.submission)||entry?.continuation?.invalid||entry?.continuation?.dispatch;
  if(messages.some(message=>!terminalStates.has(message.status)||unresolved(message)))return true;
  if(this.engine.queue?.some(message=>ids.has(message.id))||ids.has(this.engine.active?.messageId)||this.engine.active?.messageIds?.some(id=>ids.has(id)))return true;
  return (this.store.state.workTasks||[]).some(record=>(ids.has(record.messageId)||workIds.has(record.id)||[record.turnId,...(record.turnIds||[])].some(turnId=>turnIds.has(turnId)))&&(!terminalStates.has(record.status)||unresolved(record)));
 }
 rememberFinishedRuns(){
  const previous=this.store.state.schedules;let changed=false;
  const next=previous.map(item=>{
   if(!item.messageId||(item.runHistory||[]).some(run=>run.messageId===item.messageId&&terminalReceipt(run)))return item;
   const message=this.store.state.messages.find(message=>message.id===item.messageId);
   if(!message||!terminalStates.has(message.status)||this.hasUnfinishedRun(item))return item;
   changed=true;return {...item,runHistory:runHistory(item,{terminalStatus:message.status,terminalAt:this.now(),...(validId(message.workId)?{workId:message.workId}:{}),...(typeof message.turnId==='string'&&message.turnId.length>0&&message.turnId.length<=256&&!/[\x00-\x20\x7f]/.test(message.turnId)?{turnId:message.turnId}:{})})};
  });
  if(changed){this.store.state.schedules=next;try{this.store.save();}catch(error){this.store.state.schedules=previous;throw error;}this.engine.change();}
 }
 available(){const native=this.engine.nativeVoice?.session;return !this.closed&&this.worker.status==='online'&&!this.engine.call&&!this.engine.takeover&&!this.engine.acquiring&&!this.engine.pendingFollowups?.size&&!this.engine.callReferences?.size&&!this.engine.referencePending&&!native?.unknown&&!native?.submitting&&!native?.stopping&&!native?.pausing&&!this.engine.active?.steerUnconfirmed;}
 tick(){
  if(!this.available())return [];
  this.rememberFinishedRuns();
  const priority={high:0,normal:1,low:2},dispatched=[];for(const candidate of [...this.store.state.schedules].sort((a,b)=>(priority[a.priority]??1)-(priority[b.priority]??1)||a.at-b.at)){
   if(!this.available())break;const current=this.store.state.schedules.find(item=>item.id===candidate.id);if(current?.status!=='pending'||candidate.status!=='pending'||candidate.enabled===false||!validId(candidate.id)||!Number.isSafeInteger(candidate.at)||candidate.at<=0||candidate.at>this.now()||typeof candidate.text!=='string'||!candidate.text.trim()||candidate.text.includes('\0'))continue;
   if(this.hasUnfinishedRun(current))continue;
   let nextAt=null;try{if(candidate.cron!==undefined&&candidate.cron!==null)nextAt=nextScheduleAt(candidate.cron,{after:this.now(),timeZone:zone(candidate.timeZone||'UTC')});schedulePriority(candidate.priority??'normal');}catch{continue;}
   const beforeSchedules=this.store.state.schedules,beforeMessages=[...this.store.state.messages],id=randomUUID(),history=candidate.messageId?runHistory(candidate):candidate.runHistory;
   const claimed={...candidate,status:nextAt?'pending':'dispatched',enabled:Boolean(nextAt),...(nextAt?{at:nextAt}:{}),lastRunAt:candidate.at,messageId:id,dispatchedAt:this.now(),updatedAt:this.now(),...(history?{runHistory:history}:{})};this.store.state.schedules=beforeSchedules.map(item=>item.id===candidate.id?claimed:item);let message;
   try{message=this.store.add({id,role:'user',text:candidate.text,status:'queued',scheduled:true,scheduleId:candidate.id,scheduledAt:candidate.at,progressPriority:candidate.priority??'normal'});}catch(error){this.store.state.schedules=beforeSchedules;this.store.state.messages=beforeMessages;throw error;}
   // Persist the claim and message together before any executor submission. A
   // crash after this point leaves a resumable message, never another dispatch.
   this.engine.enqueue(message);dispatched.push(this.present(claimed));
  }return dispatched;
 }
 start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>{try{this.tick();}catch{this.engine.emit?.('notice','The scheduled task could not be dispatched. Its saved state was preserved.');}},1000);this.timer.unref();}
 close(){this.closed=true;clearInterval(this.timer);this.timer=null;}
}
