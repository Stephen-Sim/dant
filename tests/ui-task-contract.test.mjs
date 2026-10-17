import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {workProgress,renderWorkSummary,renderActiveWork,renderVoiceWorkHistory} from '../ui/work-progress.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
 const requests=[],toasts=[],state={active:{source:'voice',messageId:'active',turnId:'voice-turn'},call:{id:'call',provider:'subscription'},queue:[],messages:[{id:'active',role:'user',text:'Current task',status:'running'},{id:'paused',role:'user',text:'Paused task',status:'paused'},{id:'unknown',role:'user',text:'Unknown task',status:'paused',submission:'unknown'}]};
 const context={workProgress,renderWorkSummary,renderActiveWork,renderVoiceWorkHistory,language:()=>'en',eventConnected:true,state,pendingActions:new Set(),steerExpectedTurn:null,steerDraft:'',progressExpanded:false,t:value=>value,esc:value=>String(value??''),ico:()=>'',formatTime:()=>'',humanControl:()=>false,unknownTask:message=>message?.submission==='unknown',taskRequest:async(id,route,body)=>requests.push({id,route,body}),toast:value=>toasts.push(value),openModal:()=>{}};
 vm.createContext(context);vm.runInContext(section('function renderProgress(){','function renderModal(){')+'\n'+section('function resumeTask(id,confirmUnknown){','function bindSteer(){'),context);
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
 const {context,state}=fixture();state.call=null;state.active={source:'voice',messageId:null,turnId:'owned',background:true,canSteer:false};
 let html=context.renderProgress();assert.doesNotMatch(html,/id="steer-form"/);assert.match(html,/workAdjustUnavailable/);assert.match(html,/data-action="stop"/);
 state.active.canSteer=true;state.active.status='waiting_user';html=context.renderProgress();assert.match(html,/id="steer-form"/);
 state.controller={cached:true};html=context.renderProgress();assert.match(html,/id="steer-text"[^>]*disabled/);assert.match(html,/<button type="submit"[^>]*disabled/);
});

test('direct resume handlers cannot submit while a subscription call is active',async()=>{
 const {context,state,requests,toasts}=fixture();await context.resumeTask('paused',false);await context.resumeTask('unknown',true);assert.equal(requests.length,0);assert.deepEqual(toasts,['resumeAfterCall','resumeAfterCall']);
 state.call=null;await context.resumeTask('paused',false);assert.equal(requests.length,1);assert.equal(requests[0].route,'/tasks/resume');assert.equal(requests[0].body.ids[0],'paused');
});
test('only inactive recent task rows have close controls, including while another call is active',()=>{
 const {context,state}=fixture();state.queue=['queued'];state.messages.push({id:'queued',role:'user',text:'Queued work',status:'queued'},{id:'review',role:'user',text:'Result',status:'review'},{id:'completed',role:'user',text:'Done',status:'completed'},{id:'draft',role:'user',text:'Still preparing attachment',status:'draft'});
 const {document}=parseHTML(context.renderProgress()),dismiss=[...document.querySelectorAll('[data-task-dismiss]')];assert.deepEqual(dismiss.map(button=>button.dataset.taskDismiss),['paused','unknown','review','completed']);assert.ok(dismiss.every(button=>button.dataset.progressKind==='task'&&!button.hasAttribute('disabled')));assert.ok(document.querySelector('[data-task-accept="review"]'));assert.ok(document.querySelector('[data-action="stop"]'));
 context.pendingActions.add('task:paused');const pending=parseHTML(context.renderProgress()).document;assert.equal(pending.querySelector('[data-task-dismiss="paused"]').hasAttribute('disabled'),true);
});
