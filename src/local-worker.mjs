import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Rpc} from './rpc.mjs';
import {execFileSync,spawn} from 'node:child_process';

export async function assertVmRuntime({platform=process.platform,uid=process.getuid?.(),detect=()=>execFileSync('systemd-detect-virt',['--vm'],{encoding:'utf8',timeout:5000}).trim(),fetchImpl=fetch}={}){
 if(platform!=='linux'||uid===0)throw Error('The executor requires an ordinary user inside a Linux VM.');
 let virtualization;try{virtualization=detect();}catch{throw Error('No virtual machine runtime was detected; execution was refused.');}
 if(!virtualization||virtualization==='none')throw Error('No virtual machine runtime was detected; execution was refused.');
 const health=await fetchImpl('http://127.0.0.1:4320/health',{signal:AbortSignal.timeout(5000)});if(!health.ok||!(await health.json()).ok)throw Error('The VM desktop bridge is not healthy.');
 const screen=await fetchImpl('http://127.0.0.1:4320/screen',{signal:AbortSignal.timeout(10000)});const bytes=Buffer.from(await screen.arrayBuffer());if(!screen.ok||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('The VM display is unavailable.');
}

// Only the VM service constructs this executor. A Controller never creates Rpc.
export class LocalWorker extends EventEmitter {
 constructor(store,{rpcFactory=(command,args,options)=>new Rpc(command,args,options),platform=process.platform,home=os.homedir(),fetchImpl=fetch,verifyRuntime=()=>assertVmRuntime({fetchImpl})}={}){
  super();this.store=store;this.rpcFactory=rpcFactory;this.platform=platform;this.home=home;this.fetchImpl=fetchImpl;this.verifyRuntime=verifyRuntime;this.status='offline';this.error=null;this.generation=0;
  this.runtimeId=process.env.DANT_RUNTIME_ID||`vm:${os.hostname()}:${os.userInfo().username}`;
  this.workspaceRoot=process.env.DANT_WORKSPACE_ROOT||path.join(home,'dant/workspaces');
  this.desktopPath=path.join(home,'dant/vm/desktop.py');
 }
 async connect(){
  if(this.platform!=='linux')throw Error('Task execution is available only inside the Linux VM.');
  if(this.connecting)return this.connecting;
  this.disconnect();const generation=this.generation;
  const pending=this.open(generation).finally(()=>{if(this.connecting===pending)this.connecting=null;});this.connecting=pending;return pending;
 }
 async open(generation){
  this.status='connecting';this.error=null;this.emit('status');let rpc;
  const current=()=>{if(generation!==this.generation||rpc?.closed)throw Error('VM executor connection cancelled');};
  try{
   await this.verifyRuntime();current();
   fs.mkdirSync(this.workspaceRoot,{recursive:true});
   const candidates=[path.join(this.home,'.local/bin/codex'),'/usr/local/bin/codex','/usr/bin/codex'];
   const command=candidates.find(file=>fs.existsSync(file));if(!command)throw Error('Codex is not installed in the VM.');
   const args=['-c','features.realtime_conversation=true','-c','mcp_servers.dant_desktop.command='+JSON.stringify('/usr/bin/python3'),'-c','mcp_servers.dant_desktop.args='+JSON.stringify([path.join(this.home,'dant/vm/desktop_mcp.py'),'--output-dir',path.join(this.workspaceRoot,this.store.state.conversationId,'output')]),'app-server','--listen','stdio://'];
   rpc=this.rpcFactory(command,args,{cwd:this.workspaceRoot,env:{...process.env,DISPLAY:':0',CODEX_HOME:path.join(this.home,'.dant-codex'),PATH:`${path.join(this.home,'.local/bin')}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:${process.env.PATH||''}`}});this.rpc=rpc;
   if(rpc.child){this.executorChild=rpc.child;this.executorClosed=false;this.executorClose=new Promise(resolve=>rpc.child.once('close',()=>{this.executorClosed=true;resolve();}));}
   rpc.on('event',event=>{if(this.rpc===rpc)this.emit('event',event);});
   rpc.on('disconnected',error=>{if(this.rpc===rpc){this.rpc=null;this.status='offline';this.account=null;this.models=null;this.error=error.message;this.emit('status');}});
   await rpc.request('initialize',{clientInfo:{name:'dant',title:'dant',version:'0.1.0'},capabilities:{experimentalApi:true}});current();rpc.send({method:'initialized'});
   this.account=await rpc.request('account/read',{});current();this.models=await rpc.request('model/list',{});current();this.status='online';this.error=null;this.emit('status');return this.account;
  }catch(error){if(this.rpc===rpc)this.rpc=null;rpc?.close();if(generation===this.generation){this.status='offline';this.error=error.message;this.emit('status');}throw error;}
 }
 disconnect(){this.generation++;this.connecting=null;if(this.rpc){const rpc=this.rpc;this.rpc=null;rpc.close();}this.status='offline';this.account=null;this.models=null;this.emit('status');}
 async terminateConfirmed({timeoutMs=5000}={}){
  const child=this.executorChild;if(!child||this.executorClosed)return {terminated:true};
  this.rpc?.close();if(!this.rpc)child.kill('SIGTERM');
  let timer;try{await Promise.race([this.executorClose,new Promise((resolve,reject)=>timer=setTimeout(()=>reject(Error('The VM executor has not confirmed that it stopped. Computer control remains blocked.')),timeoutMs))]);}
  finally{clearTimeout(timer);}
  if(!this.executorClosed)throw Error('The VM executor did not confirm shutdown.');return {terminated:true};
 }
 request(method,params){if(this.status!=='online')throw Error('The VM executor is offline');return this.rpc.request(method,params);}
 async guest(route,body){
  if(this.status!=='online')throw Error('The VM executor is offline');
  if(!['/screen','/input','/control','/file','/read-file'].includes(route))throw Error('Unsupported desktop operation');
  const response=await this.fetchImpl(`http://127.0.0.1:4320${route}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`Desktop operation failed (${response.status})`);return response;
 }
 async upload(file){return (await this.guest('/file',{name:file.originalname,data:fs.readFileSync(file.path).toString('base64')})).json();}
 async createVoiceMessage({text,outputDir,language}={}){
  if(this.platform!=='linux'||this.status!=='online')throw Error('Voice files can only be created by the connected VM.');
  const directory=path.resolve(outputDir||''),relative=path.relative(this.workspaceRoot,directory);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Voice output must be inside the VM conversation workspace.');
  if(typeof text!=='string'||!text.trim()||text.length>2500)throw Error('Voice messages require 1–2500 characters.');
  return await new Promise((resolve,reject)=>{
   let output='',errorOutput='',settled=false;const child=spawn('/usr/bin/python3',[path.join(this.home,'dant/vm/voice_message.py'),'--output-dir',directory],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
   const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};const timer=setTimeout(()=>{child.kill();finish(Error('VM speech generation timed out.'));},55000);
   child.once('error',()=>finish(Error('Could not start VM speech generation.')));child.stdout.on('data',chunk=>{output=(output+chunk.toString()).slice(-8192);});child.stderr.on('data',chunk=>{errorOutput=(errorOutput+chunk.toString()).slice(-4096);});child.stdin.on('error',()=>{});
   child.once('close',code=>{if(code!==0){let reason;try{reason=JSON.parse(errorOutput).error;}catch{}finish(Error(reason||'VM speech generation failed; check the local espeak-ng dependency.'));return;}try{const result=JSON.parse(output),file=path.resolve(result.path);if(path.dirname(file)!==directory||result.type!=='audio/wav')throw Error('Invalid VM voice output.');finish(null,result);}catch{finish(Error('VM speech generation returned an invalid output.'));}});child.stdin.end(JSON.stringify({text,language}));
  });
 }
}
