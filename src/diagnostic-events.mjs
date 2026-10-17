const fixedRoutes=new Set(['session','state','events','diagnostics','version','updates','settings','connect','prepare','provision','login','logout','voice-key','messages','realtime/message','memory','read','stop','tasks/pause','tasks/resume','steer','takeover','screen','input','upload','call','call/connected','call/stop','voices','schedules','credentials','skills','history','fonts','vm/profiles','vm/providers','vm/import','notifications/pending','telegram','telegram/config','telegram/pair','telegram/disconnect','internal/credentials'].map(route=>'/api/'+route));
const variableRoutes=[[/^\/api\/messages\/[^/]+\/reaction$/,'/api/messages/:id/reaction'],[/^\/api\/messages\/[^/]+$/,'/api/messages/:id'],[/^\/api\/credentials\/requests\/[^/]+$/,'/api/credentials/requests/:id'],[/^\/api\/credentials\/[^/]+$/,'/api/credentials/:id'],[/^\/api\/skills\/[^/]+$/,'/api/skills/:name'],[/^\/api\/memory\/[^/]+$/,'/api/memory/:name'],[/^\/api\/files\/[^/]+$/,'/api/files/:id'],[/^\/api\/retry\/[^/]+$/,'/api/retry/:id'],[/^\/api\/tasks\/[^/]+\/accept$/,'/api/tasks/:id/accept'],[/^\/api\/schedules\/[^/]+$/,'/api/schedules/:id'],[/^\/api\/notifications\/[^/]+\/ack$/,'/api/notifications/:id/ack']];
export function diagnosticRoute(url){const route=String(url||'').split('?')[0];if(fixedRoutes.has(route))return route;for(const [pattern,template]of variableRoutes)if(pattern.test(route))return template;return '/api/:unknown';}
const rpcMethods=new Set(['initialize','account/read','account/login/start','account/logout','model/list','skills/list','thread/start','thread/resume','thread/read','thread/inject_items','thread/realtime/start','thread/realtime/stop','thread/realtime/appendText','thread/realtime/listVoices','turn/start','turn/steer','turn/interrupt']);
export const diagnosticRpcMethod=method=>rpcMethods.has(method)?method:'other';
export function serviceVersion(projectRoot){try{const version=JSON.parse(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8')).version;return typeof version==='string'&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)?version:'unknown';}catch{return 'unknown';}}
const workerStates=new Set(['offline','connecting','online']);
export const diagnosticWorkerStatus=status=>workerStates.has(status)?status:'unknown';
const taskStates=new Set(['draft','queued','running','waiting_user','pausing','paused','failed','review','completed','cancelled','interrupted']);
export function observeTasks(diagnostics,store,engine){
 const states=new Map((store.state.messages||[]).filter(message=>message.role==='user').map(message=>[message.id,message.status]));let call=engine.call?{id:engine.call.id,status:engine.call.status,provider:engine.call.provider}:null;
 return ()=>{const present=new Set();for(const message of store.state.messages||[]){if(message.role!=='user')continue;present.add(message.id);if(states.get(message.id)!==message.status){states.set(message.id,message.status);diagnostics.log('task.status',{messageId:message.id,status:taskStates.has(message.status)?message.status:'unknown'});}}for(const id of states.keys())if(!present.has(id))states.delete(id);
  const current=engine.call;if(call&&call.id!==current?.id)diagnostics.log('call.closed',{callId:call.id,provider:['api','subscription'].includes(call.provider)?call.provider:'unknown'});
  if(current&&(!call||call.id!==current.id||call.status!==current.status))diagnostics.log('call.status',{callId:current.id,provider:['api','subscription'].includes(current.provider)?current.provider:'unknown',status:['starting','negotiating','connected','stopping','stop-unconfirmed'].includes(current.status)?current.status:'unknown'});
  call=current?{id:current.id,status:current.status,provider:current.provider}:null;
 };
}
export function observeHttp(diagnostics,{now=()=>performance.now(),slowMs=2000}={}){
 return (req,res,next)=>{
  const url=String(req.originalUrl||req.url||'');if(url!=='/api'&&!url.startsWith('/api/'))return next();
  const start=now(),route=diagnosticRoute(url),method=['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(req.method)?req.method:'OTHER';let completed=false;
  const record=aborted=>{
   if(completed)return;completed=true;res.removeListener('finish',finished);res.removeListener('close',closed);
   const durationMs=Math.max(0,Math.round(now()-start)),status=aborted?499:res.statusCode;
   if(!aborted&&status<400&&(durationMs<slowMs||route==='/api/events'))return;
   const reason=aborted?'client-aborted':status>=500?'server-error':status===401?'unauthorized':status===403?'forbidden':status===404?'not-found':status===409?'conflict':status===413?'too-large':status>=400?'request-rejected':'slow-request';
   diagnostics.log('http.request',{method,route,status,durationMs,reason});
  };
  const finished=()=>record(false),closed=()=>record(true);res.once('finish',finished);res.once('close',closed);next();
 };
}
import fs from 'node:fs';
import path from 'node:path';

