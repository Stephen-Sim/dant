import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ordinaryDirectory} from './managed-path.mjs';

const DAY=86400000,MiB=1024*1024,SCHEMA='dant.diagnostics.v1',STARTUP_SCHEMA='dant.startup.v1',MAX_LINE_BYTES=4096;
const FILE=/^dant-diagnostics-v1-(\d{4}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/;
const token=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/,identifier=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const secretLike=/(?:^|[.:/])(?:sk[-_]|gh[pousr]_|xox[baprs]-|Bearer|eyJ[A-Za-z0-9_-]{10,}\.)/i;
const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*))*)?(?:\+[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/;
const versionString=value=>typeof value==='string'&&value.length<=64&&semver.test(value)&&!secretLike.test(value);
const versionKeys=new Set(['version','targetVersion','runningVersion']);
const textKeys=new Set(['code','status','role','reason','provider','phase','stage','source','operation','signal','transport']);
const idKeys=new Set(['threadId','turnId','callId','requestId','messageId','taskId','itemId']);
const itemTypes=new Set(['userMessage','hookPrompt','agentMessage','plan','reasoning','commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabAgentToolCall','webSearch','imageView','imageGeneration','enteredReviewMode','exitedReviewMode','contextCompaction','other']);
const itemStatuses=new Set(['inProgress','completed','failed','declined','interrupted','cancelled']);
const numberKeys=new Set(['bytes','eventBytes','queuedBytes','queuedEvents','durationMs','count','attempt','exitCode']);
const booleanKeys=new Set(['executorStopped','confirmed','unknownOutcome','connected','available','active','cached']);
const routes=new Set(['/api/:unknown','/api/session','/api/events','/api/state','/api/diagnostics','/api/provision','/api/connect','/api/prepare','/api/vm/profiles','/api/vm/providers','/api/vm/import','/api/fonts','/api/notifications/pending','/api/notifications/:id/ack','/api/internal/credentials','/api/messages','/api/messages/:id','/api/messages/:id/reaction','/api/history','/api/credentials','/api/credentials/:id','/api/credentials/requests/:id','/api/skills','/api/skills/:name','/api/telegram','/api/telegram/config','/api/telegram/pair','/api/telegram/disconnect','/api/login','/api/logout','/api/voice-key','/api/settings','/api/memory','/api/memory/:name','/api/read','/api/retry/:id','/api/stop','/api/tasks/pause','/api/tasks/resume','/api/tasks/:id/accept','/api/steer','/api/takeover','/api/screen','/api/input','/api/upload','/api/files/:id','/api/call','/api/call/connected','/api/realtime/message','/api/call/stop','/api/voices','/api/schedules','/api/schedules/:id','/health','/screen','/input','/control']);
const safeString=(value,pattern=token)=>typeof value==='string'&&pattern.test(value)&&!secretLike.test(value);
const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER;
const safeError=code=>Object.assign(Error(code),{diagnosticCode:code});
const sameFile=(left,right)=>left.dev===right.dev&&left.ino===right.ino;
routes.add('/api/version');routes.add('/api/updates');
routes.add('/api/tasks/clear-completed');
for(const action of ['pause','resume','cancel','priority','dismiss','context'])routes.add('/api/tasks/:id/'+action);
routes.add('/api/messages/:id/output-link/resolve');

// Metadata is an explicit schema. No recursive traversal, coercion, getters,
// messages, payloads, URLs, headers, or raw exception strings enter the file.
function metadata(value){
 if(value===null||typeof value!=='object'||Array.isArray(value))return {};
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return {};
 const result={};
 for(const key of [...textKeys,...idKeys,...numberKeys,...booleanKeys,'method','route',...versionKeys,'itemType','itemStatus']){
  const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))continue;const item=descriptor.value;
  if(versionKeys.has(key)){if(versionString(item))result[key]=item;}
  else if(key==='itemType'){if(itemTypes.has(item))result[key]=item;}
  else if(key==='itemStatus'){if(itemStatuses.has(item))result[key]=item;}
  else if(key==='route'){if(routes.has(item))result[key]=item;}
  else if(key==='method'){if(safeString(item,/^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*){0,5}$/)&&item.length<=96)result[key]=item;}
  else if(textKeys.has(key)){if(safeString(item))result[key]=item;else if(['status','code'].includes(key)&&Number.isSafeInteger(item)&&Math.abs(item)<=2147483648)result[key]=item;}
  else if(idKeys.has(key)){if(safeString(item,identifier)||(key==='requestId'&&Number.isSafeInteger(item)&&item>=0))result[key]=item;}
  else if(numberKeys.has(key)){if(numeric(item)&&(key==='durationMs'||Number.isSafeInteger(item))&&(key==='exitCode'||item>=0))result[key]=item;}
  else if(typeof item==='boolean')result[key]=item;
 }
 return result;
}

