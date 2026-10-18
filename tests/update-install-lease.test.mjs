import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {UpdateInstallLease,installStateSafe,updateSensitiveRequest} from '../src/update-install-lease.mjs';
import {createControllerApp} from '../src/controller.mjs';

const safe=()=>({mode:'vm-controller',controller:{status:'online',cached:false,authority:'vm'},call:null,takeover:false,computer:{status:'dant',sessionId:null,pending:false},provisioning:{status:'ready',running:false},active:{turnId:'keep-running'},queue:['keep-queued']});
test('install admission preserves VM work but requires live no-call/control/setup authority',()=>{
 const state=safe();assert.equal(installStateSafe(state),true);
 for(const patch of [{call:{id:'call'}},{call:undefined},{takeover:true},{acquiring:true},{controller:{status:'online',cached:true,authority:'vm'}},{computer:{status:'human'}},{computer:{status:'dant',pending:true}},{computer:{status:'dant',sessionId:'human'}},{provisioning:{running:true,status:'installing'}},{mode:'vm-worker'}])assert.equal(installStateSafe({...state,...patch}),false);
});
test('sensitive admission is normalized and includes call/control/setup without blocking messages or cancellation',()=>{
 for(const originalUrl of ['/api/call','/api/CALL/','/api/x/../call','/api/%63all','/api/takeover','/api/provision','/api/connect','/api/prepare','/api/vm/import'])assert.equal(updateSensitiveRequest({method:'POST',originalUrl}),true,originalUrl);
 assert.equal(updateSensitiveRequest({method:'PATCH',path:'/api/settings',body:{vm:{host:'changed'}}}),true);
 for(const [method,path,body]of [['GET','/api/state'],['POST','/api/messages'],['POST','/api/tasks/work/cancel'],['POST','/api/call/stop'],['PATCH','/api/settings',{theme:'dark'}]])assert.equal(updateSensitiveRequest({method,path,body}),false,path);
});
test('refresh reserves admission atomically; live task stays untouched and lease release/expiry permit later calls',async()=>{
 let finish,now=100;const state=safe(),lease=new UpdateInstallLease({snapshot:()=>state,refresh:()=>new Promise(resolve=>finish=resolve),now:()=>now,id:()=> 'lease-one'});
 const acquired=lease.acquire();assert.throws(()=>lease.enter(),error=>error.status===409);finish();assert.deepEqual(await acquired,{leaseId:'lease-one',expiresAt:30100});assert.throws(()=>lease.enter());assert.deepEqual(state.active,{turnId:'keep-running'});assert.deepEqual(state.queue,['keep-queued']);
 assert.throws(()=>lease.release('stale'));assert.deepEqual(lease.release('lease-one'),{released:true});const done=lease.enter();done();
 const again=lease.acquire();finish();await again;now=30100;lease.enter()();lease.close();assert.throws(()=>lease.enter());await assert.rejects(lease.acquire());
});
test('pending or uncertain critical delivery prevents install and completion cannot decrement twice',async()=>{
 const lease=new UpdateInstallLease({snapshot:safe,refresh:async()=>{}}),done=lease.enter();await assert.rejects(lease.acquire());assert.equal(lease.pending,1);done();done();assert.equal(lease.pending,0);const unknown=lease.enter();unknown({unknownOutcome:true});await assert.rejects(lease.acquire());
});
test('failed refresh, call discovered after refresh and shutdown release checking reservation',async()=>{
 let state=safe(),fail=true;const lease=new UpdateInstallLease({snapshot:()=>state,refresh:async()=>{if(fail)throw Error('offline');state={...state,call:{id:'new-call'}};}});
 await assert.rejects(lease.acquire());lease.enter()();fail=false;await assert.rejects(lease.acquire());lease.enter()();
 let finish;const closing=new UpdateInstallLease({snapshot:safe,refresh:()=>new Promise(resolve=>finish=resolve)}),pending=closing.acquire();closing.close();finish();await assert.rejects(pending);
});

