import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync,crc32} from 'node:zlib';
import {SkillLibrary} from '../src/skill-library.mjs';
import {SkillImporter} from '../src/skill-import.mjs';

const base=path.resolve('.cache/tests');fs.mkdirSync(base,{recursive:true});
const source='---\nname: inspect-desktop\ndescription: Inspect the work computer safely.\n---\n\nRead scripts/check.py before using this skill.\n';
const errorCode=code=>error=>error.code===code&&!/private|secret exception/.test(error.message);
function fixture(t,options={}){
 const workspace=fs.mkdtempSync(path.join(base,'skill-import-')),skills=new SkillLibrary({workspace}),importer=new SkillImporter({skills,...options});
 t.after(()=>{importer.close();assert.ok(path.relative(base,workspace)&&!path.relative(base,workspace).startsWith('..'));assert.equal(fs.lstatSync(workspace).isSymbolicLink(),false);fs.rmSync(workspace,{recursive:true,force:true});});return {workspace,skills,importer};
}
function zip(items){
 const local=[],central=[];let offset=0;
 for(const item of items){
  const name=Buffer.from(item.name),data=Buffer.from(item.data||''),compressed=item.store?data:deflateRawSync(data),flag=0x800|(item.encrypted?1:0),method=item.store?0:8,crc=item.crc??crc32(data),size=item.size??data.length;
  const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(flag,6);head.writeUInt16LE(method,8);head.writeUInt32LE(crc,14);head.writeUInt32LE(compressed.length,18);head.writeUInt32LE(size,22);head.writeUInt16LE(name.length,26);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(flag,8);record.writeUInt16LE(method,10);record.writeUInt32LE(crc,16);record.writeUInt32LE(compressed.length,20);record.writeUInt32LE(size,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(((item.mode??(item.name.endsWith('/')?0x41ed:0x81a4))<<16)>>>0,38);record.writeUInt32LE(offset,42);
  local.push(head,name,compressed);central.push(record,name);offset+=head.length+name.length+compressed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
const blobSha=data=>createHash('sha1').update('blob '+Buffer.byteLength(data)+'\0').update(data).digest('hex');
function github({files={'SKILL.md':source,'scripts/check.py':'print("review before running")\n'},refs=['HEAD','main'],treeChange=value=>value,blobChange=value=>value,commitChange=value=>value,fetchChange}={}){
 const calls=[],commit='1'.repeat(40),root='a'.repeat(40),nested='b'.repeat(40),deeper='c'.repeat(40),entries=Object.entries(files).map(([name,data])=>({path:name,mode:'100644',type:'blob',sha:blobSha(data),size:Buffer.byteLength(data)}));
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});if(fetchChange)return fetchChange(url,options);
  const route=new URL(url).pathname;
  if(route.endsWith('/commits'))return refs.includes(new URL(url).searchParams.get('sha'))?Response.json([commitChange({sha:commit,commit:{tree:{sha:root}}})]):new Response('',{status:422});
  if(route.endsWith('/git/trees/'+root)&&!new URL(url).search)return Response.json({truncated:false,tree:[{path:'skills',type:'tree',mode:'040000',sha:nested}]});
  if(route.endsWith('/git/trees/'+nested)&&!new URL(url).search)return Response.json({truncated:false,tree:[{path:'example',type:'tree',mode:'040000',sha:deeper}]});
  if(route.includes('/git/trees/'))return Response.json(treeChange({truncated:false,tree:entries}));
  const entry=entries.find(item=>route.endsWith('/git/blobs/'+item.sha));if(entry)return Response.json(blobChange({sha:entry.sha,encoding:'base64',size:entry.size,content:Buffer.from(files[entry.path]).toString('base64')}));
  return new Response('not found',{status:404});
 };return {fetchImpl,calls,commit,root};
}

