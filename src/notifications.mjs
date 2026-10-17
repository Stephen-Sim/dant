import fs from 'node:fs';
import path from 'node:path';

export class NotificationHub{
 constructor(dataDir,{now=()=>Date.now(),graceMs=3000}={}){
  this.file=path.join(dataDir,'notifications.json');this.now=now;this.graceMs=graceMs;
  try{this.state=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{this.state={enabled:false,enabledAt:null,records:{}};}
  this.state.records||={};this.latest=[];
 }
 save(){const file=this.file+'.tmp';fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(file,JSON.stringify(this.state),{mode:0o600});fs.renameSync(file,this.file);}
 configure(enabled){if(this.state.enabled===enabled)return;this.state.enabled=enabled;if(enabled)this.state.enabledAt=this.now();this.save();}
 observe(snapshot){
  const completions=snapshot.completions||snapshot.conversation?.completions||[];
  this.latest=completions;
  const messages=new Map((snapshot.messages||[]).map(message=>[message.id,message]));let changed=false;
  for(const completion of completions){
   if(!completion.id||!Number.isFinite(completion.at))continue;
   let record=this.state.records[completion.id];
   if(!record){record=this.state.records[completion.id]={id:completion.id,conversationId:snapshot.conversationId||snapshot.conversation?.id||null,messageId:completion.messageIds?.at(-1)||null,at:completion.at,observedAt:this.now(),eligible:this.state.enabled&&completion.at>=this.state.enabledAt};changed=true;}
   const ids=completion.messageIds||[],read=!!completion.readAt||(ids.length>0&&ids.every(id=>{const message=messages.get(id);return message&&(message.read||message.visibleAt||message.receipt?.readAt);}));
   if(read&&!record.readAt){record.readAt=this.now();changed=true;}
  }
  const all=Object.values(this.state.records);if(all.length>1000){const keep=new Set(completions.map(item=>item.id));for(const record of all.sort((a,b)=>b.at-a.at).slice(1000))if(!keep.has(record.id))delete this.state.records[record.id];changed=true;}
  if(changed)this.save();
 }
 pending(){if(!this.state.enabled)return [];return Object.values(this.state.records).filter(record=>record.eligible&&!record.readAt&&!record.deliveredAt&&this.now()-record.observedAt>=this.graceMs).map(({id,conversationId,messageId})=>({id,conversationId,messageId,title:'dant',body:'你有来自 dant 的未读消息。 / You have an unread message from dant.'}));}
 acknowledge(id){const record=this.state.records[id];if(!record)throw Error('Unknown completion notification.');if(!record.deliveredAt){record.deliveredAt=this.now();this.save();}return {ok:true};}
}
