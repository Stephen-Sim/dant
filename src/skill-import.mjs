import {randomUUID,createHash} from 'node:crypto';
import yauzl from 'yauzl';

const MAX_ARCHIVE=1024*1024,MAX_FILE=65536,MAX_TOTAL=262144,MAX_ENTRIES=128,TTL=10*60*1000;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const slug=value=>typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
const rootDoc=/^(?:README\.md|(?:LICENSE|NOTICE)(?:\.(?:txt|md))?)$/;
const fail=(code,message,status=400)=>Object.assign(Error(message),{code,status});
const invalid=()=>fail('invalid_skill','The skill has invalid or unsupported instructions or metadata.');
const limited=()=>fail('size_limit','The skill exceeds the supported file count or size limit.');
const remoteFailure=()=>fail('fetch_failed','Could not read the public GitHub skill. Check the source or try again later.',502);
const safePath=value=>typeof value==='string'&&value.length<=512&&!/[\\\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.includes(':'));
function plain(data){
 let value;try{value=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw fail('unsupported_file','Skill files must contain valid UTF-8 text.');}
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)||/^(?:%PDF-|PK\x03\x04|RIFF|OggS|GIF8[79]a)/.test(value))throw fail('unsupported_file','Binary skill files are not supported.');
 return value.replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
}
function scalar(value){
 value=value.trim();
 if(value.startsWith('"')){const match=/^("(?:[^"\\]|\\.)*")(?:\s*#.*)?$/.exec(value);try{if(!match)throw Error();const parsed=JSON.parse(match[1]);if(typeof parsed!=='string')throw Error();return parsed;}catch{throw invalid();}}
 if(value.startsWith("'")){const match=/^'((?:[^']|'')*)'(?:\s*#.*)?$/.exec(value);if(!match)throw invalid();return match[1].replaceAll("''", "'");}
 if(!value||/^[#!&*[{]/.test(value)||/\s[&*][\w-]+/.test(value))throw invalid();
 return value.replace(/\s+#.*$/,'').trim();
}
function manifest(data,source){
 const text=plain(data);if(!text.startsWith('---\n'))throw invalid();const boundary=text.indexOf('\n---\n',4);if(boundary<0||boundary>8192)throw invalid();
 const lines=text.slice(4,boundary).split('\n'),fields=Object.create(null);let index=0;
 while(index<lines.length){
  const line=lines[index++];if(!line.trim()||line.trimStart().startsWith('#'))continue;
  const match=/^([a-z][a-z-]*):(?:\s+(.*))?$/.exec(line);if(!match||Object.hasOwn(fields,match[1]))throw invalid();
  const [,key,raw='']=match;if(!['name','description','license','compatibility','metadata'].includes(key))throw fail('invalid_skill','This skill uses unsupported behavioral metadata. Import it only after reviewing those requirements.');
  if(key==='metadata'){fields[key]=true;while(index<lines.length&&(/^\s/.test(lines[index])||!lines[index].trim()))index++;continue;}
  if(/^[|>][-+]?$/.test(raw.trim())){
   const pieces=[];let indent=null;
   while(index<lines.length&&(/^\s/.test(lines[index])||!lines[index].trim())){const item=lines[index++];if(item.trim()){const spaces=/^ */.exec(item)[0].length;if(!spaces||item.startsWith('\t'))throw invalid();indent=indent===null?spaces:Math.min(indent,spaces);}pieces.push(item);}
   if(indent===null)throw invalid();const body=pieces.map(item=>item.trim()?item.slice(indent):'');fields[key]=(raw.startsWith('>')?body.join('\n').replace(/([^\n])\n(?=[^\n])/g,'$1 '):body.join('\n')).trim();
  }else fields[key]=scalar(raw);
 }
 if(!slug(fields.name)||typeof fields.description!=='string'||!fields.description.trim()||Buffer.byteLength(fields.description)>1000)throw invalid();
 let instructions=text.slice(boundary+5).trim();if(!instructions)throw invalid();
 const provenance=[...(source.startsWith('https://github.com/')?['Source: '+source]:[]),...['license','compatibility'].filter(key=>fields[key]).map(key=>key[0].toUpperCase()+key.slice(1)+': '+fields[key])];
 if(provenance.length)instructions+='\n\n---\nImported skill reference metadata:\n'+provenance.join('\n');if(Buffer.byteLength(instructions)>49152)throw limited();
 return {name:fields.name,description:fields.description.trim(),instructions};
}
function supported(relative){if(!safePath(relative)||relative.length>180||!(/^(scripts|references|assets)\//.test(relative)||rootDoc.test(relative)))throw fail('unsupported_file','Only SKILL.md, README/LICENSE/NOTICE documents, and text files in scripts, references, or assets are supported.');}
function select(files){
 const candidates=[...files.keys()].filter(name=>name.split('/').at(-1)==='SKILL.md');
 if(candidates.length!==1)throw fail('invalid_skill',candidates.length?'Multiple skills were found. Choose one specific skill directory.':'No SKILL.md was found in the source.');
 const skillPath=candidates[0],prefix=skillPath.slice(0,-8),selected=new Map();
 for(const [name,value]of files)if(name.startsWith(prefix)){const relative=name.slice(prefix.length);if(relative!=='SKILL.md')supported(relative);selected.set(relative,value);}
 if(selected.size>21)throw limited();const paths=new Set([...selected.keys()].map(value=>value.toLowerCase()));for(const file of paths){const parts=file.split('/');for(let count=1;count<parts.length;count++)if(paths.has(parts.slice(0,count).join('/')))throw fail('invalid_skill','The skill contains conflicting file and directory paths.');}return selected;
}
async function withSignal(promise,signal){
 let abort;try{return await Promise.race([promise,new Promise((resolve,reject)=>{abort=()=>reject(remoteFailure());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}
}
async function bytes(response,limit,signal){
 if(Number(response.headers?.get('content-length'))>limit)throw limited();
 const reader=response.body?.getReader();if(!reader)throw remoteFailure();const chunks=[];let total=0;
 try{while(true){const item=await withSignal(reader.read(),signal);if(item.done)break;total+=item.value.byteLength;if(total>limit)throw limited();chunks.push(Buffer.from(item.value));}return Buffer.concat(chunks,total);}
 finally{void reader.cancel().catch(()=>{});}
}
function githubSource(value){
 if(typeof value!=='string')throw fail('invalid_source','Use a public github.com repository, skill directory, or SKILL.md URL.');
 try{const rawPath=/^https:\/\/[^/]+(\/[^?#]*)/.exec(value)?.[1]||'';if(rawPath.split('/').map(decodeURIComponent).some(part=>part==='.'||part==='..'))throw Error();}catch{throw fail('invalid_source','The GitHub source URL contains an invalid path.');}
 let url;try{url=new URL(value);}catch{throw fail('invalid_source','Use a public github.com repository, skill directory, or SKILL.md URL.');}
 if(typeof value!=='string'||value.length>2048||/[\\\x00-\x20\x7f]/.test(value)||url.protocol!=='https:'||url.hostname!=='github.com'||url.port||url.username||url.password||url.search||url.hash)throw fail('invalid_source','Use a public github.com URL without credentials, queries, or fragments.');
 let parts;try{parts=url.pathname.replace(/\/$/,'').slice(1).split('/').map(decodeURIComponent);}catch{throw fail('invalid_source','The GitHub source URL is invalid.');}
 const [owner,repoPart,...rest]=parts,repo=repoPart?.replace(/\.git$/,'');if(!/^[a-zA-Z0-9-]{1,100}$/.test(owner||'')||! /^[a-zA-Z0-9_.-]{1,100}$/.test(repo||'')||repo==='.'||repo==='..')throw fail('invalid_source','The GitHub repository URL is invalid.');
 let ref='HEAD',directory='';if(rest.length){const [kind,branch,...location]=rest;if(!['tree','blob'].includes(kind)||!branch||branch.length>128||! /^[a-zA-Z0-9._/-]+$/.test(branch)||branch.split('/').some(part=>!part||part==='.'||part==='..'))throw fail('invalid_source','Choose a GitHub repository, tree directory, or SKILL.md blob URL.');ref=branch;if(kind==='blob'&&location.pop()!=='SKILL.md')throw fail('invalid_source','A GitHub file URL must point to SKILL.md.');directory=location.join('/');if(location.some(part=>part.includes('/'))||directory&&(!safePath(directory)||directory.split('/').length>16))throw fail('invalid_source','The GitHub skill directory is invalid.');}
 const candidates=[];if(!rest.length)candidates.push({ref,directory});else{const parts=directory?directory.split('/'):[];for(let length=parts.length;length>=0;length--){const candidate=[ref,...parts.slice(0,length)].join('/');if(candidate.length<=128)candidates.push({ref:candidate,directory:parts.slice(length).join('/')});}}
 return {owner,repo,candidates};
}
function crc32(data){let value=0xffffffff;for(const byte of data){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
async function unzip(data,signal){
 let zip;try{zip=await new Promise((resolve,reject)=>yauzl.fromBuffer(data,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,value)=>error?reject(error):resolve(value)));}catch{throw fail('invalid_skill','The ZIP archive is invalid or unsupported.');}
 const files=new Map(),entries=[];let stream;
 try{
  await new Promise((resolve,reject)=>{
   let count=0,total=0;const names=new Set(),abort=()=>reject(remoteFailure());signal.addEventListener('abort',abort,{once:true});
   const cleanup=()=>signal.removeEventListener('abort',abort);zip.once('end',()=>{cleanup();resolve();});zip.once('error',()=>{cleanup();reject(fail('invalid_skill','The ZIP archive is invalid or unsupported.'));});
   zip.on('entry',entry=>{
    try{
     if(++count>MAX_ENTRIES||zip.entryCount>MAX_ENTRIES)throw limited();const directory=entry.fileName.endsWith('/'),name=directory?entry.fileName.slice(0,-1):entry.fileName;
     if(!safePath(name)||names.has(name.toLowerCase()))throw fail('invalid_skill','The ZIP contains unsafe or duplicate paths.');names.add(name.toLowerCase());
     const mode=(entry.externalFileAttributes>>>16)&0xf000;if(entry.isEncrypted()||(mode&&mode!==(directory?0x4000:0x8000)))throw fail('unsupported_file','Encrypted archives, links, and special files are not supported.');
     if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||entry.uncompressedSize>MAX_FILE||!Number.isSafeInteger(entry.compressedSize)||entry.compressedSize<0||entry.compressedSize>MAX_ARCHIVE)throw limited();
     total+=entry.uncompressedSize;if(total>MAX_TOTAL+MAX_FILE)throw limited();if(!directory)entries.push(entry);else if(entry.uncompressedSize)throw invalid();zip.readEntry();
    }catch(error){cleanup();reject(error);}
   });zip.readEntry();if(signal.aborted)abort();
  });
  const selected=select(new Map(entries.map(entry=>[entry.fileName,entry])));
  for(const [relative,entry]of selected){
   if(signal.aborted)throw remoteFailure();stream=await new Promise((resolve,reject)=>zip.openReadStream(entry,(error,value)=>error?reject(error):resolve(value)));
   const chunks=[];let length=0;
   try{for await(const chunk of stream){if(signal.aborted)throw remoteFailure();length+=chunk.length;if(length>MAX_FILE||length>entry.uncompressedSize)throw limited();chunks.push(chunk);}}catch(error){if(error.code)throw error;throw fail('invalid_skill','The ZIP file contents are invalid.');}finally{stream.destroy();stream=null;}
   const content=Buffer.concat(chunks,length);if(length!==entry.uncompressedSize||crc32(content)!==entry.crc32)throw fail('invalid_skill','The ZIP file contents failed their integrity check.');files.set(relative,content);
  }
  return files;
 }catch(error){if(error?.status)throw error;throw fail('invalid_skill','The ZIP archive is invalid or unsupported.');}finally{stream?.destroy();zip.close();}
}

/** Previews hold inert text in RAM. Only an explicit commit writes a managed skill. */
export class SkillImporter{
 constructor({skills,fetchImpl=fetch,now=Date.now,timeoutMs=30000}={}){this.skills=skills;this.fetch=fetchImpl;this.now=now;this.timeoutMs=timeoutMs;this.previews=new Map();this.inflight=0;this.controllers=new Set();this.closed=false;if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw fail('invalid_source','Invalid skill import deadline.');}
 clean(){for(const [id,item]of this.previews)if(item.expiresAt<=this.now())this.previews.delete(id);}
 async request(route,signal,limit=MAX_FILE*2){
  let response;try{response=await withSignal(this.fetch('https://api.github.com'+route,{method:'GET',redirect:'error',credentials:'omit',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'dant-skill-import'},signal}),signal);}catch{throw remoteFailure();}
  if(response.status===404||response.status===422&&/^\/repos\/[^/]+\/[^/]+\/commits(?:\/|\?)/.test(route))throw fail('not_found','The public GitHub repository, revision, or skill was not found.',404);if(!response.ok||response.redirected)throw remoteFailure();
  let data;try{data=await bytes(response,limit,signal);}catch(error){if(error.code==='size_limit')throw error;throw remoteFailure();}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw remoteFailure();}
 }
 async github(url,signal){
  const {owner,repo,candidates}=githubSource(url),base='/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repo);let commit,directory;
  // GitHub URLs can contain slash-bearing branches. Match the longest existing
  // revision prefix, then freeze all reads to its immutable commit/tree/blob IDs.
  for(const candidate of candidates){try{const commits=await this.request(base+'/commits?sha='+encodeURIComponent(candidate.ref)+'&per_page=1',signal);if(!Array.isArray(commits)||commits.length!==1)throw remoteFailure();commit=commits[0];directory=candidate.directory;break;}catch(error){if(error.code!=='not_found')throw error;}}
  if(!commit)throw fail('not_found','The public GitHub repository, revision, or skill was not found.',404);if(!sha(commit.sha)||!sha(commit?.commit?.tree?.sha))throw remoteFailure();let treeId=commit.commit.tree.sha;
  for(const segment of directory?directory.split('/'):[]){const tree=await this.request(base+'/git/trees/'+treeId,signal,MAX_ARCHIVE);if(tree?.truncated!==false||!Array.isArray(tree.tree)||tree.tree.length>1000)throw limited();const item=tree.tree.find(item=>item.path===segment);if(!item||item.type!=='tree'||item.mode!=='040000'||!sha(item.sha))throw fail('not_found','The selected GitHub skill directory was not found.',404);treeId=item.sha;}
  const tree=await this.request(base+'/git/trees/'+treeId+'?recursive=1',signal,MAX_ARCHIVE);if(tree?.truncated!==false||!Array.isArray(tree.tree)||tree.tree.length>MAX_ENTRIES)throw limited();
  const files=new Map(),names=new Set();for(const entry of tree.tree){if(!safePath(entry.path)||names.has(entry.path.toLowerCase()))throw remoteFailure();names.add(entry.path.toLowerCase());if(entry.type==='tree'&&entry.mode==='040000')continue;files.set(entry.path,entry);}
  const selected=select(files),result=new Map();let total=0;
  for(const [name,entry]of selected){if(entry.type!=='blob'||!['100644','100755'].includes(entry.mode)||!sha(entry.sha))throw fail('unsupported_file','GitHub links, submodules, and special files are not supported.');if(!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>MAX_FILE)throw limited();total+=entry.size;if(total>MAX_TOTAL+MAX_FILE)throw limited();}
  for(const [name,entry]of selected){
   const blob=await this.request(base+'/git/blobs/'+entry.sha,signal);if(blob?.encoding!=='base64'||typeof blob.content!=='string'||blob.size!==entry.size||blob.sha!==entry.sha)throw remoteFailure();const encoded=blob.content.replaceAll('\n','');if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw remoteFailure();const data=Buffer.from(encoded,'base64');
   if(data.length!==entry.size||createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex')!==entry.sha)throw remoteFailure();result.set(name,data);
  }
  return {files:result,source:'https://github.com/'+owner+'/'+repo+'/tree/'+commit.sha+(directory?'/'+directory.split('/').map(encodeURIComponent).join('/'):'')};
 }
 async preview(input){
  this.clean();if(this.closed)throw fail('expired','Skill importing has stopped.',410);if(this.previews.size+this.inflight>=3)throw fail('import_busy','Three import previews are already open. Finish one or wait for it to expire.',429);
  if(!input||typeof input!=='object'||Array.isArray(input)||Boolean(input.url)===Boolean(input.data))throw fail('invalid_source','Choose one GitHub URL or local ZIP/SKILL.md file.');
  this.inflight++;const controller=new AbortController();this.controllers.add(controller);const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  try{
   let files,source;
   if(input.url){({files,source}=await this.github(input.url,controller.signal));}
   else{if(!Buffer.isBuffer(input.data)||input.data.length>MAX_ARCHIVE)throw limited();source=typeof input.name==='string'?input.name.replaceAll('\\','/').split('/').at(-1):'';if(source==='SKILL.md'){if(input.data.length>MAX_FILE)throw limited();files=new Map([['SKILL.md',input.data]]);}else if(/\.zip$/i.test(source))files=await unzip(input.data,controller.signal);else throw fail('unsupported_file','Choose a ZIP archive or a file named SKILL.md.');if(/[\x00-\x1f\x7f]/.test(source)||source.length>180)throw fail('invalid_source','The local skill file name is invalid.');}
   const candidate=manifest(files.get('SKILL.md'),source),support=Object.create(null);let total=Buffer.byteLength(candidate.instructions);const listed=[{path:'SKILL.md',size:files.get('SKILL.md').length}];
   for(const [name,data]of files)if(name!=='SKILL.md'){supported(name);if(data.length>MAX_FILE)throw limited();const text=plain(data);support[name]=text;total+=Buffer.byteLength(text);listed.push({path:name,size:Buffer.byteLength(text)});}
   if(total>MAX_TOTAL||Object.keys(support).length>20)throw limited();for(const value of [candidate.name,candidate.description,candidate.instructions,...Object.keys(support),...Object.values(support)])if(this.skills?.containsSecret?.(value))throw fail('invalid_skill','Keep credentials in the credential vault, not in imported skills.');
   if(this.closed||controller.signal.aborted)throw remoteFailure();const id=randomUUID(),expiresAt=this.now()+TTL,value={...candidate,files:support};this.previews.set(id,{value,source,expiresAt});return {id,source,...candidate,files:listed,expiresAt};
  }finally{clearTimeout(timer);this.controllers.delete(controller);this.inflight--;}
 }
 commit({id,name,enabled}={}){
  this.clean();const item=this.previews.get(id);if(!item)throw fail('expired','This import preview expired or was already used. Preview the source again.',410);
  name=name??item.value.name;if(!slug(name)||(enabled!==undefined&&typeof enabled!=='boolean'))throw invalid();
  let existing;try{existing=this.skills.locate(name);}catch{throw fail('name_exists','A skill or unmanaged folder with this name already exists. Choose another name.',409);}if(existing)throw fail('name_exists','A skill with this name already exists. Choose another name.',409);
  this.previews.delete(id);try{return this.skills.save({...item.value,name,enabled:enabled??true},{overwrite:false});}catch{throw fail('invalid_skill','The imported skill could not be saved. Check its contents and preview it again.');}
 }
 discard(id){this.previews.delete(id);return {discarded:true};}
 close(){this.closed=true;this.previews.clear();for(const controller of this.controllers)controller.abort();}
}
