import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {SkillLibrary} from '../src/skill-library.mjs';
import {SKILL_SUPPORT_FILE_LIMIT} from '../src/skill-limits.mjs';
const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const sample={name:'inspect-desktop',description:'Observe the VM desktop when verifying browser work.',instructions:'Use the shared desktop bridge. Read scripts/inspect.py before use.',files:{'scripts/inspect.py':'print("checked")\n','references/workflow.md':'Observe before acting.'}};
function setup(t,options={}){const workspace=fs.mkdtempSync(path.join(base,'skills-'));t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));return {workspace,skills:new SkillLibrary({workspace,...options})};}

test('import saves preserve root license documents and refuse overwriting an existing skill',t=>{
 const {skills}=setup(t),input={...sample,files:{...sample.files,'LICENSE.txt':'Original license terms','NOTICE':'Original author notice','README.md':'How to use'}};
 skills.save(input,{overwrite:false});assert.equal(skills.get(input.name).files['LICENSE.txt'],'Original license terms');
 assert.throws(()=>skills.save({...input,instructions:'replacement'},{overwrite:false}),error=>error.code==='EEXIST');assert.equal(skills.get(input.name).instructions,input.instructions);
 for(const name of ['LICENSE/escape.txt','LICENSE.txt/escape','README.md/escape','root.py','NOTICE/../root.py'])assert.throws(()=>skills.fileName(name));
});
test('skills save valid SKILL.md, retain helpers across restarts, disable discovery, edit and remove',t=>{
 const {workspace,skills}=setup(t);assert.deepEqual(skills.list(),[]);const item=skills.save(sample);assert.equal(item.enabled,true);assert.match(fs.readFileSync(item.path,'utf8'),/^---\nname: "inspect-desktop"\ndescription:/);assert.deepEqual(item.files,sample.files);assert.equal(item.instructions,sample.instructions);assert.match(skills.context(),/inspect-desktop/);
 const reopened=new SkillLibrary({workspace});assert.equal(reopened.list().length,1);const disabled=reopened.setEnabled(sample.name,false);assert.equal(disabled.enabled,false);assert.equal(fs.existsSync(item.path),false);assert.doesNotMatch(reopened.context(),/inspect-desktop/);assert.equal(reopened.get(sample.name).files['scripts/inspect.py'],sample.files['scripts/inspect.py']);assert.equal(reopened.setEnabled(sample.name,true).enabled,true);
 reopened.save({...sample,description:'Updated use',files:{}});assert.deepEqual(reopened.get(sample.name).files,{});assert.equal(fs.existsSync(path.join(path.dirname(item.path),'scripts/inspect.py')),false);assert.equal(reopened.remove(sample.name).removed,true);assert.deepEqual(reopened.list(),[]);assert.throws(()=>reopened.get(sample.name));assert.throws(()=>reopened.remove(sample.name));
});

