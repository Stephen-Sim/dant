import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import {sshArgs} from './worker.mjs';
import {readVmBinding} from './vm-profiles.mjs';
import {serviceVersion} from './diagnostic-events.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const sourceAllowlist=['src','dist','LICENSE','package.json','package-lock.json','vm/install-worker.sh','vm/install-speech.sh','vm/install-transcription.sh','vm/transcription-requirements.txt','vm/migrate-state.mjs','vm/start-codex.sh','vm/guest.py','vm/desktop.py','vm/control.py','vm/voice_message.py','vm/transcribe_audio.py','vm/desktop_mcp.py'];
const bindingIdentity=vm=>JSON.stringify([vm.host,vm.user,vm.port,vm.keyPath,vm.knownHosts]);
const versionPattern=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// File names and bytes, rather than tar mtimes, identify deployable source.
export function vmSourceFingerprint(root){
 const files=[];let total=0;
 const walk=name=>{const file=path.join(root,name),stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat)throw Error(`Build resources are missing: ${name}`);if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw Error('VM build resources must be ordinary files.');if(stat.isDirectory()){for(const child of fs.readdirSync(file).sort())walk(name+'/'+child);}else{total+=stat.size;if(files.length>=20000||total>512*1024*1024)throw Error('VM build resources exceed the supported size.');files.push(name);}};
 for(const name of sourceAllowlist)walk(name);
 const hash=createHash('sha256');for(const name of files.sort()){const bytes=fs.readFileSync(path.join(root,name));hash.update(JSON.stringify([name,bytes.length])+'\n');hash.update(bytes);hash.update('\n');}return hash.digest('hex');
}

