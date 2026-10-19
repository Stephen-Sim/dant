import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {MAX_MESSAGE_ATTACHMENTS} from '../src/attachments.mjs';

const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});
const file=index=>({id:`10000000-0000-4000-8000-${String(index).padStart(12,'0')}`,name:`file-${index}.png`,type:'image/png'});
function fixture(t){const directory=fs.mkdtempSync(path.join(root,'read-attachments-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,store:new Store(directory)};}
const seen=(store,message,ids)=>store.markVisible([message.id],{[message.id]:ids});

test('observed attachment receipts persist exact bounded IDs and survive restart without changing task state',t=>{
 const {directory,store}=fixture(t),first=file(1),second=file(2),message=store.add({role:'assistant',text:'Results',status:'completed',attachments:[first,second]}),task=store.add({role:'user',text:'Task',status:'review'});
 store.addCompletion({turnId:'result-turn',messageIds:[message.id],taskId:task.id});
 store.markVisible([message.id,task.id],{[message.id]:[first.id,second.id,first.id,'invalid',file(99).id]});
 assert.equal(message.read,true);assert.deepEqual(message.visibleAttachmentIds,[first.id,second.id]);assert.ok(message.visibleAt);assert.equal(task.read,false);assert.equal(task.status,'review');assert.ok(store.state.completions[0].readAt);
 const saved=JSON.parse(fs.readFileSync(store.file,'utf8')).messages.find(item=>item.id===message.id);assert.deepEqual(saved.visibleAttachmentIds,[first.id,second.id]);
 const restored=new Store(directory).state.messages.find(item=>item.id===message.id);assert.equal(restored.read,true);assert.equal(restored.visibleAt,message.visibleAt);assert.deepEqual(restored.visibleAttachmentIds,[first.id,second.id]);
});

test('appending a new attachment makes an observed message unread while preserving the already viewed file receipt',t=>{
 const {directory,store}=fixture(t),first=file(1),second=file(2),message=store.add({role:'assistant',text:'First result',status:'completed',attachments:[first]});
 seen(store,message,[first.id]);const firstVisibleAt=message.visibleAt;
 store.update(message.id,{attachments:[first,second]});assert.equal(message.read,false);assert.equal(message.visibleAt,firstVisibleAt);assert.deepEqual(message.visibleAttachmentIds,[first.id]);assert.equal(message.status,'completed');
 const restarted=new Store(directory),restored=restarted.state.messages.find(item=>item.id===message.id);assert.equal(restored.read,false);assert.deepEqual(restored.visibleAttachmentIds,[first.id]);
 seen(restarted,restored,[first.id,second.id]);assert.equal(restored.read,true);assert.deepEqual(restored.visibleAttachmentIds,[first.id,second.id]);
});

test('a receipt for old text or an older attachment snapshot cannot acknowledge an image appended while the receipt was in flight',t=>{
 const {store}=fixture(t),first=file(1),second=file(2),message=store.add({role:'assistant',text:'Text first',status:'completed'});
 store.markVisible([message.id],{[message.id]:[]});assert.equal(message.read,true);
 store.update(message.id,{attachments:[first]});store.markVisible([message.id],{[message.id]:[]});assert.equal(message.read,false);assert.deepEqual(message.visibleAttachmentIds,[]);
 seen(store,message,[first.id]);store.update(message.id,{attachments:[first,second]});seen(store,message,[first.id]);assert.equal(message.read,false);assert.deepEqual(message.visibleAttachmentIds,[first.id]);
 seen(store,message,[second.id]);assert.equal(message.read,true);assert.deepEqual(message.visibleAttachmentIds,[first.id,second.id]);
});

test('status, reaction, marker, duplicate or reordered attachment updates never create a new unread event',t=>{
 const {store}=fixture(t),first=file(1),second=file(2),message=store.add({role:'assistant',text:'Result',status:'completed',attachments:[first,second]});seen(store,message,[first.id,second.id]);
 for(const patch of [{status:'completed'},{reactions:['👍']},{telegramMirror:{text:'scheduled'}},{attachments:[second,first,first]},{attachments:[first,{...second,name:'renamed.png'}]},{attachments:[first,second,{id:'invalid'}]}]){store.update(message.id,patch);assert.equal(message.read,true);assert.deepEqual(message.visibleAttachmentIds,[first.id,second.id]);}
 const user=store.add({role:'user',text:'Original',status:'review',read:true,attachments:[first]});store.update(user.id,{attachments:[first,second]});assert.equal(user.read,true);assert.equal(user.status,'review');
});

test('legacy receipts retain text and label read compatibility without inventing viewed attachment IDs',t=>{
 const {directory,store}=fixture(t),plain=store.add({role:'assistant',text:'Text',status:'completed'}),image=store.add({role:'assistant',text:'Image',status:'completed',attachments:[file(1)]}),historical=store.add({role:'assistant',text:'Previously read',status:'completed',read:true,attachments:[file(2)]});
 const restored=new Store(directory);assert.equal(restored.state.messages.find(m=>m.id===historical.id).read,true);assert.equal(Object.hasOwn(restored.state.messages.find(m=>m.id===historical.id),'visibleAttachmentIds'),false);
 store.markVisible([plain.id,image.id,historical.id]);for(const message of [plain,image,historical]){assert.equal(message.read,true);assert.ok(message.visibleAt);assert.equal(Object.hasOwn(message,'visibleAttachmentIds'),false);}
 const reopened=new Store(directory);for(const message of reopened.state.messages){assert.equal(message.read,true);assert.equal(Object.hasOwn(message,'visibleAttachmentIds'),false);}
 store.update(plain.id,{attachments:[file(3)]});assert.equal(plain.read,false);assert.deepEqual(plain.visibleAttachmentIds,[]);seen(store,plain,[]);assert.equal(plain.read,false);seen(store,plain,[file(3).id]);assert.equal(plain.read,true);
 const first=file(4),second=file(5),current=store.add({role:'assistant',text:'Known file',status:'completed',attachments:[first]});seen(store,current,[first.id]);store.update(current.id,{attachments:[first,second]});store.markVisible([current.id]);assert.equal(current.read,true);assert.deepEqual(current.visibleAttachmentIds,[first.id]);
});

test('invalid, inherited or cross-message snapshots cannot forge attachment visibility, and persisted receipts are bounded',t=>{
 const {directory,store}=fixture(t),files=Array.from({length:MAX_MESSAGE_ATTACHMENTS+3},(_,index)=>file(index+1)),message=store.add({role:'assistant',text:'Files',status:'completed',attachments:files.slice(0,MAX_MESSAGE_ATTACHMENTS)}),other=store.add({role:'assistant',text:'Other',status:'completed',attachments:[file(99)]});
 const inherited=Object.create({[message.id]:files.map(item=>item.id)});store.markVisible([message.id],inherited);assert.equal(message.read,false);assert.deepEqual(message.visibleAttachmentIds,[]);
 store.markVisible([message.id],{[message.id]:null,[other.id]:[file(99).id]});assert.equal(other.read,false);assert.equal(Object.hasOwn(other,'visibleAttachmentIds'),false);
 store.markVisible([message.id],{[message.id]:[...files.map(item=>item.id),...files.map(item=>item.id),'invalid']});assert.equal(message.read,true);assert.equal(message.visibleAttachmentIds.length,MAX_MESSAGE_ATTACHMENTS);
 message.visibleAttachmentIds=[...files.map(item=>item.id),null,'invalid',...files.map(item=>item.id)];store.save();const reopened=new Store(directory).state.messages.find(m=>m.id===message.id);assert.deepEqual(reopened.visibleAttachmentIds,files.slice(0,MAX_MESSAGE_ATTACHMENTS).map(item=>item.id));assert.equal(reopened.read,true);
});
