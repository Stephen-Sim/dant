import {PlanStepStatus,TaskProgressStage,TaskStatus} from './contracts/states.mjs';
const steps=new Set(Object.values(TaskProgressStage));
const itemSteps=new Map([['commandExecution',TaskProgressStage.Command],['fileChange',TaskProgressStage.Files],['agentMessage',TaskProgressStage.Responding],['imageView',TaskProgressStage.Computer],['imageGeneration',TaskProgressStage.Files],['webSearch',TaskProgressStage.Working],['dynamicToolCall',TaskProgressStage.Working],['collabAgentToolCall',TaskProgressStage.Working]]);
const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=8640000000000000;
const validItemId=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const planStatuses=new Set(Object.values(PlanStepStatus));
export const TASK_PLAN_SCHEMA=Object.freeze({workId:{type:'string',minLength:1,maxLength:128},status:{type:'string',enum:[TaskStatus.Running,TaskStatus.WaitingUser],description:'Use waiting_user only when the accepted task needs information from the user. Its steps must contain at least one pending step and no inProgress step; an all-completed plan cannot wait for user input.'},title:{type:'string',minLength:1,maxLength:240},steps:{type:'array',minItems:1,maxItems:128,items:{type:'object',properties:{step:{type:'string',minLength:1,maxLength:5000},status:{type:'string',enum:[...planStatuses]}},required:['step','status'],additionalProperties:false}}});
export const TASK_PLAN_DESCRIPTION='Register every accepted real task in Work progress before action or clarification, including a simple request to send a link or file. Supply a concrete short title and actual steps; wait for saved:true before claiming registration. A saved:false work_conflict response identifies activeWorkId; keep that exact automatic-continuation binding and update only its actual task, never unrelated work. Before asking for missing task information, set status to waiting_user with at least one pending step and no inProgress step. Reuse the actual returned workId for semantically related follow-ups across turns, including human-requested revisions to an unaccepted result awaiting review; never guess the latest task. Ordinary conversation and requests only asking for progress create no new task. This records progress only: it never starts another executor, grants permission, or marks execution finished.';
export const TASK_PLAN_INSTRUCTIONS='Before executing any accepted real entrusted task, including a simple request to send a link or file, use task_plan (also available through dant_desktop MCP) to record its concrete title and actual steps in Work progress. Wait for its saved acknowledgement before doing that work or claiming the task is registered. Require saved:true before claiming registration. A saved:false result means the plan was not saved. When it returns code work_conflict and activeWorkId, this automatic continuation must keep that exact workId and only its own actual task steps; do not switch to, overwrite or start unrelated work. Retry the corrected task_plan only after this explicit saved:false rejection; an unconfirmed result must never be retried automatically. If an accepted request needs clarification or missing information, register it before asking the user: explicitly set status to waiting_user, keep at least one step pending, and mark no step inProgress. A waiting_user plan cannot have every step completed. Explicit status running records work that can proceed; omitting status preserves the existing status behavior. Update the same plan as steps advance or the task changes. Keep the returned workId and supply it when the same entrusted task continues in another turn or call; use the saved acknowledgement or task_list to identify the actual matching workId, never guess or select the most recent task. Do not create a new task for each sentence, acknowledgement or progress report. Associate a follow-up with existing work only when its actual meaning continues that task; this includes requested revisions to an unaccepted result awaiting review. Accepted completed work stays closed; an unrelated real request needs a separate task. Ordinary conversation does not need a task plan; a question only asking for task progress does not create a new task. Do not substitute a promise, speech transcript, internal reasoning, or invented percentage for task registration. Finishing one response does not finish the entrusted task. Keep working until the real result is verified, update verified steps to completed, or record waiting_user before asking the user about an actual information blocker. An unfinished checklist remains continuing after an executor turn ends. The application periodically checks eligible unfinished work and may continue it in the same conversation when the executor is confirmed idle; this does not mean an executor is already running between turns. Record waiting_user for an actual information blocker, and respect paused, cancelled, review and unconfirmed states instead of starting another execution channel. A plan never grants new permissions or creates another execution channel.';
export function publicTaskPlan(plan,{redact=text=>text}={}){
 if(!Array.isArray(plan)||!plan.length||plan.length>128||plan.some(item=>!item||typeof item.step!=='string'||!item.step.trim()||item.step.length>5000||!planStatuses.has(item.status)))throw Error('A task plan requires 1–128 actual steps with valid statuses.');
 const clean=plan.map(item=>({step:String(redact(item.step)).replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240),status:item.status}));
 if(clean.some(item=>!item.step))throw Error('Task steps must have visible text.');
 const current=clean.find(item=>item.status===PlanStepStatus.InProgress)||clean.find(item=>item.status===PlanStepStatus.Pending);
 return {total:clean.length,completed:clean.filter(item=>item.status===PlanStepStatus.Completed).length,currentStep:current?.step||'',steps:clean};
}
export function taskPlanInput(args,{redact=text=>text}={}){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['workId','title','steps','status'].includes(key))||typeof args.title!=='string'||!args.title.trim()||args.title.length>240||args.workId!==undefined&&(typeof args.workId!=='string'||!args.workId||args.workId.length>128||/[\x00-\x20\x7f]/.test(args.workId)))throw Error('A task plan requires a short concrete title and steps.');
 const title=String(redact(args.title)).replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240);if(!title)throw Error('Task title must have visible text.');
 if(args.status!==undefined&&![TaskStatus.Running,TaskStatus.WaitingUser].includes(args.status))throw Error('Task plan status must be running or waiting_user.');
 const plan=publicTaskPlan(args.steps,{redact});if(args.status===TaskStatus.WaitingUser&&(plan.steps.some(step=>step.status===PlanStepStatus.InProgress)||!plan.steps.some(step=>step.status===PlanStepStatus.Pending)))throw Error('A waiting_user task plan requires at least one pending step and no inProgress steps.');
 return {title,plan,...(args.workId!==undefined?{workId:args.workId}:{}),...(args.status!==undefined?{status:args.status}:{})};
}

