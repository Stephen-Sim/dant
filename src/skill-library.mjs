import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ordinaryDirectory,renameManaged} from './managed-path.mjs';

const slug=name=>typeof name==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name);
const text=(value,max)=>typeof value==='string'&&!value.includes('\0')&&Buffer.byteLength(value)<=max;
const marker='.dant-managed.json';

/** Only dant-owned folders are editable. Enabled skills use Codex's workspace discovery path. */
export class SkillLibrary{
 constructor({workspace,containsSecret=()=>false}){this.workspace=path.resolve(workspace);this.enabledRoot=path.join(this.workspace,'.agents','skills');this.disabledRoot=path.join(this.workspace,'.dant-disabled-skills');this.containsSecret=containsSecret;}
 inside(target){const full=path.resolve(target),relative=path.relative(this.workspace,full);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Invalid managed skill path.');return full;}
 ordinary(directory,{create=false}={}){
  this.inside(directory);ordinaryDirectory(directory,{create});
 }
 locate(name){if(!slug(name))throw Error('Invalid skill name.');for(const [root,enabled]of [[this.enabledRoot,true],[this.disabledRoot,false]]){const directory=this.inside(path.join(root,name));if(fs.lstatSync(directory,{throwIfNoEntry:false})){this.ordinary(directory);const file=path.join(directory,marker),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)throw Error('This skill is not managed by dant.');const meta=JSON.parse(fs.readFileSync(file,'utf8'));if(meta.owner!=='dant'||meta.name!==name)throw Error('This skill is not managed by dant.');return {directory,enabled,meta};}}return null;}
 list(){const items=[];for(const root of [this.enabledRoot,this.disabledRoot]){if(!fs.existsSync(root))continue;this.ordinary(root);for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory()||!slug(entry.name))continue;try{const found=this.locate(entry.name);if(!found||items.some(item=>item.name===entry.name))continue;items.push({name:entry.name,description:found.meta.description,enabled:found.enabled,path:path.join(found.directory,'SKILL.md'),updatedAt:found.meta.updatedAt});}catch{/* User/system skill folders are not managed here. */}}}return items.sort((a,b)=>a.name.localeCompare(b.name));}
 get(name){const found=this.locate(name);if(!found)throw Error('Skill not found.');const {directory,enabled,meta}=found,files={};for(const relative of meta.files||[]){this.fileName(relative);const file=this.inside(path.join(directory,relative));this.ordinary(path.dirname(file));const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Invalid managed skill file.');files[relative]=fs.readFileSync(file,'utf8');}const skill=path.join(directory,'SKILL.md'),stat=fs.lstatSync(skill);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Invalid managed skill instructions.');const source=fs.readFileSync(skill,'utf8'),boundary=source.indexOf('\n---\n',4);if(!source.startsWith('---\n')||boundary<0)throw Error('Invalid managed skill frontmatter.');return {name,description:meta.description,instructions:source.slice(boundary+5).trim(),files,enabled,path:skill,updatedAt:meta.updatedAt};}
 fileName(relative){if(typeof relative!=='string'||relative.length>180||relative.includes('\\')||relative.includes('\0')||! /^(scripts|references|assets)\//.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':')))throw Error('Invalid supporting skill file path.');}
 save(input){
  if(!input||!slug(input.name)||!text(input.description,1000)||!input.description.trim()||!text(input.instructions,49152)||!input.instructions.trim()||(input.enabled!==undefined&&typeof input.enabled!=='boolean'))throw Error('Invalid skill name, description, or instructions.');
  const files=input.files??{};if(!files||typeof files!=='object'||Array.isArray(files)||Object.keys(files).length>20)throw Error('Attach at most twenty text skill files.');let bytes=Buffer.byteLength(input.instructions);
  for(const [relative,value]of Object.entries(files)){this.fileName(relative);if(!text(value,65536))throw Error('Invalid supporting skill file.');bytes+=Buffer.byteLength(value);}
  if(bytes>262144)throw Error('The skill exceeds its size limit.');if([input.name,input.description,input.instructions,...Object.keys(files),...Object.values(files)].some(value=>this.containsSecret(value)))throw Error('Keep credentials in the credential vault, not in skills.');
  const existing=this.locate(input.name),enabled=input.enabled??existing?.enabled??true,root=enabled?this.enabledRoot:this.disabledRoot;this.ordinary(root,{create:true});
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
 setEnabled(name,enabled){if(typeof enabled!=='boolean')throw Error('Invalid skill enable preference.');const existing=this.get(name);return this.save({...existing,enabled});}
 remove(name){const found=this.locate(name);if(!found)throw Error('Skill not found.');fs.rmSync(this.inside(found.directory),{recursive:true,maxRetries:5,retryDelay:20});return {removed:true,name};}
 context(){return 'Available dant-managed VM skills (reference index; read SKILL.md when relevant):\n'+JSON.stringify(this.list().filter(item=>item.enabled).map(({name,description,path})=>({name,description,path}))).slice(0,16000);}
}
