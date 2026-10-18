import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {ordinaryDirectory,renameManaged} from './managed-path.mjs';

const MAX_FILE=2*1024*1024;
const field=(value,name,max,{optional=false}={})=>{if(optional&&value===undefined)return undefined;if(typeof value!=='string'||value.length>max||(!optional&&!value.trim())||value.includes('\0'))throw Error('Invalid credential '+name+'.');return value;};
const metadata=({id,name,service,username,createdAt,updatedAt})=>({id,name,service,username,createdAt,updatedAt});
const validId=id=>typeof id==='string'&&/^[0-9a-f-]{36}$/i.test(id);

// Streaming subtitles can end midway through a credential. Suppress a matching
// secret prefix before it becomes a complete value in a later transport frame.
function matchingSuffix(text,pattern){
 const table=new Uint32Array(pattern.length);for(let i=1,j=0;i<pattern.length;i++){while(j&&pattern[i]!==pattern[j])j=table[j-1];if(pattern[i]===pattern[j])j++;table[i]=j;}
 let matched=0;const tail=text.slice(-pattern.length);for(let i=0;i<tail.length;i++){while(matched&&tail[i]!==pattern[matched])matched=table[matched-1];if(tail[i]===pattern[matched])matched++;if(matched===pattern.length)matched=table[matched-1];}return matched;
}
export function redactCredentialText(value,secrets,{partial=false}={}){
 let result=String(value);for(const secret of [...secrets].filter(value=>typeof value==='string'&&value.length>=4).sort((a,b)=>b.length-a.length)){
  result=result.split(secret).join('[credential redacted]');
  if(partial){const count=matchingSuffix(result,secret);if(count>=4)result=result.slice(0,-count)+'[credential redacted]';}
 }return result;
}

/** VM-owned encrypted vault. The master key is restricted to the ordinary VM user. */
export class CredentialVault{
 constructor({dataDir}){this.dir=path.join(path.resolve(dataDir),'credentials');this.file=path.join(this.dir,'vault.enc');this.keyFile=path.join(this.dir,'master.key');}
 privateFile(file,max){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max||(process.platform!=='win32'&&(stat.mode&0o077)))throw Error('Invalid credential storage.');return stat;}
 directory(){ordinaryDirectory(this.dir,{create:true});const stat=fs.lstatSync(this.dir);if(process.platform!=='win32'&&(stat.mode&0o077))throw Error('Invalid credential storage.');}
 key(create=false){
  this.directory();
  if(!fs.existsSync(this.keyFile)){
   if(!create||fs.existsSync(this.file))throw Error('Credential storage cannot be unlocked.');
   fs.writeFileSync(this.keyFile,randomBytes(32),{flag:'wx',mode:0o600});
  }
  if(this.privateFile(this.keyFile,32).size!==32)throw Error('Credential storage cannot be unlocked.');return fs.readFileSync(this.keyFile);
 }
 read(){
  try{
   this.directory();if(!fs.lstatSync(this.file,{throwIfNoEntry:false}))return [];
   this.privateFile(this.file,MAX_FILE);const key=this.key();
   try{const value=JSON.parse(fs.readFileSync(this.file,'utf8'));if(value.version!==1)throw Error();const iv=Buffer.from(value.iv,'base64'),tag=Buffer.from(value.tag,'base64'),ciphertext=Buffer.from(value.data,'base64');if(iv.length!==12||tag.length!==16)throw Error();const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from('dant.credentials.v1'));decipher.setAuthTag(tag);const plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);try{const entries=JSON.parse(plain.toString('utf8'));if(!Array.isArray(entries)||entries.length>100||entries.some(item=>!validId(item?.id)||typeof item.secret!=='string'))throw Error();return entries;}finally{plain.fill(0);}}
   finally{key.fill(0);}
  }catch{throw Error('Credential storage cannot be unlocked. Existing data was preserved.');}
 }
 write(entries){
  let key,plain,temporary;
  try{
   if(entries.length>100)throw Error();key=this.key(true);plain=Buffer.from(JSON.stringify(entries));const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('dant.credentials.v1'));const data=Buffer.concat([cipher.update(plain),cipher.final()]);const value=JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});if(Buffer.byteLength(value)>MAX_FILE)throw Error();
   temporary=path.join(this.dir,'.vault-'+randomUUID()+'.tmp');const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}renameManaged(temporary,this.file);
  }catch{throw Error('The credential could not be saved. Existing data was preserved.');}
  finally{key?.fill(0);plain?.fill(0);if(temporary)try{fs.unlinkSync(temporary);}catch{/* Renamed or already absent. */}}
 }
 list(){return this.read().map(metadata);}
 find(query=''){const text=field(query,'query',300,{optional:true})??'';const value=text.toLowerCase().trim();return this.list().filter(item=>[item.name,item.service,item.username].some(part=>part.toLowerCase().includes(value))).slice(0,50);}
 get(id){if(!validId(id))throw Error('Invalid credential identifier.');const item=this.read().find(item=>item.id===id);if(!item)throw Error('Credential not found.');return {...item};}
 upsert(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid credential.');
  const entries=this.read();let item;if(input.id!==undefined){if(!validId(input.id))throw Error('Invalid credential identifier.');item=entries.find(item=>item.id===input.id);if(!item)throw Error('Credential not found.');}
  const name=field(input.name??item?.name,'name',100),service=field(input.service??item?.service??'','service',200,{optional:true}),username=field(input.username??item?.username??'','username',300,{optional:true}),secret=field(input.secret??item?.secret,'secret',16384);
  if(!item&&entries.length>=100)throw Error('The credential vault is full.');const now=Date.now(),updated={id:item?.id||randomUUID(),name:name.trim(),service:service.trim(),username,secret,createdAt:item?.createdAt||now,updatedAt:now};
  if(item)entries[entries.indexOf(item)]=updated;else entries.push(updated);this.write(entries);return metadata(updated);
 }
 remove(id){if(!validId(id))throw Error('Invalid credential identifier.');const entries=this.read(),filtered=entries.filter(item=>item.id!==id);if(filtered.length===entries.length)throw Error('Credential not found.');this.write(filtered);return {removed:true,id};}
 containsSecret(value){return this.read().some(item=>item.secret.length>=4&&String(value).includes(item.secret));}
 redact(value,{partial=false,additionalSecrets=[]}={}){
  if(!Array.isArray(additionalSecrets)||additionalSecrets.some(secret=>typeof secret!=='string'))throw Error('Invalid additional redaction values.');
  return redactCredentialText(value,[...this.read().map(item=>item.secret),...additionalSecrets],{partial});
 }
 toJSON(){return {items:this.list()};}
}

