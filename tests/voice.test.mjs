import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Voice,VOICES,VOICE_TOOLS,DEFAULT_VOICE_MODEL} from '../src/voice.mjs';

const KEY='sk-proj-fake-key-for-voice-tests-only';
const SDP='v=0\r\ns=voice\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=(sdp=SDP,location='/v1/realtime/calls/rtc_test')=>new Response(sdp,{status:201,headers:{Location:location,'Content-Type':'application/sdp'}});
function harness(t,overrides={}){
 const requests=[],sockets=[],tasks=[],tools=[],events={closed:[],notices:[],changes:[]};
 class Socket extends EventEmitter{
  constructor(url,options){super();this.url=url;this.options=options;this.readyState=0;this.sent=[];this.closeCount=0;sockets.push(this);queueMicrotask(()=>{if(this.readyState!==0)return;if(overrides.socketError){this.readyState=3;this.emit('error',Error(`Transport exposed ${KEY}`));this.emit('close');}else if(!overrides.holdSocket){this.readyState=1;this.emit('open');}});}
  send(value,callback){const event=JSON.parse(value);this.sent.push(event);callback?.();overrides.onSend?.(this,event);}
  close(){this.closeCount++;this.readyState=3;queueMicrotask(()=>this.emit('close'));}
  terminate(){this.close();}
 }
 const voice=new Voice({
  getKey:overrides.getKey||(()=>KEY),
  runTask:overrides.runTask|| (async(text,context)=>{tasks.push({text,context});return {status:'completed',text:'VM task completed'};}),
  tool:overrides.tool|| (async(name,args)=>{tools.push({name,args});return {success:true};}),
  context:overrides.context|| (()=>'The current text chat is about a report.'),
  WebSocketImpl:Socket,
  fetchImpl:async(url,options)=>{requests.push({url,options});return overrides.fetchImpl?await overrides.fetchImpl(url,options):url.endsWith('/hangup')?new Response(null,{status:204}):response();},
  // Non-timeout tests must not race a busy Windows/CI event loop. The timeout
  // regression below opts into a deliberately short, explicit deadline.
  connectTimeoutMs:overrides.connectTimeoutMs||5000,
  hangupTimeoutMs:1000,contextTimeoutMs:overrides.contextTimeoutMs||5000
 });
 voice.on('closed',event=>events.closed.push(event));voice.on('notice',message=>events.notices.push(message));voice.on('change',state=>events.changes.push(state));
 t.after(()=>voice.close().catch(()=>{}));return {voice,requests,sockets,tasks,tools,events};
}
function emit(socket,event){socket.emit('message',Buffer.from(JSON.stringify(event)));}
function completed(output,status='completed'){return {type:'response.done',response:{status,output}};}
function call(name,args,id='call_tool'){return {type:'function_call',status:'completed',name,arguments:JSON.stringify(args),call_id:id};}

test('voice uses the host key only for API and sideband authentication and returns SDP alone',async t=>{
 const {voice,requests,sockets,events}=harness(t);
 assert.equal(voice.call,null);assert.equal(requests.length,0);
 assert.deepEqual(await voice.start({sdp:SDP,memory:'Prefers Chinese'}),{sdp:SDP});
 const session=JSON.parse(requests[0].options.body.get('session'));
 assert.equal(requests[0].url,'https://api.openai.com/v1/realtime/calls');assert.equal(requests[0].options.redirect,'error');
 assert.equal(requests[0].options.headers.Authorization,`Bearer ${KEY}`);assert.equal(requests[0].options.body.get('sdp'),SDP);
 assert.equal(session.model,DEFAULT_VOICE_MODEL);assert.equal(session.audio.output.voice,'marin');assert.match(session.instructions,/Prefers Chinese/);assert.match(session.instructions,/current text chat/);
 assert.deepEqual(session.tools.map(tool=>tool.name),['run_task','memory_write','send_message','react_message','credential_find','credential_get','credential_request','credential_store','skill_list','skill_get','skill_save','send_file','end_call']);
 assert.equal(sockets[0].url,'wss://api.openai.com/v1/realtime?call_id=rtc_test');assert.equal(sockets[0].options.headers.Authorization,`Bearer ${KEY}`);
 assert.equal(voice.call.status,'active');assert.equal(JSON.stringify({state:voice.state,events}).includes(KEY),false);
 assert.ok(VOICES.includes('cedar'));assert.equal(VOICE_TOOLS.length,13);
});

