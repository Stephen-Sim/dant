import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine,dynamicTools} from '../src/engine.mjs';
import {CredentialVault,CredentialRequests} from '../src/credentials.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-credential-engine-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),worker=new EventEmitter();worker.status='offline';worker.rpc={send(){}};worker.request=async()=>({});
 const credentials=new CredentialRequests({vault:new CredentialVault({dataDir:dir}),timeoutMs:10000}),engine=new Engine(store,worker,{credentials});t.after(()=>credentials.close());
 const message=store.add({role:'user',text:'Sign in to the requested service',status:'running'});
 const active={threadId:'thread',turnId:'turn',startAcknowledged:true,messageId:message.id,messageIds:[message.id],assistantIds:[],outputs:new Map(),resolveStopped(){}};engine.active=active;
 return {dir,store,worker,engine,credentials,message,active};
}

test('vault model tools require accepted live ownership and expose secrets only to explicit get results',async t=>{
 const {store,engine,credentials,active}=fixture(t);engine.active=null;
 for(const name of ['credential_find','credential_get','credential_store','credential_request'])await assert.rejects(engine.tool(name,{}),/accepted active task/);
 engine.active=active;const secret='test-only-never-chat-secret',saved=await engine.tool('credential_store',{name:'Test account',service:'example.test',username:'user',secret});
 assert.equal(JSON.stringify(saved).includes(secret),false);const found=await engine.tool('credential_find',{query:'example'});assert.equal(found.length,1);assert.equal(JSON.stringify(found).includes(secret),false);
 const value=await engine.tool('credential_get',{id:saved.id});assert.equal(value.secret,secret);assert.equal(JSON.stringify(store.state).includes(secret),false);assert.equal(JSON.stringify(credentials.snapshot()).includes(secret),false);
 for(const name of ['credential_find','credential_get','credential_store','credential_request'])assert.ok(dynamicTools.some(tool=>tool.name===name));assert.match(engine.instructions(),/separate secure form/);assert.match(engine.instructions(),/Never echo or log secrets/);
 await assert.rejects(engine.tool('credential_get',{id:saved.id},{owner:'old-call',isCurrent:()=>false}),/no longer belongs/);
});

test('secure form waits in waiting_user, resolves metadata and restores only its live task',async t=>{
 const {store,engine,credentials,message}=fixture(t),pending=engine.tool('credential_request',{name:'Requested API',service:'api.example',reason:'Run the authorized API request'});await tick();
 assert.equal(message.status,'waiting_user');const request=credentials.snapshot().requests[0];assert.equal(request.name,'Requested API');assert.equal(store.state.messages.length,1);
 credentials.fulfill(request.id,{username:'account',secret:'form-only-secret'});const result=await pending;assert.equal(result.stored,true);assert.equal(message.status,'running');assert.equal(JSON.stringify(result).includes('form-only-secret'),false);assert.equal(JSON.stringify(store.state).includes('form-only-secret'),false);
});

test('parallel secure forms keep the task waiting until the last current request resolves',async t=>{
 const {engine,credentials,message}=fixture(t),first=engine.tool('credential_request',{name:'One'}),second=engine.tool('credential_request',{name:'Two'});await tick();
 const [a,b]=credentials.snapshot().requests;credentials.fulfill(a.id,{secret:'one'});await first;assert.equal(message.status,'waiting_user');credentials.fulfill(b.id,{secret:'two'});await second;assert.equal(message.status,'running');
});

test('interrupt cancels owned secure forms and late completion cannot revive an old task',async t=>{
 const {engine,credentials,message,active}=fixture(t),result=engine.tool('credential_request',{name:'Old credential'}).then(()=>null,error=>error);await tick();
 await engine.interrupt(active);assert.match((await result).message,/cancelled/);assert.equal(message.status,'pausing');assert.equal(credentials.snapshot().requests.length,0);
 const newMessage=engine.store.add({role:'user',text:'New work',status:'running'}),old=active;engine.active={...active,turnId:'new-turn',messageId:newMessage.id,messageIds:[newMessage.id],stopRequested:false};old.stopRequested=false;
 assert.equal(newMessage.status,'running');await assert.rejects(engine.tool('credential_request',{name:'Stale'}, {owner:old.turnId,isCurrent:()=>engine.active===old}),/no longer belongs/);
});

test('completion cancels forms and explicit voice scope cancels without writing chat',async t=>{
 const {engine,credentials,message,active}=fixture(t),pending=engine.tool('credential_request',{name:'Task form'}).then(()=>null,error=>error);await tick();
 await engine.finish('completed');assert.match((await pending).message,/cancelled/);assert.equal(message.status,'review');assert.equal(credentials.snapshot().requests.length,0);
 let current=true;const voice=engine.tool('credential_request',{name:'Call form'},{owner:'call-owned',isCurrent:()=>current}).then(()=>null,error=>error);await tick();assert.equal(credentials.snapshot().requests.length,1);current=false;engine.cancelCredentials('call-owned');assert.match((await voice).message,/cancelled/);assert.equal(message.status,'review');
});

test('known vault secrets are redacted from assistant output and cannot be copied into memory',async t=>{
 const {engine,credentials,store,active}=fixture(t),secret='test-only-vault-token';const saved=credentials.upsert({name:'Token',secret});
 const text=engine.output(active,'answer','The token is '+secret);assert.equal(text.includes(secret),false);assert.match(text,/credential redacted/);
 const delivered=engine.deliverText('Saved credential '+secret);assert.equal(engine.task(delivered.messageId).text.includes(secret),false);
 await assert.rejects(engine.tool('memory_write',{text:'Remember '+secret}),/encrypted vault/);assert.equal(store.state.memory,'');assert.equal(JSON.stringify(store.state).includes(secret),false);
 assert.equal((await engine.tool('credential_get',{id:saved.id})).secret,secret,'The explicit credential tool result remains usable by the model');
});
