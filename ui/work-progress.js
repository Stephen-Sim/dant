const copy={
 en:{title:'Work progress',idle:'No task is running',offline:'Work status is unavailable',running:'Working',background:'Continuing in the background',waiting_user:'Waiting for your reply',pausing:'Stopping safely',unknown:'Status unconfirmed',review:'Awaiting review',paused:'Paused',failed:'Failed',completed:'Completed',queued:'Queued',voice:'Task from a call',chat:'Chat task',task:'Task',preparing:'Preparing',working:'Working',computer:'Using the computer',command:'Running a command',files:'Working with files',responding:'Preparing a reply',saving:'Saving the result',elapsed:'Elapsed',updated:'Last update',steps:'steps completed',plan:'Task steps',pendingStep:'Pending',inProgressStep:'In progress',dismiss:'Dismiss task',view:'View result',unread:'Unread result',stale:'Reconnect to confirm the current state. The last known task is kept.',continues:'Hanging up or closing the window keeps this task running.',queuedCount:n=>`${n} queued`,reviewCount:n=>`${n} awaiting review`},
 zh:{title:'工作进度',idle:'当前没有正在执行的任务',offline:'暂时无法确认工作状态',running:'正在执行',background:'正在后台继续',waiting_user:'等待你回复',pausing:'正在安全停止',unknown:'状态未确认',review:'待验收',paused:'已暂停',failed:'失败',completed:'已完成',queued:'排队中',voice:'通话中交办的任务',chat:'聊天任务',task:'任务',preparing:'准备任务',working:'正在处理',computer:'正在操作电脑',command:'正在执行命令',files:'正在处理文件',responding:'正在准备回复',saving:'正在保存结果',elapsed:'已用时',updated:'最后更新',steps:'步已完成',plan:'任务步骤',pendingStep:'待处理',inProgressStep:'正在执行',dismiss:'收起任务',view:'查看结果',unread:'结果未读',stale:'重新连接后才能确认当前状态；保留上次已知任务。',continues:'挂断通话或关闭窗口后，这项任务会继续执行。',queuedCount:n=>`${n} 项排队中`,reviewCount:n=>`${n} 项待验收`}
};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
Object.assign(copy.en,{continuing:'In progress',ongoing:'Ongoing tasks',unfinished:'This task is unfinished. Related follow-ups stay with this task.'});
Object.assign(copy.zh,{continuing:'进行中',ongoing:'进行中的任务',unfinished:'这项任务尚未完成；相关补充和追问会接续这项任务。'});
const time=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=8640000000000000?value:null;
const text=(message,fallback)=>String(message?.text||message?.attachments?.map(file=>file.name).join(', ')||fallback).slice(0,240);
const statuses=new Set(['draft','running','continuing','waiting_user','pausing','unknown','review','paused','failed','completed','queued','cancelled','interrupted']);
const status=value=>value==='read'?'review':statuses.has(value)?value:'unknown';
const finalStatuses=new Set(['review','paused','failed','completed','continuing']);
const read=message=>message?.read===true||Boolean(message?.readAt||message?.receipt?.readAt||message?.visibleAt);
const elapsedTime=(startedAt,now)=>{const seconds=Math.max(0,Math.floor((now-startedAt)/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
const title=value=>typeof value==='string'?value.trim().slice(0,240):'';
function workPlan(plan){
 if(!plan)return null;
 const steps=Array.isArray(plan.steps)?plan.steps.slice(0,128).filter(item=>title(item?.step)&&['pending','inProgress','completed'].includes(item.status)).map(item=>({step:title(item.step),status:item.status})):[];
 if(steps.length)return {total:steps.length,completed:steps.filter(item=>item.status==='completed').length,currentStep:steps.find(item=>item.status==='inProgress')?.step||'',steps};
 const total=Number.isSafeInteger(plan.total)&&plan.total>0&&plan.total<=128?plan.total:0,completed=Number.isSafeInteger(plan.completed)&&plan.completed>=0&&plan.completed<=total?plan.completed:0;
 return total?{total,completed,currentStep:title(plan.currentStep)}:null;
}
export function updateWorkTimers(document,now=Date.now()){
 for(const node of document.querySelectorAll('[data-work-started]')){const started=time(Number(node.dataset.workStarted));if(started)node.textContent=elapsedTime(started,now);}
}

export function workProgress(state,{language='en',connected=true,now=Date.now()}={}){
 const labels=copy[language==='zh'?'zh':'en'],messages=state?.messages||[],users=messages.filter(message=>message.role==='user'&&message.kind!=='call'&&message.workKind!=='conversation'&&!(message.voiceCallId&&!message.turnId)),byId=new Map(messages.map(message=>[message.id,message]));
 const reliable=connected&&state?.controller?.cached!==true&&(state?.controller?.status===undefined||state.controller.status==='online')&&(state?.worker?.status===undefined||state.worker.status==='online');
 const current=state?.active?.visible===false&&!['unknown','pausing','waiting_user'].includes(state.active.status)?null:state?.active,activeIds=new Set([current?.messageId,...(current?.messageIds||[])].filter(Boolean)),queueIds=new Set(state?.queue||[]);
 const records=[],registeredTurns=new Set(),registeredMessages=new Set(),recordIds=new Set();
 for(const record of [...(state?.workTasks||[])].sort((a,b)=>(time(b.updatedAt)||0)-(time(a.updatedAt)||0))){
  if(!record?.id||!record.turnId||registeredTurns.has(record.turnId)||recordIds.has(record.id))continue;
  records.push(record);for(const id of [record.turnId,...(record.turnIds||[])])registeredTurns.add(id);recordIds.add(record.id);const message=byId.get(record.messageId);if(message?.role==='user'&&(!message.turnId||registeredTurns.has(message.turnId)))registeredMessages.add(message.id);
 }
 const registered=records.find(record=>current&&(record.id===current.workId||record.turnId===current.turnId));
 if(current?.turnId)for(const message of users)if(message.turnId===current.turnId)activeIds.add(message.id);
 let active=null;
 if(current){
  const message=users.find(item=>activeIds.has(item.id)),source=current.source==='voice'?'voice':'chat',known=status(current.status||(['waiting_user','pausing'].includes(message?.status)?message.status:'running'));
  active={...current,title:title(current.title)||title(registered?.title)||text(message,labels[source==='voice'?'voice':'task']),source,canSteer:current.canSteer===true||current.canSteer===undefined&&source==='chat'&&Boolean(current.turnId),status:reliable?known:'unknown',knownStatus:known,stale:!reliable,startedAt:time(current.startedAt)||time(registered?.startedAt)||time(message?.time),updatedAt:time(current.updatedAt)||time(registered?.updatedAt),plan:workPlan(current.plan||registered?.plan)};
 }
 const queue=(state?.queue||[]).map(id=>byId.get(id)).filter(message=>users.includes(message)).map(message=>({message,status:'queued',title:text(message,labels.task),time:time(message.time)}));
 const history=users.filter(message=>!activeIds.has(message.id)&&!queueIds.has(message.id)&&!registeredMessages.has(message.id)&&!registeredTurns.has(message.turnId)&&!time(message.progressDismissedAt)).map(message=>({message,status:status(message.status),title:text(message,labels.task),time:time(message.time),voice:false}));
 for(const record of records){
  const original=byId.get(record.messageId),turnIds=new Set([record.turnId,...(record.turnIds||[])]),message=messages.find(item=>item.role==='user'&&item.turnId===record.turnId)||(original?.role==='user'&&!original.turnId?original:null),ownsMessage=message?.role==='user';
  if(time(record.progressDismissedAt)||record.id===current?.workId||record.turnId===current?.turnId||!current?.turnId&&activeIds.has(record.messageId)||ownsMessage&&queueIds.has(record.messageId))continue;
  const results=(state?.completions||[]).filter(completion=>turnIds.has(completion.turnId)).flatMap(completion=>completion.messageIds||[]).map(id=>byId.get(id)).filter(item=>item?.role==='assistant'&&item.kind!=='call');
  const known=status(record.status),source=record.source==='voice'?'voice':'chat';
  history.push({id:record.id,turnId:record.turnId,work:true,registered:true,voice:source==='voice',source,taskId:ownsMessage?message.id:null,message:ownsMessage?message:undefined,messageId:results[0]?.id,status:!reliable&&['running','waiting_user','pausing'].includes(known)?'unknown':known,knownStatus:known,canDismiss:finalStatuses.has(known),title:title(record.title)||text(message,labels[source==='voice'?'voice':'task']),time:time(record.updatedAt)||time(record.startedAt)||time(message?.time),startedAt:time(record.startedAt),updatedAt:time(record.updatedAt),plan:workPlan(record.plan),unread:results.some(item=>!read(item))});
 }
 const seen=new Set();
 for(const completion of state?.completions||[]){
  if(!completion?.turnId||registeredTurns.has(completion.turnId)||time(completion.progressDismissedAt)||seen.has(completion.turnId)||completion.turnId===current?.turnId||users.some(message=>message.id===completion.taskId))continue;
  const result=(completion.messageIds||[]).map(id=>byId.get(id)).filter(message=>message?.role==='assistant'&&message.kind!=='call');
  if(!result.length||completion.work?.source!=='voice'||!['review','failed','paused'].includes(completion.work.status))continue;
  seen.add(completion.turnId);
  history.push({id:completion.id||completion.turnId,voice:true,status:status(completion.work?.status||'review'),title:labels.voice,time:time(completion.work?.updatedAt)||time(completion.at),messageId:result[0].id,unread:result.some(message=>!read(message))});
 }
 history.sort((a,b)=>(b.time||0)-(a.time||0));
 const ongoing=history.filter(item=>item.registered&&['continuing','waiting_user'].includes(item.knownStatus)),recent=history.filter(item=>!ongoing.includes(item));
 const reviewCount=recent.filter(item=>item.status==='review'&&(!item.voice||item.unread)).length;
 return {active,queue,ongoing,history:recent.slice(0,12),reviewCount,reliable,now,labels};
}
export function renderWorkEntry(model,icon=''){
 const {labels,reviewCount}=model,label=labels.title+(reviewCount?' · '+labels.reviewCount(reviewCount):'');
 return `<button type="button" class="text-btn header-work" data-action="progress" title="${escape(label)}" aria-label="${escape(label)}">${icon}<span>${escape(labels.title)}</span>${reviewCount?'<i class="work-review-marker" data-work-review-marker aria-hidden="true"></i>':''}</button>`;
}
function renderPlan(plan,labels,{history=false,workId,expanded=false}={}){
 if(!plan)return '';
 const count=`${plan.completed} / ${plan.total} ${escape(labels.steps)}`;
 const checklist=plan.steps?.length?`<ol class="work-checklist" aria-label="${escape(labels.plan)}">${plan.steps.map(item=>`<li data-work-step-status="${item.status}"><span class="work-step-icon" aria-hidden="true">${item.status==='completed'?'✓':item.status==='inProgress'?'◉':'○'}</span><span>${escape(item.step)}</span><small>${escape(item.status==='completed'?labels.completed:item.status==='inProgress'?labels.inProgressStep:labels.pendingStep)}</small></li>`).join('')}</ol>`:plan.currentStep?`<p>${escape(plan.currentStep)}</p>`:'';
 if(history)return `<details class="work-plan work-history-plan" data-key="work-plan-${escape(workId)}" data-work-plan="${escape(workId)}" ${expanded?'open':''}><summary>${count}</summary>${checklist}</details>`;
 return `<div class="work-plan"><div><span>${count}</span></div><progress max="${plan.total}" value="${plan.completed}" aria-label="${escape(labels.steps)}"></progress>${checklist}</div>`;
}
export function renderActiveWork(model){
 const {active,labels,now}=model;if(!active)return '';
 const state=active.status,label=state==='running'&&active.background?labels.background:labels[state]||labels.unknown;
 const duration=active.startedAt?elapsedTime(active.startedAt,now):'';
 const updated=active.updatedAt?new Intl.DateTimeFormat(labels===copy.zh?'zh-CN':'en',{hour:'2-digit',minute:'2-digit'}).format(active.updatedAt):'';
 return `<section class="current-work ${escape(state)}" data-key="current-work"><div class="current-work-status"><i class="work-status-dot" aria-hidden="true"></i><strong>${escape(label)}</strong><small>${escape(labels[active.source==='voice'?'voice':'chat'])}</small></div><h3>${escape(active.title)}</h3><p class="work-step">${escape(labels[active.step]||labels.working)}</p>${renderPlan(active.plan,labels)}<div class="work-time">${duration?`<span>${escape(labels.elapsed)} · <time data-work-started="${active.startedAt}">${duration}</time></span>`:''}${updated?`<span>${escape(labels.updated)} · ${escape(updated)}</span>`:''}</div><p class="work-continuation">${escape(active.stale?labels.stale:labels.continues)}</p></section>`;
}
export function renderVoiceWorkHistory(item,labels,{pending=false}={}){
 const dismiss=labels.dismiss;
 return `<div class="progress-item voice-work" data-key="voice-work-${escape(item.id)}"><span class="progress-state ${escape(item.status)}" aria-hidden="true">◷</span><div><p>${escape(item.title)}</p><small>${escape(labels[item.status]||labels.unknown)}${item.unread?' · '+escape(labels.unread):''}</small><div class="task-actions"><button type="button" class="text-btn" data-progress-message="${escape(item.messageId)}">${escape(labels.view)}</button></div></div><button type="button" class="icon-btn progress-dismiss" data-task-dismiss="${escape(item.id)}" data-progress-kind="completion" title="${dismiss}" aria-label="${dismiss}" ${pending?'disabled':''}><span aria-hidden="true">×</span></button></div>`;
}
export function renderWorkTaskHistory(item,labels,{pending=false,actions='',planOpen=false}={}){
 const at=item.time?new Intl.DateTimeFormat(labels===copy.zh?'zh-CN':'en',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(item.time):'';
 const view=item.messageId?`<button type="button" class="text-btn" data-progress-message="${escape(item.messageId)}">${escape(labels.view)}</button>`:'';
 return `<div class="progress-item registered-work${['continuing','waiting_user'].includes(item.knownStatus)?' ongoing-work':''}" data-key="registered-work-${escape(item.id)}"><span class="progress-state ${escape(item.status)}" aria-hidden="true">${item.status==='completed'?'✓':'◷'}</span><div><p>${escape(item.title)}</p><small>${escape(labels[item.status]||labels.unknown)}${at?' · '+escape(at):''}${item.unread?' · '+escape(labels.unread):''}</small>${item.knownStatus==='continuing'?`<p class="work-continuation">${escape(labels.unfinished)}</p>`:''}${renderPlan(item.plan,labels,{history:true,workId:item.id,expanded:planOpen})}${view?`<div class="task-actions">${view}</div>`:''}${actions}</div>${item.canDismiss?`<button type="button" class="icon-btn progress-dismiss" data-task-dismiss="${escape(item.id)}" data-progress-kind="work" title="${escape(labels.dismiss)}" aria-label="${escape(labels.dismiss)}" ${pending?'disabled':''}><span aria-hidden="true">×</span></button>`:''}</div>`;
}
