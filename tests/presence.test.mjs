import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {formatPresence} from '../ui/presence.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Worker extends EventEmitter{
 constructor(){super();this.status='online';this.calls=[];this.rpc={send(){},reply(){}};}
 async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread'}};if(method==='thread/read')return {thread:{id:params.threadId,turns:[]}};if(method==='turn/start')return {turn:{id:'turn'}};return {};}
}
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-presence-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir),worker=new Worker(),engine=new Engine(store,worker);return {dir,store,worker,engine};}
const completed={method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}};

test('presence starts unknown, persists activity, and ignores invalid/backwards/repeated timestamps',t=>{
 const {dir,store,engine}=setup(t);assert.deepEqual(engine.presence,{lastActiveAt:null});assert.deepEqual(store.state.presence,{lastActiveAt:null});
 assert.equal(engine.touchActivity(1000),true);assert.deepEqual(new Store(dir).state.presence,{lastActiveAt:1000});
 let saves=0;const save=store.save.bind(store);store.save=()=>{saves++;save();};
 for(const at of [null,undefined,0,-1,NaN,Infinity,'2000',1e30,999,1000])assert.equal(engine.touchActivity(at),at===undefined);
 // An omitted argument is the real clock and is a meaningful explicit touch.
 assert.equal(saves,1);assert.ok(engine.presence.lastActiveAt>=1000);
});

test('legacy and malformed presence normalize to unknown without inventing past activity',t=>{
 const {dir,store}=setup(t);
 for(const presence of [undefined,{},null,{lastActiveAt:'1000'},{lastActiveAt:-1},{lastActiveAt:1e30}]){
  store.state.presence=presence;store.save();assert.deepEqual(new Store(dir).state.presence,{lastActiveAt:null});
 }
 store.state.presence={lastActiveAt:1234};store.save();assert.deepEqual(new Store(dir).state.presence,{lastActiveAt:1234});
});

test('idle worker status, settings and reactions never refresh recent activity',async t=>{
 const {store,worker,engine}=setup(t);engine.touchActivity(1000);
 worker.status='offline';worker.emit('status');worker.status='online';worker.emit('status');store.state.settings.language='en';store.save();
 const message=store.add({role:'user',text:'hello'});await engine.tool('react_message',{messageId:message.id,emoji:'👍'});await tick();
 assert.equal(engine.presence.lastActiveAt,1000);assert.equal(engine.active,null);
});

test('task activity starts only after its accepted turn acknowledgement and refreshes at completion',async t=>{
 const {engine,store,worker}=setup(t);let acknowledge,submitted;const submitting=new Promise(resolve=>submitted=resolve),request=worker.request.bind(worker);
 worker.request=(method,params)=>method==='turn/start'?(submitted(),new Promise(resolve=>acknowledge=resolve)):request(method,params);
 engine.enqueue(store.add({role:'user',text:'Work'}));await submitting;assert.equal(engine.presence.lastActiveAt,null);
 await engine.handle({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});assert.equal(engine.presence.lastActiveAt,null);
 acknowledge({turn:{id:'turn'}});await tick();const started=engine.presence.lastActiveAt;assert.ok(started>0);
 const realNow=Date.now;Date.now=()=>started+60000;try{await engine.handle(completed);}finally{Date.now=realNow;}assert.equal(engine.presence.lastActiveAt,started+60000);assert.equal(engine.active,null);
 const ended=engine.presence.lastActiveAt;await engine.handle(completed);assert.equal(engine.presence.lastActiveAt,ended);
});

test('unknown task submission never invents activity',async t=>{
 const {store,worker,engine}=setup(t),request=worker.request.bind(worker);worker.request=(method,params)=>method==='turn/start'?Promise.reject(Error('Transport lost')):request(method,params);
 engine.enqueue(store.add({role:'user',text:'Unconfirmed'}));await tick();assert.equal(engine.presence.lastActiveAt,null);assert.equal(store.state.messages[0].submission,'unknown');
});

test('failed activity persistence does not drop an acknowledged running task',async t=>{
 const {store,engine}=setup(t),save=store.save.bind(store),notices=[];engine.on('notice',notice=>notices.push(notice));let failed=false;
 store.save=()=>{if(store.state.presence.lastActiveAt&&!failed){failed=true;throw Error('Injected disk failure');}return save();};
 engine.enqueue(store.add({role:'user',text:'Work safely'}));await tick();assert.equal(failed,true);assert.ok(engine.active.startAcknowledged);assert.equal(store.state.messages[0].status,'running');assert.equal(engine.presence.lastActiveAt,null);assert.ok(notices.some(notice=>notice.includes('recent activity')));
 await engine.handle(completed);assert.equal(engine.active,null);assert.ok(engine.presence.lastActiveAt>0);assert.equal(store.state.messages[0].status,'review');
});

