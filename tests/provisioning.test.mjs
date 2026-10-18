import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {Provisioning as ProvisioningController} from '../src/provisioning.mjs';

const detected=[{id:'hyperv',label:'Hyper-V',available:true,reason:null},{id:'vmware',label:'VMware Workstation',available:true,reason:null,tools:{vmrun:'C:\\VMware\\vmrun.exe',vdiskmanager:'C:\\VMware\\vmware-vdiskmanager.exe'}}];
// Every test supplies discovery so CI never probes its real host or registry.
class Provisioning extends ProvisioningController{constructor(options){super({detectProviders:()=>structuredClone(detected),...options});}}

const root=path.resolve('.cache','tests');fs.mkdirSync(root,{recursive:true});
function directory(t){const dir=fs.mkdtempSync(path.join(root,'provisioning-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fakeChild(){const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.killed=false;child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('close',null));};return child;}
function writeBinding(dir,provider){fs.writeFileSync(path.join(dir,'vm.json'),'\uFEFF'+JSON.stringify({host:'172.16.0.2',user:'dant',port:22,keyPath:path.join(dir,'vm-key'),...(provider?{provider}:{})}));fs.writeFileSync(path.join(dir,'vm-setup-status.json'),'\uFEFF'+JSON.stringify({stage:'guest-installing',log:path.join(dir,'logs','create-vm.log'),...(provider?{provider}:{})}));}

test('provisioning never starts automatically and rejects invalid options before spawning',t=>{
 const calls=[],p=new Provisioning({dataDir:directory(t),platform:'win32',spawnProcess:(...args)=>calls.push(args)});t.after(()=>p.close());
 assert.equal(p.snapshot().status,'idle');assert.equal(calls.length,0);
 for(const options of [{cpu:'4'},{cpu:0},{memoryGB:1},{diskGB:2049},{adminSudo:'yes'}])assert.throws(()=>p.start(options));
 assert.equal(calls.length,0);assert.equal(p.snapshot().running,false);
});

test('provisioning prepares, requests elevation and verifies readiness using argument arrays',async t=>{
 const dir=directory(t),calls=[],stages=[];
 const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:(command,args,options)=>{
  calls.push({command,args,options});const child=fakeChild();
  queueMicrotask(()=>{const script=path.basename(args[args.indexOf('-File')+1]);if(script==='launch-vm.ps1')writeBinding(dir);if(script==='check-vm.ps1')fs.writeFileSync(path.join(dir,'vm-setup-status.json'),'\uFEFF'+JSON.stringify({stage:'ready'}));child.stdout.emit('data',Buffer.from('Progress\n'));child.emit('close',0);});return child;
 }});t.after(()=>p.close());p.on('change',state=>stages.push(state.status));
 p.start({cpu:8,memoryGB:12,diskGB:80,adminSudo:true});await p.task;
 assert.equal(p.snapshot().status,'ready');assert.equal(p.snapshot().running,false);assert.equal(p.snapshot().connection.host,'172.16.0.2');
 assert.deepEqual(calls.map(c=>path.basename(c.args[c.args.indexOf('-File')+1])),['prepare-vm.ps1','launch-vm.ps1','check-vm.ps1']);
 for(const call of calls){assert.equal(call.command,'powershell.exe');assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.ok(call.args.includes(dir));}
 assert.ok(calls[0].args.includes('-AdminSudo'));assert.equal(calls[1].args[calls[1].args.indexOf('-Cpu')+1],'8');
 assert.ok(stages.includes('preparing'));assert.ok(stages.includes('awaiting-admin'));assert.ok(stages.includes('installing'));
 assert.throws(()=>p.start(),/already configured/);
});

test('concurrent provisioning is rejected and cancelled elevation can be retried',async t=>{
 const dir=directory(t);let cancelled=true;
 const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:(command,args)=>{
  const child=fakeChild();queueMicrotask(()=>{const script=path.basename(args[args.indexOf('-File')+1]);if(script==='launch-vm.ps1'){if(cancelled){child.stderr.emit('data',Buffer.from('DANT_UAC_CANCELLED'));child.emit('close',1223);return;}writeBinding(dir);}if(script==='check-vm.ps1')fs.writeFileSync(path.join(dir,'vm-setup-status.json'),JSON.stringify({stage:'ready'}));child.emit('close',0);});return child;
 }});t.after(()=>p.close());
 p.start();assert.throws(()=>p.start(),/already running/);await p.task;
 assert.equal(p.snapshot().status,'failed');assert.match(p.snapshot().error,/approval was cancelled/);
 cancelled=false;p.start();await p.task;assert.equal(p.snapshot().status,'ready');assert.equal(p.snapshot().error,null);
});

