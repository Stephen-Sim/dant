import {DesktopPhase, ConnectionStatus} from './contracts/states.mjs';
import {serviceUpdatePaused} from './vm-service-update.mjs';
const failure=()=>Object.assign(Error('The work computer transition is still in progress.'),{status:409,code:'desktop_transition_busy'});

// Coordinates explicit UI/native requests. A normal window close never enters
// this transaction, and a service shutdown never implicitly powers off a VM.
export class DesktopLifecycle{
 constructor({bridge,lifecycle,binding,onChange=()=>{}}={}){Object.assign(this,{bridge,lifecycle,binding,onChange});this.phase=DesktopPhase.Idle;this.pending=null;this.closed=false;}
 get blocked(){return this.phase!==DesktopPhase.Idle;}
 state(phase){this.phase=phase;this.onChange();}
 identity(){return JSON.stringify(this.binding());}
 run(operation){if(this.closed||this.pending)throw failure();const identity=this.identity(),current=()=>{if(this.closed||this.identity()!==identity)throw failure();};
  const pending=Promise.resolve().then(()=>operation(current)).catch(error=>{this.state(DesktopPhase.Idle);throw error;}).finally(()=>{if(this.pending===pending)this.pending=null;});this.pending=pending;return pending;
 }
 async pause(current,reason='install'){
  if(this.phase===DesktopPhase.Paused&&this.binding().host){const state=await this.bridge.refresh(true);current();if(!serviceUpdatePaused(state))throw failure();return;}
  this.state(DesktopPhase.Pausing);current();if(!this.binding().host){this.state(DesktopPhase.Paused);return;}
  if(this.bridge.status!==ConnectionStatus.Online)await this.bridge.connect({deploy:false});current();
  if([ConnectionStatus.Offline,ConnectionStatus.Connecting].includes(this.bridge.cached?.worker?.status)){const state=await this.bridge.refresh(true);current();if(!serviceUpdatePaused(state))throw Object.assign(Error('Stop active work and return computer control before reconnecting the executor.'),{status:409});this.state(DesktopPhase.Paused);return;}
  await this.bridge.pauseWorkForUpdate({reason});current();this.state(DesktopPhase.Paused);
 }
 prepare(){return this.run(async current=>{if(this.binding().host&&this.bridge.status!==ConnectionStatus.Online){this.state(DesktopPhase.Resuming);await this.lifecycle.resume();current();}await this.pause(current);return {ok:true,workPaused:true};});}
 exit(){return this.run(async current=>{
  await this.pause(current,'exit');this.state(DesktopPhase.Suspending);const result=await this.lifecycle.suspend();current();
  this.state(result.vmSuspended?DesktopPhase.Suspended:DesktopPhase.Paused);if(result.vmSuspended)this.bridge.disconnect();
  return {ok:true,workPaused:true,vmSuspended:result.vmSuspended===true,...(!result.supported?{unsupported:true}:{}),...(!this.binding().host?{notConfigured:true}:{})};
 });}
 cancel(){return this.run(async current=>{
  this.state(DesktopPhase.Resuming);await this.lifecycle.resume();current();
  if(this.binding().host&&this.bridge.status!==ConnectionStatus.Online)await this.bridge.connect({deploy:false});current();
  this.state(DesktopPhase.Idle);return {ok:true};
 });}
 close(){this.closed=true;}
}
