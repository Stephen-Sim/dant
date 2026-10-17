import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import fs from 'node:fs';
import vm from 'node:vm';
import {workProgress,renderWorkSummary,renderWorkEntry,renderActiveWork,renderVoiceWorkHistory,updateWorkTimers} from '../ui/work-progress.js';

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
