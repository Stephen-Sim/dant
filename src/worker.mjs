import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {Rpc} from './rpc.mjs';
export function sshArgs(vm){
 if(!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(vm.host)||!/^[a-z_][a-z0-9_-]*$/i.test(vm.user)||!Number.isInteger(Number(vm.port))||vm.port<1||vm.port>65535)throw Error('Invalid VM connection settings');
 if(!vm.keyPath||!fs.existsSync(vm.keyPath))throw Error('SSH private key not found');
 return ['-T','-p',String(vm.port),'-i',vm.keyPath,'-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=accept-new','-o',`UserKnownHostsFile=${vm.knownHosts}`];
}
async function freePort(){return await new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));});});}
export class Worker extends EventEmitter{
 constructor(store){super();this.store=store;this.status='offline';this.error=null;this.generation=0;}
 async connect(){
  if(this.connecting)return this.connecting;
  this.disconnect();const generation=this.generation;
  const connecting=this.open(generation).finally(()=>{if(this.connecting===connecting)this.connecting=null;});this.connecting=connecting;return connecting;
 }
 async open(generation){
  this.status='connecting';this.error=null;this.emit('status');let rpc;
  const current=()=>{if(generation!==this.generation||rpc?.closed)throw Error('VM connection cancelled or disconnected');};
  try{
   const vm=this.store.state.settings.vm;vm.knownHosts ||= path.join(this.store.dir,'known_hosts');this.store.save();
   const args=sshArgs(vm);const port=await freePort();current();this.port=port;
   rpc=new Rpc('ssh',[...args,'-L',`127.0.0.1:${port}:127.0.0.1:4319`,'-o','ExitOnForwardFailure=yes',`${vm.user}@${vm.host}`,'/opt/dant/start-codex.sh']);this.rpc=rpc;
   rpc.on('event',e=>{if(this.rpc===rpc)this.emit('event',e);});rpc.on('diagnostic',e=>{if(this.rpc===rpc)this.lastDiagnostic=e;});
   rpc.on('disconnected',e=>{if(this.rpc===rpc){this.rpc=null;this.status='offline';this.account=null;this.models=null;this.error=e.message;this.emit('status');}});
   await rpc.request('initialize',{clientInfo:{name:'dant',title:'dant',version:'0.1.0'},capabilities:{experimentalApi:true}});current();rpc.send({method:'initialized'});
   const account=await rpc.request('account/read',{});current();const models=await rpc.request('model/list',{});current();this.account=account;this.models=models;this.status='online';this.error=null;this.emit('status');return this.account;
  }catch(e){if(this.rpc===rpc)this.rpc=null;rpc?.close();if(generation===this.generation){this.status='offline';this.account=null;this.models=null;this.error=e.message;this.emit('status');}throw e;}
 }
 disconnect(){this.generation++;this.connecting=null;if(this.rpc){const rpc=this.rpc;this.rpc=null;rpc.close();}this.status='offline';this.account=null;this.models=null;this.port=null;this.emit('status');}
 request(method,params){if(this.status!=='online')throw Error('Connect the VM first / 请先连接工作电脑');return this.rpc.request(method,params);}
 async guest(route,body){if(this.status!=='online')throw Error('VM offline');const r=await fetch(`http://127.0.0.1:${this.port}${route}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(await r.text());return r;}
 async upload(file){return await (await this.guest('/file',{name:file.originalname,data:fs.readFileSync(file.path).toString('base64')})).json();}
}
