// WebView document visibility alone is not a reliable Windows minimize signal.
// This guard never reads chat content or changes a receipt by itself.
export function createReadVisibility({desktop=false,onChange=()=>{},loadWindow=()=>import('@tauri-apps/api/window'),window=globalThis.window}={}){
 let visible=!desktop,closed=false,generation=0,api=null;const stops=[];
 const publish=value=>{if(closed||visible===value)return;visible=value;onChange(value);};
 async function refresh(){
  if(closed||!api)return;const current=++generation;
  try{const [minimized,focused]=await Promise.all([api.isMinimized(),api.isFocused()]);if(!closed&&current===generation)publish(minimized===false&&focused===true);}
  catch{if(!closed&&current===generation)publish(false);}
 }
 function dispose(){if(closed)return;closed=true;generation++;visible=false;for(const stop of stops)stop();stops.length=0;window?.removeEventListener?.('beforeunload',dispose);}
 if(desktop){
  window?.addEventListener?.('beforeunload',dispose);
  void Promise.resolve().then(loadWindow).then(async module=>{
   if(closed)return;api=module.getCurrentWindow();
   const subscriptions=await Promise.allSettled([
    api.onFocusChanged(event=>{generation++;publish(false);if(event.payload===true)void refresh();}),
    api.onResized(()=>{publish(false);void refresh();})
   ]);
   for(const result of subscriptions)if(result.status==='fulfilled'){if(closed)result.value();else stops.push(result.value);}
   if(subscriptions.some(result=>result.status==='rejected')){generation++;api=null;publish(false);return;}
   await refresh();
  }).catch(()=>publish(false));
 }
 return {get visible(){return visible;},refresh,dispose};
}
