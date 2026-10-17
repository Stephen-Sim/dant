import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import fs from 'node:fs';
import vm from 'node:vm';
import {workProgress,renderWorkSummary,renderWorkEntry,renderActiveWork,renderVoiceWorkHistory,renderWorkTaskHistory,updateWorkTimers} from '../ui/work-progress.js';

const state=()=>({worker:{status:'online'},controller:{status:'online'},messages:[],queue:[],completions:[]});
test('speech-only work remains visible after media hangup with actual stage and plan, without fabricated progress',()=>{
 const data=state();data.active={messageId:null,turnId:'turn',source:'voice',background:true,status:'running',startedAt:1000,updatedAt:5000,step:'computer'};
 const before=structuredClone(data),model=workProgress(data,{now:61000}),html=renderWorkSummary(model)+renderActiveWork(model);
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
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),start=source.indexOf('function renderProgress(){'),end=source.indexOf('function renderModal(){',start),context={workProgress,renderActiveWork,renderWorkTaskHistory,renderVoiceWorkHistory,state:data,language:()=>'en',eventConnected:true,pendingActions:new Set(),steerExpectedTurn:null,steerDraft:'',t:value=>value,esc:value=>String(value??''),ico:()=>'',formatTime:()=>'',humanControl:()=>false,unknownTask:()=>false};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
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
test('close handlers submit only dismissal metadata and refresh through the existing request lock',async()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),start=source.indexOf(" document.querySelectorAll('[data-task-dismiss]')"),end=source.indexOf(" document.querySelectorAll('[data-task-accept]')",start);
 const {document}=parseHTML('<button data-task-dismiss="task/id" data-progress-kind="task"></button><button data-task-dismiss="receipt" data-progress-kind="completion"></button><button data-task-dismiss="bad" data-progress-kind="unknown"></button>'),calls=[],errors=[],context={document,taskRequest:async(...args)=>calls.push(args),toast:error=>errors.push(error),errorText:error=>error.message};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);for(const button of document.querySelectorAll('button'))await button.onclick();assert.equal(calls.length,2);assert.equal(calls[0][0],'task/id');assert.equal(calls[0][1],'/tasks/task%2Fid/dismiss');assert.equal(calls[0][2].kind,'task');assert.equal(calls[1][2].kind,'completion');
 context.taskRequest=async()=>{throw Error('Task became active');};await document.querySelector('button').onclick();assert.deepEqual(errors,['Task became active']);
 const requestStart=source.indexOf('async function taskRequest('),requestEnd=source.indexOf('function resumeTask(',requestStart);let release;const pending=new Promise(resolve=>release=resolve),requests=[],snapshots=[];
 const locked={pendingActions:new Set(),state:null,render:()=>{},post:async(...args)=>{requests.push(args);await pending;},api:async path=>{snapshots.push(path);return {messages:[{id:'preserved'}]};}};vm.createContext(locked);vm.runInContext(source.slice(requestStart,requestEnd),locked);
 const first=locked.taskRequest('id','/tasks/id/dismiss',{kind:'task'});await locked.taskRequest('id','/tasks/id/dismiss',{kind:'task'});assert.equal(requests.length,1);assert.equal(locked.pendingActions.has('task:id'),true);release();await first;assert.deepEqual(snapshots,['/state']);assert.equal(locked.pendingActions.size,0);assert.equal(locked.state.messages[0].id,'preserved');
});
test('review stays in a small localized progress-entry marker without an idle banner or visible review label',()=>{
 const data=state();assert.equal(renderWorkSummary(workProgress(data,{language:'zh'})),'');
 data.worker.status='offline';assert.equal(renderWorkSummary(workProgress(data)),'','offline presence already belongs in the header');
 data.worker.status='online';data.messages=[{id:'q',role:'user',text:'<script>alert(1)</script>',status:'queued'},{id:'r',role:'user',status:'review'}];
 for(const language of ['en','zh']){
  const model=workProgress(data,{language}),{document}=parseHTML(renderWorkEntry(model,'<svg></svg>')),entry=document.querySelector('button');
  assert.equal(entry.textContent,language==='en'?'Work progress':'工作进度');assert.ok(entry.querySelector('[data-work-review-marker]'));assert.match(entry.getAttribute('aria-label'),language==='en'?/1 awaiting review/:/1 项待验收/);assert.equal(entry.dataset.action,'progress');assert.equal(renderWorkSummary(model),'');
 }
 data.queue=['q'];let html=renderWorkSummary(workProgress(data));assert.match(html,/1 queued/);assert.doesNotMatch(html,/awaiting review|<script>/);
 data.active={messageId:'q',turnId:'turn',status:'running'};html=renderWorkSummary(workProgress(data));assert.match(html,/Working/);assert.doesNotMatch(html,/awaiting review|<script>/);
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

test('main renders first-class task access and voice result navigation without changing read state itself',()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
 assert.match(source,/renderWorkEntry\(workProgress\(state/);assert.match(source,/if\(a==='progress'\)\{openModal\(\{type:'progress'\}\)/);assert.match(source,/modal.type==='progress'/);
 const start=source.indexOf(" document.querySelectorAll('[data-progress-message]')"),end=source.indexOf(" document.querySelectorAll('[data-first-unread]')",start);assert.ok(start>0&&end>start);
 const {document,Event}=parseHTML('<button data-progress-message="result"></button><div class="message" data-id="result"></div>');let closes=0,reveals=0,reads=0,scrolls=0;document.querySelector('.message').scrollIntoView=()=>scrolls++;
 const context={document,state:{messages:[{id:'result',role:'assistant',read:false}]},closeModal:()=>closes++,revealMessage:()=>reveals++,updateRead:()=>reads++};vm.createContext(context);vm.runInContext(source.slice(start,end),context);document.querySelector('button').dispatchEvent(new Event('click'));
 assert.equal(closes,1);assert.equal(reveals,1);assert.equal(scrolls,1);assert.equal(reads,1);assert.equal(context.state.messages[0].read,false,'only existing visibility dwell may acknowledge reading');
 context.state.messages=[];document.querySelector('button').dispatchEvent(new Event('click'));assert.equal(closes,1,'stale/deleted result is ignored');
});
