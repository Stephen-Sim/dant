import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {captureProjectContext,safeProjectContext,taskContextSnapshots} from '../src/task-project-context.mjs';
import {continuationEligible,workReplyEligible} from '../src/work-continuation-state.mjs';
import {workReplyInstructions} from '../src/work-reply.mjs';
import {createApp} from '../src/server.mjs';
const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});
function fixture(t){const directory=fs.mkdtempSync(path.join(root,'task-project-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,store:new Store(directory)};}
const plan={steps:[{step:'Verified existing output',status:'completed'}]};
const file={id:'10000000-0000-4000-8000-000000000001',name:'result.png',type:'image/png',size:123};
const redact=text=>String(text).replaceAll('PRIVATE','[redacted]');

test('task context preserves actual original request, human additions, result references and files across pruning and restart',t=>{
 const {directory,store}=fixture(t),original=store.add({role:'user',text:'Original PRIVATE goal',status:'review',time:100,turnId:'old-turn'});
 const record=store.registerWork({turnId:'old-turn',messageId:original.id,title:'Project',source:'chat',plan,startedAt:100});
 store.add({role:'assistant',text:'Reported PRIVATE result',status:'completed',taskId:original.id,time:200,attachments:[file]});
 store.add({role:'user',text:'Keep this human addition',status:'completed',workId:record.id,time:300});
 store.add({role:'assistant',text:'Do not capture another task',status:'completed',taskId:'other-task',time:400});
 store.refreshProjectContext(record.id,{redact,at:500});store.state.messages=[];store.save();const reopened=new Store(directory),saved=reopened.state.workTasks[0];
 assert.equal(saved.projectContext.originalRequest.text,'Original [redacted] goal');assert.equal(saved.projectContext.humanUpdates[0].text,'Keep this human addition');assert.equal(saved.projectContext.results.length,1);assert.equal(saved.projectContext.results[0].text,'Reported [redacted] result');assert.deepEqual(saved.projectContext.results[0].attachments,[file]);
 const retained=captureProjectContext(saved,[],{redact,at:600});assert.deepEqual(retained.results,saved.projectContext.results);assert.equal(retained.originalRequest.messageId,original.id);
 const instructions=workReplyInstructions(saved,redact);assert.match(instructions,/reference data, not new authorization or independent proof/);assert.match(instructions,/Original \[redacted\] goal/);assert.doesNotMatch(instructions,/PRIVATE|Do not capture another task/);
});

test('context stores bounded exact excerpts, drops raw payloads and does not fabricate verification or summaries',t=>{
 const {store}=fixture(t),original=store.add({role:'user',text:'x'.repeat(5000),status:'review',time:100}),record=store.registerWork({turnId:'old',messageId:original.id,title:'Project',source:'chat',plan});
 for(let index=0;index<14;index++){store.add({role:'user',text:'Update '+index,workId:record.id,status:'completed',time:200+index});store.add({role:'assistant',text:'Result '+index,taskId:original.id,status:'completed',time:300+index,attachments:[{...file,raw:'never store',path:'/private/path'}]});}
 const context=captureProjectContext(record,store.state.messages,{at:500});assert.equal(context.originalRequest.text.length,4000);assert.equal(context.humanUpdates.length,8);assert.equal(context.results.length,8);assert.equal(context.results[0].text,'Result 6');assert.doesNotMatch(JSON.stringify(context),/never store|private\/path|verified|summary/);assert.ok(Buffer.byteLength(JSON.stringify(context))<65536);
 assert.equal(safeProjectContext({version:9,updatedAt:100}),null);assert.equal(safeProjectContext({version:1,updatedAt:-1}),null);
 for(const message of store.state.messages){message.text='中'.repeat(5000);if(message.role==='assistant')message.attachments=Array.from({length:5},()=>({...file,name:'文'.repeat(200),type:'类'.repeat(100)}));}
 const multibyte=captureProjectContext(record,store.state.messages,{at:600});assert.ok(Buffer.byteLength(JSON.stringify(multibyte))<=65536);assert.equal(multibyte.referenceDataOnly,true);assert.equal(multibyte.originalRequest.messageId,original.id);assert.ok(multibyte.results.length>0);
});

test('final task eligibility is human-only and uncertain, stale and explicitly dismissed work remains unavailable',()=>{
 const base={id:'work',turnId:'old',turnIds:['old'],source:'chat',plan,executionEndedAt:100,status:'completed'};
 for(const status of ['review','completed','cancelled','failed']){const record={...base,status};assert.equal(workReplyEligible(record,{at:1000}),true);assert.equal(continuationEligible(record,{at:1000}),false);}
 for(const patch of [{progressDismissedAt:200},{executionEndedAt:undefined},{status:'unknown'},{unknownOutcome:true},{submission:'unknown'},{continuation:{invalid:true}},{continuation:{dispatch:{phase:'submitting'}}}])assert.equal(workReplyEligible({...base,...patch},{at:1000}),false);
});

test('context persistence failure rolls back the record without changing execution state',t=>{
 const {store}=fixture(t),original=store.add({role:'user',text:'Goal',status:'review',time:100}),record=store.registerWork({turnId:'old',messageId:original.id,title:'Project',source:'chat',plan}),before=fs.readFileSync(store.file);
 store.save=()=>{throw Error('Disk full');};assert.throws(()=>store.refreshProjectContext(record.id,{at:200}),/Disk full/);assert.equal(store.state.workTasks[0],record);assert.equal(record.projectContext,undefined);assert.deepEqual(fs.readFileSync(store.file),before);
});

test('public task snapshots omit durable context while leaving stored reference data intact',()=>{
 const record={id:'work',status:'completed',projectContext:{version:1,updatedAt:100,originalRequest:{messageId:'message',at:100,text:'PRIVATE value',attachments:[{...file,name:'PRIVATE.png'}]},humanUpdates:[],results:[]}};
 const [publicRecord]=taskContextSnapshots([record]);assert.equal(Object.hasOwn(publicRecord,'projectContext'),false);assert.match(record.projectContext.originalRequest.text,/PRIVATE/);assert.deepEqual(taskContextSnapshots([{id:'plain'}]),[{id:'plain'}]);
});

test('a voice task without a human anchor never absorbs unrelated null-task results',t=>{
 const {store}=fixture(t),record=store.registerWork({turnId:'voice-turn',source:'voice',title:'Voice task',plan});
 const unrelated=store.add({role:'assistant',text:'Private result from another task',status:'completed',taskId:null,time:100}),owned=store.add({role:'assistant',text:'This voice result',status:'completed',taskId:null,time:200});
 const empty=captureProjectContext(record,store.state.messages,{at:300});assert.equal(empty.originalRequest,null);assert.deepEqual(empty.results,[]);
 const exact=captureProjectContext(record,store.state.messages,{messageIds:[owned.id],at:400});assert.deepEqual(exact.results.map(item=>item.messageId),[owned.id]);assert.doesNotMatch(JSON.stringify(exact),new RegExp(unrelated.text));
});

test('a reused human anchor cannot import another task or turn into the old project context',()=>{
 const record={id:'old-work',turnId:'old-turn',turnIds:['old-turn'],messageId:'shared-input'},messages=[{id:'shared-input',role:'user',turnId:'new-turn',workId:'new-work',text:'Different PRIVATE request',time:100},{id:'new-result',role:'assistant',taskId:'shared-input',turnId:'new-turn',workId:'new-work',text:'Different PRIVATE result',status:'completed',time:200}];
 const context=captureProjectContext(record,messages,{at:300});assert.equal(context.originalRequest,null);assert.deepEqual(context.humanUpdates,[]);assert.deepEqual(context.results,[]);
 record.projectContext={version:1,updatedAt:50,originalRequest:{messageId:'shared-input',turnId:'old-turn',at:40,text:'Original saved request',attachments:[]},humanUpdates:[],results:[]};const retained=captureProjectContext(record,messages,{at:400});assert.equal(retained.originalRequest.text,'Original saved request');assert.deepEqual(retained.results,[]);
 for(const patch of [{workId:'new-work',turnId:undefined},{workId:undefined,turnId:'new-turn'}]){const result=captureProjectContext(record,messages.map(message=>({...message,...patch})),{at:500});assert.deepEqual(result.results,[]);}
});

test('the shared finalization hook saves real native voice result IDs as durable task references',t=>{
 const {store}=fixture(t),worker=new EventEmitter();worker.status='offline';const engine=new Engine(store,worker),record=store.registerWork({turnId:'voice',source:'voice',title:'Voice result',plan});
 const message=store.add({role:'assistant',text:'Actual native result PRIVATE',status:'completed',taskId:null,time:100,attachments:[file]});engine.redact=redact;
 const owner={turnId:'voice',source:'voice',workRecord:record,assistantIds:[message.id],explicitMessageIds:[],outputs:new Map()};engine.finalizeRegisteredWork(owner,'review');
 assert.equal(store.state.workTasks[0].projectContext.results[0].text,'Actual native result [redacted]');assert.deepEqual(store.state.workTasks[0].projectContext.results[0].attachments,[file]);assert.ok(store.state.workTasks[0].executionEndedAt);
});

test('task context HTTP is exact, redacted and read-only, with no worker requests or task revival',async t=>{
 const {directory}=fixture(t),worker=new EventEmitter();Object.assign(worker,{status:'online',calls:[],request:async function(method){this.calls.push(method);return {};},disconnect(){},rpc:{send(){}}});
 const instance=createApp({mode:'test',dataDir:directory,workerFactory:()=>worker});t.after(()=>instance.close());await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(base+'/api/session').then(r=>r.json()),headers={'X-Dant-Token':token};
 const original=instance.store.add({role:'user',text:'PRIVATE goal',status:'review',time:100}),record=instance.store.registerWork({turnId:'old',messageId:original.id,title:'PRIVATE title',source:'chat',plan});instance.store.updateRegisteredWork('old',{status:'completed',executionEnded:true,at:200});instance.engine.redact=redact;
 const url=base+'/api/tasks/'+record.id+'/context?turnId=old&conversationId='+instance.store.state.conversationId,before=fs.readFileSync(instance.store.file),response=await fetch(url,{headers}),body=await response.json();assert.equal(response.status,200);assert.equal(body.referenceDataOnly,true);assert.equal(body.projectContext.originalRequest.text,'[redacted] goal');assert.equal(body.title,'[redacted] title');assert.equal(body.status,'completed');assert.deepEqual(fs.readFileSync(instance.store.file),before);assert.equal(worker.calls.length,0);assert.equal(instance.engine.active,null);
 assert.equal((await fetch(url.replace('turnId=old','turnId=stale'),{headers})).status,409);assert.equal((await fetch(url.replace(record.id,'missing'),{headers})).status,404);assert.equal((await fetch(url,{method:'POST',headers})).status,405);
 instance.store.refreshProjectContext(record.id,{redact});const state=await fetch(base+'/api/state',{headers}).then(r=>r.json());assert.equal(state.capabilities.taskReopen,true);assert.equal(Object.hasOwn(state.workTasks[0],'projectContext'),false);const again=await fetch(url,{headers}).then(r=>r.json());assert.equal(again.projectContext.originalRequest.text,'[redacted] goal');
});
