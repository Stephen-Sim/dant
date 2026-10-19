import {localizeMessages} from '../src/i18n.mjs';
const words={
 en:{about:'About dant',version:'Version',channel:'Update channel',stable:'Stable',beta:'Beta',check:'Check for updates',checking:'Checking for updates…',available:'A new version is available',current:'You’re up to date.',failed:'Could not check for updates. Check your connection and try again.',retry:'Try again',download:'Download update',release:'View release',downloading:'Downloading update',ready:'Update ready to install',install:'Install and restart',installing:'Starting installer…',downloadFailed:'The update could not be downloaded or verified. Try again.',installFailed:'The installer was not started. Check the app state and try again.',callBlocked:'End the call before installing. The download can finish in the background.',busyBlocked:'Finish computer control or setup before installing.',offlineBlocked:'Reconnect the local app before installing.',manual:'Downloads run in the background. Installing pauses work, ends calls and suspends a managed VM. Reopening restores the VM and updates its service.',betaHint:'Beta includes preview releases and may be less stable.'},
 zh:{about:'关于 dant',version:'版本',channel:'更新渠道',stable:'正式版',beta:'测试版',check:'检查更新',checking:'正在检查更新…',available:'有新版本可用',current:'已是最新版本。',failed:'无法检查更新，请检查网络连接后重试。',retry:'重试',download:'下载更新',release:'查看版本',downloading:'正在下载更新',ready:'更新已准备好安装',install:'安装并重启',installing:'正在启动安装程序…',downloadFailed:'更新下载或校验失败，请重试。',installFailed:'安装程序尚未启动，请检查应用状态后重试。',callBlocked:'请先结束通话再安装，更新可继续在后台下载。',busyBlocked:'请先结束电脑接管或系统配置，再安装更新。',offlineBlocked:'请先重新连接本地应用，再安装更新。',manual:'更新在后台下载。安装前会暂停任务、结束通话并挂起受管理的 VM；重新打开后恢复 VM 并更新服务。',betaHint:'测试版包含预览功能，稳定性可能较低。'},
};
words.en.unsupported='Automatic installation is unavailable in this app layout. Use the installer on the release page.';
words.zh.unsupported='当前运行方式不支持自动安装，请从版本页面下载安装程序。';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const versionPattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*))*))?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/;
const validVersion=value=>typeof value==='string'&&value.length<=64&&versionPattern.test(value);
const channels=['stable','beta'],storageKey='dant.updateChannel';
const storage=()=>{try{return globalThis.localStorage;}catch{return null;}};
function releaseURL(value){
 if(typeof value!=='string'||value.length>500)return null;
 try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='github.com'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/Stephen-Sim\/dant\/releases\/tag\/v?[0-9A-Za-z.+-]+$/.test(url.pathname)?url.href:null;}catch{return null;}
}
function validatedAsset(value,version,channel,releaseUrl){
 const name=`dant_${version}_windows_x64_setup.exe`;
 if(!value||typeof value!=='object'||value.version!==version||value.channel!==channel||value.name!==name||!Number.isSafeInteger(value.size)||value.size<1||value.size>512*1024*1024||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||value.url!==releaseUrl.replace('/tag/','/download/')+'/'+name)return null;
 return {version,channel,name,size:value.size,sha256:value.sha256,url:value.url};
}
const assetKey=asset=>[asset.channel,asset.version,asset.sha256].join(':');

