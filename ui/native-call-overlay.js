const actions=new Set(['mute','hangup','restore']),statuses=new Set(['calling','talking','recovering','stopping']);
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_:.-]{1,128}$/.test(value);
export function createNativeCallOverlay({desktop=false,onAction=()=>{},onError=()=>{},loadCore=()=>import('@tauri-apps/api/core'),loadEvents=()=>import('@tauri-apps/api/event'),window=globalThis.window,document=globalThis.document,MutationObserver=globalThis.MutationObserver}={}){
 let latest=null,closed=false,revision=0,queued=false,unlisten=null,observer=null,lastSent='',ready=null,sending=Promise.resolve(),reported=false;const seen=new Set();
 const report=()=>{if(reported)return;reported=true;try{onError(Error('The floating call window is unavailable.'));}catch{}};
 function snapshot(value){
  if(!value)return null;if(!identifier(value.callId)||!statuses.has(value.status)||!['en','zh'].includes(value.language)||!['light','dark'].includes(value.theme))return null;
  return {callId:value.callId,status:value.status,connectedAt:Number.isSafeInteger(value.connectedAt)&&value.connectedAt>=0&&value.connectedAt<=8640000000000000?value.connectedAt:null,seconds:Number.isFinite(value.seconds)?Math.min(9007199254740,Math.max(0,Math.floor(value.seconds))):0,confirmed:!!value.confirmed,running:!!value.running,muted:!!value.muted,canMute:!!value.canMute,language:value.language,theme:value.theme};
 }
 async function receive(event){
  const value=event?.payload;if(closed||!latest||!value||value.callId!==latest.callId||!identifier(value.requestId)||!actions.has(value.action)||seen.has(value.requestId))return;
  seen.add(value.requestId);while(seen.size>128)seen.delete(seen.values().next().value);
  if(value.action==='mute'&&(!latest.canMute||typeof value.muted!=='boolean'||latest.muted===value.muted))return;
  try{await onAction({callId:value.callId,action:value.action,...(value.action==='mute'?{muted:value.muted}:{})});}catch{report();}
 }
 function initialize(){
  return ready ||= Promise.all([loadCore(),loadEvents()]).then(async([core,events])=>{const stop=await events.listen('dant-call-overlay-action',receive);if(closed)stop();else unlisten=stop;return core;});
 }
 async function flush(){
  if(queued||closed||!desktop)return;queued=true;let attempted=revision,retry=false;
  try{const core=await initialize();while(!closed){const current=revision,value=latest,encoded=JSON.stringify(value);attempted=current;if(encoded!==lastSent){sending=core.invoke('call_overlay_update',{state:value});await sending;lastSent=encoded;reported=false;}if(current===revision)break;}}
  catch{report();retry=revision!==attempted;}finally{queued=false;if(retry&&!closed)void flush();}
 }
 function update(value){if(closed||!desktop)return;const next=snapshot(value);if(latest?.callId!==next?.callId)seen.clear();latest=next;revision++;void flush();}
 function dispose(){if(closed)return;closed=true;unlisten?.();unlisten=null;observer?.disconnect();observer=null;window?.removeEventListener?.('beforeunload',dispose);if(desktop&&ready)void ready.then(async core=>{await sending.catch(()=>{});return core.invoke('call_overlay_update',{state:null});}).catch(()=>{});latest=null;seen.clear();}
 if(desktop){window?.addEventListener?.('beforeunload',dispose);if(MutationObserver&&document?.documentElement){observer=new MutationObserver(()=>{if(latest){const theme=document.documentElement.dataset.theme;if(['light','dark'].includes(theme)&&theme!==latest.theme)update({...latest,theme});}});observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});}}
 return {update,dispose};
}
