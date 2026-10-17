const steps=new Set(['preparing','working','computer','command','files','responding','saving']);
const itemSteps=new Map([['commandExecution','command'],['fileChange','files'],['agentMessage','responding'],['imageView','computer'],['imageGeneration','files'],['webSearch','working'],['dynamicToolCall','working'],['collabAgentToolCall','working']]);
const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=8640000000000000;
const validItemId=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const planStatuses=new Set(['pending','inProgress','completed']);
export const TASK_PLAN_SCHEMA=Object.freeze({workId:{type:'string',minLength:1,maxLength:128},title:{type:'string',minLength:1,maxLength:240},steps:{type:'array',minItems:1,maxItems:128,items:{type:'object',properties:{step:{type:'string',minLength:1,maxLength:5000},status:{type:'string',enum:[...planStatuses]}},required:['step','status'],additionalProperties:false}}});
export const TASK_PLAN_DESCRIPTION='Register the current entrusted task in Work progress before computer, command, file-changing or multistep work. Supply a concrete short task title and actual steps. Reuse the returned workId when this same task continues across turns; do not create a new task for each sentence or follow-up. Decide from the actual request whether it belongs to existing work. Ordinary conversation needs no plan. This records progress only: it never starts another task, grants permission, or marks execution finished.';
export const TASK_PLAN_INSTRUCTIONS='Before executing an entrusted computer, command, file-changing or multistep task, use task_plan (also available through dant_desktop MCP) to record its concrete title and actual steps in Work progress, and wait for its saved acknowledgement before doing that work. Update the same plan as steps advance or the task changes. Keep the returned workId and supply it when the same entrusted task continues in another turn or call; do not create a new task for each sentence, acknowledgement or progress report. Associate a follow-up with existing work only when its actual meaning continues that task; an unrelated request needs a separate task. Ordinary conversation does not need a task plan. Do not substitute a promise, speech transcript, internal reasoning, or invented percentage for task registration. Finishing one response does not finish the entrusted task. Keep working until the real result is verified, update verified steps to completed, or ask the user about an actual blocker. An unfinished checklist remains continuing after an executor turn ends; it does not claim that an executor is still running or automatically start work. A plan never grants new permissions or creates another execution channel.';
export function publicTaskPlan(plan,{redact=text=>text}={}){
 if(!Array.isArray(plan)||!plan.length||plan.length>128||plan.some(item=>!item||typeof item.step!=='string'||!item.step.trim()||item.step.length>5000||!planStatuses.has(item.status)))throw Error('A task plan requires 1–128 actual steps with valid statuses.');
 const clean=plan.map(item=>({step:String(redact(item.step)).replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240),status:item.status}));
 if(clean.some(item=>!item.step))throw Error('Task steps must have visible text.');
 const current=clean.find(item=>item.status==='inProgress')||clean.find(item=>item.status==='pending');
 return {total:clean.length,completed:clean.filter(item=>item.status==='completed').length,currentStep:current?.step||'',steps:clean};
}
export function taskPlanInput(args,{redact=text=>text}={}){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['workId','title','steps'].includes(key))||typeof args.title!=='string'||!args.title.trim()||args.title.length>240||args.workId!==undefined&&(typeof args.workId!=='string'||!args.workId||args.workId.length>128||/[\x00-\x20\x7f]/.test(args.workId)))throw Error('A task plan requires a short concrete title and steps.');
 const title=String(redact(args.title)).replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240);if(!title)throw Error('Task title must have visible text.');
 return {title,plan:publicTaskPlan(args.steps,{redact}),...(args.workId!==undefined?{workId:args.workId}:{})};
}

const conversationTools=new Set(['task_plan','send_message','send_chat_message','end_call','react_message','memory_write','skill_list','skill_get','credential_find','credential_get','schedule_list','schedule_save','schedule_delete']);
export function isTaskExecutionEvent(event){
 const method=event?.method,params=event?.params||{};
 if(method==='item/tool/call')return ['skill_save','send_file','create_voice_message','credential_request','credential_store'].includes(params.tool);
 if(!['item/started','item/completed'].includes(method))return false;
 const item=params.item;if(!item||!validItemId(item.id))return false;
 if(['commandExecution','fileChange','imageView','imageGeneration','webSearch','collabAgentToolCall'].includes(item.type))return true;
 return ['mcpToolCall','dynamicToolCall'].includes(item.type)&&typeof item.tool==='string'&&!!item.tool&&!conversationTools.has(item.tool);
}
export function registeredWorkFinalStatus(task,status){
 const plan=task?.workRecord?.plan;
 if(status==='review'&&Array.isArray(plan?.steps)&&plan.steps.some(step=>step.status!=='completed'))return task.awaitingChatInput||task.credentialWaits?'waiting_user':'continuing';
 return status;
}

