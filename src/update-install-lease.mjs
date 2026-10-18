import {randomUUID} from 'node:crypto';

const blocked=()=>Object.assign(Error('Installation is deferred. Finish the call, computer control or setup, then try again.'),{status:409});
export function installStateSafe(state){
 return state?.mode==='vm-controller'&&state.controller?.status==='online'&&state.controller.cached===false&&state.controller.authority==='vm'&&state.call===null&&state.takeover===false&&!state.acquiring&&state.computer?.status==='dant'&&!state.computer.sessionId&&!state.computer.pending&&state.provisioning?.running===false&&['idle','ready','failed'].includes(state.provisioning.status);
}
export function updateSensitiveRequest(req){
 const route=decodeURIComponent(new URL(req.originalUrl||req.path,'http://localhost').pathname).toLowerCase().replace(/\/+$/,'');
 if(req.method==='POST')return ['/api/call','/api/takeover','/api/provision','/api/connect','/api/prepare','/api/vm/import'].includes(route);
 return req.method==='PATCH'&&route==='/api/settings'&&req.body?.vm!==undefined;
}

// Controller-local admission fence only. It never pauses a VM task or queue.
export class UpdateInstallLease{
 constructor({snapshot,refresh,now=Date.now,ttlMs=30000,id=randomUUID}={}){this.snapshot=snapshot;this.refresh=refresh;this.now=now;this.ttlMs=ttlMs;this.id=id;this.pending=0;this.checking=false;this.lease=null;this.uncertain=false;this.closed=false;}
 current(){if(this.lease&&this.lease.expiresAt<=this.now())this.lease=null;return this.lease;}
 enter(){
  if(this.closed||this.checking||this.current())throw blocked();this.pending++;let finished=false;
  return error=>{if(finished)return;finished=true;this.pending--;if(error?.unknownOutcome)this.uncertain=true;};
 }
 async acquire(){
  if(this.closed||this.checking||this.current()||this.pending||this.uncertain)throw blocked();this.checking=true;
  try{await this.refresh();if(this.closed||this.pending||this.uncertain||!installStateSafe(this.snapshot()))throw blocked();this.lease={leaseId:this.id(),expiresAt:this.now()+this.ttlMs};return {...this.lease};}
  catch{throw blocked();}finally{this.checking=false;}
 }
 release(id){const lease=this.current();if(!lease||lease.leaseId!==id)throw blocked();this.lease=null;return {released:true};}
 close(){this.closed=true;this.lease=null;}
}

export function installLeaseRoutes(app,lease){
 app.post('/api/updates/install-lease',async(req,res)=>{if(!req.body||Array.isArray(req.body)||typeof req.body!=='object'||Object.keys(req.body).length)return res.status(400).json({error:'An empty update installation request is required.'});res.setHeader('Cache-Control','no-store');res.json(await lease.acquire());});
 app.delete('/api/updates/install-lease/:id',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(lease.release(req.params.id));});
}
