import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {workProgress,renderWorkPriority,renderActiveWork,renderVoiceWorkHistory,renderWorkTaskHistory} from '../ui/work-progress.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
 const requests=[],toasts=[],state={active:{source:'voice',messageId:'active',turnId:'voice-turn',callId:'call'},call:{id:'call',provider:'subscription'},queue:[],messages:[{id:'active',role:'user',text:'Current task',status:'running'},{id:'paused',role:'user',text:'Paused task',status:'paused'},{id:'unknown',role:'user',text:'Unknown task',status:'paused',submission:'unknown'}]};
 const context={progressActions:{bind(){},renderConfirmation:()=>'',onClose(){},busy:false},workDisclosures:{capture(){},bind(){},isOpen:()=>false},workProgress,renderWorkPriority,renderActiveWork,renderVoiceWorkHistory,renderWorkTaskHistory,language:()=>'en',eventConnected:true,state,pendingActions:new Set(),steerExpectedTurn:null,steerDraft:'',progressExpanded:false,t:value=>value,esc:value=>String(value??''),ico:()=>'',formatTime:()=>'',humanControl:()=>false,taskRequest:async(id,route,body)=>requests.push({id,route,body}),toast:value=>toasts.push(value),openModal:()=>{}};
 vm.createContext(context);vm.runInContext(source.match(/^const unknownTask=.*$/m)[0]+'\n'+section('function renderProgress(){','function renderModal(){')+'\n'+section('function resumeTask(id,confirmUnknown){','function bindSteer(){'),context);
 return {context,state,requests,toasts};
}

test('native work uses the call composer and disables ordinary paused-task replay',()=>{
 const {context,state}=fixture();let html=context.renderProgress();
 assert.doesNotMatch(html,/id="steer-form"/);assert.match(html,/voiceTaskAdjust/);
 assert.match(html,/data-task-resume="paused"[^>]*disabled/);assert.match(html,/data-task-unknown="unknown"[^>]*disabled/);assert.match(html,/resumeAfterCall/);
 state.active.messageId=null;html=context.renderProgress();assert.match(html,/voiceTaskAdjust/);assert.doesNotMatch(html,/noActiveTask|id="steer-form"/,'speech-only work is still an active task');
 state.call=null;state.active={messageId:'active',turnId:'text-turn'};html=context.renderProgress();assert.match(html,/id="steer-form"/);assert.doesNotMatch(html,/data-task-resume="paused"[^>]*disabled/);
});

test('native background work exposes an adjustment only when the owned task can accept that reply',()=>{
 const {context,state}=fixture();state.call=null;state.active={source:'voice',messageId:null,turnId:'owned',callId:'detached-call',background:true,canSteer:false};
 let html=context.renderProgress();assert.doesNotMatch(html,/id="steer-form"/);assert.match(html,/workAdjustUnavailable/);assert.doesNotMatch(html,/data-action="stop"/);
 const controls=[...parseHTML(html).document.querySelectorAll('[data-task-cancel]')];assert.equal(controls.length,2);assert.ok(controls.every(button=>button.dataset.taskCancel==='current'&&button.dataset.progressKind==='active'&&button.dataset.progressTurn==='owned'&&button.dataset.progressCall==='detached-call'&&!button.hasAttribute('disabled')),'both the X and Cancel current work retain the detached execution owner');
 state.active.canSteer=true;state.active.status='waiting_user';html=context.renderProgress();assert.match(html,/id="steer-form"/);
 state.controller={cached:true};html=context.renderProgress();assert.match(html,/id="steer-text"[^>]*disabled/);assert.match(html,/<button type="submit"[^>]*disabled/);assert.ok([...parseHTML(html).document.querySelectorAll('[data-task-cancel]')].every(button=>button.hasAttribute('disabled')),'cached ownership cannot issue cancellation');
});

test('direct resume handlers cannot submit while a subscription call is active',async()=>{
 const {context,state,requests,toasts}=fixture();await context.resumeTask('paused',false);await context.resumeTask('unknown',true);assert.equal(requests.length,0);assert.deepEqual(toasts,['resumeAfterCall','resumeAfterCall']);
 state.call=null;await context.resumeTask('paused',false);assert.equal(requests.length,1);assert.equal(requests[0].route,'/tasks/resume');assert.equal(requests[0].body.ids[0],'paused');
});

test('stale resume actions cannot replay cancelled or removed messages',async()=>{
 const {context,state,requests,toasts}=fixture();state.call=null;const message=state.messages.find(item=>item.id==='paused');message.status='cancelled';
 await context.resumeTask('paused',false);await context.resumeTask('paused',true);await context.resumeTask('removed',false);assert.equal(requests.length,0);assert.deepEqual(toasts,[]);
 state.call={id:'call',provider:'subscription'};await context.resumeTask('paused',false);assert.equal(requests.length,0);assert.deepEqual(toasts,[],'a terminal stale action needs neither a replay nor a misleading call warning');
 message.status='paused';await context.resumeTask('paused',false);assert.deepEqual(toasts,['resumeAfterCall'],'valid replay still respects the call guard');
});

