import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
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
 const message={id:'new',role:'user',status:'queued',text:'new private text'};store.state.messages.push(message);observe();observe();message.status='accepted';observe();observe();assert.equal(entries.at(-1).status,'accepted');message.status='running';engine.call={id:'call',provider:'subscription',status:'connected',sdp:'private-sdp'};observe();observe();engine.call=null;observe();
 assert.deepEqual(entries.map(entry=>entry.event),['task.status','task.status','task.status','call.status','call.closed']);assert.equal(JSON.stringify(entries).includes('private'),false);
 store.state.messages=[];observe();store.state.messages=[{id:'new',role:'user',status:'paused'}];observe();assert.equal(entries.at(-1).status,'paused');
});

test('normal call startup is connecting while unknown provider states remain bounded',()=>{
 const entries=[],logger={log:(event,metadata)=>entries.push({event,...metadata})},store={state:{messages:[]}},engine={call:null},observe=observeTasks(logger,store,engine);
 engine.call={id:'call',provider:'subscription',status:'connecting'};observe();observe();
 engine.call.status='negotiating';observe();engine.call.status='connected';observe();
 engine.call.status='private unexpected status';observe();engine.call.provider='private-provider';engine.call.status='starting';observe();
 assert.deepEqual(entries.map(entry=>entry.status),['connecting','negotiating','connected','unknown','starting']);assert.equal(entries.at(-1).provider,'unknown');assert.doesNotMatch(JSON.stringify(entries),/private/);
});

test('task action diagnostics distinguish registered task routes without retaining IDs or reference queries',()=>{
 for(const action of ['accept','pause','resume','cancel','priority','dismiss','context'])assert.equal(diagnosticRoute('/api/tasks/private-task-id/'+action+'?turnId=private-turn&conversationId=private-conversation&token=private-token'),'/api/tasks/:id/'+action);
 for(const action of ['pause','resume','clear-completed'])assert.equal(diagnosticRoute('/api/tasks/'+action+'?token=private-token'),'/api/tasks/'+action);
 assert.equal(diagnosticRoute('/api/messages/private-message/output-link/resolve?token=private-token'),'/api/messages/:id/output-link/resolve');
 for(const route of ['/api/tasks/private-task/private-action','/api/tasks/private-task/context/extra','/api/tasks/private-task/contextual'])assert.equal(diagnosticRoute(route),'/api/:unknown');
});

test('an HTTP response closed before finish logs one metadata-only client abort and detaches both listeners',()=>{
 const entries=[],logger={log:(event,metadata)=>entries.push({event,...metadata})};let now=100;const middleware=observeHttp(logger,{now:()=>now}),res=new EventEmitter();res.statusCode=200;
 middleware({originalUrl:'/api/files/private-filename?token=private-query',method:'GET',body:{text:'private-body'},headers:{authorization:'private-header'}},res,()=>{});now=10421.4;res.emit('close');res.emit('finish');res.emit('close');
 assert.deepEqual(entries,[{event:'http.request',method:'GET',route:'/api/files/:id',status:499,durationMs:10321,reason:'client-aborted'}]);assert.equal(res.listenerCount('finish'),0);assert.equal(res.listenerCount('close'),0);assert.equal(JSON.stringify(entries).includes('private-'),false);
});

test('ordinary response finish suppresses a later close, including fast responses intentionally omitted from diagnostics',()=>{
 const entries=[],logger={log:(event,metadata)=>entries.push({event,...metadata})};let now=0;const middleware=observeHttp(logger,{now:()=>now});
 for(const [status,duration]of [[200,10],[503,20],[200,2500]]){const res=new EventEmitter();res.statusCode=status;middleware({url:'/api/screen',method:'GET'},res,()=>{});now+=duration;res.emit('finish');res.emit('close');assert.equal(res.listenerCount('close'),0);}
 assert.deepEqual(entries.map(entry=>[entry.status,entry.reason,entry.durationMs]),[[503,'server-error',20],[200,'slow-request',2500]]);
});

test('an actual client disconnect while a desktop response is pending records 499 without payload or URL parameters',async t=>{
 const entries=[],middleware=observeHttp({log:(event,metadata)=>entries.push({event,...metadata})});let entered,closed;const pending=new Promise(resolve=>entered=resolve),disconnected=new Promise(resolve=>closed=resolve),server=http.createServer((req,res)=>middleware(req,res,()=>{res.once('close',closed);entered();}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/screen?token=private-query',headers:{Authorization:'private-header'},method:'GET'});request.on('error',()=>{});request.end();await pending;request.destroy();await disconnected;
 assert.equal(entries.length,1);assert.equal(entries[0].status,499);assert.equal(entries[0].reason,'client-aborted');assert.equal(entries[0].route,'/api/screen');assert.ok(entries[0].durationMs>=0);assert.equal(JSON.stringify(entries).includes('private-'),false);
});
