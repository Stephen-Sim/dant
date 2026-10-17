import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {createSchedules} from '../ui/schedules.js';

const now=Date.parse('2026-10-18T00:00:00Z');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const item=(id,status='pending',extra={})=>({id,status,enabled:status==='pending',text:'Task '+id,at:now+86400000,timeZone:'Asia/Kuala_Lumpur',...extra});
function fixture({items=[],online=true,language='en',zone='Asia/Kuala_Lumpur'}={}){
 const {document,Event}=parseHTML('<main id="app"></main>'),app=document.querySelector('#app'),calls=[],toasts=[],backend=structuredClone(items),state={conversationId:'conversation',settings:{language,vm:{host:'vm-one',user:'dant',port:22}},worker:{status:online?'online':'offline'},controller:{status:online?'online':'offline',cached:false},schedules:structuredClone(items)};
 let ui,wait=null,fail=null,after=null,connected=true,id=0;
 function render(){const template=document.createElement('template');template.innerHTML=ui.renderPage();for(const textarea of template.content.querySelectorAll('textarea')){const decoder=document.createElement('div');decoder.innerHTML=textarea.textContent;textarea.textContent=decoder.textContent;}reconcile(app,template.content);ui.bind();}
 async function request(route,options={}){
  const method=options.method||'GET';calls.push({route,method,...structuredClone(options)});if(wait)await wait(route,options);if(fail?.(route,options))throw Error('private server details');
  let result;
  if(method==='GET')result={items:structuredClone(backend),now:new Date(now).toISOString(),timeZone:zone};
  else if(method==='POST'){
   let created=backend.find(entry=>entry.clientRequestId===options.body.clientRequestId);
   if(!created){created=item('created-'+(++id),'pending',options.body);backend.push(created);}result=structuredClone(created);
  }else{
   const selected=backend.find(entry=>entry.id===decodeURIComponent(route.split('/').at(-1)));assert.ok(selected,'Unexpected schedule ID');
   if(method==='DELETE'){backend.splice(backend.indexOf(selected),1);result={deleted:true,id:selected.id};}
   else{Object.assign(selected,options.body);if(Object.hasOwn(options.body,'enabled'))selected.status=options.body.enabled?'pending':'paused';result=structuredClone(selected);}
  }
  if(after)await after(route,options,result);return result;
 }
 ui=createSchedules({getState:()=>state,request,render,document,toast:message=>toasts.push(message),connected:()=>connected,now:()=>now,timeZone:()=>zone,getID:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`});render();
 return {ui,document,state,backend,calls,toasts,render,set wait(value){wait=value;},set fail(value){fail=value;},set after(value){after=value;},set connected(value){connected=value;},node:selector=>document.querySelector(selector),async click(selector){const node=document.querySelector(selector);assert.ok(node,'Missing '+selector);await node.onclick?.({preventDefault(){}});},input(name,value){const node=document.querySelector(`[name="${name}"]`);assert.ok(node,'Missing input '+name);node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));return node;},async submit(){const form=document.querySelector('[data-schedule-editor]');assert.ok(form);await form.onsubmit({preventDefault(){}});}};
}
async function draft(f,text='Check the project',at='2026-10-19T09:30'){await f.click('[data-schedule-add]');f.input('text',text);f.input('at',at);}

test('schedule creation sends a stable request ID and the displayed time zone, then closes only after confirmation',async()=>{
 const f=fixture();await draft(f,'  Check <project>  ');const pause=deferred();f.wait=(route,options)=>options.method==='POST'?pause.promise:undefined;
 const pending=f.submit();assert.ok(f.node('[data-schedule-editor]'));assert.equal(f.node('[type="submit"]').disabled,true);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{text:'Check <project>',at:Date.parse('2026-10-19T01:30:00Z'),timeZone:'Asia/Kuala_Lumpur',clientRequestId:'00000000-0000-4000-8000-000000000001'});
 pause.resolve();await pending;assert.equal(f.node('[data-schedule-editor]'),null);assert.deepEqual(f.calls.map(call=>call.method),['POST','GET']);assert.equal(f.state.schedules.length,1);assert.equal(f.node('project'),null);assert.match(f.node('.schedule-card-text').textContent,/<project>/);
});

test('a lost create acknowledgement retries the original ID and payload before applying edited draft content',async()=>{
 const f=fixture();await draft(f);let lost=true;f.after=(route,options)=>{if(options.method==='POST'&&lost){lost=false;throw Error('Connection lost');}};await f.submit();assert.ok(f.node('[data-schedule-editor]'));assert.equal(f.backend.length,1);assert.equal(f.toasts.length,1);assert.doesNotMatch(f.document.toString(),/Connection lost|private server/);
 f.input('text','Updated instructions');await f.submit();const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(f.backend.length,1);assert.equal(f.backend[0].text,'Updated instructions');assert.deepEqual(f.calls.map(call=>call.method),['POST','POST','PATCH','GET']);assert.equal(f.node('[data-schedule-editor]'),null);
});

test('acknowledged creation with a failed list refresh keeps a draft bound to that task for safe retry',async()=>{
 const f=fixture();await draft(f);f.fail=(route,options)=>!options.method;await f.submit();assert.ok(f.node('[data-schedule-editor]'));assert.equal(f.backend.length,1);f.fail=null;await f.submit();assert.equal(f.calls.filter(call=>call.method==='POST').length,1);assert.equal(f.calls.filter(call=>call.method==='PATCH').length,1);assert.equal(f.node('[data-schedule-editor]'),null);
});

test('editing preserves the task zone and its wall time independently of the browser default zone',async()=>{
 const original=item('edit','pending',{at:Date.parse('2026-10-19T14:15:00Z'),timeZone:'America/New_York'}),f=fixture({items:[original]});await f.click('[data-schedule-edit]');assert.equal(f.node('[name="at"]').value,'2026-10-19T10:15');assert.match(f.node('.schedule-editor-time').textContent,/America\/New_York/);f.input('text','Edited task');await f.submit();assert.equal(f.calls[0].method,'PATCH');assert.deepEqual(f.calls[0].body,{text:'Edited task',at:original.at,timeZone:'America/New_York'});assert.equal(f.backend[0].text,'Edited task');
});

test('unsaved live draft values survive state updates, refresh and another task pause or removal',async()=>{
 const f=fixture({items:[item('other')]});await draft(f,'Keep my <draft>');const textarea=f.node('[name="text"]');textarea.value='Unsaved live value';f.state.schedules.push(item('streamed'));f.render();assert.equal(f.node('[name="text"]'),textarea);assert.equal(textarea.value,'Unsaved live value');
 await f.click('[data-schedules-refresh]');assert.deepEqual(f.calls.map(call=>call.method),['GET']);assert.equal(f.node('[name="text"]').value,'Unsaved live value');await f.click('[data-schedule-toggle="other"]');assert.equal(f.backend[0].status,'paused');assert.equal(f.node('[name="text"]').value,'Unsaved live value');await f.click('[data-schedule-filter="paused"]');await f.click('[data-schedule-remove="other"]');assert.equal(f.backend.length,0);assert.equal(f.node('[name="text"]').value,'Unsaved live value');assert.equal(f.node('[name="at"]').value,'2026-10-19T09:30');
});

test('pause, resume, edit and delete use local endpoints without navigation',async()=>{
 const f=fixture({items:[item('one/id')]});await f.click('[data-schedule-toggle]');assert.deepEqual(f.calls[0],{route:'/schedules/one%2Fid',method:'PATCH',body:{enabled:false}});await f.click('[data-schedule-filter="paused"]');await f.click('[data-schedule-toggle]');assert.equal(f.backend[0].status,'pending');await f.click('[data-schedule-filter="upcoming"]');await f.click('[data-schedule-edit]');await f.click('[data-schedule-remove]');assert.equal(f.node('[data-schedule-editor]'),null);assert.equal(f.backend.length,0);assert.ok(f.calls.every(call=>call.route.startsWith('/schedules')));assert.equal(f.document.querySelector('a'),null);
});

test('expired paused work asks for a future date without overwriting an existing draft',async()=>{
 const f=fixture({items:[item('expired','paused',{at:now-1})]});await f.click('[data-schedule-filter="paused"]');await f.click('[data-schedule-toggle]');assert.equal(f.node('[name="at"]').value,'');assert.match(f.node('.schedule-editor').textContent,/future/);await f.click('[data-schedule-cancel]');await draft(f,'My separate task');await f.click('[data-schedule-toggle]');assert.equal(f.node('[name="text"]').value,'My separate task');assert.equal(f.calls.length,0);
});

test('filters, normalized search and safe malformed-date rendering work in both languages',async()=>{
 for(const language of ['en','zh']){
  const f=fixture({language,items:[item('one','pending',{text:'ＰＲＯＪＥＣＴ <script>alert(1)</script>'}),item('two','paused'),item('three','dispatched',{at:'bad-date'}),item('four','unknown')]});assert.equal(f.document.querySelectorAll('.schedule-card').length,1);await f.click('[data-schedule-filter="all"]');assert.equal(f.document.querySelectorAll('.schedule-card').length,4);assert.equal(f.document.querySelector('script'),null);assert.equal(f.node('[data-key="schedule-three"] time').getAttribute('datetime'),'');
  const search=f.node('#schedules-search');search.value='project';search.oninput();assert.equal(f.document.querySelectorAll('.schedule-card').length,1);search.value='';search.oninput();await f.click('[data-schedule-filter="history"]');assert.equal(f.document.querySelectorAll('.schedule-card').length,2);assert.equal(f.document.querySelectorAll('[data-schedule-edit]').length,0);
 }
});

test('invalid, past and nonexistent daylight-saving times fail before dispatch and preserve the draft',async()=>{
 const f=fixture({zone:'America/New_York'});await draft(f,'','invalid');await f.submit();assert.match(f.node('.error').textContent,/Describe/);f.input('text','Task');for(const value of ['invalid','2026-02-30T12:00','2026-10-17T09:00','2027-03-14T02:30']){f.input('at',value);await f.submit();assert.match(f.node('.error').textContent,/future/);assert.equal(f.node('[name="text"]').value,'Task');}assert.equal(f.calls.length,0);
});

test('offline, cached and disconnected states disable mutations but preserve an editable draft',async()=>{
 for(const mode of ['worker','controller','cached','disconnected']){
  const f=fixture({items:[item('one')]});await draft(f);if(mode==='worker')f.state.worker.status='offline';if(mode==='controller')f.state.controller.status='offline';if(mode==='cached')f.state.controller.cached=true;if(mode==='disconnected')f.connected=false;f.render();assert.equal(f.node('[data-schedule-add]').disabled,true);assert.equal(f.node('[type="submit"]').disabled,true);assert.ok(f.node('.skills-page-notice'));await f.submit();await f.click('[data-schedule-toggle]');await f.click('[data-schedules-refresh]');assert.equal(f.calls.length,0);assert.equal(f.node('[name="text"]').value,'Check the project');
 }
});

test('stale refresh responses and captured old controls cannot change another VM scope',async()=>{
 const f=fixture({items:[item('old')]});const oldControl=f.node('[data-schedule-toggle]'),wait=deferred();f.wait=()=>wait.promise;const pending=f.click('[data-schedules-refresh]');f.state.settings.vm.host='vm-two';f.state.schedules=[item('new')];f.render();await oldControl.onclick();wait.resolve();await pending;assert.deepEqual(f.state.schedules.map(entry=>entry.id),['new']);assert.equal(f.calls.length,1);assert.equal(f.node('[data-schedules-refresh]').disabled,false);
});

test('a stale save acknowledgement does not refresh, close the new editor, or show errors in another scope',async()=>{
 for(const reject of [false,true]){
  const f=fixture();await draft(f,'Old VM draft');const wait=deferred();f.wait=()=>wait.promise;const pending=f.submit();f.state.settings.vm.host='vm-two';f.state.schedules=[];f.render();await draft(f,'New VM draft');if(reject)wait.reject(Error('old VM failure'));else wait.resolve();await pending;assert.equal(f.node('[name="text"]').value,'New VM draft');assert.equal(f.calls.length,1);assert.equal(f.state.schedules.length,0);assert.deepEqual(f.toasts,[]);
 }
});

test('definite mutation failures retain the draft and cancellation clears only local form state',async()=>{
 const f=fixture({items:[item('one')]});await f.click('[data-schedule-edit]');f.input('text','Keep this edit');f.fail=()=>true;await f.submit();assert.equal(f.node('[name="text"]').value,'Keep this edit');assert.equal(f.backend[0].text,'Task one');assert.equal(f.calls.length,1);await f.click('[data-schedule-cancel]');assert.equal(f.node('[data-schedule-editor]'),null);assert.equal(f.calls.length,1);
});
