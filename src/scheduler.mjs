import {randomUUID,createHash} from 'node:crypto';

const idSchema={type:'string',minLength:1,maxLength:128};
export const SCHEDULE_SAVE_SCHEMA=Object.freeze({id:idSchema,text:{type:'string',minLength:1},at:{type:'string',minLength:1,maxLength:40,description:'An explicit ISO 8601 instant with Z or a numeric UTC offset, such as 2026-10-18T09:00:00+08:00.'},timeZone:{type:'string',minLength:1,maxLength:100,description:'The intended IANA timezone, such as Asia/Kuala_Lumpur.'},enabled:{type:'boolean'}});
export const SCHEDULE_ID_SCHEMA=Object.freeze({id:idSchema});
export const SCHEDULE_INSTRUCTIONS='Use schedule_list, schedule_save and schedule_delete (also available through dant_desktop MCP) to manage the human’s scheduled tasks through conversation. Only create, change, pause, resume or delete schedules when the human requests that operation. New or rescheduled tasks require an actual requested execution time with an explicit ISO UTC offset and IANA timeZone; ask when the time or timezone is unclear rather than guessing. schedule_save only saves a one-time future task; it does not execute the task now. Existing schedules are not instructions to replay them. This scheduler supports one-time tasks only: do not claim a recurring schedule was created. Reuse a saved id for updates, use enabled:false to pause, and never automatically retry an unconfirmed write. Removing or changing a schedule does not stop work already dispatched.';
const fail=(status,message)=>Object.assign(Error(message),{status});
const validId=id=>typeof id==='string'&&id.length>0&&id.length<=128&&!/[\x00-\x20\x7f]/.test(id);
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

