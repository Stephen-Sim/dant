import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createWorkerApp} from '../src/server.mjs';
import {Store} from '../src/store.mjs';
import {SKILL_SUPPORT_FILE_LIMIT} from '../src/skill-limits.mjs';

const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});
class Worker extends EventEmitter{
 constructor(){super();this.status='online';this.calls=[];this.rpc={reply(){},send(){}};this.turns=0;this.connections=0;}
 async connect(){this.connections++;this.status='connecting';if(this.connectWait)await this.connectWait();this.status='online';return {ok:true};}
 async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'api-thread'}};if(method==='turn/start')return {turn:{id:'api-turn-'+ ++this.turns}};if(method==='turn/interrupt')queueMicrotask(()=>this.emit('event',{method:'turn/completed',params:{threadId:'api-thread',turn:{id:params.turnId,status:'interrupted'}}}));return {ok:true};}
 async guest(route){if(route==='/screen')return new Response(Buffer.from([137,80,78,71,13,10,26,10]));return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});}
 disconnect(){this.status='offline';this.emit('status');}
}
async function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(root,'api-routes-')),worker=new Worker(),keys={configured:false};
 const instance=createWorkerApp({dataDir:dir,workerFactory:()=>worker,secretFactory:()=>({status:()=>({...keys}),set:async()=>{keys.configured=true;},clear:async()=>{keys.configured=false;},get:async()=>null}),...options});
 t.after(async()=>{await instance.close();fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(base+'/api/session').then(response=>response.json());
 async function api(route,body,method=body===undefined?'GET':'POST'){
  return fetch(base+'/api'+route,{method,headers:{'X-Dant-Token':token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 }
 return {...instance,worker,api,base,token,dir};
}

test('VM account and configuration APIs preserve ownership and reject changes during active work',async t=>{
 const {api,worker,engine,store}=await fixture(t);
 assert.equal((await api('/connect',{})).status,200);
 assert.equal((await api('/login',{})).status,200);assert.equal(worker.calls.at(-1).method,'account/login/start');assert.equal(worker.calls.at(-1).params.type,'chatgptDeviceCode');
 assert.equal((await api('/settings',{language:'en',notifications:false,model:'fixture-model',nativeVoice:'ember',apiVoice:'marin'},'PATCH')).status,200);
 assert.equal(store.state.settings.language,'en');assert.equal(store.state.settings.nativeVoice,'ember');assert.equal(store.state.settings.model,'fixture-model');
 assert.equal((await api('/settings',{vm:{host:'example.test'}},'PATCH')).status,400);
 engine.call={id:'call-guard',provider:'subscription'};
 for(const [route,body,method]of [['/connect',{}],['/logout',{}],['/settings',{model:'other'},'PATCH'],['/voice-key',{key:'never-stored'}],['/voice-key',{},'DELETE']])assert.equal((await api(route,body,method)).status,400,route);
 assert.equal(store.state.settings.model,'fixture-model');engine.call=null;
 assert.equal((await api('/voice-key',{key:'test-only'})).status,200);assert.equal((await api('/state').then(r=>r.json())).worker.realtime.key.configured,true);
 assert.equal((await api('/voice-key',{},'DELETE')).status,200);assert.equal((await api('/logout',{})).status,200);assert.equal(worker.calls.at(-1).method,'account/logout');
});

test('private task progress failures expose only fixed whitelisted codes without leaking exceptions or changing credential errors',async t=>{
 const {base,worker,engine}=await fixture(t),originalTool=engine.tool,secret='private-task-plan-diagnostic-and-arguments',active={turnId:'safe-error-owner',messageIds:[],startAcknowledged:true,stopRequested:false,finishing:false};let calls=0,code;
 const internal=(tool,args={},token=worker.credentialBridgeToken)=>fetch(base+'/api/internal/credentials',{method:'POST',headers:{'Content-Type':'application/json','X-Dant-Credential-Token':token},body:JSON.stringify({tool,arguments:args})});
 engine.tool=async()=>{calls++;throw Object.assign(Error(secret),{code});};
 try{
  assert.equal((await internal('task_plan',{title:secret},'forged-token')).status,403);assert.equal((await internal('task_plan',{title:secret})).status,409);assert.equal(calls,0);engine.active=active;
  for(code of ['work_not_found','work_conflict','work_not_continuable','work_stale_turn',secret,undefined]){
   const response=await internal('task_plan',{title:secret});assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'The task progress request could not be completed.',...(['work_not_found','work_conflict','work_not_continuable','work_stale_turn'].includes(code)?{code}:{})});
  }
  const before=calls,response=await internal('task_plan',[]);assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'The task progress request could not be completed.'});assert.equal(calls,before);
  code='work_not_found';const credential=await internal('credential_get',{id:secret});assert.equal(credential.status,400);assert.deepEqual(await credential.json(),{error:'The credential operation could not be completed.'});
  let release;engine.tool=()=>new Promise(resolve=>release=resolve);const pending=internal('task_plan',{title:secret});while(!release)await new Promise(resolve=>setImmediate(resolve));active.stopRequested=true;release({secret});const stale=await pending;assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'The task progress request is no longer active.'});
 }finally{engine.active=null;engine.tool=originalTool;}
});

