import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {TelegramGateway,splitTelegramText,telegramMirrorText} from '../src/telegram.mjs';
import {Store} from '../src/store.mjs';
import {AttachmentStore,MAX_ATTACHMENT_BYTES} from '../src/attachments.mjs';
import {createWorkerApp} from '../src/server.mjs';
import {Engine} from '../src/engine.mjs';

const TOKEN='123456:abcdefghijklmnopqrstuvwxyz_123456789',OTHER_TOKEN='654321:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789';
const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});const tick=()=>new Promise(resolve=>setImmediate(resolve));
const json=(result,status=200)=>new Response(JSON.stringify({ok:true,result}),{status,headers:{'Content-Type':'application/json'}});
class FakeEngine extends EventEmitter{
 constructor(store){super();this.store=store;this.worker={status:'online'};this.queue=[];this.active=null;this.call=null;this.enqueued=[];this.stops=[];}
 task(id){return this.store.state.messages.find(item=>item.id===id);}
 change(){this.emit('change');}
 safeUpdate(id,patch){return this.store.update(id,patch);}
 enqueue(message){this.enqueued.push(message.id);if(this.takeover||this.call?.provider==='subscription')this.store.update(message.id,{status:'paused'});else{this.store.update(message.id,{status:'queued'});this.queue.push(message);}this.change();}
 async waitStopped(active){this.stops.push(active);for(const id of active.messageIds)this.store.update(id,{status:'paused'});if(this.active===active)this.active=null;this.change();}
}
class MockApi{
 constructor(){this.calls=[];this.handlers=new Map();this.webhook='';this.filePath='documents/file_1.txt';this.fileData=Buffer.from('File contents');}
 fetch=async(url,options={})=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://api.telegram.org');assert.equal(options.redirect,'error');
  const method=parsed.pathname.startsWith('/file/')?'download':parsed.pathname.split('/').at(-1),body=options.body instanceof FormData?options.body:options.body?JSON.parse(options.body):null;this.calls.push({method,url,body,signal:options.signal});
  if(this.handlers.has(method))return this.handlers.get(method)({url,options,body});
  if(method==='getMe')return json({id:url.includes('654321:')?654321:123456,is_bot:true,username:'dant_test_bot'});
  if(method==='getWebhookInfo')return json({url:this.webhook});
  if(method==='getUpdates')return json([]);
  if(method==='getFile')return json({file_id:body.file_id,file_path:this.filePath,file_size:this.fileData.length});
  if(method==='download')return new Response(this.fileData);
  if(method==='sendMessage'||method==='sendPhoto'||method==='sendDocument')return json({message_id:77});
  throw Error('Unexpected Telegram method');
 };
 count(method){return this.calls.filter(call=>call.method===method).length;}
}
function setup(t,options={}){
 const dir=options.dir||fs.mkdtempSync(path.join(base,'telegram-test-'));if(!options.dir)t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir);if(!options.dir||options.language!==undefined)store.state.settings.language=options.language??'en';const engine=new FakeEngine(store),attachments=new AttachmentStore(path.join(dir,'attachments')),api=new MockApi();
 const gateway=new TelegramGateway({dataDir:dir,store,engine,attachments,fetchImpl:api.fetch,autoPoll:false,...options.gateway});t.after(()=>gateway.close());return {dir,store,engine,attachments,api,gateway};
}
function update(id,text,extra={}){return {update_id:id,message:{message_id:id,chat:{id:11,type:'private'},from:{id:11,is_bot:false},text,...extra}};}
async function paired(context){await context.gateway.configure({token:TOKEN,enabled:true});const pairing=await context.gateway.pair();await context.gateway.receive(update(1,'/start '+pairing.code));await context.gateway.flush();return pairing;}
function complete(context,text='Done',files=[]){const task=context.store.state.messages.find(message=>message.role==='user'&&message.source?.type==='telegram');context.store.update(task.id,{status:'review',turnId:'turn-test'});const reply=context.store.add({role:'assistant',text,status:'completed',taskId:task.id,attachments:files});return {task,reply};}
const englishPrompt=/\b(?:Send text|Work progress|Computer(?: control)?|Online|Offline|No call|In a call|Current work|State|Elapsed|Last update|Task steps|Recent tasks|Ongoing tasks|Queued|Background|Waiting for your reply|Status unconfirmed|Awaiting review|Awaiting confirmation|Completed|Pending|Failed|Paused|Working|Task from a call|Task resume requested|There is no|This Telegram|No Telegram|Stop only this|Usage:|Check progress|The task could not|No paused|Choose a paused|Return computer|Connect the work|End the subscription|Continue voice-only|Work finished|Task submission|Work and queue|Work has not confirmed|This message could not)\b/i;
function assertPromptLanguage(text,language){assert.equal(typeof text,'string');assert.ok(text.trim());if(language==='en')assert.doesNotMatch(text,/\p{Script=Han}/u);else{assert.match(text,/\p{Script=Han}/u);assert.doesNotMatch(text,englishPrompt);}}
function commandText(context,id){const parts=context.gateway.config.outbox.filter(item=>item.id.startsWith(`command:${id}:`));assert.ok(parts.length,'a command should queue its own reply');return parts.map(item=>item.text).join('');}
async function localizedCommand(context,id,text,language){await context.gateway.receive(update(id,text,{from:{id:11,is_bot:false,language_code:language==='en'?'zh-hans':'en'}}));await context.gateway.flush();const reply=commandText(context,id);assertPromptLanguage(reply,language);assert.ok(context.api.calls.some(call=>call.method==='sendMessage'&&reply.includes(call.body.text)),'the localized reply must be sent through the fake Telegram transport');return reply;}

test('Telegram defaults off and has no network activity or token in public state',async t=>{
 const {gateway,api,dir}=setup(t);gateway.start();await gateway.pollOnce();await gateway.flush();assert.equal(api.calls.length,0);assert.equal(gateway.status().enabled,false);assert.equal(gateway.status().configured,false);assert.equal(fs.existsSync(path.join(dir,'telegram.json')),false);
 await gateway.configure({token:TOKEN,enabled:false});assert.equal(api.count('getMe'),1);assert.equal(api.count('getUpdates'),0);assert.equal(JSON.stringify(gateway.status()).includes(TOKEN),false);assert.equal(JSON.stringify(gateway.store.state).includes(TOKEN),false);
 const raw=JSON.parse(fs.readFileSync(path.join(dir,'telegram.json'),'utf8'));assert.equal(raw.token,TOKEN);if(process.platform!=='win32')assert.equal(fs.statSync(path.join(dir,'telegram.json')).mode&0o777,0o600);
});

test('an existing data directory keeps its permissions and linked config files are refused',async t=>{
 const context=setup(t);if(process.platform!=='win32')fs.chmodSync(context.dir,0o755);await context.gateway.configure({token:TOKEN});if(process.platform!=='win32')assert.equal(fs.statSync(context.dir).mode&0o777,0o755);
 await context.gateway.close();const file=path.join(context.dir,'telegram.json'),link=path.join(context.dir,'linked-config.json');fs.linkSync(file,link);assert.throws(()=>new TelegramGateway({dataDir:context.dir,store:context.store,engine:context.engine,attachments:context.attachments,fetchImpl:context.api.fetch}),/regular private file/);
});

test('token validation and webhook conflicts never expose token or delete another integration',async t=>{
 const {gateway,api}=setup(t);await assert.rejects(gateway.configure({token:'bad-token'}),/valid Telegram/);assert.equal(api.calls.length,0);api.webhook='https://another-service.test/private-hook';await assert.rejects(gateway.configure({token:TOKEN,enabled:true}),/already has a webhook/);assert.equal(api.count('deleteWebhook'),0);assert.equal(gateway.status().enabled,false);assert.equal(gateway.status().configured,false);assert.equal(JSON.stringify(gateway.status()).includes('private-hook'),false);
});

test('pairing code is 128 bits, expires in ten minutes, is single-use and does not appear in status or file',async t=>{
 let now=100000;const context=setup(t,{gateway:{now:()=>now}}),{gateway,api}=context;await gateway.configure({token:TOKEN,enabled:true});let pair=await gateway.pair();assert.match(pair.code,/^[0-9a-f]{32}$/);assert.equal(pair.expiresAt,now+600000);assert.equal(JSON.stringify(gateway.status()).includes(pair.code),false);assert.equal(fs.readFileSync(gateway.file,'utf8').includes(pair.code),false);
 await gateway.receive(update(1,'/start '+'a'.repeat(32)));await gateway.receive(update(2,'/start '+pair.code,{chat:{id:-11,type:'group'}}));assert.equal(gateway.status().paired,false);now=pair.expiresAt+1;await gateway.receive(update(3,'/start '+pair.code));assert.equal(gateway.status().paired,false);
 pair=await gateway.pair();await gateway.receive(update(4,'/start '+pair.code));assert.deepEqual(gateway.status().owner,{chatId:'11',userId:'11'});assert.equal(gateway.status().pairing,null);await assert.rejects(gateway.pair(),/Disconnect/);await gateway.receive(update(5,'/start '+pair.code,{chat:{id:22,type:'private'},from:{id:22}}));assert.deepEqual(gateway.status().owner,{chatId:'11',userId:'11'});assert.equal(api.count('sendMessage'),0);
});

test('only the paired private chat and user can enqueue Chinese or English tasks',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'窃取任务',{chat:{id:22,type:'private'},from:{id:22}}));await context.gateway.receive(update(3,'wrong user',{from:{id:22}}));await context.gateway.receive(update(4,'group task',{chat:{id:11,type:'group'}}));assert.equal(context.engine.enqueued.length,0);
 await context.gateway.receive(update(5,'请整理文件'));await context.gateway.receive(update(6,'Please create a report'));assert.equal(context.engine.enqueued.length,2);assert.deepEqual(context.store.state.messages.map(message=>message.text),['请整理文件','Please create a report']);assert.equal(context.store.state.messages[0].clientMessageId,'tg:123456:5');assert.equal(context.store.state.messages[0].status,'queued');assert.equal(context.store.state.messages[0].read,false);
});

test('persisted client IDs, receipts and offsets prevent replay after a restart, including unknown submissions',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Run once'));const task=context.store.state.messages[0];context.store.update(task.id,{status:'paused',submission:'unknown'});await context.gateway.close();const restarted=setup(t,{dir:context.dir});assert.equal(restarted.gateway.config.offset,3);await restarted.gateway.receive(update(2,'Run once'));assert.equal(restarted.engine.enqueued.length,0);
 restarted.api.handlers.set('getUpdates',()=>json([update(2,'Run once'),update(3,'New request')]));await restarted.gateway.pollOnce();assert.equal(restarted.api.calls.find(call=>call.method==='getUpdates').body.offset,3);assert.equal(restarted.engine.enqueued.length,1);assert.equal(restarted.store.state.messages.length,2);assert.equal(restarted.gateway.config.offset,4);
});

