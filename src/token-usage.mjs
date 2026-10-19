import {createHash} from 'node:crypto';

const fields=['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const digest=(...values)=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
const timestamp=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
const HISTORY_DAYS=400,DAY_MS=86400000;
const providers=['subscription','apiVoice'];
const emptyActivity=timeZone=>({timeZone,recordedSince:null,retainedFrom:null,days:{},unallocated:{subscription:null,apiVoice:null}});
function zone(value){try{if(typeof value==='string'&&value.length<=100)return new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone;}catch{}return 'UTC';}
function calendarDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const at=Date.parse(value+'T00:00:00Z');return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===value;}
function dayOf(at,timeZone){
 if(!timestamp(at))return null;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at).map(part=>[part.type,part.value]));
 const date=`${parts.year.padStart(4,'0')}-${parts.month}-${parts.day}`;return calendarDate(date)?date:null;
}
function aggregateCounts(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const result={};for(const field of fields){if(value[field]===null||integer(value[field]))result[field]=value[field];else return null;}
 if(result.cachedInputTokens!==null&&result.inputTokens!==null&&result.cachedInputTokens>result.inputTokens||result.reasoningOutputTokens!==null&&result.outputTokens!==null&&result.reasoningOutputTokens>result.outputTokens||result.totalTokens!==null&&result.inputTokens!==null&&result.outputTokens!==null&&result.totalTokens!==result.inputTokens+result.outputTokens)return null;
 return result;
}
function addCounts(left,right){
 if(!left)return right?{...right}:null;if(!right)return {...left};
 return Object.fromEntries(fields.map(field=>{const total=left[field]===null||right[field]===null?null:left[field]+right[field];return [field,integer(total)?total:null];}));
}
function difference(total,prior){
 const inputTokens=total.inputTokens-prior.inputTokens,outputTokens=total.outputTokens-prior.outputTokens;
 const cached=total.cachedInputTokens-prior.cachedInputTokens,reasoning=total.reasoningOutputTokens-prior.reasoningOutputTokens;
 return {inputTokens,outputTokens,totalTokens:inputTokens+outputTokens,cachedInputTokens:cached>=0&&cached<=inputTokens?cached:null,reasoningOutputTokens:reasoning>=0&&reasoning<=outputTokens?reasoning:null};
}
function trimActivity(activity,at){
 const current=dayOf(at,activity.timeZone),today=Object.keys(activity.days).reduce((latest,date)=>!latest||date>latest?date:latest,current);if(!today)return activity;
 const cutoff=new Date(Date.parse(today+'T00:00:00Z')-(HISTORY_DAYS-1)*DAY_MS).toISOString().slice(0,10),retainedFrom=activity.retainedFrom&&activity.retainedFrom>cutoff?activity.retainedFrom:cutoff;
 const days={},unallocated={...activity.unallocated};
 for(const [date,entry]of Object.entries(activity.days))if(date>=retainedFrom)days[date]=entry;else for(const provider of providers)unallocated[provider]=addCounts(unallocated[provider],entry[provider]);
 return {...activity,retainedFrom,days,unallocated};
}
function allocate(activity,provider,value,at){
 if(!value)return activity;
 activity=trimActivity(activity,at);const date=dayOf(at,activity.timeZone);activity={...activity,recordedSince:date?(activity.recordedSince===null?at:Math.min(activity.recordedSince,at)):activity.recordedSince};
 if(!date||activity.retainedFrom&&date<activity.retainedFrom)return {...activity,unallocated:{...activity.unallocated,[provider]:addCounts(activity.unallocated[provider],value)}};
 const entry=activity.days[date]||{subscription:null,apiVoice:null};
 return {...activity,days:{...activity.days,[date]:{...entry,[provider]:addCounts(entry[provider],value)}}};
}
function restoreActivity(value,{timeZone,at,native,apiVoice}){
 let activity;
 if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.timeZone==='string'&&zone(value.timeZone)===value.timeZone&&(value.recordedSince===null||timestamp(value.recordedSince))&&(value.retainedFrom===null||calendarDate(value.retainedFrom))&&value.days&&typeof value.days==='object'&&!Array.isArray(value.days)&&value.unallocated&&typeof value.unallocated==='object'){
  let valid=true;const days={},unallocated={};
  for(const provider of providers){const raw=value.unallocated[provider];unallocated[provider]=raw===null?null:aggregateCounts(raw);if(raw!==null&&!unallocated[provider])valid=false;}
  for(const [date,entry]of Object.entries(value.days)){
   if(!calendarDate(date)||!entry||typeof entry!=='object'||Array.isArray(entry)){valid=false;break;}
   const saved={};for(const provider of providers){saved[provider]=entry[provider]===null?null:aggregateCounts(entry[provider]);if(entry[provider]!==null&&!saved[provider])valid=false;}if(!saved.subscription&&!saved.apiVoice)valid=false;days[date]=saved;
  }
  if(valid)activity={timeZone:value.timeZone,recordedSince:value.recordedSince,retainedFrom:value.retainedFrom,days,unallocated};
 }
 if(!activity){
  // A v1 native high-water mark has no historical timestamps per response.
  // Keep it unallocated; API receipts do have their original observation time.
  activity=emptyActivity(zone(timeZone));activity.unallocated.subscription=sum(Object.values(native),'total');
  activity=trimActivity(activity,at);
  for(const record of Object.values(apiVoice))activity=allocate(activity,'apiVoice',record.counts,record.at);
 }
 return trimActivity(activity,at);
}
function counts(value,{optional=false}={}){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const result={};for(const field of fields){const number=value[field];if(optional&&['cachedInputTokens','reasoningOutputTokens'].includes(field)&&number===null)result[field]=null;else if(integer(number))result[field]=number;else return null;}
 if(result.cachedInputTokens!==null&&result.cachedInputTokens>result.inputTokens||result.reasoningOutputTokens!==null&&result.reasoningOutputTokens>result.outputTokens||result.totalTokens!==result.inputTokens+result.outputTokens)return null;
 return result;
}
function restore(value,{timeZone,at}){
 const state={version:2,recordedSince:timestamp(value?.recordedSince)?value.recordedSince:null,native:{},apiVoice:{}};
 if(![1,2].includes(value?.version))return {...state,activity:trimActivity(emptyActivity(zone(timeZone)),at)};
 for(const [key,record] of Object.entries(value.native||{})){
  const total=counts(record?.total),last=counts(record?.last);if(/^[a-f\d]{64}$/.test(key)&&total&&last&&timestamp(record.at))state.native[key]={total,last,at:record.at};
 }
 for(const [key,record] of Object.entries(value.apiVoice||{})){
  const usage=counts(record?.counts,{optional:true});if(/^[a-f\d]{64}$/.test(key)&&usage&&timestamp(record.at))state.apiVoice[key]={counts:usage,at:record.at};
 }
 state.activity=restoreActivity(value.version===2?value.activity:null,{timeZone,at,native:state.native,apiVoice:state.apiVoice});return state;
}
function sum(records,key){
 if(!records.length)return null;
 return Object.fromEntries(fields.map(field=>{const values=records.map(record=>record[key][field]);if(values.includes(null))return [field,null];const total=values.reduce((a,b)=>a+b,0);return [field,integer(total)?total:null];}));
}
const latest=records=>records.reduce((found,record)=>!found||record.at>=found.at?record:found,null);

