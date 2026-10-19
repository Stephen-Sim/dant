import {formatCallDuration} from './call-duration.js';

const copy={
 en:{title:'Work progress',idle:'No task is running',offline:'Work status is unavailable',running:'Working',background:'Continuing in the background',waiting_user:'Waiting for your reply',pausing:'Stopping safely',unknown:'Status unconfirmed',review:'Awaiting review',paused:'Paused',failed:'Failed',completed:'Completed',queued:'Queued',voice:'Task from a call',chat:'Chat task',task:'Task',preparing:'Preparing',working:'Working',computer:'Using the computer',command:'Running a command',files:'Working with files',responding:'Preparing a reply',saving:'Saving the result',elapsed:'Elapsed',updated:'Last update',steps:'steps completed',plan:'Task steps',pendingStep:'Pending',inProgressStep:'In progress',dismiss:'Dismiss task',view:'View result',unread:'Unread result',stale:'Reconnect to confirm the current state. The last known task is kept.',continues:'Hanging up or closing the window keeps this task running.',queuedCount:n=>`${n} queued`,reviewCount:n=>`${n} awaiting review`},
 zh:{title:'工作进度',idle:'当前没有正在执行的任务',offline:'暂时无法确认工作状态',running:'正在执行',background:'正在后台继续',waiting_user:'等待你回复',pausing:'正在安全停止',unknown:'状态未确认',review:'待验收',paused:'已暂停',failed:'失败',completed:'已完成',queued:'排队中',voice:'通话中交办的任务',chat:'聊天任务',task:'任务',preparing:'准备任务',working:'正在处理',computer:'正在操作电脑',command:'正在执行命令',files:'正在处理文件',responding:'正在准备回复',saving:'正在保存结果',elapsed:'已用时',updated:'最后更新',steps:'步已完成',plan:'任务步骤',pendingStep:'待处理',inProgressStep:'正在执行',dismiss:'收起任务',view:'查看结果',unread:'结果未读',stale:'重新连接后才能确认当前状态；保留上次已知任务。',continues:'挂断通话或关闭窗口后，这项任务会继续执行。',queuedCount:n=>`${n} 项排队中`,reviewCount:n=>`${n} 项待验收`}
};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
Object.assign(copy.en,{continuing:'In progress',ongoing:'Ongoing tasks',unfinished:'dant will continue the remaining work when the work computer is available, and notify you when it finishes, fails or needs your reply.',automaticNoProgress:'Paused because repeated attempts did not advance this task. Check it or send more instructions.',completedTasks:'Completed tasks',clearCompleted:'Clear all',priority:'Priority',priorityHigh:'High',priorityNormal:'Normal',priorityLow:'Low',cancelled:'Cancelled',cancelTask:'Cancel task',cancelCurrent:'Cancel current work',stoppedStep:'Stopped'});
Object.assign(copy.zh,{continuing:'进行中',ongoing:'进行中的任务',unfinished:'dant 会在工作电脑可用时继续执行剩余工作；完成、失败或需要你回复时会通知你。',automaticNoProgress:'多次尝试仍未推进任务，已暂停；请检查任务或发送补充说明。',completedTasks:'已完成的任务',clearCompleted:'清空全部',priority:'优先级',priorityHigh:'高',priorityNormal:'普通',priorityLow:'低',cancelled:'已取消',cancelTask:'取消任务',cancelCurrent:'取消当前工作',stoppedStep:'已停止'});
Object.assign(copy.en,{pauseTask:'Pause task',pauseCurrent:'Pause current work',resumeTask:'Resume task',pausedStep:'Paused'});
Object.assign(copy.zh,{pauseTask:'暂停任务',pauseCurrent:'暂停当前工作',resumeTask:'继续任务',pausedStep:'已暂停'});
Object.assign(copy.en,{replyTask:'Reply to task',replyServiceUpdate:'Update the work computer service to reply to this task.'});
Object.assign(copy.zh,{replyTask:'回复任务',replyServiceUpdate:'请更新工作电脑服务后，再回复这项任务。'});
const priority=value=>['high','normal','low'].includes(value)?value:'normal';
const priorityOrder={high:0,normal:1,low:2};
const compareProgress=(a,b)=>priorityOrder[a.progressPriority]-priorityOrder[b.progressPriority]||Number(a.progressCompleted)-Number(b.progressCompleted)||(b.time||0)-(a.time||0);
const unconfirmed=value=>value?.unknownOutcome===true||['unknown','submitting'].includes(value?.submission);
const time=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=8640000000000000?value:null;
const text=(message,fallback)=>String(message?.text||message?.attachments?.map(file=>file.name).join(', ')||fallback).slice(0,240);
const statuses=new Set(['draft','running','continuing','waiting_user','pausing','unknown','review','paused','failed','completed','queued','cancelled','interrupted']);
const status=value=>value==='read'?'review':statuses.has(value)?value:'unknown';
const finalStatuses=new Set(['review','paused','failed','completed','continuing','cancelled']);
const read=message=>message?.read===true||Boolean(message?.readAt||message?.receipt?.readAt||message?.visibleAt);
const elapsedTime=(startedAt,now)=>formatCallDuration(Math.max(0,Math.floor((now-startedAt)/1000)));
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
 const userIds=new Set(users.map(message=>message.id)),usersByTurn=new Map(),userById=new Map(),unconfirmedTurns=new Set(),unconfirmedWorkIds=new Set(),completedUserTurns=new Set(),workByTurn=new Map(),completionsByTurn=new Map();
 for(const message of messages){if(message.role!=='user')continue;userById.set(message.id,message);if(unconfirmed(message)&&message.workId)unconfirmedWorkIds.add(message.workId);if(!message.turnId)continue;const owners=usersByTurn.get(message.turnId)||[];owners.push(message);usersByTurn.set(message.turnId,owners);if(unconfirmed(message))unconfirmedTurns.add(message.turnId);if(message.status==='completed')completedUserTurns.add(message.turnId);}
 for(const record of state?.workTasks||[]){if(!record?.turnId)continue;for(const turnId of new Set([record.turnId,...(record.turnIds||[])])){const records=workByTurn.get(turnId)||[];records.push(record);workByTurn.set(turnId,records);}}
 for(const [index,completion]of (state?.completions||[]).entries()){if(!completion?.turnId)continue;const receipts=completionsByTurn.get(completion.turnId)||[];receipts.push({completion,index});completionsByTurn.set(completion.turnId,receipts);}
 const isCompleted=(entry,kind)=>{
  if(unconfirmed(entry))return false;if(kind==='task')return entry.status==='completed';
  if(unconfirmedTurns.has(entry.turnId))return false;if(kind==='work')return entry.status==='completed';
  const requested=userById.get(entry.taskId);if(unconfirmed(requested))return false;const records=workByTurn.get(entry.turnId);
  if(records?.length)return records.some(record=>record.turnId===entry.turnId&&record.status==='completed');
  return entry.taskId?requested?.turnId===entry.turnId&&requested.status==='completed':completedUserTurns.has(entry.turnId);
 };
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
  const kind=registered?'work':current.messageId?'task':'active',id=registered?.id||current.messageId||'current',turnId=current.turnId||null;
  active={...current,progressPriority:priority(current.progressPriority??registered?.progressPriority??message?.progressPriority),title:title(current.title)||title(registered?.title)||text(message,labels[source==='voice'?'voice':'task']),source,canSteer:current.canSteer===true||current.canSteer===undefined&&source==='chat'&&Boolean(current.turnId),status:reliable?known:'unknown',knownStatus:known,stale:!reliable,startedAt:time(current.startedAt)||time(registered?.startedAt)||time(message?.time),updatedAt:time(current.updatedAt)||time(registered?.updatedAt),plan:workPlan(current.plan||registered?.plan),cancelTarget:{id,kind,turnId,callId:current.callId||null},canCancel:reliable&&['running','waiting_user'].includes(known)&&(Boolean(turnId)||kind==='task')&&!unconfirmed(message)&&!unconfirmed(registered)};
  active.canPause=active.canCancel;
 }
 const queue=(state?.queue||[]).map(id=>byId.get(id)).filter(message=>message&&userIds.has(message.id)).map(message=>({message,status:'queued',progressPriority:priority(message.progressPriority),title:text(message,labels.task),time:time(message.time)}));
 const history=users.filter(message=>!activeIds.has(message.id)&&!queueIds.has(message.id)&&!registeredMessages.has(message.id)&&!registeredTurns.has(message.turnId)&&!time(message.progressDismissedAt)).map(message=>({message,status:status(message.status),progressCompleted:isCompleted(message,'task'),progressPriority:priority(message.progressPriority),title:text(message,labels.task),time:time(message.time),voice:false}));
 for(const record of records){
  const original=byId.get(record.messageId),turnIds=new Set([record.turnId,...(record.turnIds||[])]),message=usersByTurn.get(record.turnId)?.[0]||(original?.role==='user'&&!original.turnId?original:null),ownsMessage=message?.role==='user';
  if(time(record.progressDismissedAt)||record.id===current?.workId||record.turnId===current?.turnId||!current?.turnId&&activeIds.has(record.messageId)||ownsMessage&&queueIds.has(record.messageId))continue;
  const results=[...turnIds].flatMap(turnId=>completionsByTurn.get(turnId)||[]).sort((a,b)=>a.index-b.index).flatMap(({completion})=>completion.messageIds||[]).map(id=>byId.get(id)).filter(item=>item?.role==='assistant'&&item.kind!=='call');
  const known=status(record.status),source=record.source==='voice'?'voice':'chat';
  const canCancel=Boolean(reliable&&['continuing','waiting_user'].includes(known)&&!unconfirmed(record)&&!unconfirmedTurns.has(record.turnId)),plan=workPlan(record.plan),resumePlan=record.plan===null?record.provisional===true:plan?.steps?.some(step=>step.status!=='completed');
  const replyTarget=typeof state?.conversationId==='string'&&state.conversationId?{workId:record.id,turnId:record.turnId,conversationId:state.conversationId}:null;
  const replySupported=state?.capabilities?.workReply===true,canReply=Boolean(replyTarget&&replySupported&&reliable&&['continuing','waiting_user','paused'].includes(known)&&Number.isSafeInteger(record.executionEndedAt)&&time(record.executionEndedAt)&&!unconfirmed(record)&&!unconfirmed(message)&&!unconfirmedTurns.has(record.turnId)&&!unconfirmedWorkIds.has(record.id)&&!record.continuation?.invalid&&!record.continuation?.dispatch);
  history.push({id:record.id,turnId:record.turnId,work:true,registered:true,voice:source==='voice',source,progressCompleted:isCompleted(record,'work'),progressPriority:priority(record.progressPriority??message?.progressPriority),taskId:ownsMessage?message.id:null,message:ownsMessage?message:undefined,messageId:results[0]?.id,status:!reliable&&['running','waiting_user','pausing'].includes(known)?'unknown':known,knownStatus:known,stale:!reliable,pauseReason:record.pauseReason==='automatic-no-progress'?'automatic-no-progress':null,canDismiss:finalStatuses.has(known),cancelTarget:{id:record.id,kind:'work',turnId:record.turnId,callId:null},canCancel,canPause:canCancel,replyTarget,replySupported,canReply,canResume:Boolean(reliable&&known==='paused'&&Number.isSafeInteger(record.executionEndedAt)&&time(record.executionEndedAt)&&resumePlan&&!unconfirmed(record)&&!unconfirmed(message)&&!unconfirmedTurns.has(record.turnId)&&!unconfirmedWorkIds.has(record.id)&&!record.continuation?.invalid&&!record.continuation?.dispatch),title:title(record.title)||text(message,labels[source==='voice'?'voice':'task']),time:time(record.updatedAt)||time(record.startedAt)||time(message?.time),startedAt:time(record.startedAt),updatedAt:time(record.updatedAt),plan,unread:results.some(item=>!read(item))});
 }
 const seen=new Set();
 for(const completion of state?.completions||[]){
  if(!completion?.turnId||registeredTurns.has(completion.turnId)||time(completion.progressDismissedAt)||seen.has(completion.turnId)||completion.turnId===current?.turnId||userIds.has(completion.taskId))continue;
  const result=(completion.messageIds||[]).map(id=>byId.get(id)).filter(message=>message?.role==='assistant'&&message.kind!=='call');
  if(!result.length||completion.work?.source!=='voice'||!['review','failed','paused','cancelled'].includes(completion.work.status))continue;
  seen.add(completion.turnId);
  const accepted=isCompleted(completion,'completion');
  history.push({id:completion.id||completion.turnId,voice:true,progressCompleted:accepted,progressPriority:priority(completion.progressPriority),status:accepted?'completed':status(completion.work?.status||'review'),title:labels.voice,time:time(completion.work?.updatedAt)||time(completion.at),messageId:result[0].id,unread:result.some(message=>!read(message))});
 }
 history.sort(compareProgress);
 const isOngoing=item=>item.registered&&['continuing','waiting_user'].includes(item.knownStatus),ongoing=history.filter(isOngoing),recent=history.filter(item=>!isOngoing(item));
 const reviewCount=recent.filter(item=>item.status==='review'&&(!item.voice||item.unread)).length;
 const completed=recent.filter(item=>item.progressCompleted);
 const replyReferences=records.filter(record=>!time(record.progressDismissedAt)).map(record=>({workId:record.id,conversationId:state?.conversationId||null,title:title(record.title)||text(byId.get(record.messageId),labels.task)}));
 return {conversationId:state?.conversationId||null,taskReplySupported:state?.capabilities?.workReply===true,replyReferences,active,queue,ongoing,history:recent.slice(0,12),recent:recent.filter(item=>!item.progressCompleted).slice(0,12),completed,completedCount:completed.length,items:history,reviewCount,reliable,now,labels};
}
export function renderWorkEntry(model,icon=''){
 const {labels,reviewCount}=model,label=labels.title+(reviewCount?' · '+labels.reviewCount(reviewCount):'');
 return `<button type="button" class="text-btn header-work" data-action="progress" title="${escape(label)}" aria-label="${escape(label)}">${icon}<span>${escape(labels.title)}</span>${reviewCount?'<i class="work-review-marker" data-work-review-marker aria-hidden="true"></i>':''}</button>`;
}
export function renderWorkSummary(model){
 const {active,ongoing=[],queue=[],labels,reliable}=model,item=active||ongoing[0]||queue[0];if(!item)return '';
 const state=reliable?active?.status||ongoing[0]?.status||'queued':'unknown',label=state==='running'&&active?.background?labels.background:labels[state]||labels.unknown;
 const hint=!reliable?labels.stale:labels.title;
 return `<button type="button" class="work-summary ${escape(state)}" data-key="work-summary" data-action="progress" title="${escape(hint)}" aria-label="${escape(labels.title+': '+label+' · '+item.title)}"><i class="work-status-dot" aria-hidden="true"></i><span class="work-summary-content"><small>${escape(label)}</small><strong>${escape(item.title)}</strong></span><span class="work-summary-chevron" aria-hidden="true">›</span></button>`;
}
function renderPlan(plan,labels,{history=false,workId,expanded=false,cancelled=false,paused=false}={}){
 if(!plan)return '';
 const count=`${plan.completed} / ${plan.total} ${escape(labels.steps)}`;
 const checklist=plan.steps?.length?`<ol class="work-checklist" aria-label="${escape(labels.plan)}">${plan.steps.map(item=>{const stopped=(cancelled||paused)&&item.status==='inProgress',state=stopped?(cancelled?'cancelled':'paused'):item.status;return `<li data-work-step-status="${state}"><span class="work-step-icon" aria-hidden="true">${item.status==='completed'?'✓':stopped?'−':item.status==='inProgress'?'◉':'○'}</span><span>${escape(item.step)}</span><small>${escape(item.status==='completed'?labels.completed:stopped?(cancelled?labels.stoppedStep:labels.pausedStep):item.status==='inProgress'?labels.inProgressStep:labels.pendingStep)}</small></li>`;}).join('')}</ol>`:plan.currentStep?`<p>${escape(plan.currentStep)}</p>`:'';
 if(history)return `<details class="work-plan work-history-plan" data-key="work-plan-${escape(workId)}" data-work-plan="${escape(workId)}" ${expanded?'open':''}><summary>${count}</summary>${checklist}</details>`;
 return `<div class="work-plan"><div><span>${count}</span></div><progress max="${plan.total}" value="${plan.completed}" aria-label="${escape(labels.steps)}"></progress>${checklist}</div>`;
}
export function renderWorkCancel(item,labels,{pending=false,compact=false}={}){
 const target=item.cancelTarget;if(!target)return '';
 return `<button type="button" class="${compact?'icon-btn progress-cancel':'text-btn current-work-cancel'}" data-task-cancel="${escape(target.id)}" data-progress-kind="${escape(target.kind)}" data-progress-turn="${escape(target.turnId||'')}" data-progress-call="${escape(target.callId||'')}" title="${escape(labels.cancelTask)}" aria-label="${escape(compact?labels.cancelTask:labels.cancelCurrent)}" ${pending||!item.canCancel?'disabled':''}>${compact?'<span aria-hidden="true">×</span>':escape(labels.cancelCurrent)}</button>`;
}
function renderWorkPause(item,labels,{pending=false,active=false}={}){
 const target=item.cancelTarget;if(!target)return '';
 return `<button type="button" class="text-btn" data-task-pause="${escape(target.id)}" data-progress-kind="${escape(target.kind)}" data-progress-turn="${escape(target.turnId||'')}" data-progress-call="${escape(target.callId||'')}" ${pending||!item.canPause?'disabled':''}>${escape(active?labels.pauseCurrent:labels.pauseTask)}</button>`;
}
function renderWorkResume(item,labels,{pending=false}={}){
 const target=item.cancelTarget;if(!target)return '';
 return `<button type="button" class="text-btn" data-task-work-resume="${escape(target.id)}" data-progress-kind="${escape(target.kind)}" data-progress-turn="${escape(target.turnId||'')}" ${pending||!item.canResume?'disabled':''}>${escape(labels.resumeTask)}</button>`;
}
function renderWorkReply(item,labels,{pending=false}={}){
 const target=item.replyTarget;if(!target||!['continuing','waiting_user','paused'].includes(item.knownStatus))return '';
 return `<button type="button" class="text-btn" data-task-work-reply="${escape(target.workId)}" data-progress-turn="${escape(target.turnId)}" data-progress-conversation="${escape(target.conversationId)}"${item.replySupported===false?` title="${escape(labels.replyServiceUpdate)}"`:''} ${pending||!item.canReply?'disabled':''}>${escape(labels.replyTask)}</button>`;
}
export function renderActiveWork(model,{pending=false}={}){
 const {active,labels,now}=model;if(!active)return '';
 const state=active.status,label=state==='running'&&active.background?labels.background:labels[state]||labels.unknown;
 const duration=active.startedAt?elapsedTime(active.startedAt,now):'';
 const updated=active.updatedAt?new Intl.DateTimeFormat(labels===copy.zh?'zh-CN':'en',{hour:'2-digit',minute:'2-digit'}).format(active.updatedAt):'';
 return `<section class="current-work ${escape(state)}" data-key="current-work"><div class="current-work-status"><i class="work-status-dot" aria-hidden="true"></i><strong>${escape(label)}</strong><small>${escape(labels[active.source==='voice'?'voice':'chat'])}</small>${renderWorkCancel(active,labels,{pending,compact:true})}</div><h3>${escape(active.title)}</h3><p class="work-step">${escape(labels[active.step]||labels.working)}</p>${renderPlan(active.plan,labels)}<div class="work-time">${duration?`<span>${escape(labels.elapsed)} · <time data-work-started="${active.startedAt}">${duration}</time></span>`:''}${updated?`<span>${escape(labels.updated)} · ${escape(updated)}</span>`:''}</div><p class="work-continuation">${escape(active.stale?labels.stale:labels.continues)}</p><div class="task-actions">${renderWorkPause(active,labels,{pending,active:true})}${renderWorkCancel(active,labels,{pending})}</div></section>`;
}
export function renderVoiceWorkHistory(item,labels,{pending=false}={}){
 const dismiss=labels.dismiss;
 return `<div class="progress-item voice-work" data-key="voice-work-${escape(item.id)}"><span class="progress-state ${escape(item.status)}" aria-hidden="true">◷</span><div><p>${escape(item.title)}</p><small>${escape(labels[item.status]||labels.unknown)}${item.unread?' · '+escape(labels.unread):''}</small><div class="task-actions">${renderWorkPriority({...item,voice:true},labels,{pending})}<button type="button" class="text-btn" data-progress-message="${escape(item.messageId)}">${escape(labels.view)}</button></div></div><button type="button" class="icon-btn progress-dismiss" data-task-dismiss="${escape(item.id)}" data-progress-kind="completion" data-progress-status="${escape(item.knownStatus||item.status)}" title="${escape(dismiss)}" aria-label="${escape(dismiss)}" ${pending?'disabled':''}><span aria-hidden="true">×</span></button></div>`;
}
export function renderWorkPriority(item,labels,{pending=false}={}){
 const kind=item.registered||item.work?'work':item.voice?'completion':'task',id=kind==='task'?item.message?.id||item.id:item.id;if(!id)return '';
 const selected=priority(item.progressPriority??item.message?.progressPriority);
 return `<label class="work-priority"><span>${escape(labels.priority)}</span><select data-task-priority="${escape(id)}" data-progress-kind="${kind}" aria-label="${escape(labels.priority)}" ${pending?'disabled':''}>${['high','normal','low'].map(value=>`<option value="${value}" ${selected===value?'selected':''}>${escape(labels[{high:'priorityHigh',normal:'priorityNormal',low:'priorityLow'}[value]])}</option>`).join('')}</select></label>`;
}
export function renderWorkTaskHistory(item,labels,{pending=false,actions='',planOpen=false}={}){
 const at=item.time?new Intl.DateTimeFormat(labels===copy.zh?'zh-CN':'en',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(item.time):'';
 const view=item.messageId?`<button type="button" class="text-btn" data-progress-message="${escape(item.messageId)}">${escape(labels.view)}</button>`:'';
 const ongoing=['continuing','waiting_user'].includes(item.knownStatus);
 const continuationHint=item.status==='paused'&&item.pauseReason==='automatic-no-progress'?labels.automaticNoProgress:item.knownStatus==='continuing'?(item.stale?labels.stale:labels.unfinished):'';
 const paused=(item.knownStatus||item.status)==='paused',legacyActions=actions;
 return `<div class="progress-item registered-work${ongoing?' ongoing-work':''}" data-key="registered-work-${escape(item.id)}"><span class="progress-state ${escape(item.status)}" aria-hidden="true">${item.status==='completed'?'✓':item.status==='cancelled'?'−':'◷'}</span><div><p>${escape(item.title)}</p><small>${escape(labels[item.status]||labels.unknown)}${at?' · '+escape(at):''}${item.unread?' · '+escape(labels.unread):''}</small>${continuationHint?`<p class="work-continuation">${escape(continuationHint)}</p>`:''}${renderPlan(item.plan,labels,{history:true,workId:item.id,expanded:planOpen,cancelled:item.status==='cancelled',paused})}<div class="task-actions">${renderWorkReply(item,labels,{pending})}${renderWorkPriority({...item,registered:true},labels,{pending})}${view}${ongoing?renderWorkPause(item,labels,{pending}):paused?renderWorkResume(item,labels,{pending}):''}</div>${legacyActions}</div>${ongoing?renderWorkCancel(item,labels,{pending,compact:true}):item.canDismiss?`<button type="button" class="icon-btn progress-dismiss" data-task-dismiss="${escape(item.id)}" data-progress-kind="work" data-progress-status="${escape(item.knownStatus||item.status)}" title="${escape(labels.dismiss)}" aria-label="${escape(labels.dismiss)}" ${pending?'disabled':''}><span aria-hidden="true">×</span></button>`:''}</div>`;
}