class Provisioning extends EventEmitter{snapshot(){return {status:'ready',running:false};}resumeMonitoring(){return this.snapshot();}close(){}}
class Bridge extends EventEmitter{
 constructor(){super();this.status='online';this.cached={...safe(),messages:[],settings:{language:'zh'},worker:{status:'online'}};this.requests=[];}
 async refresh(){if(this.refreshFailure)throw Error('offline');this.emit('state',this.cached);return this.cached;}
 async request(route,options){this.requests.push({route,...options});if(this.pending)await this.pending;return new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}});}
 close(){}
}
async function fixture(t){
 const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'update-lease-')),bridge=new Bridge(),app=createControllerApp({dataDir:dir,projectRoot:path.resolve('.'),bridgeFactory:()=>bridge,provisioningFactory:()=>new Provisioning(),profileOptions:{registryFile:path.join(dir,'registry.json'),candidateDirs:[],includeProject:false,env:{}}});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`,session=await fetch(base+'/api/session').then(r=>r.json()),headers={'Content-Type':'application/json','X-Dant-Token':session.token};
 const call=(route,method='POST',body={})=>fetch(base+'/api/'+route,{method,headers,...(method==='GET'?{}:{body:JSON.stringify(body)})});return {base,headers,bridge,app,call};
}
test('authenticated Controller lease blocks late call/control/setup, leaves messages and active VM work untouched',async t=>{
 const {base,headers,bridge,call}=await fixture(t);
 assert.equal((await fetch(base+'/api/updates/install-lease',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await fetch(base+'/api/updates/install-lease',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
 for(const value of [null,[],{unexpected:true}])assert.equal((await call('updates/install-lease','POST',value)).status,400);
 const response=await call('updates/install-lease');assert.equal(response.status,200);const lease=await response.json();assert.equal(typeof lease.leaseId,'string');assert.ok(lease.expiresAt>Date.now());
 for(const route of ['call','CALL/','takeover','prepare','connect','provision','vm/import'])assert.equal((await call(route)).status,409,route);
 assert.equal((await call('settings','PATCH',{vm:{host:'192.0.2.1'}})).status,409);
 assert.equal((await call('messages','POST',{text:'still working'})).status,200);assert.equal((await call('tasks/work/cancel')).status,200);assert.deepEqual(bridge.cached.active,{turnId:'keep-running'});assert.deepEqual(bridge.cached.queue,['keep-queued']);
 assert.equal((await call('updates/install-lease/not-the-lease','DELETE')).status,409);assert.equal((await call('updates/install-lease/'+lease.leaseId,'DELETE')).status,200);assert.equal((await call('takeover')).status,200);
});
test('aborting a connecting call cannot drop its in-flight install barrier before upstream completion',async t=>{
 const {base,headers,bridge,call}=await fixture(t);let finish;bridge.pending=new Promise(resolve=>finish=resolve);const abort=new AbortController(),request=fetch(base+'/api/call',{method:'POST',headers,body:'{}',signal:abort.signal}).catch(()=>null);
 for(let tries=0;!bridge.requests.length&&tries<200;tries++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(bridge.requests.length,'the call must be admitted upstream');abort.abort();await request;assert.equal((await call('updates/install-lease')).status,409);bridge.pending=null;finish();
 for(let tries=0;tries<100;tries++){const result=await call('updates/install-lease');if(result.status===200)return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('finished upstream call did not release admission');
});
test('fresh call/control state or failed refresh denies install, then permits a later confirmed safe retry',async t=>{
 const {bridge,call}=await fixture(t);bridge.cached.call={id:'live-call'};assert.equal((await call('updates/install-lease')).status,409);bridge.cached.call=null;bridge.refreshFailure=true;assert.equal((await call('updates/install-lease')).status,409);bridge.refreshFailure=false;assert.equal((await call('updates/install-lease')).status,200);
});
test('lease waits out an older pending poll and requests a new authoritative state before allowing restart',{timeout:10000},async t=>{
 const {bridge,call}=await fixture(t);let finish,noticed,waited=false;const oldPoll=new Promise(resolve=>finish=resolve),observed=new Promise(resolve=>noticed=resolve);Object.defineProperty(bridge,'refreshing',{get(){noticed();return oldPoll;}});t.after(()=>finish());bridge.refresh=async force=>{assert.equal(force,true);assert.equal(waited,true);bridge.cached.call={id:'call-observed-after-old-poll'};bridge.emit('state',bridge.cached);return bridge.cached;};
 const pending=call('updates/install-lease');await observed;waited=true;finish();assert.equal((await pending).status,409);
});
