import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createControllerApp} from '../src/controller.mjs';
import {VmBridge} from '../src/vm-bridge.mjs';
import {assertVmRuntime} from '../src/local-worker.mjs';

const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});
const temporary=t=>{const dir=fs.mkdtempSync(path.join(root,'controller-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
class FakeProvisioning extends EventEmitter{snapshot(){return {status:'idle',running:false};}resumeMonitoring(){return this.snapshot();}close(){}}
class FakeBridge extends EventEmitter{
 constructor(){super();this.status='offline';this.error=null;this.requests=[];}
 async refresh(){return this.cached;}
 async request(route,options){this.requests.push({route,...options});if(this.fail)throw Object.assign(Error('Unknown outcome; not resent'),{unknownOutcome:true,status:502});return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});}
 close(){}disconnect(){this.status='offline';this.emit('change');}
}
async function listen(t,dir,bridge=new FakeBridge()){
 const app=createControllerApp({dataDir:dir,projectRoot:path.resolve('.'),bridgeFactory:()=>bridge,provisioningFactory:()=>new FakeProvisioning()});t.after(()=>app.close());
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
 const session=await fetch(base+'/api/session').then(response=>response.json());return {app,bridge,base,session,headers:{'X-Dant-Token':session.token,'Content-Type':'application/json'}};
}

test('language changes persist offline and synchronize the VM default on reconnect',async t=>{
 const dir=temporary(t),{app,base,headers,bridge}=await listen(t,dir);
 let response=await fetch(base+'/api/settings',{method:'PATCH',headers,body:JSON.stringify({language:'en'})});assert.equal(response.ok,true);assert.equal(app.snapshot().settings.language,'en');assert.equal(bridge.requests.length,0);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'controller.json'))).language,'en');
 bridge.connect=async()=>{bridge.status='online';bridge.cached={settings:{language:'zh'}};};
 response=await fetch(base+'/api/connect',{method:'POST',headers,body:'{}'});assert.equal(response.ok,true);assert.equal(bridge.requests.length,1);assert.equal(bridge.requests[0].route,'/api/settings');assert.deepEqual(JSON.parse(bridge.requests[0].body),{language:'en'});
 response=await fetch(base+'/api/settings',{method:'PATCH',headers,body:JSON.stringify({language:'zh'})});assert.equal(response.ok,true);assert.equal(app.snapshot().settings.language,'zh');assert.deepEqual(JSON.parse(bridge.requests.at(-1).body),{language:'zh'});
 const invalid=await fetch(base+'/api/settings',{method:'PATCH',headers,body:JSON.stringify({language:'unknown'})});assert.equal(invalid.ok,false);assert.equal(app.snapshot().settings.language,'zh');
});

test('default Controller has no authoritative Store or local task executor',async t=>{
 const dir=temporary(t),{app,base,session,headers}=await listen(t,dir);
 assert.equal(session.product,'dant');assert.equal(session.mode,'controller');assert.equal(app.store,undefined);assert.equal(app.engine,undefined);assert.equal(app.worker,undefined);assert.equal(fs.existsSync(path.join(dir,'state.json')),false);
 const state=await fetch(base+'/api/state',{headers}).then(response=>response.json());assert.equal(state.mode,'vm-controller');assert.equal(state.controller.authority,'vm');assert.deepEqual(state.messages,[]);
});

test('Controller retains cached VM conversation offline and never loads legacy host state as authority',async t=>{
 const dir=temporary(t),message={id:'from-vm',role:'assistant',text:'VM history',status:'completed'},legacy={messages:[{id:'host-only'}]};fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(legacy));
 fs.writeFileSync(path.join(dir,'state-cache.json'),JSON.stringify({messages:[message],settings:{language:'en'},worker:{status:'online'},memory:'VM memory',queue:[]}));
 const {base,headers}=await listen(t,dir);const state=await fetch(base+'/api/state',{headers}).then(response=>response.json());
 assert.equal(state.worker.status,'offline');assert.equal(state.controller.cached,true);assert.deepEqual(state.messages,[message]);assert.equal(state.memory,'VM memory');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')),legacy);
});

