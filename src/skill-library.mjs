import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ordinaryDirectory,renameManaged} from './managed-path.mjs';

const slug=name=>typeof name==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name);
const text=(value,max)=>typeof value==='string'&&!value.includes('\0')&&Buffer.byteLength(value)<=max;
const marker='.dant-managed.json';
const generatedCaches=new Set(['__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','node_modules']);
const exportFailure=()=>Error('Invalid managed skill files for export.');
function instructionBody(source){const boundary=source.indexOf('\n---\n',4);if(!source.startsWith('---\n')||boundary<0)throw Error('Invalid managed skill frontmatter.');return source.slice(boundary+5).trim();}
function snapshotText(library,directory,relative){
 const file=library.inside(path.join(directory,relative));library.ordinary(path.dirname(file));const before=fs.lstatSync(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink>1||before.size>65536)throw exportFailure();
 const descriptor=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{
  const opened=fs.fstatSync(descriptor);if(!opened.isFile()||opened.nlink>1||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>65536)throw exportFailure();
  const buffer=Buffer.alloc(65537);let length=0,read;
  while(length<buffer.length&&(read=fs.readSync(descriptor,buffer,length,buffer.length-length,length)))length+=read;
  const after=fs.fstatSync(descriptor),current=fs.lstatSync(file);library.ordinary(path.dirname(file));
  if(length>65536||length!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||current.isSymbolicLink()||current.nlink>1||current.dev!==opened.dev||current.ino!==opened.ino)throw exportFailure();
  let value;try{value=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));}catch{throw exportFailure();}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw exportFailure();return value;
 }finally{fs.closeSync(descriptor);}
}