const conversationTools=new Set(['task_plan','task_list','task_cancel','send_message','send_chat_message','end_call','react_message','memory_write','skill_list','skill_get','credential_find','credential_get','schedule_list','schedule_save','schedule_delete']);
const observedExecutionEvents=new WeakSet();
// Observer copies omit bulk tool fields; retain only their validated category
// in process memory, never on the wire or in serialized task progress.
export function inheritTaskExecutionEvent(original,projected){
 if(projected&&typeof projected==='object'&&isTaskExecutionEvent(original))observedExecutionEvents.add(projected);
 return projected;
}
export function isTaskExecutionEvent(event){
 if(observedExecutionEvents.has(event))return true;
 const method=event?.method,params=event?.params||{};
 if(method==='item/tool/call')return ['skill_save','send_file','create_voice_message','credential_request','credential_store'].includes(params.tool);
 if(!['item/started','item/completed'].includes(method))return false;
 const item=params.item;if(!item||!validItemId(item.id))return false;
 if(['commandExecution','fileChange','imageView','imageGeneration','webSearch','collabAgentToolCall'].includes(item.type))return true;
 return ['mcpToolCall','dynamicToolCall'].includes(item.type)&&typeof item.tool==='string'&&!!item.tool&&!conversationTools.has(item.tool);
}
export function registeredWorkFinalStatus(task,status){
 const plan=task?.workRecord?.plan;
 if(status===TaskStatus.Review&&task?.workRecord){
  if(task.awaitingChatInput||task.credentialWaits||task.planWaitingForUser)return TaskStatus.WaitingUser;
  if(!plan||Array.isArray(plan.steps)&&plan.steps.some(step=>step.status!==PlanStepStatus.Completed))return TaskStatus.Continuing;
 }
 return status;
}

