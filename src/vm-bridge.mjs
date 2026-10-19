import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import {sshArgs} from './worker.mjs';
import {readVmBinding} from './vm-profiles.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});

export class VmBridge extends EventEmitter {
 constructor({dataDir,projectRoot,spawnProcess=spawn,fetchImpl=fetch,WebSocketImpl=WebSocket,cacheMs=2000}={}){
  super();this.dataDir=dataDir;this.projectRoot=projectRoot;this.spawnProcess=spawnProcess;this.fetchImpl=fetchImpl;this.WebSocketImpl=WebSocketImpl;this.cacheMs=cacheMs;this.status='offline';this.error=null;this.closed=false;this.generation=0;
 }
 binding(){return readVmBinding(this.dataDir);}
 async connect({deploy=true,updateRunningWork=false}={}){
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
  const pending=this.open(deploy,{updateRunningWork}).finally(()=>{if(this.connecting===pending){this.connecting=null;this.connectingUpdatesWork=false;}});this.connecting=pending;return pending;
 }
 async open(deploy,{updateRunningWork=false}={}){
  const reconnectDesired=this.reconnectDesired;this.disconnect();this.reconnectDesired=reconnectDesired;const generation=this.generation;this.status='connecting';this.error=null;this.emit('change');
  try{
   const vm=this.binding();if(deploy)try{await this.prepare(vm,{updateRunningWork});}catch(error){if(!error.updateDeferred||updateRunningWork)throw error;this.emit('event',{type:'notice',data:{message:'The VM is still working. Its service update was deferred until work has stopped.'}});}if(this.closed||generation!==this.generation)throw Error('VM connection cancelled');
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
   this.token=session.token;this.status='online';this.error=null;this.reconnectDesired=true;await this.refresh(true);if(this.closed||generation!==this.generation||this.status!=='online')throw Error(this.error||'VM connection cancelled');this.openEvents(generation);this.emit('change');return this.cached;
  }catch(error){this.failed(generation,error.message);throw error;}
 }
 failed(generation,message){if(generation!==this.generation||this.closed||(this.status==='offline'&&!this.child&&this.error))return;this.status='offline';this.error=message;this.token=null;this.child?.kill();this.child=null;this.ws?.terminate?.();this.ws=null;this.emit('change');if(this.reconnectDesired){clearTimeout(this.reconnectTimer);this.reconnectTimer=setTimeout(()=>void this.connect({deploy:false}).catch(()=>{}),5000);this.reconnectTimer.unref();}}
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
   if(!updateRunningWork||this.preparingUpdatesWork)return this.preparing;
   if(this.manualPreparationPending)return this.manualPreparationPending;
   const generation=this.generation,identity=value=>JSON.stringify([value.host,value.user,value.port,value.keyPath,value.knownHosts]),binding=identity(vm);
   const task=this.preparing.catch(()=>{}).then(()=>{if(this.closed||generation!==this.generation||identity(this.binding())!==binding)throw Error('VM preparation cancelled because its connection changed');return this.prepare(vm,{updateRunningWork:true});}).finally(()=>{if(this.manualPreparationPending===task)this.manualPreparationPending=null;});
   this.manualPreparationPending=task;return task;
  }
  this.preparingUpdatesWork=updateRunningWork;
  const task=this.deploy(vm,{updateRunningWork}).finally(()=>{if(this.preparing===task){this.preparing=null;this.preparingUpdatesWork=false;}});this.preparing=task;return task;
 }
 run(command,args,{input,timeoutMs=10*60*1000}={}){
  return new Promise((resolve,reject)=>{let output='',settled=false;const child=this.spawnProcess(command,args,{cwd:this.projectRoot,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});const timer=setTimeout(()=>{child.kill();finish(Error('VM preparation timed out. Existing VM files have been preserved.'));},timeoutMs);
   const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);this.preparationChildren?.delete(child);error?reject(error):resolve(output);};
   this.preparationChildren??=new Set();this.preparationChildren.add(child);child.once('error',()=>finish(Error('Could not start VM preparation.')));child.once('close',code=>finish(code===0?null:Object.assign(Error(`VM preparation failed (${code}). ${output.slice(-1200)}`),{updateDeferred:output.includes('DANT_WORK_ACTIVE')})));child.stdout?.on('data',data=>{output=(output+data.toString()).slice(-6000);});child.stderr?.on('data',data=>{output=(output+data.toString()).slice(-6000);});child.stdin?.on('error',()=>{});
   if(input)fs.createReadStream(input).on('error',error=>{child.kill();finish(error);}).pipe(child.stdin);else child.stdin?.end();
  });
 }
 async deploy(vm,{updateRunningWork=false}={}){
  fs.mkdirSync(this.dataDir,{recursive:true});const temporary=fs.mkdtempSync(path.join(this.dataDir,'deploy-'));const archive=path.join(temporary,'source.tar');
  try{
   const allowlist=['src','dist','LICENSE','package.json','package-lock.json','vm/install-worker.sh','vm/install-speech.sh','vm/install-transcription.sh','vm/transcription-requirements.txt','vm/migrate-state.mjs','vm/start-codex.sh','vm/guest.py','vm/desktop.py','vm/control.py','vm/voice_message.py','vm/transcribe_audio.py','vm/desktop_mcp.py'];
   for(const name of allowlist)if(!fs.existsSync(path.join(this.projectRoot,name)))throw Error(`Build resources are missing: ${name}`);
   const tar=process.platform==='win32'?path.join(process.env.SystemRoot||'C:/Windows','System32/tar.exe'):'tar';
   await this.run(tar,['-cf',archive,'-C',this.projectRoot,...allowlist]);
   fs.writeFileSync(path.join(temporary,'deploy-manifest.json'),JSON.stringify({sha256:createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}));
   await this.run(tar,['-rf',archive,'-C',temporary,'deploy-manifest.json']);
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
   await this.run('ssh',[...sshArgs(vm),`${vm.user}@${vm.host}`,command],{input:archive});
   if(migration)fs.writeFileSync(receipt,JSON.stringify({...migration,host:vm.host,completedAt:new Date().toISOString()},null,2));
  }finally{const relative=path.relative(this.dataDir,temporary);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(temporary).startsWith('deploy-'))fs.rmSync(temporary,{recursive:true,force:true});}
 }
 disconnect(){this.generation++;this.connecting=null;this.refreshing=null;this.reconnectDesired=false;clearTimeout(this.reconnectTimer);this.token=null;this.ws?.terminate?.();this.ws=null;this.child?.kill();this.child=null;this.status='offline';this.emit('change');}
 close(){this.closed=true;this.disconnect();for(const child of this.preparationChildren||[])child.kill();this.removeAllListeners();}
}