test('standalone Worker work summaries default hidden and persist both toggle values across Store reloads',async t=>{
 const {api,store,dir}=await fixture(t);assert.equal((await api('/state').then(response=>response.json())).settings.showWorkSummary,false);
 for(const showWorkSummary of [true,false,true]){
  assert.equal((await api('/settings',{showWorkSummary},'PATCH')).status,200);assert.equal(store.state.settings.showWorkSummary,showWorkSummary);assert.equal((await api('/state').then(response=>response.json())).settings.showWorkSummary,showWorkSummary);
  assert.equal(new Store(dir).state.settings.showWorkSummary,showWorkSummary);
 }
});

test('standalone work summary changes leave a running call and its executor untouched',async t=>{
 const {api,store,worker,engine}=await fixture(t),call={id:'existing-call',provider:'api',status:'connected'},active={turnId:'already-running',messageIds:[],voiceOutput:true};
 engine.call=call;engine.active=active;engine.loaded=true;
 try{for(const showWorkSummary of [true,false]){
  assert.equal((await api('/settings',{showWorkSummary},'PATCH')).status,200);assert.equal(store.state.settings.showWorkSummary,showWorkSummary);assert.equal(engine.call,call);assert.equal(engine.active,active);assert.equal(engine.loaded,true);assert.equal(worker.calls.length,0);assert.equal(worker.connections,0);
 }}finally{engine.call=null;engine.active=null;}
});

test('invalid standalone work summary preferences reject other settings before mutating state or disk',async t=>{
 const {api,store,engine,worker}=await fixture(t);engine.loaded=true;const state=structuredClone(store.state),saved=fs.readFileSync(store.file);
 for(const showWorkSummary of ['false',1,0,null,[],{}]){
  const response=await api('/settings',{showWorkSummary,language:'en',notifications:false,model:'not-applied',timeZone:'Asia/Kuala_Lumpur'},'PATCH');assert.equal(response.status,400);assert.match((await response.json()).error,/work summary preference/);
  assert.deepEqual(store.state,state);assert.deepEqual(fs.readFileSync(store.file),saved);assert.equal(engine.loaded,true);assert.equal(worker.calls.length,0);
 }
});

