import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createWorkerApp} from '../src/server.mjs';
import {createControllerApp} from '../src/controller.mjs';
import {Diagnostics} from '../src/diagnostics.mjs';

const testRoot=path.resolve('.cache/tests');fs.mkdirSync(testRoot,{recursive:true});
class Worker extends EventEmitter{constructor(){super();this.status='online';this.rpc={reply(){},send(){}};}disconnect(){this.status='offline';this.emit('status');}async request(){return {};}}
class Provisioning extends EventEmitter{snapshot(){return {status:'idle'};}close(){}}
class Bridge extends EventEmitter{constructor(){super();this.status='offline';this.requests=[];this.cached={settings:{language:'zh',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}};}async request(route){this.requests.push(route);if(this.error)throw Error('private SSH error');return Response.json({status:{role:'vm-worker',retentionDays:3},recent:[{event:'service.started'}]});}close(){this.status='offline';this.emit('change');}}
async function fixture(t,mode){const dir=fs.mkdtempSync(path.join(testRoot,'diagnostics-route-')),worker=new Worker(),bridge=new Bridge();let timerCallback,cancelled=0;const diagnosticsFactory=options=>new Diagnostics({...options,schedule:callback=>{timerCallback=callback;return {unref(){}};},cancel:()=>cancelled++});
 const instance=mode==='worker'?createWorkerApp({dataDir:dir,workerFactory:()=>worker,diagnosticsFactory}):createControllerApp({dataDir:dir,projectRoot:path.resolve('.'),bridgeFactory:()=>bridge,provisioningFactory:()=>new Provisioning(),diagnosticsFactory,profileOptions:{registryFile:path.join(dir,'registry.json'),includeProject:false,candidateDirs:[],env:{}}});
 t.after(async()=>{await instance.close();fs.rmSync(dir,{recursive:true,force:true});});await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(base+'/api/session').then(response=>response.json());
 return {instance,worker,bridge,dir,base,headers:{'X-Dant-Token':token,'Content-Type':'application/json'},timer:()=>timerCallback,cancelled:()=>cancelled};}

test('Worker diagnostics require session auth, are read-only, redact payloads and close their timer',async t=>{
 const {instance,worker,dir,base,headers,timer,cancelled}=await fixture(t,'worker');assert.equal((await fetch(base+'/api/diagnostics?privateQuery=hidden')).status,401);assert.equal((await fetch(base+'/api/diagnostics',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
 worker.emit('diagnostic','private-raw-stderr');worker.emit('lifecycle',{code:'rpc.timeout',method:'turn/start',count:1,durationMs:60000,error:'private-error',body:{secret:'private-body'}});
 instance.nativeVoice.emit('diagnostic',{code:'voice_shutdown',callId:'test-call',reason:'notification-buffer',confirmed:true,executorStopped:true,payload:'private-image'});worker.error='private-worker-error';worker.status='offline';worker.emit('status');worker.emit('status');
 instance.nativeVoice.emit('diagnostic',{code:'voice_handoff_tracked',callId:'test-call',turnId:'test-turn',count:1,payload:'private-spoken-text'});instance.nativeVoice.emit('diagnostic',{code:'voice_handoff_confirmed',callId:'test-call',count:1,text:'private-transcript'});
 instance.nativeVoice.emit('diagnostic',{code:'voice_observer_payload_omitted',callId:'test-call',method:'item/completed',itemType:'mcpToolCall',itemStatus:'completed',itemId:'screenshot-1',eventBytes:1049077,bytes:240,count:1,output:'private-large-output',arguments:{secret:'private-argument'}});
 const message=instance.store.add({role:'user',text:'private-prompt',status:'queued'});instance.engine.change();message.status='review';instance.engine.change();
 assert.equal((await fetch(base+'/api/credentials/private-name?privateQuery=hidden',{method:'DELETE',headers,body:JSON.stringify({secret:'private-secret'})})).status,400);
 const response=await fetch(base+'/api/diagnostics',{headers});assert.equal(response.status,200);const result=await response.json();assert.equal(result.status.role,'vm-worker');assert.equal(result.status.retentionDays,3);assert.equal(result.status.version,JSON.parse(fs.readFileSync('package.json')).version);
 assert.ok(result.recent.some(entry=>entry.event==='rpc.timeout'));assert.ok(result.recent.some(entry=>entry.event==='voice_shutdown'));assert.equal(result.recent.filter(entry=>entry.event==='worker.status'&&entry.status==='offline').length,1);assert.ok(result.recent.some(entry=>entry.event==='http.request'&&entry.route==='/api/credentials/:id'));assert.ok(result.recent.some(entry=>entry.event==='task.status'&&entry.status==='review'));
 assert.ok(result.recent.some(entry=>entry.event==='voice_handoff_tracked'&&entry.turnId==='test-turn'&&entry.count===1));assert.ok(result.recent.some(entry=>entry.event==='voice_handoff_confirmed'&&entry.count===1));
 assert.ok(result.recent.some(entry=>entry.event==='voice_observer_payload_omitted'&&entry.itemType==='mcpToolCall'&&entry.itemStatus==='completed'&&entry.itemId==='screenshot-1'&&entry.eventBytes===1049077&&entry.bytes===240));
 assert.equal(JSON.stringify(result).includes('private-'),false);const mutation=await fetch(base+'/api/diagnostics',{method:'DELETE',headers});assert.equal(mutation.status,405);assert.equal(fs.readdirSync(path.join(dir,'logs')).length,1);
 const cleanup=timer();await instance.close();assert.equal(instance.diagnostics.status().closed,true);assert.equal(cancelled(),1);assert.equal(instance.diagnostics.recent(50).at(-1).event,'service.closed');assert.equal(cleanup(),false);await instance.close();assert.equal(cancelled(),1);
});

test('Controller diagnostics aggregate only an online Worker and retain fixed offline/failure results',async t=>{
 const {instance,bridge,base,headers}=await fixture(t,'controller');assert.equal((await fetch(base+'/api/diagnostics')).status,401);
 let result=await fetch(base+'/api/diagnostics',{headers}).then(response=>response.json());assert.deepEqual(result.worker,{available:false,reason:'worker-unavailable'});assert.equal(bridge.requests.length,0);
 bridge.status='online';bridge.emit('change');bridge.emit('state',{messages:[],settings:{},worker:{status:'offline',error:'private cached model error'},queue:[]});result=await fetch(base+'/api/diagnostics',{headers}).then(response=>response.json());assert.equal(result.worker.available,true);assert.equal(result.worker.status.role,'vm-worker');assert.deepEqual(bridge.requests,['/api/diagnostics']);assert.ok(result.recent.some(entry=>entry.event==='bridge.status'&&entry.status==='online'));assert.ok(result.recent.some(entry=>entry.event==='worker.status'&&entry.cached));assert.equal(JSON.stringify(result).includes('private'),false);
 bridge.error=true;result=await fetch(base+'/api/diagnostics',{headers}).then(response=>response.json());assert.deepEqual(result.worker,{available:false,reason:'worker-unavailable'});assert.equal((await fetch(base+'/api/diagnostics',{method:'POST',headers,body:'{}'})).status,405);assert.equal(bridge.requests.length,2);await instance.close();assert.equal(instance.diagnostics.status().closed,true);
});