test('local SKILL.md previews are inert, reviewed, renameable, optional-disabled, and one use',async t=>{
 const {skills,importer,workspace}=fixture(t),preview=await importer.preview({name:'SKILL.md',data:Buffer.from(source)});
 assert.equal(skills.list().length,0);assert.equal(fs.existsSync(path.join(workspace,'.agents')),false);assert.equal(preview.name,'inspect-desktop');assert.equal(preview.source,'SKILL.md');assert.deepEqual(preview.files,[{path:'SKILL.md',size:Buffer.byteLength(source)}]);assert.equal(preview.expiresAt> Date.now(),true);
 const saved=importer.commit({id:preview.id,name:'renamed-skill',enabled:false});assert.equal(saved.name,'renamed-skill');assert.equal(saved.enabled,false);assert.equal(saved.instructions,'Read scripts/check.py before using this skill.');assert.deepEqual(saved.files,{});assert.throws(()=>importer.commit({id:preview.id}),errorCode('expired'));
});

test('folded/literal and quoted bilingual descriptions plus benign metadata are parsed without evaluating YAML',async t=>{
 const {importer}=fixture(t);
 for(const description of ['"A safe: quoted # description"',"'It''s a safe skill'",'>-\n  Observe the desktop\n  before acting.','|\n  第一行\n  Second line']){
  const text='\uFEFF---\r\nname: inspect-desktop\r\ndescription: '+description.replaceAll('\n','\r\n')+'\r\nlicense: See LICENSE.txt\r\ncompatibility: Requires a Linux desktop\r\nmetadata:\r\n  short-description: A display label\r\n---\r\n\r\nRead before acting.\r\n';
  const preview=await importer.preview({name:'SKILL.md',data:Buffer.from(text)});assert.match(preview.instructions,/License: See LICENSE.txt/);assert.match(preview.instructions,/Compatibility: Requires a Linux desktop/);importer.commit({id:preview.id,name:'copy-'+description.length});
 }
});

test('ZIP wrappers preserve every supported helper, root license, notice, and README without execution',async t=>{
 const {importer,skills}=fixture(t),files=[{name:'package/'},{name:'package/SKILL.md',data:source},{name:'package/scripts/check.py',data:'raise RuntimeError("never execute imports")\n'},{name:'package/references/check.md',data:'先观察，再执行。'},{name:'package/assets/schema.json',data:'{"ok":true}'},{name:'package/LICENSE.txt',data:'MIT fixture'},{name:'package/NOTICE',data:'Copyright fixture'},{name:'package/README.md',data:'Read before use'}];
 const preview=await importer.preview({name:'download.zip',data:zip(files)});assert.equal(skills.list().length,0);assert.equal(preview.files.length,7);const saved=importer.commit({id:preview.id});assert.equal(Object.keys(saved.files).length,6);assert.equal(saved.files['LICENSE.txt'],'MIT fixture');assert.match(saved.files['scripts/check.py'],/never execute/);
});

test('existing managed or unmanaged names never overwrite and the same preview can be renamed',async t=>{
 const {importer,skills,workspace}=fixture(t);const original=skills.save({name:'inspect-desktop',description:'Existing',instructions:'Preserve existing instructions.'}),preview=await importer.preview({name:'SKILL.md',data:Buffer.from(source)});
 assert.throws(()=>importer.commit({id:preview.id}),errorCode('name_exists'));assert.deepEqual(skills.get(original.name),original);
 assert.throws(()=>importer.commit({id:preview.id,name:'../escape'}),errorCode('invalid_skill'));assert.throws(()=>importer.commit({id:preview.id,enabled:'yes'}),errorCode('invalid_skill'));
 fs.mkdirSync(path.join(workspace,'.agents/skills/unmanaged'));fs.writeFileSync(path.join(workspace,'.agents/skills/unmanaged/SKILL.md'),'User owned');assert.throws(()=>importer.commit({id:preview.id,name:'unmanaged'}),errorCode('name_exists'));
 assert.equal(importer.commit({id:preview.id,name:'reviewed-copy'}).name,'reviewed-copy');assert.equal(fs.readFileSync(path.join(workspace,'.agents/skills/unmanaged/SKILL.md'),'utf8'),'User owned');
});

