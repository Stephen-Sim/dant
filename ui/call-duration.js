export function formatCallDuration(value){
 const seconds=Number.isFinite(Number(value))?Math.max(0,Math.floor(Number(value))):0;
 return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
}

// The server's connectedAt and final history seconds are authoritative. A local
// stop freezes the display until confirmation; stale snapshots cannot restart it.
export function createCallDuration({now=Date.now,schedule=setInterval,cancel=clearInterval,onTick=()=>{}}={}){
 let callId=null,connectedAt=null,seconds=0,timer=null,stopped=false,confirmed=false,finalized=false;
 const snapshot=()=>({callId,seconds,confirmed,finalized,running:timer!==null});
 const clear=()=>{if(timer!==null){cancel(timer);timer=null;}};
 function tick(){if(connectedAt===null)return;const next=Math.max(0,Math.round((now()-connectedAt)/1000));if(next!==seconds){seconds=next;onTick(snapshot());}}
 function reset(id=null){clear();callId=id;connectedAt=null;seconds=0;stopped=false;confirmed=false;finalized=false;onTick(snapshot());}
 function start(id,at){
  if(typeof id!=='string'||!id||!Number.isFinite(at)||at<0)return;
  if(callId!==id)reset(id);if(stopped)return;
  connectedAt=at;confirmed=true;tick();if(timer===null)timer=schedule(tick,1000);
 }
 function stop(id=callId,finalSeconds){
  if(!id||id!==callId)return;tick();clear();connectedAt=null;stopped=true;
  if(Number.isFinite(finalSeconds)&&finalSeconds>=0){seconds=Math.round(finalSeconds);finalized=true;confirmed=true;}
  onTick(snapshot());
 }
 function sync(call,messages=[]){
  const record=messages.find(message=>message.kind==='call'&&message.callId===callId);
  if(record)stop(callId,record.seconds);
  const id=call?.id||call?.callId;
  if(!id){if(callId&&!stopped)stop(callId);return;}
  if(id!==callId)reset(id);
  if(call.connectedAt!==null&&call.connectedAt!==undefined)start(id,call.connectedAt);
 }
 return {get snapshot(){return snapshot();},reset,start,stop,sync,dispose(){clear();stopped=true;}};
}