export function startTaskProgress(task,{at=Date.now(),step=TaskProgressStage.Preparing}={}){
 const time=validTime(at)?at:Date.now();task.workProgress={startedAt:time,updatedAt:time,step:steps.has(step)?step:TaskProgressStage.Working,items:new Map()};return task.workProgress;
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
  const plan=params.plan;if(!Array.isArray(plan)||plan.length>128||plan.some(item=>!item||typeof item.step!=='string'||item.step.length>5000||![PlanStepStatus.Pending,PlanStepStatus.InProgress,PlanStepStatus.Completed].includes(item.status)))return false;
  const progress=task.workProgress||startTaskProgress(task,{at,step:TaskProgressStage.Working}),current=plan.find(item=>item.status===PlanStepStatus.InProgress)||plan.find(item=>item.status===PlanStepStatus.Pending);
  progress.plan={total:plan.length,completed:plan.filter(item=>item.status===PlanStepStatus.Completed).length,currentStep:current?String(redact(current.step)).replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240):''};
  if(validTime(at))progress.updatedAt=Math.max(progress.updatedAt,at);return true;
 }
 if(method==='item/agentMessage/delta'&&typeof params.delta==='string')return advanceTaskProgress(task,TaskProgressStage.Responding,{at});
 if(['item/tool/call','item/tool/requestUserInput'].includes(method))return advanceTaskProgress(task,TaskProgressStage.Working,{at});
 if(!['item/started','item/completed'].includes(method))return false;
 const item=params.item;if(!item||!validItemId(item.id))return false;
 const step=item.type==='mcpToolCall'?(item.server==='dant_desktop'?TaskProgressStage.Computer:TaskProgressStage.Working):itemSteps.get(item.type);if(!step)return false;
 const progress=task.workProgress||startTaskProgress(task,{at,step:TaskProgressStage.Working});
 if(method==='item/started'){if(progress.items.has(item.id)||progress.items.size<128)progress.items.set(item.id,step);}else progress.items.delete(item.id);
 const current=[...progress.items.values()].at(-1);return advanceTaskProgress(task,current||TaskProgressStage.Working,{at});
}

export function taskProgressSnapshot(task,{source='chat',background=false,status=TaskStatus.Running,startedAt,redact=text=>text,saving=false}={}){
 const progress=task?.workProgress,start=validTime(progress?.startedAt)?progress.startedAt:validTime(startedAt)?startedAt:null,updated=validTime(progress?.updatedAt)?progress.updatedAt:start;
 const result={messageId:task?.messageId||null,turnId:task?.turnId||null,source:source==='voice'?'voice':'chat',background:background===true,status:[TaskStatus.Running,TaskStatus.WaitingUser,TaskStatus.Pausing,TaskStatus.Unknown].includes(status)?status:TaskStatus.Running,startedAt:start,updatedAt:updated,step:saving?TaskProgressStage.Saving:steps.has(progress?.step)?progress.step:TaskProgressStage.Working};
 if(progress?.plan)result.plan={total:progress.plan.total,completed:progress.plan.completed,currentStep:String(redact(progress.plan.currentStep)).slice(0,240)};
 if(task?.workRecord){result.workId=task.workRecord.id;result.title=String(redact(task.workRecord.title)).slice(0,240);if(task.workRecord.plan)result.plan=publicTaskPlan(task.workRecord.plan.steps,{redact});else delete result.plan;if(validTime(task.workRecord.startedAt))result.startedAt=task.workRecord.startedAt;}
 return result;
}
export function voiceCompletionWork(task,status,{at=Date.now()}={}){
  if(![TaskStatus.Review,TaskStatus.Failed,TaskStatus.Paused,TaskStatus.Cancelled].includes(status))return undefined;
 const work={source:'voice',status},startedAt=task?.workProgress?.startedAt;if(validTime(startedAt))work.startedAt=startedAt;if(validTime(at))work.updatedAt=at;return work;
}
export function safeCompletionWork(work){
 if(!work||typeof work!=='object'||Array.isArray(work)||![Object.prototype,null].includes(Object.getPrototypeOf(work)))return undefined;
  const fields=Object.getOwnPropertyDescriptors(work),source=fields.source?.value,status=fields.status?.value;if(source!=='voice'||![TaskStatus.Review,TaskStatus.Failed,TaskStatus.Paused,TaskStatus.Cancelled].includes(status))return undefined;
 const result={source,status};for(const key of ['startedAt','updatedAt'])if(validTime(fields[key]?.value))result[key]=fields[key].value;return result;
}
