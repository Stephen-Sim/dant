import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import fs from 'node:fs';
import vm from 'node:vm';
import {workProgress,renderWorkEntry,renderWorkSummary,renderWorkPriority,renderActiveWork,renderVoiceWorkHistory,renderWorkTaskHistory,updateWorkTimers} from '../ui/work-progress.js';

const state=()=>({worker:{status:'online'},controller:{status:'online'},messages:[],queue:[],completions:[]});

test('priority sorts ongoing and recent display entries without reordering live work or the executor queue',()=>{
 const data=state();data.messages=[{id:'active',role:'user',turnId:'active-turn',text:'Current work',status:'running',progressPriority:'low'},{id:'q-low',role:'user',text:'First queued',status:'queued',progressPriority:'low'},{id:'q-high',role:'user',text:'Second queued',status:'queued',progressPriority:'high'},...[
  ['low','low',500],['normal','normal',400],['high','high',100],['bad','URGENT',300],['tie-one','normal',200],['tie-two','normal',200]
 ].map(([id,progressPriority,time])=>({id,role:'user',status:'paused',text:id,progressPriority,time}))];data.queue=['q-low','q-high'];data.active={messageId:'active',turnId:'active-turn',status:'running'};data.workTasks=[{id:'low-ongoing',turnId:'low-turn',title:'Recent low',status:'continuing',progressPriority:'low',updatedAt:500},{id:'high-ongoing',turnId:'high-turn',title:'Older high',status:'waiting_user',progressPriority:'high',updatedAt:100}];
 const before=structuredClone(data),model=workProgress(data);assert.equal(model.active.messageId,'active');assert.equal(model.active.progressPriority,'low');assert.deepEqual(model.queue.map(item=>item.message.id),['q-low','q-high']);assert.deepEqual(model.ongoing.map(item=>item.id),['high-ongoing','low-ongoing']);assert.deepEqual(model.recent.map(item=>item.message.id),['high','normal','bad','tie-one','tie-two','low']);assert.equal(model.recent.find(item=>item.message.id==='bad').progressPriority,'normal');assert.deepEqual(data,before);
});

test('equal-priority unfinished entries precede completed entries while higher priority still wins first',()=>{
 const data=state();data.messages=[{id:'normal-done',role:'user',status:'completed',progressPriority:'normal',time:900},{id:'normal-paused',role:'user',status:'paused',time:100},{id:'high-done',role:'user',status:'completed',progressPriority:'high',time:50},{id:'low-review',role:'user',status:'review',progressPriority:'low',time:1000}];
 const model=workProgress(data);assert.deepEqual(model.history.map(item=>item.message.id),['high-done','normal-paused','normal-done','low-review']);assert.deepEqual(model.recent.map(item=>item.message.id),['normal-paused','low-review']);assert.deepEqual(model.completed.map(item=>item.message.id),['high-done','normal-done']);assert.equal(model.completedCount,2);
});

test('all visible completed entries are collected before history limits and cannot starve unfinished recent work',()=>{
 const data=state();data.messages=Array.from({length:17},(_,index)=>({id:'done-'+index,role:'user',status:'completed',progressPriority:'high',time:100+index}));data.messages.push({id:'unfinished',role:'user',status:'paused',progressPriority:'low',time:1},{id:'hidden',role:'user',status:'completed',progressDismissedAt:123},{id:'conversation',role:'user',status:'completed',workKind:'conversation'},{id:'unknown',role:'user',status:'completed',submission:'unknown'},{id:'uncertain',role:'user',status:'completed',unknownOutcome:true});
 const before=structuredClone(data),model=workProgress(data);assert.equal(model.history.length,12);assert.equal(model.completedCount,17);assert.equal(model.completed.length,17);assert.equal(model.completed[0].message.id,'done-16');assert.equal(model.completed.at(-1).message.id,'done-0');assert.ok(model.recent.some(item=>item.message.id==='unfinished'));assert.equal(model.completed.some(item=>['hidden','conversation','unknown','uncertain'].includes(item.message?.id)),false);assert.deepEqual(data,before);
});

test('large mixed histories keep exact completed counts, ownership deduplication and priorities without changing state',()=>{
 const data=state();data.workTasks=[];
 for(let index=0;index<500;index++)data.messages.push({id:'legacy-'+index,role:'user',text:'Legacy '+index,status:index%2?'paused':'completed',time:100+index,progressPriority:['high','normal','low'][index%3]});
 for(let index=0;index<60;index++){const turnId='work-turn-'+index;data.messages.push({id:'work-input-'+index,role:'user',turnId,status:index%2?'paused':'completed'},{id:'work-result-'+index,role:'assistant'});data.workTasks.push({id:'work-'+index,turnId,messageId:'work-input-'+index,title:'Registered '+index,status:index%2?'continuing':'completed',updatedAt:1000+index,progressPriority:'high'});data.completions.push({id:'work-receipt-'+index,turnId,messageIds:['work-result-'+index],work:{source:'voice',status:'review'}});}
 for(let index=0;index<40;index++){const turnId='voice-turn-'+index;data.messages.push({id:'voice-input-'+index,role:'user',turnId,workKind:'conversation',status:index%2?'paused':'completed'},{id:'voice-result-'+index,role:'assistant'});data.completions.push({id:'voice-receipt-'+index,turnId,messageIds:['voice-result-'+index],progressPriority:'low',work:{source:'voice',status:'review'}});}
 const before=structuredClone(data),model=workProgress(data);assert.equal(model.completedCount,300);assert.equal(model.items.length,600);assert.equal(model.ongoing.length,30);assert.equal(model.history.length,12);assert.equal(model.recent.length,12);assert.equal(model.completed.filter(item=>item.registered).length,30);assert.equal(model.completed.filter(item=>item.voice&&!item.registered).length,20);assert.equal(model.items.some(item=>item.id?.startsWith('work-receipt-')),false);assert.ok(model.ongoing.every(item=>item.progressPriority==='high'));assert.deepEqual(data,before);
});

test('completion uncertainty uses the same strict boolean flag as the backend for tasks, work and receipts',()=>{
 for(const unknownOutcome of [true,false,null,undefined,0,1,'true','false',{}]){
  const data=state();data.messages=[{id:'task',role:'user',status:'completed',unknownOutcome},{id:'work-input',role:'user',turnId:'work-turn',status:'completed',unknownOutcome},{id:'voice-input',role:'user',turnId:'voice-turn',workKind:'conversation',status:'completed',unknownOutcome},{id:'answer',role:'assistant'}];data.workTasks=[{id:'work',turnId:'work-turn',messageId:'work-input',status:'completed',unknownOutcome}];data.completions=[{id:'voice',turnId:'voice-turn',messageIds:['answer'],unknownOutcome,work:{source:'voice',status:'review'}}];const model=workProgress(data);assert.equal(model.completedCount,unknownOutcome===true?0:3);assert.equal(model.items.every(item=>item.progressCompleted),unknownOutcome!==true);
 }
 const data=state();data.messages=[{id:'accepted',role:'user',turnId:'old-turn',workKind:'conversation',status:'completed'},{id:'retry',role:'user',turnId:'new-turn',workKind:'conversation',status:'paused',submission:'unknown'},{id:'answer',role:'assistant'}];data.completions=[{id:'receipt',turnId:'old-turn',taskId:'retry',messageIds:['answer'],work:{source:'voice',status:'review'}}];assert.equal(workProgress(data).completedCount,0,'a referenced retry with uncertain submission keeps an old receipt unresolved');
});

