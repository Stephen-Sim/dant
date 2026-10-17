const words={
 en:{about:'About dant',version:'Version',check:'Check for updates',checking:'Checking for updates…',available:'A new version is available',current:'You’re up to date.',failed:'Could not check for updates. Check your connection and try again.',retry:'Try again',download:'View update',manual:'Checks GitHub releases when you choose. Download and install updates manually.'},
 zh:{about:'关于 dant',version:'版本',check:'检查更新',checking:'正在检查更新…',available:'有新版本可用',current:'已是最新版本。',failed:'无法检查更新，请检查网络连接后重试。',retry:'重试',download:'查看更新',manual:'点击时检查 GitHub 发布版本，更新需手动下载和安装。'},
};
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const validVersion=value=>typeof value==='string'&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)&&value.length<100;
function releaseURL(value){
 if(typeof value!=='string'||value.length>500)return null;
 try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='github.com'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/Stephen-Sim\/dant\/releases\/tag\/v?[0-9A-Za-z.+-]+$/.test(url.pathname)?url.href:null;}catch{return null;}
}

// This state belongs to the Windows app. It deliberately has no VM generation,
// worker status, task queue, call, or conversation dependency.
export function createUpdates({request,version:buildVersion,getLanguage=()=> 'en',onChange=()=>{},document=globalThis.document,openExternal,onOpenError=()=>{}}){
 let version=validVersion(buildVersion)?buildVersion:'—',visible=false,generation=0,checking=false,result=null,status='idle';
 const text=()=>words[getLanguage()==='zh'?'zh':'en'];
 const current=run=>visible&&generation===run;
 async function loadVersion(run){
  try{const info=await request('/version');if(current(run)&&validVersion(info?.version)){version=info.version;onChange();}}catch{ /* The bundled version remains available while the local service is offline. */ }
 }
 function setVisible(value){
  value=Boolean(value);if(value===visible)return;
  visible=value;const run=++generation;
  checking=false;if(status==='checking')status='idle';
  if(visible)void loadVersion(run);
 }
 async function check(){
  if(!visible||checking)return;
  const run=generation;checking=true;status='checking';onChange();
  try{
   const response=await request('/updates'),url=releaseURL(response?.releaseUrl);
   if(!current(run))return;
   if(!validVersion(response?.currentVersion)||!validVersion(response?.latestVersion)||typeof response?.updateAvailable!=='boolean'||!url)throw Error('Invalid update response');
   version=response.currentVersion;result={latestVersion:response.latestVersion,releaseUrl:url};status=response.updateAvailable?'available':'current';
  }catch{if(current(run)){result=null;status='failed';}}
  finally{if(current(run)){checking=false;onChange();}}
 }
 function render(){
  const tr=text(),message=status==='available'?`${tr.available} · ${result.latestVersion}`:tr[status]||'';
  return `<section class="settings-section setting-card app-about-settings" data-key="app-about"><div class="card-label"><h2>${tr.about}</h2></div><div class="card-content"><div class="setting-row app-version-row"><span>${tr.version}</span><strong data-app-version>${escape(version)}</strong></div><div class="app-update-actions"><button type="button" class="text-btn" data-check-updates ${checking?'disabled aria-busy="true"':''}>${tr[checking?'checking':status==='failed'?'retry':'check']}</button>${status==='available'?`<a class="text-btn" data-update-release href="${escape(result.releaseUrl)}" target="_blank" rel="noopener noreferrer">${tr.download}</a>`:''}</div><p class="app-update-status ${status==='failed'?'error':''}" role="status" aria-live="polite">${escape(message)}</p><small class="muted app-update-hint">${tr.manual}</small></div></section>`;
 }
 function bind(){
  const button=document.querySelector('[data-check-updates]');if(button)button.onclick=()=>check();
  const link=document.querySelector('[data-update-release]');if(link&&openExternal)link.onclick=event=>{event.preventDefault();if(!visible||status!=='available')return;const url=releaseURL(result?.releaseUrl);if(url)Promise.resolve().then(()=>openExternal(url)).catch(onOpenError);};
 }
 function dispose(){visible=false;generation++;checking=false;}
 return {setVisible,check,render,bind,dispose};
}