test('close stops only the direct helper and does not start more setup actions',async t=>{
 const calls=[],p=new Provisioning({dataDir:directory(t),platform:'win32',spawnProcess:(...args)=>{const child=fakeChild();calls.push({args,child});return child;}});
 p.start();p.close();await p.task;
 assert.equal(calls.length,1);assert.equal(calls[0].child.killed,true);assert.equal(p.snapshot().running,false);
 assert.throws(()=>p.start(),/closed/);
});

test('non-Windows provisioning fails without creating a subprocess',t=>{
 let called=false;const p=new Provisioning({dataDir:directory(t),platform:'linux',spawnProcess:()=>called=true});t.after(()=>p.close());
 assert.throws(()=>p.start(),/requires Windows/);assert.equal(called,false);
});

test('a new controller preserves an in-progress elevated setup instead of starting a second creation',t=>{
 const dir=directory(t);fs.writeFileSync(path.join(dir,'vm-setup-status.json'),'\uFEFF'+JSON.stringify({stage:'converting-disk'}));
 const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:()=>assert.fail('Must not start a second setup')});t.after(()=>p.close());
 assert.equal(p.snapshot().status,'creating');assert.throws(()=>p.start(),/earlier VM setup/);
});

test('resuming an installing VM runs only readiness checks and never reruns preparation or creation',async t=>{
 const dir=directory(t),calls=[];writeBinding(dir);
 const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:(command,args)=>{
  calls.push(path.basename(args[args.indexOf('-File')+1]));const child=fakeChild();queueMicrotask(()=>child.emit('close',0));return child;
 }});t.after(()=>p.close());
 assert.equal(calls.length,0);assert.equal(p.snapshot().status,'installing');
 p.resumeMonitoring();await p.task;
 assert.deepEqual(calls,['check-vm.ps1']);assert.equal(p.snapshot().status,'ready');assert.equal(p.snapshot().running,false);
});

test('resumed monitoring watches creation until a binding appears, then checks the guest',async t=>{
 const dir=directory(t),calls=[];fs.writeFileSync(path.join(dir,'vm-setup-status.json'),JSON.stringify({stage:'converting-disk'}));
 const p=new Provisioning({dataDir:dir,platform:'win32',probeIntervalMs:1,installTimeoutMs:500,spawnProcess:(command,args)=>{
  calls.push(path.basename(args[args.indexOf('-File')+1]));const child=fakeChild();queueMicrotask(()=>child.emit('close',0));return child;
 }});t.after(()=>p.close());
 p.resumeMonitoring();assert.equal(p.snapshot().running,true);assert.equal(calls.length,0);
 writeBinding(dir);await p.task;
 assert.deepEqual(calls,['check-vm.ps1']);assert.equal(p.snapshot().status,'ready');
});

test('resumed creation monitoring times out without modifying or stopping the existing VM',async t=>{
 const dir=directory(t);fs.writeFileSync(path.join(dir,'vm-setup-status.json'),JSON.stringify({stage:'waiting-for-ip'}));
 const p=new Provisioning({dataDir:dir,platform:'win32',probeIntervalMs:1,installTimeoutMs:5,spawnProcess:()=>assert.fail('No process should be spawned while waiting for VM creation')});t.after(()=>p.close());
 p.resumeMonitoring();await p.task;
 assert.equal(p.snapshot().status,'failed');assert.match(p.snapshot().error,/files have been preserved/);assert.equal(p.snapshot().running,false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'vm-setup-status.json'),'utf8')).stage,'waiting-for-ip');
});

