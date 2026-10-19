import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';

const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const temp=t=>{const dir=fs.mkdtempSync(path.join(base,'engine-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class FakeWorker extends EventEmitter{
 constructor(dir){super();this.status='online';this.runtimeId='vm:test:user';this.workspaceRoot=path.join(dir,'workspaces');this.desktopPath=path.join(dir,'vm','desktop.py');this.calls=[];this.next=0;this.responses=[];this.rpc={send:value=>this.responses.push(value),reply:(id,result)=>this.responses.push({id,result})};}
 async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-test'}};if(method==='turn/start')return {turn:{id:'turn-'+ ++this.next}};if(method==='turn/interrupt')queueMicrotask(()=>this.emit('event',{method:'turn/completed',params:{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted'}}}));return {};}
 disconnect(){this.status='offline';this.emit('status');}
}
function setup(t,options={}){const dir=temp(t),store=new Store(dir),worker=new FakeWorker(dir),engine=new Engine(store,worker,options);return {dir,store,worker,engine};}
const completed=(id,status='completed')=>({method:'turn/completed',params:{threadId:'thread-test',turn:{id,status}}});

test('separate explicit deliveries share the five-file round limit and never claim an unsent sixth file',t=>{
 const {engine,store}=setup(t),round={assistantIds:[]};
 for(let index=0;index<5;index++)assert.equal(engine.deliverAttachments(round,[{id:'file-'+index,name:'file'+index,hash:String(index)}]).sent,true);
 assert.throws(()=>engine.deliverAttachments(round,[{id:'six',name:'six',hash:'six'}]),/has not been sent/);
 const repeated=engine.deliverAttachments(round,[{id:'copy',name:'same',hash:'0'}]);assert.equal(repeated.files[0].id,'file-0');assert.equal(store.state.messages.flatMap(message=>message.attachments||[]).length,5);
});

test('streamed output has a total bound and completion receipts track visible results',async t=>{
 const {store,engine}=setup(t);engine.enqueue(store.add({role:'user',text:'large output'}));await tick();
 await engine.handle({method:'item/agentMessage/delta',params:{threadId:'thread-test',turnId:'turn-1',itemId:'one',delta:'x'.repeat(100000)}});
 await engine.handle({method:'item/agentMessage/delta',params:{threadId:'thread-test',turnId:'turn-1',itemId:'two',delta:'y'.repeat(100000)}});
 assert.equal(store.state.messages.filter(m=>m.role==='assistant').reduce((n,m)=>n+m.text.length,0),120000);
 await engine.handle(completed('turn-1'));assert.equal(store.state.completions.length,1);const completion=store.state.completions[0];assert.equal(completion.readAt,null);
 store.markVisible(completion.messageIds);assert.ok(completion.readAt);assert.equal(store.state.messages[0].status,'review');
});

test('Chinese and English messages are supported and attachment-only input follows the selected language',async t=>{
 const {engine,store,worker}=setup(t);store.state.settings.language='en';await engine.thread();assert.match(worker.calls.at(-1).params.developerInstructions,/Match the current user message language/);assert.match(worker.calls.at(-1).params.developerInstructions,/ambiguous, use English/);assert.match(engine.input({text:''})[0].text,/Please inspect/);
 store.state.settings.language='zh';engine.loaded=false;await engine.thread();assert.match(worker.calls.at(-1).params.developerInstructions,/ambiguous, use Simplified Chinese/);assert.match(engine.input({text:''})[0].text,/中文/);assert.equal(engine.input({text:'Please use English.'})[0].text,'Please use English.');assert.equal(engine.input({text:'请用中文。'})[0].text,'请用中文。');
});

test('one persistent conversation UUID determines the workspace and resumed thread',async t=>{
 const {dir,store,worker,engine}=setup(t),id=store.state.conversationId;assert.match(id,/^[0-9a-f-]{36}$/);await engine.thread();
 const first=worker.calls[0];assert.equal(first.params.cwd,path.join(worker.workspaceRoot,id));assert.ok(fs.statSync(engine.outputDir).isDirectory());assert.ok(first.params.developerInstructions.includes(worker.desktopPath));assert.equal(first.params.developerInstructions.includes('/opt/dant/desktop.py'),false);
 const reopened=new Store(dir),again=new Engine(reopened,worker);await again.thread();assert.equal(reopened.state.conversationId,id);assert.equal(worker.calls.at(-1).method,'thread/resume');assert.equal(worker.calls.at(-1).params.cwd,engine.workspace);
});

test('restart pauses every leftover runnable task without replay and preserves review/acceptance',t=>{
 const dir=temp(t),store=new Store(dir);for(const status of ['queued','running','waiting_user','pausing','paused','failed','review','completed'])store.add({role:'user',text:status,status});
 const reopened=new Store(dir);assert.deepEqual(reopened.state.messages.map(message=>message.status),['paused','paused','paused','paused','paused','failed','review','completed']);
 const worker=new FakeWorker(dir),engine=new Engine(reopened,worker);assert.equal(engine.queue.length,0);assert.equal(worker.calls.length,0);assert.equal(engine.active,null);
});

