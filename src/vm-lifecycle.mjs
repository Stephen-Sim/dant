import {VmPowerState, VmReceiptPhase} from './contracts/states.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const failure=reason=>Object.assign(Error(`vm_lifecycle_${reason}`),{code:`vm_lifecycle_${reason}`,status:409});
const hash=value=>createHash('sha256').update(value).digest('hex');
function readFile(file,limit=65536){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit)throw failure('invalid_identity');return fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');}
function jsonFile(file){return JSON.parse(readFile(file));}
function writeFile(file,value){const temporary=path.join(path.dirname(file),`.vm-lifecycle-${randomUUID()}.tmp`);try{fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}}
const execute=(command,args,options)=>new Promise((resolve,reject)=>execFile(command,args,options,(error,stdout)=>error?reject(error):resolve(stdout)));

/** Owns only the configured, locally managed VM. Never searches by a guessed VM name. */
export class VmLifecycle{
 constructor({dataDir,projectRoot=root,platform=process.platform,run=execute,timeoutMs=85000}={}){this.dataDir=path.resolve(dataDir);this.projectRoot=projectRoot;this.platform=platform;this.run=run;this.timeoutMs=timeoutMs;this.file=path.join(this.dataDir,'vm-lifecycle.json');this.pending=null;}
 binding(){try{const raw=readFile(path.join(this.dataDir,'vm.json')),value=JSON.parse(raw);return {value,digest:hash(raw)};}catch(error){if(error.code==='ENOENT')return null;throw failure('invalid_identity');}}
 managed(binding){
  if(!binding)return false;const vm=binding.value;if(!vm||typeof vm.keyPath!=='string'||!path.isAbsolute(vm.keyPath)||path.basename(vm.keyPath)!=='vm-key')return false;
  if(vm.provider==='ssh'||vm.provider&&!['hyperv','vmware'].includes(vm.provider))return false;
  try{
   const base=path.dirname(vm.keyPath);
   if(vm.provider==='vmware'){
    const manifest=jsonFile(path.join(base,'manifest.json')),vmx=path.join(base,'dant.vmx');
    if(manifest.owner!=='dant-vmware-v1'||manifest.provider!=='vmware'||manifest.version!==1||manifest.id!==vm.vmwareId||typeof manifest.id!=='string'||!/^[0-9a-f-]{36}$/i.test(manifest.id)||path.resolve(manifest.vmx)!==vmx||path.resolve(manifest.disk)!==path.join(base,'dant.vmdk')||!['created','starting','started','connected'].includes(manifest.phase))return false;
    const text=readFile(vmx,1024*1024);return new RegExp(`^annotation\\s*=\\s*"dant-vmware-v1:${manifest.id}"\\s*$`,'m').test(text)?'vmware':false;
   }
   const status=jsonFile(path.join(base,'vm-setup-status.json'));
   if(!['ready','guest-installing'].includes(status.stage)||typeof status.name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(status.name)||vm.name&&vm.name!==status.name)return false;
   const disk=fs.lstatSync(path.join(base,'vm','dant.vhdx'));return disk.isFile()&&!disk.isSymbolicLink()?'hyperv':false;
  }catch{return false;}
 }
 receipt(){try{const value=jsonFile(this.file);if(value.version!==1||![VmReceiptPhase.Suspending,VmReceiptPhase.Suspended].includes(value.phase)||!['hyperv','vmware'].includes(value.provider)||!/^[a-f0-9]{64}$/.test(value.binding)||value.vmId!==null&&(typeof value.vmId!=='string'||!/^[a-f0-9-]{36}$/i.test(value.vmId)))throw Error();return value;}catch(error){if(error.code==='ENOENT')return null;throw failure('invalid_receipt');}}
 async command(action,binding,receipt){
  const args=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(this.projectRoot,'scripts','vm-lifecycle.ps1'),'-Action',action,'-DataDirectory',this.dataDir,'-ExpectedBinding',binding.digest];
  if(receipt.vmId)args.push('-ExpectedVmId',receipt.vmId);
  let value;try{const output=await this.run('powershell.exe',args,{windowsHide:true,shell:false,timeout:this.timeoutMs,maxBuffer:32768,encoding:'utf8'});value=JSON.parse(String(output).replace(/^\uFEFF/,''));}catch{throw failure('unconfirmed');}
  if(value?.ok!==true||value.provider!==receipt.provider||typeof value.vmId!=='string'||!/^[a-f0-9-]{36}$/i.test(value.vmId)||receipt.vmId&&receipt.vmId.toLowerCase()!==value.vmId.toLowerCase()||![VmPowerState.Running,VmPowerState.Suspended,VmPowerState.Off].includes(value.state)||typeof value.changed!=='boolean')throw failure('unconfirmed');
  if(this.binding()?.digest!==binding.digest)throw failure('binding_changed');return value;
 }
 exclusive(operation){if(this.pending)return Promise.reject(failure('busy'));this.pending=Promise.resolve().then(operation).finally(()=>{this.pending=null;});return this.pending;}
 suspend(){return this.exclusive(async()=>{
  const binding=this.binding(),provider=this.managed(binding);
  if(!provider||this.platform!=='win32')return {ok:true,supported:false,vmSuspended:false};
  const previous=this.receipt();if(previous&&previous.binding!==binding.digest)throw failure('binding_changed');
  const receipt=previous||{version:1,phase:VmReceiptPhase.Suspending,provider,binding:binding.digest,vmId:null};
  fs.mkdirSync(this.dataDir,{recursive:true});writeFile(this.file,receipt);
  const result=await this.command('suspend',binding,receipt);
  if(![VmPowerState.Suspended,VmPowerState.Off].includes(result.state))throw failure('unconfirmed');
  if(result.changed||previous)writeFile(this.file,{...receipt,phase:VmReceiptPhase.Suspended,vmId:result.vmId});else fs.rmSync(this.file,{force:true});
  return {ok:true,supported:true,vmSuspended:true,state:result.state};
 });}
 resume(){return this.exclusive(async()=>{
  const receipt=this.receipt();if(!receipt)return {ok:true,resumed:false};
  const binding=this.binding();if(!binding||receipt.binding!==binding.digest||this.managed(binding)!==receipt.provider||this.platform!=='win32')throw failure('binding_changed');
  const result=await this.command('resume',binding,receipt);
  if(result.state!==VmPowerState.Running&&result.state!==VmPowerState.Off)throw failure('unconfirmed');
  fs.rmSync(this.file,{force:true});return {ok:true,resumed:result.changed,state:result.state};
 });}
}
