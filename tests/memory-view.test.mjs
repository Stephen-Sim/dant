import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {MemoryStore} from '../src/memory.mjs';
import {DANT_IDENTITY_INSTRUCTIONS} from '../src/identity.mjs';
import {currentMemoryView} from '../src/memory-view.mjs';
import {createWorkerApp} from '../src/server.mjs';

const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const directory=t=>{const dir=fs.mkdtempSync(path.join(base,'memory-view-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};

test('read-only memory view returns the actual shared persona and exact effective redacted durable context',t=>{
 const dir=directory(t),memory=new MemoryStore(dir);memory.write('identity.md','Preference: Chinese.\nBearer fake_private_token_for_memory_only');memory.write('working-memory.md','Current project: PRIVATE_VAULT_VALUE');fs.writeFileSync(path.join(dir,'private-auth.json'),'PRIVATE_CONFIG_MUST_NOT_BE_READ');
 const before=Object.fromEntries(memory.snapshot().map(file=>[file.name,fs.readFileSync(memory.file(file.name))])),engine={store:{state:{conversationId:'current'}},memory,redact:text=>text.replaceAll('PRIVATE_VAULT_VALUE','[redacted]')},result=currentMemoryView(engine);
 assert.deepEqual(result,{conversationId:'current',readOnly:true,identity:{text:DANT_IDENTITY_INSTRUCTIONS},memory:{text:engine.redact(memory.context())}});assert.match(result.memory.text,/Preference: Chinese/);assert.match(result.memory.text,/identity.md/);assert.match(result.memory.text,/working-memory.md/);assert.doesNotMatch(JSON.stringify(result),/fake_private_token|PRIVATE_VAULT_VALUE|PRIVATE_CONFIG/);
 for(const [name,bytes]of Object.entries(before))assert.deepEqual(fs.readFileSync(memory.file(name)),bytes);
});

test('memory view API is authenticated and read-only without running or modifying tasks',async t=>{
 const dir=directory(t);class Worker extends EventEmitter{constructor(){super();this.status='offline';this.calls=[];this.rpc={reply(){},send(){}};}request(method){this.calls.push(method);throw Error('No VM operation expected');}disconnect(){}}
 class Provider extends EventEmitter{constructor(){super();this.state={available:false};}ownsEvent(){return false;}async close(){}}
 const worker=new Worker(),instance=createWorkerApp({dataDir:dir,workerFactory:()=>worker,voiceFactory:()=>new Provider(),nativeVoiceFactory:()=>new Provider()});t.after(()=>instance.close());instance.engine.memory.write('identity.md','Actual personality preference');instance.engine.memory.write('working-memory.md','Actual durable project');const before=fs.readFileSync(instance.store.file);await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const root='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(root+'/api/session').then(response=>response.json()),headers={'X-Dant-Token':token};
 assert.equal((await fetch(root+'/api/memory/view')).status,401);assert.equal((await fetch(root+'/api/memory/view',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
 const response=await fetch(root+'/api/memory/view?name=private-auth.json',{headers}),body=await response.json();assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(body.identity.text,DANT_IDENTITY_INSTRUCTIONS);assert.match(body.memory.text,/Actual personality preference/);assert.match(body.memory.text,/Actual durable project/);assert.deepEqual(Object.keys(body).sort(),['conversationId','identity','memory','readOnly']);
 for(const method of ['POST','PATCH','DELETE'])assert.equal((await fetch(root+'/api/memory/view',{method,headers})).status,405);assert.deepEqual(fs.readFileSync(instance.store.file),before);assert.deepEqual(worker.calls,[]);
 instance.engine.memory.context=()=>{throw Error('PRIVATE_PATH_AND_TOKEN');};const failed=await fetch(root+'/api/memory/view',{headers});assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/PRIVATE_PATH_AND_TOKEN/);
});
