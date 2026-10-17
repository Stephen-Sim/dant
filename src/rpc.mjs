import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import readline from 'node:readline';
export class Rpc extends EventEmitter {
  constructor(command,args,options={}){super();this.next=0;this.pending=new Map();this.child=spawn(command,args,{...options,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.on('error',e=>this.fail(e));this.child.on('close',(code)=>this.fail(Error(`Worker disconnected (${code})`)));
    this.child.stdin.on('error',e=>this.fail(e));
    this.child.stderr.on('data',d=>this.emit('diagnostic',d.toString().slice(-2000)));
    readline.createInterface({input:this.child.stdout}).on('line',line=>{try{this.receive(JSON.parse(line));}catch{}});
  }
  receive(msg){if(!msg||typeof msg!=='object')return;if(typeof msg.method==='string'){this.emit('event',msg);return;}const pending=this.pending.get(msg.id);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(msg.id);if(msg.error){const error=Error(msg.error.message||'Worker request failed');error.code=msg.error.code;error.data=msg.error.data;pending.reject(error);}else pending.resolve(msg.result);}
  send(msg){if(this.closed||this.child.stdin.destroyed)throw Error('Worker disconnected');this.child.stdin.write(JSON.stringify(msg)+'\n',e=>{if(e)this.fail(e);});}
  request(method,params={}){return new Promise((resolve,reject)=>{const id=++this.next;const timer=setTimeout(()=>{this.fail(Error(`Timed out: ${method}`));this.child.kill();},60000);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  reply(id,result){this.send({id,result});}
  fail(e){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.emit('disconnected',e);}
  close(){this.child.kill();this.fail(Error('Worker stopped'));}
}
