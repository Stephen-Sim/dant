import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {WebSocketServer} from 'ws';
import {VmBridge} from './vm-bridge.mjs';
import {Provisioning} from './provisioning.mjs';
import {sshArgs} from './worker.mjs';
import {NotificationHub} from './notifications.mjs';
import {createSecretStore} from './secrets.mjs';

const parse=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const allowedOrigin=origin=>!origin||/^https?:\/\/(127\.0\.0\.1|localhost)(:431[78])?$/.test(origin)||origin==='http://tauri.localhost'||origin==='tauri://localhost';
const emptyState=()=>({messages:[],memory:'',settings:{language:'zh',voice:'marin',model:'',notifications:true,vm:{host:'',user:'dant',port:22,keyPath:'',knownHosts:''}},worker:{status:'offline',account:null,models:[],realtime:{available:false,reason:'vm-offline',key:{configured:false}}},active:null,queue:[],takeover:false,call:null,schedules:[]});

// No Store, Engine, LocalWorker, user command, or authoritative conversation file
// is constructed by this process. The JSON here is explicitly an offline cache.
export function createControllerApp({dataDir,projectRoot,prepareOnly=false,bridgeFactory=options=>new VmBridge(options),provisioningFactory=options=>new Provisioning(options),secretFactory=dir=>createSecretStore(dir)}={}){
 fs.mkdirSync(dataDir,{recursive:true});const configFile=path.join(dataDir,'controller.json'),cacheFile=path.join(dataDir,'state-cache.json');
 let config={language:'zh',notifications:false};try{config={...config,...parse(configFile)};}catch{}
 let cached=emptyState();try{cached=parse(cacheFile);}catch{}
 const bridge=bridgeFactory({dataDir,projectRoot}),provisioning=provisioningFactory({projectRoot,dataDir});
 const notifications=new NotificationHub(dataDir),voiceKeys=secretFactory(dataDir);notifications.configure(config.notifications);
 const app=express(),server=http.createServer(app),token=randomBytes(32).toString('hex'),wss=new WebSocketServer({noServer:true,maxPayload:1024*1024}),streams=new Set();let closing=false,lastSaved=0,saveTimer;
 app.disable('x-powered-by');
 app.use((req,res,next)=>{const hostname=req.headers.host?.split(':')[0];if(!['127.0.0.1','localhost'].includes(hostname)||!allowedOrigin(req.headers.origin))return res.sendStatus(403);if(req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Dant-Token');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');}if(req.method==='OPTIONS')return res.sendStatus(204);next();});
 app.use(express.json({limit:'2mb'}));app.get('/api/session',(req,res)=>res.json({token,product:'dant',mode:'controller'}));
 app.use('/api',(req,res,next)=>req.headers['x-dant-token']===token||req.query.token===token?next():res.sendStatus(401));
 function binding(){try{return parse(path.join(dataDir,'vm.json'));}catch{return {};}}
 function snapshot(){const state=structuredClone(cached),key=voiceKeys.status();state.mode='vm-controller';state.settings={...emptyState().settings,...state.settings,language:config.language,notifications:config.notifications,vm:{...emptyState().settings.vm,...binding()}};state.worker={...state.worker,status:bridge.status==='online'?state.worker?.status||'connecting':bridge.status,error:bridge.error||state.worker?.error||null,realtime:{...state.worker?.realtime,key,api:{available:key.configured,billing:'api'}}};state.provisioning=provisioning.snapshot();state.controller={status:bridge.status,authority:'vm',cached:bridge.status!=='online',updatedAt:lastSaved||null,error:bridge.error||null};return state;}
 function broadcast(type,data){if(closing)return;const body=JSON.stringify({type,data});for(const client of wss.clients)if(client.readyState===1)client.send(body);for(const stream of streams)stream.write(`data: ${body}\n\n`);}
 function saveCache(){clearTimeout(saveTimer);saveTimer=null;const temporary=cacheFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify(cached));fs.renameSync(temporary,cacheFile);lastSaved=Date.now();}
 bridge.on('state',state=>{cached=state;notifications.observe(state);if(!saveTimer)saveTimer=setTimeout(()=>{try{saveCache();}catch{broadcast('notice',{message:'The VM state is available, but its Windows cache could not be saved.'});}},2000);broadcast('state',snapshot());});
 bridge.on('change',()=>broadcast('state',snapshot()));bridge.on('event',event=>broadcast(event.type,event.data));
 let provisioningStatus=provisioning.snapshot().status;
 provisioning.on('change',progress=>{broadcast('state',snapshot());if(!prepareOnly&&progress.status==='ready'&&provisioningStatus!=='ready')void bridge.connect().catch(error=>broadcast('notice',{message:error.message}));provisioningStatus=progress.status;});
 server.on('upgrade',(req,socket,head)=>{let url;try{url=new URL(req.url,'http://localhost');}catch{socket.destroy();return;}if(url.pathname!=='/events'||url.searchParams.get('token')!==token||!allowedOrigin(req.headers.origin)){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
 wss.on('connection',ws=>ws.send(JSON.stringify({type:'state',data:snapshot()})));
 app.get('/api/events',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.flushHeaders();streams.add(res);res.write(`data: ${JSON.stringify({type:'state',data:snapshot()})}\n\n`);const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);heartbeat.unref();req.on('close',()=>{clearInterval(heartbeat);streams.delete(res);});});
 app.get('/api/state',async(req,res)=>{if(bridge.status==='online')try{await bridge.refresh();}catch(error){bridge.error=error.message;}res.json(snapshot());});
 app.post('/api/provision',(req,res)=>res.json(provisioning.start(req.body)));
 app.post('/api/connect',async(req,res)=>{await bridge.connect();res.json({ok:true});});
 app.post('/api/prepare',async(req,res)=>{await bridge.prepare();res.json({ok:true});});
 app.get('/api/notifications/pending',(req,res)=>res.json({notifications:notifications.pending()}));
 app.post('/api/notifications/:id/ack',(req,res)=>res.json(notifications.acknowledge(req.params.id)));
 app.post('/api/voice-key',async(req,res)=>{if(cached.call)throw Error('End the call before changing its API key');await voiceKeys.set(req.body.key);broadcast('state',snapshot());res.json({ok:true,key:voiceKeys.status()});});
 app.delete('/api/voice-key',async(req,res)=>{if(cached.call)throw Error('End the call before removing its API key');await voiceKeys.clear();broadcast('state',snapshot());res.json({ok:true,key:voiceKeys.status()});});
 app.post('/api/call',async(req,res,next)=>{if(req.body.provider==='api'){const key=await voiceKeys.get();if(!key)throw Error('Configure the optional voice API key first');req.body={...req.body,apiKey:key};}next();});
 app.patch('/api/settings',async(req,res,next)=>{
  const body={...req.body};if(body.vm){const old=binding(),vm={...old,...Object.fromEntries(['host','user','port','keyPath','knownHosts'].filter(key=>body.vm[key]!==undefined).map(key=>[key,body.vm[key]]))};vm.port=Number(vm.port||22);vm.knownHosts||=path.join(dataDir,'known_hosts');sshArgs(vm);fs.writeFileSync(path.join(dataDir,'vm.json'),JSON.stringify(vm,null,2));bridge.disconnect();delete body.vm;}
  for(const key of ['language','notifications'])if(body[key]!==undefined){if(key==='language'&&!['zh','en'].includes(body[key]))throw Error('Invalid language');if(key==='notifications'&&typeof body[key]!=='boolean')throw Error('Invalid notification preference');config[key]=body[key];delete body[key];}
  fs.writeFileSync(configFile,JSON.stringify(config,null,2));notifications.configure(config.notifications);broadcast('state',snapshot());
  if(Object.keys(body).length){req.body=body;return next();}res.json({ok:true});
 });
 app.use('/api',async(req,res,next)=>{
  try{
   const route=new URL(req.originalUrl,'http://localhost');route.searchParams.delete('token');
   const headers={};if(req.headers['content-type'])headers['Content-Type']=req.headers['content-type'];
   const options={method:req.method,headers};
   if(!['GET','HEAD'].includes(req.method)){if(req.is('application/json'))options.body=JSON.stringify(req.body??{});else{options.body=req;options.duplex='half';}}
   const response=await bridge.request(route.pathname+route.search,options);res.status(response.status);
   for(const name of ['content-type','content-disposition','cache-control','x-content-type-options'])if(response.headers.has(name))res.setHeader(name,response.headers.get(name));
   if(response.body)Readable.fromWeb(response.body).on('error',error=>{if(!res.headersSent)next(error);else res.destroy();}).pipe(res);else res.end();
  }catch(error){next(error);}
 });
 app.use(express.static(path.join(projectRoot,'dist')));
 app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status||400).json({error:error.message,...(error.unknownOutcome?{unknownOutcome:true}: {})});});
 let closePromise;
 return {app,server,bridge,provisioning,notifications,voiceKeys,snapshot,start:async()=>{const progress=provisioning.resumeMonitoring();if(!prepareOnly&&binding().host&&!progress.running&&['idle','ready'].includes(progress.status))await bridge.connect();},close:()=>{if(closePromise)return closePromise;closing=true;clearTimeout(saveTimer);try{if(bridge.cached)saveCache();}catch{}bridge.close();provisioning.close();for(const stream of streams)stream.end();streams.clear();for(const client of wss.clients)client.terminate();wss.close();closePromise=new Promise(resolve=>{if(server.listening)server.close(resolve);else resolve();});return closePromise;}};
}