test('changing the token resets owner, offset and pending output without mixing bot identities',async t=>{
 const context=setup(t);await paired(context);context.gateway.queueText('old-output','Old owner output');await context.gateway.configure({token:OTHER_TOKEN,enabled:false});assert.equal(context.gateway.status().paired,false);assert.equal(context.gateway.status().bot.id,'654321');assert.equal(context.gateway.config.offset,0);assert.equal(context.gateway.config.outbox.length,0);assert.equal(JSON.stringify(context.gateway.status()).includes(OTHER_TOKEN),false);
});

test('a new pairing never broadcasts results belonging to an earlier pairing or bot token epoch',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Old Telegram task'));complete(context,'Old private answer');const oldPairing=context.gateway.config.owner.pairingId;
 await context.gateway.disconnect();await context.gateway.configure({token:OTHER_TOKEN,enabled:true});context.api.handlers.set('getMe',()=>json({id:123456,is_bot:true,username:'dant_test_bot'}));await context.gateway.configure({token:TOKEN,enabled:true});const pair=await context.gateway.pair();await context.gateway.receive(update(3,'/start '+pair.code));assert.notEqual(context.gateway.config.owner.pairingId,oldPairing);const prior=context.api.count('sendMessage');await context.gateway.flush();const texts=context.api.calls.filter(call=>call.method==='sendMessage').slice(prior).map(call=>call.body.text);assert.equal(texts.includes('Old private answer'),false);
});

test('photos, documents and voice files use only the fixed Telegram file endpoint and immutable attachment storage',async t=>{
 const context=setup(t);await paired(context);context.api.handlers.set('getFile',({body})=>json({file_path:body.file_id==='photo'?'photos/photo.jpg':body.file_id==='voice'?'voice/file.ogg':'documents/file.txt'}));context.api.handlers.set('download',({url})=>new Response(url.endsWith('.jpg')?Buffer.from([255,216,255,1]):url.endsWith('.ogg')?Buffer.from('OggSvoice'):Buffer.from('document')));
 await context.gateway.receive(update(2,'',{caption:'Inspect attachments',photo:[{file_id:'photo',file_size:4}],document:{file_id:'doc',file_name:'../report.txt'},voice:{file_id:'voice',file_size:8}}));const task=context.store.state.messages[0];assert.equal(task.attachments.length,3);assert.deepEqual(task.attachments.map(file=>file.type),['image/jpeg','text/plain','audio/ogg']);assert.equal(task.attachments[1].name,'report.txt');assert.equal(context.engine.enqueued.length,1);
 assert.ok(context.api.calls.filter(call=>call.method==='download').every(call=>call.url.startsWith('https://api.telegram.org/file/bot'+TOKEN+'/')));assert.equal(JSON.stringify(task).includes(TOKEN),false);
});

test('unsafe Telegram file paths and declared or streamed oversized files fail without task execution',async t=>{
 const context=setup(t);await paired(context);
 for(const [index,filePath] of ['/etc/passwd','../private','https://other.test/file','documents/%2e%2e/key','documents/file?token=x'].entries()){context.api.filePath=filePath;await context.gateway.receive(update(index+2,'',{document:{file_id:'doc',file_name:'file.txt'}}));}
 assert.equal(context.api.count('download'),0);assert.equal(context.engine.enqueued.length,0);
 await context.gateway.receive(update(8,'',{document:{file_id:'large',file_size:MAX_ATTACHMENT_BYTES+1}}));assert.equal(context.engine.enqueued.length,0);
 context.api.handlers.set('getFile',()=>json({file_path:'documents/large.txt'}));context.api.handlers.set('download',()=>new Response(Buffer.alloc(MAX_ATTACHMENT_BYTES+1,65)));await context.gateway.receive(update(9,'',{document:{file_id:'streamed'}}));assert.equal(context.engine.enqueued.length,0);assert.ok(context.store.state.messages.every(message=>message.status==='failed'));
});

test('new desktop messages and final Telegram replies are mirrored once, with files and without auto acceptance',async t=>{
 const context=setup(t);await paired(context);const initial=context.api.count('sendMessage');const desktop=context.store.add({role:'user',text:'Desktop task',status:'review'});context.store.add({role:'assistant',text:'Desktop secret answer',taskId:desktop.id,status:'completed'});
 await context.gateway.receive(update(2,'Generate a result'));const task=context.store.state.messages.find(message=>message.source?.type==='telegram');context.store.add({role:'assistant',text:'Streaming draft',taskId:task.id,status:'streaming'});await context.gateway.flush();assert.equal(context.api.count('sendMessage'),initial+2);assert.deepEqual(context.api.calls.filter(call=>call.method==='sendMessage').slice(initial).map(call=>call.body.text),['You · desktop:\nDesktop task','Desktop secret answer']);
 const file=context.attachments.put({name:'result.txt',data:Buffer.from('final output')});complete(context,'Final **plain text** 中文',[file]);await context.gateway.flush();const sent=context.api.calls.filter(call=>call.method==='sendMessage').at(-1);assert.equal(sent.body.text,'Final **plain text** 中文');assert.equal(sent.body.parse_mode,undefined);assert.equal(context.api.count('sendDocument'),1);assert.equal(context.api.calls.find(call=>call.method==='sendDocument').body.get('document').name,'result.txt');assert.equal(task.status,'review');
 const count=context.api.calls.length;await context.gateway.flush();assert.equal(context.api.calls.length,count);assert.equal(context.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text==='Final **plain text** 中文').length,1);
});

test('plain text chunks obey Telegram limits without breaking Unicode surrogate pairs',()=>{
 const source='中文🙂'.repeat(3000),chunks=splitTelegramText(source);assert.equal(chunks.join(''),source);assert.ok(chunks.every(chunk=>chunk.length<=4096));assert.ok(chunks.every(chunk=>!/[\uD800-\uDBFF]$/.test(chunk)&&! /^[\uDC00-\uDFFF]/.test(chunk)));
});

test('unknown outbound delivery is visible and is never automatically retried or replayed after restart',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Task'));complete(context,'Reply needing confirmation');const count=context.api.count('sendMessage');context.api.handlers.set('sendMessage',()=>{throw Error('Network failed at https://api.telegram.org/bot'+TOKEN+'/sendMessage');});await context.gateway.flush();assert.equal(context.gateway.status().delivery.unknown,1);assert.equal(context.api.count('sendMessage'),count+1);assert.equal(JSON.stringify(context.gateway.status()).includes(TOKEN),false);await context.gateway.flush();assert.equal(context.api.count('sendMessage'),count+1);
 await context.gateway.close();const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);assert.equal(restarted.gateway.status().delivery.unknown,1);
});

test('a persisted in-flight send becomes unknown after restart and later parts are withheld',async t=>{
 const context=setup(t);await paired(context);context.gateway.queueText('in-flight','x'.repeat(5000),{deliveryId:'reply'});context.gateway.config.outbox.find(item=>item.id==='in-flight:0').status='sending';context.gateway.save();await context.gateway.close();const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);assert.equal(restarted.gateway.status().delivery.unknown,1);assert.equal(restarted.gateway.status().delivery.failed,1);
});

test('429 is retried only after explicit retry_after, while explicit rejection is not retried',async t=>{
 const delays=[],context=setup(t,{gateway:{delay:async ms=>delays.push(ms)}});await paired(context);let attempts=0;context.api.handlers.set('sendMessage',()=>++attempts===1?new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:2}}),{status:429}):json({message_id:9}));context.gateway.queueText('limited','After delay');await context.gateway.flush();assert.deepEqual(delays,[2000]);assert.equal(attempts,2);assert.equal(context.gateway.status().delivery.unknown,0);
 context.api.handlers.set('sendMessage',()=>new Response(JSON.stringify({ok:false,error_code:403}),{status:403}));const prior=context.api.count('sendMessage');context.gateway.queueText('rejected','No access');await context.gateway.flush();await context.gateway.flush();assert.equal(context.api.count('sendMessage'),prior+1);assert.equal(context.gateway.status().delivery.failed,1);
});

test('/stop only interrupts exclusively Telegram-owned ordinary tasks and preserves desktop work and calls',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Telegram task'));const own=context.store.state.messages[0],desktop=context.store.add({role:'user',text:'Desktop',status:'running'});context.engine.active={messageId:desktop.id,messageIds:[desktop.id]};context.engine.queue=[own,desktop];await context.gateway.receive(update(3,'/stop'));assert.equal(context.engine.stops.length,0);assert.deepEqual(context.engine.queue.map(message=>message.id),[desktop.id]);assert.equal(context.engine.active.messageId,desktop.id);
 context.engine.active={messageId:own.id,messageIds:[own.id]};context.engine.call={provider:'subscription'};await context.gateway.receive(update(4,'/stop'));assert.equal(context.engine.stops.length,0);context.engine.call=null;await context.gateway.receive(update(5,'/stop'));assert.equal(context.engine.stops.length,1);assert.equal(context.engine.active,null);assert.equal(desktop.status,'running');
});

test('disable and close abort polling, remove listeners, and never delete webhooks',async t=>{
 const context=setup(t,{gateway:{autoPoll:true}});let aborted=false,started;const polling=new Promise(resolve=>started=resolve);context.api.handlers.set('getUpdates',({options})=>new Promise((resolve,reject)=>{started();options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true});}));await context.gateway.configure({token:TOKEN,enabled:true});await polling;await context.gateway.configure({enabled:false});assert.equal(aborted,true);assert.equal(context.gateway.status().enabled,false);assert.equal(context.gateway.status().connected,false);await context.gateway.close();assert.equal(context.engine.listenerCount('change'),0);assert.equal(context.api.count('deleteWebhook'),0);assert.equal(context.gateway.close(),context.gateway.close());
});

test('bounded output queue reports pressure instead of growing indefinitely',async t=>{
 const context=setup(t);await paired(context);for(let index=0;index<150;index++)context.gateway.queueText('queued-'+index,'Reply '+index);assert.ok(context.gateway.config.outbox.length<=128);assert.match(context.gateway.status().lastError,/queue.*full|byte limit/);assert.ok(fs.statSync(context.gateway.file).size<1024*1024);
});

test('Windows Telegram atomic saves retry a transient sharing error and preserve the previous file on final failure',async t=>{
 const context=setup(t);await context.gateway.configure({token:TOKEN});const before=fs.readFileSync(context.gateway.file,'utf8'),pauses=[];let renames=0;
 context.gateway.platform='win32';context.gateway.pause=ms=>pauses.push(ms);context.gateway.renameSync=(source,destination)=>{if(++renames===1)throw Object.assign(Error('temporary sharing violation'),{code:'EPERM'});fs.renameSync(source,destination);};context.gateway.save();assert.equal(renames,2);assert.deepEqual(pauses,[10]);assert.equal(fs.readFileSync(context.gateway.file,'utf8'),before);
 const original=Object.assign(Error('persistent sharing violation'),{code:'EACCES'});renames=0;context.gateway.renameSync=()=>{renames++;throw original;};context.gateway.config.enabled=true;assert.throws(()=>context.gateway.save(),error=>error===original);assert.equal(renames,6);assert.equal(fs.readFileSync(context.gateway.file,'utf8'),before);assert.ok(fs.readdirSync(context.dir).every(name=>!name.endsWith('.tmp')));
});