/** Pending secure forms are ephemeral, owner-scoped, and never become chat messages. */
export class CredentialRequests{
 constructor({vault,change=()=>{},timeoutMs=10*60*1000}){this.vault=vault;this.change=change;this.timeoutMs=timeoutMs;this.pending=new Map();this.closed=false;}
 snapshot(){const requests=[...this.pending.values()].map(item=>({id:item.id,name:item.name,service:item.service,reason:item.reason}));try{return {items:this.vault.list(),requests};}catch{return {items:[],requests,error:'Credential storage cannot be unlocked. Existing data was preserved.'};}}
 find(query){return this.vault.find(query);}
 get(id){return this.vault.get(id);}
 upsert(input){const item=this.vault.upsert(input);this.change();return item;}
 remove(id){const result=this.vault.remove(id);this.change();return result;}
 containsSecret(value){return this.vault.containsSecret(value);}
 redact(value,options){return this.vault.redact(value,options);}
 request(input,{owner,isCurrent}={}){
  if(this.closed||typeof owner!=='string'||typeof isCurrent!=='function'||!isCurrent())return Promise.reject(Error('The credential request is no longer active.'));
  const name=field(input?.name,'name',100).trim(),service=field(input.service??'','service',200,{optional:true}).trim(),reason=field(input.reason??'','reason',500,{optional:true});
  const prior=[...this.pending.values()].find(item=>item.owner===owner&&item.name===name&&item.service===service);if(prior)return prior.promise;
  if(this.pending.size>=10)return Promise.reject(Error('Too many pending credential requests.'));
  let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});
  const item={id:randomUUID(),name,service,reason,owner,isCurrent,resolve,reject,promise};item.timer=setTimeout(()=>this.cancel(item.id),this.timeoutMs);item.timer.unref?.();this.pending.set(item.id,item);this.change();return promise;
 }
 fulfill(id,input){
  const request=this.pending.get(id);if(!request)throw Error('The credential request is no longer active.');
  if(!request.isCurrent()){this.cancel(id);throw Error('The credential request is no longer active.');}
  const username=field(input?.username??'','username',300,{optional:true}),secret=field(input?.secret,'secret',16384);
  const existing=this.vault.list().find(item=>item.name===request.name&&item.service===request.service&&item.username===username);
  const item=this.vault.upsert({...(existing?{id:existing.id}:{}),name:request.name,service:request.service,username,secret});
  clearTimeout(request.timer);this.pending.delete(id);request.resolve({stored:true,credential:item});this.change();return {stored:true,credential:item};
 }
 cancel(id){const item=this.pending.get(id);if(!item)throw Error('The credential request is no longer active.');clearTimeout(item.timer);this.pending.delete(id);item.reject(Error('The credential request was cancelled.'));this.change();return {cancelled:true};}
 cancelOwner(owner){for(const item of [...this.pending.values()])if(item.owner===owner)this.cancel(item.id);}
 close(){this.closed=true;for(const item of [...this.pending.values()])this.cancel(item.id);}
}
