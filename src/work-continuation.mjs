import {continuationEligible,continuationId} from './work-continuation-state.mjs';

const CHANGE_DELAY=5000;
const FAILURE_DELAY=30000;
const FAILURE_NOTICE='Unfinished work could not be continued. Its saved state was preserved.';
const priority={high:0,normal:1,low:2};
const unfinished=plan=>plan===null||Array.isArray(plan?.steps)&&plan.steps.length>0&&plan.steps.every(step=>step&&['pending','inProgress','completed'].includes(step.status))&&plan.steps.some(step=>step.status!=='completed');
const dueAt=record=>record.continuation?.nextAt??record.executionEndedAt+CHANGE_DELAY;

/** Reconcile saved unfinished work through the Engine's single admission path. */
export class WorkContinuationSupervisor{
 constructor({engine,store=engine?.store,worker=engine?.worker,now=Date.now,intervalMs=30000,setTimer=setInterval,clearTimer=clearInterval}={}){
  if(!engine||!store||!worker||typeof now!=='function'||typeof setTimer!=='function'||typeof clearTimer!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<=0)throw Error('Work continuation requires the existing conversation engine and timers.');
  this.engine=engine;this.store=store;this.worker=worker;this.now=now;this.intervalMs=intervalMs;this.setTimer=setTimer;this.clearTimer=clearTimer;
  this.timer=null;this.changeTimer=null;this.started=false;this.closed=false;this.running=false;this.retryAt=0;this.generation=0;
  this.onChange=()=>this.scheduleCheck();
 }
 available(){return !this.closed&&this.worker.status==='online'&&typeof this.engine.canContinueRegisteredWork==='function'&&this.engine.canContinueRegisteredWork()===true;}
 eligible(record,at){return continuationId(record?.id,128)&&continuationId(record?.turnId)&&unfinished(record.plan)&&continuationEligible(record,{at});}
 candidate(at){
  const records=Array.isArray(this.store.state?.workTasks)?this.store.state.workTasks:[];
  return records.map((record,index)=>({record,index})).filter(({record})=>this.eligible(record,at)).sort((a,b)=>(priority[a.record.progressPriority]??1)-(priority[b.record.progressPriority]??1)||dueAt(a.record)-dueAt(b.record)||a.index-b.index).map(({record})=>({id:record.id,turnId:record.turnId}))[0]||null;
 }
 async tick(){
  if(this.closed||this.running)return null;
  this.running=true;const generation=this.generation;
  try{
   const at=this.now();if(at<this.retryAt||!this.available())return null;
   const selected=this.candidate(at);if(!selected||!this.available())return null;
   const current=this.store.state.workTasks.find(record=>record.id===selected.id);
   if(this.closed||generation!==this.generation||current?.turnId!==selected.turnId||!this.eligible(current,this.now()))return null;
   // No await separates the final selection from the Engine's synchronous
   // reservation. It rechecks the exact saved owner before any submission.
   const result=await this.engine.continueRegisteredWork(selected.id,{expectedTurnId:selected.turnId});
   return this.closed||generation!==this.generation?null:result;
  }catch{
   if(!this.closed&&generation===this.generation){
    this.retryAt=Math.max(this.retryAt,this.now()+FAILURE_DELAY);
    try{this.engine.emit?.('notice',FAILURE_NOTICE);}catch{}
   }
   return null;
  }finally{this.running=false;}
 }
 scheduleCheck(){
  if(!this.started||this.closed)return;
  if(this.changeTimer!==null)this.clearTimer(this.changeTimer);
  const generation=this.generation,timer=this.setTimer(()=>{
   if(this.changeTimer!==timer)return;
   this.clearTimer(timer);this.changeTimer=null;
   if(!this.closed&&this.started&&generation===this.generation)void this.tick();
  },CHANGE_DELAY);
  this.changeTimer=timer;timer?.unref?.();
 }
 start(){
  if(this.started||this.closed)return this;
  this.started=true;this.engine.on?.('change',this.onChange);
  this.timer=this.setTimer(()=>{void this.tick();},this.intervalMs);this.timer?.unref?.();
  return this;
 }
 close(){
  if(this.closed)return;
  this.closed=true;this.started=false;this.generation++;
  if(this.timer!==null)this.clearTimer(this.timer);
  if(this.changeTimer!==null)this.clearTimer(this.changeTimer);
  this.timer=null;this.changeTimer=null;
  if(typeof this.engine.off==='function')this.engine.off('change',this.onChange);else this.engine.removeListener?.('change',this.onChange);
 }
}