test('preview TTL, capacity, concurrency, and closure bound retained import data',async t=>{
 let now=1000;const {importer}=fixture(t,{now:()=>now});const previews=[];for(let i=0;i<3;i++)previews.push(await importer.preview({name:'SKILL.md',data:Buffer.from(source)}));
 await assert.rejects(importer.preview({name:'SKILL.md',data:Buffer.from(source)}),errorCode('import_busy'));now+=10*60*1000;assert.throws(()=>importer.commit({id:previews[0].id}),errorCode('expired'));assert.equal((await importer.preview({name:'SKILL.md',data:Buffer.from(source)})).expiresAt,now+600000);
 importer.close();assert.equal(importer.previews.size,0);await assert.rejects(importer.preview({name:'SKILL.md',data:Buffer.from(source)}),errorCode('expired'));
});

test('discard releases preview capacity, prevents commit, and never changes saved skills',async t=>{
 const {importer,skills}=fixture(t),one=await importer.preview({name:'SKILL.md',data:Buffer.from(source)}),saved=importer.commit({id:one.id});
 const two=await importer.preview({name:'SKILL.md',data:Buffer.from(source)});assert.deepEqual(importer.discard(two.id),{discarded:true});assert.throws(()=>importer.commit({id:two.id}),errorCode('expired'));assert.deepEqual(skills.get(saved.name),saved);assert.deepEqual(importer.discard(one.id),{discarded:true});assert.deepEqual(skills.get(saved.name),saved);
});

test('unsupported YAML, malformed UTF-8, binary bodies, and incomplete skill files are refused',async t=>{
 const {importer}=fixture(t);
 for(const text of ['no frontmatter','---\nname: inspect-desktop\ndescription: valid\n---\n',source.replace('description: Inspect the work computer safely.','description: &ref Dangerous'),source.replace('name: inspect-desktop','name: ../escape'),source.replace('description: Inspect the work computer safely.','description: [list, value]'),source.replace('description: Inspect the work computer safely.','description: "unterminated'),source.replace('description: Inspect the work computer safely.','allowed-tools: Bash\ndescription: A tool requirement'),source.replace('description: Inspect the work computer safely.','description: One\ndescription: Two')])await assert.rejects(importer.preview({name:'SKILL.md',data:Buffer.from(text)}),errorCode('invalid_skill'));
 for(const data of [Buffer.from([0xff]),Buffer.from('---\n\0')])await assert.rejects(importer.preview({name:'SKILL.md',data}),errorCode('unsupported_file'));
 for(const input of [{},null,{url:'https://github.com/a/b',name:'SKILL.md',data:Buffer.from(source)},{name:'unknown.txt',data:Buffer.from(source)}])await assert.rejects(importer.preview(input),error=>['invalid_source','unsupported_file'].includes(error.code));
});

test('ZIP unsafe paths, duplicate names, multiple skills, encryption, links, and unknown root code fail',async t=>{
 const {importer}=fixture(t),cases=[
  [{name:'../SKILL.md',data:source}],
  [{name:'/SKILL.md',data:source}],
  [{name:'wrapper\\SKILL.md',data:source}],
  [{name:'SKILL.md',data:source},{name:'skill.md',data:'duplicate'}],
  [{name:'one/SKILL.md',data:source},{name:'two/SKILL.md',data:source}],
  [{name:'SKILL.md',data:source,encrypted:true}],
  [{name:'SKILL.md',data:source},{name:'scripts/linked.py',data:'../../outside',mode:0xa1ff}],
  [{name:'SKILL.md',data:source},{name:'install.js',data:'must not execute'}],
  [{name:'SKILL.md',data:source},{name:'scripts/helper',data:'a file'},{name:'scripts/helper/nested.py',data:'conflicting directory'}],
  [{name:'SKILL.md',data:source},{name:'assets/image.png',data:Buffer.from([0,1,2])}],
 ];
 for(const items of cases)await assert.rejects(importer.preview({name:'unsafe.zip',data:zip(items)}),error=>['invalid_skill','unsupported_file'].includes(error.code));
 await assert.rejects(importer.preview({name:'bad.zip',data:Buffer.from('not a ZIP')}),errorCode('invalid_skill'));
});

