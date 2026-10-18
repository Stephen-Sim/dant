import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {MAX_ATTACHMENT_BYTES,MAX_MESSAGE_ATTACHMENTS,readBounded} from './attachments.mjs';

const denied=/(?:^\.|(?:^|[-_.])(?:credentials?|secrets?|passwords?|tokens?|auth|cookies?)(?:[-_.]|$)|\.(?:log|pem|key|p12|pfx)$|^id_(?:rsa|ed25519|ecdsa))/i;
const MAX_ENTRIES=512,MAX_SCAN_BYTES=64*1024*1024,MAX_DEPTH=8;
const digest=data=>createHash('sha256').update(data).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&b.nlink===1;
const sameDirectory=(a,b)=>b.isDirectory()&&!b.isSymbolicLink()&&a.dev===b.dev&&a.ino===b.ino;

export function outputReference(root,value,{encoded=true}={}){
 if(typeof value!=='string'||!value||/[\x00-\x1f\x7f]/.test(value))return null;
 let candidate=value;
 if(encoded){
  candidate=candidate.replace(/^<|>$/g,'');
  if(/^file:/i.test(candidate)){
   try{const url=new URL(candidate);if(url.hostname&&url.hostname!=='localhost'||url.search||url.hash)return null;candidate=url.pathname;if(process.platform==='win32'&&/^\/[a-z]:\//i.test(candidate))candidate=candidate.slice(1);}catch{return null;}
  }else candidate=candidate.replace(/^sandbox:/i,'');
  if(/^[a-z][a-z\d+.-]*:/i.test(candidate)&&!(/^[a-z]:[/\\]/i.test(candidate)))return null;
  try{candidate=decodeURIComponent(candidate);}catch{return null;}
  if(/[\x00-\x1f\x7f?#]/.test(candidate)||candidate.startsWith('//'))return null;
 }
 const target=path.isAbsolute(candidate)?path.resolve(candidate):path.resolve(root,candidate.replace(/^(?:\.\/)?output[/\\]/,''));
 const relative=path.relative(root,target),parts=relative.split(path.sep);
 if(!relative||path.isAbsolute(relative)||parts.some(part=>part==='..'||denied.test(part))||parts.length>MAX_DEPTH+1)return null;
 return relative;
}

// Explicit output delivery only visits the requested path. An old screenshot
// remains deliverable when unrelated output files exceed automatic scan limits.
// Held parent descriptors prevent Linux directory replacement from redirecting
// the read; every platform also rechecks the complete directory/file identity.
function readOutputFile(root,relative){
 const parts=relative.split(path.sep),directories=[];
 try{
  fs.mkdirSync(root,{recursive:true});
  if(fs.realpathSync(root)!==root)throw Error('Output directory must be a real directory.');
  let directory=root;
  for(let index=0;index<parts.length;index++){
   const before=fs.lstatSync(directory);if(!before.isDirectory()||before.isSymbolicLink())throw Error('Output directory changed.');
   const fd=fs.openSync(directory,fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY||0)|(fs.constants.O_NOFOLLOW||0));
   directories.push({path:directory,fd,info:before});
   if(!sameDirectory(before,fs.fstatSync(fd)))throw Error('Output directory changed while opening.');
   const anchor=process.platform==='linux'?`/proc/self/fd/${fd}`:directory,target=path.join(anchor,parts[index]);
   if(index<parts.length-1){directory=target;continue;}
   const info=fs.lstatSync(target);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>MAX_ATTACHMENT_BYTES)throw Error('Output file is restricted.');
   const file=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
   try{
    const start=fs.fstatSync(file);if(!same(info,start))throw Error('Output file changed while opening.');
    const data=readBounded(file,MAX_ATTACHMENT_BYTES),end=fs.fstatSync(file),current=fs.lstatSync(target);
    if(!same(start,end)||!same(end,current)||data.length!==info.size)throw Error('Output file changed while reading.');
    for(const opened of directories)if(!sameDirectory(opened.info,fs.lstatSync(opened.path))||!sameDirectory(opened.info,fs.fstatSync(opened.fd)))throw Error('Output directory changed while reading.');
    return {hash:digest(data),data,name:parts.at(-1)};
   }finally{fs.closeSync(file);}
  }
 }finally{for(const directory of directories.reverse())fs.closeSync(directory.fd);}
}

// On Linux every child is opened relative to the already opened parent inode.
// Renaming a directory or replacing it with a symlink cannot redirect the scan.
function scan(outputDir){
 const root=path.resolve(outputDir),files=new Map();let count=0,bytes=0;
 fs.mkdirSync(root,{recursive:true});
 const rootStat=fs.lstatSync(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||fs.realpathSync(root)!==root)throw Error('Output directory must be a real directory.');
 function walk(directory,relative,depth){
  if(depth>MAX_DEPTH)throw Error('Output scan exceeded the directory depth limit.');
  const before=fs.lstatSync(directory);if(!before.isDirectory()||before.isSymbolicLink())throw Error('Output directory changed.');
  const fd=fs.openSync(directory,fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY||0)|(fs.constants.O_NOFOLLOW||0));
  try{
   const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)throw Error('Output directory changed while opening.');
   const anchor=process.platform==='linux'?`/proc/self/fd/${fd}`:directory;
   for(const name of fs.readdirSync(anchor).sort()){
    if(++count>MAX_ENTRIES)throw Error('Output scan exceeded 512 entries.');
    if(denied.test(name))continue;
    const target=path.join(anchor,name),rel=relative?relative+'/'+name:name,info=fs.lstatSync(target);
    if(info.isSymbolicLink())continue;
    if(info.isDirectory()){walk(target,rel,depth+1);continue;}
    if(!info.isFile()||info.nlink!==1||info.size>MAX_ATTACHMENT_BYTES)continue;
    bytes+=info.size;if(bytes>MAX_SCAN_BYTES)throw Error('Output scan exceeded 64 MiB.');
    const file=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{
     const start=fs.fstatSync(file);if(!same(info,start))throw Error('Output file changed while opening.');
     const data=readBounded(file,MAX_ATTACHMENT_BYTES),end=fs.fstatSync(file),current=fs.lstatSync(target);
     if(!same(start,end)||!same(end,current)||data.length!==info.size)throw Error('Output file changed while reading.');
     files.set(rel,{hash:digest(data),data,name});
    }finally{fs.closeSync(file);}
   }
  }finally{fs.closeSync(fd);}
 }
 walk(root,'',0);return files;
}