test('registered work and voice receipts retain their own normalized priority without borrowing backing message metadata',()=>{
 const data=state();data.messages=[{id:'backing',role:'user',turnId:'work-turn',status:'review',progressPriority:'low'},{id:'result',role:'assistant',read:false}];data.workTasks=[{id:'work',turnId:'work-turn',messageId:'backing',source:'chat',title:'Registered task',status:'review',progressPriority:'high'}];data.completions=[{id:'voice',turnId:'voice-turn',messageIds:['result'],progressPriority:'low',work:{source:'voice',status:'paused'}},{id:'invalid',turnId:'other-turn',messageIds:['result'],progressPriority:'urgent',work:{source:'voice',status:'review'}}];
 const model=workProgress(data);assert.deepEqual(model.history.map(item=>[item.id,item.progressPriority]),[['work','high'],['invalid','normal'],['voice','low']]);assert.equal(model.history.some(item=>item.message?.id==='backing'&&!item.registered),false);
 delete data.workTasks[0].progressPriority;assert.equal(workProgress(data).history.find(item=>item.id==='work').progressPriority,'low','older first-plan records retain the current request priority when no explicit work preference exists');
});

test('voice receipts become completed only through an exact accepted current-turn authority',()=>{
 const data=state();data.messages=[{id:'answer',role:'assistant'},{id:'accepted',role:'user',status:'completed',turnId:'accepted-turn',workKind:'conversation'},{id:'uncertain',role:'user',status:'completed',turnId:'uncertain-turn',workKind:'conversation',submission:'unknown'}];data.completions=[{id:'accepted-receipt',turnId:'accepted-turn',messageIds:['answer'],work:{source:'voice',status:'review'}},{id:'standalone',turnId:'standalone-turn',messageIds:['answer'],work:{source:'voice',status:'review'}},{id:'uncertain-receipt',turnId:'uncertain-turn',messageIds:['answer'],work:{source:'voice',status:'review'}},{id:'fake-completed',turnId:'fake-turn',messageIds:['answer'],work:{source:'voice',status:'completed'}}];
 const model=workProgress(data);assert.deepEqual(model.completed.map(item=>item.id),['accepted-receipt']);assert.equal(model.completedCount,1);assert.ok(model.recent.some(item=>item.id==='standalone'&&item.status==='review'));assert.ok(model.recent.some(item=>item.id==='uncertain-receipt'&&item.status==='review'));assert.equal(model.history.some(item=>item.id==='fake-completed'),false);
 data.messages.push({id:'pending-sibling',role:'user',turnId:'accepted-turn',workKind:'conversation',status:'paused',submission:'submitting'});assert.equal(workProgress(data).completedCount,0,'another unconfirmed input on the same owned turn keeps its outcome unresolved');data.messages.pop();data.completions[0].taskId='different-task';assert.equal(workProgress(data).completedCount,0,'a receipt naming another task cannot borrow an accepted sibling');
});

test('priority controls are bilingual, compact, exact-kind and safe for untrusted IDs and invalid values',()=>{
 for(const language of ['en','zh']){
  const labels=workProgress(state(),{language}).labels;
  for(const [item,kind,id]of [[{registered:true,id:'work',progressPriority:'high'},'work','work'],[{voice:true,id:'receipt',progressPriority:'low'},'completion','receipt'],[{message:{id:'task"><img>',progressPriority:'invalid'}},'task','task"><img>']]){const document=parseHTML(renderWorkPriority(item,labels,{pending:true})).document,select=document.querySelector('select');assert.equal(select.dataset.taskPriority,id);assert.equal(select.dataset.progressKind,kind);assert.equal(select.getAttribute('aria-label'),language==='en'?'Priority':'优先级');assert.equal(select.hasAttribute('disabled'),true);assert.deepEqual([...select.querySelectorAll('option')].map(option=>option.value),['high','normal','low']);assert.equal(select.querySelector('[selected]').value,item.progressPriority||'normal');assert.equal(document.querySelector('img'),null);}
  assert.equal(labels.completedTasks,language==='en'?'Completed tasks':'已完成的任务');assert.equal(labels.clearCompleted,language==='en'?'Clear all':'清空全部');assert.equal(renderWorkPriority({},labels),'');
 }
});

