import {localizeMessages} from '../src/i18n.mjs';
import {workProgress} from './work-progress.js';

const copy={
 en:{title:'Task details',close:'Close',loading:'Loading task details…',failed:'Task details could not be loaded. Check the connection and try again.',retry:'Try again',changed:'This task or work computer has changed. Open Work progress and select the task again.',offline:'Reconnect to confirm this task and reply. The last known records are shown below.',unsupported:'The work computer service updates automatically. Check its update status before viewing project memory or replying to this task.',memory:'Project memory',reference:'Saved from actual task records. These excerpts are reference material and do not authorize new work.',empty:'No saved project records are available yet.',original:'Original request',updates:'Your updates',results:'Results',plan:'Task steps',reply:'Reply to task',reopen:'Reopen task',replyHint:'Choose this task in the chat composer. Nothing is sent until you submit a message.',unconfirmed:'The task status is unconfirmed. Reconnect before replying.',view:'View file',download:'Download',chat:'View in chat',file:'Attachment',fileFailed:'This file could not be opened. Check the connection and try again.',updated:'Last saved',states:{draft:'Draft',running:'Working',continuing:'In progress',waiting_user:'Waiting for your reply',pausing:'Stopping safely',unknown:'Status unconfirmed',review:'Awaiting review',paused:'Paused',failed:'Failed',completed:'Completed',queued:'Queued',cancelled:'Cancelled',interrupted:'Interrupted'},steps:{pending:'Pending',inProgress:'In progress',completed:'Completed'}},
 zh:{title:'任务详情',close:'关闭',loading:'正在读取任务详情…',failed:'无法读取任务详情，请检查连接后重试。',retry:'重试',changed:'任务或工作电脑已变化，请打开工作进度重新选择。',offline:'请重新连接后确认任务并回复；下方保留上次已知记录。',unsupported:'工作电脑服务会自动更新，请在更新完成后查看项目记忆或回复这项任务。',memory:'项目记忆',reference:'内容来自真实任务记录，仅供参考，不代表新的工作授权。',empty:'目前还没有保存的项目记录。',original:'原始要求',updates:'你的补充',results:'结果',plan:'任务步骤',reply:'回复任务',reopen:'重新开启任务',replyHint:'仅在聊天输入框中选中这项任务；发送消息后才会提交。',unconfirmed:'任务状态尚未确认，请重新连接后再回复。',view:'查看文件',download:'下载',chat:'在聊天中查看',file:'附件',fileFailed:'无法打开此文件，请检查连接后重试。',updated:'最后保存',states:{draft:'草稿',running:'正在执行',continuing:'进行中',waiting_user:'等待你回复',pausing:'正在安全停止',unknown:'状态未确认',review:'待验收',paused:'已暂停',failed:'失败',completed:'已完成',queued:'排队中',cancelled:'已取消',interrupted:'已中断'},steps:{pending:'待处理',inProgress:'正在执行',completed:'已完成'}}
};
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x20\x7f]/.test(value);
const targetValid=value=>plain(value)&&id(value.workId,128)&&id(value.turnId)&&id(value.conversationId,128);
const targetCopy=value=>({workId:value.workId,turnId:value.turnId,conversationId:value.conversationId});
const same=(left,right)=>targetValid(left)&&targetValid(right)&&left.workId===right.workId&&left.turnId===right.turnId&&left.conversationId===right.conversationId;
const time=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
const text=(value,max)=>typeof value==='string'?value.slice(0,max).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,''):'';
const fileId=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal=new Set(['failed','completed','cancelled','review']);
function fileView(file){
 if(!plain(file)||typeof file.id!=='string'||!fileId.test(file.id))return null;
 const type=text(file.type,100).toLowerCase();return {id:file.id,name:text(file.name,200),type:/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)?type:'application/octet-stream',...(Number.isSafeInteger(file.size)&&file.size>=0&&file.size<=10*1024*1024?{size:file.size}:{})};
}
function entryView(value){
 if(!plain(value)||!id(value.messageId)||!time(value.at))return null;const seen=new Set();
 const attachments=(Array.isArray(value.attachments)?value.attachments:[]).slice(0,5).flatMap(file=>{const safe=fileView(file);if(!safe||seen.has(safe.id))return [];seen.add(safe.id);return [safe];});
 return {messageId:value.messageId,...(id(value.turnId)?{turnId:value.turnId}:{}),at:value.at,text:text(value.text,4000),attachments};
}
function contextView(value){
 if(!plain(value)||value.version!==1||value.referenceDataOnly!==true||!time(value.updatedAt))return null;
 const entries=value=>(Array.isArray(value)?value:[]).slice(-8).flatMap(item=>{const safe=entryView(item);return safe?[safe]:[];});
 return {updatedAt:value.updatedAt,originalRequest:entryView(value.originalRequest),humanUpdates:entries(value.humanUpdates),results:entries(value.results)};
}
function planView(value){return (Array.isArray(value?.steps)?value.steps:[]).slice(0,128).flatMap(item=>plain(item)&&text(item.step,240).trim()&&['pending','inProgress','completed'].includes(item.status)?[{step:text(item.step,240),status:item.status}]:[]);}
async function untilAbort(value,signal){let abort;try{return await Promise.race([value,new Promise((resolve,reject)=>{abort=()=>reject(Error('Task details cancelled.'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}}

// This viewer only reads saved references. Reply chooses a composer target;
// it never submits, resumes or changes a task by itself.
export function createTaskDetails({document=globalThis.document,window=globalThis.window,getState,getLanguage=()=> 'en',getModal,openModal,request,render=()=>{},onReply,onFile,onDownload,onReveal,icon=()=>'',connected=()=>true}={}){
 let active=null,fileLease=null,sequence=0,disposed=false;
 const words=()=>localizeMessages(copy,getLanguage());
 const scope=()=>{const state=getState(),vm=state?.settings?.vm;return JSON.stringify([state?.conversationId??null,vm?.host??null,vm?.user??null,vm?.port??null,vm?.keyPath??null]);};
 const reliable=()=>{const state=getState();return (typeof connected==='function'?connected():connected)!==false&&state?.controller?.cached!==true&&(state?.controller?.status===undefined||state.controller.status==='online')&&state?.worker?.status==='online';};
 const record=target=>{const state=getState();return state?.conversationId===target.conversationId?(state.workTasks||[]).find(item=>item?.id===target.workId&&item.turnId===target.turnId&&!item.progressDismissedAt):null;};
 const scoped=operation=>!disposed&&active===operation&&same(operation.modal.target,operation.target)&&scope()===operation.scope&&Boolean(record(operation.target));
 const owns=operation=>scoped(operation)&&getModal()===operation.modal;
 const preview=operation=>{const modal=getModal();return scoped(operation)&&fileLease?.operation===operation&&['file','image'].includes(modal?.type)&&modal.fileId===fileLease.file.id&&modal.parent===operation.modal;};
 function clear(){if(active){active.controller?.abort();active.context=null;active=null;}fileLease=null;}
 function current(){const operation=active;if(!operation)return null;if(!owns(operation)){if(!preview(operation))clear();return null;}return operation;}
 function syncModal(value=getModal()){current();return value;}
 const replyItem=operation=>{const model=workProgress(getState(),{language:getLanguage(),connected:typeof connected==='function'?connected():connected});return [model.active,...model.items].find(item=>same(item?.replyTarget,operation.target));};
 const uncertain=(item,progress)=>!item||progress?.knownStatus==='unknown'||item.status==='unknown'||item.unknownOutcome===true||['unknown','submitting'].includes(item.submission)||item.continuation?.invalid===true||Boolean(item.continuation?.dispatch&&item.continuation.dispatch.phase!=='acknowledged');
 const canReply=operation=>owns(operation)&&reliable()&&getState()?.capabilities?.taskReopen===true&&replyItem(operation)?.canReply===true&&typeof onReply==='function';
 const date=value=>{try{return new Date(value).toLocaleString(getLanguage()==='zh'?'zh-CN':'en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch{return '';}};
 async function load(operation){
  operation.controller?.abort();const controller=new AbortController(),generation=++operation.generation;operation.controller=controller;operation.status='loading';operation.context=null;operation.fileError=false;render();
  try{
   const {workId,turnId,conversationId}=operation.target;
   const result=await untilAbort(request(`/tasks/${encodeURIComponent(workId)}/context?turnId=${encodeURIComponent(turnId)}&conversationId=${encodeURIComponent(conversationId)}`,{method:'GET',signal:controller.signal}),controller.signal);
   if(!owns(operation)||generation!==operation.generation||controller.signal.aborted)return;
   if(!plain(result)||!same(result,operation.target))throw Error('Task details did not match the requested task.');
   operation.context=contextView(result.projectContext);operation.title=text(result.title,240);operation.plan=planView(result.plan);operation.status='ready';
  }catch{if(owns(operation)&&generation===operation.generation&&!controller.signal.aborted){operation.status='failed';operation.context=null;}}
  finally{if(owns(operation)&&generation===operation.generation)render();}
 }
 function open(target){
  if(disposed||!targetValid(target)||!record(target))return Promise.resolve(false);clear();const item=record(target),modal={type:'task-detail',target:targetCopy(target),detailId:++sequence};
  const operation={modal,target:targetCopy(target),scope:scope(),title:text(item.title,240),plan:planView(item.plan),context:contextView(item.projectContext),status:'ready',generation:0};active=operation;openModal(modal);
  if(!reliable()){operation.status='offline';render();return Promise.resolve(true);}if(getState()?.capabilities?.taskReopen!==true){operation.status='unsupported';render();return Promise.resolve(true);}
  return load(operation).then(()=>Boolean(owns(operation)));
 }
 function entryMarkup(entry){
  if(!entry)return '';const w=words(),state=getState(),inChat=typeof onReveal==='function'&&(state?.messages||[]).some(message=>message.id===entry.messageId);
  return `<article class="task-detail-entry"><div class="task-detail-entry-meta"><time datetime="${escape(new Date(entry.at).toISOString())}">${escape(date(entry.at))}</time>${inChat?`<button type="button" class="text-btn" data-task-detail-reveal="${escape(entry.messageId)}">${w.chat}</button>`:''}</div>${entry.text?`<div class="task-detail-text">${escape(entry.text)}</div>`:''}${entry.attachments.length?`<ul class="task-detail-files">${entry.attachments.map(file=>`<li><span class="task-detail-file-name">${icon('file-text')}${escape(file.name||w.file)}</span><div>${typeof onFile==='function'?`<button type="button" class="text-btn" data-task-detail-file="${escape(file.id)}" ${reliable()?'':'disabled'}>${w.view}</button>`:''}${typeof onDownload==='function'?`<button type="button" class="text-btn" data-task-detail-download="${escape(file.id)}" ${reliable()?'':'disabled'}>${w.download}</button>`:''}</div></li>`).join('')}</ul>`:''}</article>`;
 }
 function renderModal(modal=getModal()){
  if(modal?.type!=='task-detail'){if(!active||!preview(active))clear();return '';}
  const operation=current(),w=words(),item=operation&&record(operation.target),progress=operation&&replyItem(operation),known=progress?.knownStatus||item?.status,status=Object.hasOwn(w.states,known)?known:'unknown';
  const context=operation?.context,hasContext=context&&(context.originalRequest||context.humanUpdates.length||context.results.length),plan=operation?.plan||[];
  const guidance=!operation?'changed':!reliable()?'offline':getState()?.capabilities?.taskReopen!==true?'unsupported':uncertain(item,progress)?'unconfirmed':null;
  const stateMessage=guidance||(operation?.status==='loading'?'loading':operation?.status==='failed'?'failed':null);
  const section=(label,entries)=>entries.length?`<section class="task-detail-context-section"><h3>${escape(label)}</h3>${entries.map(entryMarkup).join('')}</section>`:'';
  return `<div class="modal-backdrop task-detail-backdrop" data-key="modal-backdrop"><section class="dialog task-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><div><h2 id="dialog-title">${escape(operation?.title||w.title)}</h2>${operation?`<span class="task-detail-state" data-task-detail-state>${escape(w.states[status])}</span>`:''}</div><button type="button" class="icon-btn" data-action="close-modal" aria-label="${w.close}">${icon('x')||'×'}</button></div><div class="task-detail-body" aria-busy="${operation?.status==='loading'}">${stateMessage?`<p class="task-detail-notice" role="status">${escape(w[stateMessage])}</p>`:''}${operation?.status==='failed'&&!guidance?`<button type="button" class="text-btn" data-task-detail-retry>${w.retry}</button>`:''}${operation?.fileError?`<p class="task-detail-notice" role="status">${w.fileFailed}</p>`:''}${plan.length?`<section class="task-detail-plan"><h3>${w.plan}</h3><ol>${plan.map(step=>`<li><span>${escape(step.step)}</span><small>${escape(w.steps[step.status])}</small></li>`).join('')}</ol></section>`:''}<section class="task-detail-context"><h3>${w.memory}</h3><p class="task-detail-reference">${w.reference}</p>${hasContext?`${section(w.original,context.originalRequest?[context.originalRequest]:[])}${section(w.updates,context.humanUpdates)}${section(w.results,context.results)}<p class="task-detail-updated">${w.updated} · ${escape(date(context.updatedAt))}</p>`:`<p class="task-detail-empty">${w.empty}</p>`}</section></div><div class="task-detail-footer"><p>${w.replyHint}</p><button type="button" class="solid" data-task-detail-reply ${operation&&canReply(operation)?'':'disabled'}>${escape(w.reply)}</button></div></section></div>`;
 }
 function files(operation){const context=operation.context;return context?[context.originalRequest,...context.humanUpdates,...context.results].filter(Boolean).flatMap(entry=>entry.attachments):[];}
 function file(id){
  if(typeof id!=='string'||!fileId.test(id))return null;const operation=active;if(!operation)return null;
  const value=owns(operation)?files(operation).find(file=>file.id===id):preview(operation)&&fileLease.file.id===id?fileLease.file:null;
  if(!scoped(operation)){clear();return null;}return value?{...value}:null;
 }
 function bind(){
  const operation=current();
  document?.querySelectorAll('[data-task-detail-open],[data-task-details]').forEach(node=>node.onclick=event=>{event.preventDefault();event.stopPropagation();void open({workId:node.dataset.taskDetailOpen||node.dataset.taskDetails,turnId:node.dataset.progressTurn,conversationId:node.dataset.progressConversation});});
  document?.querySelectorAll('[data-task-detail-retry]').forEach(node=>node.onclick=event=>{event.preventDefault();event.stopPropagation();const operation=current();if(operation&&reliable()&&getState()?.capabilities?.taskReopen===true)void load(operation);});
  document?.querySelectorAll('[data-task-detail-reply]').forEach(node=>node.onclick=event=>{event.preventDefault();event.stopPropagation();const operation=current();if(operation&&canReply(operation))onReply(targetCopy(operation.target));});
  for(const [attribute,callback]of [['file',onFile],['download',onDownload]])document?.querySelectorAll(`[data-task-detail-${attribute}]`).forEach(node=>node.onclick=event=>{
   event.preventDefault();event.stopPropagation();const operation=current();if(!operation||!reliable()||typeof callback!=='function')return;const file=files(operation).find(file=>file.id===node.getAttribute(`data-task-detail-${attribute}`));if(!file)return;
   void Promise.resolve().then(()=>{if(owns(operation)){if(attribute==='file')fileLease={operation,file:{...file}};return callback({...file});}}).catch(()=>{if(owns(operation)){operation.fileError=true;render();}});
  });
  document?.querySelectorAll('[data-task-detail-reveal]').forEach(node=>node.onclick=event=>{event.preventDefault();event.stopPropagation();const operation=current(),messageId=node.dataset.taskDetailReveal;if(operation&&id(messageId)&&(getState()?.messages||[]).some(message=>message.id===messageId)&&typeof onReveal==='function')onReveal(messageId,targetCopy(operation.target));});
  return Boolean(operation);
 }
 function dispose(){if(disposed)return;disposed=true;clear();window?.removeEventListener?.('beforeunload',dispose);}
 window?.addEventListener?.('beforeunload',dispose);return {open,renderModal,syncModal,bind,dispose,file};
}
