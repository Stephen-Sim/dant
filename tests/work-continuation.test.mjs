import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {WorkContinuationSupervisor} from '../src/work-continuation.mjs';

const NOW=Date.parse('2026-10-18T00:00:00Z');
const pendingPlan=()=>({steps:[{step:'Verify the entrusted result',status:'pending'}]});
const work=(id='work-one',extra={})=>({id,turnId:'turn-'+id,status:'continuing',executionEndedAt:NOW-10000,plan:pendingPlan(),...extra});
const metadata=(nextAt,extra={})=>({nextAt,attempts:1,noProgressCount:0,lastCheckpoint:'a'.repeat(64),...extra});
const dispatch=phase=>({id:'dispatch-one',fromTurnId:'turn-work-one',runtimeId:'runtime',threadId:'thread',phase,createdAt:NOW-1000,...(phase==='acknowledged'?{turnId:'next-turn'}:{})});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function fakeClock(){
 let at=NOW,nextId=0;const jobs=new Map();
 return {now:()=>at,set:value=>{at=value;},jobs,
  setTimer(fn,delay){const id=nextId++;jobs.set(id,{fn,delay,next:at+delay});return id;},
  clearTimer:id=>jobs.delete(id),
  async advance(ms){const end=at+ms;let iterations=0;for(;;){const entry=[...jobs].filter(([,job])=>job.next<=end).sort((a,b)=>a[1].next-b[1].next||a[0]-b[0])[0];if(!entry)break;if(++iterations>1000)throw Error('Unexpected timer loop');at=entry[1].next;entry[1].next+=entry[1].delay;entry[1].fn();await settle();}at=end;await settle();}
 };
}
function fixture(t,records=[work()]){
 const clock=fakeClock(),engine=new EventEmitter(),store={state:{workTasks:records,messages:[]}},worker={status:'online'},calls=[],notices=[];
 let allowed=true,continueWork=(id,{expectedTurnId})=>{const current=store.state.workTasks.find(record=>record.id===id);assert.equal(current.turnId,expectedTurnId);store.state.workTasks=store.state.workTasks.map(record=>record===current?{...record,status:'running'}:record);return {continued:true,workId:id};};
 Object.assign(engine,{store,worker,canContinueRegisteredWork:()=>allowed,continueRegisteredWork(id,scope){calls.push({id,...scope});return continueWork(id,scope);}});
 engine.on('notice',message=>notices.push(message));
 const supervisor=new WorkContinuationSupervisor({engine,now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer});
 t.after(()=>supervisor.close());return {clock,engine,store,worker,calls,notices,supervisor,setAllowed:value=>allowed=value,setContinue:fn=>continueWork=fn};
}

test('construction and start create no executor, message or immediate submission; a tick uses only the exact Engine continuation entry',async t=>{
 const f=fixture(t);assert.equal(f.clock.jobs.size,0);assert.equal(f.engine.listenerCount('change'),0);f.supervisor.start();assert.equal(f.clock.jobs.size,1);assert.equal(f.engine.listenerCount('change'),1);assert.equal(f.calls.length,0);
 assert.deepEqual(await f.supervisor.tick(),{continued:true,workId:'work-one'});assert.deepEqual(f.calls,[{id:'work-one',expectedTurnId:'turn-work-one'}]);assert.deepEqual(f.store.state.messages,[]);assert.equal(f.clock.jobs.size,1);
});

test('first continuation waits five seconds after confirmed execution end and becomes eligible at the boundary',async t=>{
 const f=fixture(t,[work('fresh',{executionEndedAt:NOW})]);assert.equal(await f.supervisor.tick(),null);f.clock.set(NOW+4999);await f.supervisor.tick();assert.equal(f.calls.length,0);f.clock.set(NOW+5000);await f.supervisor.tick();assert.deepEqual(f.calls,[{id:'fresh',expectedTurnId:'turn-fresh'}]);
});

test('saved nextAt overrides the initial due time and an existing dispatch is never submitted again',async t=>{
 const f=fixture(t,[work('later',{continuation:metadata(NOW+1000)}),work('work-one',{continuation:metadata(NOW-1000,{dispatch:dispatch('acknowledged')})})]);const before=structuredClone(f.store.state);await f.supervisor.tick();assert.equal(f.calls.length,0);assert.deepEqual(f.store.state,before);f.clock.set(NOW+1000);await f.supervisor.tick();assert.equal(f.calls[0].id,'later');
});

