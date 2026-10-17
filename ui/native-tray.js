const taskStates=new Set(['waiting_user','pausing','unknown']);
export function trayStatus(state={}){
 const bridge=state.controller?.status,disconnected=state.controller?.cached===true||(bridge!==undefined&&bridge!=='online');
 const connection=!disconnected&&state.worker?.status==='online'?'online':bridge==='connecting'||(!disconnected&&state.worker?.status==='connecting')?'connecting':'offline';
 const active=state.active,task=active?(taskStates.has(active.status)?active.status:active.background?'background':'running'):'idle';
 return {language:state.settings?.language==='en'?'en':'zh',connection,task,queued:Math.min(999,Array.isArray(state.queue)?state.queue.length:0)};
}
export function createNativeTray({desktop=false,onProgress=()=>{},loadCore=()=>import('@tauri-apps/api/core'),loadEvents=()=>import('@tauri-apps/api/event')}={}){
 let latest=null,last='',ready=null,unlisten=null,closed=false,sending=false;
 function initialize(){return ready ||= Promise.all([loadCore(),loadEvents()]).then(async([core,events])=>{const stop=await events.listen('dant-tray-progress',()=>{if(!closed)onProgress();});if(closed)stop();else unlisten=stop;return core;}).catch(error=>{ready=null;throw error;});}
 async function flush(){
  if(sending||closed||!desktop)return;sending=true;let attempted=JSON.stringify(latest);
  try{const core=await initialize();while(!closed){const current=JSON.stringify(latest);attempted=current;if(current!==last){await core.invoke('tray_status_update',{status:latest});last=current;}if(current===JSON.stringify(latest))break;}}
  catch{/* An unavailable tray leaves ordinary window close available. */}
  finally{sending=false;if(!closed&&JSON.stringify(latest)!==attempted)void flush();}
 }
 function sync(state){if(closed||!desktop)return;latest=trayStatus(state);void flush();}
 function dispose(){if(closed)return;closed=true;unlisten?.();unlisten=null;}
 return {sync,dispose};
}
