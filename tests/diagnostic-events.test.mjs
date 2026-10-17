import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {diagnosticRoute,diagnosticRpcMethod,observeHttp,observeTasks,serviceVersion,diagnosticWorkerStatus} from '../src/diagnostic-events.mjs';

test('HTTP diagnostics retain templates and fixed reasons, never route parameters or query/body/header values',()=>{
 const entries=[],logger={log:(event,metadata)=>entries.push({event,...metadata})};let now=10;
 const middleware=observeHttp(logger,{now:()=>now});
 function request(url,status,duration=5,method='POST'){const req={originalUrl:url,method,body:{secret:'private-body'},headers:{authorization:'private-header'}},res=new EventEmitter();res.statusCode=status;let next=false;middleware(req,res,()=>next=true);assert.equal(next,true);now+=duration;res.emit('finish');}
 request('/api/credentials/private-name?token=private-query',409);request('/api/private-path/private-file',500);request('/api/messages',200);request('/api/state',200,2001,'GET');request('/api/events',200,60000,'GET');request('/assets/private.png',404);request('/api/settings',400,1,'invalid-method');
 assert.deepEqual(entries.map(entry=>[entry.route,entry.status,entry.reason]),[['/api/credentials/:id',409,'conflict'],['/api/:unknown',500,'server-error'],['/api/state',200,'slow-request'],['/api/settings',400,'request-rejected']]);
 assert.equal(entries.at(-1).method,'OTHER');assert.equal(JSON.stringify(entries).includes('private-'),false);
 for(const [url,expected]of [['/api/messages/sensitive/reaction','/api/messages/:id/reaction'],['/api/skills/sensitive','/api/skills/:name'],['/api/notifications/sensitive/ack','/api/notifications/:id/ack'],['/api/state?key=secret','/api/state']])assert.equal(diagnosticRoute(url),expected);
 assert.equal(diagnosticRpcMethod('turn/start'),'turn/start');assert.equal(diagnosticRpcMethod('secret/value'),'other');assert.equal(diagnosticWorkerStatus('unexpected private text'),'unknown');assert.equal(serviceVersion('/missing-test-project'),'unknown');
});

test('task and call diagnostics log transitions once without reading message text or replaying historical tasks',()=>{
 const entries=[],logger={log:(event,metadata)=>entries.push({event,...metadata})},store={state:{messages:[{id:'old',role:'user',status:'review',text:'historical private text'}]}},engine={call:null};const observe=observeTasks(logger,store,engine);observe();assert.deepEqual(entries,[]);
 const message={id:'new',role:'user',status:'queued',text:'new private text'};store.state.messages.push(message);observe();observe();message.status='running';engine.call={id:'call',provider:'subscription',status:'connected',sdp:'private-sdp'};observe();observe();engine.call=null;observe();
 assert.deepEqual(entries.map(entry=>entry.event),['task.status','task.status','call.status','call.closed']);assert.equal(JSON.stringify(entries).includes('private'),false);
 store.state.messages=[];observe();store.state.messages=[{id:'new',role:'user',status:'paused'}];observe();assert.equal(entries.at(-1).status,'paused');
});