test('crash during submission becomes unknown and needs explicit confirmation, while preparation remains safe to resume',t=>{
 const dir=temp(t),store=new Store(dir),submitting=store.add({role:'user',text:'May already have run',status:'running',submission:'submitting'}),preparing=store.add({role:'user',text:'Not submitted yet',status:'running',submission:'preparing'});
 store.state.threadId='shared-context';store.state.voiceHistory=[{role:'user',text:'Keep shared call context'}];store.save();const restored=new Store(dir),worker=new FakeWorker(dir);worker.status='offline';const engine=new Engine(restored,worker),uncertain=restored.state.messages.find(message=>message.id===submitting.id),safe=restored.state.messages.find(message=>message.id===preparing.id);
 assert.equal(uncertain.status,'paused');assert.equal(uncertain.submission,'unknown');assert.equal(uncertain.pauseReason,'restart');assert.equal(safe.status,'paused');assert.equal(safe.submission,'preparing');
 assert.throws(()=>engine.resumePaused([uncertain.id]),/explicitly confirm/);assert.throws(()=>engine.resumePaused([uncertain.id],{confirmUnknown:'true'}),/explicitly confirm/);assert.equal(engine.queue.length,0);assert.equal(worker.calls.length,0);
 engine.resumePaused([safe.id]);assert.equal(engine.queue.length,1);engine.resumePaused([uncertain.id],{confirmUnknown:true});assert.equal(engine.queue.length,2);assert.equal(uncertain.submission,null);assert.equal(worker.calls.length,0);assert.equal(restored.state.threadId,'shared-context');assert.equal(restored.state.voiceHistory[0].text,'Keep shared call context');
});

test('resume guards submitting and legacy unknown-outcome tasks even without a Store restart',t=>{
 const {store,worker,engine}=setup(t);worker.status='offline';
 for(const patch of [{submission:'submitting'},{submission:'unknown'},{submission:'confirmed',unknownOutcome:true}]){
  const message=store.add({role:'user',text:'Explicit retry required',status:'paused',...patch}),before=structuredClone(message);
  assert.throws(()=>engine.resumePaused([message.id]),/explicitly confirm/);assert.deepEqual(message,before);assert.equal(worker.calls.length,0);engine.resumePaused([message.id],{confirmUnknown:true});assert.equal(message.status,'queued');assert.equal(message.submission,null);assert.ok(!message.unknownOutcome);
 }
 assert.equal(engine.queue.length,3);
});

test('submission acknowledgement, assistant visibility and user acceptance are distinct',async t=>{
 const {store,worker,engine}=setup(t),message=store.add({role:'user',text:'Create a note'});assert.ok(message.receivedAt);assert.equal(message.executorConfirmedAt,null);
 engine.enqueue(message);await tick();assert.ok(message.executorConfirmedAt);assert.equal(message.read,false);
 await engine.handle({method:'item/completed',params:{threadId:'thread-test',turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:'Done'}}});await engine.handle(completed('turn-1'));
 const assistant=store.state.messages.find(item=>item.role==='assistant');assert.equal(message.status,'review');assert.equal(assistant.read,false);store.markVisible([message.id,assistant.id]);assert.equal(message.read,false);assert.equal(assistant.read,true);
 engine.confirm(message.id);assert.equal(message.status,'completed');assert.ok(message.acceptedAt);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);
});

test('events before start acknowledgement are bounded and replay only the accepted turn',async t=>{
 const {store,worker,engine}=setup(t);let reply,started;const submitted=new Promise(resolve=>started=resolve),request=worker.request.bind(worker);
 worker.request=(method,params)=>{if(method!=='turn/start')return request(method,params);worker.calls.push({method,params});started();return new Promise(resolve=>reply=resolve);};
 const message=store.add({role:'user',text:'Run'});engine.enqueue(message);await submitted;
 await engine.handle({method:'turn/started',params:{threadId:'thread-test',turn:{id:'wrong-turn'}}});
 for(let index=0;index<150;index++)await engine.handle({method:'item/agentMessage/delta',params:{threadId:'thread-test',turnId:'wrong-turn',itemId:'stale',delta:'x'}});
 await engine.handle({method:'item/completed',params:{threadId:'thread-test',turnId:'accepted-turn',item:{id:'actual',type:'agentMessage',text:'Correct'}}});await engine.handle(completed('accepted-turn'));
 assert.equal(engine.active.turnId,null);assert.equal(message.executorConfirmedAt,null);assert.ok(engine.active.early.length<=128);assert.equal(store.state.messages.length,1);
 reply({turn:{id:'accepted-turn'}});await tick();assert.equal(engine.active,null);assert.equal(message.status,'review');assert.deepEqual(store.state.messages.filter(item=>item.role==='assistant').map(item=>item.text),['Correct']);
});

test('unknown start submission is paused and cannot be retried implicitly',async t=>{
 const {store,worker,engine}=setup(t),request=worker.request.bind(worker);worker.request=(method,params)=>method==='turn/start'?Promise.reject(Error('Connection lost after submission')):request(method,params);
 const message=store.add({role:'user',text:'May have run'});engine.enqueue(message);await tick();assert.equal(message.status,'paused');assert.equal(message.submission,'unknown');assert.equal(engine.queue.length,0);
 assert.throws(()=>engine.resumePaused([message.id]),/explicitly confirm/);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);
});