test('configuration misuse, missing token and unsupported API methods never create a network request',async t=>{
 const {gateway,api}=setup(t);await assert.rejects(gateway.configure({enabled:'yes'}),/boolean/);await assert.rejects(gateway.configure({enabled:true}),/token/);await assert.rejects(gateway.pair(),/Enable/);await assert.rejects(gateway.disconnect({clearToken:'yes'}),/boolean/);await assert.rejects(gateway.api('deleteWebhook'),/Unsupported/);await assert.rejects(gateway.api('getMe'),/not configured/);assert.equal(api.calls.length,0);await gateway.close();await assert.rejects(gateway.configure({enabled:false}),/closed/);
});

test('corrupt and oversized Telegram configuration is preserved rather than silently reset',async t=>{
 const context=setup(t);await context.gateway.close();fs.writeFileSync(path.join(context.dir,'telegram.json'),'{broken');const options={dataDir:context.dir,store:context.store,engine:context.engine,attachments:context.attachments};assert.throws(()=>new TelegramGateway(options),SyntaxError);assert.equal(fs.readFileSync(path.join(context.dir,'telegram.json'),'utf8'),'{broken');fs.writeFileSync(path.join(context.dir,'telegram.json'),'x'.repeat(1024*1024+1));assert.throws(()=>new TelegramGateway(options),/bounded regular/);
});

test('a crash while accepting an update leaves an unknown receipt without replaying the pending command',async t=>{
 const context=setup(t);await paired(context);context.gateway.config.receipts.push({id:2,status:'processing'});context.gateway.save();await context.gateway.close();const restarted=setup(t,{dir:context.dir});assert.equal(restarted.gateway.config.receipts.at(-1).status,'unknown');assert.match(restarted.gateway.status().lastError,/not replayed/);await restarted.gateway.receive(update(2,'/stop'));assert.equal(restarted.engine.stops.length,0);assert.equal(restarted.engine.enqueued.length,0);
});

test('/status and /help return owner-only plain responses without account details',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'/status'));await context.gateway.receive(update(3,'/help'));await context.gateway.flush();assert.ok(context.api.calls.some(call=>call.method==='sendMessage'&&call.body.text.includes('Computer: Online')));assert.ok(context.api.calls.filter(call=>call.method==='sendMessage').every(call=>call.body.chat_id==='11'));
});

test('shared progress includes registered desktop and call plans, timestamps, queue and actual recent states',async t=>{
 const context=setup(t),{store,engine,gateway}=context;await paired(context);const now=200000;gateway.now=()=>now;
 const current=store.add({id:'current-task',role:'user',text:'An older chat title',status:'running',turnId:'current-turn'}),steer=store.add({id:'steered-task',role:'user',text:'Refine the same task',status:'running',turnId:'current-turn'}),queued=store.add({id:'queued-task',role:'user',text:'Queued desktop work',status:'queued'}),paused=store.add({id:'paused-task',role:'user',text:'Paused earlier',status:'paused'});
 const plan={total:3,completed:1,currentStep:'Verify the result',steps:[{step:'Prepare files',status:'completed'},{step:'Verify the result',status:'inProgress'},{step:'Deliver files',status:'pending'}]};
 store.state.workTasks=[{id:'current-record',turnId:'current-turn',messageId:current.id,source:'voice',title:'Verified call work',plan,status:'running',startedAt:100000,updatedAt:190000},{id:'voice-record',turnId:'voice-only-turn',messageId:null,source:'voice',title:'Earlier voice task',plan,status:'paused',updatedAt:180000}];
 engine.progress={workId:'current-record',messageId:current.id,turnId:'current-turn',source:'voice',status:'waiting_user',background:true,startedAt:100000,updatedAt:190000};engine.queue=[queued];engine.call={provider:'api',id:'existing-call'};
 await gateway.receive(update(2,'/progress'));await gateway.flush();const output=context.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text.startsWith('Work progress')).at(-1).body.text;
 for(const value of ['Verified call work','Waiting for your reply','1:40','1970-01-01T00:03:10.000Z','✓ Prepare files','◉ Verify the result','○ Deliver files','Queued desktop work','Earlier voice task','Paused','/resume paused-task','Continue with a new instruction in chat'])assert.ok(output.includes(value),value);
 assert.equal(output.includes('/resume voice-record'),false);assert.equal(output.includes(steer.text),false);assert.equal(output.match(/Verified call work/g).length,1);assert.equal(gateway.workState().recent.some(item=>item.taskId===current.id||item.taskId===steer.id),false);assert.equal(paused.status,'paused');assert.equal(engine.call.id,'existing-call');assert.equal(store.state.messages.length,4);
});

test('progress excludes admitted call conversation inputs and retains real call tasks and uncertain deliveries',t=>{
 const {store,gateway}=setup(t);store.add({id:'call-input',role:'user',text:'A conversational reply',status:'accepted',voiceCallId:'call'});store.add({id:'work-input',role:'user',text:'Check a file',status:'accepted',voiceCallId:'call'});store.add({id:'unknown-input',role:'user',text:'Unconfirmed work',status:'unknown',voiceCallId:'call',turnId:'unknown-work'});
 store.state.workTasks=[{id:'real-work',turnId:'work-turn',messageId:'work-input',source:'voice',title:'Checking a file',status:'review',updatedAt:2000}];
 const recent=gateway.workState().recent;assert.equal(recent.length,2);assert.ok(recent.some(item=>item.taskId==='work-input'&&item.status==='review'));assert.ok(recent.some(item=>item.taskId==='unknown-input'&&item.status==='unknown'));assert.equal(gateway.progressText().includes('A conversational reply'),false);
});

test('Telegram preserves uncertain, stopping and real waiting ownership despite a hidden conversation marker',t=>{
 const {gateway,engine,store}=setup(t);store.add({id:'conversation',role:'user',text:'Ordinary conversation',status:'running',workKind:'conversation',turnId:'conversation-turn'});engine.progress={messageId:'conversation',turnId:'conversation-turn',source:'voice',visible:false,status:'running'};
 assert.equal(gateway.workState().active,null);assert.equal(gateway.workState().recent.length,0);
 for(const [status,label]of [['unknown','Status unconfirmed'],['pausing','Stopping safely'],['waiting_user','Waiting for your reply']]){engine.progress.status=status;assert.equal(gateway.workState().active.status,status);assert.equal(gateway.workState().recent.length,0);assert.match(gateway.progressText(),new RegExp(label));assert.doesNotMatch(gateway.progressText(),/\/resume conversation/);}
 engine.progress.status='running';assert.equal(gateway.workState().active,null);
});

test('/porgress alias is read-only, and offline status never implies cached work is still running',async t=>{
 const context=setup(t);await paired(context);const {engine,gateway,store}=context;engine.worker.status='offline';engine.progress={source:'voice',status:'running',title:'Cached public title',updatedAt:1000};store.state.voiceHistory=[{text:'Private speech should not be included'}];
 await gateway.receive(update(2,'/porgress'));await gateway.receive(update(3,'/status'));await gateway.flush();const replies=context.api.calls.filter(call=>call.method==='sendMessage').map(call=>call.body.text).filter(text=>text.startsWith('Work progress'));
 assert.equal(replies.length,2);for(const output of replies){assert.match(output,/Offline or connecting/);assert.match(output,/Status unconfirmed/);assert.equal(output.includes('Private speech'),false);}assert.equal(engine.enqueued.length,0);assert.equal(store.state.messages.length,0);
});

test('public progress redacts known secrets and excludes dismissed records, blockers, reasoning and tool output',async t=>{
 const context=setup(t);await paired(context);const {engine,gateway,store}=context;engine.redact=text=>text.replaceAll('stored-secret','[redacted]');engine.progress={title:'Public stored-secret title '+TOKEN,status:'running',source:'voice',plan:{total:2,completed:0,currentStep:'Current stored-secret step'},reasoning:'PRIVATE_REASONING',output:'PRIVATE_OUTPUT'};
 store.state.workTasks=[{id:'dismissed-record',turnId:'old-turn',messageId:null,source:'voice',status:'review',title:'HIDDEN_RECORD',progressDismissedAt:1000}];store.add({role:'user',status:'paused',text:'HIDDEN_MESSAGE',progressDismissedAt:1000});const blocker=store.add({role:'assistant',status:'completed',text:'PRIVATE_BLOCKER'});store.state.completions=[{id:'blocker-receipt',turnId:'old-turn:input:1',messageIds:[blocker.id]}];
 const output=gateway.progressText();assert.match(output,/\[redacted\]/);assert.match(output,/Steps: 0\/2/);for(const secret of ['stored-secret',TOKEN,'PRIVATE_REASONING','PRIVATE_OUTPUT','HIDDEN_RECORD','HIDDEN_MESSAGE','PRIVATE_BLOCKER'])assert.equal(output.includes(secret),false,secret);
});

test('progress reports only final voice receipts and never their speech or reply contents',async t=>{
 const context=setup(t);await paired(context);const {store,gateway}=context,reply=store.add({role:'assistant',status:'completed',text:'PRIVATE_RESULT'});store.state.completions=[{id:'final',turnId:'voice-final',messageIds:[reply.id],work:{source:'voice',status:'review',updatedAt:2000}},{id:'duplicate',turnId:'voice-final',messageIds:[reply.id],work:{source:'voice',status:'failed'}},{id:'not-final',turnId:'voice-input',messageIds:[reply.id]}];
 assert.equal(gateway.workState().recent.length,1);assert.match(gateway.progressText(),/Task from a call.*Awaiting review/);assert.equal(gateway.progressText().includes('PRIVATE_RESULT'),false);
});

test('/pause pauses shared work and queue through the engine without hanging up or disconnecting Telegram',async t=>{
 const context=setup(t);await paired(context);const {engine,gateway,store}=context,task=store.add({role:'user',text:'Desktop work',status:'running'}),queued=store.add({role:'user',text:'Next work',status:'queued'}),call={id:'keep-this-call',provider:'subscription'};engine.call=call;engine.active={messageId:task.id,messageIds:[task.id]};engine.queue=[queued];let pauses=0;engine.pause=async()=>{pauses++;await engine.waitStopped(engine.active);for(const entry of engine.queue)store.update(entry.id,{status:'paused'});engine.queue=[];};
 await gateway.receive(update(2,'/pause'));await gateway.receive(update(2,'/pause'));await gateway.flush();assert.equal(pauses,1);assert.equal(task.status,'paused');assert.equal(queued.status,'paused');assert.equal(engine.call,call);assert.equal(gateway.status().enabled,true);assert.equal(gateway.status().paired,true);assert.ok(context.api.calls.some(call=>call.method==='sendMessage'&&call.body.text.includes('call was left unchanged')));
});