test('missing keys and invalid offers fail before sending requests',async t=>{
 const h=harness(t,{getKey:()=>''});await assert.rejects(h.voice.start({sdp:SDP}),/Add an OpenAI API key/);assert.equal(h.requests.length,0);assert.equal(h.voice.call,null);
 await assert.rejects(h.voice.start({sdp:'not SDP'}),/valid WebRTC/);assert.equal(h.requests.length,0);
 await assert.rejects(h.voice.start({sdp:SDP,voice:'unsupported'}),/Unsupported voice/);assert.equal(h.requests.length,0);
});

test('HTTP failures do not echo the API key or server response body',async t=>{
 const h=harness(t,{fetchImpl:async()=>new Response(JSON.stringify({error:{message:`Invalid Authorization Bearer ${KEY}`}}),{status:401})});
 let failure;try{await h.voice.start({sdp:SDP});}catch(error){failure=error;}
 assert.match(failure.message,/key was rejected/);assert.equal(JSON.stringify({error:failure.message,state:h.voice.state,events:h.events}).includes(KEY),false);
 assert.equal(h.voice.call,null);assert.equal(h.sockets.length,0);
});

test('network and WebSocket errors are sanitized even when the transport error contains headers',async t=>{
 const network=harness(t,{fetchImpl:async()=>{throw Error(`Authorization: Bearer ${KEY}`);}});
 await assert.rejects(network.voice.start({sdp:SDP}),error=>!error.message.includes(KEY)&&/could not be reached/.test(error.message));
 const socket=harness(t,{socketError:true});await assert.rejects(socket.voice.start({sdp:SDP}),/control connection failed/);
 assert.equal(socket.requests.filter(request=>request.url.endsWith('/hangup')).length,1);
 assert.equal(JSON.stringify({state:socket.voice.state,events:socket.events}).includes(KEY),false);
});

test('an invalid SDP answer is rejected and its created remote call is hung up',async t=>{
 const h=harness(t,{fetchImpl:async url=>url.endsWith('/hangup')?new Response(null,{status:204}):response('not SDP')});
 await assert.rejects(h.voice.start({sdp:SDP}),/invalid audio connection answer/);
 assert.equal(h.requests.filter(request=>request.url.endsWith('/hangup')).length,1);assert.equal(h.sockets.length,0);assert.equal(h.voice.call,null);
});

test('untrusted call locations cannot redirect the key or sideband connection',async t=>{
 const h=harness(t,{fetchImpl:async()=>response(SDP,'https://attacker.invalid/v1/realtime/calls/rtc_secret')});
 await assert.rejects(h.voice.start({sdp:SDP}),/valid call identifier/);
 assert.equal(h.requests.length,1);assert.equal(h.sockets.length,0);
});

test('completed function calls run on the coworker adapter once and return actual results',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP});const socket=h.sockets[0];
 const event=completed([call('run_task',{text:'Build the report'},'call_task'),call('memory_write',{text:'Prefers Chinese'},'call_memory'),call('send_message',{text:'Report link'},'call_message'),call('send_file',{path:'/home/dant/work/report.pdf'},'call_file')]);
 emit(socket,event);await tick();emit(socket,event);await tick();
 assert.equal(h.tasks.length,1);assert.equal(h.tasks[0].text,'Build the report');
 assert.deepEqual(h.tools.map(item=>item.name),['memory_write','send_message','send_file']);
 const outputs=socket.sent.filter(item=>item.type==='conversation.item.create');assert.equal(outputs.length,4);
 assert.deepEqual(JSON.parse(outputs.find(item=>item.item.call_id==='call_task').item.output),{status:'completed',text:'VM task completed'});
 assert.equal(socket.sent.filter(item=>item.type==='response.create').length,1);
});