export class VmBridge extends EventEmitter {
 constructor({dataDir,projectRoot,spawnProcess=spawn,fetchImpl=fetch,WebSocketImpl=WebSocket,cacheMs=2000}={}){
  super();this.dataDir=dataDir;this.projectRoot=projectRoot;this.spawnProcess=spawnProcess;this.fetchImpl=fetchImpl;this.WebSocketImpl=WebSocketImpl;this.cacheMs=cacheMs;this.status='offline';this.error=null;this.closed=false;this.generation=0;
  this.serviceUpdate={status:'checking',targetVersion:serviceVersion(projectRoot),runningVersion:null,confirmed:false,reason:'not-configured'};
 }
 binding(){return readVmBinding(this.dataDir);}
 updateService(patch,phase='prepare'){this.serviceUpdate={...this.serviceUpdate,...patch};this.emit('diagnostic',{event:'vm.service-update',fields:{status:this.serviceUpdate.status,phase,reason:this.serviceUpdate.reason,targetVersion:this.serviceUpdate.targetVersion,runningVersion:this.serviceUpdate.runningVersion}});this.emit('change');}
 async confirmServiceVersion(generation=this.generation){
  try{const response=await this.request('/api/version');if(!response.ok)throw Error();const value=await response.json();if(this.closed||generation!==this.generation||this.status!=='online')return;
   if(typeof value.version!=='string'||!versionPattern.test(value.version))throw Error();
   const patch={runningVersion:value.version,confirmed:true};
   if(this.sourceVerified&&(this.serviceUpdate.status!=='pending'||this.serviceUpdate.reason==='version-unconfirmed')&&this.serviceUpdate.reason!=='update-unconfirmed')Object.assign(patch,value.version===this.serviceUpdate.targetVersion?{status:'current',reason:'source-current'}:{status:'failed',reason:'version-mismatch'});
   this.updateService(patch,'verify');
  }catch{if(!this.closed&&generation===this.generation&&this.status==='online')this.updateService({confirmed:false,...(!['pending','failed'].includes(this.serviceUpdate.status)?{status:'pending',reason:'version-unconfirmed'}:{})},'verify');}
 }
 async connect({deploy=true,updateRunningWork=false,autoUpdate=false}={}){
  if(this.closed)throw Error('VM bridge is closed');
  updateRunningWork=updateRunningWork===true;
  if(this.connecting){
   if(!updateRunningWork||this.connectingUpdatesWork)return this.connecting;
   if(this.manualConnectionPending)return this.manualConnectionPending;
   const generation=this.generation;
   const pending=this.connecting.catch(()=>{}).then(()=>{if(this.closed||generation!==this.generation)throw Error('VM connection cancelled');return this.connect({deploy,updateRunningWork:true});}).finally(()=>{if(this.manualConnectionPending===pending)this.manualConnectionPending=null;});
   this.manualConnectionPending=pending;return pending;
  }
  this.connectingUpdatesWork=updateRunningWork;
  const pending=this.open(deploy,{updateRunningWork,autoUpdate}).finally(()=>{if(this.connecting===pending){this.connecting=null;this.connectingUpdatesWork=false;}});this.connecting=pending;return pending;
 }
 async open(deploy,{updateRunningWork=false,autoUpdate=false}={}){
  const reconnectDesired=this.reconnectDesired;this.disconnect();this.reconnectDesired=reconnectDesired;const generation=this.generation;this.status='connecting';this.error=null;this.emit('change');
  try{
   const vm=this.binding(),identity=bindingIdentity(vm);if(this.serviceBinding!==identity){this.serviceBinding=identity;this.sourceVerified=false;this.updateService({status:'checking',runningVersion:null,confirmed:false,reason:null});}
   if(deploy)try{this.sourceVerified=false;this.updateService({status:'checking',confirmed:false,reason:null});await this.prepare(vm,{updateRunningWork});this.sourceVerified=true;}catch(error){
    if(this.closed||generation!==this.generation||identity!==bindingIdentity(this.binding())||error.cancelled)throw Error('VM connection cancelled');
    const reason=error.updateDeferred?(error.updateReason||'work-active'):error.unknownOutcome?'update-unconfirmed':error.updateRetryable?'connection-unavailable':'update-failed';
    this.updateService({status:error.updateDeferred?'pending':'failed',reason,confirmed:false});
    if(error.updateGuardReason)this.emit('diagnostic',{event:'vm.service-update',fields:{status:this.serviceUpdate.status,phase:'prepare',reason:error.updateGuardReason,stage:error.updateStage,targetVersion:this.serviceUpdate.targetVersion,exitCode:error.exitCode,unknownOutcome:error.unknownOutcome===true}});
    if(updateRunningWork||!error.updateDeferred&&!autoUpdate)throw error;
    if(!autoUpdate)this.emit('event',{type:'notice',data:{message:'The VM is still working. Its service update was deferred until work has stopped.'}});
   }if(this.closed||generation!==this.generation||identity!==bindingIdentity(this.binding()))throw Error('VM connection cancelled');
   this.port=await freePort();if(this.closed||generation!==this.generation)throw Error('VM connection cancelled');const child=this.spawnProcess('ssh',[...sshArgs(vm),'-N','-L',`127.0.0.1:${this.port}:127.0.0.1:4317`,'-o','ExitOnForwardFailure=yes',`${vm.user}@${vm.host}`],{shell:false,windowsHide:true,stdio:['ignore','ignore','pipe']});this.child=child;
   child.stderr?.on('data',()=>{});child.once('error',()=>this.failed(generation,'Could not start the SSH connection.'));child.once('close',()=>this.failed(generation,'The VM connection was lost. Cached conversation remains available.'));
   let session;const deadline=Date.now()+30000;
   while(Date.now()<deadline){
    if(this.closed||generation!==this.generation||this.status==='offline')throw Error(this.error||'VM connection cancelled');
    try{const response=await this.fetchImpl(`http://127.0.0.1:${this.port}/api/session`,{signal:AbortSignal.timeout(2000)});if(response.ok){session=await response.json();break;}}catch{}
    await delay(300);
   }
   if(this.closed||generation!==this.generation||this.status==='offline')throw Error(this.error||'VM connection cancelled');
   if(!session?.token)throw Error('The VM service did not become ready. Its files and work have been preserved.');
   this.token=session.token;this.status='online';this.error=null;this.reconnectDesired=true;await this.refresh(true);if(this.closed||generation!==this.generation||this.status!=='online')throw Error(this.error||'VM connection cancelled');await this.confirmServiceVersion(generation);if(this.closed||generation!==this.generation||this.status!=='online')throw Error('VM connection cancelled');this.openEvents(generation);this.emit('change');return this.cached;
  }catch(error){this.failed(generation,error.message);throw error;}
 }
 failed(generation,message){if(generation!==this.generation||this.closed||(this.status==='offline'&&!this.child&&this.error))return;this.status='offline';this.error=message;this.token=null;this.serviceUpdate={...this.serviceUpdate,confirmed:false};this.child?.kill();this.child=null;this.ws?.terminate?.();this.ws=null;this.emit('change');if(this.reconnectDesired&&!this.reconnectManaged){clearTimeout(this.reconnectTimer);this.reconnectTimer=setTimeout(()=>void this.connect({deploy:false}).catch(()=>{}),5000);this.reconnectTimer.unref();}}
 openEvents(generation){
  const ws=new this.WebSocketImpl(`ws://127.0.0.1:${this.port}/events?token=${encodeURIComponent(this.token)}`);this.ws=ws;
  ws.on('message',data=>{if(generation!==this.generation)return;try{const event=JSON.parse(data.toString());if(event.type==='state'){this.cached=event.data;this.cachedAt=Date.now();this.error=null;this.emit('state',this.cached);}else this.emit('event',event);}catch{}});
  ws.on('error',()=>{});ws.on('close',()=>{if(generation===this.generation&&!this.closed&&this.status==='online')this.failed(generation,'The VM event connection was lost. Cached conversation remains available.');});
 }
 async refresh(force=false){
  if(!force&&this.cached&&Date.now()-this.cachedAt<this.cacheMs)return this.cached;
  if(this.refreshing)return this.refreshing;
  const generation=this.generation,current=()=>{if(this.closed||generation!==this.generation||this.status!=='online')throw Error('VM state refresh cancelled');};
  const pending=(async()=>{const response=await this.request('/api/state');current();if(!response.ok)throw Error(`VM state unavailable (${response.status})`);const state=await response.json();current();this.cached=state;this.cachedAt=Date.now();this.error=null;this.emit('state',state);return state;})().finally(()=>{if(this.refreshing===pending)this.refreshing=null;});this.refreshing=pending;return pending;
 }
 async request(route,options={}){
  if(this.status!=='online'||!this.token)throw Object.assign(Error('The VM is offline. Reconnect before sending work.'),{status:503});
  if(!route.startsWith('/api/')||route.startsWith('//')||route.includes('://'))throw Error('Invalid VM API route');
  const method=options.method||'GET';
  try{return await this.fetchImpl(`http://127.0.0.1:${this.port}${route}`,{...options,method,headers:{...options.headers,'X-Dant-Token':this.token},signal:options.signal||AbortSignal.timeout(60000)});}
  catch{throw Object.assign(Error(method==='GET'?'The VM request failed. Cached conversation remains available.':'The VM connection ended before the result was confirmed. This action was not resent; reconnect and check its state before retrying.'),{status:502,unknownOutcome:method!=='GET'});}
 }
 async prepare(vm=this.binding(),{updateRunningWork=false}={}){
  if(this.closed)throw Error('VM bridge is closed');
  updateRunningWork=updateRunningWork===true;
  if(this.preparing){
   if(this.preparingScope&&(this.preparingScope.generation!==this.generation||this.preparingScope.binding!==bindingIdentity(vm)))throw Object.assign(Error('VM preparation cancelled because its connection changed'),{cancelled:true});
   if(!updateRunningWork||this.preparingUpdatesWork)return this.preparing;
   if(this.manualPreparationPending)return this.manualPreparationPending;
   const generation=this.generation,identity=value=>JSON.stringify([value.host,value.user,value.port,value.keyPath,value.knownHosts]),binding=identity(vm);
   const task=this.preparing.catch(()=>{}).then(()=>{if(this.closed||generation!==this.generation||identity(this.binding())!==binding)throw Error('VM preparation cancelled because its connection changed');return this.prepare(vm,{updateRunningWork:true});}).finally(()=>{if(this.manualPreparationPending===task)this.manualPreparationPending=null;});
   this.manualPreparationPending=task;return task;
  }
  this.preparingUpdatesWork=updateRunningWork;
  this.preparingScope={generation:this.generation,binding:bindingIdentity(vm)};
  const task=this.deploy(vm,{updateRunningWork}).finally(()=>{if(this.preparing===task){this.preparing=null;this.preparingScope=null;this.preparingUpdatesWork=false;}});this.preparing=task;return task;
 }
 run(command,args,{input,timeoutMs=10*60*1000}={}){
  return new Promise((resolve,reject)=>{let output='',settled=false;const child=this.spawnProcess(command,args,{cwd:this.projectRoot,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});const timer=setTimeout(()=>{child.kill();finish(Error('VM preparation timed out. Existing VM files have been preserved.'));},timeoutMs);
   const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);this.preparationChildren?.delete(child);error?reject(error):resolve(output);};
   this.preparationChildren??=new Set();this.preparationChildren.add(child);child.once('error',()=>finish(Error('Could not start VM preparation.')));child.once('close',code=>{
    const marker=[...output.matchAll(/DANT_UPDATE_(?:FAILED|DEFERRED):([a-z-]{1,64}):([a-z-]{1,32})(?:\s|$)/g)].at(-1);
    finish(code===0?null:Object.assign(Error(`VM preparation failed (${code}).`),{updateDeferred:output.includes('DANT_WORK_ACTIVE')&&[75,79].includes(code)&&marker?.[2]!=='rollback',updateReason:output.includes('DANT_UPDATE_DEFERRED:executor-offline:')?'executor-offline':'work-active',...(marker?{updateGuardReason:marker[1],updateStage:marker[2]}:{}),exitCode:code}));
   });child.stdout?.on('data',data=>{output=(output+data.toString()).slice(-6000);});child.stderr?.on('data',data=>{output=(output+data.toString()).slice(-6000);});child.stdin?.on('error',()=>{});
   if(input)fs.createReadStream(input).on('error',error=>{child.kill();finish(error);}).pipe(child.stdin);else child.stdin?.end();
  });
 }
 async deployedSource(vm=this.binding()){
  const command="python3 - <<'PY'\nimport json,pathlib,subprocess\np=pathlib.Path.home()/'dant/deployed-source.json'\nsha=None\ntry:\n data=p.read_bytes()\n if len(data)<=4096:\n  value=json.loads(data).get('sha256')\n  if isinstance(value,str) and len(value)==64 and all(c in '0123456789abcdef' for c in value): sha=value\nexcept (OSError,ValueError,AttributeError): pass\nactive=subprocess.run(['systemctl','--user','is-active','--quiet','dant-worker.service','dant-guest-local.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0\nprint(json.dumps({'sha256':sha,'active':active}))\nPY";
  let output;try{output=await this.run('ssh',[...sshArgs(vm),`${vm.user}@${vm.host}`,command],{timeoutMs:15000});}catch{throw Object.assign(Error('The work computer is unavailable. It will reconnect automatically.'),{updateRetryable:true});}
  try{const value=JSON.parse(output);if(value?.sha256!==null&&(typeof value?.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))||typeof value?.active!=='boolean')throw Error();return value;}catch{throw Object.assign(Error('The work computer deployment could not be verified.'),{updateRetryable:true});}
 }
 updateAttempts(vm,fingerprint,action='read'){
  const file=path.join(this.dataDir,'vm-update-attempts.json'),key=createHash('sha256').update(bindingIdentity(vm)).digest('hex');let entries=[];
  try{const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)throw Error();const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.schemaVersion!==1||!Array.isArray(value.entries)||value.entries.length>64||value.entries.some(entry=>!entry||!/^[a-f0-9]{64}$/.test(entry.binding)||!/^[a-f0-9]{64}$/.test(entry.source)))throw Error();entries=value.entries;}}
  catch{throw Object.assign(Error('A previous work computer update is unconfirmed.'),{unknownOutcome:true});}
  if(action==='read')return entries.some(entry=>entry.binding===key);
  if(action==='has-source')return entries.some(entry=>entry.binding===key&&entry.source===fingerprint);
  const next=entries.filter(entry=>entry.binding!==key||action!=='start-explicit'&&entry.source!==fingerprint);if(action==='start'||action==='start-explicit'){if(next.length>=64)throw Object.assign(Error('Previous work computer updates must be verified before continuing.'),{unknownOutcome:true});next.push({binding:key,source:fingerprint});}
  const temporary=path.join(this.dataDir,`.vm-update-${randomUUID()}.tmp`);try{fs.writeFileSync(temporary,JSON.stringify({schemaVersion:1,entries:next}),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}return false;
 }
 async reconcileServiceUpdate(){
  const generation=this.generation,vm=this.binding(),identity=bindingIdentity(vm);
  const current=()=>!this.closed&&generation===this.generation&&identity===bindingIdentity(this.binding());
  const remote=await this.deployedSource(vm);if(!current())return;
  if(remote.active&&remote.sha256&&this.updateAttempts(vm,remote.sha256,'has-source'))this.updateAttempts(vm,remote.sha256,'clear');
  if(remote.active&&this.desiredSource&&remote.sha256===this.desiredSource&&!this.updateAttempts(vm,this.desiredSource)){this.sourceVerified=true;this.updateService({status:'checking',reason:null},'verify');if(this.status==='online')await this.confirmServiceVersion(generation);}
  else if(!this.updateAttempts(vm,this.desiredSource)&&this.serviceUpdate.reason==='update-unconfirmed')this.updateService({status:'pending',reason:null},'verify');
 }
 async deploy(vm,{updateRunningWork=false}={}){
  fs.mkdirSync(this.dataDir,{recursive:true});const temporary=fs.mkdtempSync(path.join(this.dataDir,'deploy-'));const archive=path.join(temporary,'source.tar');
  try{
   const generation=this.generation,identity=bindingIdentity(vm),current=()=>{if(this.closed||generation!==this.generation||identity!==bindingIdentity(this.binding()))throw Object.assign(Error('VM preparation cancelled because its connection changed'),{cancelled:true});};
   current();const fingerprint=vmSourceFingerprint(this.projectRoot);this.desiredSource=fingerprint;
   const remote=await this.deployedSource(vm);current();
   if(remote.active&&remote.sha256&&this.updateAttempts(vm,remote.sha256,'has-source'))this.updateAttempts(vm,remote.sha256,'clear');
   if(!updateRunningWork&&this.updateAttempts(vm,fingerprint))throw Object.assign(Error('A previous work computer update is unconfirmed.'),{unknownOutcome:true});
   if(remote.sha256===fingerprint&&remote.active)return {fingerprint,current:true};
   const tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:/Windows','System32/tar.exe'):'tar';
   await this.run(tar,['-cf',archive,'-C',this.projectRoot,...sourceAllowlist]);current();
   if(vmSourceFingerprint(this.projectRoot)!==fingerprint)throw Object.assign(Error('VM build resources changed during preparation.'),{cancelled:true});
   fs.writeFileSync(path.join(temporary,'deploy-manifest.json'),JSON.stringify({schemaVersion:2,sha256:fingerprint}));
   await this.run(tar,['-rf',archive,'-C',temporary,'deploy-manifest.json']);
   current();
   const stateFile=path.join(this.dataDir,'state.json'),receipt=path.join(this.dataDir,'vm-migration.json');
   let migration;
   if(fs.existsSync(stateFile)&&!fs.existsSync(receipt)){
    const raw=fs.readFileSync(stateFile),state=JSON.parse(raw.toString('utf8'));migration={id:createHash('sha256').update(raw).digest('hex'),messages:state.messages?.length||0,createdAt:new Date().toISOString()};
    const backup=path.join(this.dataDir,'migration-backups',`${Date.now()}-${randomUUID()}`);fs.mkdirSync(backup,{recursive:true});fs.copyFileSync(stateFile,path.join(backup,'state.json'));if(fs.existsSync(path.join(this.dataDir,'files')))fs.cpSync(path.join(this.dataDir,'files'),path.join(backup,'files'),{recursive:true});
    const migrationDir=path.join(temporary,'migration');fs.mkdirSync(migrationDir);state.settings??={};state.settings.vm={host:'',user:'dant',port:22,keyPath:'',knownHosts:''};fs.writeFileSync(path.join(migrationDir,'state.json'),JSON.stringify(state));fs.writeFileSync(path.join(migrationDir,'manifest.json'),JSON.stringify(migration));
    if(fs.existsSync(path.join(this.dataDir,'files')))fs.cpSync(path.join(this.dataDir,'files'),path.join(migrationDir,'files'),{recursive:true});
    await this.run(tar,['-rf',archive,'-C',temporary,'migration']);
   }
   // No keys, CODEX_HOME, node_modules, Windows runtime, or personal caches enter the archive.
   const command='umask 077; set -e; mkdir -p "$HOME/dant/releases"; stage=$(mktemp -d "$HOME/dant/releases/source.XXXXXX"); tar -xf - -C "$stage"; bash "$stage/vm/install-worker.sh" "$stage"'+(updateRunningWork===true?' --update-running-work':'');
   current();this.updateAttempts(vm,fingerprint,updateRunningWork?'start-explicit':'start');this.updateService({status:'updating',confirmed:false,reason:null},'activate');
   try{await this.run('ssh',[...sshArgs(vm),`${vm.user}@${vm.host}`,command],{input:archive});}catch(error){if(error.updateDeferred)this.updateAttempts(vm,fingerprint,'clear');else error.unknownOutcome=true;throw error;}
   current();let confirmed;try{confirmed=await this.deployedSource(vm);}catch{throw Object.assign(Error('The work computer update was not confirmed.'),{unknownOutcome:true});}current();if(!confirmed.active||confirmed.sha256!==fingerprint)throw Object.assign(Error('The work computer update was not confirmed.'),{unknownOutcome:true});
   this.updateAttempts(vm,fingerprint,'clear');if(migration)fs.writeFileSync(receipt,JSON.stringify({...migration,host:vm.host,completedAt:new Date().toISOString()},null,2));return {fingerprint,current:false};
  }finally{const relative=path.relative(this.dataDir,temporary);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(temporary).startsWith('deploy-'))fs.rmSync(temporary,{recursive:true,force:true});}
 }
 disconnect(){this.generation++;this.connecting=null;this.refreshing=null;this.reconnectDesired=false;clearTimeout(this.reconnectTimer);this.token=null;this.serviceUpdate={...this.serviceUpdate,confirmed:false};this.ws?.terminate?.();this.ws=null;this.child?.kill();this.child=null;this.status='offline';this.emit('change');}
 close(){this.closed=true;this.disconnect();for(const child of this.preparationChildren||[])child.kill();this.removeAllListeners();}
}