export function startTaskProgress(task,{at=Date.now(),step='preparing'}={}){
 const time=validTime(at)?at:Date.now();task.workProgress={startedAt:time,updatedAt:time,step:steps.has(step)?step:'working',items:new Map()};return task.workProgress;
}
export function advanceTaskProgress(task,step,{at=Date.now()}={}){
 if(!steps.has(step))return false;const progress=task.workProgress||startTaskProgress(task,{at,step});progress.step=step;if(validTime(at))progress.updatedAt=Math.max(progress.updatedAt,at);return true;
}

// Only explicit public plans and fixed item categories become UI progress.
// Reasoning, explanations, command text, output, tool arguments and speech stay out.
export function observeTaskProgress(task,event,{at=Date.now(),redact=text=>text}={}){
 const method=event?.method,params=event?.params||{};
 if(isTaskExecutionEvent(event))task.workObserved=true;
 if(method==='turn/plan/updated'){
  const plan=params.plan;if(!Array.isArray(plan)||plan.length>128||plan.some(item=>!item||typeof item.step!=='string'||item.step.length>5000||!['pending','inProgress','completed'].includes(item.status)))return false;
  const progress=task.workProgress||startTaskProgress(task,{at,step:'working'}),current=plan.find(item=>item.status==='inProgress')||plan.find(item=>item.status==='pending');
  progress.plan={total:plan.length,completed:plan.filter(item=>item.status==='completed').length,currentStep:current?String(redact(current.step)).replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240):''};
  if(validTime(at))progress.updatedAt=Math.max(progress.updatedAt,at);return true;
 }
 if(method==='item/agentMessage/delta'&&typeof params.delta==='string')return advanceTaskProgress(task,'responding',{at});
 if(['item/tool/call','item/tool/requestUserInput'].includes(method))return advanceTaskProgress(task,'working',{at});
 if(!['item/started','item/completed'].includes(method))return false;
 const item=params.item;if(!item||!validItemId(item.id))return false;
 const step=item.type==='mcpToolCall'?(item.server==='dant_desktop'?'computer':'working'):itemSteps.get(item.type);if(!step)return false;
 const progress=task.workProgress||startTaskProgress(task,{at,step:'working'});
 if(method==='item/started'){if(progress.items.has(item.id)||progress.items.size<128)progress.items.set(item.id,step);}else progress.items.delete(item.id);
 const current=[...progress.items.values()].at(-1);return advanceTaskProgress(task,current||'working',{at});
}

export function taskProgressSnapshot(task,{source='chat',background=false,status='running',startedAt,redact=text=>text,saving=false}={}){
 const progress=task?.workProgress,start=validTime(progress?.startedAt)?progress.startedAt:validTime(startedAt)?startedAt:null,updated=validTime(progress?.updatedAt)?progress.updatedAt:start;
 const result={messageId:task?.messageId||null,turnId:task?.turnId||null,source:source==='voice'?'voice':'chat',background:background===true,status:['running','waiting_user','pausing','unknown'].includes(status)?status:'running',startedAt:start,updatedAt:updated,step:saving?'saving':steps.has(progress?.step)?progress.step:'working'};
 if(progress?.plan)result.plan={total:progress.plan.total,completed:progress.plan.completed,currentStep:String(redact(progress.plan.currentStep)).slice(0,240)};
 if(task?.workRecord){result.workId=task.workRecord.id;result.title=String(redact(task.workRecord.title)).slice(0,240);result.plan=publicTaskPlan(task.workRecord.plan.steps,{redact});if(validTime(task.workRecord.startedAt))result.startedAt=task.workRecord.startedAt;}
 return result;
}
export function voiceCompletionWork(task,status,{at=Date.now()}={}){
 if(!['review','failed','paused'].includes(status))return undefined;
 const work={source:'voice',status},startedAt=task?.workProgress?.startedAt;if(validTime(startedAt))work.startedAt=startedAt;if(validTime(at))work.updatedAt=at;return work;
}
export function safeCompletionWork(work){
 if(!work||typeof work!=='object'||Array.isArray(work)||![Object.prototype,null].includes(Object.getPrototypeOf(work)))return undefined;
 const fields=Object.getOwnPropertyDescriptors(work),source=fields.source?.value,status=fields.status?.value;if(source!=='voice'||!['review','failed','paused'].includes(status))return undefined;
 const result={source,status};for(const key of ['startedAt','updatedAt'])if(validTime(fields[key]?.value))result[key]=fields[key].value;return result;
}
