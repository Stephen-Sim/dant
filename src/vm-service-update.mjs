// The automatic path only observes fresh VM state. The remote installer repeats
// these checks immediately before changing a live service.
export function serviceUpdateIdle(state){
 if(!state||state.active!==null||state.call!==null||!Array.isArray(state.queue)||state.queue.length||state.takeover!==false||state.acquiring||state.worker?.status!=='online')return false;
 const computer=state.computer;
 if(!computer||computer.status!=='dant'||computer.sessionId||computer.pending||computer.acquiring)return false;
 if(!Array.isArray(state.messages)||!Array.isArray(state.workTasks))return false;
 return ![...state.messages,...state.workTasks].some(entry=>!entry||typeof entry!=='object'||entry.unknownOutcome===true||['unknown','submitting'].includes(entry.submission)||['unknown','running','queued','accepted','pausing','continuing'].includes(entry.status)||entry.status==='waiting_user'&&!(typeof entry.executionEndedAt==='number'&&Number.isFinite(entry.executionEndedAt)&&entry.executionEndedAt>0)||entry.continuation?.invalid||entry.continuation?.dispatch);
}

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
 changed(){if(!this.enabled||this.closed)return;if(this.scope!==this.identity()){this.reset();return;}if(this.pending||this.driving)return;const update=this.bridge.serviceUpdate;if(this.bridge.status!=='online')this.schedule(5000);else if(update&&update.status!=='current')this.schedule(update.status==='pending'?1000:30000);}
 async run(){
  if(!this.enabled||this.closed)return;if(this.pending)return this.pending;
  if(this.scope!==this.identity()){this.epoch++;this.scope=this.identity();this.checked=false;this.attempt=0;}
  const epoch=this.epoch,scope=this.scope,current=()=>!this.closed&&this.enabled&&epoch===this.epoch&&scope===this.identity();
  this.driving=true;const pending=(async()=>{
   if(!this.allowed()){this.schedule(5000);return;}
   const update=this.bridge.serviceUpdate,uncertain=update?.reason==='update-unconfirmed';
   try{
    if(this.bridge.status==='online'){
     if(update?.status==='current'){this.checked=true;this.attempt=0;return;}
     if(update?.reason==='version-unconfirmed'&&this.bridge.sourceVerified){await this.bridge.confirmServiceVersion?.();return;}
     if(uncertain){await this.bridge.reconcileServiceUpdate?.();return;}
     if(update?.status==='failed'&&!['connection-unavailable','version-unconfirmed'].includes(update.reason))return;
     const generation=this.bridge.generation,state=await this.bridge.refresh(true);if(!current()||generation!==this.bridge.generation||!serviceUpdateIdle(state))return;
    }
    if(!current())return;
    await this.connect({deploy:!this.checked&&!uncertain,automatic:true});
    if(!current())return;
    if(this.bridge.serviceUpdate?.status==='current'||!this.bridge.serviceUpdate){this.checked=true;this.attempt=0;}
    else if(uncertain)await this.bridge.reconcileServiceUpdate?.();
   }catch{if(current())this.attempt=Math.min(this.attempt+1,4);}
  })().finally(()=>{
   if(this.pending===pending)this.pending=null;this.driving=false;
   if(!current()){if(!this.closed&&this.enabled)this.schedule(0);return;}
   const update=this.bridge.serviceUpdate;
   if(this.bridge.status!=='online')this.schedule(Math.min(60000,5000*2**Math.max(0,this.attempt-1)));
   else if(update&&update.status!=='current')this.schedule(30000);
  });this.pending=pending;return pending;
 }
 close(){this.closed=true;this.enabled=false;this.epoch++;this.clearTimer(this.timer);this.timer=null;}
}