test('legacy and invalid stored work summary values normalize to false while an explicit true survives restart',t=>{
 for(const showWorkSummary of [undefined,false,true,'true',1,null,[],{}]){
  const dir=fs.mkdtempSync(path.join(root,'work-summary-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const original=new Store(dir);
  if(showWorkSummary===undefined)delete original.state.settings.showWorkSummary;else original.state.settings.showWorkSummary=showWorkSummary;
  original.state.settings.language='en';original.save();const restored=new Store(dir);assert.equal(restored.state.settings.showWorkSummary,showWorkSummary===true);assert.equal(restored.state.settings.language,'en');assert.equal(JSON.parse(fs.readFileSync(restored.file,'utf8')).settings.showWorkSummary,showWorkSummary===true);
 }
});

test('background native work blocks executor and model replacement even after media hangup',async t=>{
 const {api,worker,nativeVoice,store}=await fixture(t),model=store.state.settings.model;Object.defineProperty(nativeVoice,'active',{configurable:true,value:{messageId:'native-background',background:true}});
 for(const [route,body,method]of [['/connect',{}],['/logout',{}],['/provision',{}],['/settings',{model:'replacement'},'PATCH']])assert.equal((await api(route,body,method)).status,400,route);
 assert.equal(store.state.settings.model,model);assert.equal(worker.calls.length,0);assert.equal(worker.connections,0);delete nativeVoice.active;
});

test('pending followup or native canonical-reference delivery blocks executor replacement and new calls after its owner ends',async t=>{
 const {api,worker,engine,store}=await fixture(t),model=store.state.settings.model;
 for(const deliveries of [engine.pendingFollowups,engine.callReferences]){deliveries.set('awaiting-message',new Promise(()=>{}));assert.equal(engine.active,null);
 try{
  for(const [route,body,method]of [['/connect',{}],['/connect',{idleRecovery:true}],['/logout',{}],['/provision',{}],['/settings',{model:'replacement'},'PATCH'],['/call',{sdp:'unused',provider:'subscription'}]]){
   const response=await api(route,body,method);assert.ok([400,409].includes(response.status),route);
  }
  assert.equal(store.state.settings.model,model);assert.equal(worker.calls.length,0);assert.equal(worker.connections,0);assert.equal(engine.call,null);
 }finally{deliveries.clear();}}
});

test('public work progress keeps ephemeral voice work visible after hangup and exposes only safe plan metadata',async t=>{
 const {api,engine,nativeVoice}=await fixture(t);
 const progress={messageId:null,turnId:'native-owned-turn',source:'voice',background:true,status:'waiting_user',startedAt:100,updatedAt:200,step:'computer',plan:{total:3,completed:1,currentStep:'Check the board'}};
 Object.defineProperty(nativeVoice,'progress',{configurable:true,value:progress});
 let snapshot=await api('/state').then(response=>response.json());assert.equal(snapshot.call,null);assert.deepEqual(snapshot.active,progress);assert.equal(snapshot.messages.length,0);
 engine.active={messageId:null,turnId:'api-owned-turn',messageIds:[],voiceOutput:true,backgroundVoice:true,awaitingChatInput:true,workProgress:{startedAt:300,updatedAt:400,step:'files',items:new Map()}};
 snapshot=await api('/state').then(response=>response.json());assert.equal(snapshot.active.turnId,'api-owned-turn');assert.equal(snapshot.active.source,'voice');assert.equal(snapshot.active.background,true);assert.equal(snapshot.active.status,'waiting_user');assert.equal(snapshot.active.step,'files');assert.equal('items' in snapshot.active,false);
 engine.active=null;delete nativeVoice.progress;
});

test('private shared call input references never enter desktop state snapshots',async t=>{
 const {api,store}=await fixture(t);store.state.callInputHistory=[{messageId:'private-input',callId:'private-call',text:'PRIVATE_CALL_INPUT',quotedMessage:{role:'assistant',text:'PRIVATE_QUOTED_CONTENT'},status:'submitted'}];store.save();
 const snapshot=await api('/state').then(response=>response.json());assert.equal('callInputHistory' in snapshot,false);assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_CALL_INPUT|PRIVATE_QUOTED_CONTENT/);
});

test('steering preflight rejects an unavailable or different owned turn before creating a message or task',async t=>{
 const {api,engine,nativeVoice,store}=await fixture(t);
 for(const progress of [null,{turnId:'native-background',source:'voice',background:true,canSteer:false},{turnId:'new-turn',canSteer:true}]){
  Object.defineProperty(nativeVoice,'progress',{configurable:true,value:progress});const response=await api('/steer',{text:'Only adjust the displayed turn',expectedTurnId:'native-background'});assert.equal(response.status,400);assert.equal(store.state.messages.length,0);assert.equal(engine.queue.length,0);
 }
 delete nativeVoice.progress;
});

test('ordinary chat followups reach the active task once and remain unread until executor acknowledgement',async t=>{
 const {api,worker,engine,store}=await fixture(t);
 const first=await api('/messages',{text:'Keep working on the current task'}).then(response=>response.json());
 while(!engine.active?.turnId)await new Promise(resolve=>setImmediate(resolve));
 const turnId=engine.active.turnId,request=worker.request.bind(worker);let acknowledge,entered;
 const submitted=new Promise(resolve=>entered=resolve);
 worker.request=(method,params)=>{if(method!=='turn/steer')return request(method,params);worker.calls.push({method,params});entered();return new Promise(resolve=>acknowledge=resolve);};
 try{
 const payload={text:'Open the test room first',replyTo:first.id,clientMessageId:randomUUID()};
 const sent=await api('/messages',payload);assert.equal(sent.status,200);await submitted;
 const followup=store.state.messages.find(message=>message.clientMessageId===payload.clientMessageId);
 assert.equal(followup.executorConfirmedAt,null);assert.equal(engine.queue.length,0);
 assert.equal((await api('/messages',payload)).status,200);assert.equal(worker.calls.filter(call=>call.method==='turn/steer').length,1);
 acknowledge({});await engine.active.steerChain;
 assert.ok(followup.executorConfirmedAt);assert.equal(followup.turnId,turnId);assert.equal(followup.submission,'confirmed');
 const steer=worker.calls.find(call=>call.method==='turn/steer');assert.equal(steer.params.expectedTurnId,turnId);assert.match(steer.params.input[0].text,/Replying to: Keep working on the current task/);assert.match(steer.params.input[0].text,/Open the test room first/);
 assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);assert.equal(store.state.messages.filter(message=>message.clientMessageId===payload.clientMessageId).length,1);
 await engine.handle({method:'turn/completed',params:{threadId:'api-thread',turn:{id:turnId,status:'completed'}}});assert.equal(followup.status,'review');
 }finally{acknowledge?.({});}
});

