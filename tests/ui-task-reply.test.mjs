import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {workProgress,renderWorkTaskHistory} from '../ui/work-progress.js';
import {createTaskReplyController} from '../ui/task-reply.js';

function fixture({language='en',status='waiting_user'}={}){
 const {document}=parseHTML('<html><body></body></html>');
 const state={conversationId:'conversation-a',capabilities:{workReply:true},controller:{status:'online'},worker:{status:'online'},queue:['queued-other'],messages:[{id:'quoted',role:'assistant',text:'Ordinary message quote'},{id:'queued-other',role:'user',text:'Another request',status:'queued'}],workTasks:[{id:'work-a',turnId:'turn-a',status,title:'Verify <project> & report',executionEndedAt:1000,plan:{steps:[{step:'Run verification',status:'inProgress'}]}},{id:'work-b',turnId:'turn-b',status:'waiting_user',title:'Unrelated task',executionEndedAt:1000,plan:{steps:[{step:'Wait',status:'pending'}]}}],active:{workId:'live-other',turnId:'live-turn',source:'voice',status:'running',callId:'call-a'},call:{id:'call-a',provider:'subscription',status:'connected'}};
 const composer={draft:'Keep my unsent draft',replyTo:'quoted',attachments:['attachment-a']},toasts=[];let modal=true,chatMode='call',opens=0,controller;
 const getModel=()=>workProgress(state,{language});
 const render=()=>{const model=getModel();document.body.innerHTML=`<main>${model.items.filter(item=>item.registered).map(item=>renderWorkTaskHistory(item,model.labels,{pending:controller.pending})).join('')}</main><aside>${controller.render()}<div data-ordinary-reply>${composer.replyTo}</div><textarea id="composer">${composer.draft}</textarea><div data-attachment>${composer.attachments.join(',')}</div></aside>`;controller.bind();};
 controller=createTaskReplyController({document,getModel,getLanguage:()=>language,render,toast:message=>toasts.push(message),openChat:()=>{modal=false;chatMode='text';opens++;}});render();
 return {document,state,composer,toasts,controller,getModel,render,get modal(){return modal;},get chatMode(){return chatMode;},get opens(){return opens;}};
}

test('Reply to task opens the text composer without sending, resuming, replacing a draft or ordinary message quote',()=>{
 for(const language of ['en','zh']){
  const app=fixture({language}),before=structuredClone({state:app.state,composer:app.composer});
  const button=app.document.querySelector('[data-task-work-reply="work-a"]');assert.equal(button.disabled,false);assert.match(button.textContent,language==='en'?/Reply to task/:/回复任务/);button.click();
  assert.equal(app.modal,false);assert.equal(app.chatMode,'text');assert.equal(app.opens,1);assert.deepEqual({state:app.state,composer:app.composer},before);
  assert.equal(app.document.querySelector('#composer').value,'Keep my unsent draft');assert.equal(app.document.querySelector('[data-ordinary-reply]').textContent,'quoted');assert.equal(app.document.querySelector('[data-attachment]').textContent,'attachment-a');
  const preview=app.document.querySelector('[data-task-reply-preview]');assert.match(preview.textContent,/Verify <project> & report/);assert.equal(preview.querySelector('project'),null);assert.match(preview.textContent,language==='en'?/Replying to task/:/正在回复任务/);
  assert.deepEqual(app.controller.prepare(),{workId:'work-a',turnId:'turn-a',conversationId:'conversation-a'});assert.equal(app.state.active.workId,'live-other');assert.equal(app.state.call.id,'call-a');
  app.document.querySelector('[data-task-reply-cancel]').click();assert.equal(app.controller.selected,false);assert.equal(app.controller.prepare(),null);assert.deepEqual(app.composer,before.composer);assert.equal(app.document.querySelector('[data-task-reply-preview]'),null);
 }
});