test('provider discovery is explicit, side-effect free and snapshot results cannot mutate selection',t=>{
 let discoveries=0;const p=new Provisioning({dataDir:directory(t),platform:'win32',detectProviders:()=>{discoveries++;return structuredClone(detected);},spawnProcess:()=>assert.fail('Discovery must not create a VM')});t.after(()=>p.close());
 assert.equal(discoveries,0);assert.deepEqual(p.snapshot().availableProviders,[]);
 const providers=p.providers();assert.equal(discoveries,1);assert.equal(providers.selected,'auto');assert.equal(providers.provider,'hyperv');assert.equal(providers.availableProviders.length,2);
 providers.availableProviders[1].tools.vmrun='changed';assert.equal(p.snapshot().availableProviders[1].tools.vmrun,detected[1].tools.vmrun);
 for(const provider of ['other',null,{},1])assert.throws(()=>p.start({provider}),/Invalid VM provider/);
 assert.equal(p.snapshot().running,false);
});

test('VMware preparation and creation run directly without elevation and preserve selected resources',async t=>{
 const dir=directory(t),calls=[],stages=[];
 const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:(command,args,options)=>{
  calls.push({command,args,options});const child=fakeChild();queueMicrotask(()=>{
   const script=path.basename(args[args.indexOf('-File')+1]);if(script==='create-vmware.ps1')writeBinding(dir,'vmware');child.emit('close',0);
  });return child;
 }});t.after(()=>p.close());p.on('change',state=>stages.push(state.status));
 const started=p.start({provider:'vmware',cpu:6,memoryGB:10,diskGB:64,adminSudo:true});assert.equal(started.provider,'vmware');await p.task;
 assert.equal(p.snapshot().status,'ready');assert.equal(p.snapshot().provider,'vmware');assert.equal(p.providers().selected,'vmware');
 assert.deepEqual(calls.map(call=>path.basename(call.args[call.args.indexOf('-File')+1])),['prepare-vmware.ps1','create-vmware.ps1','check-vm.ps1']);
 assert.equal(stages.includes('awaiting-admin'),false);assert.ok(stages.includes('creating'));
 for(const call of calls){assert.equal(call.command,'powershell.exe');assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.equal(call.args.includes('-Verb'),false);}
 for(const call of calls.slice(0,2)){assert.equal(call.args[call.args.indexOf('-VmrunPath')+1],detected[1].tools.vmrun);assert.equal(call.args[call.args.indexOf('-VdiskmanagerPath')+1],detected[1].tools.vdiskmanager);}
 assert.ok(calls[0].args.includes('-AdminSudo'));assert.equal(calls[1].args.includes('-AdminSudo'),false);assert.equal(calls[1].args[calls[1].args.indexOf('-Cpu')+1],'6');assert.equal(calls[1].args[calls[1].args.indexOf('-MemoryGB')+1],'10');assert.equal(calls[1].args[calls[1].args.indexOf('-DiskGB')+1],'64');
 const progress=JSON.parse(fs.readFileSync(path.join(dir,'vm-setup-status.json'),'utf8'));assert.equal(progress.provider,'vmware');assert.equal(progress.selected,'vmware');assert.equal(progress.stage,'ready');assert.equal(progress.log,path.join(dir,'logs','create-vm.log'));
});

test('auto selects VMware when Hyper-V is unavailable and does not require administrator approval',async t=>{
 const dir=directory(t),scripts=[];const p=new Provisioning({dataDir:dir,platform:'win32',detectProviders:()=>detected.map(item=>({...item,available:item.id==='vmware'})),spawnProcess:(_command,args)=>{
  const child=fakeChild(),script=path.basename(args[args.indexOf('-File')+1]);scripts.push(script);queueMicrotask(()=>{if(script==='create-vmware.ps1')writeBinding(dir,'vmware');child.emit('close',0);});return child;
 }});t.after(()=>p.close());p.start();await p.task;
 assert.equal(p.snapshot().status,'ready');assert.equal(p.snapshot().provider,'vmware');assert.equal(p.providers().selected,'auto');assert.deepEqual(scripts,['prepare-vmware.ps1','create-vmware.ps1','check-vm.ps1']);
});

