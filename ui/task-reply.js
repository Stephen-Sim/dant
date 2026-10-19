const copy={
 en:{reply:'Replying to task',reference:'Reply to task',task:'Task',cancel:'Cancel task reply',changed:'This task has changed or is no longer available. Open Work progress and select it again. Your draft has been kept.',offline:'Reconnect before replying to this task. Your draft has been kept.',unsupported:'Update the work computer service before replying to this task. Your draft has been kept.',sending:'Wait for the current message to finish sending.'},
 zh:{reply:'正在回复任务',reference:'回复任务',task:'任务',cancel:'取消回复任务',changed:'任务状态已变化或已不可用，请打开工作进度重新选择。草稿已保留。',offline:'请重新连接后再回复这项任务，草稿已保留。',unsupported:'请更新工作电脑服务后再回复这项任务，草稿已保留。',sending:'请等待当前消息发送完成。'},
};
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const id=(value,limit)=>typeof value==='string'&&value.length>0&&value.length<=limit&&!/[\x00-\x1f\x7f]/.test(value);
const valid=target=>target&&id(target.workId,128)&&id(target.turnId,256)&&id(target.conversationId,128);
const same=(left,right)=>Boolean(valid(left)&&valid(right)&&left.workId===right.workId&&left.turnId===right.turnId&&left.conversationId===right.conversationId);
const payload=target=>({workId:target.workId,turnId:target.turnId,conversationId:target.conversationId});

// A task target is independent of the ordinary quoted-message reply and composer draft.
// Selection never submits a message, resumes a task or changes another task's owner.
export function createTaskReplyController({document=globalThis.document,getModel,getLanguage=()=> 'en',render=()=>{},openChat=()=>{},toast=()=>{},isPending=()=>false}={}){
 let selected=null,pending=false;
 const words=()=>copy[getLanguage()==='zh'?'zh':'en'];
 const busy=()=>pending||isPending();
 const items=model=>[model?.active,...(model?.items||[]),...(model?.ongoing||[]),...(model?.recent||model?.history||[])].filter(Boolean);
 const find=(target,model=getModel())=>model?.conversationId===target.conversationId?items(model).find(item=>item.canReply===true&&same(item.replyTarget,target)):null;
 const focus=()=>document?.querySelector('#composer')?.focus({preventScroll:true});
 const error=message=>Object.assign(Error(message),{code:'task_reply_changed'});
 function select(target){
  if(busy()){toast(words().sending);return false;}
  if(!valid(target)){toast(words().changed);return false;}
  const model=getModel();if(model?.reliable===false){toast(words().offline);return false;}if(model?.taskReplySupported!==true){toast(words().unsupported);return false;}
  const item=find(target,model);if(!item){toast(words().changed);return false;}
  selected={...payload(target),title:String(item.title||words().task).slice(0,240)};
  openChat();render();focus();return true;
 }
 function cancel(){if(busy())return false;selected=null;render();focus();return true;}
 function restore(target){
  if(!valid(target)||busy())return false;
  const model=getModel(),reference=model?.replyReferences?.find(item=>item.workId===target.workId&&item.conversationId===target.conversationId);
  selected={...payload(target),title:String(reference?.title||words().task).slice(0,240)};
  return true;
 }
 function prepare(){
  if(!selected)return null;
  const model=getModel();if(model?.reliable===false)throw error(words().offline);if(model?.taskReplySupported!==true)throw error(words().unsupported);
  if(!find(selected,model))throw error(words().changed);
  return payload(selected);
 }
 function renderPreview(){
  if(!selected)return '';
  const model=getModel(),warning=model?.reliable===false?words().offline:model?.taskReplySupported!==true?words().unsupported:find(selected,model)?'':words().changed;
  const title=find(selected,model)?.title||selected.title;
  return `<div class="task-reply-preview" data-key="task-reply-preview" data-task-reply-preview><div><small>${words().reply}</small><strong>${escape(title)}</strong>${warning?`<span class="task-reply-warning" role="status">${escape(warning)}</span>`:''}</div><button type="button" class="icon-btn" data-task-reply-cancel title="${escape(words().cancel)}" aria-label="${escape(words().cancel)}" ${busy()?'disabled':''}><span aria-hidden="true">×</span></button></div>`;
 }
 function renderMessageReference(message){
  const target=message?.workReply,model=getModel();if(message?.role!=='user'||!valid(target)||target.conversationId!==model?.conversationId)return '';
  // Historical turns legitimately differ after the task is continued. Only the
  // current conversation and stable work ID determine the displayed title.
  const item=model.replyReferences?.find(item=>item.workId===target.workId&&item.conversationId===target.conversationId)||items(model).find(item=>item.id===target.workId&&item.replyTarget?.conversationId===target.conversationId);
  const title=item?.title||words().task;
  return `<blockquote class="task-message-reference" data-task-reply-reference><small>${words().reference}</small><span>${escape(String(title).slice(0,240))}</span></blockquote>`;
 }
 function bind(){
  document?.querySelectorAll('[data-task-work-reply]').forEach(node=>{node.onclick=()=>select({workId:node.dataset.taskWorkReply,turnId:node.dataset.progressTurn,conversationId:node.dataset.progressConversation});});
  document?.querySelectorAll('[data-task-reply-cancel]').forEach(node=>{node.onclick=cancel;});
 }
 return {bind,select,restore,cancel,prepare,render:renderPreview,renderMessageReference,setPending(value){pending=value===true;},get pending(){return busy();},get selected(){return Boolean(selected);},get target(){return selected?payload(selected):null;},acknowledged(target){if(!same(selected,target))return false;selected=null;return true;}};
}