// Native notifications carry cumulative thread usage. API voice carries one
// response's usage. Persist each source's receipt so replay/restart cannot add
// either cumulative totals or a completed API response twice.
export class TokenUsageStore{
 constructor(store,{now=Date.now,onChange=()=>{}}={}){this.store=store;this.now=now;this.onChange=onChange;this.state=restore(store.state.tokenUsage,{timeZone:store.state.settings?.timeZone,at:now()});}
 commit(next){
  const previous=this.store.state.tokenUsage;this.store.state.tokenUsage=next;
  try{this.store.save();}catch(error){if(previous===undefined)delete this.store.state.tokenUsage;else this.store.state.tokenUsage=previous;throw error;}
  this.state=next;this.onChange();return true;
 }
 observeCodex(params,{runtimeId}={}){
  if(!identifier(runtimeId)||!identifier(params?.threadId)||!identifier(params?.turnId))return false;
  const total=counts(params.tokenUsage?.total),last=counts(params.tokenUsage?.last);if(!total||!last)return false;
  const key=digest(runtimeId,params.threadId),prior=this.state.native[key];
  // Ignore duplicate/restored notifications and out-of-order older snapshots.
  // Never interpret a cumulative reset as new consumption.
  if(prior&&(fields.some(field=>total[field]<prior.total[field])||fields.every(field=>total[field]===prior.total[field])))return false;
  const at=this.now();if(!timestamp(at))return false;
  let activity=trimActivity(this.state.activity,at);
  if(prior)activity=allocate(activity,'subscription',difference(total,prior.total),at);
  else{
   const remainder=Object.fromEntries(fields.map(field=>[field,total[field]-last[field]])),reliable=counts(remainder);
   // The first cumulative notification can include years of earlier usage.
   // Only its verified latest response belongs to the receipt's current day.
   const historical=reliable||total;
   activity={...activity,unallocated:{...activity.unallocated,subscription:addCounts(activity.unallocated.subscription,historical)}};
   if(reliable)activity=allocate(activity,'subscription',last,at);
  }
  return this.commit({...this.state,activity,recordedSince:this.state.recordedSince||at,native:{...this.state.native,[key]:{total,last,at}}});
 }
 observeApiVoice({callId,responseId,usage}={}){
  if(!identifier(callId)||!identifier(responseId)||!usage||typeof usage!=='object')return false;
  const value=counts({inputTokens:usage.input_tokens,cachedInputTokens:usage.input_token_details?.cached_tokens??null,outputTokens:usage.output_tokens,reasoningOutputTokens:null,totalTokens:usage.total_tokens},{optional:true});if(!value)return false;
  const key=digest(callId,responseId);if(this.state.apiVoice[key])return false;
  const at=this.now();if(!timestamp(at))return false;
  return this.commit({...this.state,activity:allocate(this.state.activity,'apiVoice',value,at),recordedSince:this.state.recordedSince||at,apiVoice:{...this.state.apiVoice,[key]:{counts:value,at}}});
 }
 snapshot(){
  const native=Object.values(this.state.native),api=Object.values(this.state.apiVoice),lastNative=latest(native),lastApi=latest(api);
  const activity=trimActivity(this.state.activity,this.now());
  return {recordedSince:this.state.recordedSince,subscription:{available:native.length>0,totals:sum(native,'total'),lastResponse:lastNative?{...lastNative.last,at:lastNative.at}:null},apiVoice:{available:api.length>0,totals:sum(api,'counts'),lastResponse:lastApi?{...lastApi.counts,at:lastApi.at}:null},activity:{timeZone:activity.timeZone,recordedSince:activity.recordedSince,retainedFrom:activity.retainedFrom,days:Object.entries(activity.days).sort(([left],[right])=>left.localeCompare(right)).map(([date,entry])=>({date,...structuredClone(entry)})),unallocated:structuredClone(activity.unallocated)}};
 }
}