test('Controller proxies a mutation once and preserves an unknown result instead of resending',async t=>{
 const {base,headers,bridge}=await listen(t,temporary(t));bridge.status='online';bridge.fail=true;
 const response=await fetch(base+'/api/messages',{method:'POST',headers,body:JSON.stringify({text:'one request'})});assert.equal(response.status,502);assert.equal((await response.json()).unknownOutcome,true);assert.equal(bridge.requests.length,1);assert.equal(bridge.requests[0].body,'{"text":"one request"}');
});

test('Controller token and origin checks protect proxied mutations',async t=>{
 const {base,headers,bridge}=await listen(t,temporary(t));assert.equal((await fetch(base+'/api/state')).status,401);
 assert.equal((await fetch(base+'/api/messages',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);assert.equal(bridge.requests.length,0);
});

test('VM bridge merges simultaneous state refreshes and serves the 2 second cache',async t=>{
 let finish,calls=0;const bridge=new VmBridge({dataDir:temporary(t),projectRoot:path.resolve('.'),fetchImpl:()=>{calls++;return new Promise(resolve=>finish=resolve);}});t.after(()=>bridge.close());bridge.status='online';bridge.token='test-token';bridge.port=1234;
 const first=bridge.refresh(),second=bridge.refresh();assert.equal(calls,1);finish(new Response(JSON.stringify({messages:[{id:'vm'}]}),{headers:{'Content-Type':'application/json'}}));
 assert.deepEqual(await first,await second);await bridge.refresh();assert.equal(calls,1);
});

test('VM bridge never retries a failed business mutation',async t=>{
 let calls=0;const bridge=new VmBridge({dataDir:temporary(t),projectRoot:path.resolve('.'),fetchImpl:async()=>{calls++;throw Error('Network ended');}});t.after(()=>bridge.close());bridge.status='online';bridge.token='test-token';bridge.port=1234;
 await assert.rejects(bridge.request('/api/messages',{method:'POST',body:'{}'}),error=>error.unknownOutcome===true&&/not resent/.test(error.message));assert.equal(calls,1);
});

test('runtime verification rejects root, bare metal and unavailable desktop before execution',async()=>{
 await assert.rejects(assertVmRuntime({platform:'linux',uid:0}),/ordinary user/);
 await assert.rejects(assertVmRuntime({platform:'linux',uid:1000,detect:()=>{throw Error('not a VM');}}),/No virtual machine/);
 await assert.rejects(assertVmRuntime({platform:'linux',uid:1000,detect:()=> 'microsoft',fetchImpl:async()=>new Response('{"ok":false}',{headers:{'Content-Type':'application/json'}})}),/not healthy/);
 let requests=0;await assertVmRuntime({platform:'linux',uid:1000,detect:()=> 'microsoft',fetchImpl:async()=>++requests===1?new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}}):new Response(Buffer.from([137,80,78,71,13,10,26,10]))});assert.equal(requests,2);
});

test('prepare mode displays setup without automatically connecting a bound VM',async t=>{
 const dir=temporary(t);fs.writeFileSync(path.join(dir,'vm.json'),'{"host":"192.0.2.1"}');const bridge=new FakeBridge();bridge.connect=()=>assert.fail('Prepare mode must not connect automatically');
 const instance=createControllerApp({dataDir:dir,projectRoot:path.resolve('.'),prepareOnly:true,bridgeFactory:()=>bridge,provisioningFactory:()=>new FakeProvisioning()});t.after(()=>instance.close());await instance.start();assert.equal(instance.snapshot().worker.status,'offline');
});

test('SSE sends the same cached state contract without opening a VM connection',async t=>{
 const {base,session}=await listen(t,temporary(t));const controller=new AbortController();t.after(()=>controller.abort());
 const response=await fetch(base+'/api/events?token='+session.token,{signal:controller.signal});assert.equal(response.headers.get('content-type'),'text/event-stream');const reader=response.body.getReader(),chunk=await reader.read();const event=JSON.parse(new TextDecoder().decode(chunk.value).trim().replace(/^data: /,''));assert.equal(event.type,'state');assert.equal(event.data.mode,'vm-controller');await reader.cancel();
});