test('/pause handles idle work, arguments and unconfirmed stopping without claiming success',async t=>{
 const context=setup(t);await paired(context);const {gateway,engine}=context;await gateway.receive(update(2,'/pause'));await gateway.receive(update(3,'/pause anything'));engine.active={messageId:'current'};let attempts=0;engine.pause=async()=>{attempts++;throw Error(TOKEN+' private executor details');};await gateway.receive(update(4,'/pause'));await gateway.flush();const replies=context.api.calls.filter(call=>call.method==='sendMessage').map(call=>call.body.text).join('\n');assert.match(replies,/no current or queued work/i);assert.match(replies,/Usage: \/pause/);assert.match(replies,/not confirmed it stopped/);assert.equal(replies.includes('private executor details'),false);assert.equal(attempts,1);
});

test('pending message and canonical-reference delivery remain visible to Telegram status, pause and resume guards',async t=>{
 const context=setup(t);await paired(context);const {gateway,engine,store}=context,task=store.add({id:'paused-task',role:'user',text:'Independent paused work',status:'paused'});let pauses=0,resumes=0,id=2;engine.pause=async()=>{pauses++;};engine.resumePaused=()=>{resumes++;};
 for(const property of ['pendingFollowups','callReferences']){
  engine[property]=new Map([['pending-private-message',{private:'PRIVATE_REFERENCE_TEXT'}]]);assert.match(gateway.progressText({brief:true}),/Message delivery.*Awaiting confirmation/);assert.equal(gateway.progressText().includes('PRIVATE_REFERENCE_TEXT'),false);
  await gateway.receive(update(id++,'/pause'));await gateway.receive(update(id++,'/resume '+task.id));assert.equal(resumes,0);engine[property].clear();
 }
 assert.equal(pauses,2);await gateway.flush();const replies=context.api.calls.filter(call=>call.method==='sendMessage').map(call=>call.body.text).join('\n');assert.match(replies,/Current work is still active or unconfirmed/);assert.equal(replies.includes('PRIVATE_REFERENCE_TEXT'),false);assert.equal(engine.enqueued.length,0);
});

test('Telegram continued-work history offers only its latest human task ID and never replays the historical anchor',t=>{
 const {store,gateway}=setup(t);store.state.messages=[{id:'original',role:'user',text:'Original request',status:'paused',turnId:'first-turn'},{id:'latest',role:'user',text:'Latest continuation',status:'paused',turnId:'latest-turn'}];store.state.workTasks=[{id:'same-work',turnId:'latest-turn',turnIds:['first-turn','latest-turn'],messageId:'original',source:'voice',title:'Continued task',status:'paused'}];
 let progress=gateway.progressText();assert.match(progress,/\/resume latest/);assert.doesNotMatch(progress,/\/resume original/);assert.equal(gateway.workState().recent.length,1);
 store.state.messages.pop();progress=gateway.progressText();assert.doesNotMatch(progress,/\/resume original/);assert.match(progress,/Continue with a new instruction in chat/);
});

test('/resume requires one exact eligible user task and never guesses among paused tasks',async t=>{
 const context=setup(t);await paired(context);const {gateway,engine,store}=context,first=store.add({id:'full-task-id-one',role:'user',text:'First task',status:'paused'}),second=store.add({id:'full-task-id-two',role:'user',text:'Second task',status:'paused'});const resumes=[];engine.resumePaused=(ids,options)=>{resumes.push({ids,options});for(const id of ids)store.update(id,{status:'queued'});};
 await gateway.receive(update(2,'/resume'));await gateway.flush();const ambiguous=context.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text.includes('Choose a paused task explicitly')).at(-1).body.text;assert.match(ambiguous,/\/resume full-task-id-one/);assert.equal(resumes.length,0);
 await gateway.receive(update(3,'/resume full-task'));assert.equal(resumes.length,0);await gateway.receive(update(4,'/resume full-task-id-two'));assert.deepEqual(resumes,[{ids:[second.id],options:{confirmUnknown:false}}]);assert.equal(first.status,'paused');assert.equal(second.status,'queued');await gateway.receive(update(5,'/resume'));assert.deepEqual(resumes[1],{ids:[first.id],options:{confirmUnknown:false}});
});

test('/resume preserves unknown submissions, worker, human, subscription and executor ownership guards',async t=>{
 const context=setup(t);await paired(context);const {gateway,engine,store}=context,task=store.add({id:'guarded-task',role:'user',text:'Guarded work',status:'paused'});let resumes=0;engine.resumePaused=()=>resumes++;let updateId=2;
 for(const setupGuard of [()=>{engine.worker.status='offline';},()=>{engine.worker.status='online';engine.takeover=true;},()=>{engine.takeover=false;engine.acquiring=true;},()=>{engine.acquiring=false;engine.call={provider:'subscription'};},()=>{engine.call=null;engine.active={messageId:task.id};},()=>{engine.active=null;engine.nativeVoice={session:{unknown:true,turns:new Map()}};},()=>{engine.nativeVoice={session:{turns:new Map([['unfinished',{done:true,resultSaved:false}]])}};},()=>{engine.nativeVoice=null;store.update(task.id,{unknownOutcome:true});},()=>{store.update(task.id,{unknownOutcome:false,submission:'unknown'});}]){setupGuard();await gateway.receive(update(updateId++,'/resume '+task.id));}
 assert.equal(resumes,0);assert.equal(task.submission,'unknown');await gateway.flush();const replies=context.api.calls.filter(call=>call.method==='sendMessage').map(call=>call.body.text).join('\n');for(const expected of ['Connect the work computer','Return computer control','End the subscription call','Current work is still active or unconfirmed','submission is unconfirmed'])assert.ok(replies.includes(expected),expected);
});

test('/resume gives voice-only tasks no fabricated chat ID and failed tasks require an explicit ID',async t=>{
 const context=setup(t);await paired(context);const {gateway,engine,store}=context;store.state.workTasks=[{id:'voice-only-record-id',turnId:'voice-turn',messageId:null,source:'voice',title:'Voice-only work',status:'paused'}];const task=store.add({id:'failed-chat-task',role:'user',status:'failed',text:'A failed chat task'}),resumes=[];engine.resumePaused=ids=>resumes.push(ids);
 await gateway.receive(update(2,'/resume'));await gateway.receive(update(3,'/resume voice-only-record-id'));assert.equal(resumes.length,0);await gateway.receive(update(4,'/resume '+task.id));assert.deepEqual(resumes,[[task.id]]);engine.resumePaused=()=>{throw Error(TOKEN+' private failure');};await gateway.receive(update(5,'/resume '+task.id));await gateway.flush();const output=context.api.calls.filter(call=>call.method==='sendMessage').map(call=>call.body.text).join('\n');assert.match(output,/Continue voice-only work with a new chat instruction/);assert.match(output,/No paused or failed task matches/);assert.match(output,/task could not resume/);assert.equal(output.includes('private failure'),false);
});

test('/resume never replays a submitting task restored as paused after a crash, while preparing remains eligible',async t=>{
 const context=setup(t);await paired(context);const submitting=context.store.add({id:'interrupted-submission',role:'user',text:'May already have started',status:'running',submission:'submitting'}),preparing=context.store.add({id:'interrupted-preparation',role:'user',text:'Not submitted yet',status:'running',submission:'preparing'});await context.gateway.close();
 const restarted=setup(t,{dir:context.dir}),resumes=[];restarted.engine.resumePaused=(ids,options)=>resumes.push({ids,options});const restored=restarted.store.state.messages.find(message=>message.id===submitting.id);assert.equal(restored.status,'paused');assert.equal(restored.submission,'unknown');
 await restarted.gateway.receive(update(2,'/resume '+submitting.id));assert.equal(resumes.length,0);assert.equal(restored.submission,'unknown');assert.equal(restored.status,'paused');assert.ok(restarted.gateway.config.outbox.some(item=>item.text.includes('submission is unconfirmed')));
 await restarted.gateway.receive(update(3,'/resume '+preparing.id));assert.deepEqual(resumes,[{ids:[preparing.id],options:{confirmUnknown:false}}]);assert.equal(restarted.engine.enqueued.length,0);
});

test('commands reveal no task data or control to unpaired users, other owners, groups or bots',async t=>{
 const context=setup(t),{gateway,engine,store}=context;store.add({role:'user',text:'PRIVATE_DESKTOP_TASK',status:'running'});await gateway.configure({token:TOKEN,enabled:true});let controls=0;engine.pause=()=>controls++;engine.resumePaused=()=>controls++;engine.active={messageId:'private'};
 let id=1;for(const command of ['/progress','/porgress','/status','/pause','/resume','/help'])await gateway.receive(update(id++,command));assert.equal(gateway.config.outbox.length,0);const pairing=await gateway.pair();await gateway.receive(update(id++,'/start '+pairing.code));assert.equal(gateway.status().paired,true);
 for(const command of ['/progress','/status','/pause','/resume'])for(const extra of [{chat:{id:22,type:'private'},from:{id:22}},{from:{id:22}},{chat:{id:11,type:'group'}},{from:{id:11,is_bot:true}}])await gateway.receive(update(++id,command,extra));
 assert.equal(controls,0);assert.equal(engine.enqueued.length,0);assert.equal(gateway.config.outbox.some(item=>item.text.includes('PRIVATE_DESKTOP_TASK')),false);
});

test('shared control commands persist receipt identity across restart and /help lists only supported commands',async t=>{
 const context=setup(t);await paired(context);const {gateway,engine,store}=context,task=store.add({id:'resumable',role:'user',text:'Run once',status:'paused'});let resumes=0;engine.resumePaused=()=>resumes++;await gateway.receive(update(2,'/resume '+task.id));assert.equal(resumes,1);await gateway.close();const again=setup(t,{dir:context.dir});again.engine.resumePaused=()=>resumes++;await again.gateway.receive(update(2,'/resume '+task.id));assert.equal(resumes,1);await again.gateway.receive(update(3,'/help'));await again.gateway.flush();const help=again.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text.includes('/help')).at(-1).body.text;for(const command of ['/progress','/porgress','/status','/pause','/resume','/stop','/help'])assert.ok(help.includes(command),command);assert.match(help,/Stop only this Telegram/);assert.equal(help.includes('/disconnect'),false);
});

test('polling uses bounded backoff after a read failure and aborts its idle delay on close',async t=>{
 const context=setup(t,{gateway:{autoPoll:true,retryBaseMs:2}});let requests=0,second;const resumed=new Promise(resolve=>second=resolve);context.api.handlers.set('getUpdates',()=>{if(++requests===1)throw Error('offline');second();return json([]);});await context.gateway.configure({token:TOKEN,enabled:true});await resumed;await tick();assert.ok(requests>=2);await context.gateway.close();assert.equal(context.gateway.status().connected,false);assert.equal(context.gateway.loopAbort.signal.aborted,true);
});