test('recorded voice API preserves original playback while recognized speech reaches the shared task once',async t=>{
 const audio=Buffer.from([26,69,223,163,1,2,3,4]),recognized='请记住紫色自行车。 Remember the purple bicycle.';let count=0;
 const {api,base,token,worker,store,engine}=await fixture(t,{audioTranscriberFactory:({attachments})=>({transcribe:async file=>{count++;assert.deepEqual(attachments.read(file.id).data,audio);return {text:recognized,language:'zh',duration:3};}})});
 const form=new FormData();form.set('file',new Blob([audio],{type:'audio/webm'}),'voice.webm');
 const file=await fetch(base+'/api/upload',{method:'POST',headers:{'X-Dant-Token':token},body:form}).then(response=>response.json());
 const payload={text:'',attachments:[file.id],clientMessageId:randomUUID()},response=await api('/messages',payload);assert.equal(response.status,200);const sent=await response.json();
 await new Promise(resolve=>setImmediate(resolve));assert.equal((await api('/messages',payload)).status,200);
 assert.equal(count,1);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);assert.match(worker.calls.find(call=>call.method==='turn/start').params.input[0].text,/purple bicycle/);
 assert.equal(sent.text,'');assert.equal(store.state.messages.filter(message=>message.clientMessageId===payload.clientMessageId).length,1);
 const snapshot=await api('/state').then(response=>response.json());assert.equal(JSON.stringify(snapshot).includes(recognized),false);assert.equal(JSON.stringify(store.state).includes(recognized),false);
 const playback=await api('/files/'+file.id);assert.equal(playback.headers.get('content-type'),'audio/webm');assert.deepEqual(Buffer.from(await playback.arrayBuffer()),audio);
 await engine.handle({method:'turn/completed',params:{threadId:'api-thread',turn:{id:engine.active.turnId,status:'completed'}}});
});

test('editing a skill grown beyond twenty helpers preserves every current file and the shared conversation',async t=>{
 const {api,skills,store,worker}=await fixture(t),files=Object.fromEntries(Array.from({length:20},(_,index)=>['scripts/helper-'+index+'.mjs','export const value = '+index+';\n'])),saved=skills.save({name:'growing-skill',description:'Growing source tree',instructions:'Read the helpers.',files}),directory=path.dirname(saved.path),marker=fs.readFileSync(path.join(directory,'.dant-managed.json')),before=structuredClone(store.state.messages);
 for(let index=20;index<30;index++){const name='scripts/helper-'+index+'.mjs',value='export const value = '+index+';\n';files[name]=value;fs.writeFileSync(path.join(directory,name),value);}
 const read=await api('/skills/growing-skill',undefined,'GET');assert.equal(read.status,200);const draft=await read.json();assert.deepEqual(draft.files,files);assert.deepEqual(fs.readFileSync(path.join(directory,'.dant-managed.json')),marker,'opening Edit is read-only');
 const response=await api('/skills/growing-skill',{description:'Updated description',instructions:draft.instructions,files:draft.files,enabled:true},'PATCH');assert.equal(response.status,200);assert.deepEqual((await response.json()).files,files);assert.deepEqual(skills.get('growing-skill').files,files);for(const [name,value] of Object.entries(files))assert.equal(fs.readFileSync(path.join(directory,name),'utf8'),value);
 assert.deepEqual(store.state.messages,before);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);
});

