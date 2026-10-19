import {randomUUID} from 'node:crypto';
import {serviceUpdatePaused} from './vm-service-update.mjs';

const blocked=()=>Object.assign(Error('Installation is deferred. Finish the call, computer control or setup, then try again.'),{status:409});
export function installStateSafe(state){
 if(state?.mode!=='vm-controller'||state.controller?.authority!=='vm'||state.provisioning?.running!==false||!['idle','ready','failed'].includes(state.provisioning.status))return false;
 if(state.controller.vmConfigured===false)return state.active===null&&state.call===null&&Array.isArray(state.queue)&&state.queue.length===0&&state.takeover===false&&!state.acquiring;
 return state.controller.status==='online'&&state.controller.cached===false&&serviceUpdatePaused(state);
}
export function updateSensitiveRequest(req){
 const route=decodeURIComponent(new URL(req.originalUrl||req.path,'http://localhost').pathname).toLowerCase().replace(/\/+$/,'');
 if(!['POST','PATCH','DELETE'].includes(req.method))return false;
 return route.startsWith('/api/')&&!/^\/api\/(?:desktop\/|updates(?:\/|$))/.test(route);
}

// The Controller supplies a pause-and-confirm refresh before reserving a lease.
// This fence prevents new work from entering between that pause and the installer.
export class UpdateInstallLease{
 constructor({snapshot,refresh,onFailure=()=>{},onRelease=()=>{},now=Date.now,ttlMs=30000,id=randomUUID}={}){Object.assign(this,{snapshot,refresh,onFailure,onRelease});this.now=now;this.ttlMs=ttlMs;this.id=id;this.pending=0;this.checking=false;this.lease=null;this.uncertain=false;this.closed=false;}
 current(){if(this.lease&&this.lease.expiresAt<=this.now()){this.lease=null;clearTimeout(this.timer);this.onRelease();}return this.lease;}
 arm(){clearTimeout(this.timer);if(this.lease){this.timer=setTimeout(()=>this.current(),Math.max(1,this.lease.expiresAt-this.now()));this.timer.unref?.();}}
 assertQuiescent(allowPending=0){if(this.closed||this.checking||this.current()||this.pending>allowPending||this.uncertain)throw blocked();}
 enter(){
  if(this.closed||this.checking||this.current())throw blocked();this.pending++;let finished=false;
  return error=>{if(finished)return;finished=true;this.pending--;if(error?.unknownOutcome)this.uncertain=true;};
 }
 async acquire(){
  if(this.closed||this.checking||this.current()||this.pending||this.uncertain)throw blocked();this.checking=true;
  try{await this.refresh();if(this.closed||this.pending||this.uncertain||!installStateSafe(this.snapshot()))throw blocked();this.lease={leaseId:this.id(),expiresAt:this.now()+this.ttlMs};this.arm();return {...this.lease};}
  catch{this.onFailure();throw blocked();}finally{this.checking=false;}
 }
 pin(id){const lease=this.current();if(!lease||lease.leaseId!==id)throw blocked();this.lease={...lease,expiresAt:this.now()+150000};this.arm();return {...this.lease};}
 renew(id){const lease=this.current();if(!lease||lease.leaseId!==id)throw blocked();this.lease={leaseId:id,expiresAt:this.now()+this.ttlMs};this.arm();return {...this.lease};}
 release(id){const lease=this.current();if(!lease||lease.leaseId!==id)throw blocked();this.lease=null;clearTimeout(this.timer);this.onRelease();return {released:true};}
 close(){this.closed=true;this.lease=null;clearTimeout(this.timer);}
}

export function installLeaseRoutes(app,lease){
 app.post('/api/updates/install-lease',async(req,res)=>{if(!req.body||Array.isArray(req.body)||typeof req.body!=='object'||Object.keys(req.body).length)return res.status(400).json({error:'An empty update installation request is required.'});res.setHeader('Cache-Control','no-store');res.json(await lease.acquire());});
 app.delete('/api/updates/install-lease/:id',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(lease.release(req.params.id));});
}
