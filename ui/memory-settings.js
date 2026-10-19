const words={
 en:{title:'Memory & personality',description:'The shared identity and durable notes dant currently uses in chat and calls. Read-only; maintained by dant.',identity:'Shared personality',identitySource:'The shared identity used by text chat and both voice providers.',memory:'Current memory',memorySource:'Identity and preferences, followed by working memory, from the work computer. Credential values are omitted.',refresh:'Refresh',refreshing:'Refreshing…',loading:'Reading current memory…',offline:'Connect the work computer to read current memory.',cached:'Last loaded copy. The current work computer has not confirmed a fresh read.',failed:'Current memory could not be read. Reconnect and try again.',empty:'No saved reference notes.'},
 zh:{title:'记忆与人格',description:'查看 dant 在文字和通话中使用的共享身份与持久记忆。此处只读，由 dant 维护。',identity:'共享人格',identitySource:'文字对话与两种语音通道共用的实际身份设定。',memory:'当前记忆',memorySource:'来自工作电脑的身份与偏好，以及工作记忆。凭据内容会被隐藏。',refresh:'刷新',refreshing:'正在刷新…',loading:'正在读取当前记忆…',offline:'请连接工作电脑以读取当前记忆。',cached:'上次读取的内容，当前工作电脑尚未确认最新内容。',failed:'暂时无法读取当前记忆，请重新连接后重试。',empty:'尚无持久记忆内容。'},
};
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const scope=state=>state?.conversationId?JSON.stringify([state.conversationId,state.settings?.vm?.host||'',state.settings?.vm?.user||'',state.settings?.vm?.port||'',state.settings?.vm?.keyPath||'',state.settings?.vm?.knownHosts||'']):null;
const revision=state=>JSON.stringify([state?.memory||'',state?.memoryFiles?.filter(file=>['identity.md','working-memory.md'].includes(file?.name)).map(file=>[file.name,file.text])||[]]);
function valid(value,conversationId){return value?.readOnly===true&&value.conversationId===conversationId&&typeof value.identity?.text==='string'&&value.identity.text.length<=32768&&typeof value.memory?.text==='string'&&value.memory.text.length<=140000;}

export function createMemorySettings({request,getState,getLanguage=()=> 'en',onChange=()=>{},document=globalThis.document,connected=()=>true,renderMarkdown=text=>escape(text).replace(/\n/g,'<br>')}){
 let visible=false,generation=0,identity=null,lastRevision=null,lastOnline=false,data=null,status='idle';
 const text=()=>words[getLanguage()==='zh'?'zh':'en'],changed=()=>{if(visible)onChange();};
 const online=state=>connected()&&(state?.mode==='vm-controller'?state.controller?.status==='online'&&state.controller.cached!==true:state?.worker?.status==='online');
 function synchronize(){const state=getState(),next=scope(state),nextRevision=revision(state),ready=online(state),changedScope=next!==identity,changedMemory=nextRevision!==lastRevision,returned=ready&&!lastOnline,lost=!ready&&lastOnline;identity=next;lastRevision=nextRevision;lastOnline=ready;if(changedScope){data=null;status='idle';generation++;}if(lost)generation++;return {load:visible&&next&&ready&&(changedScope||changedMemory||returned||status==='idle'),ready};}
 function setVisible(value){const entered=!visible&&Boolean(value);visible=Boolean(value);if(!visible){generation++;return;}const state=synchronize();if((entered||state.load)&&state.ready){const run=++generation;status='loading';queueMicrotask(()=>{if(visible&&generation===run)void load();});}else if(!state.ready)status=data?'cached':'offline';}
 async function load(){
  const state=getState(),key=scope(state);if(!visible||!key)return;if(!online(state)){status=data?'cached':'offline';changed();return;}
  const run=++generation;status='loading';changed();
  try{const result=await request('/memory/view');if(!visible||run!==generation||scope(getState())!==key)return;if(!valid(result,state.conversationId))throw Error('Invalid memory view');data={identity:result.identity.text,memory:result.memory.text};status='ready';}
  catch{if(visible&&run===generation&&scope(getState())===key)status=data?'cached':'failed';}
  finally{if(visible&&run===generation)changed();}
 }
 function render(){
  const tr=text(),busy=status==='loading';
  const card=(title,description,content,key)=>`<section class="setting-card"><div class="card-label"><h2>${tr[title]}</h2><p>${tr[description]}</p></div><div class="card-content memory-content markdown" data-memory-${key}>${renderMarkdown(content)}</div></section>`;
  return `<section class="settings-section memory-page"><div class="memory-page-header"><p class="card-description">${tr.description}</p><button type="button" class="text-btn memory-refresh" data-key="memory-refresh" data-memory-refresh aria-busy="${busy}" ${busy||!lastOnline?'disabled':''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg><span>${busy?tr.refreshing:tr.refresh}</span></button></div><p class="memory-page-status muted ${busy?'memory-status-loading':''}" role="status" ${tr[status]?'':'hidden'}>${tr[status]||''}</p>${data?card('identity','identitySource',data.identity,'identity')+card('memory','memorySource',data.memory||tr.empty,'references'):''}</section>`;
 }
 function bind(){const button=document.querySelector('[data-memory-refresh]');if(button)button.onclick=()=>status==='loading'||!lastOnline?undefined:load();}
 function dispose(){visible=false;generation++;data=null;}
 return {setVisible,load,render,bind,dispose};
}