test('ZIP integrity, file count, compressed size and inflated-size lies are bounded before saving',async t=>{
 const {importer,skills}=fixture(t),cases=[
  {name:'too-big.zip',data:Buffer.alloc(1024*1024+1)},
  {name:'huge.zip',data:zip([{name:'SKILL.md',data:source},{name:'assets/huge.txt',data:'a'.repeat(65537)}])},
  {name:'many.zip',data:zip([{name:'SKILL.md',data:source},...Array.from({length:21},(_,i)=>({name:'references/'+i+'.txt',data:'x'}))])},
  {name:'entries.zip',data:zip(Array.from({length:129},(_,i)=>({name:'folder'+i+'/',data:''})))},
  {name:'bomb.zip',data:zip([{name:'SKILL.md',data:source},{name:'assets/bomb.txt',data:'a'.repeat(200000),size:1}])},
  {name:'corrupt.zip',data:zip([{name:'SKILL.md',data:source,crc:123}])},
 ];
 for(const input of cases)await assert.rejects(importer.preview(input),error=>['size_limit','invalid_skill'].includes(error.code));assert.equal(skills.list().length,0);
 await assert.rejects(importer.preview({name:'SKILL.md',data:Buffer.from(source+'x'.repeat(49152))}),errorCode('size_limit'));
 const total=[{name:'SKILL.md',data:source},...Array.from({length:5},(_,i)=>({name:'references/'+i+'.txt',data:'a'.repeat(60000)}))];await assert.rejects(importer.preview({name:'total.zip',data:zip(total)}),errorCode('size_limit'));
});

test('public GitHub sources resolve one commit and verify every downloaded blob against that pinned tree',async t=>{
 for(const url of ['https://github.com/owner/repo','https://github.com/owner/repo/tree/main/skills/example','https://github.com/owner/repo/blob/main/skills/example/SKILL.md']){
  const network=github(),{importer}=fixture(t,{fetchImpl:network.fetchImpl}),preview=await importer.preview({url});assert.ok(preview.source.includes('/tree/'+network.commit));assert.ok(preview.instructions.includes('Source: '+preview.source));assert.equal(preview.files.length,2);const saved=importer.commit({id:preview.id});assert.match(saved.files['scripts/check.py'],/review/);
  assert.ok(network.calls.filter(call=>call.url.includes('/commits?')).length<=17);assert.ok(network.calls.some(call=>call.url.includes('?recursive=1')));
  for(const {url,options}of network.calls){assert.equal(new URL(url).hostname,'api.github.com');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,undefined);}
 }
});

test('slash-bearing branches and tags resolve their longest existing prefix before path traversal',async t=>{
 for(const url of ['https://github.com/owner/repo/tree/codex/windows-vm/skills/example','https://github.com/owner/repo/blob/codex/windows-vm/skills/example/SKILL.md','https://github.com/owner/repo/tree/codex%2Fwindows-vm/skills/example']){
  const network=github({refs:['codex','codex/windows-vm']}),{importer}=fixture(t,{fetchImpl:network.fetchImpl}),preview=await importer.preview({url});assert.equal(preview.name,'inspect-desktop');assert.ok(preview.source.endsWith('/skills/example'));
  const revisions=network.calls.filter(call=>call.url.includes('/commits?')).map(call=>new URL(call.url).searchParams.get('sha'));assert.equal(revisions.at(-1),'codex/windows-vm');assert.equal(revisions.includes('codex'),false);assert.ok(network.calls.length<30);
 }
});