test('only unfinished continuing work with a confirmed end and safe persisted metadata is eligible',async t=>{
 const variants=[...['running','waiting_user','paused','failed','review','completed','cancelled','unknown','pausing'].map(status=>({status})),{executionEndedAt:undefined},{executionEndedAt:NaN},{executionEndedAt:NOW+1},{progressDismissedAt:NOW-1},{unknownOutcome:true},{submission:'unknown'},{submission:'submitting'},{id:''},{turnId:null},{plan:undefined},{plan:{steps:[]}},{plan:{steps:[{step:'Done',status:'completed'}]}},{plan:{steps:[{step:'Invalid',status:'invented'}]}},{plan:null},{continuation:metadata(null)},{continuation:metadata(NOW-1,{attempts:3,noProgressCount:3})},{continuation:{}},...['claimed','submitting','acknowledged','unknown'].map(phase=>({continuation:metadata(NOW-1,{dispatch:dispatch(phase)})}))];
 for(const extra of variants){const f=fixture(t,[work('work-one',extra)]),before=structuredClone(f.store.state);await f.supervisor.tick();assert.equal(f.calls.length,0,JSON.stringify(extra));assert.deepEqual(f.store.state,before);assert.equal(f.notices.length,0);}
});

test('an observed unfinished task with an authentic null plan can continue without invented steps',async t=>{
 const f=fixture(t,[work('observed',{plan:null,provisional:true})]);await f.supervisor.tick();assert.equal(f.calls[0].id,'observed');assert.equal(f.store.state.workTasks[0].plan,null);assert.deepEqual(f.store.state.messages,[]);
});

test('selection uses priority before oldest due time and retains source order for exact ties',async t=>{
 const f=fixture(t,[work('normal-old',{executionEndedAt:NOW-90000}),work('high-later',{progressPriority:'high',continuation:metadata(NOW-1000)}),work('high-first',{progressPriority:'high',continuation:metadata(NOW-2000)}),work('high-tie',{progressPriority:'high',continuation:metadata(NOW-2000)}),work('low-old',{progressPriority:'low',executionEndedAt:NOW-100000}),work('default',{progressPriority:undefined,executionEndedAt:NOW-20000})]);
 for(let i=0;i<6;i++)await f.supervisor.tick();assert.deepEqual(f.calls.map(call=>call.id),['high-first','high-tie','high-later','normal-old','default','low-old']);
});

test('the authoritative availability fence blocks pauses, ownership barriers and closure while allowing a stable idle call',async t=>{
 const f=fixture(t);f.setAllowed(false);for(const reason of ['user-paused','active','finishing','cancelling','takeover','acquiring','queue','pending-followup','pending-reference','user-input','native-unknown','native-submitting','native-stopping','native-reconnecting','native-handoff','setting-disabled','service-closed']){f.engine.blocker=reason;await f.supervisor.tick();}assert.equal(f.calls.length,0);assert.equal(f.notices.length,0);
 f.setAllowed(true);f.engine.call={id:'stable-call',status:'connected'};await f.supervisor.tick();assert.equal(f.calls.length,1);assert.equal(f.engine.call.status,'connected');
});

test('offline workers and missing or non-boolean admission functions fail closed',async t=>{
 for(const value of [undefined,()=>undefined,()=>({available:true}),()=>Promise.resolve(true)]){const f=fixture(t);f.engine.canContinueRegisteredWork=value;await f.supervisor.tick();assert.equal(f.calls.length,0);}
 const f=fixture(t);f.worker.status='connecting';await f.supervisor.tick();f.worker.status='offline';await f.supervisor.tick();assert.equal(f.calls.length,0);f.worker.status='online';await f.supervisor.tick();assert.equal(f.calls.length,1);
});

test('the selected work is read again after admission and cannot retarget a changed or removed owner',async t=>{
 for(const mutate of [f=>f.store.state.workTasks=[work('work-one',{turnId:'new-owner'})],f=>f.store.state.workTasks=[],f=>f.store.state.workTasks=[work('work-one',{status:'waiting_user'})],f=>f.store.state.workTasks=[work('work-one',{continuation:metadata(NOW+5000)})]]){const f=fixture(t);let checks=0;f.engine.canContinueRegisteredWork=()=>{if(++checks===2)mutate(f);return true;};await f.supervisor.tick();assert.equal(f.calls.length,0);}
});

test('concurrent ticks and repeated changes never submit while a continuation acknowledgement is pending',async t=>{
 const f=fixture(t,[work('one'),work('two')]),ack=deferred();f.setContinue(()=>ack.promise);f.supervisor.start();const first=f.supervisor.tick();await f.supervisor.tick();f.engine.emit('change');f.engine.emit('change');await f.clock.advance(30000);assert.equal(f.calls.length,1);ack.resolve({continued:true});assert.deepEqual(await first,{continued:true});assert.equal(f.calls.length,1);assert.equal(f.supervisor.running,false);
});

