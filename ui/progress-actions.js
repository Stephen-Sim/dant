const copy={
 en:{title:'Remove unfinished task?',hint:'This task is not completed. Remove it from Work progress? Its chat and results will stay.',cancel:'Cancel',remove:'Remove task',cleared:'Completed tasks cleared',kept:'Tasks still in use were kept. Try again later.',changed:'This task has changed. Check its current status and try again.',offline:'Reconnect to change Work progress.',failed:'The task could not be updated. Please try again.'},
 zh:{title:'删除未完成的任务？',hint:'这项任务尚未完成。确认从工作进度中移除？聊天和结果会保留。',cancel:'取消',remove:'确认删除',cleared:'已清空已完成的任务',kept:'仍在使用的任务已保留，请稍后再试。',changed:'任务状态已变化，请检查后重试。',offline:'请先重新连接，再修改工作进度。',failed:'任务修改失败，请重试。'}
};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kinds=new Set(['task','work','completion']),priorities=new Set(['high','normal','low']);
const identity=item=>item.registered||item.work?{id:item.id,kind:'work'}:item.voice?{id:item.id,kind:'completion'}:{id:item.message?.id,kind:'task'};
export function createProgressActions({getModel,request,render,toast,getLanguage=()=> 'en',formatError=error=>error.message,document=globalThis.document,isPending=()=>false}={}){
 let confirmation=null,busy=false,epoch=0;
 const labels=()=>copy[getLanguage()==='zh'?'zh':'en'];
 const valid=(id,kind)=>typeof id==='string'&&id.length>0&&id.length<=128&&kinds.has(kind);
 const find=(id,kind)=>{const model=getModel();return [...(model.items||[]),...(model.ongoing||[]),...(model.recent||model.history||[]),...(model.completed||[])].find(item=>{const key=identity(item);return key.id===id&&key.kind===kind;});};
 const ready=id=>{if(busy||isPending(id))return false;if(getModel().reliable===false){toast(labels().offline);return false;}return true;};
 function prompt(item,id,kind){confirmation={id,kind,title:item?.title||''};render();document.querySelector('[data-progress-dismiss-cancel]')?.focus();}
 async function mutate(id,route,body){
  busy=true;render();
  try{return {ok:true,value:await request(id,route,body)};}
  catch(error){return {ok:false,error};}
  finally{busy=false;render();}
 }
 async function dismiss(id,kind){
  if(!valid(id,kind)||!ready(id))return;
  const item=find(id,kind);if(!item){toast(labels().changed);return;}
  if(!item.progressCompleted){prompt(item,id,kind);return;}
  const currentEpoch=epoch;
  const result=await mutate(id,'/tasks/'+encodeURIComponent(id)+'/dismiss',{kind});
  if(!result.ok){if(result.error.code==='confirmation_required'&&currentEpoch===epoch)prompt(find(id,kind)||item,id,kind);else toast(formatError(result.error)||labels().failed);}
 }
 async function confirmDismiss(){
  const selected=confirmation;if(!selected||!ready(selected.id))return;
  if(!find(selected.id,selected.kind)){confirmation=null;render();toast(labels().changed);return;}
  const result=await mutate(selected.id,'/tasks/'+encodeURIComponent(selected.id)+'/dismiss',{kind:selected.kind,confirmUnfinished:true});
  if(result.ok){if(confirmation===selected)confirmation=null;render();}
  else toast(formatError(result.error)||labels().failed);
 }
 function cancel(){if(busy)return;const previous=confirmation;confirmation=null;render();if(previous)[...document.querySelectorAll('[data-task-dismiss]')].find(node=>node.dataset.taskDismiss===previous.id&&node.dataset.progressKind===previous.kind)?.focus();}
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
  const text=labels();return `<section class="progress-confirmation" data-key="progress-dismiss-confirmation" role="alertdialog" aria-modal="false" aria-labelledby="progress-dismiss-title"><strong id="progress-dismiss-title">${text.title}</strong><p>${text.hint}</p>${confirmation.title?`<blockquote>${escape(confirmation.title)}</blockquote>`:''}<div class="task-actions"><button type="button" class="text-btn" data-progress-dismiss-cancel ${busy?'disabled':''}>${text.cancel}</button><button type="button" class="text-btn danger" data-progress-dismiss-confirm ${busy?'disabled':''}>${text.remove}</button></div></section>`;
 }
 function bind(){
  document.querySelectorAll('[data-task-dismiss]').forEach(node=>node.onclick=()=>dismiss(node.dataset.taskDismiss,node.dataset.progressKind));
  document.querySelectorAll('[data-task-priority]').forEach(node=>node.onchange=()=>priority(node.dataset.taskPriority,node.dataset.progressKind,node.value));
  document.querySelectorAll('[data-progress-clear-completed]').forEach(node=>node.onclick=clearCompleted);
  document.querySelectorAll('[data-progress-dismiss-confirm]').forEach(node=>node.onclick=confirmDismiss);
  document.querySelectorAll('[data-progress-dismiss-cancel]').forEach(node=>node.onclick=cancel);
 }
 return {bind,renderConfirmation,onClose(){confirmation=null;epoch++;},get busy(){return busy;}};
}
