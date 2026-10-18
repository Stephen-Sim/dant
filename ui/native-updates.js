const version=value=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
const key=asset=>asset&&['stable','beta'].includes(asset.channel)&&version(asset.version)&&/^[a-f0-9]{64}$/.test(asset.sha256||'')&&Number.isSafeInteger(asset.size)&&asset.size>0&&asset.size<=512*1024*1024&&asset.name===`dant_${asset.version}_windows_x64_setup.exe`?`${asset.channel}:${asset.version}:${asset.sha256}`:null;
const same=(asset,result)=>result?.version===asset.version&&result?.channel===asset.channel&&result?.sha256===asset.sha256&&result?.name===asset.name&&result?.size===asset.size;
export function createNativeUpdates({desktop=false,getToken=()=>'',loadCore=()=>import('@tauri-apps/api/core'),loadEvents=()=>import('@tauri-apps/api/event')}={}){
 let closed=false,installing=false,installSupported=false,corePromise=null,readyPromise=null,eventPromise=null,unlisten=null;
 const pending=new Map(),packages=new Map(),listeners=new Map();
 const core=()=>corePromise||=(loadCore());
 const token=()=>{const value=getToken();if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))throw Error('The local update session is unavailable.');return value;};
 function ready(){return readyPromise||=(async()=>{if(!desktop||closed)return;try{const api=await core(),result=await api.invoke('update_capabilities');if(!closed)installSupported=result?.install===true&&result?.download===true;}catch{installSupported=false;}})();}
 function events(){return eventPromise||=(async()=>{const api=await loadEvents();const stop=await api.listen('dant-update-progress',event=>{if(closed)return;const result=event?.payload;if(!result||!['downloading','ready','failed'].includes(result.status))return;const id=`${result.channel}:${result.version}:${result.sha256}`,entry=listeners.get(id);if(!entry||result.total!==entry.asset.size||!Number.isSafeInteger(result.received)||result.received<0||result.received>result.total)return;for(const callback of entry.callbacks)try{callback({...result});}catch{}});if(closed)stop();else unlisten=stop;})();}
 async function download(asset,onProgress=()=>{}){
  const selected={...asset},id=key(selected);if(!desktop||closed||!id)throw Error('The verified update download is unavailable.');let entry=listeners.get(id);if(!entry){entry={asset:selected,callbacks:new Set()};listeners.set(id,entry);}entry.callbacks.add(onProgress);
  if(packages.has(id))return packages.get(id);
  if(pending.has(id))return pending.get(id);
  const operation=(async()=>{await events();if(closed)throw Error('The update view is closed.');const api=await core(),result=await api.invoke('download_update',{channel:selected.channel,token:token(),expectedVersion:selected.version});if(!result?.ready||!same(selected,result)||!/^[a-f0-9]{64}$/.test(result.packageId||'')||result.packageId!==selected.sha256)throw Error('The update package identity changed. Check for updates again.');packages.set(id,result);return result;})().finally(()=>pending.delete(id));pending.set(id,operation);return operation;
 }
 async function install(asset){
  const id=key(asset),item=packages.get(id);await ready();if(!desktop||closed||!installSupported||!item||installing)throw Error('The verified update installation is unavailable.');installing=true;
  try{const api=await core(),result=await api.invoke('install_update',{packageId:item.packageId,token:token()});if(result?.launched!==true)throw Error('The update handoff was not confirmed.');return result;}finally{installing=false;}
 }
 function dispose(){closed=true;installSupported=false;unlisten?.();unlisten=null;listeners.clear();}
 return {available:desktop===true,get installSupported(){return installSupported;},ready,download,install,dispose};
}
