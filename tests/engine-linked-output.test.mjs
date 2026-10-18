import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {NativeRealtimeVoice} from '../src/realtime.mjs';
import {AttachmentStore} from '../src/attachments.mjs';
import {DeliverableCollector} from '../src/deliverables.mjs';
import {resolveMessageAttachmentLink} from '../ui/attachment-links.js';

const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=','base64');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Worker extends EventEmitter{
 constructor(dir){super();this.status='online';this.workspaceRoot=path.join(dir,'workspaces');this.calls=[];}
 async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread'}};if(method==='turn/start')return {turn:{id:'turn'}};return {};}
}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(base,'linked-output-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),base);assert.ok(path.basename(dir).startsWith('linked-output-'));fs.rmSync(dir,{recursive:true,force:true});});
 const store=new Store(dir),worker=new Worker(dir),attachments=new AttachmentStore(path.join(dir,'attachments')),collector=new DeliverableCollector(attachments),engine=new Engine(store,worker,{deliverables:collector});
 fs.mkdirSync(engine.outputDir,{recursive:true});const file=path.join(engine.outputDir,'40lines-no-idle-result.png');fs.writeFileSync(file,png);
 engine.enqueue(store.add({role:'user',text:'Send the screenshot'}));await tick();assert.equal(engine.active.startAcknowledged,true);
 const text=`本轮截图：[本轮截图](${file})`,finish=()=>engine.handle({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 return {dir,store,worker,attachments,collector,engine,file,text,finish};
}

test('explicit text delivery archives a linked existing screenshot immediately and only once',async t=>{
 const {store,attachments,engine,file,text,finish}=await fixture(t),unrelated=path.join(engine.outputDir,'unrelated-new.txt');fs.writeFileSync(unrelated,'not requested');
 const result=await engine.tool('send_message',{text}),message=store.state.messages.find(item=>item.id===result.messageId);
 assert.equal(message.text,text);assert.equal(message.attachments.length,1);assert.equal(message.attachments[0].type,'image/png');assert.equal(message.attachments[0].sourcePath,file);assert.deepEqual(attachments.read(message.attachments[0].id).data,png);assert.equal(engine.active.outputs.size,0,'explicit delivery does not invent a model output item');
 assert.deepEqual(result.files,[{id:message.attachments[0].id,name:path.basename(file)}]);assert.equal(store.state.messages[0].status,'running');
 fs.unlinkSync(unrelated);await finish();assert.equal(message.attachments.length,1);assert.equal(store.state.messages.flatMap(item=>item.attachments||[]).length,1);assert.equal(fs.readdirSync(attachments.dir).filter(name=>name.endsWith('.bin')).length,1,'final archival must not leave duplicate immutable snapshots');
});

test('successful dant MCP text receipts archive the referenced old output before final response',async t=>{
 const {store,engine,text,file,finish}=await fixture(t),item={id:'delivery',type:'mcpToolCall',server:'dant_desktop',tool:'send_chat_message',status:'completed',arguments:{text},result:{structuredContent:{dantMessage:{text}}}};
 await engine.acceptMcpResult(item,engine.active);await engine.acceptMcpResult(item,engine.active);
 const messages=store.state.messages.filter(message=>message.role==='assistant');assert.equal(messages.length,1);assert.equal(messages[0].attachments.length,1);assert.equal(messages[0].attachments[0].sourcePath,file);await finish();
});

test('duplicate MCP receipts cannot replay a message while its linked archive is pending',async t=>{
 const {store,collector,engine,text,finish}=await fixture(t),archive=collector.archive.bind(collector);let resolveArchive,calls=0;collector.archive=options=>{calls++;return new Promise(resolve=>{resolveArchive=()=>resolve(archive(options));});};
 const item={id:'delivery',type:'mcpToolCall',server:'dant_desktop',tool:'send_chat_message',status:'completed',arguments:{text},result:{structuredContent:{dantMessage:{text}}}},pending=engine.acceptMcpResult(item,engine.active);
 assert.equal(await engine.acceptMcpResult(item,engine.active),true);assert.equal(calls,1);assert.equal(store.state.messages.filter(message=>message.role==='assistant').length,1);resolveArchive();await pending;collector.archive=archive;await finish();
});

test('native voice send_message uses the same safe immediate linked-file delivery',async t=>{
 const {store,engine,worker,text,file,finish}=await fixture(t),turn={turnId:'native-turn',messageId:'native-request',source:'voice',assistantIds:[],explicitPaths:[]};
 const result=await NativeRealtimeVoice.prototype.tool.call({engine,worker},{},turn,'send_message',{text});
 const message=store.state.messages.find(item=>item.id===result.messageId);assert.equal(message.attachments[0].sourcePath,file);assert.equal(message.source.type,'voice-call');assert.deepEqual(turn.assistantIds,[message.id]);assert.equal(engine.active.assistantIds.length,0);await finish();
});

test('an asynchronous archive attaches to its exact delivered message instead of a later response',async t=>{
 const {store,collector,engine,text,finish}=await fixture(t),archive=collector.archive.bind(collector);let resolveArchive;collector.archive=options=>new Promise(resolve=>{resolveArchive=()=>resolve(archive(options));});
 const pending=engine.tool('send_message',{text}),first=store.state.messages.at(-1),later=engine.deliverText('A later message');resolveArchive();await pending;
 assert.equal(first.attachments.length,1);assert.deepEqual(store.state.messages.find(message=>message.id===later.messageId).attachments||[],[]);collector.archive=archive;await finish();
});

test('local text links cannot deliver outside, restricted or symlinked files',async t=>{
 const {dir,store,engine,file,finish}=await fixture(t),outside=path.join(dir,'outside.png'),secret=path.join(engine.outputDir,'secret-token.png'),linked=path.join(engine.outputDir,'linked.png');fs.writeFileSync(outside,png);fs.writeFileSync(secret,png);fs.symlinkSync(outside,linked,'file');
 const result=await engine.tool('send_message',{text:`[outside](${outside}) [secret](${secret}) [link](${linked}) [web](https://example.test/photo.png)`});
 assert.deepEqual(result.files,[]);assert.deepEqual(store.state.messages.find(message=>message.id===result.messageId).attachments||[],[]);assert.deepEqual(fs.readFileSync(file),png);await finish();
});

test('ordinary text and external links do not start output scans',async t=>{
 const {engine,collector,finish}=await fixture(t),archive=collector.archive.bind(collector);let calls=0;collector.archive=options=>{calls++;return archive(options);};
 await engine.tool('send_message',{text:'Ordinary reply'});await engine.tool('send_message',{text:'[Website](https://example.test/photo.png)'});assert.equal(calls,0);await finish();
});

test('relative output links retain an exact validated source path without changing immutable metadata',async t=>{
 const {collector,engine,attachments,file,finish}=await fixture(t),result=await engine.tool('send_message',{text:'[Screenshot](output/40lines-no-idle-result.png)'}),message=engine.task(result.messageId),attachment=message.attachments[0];
 assert.equal(attachment.sourcePath,file);assert.equal(Object.hasOwn(attachments.get(attachment.id),'sourcePath'),false);assert.equal(collector.readExplicit({outputDir:engine.outputDir,filePath:file}).sourcePath,file);await finish();
});

test('linked archive failure keeps the saved text without inviting a duplicate resend',async t=>{
 const {engine,collector,store,text,finish}=await fixture(t),archive=collector.archive.bind(collector),notices=[];engine.on('notice',notice=>notices.push(notice));collector.archive=async()=>{throw Error('private output path');};
 const result=await engine.tool('send_message',{text});assert.equal(result.sent,true);assert.deepEqual(result.files,[]);assert.equal(store.state.messages.filter(message=>message.role==='assistant').length,1);assert.deepEqual(notices,['The linked output files could not be added to chat.']);collector.archive=archive;await finish();
});

test('ordinary streamed screenshot replies archive onto their own message before a later reply',async t=>{
 const {engine,store,file,text,finish}=await fixture(t);
 await engine.handle({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'image-answer',delta:text}});
 await engine.handle({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'image-answer',type:'agentMessage',text}}});
 const first=store.state.messages.find(message=>message.role==='assistant');assert.equal(resolveMessageAttachmentLink(file,first.attachments).file?.id,first.attachments[0].id);
 await engine.handle({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'later-answer',type:'agentMessage',text:'Continuing the checks.'}}});
 await finish();assert.equal(first.attachments.length,1);assert.deepEqual(store.state.messages.at(-1).attachments||[],[]);
});