test('waiting, continuing and paused records may be targeted only when ended and authoritatively confirmed',()=>{
 for(const status of ['waiting_user','continuing','paused']){const app=fixture({status}),item=app.getModel().items.find(item=>item.id==='work-a');assert.equal(item.canReply,true,status);assert.equal(app.controller.select(item.replyTarget),true);}
 for(const change of ['noEnd','running','review','completed','cancelled','unknown','submitting','dispatch','invalid','relatedUnknown','workUnknown','offline','cached']){
  const app=fixture(),record=app.state.workTasks[0];if(change==='noEnd')delete record.executionEndedAt;else if(['running','review','completed','cancelled'].includes(change))record.status=change;else if(change==='unknown')record.unknownOutcome=true;else if(change==='submitting')record.submission='submitting';else if(change==='dispatch')record.continuation={dispatch:{phase:'submitting'}};else if(change==='invalid')record.continuation={invalid:true};else if(change==='relatedUnknown')app.state.messages.push({id:'uncertain',role:'user',turnId:record.turnId,submission:'unknown'});else if(change==='workUnknown')app.state.messages.push({id:'uncertain',role:'user',workId:record.id,submission:'unknown'});else if(change==='offline')app.state.worker.status='offline';else app.state.controller.cached=true;
  assert.equal(app.getModel().items.find(item=>item.id==='work-a').canReply,false,change);assert.equal(app.controller.select({workId:'work-a',turnId:'turn-a',conversationId:'conversation-a'}),false,change);assert.equal(app.controller.selected,false);
 }
});

test('stale card controls and changed conversation identities never switch the reply target to another task',()=>{
 for(const change of ['turn','conversation','dismissed','removed','cancelled']){
  const app=fixture(),old=app.document.querySelector('[data-task-work-reply="work-a"]');
  if(change==='turn')app.state.workTasks[0].turnId='new-turn';else if(change==='conversation')app.state.conversationId='conversation-b';else if(change==='dismissed')app.state.workTasks[0].progressDismissedAt=2000;else if(change==='removed')app.state.workTasks.shift();else app.state.workTasks[0].status='cancelled';
  old.click();assert.equal(app.controller.selected,false,change);assert.equal(app.opens,0);assert.match(app.toasts.at(-1),/changed|no longer/);
 }
 const app=fixture();assert.equal(app.controller.select({workId:'work-a',turnId:'turn-b',conversationId:'conversation-a'}),false);assert.equal(app.controller.select({workId:'work-a',turnId:'turn-a',conversationId:'other'}),false);assert.equal(app.controller.select({workId:'work-a',turnId:'turn-a\n',conversationId:'conversation-a'}),false);
});

test('a selected task that changes is blocked before sending while its target and draft remain visible',()=>{
 for(const change of ['turn','cancelled','offline','removed'])for(const language of ['en','zh']){
  const app=fixture({language});app.document.querySelector('[data-task-work-reply="work-a"]').click();const before=app.controller.target;
  if(change==='turn')app.state.workTasks[0].turnId='new-turn';else if(change==='cancelled')app.state.workTasks[0].status='cancelled';else if(change==='offline')app.state.controller.cached=true;else app.state.workTasks.shift();
  assert.throws(()=>app.controller.prepare(),error=>error.code==='task_reply_changed'&&new RegExp(language==='en'?'draft has been kept':'草稿已保留').test(error.message));assert.deepEqual(app.controller.target,before);app.render();
  assert.ok(app.document.querySelector('.task-reply-warning'));assert.equal(app.document.querySelector('#composer').value,'Keep my unsent draft');assert.equal(app.composer.replyTo,'quoted');
 }
});

test('pending sends prevent cancellation or retargeting and acknowledgements clear only the exact sent target',()=>{
 const app=fixture();app.document.querySelector('[data-task-work-reply="work-a"]').click();const target=app.controller.prepare();target.turnId='client-mutated';assert.equal(app.controller.target.turnId,'turn-a');
 app.controller.setPending(true);app.render();assert.equal(app.controller.pending,true);assert.equal(app.document.querySelector('[data-task-reply-cancel]').disabled,true);assert.equal(app.controller.cancel(),false);assert.equal(app.controller.select({workId:'work-b',turnId:'turn-b',conversationId:'conversation-a'}),false);assert.equal(app.controller.target.workId,'work-a');
 assert.equal(app.controller.acknowledged(target),false);assert.equal(app.controller.selected,true);assert.equal(app.controller.acknowledged({workId:'work-a',turnId:'turn-a',conversationId:'conversation-a'}),true);assert.equal(app.controller.selected,false);app.controller.setPending(false);assert.equal(app.controller.pending,false);
 app.controller.select({workId:'work-b',turnId:'turn-b',conversationId:'conversation-a'});assert.equal(app.controller.acknowledged({workId:'work-a',turnId:'turn-a',conversationId:'conversation-a'}),false);assert.equal(app.controller.target.workId,'work-b');
});

