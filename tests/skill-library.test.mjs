import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {SkillLibrary} from '../src/skill-library.mjs';
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
 const invalid=[null,{}, {...sample,name:'../escape'}, {...sample,name:'UPPER'}, {...sample,description:''}, {...sample,instructions:''}, {...sample,enabled:'yes'}, {...sample,files:[]}, {...sample,files:{'scripts/../../outside':'x'}}, {...sample,files:{'scripts\\escape.py':'x'}}, {...sample,files:{'/absolute':'x'}}, {...sample,files:{'scripts/C:/escape':'x'}}, {...sample,files:{'scripts/helper.py':42}}, {...sample,files:{'scripts/helper.py':'x'.repeat(65537)}}, {...sample,instructions:'test-vault-secret'}];
 for(const input of invalid)assert.throws(()=>skills.save(input));assert.deepEqual(skills.get(sample.name),before);assert.throws(()=>skills.setEnabled(sample.name,'yes'));assert.throws(()=>skills.inside(skills.workspace));assert.throws(()=>skills.inside(path.dirname(skills.workspace)));assert.throws(()=>skills.get('../escape'));
 const many=Object.fromEntries(Array.from({length:21},(_,n)=>['scripts/'+n+'.txt','x']));assert.throws(()=>skills.save({...sample,files:many}));const large=Object.fromEntries(Array.from({length:5},(_,n)=>['assets/'+n+'.txt','x'.repeat(65536)]));assert.throws(()=>skills.save({...sample,files:large}));
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
