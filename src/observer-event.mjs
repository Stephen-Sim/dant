import {inheritTaskExecutionEvent} from './task-progress.mjs';

const ITEM_BYTES=64*1024,AGENT_TEXT_CHARS=120000;
const itemTypes=new Set(['userMessage','hookPrompt','agentMessage','plan','reasoning','commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','webSearch','imageView','imageGeneration','enteredReviewMode','exitedReviewMode','contextCompaction']);
const itemStatuses=new Set(['inProgress','completed','failed','declined','interrupted','cancelled']);
const deliveryTools=new Set(['send_chat_message','create_voice_message','react_message']);
const projections=new WeakMap();
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const diagnosticId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)&&!/(?:^|[.:/])(?:sk[-_]|gh[pousr]_|xox[baprs]-|Bearer|eyJ[A-Za-z0-9_-]{10,}\.)/i.test(value);

/** Fixed schema metadata only: never tool names, arguments, output or speech. */
export function observerEventMetadata(event){
 const item=event?.params?.item,metadata={};
 if(item&&typeof item==='object'){
  metadata.itemType=itemTypes.has(item.type)?item.type:'other';
  if(itemStatuses.has(item.status))metadata.itemStatus=item.status;
 }
 const id=item?.id??event?.params?.itemId;if(diagnosticId(id))metadata.itemId=id;
 return metadata;
}

/** Projection bookkeeping stays outside the protocol object. */
export function getObserverProjectionKind(event){return event&&typeof event==='object'?projections.get(event)||null:null;}
function projected(event,item,kind){const result={...event,params:{...event.params,item}};projections.set(result,kind);return inheritTaskExecutionEvent(event,result);}
function itemMetadata(item){
 const result={id:item.id,type:item.type};
 if(itemStatuses.has(item.status))result.status=item.status;
 if(Number.isSafeInteger(item.exitCode))result.exitCode=item.exitCode;
 if(typeof item.durationMs==='number'&&Number.isFinite(item.durationMs)&&item.durationMs>=0)result.durationMs=item.durationMs;
 return result;
}

/**
 * Codex has already consumed these notification payloads. Retain only what the
 * native voice observer uses, while leaving the original model result intact.
 * Requests, unknown shapes and control events keep the existing safety budget.
 */
export function prepareObserverEvent(event){
 if(!event||event.id!==undefined||projections.has(event))return event;
 if(event.method==='item/agentMessage/delta'){
  const p=event.params;if(!identity(p?.itemId)||typeof p.delta!=='string'||p.delta.length<=AGENT_TEXT_CHARS)return event;
  const result={...event,params:{...p,delta:p.delta.slice(0,AGENT_TEXT_CHARS)}};projections.set(result,'payload');return result;
 }
 if(!['item/started','item/completed'].includes(event.method))return event;
 let item=event.params?.item;if(!itemTypes.has(item?.type)||!identity(item.id))return event;
 let observed=event;
 if(item.type==='mcpToolCall'&&Array.isArray(item.result?.content)){
  let changed=false;
  const content=item.result.content.map(block=>{
   if(block?.type!=='image'||typeof block.data!=='string')return block;
   changed=true;const {data,...metadata}=block;return metadata;
  });
  if(changed){item={...item,result:{...item.result,content}};observed=projected(event,item,'image');}
 }
 if(Buffer.byteLength(JSON.stringify(item))<=ITEM_BYTES)return observed;
 if(item.type==='agentMessage'){
  if(typeof item.text!=='string')return observed;
  return projected(observed,{...itemMetadata(item),text:item.text.slice(0,AGENT_TEXT_CHARS)},'payload');
 }
 // These three tools deliver visible chat effects. Preserve their exact matching
 // arguments, structured markers and status for Engine.acceptMcpResult validation.
 if(item.type==='mcpToolCall'&&event.method==='item/completed'&&item.server==='dant_desktop'&&deliveryTools.has(item.tool)&&item.status==='completed'&&!item.error&&!item.result?.isError)return observed;
 return projected(observed,itemMetadata(item),'payload');
}