test('an unavailable explicit provider cannot fall back or write setup progress',t=>{
 const dir=directory(t);const p=new Provisioning({dataDir:dir,platform:'win32',detectProviders:()=>detected.map(item=>({...item,available:item.id==='hyperv',reason:item.id==='vmware'?'VMware is not installed':null})),spawnProcess:()=>assert.fail('Must not start Hyper-V as fallback')});t.after(()=>p.close());
 assert.throws(()=>p.start({provider:'vmware'}),/VMware is not installed/);assert.equal(fs.existsSync(path.join(dir,'vm-setup-status.json')),false);assert.equal(p.snapshot().provider,null);
});

test('failed setup preserves its provider across restart and auto retry never switches providers',async t=>{
 const dir=directory(t),scripts=[];const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:(_command,args)=>{
  scripts.push(path.basename(args[args.indexOf('-File')+1]));const child=fakeChild();queueMicrotask(()=>{child.stderr.emit('data','VMware fixture preparation failed');child.emit('close',1);});return child;
 }});t.after(()=>p.close());p.start({provider:'vmware'});await p.task;
 assert.equal(p.snapshot().status,'failed');assert.equal(p.snapshot().provider,'vmware');assert.deepEqual(scripts,['prepare-vmware.ps1']);
 const previous=fs.readFileSync(path.join(dir,'vm-setup-status.json'));
 const restarted=new Provisioning({dataDir:dir,platform:'win32',detectProviders:()=>detected.map(item=>({...item,available:item.id==='hyperv',reason:item.id==='vmware'?'VMware remains unavailable':null})),spawnProcess:()=>assert.fail('Must preserve failed VMware selection')});t.after(()=>restarted.close());
 assert.equal(restarted.snapshot().provider,'vmware');assert.equal(restarted.providers().selected,'vmware');assert.throws(()=>restarted.start(),/VMware remains unavailable/);assert.deepEqual(fs.readFileSync(path.join(dir,'vm-setup-status.json')),previous);
});

test('a configured VM is preserved even when setup failed, with no new preparation or provider switch',t=>{
 for(const provider of ['vmware','hyperv','ssh']){
  const dir=directory(t);writeBinding(dir,provider);fs.writeFileSync(path.join(dir,'vm-setup-status.json'),JSON.stringify({stage:'failed:old-setup',provider:provider==='vmware'?'hyperv':'vmware',error:'old failure'}));
  const original=fs.readFileSync(path.join(dir,'vm.json'));const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:()=>assert.fail('Existing binding must be preserved')});t.after(()=>p.close());
  assert.equal(p.providers().provider,provider);assert.throws(()=>p.start({provider:provider==='vmware'?'hyperv':'vmware'}),/already configured/);assert.deepEqual(fs.readFileSync(path.join(dir,'vm.json')),original);
 }
});

test('legacy setup infers Hyper-V but a generic SSH profile is not mislabeled as a hypervisor',t=>{
 const legacy=directory(t);fs.writeFileSync(path.join(legacy,'vm-setup-status.json'),JSON.stringify({stage:'failed:checking-hyper-v'}));const p=new Provisioning({dataDir:legacy,platform:'win32'});t.after(()=>p.close());assert.equal(p.providers().provider,'hyperv');
 const generic=directory(t);fs.writeFileSync(path.join(generic,'vm.json'),JSON.stringify({host:'192.0.2.20',user:'dant'}));const ssh=new Provisioning({dataDir:generic,platform:'win32'});t.after(()=>ssh.close());assert.equal(ssh.providers().provider,null);assert.equal(ssh.snapshot().provider,null);assert.throws(()=>ssh.start(),/already configured/);
});

test('existing Hyper-V and VMware disks are not overwritten or reused for another provider',t=>{
 for(const relative of ['vm/dant.vhdx','vmware/dant.vmx','vmware/dant.vmdk']){
  const dir=directory(t),file=path.join(dir,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'existing disk sentinel');const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:()=>assert.fail('Existing disks must not be touched')});t.after(()=>p.close());
  assert.throws(()=>p.start({provider:'vmware'}),/Existing VM disk files have been preserved/);assert.equal(fs.readFileSync(file,'utf8'),'existing disk sentinel');assert.equal(fs.existsSync(path.join(dir,'vm-setup-status.json')),false);
 }
});