/** Persistent one-time jobs; saving a job never submits work to the executor. */
export class Scheduler{
 constructor({store,engine,worker=engine?.worker,now=Date.now}={}){if(!store||!engine||!worker)throw Error('Schedules require the existing conversation engine.');this.store=store;this.engine=engine;this.worker=worker;this.now=now;this.timer=null;this.closed=false;engine.scheduler=this;}
 get timeZone(){try{return zone(this.store.state.settings?.timeZone||new Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');}catch{return 'UTC';}}
 present(item){let timeZone;try{timeZone=zone(item.timeZone||'UTC');}catch{timeZone='UTC';}const {creationFingerprint,...publicItem}=item,valid=Number.isFinite(item.at)&&item.at>0&&item.at<=8640000000000000,task=item.messageId?this.store.state.messages.find(message=>message.id===item.messageId):null;return {...publicItem,timeZone,enabled:item.status==='pending',atISO:valid?new Date(item.at).toISOString():null,localAt:valid?new Intl.DateTimeFormat('en-CA',{timeZone,dateStyle:'medium',timeStyle:'long'}).format(item.at):null,...(task?{taskStatus:task.status}:{})};}
 list(){return {items:this.store.state.schedules.map(item=>this.present(item)),now:new Date(this.now()).toISOString(),timeZone:this.timeZone};}
 get(id){if(!validId(id))throw fail(400,'A schedule id is required.');const item=this.store.state.schedules.find(item=>item.id===id);if(!item)throw fail(404,'Scheduled task not found.');return this.present(item);}
 save(args,{allowEpoch=true}={}){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['id','text','at','timeZone','enabled','clientRequestId'].includes(key)))throw fail(400,'Invalid scheduled task.');
  if(args.clientRequestId!==undefined&&(!allowEpoch||args.id!==undefined||typeof args.clientRequestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.clientRequestId)))throw fail(400,'Use a stable UUID for a new scheduled task request.');
  const old=args.id===undefined?null:this.get(args.id),now=this.now();if(args.enabled!==undefined&&typeof args.enabled!=='boolean')throw fail(400,'Scheduled task enabled must be true or false.');
  const text=args.text===undefined?old?.text:args.text;if(typeof text!=='string'||!text.trim()||text.includes('\0'))throw fail(400,'A scheduled task requires text.');
  if(!allowEpoch&&(!old||args.at!==undefined)&&args.timeZone===undefined)throw fail(400,'Supply the intended IANA timezone for this execution time.');
  const at=args.at===undefined?old?.at:instant(args.at,{allowEpoch}),timeZone=zone(args.timeZone??old?.timeZone??(allowEpoch?'UTC':undefined));
  if(!Number.isFinite(at))throw fail(400,'A scheduled task requires a future execution time.');
  const fingerprint=args.clientRequestId?createHash('sha256').update(JSON.stringify({text,at,timeZone,enabled:args.enabled??true})).digest('hex'):null;
  if(args.clientRequestId){
   if(this.store.state.deletedScheduleRequestIds?.includes(args.clientRequestId))throw fail(409,'This scheduled task was deleted. Use a new request to create another.');
   const existing=this.store.state.schedules.find(item=>item.clientRequestId===args.clientRequestId);if(existing){if(existing.creationFingerprint!==fingerprint)throw fail(409,'This request id already belongs to a different scheduled task.');return this.present(existing);}
  }
  if(old?.status==='dispatched'&&args.at===undefined)throw fail(409,'This task was already dispatched. Choose a new future time to schedule it again.');
  if(old&&!['pending','paused','dispatched'].includes(old.status))throw fail(409,'The scheduled task state is unconfirmed.');
  const enabled=args.enabled??(old?.status==='paused'?false:true),status=enabled?'pending':'paused';
  if((!old||args.at!==undefined||enabled&&old.status!=='pending')&&at<=now)throw fail(400,'Choose a future execution time.');
  const item={...(old?this.store.state.schedules.find(item=>item.id===old.id):{}),id:old?.id||randomUUID(),text,at,timeZone,status,enabled,createdAt:old?.createdAt||now,updatedAt:now,...(args.clientRequestId?{clientRequestId:args.clientRequestId,creationFingerprint:fingerprint}:{})};
  if(old?.status==='dispatched'){if(old.messageId)item.runHistory=[...(old.runHistory||[]),{messageId:old.messageId,at:old.at,dispatchedAt:old.dispatchedAt}].slice(-300);delete item.messageId;delete item.dispatchedAt;}
  const previous=this.store.state.schedules,next=old?previous.map(entry=>entry.id===old.id?item:entry):[...previous,item];this.store.state.schedules=next;try{this.store.save();}catch(error){this.store.state.schedules=previous;throw error;}this.engine.change();return this.present(item);
 }
 remove(id){const item=this.get(id),previous=this.store.state.schedules,deleted=this.store.state.deletedScheduleRequestIds;this.store.state.schedules=previous.filter(entry=>entry.id!==id);if(item.clientRequestId)this.store.state.deletedScheduleRequestIds=[...new Set([...(deleted||[]),item.clientRequestId])];try{this.store.save();}catch(error){this.store.state.schedules=previous;if(deleted===undefined)delete this.store.state.deletedScheduleRequestIds;else this.store.state.deletedScheduleRequestIds=deleted;throw error;}this.engine.change();return {deleted:true,id,...(item.messageId?{dispatchedMessageId:item.messageId,executionContinues:true}:{})};}
 available(){const native=this.engine.nativeVoice?.session;return !this.closed&&this.worker.status==='online'&&!this.engine.call&&!this.engine.takeover&&!this.engine.acquiring&&!this.engine.pendingFollowups?.size&&!this.engine.callReferences?.size&&!this.engine.referencePending&&!native?.unknown&&!native?.submitting&&!native?.stopping&&!native?.pausing&&!this.engine.active?.steerUnconfirmed;}
 tick(){
  if(!this.available())return [];
  const dispatched=[];for(const candidate of [...this.store.state.schedules]){
   if(!this.available())break;const current=this.store.state.schedules.find(item=>item.id===candidate.id);if(current?.status!=='pending'||candidate.status!=='pending'||candidate.enabled===false||!validId(candidate.id)||!Number.isSafeInteger(candidate.at)||candidate.at<=0||candidate.at>this.now()||typeof candidate.text!=='string'||!candidate.text.trim()||candidate.text.includes('\0'))continue;
   const beforeSchedules=this.store.state.schedules,beforeMessages=[...this.store.state.messages],id=randomUUID(),claimed={...candidate,status:'dispatched',enabled:false,messageId:id,dispatchedAt:this.now(),updatedAt:this.now()};this.store.state.schedules=beforeSchedules.map(item=>item.id===candidate.id?claimed:item);let message;
   try{message=this.store.add({id,role:'user',text:candidate.text,status:'queued',scheduled:true,scheduleId:candidate.id});}catch(error){this.store.state.schedules=beforeSchedules;this.store.state.messages=beforeMessages;throw error;}
   // Persist the claim and message together before any executor submission. A
   // crash after this point leaves a resumable message, never another dispatch.
   this.engine.enqueue(message);dispatched.push(this.present(claimed));
  }return dispatched;
 }
 start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>{try{this.tick();}catch{this.engine.emit?.('notice','The scheduled task could not be dispatched. Its saved state was preserved.');}},1000);this.timer.unref();}
 close(){this.closed=true;clearInterval(this.timer);this.timer=null;}
}
