import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {workProgress,renderActiveWork,renderWorkTaskHistory} from '../ui/work-progress.js';
import {createProgressActions} from '../ui/progress-actions.js';

function setup({language='en',ongoing,registered=true,ephemeral=false,request}={}){
 const {document}=parseHTML('<main></main>'),calls=[],toasts=[];
 const state={worker:{status:'online'},controller:{status:'online'},queue:[],completions:[],call:{id:'media-call',status:'connected'},messages:ephemeral?[]:[{id:'message',role:'user',turnId:'turn',text:'Check <project>',status:'running'}],workTasks:registered?[{id:'work',turnId:'turn',messageId:ephemeral?null:'message',source:'voice',title:'Check <project>',status:ongoing||'running',plan:{steps:[{step:'Inspect',status:'completed'},{step:'Verify',status:'inProgress'}]}}]:[],active:ongoing?null:{messageId:ephemeral?null:'message',turnId:'turn',source:'voice',callId:'owner-call',status:'running',...(registered?{workId:'work'}:{})}};
 let actions;
 const getModel=()=>workProgress(state,{language}),render=()=>{const model=getModel();document.querySelector('main').innerHTML=renderActiveWork(model,{pending:actions.busy})+model.ongoing.map(item=>renderWorkTaskHistory(item,model.labels,{pending:actions.busy})).join('')+model.recent.filter(item=>item.registered).map(item=>renderWorkTaskHistory(item,model.labels,{pending:actions.busy})).join('')+actions.renderConfirmation();actions.bind();};
 actions=createProgressActions({document,getModel,render,getLanguage:()=>language,toast:text=>toasts.push(text),request:async(...args)=>{calls.push(args);if(request)return request(...args);state.active=null;for(const record of state.workTasks)record.status='cancelled';for(const message of state.messages)message.status='cancelled';return {ok:true,cancelled:true};}});render();
 return {document,state,actions,getModel,render,calls,toasts};
}

test('the compact registered current X requires confirmation and retains exact cancelled history without touching call media',async()=>{
 for(const language of ['en','zh']){
  const app=setup({language}),beforeCall=structuredClone(app.state.call);assert.equal(app.document.querySelectorAll('[data-task-cancel]').length,1);await app.document.querySelector('.progress-cancel').onclick();
  assert.equal(app.calls.length,0);assert.match(app.document.querySelector('[role=alertdialog]').textContent,language==='en'?/Recent tasks as Cancelled/:/最近的任务.*已取消/);assert.equal(app.document.querySelector('project'),null);
  await app.document.querySelector('[data-progress-task-cancel-confirm]').onclick();
  assert.deepEqual(app.calls,[['work','/tasks/work/cancel',{kind:'work',turnId:'turn',callId:'owner-call'}]]);assert.equal(app.document.querySelector('.current-work'),null);assert.equal(app.getModel().ongoing.length,0);assert.equal(app.getModel().recent[0].status,'cancelled');assert.equal(app.getModel().completedCount,0);assert.deepEqual(app.state.call,beforeCall);assert.equal(app.state.messages.length,1);assert.equal(app.state.workTasks.length,1);
  assert.match(app.document.querySelector('.registered-work').textContent,language==='en'?/Cancelled/:/已取消/);assert.equal(app.document.querySelector('[data-work-step-status=inProgress]'),null);assert.match(app.document.querySelector('[data-work-step-status=cancelled] small').textContent,language==='en'?/Stopped/:/已停止/);assert.equal(app.state.workTasks[0].plan.steps[1].status,'inProgress','only presentation changes the unfinished step');assert.equal(app.document.querySelector('[data-task-cancel]'),null);assert.ok(app.document.querySelector('[data-task-dismiss]'));
 }
});

test('inactive ongoing work cancels into recent history while a historical task still uses dismiss',async()=>{
 for(const status of ['continuing','waiting_user']){
  const app=setup({ongoing:status});assert.equal(app.document.querySelector('[data-task-dismiss]'),null);await app.document.querySelector('[data-task-cancel]').onclick();await app.document.querySelector('[data-progress-task-cancel-confirm]').onclick();assert.deepEqual(app.calls,[['work','/tasks/work/cancel',{kind:'work',turnId:'turn'}]]);assert.equal(app.getModel().ongoing.length,0);assert.equal(app.getModel().recent[0].status,'cancelled');
  await app.document.querySelector('[data-task-dismiss]').onclick();assert.ok(app.document.querySelector('[data-progress-dismiss-confirm]'));assert.equal(app.document.querySelector('[data-progress-task-cancel-confirm]'),null);
 }
});

test('legacy bottom cancellation targets the actual task, preparation message or ephemeral native turn',async()=>{
 for(const entry of [{registered:false,expected:{kind:'task',turnId:'turn',callId:'owner-call'},id:'message'},{registered:false,ephemeral:true,expected:{kind:'active',turnId:'turn',callId:'owner-call'},id:'current'},{registered:false,preparing:true,expected:{kind:'task',turnId:null,callId:'owner-call'},id:'message'}]){
  const app=setup(entry);if(entry.preparing){app.state.active.turnId=null;delete app.state.messages[0].turnId;app.render();}assert.equal(app.document.querySelectorAll('[data-task-cancel]').length,2);await app.document.querySelector('.current-work-cancel').onclick();await app.document.querySelector('[data-progress-task-cancel-confirm]').onclick();assert.deepEqual(app.calls,[[entry.id,'/tasks/'+entry.id+'/cancel',entry.expected]]);
 }
});