test('GitHub URL validation prevents arbitrary hosts, credentialed requests, redirects, or arbitrary file endpoints',async t=>{
 let calls=0;const {importer}=fixture(t,{fetchImpl:async()=>{calls++;throw Error('must not fetch');}});
 for(const url of ['http://github.com/a/b','https://localhost/a/b','https://api.github.com/repos/a/b','https://github.com.evil.test/a/b','https://user:password@github.com/a/b','https://github.com/a/b?token=private','https://github.com/a/b#readme','https://github.com/a/b/raw/main/SKILL.md','https://github.com/a/b/blob/main/package.json','https://github.com/a/b/tree/%2e%2e/other','https://github.com/a/b/tree/main/x%2fy','https://github.com/a/b/tree/main/%00'])await assert.rejects(importer.preview({url}),errorCode('invalid_source'));
 assert.equal(calls,0);
});

test('remote truncation, unsupported entries, excessive data, changed blob hashes, and malformed JSON fail closed',async t=>{
 for(const options of [
  {treeChange:tree=>({...tree,truncated:true})},
  {treeChange:tree=>({...tree,tree:[...tree.tree,...Array.from({length:129},(_,i)=>({path:'dir'+i,type:'tree',mode:'040000'}))]})},
  {treeChange:tree=>({...tree,tree:tree.tree.map(item=>({...item,mode:'120000'}))})},
  {treeChange:tree=>({...tree,tree:tree.tree.map(item=>({...item,size:65537}))})},
  {blobChange:blob=>({...blob,content:Buffer.from('changed').toString('base64')})},
  {blobChange:blob=>({...blob,content:'!!!!'})},
  {commitChange:commit=>({...commit,sha:'not-sha'})},
  {fetchChange:async()=>new Response('private body',{status:404})},
  {fetchChange:async()=>new Response('private body',{status:302,headers:{Location:'http://localhost/private'}})},
  {fetchChange:async()=>new Response('{malformed')},
  {fetchChange:async()=>new Response(new ReadableStream({start(controller){controller.error(Error('private transport error'));}}))},
  {fetchChange:async()=>new Response('large',{headers:{'content-length':String(2*1024*1024)}})},
  {fetchChange:async()=>{throw Error('secret exception');}},
 ]){
  const network=github(options),{importer}=fixture(t,{fetchImpl:network.fetchImpl});await assert.rejects(importer.preview({url:'https://github.com/owner/repo'}),error=>['fetch_failed','not_found','size_limit','unsupported_file'].includes(error.code)&&!error.message.includes('private'));
 }
});

test('remote body and connection stalls time out, and closure prevents late network results from creating a preview',async t=>{
 for(const body of [false,true]){
  let aborted=false;const {importer}=fixture(t,{timeoutMs:10,fetchImpl:async(url,{signal})=>{signal.addEventListener('abort',()=>aborted=true);return body?new Response(new ReadableStream({start(){}})):new Promise(()=>{});}});
  await assert.rejects(importer.preview({url:'https://github.com/owner/repo'}),errorCode('fetch_failed'));assert.equal(aborted,true);assert.equal(importer.previews.size,0);
 }
 let release;const {importer}=fixture(t,{fetchImpl:()=>new Promise(resolve=>release=resolve)}),pending=importer.preview({url:'https://github.com/owner/repo'});importer.close();await assert.rejects(pending,errorCode('fetch_failed'));release(Response.json({}));assert.equal(importer.previews.size,0);
});

test('concurrent previews reserve capacity and save failures consume IDs without leaking filesystem errors',async t=>{
 const waits=[],{importer}=fixture(t,{fetchImpl:()=>new Promise(resolve=>waits.push(resolve))}),requests=Array.from({length:3},()=>importer.preview({url:'https://github.com/owner/repo'}));
 await assert.rejects(importer.preview({name:'SKILL.md',data:Buffer.from(source)}),errorCode('import_busy'));importer.close();await Promise.all(requests.map(promise=>assert.rejects(promise,errorCode('fetch_failed'))));for(const release of waits)release(Response.json({}));
 const second=fixture(t),preview=await second.importer.preview({name:'SKILL.md',data:Buffer.from(source)});second.skills.save=()=>{throw Error('secret exception');};assert.throws(()=>second.importer.commit({id:preview.id}),errorCode('invalid_skill'));assert.throws(()=>second.importer.commit({id:preview.id}),errorCode('expired'));
});