test('skill read count failures expose only a safe size code and preserve the complete directory',async t=>{
 const {api,skills}=await fixture(t),files=Object.fromEntries(Array.from({length:SKILL_SUPPORT_FILE_LIMIT},(_,index)=>['references/'+index+'.txt','Reference '+index])),saved=skills.save({name:'bounded-skill',description:'Bounded source tree',instructions:'Read references.',files}),directory=path.dirname(saved.path),marker=fs.readFileSync(path.join(directory,'.dant-managed.json'));
 fs.writeFileSync(path.join(directory,'references/new.txt'),'Keep this authored helper');
 const response=await api('/skills/bounded-skill',undefined,'GET');assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'The skill action could not be completed. Existing skills were preserved.',code:'size_limit'});assert.deepEqual(fs.readFileSync(path.join(directory,'.dant-managed.json')),marker);assert.equal(fs.readFileSync(path.join(directory,'references/new.txt'),'utf8'),'Keep this authored helper');
});

test('skill import previews are read-only, commits refresh discovery and name collisions preserve both previews and existing skills',async t=>{
 const {api,base,token,skills,worker}=await fixture(t),source='---\nname: imported-check\ndescription: Check a desktop workflow.\nlicense: MIT\n---\nRead the screen before clicking.';
 const preview=async()=>{const form=new FormData();form.set('file',new Blob([source],{type:'text/markdown'}),'SKILL.md');const response=await fetch(base+'/api/skills/import/preview',{method:'POST',headers:{'X-Dant-Token':token},body:form});assert.equal(response.status,200);return response.json();};
 const first=await preview();assert.equal(first.name,'imported-check');assert.deepEqual(skills.list(),[]);assert.equal(worker.calls.some(call=>call.method==='turn/start'),false);assert.ok(first.files.some(file=>file.path==='SKILL.md'));
 const saved=await api('/skills/import',{id:first.id,enabled:false});assert.equal(saved.status,200);assert.equal((await saved.json()).enabled,false);assert.match(skills.get(first.name).instructions,/Read the screen/);assert.ok(worker.calls.some(call=>call.method==='skills/list'&&call.params.forceReload));
 assert.equal((await api('/skills/import',{id:first.id})).status,410);
 const again=await preview();const conflict=await api('/skills/import',{id:again.id});assert.equal(conflict.status,409);assert.equal((await conflict.json()).code,'name_exists');
 assert.equal((await api('/skills/import',{id:again.id,name:'imported-renamed',enabled:true})).status,200);assert.equal(skills.list().length,2);assert.equal(skills.get(first.name).enabled,false);
 const discard=await preview();assert.equal((await api('/skills/import/previews/'+discard.id,undefined,'DELETE')).status,200);assert.equal((await api('/skills/import',{id:discard.id})).status,410);assert.equal(skills.list().length,2);
});

