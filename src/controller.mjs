import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {WebSocketServer} from 'ws';
import {VmBridge} from './vm-bridge.mjs';
import {Provisioning} from './provisioning.mjs';
import {VmProfiles,readVmBinding,normalizeVmBinding} from './vm-profiles.mjs';
import {NotificationHub} from './notifications.mjs';
import {createSecretStore} from './secrets.mjs';
import {appearanceDefaults,appearanceKeys,readAppearance,validateAppearancePatch,listSystemFonts} from './appearance.mjs';
import {Diagnostics} from './diagnostics.mjs';
import {observeHttp,serviceVersion,diagnosticWorkerStatus} from './diagnostic-events.mjs';
import {UpdateService,installUpdateRoutes} from './updates.mjs';
import {UpdateInstallLease,installLeaseRoutes,updateSensitiveRequest} from './update-install-lease.mjs';

const parse=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const allowedOrigin=origin=>!origin||/^https?:\/\/(127\.0\.0\.1|localhost)(:431[78])?$/.test(origin)||origin==='http://tauri.localhost'||origin==='tauri://localhost';
const emptyState=()=>({messages:[],memory:'',settings:{language:'zh',voice:'marin',model:'',notifications:true,showWorkSummary:false,vm:{host:'',user:'dant',port:22,keyPath:'',knownHosts:''}},worker:{status:'offline',account:null,models:[],realtime:{available:false,reason:'vm-offline',key:{configured:false}}},active:null,queue:[],takeover:false,call:null,schedules:[]});

