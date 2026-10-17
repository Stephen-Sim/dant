import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_LENGTH=240;
function plainText(value){
 if(typeof value!=='string')return '';
 return value.slice(0,8192)
  .replace(/```[^\n]*\n?/g,'').replace(/!?\[([^\]]*)\]\([^\n)]*\)/g,'$1')
  .replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|#39);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'"})[entity])
  .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm,'').replace(/(\*\*|__|~~)([\s\S]*?)\1/g,'$2').replace(/\*([^*\n]+)\*/g,'$1').replace(/`/g,'')
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,' ').replace(/\s+/g,' ').trim();
}
function boundedPreview(value){const characters=Array.from(plainText(value));return characters.length>PREVIEW_LENGTH?characters.slice(0,PREVIEW_LENGTH-1).join('')+'…':characters.join('');}
function completionPreview(completion,messages,conversationId){
 // Only chat deliveries belong in a banner, never live speech or observer payloads.
 const deliveries=[...(completion.messageIds||[])].reverse().map(id=>messages.get(id)).filter(message=>message?.role==='assistant'&&message.status==='completed'&&(!message.source?.conversationId||message.source.conversationId===conversationId));
 for(const message of deliveries){
  const text=boundedPreview(message.text);if(text)return text;
 }
 for(const message of deliveries){
  const names=(message.attachments||[]).slice(0,3).map(file=>plainText(path.posix.basename(String(file.name||'').replace(/\\/g,'/')))).filter(Boolean);
  if(names.length)return boundedPreview(names.join(' · '));
 }
 return '';
}

export class NotificationHub{
 constructor(dataDir,{now=()=>Date.now(),graceMs=3000}={}){
  this.file=path.join(dataDir,'notifications.json');this.now=now;this.graceMs=graceMs;
  try{this.state=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{this.state={enabled:false,enabledAt:null,records:{}};}
  this.state.records||={};this.latest=[];this.previews=new Map();
 }
 save(){const file=this.file+'.tmp';fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(file,JSON.stringify(this.state),{mode:0o600});fs.renameSync(file,this.file);}
 configure(enabled){if(this.state.enabled===enabled)return;this.state.enabled=enabled;if(enabled)this.state.enabledAt=this.now();this.save();}
 observe(snapshot){
  const completions=snapshot.completions||snapshot.conversation?.completions||[];
  this.latest=completions;
  const messages=new Map((snapshot.messages||[]).map(message=>[message.id,message])),conversationId=snapshot.conversationId||snapshot.conversation?.id||null;this.previews=new Map();let changed=false;
  for(const completion of completions){
   if(!completion.id||!Number.isFinite(completion.at))continue;
   let record=this.state.records[completion.id];
   if(!record){record=this.state.records[completion.id]={id:completion.id,conversationId:snapshot.conversationId||snapshot.conversation?.id||null,messageId:completion.messageIds?.at(-1)||null,at:completion.at,observedAt:this.now(),eligible:this.state.enabled&&completion.at>=this.state.enabledAt};changed=true;}
   if(record.conversationId===conversationId)this.previews.set(completion.id,completionPreview(completion,messages,conversationId));
   const ids=completion.messageIds||[],read=!!completion.readAt||(ids.length>0&&ids.every(id=>{const message=messages.get(id);return message&&(message.read||message.visibleAt||message.receipt?.readAt);}));
   if(read&&!record.readAt){record.readAt=this.now();changed=true;}
  }
  const all=Object.values(this.state.records);if(all.length>1000){const keep=new Set(completions.map(item=>item.id));for(const record of all.sort((a,b)=>b.at-a.at).slice(1000))if(!keep.has(record.id))delete this.state.records[record.id];changed=true;}
  if(changed)this.save();
 }
 pending(){if(!this.state.enabled)return [];return Object.values(this.state.records).filter(record=>record.eligible&&!record.readAt&&!record.deliveredAt&&this.now()-record.observedAt>=this.graceMs).map(({id,conversationId,messageId})=>({id,conversationId,messageId,title:'dant',body:this.previews.get(id)||''}));}
 acknowledge(id){const record=this.state.records[id];if(!record)throw Error('Unknown completion notification.');if(!record.deliveredAt){record.deliveredAt=this.now();this.save();}return {ok:true};}
}
