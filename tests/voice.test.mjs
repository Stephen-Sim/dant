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
  send(value,callback){this.sent.push(JSON.parse(value));callback?.();}
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
  connectTimeoutMs:overrides.connectTimeoutMs||100,
  hangupTimeoutMs:100
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
 assert.deepEqual(session.tools.map(tool=>tool.name),['run_task','memory_write','send_message','send_file','end_call']);
 assert.equal(sockets[0].url,'wss://api.openai.com/v1/realtime?call_id=rtc_test');assert.equal(sockets[0].options.headers.Authorization,`Bearer ${KEY}`);
 assert.equal(voice.call.status,'active');assert.equal(JSON.stringify({state:voice.state,events}).includes(KEY),false);
 assert.ok(VOICES.includes('cedar'));assert.equal(VOICE_TOOLS.length,5);
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
