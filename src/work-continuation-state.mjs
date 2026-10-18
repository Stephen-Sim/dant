import {createHash} from 'node:crypto';

const phases=new Set(['claimed','submitting','acknowledged','unknown']);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
export const continuationTime=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
export const continuationId=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x20\x7f]/.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));

export function workContinuationCheckpoint(plan){
 return createHash('sha256').update(JSON.stringify(plan?plan.steps.map(({step,status})=>({step,status})):null)).digest('hex');
}
export const continuationDelay=noProgressCount=>Math.min(300000,30000*2**Math.min(Math.max(0,noProgressCount-1),4));

/** Only bounded control metadata survives restart; never preserve raw errors. */
export function safeWorkContinuation(value){
 if(!plain(value)||!keys(value,['nextAt','attempts','noProgressCount','lastCheckpoint','dispatch','invalid'])||value.nextAt!==null&&!continuationTime(value.nextAt)||!count(value.attempts)||!count(value.noProgressCount)||value.noProgressCount>value.attempts||typeof value.lastCheckpoint!=='string'||!/^[a-f0-9]{64}$/.test(value.lastCheckpoint))return null;
 if(Object.hasOwn(value,'invalid')&&value.invalid!==true)return null;
 const result={nextAt:value.nextAt,attempts:value.attempts,noProgressCount:value.noProgressCount,lastCheckpoint:value.lastCheckpoint};
 if(value.invalid===true){if(Object.hasOwn(value,'dispatch')||value.nextAt!==null)return null;result.invalid=true;return result;}
 if(Object.hasOwn(value,'dispatch')){
  const d=value.dispatch;if(!plain(d)||!keys(d,['id','fromTurnId','runtimeId','threadId','phase','createdAt','turnId'])||!continuationId(d.id,128)||!continuationId(d.fromTurnId)||typeof d.runtimeId!=='string'||!d.runtimeId.trim()||d.runtimeId.length>512||/[\x00-\x1f\x7f]/.test(d.runtimeId)||!continuationId(d.threadId)||!phases.has(d.phase)||!continuationTime(d.createdAt))return null;
  if(d.phase==='acknowledged'&&!continuationId(d.turnId)||Object.hasOwn(d,'turnId')&&(!continuationId(d.turnId)||d.turnId===d.fromTurnId)||['claimed','submitting'].includes(d.phase)&&Object.hasOwn(d,'turnId'))return null;
  result.dispatch={id:d.id,fromTurnId:d.fromTurnId,runtimeId:d.runtimeId,threadId:d.threadId,phase:d.phase,createdAt:d.createdAt,...(Object.hasOwn(d,'turnId')?{turnId:d.turnId}:{})};
 }
 return result;
}
export function continuationUnconfirmed(record){
 if(!record||!Object.hasOwn(record,'continuation'))return false;
 const value=safeWorkContinuation(record.continuation);
 return !value||value.invalid===true||['submitting','unknown'].includes(value.dispatch?.phase);
}
export function continuationEligible(record,{at=Date.now()}={}){
 if(!continuationTime(at)||!continuationId(record?.id,128)||!continuationId(record?.turnId)||record.status!=='continuing'||!continuationTime(record.executionEndedAt)||record.executionEndedAt>at||record.progressDismissedAt||record.unknownOutcome===true||['unknown','submitting'].includes(record.submission))return false;
 if(record.plan===null?record.provisional!==true:!Array.isArray(record.plan?.steps)||!record.plan.steps.length||record.plan.steps.length>128||record.plan.steps.some(step=>typeof step?.step!=='string'||!step.step.trim()||step.step.length>240||!['pending','inProgress','completed'].includes(step.status))||!record.plan.steps.some(step=>step.status!=='completed'))return false;
 if(!Object.hasOwn(record,'continuation'))return at>=record.executionEndedAt+5000;
 const state=safeWorkContinuation(record.continuation);
 return !!state&&!state.invalid&&!state.dispatch&&state.noProgressCount<3&&state.nextAt!==null&&at>=state.nextAt;
}
export function restoreWorkContinuation(record,raw){
 const state=safeWorkContinuation(raw),dispatch=state?.dispatch,owner=dispatch?.turnId||dispatch?.fromTurnId;
 if(!state||dispatch&&(record.turnId!==owner||!record.turnIds.includes(dispatch.fromTurnId))){
  return {continuation:{nextAt:null,attempts:0,noProgressCount:0,lastCheckpoint:workContinuationCheckpoint(record.plan),invalid:true},status:'unknown',pauseReason:'continuation-state-invalid'};
 }
 if(state.invalid)return {continuation:state,status:'unknown',pauseReason:'continuation-state-invalid'};
 if(dispatch)return {continuation:state,status:['submitting','unknown'].includes(dispatch.phase)?'unknown':'paused',pauseReason:['submitting','unknown'].includes(dispatch.phase)?'continuation-unconfirmed':'continuation-interrupted'};
 if(record.status==='continuing'&&state.noProgressCount>=3)return {continuation:{...state,nextAt:null},status:'paused',pauseReason:'automatic-no-progress'};
 return {continuation:state};
}
