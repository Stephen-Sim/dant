const copy={
 en:{title:'Remove unfinished task?',hint:'This task is not completed. Remove it from Work progress? Its chat and results will stay.',cancel:'Cancel',remove:'Remove task',cleared:'Completed tasks cleared',kept:'Tasks still in use were kept. Try again later.',changed:'This task has changed. Check its current status and try again.',offline:'Reconnect to change Work progress.',failed:'The task could not be updated. Please try again.'},
 zh:{title:'删除未完成的任务？',hint:'这项任务尚未完成。确认从工作进度中移除？聊天和结果会保留。',cancel:'取消',remove:'确认删除',cleared:'已清空已完成的任务',kept:'仍在使用的任务已保留，请稍后再试。',changed:'任务状态已变化，请检查后重试。',offline:'请先重新连接，再修改工作进度。',failed:'任务修改失败，请重试。'}
};
Object.assign(copy.en,{cancelTitle:'Cancel this task?',cancelHint:'Stop this task and keep it in Recent tasks as Cancelled. Its chat and results will stay.',keepWorking:'Keep task',confirmCancel:'Cancel task',cancelled:'Task cancelled',unconfirmed:'Cancellation is not confirmed. Check the current task status before trying again.'});
Object.assign(copy.zh,{cancelTitle:'取消这项任务？',cancelHint:'停止这项任务，并在最近的任务中保留“已取消”记录。聊天和结果会保留。',keepWorking:'保留任务',confirmCancel:'确认取消任务',cancelled:'任务已取消',unconfirmed:'尚未确认任务已取消，请检查当前状态后再操作。'});
Object.assign(copy.en,{paused:'Task paused',pausing:'Waiting for the task to pause safely.',resumed:'Task will continue when the executor is free.',pauseUnconfirmed:'Pause is not confirmed. Check the current task status before trying again.',resumeUnconfirmed:'Resume is not confirmed. Check the current task status before trying again.'});
Object.assign(copy.zh,{paused:'任务已暂停',pausing:'正在等待任务安全暂停。',resumed:'执行器空闲时会继续这项任务。',pauseUnconfirmed:'尚未确认任务已暂停，请检查当前状态后再操作。',resumeUnconfirmed:'尚未确认任务已继续，请检查当前状态后再操作。'});
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kinds=new Set(['task','work','completion']),priorities=new Set(['high','normal','low']);
const identity=item=>item.registered||item.work?{id:item.id,kind:'work'}:item.voice?{id:item.id,kind:'completion'}:{id:item.message?.id,kind:'task'};
export function createProgressActions({getModel,request,render,toast,getLanguage=()=> 'en',formatError=error=>error.message,document=globalThis.document,isPending=()=>false}={}){
 let confirmation=null,busy=false,epoch=0;
 const labels=()=>copy[getLanguage()==='zh'?'zh':'en'];
 const valid=(id,kind)=>typeof id==='string'&&id.length>0&&id.length<=128&&kinds.has(kind);
 const find=(id,kind)=>{const model=getModel();return [...(model.items||[]),...(model.ongoing||[]),...(model.recent||model.history||[]),...(model.completed||[])].find(item=>{const key=identity(item);return key.id===id&&key.kind===kind;});};
 const sameTarget=(a,b)=>a&&b&&a.id===b.id&&a.kind===b.kind&&a.turnId===b.turnId&&(a.callId||null)===(b.callId||null);
 const validTarget=target=>target&&typeof target.id==='string'&&target.id.length>0&&target.id.length<=128&&['task','work','active'].includes(target.kind)&&(target.kind!=='active'||target.id==='current')&&(typeof target.turnId==='string'&&target.turnId.length>0&&target.turnId.length<=256||target.kind==='task'&&target.turnId===null)&&(!target.callId||typeof target.callId==='string'&&target.callId.length<=128);
 const findCancellation=target=>{const model=getModel();return [model.active,...(model.ongoing||[])].find(item=>item&&sameTarget(item.cancelTarget,target));};
 const findResumption=target=>{const model=getModel();return [...(model.items||[]),...(model.recent||model.history||[])].find(item=>item?.registered&&sameTarget(item.cancelTarget,target));};
 const ready=id=>{if(busy||isPending(id))return false;if(getModel().reliable===false){toast(labels().offline);return false;}return true;};
 function prompt(item,id,kind){confirmation={id,kind,title:item?.title||''};render();document.querySelector('[data-progress-dismiss-cancel]')?.focus();}
 function promptCancellation(item,target){confirmation={...target,mode:'cancel',title:item.title||''};render();document.querySelector('[data-progress-task-cancel-back]')?.focus();}
 async function cancelTask(target){
  if(!validTarget(target)||!ready(target.id))return;
  const item=findCancellation(target);if(!item?.canCancel){toast(labels().changed);return;}
  promptCancellation(item,target);
 }
 async function confirmCancellation(){
  const selected=confirmation;if(selected?.mode!=='cancel'||!ready(selected.id))return;
  if(!findCancellation(selected)?.canCancel){confirmation=null;render();toast(labels().changed);return;}
  const body={kind:selected.kind,turnId:selected.turnId,...(selected.callId?{callId:selected.callId}:{})},result=await mutate(selected.id,'/tasks/'+encodeURIComponent(selected.id)+'/cancel',body);
  if(result.ok&&result.value?.cancelled===true){if(confirmation===selected)confirmation=null;render();toast(labels().cancelled);}
  else toast(result.ok?labels().unconfirmed:formatError(result.error)||labels().failed);
 }
 async function pauseTask(target){
  if(!validTarget(target)||!ready(target.id))return;
  if(!findCancellation(target)?.canPause){toast(labels().changed);return;}
  const result=await mutate(target.id,'/tasks/'+encodeURIComponent(target.id)+'/pause',{kind:target.kind,turnId:target.turnId,...(target.callId?{callId:target.callId}:{})});
  if(result.ok)toast(result.value?.paused===true?labels().paused:result.value?.pausing===true?labels().pausing:labels().pauseUnconfirmed);
  else toast(formatError(result.error)||labels().failed);
 }
 async function resumeTask(target){
  if(!validTarget(target)||target.kind!=='work'||!ready(target.id))return;
  if(!findResumption(target)?.canResume){toast(labels().changed);return;}
  const result=await mutate(target.id,'/tasks/'+encodeURIComponent(target.id)+'/resume',{kind:'work',turnId:target.turnId});
  if(result.ok)toast(result.value?.resumed===true?labels().resumed:labels().resumeUnconfirmed);
  else toast(formatError(result.error)||labels().failed);
 }
 async function mutate(id,route,body){
  busy=true;render();
  try{return {ok:true,value:await request(id,route,body)};}
  catch(error){return {ok:false,error};}
  finally{busy=false;render();}
 }
 async function dismiss(id,kind){
  if(!valid(id,kind)||!ready(id))return;
  const item=find(id,kind);if(!item){toast(labels().changed);return;}
  if(item.canCancel&&item.cancelTarget){promptCancellation(item,item.cancelTarget);return;}
  if(!item.progressCompleted){prompt(item,id,kind);return;}
  const currentEpoch=epoch;
  const result=await mutate(id,'/tasks/'+encodeURIComponent(id)+'/dismiss',{kind});
  if(!result.ok){if(result.error.code==='confirmation_required'&&currentEpoch===epoch){const current=find(id,kind)||item;if(current.canCancel&&current.cancelTarget)promptCancellation(current,current.cancelTarget);else prompt(current,id,kind);}else toast(formatError(result.error)||labels().failed);}
 }
 async function confirmDismiss(){
  const selected=confirmation;if(!selected||!ready(selected.id))return;
  const item=find(selected.id,selected.kind);if(!item){confirmation=null;render();toast(labels().changed);return;}
  if(item.canCancel&&item.cancelTarget){promptCancellation(item,item.cancelTarget);return;}
  const result=await mutate(selected.id,'/tasks/'+encodeURIComponent(selected.id)+'/dismiss',{kind:selected.kind,confirmUnfinished:true});
  if(result.ok){if(confirmation===selected)confirmation=null;render();}
  else toast(formatError(result.error)||labels().failed);
 }
 function cancel(){if(busy)return;const previous=confirmation;confirmation=null;render();if(previous)[...document.querySelectorAll(previous.mode==='cancel'?'[data-task-cancel]':'[data-task-dismiss]')].find(node=>(previous.mode==='cancel'?node.dataset.taskCancel:node.dataset.taskDismiss)===previous.id&&node.dataset.progressKind===previous.kind)?.focus();}
 async function clearCompleted(){
  if(!ready('clear-completed')||!getModel().completedCount)return;
  const result=await mutate('clear-completed','/tasks/clear-completed',{});
  if(result.ok){confirmation=null;render();toast(result.value?.cleared===0?labels().kept:labels().cleared);}else toast(formatError(result.error)||labels().failed);
 }
 async function priority(id,kind,value){
  if(!valid(id,kind)||!priorities.has(value)||!ready(id)){render();return;}
  const result=await mutate(id,'/tasks/'+encodeURIComponent(id)+'/priority',{kind,priority:value});
  if(!result.ok)toast(formatError(result.error)||labels().failed);
 }
 function renderConfirmation(){
  if(!confirmation)return '';
  if(confirmation.mode==='cancel'){const text=labels(),changed=!findCancellation(confirmation)?.canCancel;return `<section class="progress-confirmation" data-key="progress-cancel-confirmation" role="alertdialog" aria-modal="false" aria-labelledby="progress-cancel-title"><strong id="progress-cancel-title">${text.cancelTitle}</strong><p>${changed?text.changed:text.cancelHint}</p>${confirmation.title?`<blockquote>${escape(confirmation.title)}</blockquote>`:''}<div class="task-actions"><button type="button" class="text-btn" data-progress-task-cancel-back ${busy?'disabled':''}>${text.keepWorking}</button><button type="button" class="text-btn danger" data-progress-task-cancel-confirm ${busy||changed?'disabled':''}>${text.confirmCancel}</button></div></section>`;}
  const text=labels();return `<section class="progress-confirmation" data-key="progress-dismiss-confirmation" role="alertdialog" aria-modal="false" aria-labelledby="progress-dismiss-title"><strong id="progress-dismiss-title">${text.title}</strong><p>${text.hint}</p>${confirmation.title?`<blockquote>${escape(confirmation.title)}</blockquote>`:''}<div class="task-actions"><button type="button" class="text-btn" data-progress-dismiss-cancel ${busy?'disabled':''}>${text.cancel}</button><button type="button" class="text-btn danger" data-progress-dismiss-confirm ${busy?'disabled':''}>${text.remove}</button></div></section>`;
 }
 function bind(){
  document.querySelectorAll('[data-task-pause]').forEach(node=>node.onclick=()=>pauseTask({id:node.dataset.taskPause,kind:node.dataset.progressKind,turnId:node.dataset.progressTurn||null,callId:node.dataset.progressCall||null}));
  document.querySelectorAll('[data-task-work-resume]').forEach(node=>node.onclick=()=>resumeTask({id:node.dataset.taskWorkResume,kind:node.dataset.progressKind,turnId:node.dataset.progressTurn||null,callId:null}));
  document.querySelectorAll('[data-task-cancel]').forEach(node=>node.onclick=()=>cancelTask({id:node.dataset.taskCancel,kind:node.dataset.progressKind,turnId:node.dataset.progressTurn||null,callId:node.dataset.progressCall||null}));
  document.querySelectorAll('[data-progress-task-cancel-confirm]').forEach(node=>node.onclick=confirmCancellation);
  document.querySelectorAll('[data-progress-task-cancel-back]').forEach(node=>node.onclick=cancel);
  document.querySelectorAll('[data-task-dismiss]').forEach(node=>node.onclick=()=>dismiss(node.dataset.taskDismiss,node.dataset.progressKind));
  document.querySelectorAll('[data-task-priority]').forEach(node=>node.onchange=()=>priority(node.dataset.taskPriority,node.dataset.progressKind,node.value));
  document.querySelectorAll('[data-progress-clear-completed]').forEach(node=>node.onclick=clearCompleted);
  document.querySelectorAll('[data-progress-dismiss-confirm]').forEach(node=>node.onclick=confirmDismiss);
  document.querySelectorAll('[data-progress-dismiss-cancel]').forEach(node=>node.onclick=cancel);
 }
 return {bind,renderConfirmation,onClose(){confirmation=null;epoch++;},get busy(){return busy;}};
}
