import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createMemorySettings} from '../ui/memory-settings.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const value=(conversationId='one',memory='Actual durable notes')=>({conversationId,readOnly:true,identity:{text:'Actual shared identity'},memory:{text:memory}});
function fixture(){const {document}=parseHTML('<!doctype html><html><body><main></main></body></html>');let state={conversationId:'one',mode:'vm-controller',controller:{status:'online',cached:false},settings:{vm:{host:'one',user:'dant',port:22}}},request=async()=>value();const calls=[],ui=createMemorySettings({document,getState:()=>state,request:async route=>{calls.push(route);return request(route);},onChange:render});function render(){document.querySelector('main').innerHTML=ui.render();ui.bind();}render();return {ui,document,calls,render,set state(next){state=next;},get state(){return state;},set request(next){request=next;}};}

test('memory page reads only effective persona and notes and offers no editor or mutation action',async()=>{
 const f=fixture();assert.deepEqual(f.calls,[]);f.ui.setVisible(true);await tick();assert.deepEqual(f.calls,['/memory/view']);assert.equal(f.document.querySelector('[data-memory-identity]').textContent,'Actual shared identity');assert.equal(f.document.querySelector('[data-memory-references]').textContent,'Actual durable notes');assert.equal(f.document.querySelector('textarea,input,[contenteditable]'),null);
 f.request=async()=>value('one','<script>private injected script</script>');await f.ui.load();assert.equal(f.document.querySelector('script'),null);assert.match(f.document.querySelector('[data-memory-references]').textContent,/injected script/);
});

test('different conversation or computer never receives a stale memory response',async()=>{
 const f=fixture();let finish;f.request=()=>new Promise(resolve=>finish=resolve);f.ui.setVisible(true);await tick();f.state={...f.state,conversationId:'two',settings:{vm:{host:'two',user:'dant',port:22}}};f.request=async()=>value('two','New computer notes');f.ui.setVisible(true);await tick();finish(value('one','Old computer notes'));await tick();assert.match(f.document.body.textContent,/New computer notes/);assert.doesNotMatch(f.document.body.textContent,/Old computer/);
 f.request=async()=>value('other','Forged scope');await f.ui.load();assert.doesNotMatch(f.document.body.textContent,/Forged scope/);
});

test('offline view labels its last read copy and reconnect refreshes without invented fallback notes',async()=>{
 const f=fixture();f.ui.setVisible(true);await tick();f.state.controller={status:'offline',cached:true};f.ui.setVisible(true);f.render();assert.match(f.document.body.textContent,/Last loaded copy/);assert.match(f.document.body.textContent,/Actual durable notes/);assert.equal(f.document.querySelector('[data-memory-refresh]').disabled,true);
 f.request=async()=>value('one','Reconnected current notes');f.state.controller={status:'online',cached:false};f.ui.setVisible(true);await tick();assert.match(f.document.body.textContent,/Reconnected current notes/);
 f.state={...f.state,conversationId:'three',controller:{status:'offline',cached:true}};f.ui.setVisible(true);f.render();assert.doesNotMatch(f.document.body.textContent,/Reconnected current notes/);assert.match(f.document.body.textContent,/Connect the work computer/);
});

test('memory revisions refresh a visible page and leaving it ignores late failures',async()=>{
 const f=fixture();f.ui.setVisible(true);await tick();f.state.memory='Updated snapshot';f.request=async()=>value('one','Updated durable notes');f.ui.setVisible(true);await tick();assert.match(f.document.body.textContent,/Updated durable notes/);
 let reject;f.request=()=>new Promise((resolve,no)=>reject=no);const pending=f.ui.load();f.ui.setVisible(false);reject(Error('PRIVATE_TRANSPORT_BODY'));await pending;f.render();assert.doesNotMatch(f.document.body.textContent,/PRIVATE_TRANSPORT_BODY/);
});

test('refresh keeps the current notes visible, announces loading and ignores repeated activation until the read finishes',async()=>{
 const f=fixture();f.ui.setVisible(true);await tick();let finish;f.request=()=>new Promise(resolve=>finish=resolve);
 const read=f.document.querySelector('[data-memory-refresh]').onclick(),busy=f.document.querySelector('[data-memory-refresh]');
 assert.equal(busy.disabled,true);assert.equal(busy.getAttribute('aria-busy'),'true');assert.match(busy.textContent,/Refreshing/);assert.ok(busy.querySelector('svg[aria-hidden="true"]'));
 assert.match(f.document.querySelector('[role="status"]').textContent,/Reading current memory/);assert.match(f.document.querySelector('[data-memory-references]').textContent,/Actual durable notes/);
 busy.onclick();assert.equal(f.calls.length,2);finish(value('one','Refreshed notes'));await read;
 assert.equal(f.document.querySelector('[data-memory-refresh]').disabled,false);assert.equal(f.document.querySelector('[data-memory-refresh]').getAttribute('aria-busy'),'false');assert.equal(f.document.querySelector('[role="status"]').hidden,true);assert.match(f.document.querySelector('[data-memory-references]').textContent,/Refreshed notes/);f.ui.dispose();
});
