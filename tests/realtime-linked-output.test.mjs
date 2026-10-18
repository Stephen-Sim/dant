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

const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=','base64');
const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const event=(method,params={})=>({method,params:{threadId:'thread',...params}});
class Worker extends EventEmitter{
 constructor(dir){super();this.status='online';this.workspaceRoot=path.join(dir,'workspaces');this.calls=[];this.responses=[];this.rpc={reply:(id,result)=>this.responses.push({id,result})};}
 emitEvent(method,params={}){this.emit('event',event(method,params));}
 async request(method,params){
  this.calls.push({method,params});
  if(method==='thread/start')return {thread:{id:'thread'}};
  if(method==='thread/realtime/start'){queueMicrotask(()=>{this.emitEvent('thread/realtime/started',{version:'v3',realtimeSessionId:'native-'+params.voiceSessionId});this.emitEvent('thread/realtime/sdp',{sdp});});return {};}
  if(method==='thread/realtime/stop'){queueMicrotask(()=>this.emitEvent('thread/realtime/closed'));return {};}
  if(method==='thread/read'){const turns=[...(this.engine.nativeVoice.session?.turns.values()||[])].map(turn=>({id:turn.turnId,status:turn.done?'completed':'inProgress'}));return {thread:{id:'thread',status:{type:turns.some(turn=>turn.status==='inProgress')?'active':'idle'},turns}};}
  return {};
 }
 async terminateConfirmed(){throw Error('File delivery must not terminate the executor');}
}
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(base,'native-linked-output-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),base);assert.ok(path.basename(dir).startsWith('native-linked-output-'));fs.rmSync(dir,{recursive:true,force:true});});
 const store=new Store(dir),worker=new Worker(dir),attachments=new AttachmentStore(path.join(dir,'attachments')),collector=new DeliverableCollector(attachments),engine=new Engine(store,worker,{deliverables:collector}),voice=new NativeRealtimeVoice({worker,engine,connectTimeoutMs:1000,stopTimeoutMs:1000});worker.engine=engine;
 fs.mkdirSync(engine.outputDir,{recursive:true});const file=path.join(engine.outputDir,'result.png');fs.writeFileSync(file,png);
 const call=await engine.startCall(sdp);await engine.handle(event('turn/started',{turn:{id:'native-task',status:'inProgress'}}));
 const turn=voice.session.turns.get('native-task'),text=`结果截图：[结果截图](${file})`,finish=()=>engine.handle(event('turn/completed',{turn:{id:'native-task',status:'completed'}}));
 return {store,worker,attachments,collector,engine,voice,call,turn,file,text,finish};
}
function assertNoExtraExecution(worker){
 assert.equal(worker.calls.filter(call=>call.method==='thread/start').length,1);
 assert.equal(worker.calls.filter(call=>call.method==='thread/realtime/start').length,1);
 assert.deepEqual(worker.calls.filter(call=>['turn/start','turn/steer','turn/interrupt'].includes(call.method)),[]);
}

test('native work after hangup archives an existing linked image onto its original result message',async t=>{
 const {store,worker,attachments,collector,engine,voice,call,turn,file,text,finish}=await fixture(t);
 await engine.stopCall(call.callId);assert.equal(engine.call,null);assert.equal(turn.background,true);
 await engine.handle(event('item/completed',{turnId:turn.turnId,item:{id:'result',type:'agentMessage',text}}));
 const archive=collector.archive.bind(collector);let release,started;const pendingArchive=new Promise(resolve=>started=resolve);
 collector.archive=options=>{if(options.onlyExplicit){started();return new Promise(resolve=>release=()=>resolve(archive(options)));}return archive(options);};
 const finishing=finish();await pendingArchive;
 const linked=store.state.messages.find(message=>message.text===text),later=engine.deliverText('A later status update',turn);
 assert.ok(linked);assert.deepEqual(linked.attachments||[],[]);release();await finishing;
 assert.equal(linked.attachments.length,1);assert.equal(linked.attachments[0].sourcePath,file);assert.equal(linked.attachments[0].type,'image/png');assert.deepEqual(attachments.read(linked.attachments[0].id).data,png);
 assert.deepEqual(engine.task(later.messageId).attachments||[],[]);assert.equal(store.state.messages.filter(message=>message.role==='assistant').length,2);
 assert.equal(turn.resultSaved,true);assert.equal(voice.session,null);assertNoExtraExecution(worker);
});

test('native messages linking the same image share its immutable attachment while keeping both links usable',async t=>{
 const {store,worker,attachments,engine,call,turn,file,text,finish}=await fixture(t);
 const send=(requestId,text)=>engine.handle({...event('item/tool/call',{turnId:turn.turnId,callId:'delivery-'+requestId,tool:'send_message',arguments:{text}}),id:requestId});
 await send(1,text);await send(2,`再看这张：[结果截图](${file})`);
 const messages=store.state.messages.filter(message=>message.role==='assistant');assert.equal(messages.length,2);
 for(const message of messages){assert.equal(message.attachments.length,1);assert.equal(message.attachments[0].sourcePath,file);assert.deepEqual(attachments.read(message.attachments[0].id).data,png);}
 assert.equal(messages[0].attachments[0].id,messages[1].attachments[0].id);assert.equal(worker.responses.every(response=>response.result.success===true),true);
 await finish();assert.equal(store.state.messages.filter(message=>message.role==='assistant').length,2);assert.ok(messages.every(message=>message.attachments.length===1));
 await engine.stopCall(call.callId);assertNoExtraExecution(worker);
});