test('cancelled and incomplete argument events cannot trigger VM actions',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP});const socket=h.sockets[0];
 for(const status of ['cancelled','incomplete']){
  const item=call('run_task',{text:'Must not execute'},`call_${status}`);
  emit(socket,{type:'response.function_call_arguments.done',...item,type:'response.function_call_arguments.done'});
  emit(socket,completed([item],status));
 }
 await tick();assert.equal(h.tasks.length,0);assert.equal(h.tools.length,0);assert.equal(socket.sent.length,0);
});

test('tool errors and results are redacted before being sent back to the voice model',async t=>{
 const h=harness(t,{runTask:async()=>({status:'failed',text:`Credential ${KEY}`}),tool:async()=>{throw Error(`Bad secret ${KEY}`);}});
 await h.voice.start({sdp:SDP});const socket=h.sockets[0];
 emit(socket,completed([call('run_task',{text:'Test'},'call_key'),call('memory_write',{text:'Test'},'call_error')]));await tick();
 assert.equal(JSON.stringify(socket.sent).includes(KEY),false);assert.match(JSON.stringify(socket.sent),/redacted/);
 assert.equal(JSON.parse(socket.sent.find(item=>item.item?.call_id==='call_error').item.output).success,false);
});

test('end_call sends its result before hanging up and does not invoke Engine end_call recursively',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP});const socket=h.sockets[0];
 emit(socket,completed([call('end_call',{})]));await tick();
 assert.equal(h.tools.length,0);assert.deepEqual(JSON.parse(socket.sent[0].item.output),{ended:true});
 assert.equal(socket.sent.some(item=>item.type==='response.create'),false);assert.equal(h.voice.call,null);
 assert.equal(h.events.closed.length,1);assert.equal(h.events.closed[0].reason,'tool');assert.equal(h.requests.filter(item=>item.url.endsWith('/hangup')).length,1);
});

test('simultaneous and repeated stops hang up once and emit a single closed event',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP});await Promise.all([h.voice.stop(),h.voice.stop()]);await h.voice.stop();
 assert.equal(h.requests.filter(item=>item.url.endsWith('/hangup')).length,1);assert.equal(h.events.closed.length,1);assert.equal(h.sockets[0].closeCount,1);assert.equal(h.voice.call,null);
});

test('cancellation during call creation never revives a call and cleans up a late creation response',async t=>{
 let resolveCreate;const h=harness(t,{fetchImpl:async url=>url.endsWith('/hangup')?new Response(null,{status:204}):new Promise(resolve=>resolveCreate=resolve)});
 const start=h.voice.start({sdp:SDP});const rejected=assert.rejects(start,/cancelled/);await tick();await h.voice.stop();resolveCreate(response());await rejected;
 assert.equal(h.voice.call,null);assert.equal(h.events.closed.length,1);assert.equal(h.sockets.length,0);assert.equal(h.requests.filter(item=>item.url.endsWith('/hangup')).length,1);
});

test('closing during sideband setup cancels the handshake and reclaims the remote call',async t=>{
 const h=harness(t,{holdSocket:true});const start=h.voice.start({sdp:SDP});const rejected=assert.rejects(start,/cancelled/);await tick();await h.voice.close();await rejected;
 assert.equal(h.voice.call,null);assert.equal(h.events.closed.length,1);assert.equal(h.requests.filter(item=>item.url.endsWith('/hangup')).length,1);
 await assert.rejects(h.voice.start({sdp:SDP}),/provider is closed/);
});