export class Diagnostics {
 constructor({dataDir,role='service',version,maxFileBytes=5*MiB,maxTotalBytes=50*MiB,retentionDays=3,cleanupIntervalMs=60*60*1000,startupLogMaxBytes=MiB,now=Date.now,schedule=setInterval,cancel=clearInterval}={}){
  this.closed=false;this.lastError=null;this.lastErrorAt=null;this.lastCleanupAt=null;this.totalBytes=0;this.fileCount=0;this.current=null;this.retained=new Map();this.cacheReady=false;this.nextExpiryAt=Infinity;this.timer=null;this.now=now;this.cancel=cancel;
  this.role=safeString(role)?role:'service';
  this.version=versionString(version)?version:null;
  this.maxTotalBytes=Number.isSafeInteger(maxTotalBytes)&&maxTotalBytes>=256?Math.min(50*MiB,maxTotalBytes):50*MiB;
  this.maxFileBytes=Number.isSafeInteger(maxFileBytes)&&maxFileBytes>=256?Math.min(5*MiB,maxFileBytes,this.maxTotalBytes):Math.min(5*MiB,this.maxTotalBytes);
  this.retentionDays=typeof retentionDays==='number'&&Number.isFinite(retentionDays)&&retentionDays>0?Math.min(3,retentionDays):3;
  this.cleanupIntervalMs=Number.isSafeInteger(cleanupIntervalMs)&&cleanupIntervalMs>=10?Math.min(DAY,cleanupIntervalMs):60*60*1000;
  this.startupLogMaxBytes=Number.isSafeInteger(startupLogMaxBytes)&&startupLogMaxBytes>0?Math.max(128,Math.min(MiB,startupLogMaxBytes)):MiB;
  this.dataDir=typeof dataDir==='string'&&path.isAbsolute(dataDir)&&!dataDir.includes('\0')?path.resolve(dataDir):null;
  this.directory=this.dataDir?path.join(this.dataDir,'logs'):null;
  this.cleanup();
  try{this.timer=schedule(()=>this.cleanup(),this.cleanupIntervalMs);this.timer?.unref?.();}catch{this.error('LOG_TIMER_FAILED');}
 }
 clock(){try{const value=this.now();if(typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=8640000000000000)return value;}catch{}return Date.now();}
 error(code){this.lastError=code;this.lastErrorAt=this.clock();return false;}
 directories(){if(!this.dataDir||!this.directory)throw safeError('LOG_UNSAFE_PATH');try{ordinaryDirectory(this.directory,{create:true});}catch{throw safeError('LOG_UNSAFE_PATH');}}
 ordinaryFile(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw safeError('LOG_UNSAFE_FILE');return stat;}
 open(file,flags){const before=this.ordinaryFile(file),fd=fs.openSync(file,flags|(fs.constants.O_NOFOLLOW||0));try{const actual=fs.fstatSync(fd);if(!sameFile(before,actual)||!actual.isFile()||actual.nlink!==1)throw safeError('LOG_UNSAFE_FILE');return {fd,stat:actual};}catch(error){fs.closeSync(fd);throw error;}}
 header(file,name){
  const match=FILE.exec(name);if(!match)return null;let opened;
  try{
   opened=this.open(file,fs.constants.O_RDONLY);const bytes=Buffer.alloc(Math.min(512,opened.stat.size));fs.readSync(opened.fd,bytes,0,bytes.length,0);const newline=bytes.indexOf(10);if(newline<0)return null;
   const value=JSON.parse(bytes.subarray(0,newline).toString('utf8')),createdAt=Date.parse(value.createdAt);
   if(value.schema!==SCHEMA||value.id!==match[2]||!Number.isFinite(createdAt)||new Date(createdAt).toISOString()!==value.createdAt||value.createdAt.slice(0,10)!==match[1])return null;
   return {name,file,size:opened.stat.size,createdAt,stat:opened.stat};
  }catch(error){if(error.diagnosticCode)this.error(error.diagnosticCode);else if(!(error instanceof SyntaxError)&&error.code!=='ENOENT')throw safeError('LOG_READ_FAILED');return null;}finally{if(opened)fs.closeSync(opened.fd);}
 }
 scan(){
  this.directories();const files=[],directory=fs.opendirSync(this.directory);let entries=0;
  try{let item;while((item=directory.readSync())){if(++entries>4096)throw safeError('LOG_SCAN_LIMIT');if(!FILE.test(item.name))continue;const file=path.join(this.directory,item.name),record=this.header(file,item.name);if(record)files.push(record);}}finally{directory.closeSync();}
  return files.sort((a,b)=>a.createdAt-b.createdAt||a.stat.birthtimeMs-b.stat.birthtimeMs||a.name.localeCompare(b.name));
 }
 remove(record){this.directories();const current=this.ordinaryFile(record.file);if(!sameFile(record.stat,current))throw safeError('LOG_UNSAFE_FILE');fs.unlinkSync(record.file);if(this.current===record.name)this.current=null;}
 legacy(now){
  const file=path.join(this.dataDir,'startup.log');let opened;
  try{
   const stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat)return;
   if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw safeError('LOG_UNSAFE_FILE');
   this.directories();opened=this.open(file,fs.constants.O_RDWR);if(!sameFile(stat,opened.stat))throw safeError('LOG_UNSAFE_FILE');
   const bytes=Buffer.alloc(Math.min(256,opened.stat.size));fs.readSync(opened.fd,bytes,0,bytes.length,0);let createdAt=null;
   try{const end=bytes.indexOf(10),marker=end>=0?JSON.parse(bytes.subarray(0,end).toString('utf8')):null,at=Date.parse(marker?.createdAt);if(marker?.schema===STARTUP_SCHEMA&&Number.isFinite(at)&&at<=now&&new Date(at).toISOString()===marker.createdAt)createdAt=at;}catch{}
   if(createdAt!==null&&now-createdAt<this.retentionDays*DAY&&opened.stat.size<=this.startupLogMaxBytes)return;
   // One-time adoption discards the unstructured legacy log. This first line
   // survives Rust's O_APPEND writes and process restarts; mtime and birthtime
   // cannot provide the age of content after ftruncate on the same inode.
   fs.ftruncateSync(opened.fd,0);fs.writeFileSync(opened.fd,JSON.stringify({schema:STARTUP_SCHEMA,createdAt:new Date(now).toISOString()})+'\n');
  }finally{if(opened)fs.closeSync(opened.fd);}
 }
 cleanup(){
  if(this.closed)return false;
  try{
   const now=this.clock(),files=this.scan(),retained=[];
   for(const file of files){if(now-file.createdAt>=this.retentionDays*DAY)this.remove(file);else retained.push(file);}
   retained.sort((a,b)=>(a.name===this.current)-(b.name===this.current)||a.createdAt-b.createdAt||a.stat.birthtimeMs-b.stat.birthtimeMs||a.name.localeCompare(b.name));
   let total=retained.reduce((sum,file)=>sum+file.size,0);
   while(total>this.maxTotalBytes&&retained.length){const file=retained.shift();this.remove(file);total-=file.size;}
   this.legacy(now);this.retained=new Map(retained.map(file=>[file.name,file]));if(!this.retained.has(this.current))this.current=null;
   this.totalBytes=total;this.fileCount=retained.length;this.nextExpiryAt=Math.min(Infinity,...retained.map(file=>file.createdAt+this.retentionDays*DAY));this.cacheReady=true;this.lastCleanupAt=now;return true;
  }catch(error){this.cacheReady=false;return this.error(error.diagnosticCode||'LOG_CLEANUP_FAILED');}
 }
 activeFile(){
  const file=this.retained.get(this.current);if(!file)return null;let stat;
  try{stat=this.ordinaryFile(file.file);}catch(error){if(error.code!=='ENOENT')throw error;this.current=null;this.cacheReady=false;return null;}
  if(!sameFile(file.stat,stat))throw safeError('LOG_UNSAFE_FILE');
  if(stat.size<file.size){this.current=null;this.cacheReady=false;return null;}
  this.totalBytes+=stat.size-file.size;file.size=stat.size;file.stat=stat;return file;
 }
 makeRoom(bytes,protectedName=null){
  const candidates=[...this.retained.values()].filter(file=>file.name!==protectedName).sort((a,b)=>a.createdAt-b.createdAt||a.stat.birthtimeMs-b.stat.birthtimeMs||a.name.localeCompare(b.name));
  while(this.totalBytes+bytes>this.maxTotalBytes&&candidates.length){const file=candidates.shift();this.remove(file);this.retained.delete(file.name);this.totalBytes-=file.size;}
  this.fileCount=this.retained.size;if(this.totalBytes+bytes>this.maxTotalBytes)throw safeError('LOG_QUOTA_FAILED');
  this.nextExpiryAt=Math.min(Infinity,...[...this.retained.values()].map(file=>file.createdAt+this.retentionDays*DAY));
 }
 log(event,fields={}){
  if(this.closed)return false;
  if(!safeString(event,/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/))return this.error('LOG_INVALID_EVENT');
  try{
   const now=this.clock(),at=new Date(now).toISOString(),record={at,event,...metadata(fields),role:this.role,...(this.version?{version:this.version}:{})},line=Buffer.from(JSON.stringify(record)+'\n');
   if(line.length>MAX_LINE_BYTES)return this.error('LOG_RECORD_TOO_LARGE');
   if((!this.cacheReady||now>=this.nextExpiryAt)&&!this.cleanup())return false;
   this.directories();let target=this.activeFile();
   if(!target||target.name.slice(20,30)!==at.slice(0,10)||target.size+line.length>this.maxFileBytes){
    const id=randomUUID(),name=`dant-diagnostics-v1-${at.slice(0,10)}-${id}.jsonl`,header=Buffer.from(JSON.stringify({schema:SCHEMA,id,createdAt:at})+'\n');
    if(header.length+line.length>this.maxFileBytes)return this.error('LOG_RECORD_TOO_LARGE');
    if(!this.cleanup())return false;this.makeRoom(header.length+line.length);
    this.directories();const file=path.join(this.directory,name),fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
    let stat,created,failure;
    try{created=fs.fstatSync(fd);fs.writeFileSync(fd,Buffer.concat([header,line]));stat=fs.fstatSync(fd);}catch(error){failure=error;}finally{fs.closeSync(fd);}
    if(failure){try{const actual=this.ordinaryFile(file);if(created&&sameFile(created,actual))fs.unlinkSync(file);}catch{}throw failure;}this.current=name;
    this.retained.set(name,{name,file,size:stat.size,createdAt:now,stat});this.totalBytes+=stat.size;this.fileCount=this.retained.size;this.nextExpiryAt=Math.min(this.nextExpiryAt,now+this.retentionDays*DAY);
   }else{
    if(this.totalBytes+line.length>this.maxTotalBytes){if(!this.cleanup())return false;target=this.activeFile();if(!target)throw safeError('LOG_FILE_CHANGED');this.makeRoom(line.length,target.name);}
    this.directories();const opened=this.open(target.file,fs.constants.O_WRONLY|fs.constants.O_APPEND);
    try{if(!sameFile(target.stat,opened.stat)||opened.stat.size!==target.size||opened.stat.size+line.length>this.maxFileBytes)throw safeError('LOG_FILE_CHANGED');fs.writeFileSync(opened.fd,line);const stat=fs.fstatSync(opened.fd);this.totalBytes+=stat.size-target.size;target.size=stat.size;target.stat=stat;}finally{fs.closeSync(opened.fd);}
   }
   return this.totalBytes>this.maxTotalBytes?this.cleanup():true;
  }catch(error){this.cacheReady=false;this.current=null;return this.error(error.diagnosticCode||'LOG_WRITE_FAILED');}
 }
 status(){return {directory:this.directory,role:this.role,version:this.version,retentionDays:this.retentionDays,maxFileBytes:this.maxFileBytes,maxTotalBytes:this.maxTotalBytes,cleanupIntervalMs:this.cleanupIntervalMs,startupLogMaxBytes:this.startupLogMaxBytes,fileCount:this.fileCount,totalBytes:this.totalBytes,lastCleanupAt:this.lastCleanupAt,lastError:this.lastError,lastErrorAt:this.lastErrorAt,closed:this.closed};}
 recent(limit=50){
  const count=Number.isFinite(limit)?Math.min(200,Math.max(0,Math.floor(limit))):50;if(!count)return [];
  try{
   const files=this.scan().reverse(),groups=[];let budget=MiB;
   for(const file of files){
    if(!budget)break;let opened;const records=[];
    try{
     opened=this.open(file.file,fs.constants.O_RDONLY);const length=Math.min(opened.stat.size,256*1024,budget),start=opened.stat.size-length,bytes=Buffer.alloc(length);fs.readSync(opened.fd,bytes,0,length,start);budget-=length;
     let content=bytes.toString('utf8');if(start>0)content=content.slice(content.indexOf('\n')+1);
     for(const line of content.split('\n')){
      if(!line||Buffer.byteLength(line)>MAX_LINE_BYTES)continue;let value;try{value=JSON.parse(line);}catch{continue;}
      if(!value||!safeString(value.event,/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/)||typeof value.at!=='string')continue;const at=Date.parse(value.at);
      if(!Number.isFinite(at)||this.clock()-at>=this.retentionDays*DAY)continue;records.push({at:new Date(at).toISOString(),event:value.event,...metadata(value)});
     }
    }finally{if(opened)fs.closeSync(opened.fd);}groups.push(records);
   }
   return groups.reverse().flat().sort((a,b)=>a.at.localeCompare(b.at)).slice(-count);
  }catch(error){this.error(error.diagnosticCode||'LOG_READ_FAILED');return [];}
 }
 close(){if(this.closed)return;this.closed=true;try{if(this.timer!==null)this.cancel(this.timer);}catch{this.error('LOG_TIMER_FAILED');}this.timer=null;}
}
export {Diagnostics as DiagnosticLogger};