test('skill import rejects invalid remote sources, oversized files, unauthenticated writes and offline VM work',async t=>{
 const {api,base,worker}=await fixture(t);
 assert.equal((await fetch(base+'/api/skills/import',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 const rejected=await api('/skills/import/preview',{url:'https://127.0.0.1/private'});assert.equal(rejected.status,400);assert.equal((await rejected.json()).code,'invalid_source');
 const form=new FormData();form.set('file',new Blob([new Uint8Array(1024*1024+1)]),'oversized.zip');
 const {token}=await fetch(base+'/api/session').then(response=>response.json());const tooLarge=await fetch(base+'/api/skills/import/preview',{method:'POST',headers:{'X-Dant-Token':token},body:form});assert.equal(tooLarge.status,413);assert.equal((await tooLarge.json()).code,'size_limit');
 worker.status='offline';assert.equal((await api('/skills/import/preview',{url:'https://github.com/example/skills'})).status,409);assert.equal((await api('/skills/import',{id:'old'})).status,409);
});

test('managed skill ZIP export uses immutable attachments without changing chat or running helpers',async t=>{
 const {api,base,skills,store,worker}=await fixture(t),original=skills.save({name:'desktop-check',description:'Inspect the desktop',instructions:'Read before acting.',files:{'scripts/check.py':'raise RuntimeError("never run on export")','LICENSE':'MIT fixture'},enabled:false}),before=structuredClone(store.state.messages);
 assert.equal((await fetch(base+'/api/skills/desktop-check/export',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 const response=await api('/skills/desktop-check/export',{});assert.equal(response.status,200);const file=await response.json();assert.equal(file.name,'desktop-check.zip');assert.equal(file.type,'application/zip');assert.ok(file.size>100);
 const downloaded=await api('/files/'+file.id+'?download=1');assert.match(downloaded.headers.get('content-disposition'),/^attachment;.*desktop-check\.zip/);const zip=Buffer.from(await downloaded.arrayBuffer());assert.equal(zip.readUInt32LE(0),0x04034b50);assert.match(zip.toString('utf8'),/desktop-check\/SKILL\.md/);assert.match(zip.toString('utf8'),/desktop-check\/scripts\/check\.py/);assert.match(zip.toString('utf8'),/MIT fixture/);assert.doesNotMatch(zip.toString('utf8'),/\.dant-managed\.json/);
 assert.deepEqual(skills.get('desktop-check'),original);assert.deepEqual(store.state.messages,before);assert.equal(worker.calls.length,0);
 assert.equal((await api('/skills/missing/export',{})).status,400);assert.equal((await api('/skills/%2e%2e%2foutside/export',{})).status,400);worker.status='offline';assert.equal((await api('/skills/desktop-check/export',{})).status,409);
});

test('VM memory, reactions and read APIs validate references and preserve unrelated messages',async t=>{
 const {api,store,engine}=await fixture(t);engine.loaded=true;
 assert.equal((await api('/memory/working-memory.md',{text:'A useful preference'},'PATCH')).status,200);assert.equal(engine.loaded,false);assert.equal(store.state.memory,'A useful preference');
 const memory=await api('/memory').then(r=>r.json());assert.ok(memory.files.some(file=>file.name==='working-memory.md'));
 assert.equal((await api('/memory/unknown.md',{text:'Should not write'},'PATCH')).status,400);
 const a=store.add({role:'assistant',text:'Read this',status:'completed'}),b=store.add({role:'assistant',text:'Remain unread',status:'completed'});
 assert.equal((await api('/messages/'+a.id+'/reaction',{emoji:'invalid'})).status,400);assert.equal((await api('/messages/missing/reaction',{emoji:'👍'})).status,404);
 await api('/messages/'+a.id+'/reaction',{emoji:'👍'});await api('/messages/'+a.id+'/reaction',{emoji:'👍'});assert.deepEqual(a.reactions,[]);
 assert.equal((await api('/read',{ids:'all'})).status,400);assert.equal((await api('/read',{ids:[a.id]})).status,200);assert.equal(a.read,true);assert.equal(b.read,false);
});

test('upload and download APIs preserve immutable content and never inline active documents',async t=>{
 const {api,base,token}=await fixture(t);
 const form=new FormData();form.set('file',new Blob(['<script>window.injected=true</script>'],{type:'text/html'}),'page.html');
 const uploaded=await fetch(base+'/api/upload',{method:'POST',headers:{'X-Dant-Token':token},body:form});assert.equal(uploaded.status,200);const file=await uploaded.json();
 assert.equal(file.type,'application/octet-stream');
 const download=await api('/files/'+file.id);assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal(await download.text(),'<script>window.injected=true</script>');
 assert.equal((await api('/files/00000000-0000-0000-0000-000000000000')).status,404);
 const forged=new FormData();forged.set('file',new Blob(['plain text'],{type:'image/png'}),'fake.png');
 assert.equal((await fetch(base+'/api/upload',{method:'POST',headers:{'X-Dant-Token':token},body:forged})).status,400);
 assert.equal((await api('/upload',{})).status,400);
 const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),imageForm=new FormData();imageForm.set('file',new Blob([png],{type:'image/png'}),'screenshot.png');
 const image=await fetch(base+'/api/upload',{method:'POST',headers:{'X-Dant-Token':token},body:imageForm}).then(response=>response.json());
 const inline=await api('/files/'+image.id);assert.equal(inline.headers.get('content-type'),'image/png');assert.equal(inline.headers.has('content-disposition'),false);
 const saved=await api('/files/'+image.id+'?download=1');assert.match(saved.headers.get('content-disposition'),/^attachment;.*screenshot\.png/);assert.equal(saved.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await saved.arrayBuffer()),png);
});

test('invalid message references and uncertain retries never accidentally submit model work',async t=>{
 const {api,worker,store}=await fixture(t);
 for(const body of [{text:'hello',clientMessageId:'unsafe-id'},{text:'hello',attachments:['missing']},{text:'hello',replyTo:'missing'},{text:'hello',attachments:['same','same']},{text:''}])assert.equal((await api('/messages',body)).status,400);
 assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);
 const task=store.add({role:'user',text:'Uncertain external action',status:'paused',submission:'unknown'});
 assert.equal((await api('/retry/'+task.id,{})).status,400);assert.equal(task.status,'paused');assert.equal((await api('/tasks/resume',{ids:[task.id]})).status,400);
 assert.equal((await api('/tasks/resume',{ids:'all'})).status,400);assert.equal((await api('/tasks/'+task.id+'/accept',{})).status,400);
 assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,0);
 store.update(task.id,{status:'review'});assert.equal((await api('/tasks/'+task.id+'/accept',{})).status,200);assert.equal(task.status,'completed');
 worker.status='offline';assert.equal((await api('/messages',{text:'Wait until online'})).status,409);assert.equal((await api('/steer',{text:'extra',expectedTurnId:'old'})).status,400);
});

test('authenticated text and steering pass complete input beyond 100000 characters while keeping the HTTP transport bound',async t=>{
 const {api,worker,engine,store}=await fixture(t),text='Long input 中文😀 '.repeat(9000)+'LONG_USER_INPUT_TAIL',clientMessageId=randomUUID();assert.ok(text.length>100000);const response=await api('/messages',{text,clientMessageId});assert.equal(response.status,200);const message=await response.json();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(message.text,text);assert.equal(store.state.messages.find(item=>item.id===message.id).text,text);const turn=worker.calls.find(call=>call.method==='turn/start');assert.ok(turn.params.input.some(item=>item.type==='text'&&item.text.endsWith('LONG_USER_INPUT_TAIL')));assert.ok(turn.params.input.some(item=>item.type==='text'&&item.text.includes(text)));
 const duplicate=await api('/messages',{text,clientMessageId});assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).id,message.id);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);
 const correction='Correction 中文😀 '.repeat(9000)+'LONG_STEER_INPUT_TAIL';assert.ok(correction.length>100000);const steering=await api('/steer',{text:correction,expectedTurnId:engine.active.turnId});assert.equal(steering.status,200);const steer=worker.calls.find(call=>call.method==='turn/steer');assert.ok(steer.params.input.some(item=>item.type==='text'&&item.text.includes(correction)));assert.equal(store.state.messages.at(-1).text,correction);
 const count=store.state.messages.length;assert.equal((await api('/messages',{text:'x'.repeat(2*1024*1024)})).status,413);assert.equal((await api('/steer',{text:'x'.repeat(2*1024*1024),expectedTurnId:engine.active.turnId})).status,413);assert.equal(store.state.messages.length,count);assert.equal(worker.calls.filter(call=>call.method==='turn/start').length,1);assert.equal(worker.calls.filter(call=>call.method==='turn/steer').length,1);
});