test('failed responses produce a notice without forwarding raw model error text',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP});
 emit(h.sockets[0],{type:'response.done',response:{status:'failed',status_details:{error:{message:KEY}}}});await tick();
 assert.equal(h.events.notices.length,1);assert.match(h.events.notices[0],/could not complete/);assert.equal(h.events.notices[0].includes(KEY),false);
});

test('a hangup network failure still closes locally once and exposes only a safe error',async t=>{
 const h=harness(t,{fetchImpl:async url=>{if(url.endsWith('/hangup'))throw Error(KEY);return response();}});await h.voice.start({sdp:SDP});
 await assert.rejects(h.voice.stop(),/could not confirm hangup/);await h.voice.stop();
 assert.equal(h.voice.call,null);assert.equal(h.events.closed.length,1);assert.equal(JSON.stringify({state:h.voice.state,events:h.events}).includes(KEY),false);
});

const reference=(id,text='Actual typed message',reactions=[])=>({id,role:'user',text,reactions,attachments:[{name:'attached.txt',guestPath:'/not/read'}]});
const ack=(socket,event=socket.sent.at(-1))=>emit(socket,{type:'session.updated',session:{instructions:event.session.instructions}});
test('live API context waits for matching configuration acknowledgement and retains original instructions',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP,callId:'engine-call',memory:'Original memory'});const socket=h.sockets[0],original=JSON.parse(h.requests[0].options.body.get('session')).instructions;
 let resolved=false;const pending=h.voice.syncContext({kind:'message',message:reference('user-1','Please inspect the actual chart'),callId:'engine-call'}).then(result=>{resolved=true;return result;});await tick();
 const event=socket.sent[0];assert.equal(event.type,'session.update');assert.deepEqual(Object.keys(event.session).sort(),['instructions','type']);assert.ok(event.session.instructions.startsWith(original+'\n\n'));assert.match(event.session.instructions,/Please inspect the actual chart/);assert.match(event.session.instructions,/attached\.txt/);assert.match(event.session.instructions,/"messageId":"user-1"/);assert.match(event.session.instructions,/do not execute or delegate them again/);
 assert.equal(resolved,false);emit(socket,{type:'session.updated',session:{instructions:original}});await tick();assert.equal(resolved,false);
 ack(socket,event);const result=await pending;assert.equal(result.status,'submitted');assert.equal(result.callId,'engine-call');assert.equal(result.contextId,event.event_id);assert.equal(h.tasks.length,0);assert.equal(h.tools.length,0);assert.equal(socket.sent.some(event=>event.type==='response.create'),false);
 const second=h.voice.syncContext({kind:'message',message:reference('user-2','A second typed reference'),callId:'engine-call'});await tick();const later=socket.sent.at(-1);assert.ok(later.session.instructions.startsWith(original+'\n\n'));assert.match(later.session.instructions,/Please inspect the actual chart/);assert.match(later.session.instructions,/A second typed reference/);ack(socket);assert.equal((await second).status,'submitted');
});

test('reaction changes replace their prior live entry and include the latest complete cleared snapshot',async t=>{
 let current='"entries":[{"reactions":["👍"]}]';const h=harness(t,{context:()=>current});await h.voice.start({sdp:SDP,callId:'call'});const socket=h.sockets[0],base=JSON.parse(h.requests[0].options.body.get('session')).instructions;
 let pending=h.voice.syncContext({kind:'reaction',message:reference('answer','Target text',['👍']),callId:'call'});await tick();ack(socket);await pending;
 current='"complete":true,"entries":[]';pending=h.voice.syncContext({kind:'reaction',message:reference('answer','Target text',[]),callId:'call'});await tick();const dynamic=socket.sent.at(-1).session.instructions.slice(base.length);assert.match(dynamic,/"reactions":\[\]/);assert.match(dynamic,/"complete":true,"entries":\[\]/);assert.doesNotMatch(dynamic,/👍/);ack(socket);assert.equal((await pending).status,'submitted');
});