test('history priority controls and dismiss buttons retain canonical status and plan disclosure without borrowing action ownership',()=>{
 const labels=workProgress(state()).labels,entry={id:'work',title:'Keep original task',status:'unknown',knownStatus:'paused',canDismiss:true,progressPriority:'high',plan:{steps:[{step:'Verify',status:'pending'}]}};
 let document=parseHTML(renderWorkTaskHistory(entry,labels,{planOpen:true,pending:true})).document;assert.equal(document.querySelector('[data-task-priority]').dataset.progressKind,'work');assert.equal(document.querySelector('[data-task-priority]').getAttribute('disabled'),'');assert.equal(document.querySelector('[data-task-dismiss]').dataset.progressStatus,'paused');assert.equal(document.querySelector('[data-work-plan]').hasAttribute('open'),true);assert.equal(document.querySelector('[data-task-accept],[data-task-resume]'),null);
 document=parseHTML(renderVoiceWorkHistory({id:'receipt',messageId:'answer',title:'Call result',status:'completed',progressPriority:'low'},labels)).document;assert.equal(document.querySelector('[data-task-priority]').dataset.progressKind,'completion');assert.equal(document.querySelector('[data-task-dismiss]').dataset.progressStatus,'completed');assert.equal(document.querySelector('[data-progress-message]').dataset.progressMessage,'answer');
});
test('accepted call conversation inputs are not phantom tasks while registered call work remains visible',()=>{
 const data=state();data.messages=[{id:'spoken-input',role:'user',text:'This one',status:'accepted',voiceCallId:'call',time:100},{id:'task-input',role:'user',text:'Check the file',status:'accepted',voiceCallId:'call',time:200},{id:'uncertain-input',role:'user',text:'Delivery uncertain',status:'unknown',voiceCallId:'call',turnId:'actual-unknown-work',time:300}];
 data.workTasks=[{id:'call-work',turnId:'actual-turn',messageId:'task-input',source:'voice',title:'Checking the file',status:'review',updatedAt:400}];
 const model=workProgress(data);assert.deepEqual(model.history.map(item=>item.id||item.message.id),['call-work','uncertain-input']);assert.equal(model.history[0].status,'review');assert.equal(model.history[0].message.id,'task-input');assert.equal(model.history[1].status,'unknown');assert.equal(model.reviewCount,0);
});
test('related work spans multiple execution turns while conversation-only replies create no progress entries',()=>{
 const data=state();data.active={turnId:'speech-tail',source:'voice',status:'running',visible:false};data.messages=[{id:'first',role:'user',turnId:'first-turn',workKind:'task',text:'Check a room',status:'review'},{id:'followup',role:'user',turnId:'next-turn',workKind:'task',text:'Use this room',status:'review'},{id:'hello',role:'user',turnId:'greeting',workKind:'conversation',text:'Hello',status:'review'},{id:'input-only',role:'user',voiceCallId:'call',status:'paused'},{id:'old-output',role:'assistant',text:'Room created',read:true},{id:'next-output',role:'assistant',text:'Checking',read:false}];
 data.workTasks=[{id:'same-work',turnId:'next-turn',turnIds:['first-turn','next-turn'],messageId:'first',source:'voice',title:'Test the private room',status:'continuing',startedAt:1000,updatedAt:3000,plan:{steps:[{step:'Create room',status:'completed'},{step:'Verify play',status:'inProgress'}]}}];data.completions=[{turnId:'first-turn',messageIds:['old-output'],work:{source:'voice',status:'review'}},{turnId:'next-turn',messageIds:['next-output'],work:{source:'voice',status:'review'}}];
 let model=workProgress(data);assert.equal(model.active,null);assert.equal(model.history.length,0);assert.equal(model.ongoing.length,1);assert.equal(model.ongoing[0].id,'same-work');assert.equal(model.ongoing[0].message.id,'followup');assert.equal(model.reviewCount,0);
 for(const language of ['en','zh']){model=workProgress(data,{language});const {document}=parseHTML(renderWorkTaskHistory(model.ongoing[0],model.labels));assert.match(document.querySelector('.registered-work').textContent,language==='en'?/In progress/:/进行中/);assert.equal(document.querySelectorAll('ol li').length,2);assert.equal(document.querySelector('[data-work-started]'),null);assert.equal(document.querySelector('[data-task-accept]'),null);}
 data.active={workId:'same-work',turnId:'next-turn',status:'running',source:'voice'};model=workProgress(data);assert.equal(model.active.title,'Test the private room');assert.equal(model.ongoing.length,0);assert.equal(model.history.length,0);
 data.active=null;data.workTasks[0].status='review';model=workProgress(data);assert.equal(model.ongoing.length,0);assert.equal(model.history.length,1);assert.equal(model.reviewCount,1);assert.equal(model.history[0].unread,true);
});

test('idle unfinished work explains automatic continuation without claiming a running executor or changing its actions',()=>{
 for(const language of ['en','zh']){
  const data=state();data.workTasks=[{id:'work',turnId:'ended',source:'voice',title:'Verify the original task',status:'continuing',executionEndedAt:1000,plan:{steps:[{step:'Verify actual output',status:'pending'}]},continuation:{attempts:1,nextAt:30000,dispatch:{id:'private-claim-id',threadId:'private-thread-id'}}}];
  const before=structuredClone(data),model=workProgress(data,{language}),item=model.ongoing[0],document=parseHTML(renderWorkTaskHistory(item,model.labels)).document,hint=document.querySelector('.work-continuation');
  assert.equal(model.active,null);assert.ok(hint);assert.match(hint.textContent,language==='en'?/continues it automatically.*online.*executor is free/:/在线且执行器空闲.*自动续作/);assert.match(hint.textContent,/30/);assert.match(hint.textContent,/5/);assert.equal(document.querySelector('.current-work,[data-work-started],.stream-cursor'),null);assert.equal(document.querySelector('[data-task-cancel]').dataset.taskCancel,'work');assert.equal(document.querySelector('[data-task-dismiss],[data-task-resume],[data-task-accept]'),null);assert.equal(document.querySelector('[data-task-priority]').dataset.progressKind,'work');assert.doesNotMatch(document.documentElement.textContent,/private-claim-id|private-thread-id|attempts|nextAt/);assert.deepEqual(data,before);
  data.controller={status:'offline',cached:true};const stale=workProgress(data,{language}),staleDocument=parseHTML(renderWorkTaskHistory(stale.ongoing[0],stale.labels)).document;assert.equal(staleDocument.querySelector('.work-continuation').textContent,stale.labels.stale);assert.equal(staleDocument.querySelector('[data-task-cancel]').hasAttribute('disabled'),true);assert.doesNotMatch(staleDocument.querySelector('.work-continuation').textContent,/30|5/,'offline state cannot imply a running local check');
 }
});

test('three unchanged automatic follow-ups show a localized pause reason only on the actual paused history entry',()=>{
 for(const language of ['en','zh']){
  const data=state();data.messages=[{id:'result',role:'assistant',text:'A previous actual result',read:false}];data.workTasks=[{id:'stalled-work',turnId:'stalled-turn',source:'chat',title:'Check the pending output',status:'paused',pauseReason:'automatic-no-progress',continuation:{attempts:3,noProgressCount:3,nextAt:null,lastCheckpoint:'hidden-checkpoint'},plan:{steps:[{step:'Check output',status:'inProgress'}]}}];data.completions=[{turnId:'stalled-turn',messageIds:['result']}];
  const before=structuredClone(data),model=workProgress(data,{language}),item=model.history[0],document=parseHTML(renderWorkTaskHistory(item,model.labels,{actions:'<button data-existing-action>Existing action</button>',planOpen:true})).document;
  assert.equal(model.ongoing.length,0);assert.equal(model.completedCount,0);assert.equal(item.pauseReason,'automatic-no-progress');assert.equal(document.querySelector('.work-continuation').textContent,language==='zh'?'连续三次自动跟进没有记录到新进展，已暂停；请检查任务或发送补充说明。':'Paused after three automatic follow-ups recorded no new progress. Check the task or send more instructions.');assert.equal(document.querySelector('[data-task-dismiss]').dataset.progressStatus,'paused');assert.ok(document.querySelector('[data-existing-action]'));assert.equal(document.querySelector('[data-progress-message]').dataset.progressMessage,'result');assert.equal(document.querySelector('[data-work-plan]').hasAttribute('open'),true);assert.equal(document.querySelector('[data-task-cancel]'),null);assert.doesNotMatch(document.documentElement.textContent,/hidden-checkpoint|nextAt|automatic-no-progress/);assert.deepEqual(data,before);
  for(const status of ['cancelled','review','completed','waiting_user','unknown']){data.workTasks[0].status=status;const changed=workProgress(data,{language}),entry=changed.ongoing[0]||changed.history[0];assert.equal(parseHTML(renderWorkTaskHistory(entry,changed.labels)).document.querySelector('.work-continuation'),null,'a stale pause reason never overrides '+status);}
 }
});

