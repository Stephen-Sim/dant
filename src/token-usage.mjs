import {createHash} from 'node:crypto';

const fields=['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const digest=(...values)=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
const timestamp=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
function counts(value,{optional=false}={}){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const result={};for(const field of fields){const number=value[field];if(optional&&['cachedInputTokens','reasoningOutputTokens'].includes(field)&&number===null)result[field]=null;else if(integer(number))result[field]=number;else return null;}
 if(result.cachedInputTokens!==null&&result.cachedInputTokens>result.inputTokens||result.reasoningOutputTokens!==null&&result.reasoningOutputTokens>result.outputTokens||result.totalTokens!==result.inputTokens+result.outputTokens)return null;
 return result;
}
function restore(value){
 const state={version:1,recordedSince:timestamp(value?.recordedSince)?value.recordedSince:null,native:{},apiVoice:{}};
 if(value?.version!==1)return state;
 for(const [key,record] of Object.entries(value.native||{})){
  const total=counts(record?.total),last=counts(record?.last);if(/^[a-f\d]{64}$/.test(key)&&total&&last&&timestamp(record.at))state.native[key]={total,last,at:record.at};
 }
 for(const [key,record] of Object.entries(value.apiVoice||{})){
  const usage=counts(record?.counts,{optional:true});if(/^[a-f\d]{64}$/.test(key)&&usage&&timestamp(record.at))state.apiVoice[key]={counts:usage,at:record.at};
 }
 return state;
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
 constructor(store,{now=Date.now,onChange=()=>{}}={}){this.store=store;this.now=now;this.onChange=onChange;this.state=restore(store.state.tokenUsage);}
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
  return this.commit({...this.state,recordedSince:this.state.recordedSince||at,native:{...this.state.native,[key]:{total,last,at}}});
 }
 observeApiVoice({callId,responseId,usage}={}){
  if(!identifier(callId)||!identifier(responseId)||!usage||typeof usage!=='object')return false;
  const value=counts({inputTokens:usage.input_tokens,cachedInputTokens:usage.input_token_details?.cached_tokens??null,outputTokens:usage.output_tokens,reasoningOutputTokens:null,totalTokens:usage.total_tokens},{optional:true});if(!value)return false;
  const key=digest(callId,responseId);if(this.state.apiVoice[key])return false;
  const at=this.now();if(!timestamp(at))return false;
  return this.commit({...this.state,recordedSince:this.state.recordedSince||at,apiVoice:{...this.state.apiVoice,[key]:{counts:value,at}}});
 }
 snapshot(){
  const native=Object.values(this.state.native),api=Object.values(this.state.apiVoice),lastNative=latest(native),lastApi=latest(api);
  return {recordedSince:this.state.recordedSince,subscription:{available:native.length>0,totals:sum(native,'total'),lastResponse:lastNative?{...lastNative.last,at:lastNative.at}:null},apiVoice:{available:api.length>0,totals:sum(api,'counts'),lastResponse:lastApi?{...lastApi.counts,at:lastApi.at}:null}};
 }
}
