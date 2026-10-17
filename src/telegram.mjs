import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {MAX_ATTACHMENT_BYTES,MAX_MESSAGE_ATTACHMENTS,readBounded} from './attachments.mjs';

const API='https://api.telegram.org',MAX_CONFIG=1024*1024,MAX_OUTBOX=128;
const retryRenameCodes=new Set(['EPERM','EACCES','EBUSY']),pauseBuffer=new Int32Array(new SharedArrayBuffer(4));
const allowedMethods=new Set(['getMe','getWebhookInfo','getUpdates','getFile','sendMessage','sendDocument']);
const terminal=new Set(['review','completed','failed','paused']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const identifier=value=>Number.isSafeInteger(value)&&value>0?String(value):null;
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);resolve();};const aborted=()=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);reject(Error('Telegram request cancelled'));};const timer=setTimeout(done,ms);signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();});
export function splitTelegramText(text){
 const result=[];let remaining=String(text);while(remaining.length){let end=Math.min(4096,remaining.length);if(end<remaining.length&&/[\uD800-\uDBFF]/.test(remaining[end-1]))end--;result.push(remaining.slice(0,end));remaining=remaining.slice(end);}return result;
}
async function responseBytes(response,limit){
 const length=Number(response.headers.get('content-length'));if(Number.isFinite(length)&&length>limit){await response.body?.cancel?.().catch(()=>{});throw Error('Telegram response exceeded its size limit');}
 const reader=response.body?.getReader();if(!reader)throw Error('Telegram response body is unavailable');const chunks=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit)throw Error('Telegram response exceeded its size limit');chunks.push(Buffer.from(value));}return Buffer.concat(chunks,total);}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}