test('schedules dispatch once only when the VM executor is online and can be removed',async t=>{
 const {api,worker,store}=await fixture(t);worker.status='offline';
 assert.equal((await api('/schedules',{text:'too late',at:Date.now()-1})).status,400);
 const response=await api('/schedules',{text:'One scheduled task',at:Date.now()+30});assert.equal(response.status,200);const schedule=await response.json();
 await new Promise(resolve=>setTimeout(resolve,1030));assert.equal(store.state.schedules[0].status,'pending');assert.equal(store.state.messages.length,0);
 worker.status='online';await new Promise(resolve=>setTimeout(resolve,1030));assert.equal(store.state.schedules[0].status,'dispatched');assert.equal(store.state.messages.filter(message=>message.scheduled).length,1);
 assert.equal((await api('/schedules/'+schedule.id,{},'DELETE')).status,200);assert.equal(store.state.schedules.length,0);
 assert.equal((await api('/tasks/pause',{})).status,200);assert.equal((await api('/stop',{})).status,200);
});

test('idle executor recovery restores only the stopped worker and never resumes paused or uncertain messages',async t=>{
 const {api,worker,engine,store}=await fixture(t);worker.status='offline';engine.loaded=true;const message=store.add({role:'user',text:'Do not replay this work',status:'paused',submission:'unknown'}),before=structuredClone(message),conversation=store.state.conversationId;
 const response=await api('/connect',{idleRecovery:true});assert.equal(response.status,200);assert.equal(worker.connections,1);assert.equal(worker.status,'online');assert.equal(engine.loaded,false);assert.deepEqual(engine.queue,[]);assert.deepEqual(message,before);assert.equal(store.state.conversationId,conversation);assert.equal(worker.calls.length,0);
});