/** Only dant-owned folders are editable. Enabled skills use Codex's workspace discovery path. */
export class SkillLibrary{
 constructor({workspace,containsSecret=()=>false}){this.workspace=path.resolve(workspace);this.enabledRoot=path.join(this.workspace,'.agents','skills');this.disabledRoot=path.join(this.workspace,'.dant-disabled-skills');this.containsSecret=containsSecret;}
 inside(target){const full=path.resolve(target),relative=path.relative(this.workspace,full);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Invalid managed skill path.');return full;}
 ordinary(directory,{create=false}={}){
  this.inside(directory);ordinaryDirectory(directory,{create});
 }
 locate(name){if(!slug(name))throw Error('Invalid skill name.');for(const [root,enabled]of [[this.enabledRoot,true],[this.disabledRoot,false]]){const directory=this.inside(path.join(root,name));if(fs.lstatSync(directory,{throwIfNoEntry:false})){this.ordinary(directory);const file=path.join(directory,marker),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)throw Error('This skill is not managed by dant.');const meta=JSON.parse(fs.readFileSync(file,'utf8'));if(meta.owner!=='dant'||meta.name!==name)throw Error('This skill is not managed by dant.');return {directory,enabled,meta};}}return null;}
 list(){const items=[];for(const root of [this.enabledRoot,this.disabledRoot]){if(!fs.existsSync(root))continue;this.ordinary(root);for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory()||!slug(entry.name))continue;try{const found=this.locate(entry.name);if(!found||items.some(item=>item.name===entry.name))continue;items.push({name:entry.name,description:found.meta.description,enabled:found.enabled,path:path.join(found.directory,'SKILL.md'),updatedAt:found.meta.updatedAt});}catch{/* User/system skill folders are not managed here. */}}}return items.sort((a,b)=>a.name.localeCompare(b.name));}
 get(name){const snapshot=this.exportSnapshot(name);return {...snapshot,files:{...snapshot.files}};}
 exportSnapshot(name){
  const found=this.locate(name);if(!found)throw Error('Skill not found.');const {directory,enabled,meta}=found,files=Object.create(null),instructions=instructionBody(snapshotText(this,directory,'SKILL.md'));let entries=0,total=Buffer.byteLength(instructions);
  if(!instructions||total>49152)throw exportFailure();
  const walk=(folder,prefix='',depth=0)=>{
   this.ordinary(folder);if(depth>16)throw exportFailure();
   for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    if(++entries>128)throw exportFailure();const relative=prefix+entry.name,full=this.inside(path.join(folder,entry.name)),stat=fs.lstatSync(full);
    if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw exportFailure();
    if(!prefix&&(entry.name===marker||entry.name==='SKILL.md')){if(!stat.isFile())throw exportFailure();continue;}
    if(/[\x00-\x1f\x7f]/.test(relative))throw exportFailure();
    if(stat.isDirectory()){
     if(generatedCaches.has(entry.name))continue;this.fileName(relative+'/x');walk(full,relative+'/',depth+1);
    }else{
     this.fileName(relative);if(Object.keys(files).length>=20)throw exportFailure();const value=snapshotText(this,directory,relative);total+=Buffer.byteLength(value);if(total>262144)throw exportFailure();files[relative]=value;
    }
   }
  };
  walk(directory);return {name,description:meta.description,instructions,files,enabled,path:path.join(directory,'SKILL.md'),updatedAt:meta.updatedAt};
 }
 fileName(relative){if(typeof relative!=='string'||relative.length>180||relative.includes('\\')||relative.includes('\0')||! /^(?:(scripts|references|assets)\/|README\.md$|(?:LICENSE|NOTICE)(?:\.txt|\.md)?$)/.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':')))throw Error('Invalid supporting skill file path.');}
 save(input,{overwrite=true}={}){
  if(!input||!slug(input.name)||!text(input.description,1000)||!input.description.trim()||!text(input.instructions,49152)||!input.instructions.trim()||(input.enabled!==undefined&&typeof input.enabled!=='boolean'))throw Error('Invalid skill name, description, or instructions.');
  const existing=this.locate(input.name);if(existing&&!overwrite)throw Object.assign(Error('A skill with this name already exists.'),{code:'EEXIST'});
  // Omitted files edit metadata/instructions; an explicit file map replaces supporting files.
  const files=input.files===undefined?(existing?this.get(input.name).files:{}):input.files;if(!files||typeof files!=='object'||Array.isArray(files)||Object.keys(files).length>20)throw Error('Attach at most twenty text skill files.');let bytes=Buffer.byteLength(input.instructions);
  for(const [relative,value]of Object.entries(files)){this.fileName(relative);if(!text(value,65536))throw Error('Invalid supporting skill file.');bytes+=Buffer.byteLength(value);}
  if(bytes>262144)throw Error('The skill exceeds its size limit.');if([input.name,input.description,input.instructions,...Object.keys(files),...Object.values(files)].some(value=>this.containsSecret(value)))throw Error('Keep credentials in the credential vault, not in skills.');
  const enabled=input.enabled??existing?.enabled??true,root=enabled?this.enabledRoot:this.disabledRoot;this.ordinary(root,{create:true});
  const destination=this.inside(path.join(root,input.name));if(existing&&existing.directory!==destination&&fs.existsSync(destination))throw Error('The skill destination already exists.');
  const temporary=this.inside(path.join(root,'.staging-'+randomUUID())),backup=this.inside(path.join(root,'.backup-'+randomUUID()));fs.mkdirSync(temporary,{mode:0o700});let moved=false;
  try{
   fs.writeFileSync(path.join(temporary,'SKILL.md'),'---\nname: '+JSON.stringify(input.name)+'\ndescription: '+JSON.stringify(input.description.trim())+'\n---\n\n'+input.instructions.trim()+'\n',{mode:0o600});
   for(const [relative,value]of Object.entries(files)){const file=this.inside(path.join(temporary,relative));fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,value,{mode:0o600,flag:'wx'});}
   fs.writeFileSync(path.join(temporary,marker),JSON.stringify({owner:'dant',name:input.name,description:input.description.trim(),files:Object.keys(files),updatedAt:Date.now()}),{mode:0o600});
   if(existing){this.inside(existing.directory);renameManaged(existing.directory,backup);moved=true;}
   try{renameManaged(temporary,destination);}catch(error){if(moved)renameManaged(backup,existing.directory);moved=false;throw error;}
   if(moved)fs.rmSync(this.inside(backup),{recursive:true,force:true,maxRetries:5,retryDelay:20});return this.get(input.name);
  }finally{if(fs.existsSync(temporary))fs.rmSync(this.inside(temporary),{recursive:true,force:true,maxRetries:5,retryDelay:20});}
 }
 setEnabled(name,enabled){
  if(typeof enabled!=='boolean')throw Error('Invalid skill enable preference.');const existing=this.get(name);if(existing.enabled===enabled)return existing;
  const directory=path.dirname(existing.path),root=enabled?this.enabledRoot:this.disabledRoot;this.ordinary(root,{create:true});const destination=this.inside(path.join(root,name));
  if(fs.existsSync(destination))throw Error('The skill destination already exists.');renameManaged(directory,destination);
  return {...existing,enabled,path:path.join(destination,'SKILL.md')};
 }
 remove(name){const found=this.locate(name);if(!found)throw Error('Skill not found.');fs.rmSync(this.inside(found.directory),{recursive:true,maxRetries:5,retryDelay:20});return {removed:true,name};}
 context(){return 'Available dant-managed VM skills (reference index; read SKILL.md when relevant):\n'+JSON.stringify(this.list().filter(item=>item.enabled).map(({name,description,path})=>({name,description,path})));}
}
