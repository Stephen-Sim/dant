import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createWorkerApp} from '../src/server.mjs';

const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});
class Worker extends EventEmitter{
 constructor(){super();this.status='online';this.calls=[];this.rpc={reply(){},send(){}};this.turns=0;}
 async connect(){this.status='online';return {ok:true};}
 async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'api-thread'}};if(method==='turn/start')return {turn:{id:'api-turn-'+ ++this.turns}};if(method==='turn/interrupt')queueMicrotask(()=>this.emit('event',{method:'turn/completed',params:{threadId:'api-thread',turn:{id:params.turnId,status:'interrupted'}}}));return {ok:true};}
 async guest(route){if(route==='/screen')return new Response(Buffer.from([137,80,78,71,13,10,26,10]));return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});}
 disconnect(){this.status='offline';this.emit('status');}
}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(root,'api-routes-')),worker=new Worker(),keys={configured:false};
 const instance=createWorkerApp({dataDir:dir,workerFactory:()=>worker,secretFactory:()=>({status:()=>({...keys}),set:async()=>{keys.configured=true;},clear:async()=>{keys.configured=false;},get:async()=>null})});
 t.after(async()=>{await instance.close();fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(base+'/api/session').then(response=>response.json());
 async function api(route,body,method=body===undefined?'GET':'POST'){
  return fetch(base+'/api'+route,{method,headers:{'X-Dant-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 }
 return {...instance,worker,api,base,token,dir};
}

test('VM account and configuration APIs preserve ownership and reject changes during active work',async t=>{
 const {api,worker,engine,store}=await fixture(t);
 assert.equal((await api('/connect',{})).status,200);
 assert.equal((await api('/login',{})).status,200);assert.equal(worker.calls.at(-1).method,'account/login/start');assert.equal(worker.calls.at(-1).params.type,'chatgptDeviceCode');
 assert.equal((await api('/settings',{language:'en',notifications:false,model:'fixture-model',nativeVoice:'ember',apiVoice:'marin'},'PATCH')).status,200);
 assert.equal(store.state.settings.language,'en');assert.equal(store.state.settings.nativeVoice,'ember');assert.equal(store.state.settings.model,'fixture-model');
 assert.equal((await api('/settings',{vm:{host:'example.test'}},'PATCH')).status,400);
 engine.call={id:'call-guard',provider:'subscription'};
 for(const [route,body,method]of [['/connect',{}],['/logout',{}],['/settings',{model:'other'},'PATCH'],['/voice-key',{key:'never-stored'}],['/voice-key',{},'DELETE']])assert.equal((await api(route,body,method)).status,400,route);
 assert.equal(store.state.settings.model,'fixture-model');engine.call=null;
 assert.equal((await api('/voice-key',{key:'test-only'})).status,200);assert.equal((await api('/state').then(r=>r.json())).worker.realtime.key.configured,true);
 assert.equal((await api('/voice-key',{},'DELETE')).status,200);assert.equal((await api('/logout',{})).status,200);assert.equal(worker.calls.at(-1).method,'account/logout');
});

test('VM memory, reactions and read APIs validate references and preserve unrelated messages',async t=>{
 const {api,store,engine}=await fixture(t);engine.loaded=true;
 assert.equal((await api('/memory/working-memory.md',{text:'A useful preference'},'PATCH')).status,200);assert.equal(engine.loaded,false);assert.equal(store.state.memory,'A useful preference');
 const memory=await api('/memory').then(r=>r.json());assert.ok(memory.files.some(file=>file.name==='working-memory.md'));
 assert.equal((await api('/memory/unknown.md',{text:'Should not write'},'PATCH')).status,400);
 const a=store.add({role:'assistant',text:'Read this',status:'completed'}),b=store.add({role:'assistant',text:'Remain unread',status:'completed'});
 assert.equal((await api('/messages/'+a.id+'/reaction',{emoji:'invalid'})).status,400);assert.equal((await api('/messages/missing/reaction',{emoji:'👍'})).status,404);
 await api('/messages/'+a.id+'/reaction',{emoji:'👍'});await api('/messages/'+a.id+'/reaction',{emoji:'👍'});assert.deepEqual(a.reactions,[]);
 assert.equal((await api('/read',{ids:'all'})).status,400);assert.equal((await api('/read',{ids:[a.id]})).status,200);assert.equal(a.read,true);assert.equal(b.read,false);
});

test('upload and download APIs preserve immutable content and never inline active documents',async t=>{
 const {api,base,token}=await fixture(t);
 const form=new FormData();form.set('file',new Blob(['<script>window.injected=true</script>'],{type:'text/html'}),'page.html');
 const uploaded=await fetch(base+'/api/upload',{method:'POST',headers:{'X-Dant-Token':token},body:form});assert.equal(uploaded.status,200);const file=await uploaded.json();
 assert.equal(file.type,'application/octet-stream');
 const download=await api('/files/'+file.id);assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal(await download.text(),'<script>window.injected=true</script>');
 assert.equal((await api('/files/00000000-0000-0000-0000-000000000000')).status,404);
 const forged=new FormData();forged.set('file',new Blob(['plain text'],{type:'image/png'}),'fake.png');
 assert.equal((await fetch(base+'/api/upload',{method:'POST',headers:{'X-Dant-Token':token},body:forged})).status,400);
 assert.equal((await api('/upload',{})).status,400);
});

test('invalid message references and uncertain retries never accidentally submit model work',async t=>{
 const {api,worker,store}=await fixture(t);
 for(const body of [{text:'hello',clientMessageId:'unsafe-id'},{text:'hello',attachments:['missing']},{text:'hello',replyTo:'missing'},{text:'hello',attachments:['same','same']},{text:''}])assert.equal((await api('/messages',body)).status,400);
 assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);
 const task=store.add({role:'user',text:'Uncertain external action',status:'paused',submission:'unknown'});
 assert.equal((await api('/retry/'+task.id,{})).status,400);assert.equal(task.status,'paused');assert.equal((await api('/tasks/resume',{ids:[task.id]})).status,400);
 assert.equal((await api('/tasks/resume',{ids:'all'})).status,400);assert.equal((await api('/tasks/'+task.id+'/accept',{})).status,400);
 assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);
 store.update(task.id,{status:'review'});assert.equal((await api('/tasks/'+task.id+'/accept',{})).status,200);assert.equal(task.status,'completed');
 worker.status='offline';assert.equal((await api('/messages',{text:'Wait until online'})).status,409);assert.equal((await api('/steer',{text:'extra',expectedTurnId:'old'})).status,400);
});

test('schedules dispatch once only when the VM executor is online and can be removed',async t=>{
 const {api,worker,store}=await fixture(t);worker.status='offline';
 assert.equal((await api('/schedules',{text:'too late',at:Date.now()-1})).status,400);
 const response=await api('/schedules',{text:'One scheduled task',at:Date.now()+30});assert.equal(response.status,200);const schedule=await response.json();
 await new Promise(resolve=>setTimeout(resolve,1030));assert.equal(store.state.schedules[0].status,'pending');assert.equal(store.state.messages.length,0);
 worker.status='online';await new Promise(resolve=>setTimeout(resolve,1030));assert.equal(store.state.schedules[0].status,'dispatched');assert.equal(store.state.messages.filter(message=>message.scheduled).length,1);
 assert.equal((await api('/schedules/'+schedule.id,{},'DELETE')).status,200);assert.equal(store.state.schedules.length,0);
 assert.equal((await api('/tasks/pause',{})).status,200);assert.equal((await api('/stop',{})).status,200);
});
