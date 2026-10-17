// Status comes from the live bridge first. Cached work must never appear online.
export function formatPresence(state={},language='zh',now=Date.now()){
 const {active:work,call,controller}=state,lastActiveAt=state.presence?.lastActiveAt??state.lastActiveAt,workerStatus=state.worker?.status??state.workerStatus;
 const english=language==='en',bridge=controller?.status;
 const disconnected=controller?.cached===true||(bridge!==undefined&&bridge!=='online');
 const online=!disconnected&&workerStatus==='online';
 const connecting=!online&&(bridge==='connecting'||(!disconnected&&workerStatus==='connecting'));
 const inCall=online&&call?.status==='connected'&&state.callActiveNow!==false;
 const working=online&&Boolean(work)&&(work.visible!==false||['unknown','pausing','waiting_user'].includes(work.status));
 const active=inCall||working;
 const validAt=typeof lastActiveAt==='number'&&Number.isFinite(lastActiveAt)&&lastActiveAt>0&&lastActiveAt<=8640000000000000;
 const clock=typeof now==='number'&&Number.isFinite(now)?now:Date.now();
 let detail='',title='';
 if(validAt){
  const seconds=Math.floor(Math.max(0,clock-lastActiveAt)/1000);
  let ago;
  if(seconds<60)ago=english?'just now':'刚刚';
  else{
   const count=Math.floor(seconds/(seconds<3600?60:seconds<86400?3600:86400));
   const unit=seconds<3600?(english?'minute':'分钟'):seconds<86400?(english?'hour':'小时'):(english?'day':'天');
   ago=english?`${count} ${unit}${count===1?'':'s'} ago`:`${count} ${unit}前`;
  }
  detail=english?'Last active '+ago:'最近活跃：'+ago;
  title=(english?'Last active: ':'最近活跃：')+new Date(lastActiveAt).toLocaleString(english?'en-GB':'zh-CN');
 }
 if(inCall)detail=english?'In a call':'正在通话';
 else if(working)detail=english?'Working':'正在工作';
 const label=online?(english?'Online':'在线'):connecting?(english?'Connecting':'连接中'):(english?'Disconnected':'未连接');
 return {label,detail,title,online,active};
}
