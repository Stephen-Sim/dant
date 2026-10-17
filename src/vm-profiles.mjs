import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';

const LIMIT=64*1024;
const configurationError=(message,code='DANT_VM_CONFIG_INVALID')=>Object.assign(Error(message),{code,status:409});
function jsonFile(file){
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMIT)throw Error('Configuration must be a regular JSON file smaller than 64 KiB.');
 return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
const canonical=directory=>{try{return fs.realpathSync(directory);}catch{return path.resolve(directory);}};
const identity=()=>{const user=os.userInfo();return createHash('sha256').update(JSON.stringify({name:user.username,home:user.homedir,uid:user.uid})).digest('hex');};
function absoluteFile(value,directory){
 if(typeof value!=='string'||!value.trim()||value.includes('\0'))throw configurationError('The VM SSH key path is missing. Choose its original data directory or an existing private key.');
 return path.resolve(directory,value);
}

export function normalizeVmBinding(value,directory){
 if(!value||typeof value!=='object'||Array.isArray(value))throw configurationError('The VM connection file is invalid. Import the original data directory or enter its connection details.');
 const host=value.host,user=value.user,port=value.port===undefined?22:Number(value.port);
 if(typeof host!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host)||typeof user!=='string'||!/^[a-z_][a-z0-9_-]*$/i.test(user)||!Number.isInteger(port)||port<1||port>65535)throw configurationError('The VM host, user or SSH port is invalid. Check the connection details.');
 const keyPath=absoluteFile(value.keyPath,directory),knownHosts=absoluteFile(value.knownHosts||'known_hosts',directory);
 let key;try{key=fs.statSync(keyPath);fs.accessSync(keyPath,fs.constants.R_OK);}catch{throw configurationError('The VM SSH private key is missing or unreadable. Import the original data directory or choose its existing key.','DANT_VM_KEY_MISSING');}
 if(!key.isFile()||!key.size||key.size>1024*1024)throw configurationError('The VM SSH key must be an existing private-key file.');
 try{const info=fs.statSync(knownHosts,{throwIfNoEntry:false});if(info&&!info.isFile())throw Error();if(!info&&!fs.statSync(path.dirname(knownHosts)).isDirectory())throw Error();}catch{throw configurationError('The SSH known-hosts directory is missing or invalid. Restore the original connection directory.');}
 return {host,user,port,keyPath:fs.realpathSync(keyPath),knownHosts:fs.existsSync(knownHosts)?fs.realpathSync(knownHosts):knownHosts};
}

export function readVmBinding(directory){
 const file=path.join(path.resolve(directory),'vm.json');let value;
 try{value=jsonFile(file);}catch(error){if(error.code==='ENOENT')throw configurationError('No VM connection is configured. Import an existing dant data directory or enter its connection details.','DANT_VM_CONFIG_MISSING');if(error.code?.startsWith('DANT_'))throw error;throw configurationError('The VM connection file cannot be read. Import the original data directory or check its JSON configuration.');}
 return normalizeVmBinding(value,path.resolve(directory));
}

