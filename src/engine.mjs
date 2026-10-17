import {EventEmitter} from 'node:events';
const instructions=`You are dant, a digital coworker with your own Ubuntu desktop. Speak naturally in the user's language. All shell commands run INSIDE your VM. Work serially and verify actual results. Use /opt/dant/desktop.py for screenshots, clicks, key presses, typing, and scrolling; use python3 /opt/dant/desktop.py --help for usage. DISPLAY=:0. Use browser automation or shell when appropriate. Long-term memory is stored by dant independently of ChatGPT: call memory_write to maintain useful durable facts and preferences. Use send_file to share images, audio, documents or other completed artifacts, supplying an absolute VM path. Use send_message for short progress updates and links. Never claim to have delivered a file unless send_file succeeds. Your desktop may be taken over; stop all work when interrupted and re-observe on return. Reply in coherent short paragraphs; do not split markdown syntax. During a voice call, use end_call if the user asks to hang up. Do not expose credentials.`;
const tool=(name,description,properties,required=[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const string={type:'string'};
export const dynamicTools=[tool('memory_write','Replace dant durable memory with concise updated notes.',{text:string},['text']),tool('send_file','Deliver a completed VM file to the user.',{path:string},['path']),tool('send_message','Send a text message or clickable link to the same chat.',{text:string},['text']),tool('end_call','End the active voice conversation.',{})];
export class Engine extends EventEmitter {
 constructor(store,worker){super();this.store=store;this.worker=worker;this.queue=[];this.active=null;this.takeover=false;this.acquiring=false;this.items=new Map();this.completedItems=new Set();this.completedTurns=new Set();this.call=null;
  worker.on('event',e=>{this.handle(e).catch(err=>this.emit('notice',err.message));});
  worker.on('status',()=>{if(worker.status==='offline'){this.loaded=false;if(this.active)this.finish('interrupted','VM disconnected');if(this.call)this.closeCall();}this.emit('change');if(worker.status==='online')void this.pump();});
 }
 change(){this.emit('change');}
 async thread(){if(this.threadPromise)return this.threadPromise;this.threadPromise=this.openThread().finally(()=>this.threadPromise=null);return this.threadPromise;}
 async openThread(){const state=this.store.state;const host=state.settings.vm.host;
  if(this.loaded&&state.threadHost===host)return state.threadId;
  const developerInstructions=instructions+'\nCurrent durable memory:\n'+state.memory;
  if(state.threadId&&state.threadHost===host){await this.worker.request('thread/resume',{threadId:state.threadId,excludeTurns:true,persistExtendedHistory:false,developerInstructions});this.loaded=true;return state.threadId;}
  const r=await this.worker.request('thread/start',{cwd:'/home/dant/work',approvalPolicy:'never',sandbox:'danger-full-access',model:state.settings.model||undefined,developerInstructions,dynamicTools,experimentalRawEvents:false,persistExtendedHistory:false});
  state.threadId=r.thread.id;state.threadHost=host;this.store.save();this.loaded=true;return r.thread.id;
 }
 enqueue(message){if(this.active?.messageId===message.id||this.queue.some(m=>m.id===message.id))return;this.queue.push(message);this.change();void this.pump();}
 async pump(){if(this.active||this.takeover||this.acquiring||this.worker.status!=='online'||!this.queue.length)return;const message=this.queue.shift();const active={messageId:message.id,turnId:null};this.active=active;let ready;this.starting=new Promise(resolve=>ready=resolve);this.store.update(message.id,{status:'running'});this.change();
  try{const threadId=await this.thread();const input=[{type:'text',text:message.text||'Please inspect the attached files.',text_elements:[]}];
   if(message.replyTo){const target=this.store.state.messages.find(m=>m.id===message.replyTo);if(target)input[0].text=`Replying to: ${target.text}\n\n${input[0].text}`;}
   for(const a of message.attachments||[]){if(a.type.startsWith('image/'))input.push({type:'localImage',path:a.guestPath});else input[0].text+=`\nAttached file in VM: ${a.guestPath}`;}
   if(this.active!==active)return;if(active.stopRequested){this.finish('interrupted');return;}
   const result=await this.worker.request('turn/start',{threadId,input,model:this.store.state.settings.model||undefined});if(this.active===active)this.active.turnId=result.turn.id;
  }catch(e){if(this.active===active)this.finish('failed',e.message);}finally{ready();}
 }
 async handle(e){const p=e.params||{};
  if(p.threadId&&p.threadId!==this.store.state.threadId){if(e.id!==undefined)this.worker.rpc?.send({id:e.id,error:{code:-32602,message:'Inactive thread'}});return;}
  const eventTurnId=p.turnId||p.turn?.id;
  if(eventTurnId&&(this.completedTurns.has(eventTurnId)||(this.active?.turnId&&eventTurnId!==this.active.turnId))){if(e.id!==undefined)this.worker.rpc?.send({id:e.id,error:{code:-32602,message:'Inactive turn'}});return;}
  if(e.id!==undefined){
   if(e.method==='item/tool/call'){let result;try{const args=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;result=await this.tool(p.tool,args||{});this.worker.rpc.reply(e.id,{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]});}catch(err){this.worker.rpc.reply(e.id,{success:false,contentItems:[{type:'inputText',text:err.message}]});}return;}
   this.worker.rpc.send({id:e.id,error:{code:-32601,message:'Unsupported request: '+e.method}});return;
  }
  if(e.method==='account/updated'||e.method==='account/login/completed'){this.worker.account=await this.worker.request('account/read',{});this.change();}
  if(e.method==='turn/started'&&this.active)this.active.turnId=p.turn?.id;
  if(e.method==='item/agentMessage/delta'){
   if(this.completedItems.has(p.itemId)||(p.turnId&&!this.active))return;
   let m=this.items.get(p.itemId);if(!m){m=this.store.add({role:'assistant',text:'',status:'streaming'});this.items.set(p.itemId,m);}m.text+=p.delta;this.store.save();this.emit('delta',{id:m.id,delta:p.delta});this.change();
  }
  if(e.method==='item/completed'&&p.item?.type==='agentMessage'){
   if(this.completedItems.has(p.item.id)||(p.turnId&&!this.active))return;
   let m=this.items.get(p.item.id);if(m){this.store.update(m.id,{text:p.item.text,status:'completed'});}else m=this.store.add({role:'assistant',text:p.item.text,status:'completed'});this.completedItems.add(p.item.id);if(this.completedItems.size>1000)this.completedItems.delete(this.completedItems.values().next().value);this.change();
  }
  if(e.method==='turn/completed'&&this.active){this.active.turnId ||= eventTurnId;this.finish(p.turn.status,p.turn.error?.message);}
  if(e.method==='error')this.emit('notice',p.error?.message||'Agent error');
  if(e.method.startsWith('thread/realtime/')){this.emit('realtime',e);if(e.method==='thread/realtime/closed')this.closeCall();if(e.method==='thread/realtime/error'&&this.call)await this.stopCall();}
 }
 async tool(name,args){switch(name){case 'memory_write':if(typeof args.text!=='string'||args.text.length>100000)throw Error('Invalid memory');this.store.state.memory=args.text;this.store.save();this.change();return {saved:true};case 'send_message':this.store.add({role:'assistant',text:String(args.text),status:'completed'});this.change();return {sent:true};case 'send_file':return await this.deliverFile(args.path);case 'end_call':await this.stopCall();return {ended:true};default:throw Error('Unknown tool');}}
 finish(status,error){if(this.active){if(this.active.turnId){this.completedTurns.add(this.active.turnId);if(this.completedTurns.size>1000)this.completedTurns.delete(this.completedTurns.values().next().value);}this.store.update(this.active.messageId,{status:status==='completed'?'read':status,error});}for(const [id,m] of this.items){if(m.status==='streaming')m.status=status;this.completedItems.add(id);}while(this.completedItems.size>1000)this.completedItems.delete(this.completedItems.values().next().value);this.items.clear();this.store.save();this.active=null;if(error)this.emit('notice',error);this.change();if(!this.takeover&&!this.acquiring)queueMicrotask(()=>this.pump());}
 async interrupt(){const active=this.active;if(!active)return;active.stopRequested=true;if(!active.turnId)await this.starting;if(this.active===active&&active.turnId)await this.worker.request('turn/interrupt',{threadId:this.store.state.threadId,turnId:active.turnId});}
 async acquire(){if(this.acquiring)throw Error('Desktop takeover is already in progress');this.acquiring=true;try{await this.interrupt();const deadline=Date.now()+15000;while(this.active&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));if(this.active)throw Error('Agent has not stopped yet');this.takeover=true;this.change();}finally{this.acquiring=false;if(!this.takeover)void this.pump();}}
 release(){this.takeover=false;this.change();void this.pump();}
 async startCall(sdp){if(this.call)throw Error('A call is already active');const call={started:Date.now()};this.call=call;try{const threadId=await this.thread();if(this.call!==call)throw Error('Call cancelled');const result=await this.worker.request('thread/realtime/start',{threadId,outputModality:'audio',voice:this.store.state.settings.voice,transport:{type:'webrtc',sdp},prompt:'You are dant. Speak naturally. Do not send speech transcripts into chat. Use send_message to share useful links or text, and end_call to hang up when asked.'});this.change();return result;}catch(e){if(this.call===call)this.call=null;this.change();throw e;}}
 closeCall(){if(!this.call)return;const seconds=Math.round((Date.now()-this.call.started)/1000);this.store.add({role:'system',kind:'call',seconds,text:'',status:'completed'});this.call=null;this.change();}
 async stopCall(){if(!this.call)return;try{await this.worker.request('thread/realtime/stop',{threadId:this.store.state.threadId});}finally{this.closeCall();this.emit('realtime',{method:'thread/realtime/closed',params:{}});}}
}