test('Unicode output pressure obeys the file byte bound as well as the queue entry count',async t=>{
 const context=setup(t);await paired(context);for(let index=0;index<80;index++)context.gateway.queueText('unicode-'+index,'中'.repeat(4096));assert.match(context.gateway.status().lastError,/byte limit/);assert.ok(context.gateway.config.outbox.length<128);assert.ok(fs.statSync(context.gateway.file).size<1024*1024);
});

test('real Engine preserves human takeover and delivers Telegram call input to the same voice peer without a separate task',async t=>{
 const context=setup(t);await paired(context);await context.gateway.close();class Worker extends EventEmitter{constructor(){super();this.status='online';this.calls=[];}async request(method,params){this.calls.push({method,params});return method==='thread/start'?{thread:{id:'tg-thread'}}:{turn:{id:'tg-turn'}};}}
 const worker=new Worker(),engine=new Engine(context.store,worker),gateway=new TelegramGateway({dataDir:context.dir,store:context.store,engine,attachments:context.attachments,fetchImpl:context.api.fetch,autoPoll:false});t.after(()=>gateway.close());engine.takeover=true;await gateway.receive(update(2,'While human controls'));assert.equal(context.store.state.messages[0].status,'paused');assert.equal(worker.calls.length,0);engine.takeover=false;engine.call={id:'native-call',provider:'subscription'};
 const admitted=[];engine.nativeVoice={submitCallMessage:async(message,{callId})=>{admitted.push({message,callId});await engine.rememberCallInput(message,callId);return {submission:'confirmed'};}};
 await gateway.receive(update(3,'During native call'));await Promise.all([...engine.pendingFollowups.values()]);assert.equal(context.store.state.messages[1].status,'accepted');assert.ok(context.store.state.messages[1].executorConfirmedAt);assert.equal(admitted.length,1);assert.equal(admitted[0].message,context.store.state.messages[1]);assert.equal(admitted[0].callId,'native-call');assert.equal(worker.calls.filter(call=>call.method==='turn/start'||call.method==='turn/steer').length,0);assert.equal(worker.calls.filter(call=>call.method==='thread/inject_items').length,1);engine.call=null;engine.nativeVoice=null;
 await gateway.receive(update(4,'A fresh Telegram request'));await tick();assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);assert.ok(context.store.state.messages[2].executorConfirmedAt);await engine.handle({method:'turn/completed',params:{threadId:'tg-thread',turn:{id:'tg-turn',status:'completed'}}});assert.equal(context.store.state.messages[2].status,'review');
});

test('worker HTTP routes and snapshot expose safe Telegram state and close its gateway',async t=>{
 class Worker extends EventEmitter{constructor(){super();this.status='offline';}disconnect(){}request(){throw Error('No model requests');}}
 const dir=fs.mkdtempSync(path.join(base,'telegram-http-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const api=new MockApi();const instance=createWorkerApp({dataDir:dir,workerFactory:()=>new Worker(),telegramFactory:options=>new TelegramGateway({...options,fetchImpl:api.fetch,autoPoll:false})});t.after(()=>instance.close());await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const address='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(address+'/api/session').then(response=>response.json()),headers={'X-Dant-Token':token,'Content-Type':'application/json'};
 assert.equal((await fetch(address+'/api/telegram')).status,401);let response=await fetch(address+'/api/telegram/config',{method:'POST',headers,body:JSON.stringify({token:TOKEN,enabled:true})});assert.equal(response.status,200);assert.equal((await response.text()).includes(TOKEN),false);response=await fetch(address+'/api/telegram/pair',{method:'POST',headers,body:'{}'});const pair=await response.json();assert.match(pair.code,/^[0-9a-f]{32}$/);const snapshot=await fetch(address+'/api/state',{headers}).then(response=>response.json());assert.equal(snapshot.telegram.configured,true);assert.equal(JSON.stringify(snapshot).includes(TOKEN),false);assert.equal(JSON.stringify(snapshot).includes(pair.code),false);assert.equal(fs.readFileSync(instance.store.file,'utf8').includes(TOKEN),false);
 response=await fetch(address+'/api/telegram/disconnect',{method:'POST',headers,body:JSON.stringify({clearToken:true})});assert.equal((await response.json()).configured,false);await instance.close();assert.equal(instance.telegram.closed,true);
});

test('1001 finished tasks never requeue after repeated scans, sent-outbox eviction or restart',async t=>{
 const context=setup(t);await paired(context);const owner=context.gateway.config.owner,source={type:'telegram',botId:'123456',chatId:owner.chatId,userId:owner.userId,pairingId:owner.pairingId};context.store.state.messages=[];
 for(let index=0;index<1001;index++)context.store.state.messages.push({id:'task-'+index,role:'user',text:'Task '+index,status:'review',turnId:'turn-'+index,source:{...source,updateId:index+10}},{id:'answer-'+index,role:'assistant',text:'Answer '+index,status:'completed',taskId:'task-'+index});
 // Model storage in memory for this high-cardinality scan, then checkpoint it once for a real reopen.
 context.store.update=(id,patch)=>{const message=context.store.state.messages.find(item=>item.id===id);Object.assign(message,patch);return message;};
 let queued=0;const queue=context.gateway.queueMirrorBatch.bind(context.gateway);context.gateway.queueMirrorBatch=items=>{queued+=items.length;const accepted=queue(items);if(accepted)for(const item of items)context.gateway.config.outbox.find(entry=>entry.id===item.id).status='sent';return accepted;};
 context.gateway.scanResults();assert.equal(queued,1001);assert.equal(context.gateway.config.outbox.length,128);assert.equal(context.gateway.config.resultKeys.length,0);assert.ok(context.store.state.messages.filter(item=>item.role==='user').every(task=>task.telegramDelivery?.status==='scheduled'));
 queued=0;context.gateway.scanResults();context.gateway.scanResults();context.store.state.messages[0].status='completed';context.gateway.scanResults();assert.equal(queued,0);
 context.gateway.config.outbox=[];context.gateway.save();context.store.save();await context.gateway.close();const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);assert.equal(restarted.gateway.config.outbox.length,0);assert.equal(restarted.gateway.config.resultKeys.length,0);
});

test('a resumed task delivers only the new turn reply and keeps its previous delivery boundary across restart',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Resume this task later'));const {task}=complete(context,'First turn answer');await context.gateway.flush();const previousKey=task.telegramDelivery.key;
 await context.gateway.close();const restarted=setup(t,{dir:context.dir}),again=restarted.store.state.messages.find(item=>item.id===task.id);restarted.store.update(again.id,{status:'review',turnId:'second-turn'});restarted.store.add({id:'second-answer',role:'assistant',taskId:again.id,text:'Second turn answer',status:'completed'});await restarted.gateway.flush();assert.deepEqual(restarted.api.calls.filter(call=>call.method==='sendMessage').map(call=>call.body.text),['Second turn answer']);assert.notEqual(again.telegramDelivery.key,previousKey);assert.equal(again.telegramDelivery.replyThroughId,'second-answer');assert.equal(again.status,'review');const requests=restarted.api.count('sendMessage');await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),requests);
});

test('an interrupted mirror schedule becomes unknown without repeating any output after restart',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Task'));const {reply}=complete(context,'Do not replay after a scheduling crash');context.gateway.queueMirrorBatch=()=>{throw Error('Simulated schedule crash');};assert.throws(()=>context.gateway.scanResults(),/schedule crash/);assert.equal(reply.telegramMirror.text,'scheduling');await context.gateway.close();
 const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();assert.equal(restarted.store.state.messages.find(message=>message.id===reply.id).telegramMirror.text,'unknown');assert.match(restarted.gateway.status().lastError,/scheduling was interrupted/);assert.equal(restarted.api.count('sendMessage'),0);await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);
});

test('a reply waiting for full outbox capacity is retried only after its known-unsent batch can fit',async t=>{
 const context=setup(t);await paired(context);for(let index=0;index<128;index++)context.gateway.queueText('full-'+index,'Pending output');await context.gateway.receive(update(2,'Task'));const {reply}=complete(context,'Reply waiting for queue capacity');context.gateway.scanResults();assert.equal(reply.telegramMirror.text,'pending');assert.equal(context.gateway.config.outbox.some(item=>item.text===reply.text),false);context.gateway.config.outbox=[];context.gateway.save();await context.gateway.flush();assert.equal(context.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text===reply.text).length,1);assert.equal(reply.telegramMirror.text,'scheduled');
});

test('legacy result identities and existing history remain withheld when upgrading to conversation mirroring',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Legacy task'));const {task}=complete(context,'Previously delivered');context.gateway.config.resultKeys=[`result:${task.id}:${task.turnId}:result`];delete context.gateway.config.owner.syncVersion;context.gateway.save();await context.gateway.close();const restarted=setup(t,{dir:context.dir});const migrated=restarted.store.state.messages.find(message=>message.id===task.id);assert.equal(migrated.telegramDelivery.status,'historical');assert.equal(migrated.telegramMirror.historical,true);
 restarted.gateway.config.resultKeys=[];restarted.gateway.save();await restarted.gateway.flush();assert.equal(restarted.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text==='Previously delivered').length,0);assert.equal(restarted.gateway.config.outbox.filter(item=>item.taskId===task.id).length,0);
});

test('upgrade from an already truncated legacy ledger conservatively withholds forgotten historical replies',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Forgotten old task'));const {task:forgotten}=complete(context,'Forgotten delivery identity');await context.gateway.receive(update(3,'Remembered old task'));const remembered=context.store.state.messages.find(message=>message.role==='user'&&message.id!==forgotten.id);context.store.update(remembered.id,{status:'review',turnId:'remembered-turn'});context.store.add({role:'assistant',taskId:remembered.id,status:'completed',text:'Known delivered answer'});
 delete context.gateway.config.deliveryVersion;context.gateway.config.resultKeys=[`result:${remembered.id}:remembered-turn:result`];context.gateway.save();await context.gateway.close();const restarted=setup(t,{dir:context.dir});assert.equal(restarted.store.state.messages.find(message=>message.id===forgotten.id).telegramDelivery.status,'unknown');assert.equal(restarted.store.state.messages.find(message=>message.id===remembered.id).telegramDelivery.status,'scheduled');assert.match(restarted.gateway.status().lastError,/history was incomplete/);await restarted.gateway.flush();await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);assert.equal(restarted.gateway.config.deliveryVersion,2);
});