test('an unacknowledged API context update becomes unknown and is never automatically resent',async t=>{
 const h=harness(t,{contextTimeoutMs:5});await h.voice.start({sdp:SDP,callId:'call'});
 assert.equal((await h.voice.syncContext({kind:'message',message:reference('first'),callId:'call'})).status,'unknown');
 assert.equal((await h.voice.syncContext({kind:'message',message:reference('second'),callId:'call'})).status,'unknown');assert.equal(h.sockets[0].sent.length,1);assert.equal(h.voice.call.status,'active');
});

test('a correlated API rejection is failed and its unsent reference does not replay in later updates',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP,callId:'call'});const socket=h.sockets[0];
 let pending=h.voice.syncContext({kind:'message',message:reference('rejected','Must not replay this rejected reference'),callId:'call'});await tick();emit(socket,{type:'error',error:{event_id:socket.sent[0].event_id,code:'invalid_value',message:KEY}});assert.equal((await pending).status,'failed');
 pending=h.voice.syncContext({kind:'message',message:reference('accepted','Accepted update'),callId:'call'});await tick();assert.doesNotMatch(socket.sent.at(-1).session.instructions,/Must not replay/);ack(socket);assert.equal((await pending).status,'submitted');assert.equal(JSON.stringify(h.events).includes(KEY),false);
});

test('pending reactions coalesce and a lost sideband marks only the dispatched update unknown',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP,callId:'call'});const socket=h.sockets[0];
 const first=h.voice.syncContext({kind:'message',message:reference('task'),callId:'call'});await tick();
 const old=h.voice.syncContext({kind:'reaction',message:reference('answer','Old reference',['👍']),callId:'call'}),latest=h.voice.syncContext({kind:'reaction',message:reference('answer','New reference',['❤️']),callId:'call'});assert.equal((await old).status,'superseded');assert.equal(socket.sent.length,1);
 ack(socket);await first;await tick();assert.equal(socket.sent.length,2);assert.match(socket.sent[1].session.instructions,/New reference/);assert.doesNotMatch(socket.sent[1].session.instructions,/Old reference/);
 const queued=h.voice.syncContext({kind:'message',message:reference('not-sent'),callId:'call'});socket.readyState=3;socket.emit('close');assert.equal((await latest).status,'unknown');assert.equal((await queued).status,'cancelled');assert.equal(socket.sent.length,2);
});

test('closing a call cancels context updates and stale acknowledgements cannot update a later call',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP,callId:'old-call'});const oldSocket=h.sockets[0],pending=h.voice.syncContext({kind:'message',message:reference('old'),callId:'old-call'});await tick();const sent=oldSocket.sent[0];await h.voice.stop();assert.equal((await pending).status,'cancelled');
 await h.voice.start({sdp:SDP,callId:'new-call'});ack(oldSocket,sent);assert.equal((await h.voice.syncContext({kind:'message',message:reference('stale'),callId:'old-call'})).status,'cancelled');assert.equal(h.sockets[1].sent.length,0);
 const current=h.voice.syncContext({kind:'message',message:reference('current'),callId:'new-call'});await tick();ack(h.sockets[1]);assert.equal((await current).status,'submitted');
});