test('arbitrary pause diagnostics stay out of work history and active execution retains its existing continuation copy',()=>{
 for(const language of ['en','zh']){
  const data=state();data.workTasks=[{id:'work',turnId:'turn',title:'Original title',status:'paused',pauseReason:'<script>private backend detail</script>'}];let model=workProgress(data,{language}),document=parseHTML(renderWorkTaskHistory(model.history[0],model.labels)).document;assert.equal(model.history[0].pauseReason,null);assert.equal(document.querySelector('.work-continuation,script'),null);assert.doesNotMatch(document.documentElement.textContent,/private backend detail/);
  data.workTasks[0].pauseReason='automatic-no-progress';data.workTasks[0].status='running';data.active={workId:'work',turnId:'turn',status:'running',source:'chat',step:'command'};model=workProgress(data,{language});document=parseHTML(renderActiveWork(model)).document;assert.equal(document.querySelector('.work-continuation').textContent,model.labels.continues);assert.match(document.querySelector('.work-step').textContent,language==='en'?/Running a command/:/正在执行命令/);assert.doesNotMatch(document.querySelector('.work-continuation').textContent,/three|三次|30|5/);
 }
});

test('continued work binds review and resume controls only to its latest actual human turn, never its original anchor',()=>{
 const data=state();data.messages=[{id:'original',role:'user',text:'Original request',status:'review',turnId:'first-turn'},{id:'latest',role:'user',text:'Latest continuation',status:'review',turnId:'latest-turn'}];data.workTasks=[{id:'same-work',turnId:'latest-turn',turnIds:['first-turn','latest-turn'],messageId:'original',source:'chat',title:'Continue the same work',status:'review',plan:{steps:[{step:'Verified result',status:'completed'}]}}];
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),start=source.indexOf('function renderProgress(){'),end=source.indexOf('function renderModal(){',start),context={progressActions:{renderConfirmation:()=>''},workDisclosures:{capture(){},bind(){},isOpen:()=>false},workProgress,renderWorkPriority,renderActiveWork,renderWorkTaskHistory,renderVoiceWorkHistory,state:data,language:()=>'en',eventConnected:true,pendingActions:new Set(),steerExpectedTurn:null,steerDraft:'',t:value=>value,esc:value=>String(value??''),ico:()=>'',formatTime:()=>'',humanControl:()=>false,unknownTask:()=>false};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 let document=parseHTML(context.renderProgress()).document;assert.equal(document.querySelectorAll('.registered-work').length,1);assert.equal(document.querySelector('[data-task-accept]').dataset.taskAccept,'latest');assert.equal(document.querySelector('[data-task-accept="original"]'),null);
 data.messages[1].status='paused';data.workTasks[0].status='paused';document=parseHTML(context.renderProgress()).document;assert.equal(document.querySelector('[data-task-resume]').dataset.taskResume,'latest');assert.equal(document.querySelector('[data-task-resume="original"]'),null);
 data.messages.pop();document=parseHTML(context.renderProgress()).document;assert.equal(document.querySelector('[data-task-accept],[data-task-resume]'),null,'a current voice-only continuation cannot inherit an old human action');
});
test('speech-only work remains visible after media hangup with actual stage and plan, without fabricated progress',()=>{
 const data=state();data.active={messageId:null,turnId:'turn',source:'voice',background:true,status:'running',startedAt:1000,updatedAt:5000,step:'computer'};
 const before=structuredClone(data),model=workProgress(data,{now:61000}),html=renderActiveWork(model);
 assert.match(html,/Continuing in the background/);assert.match(html,/Task from a call/);assert.match(html,/Using the computer/);assert.match(html,/1:00/);assert.doesNotMatch(html,/<progress|No task is running|100%/);assert.deepEqual(data,before);
 data.active.plan={total:4,completed:2,currentStep:'Inspect <board> & verify'};const plan=renderActiveWork(workProgress(data));assert.match(plan,/<progress max="4" value="2"/);assert.match(plan,/Inspect &lt;board&gt; &amp; verify/);
});
test('waiting for input, stopping and uncertain ownership remain distinct from normal work and do not trigger actions',()=>{
 const data=state();data.active={source:'chat',turnId:'turn',messageId:'task',startedAt:1,step:'working'};data.messages=[{id:'task',role:'user',text:'Write a file',status:'waiting_user'}];
 assert.match(renderActiveWork(workProgress(data)),/Waiting for your reply/);
 for(const [status,label]of [['pausing','Stopping safely'],['unknown','Status unconfirmed']]){data.active.status=status;assert.match(renderActiveWork(workProgress(data)),new RegExp(label));}
 for(const controller of [{status:'offline'},{status:'connecting'},{status:'online',cached:true}]){data.controller=controller;data.active.status='running';const model=workProgress(data);assert.equal(model.active.status,'unknown');assert.match(renderActiveWork(model),/Reconnect to confirm/);assert.equal(data.active.status,'running');}
 data.controller={status:'online'};assert.equal(workProgress(data,{connected:false}).active.status,'unknown');
});