test('turn completion archives a link even when the executor omitted item completion',async t=>{
 const {engine,store,file,text,finish}=await fixture(t);
 await engine.handle({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'image-answer',delta:text}});await finish();
 const first=store.state.messages.find(message=>message.role==='assistant');assert.equal(first.status,'completed');assert.equal(resolveMessageAttachmentLink(file,first.attachments).file?.id,first.attachments[0].id);
});

test('repeated screenshot links reuse the immutable attachment on each message within the round limit',async t=>{
 const {engine,store,file,text,attachments,finish}=await fixture(t),first=await engine.tool('send_message',{text}),original=engine.task(first.messageId).attachments[0];
 for(let index=0;index<4;index++)engine.deliverAttachments(engine.active,[{id:'other-'+index,name:'other'+index,hash:'other'+index}]);
 const second=await engine.tool('send_message',{text:'Same screenshot: '+text}),message=engine.task(second.messageId);
 assert.equal(message.attachments[0].id,original.id);assert.equal(resolveMessageAttachmentLink(file,message.attachments).file?.id,original.id);assert.deepEqual(attachments.read(original.id).data,png);
 assert.equal(new Set(store.state.messages.flatMap(item=>item.attachments||[]).map(item=>item.hash||item.id)).size,5);await finish();
});