test('pairing baselines existing history in one save without changing content, timestamps, references or model identity',async t=>{
 const context=setup(t),{store,gateway}=context,old=store.add({role:'user',text:'Private old draft',status:'review',time:5}),streaming=store.add({role:'assistant',text:'Old streaming content',status:'streaming',taskId:old.id,time:6});store.state.threadId='preserved-model-thread';const conversation=store.state.conversationId,before=store.state.messages.map(message=>({id:message.id,time:message.time,text:message.text,status:message.status}));let saves=0;const save=store.save.bind(store);store.save=()=>{saves++;return save();};
 await paired(context);assert.equal(saves,1);assert.equal(store.state.messages[0],old);assert.equal(store.state.messages[1],streaming);assert.deepEqual(store.state.messages.map(message=>({id:message.id,time:message.time,text:message.text,status:message.status})),before);assert.equal(store.state.threadId,'preserved-model-thread');assert.equal(store.state.conversationId,conversation);assert.ok(store.state.messages.every(message=>message.telegramMirror.historical));assert.equal(gateway.status().sync.active,true);
 const initial=context.api.calls.length,file=context.attachments.put({name:'late-old.txt',data:Buffer.from('old result')});store.update(streaming.id,{status:'completed',attachments:[file]});await gateway.flush();assert.equal(context.api.calls.length,initial);
 const fresh=store.add({role:'user',text:'New desktop input',status:'queued'});await gateway.flush();assert.equal(context.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text.endsWith(fresh.text)).length,1);assert.equal(fresh.telegramMirror.text,'scheduled');
});

test('a baseline storage failure rolls metadata back and never enables outbound sync for the epoch',async t=>{
 const context=setup(t),old=context.store.add({role:'assistant',text:'Keep private',status:'completed'});await context.gateway.configure({token:TOKEN,enabled:true});const pair=await context.gateway.pair(),save=context.store.save.bind(context.store);context.store.save=()=>{throw Error('Baseline storage unavailable');};
 await assert.rejects(context.gateway.receive(update(1,'/start '+pair.code)),/Baseline storage/);assert.equal(old.telegramMirror,undefined);assert.equal(context.gateway.config.owner.syncVersion,undefined);assert.equal(context.gateway.status().sync.active,false);assert.equal(context.api.count('sendMessage'),0);context.store.save=save;context.gateway.scanResults();await context.gateway.flush();assert.equal(old.telegramMirror.historical,true);assert.equal(context.api.count('sendMessage'),0);
});

test('an existing paired installation establishes a safe upgrade baseline once, then mirrors new messages across restart',async t=>{
 const context=setup(t);await paired(context);const old=context.store.add({role:'assistant',text:'Old private history',status:'completed'});delete context.gateway.config.owner.syncVersion;context.gateway.save();await context.gateway.close();const reopened=setup(t,{dir:context.dir});await reopened.gateway.flush();assert.equal(reopened.api.count('sendMessage'),0);assert.equal(reopened.store.state.messages.find(message=>message.id===old.id).telegramMirror.historical,true);
 reopened.store.add({role:'assistant',text:'Future output',status:'completed'});await reopened.gateway.flush();assert.deepEqual(reopened.api.calls.filter(call=>call.method==='sendMessage').map(call=>call.body.text),['Future output']);await reopened.gateway.close();const again=setup(t,{dir:context.dir});await again.gateway.flush();assert.equal(again.api.count('sendMessage'),0);
});

test('same-pairing disable and enable catches up only new messages while retaining its historical baseline',async t=>{
 const context=setup(t),historical=context.store.add({role:'assistant',text:'Before binding',status:'completed'});await paired(context);const epoch=context.gateway.config.owner.pairingId;await context.gateway.configure({enabled:false});const newUser=context.store.add({role:'user',text:'Typed while disabled'}),newReply=context.store.add({role:'assistant',text:'New reply while disabled',status:'completed',taskId:newUser.id});await context.gateway.flush();assert.equal(newUser.telegramMirror,undefined);const count=context.api.count('sendMessage');await context.gateway.configure({enabled:true});await context.gateway.flush();assert.equal(context.gateway.config.owner.pairingId,epoch);assert.equal(historical.telegramMirror.historical,true);assert.deepEqual(context.api.calls.filter(call=>call.method==='sendMessage').slice(count).map(call=>call.body.text),['You · desktop:\nTyped while disabled',newReply.text]);
});

test('completed desktop replies mirror immediately and appended files sync once without repeating their text',async t=>{
 const context=setup(t);await paired(context);const task=context.store.add({role:'user',text:'Work still running',status:'running'}),reply=context.store.add({role:'assistant',text:'Requested partial delivery',status:'completed',taskId:task.id});await context.gateway.flush();assert.equal(task.status,'running');const sent=context.api.count('sendMessage'),file=context.attachments.put({name:'result.txt',data:Buffer.from('new file')});context.store.update(reply.id,{attachments:[file]});await context.gateway.flush();await context.gateway.flush();assert.equal(context.api.count('sendMessage'),sent);assert.equal(context.api.count('sendDocument'),1);assert.equal(reply.telegramMirror.files[0].id,file.id);
 const input=context.store.add({role:'user',text:'',attachments:[file]});await context.gateway.flush();const forwarded=context.api.calls.filter(call=>call.method==='sendDocument').at(-1);assert.equal(forwarded.body.get('caption'),'You · desktop');assert.equal(forwarded.body.get('document').name,'result.txt');assert.equal(context.gateway.config.outbox.find(item=>item.localMessageId===input.id).telegramMessageId,'77');
});

test('deleting and clearing visible history cannot shift the mirror baseline or reset model context',async t=>{
 const context=setup(t),old=context.store.add({role:'assistant',text:'Historical',status:'completed'});await paired(context);const conversation=context.store.state.conversationId;context.store.state.threadId='same-model-thread';const first=context.store.add({role:'user',text:'First sent'});await context.gateway.flush();const count=context.api.count('sendMessage');context.store.state.messages=context.store.state.messages.filter(message=>message.id!==old.id);context.store.save();await context.gateway.flush();assert.equal(context.api.count('sendMessage'),count);context.store.state.messages=[];context.store.save();await context.gateway.flush();context.store.add({role:'user',text:'After clear'});await context.gateway.flush();assert.equal(context.api.count('sendMessage'),count+1);assert.equal(context.store.state.conversationId,conversation);assert.equal(context.store.state.threadId,'same-model-thread');assert.equal(first.telegramMirror.text,'scheduled');
});

test('re-pairing excludes old streaming messages, late old-owner task replies and old queued identities',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Old owner task'));const oldTask=context.store.state.messages[0],stream=context.store.add({role:'assistant',taskId:oldTask.id,text:'Private partial',status:'streaming'}),oldEpoch=context.gateway.config.owner.pairingId;context.gateway.queueText('old-queued','Old queued private output');const queued=structuredClone(context.gateway.config.outbox.at(-1));await context.gateway.disconnect();await context.gateway.configure({enabled:true});const pair=await context.gateway.pair();await context.gateway.receive(update(3,'/start '+pair.code));await context.gateway.flush();assert.notEqual(context.gateway.config.owner.pairingId,oldEpoch);const count=context.api.calls.length;
 context.store.update(stream.id,{text:'Old streaming final',status:'completed'});context.store.add({role:'assistant',taskId:oldTask.id,text:'Late old task response',status:'completed'});context.store.add({role:'assistant',taskId:'removed-old-task',text:'Orphan old response',status:'completed'});context.gateway.config.outbox.push({...queued,status:'queued'});await context.gateway.flush();assert.equal(context.api.calls.slice(count).some(call=>['sendMessage','sendDocument'].includes(call.method)),false);assert.equal(context.gateway.config.outbox.at(-1).status,'failed');
});

test('queue pressure reserves whole mirror batches and safely drains pending text and files without partial duplication',async t=>{
 const context=setup(t);await paired(context);context.gateway.config.outbox=[];for(let index=0;index<127;index++)context.gateway.queueText('occupied-'+index,'Existing queued message');const file=context.attachments.put({name:'pending.txt',data:Buffer.from('pending')}),message=context.store.add({role:'assistant',text:'x'.repeat(5000),attachments:[file],status:'completed'});const ids=context.gateway.config.outbox.map(item=>item.id);context.gateway.scanResults();assert.deepEqual(context.gateway.config.outbox.map(item=>item.id),ids);assert.equal(message.telegramMirror.text,'pending');assert.equal(message.telegramMirror.files[0].status,'pending');await context.gateway.flush();assert.equal(context.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text.startsWith('x')).length,2);assert.equal(context.api.count('sendDocument'),1);assert.equal(message.telegramMirror.text,'scheduled');assert.ok(context.gateway.config.outbox.length<=128);await context.gateway.flush();assert.equal(context.api.count('sendDocument'),1);
});

test('an ambiguous mirrored send freezes later components and is not retried after restart',async t=>{
 const context=setup(t);await paired(context);const message=context.store.add({role:'assistant',text:'Ambiguous new reply',status:'completed'});context.api.handlers.set('sendMessage',()=>{throw Error('Network outcome unknown');});await context.gateway.flush();assert.equal(context.gateway.status().delivery.unknown,1);const file=context.attachments.put({name:'later.txt',data:Buffer.from('later')});context.store.update(message.id,{attachments:[file]});await context.gateway.flush();assert.equal(context.api.count('sendDocument'),0);await context.gateway.close();const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);assert.equal(restarted.api.count('sendDocument'),0);
});

test('trusted API voice deliveries mirror with current-conversation provenance while unknown or stale orphans stay private',async t=>{
 const context=setup(t);await paired(context);const file=context.attachments.put({name:'voice-result.txt',data:Buffer.from('explicit voice output')});context.store.add({role:'assistant',text:'Explicit API voice delivery',attachments:[file],status:'completed',taskId:'voice-task-1',source:{type:'voice-call',conversationId:context.store.state.conversationId}});context.store.add({role:'assistant',text:'Stale API voice output',status:'completed',taskId:'voice-task-2',source:{type:'voice-call',conversationId:'different-conversation'}});context.store.add({role:'assistant',text:'Unknown orphan response',status:'completed',taskId:'voice-task-3'});const before=context.api.count('sendMessage');await context.gateway.flush();assert.deepEqual(context.api.calls.filter(call=>call.method==='sendMessage').slice(before).map(call=>call.body.text),['Explicit API voice delivery']);assert.equal(context.api.count('sendDocument'),1);await context.gateway.flush();assert.equal(context.api.count('sendDocument'),1);
});

