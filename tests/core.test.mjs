import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {sshArgs} from '../src/worker.mjs';
import {Worker} from '../src/worker.mjs';
import {Rpc} from '../src/rpc.mjs';
import {createApp} from '../src/server.mjs';
// Keep test data in the writable workspace: Windows sandbox Temp denies rename.
const testRoot=path.resolve('.cache','tests');fs.mkdirSync(testRoot,{recursive:true});
const temp=t=>{const p=fs.mkdtempSync(path.join(testRoot,'dant-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
class FakeWorker extends EventEmitter {
 constructor(){super();this.status='online';this.calls=[];this.next=0;this.rpc={reply:()=>{},send:()=>{}};}
 async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-test'}};if(method==='turn/start')return {turn:{id:'turn-'+ ++this.next}};if(method==='turn/interrupt')queueMicrotask(()=>this.emit('event',{method:'turn/completed',params:{threadId:'thread-test',turn:{id:params.turnId,status:'interrupted'}}}));return {};}
 disconnect(){this.status='offline';this.emit('status');}
}
const tick=()=>new Promise(r=>setImmediate(r));
test('restart retains messages and makes unfinished tasks explicitly resumable',t=>{const dir=temp(t);const s=new Store(dir);s.add({role:'user',text:'persist',status:'queued'});s.add({role:'assistant',text:'partial',status:'streaming'});const reopened=new Store(dir);assert.equal(reopened.state.messages.length,2);assert.deepEqual(reopened.state.messages.map(m=>m.status),['interrupted','interrupted']);});
test('corrupt persistence is not silently overwritten',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'state.json'),'{bad');assert.throws(()=>new Store(dir));assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),'{bad');});
test('VM host cannot inject SSH options or shell syntax',t=>{const dir=temp(t),key=path.join(dir,'key');fs.writeFileSync(key,'test');const valid={host:'172.16.0.2',user:'dant',port:22,keyPath:key,knownHosts:path.join(dir,'hosts')};assert.ok(sshArgs(valid).includes('BatchMode=yes'));for(const host of ['-oProxyCommand=x','host;whoami','$(whoami)','a b'])assert.throws(()=>sshArgs({...valid,host}));assert.throws(()=>sshArgs({...valid,user:'dant;id'}));assert.throws(()=>sshArgs({...valid,port:0}));});
test('serial queue starts next task only after completion',async t=>{const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);const a=s.add({role:'user',text:'one'}),b=s.add({role:'user',text:'two'});e.enqueue(a);e.enqueue(b);await tick();assert.equal(w.calls.filter(c=>c.method==='turn/start').length,1);await e.handle({method:'turn/completed',params:{turn:{status:'completed'},threadId:'thread-test'}});await tick();assert.equal(w.calls.filter(c=>c.method==='turn/start').length,2);assert.equal(s.state.messages[0].status,'read');});
test('takeover waits for interruption and pauses queued work until return',async t=>{const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);e.enqueue(s.add({role:'user',text:'one'}));e.enqueue(s.add({role:'user',text:'two'}));await tick();await e.acquire();assert.equal(e.active,null);assert.equal(e.takeover,true);assert.equal(w.calls.filter(c=>c.method==='turn/start').length,1);e.release();await tick();assert.equal(w.calls.filter(c=>c.method==='turn/start').length,2);});
test('streaming and final agent events produce one message with intact markdown',async t=>{const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);s.state.threadId='thread-test';for(const delta of ['**hello',' world**'])await e.handle({method:'item/agentMessage/delta',params:{threadId:'thread-test',itemId:'a',delta}});await e.handle({method:'item/completed',params:{threadId:'thread-test',item:{id:'a',type:'agentMessage',text:'**hello world**'}}});assert.equal(s.state.messages.length,1);assert.equal(s.state.messages[0].text,'**hello world**');assert.equal(s.state.messages[0].status,'completed');});
test('independent memory survives a fresh process and call end leaves one record',async t=>{const dir=temp(t),s=new Store(dir),w=new FakeWorker(),e=new Engine(s,w);await e.tool('memory_write',{text:'Prefers Chinese'});assert.equal(new Store(dir).state.memory,'Prefers Chinese');e.call={started:Date.now()-3000};await e.stopCall();e.closeCall();assert.equal(s.state.messages.filter(m=>m.kind==='call').length,1);});
test('disconnect invalidates loaded thread and marks work interrupted',async t=>{const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);e.enqueue(s.add({role:'user',text:'hello'}));await tick();assert.equal(e.loaded,true);w.disconnect();assert.equal(e.loaded,false);assert.equal(s.state.messages[0].status,'interrupted');});
test('HTTP requires token, rejects cross-origin writes and denies desktop input without takeover',async t=>{let instance;t.after(()=>instance?.close());const dir=temp(t);instance=createApp({dataDir:dir,workerFactory:()=>new FakeWorker()});await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+instance.server.address().port;assert.equal((await fetch(base+'/api/state')).status,401);const {token}=await fetch(base+'/api/session').then(r=>r.json());const headers={'X-Dant-Token':token,'Content-Type':'application/json'};assert.equal((await fetch(base+'/api/input',{method:'POST',headers,body:'{"type":"click","x":10,"y":10}'})).status,409);assert.equal((await fetch(base+'/api/stop',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);const state=await fetch(base+'/api/state',{headers}).then(r=>r.json());assert.deepEqual(state.messages,[]);});
test('HTTP stores reply relationships, reaction toggles and read receipts',async t=>{let instance;t.after(()=>instance?.close());instance=createApp({dataDir:temp(t),workerFactory:()=>new FakeWorker()});await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+instance.server.address().port;const {token}=await fetch(base+'/api/session').then(r=>r.json());const headers={'X-Dant-Token':token,'Content-Type':'application/json'};const m=instance.store.add({role:'assistant',text:'Answer',status:'completed'});await fetch(base+'/api/messages/'+m.id+'/reaction',{method:'POST',headers,body:'{"emoji":"👍"}'});assert.deepEqual(m.reactions,['👍']);await fetch(base+'/api/read',{method:'POST',headers,body:JSON.stringify({ids:[m.id]})});assert.equal(m.read,true);const response=await fetch(base+'/api/messages',{method:'POST',headers,body:JSON.stringify({text:'Follow up',replyTo:m.id})});assert.equal(response.status,200);const result=await response.json();assert.equal(result.replyTo,m.id);});

test('thread parameters match the generated app-server protocol and refresh durable memory on resume',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 s.state.memory='Prefers Chinese';await e.thread();
 assert.equal(w.calls[0].params.sandbox,'danger-full-access');
 e.loaded=false;s.state.memory='Updated memory';await e.thread();
 const resume=w.calls.find(c=>c.method==='thread/resume');
 assert.equal(resume.params.persistExtendedHistory,false);
 assert.match(resume.params.developerInstructions,/Updated memory/);
});

test('disconnect preserves queued work until reconnect instead of failing every message',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 const first=s.add({role:'user',text:'one'}),second=s.add({role:'user',text:'two',status:'queued'});
 e.enqueue(first);e.enqueue(second);await tick();w.disconnect();await tick();
 assert.equal(first.status,'interrupted');assert.equal(second.status,'queued');assert.equal(e.queue.length,1);
 w.status='online';w.emit('status');await tick();
 assert.equal(e.active.messageId,second.id);assert.equal(w.calls.filter(c=>c.method==='turn/start').length,2);
});

