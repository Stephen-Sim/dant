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
 async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-test'}};if(method==='thread/read')return {thread:{id:params.threadId,turns:[]}};if(method==='turn/start')return {turn:{id:'turn-'+ ++this.next}};if(method==='turn/interrupt')queueMicrotask(()=>this.emit('event',{method:'turn/completed',params:{threadId:'thread-test',turn:{id:params.turnId,status:'interrupted'}}}));return {};}
 disconnect(){this.status='offline';this.emit('status');}
}
const tick=()=>new Promise(r=>setImmediate(r));
const waitFor=async predicate=>{for(let attempt=0;attempt<100&&!predicate();attempt++)await tick();assert.ok(predicate(),'Expected asynchronous fixture state was not reached');};
test('restart retains messages and pauses unfinished tasks for explicit resume',t=>{const dir=temp(t);const s=new Store(dir);s.add({role:'user',text:'persist',status:'queued'});s.add({role:'assistant',text:'partial',status:'streaming'});const reopened=new Store(dir);assert.equal(reopened.state.messages.length,2);assert.deepEqual(reopened.state.messages.map(m=>m.status),['paused','paused']);});
test('corrupt persistence is not silently overwritten',t=>{const dir=temp(t);fs.writeFileSync(path.join(dir,'state.json'),'{bad');assert.throws(()=>new Store(dir));assert.equal(fs.readFileSync(path.join(dir,'state.json'),'utf8'),'{bad');});
test('Windows persistence retries a transient atomic rename without rewriting or losing state',t=>{
 const dir=temp(t),pauses=[];let armed=false,attempts=0;
 const store=new Store(dir,{platform:'win32',pause:ms=>pauses.push(ms),renameSync:(from,to)=>{if(armed&&++attempts===1)throw Object.assign(Error('Transient file lock'),{code:'EPERM'});fs.renameSync(from,to);}});
 armed=true;store.state.memory='Saved after retry';store.save();
 assert.equal(attempts,2);assert.deepEqual(pauses,[10]);assert.equal(JSON.parse(fs.readFileSync(store.file,'utf8')).memory,'Saved after retry');
 assert.equal(fs.existsSync(store.file+'.tmp'),false);
});
test('Windows persistence exhausts a bounded rename retry and preserves the original file/error',t=>{
 const dir=temp(t),pauses=[],failure=Object.assign(Error('Persistent file lock'),{code:'EACCES'});let armed=false,attempts=0;
 const store=new Store(dir,{platform:'win32',pause:ms=>pauses.push(ms),renameSync:(from,to)=>{if(armed){attempts++;throw failure;}fs.renameSync(from,to);}});
 const original=fs.readFileSync(store.file);armed=true;store.state.memory='Unsaved change';assert.throws(()=>store.save(),error=>error===failure);
 assert.equal(attempts,6);assert.deepEqual(pauses,[10,20,30,40,50]);assert.ok(pauses.reduce((a,b)=>a+b,0)<=200);assert.deepEqual(fs.readFileSync(store.file),original);
});
test('persistence does not retry unrelated errors or permission errors on other platforms',t=>{
 for(const [platform,code] of [['win32','ENOSPC'],['linux','EPERM']]){
  let armed=false,attempts=0;const failure=Object.assign(Error('Not retryable'),{code}),store=new Store(temp(t),{platform,pause:()=>assert.fail('Unexpected retry pause'),renameSync:(from,to)=>{if(armed){attempts++;throw failure;}fs.renameSync(from,to);}});
  const original=fs.readFileSync(store.file);armed=true;assert.throws(()=>store.save(),error=>error===failure);assert.equal(attempts,1);assert.deepEqual(fs.readFileSync(store.file),original);
 }
});
test('VM host cannot inject SSH options or shell syntax',t=>{const dir=temp(t),key=path.join(dir,'key');fs.writeFileSync(key,'test');const valid={host:'172.16.0.2',user:'dant',port:22,keyPath:key,knownHosts:path.join(dir,'hosts')};assert.ok(sshArgs(valid).includes('BatchMode=yes'));for(const host of ['-oProxyCommand=x','host;whoami','$(whoami)','a b'])assert.throws(()=>sshArgs({...valid,host}));assert.throws(()=>sshArgs({...valid,user:'dant;id'}));assert.throws(()=>sshArgs({...valid,port:0}));});
test('serial queue starts next task after the first reaches review',async t=>{const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);const a=s.add({role:'user',text:'one'}),b=s.add({role:'user',text:'two'});e.enqueue(a);e.enqueue(b);await tick();assert.equal(w.calls.filter(c=>c.method==='turn/start').length,1);await e.handle({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed'},threadId:'thread-test'}});await tick();assert.equal(w.calls.filter(c=>c.method==='turn/start').length,2);assert.equal(s.state.messages[0].status,'review');});
test('takeover waits for interruption and pauses queued work until return',async t=>{const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w),notices=[],events=[];e.on('notice',notice=>notices.push(notice));w.prependListener('event',event=>events.push({method:event.method,threadId:event.params?.threadId,turnId:event.params?.turn?.id}));e.enqueue(s.add({role:'user',text:'one'}));e.enqueue(s.add({role:'user',text:'two'}));await tick();try{await e.acquire();}catch(error){error.message+='; trace='+JSON.stringify({notices,events,threadId:s.state.threadId,active:e.active&&{turnId:e.active.turnId,stopRequested:e.active.stopRequested},completedTurns:[...e.completedTurns],calls:w.calls.map(call=>({method:call.method,threadId:call.params?.threadId,turnId:call.params?.turnId}))});throw error;}assert.equal(e.active,null);assert.equal(e.takeover,true);assert.equal(w.calls.filter(c=>c.method==='turn/start').length,1);e.release();await tick();assert.equal(w.calls.filter(c=>c.method==='turn/start').length,1);e.resumePaused([s.state.messages[1].id]);await tick();assert.equal(w.calls.filter(c=>c.method==='turn/start').length,2);});
test('matching streaming and final events produce one assistant message with intact markdown',async t=>{const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);e.enqueue(s.add({role:'user',text:'hello'}));await tick();for(const delta of ['**hello',' world**'])await e.handle({method:'item/agentMessage/delta',params:{threadId:'thread-test',turnId:'turn-1',itemId:'a',delta}});await e.handle({method:'item/completed',params:{threadId:'thread-test',turnId:'turn-1',item:{id:'a',type:'agentMessage',text:'**hello world**'}}});const messages=s.state.messages.filter(m=>m.role==='assistant');assert.equal(messages.length,1);assert.equal(messages[0].text,'**hello world**');assert.equal(messages[0].status,'completed');});
test('independent memory survives a fresh process and call end leaves one record',async t=>{const dir=temp(t),s=new Store(dir),w=new FakeWorker(),e=new Engine(s,w);await e.tool('memory_write',{text:'Prefers Chinese'});assert.equal(new Store(dir).state.memory,'Prefers Chinese');e.call={id:'test-call',provider:'api',connectedAt:Date.now()-3000};await e.stopCall();e.closeCall();assert.equal(s.state.messages.filter(m=>m.kind==='call').length,1);});
test('executor disconnect invalidates the loaded thread and pauses work',async t=>{const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);e.enqueue(s.add({role:'user',text:'hello'}));await tick();assert.equal(e.loaded,true);w.disconnect();await tick();assert.equal(e.loaded,false);assert.equal(s.state.messages[0].status,'paused');});
test('HTTP requires token, rejects cross-origin writes and denies desktop input without takeover',async t=>{let instance;t.after(()=>instance?.close());const dir=temp(t);instance=createApp({mode:'test',dataDir:dir,workerFactory:()=>new FakeWorker()});await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+instance.server.address().port;assert.equal((await fetch(base+'/api/state')).status,401);const {token}=await fetch(base+'/api/session').then(r=>r.json());const headers={'X-Dant-Token':token,'Content-Type':'application/json'};assert.equal((await fetch(base+'/api/input',{method:'POST',headers,body:'{"type":"click","x":10,"y":10}'})).status,400);assert.equal((await fetch(base+'/api/stop',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);const state=await fetch(base+'/api/state',{headers}).then(r=>r.json());assert.deepEqual(state.messages,[]);});
test('HTTP stores reply relationships, reaction toggles and read receipts',async t=>{let instance;t.after(()=>instance?.close());instance=createApp({mode:'test',dataDir:temp(t),workerFactory:()=>new FakeWorker()});await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+instance.server.address().port;const {token}=await fetch(base+'/api/session').then(r=>r.json());const headers={'X-Dant-Token':token,'Content-Type':'application/json'};const m=instance.store.add({role:'assistant',text:'Answer',status:'completed'});await fetch(base+'/api/messages/'+m.id+'/reaction',{method:'POST',headers,body:'{"emoji":"👍"}'});assert.deepEqual(m.reactions,['👍']);await fetch(base+'/api/read',{method:'POST',headers,body:JSON.stringify({ids:[m.id]})});assert.equal(m.read,true);const response=await fetch(base+'/api/messages',{method:'POST',headers,body:JSON.stringify({text:'Follow up',replyTo:m.id})});assert.equal(response.status,200);const result=await response.json();assert.equal(result.replyTo,m.id);});

test('HTTP client message IDs persist and prevent duplicate execution even after restart',async t=>{
 const dir=temp(t),worker=new FakeWorker();let instance=createApp({mode:'test',dataDir:dir,workerFactory:()=>worker});t.after(()=>instance.close());
 async function endpoint(){await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${instance.server.address().port}`,{token}=await fetch(base+'/api/session').then(response=>response.json());return {base,headers:{'X-Dant-Token':token,'Content-Type':'application/json'}};}
 let {base,headers}=await endpoint();const body={text:'execute only once',attachments:[],clientMessageId:'163b54ea-349c-4eca-9074-3bfb43247999'};
 const post=payload=>fetch(base+'/api/messages',{method:'POST',headers,body:JSON.stringify(payload)});
 const first=await (await post(body)).json();await tick();const duplicate=await (await post(body)).json();assert.equal(duplicate.id,first.id);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);
 assert.equal((await post({...body,text:'different request'})).status,409);assert.equal(instance.store.state.messages.filter(message=>message.role==='user').length,1);
 await instance.close();await tick();const restartedWorker=new FakeWorker();instance=createApp({mode:'test',dataDir:dir,workerFactory:()=>restartedWorker});({base,headers}=await endpoint());
 const restored=await (await post(body)).json();assert.equal(restored.id,first.id);assert.equal(restored.clientMessageId,body.clientMessageId);assert.equal(restartedWorker.calls.length,0);
});

test('thread parameters match the generated app-server protocol and refresh durable memory on resume',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 e.memory.write('working-memory.md','Prefers Chinese');await e.thread();
 assert.equal(w.calls[0].params.sandbox,'danger-full-access');
 e.loaded=false;e.memory.write('working-memory.md','Updated memory');await e.thread();
 const resume=w.calls.find(c=>c.method==='thread/resume');
 assert.equal(resume.params.persistExtendedHistory,false);
 assert.match(resume.params.developerInstructions,/Updated memory/);
});

test('resumed threads and every queued turn retain the VM execution policy and selected model',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 Object.assign(s.state,{threadId:'thread-test',threadHost:'172.16.0.2'});s.state.settings.vm.host='172.16.0.2';s.state.settings.model='gpt-6.1-sol';
 e.enqueue(s.add({role:'user',text:'first'}));e.enqueue(s.add({role:'user',text:'second'}));await tick();
 const resumed=w.calls.find(call=>call.method==='thread/resume');assert.ok(resumed);assert.equal(w.calls.some(call=>call.method==='thread/start'),false);
 assert.equal(resumed.params.cwd,e.workspace);assert.equal(resumed.params.approvalPolicy,'never');assert.equal(resumed.params.sandbox,'danger-full-access');assert.equal(resumed.params.model,'gpt-6.1-sol');
 await e.handle({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-1',status:'completed'}}});await tick();
 const turns=w.calls.filter(call=>call.method==='turn/start');assert.equal(turns.length,2);
 for(const {params} of turns){assert.equal(params.cwd,e.workspace);assert.equal(params.approvalPolicy,'never');assert.deepEqual(params.sandboxPolicy,{type:'dangerFullAccess'});assert.equal(params.model,'gpt-6.1-sol');}
});

test('executor disconnect pauses queued work until explicit resume after reconnect',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 const first=s.add({role:'user',text:'one'}),second=s.add({role:'user',text:'two',status:'queued'});
 e.enqueue(first);e.enqueue(second);await tick();w.disconnect();await tick();
 assert.equal(first.status,'paused');assert.equal(second.status,'paused');assert.equal(e.queue.length,0);
 w.status='online';w.emit('status');await tick();
 assert.equal(e.active,null);e.resumePaused([second.id]);await tick();
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
 assert.equal(e.takeover,true);assert.equal(message.status,'paused');
 assert.equal(w.calls.filter(c=>c.method==='turn/start').length,0);
});

test('failed running-status persistence settles startup instead of leaving takeover pending',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w),notices=[];e.on('notice',notice=>notices.push(notice));
 const message=s.add({role:'user',text:'one'}),update=s.update.bind(s);let failed=false;
 s.update=(id,patch)=>{if(patch.status==='running'&&!failed){failed=true;throw Error('Simulated initial save failure');}return update(id,patch);};
 e.queue.push(message);await e.pump();await e.acquire();
 assert.equal(failed,true);assert.equal(e.active,null);assert.equal(e.takeover,true);assert.equal(message.status,'failed');assert.equal(w.calls.length,0);
 assert.ok(notices.includes('Simulated initial save failure'));
});

test('takeover waits for the response identity before accepting a buffered early completion',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker();let resolveStart,requested;
 const startRequested=new Promise(resolve=>requested=resolve),original=w.request.bind(w);
 w.request=(method,params)=>{if(method!=='turn/start')return original(method,params);w.calls.push({method,params});requested();return new Promise(resolve=>resolveStart=resolve);};
 const e=new Engine(s,w),first=s.add({role:'user',text:'one'});e.enqueue(first);e.enqueue(s.add({role:'user',text:'queued'}));await startRequested;
 const takeover=e.acquire();await e.handle({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'early-turn',status:'completed'}}});await tick();
 const acquiredBeforeStartReply=e.takeover;resolveStart({turn:{id:'early-turn'}});await takeover;
 assert.equal(acquiredBeforeStartReply,false);assert.equal(e.active,null);assert.equal(first.status,'review');assert.equal(e.queue.length,0);
 assert.equal(w.calls.filter(call=>call.method==='turn/start').length,1);
});

test('takeover uses the completion notification without waiting for interrupt acknowledgement',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker();let acknowledge;
 const original=w.request.bind(w);w.request=(method,params)=>{
  if(method!=='turn/interrupt')return original(method,params);
  w.calls.push({method,params});queueMicrotask(()=>w.emit('event',{method:'turn/completed',params:{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted'}}}));
  return new Promise(resolve=>acknowledge=resolve);
 };
 const e=new Engine(s,w);e.enqueue(s.add({role:'user',text:'one'}));await tick();
 const takeover=e.acquire();await tick();const acquiredBeforeAck=e.takeover;acknowledge({});await takeover;
 assert.equal(acquiredBeforeAck,true);assert.equal(e.active,null);
});

test('unacknowledged or incomplete started events cannot replace the confirmed response turn ID',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker();let resolveStart,requested;
 const startRequested=new Promise(resolve=>requested=resolve),original=w.request.bind(w);
 w.request=(method,params)=>{if(method!=='turn/start')return original(method,params);w.calls.push({method,params});requested();return new Promise(resolve=>resolveStart=resolve);};
 const e=new Engine(s,w);e.enqueue(s.add({role:'user',text:'one'}));await startRequested;
 await e.handle({method:'turn/started',params:{threadId:'thread-test',turn:{id:'observed-turn'}}});
 await e.handle({method:'turn/started',params:{threadId:'thread-test'}});
 resolveStart({turn:{id:'stale-response-turn'}});await tick();
 assert.equal(e.active.turnId,'stale-response-turn');await e.acquire();
 assert.equal(w.calls.find(call=>call.method==='turn/interrupt').params.turnId,'stale-response-turn');assert.equal(e.takeover,true);
});

test('takeover matches the captured thread and ignores unrelated completion events',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),original=w.request.bind(w);
 w.request=(method,params)=>{if(method!=='turn/interrupt')return original(method,params);w.calls.push({method,params});return Promise.resolve({});};
 const e=new Engine(s,w);e.enqueue(s.add({role:'user',text:'one'}));await tick();const active=e.active,takeover=e.acquire();
 await e.handle({method:'turn/completed',params:{threadId:'other-thread',turn:{id:active.turnId,status:'completed'}}});
 await e.handle({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'other-turn',status:'completed'}}});await tick();
 assert.equal(e.active,active);assert.equal(e.takeover,false);
 // A settings/thread refresh must not invalidate the running turn's identity.
 s.state.threadId='other-thread';await e.handle({method:'turn/completed',params:{threadId:'thread-test',turn:{id:active.turnId,status:'interrupted'}}});
 const accepted=e.active===null;if(e.active)e.finish('interrupted');await takeover;assert.equal(accepted,true);assert.equal(e.takeover,true);assert.equal(e.active,null);
});

test('confirmed completion releases takeover and reports a final persistence failure',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w),notices=[];e.on('notice',notice=>notices.push(notice));
 e.enqueue(s.add({role:'user',text:'one'}));await tick();const original=fs.readFileSync(s.file),save=s.save.bind(s);
 s.save=()=>{throw Error('Simulated final persistence failure');};
 try{await e.acquire();}finally{s.save=save;}
 assert.equal(e.active,null);assert.equal(e.takeover,true);assert.deepEqual(fs.readFileSync(s.file),original);
 assert.ok(notices.some(notice=>notice.includes('Could not save conversation: Simulated final persistence failure')));
});

test('a failed old turn/start response cannot fail a newer task after reconnect',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker();let rejectOld;let starts=0;
 const original=w.request.bind(w);w.request=(method,params)=>{if(method==='turn/start'&&starts++===0)return new Promise((resolve,reject)=>rejectOld=reject);return original(method,params);};
 const e=new Engine(s,w),first=s.add({role:'user',text:'one'}),second=s.add({role:'user',text:'two',status:'queued'});
 e.enqueue(first);e.enqueue(second);await tick();w.disconnect();await tick();w.status='online';w.emit('status');e.resumePaused([second.id]);await tick();
 assert.equal(e.active.messageId,second.id);rejectOld(Error('Old connection closed'));await tick();
 assert.equal(e.active.messageId,second.id);assert.equal(second.status,'running');
});

test('streaming deltas survive reopening persistence after the bounded save interval',async t=>{
 const dir=temp(t),s=new Store(dir),e=new Engine(s,new FakeWorker());e.enqueue(s.add({role:'user',text:'request'}));await tick();
 await e.handle({method:'item/agentMessage/delta',params:{threadId:'thread-test',turnId:'turn-1',itemId:'partial',delta:'Saved partial'}});
 await new Promise(resolve=>setTimeout(resolve,380));
 const reopened=new Store(dir),message=reopened.state.messages.find(m=>m.role==='assistant');assert.equal(message.text,'Saved partial');
 assert.equal(message.status,'paused');
});

test('RPC resolves a final response before worker exit and preserves error codes',async t=>{
 const script="process.stdin.once('data',data=>{const msg=JSON.parse(data.toString());process.stdout.write(JSON.stringify({id:msg.id,error:{code:-32602,message:'bad argument'}})+'\\n',()=>process.exit(0));});";
 const rpc=new Rpc(process.execPath,['-e',script]);t.after(()=>rpc.close());
 await assert.rejects(rpc.request('test'),e=>e.message==='bad argument'&&e.code===-32602);
});

test('Windows refuses to construct a task execution process',async t=>{
 const w=new Worker(new Store(temp(t)),{platform:'win32',rpcFactory:()=>assert.fail('Windows must never spawn Codex')});
 await assert.rejects(w.connect(),/only inside the Linux VM/);assert.equal(w.status,'offline');
});

test('disconnect cancels VM-local Codex initialization',async t=>{
 const s=new Store(temp(t)),home=temp(t);fs.mkdirSync(path.join(home,'.local/bin'),{recursive:true});fs.writeFileSync(path.join(home,'.local/bin/codex'),'test');
 const rpc=new EventEmitter();let finish;rpc.request=()=>new Promise(resolve=>finish=resolve);rpc.close=()=>rpc.closed=true;
 const w=new Worker(s,{platform:'linux',home,verifyRuntime:async()=>{},rpcFactory:()=>rpc}),opening=w.connect();await tick();w.disconnect();finish({});
 await assert.rejects(opening,/cancelled/);assert.equal(w.status,'offline');assert.equal(w.rpc,null);
});

test('VM worker starts Codex locally through stdio with the retained authentication home',async t=>{
 const s=new Store(temp(t)),home=temp(t);fs.mkdirSync(path.join(home,'.local/bin'),{recursive:true});fs.writeFileSync(path.join(home,'.local/bin/codex'),'test');
 const rpc=new EventEmitter(),requests=[];let invocation;
 rpc.request=async(method,params)=>{requests.push({method,params});return method==='account/read'?{account:{type:'chatgpt',planType:'pro'}}:method==='model/list'?{data:[]}:{}};
 rpc.send=message=>requests.push(message);rpc.close=()=>{rpc.closed=true;rpc.emit('disconnected',Error('Stopped'));};
 const w=new Worker(s,{platform:'linux',home,verifyRuntime:async()=>{},rpcFactory:(command,args,options)=>{invocation={command,args,options};return rpc;}});t.after(()=>w.disconnect());
 await w.connect();assert.equal(w.status,'online');assert.equal(invocation.command,path.join(home,'.local/bin/codex'));
 assert.deepEqual(invocation.args.slice(-3),['app-server','--listen','stdio://']);assert.ok(invocation.args.includes('features.realtime_conversation=true'));assert.ok(invocation.args.includes('mcp_servers.dant_desktop.command='+JSON.stringify('/usr/bin/python3')));assert.ok(invocation.args.includes('mcp_servers.dant_desktop.args='+JSON.stringify([path.join(home,'dant/vm/desktop_mcp.py'),'--output-dir',path.join(w.workspaceRoot,s.state.conversationId,'output')])));assert.equal(invocation.options.env.CODEX_HOME,path.join(home,'.dant-codex'));assert.equal(invocation.options.cwd,w.workspaceRoot);
 assert.deepEqual(requests.map(request=>request.method),['initialize','initialized','account/read','model/list']);
});

test('concurrent call starts reserve one independently billed voice session',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 let finish,starts=0;e.voice={start:()=>{starts++;return new Promise(resolve=>finish=resolve);},stop:async()=>{}};
 const first=e.startCall('sdp-offer',{provider:'api'});await assert.rejects(e.startCall('second-offer',{provider:'api'}),/already active/);
 await waitFor(()=>typeof finish==='function');finish({sdp:'answer'});await first;assert.equal(starts,1);assert.deepEqual(w.calls.map(call=>call.method),['thread/start','thread/read']);assert.deepEqual(w.calls[1].params,{threadId:'thread-test',includeTurns:true});
 await e.stopCall();
});

test('unowned Codex realtime errors do not close a separate API voice call',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 let stops=0;e.voice={start:async()=>({sdp:'answer'}),stop:async()=>{stops++;}};
 await e.startCall('sdp-offer',{provider:'api'});e.confirmCallConnected(e.call.id);
 await e.handle({method:'thread/realtime/error',params:{message:'Voice unavailable'}});
 assert.equal(e.call.provider,'api');assert.equal(stops,0);await e.stopCall();assert.equal(e.call,null);assert.equal(stops,1);
 assert.equal(s.state.messages.filter(m=>m.kind==='call').length,1);
});

test('voice requires a separately configured provider before creating a session or call record',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);w.account={account:{type:'chatgpt'}};
 await assert.rejects(e.startCall('unused-offer',{provider:'api'}),/separate voice API key/);
 assert.equal(w.calls.length,0);assert.equal(e.call,null);assert.equal(s.state.messages.length,0);
});

test('voice tasks use the subscription serial queue without writing speech transcripts into chat',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);
 const message=s.add({role:'user',text:'First typed task',status:'queued'});e.enqueue(message);await tick();
 const voice=e.runVoiceTask('Check the work directory');assert.equal(e.queue.length,1);assert.equal(s.state.messages.length,1);
 await e.handle({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-1',status:'completed'}}});await tick();
 assert.match(w.calls.filter(c=>c.method==='turn/start')[1].params.input[0].text,/Check the work directory/);
 await e.handle({method:'item/agentMessage/delta',params:{threadId:'thread-test',turnId:'turn-2',itemId:'voice-item',delta:'The work directory '}});
 await e.handle({method:'item/completed',params:{threadId:'thread-test',turnId:'turn-2',item:{type:'agentMessage',id:'voice-item',text:'The work directory is ready.'}}});
 await e.handle({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-2',status:'completed'}}});
 assert.deepEqual(await voice,{result:'The work directory is ready.'});assert.equal(s.state.messages.length,1);assert.equal(e.voiceTasks.size,0);
});

test('voice task failure and cancellation do not strand a promise or mutate a stored message',async t=>{
 const s=new Store(temp(t)),w=new FakeWorker(),e=new Engine(s,w);e.takeover=true;
 await assert.rejects(e.runVoiceTask('test'),/Return the desktop/);e.takeover=false;
 const first=e.runVoiceTask('first'),firstRejected=assert.rejects(first,/disconnected/i);await tick();
 const queued=e.runVoiceTask('queued'),queuedRejected=assert.rejects(queued,/disconnected/i);
 w.disconnect();await Promise.all([firstRejected,queuedRejected]);assert.equal(e.queue.length,0);assert.equal(e.voiceTasks.size,0);assert.equal(s.state.messages.length,0);
});

test('voice key HTTP configuration stays separate from subscription state and never returns the secret',async t=>{
 let saved=null;const provider=new EventEmitter();provider.start=async()=>({sdp:'answer'});provider.stop=async()=>provider.emit('closed');provider.close=async()=>{};
 const keys={get:async()=>saved,set:async value=>{saved=value;},clear:async()=>{saved=null;},status:()=>({configured:!!saved,source:saved?'stored':null,storage:'windows-dpapi'})};
 const w=new FakeWorker();w.account={account:{type:'chatgpt',planType:'pro'}};
 const instance=createApp({mode:'test',dataDir:temp(t),workerFactory:()=>w,secretFactory:()=>keys,voiceFactory:()=>provider});t.after(()=>instance.close());
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+instance.server.address().port;
 const {token}=await fetch(base+'/api/session').then(r=>r.json()),headers={'X-Dant-Token':token,'Content-Type':'application/json'},key='test-only-key-not-a-real-credential';
 const response=await fetch(base+'/api/voice-key',{method:'POST',headers,body:JSON.stringify({key})});assert.equal(response.status,200);assert.equal((await response.text()).includes(key),false);
 const snapshot=await fetch(base+'/api/state',{headers}).then(r=>r.json());assert.equal(snapshot.worker.realtime.available,true);assert.equal(snapshot.worker.realtime.billing,'subscription');assert.equal(snapshot.worker.realtime.subscription.available,true);assert.equal(snapshot.worker.realtime.api.billing,'api');assert.equal(snapshot.worker.account.type,'chatgpt');assert.equal(JSON.stringify(snapshot).includes(key),false);assert.equal(fs.readFileSync(instance.store.file,'utf8').includes(key),false);
 await instance.engine.startCall('offer',{provider:'api'});instance.engine.confirmCallConnected(instance.engine.call.id);assert.equal((await fetch(base+'/api/voice-key',{method:'DELETE',headers})).status,400);await instance.engine.stopCall();
 assert.equal((await fetch(base+'/api/voice-key',{method:'DELETE',headers})).status,200);assert.equal(saved,null);assert.deepEqual(w.calls.map(call=>call.method),['thread/start','thread/read']);assert.deepEqual(w.calls[1].params,{threadId:'thread-test',includeTurns:true});assert.equal(instance.store.state.messages.filter(m=>m.kind==='call').length,1);
});

test('application shutdown waits for its API voice hangup and remains idempotent',async t=>{
 const provider=new EventEmitter();let finish,closed=0;provider.close=()=>{closed++;return new Promise(resolve=>finish=resolve);};
 const instance=createApp({mode:'test',dataDir:temp(t),workerFactory:()=>new FakeWorker(),voiceFactory:()=>provider});
 const shutdown=instance.close();assert.equal(instance.close(),shutdown);let completed=false;shutdown.then(()=>completed=true);await tick();assert.equal(completed,false);
 finish();await shutdown;assert.equal(completed,true);assert.equal(closed,1);
});