for(const language of ['zh','en']){
 test('Telegram '+language+' welcome, help, command fallback and progress use only the current dant language',async t=>{
  const context=setup(t,{language}),{gateway,store,engine}=context;await gateway.configure({token:TOKEN,enabled:true});const pair=await gateway.pair();await localizedCommand(context,1,'/start '+pair.code,language);
  for(const [id,command]of [[2,'/help'],[3,'/commands'],[4,'/unknown']]){const text=await localizedCommand(context,id,command,language);for(const name of ['/progress','/porgress','/status','/pause','/resume','/stop','/help'])assert.ok(text.includes(name),name);}
  await localizedCommand(context,5,'/status',language);await localizedCommand(context,6,'/porgress',language);
  const queued=store.add({id:'queued-localized-task',role:'user',text:'',status:'queued'});engine.queue=[queued];engine.call={id:'same-call',provider:'api'};engine.takeover=true;engine.pendingFollowups=new Map([['pending-input',{}]]);
  engine.progress={source:'voice',status:'waiting_user',background:true,startedAt:1000,updatedAt:2000,plan:{total:2,completed:1,currentStep:language==='en'?'Check result':'核对结果'}};
  store.state.workTasks=[{id:'ongoing-locale',turnId:'ongoing-turn',source:'voice',title:'',status:'continuing',updatedAt:1000},{id:'recent-locale',turnId:'recent-turn',source:'voice',title:'',status:'review',updatedAt:1000}];
  const progress=await localizedCommand(context,7,'/progress',language);for(const label of language==='en'?['Work progress','Computer: Online','Waiting for your reply','Background','Queued','In a call','Human','Awaiting confirmation','Task from a call']:['工作进度','在线','回复','后台','排队','通话','用户','等待确认','通话'])assert.ok(progress.includes(label),label);assert.equal(engine.call.id,'same-call');assert.equal(engine.enqueued.length,0);
  for(const status of ['running','continuing','waiting_user','pausing','unknown','review','paused','failed','completed','queued','draft']){engine.progress.status=status;assertPromptLanguage(gateway.progressText(),language);}
  engine.worker.status='offline';const offline=await localizedCommand(context,8,'/status',language);assert.match(offline,language==='en'?/Offline or connecting/:/离线|连接中/);assert.match(offline,language==='en'?/Status unconfirmed/:/未确认/);
 });

 test('Telegram '+language+' pause, resume and stop acknowledgements and guard errors stay single-language',async t=>{
  const context=setup(t,{language}),{gateway,store,engine}=context;await paired(context);let id=2;
  await localizedCommand(context,id++,'/pause',language);await localizedCommand(context,id++,'/pause extra',language);
  engine.active={messageId:'current-control-task',messageIds:[]};engine.pause=async()=>{throw Error('PRIVATE_EXECUTOR '+TOKEN);};const uncertain=await localizedCommand(context,id++,'/pause',language);assert.equal(uncertain.includes('PRIVATE_EXECUTOR'),false);assert.equal(uncertain.includes(TOKEN),false);
  let pauses=0;const call={id:'preserved-call',provider:'api'};engine.call=call;engine.pause=async()=>{pauses++;engine.active=null;engine.queue=[];};await localizedCommand(context,id++,'/pause',language);assert.equal(pauses,1);assert.equal(engine.call,call);engine.call=null;
  await localizedCommand(context,id++,'/resume',language);const task=store.add({id:'localized-resume-task',role:'user',text:language==='en'?'Resumable work':'可继续的工作',status:'paused'});let resumes=0;engine.resumePaused=(ids,options)=>{resumes++;assert.deepEqual(ids,[task.id]);assert.deepEqual(options,{confirmUnknown:false});};
  for(const [name,set,reset]of [
   ['offline',()=>engine.worker.status='offline',()=>engine.worker.status='online'],
   ['human',()=>engine.takeover=true,()=>engine.takeover=false],
   ['subscription',()=>engine.call={id:'native-call',provider:'subscription'},()=>engine.call=null],
   ['active',()=>engine.active={messageId:'other-current'},()=>engine.active=null],
   ['unknown submission',()=>store.update(task.id,{submission:'unknown'}),()=>store.update(task.id,{submission:'preparing'})]
  ]){set();await localizedCommand(context,id++,'/resume '+task.id,language);assert.equal(resumes,0,name);reset();}
  await localizedCommand(context,id++,'/resume missing-full-task-id',language);assert.equal(resumes,0);await localizedCommand(context,id++,'/resume '+task.id,language);assert.equal(resumes,1);
  engine.resumePaused=()=>{throw Error('PRIVATE_RESUME '+TOKEN);};const failed=await localizedCommand(context,id++,'/resume '+task.id,language);assert.equal(failed.includes('PRIVATE_RESUME'),false);assert.equal(failed.includes(TOKEN),false);
  store.add({id:'second-localized-task',role:'user',text:language==='en'?'Another paused task':'另一项暂停任务',status:'paused'});const choose=await localizedCommand(context,id++,'/resume',language);assert.ok(choose.includes('/resume '+task.id));
  await localizedCommand(context,id++,'/stop',language);const inputId=id++;await gateway.receive(update(inputId,language==='en'?'Telegram work':'来自聊天的工作'));const own=store.state.messages.find(message=>message.clientMessageId===`tg:123456:${inputId}`);assert.ok(own);engine.active={messageId:own.id,messageIds:[own.id]};await localizedCommand(context,id++,'/stop',language);assert.equal(engine.stops.at(-1).messageId,own.id);assert.equal(engine.active,null);
 });

 test('Telegram '+language+' mirror prefixes and automatic result notices are localized without translating message bodies',async t=>{
  const context=setup(t,{language}),{gateway,store,api}=context;await paired(context);const prefix=language==='en'?'You · desktop':'你 · 桌面',body='原文 remains unchanged';let before=api.count('sendMessage');store.add({role:'user',text:body,status:'queued'});await gateway.flush();assert.deepEqual(api.calls.filter(call=>call.method==='sendMessage').slice(before).map(call=>call.body.text),[prefix+':\n'+body]);
  const file=context.attachments.put({name:'original-name.txt',data:Buffer.from('unchanged bytes')});store.add({role:'user',text:'',attachments:[file]});await gateway.flush();assert.equal(api.calls.filter(call=>call.method==='sendDocument').at(-1).body.get('caption'),prefix);
  for(const [index,status,submission]of [[0,'review',undefined],[1,'paused',undefined],[2,'failed',undefined],[3,'paused','unknown']]){const updateId=20+index;await gateway.receive(update(updateId,language==='en'?'Requested work':'交办的工作'));const task=store.state.messages.find(message=>message.clientMessageId===`tg:123456:${updateId}`);store.update(task.id,{status,submission,turnId:'localized-result-'+index});before=api.count('sendMessage');await gateway.flush();const messages=api.calls.filter(call=>call.method==='sendMessage').slice(before);assert.equal(messages.length,1);assertPromptLanguage(messages[0].body.text,language);if(status==='review')assert.match(messages[0].body.text,language==='en'?/review/:/验收/);if(submission==='unknown')assert.match(messages[0].body.text,language==='en'?/unconfirmed/:/未确认/);}
  const task=store.state.messages.find(message=>message.clientMessageId==='tg:123456:20'),answer='Assistant 原文 is preserved';store.add({role:'assistant',taskId:task.id,text:answer,status:'completed'});before=api.count('sendMessage');await gateway.flush();assert.deepEqual(api.calls.filter(call=>call.method==='sendMessage').slice(before).map(call=>call.body.text),[answer]);
 });
}

test('Telegram reads dant language on each new reply, ignores sender language_code, and never rewrites queued prompts',async t=>{
 const context=setup(t,{language:'zh'}),{gateway,store,api}=context;await paired(context);await gateway.receive(update(2,'/help',{from:{id:11,is_bot:false,language_code:'en'}}));const queuedChinese=commandText(context,2),previousSends=api.calls.filter(call=>call.method==='sendMessage'&&call.body.text===queuedChinese).length;assertPromptLanguage(queuedChinese,'zh');
 store.state.settings.language='en';await localizedCommand(context,3,'/status','en');assert.equal(commandText(context,2),queuedChinese);assert.equal(api.calls.filter(call=>call.method==='sendMessage'&&call.body.text===queuedChinese).length,previousSends+1);assertPromptLanguage(commandText(context,3),'en');
 store.state.settings.language='zh';await localizedCommand(context,4,'/help','zh');delete store.state.settings.language;await localizedCommand(context,5,'/status','zh');store.state.settings.language='unsupported';await localizedCommand(context,6,'/help','zh');
 const sent=api.count('sendMessage');store.state.settings.language='en';await gateway.flush();assert.equal(api.count('sendMessage'),sent,'a language switch cannot replay already delivered prompts');
});

test('Telegram control acknowledgements use the latest language after awaiting confirmed engine work',async t=>{
 const context=setup(t,{language:'zh'}),{gateway,store,engine}=context;await paired(context);let resolvePause;engine.active={messageId:'pausing-current'};engine.pause=()=>new Promise(resolve=>resolvePause=()=>{engine.active=null;resolve();});const pausing=gateway.receive(update(2,'/pause'));await tick();assert.equal(typeof resolvePause,'function');store.state.settings.language='en';resolvePause();await pausing;await gateway.flush();assertPromptLanguage(commandText(context,2),'en');
 await gateway.receive(update(3,'Telegram-origin work'));const own=store.state.messages.find(message=>message.clientMessageId==='tg:123456:3');engine.active={messageId:own.id,messageIds:[own.id]};let resolveStop;engine.waitStopped=()=>new Promise(resolve=>resolveStop=()=>{engine.active=null;resolve();});const stopping=gateway.receive(update(4,'/stop'));await tick();assert.equal(typeof resolveStop,'function');store.state.settings.language='zh';resolveStop();await stopping;await gateway.flush();assertPromptLanguage(commandText(context,4),'zh');
});

const photoBytes=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrxsAAAAASUVORK5CYII=','base64');

test('recognized PNG and JPEG attachments upload as photos while other bytes retain document delivery',async t=>{
 const context=setup(t);await paired(context);const files=[context.attachments.put({name:'screenshot.png',data:photoBytes()}),context.attachments.put({name:'photo.jpg',data:Buffer.from([255,216,255,224,0,2,255,217])}),context.attachments.put({name:'looks-like-photo.png',data:Buffer.from('A text document, not image content')})];
 const message=context.store.add({role:'assistant',text:'Pictures',status:'completed',attachments:files});await context.gateway.flush();assert.equal(context.api.count('sendPhoto'),2);assert.equal(context.api.count('sendDocument'),1);const photos=context.api.calls.filter(call=>call.method==='sendPhoto');assert.equal(photos[0].body.get('chat_id'),'11');assert.equal(photos[0].body.get('photo').type,'image/png');assert.equal(photos[1].body.get('photo').type,'image/jpeg');assert.deepEqual(Buffer.from(await photos[0].body.get('photo').arrayBuffer()),photoBytes());assert.equal(photos[0].body.has('document'),false);assert.equal(context.api.calls.find(call=>call.method==='sendDocument').body.get('document').type,'text/plain');assert.equal(message.telegramMirror.files.length,3);
 const count=context.api.calls.length;await context.gateway.flush();assert.equal(context.api.calls.length,count);
 const desktop=context.store.add({role:'user',text:'',attachments:[files[0]]});await context.gateway.flush();const forwarded=context.api.calls.filter(call=>call.method==='sendPhoto').at(-1);assert.equal(forwarded.body.get('caption'),'You · desktop');assert.equal(context.gateway.config.outbox.find(item=>item.localMessageId===desktop.id).status,'sent');
});