test('live history remains bounded and local context preparation errors do not expose credentials',async t=>{
 let fail=false;const h=harness(t,{context:()=>{if(fail)throw Error(KEY);return 'Current complete reaction snapshot';},onSend:(socket,event)=>{if(event.type==='session.update')queueMicrotask(()=>ack(socket,event));}});await h.voice.start({sdp:SDP,callId:'call'});
 const base=JSON.parse(h.requests[0].options.body.get('session')).instructions;
 for(let index=0;index<20;index++)assert.equal((await h.voice.syncContext({kind:'message',message:reference('user-'+index,'Actual reference '+index+' '+'x'.repeat(3000)),callId:'call'})).status,'submitted');
 const final=h.sockets[0].sent.at(-1).session.instructions;assert.ok(Buffer.byteLength(final.slice(base.length))<33000);assert.match(final,/"messageId":"user-19"/);assert.doesNotMatch(final,/"messageId":"user-0"/);
 fail=true;const result=await h.voice.syncContext({kind:'message',message:reference('failed'),callId:'call'});assert.equal(result.status,'failed');assert.equal(JSON.stringify(result).includes(KEY),false);
});

test('API voice may explicitly set or remove a reaction through the existing tool callback',async t=>{
 const h=harness(t);await h.voice.start({sdp:SDP});const socket=h.sockets[0];
 emit(socket,completed([call('react_message',{messageId:'actual-user-id',emoji:'😆'},'reaction-set'),call('react_message',{messageId:'actual-user-id',emoji:null},'reaction-remove'),call('react_message',{messageId:'actual-user-id',emoji:'invalid text'},'reaction-invalid')]));await tick();
 assert.deepEqual(h.tools,[{name:'react_message',args:{messageId:'actual-user-id',emoji:'😆'}},{name:'react_message',args:{messageId:'actual-user-id',emoji:null}}]);assert.equal(JSON.parse(socket.sent.find(event=>event.item?.call_id==='reaction-invalid').item.output).success,false);
});

test('API credential and skill tools validate required, nullable and structured fields and carry the real call scope',async t=>{
 const received=[],h=harness(t,{tool:async(name,args,scope)=>{received.push({name,args,scope});return {saved:true};}});await h.voice.start({sdp:SDP,callId:'actual-api-session'});const socket=h.sockets[0];
 const valid=[['credential_find',{query:''}],['credential_get',{id:'actual-vault-id'}],['credential_request',{name:'Work',service:'',reason:''}],['credential_store',{name:'Work',service:'',username:'',secret:'private-test-value'}],['skill_list',{}],['skill_get',{name:'report-review'}],['skill_save',{name:'report-review',description:'Review reports',instructions:'Read and verify the report.',files:{'scripts/check.py':'print("check")'},enabled:false}]];
 for(const [index,[name,args]]of valid.entries())emit(socket,completed([call(name,args,'valid-'+index)]));await tick();assert.equal(received.length,valid.length);assert.deepEqual(received.map(item=>[item.name,item.args]),valid);
 for(const item of received){assert.equal(item.scope.callId,'actual-api-session');assert.equal(item.scope.owner,'actual-api-session');assert.equal(item.scope.isCurrent(),true);assert.equal(item.scope.signal.aborted,false);}
 const invalid=[['credential_get',{}],['credential_store',{name:'Work',service:'',username:''}],['credential_request',{name:'Work',service:'',reason:2}],['credential_find',{query:4}],['skill_get',{name:'x',extra:'forbidden'}],['skill_save',{name:'x',description:'Test',instructions:'Test',enabled:'false'}],['skill_save',{name:'x',description:'Test',instructions:'Test',files:[]}],['skill_save',{name:'x',description:'Test',instructions:'Test',files:{'scripts/check.py':false}}],['react_message',{messageId:'user'}]];
 for(const [index,[name,args]]of invalid.entries())emit(socket,completed([call(name,args,'invalid-'+index)]));await tick();assert.equal(received.length,valid.length);for(let index=0;index<invalid.length;index++)assert.equal(JSON.parse(socket.sent.find(event=>event.item?.call_id==='invalid-'+index).item.output).success,false);
 const scope=received[0].scope;await h.voice.stop();assert.equal(scope.isCurrent(),false);assert.equal(scope.signal.aborted,true);await h.voice.start({sdp:SDP,callId:'later-session'});assert.equal(scope.isCurrent(),false);
});
