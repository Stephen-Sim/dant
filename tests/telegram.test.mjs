import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {TelegramGateway,splitTelegramText} from '../src/telegram.mjs';
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
  if(method==='sendMessage'||method==='sendDocument')return json({message_id:77});
  throw Error('Unexpected Telegram method');
 };
 count(method){return this.calls.filter(call=>call.method===method).length;}
}
function setup(t,options={}){
 const dir=options.dir||fs.mkdtempSync(path.join(base,'telegram-test-'));if(!options.dir)t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir),engine=new FakeEngine(store),attachments=new AttachmentStore(path.join(dir,'attachments')),api=new MockApi();
 const gateway=new TelegramGateway({dataDir:dir,store,engine,attachments,fetchImpl:api.fetch,autoPoll:false,...options.gateway});t.after(()=>gateway.close());return {dir,store,engine,attachments,api,gateway};
}
function update(id,text,extra={}){return {update_id:id,message:{message_id:id,chat:{id:11,type:'private'},from:{id:11,is_bot:false},text,...extra}};}
async function paired(context){await context.gateway.configure({token:TOKEN,enabled:true});const pairing=await context.gateway.pair();await context.gateway.receive(update(1,'/start '+pairing.code));await context.gateway.flush();return pairing;}
function complete(context,text='Done',files=[]){const task=context.store.state.messages.find(message=>message.role==='user'&&message.source?.type==='telegram');context.store.update(task.id,{status:'review',turnId:'turn-test'});const reply=context.store.add({role:'assistant',text,status:'completed',taskId:task.id,attachments:files});return {task,reply};}

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

test('only final replies belonging to this Telegram task are sent, with files and without auto acceptance',async t=>{
 const context=setup(t);await paired(context);const initial=context.api.count('sendMessage');const desktop=context.store.add({role:'user',text:'Desktop task',status:'review'});context.store.add({role:'assistant',text:'Desktop secret answer',taskId:desktop.id,status:'completed'});
 await context.gateway.receive(update(2,'Generate a result'));const task=context.store.state.messages.find(message=>message.source?.type==='telegram');context.store.add({role:'assistant',text:'Streaming draft',taskId:task.id,status:'streaming'});await context.gateway.flush();assert.equal(context.api.count('sendMessage'),initial);
 const file=context.attachments.put({name:'result.txt',data:Buffer.from('final output')});complete(context,'Final **plain text** 中文',[file]);await context.gateway.flush();const sent=context.api.calls.filter(call=>call.method==='sendMessage').at(-1);assert.equal(sent.body.text,'Final **plain text** 中文');assert.equal(sent.body.parse_mode,undefined);assert.equal(context.api.count('sendDocument'),1);assert.equal(context.api.calls.find(call=>call.method==='sendDocument').body.get('document').name,'result.txt');assert.equal(task.status,'review');
 const count=context.api.calls.length;await context.gateway.flush();assert.equal(context.api.calls.length,count);assert.equal(JSON.stringify(context.api.calls.filter(call=>call.method==='sendMessage').map(call=>call.body)).includes('Desktop secret answer'),false);
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
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'/status'));await context.gateway.receive(update(3,'/help'));await context.gateway.flush();assert.ok(context.api.calls.some(call=>call.method==='sendMessage'&&call.body.text.includes('Telegram tasks:')));assert.ok(context.api.calls.filter(call=>call.method==='sendMessage').every(call=>call.body.chat_id==='11'));
});

test('polling uses bounded backoff after a read failure and aborts its idle delay on close',async t=>{
 const context=setup(t,{gateway:{autoPoll:true,retryBaseMs:2}});let requests=0,second;const resumed=new Promise(resolve=>second=resolve);context.api.handlers.set('getUpdates',()=>{if(++requests===1)throw Error('offline');second();return json([]);});await context.gateway.configure({token:TOKEN,enabled:true});await resumed;await tick();assert.ok(requests>=2);await context.gateway.close();assert.equal(context.gateway.status().connected,false);assert.equal(context.gateway.loopAbort.signal.aborted,true);
});

test('Unicode output pressure obeys the file byte bound as well as the queue entry count',async t=>{
 const context=setup(t);await paired(context);for(let index=0;index<80;index++)context.gateway.queueText('unicode-'+index,'中'.repeat(4096));assert.match(context.gateway.status().lastError,/byte limit/);assert.ok(context.gateway.config.outbox.length<128);assert.ok(fs.statSync(context.gateway.file).size<1024*1024);
});

