import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {MAX_ATTACHMENT_BYTES,MAX_MESSAGE_ATTACHMENTS,readBounded} from './attachments.mjs';

const denied=/(?:^\.|(?:^|[-_.])(?:credentials?|secrets?|passwords?|tokens?|auth|cookies?)(?:[-_.]|$)|\.(?:log|pem|key|p12|pfx)$|^id_(?:rsa|ed25519|ecdsa))/i;
const MAX_ENTRIES=512,MAX_SCAN_BYTES=64*1024*1024,MAX_DEPTH=8;
const digest=data=>createHash('sha256').update(data).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&b.nlink===1;

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
 archive({baseline,outputDir,explicitPaths=[],text='',onlyExplicit=false}){
  try{
   const files=scan(outputDir),explicit=new Set(),root=path.resolve(outputDir);
   const refs=[...explicitPaths,...Array.from(String(text).matchAll(/\]\(([^)]+)\)/g),m=>m[1])];
   for(let candidate of refs){
    if(typeof candidate!=='string'||/^[a-z]+:\/\//i.test(candidate))continue;
    try{candidate=decodeURIComponent(candidate.replace(/^<|>$/g,''));}catch{continue;}
    const absolute=path.isAbsolute(candidate)?path.resolve(candidate):path.resolve(root,candidate.replace(/^output[/\\]/,''));
    const relative=path.relative(root,absolute).split(path.sep).join('/');
    if(relative&&!relative.startsWith('../')&&relative!=='..'&&files.has(relative))explicit.add(relative);
   }
   const selected=[...explicit,...(!onlyExplicit&&baseline?.valid?[...files.keys()].filter(name=>baseline.hashes.get(name)!==files.get(name).hash):[])];
   const result=[];
   for(const name of [...new Set(selected)].slice(0,MAX_MESSAGE_ATTACHMENTS)){
    const file=files.get(name);result.push(this.attachments.put({name:file.name,data:file.data}));
   }
   return result;
  }catch(error){this.emit('notice','Files were not automatically delivered: '+error.message);return [];}
 }
 readExplicit({outputDir,filePath}){
  const root=path.resolve(outputDir),target=path.resolve(filePath),rel=path.relative(root,target).split(path.sep).join('/');
  if(!rel||rel.startsWith('../')||rel==='..')throw Error('Only current output directory files can be delivered.');
  const file=scan(root).get(rel);if(!file)throw Error('The output file is missing, restricted or exceeds 10 MiB.');
  return this.attachments.put({name:file.name,data:file.data});
 }
}
