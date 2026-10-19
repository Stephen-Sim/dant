const KEY='dant.updateDraft.v1',TTL=2*60*60*1000,MAX_BYTES=512*1024;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const keys=(value,allowed)=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key));
const size=value=>new TextEncoder().encode(value).length;
const failure=()=>Error('Your message draft could not be saved. Keep the app open and try again.');
const targetId=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x20\x7f]/.test(value);
function workReply(value){if(!keys(value,['workId','turnId','conversationId'])||!targetId(value.workId,128)||!targetId(value.turnId,256)||!targetId(value.conversationId,128))throw failure();return {workId:value.workId,turnId:value.turnId,conversationId:value.conversationId};}
const defaultStorage=()=>{try{return globalThis.localStorage;}catch{return null;}};
export function updateDraftScope(state){
 if(state?.mode!=='vm-controller'||state.controller?.status!=='online'||state.controller.cached===true||!uuid(state.conversationId))return null;
 const vm=state.settings?.vm,port=Number(vm?.port||22);
 if(!vm||typeof vm.host!=='string'||!vm.host||vm.host.length>255||typeof vm.user!=='string'||!vm.user||vm.user.length>128||typeof vm.keyPath!=='string'||!vm.keyPath||vm.keyPath.length>2048||!Number.isInteger(port)||port<1||port>65535)return null;
 return JSON.stringify([state.conversationId,vm.host,vm.user,port,vm.keyPath]);
}
function payload(value){
 if(!plain(value)||typeof value.text!=='string'||value.text.length>100000||value.replyTo!==null&&!uuid(value.replyTo)||!Array.isArray(value.attachments)||value.attachments.length>5)throw failure();
 const ids=new Set(),attachments=value.attachments.map(file=>{
  if(!plain(file)||!uuid(file.id)||ids.has(file.id)||typeof file.name!=='string'||!file.name||file.name.length>240||/[\x00-\x1f\x7f]/.test(file.name)||typeof file.type!=='string'||file.type.length>120||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.type)||!Number.isSafeInteger(file.size)||file.size<0||file.size>10*1024*1024)throw failure();
  ids.add(file.id);return {id:file.id,name:file.name,type:file.type,size:file.size};
 });
 return {text:value.text,replyTo:value.replyTo,attachments,...(value.workReply!==undefined?{workReply:workReply(value.workReply)}:{})};
}
export function createUpdateDraft({storage=defaultStorage(),now=Date.now,crypto=globalThis.crypto}={}){
 const digest=async scope=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(scope)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
 let taking=null;
 function remove(expected){try{if(!storage||expected!==undefined&&storage.getItem(KEY)!==expected)return false;storage.removeItem(KEY);return storage.getItem(KEY)===null;}catch{return false;}}
 async function save(state,draft){
  const value=payload(draft);if(!value.text&&!value.replyTo&&!value.attachments.length&&!value.workReply){if(!remove())throw failure();return null;}
  const scope=updateDraftScope(state),at=now();if(!scope||!Number.isSafeInteger(at)||at<=0||!storage)throw failure();
  try{const receipt=crypto.randomUUID(),record={version:1,receipt,savedAt:at,scope:await digest(scope),...value},encoded=JSON.stringify(record);if(size(encoded)>MAX_BYTES)throw failure();storage.setItem(KEY,encoded);if(storage.getItem(KEY)!==encoded)throw failure();return receipt;}catch{remove();throw failure();}
 }
 function discard(receipt){
  if(!uuid(receipt))return;
  try{const raw=storage?.getItem(KEY);if(!raw)return;const record=JSON.parse(raw);if(record.receipt===receipt)remove();}catch{}
 }
 async function consume(state,{occupied=false}={}){
  const scope=updateDraftScope(state);if(!scope)return null;
  let raw;try{raw=storage?.getItem(KEY);}catch{return null;}if(!raw)return null;
  try{
   if(raw.length>MAX_BYTES||size(raw)>MAX_BYTES)throw failure();
   const record=JSON.parse(raw),at=now();
   if(!keys(record,['version','receipt','savedAt','scope','text','replyTo','attachments','workReply'])||record.version!==1||!uuid(record.receipt)||typeof record.scope!=='string'||!/^[a-f0-9]{64}$/.test(record.scope)||!Number.isSafeInteger(record.savedAt)||record.savedAt<=0||!Number.isSafeInteger(at)||at<record.savedAt||at-record.savedAt>TTL||!record.attachments.every(file=>keys(file,['id','name','type','size'])))throw failure();
   const value=payload(record);if(occupied||record.scope!==await digest(scope)){remove(raw);return null;}
   if(!remove(raw))return null;
   if(value.replyTo&&!state.messages?.some(message=>message.id===value.replyTo))value.replyTo=null;
   return value;
  }catch{remove(raw);return null;}
 }
 return {save,discard,take(state,options){if(taking)return taking.then(()=>null);const pending=consume(state,options).finally(()=>{if(taking===pending)taking=null;});taking=pending;return pending;}};
}
