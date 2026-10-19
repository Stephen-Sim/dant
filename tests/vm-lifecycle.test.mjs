import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {VmLifecycle} from '../src/vm-lifecycle.mjs';

const vmId='312961c7-77b3-4b59-8c39-437c9ca99bd1';
function fixture(t,{provider='hyperv',run}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const base=provider==='vmware'?path.join(dir,'vmware'):dir;fs.mkdirSync(base,{recursive:true});fs.writeFileSync(path.join(base,'vm-key'),'private test fixture');
 const binding={host:'192.0.2.1',user:'dant',port:22,keyPath:path.join(base,'vm-key'),provider};
 if(provider==='hyperv'){
  fs.mkdirSync(path.join(base,'vm'));fs.writeFileSync(path.join(base,'vm','dant.vhdx'),'test disk');fs.writeFileSync(path.join(base,'vm-setup-status.json'),JSON.stringify({name:'dant',stage:'ready'}));
 }else if(provider==='vmware'){
  binding.vmwareId=vmId;fs.writeFileSync(path.join(base,'dant.vmx'),`annotation = "dant-vmware-v1:${vmId}"\n`);fs.writeFileSync(path.join(base,'dant.vmdk'),'test disk');
  fs.writeFileSync(path.join(base,'manifest.json'),JSON.stringify({version:1,owner:'dant-vmware-v1',provider:'vmware',id:vmId,vmx:path.join(base,'dant.vmx'),disk:path.join(base,'dant.vmdk'),phase:'connected'}));
 }
 fs.writeFileSync(path.join(dir,'vm.json'),JSON.stringify(binding));
 const calls=[];const lifecycle=new VmLifecycle({dataDir:dir,platform:'win32',run:async(command,args,options)=>{const action=args[args.indexOf('-Action')+1];calls.push({command,args,options,action});return run?run(action,calls):JSON.stringify({ok:true,provider,vmId,state:action==='suspend'?'suspended':'running',changed:true});}});
 return {dir,base,binding,lifecycle,calls};
}
test('suspends the configured managed VM then resumes only its durable identity on next launch',async t=>{
 const f=fixture(t);assert.deepEqual(await f.lifecycle.resume(),{ok:true,resumed:false});assert.equal(f.calls.length,0);
 assert.deepEqual(await f.lifecycle.suspend(),{ok:true,supported:true,vmSuspended:true,state:'suspended'});
 const receipt=JSON.parse(fs.readFileSync(f.lifecycle.file));assert.equal(receipt.phase,'suspended');assert.equal(receipt.vmId,vmId);assert.doesNotMatch(JSON.stringify(receipt),/private test|192\.0\.2|vm-key/);
 assert.equal(f.calls[0].command,'powershell.exe');assert.equal(f.calls[0].options.shell,false);assert.equal(f.calls[0].options.windowsHide,true);assert.ok(f.calls[0].options.timeout<=85000);
 assert.deepEqual(await f.lifecycle.resume(),{ok:true,resumed:true,state:'running'});assert.equal(fs.existsSync(f.lifecycle.file),false);assert.ok(f.calls[1].args.includes(vmId));
});
test('VMware requires its binding, manifest, VMX annotation and matching paths',async t=>{
 const f=fixture(t,{provider:'vmware'});assert.equal((await f.lifecycle.suspend()).vmSuspended,true);await f.lifecycle.resume();
 fs.writeFileSync(path.join(f.base,'dant.vmx'),'annotation = "another virtual machine"');assert.equal((await f.lifecycle.suspend()).supported,false);assert.equal(f.calls.length,2);
});
test('SSH and missing managed ownership pause elsewhere without guessing a local VM',async t=>{
 const f=fixture(t,{provider:'ssh'});assert.deepEqual(await f.lifecycle.suspend(),{ok:true,supported:false,vmSuspended:false});assert.equal(f.calls.length,0);
 const g=fixture(t);fs.unlinkSync(path.join(g.base,'vm-setup-status.json'));assert.equal((await g.lifecycle.suspend()).supported,false);assert.equal(g.calls.length,0);
});
test('old Hyper-V bindings are identified by their own setup record and disk rather than default VM name',async t=>{
 const f=fixture(t);delete f.binding.provider;fs.writeFileSync(path.join(f.dir,'vm.json'),JSON.stringify(f.binding));assert.equal((await f.lifecycle.suspend()).vmSuspended,true);
});
test('manual saved or powered-off VMs are never automatically started by merely opening dant',async t=>{
 for(const state of ['suspended','off']){
  const f=fixture(t,{run:()=>JSON.stringify({ok:true,provider:'hyperv',vmId,state,changed:false})});await f.lifecycle.suspend();assert.equal(fs.existsSync(f.lifecycle.file),false);await f.lifecycle.resume();assert.equal(f.calls.length,1);
 }
});
test('an uncertain suspend keeps a receipt so reopening reconciles that one VM without resending suspend',async t=>{
 const f=fixture(t,{run:(action)=>{if(action==='suspend')throw Error('private host error');return JSON.stringify({ok:true,provider:'hyperv',vmId,state:'running',changed:true});}});
 await assert.rejects(f.lifecycle.suspend(),/vm_lifecycle_unconfirmed/);assert.equal(JSON.parse(fs.readFileSync(f.lifecycle.file)).phase,'suspending');
 assert.equal((await f.lifecycle.resume()).resumed,true);assert.deepEqual(f.calls.map(value=>value.action),['suspend','resume']);
});
test('changed binding, changed identity, malformed receipt and response do not authorize a power operation',async t=>{
 const f=fixture(t);await f.lifecycle.suspend();f.binding.host='192.0.2.2';fs.writeFileSync(path.join(f.dir,'vm.json'),JSON.stringify(f.binding));await assert.rejects(f.lifecycle.resume(),/binding_changed/);assert.equal(f.calls.length,1);
 const g=fixture(t);fs.writeFileSync(g.lifecycle.file,'{}');await assert.rejects(g.lifecycle.suspend(),/invalid_receipt/);assert.equal(g.calls.length,0);
 const h=fixture(t,{run:()=>JSON.stringify({ok:true,provider:'hyperv',vmId:'invalid',state:'suspended',changed:true})});await assert.rejects(h.lifecycle.suspend(),/unconfirmed/);assert.equal(fs.existsSync(h.lifecycle.file),true);
 const i=fixture(t);await i.lifecycle.suspend();i.lifecycle.run=async()=>JSON.stringify({ok:true,provider:'hyperv',vmId:'11111111-1111-4111-8111-111111111111',state:'running',changed:true});await assert.rejects(i.lifecycle.resume(),/unconfirmed/);
});
test('concurrent lifecycle writes are refused and private subprocess output is never exposed',async t=>{
 let finish;const f=fixture(t,{run:()=>new Promise(resolve=>{finish=resolve;})});const first=f.lifecycle.suspend();await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.lifecycle.suspend(),/busy/);
 finish('private credential/path diagnostics');await assert.rejects(first,error=>error.message==='vm_lifecycle_unconfirmed');
});
test('binding changes while a command is outstanding retain the receipt for explicit recovery',async t=>{
 const f=fixture(t,{run:()=>{fs.writeFileSync(path.join(f.dir,'vm.json'),JSON.stringify({...f.binding,host:'192.0.2.3'}));return JSON.stringify({ok:true,provider:'hyperv',vmId,state:'suspended',changed:true});}});await assert.rejects(f.lifecycle.suspend(),/binding_changed/);assert.equal(fs.existsSync(f.lifecycle.file),true);
});
