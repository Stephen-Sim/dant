import {translate} from '../src/i18n.mjs';
import {languageInfo} from '../src/languages.mjs';
// Status comes from the live bridge first. Cached work must never appear online.
export function formatPresence(state={},language='zh',now=Date.now()){
 const {active:work,call,controller}=state,lastActiveAt=state.presence?.lastActiveAt??state.lastActiveAt,workerStatus=state.worker?.status??state.workerStatus;
 const english=language!=='zh',bridge=controller?.status;
 const disconnected=controller?.cached===true||(bridge!==undefined&&bridge!=='online');
 const online=!disconnected&&workerStatus==='online';
 const connecting=!online&&(bridge==='connecting'||(!disconnected&&workerStatus==='connecting'));
 const inCall=online&&call?.status==='connected'&&state.callActiveNow!==false;
 const working=online&&Boolean(work)&&(work.visible!==false||['unknown','pausing','waiting_user'].includes(work.status));
 const active=inCall||working;
 const unconfirmed=online&&!active&&Array.isArray(state.workTasks)&&state.workTasks.some(task=>task&&!task.progressDismissedAt&&(task.status==='unknown'||task.unknownOutcome===true||['unknown','submitting'].includes(task.submission)||task.continuation?.invalid||task.continuation?.dispatch));
 const waiting=online&&!active&&Array.isArray(state.workTasks)&&state.workTasks.some(task=>task?.status==='waiting_user'&&!task.progressDismissedAt&&!task.unknownOutcome&&!['unknown','submitting'].includes(task.submission)&&!task.continuation?.invalid&&!task.continuation?.dispatch);
 const validAt=typeof lastActiveAt==='number'&&Number.isFinite(lastActiveAt)&&lastActiveAt>0&&lastActiveAt<=8640000000000000;
 const clock=typeof now==='number'&&Number.isFinite(now)?now:Date.now();
 let detail='',title='',activity='';
 if(validAt){
  const seconds=Math.floor(Math.max(0,clock-lastActiveAt)/1000);
  let ago;
  if(seconds<60)ago=translate(language,"just now","刚刚");
  else{
   const count=Math.floor(seconds/(seconds<3600?60:seconds<86400?3600:86400));
   const unit=seconds<3600?(translate(language,"minute","分钟")):seconds<86400?(translate(language,"hour","小时")):(translate(language,"day","天"));
   ago=english?`${count} ${unit}${count===1?'':'s'} ago`:`${count} ${unit}前`;
  }
  if(!['en','zh'].includes(language)){const unit=seconds<3600?'minute':seconds<86400?'hour':'day',count=seconds<60?0:Math.floor(seconds/(seconds<3600?60:seconds<86400?3600:86400));ago=new Intl.RelativeTimeFormat(languageInfo(language).locale,{numeric:'auto'}).format(-count,unit);}
  detail=translate(language,'Last active ','最近活跃：')+ago;
  title=translate(language,'Last active: ','最近活跃：')+new Date(lastActiveAt).toLocaleString(languageInfo(language).locale);
  activity=detail+' ('+new Date(lastActiveAt).toLocaleString(languageInfo(language).locale)+')';
 }
 if(inCall)detail=translate(language,"In a call","正在通话");
 else if(working)detail=translate(language,"Working","正在工作");
 else if(online){
  detail=unconfirmed?(translate(language,"Work status unconfirmed","工作状态未确认")):waiting?(translate(language,"Waiting for your reply","等待你回复")):(translate(language,"Idle","空闲"));
  const explanation=unconfirmed?(translate(language,"The work computer is connected, but a task execution status has not been confirmed. Check Work progress before retrying.","工作电脑已连接，但有任务的执行状态尚未确认，请先查看工作进度再重试。")):waiting?(translate(language,"The work computer is connected. A task is waiting for your reply.","工作电脑已连接，有任务正在等待你回复。")):(translate(language,"The work computer is connected. No task is running.","工作电脑已连接，当前没有任务在执行。"));
  title=explanation+(activity?'\n'+activity:'');
 }
 const label=online?(translate(language,"Online","在线")):connecting?(translate(language,"Connecting","连接中")):(translate(language,"Disconnected","未连接"));
 return {label,detail,title,online,active};
}