test('hidden conversation markers cannot suppress uncertain, stopping or actual waiting ownership and its exact cancellation control',()=>{
 const data=state();data.messages=[{id:'conversation',role:'user',text:'Ordinary conversation',workKind:'conversation',status:'running',turnId:'conversation-turn'}];data.active={source:'voice',turnId:'conversation-turn',messageId:'conversation',visible:false,status:'running',canSteer:false};
 assert.equal(workProgress(data).active,null);assert.equal(workProgress(data).history.length,0);
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),start=source.indexOf('function renderProgress(){'),end=source.indexOf('function renderModal(){',start),context={progressActions:{renderConfirmation:()=>''},workDisclosures:{capture(){},bind(){},isOpen:()=>false},workProgress,renderWorkPriority,renderActiveWork,renderWorkTaskHistory,renderVoiceWorkHistory,state:data,language:()=>'en',eventConnected:true,pendingActions:new Set(),steerExpectedTurn:null,steerDraft:'',t:value=>value,esc:value=>String(value??''),ico:()=>'',formatTime:()=>'',humanControl:()=>false,unknownTask:()=>false};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 for(const [status,label]of [['unknown','Status unconfirmed'],['pausing','Stopping safely'],['waiting_user','Waiting for your reply']]){
  data.active.status=status;const model=workProgress(data),document=parseHTML(context.renderProgress()).document;assert.equal(model.active.status,status);assert.equal(model.history.length,0);assert.match(document.querySelector('.current-work').textContent,new RegExp(label));const control=document.querySelector('[data-task-cancel]');assert.ok(control);assert.equal(control.hasAttribute('disabled'),status!=='waiting_user');assert.equal(document.querySelector('[data-task-resume],[data-task-accept]'),null,'recovery visibility never invents a replay or acceptance action');
 }
 data.active.status='running';assert.equal(parseHTML(context.renderProgress()).document.querySelector('.current-work'),null,'ordinary conversation stays hidden again once ownership is known');
});
test('recent work combines user tasks and readable voice receipts without duplicate or phantom tasks',()=>{
 const data=state();data.active={messageId:'active',turnId:'active-turn'};data.queue=['q2','q1'];data.messages=[{id:'active',role:'user',text:'Active'},{id:'q1',role:'user',text:'First queued'},{id:'q2',role:'user',text:'Second queued'},{id:'human',role:'user',text:'Chat result',status:'review',time:20},{id:'call',role:'system',kind:'call'},{id:'result',role:'assistant',status:'completed',text:'Voice result',time:30,source:{type:'voice-call'}},{id:'old',role:'user',text:'Needs explicit resume',status:'paused',submission:'unknown',time:10}];
 data.completions=[{id:'receipt',turnId:'voice-turn',at:30,messageIds:['result'],work:{source:'voice',status:'review'}},{turnId:'voice-turn',at:40,messageIds:['result']},{turnId:'human-turn',taskId:'human',messageIds:['result']},{turnId:'empty-turn',messageIds:[],work:{source:'voice',status:'review'}},{turnId:'deleted-turn',messageIds:['gone'],work:{source:'voice',status:'review'}}];
 const model=workProgress(data);assert.deepEqual(model.queue.map(item=>item.message.id),['q2','q1']);assert.deepEqual(model.history.map(item=>item.voice?item.id:item.message.id),['receipt','human','old']);assert.equal(model.reviewCount,2);
 const html=renderVoiceWorkHistory(model.history[0],model.labels);assert.match(html,/data-progress-message="result"/);assert.match(html,/Unread result/);assert.doesNotMatch(html,/data-task-resume|data-task-accept|Voice result/);
 data.messages.find(item=>item.id==='result').read=true;assert.equal(workProgress(data).reviewCount,1);
});
test('requests for input or credentials are unread chat messages rather than completed voice tasks',()=>{
 const data=state();data.active={source:'voice',turnId:'owned',status:'waiting_user',background:true};
 data.messages=[{id:'question',role:'assistant',status:'completed',text:'Which project?',source:{type:'voice-call'}},{id:'secret',role:'assistant',status:'completed',text:'Please provide the login',source:{type:'voice-call'}}];
 data.completions=[{turnId:'owned:input:1',messageIds:['question']},{turnId:'owned:credential:2',messageIds:['secret']}];
 let model=workProgress(data);assert.equal(model.active.status,'waiting_user');assert.equal(model.reviewCount,0);assert.equal(model.history.length,0);
 data.active=null;model=workProgress(data);assert.equal(model.history.length,0,'answering a blocker does not convert its message receipt into a result');assert.equal(data.messages[0].read,undefined);
});
test('registered call work shows its saved title and actual checklist before any result exists',()=>{
 const data=state();data.active={workId:'work',turnId:'call-turn',source:'voice',status:'running',step:'computer'};
 data.workTasks=[{id:'work',turnId:'call-turn',messageId:null,source:'voice',title:'Complete the 40 Lines test',status:'running',startedAt:1000,updatedAt:2000,plan:{total:3,completed:1,currentStep:'Play solo',steps:[{step:'Inspect the <board>',status:'completed'},{step:'Play solo',status:'inProgress'},{step:'Verify and report',status:'pending'}]}}];
 const before=structuredClone(data),model=workProgress(data,{now:61000}),{document}=parseHTML(renderActiveWork(model));
 assert.equal(document.querySelector('h3').textContent,'Complete the 40 Lines test');assert.equal(document.querySelector('progress').getAttribute('value'),'1');assert.deepEqual([...document.querySelectorAll('[data-work-step-status]')].map(item=>item.dataset.workStepStatus),['completed','inProgress','pending']);assert.match(document.querySelector('ol').textContent,/Inspect the <board>/);assert.equal(document.querySelector('board'),null);assert.equal(model.history.length,0);assert.equal(model.active.status,'running');assert.deepEqual(data,before);
 data.active.title='Updated task title';data.active.plan={steps:[{step:'Explicitly verified',status:'completed'}]};const updated=workProgress(data);assert.equal(updated.active.title,'Updated task title');assert.equal(updated.active.plan.completed,1);assert.equal(updated.active.status,'running','completing all checklist steps does not complete the owned turn');
});
test('saved work records survive snapshots and replace matching chat and voice history without duplicates',()=>{
 const data=state();data.messages=[{id:'chat',role:'user',turnId:'chat-turn',text:'Long original request',status:'review',time:10},{id:'steered',role:'user',turnId:'chat-turn',text:'Also verify',status:'review',time:11},{id:'answer',role:'assistant',text:'Result',read:false,time:20}];
 data.completions=[{id:'receipt',turnId:'voice-turn',messageIds:['answer'],at:20,work:{source:'voice',status:'review'}}];
 data.workTasks=[{id:'chat-work',turnId:'chat-turn',messageId:'chat',source:'chat',title:'Verify project',status:'review',startedAt:10,updatedAt:30,plan:{steps:[{step:'Check output',status:'completed'}]}},{id:'voice-work',turnId:'voice-turn',source:'voice',title:'Inspect desktop',status:'review',startedAt:12,updatedAt:25,plan:{steps:[{step:'Inspect',status:'completed'}]}}];
 const restored=JSON.parse(JSON.stringify(data)),before=structuredClone(restored),model=workProgress(restored);
 assert.deepEqual(model.history.map(item=>item.id),['chat-work','voice-work']);assert.equal(model.history.every(item=>item.registered&&item.work),true);assert.equal(model.history[0].taskId,'chat');assert.equal(model.history[0].message.id,'chat');assert.equal(model.history[1].messageId,'answer');assert.equal(model.history[1].taskId,null);assert.equal(model.reviewCount,2);assert.deepEqual(restored,before);
 restored.messages.find(item=>item.id==='answer').read=true;assert.equal(workProgress(restored).reviewCount,1);assert.equal(restored.workTasks[1].status,'review','result reading does not rewrite execution status');
});
test('dismissing registered work cannot make its legacy message or receipt reappear',()=>{
 const data=state();data.messages=[{id:'task',role:'user',turnId:'turn',text:'Keep chat',status:'review'},{id:'answer',role:'assistant',read:false}];data.completions=[{id:'receipt',turnId:'turn',messageIds:['answer'],work:{source:'voice',status:'review'}}];data.workTasks=[{id:'work',turnId:'turn',messageId:'task',source:'voice',title:'Saved task',status:'review',progressDismissedAt:100}];
 const before=structuredClone(data),model=workProgress(data);assert.equal(model.history.length,0);assert.equal(model.reviewCount,0);assert.deepEqual(data,before);
 data.active={workId:'work',turnId:'turn',messageId:'task',source:'voice',status:'running'};assert.equal(workProgress(data).active.title,'Saved task','a stale dismiss marker cannot hide actual active work');assert.equal(workProgress(data).history.length,0);
});
test('retried turns keep separate history without letting the old run accept or resume the latest task',()=>{
 const data=state();data.messages=[{id:'task',role:'user',turnId:'new-turn',text:'Retry the export',status:'review',time:10},{id:'old-result',role:'assistant',read:true},{id:'new-result',role:'assistant',read:false}];
 data.workTasks=[{id:'old-work',turnId:'old-turn',messageId:'task',source:'chat',title:'Earlier export attempt',status:'paused',updatedAt:10,plan:{steps:[{step:'Collect files',status:'completed'},{step:'Export',status:'pending'}]}},{id:'new-work',turnId:'new-turn',messageId:'task',source:'chat',title:'Retried export',status:'review',updatedAt:20}];
 data.completions=[{turnId:'old-turn',messageIds:['old-result']},{turnId:'new-turn',messageIds:['new-result']}];
 const before=structuredClone(data);let model=workProgress(data),latest=model.history[0],earlier=model.history[1];
 assert.deepEqual(model.history.map(item=>item.id),['new-work','old-work']);assert.equal(latest.taskId,'task');assert.equal(latest.message,data.messages[0]);assert.equal(latest.messageId,'new-result');assert.equal(earlier.taskId,null);assert.equal(earlier.message,undefined);assert.equal(earlier.messageId,'old-result');assert.equal(earlier.title,'Earlier export attempt');assert.equal(earlier.plan.completed,1);assert.deepEqual(data,before);
 const {document}=parseHTML(renderWorkTaskHistory(earlier,model.labels));assert.equal(document.querySelector('[data-progress-message]').dataset.progressMessage,'old-result');assert.equal(document.querySelector('[data-task-dismiss]').dataset.taskDismiss,'old-work');assert.equal(document.querySelector('[data-task-accept],[data-task-resume]'),null);
 data.active={workId:'new-work',turnId:'new-turn',messageId:'task',source:'chat',status:'running'};model=workProgress(data);assert.equal(model.active.title,'Retried export');assert.deepEqual(model.history.map(item=>item.id),['old-work'],'only the actual current turn is excluded from history');assert.equal(model.history[0].message,undefined);assert.equal(model.history[0].messageId,'old-result');
 data.active=null;data.queue=['task'];model=workProgress(data);assert.equal(model.queue[0].message.id,'task');assert.deepEqual(model.history.map(item=>item.id),['old-work']);assert.equal(model.history[0].taskId,null,'the historical attempt never owns the latest queued request');
});
test('a retry that fails before registration keeps its own Resume action alongside the older saved attempt',()=>{
 const data=state();data.messages=[{id:'task',role:'user',turnId:'retry-turn',text:'Retry export',status:'failed',time:30},{id:'old-result',role:'assistant',read:true}];data.workTasks=[{id:'old-work',turnId:'old-turn',messageId:'task',source:'chat',title:'Earlier export attempt',status:'paused',updatedAt:10,plan:{steps:[{step:'Collect files',status:'completed'}]}}];data.completions=[{turnId:'old-turn',messageIds:['old-result']}];
 const before=structuredClone(data),model=workProgress(data),latest=model.history.find(item=>!item.registered),earlier=model.history.find(item=>item.registered);assert.equal(model.history.length,2);assert.equal(latest.message,data.messages[0]);assert.equal(latest.status,'failed');assert.equal(earlier.taskId,null);assert.equal(earlier.message,undefined);assert.equal(earlier.messageId,'old-result');assert.deepEqual(data,before);
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),start=source.indexOf('function renderProgress(){'),end=source.indexOf('function renderModal(){',start),context={progressActions:{renderConfirmation:()=>''},workDisclosures:{capture(){},bind(){},isOpen:()=>false},workProgress,renderWorkPriority,renderActiveWork,renderWorkTaskHistory,renderVoiceWorkHistory,state:data,language:()=>'en',eventConnected:true,pendingActions:new Set(),steerExpectedTurn:null,steerDraft:'',t:value=>value,esc:value=>String(value??''),ico:()=>'',formatTime:()=>'',humanControl:()=>false,unknownTask:()=>false};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const {document}=parseHTML(context.renderProgress()),fallback=document.querySelector('[data-key="progress-task"]'),saved=document.querySelector('[data-key="registered-work-old-work"]');assert.ok(fallback);assert.ok(saved);assert.equal(fallback.querySelector('[data-task-resume]').dataset.taskResume,'task');assert.equal(fallback.querySelector('[data-task-resume]').hasAttribute('disabled'),false);assert.equal(saved.querySelector('[data-task-resume],[data-task-accept]'),null);assert.equal(saved.querySelector('[data-progress-message]').dataset.progressMessage,'old-result');assert.equal(saved.querySelector('[data-task-dismiss]').dataset.taskDismiss,'old-work');
});
test('registered history keeps canonical status, exact result navigation, dismissal kind and supplied task actions',()=>{
 const data=state();data.workTasks=[{id:'work/id',turnId:'turn',source:'voice',title:'Export <project>',status:'paused',updatedAt:1000,plan:{steps:[{step:'Collect files',status:'completed'},{step:'Export ZIP',status:'pending'}]}}];data.messages=[{id:'question',role:'assistant'},{id:'result',role:'assistant',read:false}];data.completions=[{turnId:'turn:input:1',messageIds:['question']},{turnId:'turn',messageIds:['result']}];
 for(const language of ['en','zh']){
  const model=workProgress(data,{language}),item=model.history[0],{document}=parseHTML(renderWorkTaskHistory(item,model.labels,{pending:true,actions:'<div class="task-actions"><button data-task-resume="task">Resume</button></div>'})),close=document.querySelector('[data-task-dismiss]');
  assert.equal(document.querySelector('p').textContent,'Export <project>');assert.equal(document.querySelector('project'),null);assert.equal(document.querySelector('[data-progress-message]').dataset.progressMessage,'result');assert.equal(document.querySelector('[data-task-resume]').dataset.taskResume,'task');assert.equal(close.dataset.taskDismiss,'work/id');assert.equal(close.dataset.progressKind,'work');assert.equal(close.hasAttribute('disabled'),true);assert.equal(close.getAttribute('aria-label'),language==='en'?'Dismiss task':'收起任务');assert.equal(document.querySelectorAll('ol li').length,2);assert.match(document.querySelector('summary').textContent,/1 \/ 2/);
 }
 data.workTasks[0].status='running';data.worker.status='offline';const model=workProgress(data),{document}=parseHTML(renderWorkTaskHistory(model.history[0],model.labels));assert.equal(model.history[0].status,'unknown');assert.equal(model.history[0].knownStatus,'running');assert.equal(document.querySelector('[data-task-dismiss]'),null,'unconfirmed live work is not dismissible');
});
test('dismissing recent work hides only its progress entry and review marker',()=>{
 const data=state();data.messages=[{id:'task',role:'user',text:'Keep this chat',status:'review',time:10,progressDismissedAt:100},{id:'result',role:'assistant',text:'Keep this result',read:false,time:20}];
 data.completions=[{id:'receipt',turnId:'voice-turn',messageIds:['result'],at:20,progressDismissedAt:100,work:{source:'voice',status:'review'}}];
 const before=structuredClone(data),model=workProgress(data);assert.equal(model.history.length,0);assert.equal(model.reviewCount,0);assert.doesNotMatch(renderWorkEntry(model),/data-work-review-marker/);assert.deepEqual(data,before);
 data.messages[0].progressDismissedAt=null;data.completions[0].progressDismissedAt=null;assert.deepEqual(workProgress(data).history.map(item=>item.id||item.message.id),['receipt','task']);assert.equal(workProgress(data).reviewCount,2);
});
test('live work and its steered messages cannot leak into dismissible history',()=>{
 const data=state();data.active={messageId:'active',turnId:'owned',status:'running'};data.queue=['queued'];data.messages=[{id:'active',role:'user',status:'running',turnId:'owned',progressDismissedAt:100},{id:'steered',role:'user',status:'review',turnId:'owned'},{id:'queued',role:'user',status:'queued',progressDismissedAt:100},{id:'old',role:'user',status:'paused'}];
 const model=workProgress(data);assert.equal(model.active.messageId,'active');assert.deepEqual(model.queue.map(item=>item.message.id),['queued']);assert.deepEqual(model.history.map(item=>item.message.id),['old']);assert.equal(model.reviewCount,0);
});
test('voice history close controls use the final receipt ID and stay distinct from viewing or accepting a result',()=>{
 const item={id:'receipt',messageId:'result',status:'review',title:'Task from a call',unread:true};
 for(const language of ['en','zh']){
  const labels=workProgress(state(),{language}).labels,{document}=parseHTML(renderVoiceWorkHistory(item,labels,{pending:true})),close=document.querySelector('[data-task-dismiss]');
  assert.equal(close.dataset.taskDismiss,'receipt');assert.equal(close.dataset.progressKind,'completion');assert.equal(close.getAttribute('aria-label'),language==='en'?'Dismiss task':'收起任务');assert.equal(close.hasAttribute('disabled'),true);assert.equal(document.querySelector('[data-progress-message]').dataset.progressMessage,'result');assert.equal(document.querySelector('[data-task-accept]'),null);
 }
});
test('main delegates progress mutation bindings and retains the existing task request lock and snapshot refresh',async()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),binding=source.match(/^\s*progressActions\.bind\(\);/m);assert.ok(binding);let binds=0;const context={progressActions:{bind(){binds++;}}};vm.createContext(context);vm.runInContext(binding[0],context);assert.equal(binds,1);assert.doesNotMatch(source,/querySelectorAll\('\[data-task-dismiss\]'\)/,'confirmation and priority mutations belong to the shared action component');
 const requestStart=source.indexOf('async function taskRequest('),requestEnd=source.indexOf('function resumeTask(',requestStart);let release;const pending=new Promise(resolve=>release=resolve),requests=[],snapshots=[];
 const locked={pendingActions:new Set(),state:null,render:()=>{},post:async(...args)=>{requests.push(args);await pending;},api:async path=>{snapshots.push(path);return {messages:[{id:'preserved'}]};}};vm.createContext(locked);vm.runInContext(source.slice(requestStart,requestEnd),locked);
 const first=locked.taskRequest('id','/tasks/id/dismiss',{kind:'task'});await locked.taskRequest('id','/tasks/id/dismiss',{kind:'task'});assert.equal(requests.length,1);assert.equal(locked.pendingActions.has('task:id'),true);release();await first;assert.deepEqual(snapshots,['/state']);assert.equal(locked.pendingActions.size,0);assert.equal(locked.state.messages[0].id,'preserved');
});
test('header progress entry keeps its localized review marker while active and queued details stay in the panel',()=>{
 const data=state();data.messages=[{id:'q',role:'user',text:'<script>alert(1)</script>',status:'queued'},{id:'r',role:'user',status:'review'}];
 for(const language of ['en','zh']){
  const model=workProgress(data,{language}),{document}=parseHTML(renderWorkEntry(model,'<svg></svg>')),entry=document.querySelector('button');
  assert.equal(entry.textContent,language==='en'?'Work progress':'工作进度');assert.ok(entry.querySelector('[data-work-review-marker]'));assert.match(entry.getAttribute('aria-label'),language==='en'?/1 awaiting review/:/1 项待验收/);assert.equal(entry.dataset.action,'progress');
 }
 data.queue=['q'];let html=renderWorkEntry(workProgress(data));assert.doesNotMatch(html,/queued|<script>/);
 data.active={messageId:'q',turnId:'turn',status:'running'};html=renderWorkEntry(workProgress(data));assert.doesNotMatch(html,/Working|<script>/);assert.match(renderActiveWork(workProgress(data)),/Working/);
 data.messages.find(item=>item.id==='r').status='completed';assert.doesNotMatch(renderWorkEntry(workProgress(data)),/data-work-review-marker/);
});