export function defaultVmRegistryFile(env=process.env){
 const directory=process.platform==='win32'?(env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')):path.join(os.homedir(),'.local','share');
 return path.join(directory,'dant','vm-profiles.json');
}

/** Only fixed local sources and this user's explicitly registered profiles. */
export class VmProfiles{
 constructor({dataDir,projectRoot=process.cwd(),env=process.env,registryFile=defaultVmRegistryFile(env),candidateDirs=[],includeProject=true,owner=identity()}={}){
  this.dataDir=path.resolve(dataDir);this.projectRoot=path.resolve(projectRoot);this.registryFile=registryFile;this.owner=owner;this.registryError=null;
  const explicit=[...candidateDirs];if(env.DANT_VM_PROFILE_DIR)explicit.push(env.DANT_VM_PROFILE_DIR);
  if(env.DANT_VM_PROFILE_DIRS)try{const values=JSON.parse(env.DANT_VM_PROFILE_DIRS);if(Array.isArray(values))explicit.push(...values);}catch{}
  this.sources=explicit.filter(value=>typeof value==='string'&&path.isAbsolute(value)&&!value.includes('\0')).slice(0,64).map(directory=>({directory,source:'selected'}));
  if(includeProject)this.sources.push({directory:path.join(this.projectRoot,'data'),source:'workspace'});
 }
 registry(){
  if(!this.registryFile)return {version:1,owner:this.owner,profiles:[]};
  try{const data=jsonFile(this.registryFile);if(data.version!==1||data.owner!==this.owner||!Array.isArray(data.profiles))throw Error('This profile registry belongs to another account or is invalid; it was ignored.');return {...data,profiles:data.profiles.filter(item=>item&&typeof item.directory==='string'&&path.isAbsolute(item.directory)).slice(0,64)};}
  catch(error){if(error.code!=='ENOENT')this.registryError='The current user profile registry could not be read and was ignored.';return {version:1,owner:this.owner,profiles:[]};}
 }
 descriptor(directory,source){
  const vm=readVmBinding(directory),resolved=canonical(directory),key=JSON.stringify([vm.host.toLowerCase(),vm.user,vm.port,vm.keyPath]);
  return {id:createHash('sha256').update(key).digest('hex').slice(0,24),label:path.basename(resolved)||resolved,directory:resolved,host:vm.host,user:vm.user,port:vm.port,source,vm};
 }
 public(profile){if(!profile)return null;const {vm,...result}=profile;return result;}
 discover(){
  let current=null,error=null;try{current=this.descriptor(this.dataDir,'current');}catch(failure){error=failure.message;}
  const registry=this.registry(),sources=[...this.sources,...registry.profiles.filter(item=>typeof item.directory==='string'&&path.isAbsolute(item.directory)).map(item=>({directory:item.directory,source:'registry'}))];
  const candidates=[],seenDirectories=new Set([canonical(this.dataDir)]),seenBindings=new Set(current?[current.id]:[]);
  for(const entry of sources){const directory=canonical(entry.directory);if(seenDirectories.has(directory))continue;seenDirectories.add(directory);try{const profile=this.descriptor(directory,entry.source);if(seenBindings.has(profile.id))continue;seenBindings.add(profile.id);candidates.push(profile);}catch{/* An absent or stale known profile is not a usable candidate. */}}
  return {current:this.public(current),candidates:candidates.map(profile=>this.public(profile)),requiresSelection:!current&&candidates.length>1,error:current?null:candidates.length>1?'Several existing VM connections were found. Choose the one to import.':error,registryError:this.registryError};
 }
 registerCurrent(){
  const current=this.descriptor(this.dataDir,'current');if(!this.registryFile)return this.public(current);
  const registry=this.registry();if(this.registryError)return this.public(current);
  registry.profiles=registry.profiles.filter(item=>canonical(item.directory)!==current.directory);registry.profiles.unshift({directory:current.directory,registeredAt:Date.now()});registry.profiles=registry.profiles.slice(0,64);
  const directory=path.dirname(this.registryFile);fs.mkdirSync(directory,{recursive:true,mode:0o700});const temporary=path.join(directory,`.vm-profiles-${randomUUID()}.tmp`);
  try{fs.writeFileSync(temporary,JSON.stringify(registry,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,this.registryFile);}finally{fs.rmSync(temporary,{force:true});}
  return this.public(current);
 }
 import({id,directory}={}){
  if((id!==undefined)===(directory!==undefined))throw configurationError('Choose one existing profile or enter its absolute data-directory path.');
  let current;try{current=this.descriptor(this.dataDir,'current');}catch{}
  if(id!==undefined&&current?.id===id)return {ok:true,profile:this.public(current),connected:false};
  let selected;
  if(directory!==undefined){if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0')||directory.length>4096)throw configurationError('Enter an absolute path to the original dant data directory.');selected=this.descriptor(directory,'selected');}
  else{if(typeof id!=='string')throw configurationError('Choose an existing VM profile.');const candidate=this.discover().candidates.find(profile=>profile.id===id);if(!candidate)throw configurationError('The selected VM profile is no longer available. Refresh the profiles and choose again.');selected=this.descriptor(candidate.directory,candidate.source);}
  if(current){if(current.id===selected.id)return {ok:true,profile:this.public(current),connected:false};throw configurationError('A valid VM connection already exists. It was preserved; edit its connection settings explicitly to change computers.');}
  fs.mkdirSync(this.dataDir,{recursive:true});const target=path.join(this.dataDir,'vm.json'),temporary=path.join(this.dataDir,`.vm-import-${randomUUID()}.tmp`);
  const previous=fs.lstatSync(target,{throwIfNoEntry:false});if(previous){if(!previous.isFile()||previous.isSymbolicLink())throw configurationError('The existing VM configuration is not an ordinary file. It was preserved; inspect it before importing.');fs.copyFileSync(target,path.join(this.dataDir,`vm.json.invalid-${Date.now()}-${randomUUID()}.bak`),fs.constants.COPYFILE_EXCL);}
  try{fs.writeFileSync(temporary,JSON.stringify(selected.vm,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,target);}finally{fs.rmSync(temporary,{force:true});}
  try{this.registerCurrent();}catch{this.registryError='The VM connection was imported, but its profile could not be registered for other installations.';}
  return {ok:true,profile:this.public(selected),connected:false};
 }
 autoImport(){const discovery=this.discover();if(discovery.current){try{this.registerCurrent();}catch{this.registryError='The current VM profile could not be registered for other installations.';}return this.discover();}if(discovery.candidates.length===1)this.import({id:discovery.candidates[0].id});return this.discover();}
}
