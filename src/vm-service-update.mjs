import {ServiceUpdateStatus, ConnectionStatus, TaskStatus, SubmissionStatus, ComputerControlStatus} from './contracts/states.mjs';
// The automatic path only observes fresh VM state. The remote installer repeats
// these checks immediately before changing a live service.
function quiescent(state,allowStopped){
 if(!state||state.active!==null||state.call!==null||!Array.isArray(state.queue)||state.queue.length||state.takeover!==false||state.acquiring||!(state.worker?.status===ConnectionStatus.Online||allowStopped&&state.worker?.status===ConnectionStatus.Offline))return false;
 const computer=state.computer;
 if(!computer||computer.status!==ComputerControlStatus.Dant||computer.sessionId||computer.pending||computer.acquiring)return false;
 if(!Array.isArray(state.messages)||!Array.isArray(state.workTasks))return false;
 return ![...state.messages,...state.workTasks].some(entry=>{
  if(!entry||typeof entry!=='object'||entry.unknownOutcome===true||[SubmissionStatus.Unknown,SubmissionStatus.Submitting].includes(entry.submission)||entry.continuation?.invalid||entry.continuation?.dispatch)return true;
  // Accepted speech in a finished call is conversation history, not an
  // execution task. It has no turn/work ownership to interrupt or resume.
  if(entry.role==='user'&&entry.workKind==='conversation'&&entry.voiceCallId&&!entry.turnId&&!entry.workId&&entry.status===TaskStatus.Accepted)return false;
  return [TaskStatus.Unknown,TaskStatus.Running,TaskStatus.Queued,TaskStatus.Accepted,TaskStatus.Pausing,TaskStatus.Continuing].includes(entry.status)||entry.status===TaskStatus.WaitingUser&&!(typeof entry.executionEndedAt==='number'&&Number.isFinite(entry.executionEndedAt)&&entry.executionEndedAt>0);
 });
}
export const serviceUpdateIdle=state=>quiescent(state,false);
// Explicit installation/Exit may suspend an already stopped executor. A
// connecting, unknown or busy executor is never substituted with an online one.
export const serviceUpdatePaused=state=>quiescent(state,true);

// One Controller owns retries. A transport retry never gains permission to pause
// work, and an unconfirmed installation is only reconciled with read requests.
export class VmServiceUpdateLoop{
 constructor({bridge,connect,binding,allowed=()=>true,setTimer=(...args)=>setTimeout(...args),clearTimer=(...args)=>clearTimeout(...args)}={}){
  Object.assign(this,{bridge,connect,binding,allowed,setTimer,clearTimer});this.enabled=false;this.closed=false;this.epoch=0;this.attempt=0;this.checked=false;this.scope=null;this.pending=null;this.timer=null;
 }
 identity(){return JSON.stringify(this.binding());}
 start(){if(this.closed)return Promise.resolve();this.enabled=true;return this.run();}
 reset(){this.epoch++;this.attempt=0;this.checked=false;this.scope=this.identity();this.clearTimer(this.timer);this.timer=null;if(this.enabled)this.schedule(0);}
 schedule(ms=30000){if(!this.enabled||this.closed||this.timer)return;this.timer=this.setTimer(()=>{this.timer=null;void this.run().catch(()=>{});},ms);this.timer?.unref?.();}
 changed(){if(!this.enabled||this.closed)return;if(this.scope!==this.identity()){this.reset();return;}if(this.pending||this.driving)return;const update=this.bridge.serviceUpdate;if(this.bridge.status!==ConnectionStatus.Online)this.schedule(5000);else if(update&&update.status!==ServiceUpdateStatus.Current)this.schedule(update.status===ServiceUpdateStatus.Pending?1000:30000);}
 async run(){
  if(!this.enabled||this.closed)return;if(this.pending)return this.pending;
  if(this.scope!==this.identity()){this.epoch++;this.scope=this.identity();this.checked=false;this.attempt=0;}
  const epoch=this.epoch,scope=this.scope,current=()=>!this.closed&&this.enabled&&epoch===this.epoch&&scope===this.identity();
  this.driving=true;const pending=(async()=>{
   if(!this.allowed()){this.schedule(5000);return;}
   const update=this.bridge.serviceUpdate,uncertain=update?.reason==='update-unconfirmed';
   try{
    if(this.bridge.status===ConnectionStatus.Online){
     if(update?.status===ServiceUpdateStatus.Current||!update&&this.checked){this.checked=true;this.attempt=0;return;}
     if(update?.reason==='version-unconfirmed'&&this.bridge.sourceVerified){await this.bridge.confirmServiceVersion?.();return;}
     if(uncertain){await this.bridge.reconcileServiceUpdate?.();return;}
     if(update?.status===ServiceUpdateStatus.Failed&&!['connection-unavailable','version-unconfirmed'].includes(update.reason))return;
     const generation=this.bridge.generation,state=await this.bridge.refresh(true);if(!current()||generation!==this.bridge.generation||!serviceUpdateIdle(state))return;
    }
    if(!current()||!this.allowed())return;
    await this.connect({deploy:!this.checked&&!uncertain,automatic:true});
    if(!current())return;
    if(this.bridge.serviceUpdate?.status===ServiceUpdateStatus.Current||!this.bridge.serviceUpdate){this.checked=true;this.attempt=0;}
    else if(uncertain)await this.bridge.reconcileServiceUpdate?.();
   }catch{if(current())this.attempt=Math.min(this.attempt+1,4);}
  })().finally(()=>{
   if(this.pending===pending)this.pending=null;this.driving=false;
   if(!current()){if(!this.closed&&this.enabled)this.schedule(0);return;}
   const update=this.bridge.serviceUpdate;
   if(this.bridge.status!==ConnectionStatus.Online)this.schedule(Math.min(60000,5000*2**Math.max(0,this.attempt-1)));
   else if(update&&update.status!==ServiceUpdateStatus.Current)this.schedule(30000);
  });this.pending=pending;return pending;
 }
 close(){this.closed=true;this.enabled=false;this.epoch++;this.clearTimer(this.timer);this.timer=null;}
}