test('late and duplicate completion events cannot complete the next queued turn',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 const first=s.add({role:'user',text:'one'}),second=s.add({role:'user',text:'two'});
 e.enqueue(first);e.enqueue(second);await tick();
 const completion={method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-1',status:'completed'}}};
 await e.handle(completion);await tick();await e.handle(completion);
 assert.equal(e.active.messageId,second.id);assert.equal(second.status,'running');
 await e.handle({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'different-turn',status:'completed'}}});
 assert.equal(e.active.messageId,second.id);
});

test('takeover requested while thread starts cancels before sending turn/start',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker();let resolveStart;
 const original=w.request.bind(w);w.request=(method,params)=>method==='thread/start'?new Promise(resolve=>resolveStart=resolve):original(method,params);
 const e=new Engine(s,w),message=s.add({role:'user',text:'one'});e.enqueue(message);
 const takeover=e.acquire();assert.equal(e.takeover,false);
 resolveStart({thread:{id:'thread-test'}});await takeover;
 assert.equal(e.takeover,true);assert.equal(message.status,'interrupted');
 assert.equal(w.calls.filter(c=>c.method==='turn/start').length,0);
});

test('a failed old turn/start response cannot fail a newer task after reconnect',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker();let rejectOld;let starts=0;
 const original=w.request.bind(w);w.request=(method,params)=>{if(method==='turn/start'&&starts++===0)return new Promise((resolve,reject)=>rejectOld=reject);return original(method,params);};
 const e=new Engine(s,w),first=s.add({role:'user',text:'one'}),second=s.add({role:'user',text:'two',status:'queued'});
 e.enqueue(first);e.enqueue(second);await tick();w.disconnect();w.status='online';w.emit('status');await tick();
 assert.equal(e.active.messageId,second.id);rejectOld(Error('Old connection closed'));await tick();
 assert.equal(e.active.messageId,second.id);assert.equal(second.status,'running');
});