test('real Engine preserves human takeover and native-call constraints for Telegram submissions',async t=>{
 const context=setup(t);await paired(context);await context.gateway.close();class Worker extends EventEmitter{constructor(){super();this.status='online';this.calls=[];}async request(method,params){this.calls.push({method,params});return method==='thread/start'?{thread:{id:'tg-thread'}}:{turn:{id:'tg-turn'}};}}
 const worker=new Worker(),engine=new Engine(context.store,worker),gateway=new TelegramGateway({dataDir:context.dir,store:context.store,engine,attachments:context.attachments,fetchImpl:context.api.fetch,autoPoll:false});t.after(()=>gateway.close());engine.takeover=true;await gateway.receive(update(2,'While human controls'));assert.equal(context.store.state.messages[0].status,'paused');engine.takeover=false;engine.call={provider:'subscription'};await gateway.receive(update(3,'During native call'));assert.equal(context.store.state.messages[1].status,'paused');assert.equal(worker.calls.length,0);engine.call=null;
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
 let queued=0;const queue=context.gateway.queue.bind(context.gateway);context.gateway.queue=item=>{queued++;const accepted=queue(item);if(accepted)context.gateway.config.outbox.find(entry=>entry.id===item.id).status='sent';return accepted;};
 context.gateway.scanResults();assert.equal(queued,1001);assert.equal(context.gateway.config.outbox.length,128);assert.equal(context.gateway.config.resultKeys.length,0);assert.ok(context.store.state.messages.filter(item=>item.role==='user').every(task=>task.telegramDelivery?.status==='scheduled'));
 queued=0;context.gateway.scanResults();context.gateway.scanResults();context.store.state.messages[0].status='completed';context.gateway.scanResults();assert.equal(queued,0);
 context.gateway.config.outbox=[];context.gateway.save();context.store.save();await context.gateway.close();const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);assert.equal(restarted.gateway.config.outbox.length,0);assert.equal(restarted.gateway.config.resultKeys.length,0);
});

test('a resumed task delivers only the new turn reply and keeps its previous delivery boundary across restart',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Resume this task later'));const {task}=complete(context,'First turn answer');await context.gateway.flush();const previousKey=task.telegramDelivery.key;
 await context.gateway.close();const restarted=setup(t,{dir:context.dir}),again=restarted.store.state.messages.find(item=>item.id===task.id);restarted.store.update(again.id,{status:'review',turnId:'second-turn'});restarted.store.add({id:'second-answer',role:'assistant',taskId:again.id,text:'Second turn answer',status:'completed'});await restarted.gateway.flush();assert.deepEqual(restarted.api.calls.filter(call=>call.method==='sendMessage').map(call=>call.body.text),['Second turn answer']);assert.notEqual(again.telegramDelivery.key,previousKey);assert.equal(again.telegramDelivery.replyThroughId,'second-answer');assert.equal(again.status,'review');const requests=restarted.api.count('sendMessage');await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),requests);
});

test('an interrupted delivery schedule becomes unknown without repeating any output after restart',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Task'));const {task}=complete(context,'Do not replay after a scheduling crash');context.gateway.queue=()=>{throw Error('Simulated schedule crash');};assert.throws(()=>context.gateway.scanResults(),/schedule crash/);assert.equal(task.telegramDelivery.status,'scheduling');await context.gateway.close();
 const restarted=setup(t,{dir:context.dir});await restarted.gateway.flush();assert.equal(restarted.store.state.messages.find(message=>message.id===task.id).telegramDelivery.status,'unknown');assert.match(restarted.gateway.status().lastError,/scheduling was interrupted/);assert.equal(restarted.api.count('sendMessage'),0);await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);
});

test('a task whose reply could not enter a full outbox is marked once and is not retried when space becomes free',async t=>{
 const context=setup(t);await paired(context);for(let index=0;index<128;index++)context.gateway.queueText('full-'+index,'Pending output');await context.gateway.receive(update(2,'Task'));const {task}=complete(context,'Reply rejected by queue pressure');context.gateway.scanResults();assert.equal(task.telegramDelivery.status,'failed');context.gateway.config.outbox=[];context.gateway.save();await context.gateway.flush();assert.equal(context.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text==='Reply rejected by queue pressure').length,0);assert.equal(context.gateway.config.outbox.length,0);
});

test('legacy result keys migrate into durable task markers before their bounded ledger is discarded',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Legacy task'));const {task}=complete(context,'Previously delivered');context.gateway.config.resultKeys=[`result:${task.id}:${task.turnId}:result`];context.gateway.save();context.gateway.scanResults();assert.equal(task.telegramDelivery.status,'scheduled');assert.equal(task.telegramDelivery.pairingId,context.gateway.config.owner.pairingId);
 context.gateway.config.resultKeys=[];context.gateway.save();await context.gateway.flush();assert.equal(context.api.calls.filter(call=>call.method==='sendMessage'&&call.body.text==='Previously delivered').length,0);assert.equal(context.gateway.config.outbox.filter(item=>item.taskId===task.id).length,0);
});

test('upgrade from an already truncated legacy ledger conservatively withholds forgotten historical replies',async t=>{
 const context=setup(t);await paired(context);await context.gateway.receive(update(2,'Forgotten old task'));const {task:forgotten}=complete(context,'Forgotten delivery identity');await context.gateway.receive(update(3,'Remembered old task'));const remembered=context.store.state.messages.find(message=>message.role==='user'&&message.id!==forgotten.id);context.store.update(remembered.id,{status:'review',turnId:'remembered-turn'});context.store.add({role:'assistant',taskId:remembered.id,status:'completed',text:'Known delivered answer'});
 delete context.gateway.config.deliveryVersion;context.gateway.config.resultKeys=[`result:${remembered.id}:remembered-turn:result`];context.gateway.save();await context.gateway.close();const restarted=setup(t,{dir:context.dir});assert.equal(restarted.store.state.messages.find(message=>message.id===forgotten.id).telegramDelivery.status,'unknown');assert.equal(restarted.store.state.messages.find(message=>message.id===remembered.id).telegramDelivery.status,'scheduled');assert.match(restarted.gateway.status().lastError,/history was incomplete/);await restarted.gateway.flush();await restarted.gateway.flush();assert.equal(restarted.api.count('sendMessage'),0);assert.equal(restarted.gateway.config.deliveryVersion,2);
});
