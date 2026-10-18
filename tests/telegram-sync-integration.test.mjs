import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createWorkerApp} from '../src/server.mjs';
import {TelegramGateway} from '../src/telegram.mjs';
import {AttachmentStore} from '../src/attachments.mjs';

const base=path.resolve('.cache/tests'),TOKEN='123456:abcdefghijklmnopqrstuvwxyz_123456789',threadId='sync-thread',sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
fs.mkdirSync(base,{recursive:true});
const event=(method,params={},id)=>({method,params:{threadId,...params},...(id===undefined?{}:{id})});
const update=(id,text)=>({update_id:id,message:{message_id:id,chat:{id:11,type:'private'},from:{id:11,is_bot:false},text}});
async function waitFor(predicate,message){const until=Date.now()+2000;while(!predicate()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate(),message);}

class Worker extends EventEmitter{
 constructor(dir){super();this.status='online';this.workspaceRoot=path.join(dir,'workspaces');this.calls=[];this.responses=[];this.nextTurn=0;this.terminated=0;this.rpc={reply:(id,result)=>this.responses.push({id,result}),send:message=>this.responses.push(message)};}
 async request(method,params){
  this.calls.push({method,params});
  if(method==='thread/start'||method==='thread/resume')return {thread:{id:threadId}};
  if(method==='thread/read'){assert.equal(params.threadId,threadId);assert.equal(params.includeTurns,true);const session=this.engine?.nativeVoice?.session;if(session?.stopping||session?.background){const turns=[...session.turns.values()].map(turn=>({id:turn.turnId,status:turn.done?'completed':'inProgress'}));return {thread:{id:threadId,status:{type:turns.some(turn=>turn.status==='inProgress')?'active':'idle'},turns}};}return {thread:{id:threadId,status:{type:'idle'},turns:this.store.state.messages.filter(message=>['user','assistant'].includes(message.role)).map(message=>({id:'turn-'+message.id,startedAt:message.time/1000,items:[message.role==='user'?{id:message.id,type:'userMessage',content:[{type:'text',text:message.text}]}:{id:message.id,type:'agentMessage',text:message.text}]}))}};}
  if(method==='turn/start')return {turn:{id:'sync-turn-'+ ++this.nextTurn}};
  if(method==='thread/realtime/start'){queueMicrotask(()=>{this.emit('event',event('thread/realtime/started',{version:'v3',realtimeSessionId:'native-'+params.voiceSessionId}));this.emit('event',event('thread/realtime/sdp',{sdp}));});return {};}
  if(method==='thread/realtime/stop'){queueMicrotask(()=>this.emit('event',event('thread/realtime/closed')));return {};}
  if(method==='turn/interrupt'){queueMicrotask(()=>this.emit('event',event('turn/completed',{turn:{id:params.turnId,status:'interrupted'}})));return {};}
  throw Error('Unexpected simulated worker method: '+method);
 }
 async terminateConfirmed(){this.terminated++;return {terminated:true};}
 disconnect(){this.status='offline';}
}

// Mock only the API media transport. The real Engine still owns call scope,
// task execution, output delivery, persistence and the Telegram change events.
class ApiVoice extends EventEmitter{
 constructor(){super();this.callId=null;this.readyCalls=[];}
 async start(options){this.callId=options.callId;this.started=options;return {sdp};}
 async conversationReady(callId){assert.equal(callId,this.callId,'Task context must belong to the active media call');this.readyCalls.push(callId);}
 async syncContext(value){assert.equal(value.callId,this.callId);return {callId:value.callId,messageId:value.message.id,kind:value.kind,status:'submitted'};}
 async stop(){this.callId=null;this.emit('closed');}
 async close(){this.callId=null;}
}