test('negotiation does not count as activity, connected confirmation counts exactly once',async t=>{
 const {engine,worker}=setup(t);engine.voice={async start(){return {sdp:'answer'};},async stop(){}};
 const call=await engine.startCall('offer',{provider:'api'});assert.deepEqual(worker.calls.map(call=>call.method),['thread/start','thread/read']);assert.deepEqual(worker.calls[1].params,{threadId:'thread',includeTurns:true});assert.equal(engine.presence.lastActiveAt,null);assert.throws(()=>engine.confirmCallConnected('stale'),/changed/);
 const connected=engine.confirmCallConnected(call.callId),at=engine.presence.lastActiveAt;assert.equal(at,connected.connectedAt);
 let touches=0;const touch=engine.touchActivity.bind(engine);engine.touchActivity=(...args)=>{touches++;return touch(...args);};engine.confirmCallConnected(call.callId);assert.equal(touches,0);
 engine.call.connectedAt=at-7200000;engine.store.state.presence={lastActiveAt:at-7200000};await engine.stopCall(call.callId);assert.equal(touches,1);assert.ok(engine.presence.lastActiveAt>=at);
 const endedAt=engine.presence.lastActiveAt;engine.closeCall(call.callId);assert.equal(touches,1);assert.equal(engine.presence.lastActiveAt,endedAt);
});

test('presence helper gives live connection authority over cached tasks and calls',()=>{
 const state={worker:{status:'online'},presence:{lastActiveAt:1000},active:{turnId:'cached'},call:{status:'connected'},controller:{status:'offline',cached:true}};
 const value=formatPresence(state,'en',181000);assert.equal(value.label,'Disconnected');assert.equal(value.detail,'Last active 3 minutes ago');assert.equal(value.online,false);assert.equal(value.active,false);
 assert.equal(formatPresence({...state,controller:{status:'connecting'}},'en',181000).label,'Connecting');
 assert.equal(formatPresence({...state,controller:{status:'online',cached:true}},'en',181000).online,false);
 assert.equal(formatPresence({worker:{status:'offline'},controller:{status:'online'}},'zh').label,'未连接');
});

test('presence helper distinguishes current task/call from idle and suppresses stale local calls',()=>{
 const base={worker:{status:'online'},controller:{status:'online'},presence:{lastActiveAt:1000}};
 assert.deepEqual({...formatPresence({...base,active:{}},'en',61000),title:''},{label:'Online',detail:'Working',title:'',online:true,active:true});
 assert.equal(formatPresence({...base,call:{status:'connected'}},'zh',61000).detail,'正在通话');
 assert.equal(formatPresence({...base,call:{status:'connected'},callActiveNow:false},'en',61000).detail,'Last active 1 minute ago');
 assert.equal(formatPresence({...base,call:{status:'negotiating'}},'en',61000).active,false);
 assert.equal(formatPresence({workerStatus:'connecting'},'en').label,'Connecting');
});

test('relative activity text is bilingual, handles unit boundaries and clamps future clocks',()=>{
 const at=1000;
 for(const [elapsed,en,zh] of [[0,'just now','刚刚'],[59999,'just now','刚刚'],[60000,'1 minute ago','1 分钟前'],[120000,'2 minutes ago','2 分钟前'],[3600000,'1 hour ago','1 小时前'],[7200000,'2 hours ago','2 小时前'],[86400000,'1 day ago','1 天前'],[172800000,'2 days ago','2 天前']]){
  assert.equal(formatPresence({lastActiveAt:at,workerStatus:'online'},'en',at+elapsed).detail,'Last active '+en);
  assert.equal(formatPresence({lastActiveAt:at,workerStatus:'online'},'zh',at+elapsed).detail,'最近活跃：'+zh);
 }
 assert.equal(formatPresence({lastActiveAt:100000},'en',1000).detail,'Last active just now');
 for(const lastActiveAt of [null,0,-1,'1000',NaN,Infinity,1e30])assert.equal(formatPresence({lastActiveAt},'zh',at).detail,'');
 assert.equal(formatPresence().title,'');assert.match(formatPresence({lastActiveAt:at},'en',NaN).title,/^Last active:/);
});