test('streaming deltas survive reopening persistence before final completion',async t=>{
 const dir=temp(t),s=new Store(dir),e=new Engine(s,new FakeWorker());s.state.threadId='thread-test';
 await e.handle({method:'item/agentMessage/delta',params:{threadId:'thread-test',itemId:'partial',delta:'Saved partial'}});
 const reopened=new Store(dir);assert.equal(reopened.state.messages[0].text,'Saved partial');
 assert.equal(reopened.state.messages[0].status,'interrupted');
});

test('RPC resolves a final response before worker exit and preserves error codes',async t=>{
 const script="process.stdin.once('data',data=>{const msg=JSON.parse(data.toString());process.stdout.write(JSON.stringify({id:msg.id,error:{code:-32602,message:'bad argument'}})+'\\n',()=>process.exit(0));});";
 const rpc=new Rpc(process.execPath,['-e',script]);t.after(()=>rpc.close());
 await assert.rejects(rpc.request('test'),e=>e.message==='bad argument'&&e.code===-32602);
});

test('disconnect cancels a connection before it spawns SSH',async t=>{
 const s=new Store(temp(t)),key=path.join(s.dir,'key');fs.writeFileSync(key,'test');
 Object.assign(s.state.settings.vm,{host:'127.0.0.1',user:'dant',port:22,keyPath:key});
 const w=new Worker(s),opening=w.connect();w.disconnect();
 await assert.rejects(opening,/cancelled/);assert.equal(w.status,'offline');assert.equal(w.rpc,null);
});

test('worker exposes a concise connection error when setup is invalid',async t=>{
 const s=new Store(temp(t)),w=new Worker(s);
 await assert.rejects(w.connect(),/Invalid VM connection settings/);
 assert.equal(w.status,'offline');assert.equal(w.error,'Invalid VM connection settings');
});

test('concurrent call starts reserve one session before opening a thread',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 const first=e.startCall('sdp-offer');await assert.rejects(e.startCall('second-offer'),/already active/);
 await first;assert.equal(w.calls.filter(c=>c.method==='thread/realtime/start').length,1);
 await e.stopCall();
});

test('realtime errors close the backend call so it does not block reconnect or the next call',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 await e.startCall('sdp-offer');
 await e.handle({method:'thread/realtime/error',params:{threadId:'thread-test',message:'Voice unavailable'}});
 assert.equal(e.call,null);assert.equal(w.calls.filter(c=>c.method==='thread/realtime/stop').length,1);
 assert.equal(s.state.messages.filter(m=>m.kind==='call').length,1);
});