test('an explicit photo rejection falls back once to the original file with durable deduplication',async t=>{
 const context=setup(t);await paired(context);context.api.handlers.set('sendPhoto',()=>new Response(JSON.stringify({ok:false,error_code:400,description:'PHOTO_INVALID_DIMENSIONS'}),{status:400}));const file=context.attachments.put({name:'wide-screen.png',data:photoBytes()}),message=context.store.add({role:'assistant',text:'',attachments:[file],status:'completed'});await context.gateway.flush();assert.equal(context.api.count('sendPhoto'),1);assert.equal(context.api.count('sendDocument'),1);assert.deepEqual(Buffer.from(await context.api.calls.find(call=>call.method==='sendDocument').body.get('document').arrayBuffer()),photoBytes());const item=context.gateway.config.outbox.find(item=>item.localMessageId===message.id);assert.equal(item.status,'sent');assert.equal(item.documentFallback,true);assert.equal(item.attempts,2);await context.gateway.close();const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();assert.equal(restarted.api.count('sendPhoto'),0);assert.equal(restarted.api.count('sendDocument'),0);
});

test('unknown photo outcomes never fall back, repeat, or release later attachments after restart',async t=>{
 for(const mode of ['network','server']){
  const context=setup(t);await paired(context);context.api.handlers.set('sendPhoto',()=>{if(mode==='network')throw Error('Lost photo acknowledgement');return new Response(JSON.stringify({ok:false,error_code:500}),{status:500});});const file=context.attachments.put({name:'result.png',data:photoBytes()}),message=context.store.add({role:'assistant',text:'',attachments:[file],status:'completed'});await context.gateway.flush();assert.equal(context.gateway.status().delivery.unknown,1);assert.equal(context.api.count('sendPhoto'),1);assert.equal(context.api.count('sendDocument'),0);const later=context.attachments.put({name:'later.txt',data:Buffer.from('Later attachment')});context.store.update(message.id,{attachments:[file,later]});await context.gateway.flush();await context.gateway.close();const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();assert.equal(restarted.api.count('sendPhoto'),0);assert.equal(restarted.api.count('sendDocument'),0);assert.equal(restarted.gateway.status().delivery.unknown,1);
 }
});

test('photo throttling only retries an explicit safe retry-after and access rejection never changes media method',async t=>{
 const delays=[],context=setup(t,{gateway:{delay:async ms=>delays.push(ms)}});await paired(context);let count=0;context.api.handlers.set('sendPhoto',()=>++count===1?new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:1}}),{status:429}):json({message_id:45}));const file=context.attachments.put({name:'retry.png',data:photoBytes()});context.store.add({role:'assistant',text:'',attachments:[file],status:'completed'});await context.gateway.flush();assert.deepEqual(delays,[1000]);assert.equal(context.api.count('sendPhoto'),2);assert.equal(context.api.count('sendDocument'),0);
 context.api.handlers.set('sendPhoto',()=>new Response(JSON.stringify({ok:false,error_code:403}),{status:403}));context.store.add({role:'assistant',text:'',attachments:[file],status:'completed'});await context.gateway.flush();await context.gateway.flush();assert.equal(context.api.count('sendPhoto'),3);assert.equal(context.api.count('sendDocument'),0);assert.equal(context.gateway.status().delivery.failed,1);
});

test('oversized photos use the document limit and queued legacy attachments gain photo delivery without historical replay',async t=>{
 const context=setup(t);await paired(context);const bytes=Buffer.alloc(10000001);photoBytes().copy(bytes);const large=context.attachments.put({name:'large.png',data:bytes}),small=context.attachments.put({name:'small.png',data:photoBytes()});context.store.add({role:'assistant',text:'',attachments:[large,small],status:'completed'});context.gateway.scanResults();assert.ok(context.gateway.config.outbox.some(item=>item.kind==='document'&&item.attachmentId===small.id&&item.status==='queued'));await context.gateway.close();const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();assert.equal(restarted.api.count('sendPhoto'),1);assert.equal(restarted.api.count('sendDocument'),1);assert.equal(restarted.api.calls.find(call=>call.method==='sendDocument').body.get('document').size,bytes.length);assert.equal(restarted.api.calls.find(call=>call.method==='sendPhoto').body.get('photo').size,photoBytes().length);
});

test('assistant local file links keep their labels in Telegram while web links and human input remain unchanged',async t=>{
 const source='[本轮截图](/home/dant/project/output/result.png) ![Preview](<output/result%20two.png>) [Windows](C:\\work\\output\\image.png) [Web](https://example.test/result.png)';assert.equal(telegramMirrorText(source),'本轮截图 Preview Windows [Web](https://example.test/result.png)');assert.equal(telegramMirrorText('[Bad](output/%zz.png)'), '[Bad](output/%zz.png)');assert.equal(telegramMirrorText('[Network](//example.test/picture.png)'), '[Network](//example.test/picture.png)');
 const context=setup(t);await paired(context);const initial=context.api.count('sendMessage');context.store.add({role:'assistant',text:source,status:'completed'});context.store.add({role:'user',text:source});await context.gateway.flush();assert.deepEqual(context.api.calls.filter(call=>call.method==='sendMessage').slice(initial).map(call=>call.body.text),[telegramMirrorText(source),'You · desktop:\n'+source]);
});

test('delivery uncertainty is independent of a healthy connection and preserves only fixed diagnostic reasons',async t=>{
 const context=setup(t);await paired(context);context.gateway.connected=true;context.api.handlers.set('sendMessage',()=>{throw Object.assign(Error('PRIVATE '+TOKEN+' https://private.test'),{cause:{code:'ENOTFOUND'}});});context.gateway.queueText('unknown-dns','A reply');await context.gateway.flush();const status=context.gateway.status();assert.equal(status.connected,true);assert.equal(status.paired,true);assert.equal(status.connectionError,null);assert.equal(status.delivery.unknown,1);assert.equal(status.delivery.lastIssue.reason,'dns');assert.equal(status.delivery.lastIssue.status,'unknown');assert.ok(status.delivery.lastIssue.at>0);assert.equal(JSON.stringify(status).includes(TOKEN),false);assert.equal(JSON.stringify(context.gateway.config.outbox).includes('private.test'),false);
 context.gateway.connected=false;assert.equal(context.gateway.status().connectionError,null,'historical outgoing uncertainty is not a polling failure');context.gateway.config.pollError='Telegram could not be reached or returned an invalid response';context.gateway.config.lastError=context.gateway.config.pollError;assert.match(context.gateway.status().connectionError,/could not be reached/);context.gateway.connectionRestored();assert.equal(context.gateway.status().connectionError,null);assert.equal(context.gateway.status().lastError,null);assert.equal(context.gateway.status().delivery.unknown,1);assert.equal(context.gateway.status().delivery.lastIssue.reason,'dns');await context.gateway.close();const restarted=setup(t,{dir:context.dir});assert.equal(restarted.gateway.status().delivery.lastIssue.reason,'dns');await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);
});

test('invalid and oversized Telegram photo responses remain unknown with fixed reasons and no document fallback',async t=>{
 for(const [reason,response]of [['invalid-response',()=>new Response('PRIVATE INVALID RESPONSE '+TOKEN)],['response-too-large',()=>new Response('x',{headers:{'Content-Length':String(3*1024*1024)}})]]){
  const context=setup(t);await paired(context);context.api.handlers.set('sendPhoto',response);const file=context.attachments.put({name:'photo.png',data:photoBytes()});context.store.add({role:'assistant',text:'',attachments:[file],status:'completed'});await context.gateway.flush();assert.equal(context.gateway.status().delivery.lastIssue.reason,reason);assert.equal(context.gateway.status().delivery.unknown,1);assert.equal(context.api.count('sendPhoto'),1);assert.equal(context.api.count('sendDocument'),0);assert.equal(JSON.stringify(context.gateway.config.outbox).includes(TOKEN),false);
 }
});

test('legacy delivery issues have a bounded public summary without exposing filenames or private errors',async t=>{
 const context=setup(t);await paired(context);context.gateway.config.outbox.push({id:'legacy-unknown',status:'unknown',at:12345,error:'PRIVATE '+TOKEN,attachmentId:'PRIVATE FILE'});context.gateway.config.lastError='PRIVATE '+TOKEN;const status=context.gateway.status();assert.deepEqual(status.delivery.lastIssue,{status:'unknown',at:12345,reason:'unconfirmed'});assert.equal(status.connectionError,null);assert.equal(JSON.stringify(status).includes(TOKEN),false);assert.equal(JSON.stringify(status).includes('PRIVATE FILE'),false);context.gateway.config.outbox.at(-1).failureReason='PRIVATE '+TOKEN;assert.equal(context.gateway.status().delivery.lastIssue.reason,'unconfirmed');
});

test('outgoing success requires a real Telegram message receipt, including text, photos and documents',async t=>{
 for(const kind of ['text','photo','document']){
  const context=setup(t);await paired(context);const method=kind==='text'?'sendMessage':kind==='photo'?'sendPhoto':'sendDocument',before=context.api.count(method);context.api.handlers.set(method,()=>json({}));
  if(kind==='text')context.gateway.queueText('missing-receipt','A text reply');else{const file=context.attachments.put({name:kind==='photo'?'image.png':'file.txt',data:kind==='photo'?photoBytes():Buffer.from('Document bytes')});context.store.add({role:'assistant',text:'',attachments:[file],status:'completed'});}
  await context.gateway.flush();assert.equal(context.gateway.status().delivery.unknown,1);assert.equal(context.gateway.status().delivery.lastIssue.reason,'invalid-response');assert.equal(context.api.count(method),before+1);if(kind==='photo')assert.equal(context.api.count('sendDocument'),0);await context.gateway.flush();assert.equal(context.api.count(method),before+1);
 }
});

test('server errors and malformed rejection envelopes cannot authorize photo fallback or replay',async t=>{
 for(const [status,body,reason]of [[500,{ok:false,error_code:400},'server'],[500,{ok:false,error_code:429,parameters:{retry_after:1}},'server'],[429,{ok:false,error_code:500},'server'],[400,{ok:true,result:{message_id:77}},'invalid-response'],[200,{},'invalid-response']]){
  const context=setup(t);await paired(context);context.api.handlers.set('sendPhoto',()=>new Response(JSON.stringify(body),{status}));const file=context.attachments.put({name:'photo.png',data:photoBytes()});context.store.add({role:'assistant',text:'',attachments:[file],status:'completed'});await context.gateway.flush();assert.equal(context.api.count('sendPhoto'),1);assert.equal(context.api.count('sendDocument'),0);assert.equal(context.gateway.status().delivery.unknown,1);assert.equal(context.gateway.status().delivery.lastIssue.reason,reason);
 }
});