// Native downloads never use the serialized VM API transport or depend on
// settings visibility. Metadata and the channel preference stay in this app.
export function createUpdates({request,version:buildVersion,getLanguage=()=> 'en',onChange=()=>{},document=globalThis.document,openExternal,onOpenError=()=>{},preferences=storage(),nativeUpdater=null,getInstallState=()=>null,beforeInstall=async()=>{}}){
 let version=validVersion(buildVersion)?buildVersion:'—',visible=false,generation=0,channel='stable',disposed=false;
 try{const saved=preferences?.getItem(storageKey);if(channels.includes(saved))channel=saved;}catch{}
 const entries=new Map(channels.map(key=>[key,{checking:false,status:'idle',result:null}])),downloads=new Map();
 const text=()=>localizeMessages(words,getLanguage()),entry=()=>entries.get(channel),nativeAvailable=()=>nativeUpdater?.available===true,installSupported=()=>nativeUpdater?.installSupported===true,current=(run,selected=channel)=>visible&&!disposed&&generation===run&&channel===selected,changed=()=>{if(!disposed&&visible)onChange();};
 function installBlock(){const state=getInstallState();if(!state||state.mode!=='controller')return 'offlineBlocked';if(state.unsafeLocalInput||state.acquiring||state.computer?.acquiring||state.provisioning&&!['idle','ready','failed'].includes(state.provisioning.status))return 'busyBlocked';return null;}
 async function loadVersion(run){try{const info=await request('/version');if(current(run)&&validVersion(info?.version)){version=info.version;changed();}}catch{}}
 function setVisible(value){value=Boolean(value);if(value===visible)return;visible=value;disposed=false;const run=++generation;for(const value of entries.values()){value.checking=false;if(value.status==='checking')value.status='idle';}if(visible){void loadVersion(run);if(nativeUpdater?.ready)void Promise.resolve().then(()=>nativeUpdater.ready()).then(()=>{if(current(run))changed();}).catch(()=>{});}}
 function setChannel(value){if(!channels.includes(value)||value===channel)return;channel=value;generation++;for(const value of entries.values()){value.checking=false;if(value.status==='checking')value.status='idle';}try{preferences?.setItem(storageKey,channel);}catch{}changed();}
 async function check(){
  if(!visible||disposed||entry().checking)return;
  const run=generation,selected=channel,target=entry();target.checking=true;target.status='checking';changed();
  try{
   const response=await request(selected==='stable'?'/updates':'/updates?channel=beta'),url=releaseURL(response?.releaseUrl);
   if(!current(run,selected))return;
   if(!validVersion(response?.currentVersion)||!validVersion(response?.latestVersion)||typeof response?.updateAvailable!=='boolean'||!url||(response.channel??'stable')!==selected||selected==='stable'&&response.latestVersion.includes('-')||url.split('/').at(-1).replace(/^v/,'')!==response.latestVersion)throw Error('Invalid update response');
   const asset=response.asset==null?null:validatedAsset(response.asset,response.latestVersion,selected,url);if(response.asset!=null&&!asset)throw Error('Invalid update asset');
   version=response.currentVersion;target.result={latestVersion:response.latestVersion,releaseUrl:url,asset};target.status=response.updateAvailable?'available':'current';
  }catch{if(current(run,selected)){target.result=null;target.status='failed';}}
  finally{if(current(run,selected)){target.checking=false;changed();}}
 }
 async function download(){
  const selected=entry(),asset=selected.status==='available'?selected.result?.asset:null;if(!visible||disposed||!nativeAvailable()||!asset)return;
  const key=assetKey(asset),old=downloads.get(key);if(old&&['downloading','ready','installing'].includes(old.status))return;
  const record={status:'downloading',received:0,total:asset.size};downloads.set(key,record);changed();
  try{
   const result=await nativeUpdater.download({...asset},progress=>{if(disposed||downloads.get(key)!==record||progress?.version!==asset.version||progress.channel!==asset.channel||progress.sha256!==asset.sha256||progress.total!==asset.size||!Number.isSafeInteger(progress.received)||progress.received<record.received||progress.received>asset.size)return;record.received=progress.received;changed();});
   if(disposed||downloads.get(key)!==record)return;
   if(result?.ready!==true||result.version!==asset.version||result.channel!==asset.channel||result.sha256!==asset.sha256||result.name!==asset.name||result.size!==asset.size)throw Error('Unconfirmed download');
   record.status='ready';record.received=asset.size;
  }catch{if(!disposed&&downloads.get(key)===record)record.status='downloadFailed';}finally{changed();}
 }
 async function install(){
  const asset=entry().status==='available'?entry().result?.asset:null,record=asset&&downloads.get(assetKey(asset));if(!visible||disposed||!nativeAvailable()||!installSupported()||record?.status!=='ready'||installBlock())return;
  record.status='installing';record.installFailed=false;changed();let cleanup;
  try{cleanup=await beforeInstall();if(disposed||!visible||!installSupported()||installBlock())throw Error('Installation deferred');const result=await nativeUpdater.install({...asset});if(result?.launched!==true)throw Error('Unconfirmed installer');}
  catch{if(typeof cleanup==='function')try{await cleanup();}catch{}if(!disposed){record.status='ready';record.installFailed=true;}}finally{changed();}
 }
 function render(){
  const tr=text(),selected=entry(),result=selected.result,asset=result?.asset,record=asset&&downloads.get(assetKey(asset)),block=installSupported()?installBlock():'unsupported';
  let message=selected.status==='available'?`${tr.available} · ${result.latestVersion}`:tr[selected.status]||'';
  if(record?.status==='downloading')message=`${tr.downloading} · ${Math.floor(record.received/record.total*100)}%`;
  if(record?.status==='ready'||record?.status==='installing')message=tr[record.status==='ready'?'ready':'installing'];
  if(record?.status==='downloadFailed')message=tr.downloadFailed;if(record?.installFailed)message=tr.installFailed;
  const action=selected.status==='available'&&asset&&nativeAvailable()?(record?.status==='ready'?(installSupported()?`<button type="button" class="text-btn" data-install-update ${block?'disabled':''}>${tr.install}</button>`:''):`<button type="button" class="text-btn" data-download-update ${['downloading','installing'].includes(record?.status)?'disabled':''}>${tr[record?.status==='downloading'?'downloading':record?.status==='installing'?'installing':'download']}</button>`):'';
  return `<section class="settings-section setting-card app-about-settings" data-key="app-about"><div class="card-label"><h2>${tr.about}</h2></div><div class="card-content"><div class="setting-row app-version-row"><span>${tr.version}</span><strong data-app-version>${escape(version)}</strong></div><label class="setting-row"><span>${tr.channel}</span><select data-update-channel aria-label="${tr.channel}"><option value="stable" ${channel==='stable'?'selected':''}>${tr.stable}</option><option value="beta" ${channel==='beta'?'selected':''}>${tr.beta}</option></select></label>${channel==='beta'?`<small class="muted">${tr.betaHint}</small>`:''}<div class="app-update-actions"><button type="button" class="text-btn" data-check-updates ${selected.checking?'disabled aria-busy="true"':''}>${tr[selected.checking?'checking':selected.status==='failed'?'retry':'check']}</button>${action}${selected.status==='available'?`<a class="text-btn" data-update-release href="${escape(result.releaseUrl)}" target="_blank" rel="noopener noreferrer">${tr.release}</a>`:''}</div><p class="app-update-status ${selected.status==='failed'||record?.status==='downloadFailed'||record?.installFailed?'error':''}" role="status" aria-live="polite">${escape(message)}</p>${record?.status==='ready'&&block?`<p class="muted" data-update-install-blocked>${tr[block]}</p>`:''}<small class="muted app-update-hint">${tr.manual}</small></div></section>`;
 }
 function bind(){
  const button=document.querySelector('[data-check-updates]');if(button)button.onclick=()=>check();
  const select=document.querySelector('[data-update-channel]');if(select)select.onchange=()=>setChannel(select.value);
  const downloadButton=document.querySelector('[data-download-update]');if(downloadButton)downloadButton.onclick=()=>download();
  const installButton=document.querySelector('[data-install-update]');if(installButton)installButton.onclick=()=>install();
  const link=document.querySelector('[data-update-release]');if(link&&openExternal)link.onclick=event=>{event.preventDefault();if(!visible||entry().status!=='available')return;const url=releaseURL(entry().result?.releaseUrl);if(url)Promise.resolve().then(()=>openExternal(url)).catch(onOpenError);};
 }
 function dispose(){visible=false;disposed=true;generation++;for(const entry of entries.values())entry.checking=false;nativeUpdater?.dispose?.();}
 return {setVisible,setChannel,check,download,install,render,bind,dispose,get channel(){return channel;}};
}