test('steer uses expectedTurnId and serializes submissions while pre-ack messages queue',async t=>{
 const {store,worker,engine}=setup(t);let firstSteer,steerCount=0;const request=worker.request.bind(worker);
 worker.request=(method,params)=>{if(method!=='turn/steer')return request(method,params);worker.calls.push({method,params});if(++steerCount===1)return new Promise(resolve=>firstSteer=resolve);return Promise.resolve({});};
 engine.enqueue(store.add({role:'user',text:'Original'}));await tick();const one=store.add({role:'user',text:'First correction'}),two=store.add({role:'user',text:'Second correction'});
 const first=engine.steer(one,'turn-1'),second=engine.steer(two,'turn-1');await tick();assert.equal(steerCount,1);firstSteer({});await Promise.all([first,second]);assert.equal(steerCount,2);
 assert.ok(worker.calls.filter(call=>call.method==='turn/steer').every(call=>call.params.expectedTurnId==='turn-1'));await assert.rejects(engine.steer(store.add({role:'user',text:'Stale'}),'old-turn'),/changed/);
 await engine.handle(completed('turn-1'));assert.equal(one.status,'review');assert.equal(two.status,'review');
});

test('takeover pauses queued tasks and return requires explicit resumption',async t=>{
 const {store,worker,engine}=setup(t),one=store.add({role:'user',text:'First'}),two=store.add({role:'user',text:'Queued'});engine.enqueue(one);engine.enqueue(two);await tick();await engine.acquire();
 assert.equal(one.status,'paused');assert.equal(two.status,'paused');assert.equal(engine.takeover,true);engine.release();await tick();assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);
 engine.resumePaused([two.id]);await tick();assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,2);
});

test('human control blocks new calls and incomplete calls block takeover',async t=>{
 const {engine}=setup(t);engine.takeover=true;await assert.rejects(engine.startCall('offer'),/Return the computer/);engine.takeover=false;engine.call={started:Date.now()};await assert.rejects(engine.acquire(),/Wait for the voice call/);
});

test('completed outputs are archived against the baseline and attached once to final assistant',async t=>{
 const calls=[],collector=new EventEmitter();collector.captureBaseline=async options=>{calls.push(['capture',options]);return 'baseline';};collector.archive=async options=>{calls.push(['archive',options]);return [{id:'artifact',name:'result.txt',sha256:'hash'}];};
 const {store,engine}=setup(t,{deliverables:collector});engine.enqueue(store.add({role:'user',text:'Create output'}));await tick();await engine.handle({method:'item/completed',params:{threadId:'thread-test',turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:'Result is in output/result.txt'}}});await engine.handle(completed('turn-1'));
 assert.equal(calls[0][0],'capture');assert.equal(calls[1][0],'archive');assert.equal(calls[1][1].baseline,'baseline');assert.equal(calls[1][1].outputDir,engine.outputDir);assert.ok(calls[1][1].text.includes('output/result.txt'));
 const message=store.state.messages.find(item=>item.role==='assistant');assert.deepEqual(message.attachments.map(file=>file.id),['artifact']);
});

test('explicit chat delivery is tracked for completion and an identical streamed final is deduplicated',async t=>{
 const {store,engine}=setup(t);engine.enqueue(store.add({role:'user',text:'Share result'}));await tick();const result=await engine.tool('send_message',{text:'The requested result'});
 await engine.handle({method:'item/agentMessage/delta',params:{threadId:'thread-test',turnId:'turn-1',itemId:'answer',delta:'The requested result'}});
 await engine.handle({method:'item/completed',params:{threadId:'thread-test',turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:'The requested result'}}});await engine.handle(completed('turn-1'));
 assert.deepEqual(store.state.messages.filter(message=>message.role==='assistant').map(message=>message.text),['The requested result']);assert.deepEqual(store.state.completions[0].messageIds,[result.messageId]);await assert.rejects(engine.tool('send_message',{text:'x'.repeat(100001)}),/100000/);
});

test('ordinary tasks accept successful dant MCP chat results only once',async t=>{
 const {store,engine}=setup(t);engine.enqueue(store.add({role:'user',text:'Send useful link'}));await tick();
 const item={id:'mcp',type:'mcpToolCall',server:'dant_desktop',tool:'send_chat_message',status:'completed',arguments:{text:'https://example.test'},result:{content:[{type:'text',text:JSON.stringify({dantMessage:{text:'https://example.test'}})}]}};
 await engine.handle({method:'item/completed',params:{threadId:'thread-test',turnId:'turn-1',item}});await engine.handle({method:'item/completed',params:{threadId:'thread-test',turnId:'turn-1',item}});await engine.handle(completed('turn-1'));
 assert.equal(store.state.messages.filter(message=>message.role==='assistant').length,1);assert.equal(store.state.completions[0].messageIds.length,1);
});