/** A disabled-by-default VM gateway. Only this private file contains the bot token. */
export class TelegramGateway extends EventEmitter{
 constructor({dataDir,store,engine,attachments,fetchImpl=fetch,now=Date.now,delay=sleep,autoPoll=true,pollTimeout=25,retryBaseMs=1000,renameSync=fs.renameSync,platform=process.platform,pause=ms=>Atomics.wait(pauseBuffer,0,0,ms)}={}){
  super();if(!dataDir||!store||!engine||!attachments)throw Error('Telegram requires VM storage, engine and attachment storage');
  this.dir=path.resolve(dataDir);fs.mkdirSync(this.dir,{recursive:true,mode:0o700});if(fs.lstatSync(this.dir).isSymbolicLink())throw Error('Telegram data directory cannot be a link');
  this.file=path.join(this.dir,'telegram.json');this.store=store;this.engine=engine;this.attachments=attachments;this.fetch=fetchImpl;this.now=now;this.delay=delay;this.autoPoll=autoPoll;this.pollTimeout=pollTimeout;this.retryBaseMs=retryBaseMs;
  this.renameSync=renameSync;this.platform=platform;this.pause=pause;
  this.closed=false;this.connected=false;this.generation=0;this.closeAbort=new AbortController();this.loopAbort=new AbortController();this.mutations=Promise.resolve();
  this.config={version:1,deliveryVersion:2,enabled:false,token:null,bot:null,owner:null,offset:0,pairing:null,outbox:[],receipts:[],resultKeys:[],lastError:null,lastInboundAt:null,lastOutboundAt:null};
  if(fs.existsSync(this.file)){
   const before=fs.lstatSync(this.file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_CONFIG)throw Error('Telegram configuration must be a bounded regular private file');
   if(process.platform!=='win32')fs.chmodSync(this.file,0o600);
   let legacyDeliveryHistory=false;const fd=fs.openSync(this.file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const opened=fs.fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev)throw Error('Telegram configuration changed');const loaded=JSON.parse(readBounded(fd,MAX_CONFIG).toString('utf8'));legacyDeliveryHistory=!Object.hasOwn(loaded,'deliveryVersion')&&Array.isArray(loaded.resultKeys)&&loaded.resultKeys.length>0;Object.assign(this.config,loaded);}finally{fs.closeSync(fd);}
   if(!Array.isArray(this.config.outbox)||!Array.isArray(this.config.receipts)||!Array.isArray(this.config.resultKeys)||this.config.outbox.length>MAX_OUTBOX||!Number.isSafeInteger(this.config.offset)||this.config.offset<0)throw Error('Telegram configuration is invalid');
   let changed=false;for(const item of this.config.outbox)if(item.status==='sending'){item.status='unknown';item.error='Delivery was interrupted before confirmation and was not resent';changed=true;}
   for(const receipt of this.config.receipts)if(receipt.status==='processing'){receipt.status='unknown';this.config.lastError='A Telegram update was interrupted; its task was not replayed';changed=true;}
   if(legacyDeliveryHistory){
    for(const task of this.store.state.messages){
     if(task.role!=='user'||!this.taskOwned(task)||!terminal.has(task.status)||task.telegramDelivery)continue;
     const legacyKey=`result:${task.id}:${task.turnId||'unsubmitted'}:${['review','completed'].includes(task.status)?'result':task.status}`,known=this.config.resultKeys.includes(legacyKey),replies=this.store.state.messages.filter(message=>message.role==='assistant'&&message.taskId===task.id&&message.status==='completed');
     this.store.update(task.id,{telegramDelivery:{key:`result:${this.config.owner.pairingId}:${legacyKey.slice(7)}`,pairingId:this.config.owner.pairingId,replyThroughId:replies.at(-1)?.id||null,scheduledAt:this.now(),status:known?'scheduled':'unknown'}});
     if(!known)this.config.lastError='Legacy Telegram delivery history was incomplete; past replies were not automatically resent';
    }
    this.config.deliveryVersion=2;changed=true;
   }
   if(changed)this.save();
  }
  this.engineListener=()=>{if(this.closed||!this.config.enabled||!this.config.owner||this.flushTimer)return;this.flushTimer=setTimeout(()=>{this.flushTimer=null;try{this.scanResults();this.kickOutbound();}catch{this.fail('Telegram results could not be queued');}},100);this.flushTimer.unref?.();};engine.on('change',this.engineListener);
 }
 status(){
  const c=this.config;return {enabled:!!c.enabled,configured:!!c.token,connected:this.connected,bot:c.bot?{id:c.bot.id,username:c.bot.username}:null,paired:!!c.owner,owner:c.owner?{chatId:c.owner.chatId,userId:c.owner.userId}:null,pairing:c.pairing&&c.pairing.expiresAt>this.now()?{expiresAt:c.pairing.expiresAt}:null,lastError:c.lastError?this.safe(c.lastError):null,lastInboundAt:c.lastInboundAt||null,lastOutboundAt:c.lastOutboundAt||null,pendingOutbound:c.outbox.filter(item=>['queued','sending'].includes(item.status)).length,delivery:{failed:c.outbox.filter(item=>item.status==='failed').length,unknown:c.outbox.filter(item=>item.status==='unknown').length}};
 }
 change(){this.emit('change',this.status());}
 safe(message){let value=String(message);if(this.config.token)value=value.split(this.config.token).join('[redacted]');return value.replace(/bot\d+:[A-Za-z0-9_-]+/g,'bot[redacted]').slice(0,500);}
 fail(message){this.config.lastError=this.safe(message);this.save();this.change();}
 save(){
  if(fs.existsSync(this.file)){const info=fs.lstatSync(this.file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Telegram configuration cannot be a link');}
  const content=JSON.stringify(this.config);if(Buffer.byteLength(content)>MAX_CONFIG)throw Error('Telegram configuration reached its storage limit');
  const temporary=this.file+'.'+randomBytes(8).toString('hex')+'.tmp';let fd;
  try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,content);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
   for(let attempt=0;attempt<6;attempt++){try{this.renameSync(temporary,this.file);break;}catch(error){if(this.platform!=='win32'||!retryRenameCodes.has(error.code)||attempt===5)throw error;this.pause((attempt+1)*10);}}
   if(process.platform!=='win32')fs.chmodSync(this.file,0o600);}
  finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
 }
 mutate(operation){const result=this.mutations.then(()=>{if(this.closed)throw Error('Telegram gateway is closed');return operation();});this.mutations=result.catch(()=>{});return result;}
 async api(method,body={},options={}){
  if(!allowedMethods.has(method))throw Error('Unsupported Telegram method');const token=options.token||this.config.token;if(!token)throw Error('Telegram token is not configured');
  const outgoing=method==='sendMessage'||method==='sendDocument',signal=AbortSignal.any([this.closeAbort.signal,options.signal||this.loopAbort.signal,AbortSignal.timeout(method==='getUpdates'?(this.pollTimeout+10)*1000:30000)]);
  let response,data;
  try{response=await this.fetch(`${API}/bot${token}/${method}`,{method:'POST',redirect:'error',headers:body instanceof FormData?undefined:{'Content-Type':'application/json'},body:body instanceof FormData?body:JSON.stringify(body),signal});data=JSON.parse((await responseBytes(response,2*1024*1024)).toString('utf8'));}
  catch{throw Object.assign(Error(outgoing?'Telegram delivery was not confirmed and was not resent':'Telegram could not be reached or returned an invalid response'),{unknownOutcome:outgoing});}
  if(!response.ok||data?.ok!==true){const code=Number(data?.error_code)||response.status;throw Object.assign(Error(`Telegram rejected the request (${code})`),{telegramCode:code,retryAfter:Number(data?.parameters?.retry_after)||null,unknownOutcome:outgoing&&code>=500});}
  return data.result;
 }
 async verify(token,enabled){
  const me=await this.api('getMe',{}, {token,signal:this.closeAbort.signal});if(!identifier(me?.id)||!me.is_bot||typeof me.username!=='string'||! /^[a-zA-Z0-9_]{1,64}$/.test(me.username))throw Error('Telegram did not return a valid bot identity');
  if(enabled){const webhook=await this.api('getWebhookInfo',{}, {token,signal:this.closeAbort.signal});if(webhook?.url)throw Error('This bot already has a webhook. Remove it in the service currently using the bot before enabling dant');}
  return {id:String(me.id),username:me.username};
 }
 configure({token,enabled}={}){return this.mutate(async()=>{
  if(enabled!==undefined&&typeof enabled!=='boolean')throw Error('Telegram enabled must be a boolean');
  if(token!==undefined&&(typeof token!=='string'||token.length>512||! /^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)))throw Error('Enter a valid Telegram bot token');
  const nextToken=token??this.config.token,nextEnabled=enabled??this.config.enabled;if(nextEnabled&&!nextToken)throw Error('Configure a Telegram bot token before enabling it');
  const bot=nextToken&&(token!==undefined||nextEnabled)?await this.verify(nextToken,nextEnabled):this.config.bot;
  await this.stopLoops();
  if(nextToken!==this.config.token)Object.assign(this.config,{owner:null,offset:0,pairing:null,outbox:[],receipts:[],resultKeys:[]});
  Object.assign(this.config,{token:nextToken,bot,enabled:nextEnabled,lastError:null});this.save();this.change();this.start();return this.status();
 });}
 pair(){return this.mutate(async()=>{
  if(!this.config.enabled||!this.config.token||!this.config.bot)throw Error('Enable a verified Telegram bot before pairing');if(this.config.owner)throw Error('Disconnect the current Telegram owner before pairing another');
  const code=randomBytes(16).toString('hex'),expiresAt=this.now()+10*60*1000;this.config.pairing={hash:digest(code),expiresAt};this.save();this.change();return {code,expiresAt,botUrl:`https://t.me/${this.config.bot.username}?start=${code}`};
 });}
 disconnect({clearToken=false}={}){return this.mutate(async()=>{
  if(typeof clearToken!=='boolean')throw Error('clearToken must be a boolean');await this.stopLoops();Object.assign(this.config,{enabled:false,owner:null,pairing:null});if(clearToken){this.config.token=null;this.config.bot=null;this.config.offset=0;}
  for(const item of this.config.outbox)if(item.status==='queued'){item.status='failed';item.error='Telegram was disconnected before delivery';}this.save();this.change();return this.status();
 });}
 start(){
  if(this.closed||!this.autoPoll||!this.config.enabled||!this.config.token||this.loopTask)return this.status();
  this.loopAbort=new AbortController();const generation=++this.generation,signal=this.loopAbort.signal;
  this.loopTask=this.pollLoop(generation,signal).catch(()=>{this.config.lastError='The Telegram gateway could not continue; check its VM configuration';this.change();}).finally(()=>{if(this.generation===generation){this.loopTask=null;this.connected=false;this.change();}});return this.status();
 }
 async pollLoop(generation,signal){
  let backoff=this.retryBaseMs,verified=false;
  while(!this.closed&&this.config.enabled&&generation===this.generation&&!signal.aborted){
   try{
    if(!verified){const bot=await this.verify(this.config.token,true);if(generation!==this.generation||signal.aborted)return;this.config.bot=bot;this.save();this.connected=true;verified=true;this.change();this.scanResults();this.kickOutbound();}
    await this.pollOnce(signal);if(!this.connected){this.connected=true;this.change();}backoff=this.retryBaseMs;
   }catch(error){
    if(this.closed||signal.aborted||generation!==this.generation)return;this.connected=false;this.fail(error.message);
    if([401,403,409].includes(error.telegramCode)||/already has a webhook/.test(error.message))return;
    try{await this.delay(Math.min(300000,Math.max(backoff,(error.retryAfter||0)*1000)),signal);}catch{return;}backoff=Math.min(30000,backoff*2);
   }
  }
 }
 async pollOnce(signal=this.loopAbort.signal){
  if(!this.config.enabled||!this.config.token||!this.config.bot)return;
  const updates=await this.api('getUpdates',{offset:this.config.offset,limit:20,timeout:this.pollTimeout,allowed_updates:['message']},{signal});if(!Array.isArray(updates)||updates.length>100)throw Error('Telegram returned an invalid update list');
  for(const update of [...updates].sort((a,b)=>a.update_id-b.update_id)){if(signal.aborted||this.closed)return;await this.receive(update);}
  if(!updates.length)await this.delay(200,signal);
 }
 owned(message){const owner=this.config.owner;return message?.chat?.type==='private'&&!message.from?.is_bot&&owner&&identifier(message.chat.id)===owner.chatId&&identifier(message.from?.id)===owner.userId;}
 async receive(update){
  if(this.closed||!this.config.enabled||!this.config.bot||!Number.isSafeInteger(update?.update_id)||update.update_id<0||update.update_id<this.config.offset)return;
  const id=update.update_id;if(this.config.receipts.some(item=>item.id===id)){this.config.offset=Math.max(this.config.offset,id+1);this.save();return;}
  const message=update.message;
  if(!message||message.chat?.type!=='private'||!identifier(message.chat.id)||!identifier(message.from?.id)||message.from.is_bot){this.config.offset=Math.max(this.config.offset,id+1);this.save();return;}
  const text=typeof message.text==='string'?message.text:'',match=text.match(/^\/([a-z]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([^\n]*))?$/i),command=match?.[1].toLowerCase();
  if(!this.config.owner){
   const pairing=this.config.pairing,code=match?.[2]?.trim()||'';
   if(command!=='start'||!pairing||pairing.expiresAt<=this.now()||! /^[0-9a-f]{32}$/.test(code)||! /^[0-9a-f]{64}$/.test(pairing.hash||'')||!timingSafeEqual(Buffer.from(digest(code),'hex'),Buffer.from(pairing.hash,'hex'))){this.config.offset=Math.max(this.config.offset,id+1);this.save();return;}
   this.config.owner={chatId:String(message.chat.id),userId:String(message.from.id),pairingId:randomBytes(16).toString('hex')};this.config.pairing=null;this.save();
  }
  if(!this.owned(message)){this.config.offset=Math.max(this.config.offset,id+1);this.save();return;}
  const receipt={id,status:'processing',at:this.now()};this.config.receipts.push(receipt);this.config.receipts=this.config.receipts.slice(-1000);this.config.lastInboundAt=this.now();this.save();
  try{
   if(command)await this.command(command,id);
   else await this.incoming(message,id);
   receipt.status='done';
  }catch{receipt.status='failed';this.config.lastError='A Telegram message could not be accepted; it was not replayed';if(!this.store.state.messages.some(task=>task.clientMessageId===`tg:${this.config.bot.id}:${id}`))this.queueText(`update:${id}:error`,'消息未能执行。请在 dant 检查任务状态后再决定是否重新提交。 / This message could not be executed. Check dant before resubmitting.');}
  finally{this.config.offset=Math.max(this.config.offset,id+1);this.save();this.change();this.kickOutbound();}
 }
 async command(command,id){
  const key=`command:${id}`;
  if(command==='stop'){
   const own=message=>this.taskOwned(message),active=this.engine.active;
   this.engine.queue=this.engine.queue.filter(message=>{if(!own(message))return true;this.engine.safeUpdate(message.id,{status:'paused',pauseReason:'telegram-stop'});return false;});
   if(!this.engine.call&&active&&active.messageIds.every(messageId=>own(this.engine.task(messageId)))){await this.engine.waitStopped(active);this.queueText(key,'已停止此 Telegram 的当前任务，等待你重新决定下一步。 / This Telegram task stopped. Resume it explicitly in dant if needed.');}
   else this.queueText(key,'没有可停止的 Telegram 当前任务。桌面任务和通话保持原状。 / No Telegram-owned active task to stop. Desktop work and calls were left alone.');this.engine.change();return;
  }
  if(command==='status'){const tasks=this.store.state.messages.filter(message=>message.role==='user'&&this.taskOwned(message));this.queueText(key,`dant: ${this.engine.worker.status}; Telegram tasks: ${tasks.filter(task=>['queued','running','waiting_user','pausing'].includes(task.status)).length} active/queued.\n任务完成后仍等待你在 dant 验收。 / Finished tasks await your review in dant.`);return;}
  this.queueText(key,'已连接 dant。发送文字、图片、文档或语音附件即可提交任务。 / Send text, photos, documents or voice files to request work.\n/status 查看状态 /stop 仅停止本 Telegram 的任务 /help 帮助');
 }
 taskOwned(message){const source=message?.source,owner=this.config.owner;return source?.type==='telegram'&&owner&&typeof owner.pairingId==='string'&&source.pairingId===owner.pairingId&&source.botId===this.config.bot?.id&&source.chatId===owner.chatId&&source.userId===owner.userId;}
 async incoming(message,updateId){
  const clientMessageId=`tg:${this.config.bot.id}:${updateId}`;if(this.store.state.messages.some(item=>item.clientMessageId===clientMessageId))return;
  const text=this.safeText(typeof message.text==='string'?message.text:typeof message.caption==='string'?message.caption:'');if(text.length>100000)throw Error('Telegram text exceeds the task limit');
  const candidates=[];
  if(Array.isArray(message.photo)&&message.photo.length){const photo=[...message.photo].sort((a,b)=>(b.file_size||b.width*b.height)-(a.file_size||a.width*a.height)).find(file=>!file.file_size||file.file_size<=MAX_ATTACHMENT_BYTES);if(!photo)throw Error('Telegram photo exceeds 10 MiB');candidates.push({file:photo,name:`photo-${message.message_id||updateId}.jpg`,type:'image/jpeg'});}
  for(const [key,name,type] of [['document','document',undefined],['voice',`voice-${message.message_id||updateId}.ogg`,'audio/ogg']])if(message[key])candidates.push({file:message[key],name:message[key].file_name||name,type});
  if(!text.trim()&&!candidates.length)return;if(candidates.length>MAX_MESSAGE_ATTACHMENTS)throw Error('Attach at most five files');
  const task=this.store.add({role:'user',text:text||'Please inspect the attached Telegram file.',attachments:[],clientMessageId,status:'draft',source:{type:'telegram',botId:this.config.bot.id,chatId:this.config.owner.chatId,userId:this.config.owner.userId,pairingId:this.config.owner.pairingId,updateId}});
  try{
   if(this.engine.queue.length>=32)throw Error('The task queue is full');const attachments=[];
   for(const candidate of candidates)attachments.push(await this.download(candidate));
   this.store.update(task.id,{attachments,status:'queued'});
   if(this.engine.queue.length>=32)throw Error('The task queue is full');this.engine.enqueue(task);
  }catch{this.engine.safeUpdate(task.id,{status:'failed',error:'Telegram attachment could not be received or the task queue is full'});throw Error('Telegram task was not queued');}
 }
 async download({file,name,type}){
  if(typeof file?.file_id!=='string'||!file.file_id||file.file_id.length>1024||(file.file_size!==undefined&&(!Number.isSafeInteger(file.file_size)||file.file_size<0||file.file_size>MAX_ATTACHMENT_BYTES)))throw Error('Telegram file exceeds the attachment limit');
  const info=await this.api('getFile',{file_id:file.file_id});const remote=info?.file_path;
  if(typeof remote!=='string'||remote.length>2048||! /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(remote)||remote.split('/').some(part=>part==='.'||part==='..')||(info.file_size!==undefined&&(!Number.isSafeInteger(info.file_size)||info.file_size<0||info.file_size>MAX_ATTACHMENT_BYTES)))throw Error('Telegram returned an unsafe file path or size');
  let data;try{const response=await this.fetch(`${API}/file/bot${this.config.token}/${remote}`,{redirect:'error',signal:AbortSignal.any([this.closeAbort.signal,this.loopAbort.signal,AbortSignal.timeout(30000)])});if(!response.ok)throw Error('File request failed');data=await responseBytes(response,MAX_ATTACHMENT_BYTES);}catch{throw Error('Telegram file download failed or exceeded 10 MiB');}
  return this.attachments.put({name,data,type});
 }
 queueText(id,text,extra={}){let accepted=true;for(const [index,chunk] of splitTelegramText(this.safeText(text)).entries())accepted=this.queue({id:id+':'+index,kind:'text',text:chunk,...extra})&&accepted;return accepted;}
 safeText(text){return this.config.token?String(text).split(this.config.token).join('[redacted]'):String(text);}
 queue(item){
  if(!this.config.owner)return false;if(this.config.outbox.some(prior=>prior.id===item.id))return true;
  while(this.config.outbox.length>=MAX_OUTBOX){const index=this.config.outbox.findIndex(prior=>prior.status==='sent');if(index<0){this.config.lastError='Telegram delivery queue is full; new output was not sent';return false;}this.config.outbox.splice(index,1);}
  this.config.outbox.push({...item,botId:this.config.bot.id,chatId:this.config.owner.chatId,userId:this.config.owner.userId,status:'queued',attempts:0,at:this.now()});
  let accepted=true;if(Buffer.byteLength(JSON.stringify(this.config))>MAX_CONFIG-256*1024){this.config.outbox.pop();this.config.lastError='Telegram delivery queue reached its byte limit; new output was not sent';accepted=false;}this.save();return accepted;
 }
 scanResults(){
  if(this.closed||!this.config.enabled||!this.config.owner)return;
  for(const task of this.store.state.messages){
   if(task.role!=='user'||!this.taskOwned(task)||!terminal.has(task.status))continue;
   const legacyKey=`result:${task.id}:${task.turnId||'unsubmitted'}:${['review','completed'].includes(task.status)?'result':task.status}`,key=`result:${this.config.owner.pairingId}:${legacyKey.slice(7)}`,previous=task.telegramDelivery;
   if(previous?.key===key){
    if(previous.status==='scheduling'){this.store.update(task.id,{telegramDelivery:{...previous,status:'unknown'}});this.config.lastError='Telegram reply scheduling was interrupted; it was not automatically repeated';this.save();}
    continue;
   }
   const allReplies=this.store.state.messages.filter(message=>message.role==='assistant'&&message.taskId===task.id&&message.status==='completed');
   const marker={key,pairingId:this.config.owner.pairingId,replyThroughId:allReplies.at(-1)?.id||null,scheduledAt:this.now(),status:'scheduling'};
   // Legacy keys are migrated once; new identities live with their task, never in a sliding ledger.
   if(this.config.resultKeys.includes(legacyKey)||this.config.resultKeys.includes(key)){this.store.update(task.id,{telegramDelivery:{...marker,status:'scheduled'}});continue;}
   const anchor=previous?.pairingId===marker.pairingId&&previous.replyThroughId?allReplies.findIndex(reply=>reply.id===previous.replyThroughId):-1;
   const replies=previous?.pairingId===marker.pairingId&&previous.replyThroughId?(anchor<0?[]:allReplies.slice(anchor+1)):allReplies;
   // Commit the attempt before queuing any part. A crash can withhold a reply, never replay it.
   this.store.update(task.id,{telegramDelivery:marker});let scheduled=true;
   if(['review','completed'].includes(task.status)){
    let delivered=false;for(const reply of replies){if(reply.text){scheduled=this.queueText(key+':'+reply.id,reply.text,{deliveryId:key,taskId:task.id})&&scheduled;delivered=true;}for(const file of (reply.attachments||[]).slice(0,MAX_MESSAGE_ATTACHMENTS)){scheduled=this.queue({id:key+':file:'+file.id,kind:'document',attachmentId:file.id,deliveryId:key,taskId:task.id})&&scheduled;delivered=true;}}
    if(!delivered)scheduled=this.queueText(key,'任务已结束，等待你在 dant 验收。 / Work finished and awaits your review in dant.',{deliveryId:key,taskId:task.id});
   }else scheduled=this.queueText(key,task.submission==='unknown'?'任务提交结果未确认，不会自动重试。请先在 dant 检查。 / Task submission is unconfirmed and will not be retried. Check dant first.':`任务${task.status==='paused'?'已暂停':'未能完成'}，请在 dant 查看。 / Task ${task.status==='paused'?'paused':'failed'}; check dant.`,{deliveryId:key,taskId:task.id});
   this.store.update(task.id,{telegramDelivery:{...marker,status:scheduled?'scheduled':'failed'}});this.save();
  }
 }
 kickOutbound(){if(this.autoPoll&&!this.closed&&this.config.enabled&&this.config.owner)void this.flush().catch(()=>this.fail('Telegram output could not be delivered'));}
 async drain(){
  for(const item of this.config.outbox){
   if(this.closed||!this.config.enabled||!this.config.owner||this.loopAbort.signal.aborted)return;
   if(item.status!=='queued')continue;if(item.botId!==this.config.bot.id||item.chatId!==this.config.owner.chatId||item.userId!==this.config.owner.userId){item.status='failed';item.error='The Telegram pairing changed';this.save();continue;}
   if(item.deliveryId&&this.config.outbox.some(prior=>prior.deliveryId===item.deliveryId&&prior.status==='unknown')){item.status='failed';item.error='An earlier part of this reply was unconfirmed; remaining parts were not sent';this.save();continue;}
   let again=true;
   while(again){
    again=false;if(this.closed||!this.config.enabled||this.loopAbort.signal.aborted)return;item.status='sending';item.attempts++;this.save();this.change();
    try{
     if(item.kind==='text')await this.api('sendMessage',{chat_id:item.chatId,text:item.text,link_preview_options:{is_disabled:true}});
     else{const {meta,data}=this.attachments.read(item.attachmentId);const form=new FormData();form.set('chat_id',item.chatId);form.set('document',new Blob([data],{type:meta.type}),meta.name);await this.api('sendDocument',form);}
     item.status='sent';item.error=null;this.config.lastOutboundAt=this.now();
    }catch(error){
     if(error.telegramCode===429&&Number.isFinite(error.retryAfter)&&error.retryAfter>0&&error.retryAfter<=300&&item.attempts<3){item.status='queued';item.error='Telegram rate limit; waiting before a confirmed-safe retry';this.save();this.change();try{await this.delay(error.retryAfter*1000,this.loopAbort.signal);again=true;}catch{} }
     else{item.status=error.unknownOutcome?'unknown':'failed';item.error=this.safe(error.message);this.config.lastError=item.error;}
    }finally{this.save();this.change();}
   }
  }
 }
 flush(){this.scanResults();if(this.outboundTask)return this.outboundTask;const task=Promise.resolve().then(()=>this.drain()).finally(()=>{if(this.outboundTask===task)this.outboundTask=null;});this.outboundTask=task;return task;}
 async stopLoops(){
  this.generation++;this.loopAbort.abort();clearTimeout(this.flushTimer);this.flushTimer=null;
  const pending=[this.loopTask,this.outboundTask];this.loopTask=null;this.outboundTask=null;await Promise.allSettled(pending);this.connected=false;this.loopAbort=new AbortController();
 }
 close(){
  if(this.closePromise)return this.closePromise;this.closed=true;clearTimeout(this.flushTimer);this.engine.off('change',this.engineListener);this.closeAbort.abort();this.loopAbort.abort();
  this.closePromise=Promise.allSettled([this.loopTask,this.outboundTask,this.mutations]).then(()=>{this.connected=false;});return this.closePromise;
 }
}