test('the Worker atomically rejects idle recovery during authoritative work, calls, native handoffs or computer control changes',async t=>{
 for(const name of ['active','native-active','call','queue','finishing','acquiring','takeover','computer-pending','human','taking-over','lease'])await t.test(name,async t=>{
  const {api,worker,engine,nativeVoice,computer}=await fixture(t);worker.status='offline';engine.loaded=true;
  if(name==='active')engine.active={messageId:'active'};
  if(name==='native-active')Object.defineProperty(nativeVoice,'active',{configurable:true,value:{messageId:'native-handoff'}});
  if(name==='call')engine.call={id:'call-in-progress'};
  if(name==='queue')engine.queue.push({id:'queued-work'});
  if(name==='finishing')engine.finishing=Promise.resolve();
  if(name==='acquiring')engine.acquiring=true;
  if(name==='takeover')engine.takeover=true;
  if(name==='computer-pending')computer.pending=true;
  if(name==='human')computer.state.status='human';
  if(name==='taking-over')computer.state.status='taking-over';
  if(name==='lease')computer.state.sessionId='unreleased-lease';
  const response=await api('/connect',{idleRecovery:true});assert.equal(response.status,409);assert.match((await response.json()).error,/Stop active work and return computer control/);assert.equal(worker.connections,0);assert.equal(worker.calls.length,0);assert.equal(worker.status,'offline');assert.equal(engine.loaded,true);
  engine.active=null;engine.call=null;engine.queue=[];engine.finishing=null;engine.acquiring=false;engine.takeover=false;computer.pending=false;computer.state={status:'dant',sessionId:null,expiresAt:0};if(name==='native-active')delete nativeVoice.active;
 });
});

test('idle recovery of an already online executor is a no-op that preserves its loaded model session',async t=>{
 const {api,worker,engine}=await fixture(t);engine.loaded=true;const response=await api('/connect',{idleRecovery:true});assert.equal(response.status,200);assert.equal(worker.connections,0);assert.equal(engine.loaded,true);assert.equal(worker.calls.length,0);
});

test('a concurrent worker recovery and new chat work cannot restart or feed the connecting executor',async t=>{
 const {api,worker,engine,store}=await fixture(t);worker.status='offline';let release,started;const entered=new Promise(resolve=>started=resolve);worker.connectWait=()=>{started();return new Promise(resolve=>release=resolve);};
 const first=api('/connect',{idleRecovery:true});await entered;assert.equal(worker.status,'connecting');assert.equal((await api('/connect',{idleRecovery:true})).status,409);assert.equal((await api('/messages',{text:'Must not queue while connecting'})).status,409);assert.deepEqual(engine.queue,[]);assert.equal(store.state.messages.length,0);release();assert.equal((await first).status,200);assert.equal(worker.connections,1);assert.equal(worker.calls.length,0);
});
