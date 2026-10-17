import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {Provisioning} from '../src/provisioning.mjs';

const root=path.resolve('.cache','tests');fs.mkdirSync(root,{recursive:true});
function directory(t){const dir=fs.mkdtempSync(path.join(root,'provisioning-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function fakeChild(){const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.killed=false;child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('close',null));};return child;}
function writeBinding(dir){fs.writeFileSync(path.join(dir,'vm.json'),'\uFEFF'+JSON.stringify({host:'172.16.0.2',user:'dant',port:22,keyPath:path.join(dir,'vm-key')}));fs.writeFileSync(path.join(dir,'vm-setup-status.json'),'\uFEFF'+JSON.stringify({stage:'guest-installing',log:path.join(dir,'logs','create-vm.log')}));}

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