test('a changed turn, owner call or completed task invalidates both stale controls and their open confirmation',async()=>{
 for(const change of ['turn','call','completed']){
  const app=setup(),stale=app.document.querySelector('[data-task-cancel]');await stale.onclick();
  if(change==='turn')app.state.active.turnId='new-turn';else if(change==='call')app.state.active.callId='new-call';else{app.state.active=null;app.state.workTasks[0].status='review';}
  await app.document.querySelector('[data-progress-task-cancel-confirm]').onclick();assert.equal(app.calls.length,0);assert.equal(app.actions.renderConfirmation(),'');assert.match(app.toasts.at(-1),/changed/);
  await stale.onclick();assert.equal(app.calls.length,0);assert.equal(app.actions.renderConfirmation(),'');
 }
});

test('pending cancellation disables duplicate actions and unknown failure never moves work into cancelled history',async()=>{
 let reject;const waiting=new Promise((resolve,no)=>reject=no),app=setup({request:()=>waiting});await app.document.querySelector('[data-task-cancel]').onclick();const confirm=app.document.querySelector('[data-progress-task-cancel-confirm]'),pending=confirm.onclick();assert.equal(app.actions.busy,true);assert.ok([...app.document.querySelectorAll('[data-task-cancel]')].every(node=>node.hasAttribute('disabled')));await confirm.onclick();assert.equal(app.calls.length,1);
 app.state.active.status='unknown';reject(Error('Stop was not confirmed'));await pending;assert.equal(app.getModel().active.status,'unknown');assert.equal(app.getModel().recent.length,0);assert.match(app.document.querySelector('.current-work').textContent,/Status unconfirmed/);assert.ok(app.document.querySelector('[data-progress-task-cancel-confirm]').hasAttribute('disabled'));assert.equal(app.toasts.includes('Task cancelled'),false);
});

test('no cancellation result or an offline owner cannot claim success, and backing out never mutates a task',async()=>{
 const app=setup({request:()=>({ok:true})});await app.document.querySelector('[data-task-cancel]').onclick();app.document.querySelector('[data-progress-task-cancel-back]').onclick();assert.equal(app.calls.length,0);assert.equal(app.actions.renderConfirmation(),'');await app.document.querySelector('[data-task-cancel]').onclick();await app.document.querySelector('[data-progress-task-cancel-confirm]').onclick();assert.match(app.toasts.at(-1),/not confirmed/);assert.ok(app.getModel().active);assert.equal(app.getModel().recent.length,0);
 app.actions.onClose();app.state.controller.cached=true;app.render();assert.ok([...app.document.querySelectorAll('[data-task-cancel]')].every(node=>node.hasAttribute('disabled')));await app.document.querySelector('[data-task-cancel]').onclick();assert.equal(app.calls.length,1);
});

test('cancelled work stays outside ongoing and completed even when every step had been checked',()=>{
 const app=setup({ongoing:'continuing'});app.state.workTasks[0].status='cancelled';for(const step of app.state.workTasks[0].plan.steps)step.status='completed';const model=app.getModel();assert.equal(model.active,null);assert.equal(model.ongoing.length,0);assert.equal(model.completedCount,0);assert.equal(model.recent[0].status,'cancelled');assert.equal(model.reviewCount,0);
});

test('a historical dismiss confirmation cannot hide a task that became ongoing',async()=>{
 const app=setup({ongoing:'paused'});await app.document.querySelector('[data-task-dismiss]').onclick();app.state.workTasks[0].status='continuing';await app.document.querySelector('[data-progress-dismiss-confirm]').onclick();assert.equal(app.calls.length,0);assert.equal(app.document.querySelector('[data-progress-dismiss-confirm]'),null);assert.ok(app.document.querySelector('[data-progress-task-cancel-confirm]'));await app.document.querySelector('[data-progress-task-cancel-confirm]').onclick();assert.deepEqual(app.calls,[['work','/tasks/work/cancel',{kind:'work',turnId:'turn'}]]);
});

test('main uses task-scoped progress cancellation controls and refreshes failed cancellation without replay',async()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),renderStart=source.indexOf('function renderProgress(){'),renderEnd=source.indexOf('function renderModal(){',renderStart),progress=source.slice(renderStart,renderEnd);assert.doesNotMatch(progress,/data-action="stop"/);assert.match(progress,/renderActiveWork\(model,\{pending:busy,planOpen:workDisclosures\.isOpen\(active\.id\)\}\)/);
 const start=source.indexOf('async function taskRequest('),end=source.indexOf('function resumeTask(',start),requests=[],reads=[],context={state:null,pendingActions:new Set(),render(){},post:async(...args)=>{requests.push(args);throw Error('Unconfirmed');},api:async route=>{reads.push(route);return {active:{turnId:'turn',status:'unknown'}};}};vm.createContext(context);vm.runInContext(source.slice(start,end),context);await assert.rejects(context.taskRequest('work','/tasks/work/cancel',{kind:'work',turnId:'turn'}),/Unconfirmed/);assert.equal(requests.length,1);assert.deepEqual(reads,['/state']);assert.equal(context.state.active.status,'unknown');assert.equal(context.pendingActions.size,0);
});
