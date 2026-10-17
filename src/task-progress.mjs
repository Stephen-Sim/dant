const steps=new Set(['preparing','working','computer','command','files','responding','saving']);
const itemSteps=new Map([['commandExecution','command'],['fileChange','files'],['agentMessage','responding'],['imageView','computer'],['imageGeneration','files'],['webSearch','working'],['dynamicToolCall','working'],['collabAgentToolCall','working']]);
const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=8640000000000000;
const validItemId=value=>typeof value==='string'&&value.length>0&&value.length<=256;

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
