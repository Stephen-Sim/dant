import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readableError} from './errors.mjs';
import {buildCallContext,LiveContextQueue} from './call-context.mjs';

export const NATIVE_REALTIME_MODEL='gpt-live-1-codex';
export const DEFAULT_NATIVE_VOICE='ember';
export const NATIVE_VOICES=Object.freeze(['juniper','maple','spruce','ember','vale','breeze','arbor','sol','cove','aube','bubbie','haetsal','hanul','himari','leher','miko','neer','porto','rindo','rio','rivage','selva','sonna','tinta','viola']);
const turnIdOf=event=>event.params?.turnId||event.params?.turn?.id;
const validSdp=sdp=>typeof sdp==='string'&&sdp.length<=200000&&/^v=0\r?\n/.test(sdp)&&/^m=audio /m.test(sdp);
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject};}
async function within(promise,ms,message){let timer;try{return await Promise.race([promise,new Promise((resolve,reject)=>timer=setTimeout(()=>reject(Error(message)),ms))]);}finally{clearTimeout(timer);}}
function finalLinks(text,alreadySent=''){
 const found=new Map();
 for(const match of text.matchAll(/https?:\/\/[^\s<>"'`\)\]]+/g)){
  const raw=match[0].replace(/[.,;!?]+$/,'');let url;try{url=new URL(raw);}catch{continue;}
  if(!url.hostname||url.username||url.password||raw.length>8192||/[?&#](?:[^=&]*(?:token|secret|password|authorization|api[_-]?key|signature)[^=&]*)=/i.test(raw)||alreadySent.includes(raw))continue;
  found.set(raw,raw);if(found.size>=10)break;
 }
 return [...found.values()].join('\n');
}

/** Subscription transport on the existing VM Codex process. Speech stays ephemeral. */
export class NativeRealtimeVoice extends EventEmitter {
 constructor({worker,engine,terminateExecutor,connectTimeoutMs=20000,stopTimeoutMs=10000,contextTimeoutMs=5000}={}){
  super();if(!worker||!engine)throw Error('Native voice requires the VM executor and conversation engine');
  this.worker=worker;this.engine=engine;this.terminateExecutor=terminateExecutor||(()=>worker.terminateConfirmed());this.connectTimeoutMs=connectTimeoutMs;this.stopTimeoutMs=stopTimeoutMs;
  this.session=null;this.error=null;this.contextTimeoutMs=contextTimeoutMs;this.voices=[...NATIVE_VOICES];engine.nativeVoice=this;
  const settings=engine.store.state.settings,selected=settings.nativeVoice||settings.voice;
  const nativeVoice=this.voices.includes(selected)?selected:DEFAULT_NATIVE_VOICE;
  if(settings.voice!==nativeVoice||settings.nativeVoice!==nativeVoice||!settings.apiVoice){settings.voice=settings.nativeVoice=nativeVoice;settings.apiVoice ||= 'marin';engine.store.save();}
 }
 get call(){const s=this.session;return s?{callId:s.id,provider:'subscription',model:NATIVE_REALTIME_MODEL,version:'v3',voice:s.voice,status:s.status,connectedAt:s.connectedAt||null}:null;}
 get active(){
  const s=this.session;if(!s)return null;const turn=[...s.turns.values()].find(turn=>!turn.done);
  if(turn||s.submitting||s.unknown)return {messageId:turn?.messageId||s.submitting?.message.id||null,turnId:turn?.turnId||null,source:'voice',status:s.unknown?'unknown':s.pausing?'pausing':'running'};
  return null;
 }
 get state(){return {call:this.call,error:this.error,available:this.worker.status==='online',version:'v3',model:NATIVE_REALTIME_MODEL};}
 change(){if(this.session&&this.engine.call?.id===this.session.id)this.engine.call.status=this.session.status;this.emit('change',this.state);this.engine.change();}
 async listVoices(){
  const result=await this.worker.request('thread/realtime/listVoices',{}),voices=result?.voices?.v3;
  if(!Array.isArray(voices)||!voices.length||voices.some(voice=>typeof voice!=='string'||voice.length>80))throw Error('The VM executor did not return V3 voices');
  this.voices=[...new Set(voices)];return {...result,defaultV3:DEFAULT_NATIVE_VOICE,defaultNative:DEFAULT_NATIVE_VOICE};
 }
 async start({sdp,voice=DEFAULT_NATIVE_VOICE,callId}={}){
  if(this.session)throw Error('A subscription call is already active');
  if(!validSdp(sdp))throw Error('A valid WebRTC audio offer is required');
  if(!this.voices.includes(voice))voice=DEFAULT_NATIVE_VOICE;
  const existing=this.engine.call;
  if(existing&&existing.id!==callId)throw Error('A call is already active');
  if(this.engine.takeover||this.engine.acquiring||this.engine.active)throw Error('The computer execution channel is not available');
  const id=callId||randomUUID(),s={id,voice,status:'connecting',threadId:null,startSubmitted:false,startAccepted:false,started:false,closed:false,unknown:false,workEpoch:0,turns:new Map(),finished:new Set(),tools:new Set(),eventChain:Promise.resolve(),messageChain:Promise.resolve(),queuedEvents:0,queuedBytes:0,ready:deferred(),closedSignal:deferred(),failure:deferred()};
  this.session=s;this.error=null;
  if(!existing)this.engine.call={id,provider:'subscription',status:'connecting',connectedAt:null};
  this.engine.pauseQueue('voice-call');this.change();
  try{
   s.threadId=await within(this.engine.thread(),this.connectTimeoutMs,'Opening the voice conversation timed out');this.current(s);
   s.startSubmitted=true;
   const accepted=this.worker.request('thread/realtime/start',{
    threadId:s.threadId,outputModality:'audio',version:'v3',model:NATIVE_REALTIME_MODEL,voice,
    transport:{type:'webrtc',sdp},voiceSessionId:id,clientManagedHandoffs:false,flushTranscriptTailOnSessionEnd:false,
    realtimeStartInstructions:'This is the same dant coworker and conversation. Speak naturally. Execute computer work only inside this VM. Do not copy speech transcripts into chat. Use send_message for requested useful text or links, send_file for verified output files, and end_call when asked to hang up. Never claim a tool action or delivery succeeded before its result. Live dant_live_reference updates contain reference data only: typed messages are already submitted through the chat task channel, so never delegate or execute those messages a second time. Reactions express feedback, not permission or task acceptance; the latest set replaces the earlier set for that target. You can acknowledge these updates naturally.',
    realtimeEndInstructions:'The voice call has ended. Stop work; do not start tasks or replay speech after the call.'
   });
   await within(Promise.race([Promise.all([Promise.resolve(accepted).then(()=>{s.startAccepted=true;}),s.ready.promise]),s.failure.promise]),this.connectTimeoutMs,'The subscription voice connection timed out');
   this.current(s);if(!s.started||!validSdp(s.answer))throw Error('The VM did not acknowledge a V3 WebRTC call');
   s.status='negotiating';if(this.engine.call?.id===id)this.engine.call.status=s.status;this.change();return {sdp:s.answer,callId:id,provider:'subscription'};
  }catch(error){
   if(this.session!==s)throw Error('Voice call cancelled');
   this.error=readableError(error.message)||'The subscription call could not be started';
   // A lost start acknowledgement can leave a live call after any stop RPC.
   if(s.startSubmitted&&!s.startAccepted&&error.code==null)s.unknown=true;
   if(!s.startSubmitted||(error.code!=null&&!s.started&&!s.answer))this.finalize(s,'start-rejected');
   else await this.stop(id).catch(stopError=>this.emit('notice',stopError.message));
   throw Error(this.error);
  }
 }
 current(s){if(this.session!==s||s.stopping||s.closed)throw Error('Voice call cancelled');}
 confirmConnected(callId){
  const s=this.session;if(!s||s.id!==callId)throw Error('The voice call changed');
  if(s.status!=='negotiating'&&s.status!=='connected')throw Error('The voice call is not ready');
  s.connectedAt ||= Date.now();s.status='connected';this.change();return {connected:true,callId,connectedAt:s.connectedAt};
 }
 syncContext({kind,message,callId}={}){
  const s=this.session;
  if(!s||s.id!==callId||this.engine.call?.id!==s.id||s.stopping||s.closed||!['negotiating','connected'].includes(s.status))return Promise.resolve({callId,messageId:message?.id,kind,status:'cancelled'});
  s.contextQueue ||= new LiveContextQueue({callId:s.id,timeoutMs:this.contextTimeoutMs,isCurrent:()=>this.session===s&&this.engine.call?.id===s.id&&!s.stopping&&!s.closed,send:({text})=>this.worker.request('thread/realtime/appendText',{threadId:s.threadId,text})});
  return s.contextQueue.enqueue({key:kind+':'+message.id,text:buildCallContext(kind,message),messageId:message.id,kind}).then(result=>{
   if(result.status==='superseded'||this.session!==s)return result;
   this.engine.safeUpdate(message.id,{voiceContext:result});this.change();
   if(['unknown','failed'].includes(result.status))this.emit('notice','The chat update is saved, but its delivery to the current voice call is '+(result.status==='unknown'?'unconfirmed. It will not be retried automatically.':'unavailable.'));
   return result;
  });
 }
 message({clientMessageId,text,replyTo=null,attachments=[],callId}={}){
  const s=this.session;
  if(!s||s.id!==this.engine.call?.id||(callId!==undefined&&callId!==s.id)||!['negotiating','connected'].includes(s.status))return Promise.reject(Error('The subscription call is not ready'));
  if(typeof clientMessageId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(clientMessageId))return Promise.reject(Error('A stable client message identifier is required'));
  if(this.engine.store.state.deletedClientMessageIds?.includes(clientMessageId))return Promise.reject(Error('This message was withdrawn or deleted. Send a new message to start new work.'));
  if(typeof text!=='string'||!text.trim()||text.length>100000||!Array.isArray(attachments)||attachments.length)return Promise.reject(Error('During a subscription call send text only, up to 100000 characters'));
  if(replyTo&&!this.engine.task(replyTo))return Promise.reject(Error('The referenced message is not in this conversation'));
  const prior=this.engine.store.state.messages.find(message=>message.role==='user'&&message.clientMessageId===clientMessageId);
  if(prior){if(prior.text!==text||prior.replyTo!==replyTo)return Promise.reject(Error('This message identifier already belongs to different content'));return Promise.resolve({message:prior,callId:s.id,turnId:prior.turnId,submission:prior.submission,duplicate:true,...(prior.submission==='unknown'?{unknownOutcome:true}:{})});}
  if(s.pausing)return Promise.reject(Error('Current voice work is pausing; send a new task after it stops'));
  if(s.unknown)return Promise.reject(Error('A voice task handoff is unconfirmed. End the call before sending another task'));
  const message=this.engine.store.add({role:'user',text,replyTo,attachments:[],clientMessageId,voiceCallId:s.id,status:'queued',submission:'preparing'});this.change();
  // One ordinary task submission remains authoritative; the voice notice is reference only.
  const context=this.syncContext({kind:'message',message,callId:s.id});
  const epoch=s.workEpoch,operation=s.messageChain.then(()=>this.submitMessage(s,message,epoch));s.messageChain=operation.catch(()=>{});return operation.then(async result=>({...result,voiceContext:await context}));
 }
 workCurrent(s,epoch){this.current(s);if(s.pausing||epoch!==s.workEpoch)throw Error('This task was paused before submission');}
 async submitMessage(s,message,epoch){
  let turn,submitted=false;
  try{
   this.workCurrent(s,epoch);await s.eventChain;this.workCurrent(s,epoch);if(s.unknown)throw Error('A voice task handoff is unconfirmed');
   let active=[...s.turns.values()].filter(turn=>!turn.done);if(active.length>1){s.unknown=true;throw Error('The active voice task is ambiguous');}
   if(!active.length){
    const baseline=await this.engine.deliverables?.captureBaseline?.({outputDir:this.engine.outputDir,workspace:this.engine.workspace,conversationId:this.engine.store.state.conversationId,messageId:message.id});
    await s.eventChain;this.workCurrent(s,epoch);if(s.unknown)throw Error('A voice task handoff is unconfirmed');active=[...s.turns.values()].filter(turn=>!turn.done);
    if(!active.length){
     if(s.turns.size>=128)throw Error('This call reached its task limit');
     const pending={message,baseline,early:[],bytes:0};s.submitting=pending;
     this.engine.store.update(message.id,{status:'running',submission:'submitting'});submitted=true;this.change();
     const result=await within(this.worker.request('turn/start',{threadId:s.threadId,input:this.engine.input(message),cwd:this.engine.workspace,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},model:this.engine.store.state.settings.model||undefined}),this.connectTimeoutMs,'The text task submission was not acknowledged');
     this.current(s);const id=result?.turn?.id;if(typeof id!=='string'||!id)throw Error('The executor did not acknowledge the text task');
     turn=this.createTurn(s,id);turn.baseline=baseline;turn.messageId=message.id;turn.explicitMessageIds.push(message.id);
     this.engine.store.update(message.id,{status:'running',submission:'confirmed',turnId:id,executorConfirmedAt:Date.now()});
     // Only the response binds the explicit task. Announced unrelated tasks remain separately owned.
     const replay=s.eventChain.then(async()=>{if(this.session!==s)return;s.submitting=null;for(const event of pending.early)await this.processEvent(s,event);});s.eventChain=replay.catch(error=>this.emit('notice',readableError(error.message)));await replay;
     this.change();return {message,callId:s.id,turnId:id,submission:'confirmed'};
    }
   }
   if(active.length!==1){s.unknown=true;throw Error('The active voice task is ambiguous');}
   turn=active[0];if(turn.done)throw Error('The active voice task changed');
   turn.pendingSubmissions++;this.engine.store.update(message.id,{status:'running',submission:'submitting',parentTaskId:turn.messageId||null});submitted=true;
   await within(this.worker.request('turn/steer',{threadId:s.threadId,expectedTurnId:turn.turnId,input:this.engine.input(message)}),this.connectTimeoutMs,'The text steering request was not acknowledged');
   this.current(s);turn.explicitMessageIds.push(message.id);turn.messageId ||= message.id;
   this.engine.store.update(message.id,{status:turn.finalStatus||'running',submission:'confirmed',turnId:turn.turnId,executorConfirmedAt:Date.now()});turn.pendingSubmissions--;await this.finishTurn(s,turn);this.change();return {message,callId:s.id,turnId:turn.turnId,submission:'confirmed'};
  }catch(error){
   const unknown=submitted&&error.code==null;if(unknown)s.unknown=true;
   if(s.submitting?.message===message)s.submitting=null;
   if(turn?.pendingSubmissions)turn.pendingSubmissions--;
   this.engine.safeUpdate(message.id,{status:unknown?'paused':submitted?'failed':'paused',submission:unknown?'unknown':submitted?'rejected':'preparing',pauseReason:unknown?'submission-unknown':'voice-task-unavailable',error:readableError(error.message)});
   this.change();const failure=Error(unknown?'The text task may have been submitted. It will not be retried automatically; end the call before resuming.':readableError(error.message));if(unknown)failure.unknownOutcome=true;throw failure;
  }
 }
 createTurn(s,id){
  const stopped=deferred(),turn={turnId:id,assistantIds:[],explicitPaths:[],explicitMessageIds:[],pendingSubmissions:0,outputs:new Map(),stopped:stopped.promise,resolveStopped:stopped.resolve,done:false};s.turns.set(id,turn);this.change();return turn;
 }
 async finishTurn(s,turn){
  if(!turn.done||turn.pendingSubmissions||turn.finalized)return;turn.finalized=true;
  try{
   if(turn.finalStatus==='review'){
    const raw=[...turn.outputs.values()].join('\n\n').slice(0,120000),text=this.engine.credentials?.redact?.(raw)??raw;
    if(turn.explicitMessageIds.length&&text.trim()&&!turn.deliveredTexts?.has(text.trim())){const message=this.engine.store.add({role:'assistant',text,status:'completed',taskId:turn.messageId});turn.assistantIds.push(message.id);}
    if(!turn.explicitMessageIds.length){const links=finalLinks(text,turn.assistantIds.map(id=>this.engine.task(id)?.text||'').join('\n'));if(links)this.engine.deliverText(links,turn);}
    if(this.engine.deliverables?.archive){try{const files=await this.engine.deliverables.archive({baseline:turn.baseline,outputDir:this.engine.outputDir,workspace:this.engine.workspace,explicitPaths:turn.explicitPaths,text,conversationId:this.engine.store.state.conversationId,messageId:turn.messageId,turnId:turn.turnId});this.engine.attach(turn,files||[]);}catch(error){this.emit('notice','Voice output could not be archived: '+readableError(error.message));}}
   }
   for(const id of turn.explicitMessageIds)this.engine.store.update(id,{status:turn.finalStatus,error:turn.error||null,pauseReason:turn.finalStatus==='paused'?'executor-stopped':null});
   if(turn.finalStatus==='review'&&turn.assistantIds.length)this.engine.store.addCompletion?.({turnId:turn.turnId,messageIds:turn.assistantIds,taskId:turn.messageId});
  }catch(error){this.emit('notice','Voice task result could not be saved: '+readableError(error.message));}
  finally{turn.outputs.clear();this.change();}
 }
 ownsEvent(event){
  const s=this.session;if(!s||!s.threadId||event.params?.threadId!==s.threadId)return false;
  return event.method?.startsWith('thread/realtime/')||event.method?.startsWith('turn/')||event.method?.startsWith('item/');
 }
 handleEvent(event){
  const s=this.session;if(!s||!this.ownsEvent(event))return Promise.resolve();
  const bytes=Buffer.byteLength(JSON.stringify(event));
  if(s.queuedEvents>=128||s.queuedBytes+bytes>1024*1024){s.unknown=true;this.engine.rejectEvent(event,'Voice notification buffer exceeded');queueMicrotask(()=>void this.stop(s.id).catch(error=>this.emit('notice',error.message)));return Promise.resolve();}
  s.queuedEvents++;s.queuedBytes+=bytes;
  // RPC notifications arrive in order, but archive/tool awaits must preserve it.
  const operation=s.eventChain.then(()=>this.processEvent(s,event)).finally(()=>{s.queuedEvents--;s.queuedBytes-=bytes;});s.eventChain=operation.catch(error=>this.emit('notice',readableError(error.message)));return operation;
 }
 async processEvent(s,event){
  if(this.session!==s)return;const p=event.params||{},id=turnIdOf(event),method=event.method;
  if(method.startsWith('thread/realtime/')){
   if(method==='thread/realtime/itemAdded'&&p.item?.type==='handoff_request')s.unknown=true;
   if(method==='thread/realtime/started'){
    if(p.version!=='v3'){s.failure.reject(Error('The VM returned an unsupported realtime version'));return;}
    s.started=true;s.realtimeSessionId=p.realtimeSessionId;
   }
   if(method==='thread/realtime/sdp'){if(!validSdp(p.sdp)){s.failure.reject(Error('The VM returned an invalid audio connection answer'));return;}s.answer=p.sdp;}
   if(s.started&&s.answer)s.ready.resolve();
   if(method==='thread/realtime/closed'){
    s.closed=true;s.closedSignal.resolve();s.failure.reject(Error('The voice connection closed before it was ready'));
    if(!s.stopping)queueMicrotask(()=>void this.stop(s.id).catch(error=>this.emit('notice',error.message)));
   }
   if(method==='thread/realtime/error'){
    const message=readableError(p.message)||'The subscription voice service failed';this.error=message;this.emit('notice',message);s.failure.reject(Error(message));
    if(s.startAccepted&&!s.stopping)queueMicrotask(()=>void this.stop(s.id).catch(error=>this.emit('notice',error.message)));
   }
   // Transcript/audio/timeline notifications are never written to chat or state.
   return;
  }
  if(id&&(s.finished.has(id)||this.engine.completedTurns.has(id))){this.engine.rejectEvent(event,'Inactive voice task');return;}
  if(s.submitting){
   const pending=s.submitting,bytes=Buffer.byteLength(JSON.stringify(event));
   if(pending.early.length>=128||pending.bytes+bytes>1024*1024){s.unknown=true;this.engine.rejectEvent(event,'Early text task notification buffer exceeded');return;}
   pending.early.push(event);pending.bytes+=bytes;return;
  }
  if(method==='turn/started'&&id){
   if(s.turns.has(id))return;
   if(s.turns.size>=128){s.unknown=true;this.engine.rejectEvent(event,'Voice task limit reached');return;}
   if(s.stopping||s.closed||[...s.turns.values()].some(turn=>!turn.done))s.unknown=true;
   const turn=this.createTurn(s,id);
   try{turn.baseline=await this.engine.deliverables?.captureBaseline?.({outputDir:this.engine.outputDir,workspace:this.engine.workspace,conversationId:this.engine.store.state.conversationId,turnId:id});}
   catch(error){s.unknown=true;this.emit('notice','Voice output baseline could not be captured: '+readableError(error.message));}
   return;
  }
  const turn=id&&s.turns.get(id);
  if(!turn||turn.done){s.unknown=true;this.engine.rejectEvent(event,'No accepted voice background task');return;}
  if(event.id!==undefined){
   if(method!=='item/tool/call'){this.engine.rejectEvent(event,'Unsupported voice background request');return;}
   // A duplicate RPC request cannot execute side effects twice.
   const identity=String(p.callId||event.id);if(s.tools.has(identity)){this.engine.rejectEvent(event,'Duplicate voice tool call');return;}
   if(s.tools.size>=1000){s.unknown=true;this.engine.rejectEvent(event,'Voice tool limit reached');return;}s.tools.add(identity);
   try{
    if(s.stopping||turn.pauseRequested)throw Error('The voice task is stopping');
    const args=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('Invalid voice tool arguments');
    const result=await this.tool(s,turn,p.tool,args);
    this.worker.rpc.reply(event.id,{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]});
    if(p.tool==='end_call')queueMicrotask(()=>void this.engine.stopCall(s.id).catch(error=>this.emit('notice',error.message)));
   }catch(error){this.worker.rpc.reply(event.id,{success:false,contentItems:[{type:'inputText',text:readableError(error.message)}]});}return;
  }
  if(method==='item/agentMessage/delta'){
   if(turn.outputs.size<128||turn.outputs.has(p.itemId)){const previous=turn.outputs.get(p.itemId)||'',remaining=Math.max(0,120000-(turn.outputChars||0)),text=previous+String(p.delta||'').slice(0,remaining);turn.outputs.set(p.itemId,text);turn.outputChars=(turn.outputChars||0)+text.length-previous.length;}
  }
  if(method==='item/completed'&&p.item?.type==='agentMessage'&&(turn.outputs.size<128||turn.outputs.has(p.item.id))){const previous=turn.outputs.get(p.item.id)||'',text=String(p.item.text||'').slice(0,Math.max(0,120000-(turn.outputChars||0)+previous.length));turn.outputs.set(p.item.id,text);turn.outputChars=(turn.outputChars||0)+text.length-previous.length;}
  if(method==='item/completed'&&p.item?.type==='mcpToolCall')await this.engine.acceptMcpResult(p.item,turn);
  if(method==='turn/completed'){
   turn.done=true;s.finished.add(id);this.engine.completedTurns.add(id);while(this.engine.completedTurns.size>1000)this.engine.completedTurns.delete(this.engine.completedTurns.values().next().value);
   turn.finalStatus=p.turn?.status==='completed'?'review':['interrupted','paused'].includes(p.turn?.status)?'paused':'failed';turn.error=readableError(p.turn?.error?.message);
   try{await this.finishTurn(s,turn);}finally{turn.resolveStopped();}
  }
 }
 async tool(s,turn,name,args){
  if(!['memory_write','send_message','send_file','create_voice_message','react_message','credential_find','credential_get','credential_request','credential_store','skill_list','skill_get','skill_save','end_call'].includes(name))throw Error('Unsupported voice background tool');
  if(name==='end_call')return {ended:true};
  if(name.startsWith('credential_')||name.startsWith('skill_'))return this.engine.tool(name,args,{owner:s.id,isCurrent:()=>this.session===s&&!s.stopping&&!s.closed&&!s.unknown&&!s.pausing&&s.turns.get(turn.turnId)===turn&&!turn.done&&!turn.pauseRequested});
  if(name==='react_message')return this.engine.tool(name,args);
  if(name==='create_voice_message'){
   if(typeof args.text!=='string'||!args.text.trim()||args.text.length>100000)throw Error('Invalid voice message text');
   if(typeof this.worker.createVoiceMessage!=='function')throw Error('Voice message generation is unavailable');
   const result=await this.worker.createVoiceMessage({text:args.text,voice:args.voice,outputDir:this.engine.outputDir});return this.tool(s,turn,'send_file',{path:result.path});
  }
  if(name==='send_file'){
   if(typeof args.path!=='string'||!path.isAbsolute(args.path)||args.path.includes('\0'))throw Error('Use an absolute output file path');
   if(!this.engine.deliverables?.archive)throw Error('File archive is unavailable');
   const files=await this.engine.deliverables.archive({baseline:turn.baseline,outputDir:this.engine.outputDir,workspace:this.engine.workspace,explicitPaths:[args.path],onlyExplicit:true,text:'',conversationId:this.engine.store.state.conversationId,turnId:turn.turnId});
   if(!files?.length)throw Error('No eligible output file was archived');turn.explicitPaths.push(args.path);return this.engine.deliverAttachments(turn,files);
  }
  if(typeof args.text!=='string'||args.text.length>100000)throw Error('Invalid voice tool text');
  if(name==='send_message'&&!args.text.trim())throw Error('Message cannot be empty');
  if(name==='send_message')return this.engine.deliverText(args.text,turn);
  return this.engine.tool(name,args);
 }
 pauseWork(){
  const s=this.session;if(!s)return Promise.resolve({paused:true,callContinues:false,turnIds:[]});
  if(s.pausePromise)return s.pausePromise;
  if(s.stopping)return Promise.reject(Error('The voice call is stopping'));
  s.pausing=true;this.engine.credentials?.cancelOwner?.(s.id);s.workEpoch++;this.change();
  // Invalidate local text work waiting to submit; a later task needs a fresh user action.
  for(const message of this.engine.store.state.messages)if(message.role==='user'&&message.voiceCallId===s.id&&message.status==='queued')this.engine.safeUpdate(message.id,{status:'paused',pauseReason:'user-paused'});
  const unknown=()=>Object.assign(Error('The current voice task has not been confirmed stopped. End the call to stop its VM executor.'),{unknownOutcome:true});
  s.pausePromise=Promise.resolve().then(async()=>{
   try{
    return await within((async()=>{
     await s.eventChain;this.current(s);
     if(s.unknown||s.submitting||[...s.turns.values()].some(turn=>turn.pendingSubmissions)){s.unknown=true;throw unknown();}
     const turns=[...s.turns.values()].filter(turn=>!turn.done);
     for(const turn of turns){turn.pauseRequested=true;for(const id of turn.explicitMessageIds)this.engine.safeUpdate(id,{status:'pausing'});}this.change();
     await Promise.all(turns.map(async turn=>{await Promise.race([this.worker.request('turn/interrupt',{threadId:s.threadId,turnId:turn.turnId}),turn.stopped]);await turn.stopped;}));
     await s.eventChain;this.current(s);if(s.unknown)throw unknown();
     return {paused:true,callId:s.id,callContinues:true,turnIds:turns.map(turn=>turn.turnId)};
    })(),this.stopTimeoutMs,'The current voice task did not confirm that it stopped');
   }catch(error){if(this.session===s&&!s.stopping){s.unknown=true;this.error=readableError(error.message);}throw unknown();}
   finally{if(this.session===s){s.pausing=false;s.pausePromise=null;this.change();}}
  });return s.pausePromise;
 }
 stop(callId){
  const s=this.session;if(!s)return Promise.resolve({stopped:true});
  if(callId!==undefined&&callId!==s.id)return Promise.reject(Error('The voice call changed'));
  if(s.stopPromise)return s.stopPromise;s.stopping=true;this.engine.credentials?.cancelOwner?.(s.id);s.contextQueue?.close();s.status='stopping';this.change();
  if(s.submitting||[...s.turns.values()].some(turn=>turn.pendingSubmissions))s.unknown=true;
  s.failure.reject(Error('Voice call cancelled'));
  if(!s.startSubmitted){this.finalize(s,'cancelled');return Promise.resolve({stopped:true,callId:s.id});}
  s.stopPromise=Promise.resolve().then(()=>this.stopSession(s)).catch(error=>{if(this.session===s){s.stopPromise=null;s.status='stop-unconfirmed';this.error=readableError(error.message);this.change();}throw error;});return s.stopPromise;
 }
 async stopSession(s){
  try{
   if(s.unknown)throw Error('Voice task handoff could not be confirmed');
   await within((async()=>{
    if(!s.closed){await this.worker.request('thread/realtime/stop',{threadId:s.threadId});await s.closedSignal.promise;}
    await s.eventChain;
    const active=[...s.turns.values()].filter(turn=>!turn.done);
    await Promise.all(active.map(async turn=>{await this.worker.request('turn/interrupt',{threadId:s.threadId,turnId:turn.turnId});await turn.stopped;}));
    await s.eventChain;if(s.unknown)throw Error('Voice task handoff could not be confirmed');
   })(),this.stopTimeoutMs,'The VM did not confirm that the voice call and its tasks stopped');
  }catch(error){
   this.engine.pauseQueue('voice-stop-uncertain');
   const result=await this.terminateExecutor();if(result?.terminated!==true)throw Error('The VM executor has not confirmed shutdown. Computer control remains blocked.');
   this.engine.loaded=false;this.emit('notice','The old VM executor was stopped because voice task shutdown was uncertain. Paused tasks will not replay.');
  }
  this.finalize(s,'stopped');return {stopped:true,callId:s.id};
 }
 finalize(s,reason){
  if(this.session!==s)return;this.engine.credentials?.cancelOwner?.(s.id);s.contextQueue?.close();this.session=null;
  for(const message of this.engine.store.state.messages)if(message.role==='user'&&message.voiceCallId===s.id&&['queued','running','waiting_user','pausing'].includes(message.status))this.engine.safeUpdate(message.id,{status:'paused',pauseReason:'voice-call-ended'});
  if(this.engine.call?.id===s.id)this.engine.closeCall(s.id);
  this.emit('closed',{reason,callId:s.id});this.engine.emit('realtime',{method:'thread/realtime/closed',params:{threadId:s.threadId,callId:s.id}});this.change();
 }
 async close(){return this.stop();}
}
