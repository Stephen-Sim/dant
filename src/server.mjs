import express from 'express';
import multer from 'multer';
import {WebSocketServer} from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import {Store} from './store.mjs';
import {LocalWorker,assertVmRuntime} from './local-worker.mjs';
import {createControllerApp} from './controller.mjs';
import {Engine} from './engine.mjs';
import {Provisioning} from './provisioning.mjs';
import {Voice,VOICES} from './voice.mjs';
import {createSecretStore,validateApiKey} from './secrets.mjs';
import {AttachmentStore,MAX_ATTACHMENT_BYTES,MAX_MESSAGE_ATTACHMENTS} from './attachments.mjs';
import {AudioTranscriber} from './audio-transcription.mjs';
import {DeliverableCollector} from './deliverables.mjs';
import {MemoryStore} from './memory.mjs';
import {ComputerSession} from './computer-session.mjs';
import {NativeRealtimeVoice,DEFAULT_NATIVE_VOICE} from './realtime.mjs';
import {TelegramGateway} from './telegram.mjs';
import {buildReactionContext} from './reaction-context.mjs';
import {isReaction} from './reactions.mjs';
import {CredentialVault,CredentialRequests} from './credentials.mjs';
import {SkillLibrary} from './skill-library.mjs';
import {SkillImporter} from './skill-import.mjs';
import {exportSkillZip} from './skill-export.mjs';
import {ConversationHistory} from './history.mjs';
import {Diagnostics} from './diagnostics.mjs';
import {observeHttp,observeTasks,serviceVersion,diagnosticWorkerStatus} from './diagnostic-events.mjs';
import {UpdateService,installUpdateRoutes} from './updates.mjs';
import {Scheduler,scheduleTimeZone} from './scheduler.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createApp(options={}){
 const dataDir=options.dataDir||process.env.DANT_DATA||path.join(root,'data');
 if(options.mode==='vm-worker'||options.mode==='test')return createWorkerApp({...options,dataDir});
 return createControllerApp({...options,dataDir,projectRoot:options.projectRoot||root,prepareOnly:options.mode==='prepare'||options.prepareOnly});
}
export function createWorkerApp({dataDir=process.env.DANT_DATA||path.join(root,'data'),workerFactory=s=>new LocalWorker(s),secretFactory=dir=>createSecretStore(dir),voiceFactory=options=>new Voice(options),nativeVoiceFactory=options=>new NativeRealtimeVoice(options),telegramFactory=options=>new TelegramGateway(options),credentialVaultFactory=options=>new CredentialVault(options),credentialRequestsFactory=options=>new CredentialRequests(options),skillLibraryFactory=options=>new SkillLibrary(options),skillImporterFactory=options=>new SkillImporter(options),diagnosticsFactory=options=>new Diagnostics(options),updatesFactory=options=>new UpdateService(options),audioTranscriberFactory=options=>new AudioTranscriber(options)}={}){
 const version=serviceVersion(root),diagnostics=diagnosticsFactory({dataDir,role:'vm-worker',version}),updates=updatesFactory({version});
 const store=new Store(dataDir),worker=workerFactory(store),attachmentStore=new AttachmentStore(path.join(dataDir,'attachments')),deliverables=new DeliverableCollector(attachmentStore),memory=new MemoryStore(dataDir);
 memory.migrateLegacy?.(store);
 const audioTranscriber=audioTranscriberFactory({attachments:attachmentStore});
 const engine=new Engine(store,worker,{memory,deliverables,audioTranscriber}),computer=new ComputerSession(engine,worker),history=new ConversationHistory({store,engine}),app=express(),server=http.createServer(app);
 const scheduler=new Scheduler({store,engine,worker});
 const credentialVault=credentialVaultFactory({dataDir}),credentials=credentialRequestsFactory({vault:credentialVault,change:()=>engine.change()});engine.credentials=credentials;
 const skills=skillLibraryFactory({workspace:engine.workspace,containsSecret:value=>credentials.containsSecret(value)});engine.skills=worker.skills=skills;
 const skillImporter=skillImporterFactory({skills});
 const skillSnapshot=()=>{try{return {items:skills.list()};}catch{return {items:[],error:'Managed skills could not be read. Existing files were preserved.'};}};
 const credentialToken=randomBytes(32).toString('hex');Object.defineProperty(worker,'credentialBridgeToken',{value:credentialToken,enumerable:false});
 computer.on('change',()=>engine.change());deliverables.on('notice',message=>engine.emit('notice',message));
 const provisioning=new Provisioning({projectRoot:root,dataDir});
 const voiceKeys=secretFactory(dataDir);
 let callScopedKey=null;
 const apiScope=context=>{const callId=context?.callId,isCurrent=()=>!closing&&worker.status==='online'&&engine.call?.provider==='api'&&engine.call.id===callId&&context?.isCurrent?.()===true;if(typeof callId!=='string'||!isCurrent())throw Error('The API voice operation is no longer active.');return {...context,owner:callId,isCurrent};};
 const voice=voiceFactory({getKey:()=>callScopedKey||voiceKeys.get(),onConversationItem:item=>engine.recordSpeech(item),runTask:(text,context)=>{apiScope(context);return engine.runVoiceTask(text);},tool:(name,args,context)=>engine.tool(name,args,apiScope(context)),context:({reactionsOnly=false}={})=>{
  const reactions=buildReactionContext(store.state.messages);if(reactionsOnly)return credentials.redact(reactions);
  const lines=store.state.messages.filter(message=>['user','assistant'].includes(message.role)).map(message=>JSON.stringify({messageId:message.id,role:message.role,text:String(message.text||''),attachments:(message.attachments||[]).slice(0,5).map(file=>String(file.name||'')),assistantReaction:message.assistantReaction||null}));
  return credentials.redact(lines.join('\n')+'\n\n'+reactions);
 },hangupTimeoutMs:2000});
 engine.voice=voice;
 const nativeVoice=nativeVoiceFactory({worker,engine});engine.nativeVoice=nativeVoice;
 nativeVoice.on('diagnostic',event=>{if(['voice_executor_stop_required','voice_shutdown_unconfirmed','voice_shutdown','voice_observer_image_omitted','voice_observer_payload_omitted','voice_handoff_tracked','voice_handoff_confirmed'].includes(event?.code)){const {code,...metadata}=event;diagnostics.log(code,metadata);}});
 nativeVoice.on('notice',message=>engine.emit('notice',message));nativeVoice.on('change',()=>engine.change());
 const telegram=telegramFactory({dataDir,store,engine,attachments:attachmentStore});telegram.on('change',()=>engine.change());
 voice.on('closed',event=>{const call=engine.call;if(call?.provider!=='api'||event?.callId!==call.id)return;callScopedKey=null;credentials.cancelOwner(call.id);engine.handleVoiceClosed(event);engine.emit('realtime',{method:'thread/realtime/closed',params:{callId:call.id}});});
 nativeVoice.on('closed',event=>{if(event?.callId&&!event.workContinues)credentials.cancelOwner(event.callId);});
 voice.on('notice',message=>engine.emit('notice',message));
 const contextAttempts=new Map();
 async function syncVoiceContext(kind,message,call){
  if(!call||!['api','subscription'].includes(call.provider))return null;
  const provider=call.provider==='api'?voice:nativeVoice,attempt=Symbol(),callId=call.id;contextAttempts.set(message.id,attempt);let result;
  try{
   if(engine.call?.id!==callId)result={callId,messageId:message.id,kind,status:'cancelled'};
   else if(typeof provider.syncContext!=='function')throw Object.assign(Error('Live voice context is unavailable'),{code:-1});
   else result=await provider.syncContext({kind,message,callId});
   if(!result||result.callId!==callId||!['submitted','unknown','failed','cancelled','superseded'].includes(result.status))throw Error('The live voice context result was not confirmed');
  }catch(error){result={callId,messageId:message.id,kind,status:typeof error?.code==='number'?'failed':'unknown',error:'The live voice context update was not confirmed.'};}
  const latest=contextAttempts.get(message.id)===attempt;if(latest)contextAttempts.delete(message.id);
  if(latest&&result.status!=='superseded')try{store.update(message.id,{voiceContext:result});engine.change();}catch{engine.emit('notice','The chat update is saved, but its voice context status could not be saved.');}
  if(['unknown','failed'].includes(result.status)&&(call.provider==='api'||!result.contextId))engine.emit('notice','The chat update is saved, but its delivery to the current voice call is '+(result.status==='unknown'?'unconfirmed. It will not be retried automatically.':'unavailable.'));
  return result;
 }
 let replyCallId=null;const voiceReplies=new Map();
 engine.on('change',()=>{
  const call=engine.call;
  if(call?.provider!=='api'){replyCallId=null;voiceReplies.clear();return;}
  if(replyCallId!==call.id){replyCallId=call.id;voiceReplies.clear();for(const message of store.state.messages)if(message.role==='assistant')voiceReplies.set(message.id,JSON.stringify([message.text,message.attachments]));return;}
  for(const message of store.state.messages){
   if(message.role!=='assistant'||message.status==='streaming'||message.status==='paused')continue;
   const fingerprint=JSON.stringify([message.text,message.attachments]);if(voiceReplies.get(message.id)===fingerprint)continue;
   voiceReplies.set(message.id,fingerprint);void syncVoiceContext('message',message,call);
  }
 });
 const importBinding=()=>{const binding=path.join(dataDir,'vm.json');if(!store.state.settings.vm.host&&fs.existsSync(binding)){Object.assign(store.state.settings.vm,JSON.parse(fs.readFileSync(binding,'utf8').replace(/^\uFEFF/,'')));store.save();}};
 importBinding();
 const files=path.join(dataDir,'files');fs.mkdirSync(files,{recursive:true});
 const token=randomBytes(32).toString('hex');
 app.disable('x-powered-by');
 app.use(observeHttp(diagnostics));
 app.use((req,res,next)=>{const host=req.headers.host?.split(':')[0];if(!['127.0.0.1','localhost'].includes(host))return res.sendStatus(403);const origin=req.headers.origin;if(origin&&!/^https?:\/\/(127\.0\.0\.1|localhost)(:431[78])?$/.test(origin)&&origin!=='http://tauri.localhost'&&origin!=='tauri://localhost')return res.sendStatus(403);if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Dant-Token');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');}if(req.method==='OPTIONS')return res.sendStatus(204);next();});
 app.use(express.json({limit:'2mb'}));
 function credentialScope(){
  if(closing||worker.status!=='online'||engine.takeover||engine.acquiring)return null;
  const active=engine.active;
  if(active?.startAcknowledged&&active.turnId&&!active.stopRequested&&!active.finishing){const owner=active.turnId;return {owner,task:active,isCurrent:()=>!closing&&worker.status==='online'&&engine.active===active&&active.turnId===owner&&!active.stopRequested&&!active.finishing&&!engine.takeover&&!engine.acquiring};}
  const session=nativeVoice.session,turns=session?.turns instanceof Map?[...session.turns.values()].filter(turn=>turn.turnId&&!turn.done&&!turn.pauseRequested):[];
  const acceptedSession=()=>session&&nativeVoice.session===session&&(session.background===true||session.continueWork===true||engine.call?.provider==='subscription'&&engine.call.id===session.id&&['negotiating','connected'].includes(session.status))&&(!session.stopping||session.continueWork===true)&&(!session.closed||session.background===true||session.continueWork===true)&&!session.unknown&&!session.pausing;
  if(acceptedSession()&&turns.length===1){
   const turn=turns[0],owner=session.id;return {owner,task:turn,isCurrent:()=>!closing&&worker.status==='online'&&acceptedSession()&&session.turns.get(turn.turnId)===turn&&!turn.done&&!turn.pauseRequested&&!engine.takeover&&!engine.acquiring};
  }return null;
 }
 app.post('/api/internal/credentials',async(req,res)=>{
  if(req.headers['x-dant-credential-token']!==credentialToken)return res.status(403).json({error:'Credential bridge authorization failed.'});
  const scope=credentialScope();if(!scope)return res.status(409).json({error:'A current acknowledged VM task is required.'});
  const taskPlan=req.body?.tool==='task_plan';
  if(!['task_plan','credential_find','credential_get','credential_request','credential_store','skill_list','skill_get','skill_save','schedule_list','schedule_save','schedule_delete'].includes(req.body?.tool)||!req.body.arguments||typeof req.body.arguments!=='object'||Array.isArray(req.body.arguments))return res.status(400).json({error:taskPlan?'The task progress request could not be completed.':'Invalid credential operation.'});
  try{const result=await engine.tool(req.body.tool,req.body.arguments,scope);if(!scope.isCurrent())return res.status(409).json({error:taskPlan?'The task progress request is no longer active.':'The credential operation is no longer active.'});res.json(result);}
  catch(error){const code=taskPlan&&['work_not_found','work_conflict','work_not_continuable','work_stale_turn'].includes(error?.code)?error.code:null;res.status(400).json({error:taskPlan?'The task progress request could not be completed.':'The credential operation could not be completed.',...(code?{code}:{})});}
 });
 app.get('/api/session',(req,res)=>res.json({token,product:'dant',mode:'worker'}));
 app.use('/api',(req,res,next)=>{if(req.headers['x-dant-token']!==token&&req.query.token!==token)return res.sendStatus(401);next();});
 installUpdateRoutes(app,updates);
 app.get('/api/diagnostics',(req,res)=>res.json({status:diagnostics.status(),recent:diagnostics.recent(50)}));
 app.all('/api/diagnostics',(req,res)=>res.status(405).json({error:'Diagnostics are read-only.'}));
 const snapshot=()=>{const key=voiceKeys.status(),native=nativeVoice.state;return {mode:'vm-worker',conversationId:store.state.conversationId,messages:store.state.messages,completions:store.state.completions||[],workTasks:store.state.workTasks||[],presence:{lastActiveAt:store.state.presence?.lastActiveAt||null},credentials:credentials.snapshot(),skills:skillSnapshot(),memory:store.state.memory,memoryFiles:memory.snapshot(),settings:store.state.settings,telegram:telegram.status(),worker:{status:worker.status,error:worker.error||null,account:worker.account?.account,models:worker.models?.data||[],realtime:{available:native.available,reason:native.available?null:'vm-offline',provider:'subscription',billing:'subscription',subscription:{available:native.available,version:'v3',error:native.error||null,lastStop:native.lastStop||null},api:{available:key.configured,billing:'api'},key}},active:engine.progress||nativeVoice.progress||(engine.active?{messageId:engine.active.messageId,turnId:engine.active.turnId}:nativeVoice.active||null),queue:engine.queue.map(m=>m.id),takeover:computer.state.status==='human',computer:computer.snapshot(),call:engine.call,schedules:store.state.schedules,provisioning:provisioning.snapshot()};};
 const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
 server.on('upgrade',(req,socket,head)=>{const url=new URL(req.url,'http://localhost');if(url.pathname!=='/events'||url.searchParams.get('token')!==token){socket.destroy();return;}const origin=req.headers.origin;if(origin&&!/^http:\/\/(127\.0\.0\.1|localhost):431[78]$/.test(origin)&&origin!=='http://tauri.localhost'&&origin!=='tauri://localhost'){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
 const broadcast=(type,data)=>{const payload=JSON.stringify({type,data});for(const ws of wss.clients)if(ws.readyState===1)ws.send(payload);};
 let broadcastTimer,closing=false,lastProvisionStatus=provisioning.snapshot().status;engine.on('change',()=>{if(closing)return;clearTimeout(broadcastTimer);broadcastTimer=setTimeout(()=>broadcast('state',snapshot()),60);});engine.on('notice',message=>broadcast('notice',{message}));engine.on('realtime',e=>broadcast('realtime',e));
 let workerStatus=diagnosticWorkerStatus(worker.status);diagnostics.log('worker.status',{status:workerStatus});worker.on('status',()=>{const status=diagnosticWorkerStatus(worker.status);if(status!==workerStatus){workerStatus=status;diagnostics.log('worker.status',{status});}});
 worker.on('lifecycle',event=>{if(['rpc.timeout','rpc.disconnected'].includes(event?.code)){const {code,...metadata}=event;diagnostics.log(code,metadata);}});
 engine.on('change',observeTasks(diagnostics,store,engine));diagnostics.log('service.started',{version});
 provisioning.on('change',progress=>{if(closing)return;importBinding();engine.change();if(progress.status==='ready'&&lastProvisionStatus!=='ready'&&!engine.active&&!engine.pendingFollowups.size&&!engine.callReferences.size&&!nativeVoice.active&&!engine.call){engine.loaded=false;worker.connect().catch(e=>engine.emit('notice',e.message));}lastProvisionStatus=progress.status;});
 wss.on('connection',ws=>ws.send(JSON.stringify({type:'state',data:snapshot()})));
 app.get('/api/state',(req,res)=>res.json(snapshot()));
 const historyAction=(res,operation,action)=>{try{return res.json(action());}catch(error){return res.status([400,404,409].includes(error.status)?error.status:409).json({error:'The '+operation+' could not be completed. Check the request and stop active work before changing history.'});}};
 app.patch('/api/messages/:id',(req,res)=>historyAction(res,'message edit',()=>{const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['text','resubmit'].includes(key))||body.resubmit!==undefined&&typeof body.resubmit!=='boolean')throw Object.assign(Error('Invalid message edit'),{status:400});return history.edit(req.params.id,{text:body.text,resubmit:body.resubmit===true});}));
 app.delete('/api/messages/:id',(req,res)=>historyAction(res,'message removal',()=>history.remove(req.params.id)));
 app.delete('/api/history',(req,res)=>historyAction(res,'history clearing',()=>history.clear({confirm:req.body?.confirm===true})));
 const rejectDeletedClient=(clientMessageId,res)=>{if(history.hasDeletedClientId(clientMessageId)){res.status(409).json({error:'This message was withdrawn or deleted. Send a new message to start new work.'});return true;}return false;};
 const credentialAction=(res,action)=>{try{return res.json(action());}catch{return res.status(400).json({error:'The credential action could not be completed. Existing data was preserved.'});}};
 app.get('/api/credentials',(req,res)=>credentialAction(res,()=>credentials.snapshot()));
 app.post('/api/credentials',(req,res)=>credentialAction(res,()=>credentials.upsert(req.body)));
 app.patch('/api/credentials/:id',(req,res)=>credentialAction(res,()=>credentials.upsert({...req.body,id:req.params.id})));
 app.delete('/api/credentials/:id',(req,res)=>credentialAction(res,()=>credentials.remove(req.params.id)));
 app.post('/api/credentials/requests/:id',(req,res)=>credentialAction(res,()=>credentials.fulfill(req.params.id,req.body)));
 app.delete('/api/credentials/requests/:id',(req,res)=>credentialAction(res,()=>credentials.cancel(req.params.id)));
 const reloadSkills=async()=>{engine.loaded=false;engine.change();if(worker.status==='online')try{await worker.request('skills/list',{cwds:[engine.workspace],forceReload:true});}catch{engine.emit('notice','The skill was saved, but the VM skill list could not be refreshed. Reconnect before using it.');}};
 const skillAction=async(res,action,{reload=false}={})=>{let result;try{result=action();}catch(error){return res.status(400).json({error:'The skill action could not be completed. Existing skills were preserved.',...(error?.code==='size_limit'?{code:'size_limit'}:{})});}if(reload)await reloadSkills();return res.json(result);};
 const importUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:1024*1024,files:1,fields:0}});
 const importError=(res,error)=>{const code=error?.code,allowed=new Set(['invalid_source','not_found','invalid_skill','unsupported_file','size_limit','name_exists','expired','fetch_failed','import_busy']);const safe=allowed.has(code)?code:'invalid_skill',status={not_found:404,name_exists:409,expired:410,fetch_failed:502,import_busy:429}[safe]||400;return res.status(status).json({error:'The skill import could not be completed. Existing skills were preserved.',code:safe});};
 app.post('/api/skills/import/preview',(req,res,next)=>{if(!req.is('multipart/form-data'))return next();importUpload.single('file')(req,res,error=>error?res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({error:'The skill source could not be read.',code:error.code==='LIMIT_FILE_SIZE'?'size_limit':'invalid_source'}):next());},async(req,res)=>{
  if(closing||worker.status!=='online')return res.status(409).json({error:'Connect the work computer before importing skills.',code:'import_busy'});
  try{const input=req.file?{data:req.file.buffer,name:req.file.originalname}:req.body;res.json(await skillImporter.preview(input));}catch(error){importError(res,error);}
 });
 app.post('/api/skills/import',async(req,res)=>{
  if(closing||worker.status!=='online')return res.status(409).json({error:'Connect the work computer before importing skills.',code:'import_busy'});
  let result;try{result=skillImporter.commit(req.body);}catch(error){return importError(res,error);}await reloadSkills();res.json(result);
 });
 app.delete('/api/skills/import/previews/:id',(req,res)=>res.json(skillImporter.discard(req.params.id)));
 app.get('/api/skills',(req,res)=>res.json(skillSnapshot()));
 app.get('/api/skills/:name',(req,res)=>skillAction(res,()=>skills.get(req.params.name)));
 app.post('/api/skills/:name/export',(req,res)=>{
  if(closing||worker.status!=='online')return res.status(409).json({error:'Connect the work computer before exporting a skill.'});
  try{const archive=exportSkillZip(skills,req.params.name);res.json(attachmentStore.put({...archive,type:'application/zip'}));}
  catch{res.status(400).json({error:'The skill could not be exported. Existing skills were preserved.'});}
 });
 app.post('/api/skills',(req,res)=>skillAction(res,()=>skills.save(req.body),{reload:true}));
 app.patch('/api/skills/:name',(req,res)=>skillAction(res,()=>{const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['description','instructions','files','enabled'].includes(key)))throw Error('Invalid skill patch');if(Object.keys(body).length===1&&Object.hasOwn(body,'enabled'))return skills.setEnabled(req.params.name,body.enabled);return skills.save({...skills.get(req.params.name),...body,name:req.params.name});},{reload:true}));
 app.delete('/api/skills/:name',(req,res)=>skillAction(res,()=>skills.remove(req.params.name),{reload:true}));
 app.get('/api/telegram',(req,res)=>res.json(telegram.status()));
 app.post('/api/telegram/config',async(req,res)=>res.json(await telegram.configure({token:req.body.token,enabled:req.body.enabled})));
 app.post('/api/telegram/pair',async(req,res)=>res.json(await telegram.pair()));
 app.post('/api/telegram/disconnect',async(req,res)=>res.json(await telegram.disconnect({clearToken:req.body.clearToken})));
 app.post('/api/provision',(req,res)=>{if(engine.active||engine.pendingFollowups.size||engine.callReferences.size||nativeVoice.active||engine.call)throw Error('Stop active work first');res.json(provisioning.start(req.body));});
 app.post('/api/connect',async(req,res)=>{
  if(req.body.idleRecovery===true){
   // Controller recovery rechecks the lease and all work on the authoritative
   // VM, synchronously before connect() can change the executor state.
   if(engine.active||engine.pendingFollowups.size||engine.callReferences.size||nativeVoice.active||engine.call||engine.queue.length||engine.finishing||engine.acquiring||engine.takeover||computer.pending||computer.state.status!=='dant'||computer.state.sessionId)throw Object.assign(Error('Stop active work and return computer control before reconnecting the executor.'),{status:409});
   if(worker.status==='online')return res.json({ok:true});
   if(worker.status!=='offline')throw Object.assign(Error('The executor is already reconnecting. Check its state before trying again.'),{status:409});
  }else if(engine.active||engine.pendingFollowups.size||engine.callReferences.size||nativeVoice.active||engine.call)throw Error('Stop active work first');
  importBinding();engine.loaded=false;await worker.connect();engine.change();res.json({ok:true});
 });
 app.post('/api/login',async(req,res)=>res.json(await worker.request('account/login/start',{type:'chatgptDeviceCode'})));
 app.post('/api/logout',async(req,res)=>{if(engine.active||engine.pendingFollowups.size||engine.callReferences.size||nativeVoice.active||engine.call)throw Error('Stop active work first');await worker.request('account/logout',{});res.json({ok:true});});
 app.post('/api/voice-key',async(req,res)=>{if(engine.call)throw Error('End the call before changing its API key');await voiceKeys.set(req.body.key);engine.change();res.json({ok:true,key:voiceKeys.status()});});
 app.delete('/api/voice-key',async(req,res)=>{if(engine.call)throw Error('End the call before removing its API key');await voiceKeys.clear();engine.change();res.json({ok:true,key:voiceKeys.status()});});
 app.patch('/api/settings',(req,res)=>{const b=req.body,s=store.state.settings;if(b.showWorkSummary!==undefined&&typeof b.showWorkSummary!=='boolean')throw Error('Invalid work summary preference');const timeZone=b.timeZone===undefined?undefined:scheduleTimeZone(b.timeZone);if((engine.active||engine.pendingFollowups.size||engine.callReferences.size||nativeVoice.active||engine.call)&&(b.vm||b.model!==undefined||b.voice!==undefined||b.nativeVoice!==undefined||b.apiVoice!==undefined))throw Error('Stop active work first');if(timeZone!==undefined)s.timeZone=timeZone;if(['zh','en'].includes(b.language)){if(s.language!==b.language)engine.loaded=false;s.language=b.language;}if(typeof b.notifications==='boolean')s.notifications=b.notifications;if(b.showWorkSummary!==undefined)s.showWorkSummary=b.showWorkSummary;const selected=b.nativeVoice??b.voice;if(typeof selected==='string'&&/^[a-z]+$/.test(selected))s.nativeVoice=s.voice=selected;if(typeof b.apiVoice==='string'&&VOICES.includes(b.apiVoice))s.apiVoice=b.apiVoice;if(typeof b.model==='string'&&b.model.length<120)s.model=b.model;if(b.vm)throw Error('VM connection settings belong to the Windows Controller');store.save();engine.change();res.json({ok:true});});
 app.post('/api/messages',async(req,res)=>{const text=String(req.body.text||'').trim(),replyTo=req.body.replyTo||null,clientMessageId=req.body.clientMessageId;const ids=req.body.attachments??[];if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string')||ids.length>MAX_MESSAGE_ATTACHMENTS||new Set(ids).size!==ids.length)throw Error('Attach at most five distinct files');if(clientMessageId!==undefined&&(typeof clientMessageId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientMessageId)))throw Error('Invalid client message ID');if(rejectDeletedClient(clientMessageId,res))return;if(clientMessageId){const existing=store.state.messages.find(message=>message.role==='user'&&message.clientMessageId===clientMessageId);if(existing){if(existing.text!==text||(existing.replyTo||null)!==replyTo||JSON.stringify((existing.attachments||[]).map(file=>file.id))!==JSON.stringify(ids))return res.status(409).json({error:'This client message ID already belongs to a different request'});return res.json(existing);}}const attachments=ids.map(id=>{const item=uploadIndex.get(id);if(!item)throw Error('Attachment not found; please upload again');return item;});if(replyTo&&!store.state.messages.some(message=>message.id===replyTo))throw Error('The referenced message is not in this conversation');if(!text&&!attachments.length)return res.status(400).json({error:'Empty message'});if(worker.status!=='online')return res.status(409).json({error:'请先在设置中连接工作电脑 / Connect your VM in settings first'});const call=engine.call,m=store.add({role:'user',text,attachments,replyTo,clientMessageId,status:'queued'});engine.enqueue(m,{interactive:true});if(call?.provider==='api'&&attachments.length)await syncVoiceContext('message',m,call);res.json(m);});
 app.get('/api/memory',(req,res)=>res.json({files:memory.snapshot()}));
 app.patch('/api/memory/:name',async(req,res)=>res.json(await engine.saveMemory(req.params.name,req.body.text)));
 app.post('/api/messages/:id/reaction',async(req,res)=>{const emoji=req.body.emoji;if(!isReaction(emoji))return res.sendStatus(400);const m=store.state.messages.find(m=>m.id===req.params.id);if(!m)return res.sendStatus(404);const call=engine.call,reactions=Array.isArray(m.reactions)?m.reactions:[];store.update(m.id,{reactions:reactions.includes(emoji)?reactions.filter(x=>x!==emoji):[...reactions,emoji],reactionUpdatedAt:Date.now()});engine.change();const voiceContext=await syncVoiceContext('reaction',m,call);res.json({ok:true,...(voiceContext?{voiceContext}:{})});});
 app.post('/api/read',(req,res)=>{if(!Array.isArray(req.body.ids)||req.body.ids.length>1000)throw Error('Invalid visible message IDs');store.markVisible(req.body.ids);engine.change();res.json({ok:true});});
 app.post('/api/retry/:id',(req,res)=>{const m=store.state.messages.find(x=>x.id===req.params.id);if(!m||m.role!=='user'||!['failed','paused'].includes(m.status))return res.sendStatus(409);engine.resumePaused([m.id],{confirmUnknown:req.body.confirmUnknown===true});res.json({ok:true});});
 app.post('/api/stop',async(req,res)=>{await engine.pause();res.json({ok:true});});
 app.post('/api/tasks/pause',async(req,res)=>{await engine.pause();res.json({ok:true});});
 app.post('/api/tasks/resume',(req,res)=>{if(!Array.isArray(req.body.ids)||req.body.ids.length>100)throw Error('Choose the paused tasks to resume');engine.resumePaused(req.body.ids,{confirmUnknown:req.body.confirmUnknown===true});res.json({ok:true});});
 app.post('/api/tasks/:id/accept',(req,res)=>res.json(engine.confirm(req.params.id)));
 app.post('/api/tasks/clear-completed',(req,res)=>{try{res.json(engine.clearCompletedProgress());}catch{res.status(409).json({error:'Completed work progress could not be cleared.'});}});
 app.post('/api/tasks/:id/priority',(req,res)=>{try{res.json(engine.setProgressPriority(req.params.id,req.body?.kind,req.body?.priority));}catch(error){res.status([400,404,409].includes(error.status)?error.status:409).json({error:'Work progress priority could not be changed.'});}});
 app.post('/api/tasks/:id/dismiss',(req,res)=>{try{res.json(engine.dismissProgress(req.params.id,req.body?.kind,{confirmUnfinished:req.body?.confirmUnfinished}));}catch(error){res.status([400,404,409].includes(error.status)?error.status:409).json({error:'Work progress could not be dismissed. Only inactive task history can be hidden.',...(error.confirmationRequired?{confirmationRequired:true,code:'confirmation_required'}:{})});}});
 app.post('/api/steer',async(req,res)=>{if(engine.call?.provider==='subscription')throw Error('Send text through the current call to adjust its work');if(worker.status!=='online')throw Error('The VM executor is offline');const text=String(req.body.text||'').trim();if(!text)throw Error('Invalid steering message');const current=engine.progress||nativeVoice.progress;if(typeof req.body.expectedTurnId!=='string'||!current?.canSteer||current.turnId!==req.body.expectedTurnId)throw Error('The active turn changed; steering was not submitted');const message=store.add({role:'user',text,attachments:[],replyTo:req.body.replyTo||null,status:'draft'});res.json(await engine.steer(message,req.body.expectedTurnId));});
 app.post('/api/takeover',async(req,res)=>{const result=req.body.enabled?await computer.acquire():await computer.release(req.body.sessionId);res.json({ok:true,...result});});
 app.get('/api/screen',async(req,res)=>{const r=await worker.guest('/screen');res.type('png').send(Buffer.from(await r.arrayBuffer()));});
 app.post('/api/input',async(req,res)=>res.json(await computer.input(req.body)));
 const uploadIndex={get:id=>attachmentStore.get(id)};const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_ATTACHMENT_BYTES,files:1}});
 app.post('/api/upload',upload.single('file'),async(req,res)=>{if(!req.file)return res.sendStatus(400);res.json(attachmentStore.put({name:req.file.originalname,type:req.file.mimetype,data:req.file.buffer}));});
 app.get('/api/files/:id',(req,res)=>{const item=attachmentStore.get(req.params.id);if(!item)return res.sendStatus(404);const {meta,data}=attachmentStore.read(req.params.id);const safeInline=/^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|wav|ogg|webm))$/.test(meta.type);res.setHeader('X-Content-Type-Options','nosniff');if(!safeInline||req.query.download==='1')res.attachment(meta.name);res.setHeader('Content-Type',safeInline?meta.type:'application/octet-stream');res.send(data);});
 engine.deliverFile=async guestPath=>{const item=deliverables.readExplicit({outputDir:engine.outputDir||path.join(engine.workspaceRoot,store.state.conversationId,'output'),filePath:guestPath});store.add({role:'assistant',text:'',attachments:[item],status:'completed',taskId:engine.active?.messageId});engine.change();return {sent:true,name:item.name};};
 app.post('/api/call',async(req,res)=>{if(engine.call)throw Error('A call is already active');const provider=req.body.provider||'subscription';if(provider==='api'&&req.body.apiKey)callScopedKey=validateApiKey(req.body.apiKey);try{res.json(await engine.startCall(req.body.sdp,{provider}));}catch(error){callScopedKey=null;throw error;}});
 app.post('/api/call/connected',(req,res)=>res.json(engine.confirmCallConnected(req.body.callId)));
 app.post('/api/realtime/message',async(req,res)=>{if(!engine.call||engine.call.provider!=='subscription'||req.body.callId!==engine.call.id)throw Error('The subscription voice call changed');if(req.body.attachments!==undefined&&(!Array.isArray(req.body.attachments)||req.body.attachments.length))throw Error('Attachments are not supported during a voice call');if(rejectDeletedClient(req.body.clientMessageId,res))return;res.json(await nativeVoice.message({clientMessageId:req.body.clientMessageId,text:req.body.text,replyTo:req.body.replyTo,callId:req.body.callId}));});
 app.post('/api/call/stop',async(req,res)=>{if(engine.call&&typeof req.body.callId!=='string')throw Error('A current call ID is required');try{res.json(await engine.stopCall(req.body.callId));}finally{if(!engine.call||engine.call.provider!=='api')callScopedKey=null;}});
 app.get('/api/voices',async(req,res)=>{const result=await nativeVoice.listVoices(),nativeV3=result.voices.v3;res.json({...result,nativeV3,apiV2:VOICES,defaultNative:DEFAULT_NATIVE_VOICE,defaultApi:'marin',api:{voices:VOICES,default:'marin'}});});
 app.get('/api/schedules',(req,res)=>res.json(scheduler.list()));
 app.post('/api/schedules',(req,res)=>{if(req.body.id!==undefined)throw Object.assign(Error('Use the schedule update route for an existing task.'),{status:400});res.json(scheduler.save(req.body));});
 app.patch('/api/schedules/:id',(req,res)=>{if(req.body.id!==undefined&&req.body.id!==req.params.id)throw Object.assign(Error('The scheduled task id changed.'),{status:400});res.json(scheduler.save({...req.body,id:req.params.id}));});
 app.delete('/api/schedules/:id',(req,res)=>res.json(scheduler.remove(req.params.id)));
 scheduler.start();
 app.use(express.static(path.join(root,'dist')));
 app.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(err.status||(err.unknownOutcome?502:400)).json({error:err.type==='entity.parse.failed'?'Invalid JSON request.':err.type==='entity.too.large'?'The request exceeds its size limit.':err.message,...(err.unknownOutcome?{unknownOutcome:true}:{})});});
 let closePromise;
 telegram.start();
 return {app,server,store,worker,engine,voice,nativeVoice,telegram,voiceKeys,provisioning,computer,credentials,skills,history,diagnostics,updates,scheduler,close:()=>{if(closePromise)return closePromise;closing=true;updates.close();credentials.close();computer.close();provisioning.close();skillImporter.close?.();engine.pauseQueue('service-stopping');if(engine.active){engine.active.stopRequested=true;engine.active.preparation?.abort();}scheduler.close();clearTimeout(broadcastTimer);closePromise=Promise.allSettled([voice.close(),nativeVoice.close(),telegram.close(),audioTranscriber.close?.()]).finally(()=>{callScopedKey=null;try{worker.disconnect();}finally{diagnostics.log('service.closed',{version});diagnostics.close();}});for(const ws of wss.clients)ws.terminate();wss.close();server.close();return closePromise;}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv.includes('--vm-worker')?'vm-worker':process.argv.includes('--prepare')?'prepare':'vm-controller';
 if(mode==='vm-worker'&&process.platform!=='linux')throw Error('The authoritative worker must run inside the Linux VM.');
 if(mode==='vm-worker')await assertVmRuntime();
 const instance=createApp({mode});
 if(process.argv.includes('--deploy-worker')){await instance.bridge.prepare();await instance.close();process.exit(0);}
 const port=Number(process.env.DANT_PORT||4317);instance.server.listen(port,'127.0.0.1',()=>{
  console.log(`dant listening at http://127.0.0.1:${port}`);
  if(mode==='vm-worker')instance.worker.connect().catch(e=>instance.engine.emit('notice',e.message));
  else instance.start().catch(error=>console.error(error.message));
 });
 let shuttingDown=false;
 const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;await instance.close();process.exit();};
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 if(process.env.DANT_MANAGED){process.stdin.resume();process.stdin.on('end',shutdown);}
}
