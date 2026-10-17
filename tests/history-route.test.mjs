import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createWorkerApp} from '../src/server.mjs';
import {AttachmentStore} from '../src/attachments.mjs';

const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});
async function setup(t){
 const dataDir=fs.mkdtempSync(path.join(root,'history-route-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
 class Worker extends EventEmitter{constructor(){super();this.status='online';this.calls=[];}async request(method,params){this.calls.push({method,params});return {};}disconnect(){this.status='offline';}}
 class Provider extends EventEmitter{constructor(){super();this.state={available:true};}async close(){}}
 const worker=new Worker(),instance=createWorkerApp({dataDir,workerFactory:()=>worker,voiceFactory:()=>new Provider(),nativeVoiceFactory:()=>new Provider()});t.after(()=>{instance.engine.active=null;return instance.close();});
 const enqueued=[];instance.engine.enqueue=message=>{enqueued.push(message);instance.engine.queue.push(message);};
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(base+'/api/session').then(response=>response.json());
 const request=(route,{method='GET',body}={})=>fetch(base+'/api'+route,{method,headers:{'X-Dant-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {instance,worker,request,enqueued};
}

test('history HTTP editing preserves identity and model context and resubmits only on explicit request',async t=>{
 const h=await setup(t),{store,engine}=h.instance,conversationId=store.state.conversationId;store.state.threadId='old-thread';store.state.threadRuntime='same-vm';store.state.threadConversationId=conversationId;engine.loaded=true;
 const message=store.add({role:'user',text:'Original',status:'review',clientMessageId:'795dd577-ecb1-4b0c-bb1e-1d04d086d9f6'}),edited=await h.request('/messages/'+message.id,{method:'PATCH',body:{text:'Edited draft'}});assert.equal(edited.status,200);const result=await edited.json();assert.equal(result.edited,true);assert.equal(result.message.id,message.id);assert.equal(result.message.text,'Edited draft');assert.equal(result.resubmitted,false);assert.equal(h.enqueued.length,0);assert.equal(store.state.threadId,'old-thread');assert.equal(engine.loaded,true);assert.equal(store.state.conversationId,conversationId);
 const submit=await h.request('/messages/'+message.id,{method:'PATCH',body:{text:'Explicitly submit this edit',resubmit:true}});assert.equal(submit.status,200);assert.equal((await submit.json()).resubmitted,true);assert.equal(h.enqueued.length,1);assert.equal(h.enqueued[0].id,message.id);assert.equal(h.worker.calls.length,0);
});

test('authenticated long history edits preserve the complete text and explicit resubmission while retaining the HTTP body guard',async t=>{
 const h=await setup(t),{store,engine}=h.instance,text='中文😀'.repeat(30000)+'LONG_HTTP_EDIT_TAIL',message=store.add({role:'user',text,status:'review'}),conversationId=store.state.conversationId;store.state.threadId='long-edit-thread';engine.loaded=true;assert.ok(text.length>100000);
 const saved=await h.request('/messages/'+message.id,{method:'PATCH',body:{text:text+' saved'}});assert.equal(saved.status,200);assert.equal((await saved.json()).message.text,text+' saved');assert.equal(h.enqueued.length,0);assert.equal(store.state.threadId,'long-edit-thread');assert.equal(store.state.conversationId,conversationId);assert.equal(engine.loaded,true);
 const resent=await h.request('/messages/'+message.id,{method:'PATCH',body:{text:text+' resent',resubmit:true}});assert.equal(resent.status,200);assert.equal((await resent.json()).resubmitted,true);assert.equal(h.enqueued.length,1);assert.equal(h.enqueued[0].id,message.id);assert.equal(h.enqueued[0].text,text+' resent');
 const tooLarge=await h.request('/messages/'+message.id,{method:'PATCH',body:{text:'x'.repeat(2*1024*1024),resubmit:true}});assert.equal(tooLarge.status,413);assert.equal(h.enqueued.length,1);assert.equal(store.state.messages[0].text,text+' resent');assert.equal(store.state.threadId,'long-edit-thread');assert.equal(h.worker.calls.length,0);
});

test('history routes refuse malformed changes and preserve messages and threads atomically',async t=>{
 const h=await setup(t),{store}=h.instance,message=store.add({role:'user',text:'Keep this',status:'review'});store.state.threadId='thread-to-preserve';store.save();
 for(const body of [{text:'Edited',resubmit:'yes'},{text:'Edited',attachments:[]},{text:2},{text:''},[]]){const response=await h.request('/messages/'+message.id,{method:'PATCH',body});assert.equal(response.status,400);assert.equal(message.text,'Keep this');assert.equal(store.state.threadId,'thread-to-preserve');}
 assert.equal((await h.request('/messages/missing',{method:'PATCH',body:{text:'Text'}})).status,404);assert.equal((await h.request('/messages/missing',{method:'DELETE'})).status,404);assert.equal(h.enqueued.length,0);
});

test('busy work and calls prevent historical edits, deletes and clear without stopping their executors',async t=>{
 const h=await setup(t),{store,engine}=h.instance,message=store.add({role:'user',text:'Historical message',status:'review'});
 for(const kind of ['active','call']){
  if(kind==='active')engine.active={messageId:'other-user-task',turnId:'other-turn',startAcknowledged:true};else engine.call={id:'user-call',provider:'api'};
  assert.equal((await h.request('/messages/'+message.id,{method:'PATCH',body:{text:'Changed'}})).status,409);assert.equal((await h.request('/messages/'+message.id,{method:'DELETE'})).status,409);assert.equal((await h.request('/history',{method:'DELETE',body:{confirm:true}})).status,409);assert.equal(store.state.messages[0].text,'Historical message');assert.equal(h.worker.calls.length,0);
  engine.active=null;engine.call=null;
 }
});

test('retracting an unsubmitted queued task leaves unrelated active work and its thread intact',async t=>{
 const h=await setup(t),{store,engine}=h.instance;store.state.threadId='busy-thread';const queued=store.add({role:'user',text:'Withdraw before execution',status:'queued'});engine.queue.push(queued);engine.active={messageId:'other-user-task',turnId:'other-turn',messageIds:['other-user-task'],startAcknowledged:true};
 const response=await h.request('/messages/'+queued.id,{method:'DELETE'});assert.equal(response.status,200);const result=await response.json();assert.equal(result.withdrawn,true);assert.equal(result.id,queued.id);assert.equal(engine.queue.length,0);assert.equal(engine.active.turnId,'other-turn');assert.equal(store.state.threadId,'busy-thread');assert.equal(store.state.messages.some(message=>message.id===queued.id),false);assert.equal(h.worker.calls.length,0);
});

test('history clear needs exact confirmation and preserves workspace, memory, skills, attachments and vault',async t=>{
 const h=await setup(t),{store,engine}=h.instance,conversationId=store.state.conversationId,workspace=engine.workspace,attachments=new AttachmentStore(path.join(store.dir,'attachments')),attachment=attachments.put({name:'kept.txt',type:'text/plain',data:Buffer.from('Existing attachment.')});store.state.threadId='retained-model-context';store.state.threadRuntime='retained-runtime';engine.loaded=true;store.add({role:'user',text:'A prior request',status:'completed'});store.add({role:'assistant',text:'A prior response',attachments:[attachment]});
 h.instance.engine.memory.write('working-memory.md','Keep this durable preference.');const credential=h.instance.credentials.upsert({name:'Retained vault item',secret:'retained-private-test-value'}),skill=h.instance.skills.save({name:'retained-skill',description:'Keep a managed skill',instructions:'Reusable instructions'});const file=path.join(workspace,'output','retained.txt');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'Existing artifact.');
 for(const body of [undefined,{}, {confirm:false},{confirm:'true'}]){const response=await h.request('/history',{method:'DELETE',body});assert.equal(response.status,400);assert.equal(store.state.messages.length,2);}
 const response=await h.request('/history',{method:'DELETE',body:{confirm:true}});assert.equal(response.status,200);const result=await response.json();assert.equal(result.cleared,true);assert.equal(result.count,2);assert.deepEqual(store.state.messages,[]);assert.equal(store.state.conversationId,conversationId);assert.equal(store.state.threadId,'retained-model-context');assert.equal(store.state.threadRuntime,'retained-runtime');assert.equal(engine.loaded,true);assert.equal(engine.workspace,workspace);assert.equal(engine.memory.read('working-memory.md'),'Keep this durable preference.');assert.equal(h.instance.credentials.get(credential.id).secret,'retained-private-test-value');assert.equal(h.instance.skills.get('retained-skill').path,skill.path);assert.equal(fs.readFileSync(file,'utf8'),'Existing artifact.');assert.equal(attachments.read(attachment.id).data.toString(),'Existing attachment.');assert.equal(h.enqueued.length,0);assert.equal(h.worker.calls.length,0);
});

test('deleted and cleared client IDs cannot be replayed through ordinary or native message routes',async t=>{
 const h=await setup(t),{store,engine}=h.instance,deletedId='5841a035-7e1c-4c35-9083-2be61ed83a89',clearedId='ab924dc3-b22e-4f48-9dbe-9345d5050dad';
 const first=store.add({role:'user',text:'Deleted request',status:'review',clientMessageId:deletedId});assert.equal((await h.request('/messages/'+first.id,{method:'DELETE'})).status,200);
 store.add({role:'user',text:'Cleared request',status:'review',clientMessageId:clearedId});assert.equal((await h.request('/history',{method:'DELETE',body:{confirm:true}})).status,200);
 for(const clientMessageId of [deletedId,clearedId]){const response=await h.request('/messages',{method:'POST',body:{text:'Do not restart this request',clientMessageId}});assert.equal(response.status,409);assert.match((await response.json()).error,/withdrawn or deleted/);}
 let nativeCalls=0;h.instance.nativeVoice.message=async()=>{nativeCalls++;};engine.call={id:'active-native',provider:'subscription'};
 for(const clientMessageId of [deletedId,clearedId])assert.equal((await h.request('/realtime/message',{method:'POST',body:{callId:'active-native',clientMessageId,text:'Do not restart'}})).status,409);
 assert.equal(nativeCalls,0);assert.equal(h.enqueued.length,0);assert.deepEqual(store.state.messages,[]);assert.equal(h.worker.calls.length,0);
});
