const copy={
 en:{title:'Scheduled tasks',hint:'Tell dant what to do and when, or create a task here.',create:'Create task',search:'Search scheduled tasks',placeholder:'Search tasks…',upcoming:'Upcoming',paused:'Paused',history:'History',all:'All',pending:'Scheduled',dispatched:'Sent to work',unknown:'Submission unconfirmed',task:'Task',at:'Run at',zone:'Time zone',once:'Runs once',save:'Save task',cancel:'Cancel',edit:'Edit',pause:'Pause',resume:'Resume',remove:'Remove',refresh:'Refresh',empty:'No scheduled tasks',emptyHint:'Ask dant to schedule work in chat or during a call.',noMatch:'No matching tasks',offline:'Connect the work computer to manage scheduled tasks.',availability:'Runs while dant and its work computer are online. Missed tasks wait until they are available.',future:'Choose a future date and time.',required:'Describe what dant should do.',error:'The scheduled task could not be saved. Your draft is kept.',count:n=>`${n} ${n===1?'task':'tasks'}`,editTitle:'Edit scheduled task'},
 zh:{title:'定时任务',hint:'告诉 dant 做什么、什么时候做，也可以在这里创建。',create:'创建任务',search:'搜索定时任务',placeholder:'搜索任务…',upcoming:'即将执行',paused:'已暂停',history:'历史',all:'全部',pending:'已安排',dispatched:'已交给任务执行',unknown:'提交未确认',task:'任务内容',at:'执行时间',zone:'时区',once:'执行一次',save:'保存任务',cancel:'取消',edit:'编辑',pause:'暂停',resume:'继续',remove:'移除',refresh:'刷新',empty:'暂无定时任务',emptyHint:'在聊天或通话中告诉 dant，即可安排定时工作。',noMatch:'没有匹配的任务',offline:'连接工作电脑后可管理定时任务。',availability:'dant 和工作电脑在线时执行，错过的任务会等待恢复可用后执行。',future:'请选择未来的日期和时间。',required:'请填写需要 dant 完成的工作。',error:'定时任务未能保存，草稿已保留。',count:n=>`${n} 项任务`,editTitle:'编辑定时任务'}
};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const localValue=(at,timeZone)=>{const date=new Date(at);if(!Number.isFinite(date.getTime()))return '';try{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;}catch{return '';}};
const isoValue=at=>{const date=new Date(at);return Number.isFinite(date.getTime())?date.toISOString():'';};
// datetime-local has no zone. Convert its wall time using the zone shown beside it,
// then reject nonexistent DST dates instead of silently scheduling another time.
function timestamp(value,timeZone){
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))return NaN;
 const wall=Date.parse(value+'Z');if(!Number.isFinite(wall))return NaN;let at=wall;
 for(let attempt=0;attempt<4;attempt++){const formatted=localValue(at,timeZone);if(!formatted)return NaN;const next=at+wall-Date.parse(formatted+'Z');if(next===at)break;at=next;}
 return localValue(at,timeZone)===value?at:NaN;
}
export function createSchedules({getState,request,render,toast,document=globalThis.document,connected=()=>true,icon=()=>'',now=()=>Date.now(),timeZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone,getID=()=>globalThis.crypto.randomUUID()}={}){
 let scope=null,query='',filter='upcoming',editor=null,busy=false,error='',generation=0;
 const labels=()=>copy[getState()?.settings?.language==='en'?'en':'zh'];
 const currentScope=()=>{const state=getState(),vm=state?.settings?.vm;return JSON.stringify([state?.conversationId,vm?.host,vm?.user,vm?.port]);};
 const online=()=>connected()&&getState()?.worker?.status==='online'&&(!getState()?.controller||getState().controller.status==='online')&&getState()?.controller?.cached!==true;
 function sync(){const next=currentScope();if(scope!==next){scope=next;query='';filter='upcoming';editor=null;busy=false;error='';generation++;}}
 function capture(){const form=document.querySelector('[data-schedule-editor]');if(editor&&form?.dataset.scheduleScope===scope&&!busy){editor.text=form.querySelector('[name="text"]').value;editor.at=form.querySelector('[name="at"]').value;}}
 const items=()=>Array.isArray(getState()?.schedules)?getState().schedules:[];
 const dateText=item=>{const value=new Date(item.at);if(!Number.isFinite(value.getTime()))return '';try{return new Intl.DateTimeFormat(getState()?.settings?.language==='en'?'en':'zh-CN',{dateStyle:'medium',timeStyle:'short',timeZone:item.timeZone||timeZone()}).format(value);}catch{return value.toLocaleString();}};
 function controls(item,locked){return `<div class="schedule-card-actions">${['pending','paused'].includes(item.status)?`<button type="button" class="text-btn" data-schedule-edit="${escape(item.id)}" ${locked?'disabled':''}>${labels().edit}</button><button type="button" class="text-btn" data-schedule-toggle="${escape(item.id)}" ${locked?'disabled':''}>${labels()[item.status==='pending'?'pause':'resume']}</button>`:''}<button type="button" class="text-btn" data-schedule-remove="${escape(item.id)}" ${locked?'disabled':''}>${labels().remove}</button></div>`;}
 function renderEditor(){if(!editor)return '';const l=labels();return `<section class="schedule-editor" data-key="schedule-editor"><div class="schedule-editor-heading"><h2>${l[editor.id?'editTitle':'create']}</h2><button type="button" class="icon-btn" data-schedule-cancel aria-label="${l.cancel}" ${busy?'disabled':''}>${icon('x')||'×'}</button></div><form data-schedule-editor data-schedule-scope="${escape(scope)}"><label>${l.task}<textarea name="text" rows="3" required ${busy?'disabled':''}>${escape(editor.text)}</textarea></label><div class="schedule-editor-time"><label>${l.at}<input name="at" type="datetime-local" value="${escape(editor.at)}" required ${busy?'disabled':''}></label><div><span>${l.zone}</span><strong>${escape(editor.timeZone)}</strong><small>${l.once}</small></div></div>${error?`<p class="error" role="status">${escape(error)}</p>`:''}<div class="form-actions"><button type="button" class="text-btn" data-schedule-cancel ${busy?'disabled':''}>${l.cancel}</button><button type="submit" class="text-btn primary" ${busy||!online()?'disabled':''}>${l.save}</button></div></form></section>`;}
 function renderPage(){sync();capture();const l=labels(),locked=busy||!online(),needle=query.normalize('NFKC').toLocaleLowerCase().trim(),matches=items().filter(item=>(filter==='all'||filter==='upcoming'&&item.status==='pending'||filter==='paused'&&item.status==='paused'||filter==='history'&&!['pending','paused'].includes(item.status))&&String(item.text||'').normalize('NFKC').toLocaleLowerCase().includes(needle)).sort((a,b)=>filter==='history'?b.at-a.at:a.at-b.at);
  return `<section class="skills-page schedules-page" aria-labelledby="schedules-page-title"><div class="skills-page-heading"><div><h1 id="schedules-page-title">${l.title}</h1><p>${l.hint}</p></div><button type="button" class="text-btn primary skill-page-add" data-schedule-add ${locked?'disabled':''}><span aria-hidden="true">+</span>${l.create}</button></div>${renderEditor()}<div class="skills-page-toolbar"><label class="skills-search"><span>${l.search}</span><input id="schedules-search" type="search" value="${escape(query)}" placeholder="${l.placeholder}" aria-label="${l.search}"></label><span class="skills-count">${l.count(matches.length)}</span><button type="button" class="text-btn" data-schedules-refresh ${locked?'disabled':''}>${l.refresh}</button></div><div class="schedule-tabs" role="group" aria-label="${l.title}">${['upcoming','paused','history','all'].map(value=>`<button type="button" data-schedule-filter="${value}" class="${filter===value?'selected':''}" aria-pressed="${filter===value}">${l[value]}</button>`).join('')}</div><p class="skills-save-hint">${l.availability}</p>${!online()?`<p class="skills-page-notice" role="status">${l.offline}</p>`:''}${error&&!editor?`<p class="error" role="status">${escape(error)}</p>`:''}<div class="scheduled-task-list" aria-busy="${busy}">${matches.map(item=>`<article class="schedule-card" data-key="schedule-${escape(item.id)}"><div class="schedule-card-main"><span class="skill-card-icon">${icon('clock')}</span><div><div class="schedule-card-meta"><span class="schedule-state ${escape(item.status)}">${escape(l[item.status]||l.unknown)}</span><span>${l.once}</span></div><p class="schedule-card-text">${escape(item.text)}</p><div class="schedule-card-date">${icon('clock')}<time datetime="${escape(isoValue(item.at))}">${escape(dateText(item))}</time><span>${escape(item.timeZone||timeZone())}</span></div></div></div>${controls(item,locked)}</article>`).join('')}</div>${!matches.length?`<div class="skills-page-empty">${icon('clock')}<p>${needle?l.noMatch:l.empty}</p>${!needle?`<span>${l.emptyHint}</span>`:''}</div>`:''}</section>`;
 }
 async function update(mutate,{closeEditor=null,removedId=null}={}){
  if(busy||!online())return;capture();const owner=scope,version=++generation,current=()=>scope===owner&&currentScope()===owner&&generation===version;
  busy=true;error='';render();
  try{
   if(mutate){await mutate(current);if(!current())return;}
   const data=await request('/schedules');if(!current())return;
   const refreshed=Array.isArray(data)?data:data?.items;if(!Array.isArray(refreshed))throw Error('Invalid schedule list');
   getState().schedules=refreshed;
   if(editor===closeEditor||removedId&&editor?.id===removedId)editor=null;
  }catch{if(current()){error=labels().error;toast?.(error);}}
  finally{if(current()){busy=false;render();}}
 }
 function newEditor(item){const zone=item?.timeZone||timeZone();return {id:item?.id||null,text:item?.text||'',at:item?localValue(item.at,zone):'',timeZone:zone,clientRequestId:item?null:getID()};}
 async function save(draft,body,current){
  if(!draft.id){
   // Keep the original POST payload as well as its key. A retry after a lost
   // acknowledgement recovers the same task before applying any later edits.
   draft.creation ||= {...body,clientRequestId:draft.clientRequestId};
   const created=await request('/schedules',{method:'POST',body:draft.creation});if(!current())return;
   if(typeof created?.id!=='string'||!created.id)throw Error('Unconfirmed schedule');draft.id=created.id;
   if(['text','at','timeZone'].every(key=>draft.creation[key]===body[key]))return;
  }
  const saved=await request('/schedules/'+encodeURIComponent(draft.id),{method:'PATCH',body});if(!current())return;
  if(saved?.id!==draft.id)throw Error('Unconfirmed schedule');
 }
 function bind(){sync();const owner=scope,valid=()=>scope===owner&&currentScope()===owner;
  for(const button of document.querySelectorAll('[data-schedule-add]'))button.onclick=()=>{if(!valid()||busy||!online())return;capture();if(editor)return;editor=newEditor();error='';render();document.querySelector('[data-schedule-editor] textarea')?.focus();};
  for(const button of document.querySelectorAll('[data-schedule-cancel]'))button.onclick=()=>{if(!valid()||busy)return;editor=null;error='';render();};
  for(const button of document.querySelectorAll('[data-schedule-edit]'))button.onclick=()=>{if(!valid()||busy||!online())return;const item=items().find(item=>item.id===button.dataset.scheduleEdit);if(!item||!['pending','paused'].includes(item.status))return;capture();if(editor&&editor.id!==item.id)return;editor ||=newEditor(item);error='';render();};
  for(const button of document.querySelectorAll('[data-schedule-filter]'))button.onclick=()=>{if(!valid())return;capture();filter=button.dataset.scheduleFilter;render();};
  const search=document.querySelector('#schedules-search');if(search)search.oninput=()=>{if(!valid())return;query=search.value;capture();render();};
  const form=document.querySelector('[data-schedule-editor]');if(form){form.oninput=capture;form.onsubmit=async event=>{event.preventDefault();if(!valid()||busy||!editor||!online())return;capture();const at=timestamp(editor.at,editor.timeZone);if(!editor.text.trim()||!Number.isFinite(at)||at<=now()){error=labels()[!editor.text.trim()?'required':'future'];render();return;}const draft=editor,body={text:draft.text.trim(),at,timeZone:draft.timeZone};await update(current=>save(draft,body,current),{closeEditor:draft});};}
  for(const button of document.querySelectorAll('[data-schedule-toggle]'))button.onclick=()=>{if(!valid()||busy||!online())return;const item=items().find(item=>item.id===button.dataset.scheduleToggle);if(!item||!['pending','paused'].includes(item.status))return;capture();if(item.status==='paused'&&(!Number.isFinite(Number(item.at))||item.at<=now())){if(!editor){editor=newEditor(item);editor.at='';}error=labels().future;render();return;}return update(()=>request('/schedules/'+encodeURIComponent(item.id),{method:'PATCH',body:{enabled:item.status!=='pending'}}));};
  for(const button of document.querySelectorAll('[data-schedule-remove]'))button.onclick=()=>{if(valid()){const id=button.dataset.scheduleRemove;if(!items().some(item=>item.id===id))return;return update(()=>request('/schedules/'+encodeURIComponent(id),{method:'DELETE'}),{removedId:id});}};
  const refresh=document.querySelector('[data-schedules-refresh]');if(refresh)refresh.onclick=()=>{if(valid())return update();};
 }
 return {renderPage,bind};
}