test('final archival keeps an already delivered source snapshot when that output file changes',async t=>{
 const {engine,store,file,text,attachments,finish}=await fixture(t);
 await engine.handle({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'image-answer',type:'agentMessage',text}}});
 const message=store.state.messages.find(item=>item.role==='assistant'),original=message.attachments[0];fs.writeFileSync(file,Buffer.concat([png,Buffer.from('changed')]));await finish();
 assert.equal(message.attachments.length,1);assert.equal(message.attachments[0].id,original.id);assert.deepEqual(attachments.read(original.id).data,png);assert.equal(fs.readdirSync(attachments.dir).filter(name=>name.endsWith('.bin')).length,1);
});

test('completion waits for pending per-message archival without moving the picture to a later reply',async t=>{
 const {engine,collector,store,file,text,finish}=await fixture(t),archive=collector.archive.bind(collector);let resolveArchive;
 collector.archive=options=>options.onlyExplicit?new Promise(resolve=>{resolveArchive=()=>resolve(archive(options));}):archive(options);
 const pending=engine.handle({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'image-answer',type:'agentMessage',text}}}),first=store.state.messages.find(item=>item.role==='assistant');
 engine.deliverText('Later reply');const finishing=finish();await tick();assert.ok(engine.active);collector.archive=archive;resolveArchive();await pending;await finishing;
 assert.equal(resolveMessageAttachmentLink(file,first.attachments).file?.id,first.attachments[0].id);assert.deepEqual(store.state.messages.at(-1).attachments||[],[]);assert.equal(engine.active,null);
});

test('late linked archival cannot attach to a deleted or edited message',async t=>{
 for(const deleted of [false,true]){
  const {engine,collector,text,finish}=await fixture(t),archive=collector.archive.bind(collector);let resolveArchive;
  collector.archive=options=>new Promise(resolve=>{resolveArchive=()=>resolve(archive(options));});
  const pending=engine.tool('send_message',{text}),message=engine.store.state.messages.at(-1);
  if(deleted)engine.store.state.messages=engine.store.state.messages.filter(item=>item.id!==message.id);else engine.store.update(message.id,{text:'Changed reply'});
  collector.archive=archive;resolveArchive();await pending;assert.deepEqual(message.attachments||[],[]);await finish();
 }
});
