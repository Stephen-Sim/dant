import express from 'express';
import multer from 'multer';
import {WebSocketServer} from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';
import {Store} from './store.mjs';
import {Worker} from './worker.mjs';
import {Engine} from './engine.mjs';
import {Provisioning} from './provisioning.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createApp({dataDir=process.env.DANT_DATA||path.join(root,'data'),workerFactory=s=>new Worker(s)}={}){
 const store=new Store(dataDir),worker=workerFactory(store),engine=new Engine(store,worker),app=express(),server=http.createServer(app);
 const provisioning=new Provisioning({projectRoot:root,dataDir});
 const importBinding=()=>{const binding=path.join(dataDir,'vm.json');if(!store.state.settings.vm.host&&fs.existsSync(binding)){Object.assign(store.state.settings.vm,JSON.parse(fs.readFileSync(binding,'utf8').replace(/^\uFEFF/,'')));store.save();}};
 importBinding();
 const files=path.join(dataDir,'files');fs.mkdirSync(files,{recursive:true});
 const token=randomBytes(32).toString('hex');
 app.disable('x-powered-by');
 app.use((req,res,next)=>{const host=req.headers.host?.split(':')[0];if(!['127.0.0.1','localhost'].includes(host))return res.sendStatus(403);const origin=req.headers.origin;if(origin&&!/^https?:\/\/(127\.0\.0\.1|localhost)(:431[78])?$/.test(origin)&&origin!=='http://tauri.localhost'&&origin!=='tauri://localhost')return res.sendStatus(403);if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Dant-Token');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');}if(req.method==='OPTIONS')return res.sendStatus(204);next();});
 app.use(express.json({limit:'2mb'}));
 app.get('/api/session',(req,res)=>res.json({token}));
 app.use('/api',(req,res,next)=>{if(req.headers['x-dant-token']!==token&&req.query.token!==token)return res.sendStatus(401);next();});
 const snapshot=()=>({messages:store.state.messages,memory:store.state.memory,settings:store.state.settings,worker:{status:worker.status,error:worker.error||null,account:worker.account?.account,models:worker.models?.data||[]},active:engine.active,queue:engine.queue.map(m=>m.id),takeover:engine.takeover,call:engine.call,schedules:store.state.schedules,provisioning:provisioning.snapshot()});
 const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
 server.on('upgrade',(req,socket,head)=>{const url=new URL(req.url,'http://localhost');if(url.pathname!=='/events'||url.searchParams.get('token')!==token){socket.destroy();return;}const origin=req.headers.origin;if(origin&&!/^http:\/\/(127\.0\.0\.1|localhost):431[78]$/.test(origin)&&origin!=='http://tauri.localhost'&&origin!=='tauri://localhost'){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
 const broadcast=(type,data)=>{const payload=JSON.stringify({type,data});for(const ws of wss.clients)if(ws.readyState===1)ws.send(payload);};
 let broadcastTimer,closing=false,lastProvisionStatus=provisioning.snapshot().status;engine.on('change',()=>{if(closing)return;clearTimeout(broadcastTimer);broadcastTimer=setTimeout(()=>broadcast('state',snapshot()),60);});engine.on('notice',message=>broadcast('notice',{message}));engine.on('realtime',e=>broadcast('realtime',e));
 provisioning.on('change',progress=>{if(closing)return;importBinding();engine.change();if(progress.status==='ready'&&lastProvisionStatus!=='ready'&&!engine.active&&!engine.call){engine.loaded=false;worker.connect().catch(e=>engine.emit('notice',e.message));}lastProvisionStatus=progress.status;});
 wss.on('connection',ws=>ws.send(JSON.stringify({type:'state',data:snapshot()})));
 app.get('/api/state',(req,res)=>res.json(snapshot()));
 app.post('/api/provision',(req,res)=>{if(engine.active||engine.call)throw Error('Stop active work first');res.json(provisioning.start(req.body));});
 app.post('/api/connect',async(req,res)=>{if(engine.active||engine.call)throw Error('Stop active work first');importBinding();engine.loaded=false;await worker.connect();engine.change();res.json({ok:true});});
 app.post('/api/login',async(req,res)=>res.json(await worker.request('account/login/start',{type:'chatgptDeviceCode'})));
 app.post('/api/logout',async(req,res)=>{if(engine.active||engine.call)throw Error('Stop active work first');await worker.request('account/logout',{});res.json({ok:true});});
 app.patch('/api/settings',(req,res)=>{const b=req.body,s=store.state.settings;if((engine.active||engine.call)&&(b.vm||b.model!==undefined||b.voice!==undefined))throw Error('Stop active work first');if(['zh','en'].includes(b.language))s.language=b.language;if(typeof b.notifications==='boolean')s.notifications=b.notifications;if(typeof b.voice==='string'&&/^[a-z]+$/.test(b.voice))s.voice=b.voice;if(typeof b.model==='string'&&b.model.length<120)s.model=b.model;if(b.vm){for(const k of ['host','user','port','keyPath'])if(b.vm[k]!==undefined)s.vm[k]=b.vm[k];worker.disconnect();engine.loaded=false;}store.save();engine.change();res.json({ok:true});});
 app.post('/api/messages',(req,res)=>{const text=String(req.body.text||'').trim();const attachments=(req.body.attachments||[]).map(id=>{const item=uploadIndex.get(id);if(!item)throw Error('Attachment expired; please upload again');return item;});if(!text&&!attachments.length)return res.status(400).json({error:'Empty message'});if(text.length>100000)return res.sendStatus(413);if(worker.status!=='online')return res.status(409).json({error:'请先在设置中连接工作电脑 / Connect your VM in settings first'});const m=store.add({role:'user',text,attachments,replyTo:req.body.replyTo||null,status:'queued'});engine.enqueue(m);res.json(m);});
 app.post('/api/messages/:id/reaction',(req,res)=>{const emoji=req.body.emoji;if(!['👍','❤️','😂','👀','🎉'].includes(emoji))return res.sendStatus(400);const m=store.state.messages.find(m=>m.id===req.params.id);if(!m)return res.sendStatus(404);store.update(m.id,{reactions:m.reactions.includes(emoji)?m.reactions.filter(x=>x!==emoji):[...m.reactions,emoji]});engine.change();res.json({ok:true});});
 app.post('/api/read',(req,res)=>{const ids=new Set(req.body.ids||[]);for(const m of store.state.messages)if(ids.has(m.id))m.read=true;store.save();engine.change();res.json({ok:true});});
 app.post('/api/retry/:id',(req,res)=>{const m=store.state.messages.find(x=>x.id===req.params.id);if(!m||m.role!=='user'||!['failed','interrupted'].includes(m.status))return res.sendStatus(409);store.update(m.id,{status:'queued',error:null});engine.enqueue(m);res.json({ok:true});});
 app.post('/api/stop',async(req,res)=>{engine.queue.splice(0).forEach(m=>store.update(m.id,{status:'interrupted'}));await engine.interrupt();engine.change();res.json({ok:true});});
 app.post('/api/takeover',async(req,res)=>{if(req.body.enabled)await engine.acquire();else engine.release();res.json({ok:true});});
 app.get('/api/screen',async(req,res)=>{const r=await worker.guest('/screen');res.type('png').send(Buffer.from(await r.arrayBuffer()));});
 app.post('/api/input',async(req,res)=>{if(!engine.takeover)return res.sendStatus(409);await worker.guest('/input',req.body);res.json({ok:true});});
 const uploadIndex=new Map();const upload=multer({dest:files,limits:{fileSize:25*1024*1024,files:1}});
 app.post('/api/upload',upload.single('file'),async(req,res)=>{if(!req.file)return res.sendStatus(400);try{const guest=await worker.upload(req.file);const item={id:path.basename(req.file.path),name:req.file.originalname,type:req.file.mimetype,size:req.file.size,guestPath:guest.path};uploadIndex.set(item.id,item);res.json(item);}catch(e){fs.unlinkSync(req.file.path);throw e;}});
 app.get('/api/files/:id',(req,res)=>{if(!/^[a-zA-Z0-9-]+$/.test(req.params.id))return res.sendStatus(400);const attachment=store.state.messages.flatMap(m=>m.attachments||[]).find(a=>a.id===req.params.id)||uploadIndex.get(req.params.id);if(!attachment)return res.sendStatus(404);const safeInline=/^(image\/(png|jpeg|gif|webp)|audio\/(mpeg|wav|ogg|webm))$/.test(attachment.type);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Type',safeInline?attachment.type:'application/octet-stream');if(!safeInline)res.attachment(attachment.name);res.sendFile(path.join(files,req.params.id));});
 engine.deliverFile=async guestPath=>{const r=await worker.guest('/read-file',{path:guestPath});const result=await r.json();const id=randomUUID();fs.writeFileSync(path.join(files,id),Buffer.from(result.data,'base64'));const item={id,name:result.name,type:result.type,size:result.size};store.add({role:'assistant',text:'',attachments:[item],status:'completed'});engine.change();return {sent:true,name:item.name};};
 app.post('/api/call',async(req,res)=>res.json(await engine.startCall(req.body.sdp)));
 app.post('/api/call/stop',async(req,res)=>{await engine.stopCall();res.json({ok:true});});
 app.get('/api/voices',async(req,res)=>res.json(await worker.request('thread/realtime/listVoices',{})));
 app.post('/api/schedules',(req,res)=>{const {text,at}=req.body;if(typeof text!=='string'||!text.trim()||!Number.isFinite(at)||at<=Date.now())return res.sendStatus(400);const item={id:randomUUID(),text,at,status:'pending'};store.state.schedules.push(item);store.save();engine.change();res.json(item);});
 app.delete('/api/schedules/:id',(req,res)=>{store.state.schedules=store.state.schedules.filter(s=>s.id!==req.params.id);store.save();engine.change();res.json({ok:true});});
 const scheduler=setInterval(()=>{if(worker.status!=='online')return;for(const s of store.state.schedules){if(s.status==='pending'&&s.at<=Date.now()){s.status='dispatched';const m=store.add({role:'user',text:s.text,status:'queued',scheduled:true});engine.enqueue(m);}}},1000);scheduler.unref();
 app.use(express.static(path.join(root,'dist')));
 app.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(400).json({error:err.message});});
 return {app,server,store,worker,engine,provisioning,close:()=>{closing=true;provisioning.close();clearInterval(scheduler);clearTimeout(broadcastTimer);worker.disconnect();for(const ws of wss.clients)ws.terminate();wss.close();server.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const instance=createApp();const port=Number(process.env.DANT_PORT||4317);instance.server.listen(port,'127.0.0.1',()=>{
  console.log(`dant listening at http://127.0.0.1:${port}`);
  const progress=instance.provisioning.resumeMonitoring();
  if(instance.store.state.settings.vm.host&&!progress.running&&['idle','ready'].includes(progress.status))instance.worker.connect().catch(e=>instance.engine.emit('notice',e.message));
 });
 process.on('SIGTERM',()=>{instance.close();process.exit();});process.on('SIGINT',()=>{instance.close();process.exit();});
 if(process.env.DANT_MANAGED){process.stdin.resume();process.stdin.on('end',()=>{instance.close();process.exit();});}
}