test('invalid plans/times cannot produce false completion and text stays inert',()=>{
 const data=state();data.active={messageId:'task',source:'voice',status:'running',startedAt:Infinity,updatedAt:-1,plan:{total:4,completed:9,currentStep:'x'}};data.messages=[{id:'task',role:'user',text:'<img src=x onerror=alert(1)>'}];
 let model=workProgress(data);assert.equal(model.active.plan.completed,0);const {document}=parseHTML(renderActiveWork(model));assert.equal(document.querySelector('img'),null);assert.equal(document.querySelector('progress').getAttribute('value'),'0');assert.equal(document.querySelector('.work-time').textContent,'');
 data.active.plan.total=129;assert.equal(workProgress(data).active.plan,null);
});

test('quiet work elapsed time updates in place without replacing focused drafts or completing work',()=>{
 const {document}=parseHTML('<time data-work-started="1000">0:00</time><input value="preserved"><time data-work-started="NaN">invalid</time>'),draft=document.querySelector('input');
 updateWorkTimers(document,126000);assert.equal(document.querySelector('time').textContent,'2:05');assert.equal(document.querySelector('input'),draft);assert.equal(draft.value,'preserved');assert.equal(document.querySelectorAll('time')[1].textContent,'invalid');
 updateWorkTimers(document,0);assert.equal(document.querySelector('time').textContent,'0:00');
});