export class DeliverableCollector extends EventEmitter{
 constructor(attachments){super();this.attachments=attachments;}
 captureBaseline({outputDir}){
  try{return {valid:true,hashes:new Map([...scan(outputDir)].map(([name,item])=>[name,item.hash]))};}
  catch(error){this.emit('notice','Automatic delivery unavailable: '+error.message);return {valid:false,hashes:new Map()};}
 }
 archive({baseline,outputDir,explicitPaths=[],excludePaths=[],text='',onlyExplicit=false}){
  const result=[];
  try{
   const explicit=new Set(),root=path.resolve(outputDir),excluded=new Set(excludePaths.map(value=>outputReference(root,value,{encoded:false})).filter(Boolean));
   const refs=[...explicitPaths.map(value=>({value,encoded:false})),...Array.from(String(text).matchAll(/\]\(([^)]+)\)/g),m=>({value:m[1],encoded:true}))];
   for(const {value,encoded} of refs){const relative=outputReference(root,value,{encoded});if(relative&&!excluded.has(relative))explicit.add(relative);}
   for(const relative of explicit){
    if(result.length>=MAX_MESSAGE_ATTACHMENTS)break;
    let file;try{file=readOutputFile(root,relative);}catch{continue;}
    result.push({...this.attachments.put({name:file.name,data:file.data}),sourcePath:path.join(root,relative)});
   }
   if(!onlyExplicit&&baseline?.valid&&result.length<MAX_MESSAGE_ATTACHMENTS){
    // A failed broad scan must not discard already validated explicit files.
    const files=scan(outputDir);
    for(const [name,file] of files){
     if(result.length>=MAX_MESSAGE_ATTACHMENTS)break;
     if(excluded.has(name.split('/').join(path.sep))||explicit.has(name.split('/').join(path.sep))||baseline.hashes.get(name)===file.hash)continue;
     result.push({...this.attachments.put({name:file.name,data:file.data}),sourcePath:path.join(root,name)});
    }
   }
   return result;
  }catch(error){this.emit('notice','Files were not automatically delivered: '+error.message);return result;}
 }
 readExplicit({outputDir,filePath}){
  const root=path.resolve(outputDir),target=path.resolve(filePath),relativeTarget=path.relative(root,target),rel=relativeTarget.split(path.sep).join('/');
  if(!rel||path.isAbsolute(relativeTarget)||rel.startsWith('../')||rel==='..')throw Error('Only current output directory files can be delivered.');
  const relative=outputReference(root,filePath,{encoded:false});let file;try{if(relative)file=readOutputFile(root,relative);}catch{}
  if(!file)throw Error('The output file is missing, restricted or exceeds 10 MiB.');
  return {...this.attachments.put({name:file.name,data:file.data}),sourcePath:target};
 }
}