test('reads, metadata-only edits and toggles retain actual nested source and dependencies absent from the marker',t=>{
 const {workspace,skills}=setup(t),saved=skills.save(sample),directory=path.dirname(saved.path),added={'scripts/package/package.json':'{"dependencies":{"example":"1.2.3"}}\n','scripts/package/package-lock.json':'{"lockfileVersion":3}\n','scripts/package/src/helper.mjs':'export const answer=42;\n','scripts/package/helper.test.mjs':'// Existing test source; never executed by management.\n','assets/parameters.json':'{"delay":40}\n','LICENSE.txt':'Original license terms\n','NOTICE':'Original attribution\n'};
 for(const [relative,value]of Object.entries(added)){const file=path.join(directory,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
 const marker=fs.readFileSync(path.join(directory,'.dant-managed.json')),instructions=fs.readFileSync(saved.path,'utf8').replace('\n---\n\n','\nlicense: MIT\n---\n\n');fs.writeFileSync(saved.path,instructions);
 const cache=path.join(directory,'scripts','__pycache__');fs.mkdirSync(cache);fs.writeFileSync(path.join(cache,'helper.pyc'),Buffer.from([0,255,127]));
 const expected={...sample.files,...added},reopened=new SkillLibrary({workspace});assert.deepEqual(reopened.get(sample.name).files,expected);
 const disabled=reopened.setEnabled(sample.name,false),disabledDirectory=path.dirname(disabled.path);assert.equal(disabled.enabled,false);assert.deepEqual(disabled.files,expected);assert.equal(fs.readFileSync(disabled.path,'utf8'),instructions);assert.deepEqual(fs.readFileSync(path.join(disabledDirectory,'.dant-managed.json')),marker);assert.deepEqual(fs.readFileSync(path.join(disabledDirectory,'scripts','__pycache__','helper.pyc')),Buffer.from([0,255,127]));
 const enabled=reopened.setEnabled(sample.name,true);assert.deepEqual(enabled.files,expected);assert.equal(enabled.path,saved.path);assert.equal(fs.readFileSync(enabled.path,'utf8'),instructions);assert.deepEqual(reopened.setEnabled(sample.name,true),enabled);
 const edited=reopened.save({name:sample.name,description:'Updated description',instructions:'Read scripts/package/src/helper.mjs before use.'});assert.deepEqual(edited.files,expected);assert.deepEqual(new SkillLibrary({workspace}).get(sample.name).files,expected);
 const meta=JSON.parse(fs.readFileSync(path.join(path.dirname(edited.path),'.dant-managed.json'),'utf8'));assert.deepEqual(meta.files.sort(),Object.keys(expected).sort());
 const replaced=reopened.save({name:sample.name,description:'An intentional replacement',instructions:'Use the replacement helper.',files:{'scripts/replacement.py':'print("new helper")\n'}});assert.deepEqual(replaced.files,{'scripts/replacement.py':'print("new helper")\n'});assert.equal(fs.existsSync(path.join(directory,'scripts/package/src/helper.mjs')),false);
});

test('unsafe or unsupported unlisted content fails metadata edits and toggles without deleting current files',t=>{
 const {skills}=setup(t),saved=skills.save(sample),directory=path.dirname(saved.path),unlisted=path.join(directory,'assets','unlisted.bin');fs.mkdirSync(path.dirname(unlisted));const bytes=Buffer.from([0,255,127]);fs.writeFileSync(unlisted,bytes);const before=fs.readFileSync(saved.path),marker=fs.readFileSync(path.join(directory,'.dant-managed.json'));
 assert.throws(()=>skills.get(sample.name));assert.throws(()=>skills.setEnabled(sample.name,false));assert.throws(()=>skills.save({name:sample.name,description:'New description',instructions:'Updated instructions'}));assert.deepEqual(fs.readFileSync(unlisted),bytes);assert.deepEqual(fs.readFileSync(saved.path),before);assert.deepEqual(fs.readFileSync(path.join(directory,'.dant-managed.json')),marker);assert.equal(fs.existsSync(path.join(skills.disabledRoot,sample.name)),false);
});

test('installed nested npm dependencies do not prevent reading or editing a skill, and toggles retain their original bytes',t=>{
 const {skills}=setup(t),input={name:'npm-project',description:'Portable npm project.',instructions:'Run npm ci in scripts/project before use.',files:{'scripts/project/run.mjs':'import "example";\n','scripts/project/package.json':'{"dependencies":{"example":"1.0.0"}}\n','scripts/project/package-lock.json':'{"lockfileVersion":3}\n'}},saved=skills.save(input),directory=path.dirname(saved.path),binary=Buffer.from([0,255,127,128]),relative='scripts/project/node_modules/@scope/example/build/native.node';
 const installed=path.join(directory,relative);fs.mkdirSync(path.dirname(installed),{recursive:true});fs.writeFileSync(installed,binary);const cache=path.join(directory,'scripts/project/node_modules/another/node_modules/deep');fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(path.join(cache,'large-resource.bin'),Buffer.alloc(300000));
 assert.deepEqual(skills.get(input.name).files,input.files);const disabled=skills.setEnabled(input.name,false);assert.deepEqual(disabled.files,input.files);assert.deepEqual(fs.readFileSync(path.join(path.dirname(disabled.path),relative)),binary);const enabled=skills.setEnabled(input.name,true);assert.deepEqual(fs.readFileSync(path.join(path.dirname(enabled.path),relative)),binary);
 const updated=skills.save({name:input.name,description:'Updated portable npm project.',instructions:'Use the packaged lockfile, then run scripts/project/run.mjs.'});assert.deepEqual(updated.files,input.files);assert.equal(updated.instructions,'Use the packaged lockfile, then run scripts/project/run.mjs.');assert.equal(Object.keys(skills.get(input.name).files).some(name=>name.includes('node_modules')),false);
});
test('the full enabled skill index remains valid JSON beyond the former context cutoff',t=>{
 const {skills}=setup(t),saved=[];
 for(let index=0;index<20;index++)saved.push(skills.save({name:'workflow-'+String(index).padStart(2,'0'),description:'A reusable workflow '+index+': '+ 'Reference instructions. '.repeat(40),instructions:'Observe the current desktop before applying this workflow.'}));
 skills.save({name:'disabled-workflow',description:'This disabled skill must not be advertised.',instructions:'Keep this workflow disabled.',enabled:false});
 const context=skills.context();assert.ok(context.length>16000);
 const entries=JSON.parse(context.slice(context.indexOf('\n')+1));
 assert.deepEqual(entries,saved.map(({name,description,path})=>({name,description,path})));assert.equal(entries.at(-1).name,'workflow-19');assert.equal(entries.at(-1).description,saved.at(-1).description);assert.equal(entries.some(item=>item.name==='disabled-workflow'),false);
});

test('skill validation rejects path escape, excessive content and secret embedding before replacing anything',t=>{
 const {skills}=setup(t,{containsSecret:value=>value.includes('test-vault-secret')});const before=skills.save(sample);
 const invalid=[null,{}, {...sample,name:'../escape'}, {...sample,name:'UPPER'}, {...sample,description:''}, {...sample,instructions:''}, {...sample,enabled:'yes'}, {...sample,files:[]}, {...sample,files:null}, {...sample,files:{'scripts/../../outside':'x'}}, {...sample,files:{'scripts\\escape.py':'x'}}, {...sample,files:{'/absolute':'x'}}, {...sample,files:{'scripts/C:/escape':'x'}}, {...sample,files:{'scripts/helper.py':42}}, {...sample,files:{'scripts/helper.py':'x'.repeat(65537)}}, {...sample,instructions:'test-vault-secret'}];
 for(const input of invalid)assert.throws(()=>skills.save(input));assert.deepEqual(skills.get(sample.name),before);assert.throws(()=>skills.setEnabled(sample.name,'yes'));assert.throws(()=>skills.inside(skills.workspace));assert.throws(()=>skills.inside(path.dirname(skills.workspace)));assert.throws(()=>skills.get('../escape'));
 const many=Object.fromEntries(Array.from({length:SKILL_SUPPORT_FILE_LIMIT+1},(_,n)=>['scripts/'+n+'.txt','x']));assert.throws(()=>skills.save({...sample,files:many}),error=>error.code==='size_limit');const large=Object.fromEntries(Array.from({length:5},(_,n)=>['assets/'+n+'.txt','x'.repeat(65536)]));assert.throws(()=>skills.save({...sample,files:large}));
});

test('128 long supporting paths retain their marker index through save, edit, list and restart while the 129th is rejected intact',t=>{
 const {workspace,skills}=setup(t),files=Object.fromEntries(Array.from({length:SKILL_SUPPORT_FILE_LIMIT},(_,index)=>['references/'+String(index).padStart(3,'0')+'-'+'x'.repeat(162)+'.md','Preserved source '+index])),saved=skills.save({...sample,files}),marker=path.join(path.dirname(saved.path),'.dant-managed.json');
 assert.equal(Object.keys(saved.files).length,128);assert.ok(fs.statSync(marker).size>8192);assert.equal(skills.list().length,1);assert.deepEqual(skills.get(saved.name).files,files);assert.deepEqual(new SkillLibrary({workspace}).get(saved.name).files,files);
 const edited=skills.save({name:saved.name,description:'Updated only the description',instructions:sample.instructions});assert.deepEqual(edited.files,files);const before=fs.readFileSync(marker),instructions=fs.readFileSync(saved.path);
 assert.throws(()=>skills.save({...sample,files:{...files,'scripts/extra.mjs':'export const extra=true;'}}),error=>error.code==='size_limit');assert.deepEqual(fs.readFileSync(marker),before);assert.deepEqual(fs.readFileSync(saved.path),instructions);assert.deepEqual(skills.get(saved.name).files,files);
 const overflow=path.join(path.dirname(saved.path),'scripts','extra.mjs');fs.mkdirSync(path.dirname(overflow),{recursive:true});fs.writeFileSync(overflow,'export const extra=true;');assert.equal(skills.list().length,1);assert.throws(()=>skills.get(saved.name),error=>error.code==='size_limit');assert.throws(()=>skills.save({name:saved.name,description:'Must not discard files',instructions:sample.instructions}),error=>error.code==='size_limit');assert.equal(fs.readFileSync(overflow,'utf8'),'export const extra=true;');assert.deepEqual(fs.readFileSync(marker),before);
});

test('expanded marker metadata remains bounded and oversized markers never change the skill',t=>{
 const {skills}=setup(t),saved=skills.save(sample),marker=path.join(path.dirname(saved.path),'.dant-managed.json'),instructions=fs.readFileSync(saved.path),oversized=JSON.stringify({owner:'dant',name:saved.name,padding:'x'.repeat(8192+SKILL_SUPPORT_FILE_LIMIT*1100)});fs.writeFileSync(marker,oversized);
 assert.throws(()=>skills.get(saved.name),/not managed/);assert.deepEqual(skills.list(),[]);assert.equal(fs.readFileSync(marker,'utf8'),oversized);assert.deepEqual(fs.readFileSync(saved.path),instructions);
});

test('the maximum file count at the existing maximum directory depth remains readable after save and restart',t=>{
 const {workspace,skills}=setup(t),files=Object.fromEntries(Array.from({length:SKILL_SUPPORT_FILE_LIMIT},(_,index)=>['scripts/'+index+'/'+'nested/'.repeat(14)+'helper.mjs','export const value='+index+';\n'])),saved=skills.save({...sample,files});
 assert.deepEqual(saved.files,files);assert.equal(skills.list().length,1);assert.deepEqual(new SkillLibrary({workspace}).get(saved.name).files,files);
});
test('unmanaged folders are preserved and failed file staging leaves the old skill usable',t=>{
 const {workspace,skills}=setup(t);skills.save(sample);const external=path.join(workspace,'.agents/skills/external');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'SKILL.md'),'User-owned');assert.equal(skills.list().length,1);assert.throws(()=>skills.save({...sample,name:'external'}));assert.equal(fs.readFileSync(path.join(external,'SKILL.md'),'utf8'),'User-owned');
 assert.throws(()=>skills.save({...sample,files:{'scripts/collision':'file','scripts/collision/child.py':'nested'}}));assert.equal(skills.get(sample.name).instructions,sample.instructions);assert.deepEqual(fs.readdirSync(path.join(workspace,'.agents/skills')).sort(),['external',sample.name]);
});
test('skill reads reject replaced instructions and helper links',t=>{
 const {skills}=setup(t);const item=skills.save(sample);fs.writeFileSync(item.path,'missing frontmatter');assert.throws(()=>skills.get(sample.name),/frontmatter/);skills.save(sample);fs.writeFileSync(path.join(path.dirname(item.path),'scripts/inspect.py'),'x'.repeat(65537));assert.throws(()=>skills.get(sample.name),/Invalid managed/);
});

test('skill management refuses redirected roots and preserves linked outside data',t=>{
 const {workspace,skills}=setup(t),outside=fs.mkdtempSync(path.join(base,'outside-skills-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));fs.symlinkSync(outside,path.join(workspace,'.agents'),process.platform==='win32'?'junction':'dir');assert.throws(()=>skills.save(sample));assert.deepEqual(fs.readdirSync(outside),[]);
});