test('VMware restart monitoring only checks the existing guest and retains provider metadata',async t=>{
 const dir=directory(t),scripts=[];writeBinding(dir,'vmware');const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:(_command,args)=>{
  const script=path.basename(args[args.indexOf('-File')+1]);scripts.push(script);const child=fakeChild();queueMicrotask(()=>child.emit('close',0));return child;
 }});t.after(()=>p.close());p.resumeMonitoring();await p.task;
 assert.equal(p.snapshot().provider,'vmware');assert.equal(p.snapshot().status,'ready');assert.deepEqual(scripts,['check-vm.ps1']);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'vm-setup-status.json'),'utf8')).provider,'vmware');
});

test('VMware process startup errors stay on VMware and are reported without starting another provider',async t=>{
 for(const synchronous of [true,false]){
  const p=new Provisioning({dataDir:directory(t),platform:'win32',spawnProcess:()=>{
   if(synchronous)throw Error('VMware helper could not start');const child=fakeChild();queueMicrotask(()=>child.emit('error',Error('VMware helper could not start')));return child;
  }});t.after(()=>p.close());p.start({provider:'vmware'});await p.task;
  assert.equal(p.snapshot().status,'failed');assert.equal(p.snapshot().provider,'vmware');assert.match(p.snapshot().error,/helper could not start/);
 }
});

test('guest readiness failures retry only checks and closing aborts the pending retry',async t=>{
 const dir=directory(t),scripts=[];writeBinding(dir,'vmware');let checks=0;
 // This checks retry/abort behavior, not a wall-clock deadline. Concurrent
 // coverage and filesystem work must not exhaust its synthetic setup budget.
 const p=new Provisioning({dataDir:dir,platform:'win32',probeIntervalMs:1,installTimeoutMs:10000,spawnProcess:(_command,args)=>{
  scripts.push(path.basename(args[args.indexOf('-File')+1]));const child=fakeChild();queueMicrotask(()=>child.emit('close',++checks===1?1:0));return child;
 }});t.after(()=>p.close());p.resumeMonitoring();await p.task;assert.deepEqual(scripts,['check-vm.ps1','check-vm.ps1']);assert.equal(p.snapshot().status,'ready');
 const waitingDir=directory(t);writeBinding(waitingDir,'vmware');const waiting=new Provisioning({dataDir:waitingDir,platform:'win32',probeIntervalMs:1000,spawnProcess:()=>{const child=fakeChild();queueMicrotask(()=>child.emit('close',1));return child;}});t.after(()=>waiting.close());
 waiting.resumeMonitoring();await new Promise(resolve=>setImmediate(resolve));waiting.close();await waiting.task;assert.equal(waiting.snapshot().running,false);assert.equal(waiting.snapshot().provider,'vmware');assert.equal(JSON.parse(fs.readFileSync(path.join(waitingDir,'vm-setup-status.json'),'utf8').replace(/^\uFEFF/,'')).stage,'guest-installing');
});

test('a raw VMware failed stage survives cold start without being mistaken for active creation',t=>{
 const dir=directory(t);fs.writeFileSync(path.join(dir,'vm-setup-status.json'),JSON.stringify({provider:'vmware',stage:'failed',error:'VMware preparation failed in fixture'}));
 const p=new Provisioning({dataDir:dir,platform:'win32',spawnProcess:()=>assert.fail('A failed setup must not restart automatically')});t.after(()=>p.close());
 assert.equal(p.snapshot().status,'failed');assert.equal(p.snapshot().stage,'failed');assert.equal(p.snapshot().provider,'vmware');assert.match(p.snapshot().error,/preparation failed/);assert.equal(p.resumeMonitoring().running,false);
 fs.writeFileSync(path.join(dir,'vm-setup-status.json'),JSON.stringify({provider:'vmware',stage:'checking-vmware'}));assert.equal(p.snapshot().status,'failed');
 fs.writeFileSync(path.join(dir,'vm-setup-status.json'),JSON.stringify({provider:'vmware',stage:'ready'}));assert.equal(p.snapshot().status,'ready');assert.equal(p.snapshot().error,null);
});