class TelegramApi{
 constructor(){this.calls=[];}
 fetch=async(url,options)=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://api.telegram.org');assert.equal(options.redirect,'error');
  if(parsed.pathname.startsWith('/file/bot'))return new Response(Buffer.from('OggSsynthetic-voice'));
  const method=parsed.pathname.split('/').at(-1),body=options.body instanceof FormData?options.body:JSON.parse(options.body);
  this.calls.push({method,body});
  const result=method==='getMe'?{id:123456,is_bot:true,username:'dant_test_bot'}:method==='getWebhookInfo'?{url:''}:method==='getFile'?{file_path:'voice/synthetic.ogg'}:['sendMessage','sendDocument'].includes(method)?{message_id:this.calls.length}:null;
  assert.ok(result,'Unexpected simulated Telegram method');return Response.json({ok:true,result});
 };
 texts(){return this.calls.filter(call=>call.method==='sendMessage').map(call=>call.body.text);}
 documents(){return this.calls.filter(call=>call.method==='sendDocument');}
}

async function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(base,'telegram-sync-integration-')),api=new TelegramApi();let gateway;
 const worker=new Worker(dir),instance=createWorkerApp({dataDir:dir,workerFactory:store=>{worker.store=store;return worker;},voiceFactory:()=>new ApiVoice(),audioTranscriberFactory:()=>({transcribe:async()=>({text:'Synthetic recorded voice',language:'en',duration:3})}),telegramFactory:options=>(gateway=new TelegramGateway({...options,fetchImpl:api.fetch,autoPoll:false})),...options});worker.engine=instance.engine;
 t.after(async()=>{await instance.close();assert.ok(path.resolve(dir).startsWith(base+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(url+'/api/session').then(response=>response.json());
 const request=async(route,body,method='POST')=>{const response=await fetch(url+route,{method,headers:{'X-Dant-Token':token,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
 instance.store.state.settings.language='en';const old=instance.store.add({role:'user',text:'Historical desktop request',status:'completed'});instance.store.add({role:'assistant',text:'Historical answer',status:'completed',taskId:old.id});
 await gateway.configure({token:TOKEN,enabled:true});const pairing=await gateway.pair();await gateway.receive(update(1,'/start '+pairing.code));await gateway.flush();api.calls=[];
 return {dir,api,worker,instance,gateway,request,store:instance.store,engine:instance.engine};
}

test('Telegram voice follows the same recognition and persistent conversation path without a transcript bubble',async t=>{
 let count=0;const heard='请用英文回答。 The blue apple is ready.';
 const f=await fixture(t,{audioTranscriberFactory:({attachments})=>({transcribe:async file=>{count++;assert.equal(attachments.read(file.id).data.toString(),'OggSsynthetic-voice');return {text:heard,language:'zh',duration:3};}})});
 await f.engine.thread();const persistent=f.store.state.threadId;
 const incoming=update(2,'');incoming.message.voice={file_id:'synthetic',file_size:20};
 await f.gateway.receive(incoming);await f.gateway.receive(incoming);
 await waitFor(()=>f.engine.active?.startAcknowledged,'Telegram voice should reach the common task engine');
 const message=f.store.state.messages.find(message=>message.source?.type==='telegram');assert.equal(message.text,'');assert.equal(message.attachments[0].type,'audio/ogg');assert.equal(count,1);
 const turns=f.worker.calls.filter(call=>call.method==='turn/start');assert.equal(turns.length,1);assert.equal(turns[0].params.threadId,persistent);assert.match(turns[0].params.input[0].text,/The blue apple is ready/);
 assert.equal(JSON.stringify(f.store.state.messages).includes(heard),false);assert.deepEqual(f.api.texts(),[]);
 await f.engine.handle(event('turn/completed',{turn:{id:f.engine.active.turnId,status:'completed'}}));
});

test('desktop API submissions and real Engine completions trigger one Telegram mirror without historical backfill',async t=>{
 const f=await fixture(t),form=new FormData();form.set('file',new Blob(['Desktop attachment']), 'desktop.txt');const file=await f.request('/api/upload',form);
 const payload={clientMessageId:randomUUID(),text:'New desktop request',attachments:[file.id],replyTo:null},message=await f.request('/api/messages',payload);await f.request('/api/messages',payload);
 await waitFor(()=>f.engine.active?.startAcknowledged,'Desktop task should reach the simulated Codex transport');const turnId=f.engine.active.turnId;
 await waitFor(()=>f.store.state.messages.find(item=>item.id===message.id)?.telegramMirror?.text==='scheduled','Engine changes should queue the desktop mirror without a direct scan call');
 await f.gateway.flush();assert.deepEqual(f.api.texts(),['You · desktop:\nNew desktop request']);assert.equal(f.api.documents().length,1);assert.equal(await f.api.documents()[0].body.get('document').text(),'Desktop attachment');
 await f.engine.handle(event('item/agentMessage/delta',{turnId,itemId:'desktop-answer',delta:'Complete answer'}));await f.gateway.flush();assert.equal(f.api.texts().length,1,'Partial streamed output must stay local');
 await f.engine.handle(event('item/completed',{turnId,item:{id:'desktop-answer',type:'agentMessage',text:'Complete answer'}}));await f.engine.handle(event('turn/completed',{turn:{id:turnId,status:'completed'}}));
 await waitFor(()=>f.store.state.messages.some(item=>item.role==='assistant'&&item.text==='Complete answer'&&item.telegramMirror?.text==='scheduled'),'Completed Engine output should trigger the mirror listener');await f.gateway.flush();
 assert.deepEqual(f.api.texts(),['You · desktop:\nNew desktop request','Complete answer']);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);assert.equal(f.store.state.completions.length,1);assert.equal(f.engine.task(message.id).status,'review');
 f.engine.change();await f.gateway.flush();assert.equal(f.api.texts().length,2);assert.equal(f.api.documents().length,1);assert.equal(f.store.state.messages.filter(item=>item.clientMessageId===payload.clientMessageId).length,1);
});

test('explicit live-call MCP text and send_file deliveries mirror once, while speech and call records stay local',async t=>{
 const f=await fixture(t),call=await f.engine.startCall(sdp);f.engine.confirmCallConnected(call.callId);const turnId='native-spoken-task';await f.engine.handle(event('turn/started',{turn:{id:turnId,status:'inProgress'}}));
 await f.engine.handle(event('thread/realtime/transcript/done',{role:'user',text:'Private spoken transcript'}));
 const item={id:'native-chat-delivery',type:'mcpToolCall',server:'dant_desktop',tool:'send_chat_message',status:'completed',arguments:{text:'Explicit voice-call result'},result:{structuredContent:{dantMessage:{text:'Explicit voice-call result'}}}};
 await f.engine.handle(event('item/completed',{turnId,item}));await f.engine.handle(event('item/completed',{turnId,item}));
 await waitFor(()=>f.store.state.messages.some(message=>message.text==='Explicit voice-call result'&&message.telegramMirror?.text==='scheduled'),'Explicit native MCP delivery should trigger the mirror listener');await f.gateway.flush();assert.deepEqual(f.api.texts(),['Explicit voice-call result']);
 const output=path.join(f.engine.outputDir,'call-result.txt');fs.writeFileSync(output,'Verified native file bytes');const delivery=event('item/tool/call',{turnId,callId:'native-file-call',tool:'send_file',arguments:{path:output}},81);await f.engine.handle(delivery);await f.engine.handle(delivery);
 await waitFor(()=>f.store.state.messages.some(message=>message.attachments?.length&&message.telegramMirror?.files?.some(file=>file.status==='scheduled')),'An attachment appended to a mirrored message should queue its own file component');await f.gateway.flush();
 assert.equal(f.api.documents().length,1);assert.equal(await f.api.documents()[0].body.get('document').text(),'Verified native file bytes');assert.deepEqual(f.api.texts(),['Explicit voice-call result']);assert.equal(f.worker.responses.filter(response=>response.id===81&&response.result?.success).length,1);
 await f.engine.handle(event('turn/completed',{turn:{id:turnId,status:'completed'}}));await f.engine.stopCall(call.callId);f.engine.change();await f.gateway.flush();
 assert.equal(f.worker.terminated,0);assert.equal(f.api.documents().length,1);assert.deepEqual(f.api.texts(),['Explicit voice-call result']);assert.equal(f.store.state.messages.some(message=>String(message.text).includes('Private spoken transcript')),false);assert.equal(f.store.state.messages.filter(message=>message.kind==='call').length,1);
});

test('Telegram-origin work starts once, receives one Engine reply without echo, and is not resent on acceptance or gateway restart',async t=>{
 const f=await fixture(t);await f.gateway.receive(update(2,'Telegram origin request'));await f.gateway.receive(update(2,'Telegram origin request'));
 await waitFor(()=>f.engine.active?.startAcknowledged,'Telegram input should reach the same ordinary Engine queue');const active=f.engine.active,task=f.engine.task(active.messageId);
 assert.equal(task.source.type,'telegram');assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);await f.gateway.flush();assert.equal(f.api.texts().some(text=>text.includes('Telegram origin request')),false);
 await f.engine.handle(event('item/completed',{turnId:active.turnId,item:{id:'telegram-answer',type:'agentMessage',text:'One Telegram answer'}}));await f.engine.handle(event('turn/completed',{turn:{id:active.turnId,status:'completed'}}));
 await waitFor(()=>f.store.state.messages.some(message=>message.text==='One Telegram answer'&&message.telegramMirror?.text==='scheduled'),'Telegram-origin assistant output should use the common mirror event path');await f.gateway.flush();assert.equal(f.api.texts().filter(text=>text==='One Telegram answer').length,1);assert.equal(f.api.texts().some(text=>text.includes('Telegram origin request')),false);
 f.engine.confirm(task.id);await f.gateway.flush();assert.equal(f.api.texts().filter(text=>text==='One Telegram answer').length,1);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);
 await f.gateway.close();const restarted=new TelegramGateway({dataDir:f.dir,store:f.store,engine:f.engine,attachments:new AttachmentStore(path.join(f.dir,'attachments')),fetchImpl:f.api.fetch,autoPoll:false});t.after(()=>restarted.close());await restarted.flush();await restarted.receive(update(2,'Telegram origin request'));await restarted.flush();assert.equal(f.api.texts().filter(text=>text==='One Telegram answer').length,1);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);
});

test('an audio-only desktop voice message mirrors the uploaded bytes without synthesizing a text echo',async t=>{
 const f=await fixture(t),bytes=Uint8Array.from([26,69,223,163,129,1,2,3]),form=new FormData();form.set('file',new Blob([bytes],{type:'audio/webm'}),'voice-message.webm');const file=await f.request('/api/upload',form);
 const message=await f.request('/api/messages',{clientMessageId:randomUUID(),text:'',attachments:[file.id],replyTo:null});await waitFor(()=>f.engine.active?.startAcknowledged,'Voice file should enter the same Engine task path');
 await waitFor(()=>f.engine.task(message.id).telegramMirror?.files?.[0]?.status==='scheduled','The audio component should be queued by the normal message change');await f.gateway.flush();assert.deepEqual(f.api.texts(),[]);assert.equal(f.api.documents().length,1);const audio=f.api.documents()[0].body.get('document');assert.equal(audio.type,'audio/webm');assert.deepEqual(new Uint8Array(await audio.arrayBuffer()),bytes);
 await f.engine.handle(event('turn/completed',{turn:{id:f.engine.active.turnId,status:'completed'}}));await f.gateway.flush();assert.equal(f.api.documents().length,1);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);
});

test('a completed ephemeral API voice task mirrors its trusted explicit text and file after its in-memory task disappears',async t=>{
 const f=await fixture(t),call=await f.engine.startCall(sdp,{provider:'api'});
 const result=f.engine.runVoiceTask('Private API voice request'),active=f.engine.active,taskId=active.messageId;await active.starting;
 assert.equal(active.voiceOutput,true);assert.equal(f.engine.task(taskId),undefined);assert.deepEqual(f.instance.voice.readyCalls,[call.callId]);assert.match(f.instance.voice.started.context,/Historical desktop request/);const turnId=active.turnId;
 const output=path.join(f.engine.outputDir,'api-call-result.txt');fs.writeFileSync(output,'Explicit API voice file bytes');
 await f.engine.handle(event('item/tool/call',{turnId,callId:'api-file-delivery',tool:'send_file',arguments:{path:output}},91));
 await f.engine.handle(event('item/tool/call',{turnId,callId:'api-text-delivery',tool:'send_message',arguments:{text:'Explicit API voice text'}},92));
 await f.engine.handle(event('item/agentMessage/delta',{turnId,itemId:'spoken-answer',delta:'Private API voice answer'}));
 await f.engine.handle(event('item/completed',{turnId,item:{id:'spoken-answer',type:'agentMessage',text:'Private API voice answer'}}));
 await f.engine.handle(event('turn/completed',{turn:{id:turnId,status:'completed'}}));assert.equal((await result).result,'Private API voice answer');await f.engine.stopCall(call.callId);
 // All simulated RPC and archive work above settles through microtasks. The
 // gateway's 100 ms change timer has not run, so no live task survives to infer
 // where these two persisted deliveries came from.
 assert.equal(f.engine.active,null);assert.equal(f.engine.voiceTasks.has(taskId),false);assert.equal(f.engine.task(taskId),undefined);
 const delivered=f.store.state.messages.filter(message=>message.taskId===taskId);assert.equal(delivered.length,2);assert.ok(delivered.every(message=>message.source?.type==='voice-call'&&message.source.conversationId===f.store.state.conversationId));assert.ok(delivered.every(message=>!message.telegramMirror));
 assert.equal(f.gateway.config.outbox.filter(item=>delivered.some(message=>message.id===item.localMessageId)).length,0);
 await waitFor(()=>delivered.every(message=>message.telegramMirror?.text==='scheduled'||message.telegramMirror?.files?.some(file=>file.status==='scheduled')),'The shared Engine change listener should mirror trusted persisted voice deliveries after the task is gone');await f.gateway.flush();
 assert.deepEqual(f.api.texts(),['Explicit API voice text']);assert.equal(f.api.documents().length,1);assert.equal(await f.api.documents()[0].body.get('document').text(),'Explicit API voice file bytes');assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);
 assert.equal(f.store.state.messages.some(message=>String(message.text).includes('Private API voice')),false);assert.equal(f.store.state.completions.length,0);
 await f.gateway.close();const restarted=new TelegramGateway({dataDir:f.dir,store:f.store,engine:f.engine,attachments:new AttachmentStore(path.join(f.dir,'attachments')),fetchImpl:f.api.fetch,autoPoll:false});t.after(()=>restarted.close());await restarted.flush();
 assert.deepEqual(f.api.texts(),['Explicit API voice text']);assert.equal(f.api.documents().length,1);assert.equal(f.worker.calls.filter(call=>call.method==='turn/start').length,1);
});

test('worker HTTP language settings immediately control the next Telegram prompt without depending on sender locale',async t=>{
 const f=await fixture(t),before=f.store.state.messages.map(message=>({id:message.id,text:message.text}));
 const help=async(id,senderLanguage)=>{const incoming=update(id,'/help');incoming.message.from.language_code=senderLanguage;await f.gateway.receive(incoming);await f.gateway.flush();return f.api.texts().at(-1);};
 assert.doesNotMatch(await help(2,'zh-hans'),/\p{Script=Han}/u);
 await f.request('/api/settings',{language:'zh'},'PATCH');assert.equal(f.store.state.settings.language,'zh');const chinese=await help(3,'en');assert.match(chinese,/已连接 dant/);assert.doesNotMatch(chinese,/Send text|Shared work progress|Stop only this Telegram/);
 await f.request('/api/settings',{language:'en'},'PATCH');assert.equal(f.store.state.settings.language,'en');const english=await help(4,'zh-hans');assert.match(english,/Connected to dant/);assert.doesNotMatch(english,/\p{Script=Han}/u);
 assert.deepEqual(f.store.state.messages.map(message=>({id:message.id,text:message.text})),before);assert.equal(f.worker.calls.some(call=>['turn/start','turn/steer','thread/realtime/start'].includes(call.method)),false);
});