test('submitting and unknown-outcome work use explicit retry controls instead of ordinary resume',async()=>{
 const {context,state,requests}=fixture();state.call=null;state.active=null;state.messages.push({id:'submitting',role:'user',text:'Submission reply not recorded',status:'paused',submission:'submitting'},{id:'flagged',role:'user',text:'Uncertain outcome',status:'failed',unknownOutcome:true},{id:'preparing',role:'user',text:'Not submitted yet',status:'paused',submission:'preparing'});
 const {document}=parseHTML(context.renderProgress());for(const id of ['submitting','flagged']){assert.ok(document.querySelector('[data-task-unknown="'+id+'"]'));assert.equal(document.querySelector('[data-task-resume="'+id+'"]'),null);await context.resumeTask(id,false);}assert.equal(requests.length,0);
 assert.ok(document.querySelector('[data-task-resume="preparing"]'));await context.resumeTask('preparing',false);await context.resumeTask('submitting',true);assert.equal(requests.length,2);assert.equal(requests[0].id,'preparing');assert.equal(requests[0].body.confirmUnknown,undefined);assert.equal(requests[1].id,'submitting');assert.equal(requests[1].body.confirmUnknown,true);
});
test('active close controls cancel the exact owner while inactive history closes remain dismiss-only during a call',()=>{
 const {context,state}=fixture();state.queue=['queued'];state.messages.push({id:'queued',role:'user',text:'Queued work',status:'queued'},{id:'review',role:'user',text:'Result',status:'review'},{id:'completed',role:'user',text:'Done',status:'completed'},{id:'draft',role:'user',text:'Still preparing attachment',status:'draft'});
 const {document}=parseHTML(context.renderProgress()),dismiss=[...document.querySelectorAll('[data-task-dismiss]')];assert.deepEqual(dismiss.map(button=>button.dataset.taskDismiss),['paused','unknown','review','completed']);assert.ok(dismiss.every(button=>button.dataset.progressKind==='task'&&!button.hasAttribute('disabled')));assert.ok(document.querySelector('[data-task-accept="review"]'));
 const cancellation=[...document.querySelectorAll('[data-task-cancel]')];assert.equal(cancellation.length,2);assert.ok(cancellation.every(button=>button.dataset.taskCancel==='active'&&button.dataset.progressKind==='task'&&button.dataset.progressTurn==='voice-turn'&&button.dataset.progressCall==='call'));assert.equal(document.querySelector('[data-task-dismiss="active"],[data-task-cancel="queued"],[data-task-cancel="paused"],[data-task-cancel="unknown"]'),null);assert.equal(document.querySelector('[data-action="stop"]'),null,'the selected card never dispatches a global pause instead of exact cancellation');
 context.pendingActions.add('task:paused');const pending=parseHTML(context.renderProgress()).document;assert.equal(pending.querySelector('[data-task-dismiss="paused"]').hasAttribute('disabled'),true);
});
test('registered work keeps the existing task actions and uses its own persistent dismissal identity',()=>{
 const {context,state}=fixture();state.messages.push({id:'review',role:'user',text:'Original request',status:'review',turnId:'review-turn'},{id:'answer',role:'assistant',text:'Actual result',status:'completed'});
 state.workTasks=[{id:'record-paused',turnId:'paused-turn',messageId:'unknown',source:'chat',title:'Check the browser',status:'paused',updatedAt:10,plan:{steps:[{step:'Inspect current state',status:'inProgress'}]}},{id:'record-review',turnId:'review-turn',messageId:'review',source:'chat',title:'Verify the requested change',status:'review',updatedAt:20}];state.completions=[{turnId:'review-turn',messageIds:['answer'],taskId:'review'}];
 const {document}=parseHTML(context.renderProgress()),paused=document.querySelector('[data-key="registered-work-record-paused"]'),review=document.querySelector('[data-key="registered-work-record-review"]');assert.ok(paused);assert.ok(review);assert.equal(document.querySelector('[data-key="progress-review"]'),null);assert.equal(document.querySelector('[data-key="progress-unknown"]'),null);
 assert.equal(paused.querySelector('[data-task-unknown]').dataset.taskUnknown,'unknown');assert.equal(paused.querySelector('[data-task-unknown]').hasAttribute('disabled'),true);assert.match(paused.textContent,/unknownOutcome/);assert.equal(paused.querySelector('[data-task-dismiss]').dataset.taskDismiss,'record-paused');assert.equal(paused.querySelector('[data-task-dismiss]').dataset.progressKind,'work');assert.equal(paused.querySelector('[data-task-dismiss]').hasAttribute('disabled'),false);assert.equal(review.querySelector('[data-task-accept]').dataset.taskAccept,'review');assert.equal(review.querySelector('[data-progress-message]').dataset.progressMessage,'answer');
 context.pendingActions.add('task:record-paused');const pending=parseHTML(context.renderProgress()).document;assert.equal(pending.querySelector('[data-task-dismiss="record-paused"]').hasAttribute('disabled'),true);
});