test('sent task reply references use explicit metadata and stable task title without confusing ordinary quoted-message replies',()=>{
 const app=fixture(),message={role:'user',workId:'work-a',replyTo:'quoted',workReply:{workId:'work-a',turnId:'turn-a',conversationId:'conversation-a'}};
 let html=app.controller.renderMessageReference(message);assert.match(html,/Reply to task/);assert.match(html,/Verify &lt;project&gt; &amp; report/);assert.doesNotMatch(html,/Ordinary message quote/);
 app.state.workTasks[0].turnId='later-turn';app.state.workTasks[0].status='running';app.state.active={workId:'work-a',turnId:'later-turn',status:'running'};html=app.controller.renderMessageReference(message);assert.match(html,/Verify &lt;project&gt;/,'an already-sent historical turn reference keeps the current task title');
 app.state.workTasks[0].progressDismissedAt=2000;html=app.controller.renderMessageReference(message);assert.match(html,/<span>Task<\/span>/);assert.doesNotMatch(html,/Verify/);
 assert.equal(app.controller.renderMessageReference({...message,workReply:undefined}),'');assert.equal(app.controller.renderMessageReference({...message,role:'assistant'}),'');assert.equal(app.controller.renderMessageReference({...message,workReply:{...message.workReply,conversationId:'other'}}),'');assert.equal(app.controller.renderMessageReference({...message,workReply:{workId:'work-a'}}),'');
});

test('restored draft targets stay explicit even after another conversation or task turn replaces them',()=>{
 for(const change of ['unchanged','turn','conversation','removed']){
  const app=fixture(),target={workId:'work-a',turnId:'turn-a',conversationId:'conversation-a'};
  if(change==='turn')app.state.workTasks[0].turnId='new-turn';else if(change==='conversation')app.state.conversationId='another-conversation';else if(change==='removed')app.state.workTasks.shift();
  assert.equal(app.controller.restore(target),true);assert.deepEqual(app.controller.target,target);assert.equal(app.opens,0);assert.equal(app.modal,true);assert.equal(app.composer.draft,'Keep my unsent draft');
  if(change==='unchanged'){assert.deepEqual(app.controller.prepare(),target);assert.doesNotMatch(app.controller.render(),/task-reply-warning/);}else{assert.throws(()=>app.controller.prepare(),{code:'task_reply_changed'});assert.match(app.controller.render(),/task-reply-warning/);assert.deepEqual(app.controller.target,target);}
 }
 const app=fixture();assert.equal(app.controller.restore({workId:'work-a'}),false);assert.equal(app.controller.selected,false);app.controller.setPending(true);assert.equal(app.controller.restore({workId:'work-a',turnId:'turn-a',conversationId:'conversation-a'}),false);
});

test('old work services without explicit reply capability cannot silently accept a targeted reply as ordinary chat',()=>{
 for(const capability of [undefined,false,'true'])for(const language of ['en','zh']){
  const app=fixture({language}),target={workId:'work-a',turnId:'turn-a',conversationId:'conversation-a'};app.state.capabilities=capability===undefined?undefined:{workReply:capability};app.render();
  const button=app.document.querySelector('[data-task-work-reply="work-a"]');assert.equal(button.disabled,true);assert.match(button.title,language==='en'?/Update the work computer/:/更新工作电脑服务/);assert.equal(app.controller.select(target),false);assert.match(app.toasts.at(-1),language==='en'?/Update the work computer/:/更新工作电脑服务/);
  assert.equal(app.controller.restore(target),true);assert.deepEqual(app.controller.target,target);assert.throws(()=>app.controller.prepare(),error=>error.code==='task_reply_changed'&&/draft|草稿/.test(error.message));assert.match(app.controller.render(),language==='en'?/Update the work computer/:/更新工作电脑服务/);
 }
});