// No Store, Engine, LocalWorker, user command, or authoritative conversation file
// is constructed by this process. The JSON here is explicitly an offline cache.
export function createControllerApp({dataDir,projectRoot,prepareOnly=false,bridgeFactory=options=>new VmBridge(options),provisioningFactory=options=>new Provisioning(options),secretFactory=dir=>createSecretStore(dir),profileFactory=options=>new VmProfiles(options),profileOptions={},fontsProvider=listSystemFonts,diagnosticsFactory=options=>new Diagnostics(options),updatesFactory=options=>new UpdateService(options)}={}){
 fs.mkdirSync(dataDir,{recursive:true});const configFile=path.join(dataDir,'controller.json'),cacheFile=path.join(dataDir,'state-cache.json');
 const version=serviceVersion(projectRoot),diagnostics=diagnosticsFactory({dataDir,role:'controller',version}),updates=updatesFactory({version});
 let config={language:'zh',notifications:false,showWorkSummary:false,...appearanceDefaults};try{config={...config,...parse(configFile)};}catch{}config={...config,...readAppearance(config),showWorkSummary:config.showWorkSummary===true};
 let cached=emptyState();try{cached=parse(cacheFile);}catch{}
 const profiles=profileFactory({dataDir,projectRoot,...profileOptions});let profileError=null;try{profiles.autoImport();}catch(error){profileError=error.message;}
 const bridge=bridgeFactory({dataDir,projectRoot}),provisioning=provisioningFactory({projectRoot,dataDir});
 const notifications=new NotificationHub(dataDir),voiceKeys=secretFactory(dataDir);notifications.configure(config.notifications);
 const app=express(),server=http.createServer(app),token=randomBytes(32).toString('hex'),wss=new WebSocketServer({noServer:true,maxPayload:1024*1024}),streams=new Set();let closing=false,lastSaved=0,saveTimer;
 app.disable('x-powered-by');
 app.use(observeHttp(diagnostics));
 app.use((req,res,next)=>{const hostname=req.headers.host?.split(':')[0];if(!['127.0.0.1','localhost'].includes(hostname)||!allowedOrigin(req.headers.origin))return res.sendStatus(403);if(req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Dant-Token');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');}if(req.method==='OPTIONS')return res.sendStatus(204);next();});
 app.use(express.json({limit:'2mb'}));app.get('/api/session',(req,res)=>res.json({token,product:'dant',mode:'controller'}));
 app.use('/api',(req,res,next)=>req.headers['x-dant-token']===token||req.query.token===token?next():res.sendStatus(401));
 app.use('/api/internal',(req,res)=>res.sendStatus(403));
 installUpdateRoutes(app,updates);
 const updateLease=new UpdateInstallLease({snapshot,refresh:async()=>{if(bridge.status!=='online')throw Error('The VM is offline.');if(bridge.refreshing)await bridge.refreshing;await bridge.refresh(true);}});
 installLeaseRoutes(app,updateLease);
 app.use('/api',(req,res,next)=>{if(!updateSensitiveRequest(req))return next();req.updateInstallDone=updateLease.enter();res.once('finish',()=>req.updateInstallDone());next();});
 const admitted=handler=>async(req,res,next)=>{try{await handler(req,res,next);}catch(error){req.updateInstallDone?.(error);next(error);}finally{req.updateInstallDone?.();}};
 function binding(){try{return readVmBinding(dataDir);}catch{return {};}}
 let preferenceSync;
 // These idempotent preferences share one writer per SSH/VM connection. A
 // newer UI language waits for any older write before applying its latest value.
 const preferenceFailure=()=>Error('The computer connected, but its language and time zone could not be updated.');
 const preferenceValues=()=>({language:config.language,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
 function preferenceConnection(){
  const identity=JSON.stringify([bridge.generation??null,binding()]);
  if(closing||bridge.status!=='online'||preferenceSync?.identity!==identity){preferenceSync?.abort.abort();preferenceSync=null;}
  if(closing||bridge.status!=='online')return null;
  return preferenceSync??={identity,abort:new AbortController(),pending:null,confirmed:null,submitted:false,retryAt:0};
 }
 const preferenceCurrent=context=>!closing&&preferenceSync===context&&bridge.status==='online'&&!context.abort.signal.aborted&&context.identity===JSON.stringify([bridge.generation??null,binding()]);
 async function syncPreferences({retry=false}={}){
  const context=preferenceConnection();if(!context)return;
  if(context.pending)return context.pending;
  if(!retry&&Date.now()<context.retryAt)return;
  const pending=(async()=>{
   while(preferenceCurrent(context)){
    const values=preferenceValues(),key=JSON.stringify(values);
    if(context.confirmed===key)return;
    if(!context.submitted&&bridge.cached?.settings?.language===values.language&&bridge.cached?.settings?.timeZone===values.timeZone){context.confirmed=key;return;}
    context.submitted=true;
    const response=await bridge.request('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(values),signal:AbortSignal.any([context.abort.signal,AbortSignal.timeout(60000)])});
    if(!preferenceCurrent(context))return;
    if(!response.ok)throw preferenceFailure();
    context.confirmed=key;context.retryAt=0;
    await bridge.refresh(true);
    if(!preferenceCurrent(context))return;
   }
  })().catch(error=>{if(!preferenceCurrent(context))return;context.confirmed=null;context.retryAt=Date.now()+5000;throw error;}).finally(()=>{if(context.pending===pending)context.pending=null;});
  context.pending=pending;return pending;
 }
 function syncPreferencesAfterEvent(){const context=preferenceConnection();if(!context||context.pending||Date.now()<context.retryAt)return;void syncPreferences().catch(()=>{if(preferenceCurrent(context))broadcast('notice',{message:preferenceFailure().message});});}
 async function connect({recoverExecutor=false}={}){
  const finish=updateLease.enter();let failed;
  try{
  try{const discovery=profiles.autoImport();if(discovery.requiresSelection)throw Object.assign(Error(discovery.error),{status:409});readVmBinding(dataDir);profileError=null;}catch(error){profileError=error.message;throw error;}
  await bridge.connect({updateRunningWork:recoverExecutor});
  await syncPreferences({retry:true});
  // Reopening SSH after startup or a transport failure must preserve an executor
  // intentionally stopped by voice safety. Only the explicit Reconnect action
  // may start it again, after checking fresh authoritative VM state.
  if(!recoverExecutor)return;
  if(bridge.status!=='online')throw Object.assign(Error('The VM is still offline. Reconnect before starting its executor.'),{status:503});
  const state=await bridge.refresh(true);if(state?.worker?.status!=='offline')return;
  const computer=state.computer;
  if(state.active||state.call||state.takeover||state.acquiring||!Array.isArray(state.queue)||state.queue.length||computer?.sessionId||computer?.pending||!['dant','agent'].includes(computer?.status))throw Object.assign(Error('Stop active work and return computer control before reconnecting the executor.'),{status:409});
  const response=await bridge.request('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idleRecovery:true})});
  if(!response.ok)throw Object.assign(Error('The VM connected, but its executor could not reconnect. Check its state before trying again.'),{status:response.status>=400&&response.status<600?response.status:502});
  const refreshed=await bridge.refresh(true);if(refreshed?.worker?.status!=='online')throw Object.assign(Error('The VM connected, but its executor is still offline. Check its diagnostics before trying again.'),{status:503});
  }catch(error){failed=error;throw error;}finally{finish(failed);}
 }
 function snapshot(){const state=structuredClone(cached),key=voiceKeys.status();state.mode='vm-controller';state.settings={...emptyState().settings,...state.settings,language:config.language,notifications:config.notifications,showWorkSummary:config.showWorkSummary,...readAppearance(config),vm:{...emptyState().settings.vm,...binding()}};state.worker={...state.worker,status:bridge.status==='online'?state.worker?.status||'connecting':bridge.status,error:profileError||bridge.error||state.worker?.error||null,realtime:{...state.worker?.realtime,key,api:{available:key.configured,billing:'api'}}};state.provisioning=provisioning.snapshot();state.controller={status:bridge.status,authority:'vm',cached:bridge.status!=='online',updatedAt:lastSaved||null,error:profileError||bridge.error||null};return state;}
 function broadcast(type,data){if(closing)return;const body=JSON.stringify({type,data});for(const client of wss.clients)if(client.readyState===1)client.send(body);for(const stream of streams)stream.write(`data: ${body}\n\n`);}
 function saveCache(){clearTimeout(saveTimer);saveTimer=null;const temporary=cacheFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify(cached));fs.renameSync(temporary,cacheFile);lastSaved=Date.now();}
 let cachedWorkerStatus=diagnosticWorkerStatus(cached.worker?.status),bridgeStatus=diagnosticWorkerStatus(bridge.status);diagnostics.log('bridge.status',{status:bridgeStatus});diagnostics.log('worker.status',{status:cachedWorkerStatus,cached:true});
 bridge.on('state',state=>{cached=state;const status=diagnosticWorkerStatus(state.worker?.status);if(status!==cachedWorkerStatus){cachedWorkerStatus=status;diagnostics.log('worker.status',{status,cached:true});}notifications.observe(state);if(!saveTimer)saveTimer=setTimeout(()=>{try{saveCache();}catch{broadcast('notice',{message:'The VM state is available, but its Windows cache could not be saved.'});}},2000);broadcast('state',snapshot());syncPreferencesAfterEvent();});
 bridge.on('change',()=>{const status=diagnosticWorkerStatus(bridge.status);if(status!==bridgeStatus){bridgeStatus=status;diagnostics.log('bridge.status',{status});}broadcast('state',snapshot());syncPreferencesAfterEvent();});bridge.on('event',event=>broadcast(event.type,event.data));
 diagnostics.log('service.started',{version});
 let provisioningStatus=provisioning.snapshot().status;
 provisioning.on('change',progress=>{broadcast('state',snapshot());if(!prepareOnly&&progress.status==='ready'&&provisioningStatus!=='ready')void connect().catch(error=>broadcast('notice',{message:error.message}));provisioningStatus=progress.status;});
 server.on('upgrade',(req,socket,head)=>{let url;try{url=new URL(req.url,'http://localhost');}catch{socket.destroy();return;}if(url.pathname!=='/events'||url.searchParams.get('token')!==token||!allowedOrigin(req.headers.origin)){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
 wss.on('connection',ws=>ws.send(JSON.stringify({type:'state',data:snapshot()})));
 app.get('/api/events',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.flushHeaders();streams.add(res);res.write(`data: ${JSON.stringify({type:'state',data:snapshot()})}\n\n`);const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);heartbeat.unref();req.on('close',()=>{clearInterval(heartbeat);streams.delete(res);});});
 app.get('/api/state',async(req,res)=>{if(bridge.status==='online')try{await bridge.refresh();}catch(error){bridge.error=error.message;}res.json(snapshot());});
 app.get('/api/diagnostics',async(req,res)=>{let worker={available:false,reason:'worker-unavailable'};if(bridge.status==='online')try{const response=await bridge.request('/api/diagnostics');if(response.ok){const value=await response.json();if(value&&typeof value.status==='object'&&Array.isArray(value.recent))worker={available:true,status:value.status,recent:value.recent.slice(-50)};}}catch{}res.json({status:diagnostics.status(),recent:diagnostics.recent(50),worker});});
 app.all('/api/diagnostics',(req,res)=>res.status(405).json({error:'Diagnostics are read-only.'}));
 app.post('/api/provision',admitted((req,res)=>res.json(provisioning.start(req.body))));
 let manualConnect;
 app.post('/api/connect',admitted(async(req,res)=>{if(!manualConnect){const pending=connect({recoverExecutor:true}).finally(()=>{if(manualConnect===pending)manualConnect=null;});manualConnect=pending;}await manualConnect;res.json({ok:true});}));
 app.post('/api/prepare',admitted(async(req,res)=>{await bridge.prepare();res.json({ok:true});}));
 app.get('/api/vm/profiles',(req,res)=>res.json(profiles.discover()));
 app.get('/api/vm/providers',(req,res)=>res.json(provisioning.providers()));
 app.get('/api/fonts',async(req,res)=>res.json(await fontsProvider()));
 app.post('/api/vm/import',admitted((req,res)=>{const previous=profiles.discover().current,result=profiles.import(req.body);profileError=null;if(previous?.id!==profiles.discover().current?.id)bridge.disconnect();broadcast('state',snapshot());res.json(result);}));
 app.get('/api/notifications/pending',(req,res)=>res.json({notifications:notifications.pending().map(notification=>({...notification,language:config.language}))}));
 app.post('/api/notifications/:id/ack',(req,res)=>res.json(notifications.acknowledge(req.params.id)));
 app.post('/api/voice-key',async(req,res)=>{if(cached.call)throw Error('End the call before changing its API key');await voiceKeys.set(req.body.key);broadcast('state',snapshot());res.json({ok:true,key:voiceKeys.status()});});
 app.delete('/api/voice-key',async(req,res)=>{if(cached.call)throw Error('End the call before removing its API key');await voiceKeys.clear();broadcast('state',snapshot());res.json({ok:true,key:voiceKeys.status()});});
 app.post('/api/call',async(req,res,next)=>{if(req.body.provider==='api'){const key=await voiceKeys.get();if(!key)throw Error('Configure the optional voice API key first');req.body={...req.body,apiKey:key};}next();});
 app.patch('/api/settings',async(req,res,next)=>{
  const body={...req.body};if(body.vm&&(cached.active||cached.call||cached.takeover||['human','taking-over'].includes(cached.computer?.status)))throw Object.assign(Error('Stop active work and return computer control before changing its connection'),{status:409});const appearance=validateAppearancePatch(body);for(const key of ['language','notifications','showWorkSummary'])if(body[key]!==undefined){if(key==='language'&&!['zh','en'].includes(body[key]))throw Error('Invalid language');if(key==='notifications'&&typeof body[key]!=='boolean')throw Error('Invalid notification preference');if(key==='showWorkSummary'&&typeof body[key]!=='boolean')throw Error('Invalid work summary preference');}
  if(body.vm){const old=binding(),vm=normalizeVmBinding({...old,...Object.fromEntries(['host','user','port','keyPath','knownHosts'].filter(key=>body.vm[key]!==undefined).map(key=>[key,body.vm[key]]))},dataDir),temporary=path.join(dataDir,`.vm-settings-${randomUUID()}.tmp`);try{fs.writeFileSync(temporary,JSON.stringify(vm,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,path.join(dataDir,'vm.json'));}finally{fs.rmSync(temporary,{force:true});}try{profiles.registerCurrent();}catch{}profileError=null;bridge.disconnect();delete body.vm;}
  Object.assign(config,appearance);for(const key of appearanceKeys)delete body[key];for(const key of ['language','notifications','showWorkSummary'])if(body[key]!==undefined){config[key]=body[key];if(key!=='language'||bridge.status!=='online')delete body[key];}
  fs.writeFileSync(configFile,JSON.stringify(config,null,2));notifications.configure(config.notifications);broadcast('state',snapshot());
  const forwardingScope=JSON.stringify([bridge.generation??null,binding()]);
  if(body.language!==undefined){delete body.language;await syncPreferences({retry:true});}
  if(Object.keys(body).length){if(closing||forwardingScope!==JSON.stringify([bridge.generation??null,binding()]))throw Object.assign(Error('The VM connection changed before its settings could be updated.'),{status:409});req.body=body;return next();}res.json({ok:true});
 });
 app.use('/api',async(req,res,next)=>{
  let failed;
  try{
   const route=new URL(req.originalUrl,'http://localhost');route.searchParams.delete('token');
   if(req.method==='POST'&&route.pathname==='/api/messages'&&Object.hasOwn(req.body??{},'workReply')){
    const scope=JSON.stringify([bridge.generation??null,binding()]);
    if(bridge.status!=='online')throw Object.assign(Error('Reconnect before replying to this task.'),{status:409});
    const current=await bridge.refresh(true);
    if(closing||bridge.status!=='online'||scope!==JSON.stringify([bridge.generation??null,binding()])||current?.capabilities?.workReply!==true)throw Object.assign(Error('Update the work computer service before replying to a task.'),{status:409,code:'service_update_required'});
   }
   const scheduleId=/^\/api\/schedules\/([^/]+)$/.exec(route.pathname)?.[1],knownSchedule=scheduleId?cached.schedules?.find(item=>item.id===decodeURIComponent(scheduleId)):null;
   if(['POST','PATCH','DELETE'].includes(req.method)&&/^\/api\/schedules(?:\/[^/]+)?$/.test(route.pathname)&&(['cron','priority'].some(key=>Object.hasOwn(req.body??{},key))||knownSchedule?.cron||knownSchedule?.priority&&knownSchedule.priority!=='normal')){
    const scope=JSON.stringify([bridge.generation??null,binding()]);
    if(bridge.status!=='online')throw Object.assign(Error('Reconnect before changing this scheduled task.'),{status:409});
    const current=await bridge.refresh(true);
    if(closing||bridge.status!=='online'||scope!==JSON.stringify([bridge.generation??null,binding()])||current?.capabilities?.recurringSchedules!==true)throw Object.assign(Error('Update the work computer service before using recurring schedules and priorities.'),{status:409,code:'service_update_required'});
   }
   const headers={};if(req.headers['content-type'])headers['Content-Type']=req.headers['content-type'];
   const options={method:req.method,headers};
   if(!['GET','HEAD'].includes(req.method)){if(req.is('application/json'))options.body=JSON.stringify(req.body??{});else{options.body=req;options.duplex='half';}}
   const response=await bridge.request(route.pathname+route.search,options);res.status(response.status);
   for(const name of ['content-type','content-disposition','cache-control','x-content-type-options'])if(response.headers.has(name))res.setHeader(name,response.headers.get(name));
   if(response.body)Readable.fromWeb(response.body).on('error',error=>{if(!res.headersSent)next(error);else res.destroy();}).pipe(res);else res.end();
  }catch(error){failed=error;next(error);}finally{req.updateInstallDone?.(failed);}
 });
 app.use(express.static(path.join(projectRoot,'dist')));
 app.use((error,req,res,next)=>{req.updateInstallDone?.(error);if(res.headersSent)return next(error);res.status(error.status||400).json({error:error.message,...(typeof error.code==='string'&&/^[a-z_]{1,64}$/.test(error.code)?{code:error.code}:{}),...(error.unknownOutcome?{unknownOutcome:true}: {})});});
 let closePromise;
 return {app,server,bridge,provisioning,profiles,notifications,voiceKeys,diagnostics,updates,snapshot,start:async()=>{const progress=provisioning.resumeMonitoring();if(!prepareOnly&&binding().host&&!progress.running&&!['preparing','creating','installing','awaiting-admin'].includes(progress.status))await connect();},close:()=>{if(closePromise)return closePromise;closing=true;preferenceSync?.abort.abort();preferenceSync=null;updateLease.close();updates.close();clearTimeout(saveTimer);try{if(bridge.cached)saveCache();}catch{}bridge.close();provisioning.close();for(const stream of streams)stream.end();streams.clear();for(const client of wss.clients)client.terminate();wss.close();closePromise=new Promise(resolve=>{if(server.listening)server.close(resolve);else resolve();}).finally(()=>{diagnostics.log('service.closed',{version});diagnostics.close();});return closePromise;}};
}