test('sync and async failures keep a fixed safe notice and throttle future checks for at least thirty seconds',async t=>{
 for(const reject of [()=>{throw Error('SECRET private task and token');},()=>Promise.reject(Error('SECRET private task and token'))]){const f=fixture(t);f.setContinue(reject);await f.supervisor.tick();assert.equal(f.calls.length,1);assert.deepEqual(f.notices,['Unfinished work could not be continued. Its saved state was preserved.']);f.clock.set(NOW+29999);await f.supervisor.tick();assert.equal(f.calls.length,1);f.clock.set(NOW+30000);f.setContinue(()=>({continued:true}));await f.supervisor.tick();assert.equal(f.calls.length,2);assert.equal(JSON.stringify(f.notices).includes('SECRET'),false);assert.equal(f.store.state.workTasks[0].status,'continuing');}
});

test('failure cooldown starts when a delayed failure is observed and never replays persisted unknown submission',async t=>{
 const f=fixture(t),ack=deferred();f.setContinue(()=>ack.promise);const first=f.supervisor.tick();f.clock.set(NOW+100000);f.store.state.workTasks=[work('work-one',{continuation:metadata(NOW-1,{dispatch:dispatch('unknown')})})];ack.reject(Error('Transport acknowledgement lost'));await first;f.clock.set(NOW+130000);await f.supervisor.tick();assert.equal(f.calls.length,1);assert.equal(f.notices.length,1);
});

test('start coalesces change events into one five-second check and maintains one independent periodic timer',async t=>{
 const f=fixture(t);f.supervisor.start();f.supervisor.start();assert.equal(f.clock.jobs.size,1);f.engine.emit('change');f.engine.emit('change');assert.equal(f.clock.jobs.size,2);await f.clock.advance(4000);f.engine.emit('change');await f.clock.advance(4999);assert.equal(f.calls.length,0);await f.clock.advance(1);assert.equal(f.calls.length,1);assert.equal(f.clock.jobs.size,1);assert.equal(f.engine.listenerCount('change'),1);
});

test('periodic checks survive failures without a hot loop and resume after the saved eligibility fence permits',async t=>{
 const f=fixture(t);f.setContinue(()=>{throw Error('private');});f.supervisor.start();await f.clock.advance(30000);assert.equal(f.calls.length,1);assert.equal(f.clock.jobs.size,1);f.engine.emit('change');await f.clock.advance(5000);assert.equal(f.calls.length,1);await f.clock.advance(24999);assert.equal(f.calls.length,1);f.setAllowed(false);await f.clock.advance(1);assert.equal(f.calls.length,1);f.setAllowed(true);f.setContinue(()=>({continued:true}));await f.clock.advance(30000);assert.equal(f.calls.length,2);assert.equal(f.clock.jobs.size,1);
});

test('close removes all listeners and timers, including timer ID zero and callbacks already queued for delivery',async t=>{
 const f=fixture(t);f.supervisor.start();assert.ok(f.clock.jobs.has(0));f.engine.emit('change');const callbacks=[...f.clock.jobs.values()].map(job=>job.fn);f.supervisor.close();f.supervisor.close();f.supervisor.start();assert.equal(f.clock.jobs.size,0);assert.equal(f.engine.listenerCount('change'),0);for(const callback of callbacks)callback();f.engine.emit('change');await f.clock.advance(120000);await f.supervisor.tick();assert.equal(f.calls.length,0);assert.equal(f.clock.jobs.size,0);
});

test('a cleared old debounce callback cannot submit early or erase its replacement timer',async t=>{
 const f=fixture(t);f.supervisor.start();f.engine.emit('change');const old=[...f.clock.jobs.values()].find(job=>job.delay===5000).fn;await f.clock.advance(1000);f.engine.emit('change');old();assert.equal(f.clock.jobs.size,2);await f.clock.advance(4999);assert.equal(f.calls.length,0);await f.clock.advance(1);assert.equal(f.calls.length,1);assert.equal(f.clock.jobs.size,1);
});

test('closing during an admitted request never schedules another task or emits a late error notice',async t=>{
 for(const failure of [false,true]){const f=fixture(t,[work('one'),work('two')]),ack=deferred();f.setContinue(()=>ack.promise);f.supervisor.start();const pending=f.supervisor.tick();f.engine.emit('change');f.supervisor.close();if(failure)ack.reject(Error('late private error'));else ack.resolve({continued:true});assert.equal(await pending,null);await f.clock.advance(120000);assert.equal(f.calls.length,1);assert.equal(f.notices.length,0);assert.equal(f.clock.jobs.size,0);assert.equal(f.supervisor.running,false);}
});

test('a notice observer failure cannot break the supervisor or leak the original rejection',async t=>{
 const f=fixture(t);f.engine.on('notice',()=>{throw Error('bad UI observer');});f.setContinue(()=>Promise.reject(Error('private transport body')));await assert.doesNotReject(f.supervisor.tick());assert.equal(f.supervisor.running,false);f.clock.set(NOW+30000);await assert.doesNotReject(f.supervisor.tick());assert.equal(f.calls.length,2);assert.equal(f.notices.length,2);
});
