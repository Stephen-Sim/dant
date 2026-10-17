import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import readline from 'node:readline';
import {diagnosticRpcMethod} from './diagnostic-events.mjs';
export class Rpc extends EventEmitter {
  constructor(command,args,options={}){super();this.next=0;this.pending=new Map();this.child=spawn(command,args,{...options,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.on('error',e=>this.fail(e,{reason:'process-error'}));this.child.on('close',(code,signal)=>this.fail(Error(`Worker disconnected (${code})`),{reason:'process-closed',...(Number.isInteger(code)?{exitCode:code}:{}),...(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV'].includes(signal)?{signal}: {})}));
    this.child.stdin.on('error',e=>this.fail(e,{reason:'stdin-error'}));
    this.child.stderr.on('data',d=>this.emit('diagnostic',d.toString().slice(-2000)));
    readline.createInterface({input:this.child.stdout}).on('line',line=>{try{this.receive(JSON.parse(line));}catch{}});
  }
  receive(msg){if(!msg||typeof msg!=='object')return;if(typeof msg.method==='string'){this.emit('event',msg);return;}const pending=this.pending.get(msg.id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(msg.id);if(msg.error){const error=Error(msg.error.message||'Worker request failed');error.code=msg.error.code;error.data=msg.error.data;pending.reject(error);}else pending.resolve(msg.result);}
  send(msg){if(this.closed||this.child.stdin.destroyed)throw Error('Worker disconnected');this.child.stdin.write(JSON.stringify(msg)+'\n',e=>{if(e)this.fail(e,{reason:'stdin-error'});});}
  request(method,params={}){return new Promise((resolve,reject)=>{const id=++this.next;const timer=setTimeout(()=>{this.emit('lifecycle',{code:'rpc.timeout',method:diagnosticRpcMethod(method),durationMs:60000,count:this.pending.size});this.fail(Error(`Timed out: ${method}`),{reason:'timeout',method:diagnosticRpcMethod(method)});this.child.kill();},60000);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  reply(id,result){this.send({id,result});}
  fail(e,metadata={reason:'connection-error'}){if(this.closed)return;this.closed=true;const count=this.pending.size;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.emit('lifecycle',{code:'rpc.disconnected',...metadata,count});this.emit('disconnected',e);}
  close(){this.child.kill();this.fail(Error('Worker stopped'),{reason:'stopped'});}
}
