import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';

export const MAX_ATTACHMENT_BYTES=10*1024*1024;
export const MAX_MESSAGE_ATTACHMENTS=5;
export function readBounded(fd,limit){
 const chunks=[];let total=0;
 while(total<=limit){const chunk=Buffer.alloc(Math.min(64*1024,limit+1-total));const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;chunks.push(chunk.subarray(0,n));total+=n;}
 if(total>limit)throw Error('File exceeded the permitted size while reading.');
 return Buffer.concat(chunks,total);
}
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const utf8=new TextDecoder('utf-8',{fatal:true});

export function inspectContent(data,name='file'){
 if(!Buffer.isBuffer(data)||data.length>MAX_ATTACHMENT_BYTES)throw Error('Each attachment must be at most 10 MiB.');
 const at=(signature,offset=0)=>data.subarray(offset,offset+signature.length).equals(Buffer.from(signature));
 if(at([137,80,78,71,13,10,26,10]))return 'image/png';
 if(at([255,216,255]))return 'image/jpeg';
 if(at('GIF87a')||at('GIF89a'))return 'image/gif';
 if(at('RIFF')&&at('WEBP',8))return 'image/webp';
 if(at('%PDF-'))return 'application/pdf';
 if(at('RIFF')&&at('WAVE',8))return 'audio/wav';
 if(at('OggS'))return 'audio/ogg';
 if(at('ID3')||(data.length>1&&data[0]===255&&(data[1]&224)===224))return 'audio/mpeg';
 if(at([26,69,223,163]))return 'audio/webm';
 if(at('PK\u0003\u0004'))return 'application/zip';
 try{
  const text=utf8.decode(data);
  if(text.includes('\0'))return 'application/octet-stream';
  if(/\.json$/i.test(name)){JSON.parse(text);return 'application/json';}
  // SVG and HTML remain downloads; client declarations never make them active media.
  if(/\.(?:svg|html?)$/i.test(name))return 'application/octet-stream';
  if(!/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text))return 'text/plain';
 }catch(error){if(/\.json$/i.test(name))throw Error('The JSON attachment is not valid UTF-8 JSON.');}
 return 'application/octet-stream';
}

export class AttachmentStore{
 constructor(dir){this.dir=path.resolve(dir);fs.mkdirSync(this.dir,{recursive:true,mode:0o700});if(fs.lstatSync(this.dir).isSymbolicLink())throw Error('Attachment directory cannot be a symbolic link.');}
 put({name='file',data,type}={}){
  if(typeof data==='string'){
   if(data.length>Math.ceil(MAX_ATTACHMENT_BYTES/3)*4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw Error('Invalid attachment encoding.');
   data=Buffer.from(data,'base64');
  }
  const safeName=path.posix.basename(String(name).replaceAll('\\','/')).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,240)||'file';
  const actualType=inspectContent(data,safeName);
  if(typeof type==='string'&&/^(?:image|audio)\//.test(type)&&!actualType.startsWith(type.split('/')[0]+'/'))throw Error('The attachment content does not match its media format.');
  const id=randomUUID(),target=path.join(this.dir,id+'.bin');
  const meta={id,name:safeName,type:actualType,size:data.length,hash:createHash('sha256').update(data).digest('hex'),guestPath:target};
  fs.writeFileSync(target,data,{flag:'wx',mode:0o600});
  try{fs.writeFileSync(path.join(this.dir,id+'.json'),JSON.stringify(meta),{flag:'wx',mode:0o600});}
  catch(error){fs.unlinkSync(target);throw error;}
  return meta;
 }
 get(id){
  if(!idPattern.test(String(id)))return null;
  const file=path.join(this.dir,id+'.json');
  try{
   const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4096)return null;
   const meta=JSON.parse(fs.readFileSync(file,'utf8'));
   if(meta.id!==id||!Number.isInteger(meta.size)||meta.size<0||meta.size>MAX_ATTACHMENT_BYTES)return null;
   return {...meta,guestPath:path.join(this.dir,id+'.bin')};
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
 }
 read(id){
  const meta=this.get(id);if(!meta)throw Error('Attachment not found.');
  const file=meta.guestPath,before=fs.lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==meta.size)throw Error('Attachment changed or is not a regular file.');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
   const opened=fs.fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size)throw Error('Attachment changed while opening.');
   const data=readBounded(fd,MAX_ATTACHMENT_BYTES),after=fs.fstatSync(fd);
   if(data.length!==meta.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw Error('Attachment changed while reading.');
   return {meta,data};
  }finally{fs.closeSync(fd);}
 }
}