test('chat keeps messages and the composer free of an inline work card by default in every task state',()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),start=source.indexOf('function renderChat(){'),end=source.indexOf('function renderDraftAttachment(',start);
 const data=state(),context={state:data,renderMessages:()=>'<article class="message">Saved chat</article>',renderUnreadControl:()=>'',managedSettings:{renderRequests:()=>''},replyTo:null,attachments:[],renderUnconfirmedMessage:()=>'',renderVoiceRecorder:()=>'',recordDraft:null,recordStarting:false,composerDraft:'Draft stays here',esc:value=>String(value??''),t:value=>value,renderAttachmentOptions:()=>'',speechBlocked:()=>false,dictating:false,recording:null,sending:false,uploading:false,eventConnected:true,speakingId:null,ico:()=>'',button:(action)=>`<button data-action="${action}"></button>`};
 data.messages=[{id:'saved',role:'assistant',text:'Saved chat'}];vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 for(const activeStatus of [null,'running','waiting_user','pausing','unknown']){
  data.active=activeStatus?{messageId:'task',turnId:'owned',status:activeStatus}:null;data.queue=activeStatus?['queued']:[];
  const {document}=parseHTML('<main>'+context.renderChat()+'</main>'),main=document.querySelector('main');
  assert.equal(main.firstElementChild.id,'messages');assert.equal(document.querySelectorAll('.message').length,1);assert.equal(document.querySelector('#composer').textContent,'Draft stays here');assert.equal(document.querySelector('.work-summary,.current-work,[data-action="progress"]'),null);assert.equal(Boolean(document.querySelector('[data-action="stop"]')),Boolean(activeStatus));
 }
 assert.match(source,/settings\?\.showWorkSummary===true\?renderWorkSummary/);
});

