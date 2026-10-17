import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
 const requests=[],toasts=[],state={active:{source:'voice',messageId:'active',turnId:'voice-turn'},call:{id:'call',provider:'subscription'},queue:[],messages:[{id:'active',role:'user',text:'Current task',status:'running'},{id:'paused',role:'user',text:'Paused task',status:'paused'},{id:'unknown',role:'user',text:'Unknown task',status:'paused',submission:'unknown'}]};
 const context={state,pendingActions:new Set(),steerExpectedTurn:null,steerDraft:'',progressExpanded:false,t:value=>value,esc:value=>String(value??''),ico:()=>'',formatTime:()=>'',humanControl:()=>false,unknownTask:message=>message?.submission==='unknown',taskRequest:async(id,route,body)=>requests.push({id,route,body}),toast:value=>toasts.push(value),openModal:()=>{}};
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

test('direct resume handlers cannot submit while a subscription call is active',async()=>{
 const {context,state,requests,toasts}=fixture();await context.resumeTask('paused',false);await context.resumeTask('unknown',true);assert.equal(requests.length,0);assert.deepEqual(toasts,['resumeAfterCall','resumeAfterCall']);
 state.call=null;await context.resumeTask('paused',false);assert.equal(requests.length,1);assert.equal(requests[0].route,'/tasks/resume');assert.equal(requests[0].body.ids[0],'paused');
});
