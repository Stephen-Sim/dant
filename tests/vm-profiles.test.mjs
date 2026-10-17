import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {VmProfiles,readVmBinding} from '../src/vm-profiles.mjs';

const root=path.resolve('.cache/tests');fs.mkdirSync(root,{recursive:true});
function setup(t){const directory=fs.mkdtempSync(path.join(root,'profiles-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const target=path.join(directory,'installed'),workspace=path.join(directory,'workspace');fs.mkdirSync(target);fs.mkdirSync(workspace);return {directory,target,workspace,registryFile:path.join(directory,'user-registry.json')};}
function profile(directory,{host='192.0.2.10',keyPath='vm-key',...extra}={}){fs.mkdirSync(directory,{recursive:true});if(!path.isAbsolute(keyPath))fs.writeFileSync(path.join(directory,keyPath),'private test fixture - never read by discovery');fs.writeFileSync(path.join(directory,'known_hosts'),'trusted test host');fs.writeFileSync(path.join(directory,'vm.json'),'\uFEFF'+JSON.stringify({host,user:'dant',port:22,keyPath,knownHosts:'known_hosts',...extra}));return directory;}
const manager=(data,overrides={})=>new VmProfiles({dataDir:data.target,projectRoot:data.workspace,registryFile:data.registryFile,env:{},owner:'current-test-user',...overrides});

test('one known workspace binding is imported by reference without copying keys, state or failed setup files',t=>{
 const data=setup(t),source=profile(path.join(data.workspace,'data'));fs.writeFileSync(path.join(source,'state.json'),'private historical state');fs.writeFileSync(path.join(data.target,'vm-key'),'new unrelated key');fs.writeFileSync(path.join(data.target,'vm-setup-status.json'),'failed setup metadata');
 const profiles=manager(data),result=profiles.autoImport(),binding=readVmBinding(data.target);assert.equal(result.current.host,'192.0.2.10');assert.equal(binding.keyPath,fs.realpathSync(path.join(source,'vm-key')));assert.equal(binding.knownHosts,fs.realpathSync(path.join(source,'known_hosts')));
 assert.equal(fs.readFileSync(path.join(data.target,'vm-key'),'utf8'),'new unrelated key');assert.equal(fs.readFileSync(path.join(data.target,'vm-setup-status.json'),'utf8'),'failed setup metadata');assert.equal(fs.existsSync(path.join(data.target,'state.json')),false);assert.equal(fs.readFileSync(data.registryFile,'utf8').includes('private test fixture'),false);
});

test('multiple different known bindings require explicit selection and do not create a binding',t=>{
 const data=setup(t),first=profile(path.join(data.directory,'one')),second=profile(path.join(data.directory,'two'),{host:'192.0.2.11'}),profiles=manager(data,{includeProject:false,candidateDirs:[first,second]});
 const state=profiles.autoImport();assert.equal(state.current,null);assert.equal(state.requiresSelection,true);assert.equal(state.candidates.length,2);assert.equal(fs.existsSync(path.join(data.target,'vm.json')),false);
 const selected=state.candidates.find(item=>item.host==='192.0.2.11'),result=profiles.import({id:selected.id});assert.equal(result.connected,false);assert.equal(readVmBinding(data.target).host,'192.0.2.11');assert.equal(Object.hasOwn(selected,'keyPath'),false);
});

test('duplicate bindings for the same endpoint, user and canonical key are one candidate',t=>{
 const data=setup(t),first=profile(path.join(data.directory,'one')),second=profile(path.join(data.directory,'two'),{keyPath:path.join(first,'vm-key')}),profiles=manager(data,{includeProject:false,env:{DANT_VM_PROFILE_DIR:first,DANT_VM_PROFILE_DIRS:JSON.stringify([second])}});
 assert.equal(profiles.discover().candidates.length,1);assert.equal(profiles.autoImport().current.host,'192.0.2.10');
});

test('an existing valid current connection is never replaced by discovery or import',t=>{
 const data=setup(t);profile(data.target,{host:'192.0.2.30'});const other=profile(path.join(data.workspace,'data')),before=fs.readFileSync(path.join(data.target,'vm.json')),profiles=manager(data);
 assert.equal(profiles.autoImport().current.host,'192.0.2.30');assert.throws(()=>profiles.import({directory:other}),/valid VM connection already exists/);assert.deepEqual(fs.readFileSync(path.join(data.target,'vm.json')),before);
 assert.equal(profiles.import({id:profiles.discover().current.id}).ok,true);
});

test('only this account registry records can supply an otherwise unknown existing profile',t=>{
 const data=setup(t),source=profile(path.join(data.directory,'previous-installation'));manager(data,{dataDir:source,includeProject:false}).registerCurrent();
 const next=manager(data,{includeProject:false});assert.equal(next.discover().candidates[0].source,'registry');assert.equal(next.autoImport().current.host,'192.0.2.10');
 const different=path.join(data.directory,'different-account-target');fs.mkdirSync(different);const foreign=manager(data,{dataDir:different,includeProject:false,owner:'different-account'});assert.equal(foreign.discover().candidates.length,0);assert.equal(foreign.autoImport().current,null);assert.equal(fs.existsSync(path.join(different,'vm.json')),false);
});

test('stale candidates are ignored, missing current binding has a friendly diagnostic, explicit import is bounded',t=>{
 const data=setup(t),source=profile(path.join(data.directory,'old'));fs.unlinkSync(path.join(source,'vm-key'));const profiles=manager(data,{includeProject:false,candidateDirs:[source,path.join(data.directory,'absent')]});
 assert.deepEqual(profiles.discover().candidates,[]);assert.throws(()=>readVmBinding(data.target),error=>error.code==='DANT_VM_CONFIG_MISSING'&&!error.message.includes('ENOENT'));assert.throws(()=>profiles.import({directory:'relative/path'}),/absolute path/);assert.throws(()=>profiles.import({directory:source}),/private key is missing/);
});

test('explicit import backs up an invalid binding and imports no non-connection fields',t=>{
 const data=setup(t),source=profile(path.join(data.directory,'manually-selected'),{account:'not copied',memory:'not copied'});fs.writeFileSync(path.join(data.target,'vm.json'),'{broken');const profiles=manager(data,{includeProject:false});profiles.import({directory:source});
 const binding=JSON.parse(fs.readFileSync(path.join(data.target,'vm.json'),'utf8'));assert.deepEqual(Object.keys(binding).sort(),['host','keyPath','knownHosts','port','user']);const backup=fs.readdirSync(data.target).find(name=>name.startsWith('vm.json.invalid-'));assert.equal(fs.readFileSync(path.join(data.target,backup),'utf8'),'{broken');
});
