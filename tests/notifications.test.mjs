import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NotificationHub} from '../src/notifications.mjs';

test('host notifications ignore old completions, wait for unread grace and persist acknowledgements',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-notify-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1000;
 const hub=new NotificationHub(dir,{now:()=>now});
 hub.observe({completions:[{id:'old',at:10,messageIds:['a']}],messages:[{id:'a',role:'assistant'}]});
 hub.configure(true);now=1500;
 const snapshot={conversationId:'chat',completions:[{id:'old',at:10,messageIds:['a']},{id:'new',at:1400,messageIds:['b']}],messages:[{id:'a'},{id:'b',role:'assistant',status:'completed',text:'Ready for your review.'}]};
 hub.observe(snapshot);assert.deepEqual(hub.pending(),[]);now=4501;const [notification]=hub.pending();assert.equal(notification.id,'new');assert.equal(notification.body,'Ready for your review.');
 hub.acknowledge('new');assert.deepEqual(hub.pending(),[]);const reloaded=new NotificationHub(dir,{now:()=>now});reloaded.observe(snapshot);assert.deepEqual(reloaded.pending(),[]);
});

test('viewing a completion during the grace period prevents a notification',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-notify-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1000;
 const hub=new NotificationHub(dir,{now:()=>now});hub.configure(true);now=1200;
 const snapshot={completions:[{id:'one',at:1100,messageIds:['m']}],messages:[{id:'m',read:false}]};hub.observe(snapshot);now=2000;snapshot.messages[0].read=true;hub.observe(snapshot);now=8000;assert.deepEqual(hub.pending(),[]);
});

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-preview-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const hub=new NotificationHub(dir,{now:()=>1000,graceMs:0});hub.configure(true);
 const snapshot={conversationId:'chat',completions:[{id:'result',at:1000,messageIds:['draft','delivered','files']}],messages:[]};return {dir,hub,snapshot};
}

test('notifications preview the latest delivered chat text as bounded plain text, including questions',t=>{
 const {hub,snapshot}=fixture(t);
 snapshot.messages=[{id:'draft',role:'assistant',status:'completed',text:'The earlier update.'},{id:'delivered',role:'assistant',status:'completed',text:'## Ready\n**Please enter** the [verification code](https://example.invalid) on your computer.\n\u0000\u202eI will continue after that.'},{id:'files',role:'assistant',status:'completed',attachments:[{name:'report.json'}]}];
 hub.observe(snapshot);assert.equal(hub.pending()[0].body,'Ready Please enter the verification code on your computer. I will continue after that.');
 snapshot.messages[1].text='😀'.repeat(300);hub.observe(snapshot);const body=hub.pending()[0].body;assert.equal(Array.from(body).length,240);assert.equal(body,'😀'.repeat(239)+'…');
});

test('attachment-only notifications show safe filenames and previews are not persisted',t=>{
 const {dir,hub,snapshot}=fixture(t);snapshot.messages=[{id:'files',role:'assistant',status:'completed',attachments:[{name:'C:\\private\\output_report.json'},{name:'/workspace/screenshot.png'}]}];
 hub.observe(snapshot);assert.equal(hub.pending()[0].body,'output_report.json · screenshot.png');assert.equal(fs.readFileSync(path.join(dir,'notifications.json'),'utf8').includes('output_report'),false);
 const reloaded=new NotificationHub(dir,{now:()=>1000,graceMs:0});assert.equal(reloaded.pending()[0].body,'');reloaded.observe(snapshot);assert.equal(reloaded.pending()[0].body,'output_report.json · screenshot.png');
});

test('previews never draw from prompts, streaming speech, tools, reasoning, other conversations or secret storage',t=>{
 const {hub,snapshot}=fixture(t);snapshot.completions[0].messageIds=['prompt','speech','tool','other'];snapshot.messages=[
  {id:'prompt',role:'user',status:'completed',text:'user-secret'},
  {id:'speech',role:'assistant',status:'streaming',text:'live-speech'},
  {id:'tool',role:'tool',status:'completed',text:'tool-secret'},
  {id:'other',role:'assistant',status:'completed',text:'other-secret',source:{conversationId:'another-chat'}},
  {id:'unrelated',role:'assistant',status:'completed',text:'unrelated-secret'}
 ];snapshot.memory='memory-secret';snapshot.credentials={secret:'credential-secret'};snapshot.reasoning='reasoning-secret';
 hub.observe(snapshot);assert.equal(hub.pending()[0].body,'');
 snapshot.messages.push({id:'delivered',role:'assistant',status:'completed',text:'A delivered answer.',source:{type:'voice-call',conversationId:'chat'}});snapshot.completions[0].messageIds.push('delivered');hub.observe(snapshot);assert.equal(hub.pending()[0].body,'A delivered answer.');
 snapshot.conversationId='another-chat';snapshot.messages[5].source.conversationId='another-chat';hub.observe(snapshot);assert.equal(hub.pending()[0].body,'');
});

test('preview updates follow chat edits and deletion without reading or acknowledging a completion',t=>{
 const {hub,snapshot}=fixture(t);snapshot.messages=[{id:'delivered',role:'assistant',status:'completed',text:'First answer.'}];hub.observe(snapshot);assert.equal(hub.pending()[0].body,'First answer.');
 snapshot.messages[0].text='Updated answer.';hub.observe(snapshot);assert.equal(hub.pending()[0].body,'Updated answer.');snapshot.messages=[];hub.observe(snapshot);assert.equal(hub.pending()[0].body,'');assert.equal(hub.state.records.result.readAt,undefined);assert.equal(hub.state.records.result.deliveredAt,undefined);
 hub.configure(false);assert.deepEqual(hub.pending(),[]);
});

test('streaming and quiet task updates never create alerts, while an unread delivery is eligible only once',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-notify-stream-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1000;const hub=new NotificationHub(dir,{now:()=>now});hub.configure(true);
 const snapshot={conversationId:'chat',completions:[],messages:[{id:'stream',role:'assistant',status:'streaming',text:'Working'}],active:{status:'running'},workTasks:[{id:'work',status:'continuing'}]};
 for(let count=0;count<5;count++){now+=4000;snapshot.messages[0].text+='.';hub.observe(snapshot);assert.deepEqual(hub.pending(),[]);}
 snapshot.messages[0].status='completed';snapshot.messages[0].text='The verified result is ready.';snapshot.completions.push({id:'finished',at:now,messageIds:['stream']});hub.observe(snapshot);assert.deepEqual(hub.pending(),[]);now+=3001;assert.deepEqual(hub.pending().map(item=>item.id),['finished']);hub.acknowledge('finished');
 for(let count=0;count<5;count++){now+=4000;snapshot.workTasks[0].updatedAt=now;hub.observe(snapshot);assert.deepEqual(hub.pending(),[]);}
 hub.configure(false);snapshot.messages.push({id:'question',role:'assistant',status:'completed',text:'Which result should I use?'});snapshot.completions.push({id:'needs-input',at:++now,messageIds:['question']});hub.observe(snapshot);now+=5000;assert.deepEqual(hub.pending(),[],'the same notification preference disables both banner and sound eligibility');
});