test('optional chat work summary shows only actual active, ongoing or queued work and keeps titles inert',()=>{
 const data=state();assert.equal(renderWorkSummary(workProgress(data)),'');data.messages=[{id:'review',role:'user',text:'Review only',status:'review'}];assert.equal(renderWorkSummary(workProgress(data)),'','review history alone never creates a blank summary');
 data.active={turnId:'speech',source:'voice',status:'running',visible:false};assert.equal(renderWorkSummary(workProgress(data)),'','ordinary conversation stays hidden');
 for(const language of ['en','zh']){
  data.active={turnId:'owned',source:'voice',background:true,status:'running',title:'Verify <img src=x onerror=alert(1)> & output'};let model=workProgress(data,{language}),document=parseHTML(renderWorkSummary(model)).document;
  assert.equal(document.querySelector('button').dataset.action,'progress');assert.equal(document.querySelector('img'),null);assert.match(document.querySelector('strong').textContent,/<img/);assert.match(document.querySelector('small').textContent,language==='en'?/Continuing in the background/:/后台继续/);assert.equal(document.querySelector('progress'),null);
  for(const status of ['unknown','pausing','waiting_user']){data.active.status=status;document=parseHTML(renderWorkSummary(workProgress(data,{language}))).document;assert.equal(document.querySelector('button').classList.contains(status),true);}
  data.active.status='running';data.controller={status:'online',cached:true};document=parseHTML(renderWorkSummary(workProgress(data,{language}))).document;assert.equal(document.querySelector('button').classList.contains('unknown'),true);assert.match(document.querySelector('button').title,language==='en'?/Reconnect/:/重新连接/);data.controller={status:'online'};
 }
 data.active=null;data.messages=[];data.workTasks=[{id:'ongoing',turnId:'past-turn',source:'voice',title:'Continue verification',status:'continuing'}];assert.match(renderWorkSummary(workProgress(data)),/Continue verification/);data.workTasks=[];data.messages=[{id:'queued',role:'user',text:'Queued <script>work</script>',status:'queued'}];data.queue=['queued'];const document=parseHTML(renderWorkSummary(workProgress(data))).document;assert.match(document.querySelector('small').textContent,/Queued/);assert.equal(document.querySelector('script'),null);assert.match(document.querySelector('strong').textContent,/<script>/);
});

test('chat summary is strictly opt-in and switching it on and off preserves rendered messages and draft',()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),start=source.indexOf('function renderChat(){'),end=source.indexOf('function renderDraftAttachment(',start),data=state(),context={state:data,workProgress,renderWorkSummary,language:()=>'en',renderMessages:()=>'<article class="message">Saved chat</article>',renderUnreadControl:()=>'',managedSettings:{renderRequests:()=>''},replyTo:null,attachments:[],renderUnconfirmedMessage:()=>'',renderVoiceRecorder:()=>'',recordDraft:null,recordStarting:false,composerDraft:'Draft stays here',esc:value=>String(value??''),t:value=>value,renderAttachmentOptions:()=>'',speechBlocked:()=>false,dictating:false,recording:null,sending:false,uploading:false,eventConnected:true,speakingId:null,ico:()=>'',button:(action)=>`<button data-action="${action}"></button>`};
 data.messages=[{id:'saved',role:'assistant',text:'Saved chat'}];data.active={turnId:'owned',status:'running',title:'Inspect the project'};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 for(const enabled of [undefined,false,'true',true,false,true]){data.settings={showWorkSummary:enabled};const document=parseHTML(context.renderChat()).document;assert.equal(Boolean(document.querySelector('.work-summary')),enabled===true);assert.equal(document.querySelector('.message').textContent,'Saved chat');assert.equal(document.querySelector('#composer').value,'Draft stays here');assert.equal(document.querySelector('#messages').previousElementSibling,document.querySelector('.work-summary'));}
});

test('main renders first-class task access and voice result navigation without changing read state itself',()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
 assert.match(source,/renderWorkEntry\(workProgress\(state/);assert.match(source,/if\(a==='progress'\)\{openModal\(\{type:'progress'\}\)/);assert.match(source,/modal.type==='progress'/);
 const start=source.indexOf(" document.querySelectorAll('[data-progress-message]')"),end=source.indexOf(" document.querySelectorAll('[data-first-unread]')",start);assert.ok(start>0&&end>start);
 const {document,Event}=parseHTML('<button data-progress-message="result"></button><div class="message" data-id="result"></div>');let closes=0,reveals=0,reads=0,scrolls=0;document.querySelector('.message').scrollIntoView=()=>scrolls++;
 const context={document,chatScroll:{navigate:action=>action()},state:{messages:[{id:'result',role:'assistant',read:false}]},closeModal:()=>closes++,revealMessage:()=>reveals++,updateRead:()=>reads++};vm.createContext(context);vm.runInContext(source.slice(start,end),context);document.querySelector('button').dispatchEvent(new Event('click'));
 assert.equal(closes,1);assert.equal(reveals,1);assert.equal(scrolls,1);assert.equal(reads,1);assert.equal(context.state.messages[0].read,false,'only existing visibility dwell may acknowledge reading');
 context.state.messages=[];document.querySelector('button').dispatchEvent(new Event('click'));assert.equal(closes,1,'stale/deleted result is ignored');
});
