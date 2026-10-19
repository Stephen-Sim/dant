import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {createTaskReplyController} from '../ui/task-reply.js';
import {createMessageSubmissions} from '../ui/pending.js';
import {workProgress} from '../ui/work-progress.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const target={workId:'work-a',turnId:'turn-a',conversationId:'conversation-a'};
function fixture(){
 const {document}=parseHTML('<html><body><textarea id="composer">Verification is done</textarea></body></html>'),requests=[],toasts=[];
 const state={conversationId:target.conversationId,capabilities:{workReply:true},controller:{status:'online',cached:false},worker:{status:'online'},settings:{language:'en'},messages:[],queue:[],workTasks:[{id:target.workId,turnId:target.turnId,title:'Original task',status:'waiting_user',executionEndedAt:1000,plan:{steps:[{step:'Verify result',status:'pending'}]}}],call:{id:'live-call',provider:'subscription',status:'connected'}};
 const c={document,state,sending:false,uploading:0,recording:null,recordStarting:false,recordDraft:null,updateInstalling:false,eventConnected:true,callStops:{pending:false},attachments:[{id:'draft-file'}],replyTo:'quoted-message',composerDraft:'Verification is done',render(){},toast:value=>toasts.push(value),t:key=>key,progressExpanded:false,openModal(){},messageSubmissions:createMessageSubmissions({newId:()=> '11111111-1111-4111-8111-111111111111'}),api:async()=>state,post:async(route,body)=>{requests.push({route,body:structuredClone(body)});return {id:'saved',clientMessageId:body.clientMessageId,submission:'confirmed'};}};
 c.taskReplies=createTaskReplyController({document,getModel:()=>workProgress(state),getLanguage:()=> 'en',isPending:()=>c.sending||Boolean(c.messageSubmissions.unknown)});assert.equal(c.taskReplies.select(target),true);
 vm.createContext(c);vm.runInContext(section('function clearSentDraft(','async function send(confirmResend=false){')+section('async function send(confirmResend=false){','async function upload('),c);
 return {c,state,requests,toasts,input:document.querySelector('#composer')};
}

test('the actual chat Send binds task, quote and attachments through messages even during a subscription call',async()=>{
 const {c,state,requests,input}=fixture();await c.send();assert.equal(requests.length,1);assert.equal(requests[0].route,'/messages');assert.deepEqual(requests[0].body.workReply,target);assert.equal(requests[0].body.replyTo,'quoted-message');assert.deepEqual(requests[0].body.attachments,['draft-file']);assert.equal(state.call.id,'live-call');assert.equal(c.taskReplies.selected,false);assert.equal(input.value,'');assert.equal(c.attachments.length,0);assert.equal(c.replyTo,null);
});

test('stale target or definitive rejection never turns a task reply into ordinary chat or clears its draft',async()=>{
 const {c,state,requests,input}=fixture();state.workTasks[0].turnId='another-turn';await assert.rejects(c.send(),/task has changed/);assert.equal(requests.length,0);assert.equal(input.value,'Verification is done');assert.equal(c.taskReplies.selected,true);
 state.workTasks[0].turnId=target.turnId;c.post=async()=>{throw Object.assign(Error('stale'),{status:409});};await assert.rejects(c.send(),/stale/);assert.deepEqual(c.taskReplies.target,target);assert.equal(c.attachments.length,1);assert.equal(c.sending,false);assert.equal(c.taskReplies.pending,false);
});

test('an ambiguous task reply stays bound until its exact saved message is found',async()=>{
 const {c,state,requests,input}=fixture();c.post=async(route,body)=>{requests.push({route,body:structuredClone(body)});throw Object.assign(Error('lost acknowledgement'),{unknownOutcome:true});};await assert.rejects(c.send(),/sendUnknownHint/);assert.deepEqual(c.messageSubmissions.unknown.workReply,target);assert.equal(c.taskReplies.selected,true);await c.send();assert.equal(requests.length,1,'default Send cannot resend an ambiguous message');
 state.messages.push({id:'saved',role:'user',clientMessageId:requests[0].body.clientMessageId,workReply:{...target}});await c.checkUnconfirmedMessage();assert.equal(c.messageSubmissions.unknown,null);assert.equal(c.taskReplies.selected,false);assert.equal(input.value,'');
});

test('typing a follow-up while sending preserves the new text and its task target after the acknowledgement',async()=>{
 const {c,input}=fixture();let acknowledge;c.post=async()=>new Promise(resolve=>acknowledge=resolve);const pending=c.send();input.value='Also check the second result';acknowledge({id:'saved',submission:'confirmed'});await pending;assert.equal(input.value,'Also check the second result');assert.deepEqual(c.taskReplies.target,target);assert.equal(c.taskReplies.pending,false);
});
