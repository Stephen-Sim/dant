import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createWorkerApp} from '../src/server.mjs';
import {AttachmentStore} from '../src/attachments.mjs';
import {Store} from '../src/store.mjs';
import {TelegramGateway} from '../src/telegram.mjs';

const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=','base64');
class Worker extends EventEmitter{constructor(dir){super();this.status='online';this.calls=[];this.workspaceRoot=path.join(dir,'workspaces');this.rpc={reply(){},send(){}};}async request(method,params){this.calls.push({method,params});throw Error('Recovery must not call the model');}disconnect(){this.status='offline';}}
async function fixture(t,{telegram=false,forwardMode='all'}={}){
 const dir=fs.mkdtempSync(path.join(base,'output-link-recovery-')),worker=new Worker(dir),sent=[];
 const fetchImpl=async(url,options)=>{const method=new URL(url).pathname.split('/').at(-1);if(['sendMessage','sendPhoto','sendDocument'].includes(method))sent.push({method,body:options.body});return Response.json({ok:true,result:method==='getMe'?{id:123456,is_bot:true,username:'fixture_bot'}:method==='getWebhookInfo'?{url:''}:{message_id:sent.length+1}});};
 const instance=createWorkerApp({dataDir:dir,workerFactory:()=>worker,telegramFactory:options=>new TelegramGateway({...options,fetchImpl,autoPoll:false,mirrorGraceMs:0}),audioTranscriberFactory:()=>({close(){}})});
 t.after(async()=>{instance.engine.active=null;instance.engine.call=null;await instance.close();assert.equal(path.dirname(path.resolve(dir)),base);fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(url+'/api/session').then(response=>response.json());
 const api=(route,body,authorized=true)=>fetch(url+'/api'+route,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Dant-Token':token}:{})},body:JSON.stringify(body)});
 const file=path.join(instance.engine.outputDir,'combo-v2-result-a.png');fs.mkdirSync(instance.engine.outputDir,{recursive:true});fs.writeFileSync(file,png);
 if(telegram){await instance.telegram.configure({token:'123456:abcdefghijklmnopqrstuvwxyz_123456789',enabled:true,forwardMode,combineReplies:false});const pairing=await instance.telegram.pair();await instance.telegram.receive({update_id:1,message:{message_id:1,chat:{id:11,type:'private'},from:{id:11,is_bot:false},text:'/start '+pairing.code}});await instance.telegram.flush();sent.length=0;}
 const href=file.replaceAll('\\','/'),message=instance.store.add({role:'assistant',text:`Your saved screenshot: [View screenshot](${href})`,status:'completed',read:true,readAt:123,time:100});
 const resolve=(body={},id=message.id)=>api('/messages/'+encodeURIComponent(id)+'/output-link/resolve',{conversationId:instance.store.state.conversationId,href,...body});
 return {...instance,dir,worker,file,href,message,resolve,api,url,token,sent};
}

test('authenticated recovery restores one saved assistant link beyond the directory scan limit without model work or chat replay',async t=>{
 const f=await fixture(t);for(let index=0;index<620;index++)fs.writeFileSync(path.join(f.engine.outputDir,'unrelated-'+index+'.txt'),'unrelated');
 f.engine.call={id:'existing-call',provider:'subscription',status:'connected'};f.engine.active={turnId:'existing-work',messageIds:[]};const call=f.engine.call,active=f.engine.active,before=structuredClone(f.store.state);const response=await f.resolve();assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.messageId,f.message.id);assert.equal(result.conversationId,before.conversationId);assert.equal(result.restoredSnapshot,true);assert.equal(result.reused,false);assert.equal(result.attachment.sourcePath,f.file);assert.equal(result.attachment.type,'image/png');assert.deepEqual(new AttachmentStore(path.join(f.dir,'attachments')).read(result.attachment.id).data,png);assert.equal(f.store.state.messages.length,before.messages.length);assert.equal(f.message.time,100);assert.equal(f.message.read,false);assert.deepEqual(f.message.visibleAttachmentIds,[]);assert.equal(f.message.readAt,123);assert.equal(f.message.text,before.messages[0].text);assert.deepEqual(f.store.state.completions,before.completions);assert.deepEqual(f.store.state.workTasks,before.workTasks);assert.deepEqual(f.store.state.schedules,before.schedules);assert.equal(f.engine.call,call);assert.equal(f.engine.active,active);assert.deepEqual(f.worker.calls,[]);assert.equal(new Store(f.dir).state.messages[0].attachments[0].id,result.attachment.id);
 const fileResponse=await fetch(f.url+'/api/files/'+result.attachment.id,{headers:{'X-Dant-Token':f.token}});assert.equal(fileResponse.status,200);assert.equal(fileResponse.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()),png);
 const read=await f.api('/read',{ids:[f.message.id],attachmentSnapshots:{[f.message.id]:[result.attachment.id]}});assert.equal(read.status,200);assert.equal(f.message.read,true);assert.deepEqual(f.message.visibleAttachmentIds,[result.attachment.id]);assert.equal(f.message.time,100);assert.equal(f.message.readAt,123);
});

test('repeated, concurrent and restarted recovery reuses the exact same immutable source snapshot',async t=>{
 const f=await fixture(t),responses=await Promise.all([f.resolve(),f.resolve(),f.resolve()]),results=await Promise.all(responses.map(response=>response.json()));assert.ok(responses.every(response=>response.status===200));assert.equal(new Set(results.map(result=>result.attachment.id)).size,1);assert.equal(f.message.attachments.length,1);assert.equal(fs.readdirSync(path.join(f.dir,'attachments')).length,2);
 fs.writeFileSync(f.file,Buffer.concat([png,Buffer.from('changed current output')]));let result=await f.resolve().then(response=>response.json());assert.equal(result.reused,true);assert.equal(result.attachment.id,results[0].attachment.id);assert.deepEqual(new AttachmentStore(path.join(f.dir,'attachments')).read(result.attachment.id).data,png);
 fs.unlinkSync(f.file);result=await f.resolve().then(response=>response.json());assert.equal(result.attachment.id,results[0].attachment.id,'an archived original remains available after its source disappears');assert.equal(new Store(f.dir).state.messages[0].attachments.length,1);assert.deepEqual(f.worker.calls,[]);
});

test('only an exact saved assistant Markdown reference in the current conversation can nominate recovery',async t=>{
 const f=await fixture(t),other=path.join(f.engine.outputDir,'another.png');fs.writeFileSync(other,png);const human=f.store.add({role:'user',text:`[file](${f.href})`}),inline=f.store.add({role:'assistant',text:'`[file]('+f.href+')`'}),html=f.store.add({role:'assistant',text:'<a href="'+f.href+'">file</a>'});
 const responses=[await f.resolve({conversationId:'different'}),await f.resolve({href:other.replaceAll('\\','/')}),await f.resolve({filePath:f.file}),await f.resolve({},human.id),await f.resolve({},inline.id),await f.resolve({},html.id),await f.resolve({},'missing')];assert.deepEqual(responses.map(response=>response.status),[409,400,400,404,400,400,404]);assert.ok(f.store.state.messages.every(message=>!message.attachments?.length));assert.deepEqual(f.worker.calls,[]);
 const unauthorized=await f.api('/messages/'+f.message.id+'/output-link/resolve',{conversationId:f.store.state.conversationId,href:f.href},false);assert.equal(unauthorized.status,401);
});

test('referenced outside, sensitive, symbolic and hard-linked files stay unavailable without path disclosure',async t=>{
 const f=await fixture(t),outside=path.join(f.dir,'outside.png'),secret=path.join(f.engine.outputDir,'secret-token.png'),original=path.join(f.engine.outputDir,'original.png'),hard=path.join(f.engine.outputDir,'hard.png'),symbolic=path.join(f.engine.outputDir,'symbolic.png');for(const file of [outside,secret,original])fs.writeFileSync(file,png);fs.linkSync(original,hard);fs.symlinkSync(outside,symbolic,'file');
 for(const file of [outside,secret,hard,symbolic,path.join(f.engine.outputDir,'missing.png')]){const href=file.replaceAll('\\','/');f.message.text=`[file](${href})`;f.store.save();const response=await f.resolve({href});assert.equal(response.status,404);const body=await response.json();assert.equal(body.error,'The referenced output file is missing, restricted or unavailable.');assert.equal(JSON.stringify(body).includes(file),false);}
 assert.equal(f.message.attachments,undefined);assert.deepEqual(f.worker.calls,[]);
});

test('the five-file cap is checked before reading and never borrows a same-named attachment from another message',async t=>{
 const f=await fixture(t),other=new AttachmentStore(path.join(f.dir,'attachments')).put({name:path.basename(f.file),data:png});f.store.add({role:'assistant',text:'Other message',attachments:[{...other,sourcePath:path.join(f.dir,'different-output',path.basename(f.file))}]});
 const result=await f.resolve().then(response=>response.json());assert.notEqual(result.attachment.id,other.id);assert.equal(result.attachment.sourcePath,f.file);
 const second=f.store.add({role:'assistant',text:f.message.text,attachments:Array.from({length:5},(_,i)=>({id:'already-'+i,name:'existing-'+i+'.txt'}))});const response=await f.resolve({},second.id);assert.equal(response.status,409);assert.equal(second.attachments.length,5);assert.equal(f.store.state.messages.length,3);
});

test('URI decoding happens once and rendered percent-encoded Markdown targets still recover the exact stored filename',async t=>{
 const f=await fixture(t);
 for(const [name,storedHref,clickedHref]of [['100%20.png','output/100%2520.png','output/100%2520.png'],['a b.png','output/a b.png','output/a%20b.png'],['截图.png','output/截图.png','output/%E6%88%AA%E5%9B%BE.png']]){
  fs.writeFileSync(path.join(f.engine.outputDir,name),png);const message=f.store.add({role:'assistant',text:`[result](<${storedHref}>)`}),response=await f.resolve({href:clickedHref},message.id);assert.equal(response.status,200);const value=await response.json();assert.equal(value.attachment.sourcePath,path.join(f.engine.outputDir,name));assert.equal(value.attachment.name,name);
 }
});

test('a failed Store commit rolls back the message and leaves chat, receipts and task state unchanged for a safe retry',async t=>{
 const f=await fixture(t),before=structuredClone(f.store.state),bytes=fs.readFileSync(f.store.file),save=f.store.save;f.store.save=()=>{throw Error('private filesystem exception path');};
 const response=await f.resolve();assert.equal(response.status,500);assert.equal((await response.json()).error,'The output snapshot could not be saved. Try again after checking storage.');assert.deepEqual(f.store.state,before);assert.deepEqual(fs.readFileSync(f.store.file),bytes);f.store.save=save;
 const result=await f.resolve().then(response=>response.json());assert.ok(result.attachment.id);assert.equal(f.message.attachments.length,1);assert.deepEqual(f.worker.calls,[]);
});

test('legacy recovery adds a Telegram file once without replaying its text or result delivery',async t=>{
 const f=await fixture(t,{telegram:true});await f.telegram.flush();assert.equal(f.sent.filter(item=>item.method==='sendMessage').length,1);f.sent.length=0;const marker=structuredClone(f.message.telegramMirror);
 const first=await f.resolve().then(response=>response.json());await f.telegram.flush();assert.equal(f.sent.filter(item=>item.method==='sendMessage').length,0);assert.equal(f.sent.filter(item=>item.method==='sendPhoto').length,1);assert.equal(f.message.telegramMirror.text,marker.text);assert.deepEqual(f.store.state.completions,[]);
 const second=await f.resolve().then(response=>response.json());assert.equal(second.attachment.id,first.attachment.id);await f.telegram.flush();assert.equal(f.sent.filter(item=>item.method==='sendPhoto').length,1);assert.deepEqual(f.worker.calls,[]);
});

test('failed snapshot commits restore existing read receipts and attachment metadata exactly',async t=>{
 const f=await fixture(t),existing=new AttachmentStore(path.join(f.dir,'attachments')).put({name:'seen.txt',data:Buffer.from('Previously visible file')});f.store.update(f.message.id,{attachments:[existing]});f.store.markVisible([f.message.id],{[f.message.id]:[existing.id]});const before=structuredClone(f.store.state),bytes=fs.readFileSync(f.store.file),previousAttachments=f.message.attachments,previousVisible=f.message.visibleAttachmentIds,save=f.store.save;f.store.save=()=>{throw Error('private storage exception');};
 const response=await f.resolve();assert.equal(response.status,500);assert.deepEqual(f.store.state,before);assert.equal(f.message.attachments,previousAttachments);assert.equal(f.message.visibleAttachmentIds,previousVisible);assert.equal(f.message.read,true);assert.deepEqual(fs.readFileSync(f.store.file),bytes);f.store.save=save;
 const result=await f.resolve().then(response=>response.json());assert.equal(f.message.read,false);assert.deepEqual(f.message.visibleAttachmentIds,[existing.id]);assert.equal(f.message.attachments.length,2);assert.equal(f.message.attachments[1].id,result.attachment.id);assert.deepEqual(f.worker.calls,[]);
});

test('unread-only recovery sends the newly recovered image without replaying previously read text',async t=>{
 const f=await fixture(t,{telegram:true,forwardMode:'unread'});await f.telegram.flush();assert.equal(f.sent.length,0);assert.equal(f.message.telegramMirror.text,'suppressed');const result=await f.resolve().then(response=>response.json());assert.equal(f.message.read,false);assert.deepEqual(f.message.visibleAttachmentIds,[]);await f.telegram.flush();assert.equal(f.sent.filter(item=>item.method==='sendMessage').length,0);assert.equal(f.sent.filter(item=>item.method==='sendPhoto').length,1);assert.equal(f.message.telegramMirror.text,'suppressed');
 await f.api('/read',{ids:[f.message.id],attachmentSnapshots:{[f.message.id]:[result.attachment.id]}});assert.equal(f.message.read,true);assert.deepEqual(f.message.visibleAttachmentIds,[result.attachment.id]);const reused=await f.resolve().then(response=>response.json());assert.equal(reused.reused,true);assert.equal(reused.attachment.id,result.attachment.id);await f.telegram.flush();assert.equal(f.sent.filter(item=>item.method==='sendPhoto').length,1);assert.equal(f.sent.filter(item=>item.method==='sendMessage').length,0);assert.deepEqual(f.worker.calls,[]);
});
