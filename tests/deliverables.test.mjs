import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AttachmentStore,inspectContent,MAX_ATTACHMENT_BYTES} from '../src/attachments.mjs';
import {DeliverableCollector} from '../src/deliverables.mjs';

function fixture(t){const parent=path.resolve(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'dant-files-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),parent);assert.ok(path.basename(dir).startsWith('dant-files-'));fs.rmSync(dir,{recursive:true,force:true});});const outputDir=path.join(dir,'output'),attachments=new AttachmentStore(path.join(dir,'attachments')),collector=new DeliverableCollector(attachments);fs.mkdirSync(outputDir);return {dir,outputDir,attachments,collector};}

test('attachment content is identified independently of filename and MIME',t=>{
 const {attachments}=fixture(t);
 assert.throws(()=>attachments.put({name:'photo.png',type:'image/png',data:Buffer.from('not an image')}),/content/);
 const html=attachments.put({name:'../../page.html',type:'text/html',data:Buffer.from('<script>alert(1)</script>')});
 assert.equal(html.name,'page.html');assert.equal(html.type,'application/octet-stream');
 assert.throws(()=>inspectContent(Buffer.from('{bad'),'bad.json'),/JSON/);
 assert.throws(()=>attachments.put({data:Buffer.alloc(MAX_ATTACHMENT_BYTES+1)}),/10 MiB/);
 assert.equal(attachments.get('../outside'),null);
});

test('archive only changed files, supports explicit old references and keeps immutable copies',t=>{
 const {outputDir,attachments,collector}=fixture(t),file=path.join(outputDir,'report.txt');
 fs.writeFileSync(file,'old');const baseline=collector.captureBaseline({outputDir});
 assert.deepEqual(collector.archive({outputDir,baseline}),[]);
 fs.writeFileSync(file,'new');const [first]=collector.archive({outputDir,baseline});assert.equal(attachments.read(first.id).data.toString(),'new');
 fs.writeFileSync(file,'later');assert.equal(attachments.read(first.id).data.toString(),'new');
 const current=collector.captureBaseline({outputDir});const [explicit]=collector.archive({outputDir,baseline:current,text:`[report](${file})`});assert.equal(attachments.read(explicit.id).data.toString(),'later');
 assert.equal(collector.archive({outputDir,baseline:current,text:'[no](../private.txt)'}).length,0);
});

test('archive rejects links and secret/log names and enforces total message count',t=>{
 const {outputDir,collector}=fixture(t),baseline=collector.captureBaseline({outputDir});
 fs.writeFileSync(path.join(outputDir,'secret-token.txt'),'secret');fs.writeFileSync(path.join(outputDir,'debug.log'),'log');
 for(let n=0;n<8;n++)fs.writeFileSync(path.join(outputDir,`report${n}.txt`),'report'+n);
 fs.linkSync(path.join(outputDir,'report0.txt'),path.join(outputDir,'hardlink.txt'));
 const files=collector.archive({outputDir,baseline});assert.equal(files.length,5);assert.ok(files.every(file=>/^report[1-7]\.txt$/.test(file.name)));
});

test('incomplete output scans do not partly archive earlier files',t=>{
 const {outputDir,collector}=fixture(t),baseline=collector.captureBaseline({outputDir});
 for(let n=0;n<513;n++)fs.writeFileSync(path.join(outputDir,`report${n}.txt`),'x');
 const warnings=[];collector.on('notice',notice=>warnings.push(notice));
 assert.deepEqual(collector.archive({outputDir,baseline}),[]);assert.match(warnings[0],/512/);
});

test('symlink output escape is never archived',t=>{
 const {dir,outputDir,attachments,collector}=fixture(t),notices=[];collector.on('notice',notice=>notices.push(notice));const baseline=collector.captureBaseline({outputDir});assert.equal(baseline.valid,true);
 const outside=path.join(dir,'outside'),external=path.join(outside,'external.txt'),fileLink=path.join(outputDir,'visible.txt'),directoryLink=path.join(outputDir,'nested');fs.mkdirSync(outside);fs.writeFileSync(external,'outside bytes must stay private');
 fs.symlinkSync(external,fileLink,'file');fs.symlinkSync(outside,directoryLink,'dir');assert.equal(fs.lstatSync(fileLink).isSymbolicLink(),true);assert.equal(fs.lstatSync(directoryLink).isSymbolicLink(),true);assert.equal(fs.realpathSync(fileLink),fs.realpathSync(external));assert.equal(fs.realpathSync(directoryLink),fs.realpathSync(outside));
 fs.writeFileSync(path.join(outputDir,'report.txt'),'inside sentinel');const archived=collector.archive({outputDir,baseline});assert.deepEqual(archived.map(file=>file.name),['report.txt']);assert.equal(attachments.read(archived[0].id).data.toString(),'inside sentinel');
 const linkedChild=path.join(directoryLink,'external.txt');assert.deepEqual(collector.archive({outputDir,baseline,onlyExplicit:true,explicitPaths:[fileLink,linkedChild,external]}),[]);for(const filePath of [fileLink,linkedChild])assert.throws(()=>collector.readExplicit({outputDir,filePath}),/missing, restricted/);assert.throws(()=>collector.readExplicit({outputDir,filePath:external}),/Only current output/);
 assert.equal(fs.readFileSync(external,'utf8'),'outside bytes must stay private');assert.deepEqual(notices,[]);
});

test('explicit old output survives unrelated entry limits and an invalid automatic baseline',t=>{
 const {outputDir,attachments,collector}=fixture(t),file=path.join(outputDir,'result.txt');fs.writeFileSync(file,'requested result');const baseline=collector.captureBaseline({outputDir});
 for(let index=0;index<513;index++)fs.writeFileSync(path.join(outputDir,`unrelated-${index}.txt`),'x');
 const invalid=collector.captureBaseline({outputDir});assert.equal(invalid.valid,false);
 for(const options of [{baseline,onlyExplicit:true},{baseline:invalid,onlyExplicit:true},{baseline}]){
  const files=collector.archive({outputDir,...options,text:`[Result](${file})`});assert.equal(files.length,1);assert.equal(files[0].sourcePath,file);assert.equal(attachments.read(files[0].id).data.toString(),'requested result');
 }
 assert.equal(attachments.read(collector.readExplicit({outputDir,filePath:file}).id).data.toString(),'requested result');
});

test('explicit output survives unrelated byte limits while automatic output remains all or none',t=>{
 const {outputDir,attachments,collector}=fixture(t),file=path.join(outputDir,'result.txt');fs.writeFileSync(file,'requested result');const baseline=collector.captureBaseline({outputDir});
 for(let index=0;index<8;index++){const fd=fs.openSync(path.join(outputDir,`large-${index}.bin`),'w');try{fs.ftruncateSync(fd,9*1024*1024);}finally{fs.closeSync(fd);}}
 assert.deepEqual(collector.archive({outputDir,baseline}),[]);
 const files=collector.archive({outputDir,baseline,text:`[Result](${file})`});assert.equal(files.length,1);assert.equal(attachments.read(files[0].id).data.toString(),'requested result');
 const direct=collector.archive({outputDir,baseline,onlyExplicit:true,explicitPaths:[file]});assert.equal(direct.length,1);assert.equal(attachments.read(direct[0].id).data.toString(),'requested result');
});

test('explicit delivery does not enumerate unrelated files and supports local URI references',t=>{
 const {outputDir,attachments,collector}=fixture(t),file=path.join(outputDir,'result 1.txt');fs.writeFileSync(file,'requested result');
 t.mock.method(fs,'readdirSync',()=>{throw Error('Unrelated enumeration is not permitted');});
 const fileUrl=new URL('file:///');fileUrl.pathname=(process.platform==='win32'?'/':'')+file.replaceAll('\\','/');
 for(const reference of [fileUrl.href,'sandbox:'+file,'./output/result%201.txt']){
  const files=collector.archive({outputDir,onlyExplicit:true,text:`[Result](${reference})`});assert.equal(files.length,1,reference);assert.equal(files[0].sourcePath,file);assert.equal(attachments.read(files[0].id).data.toString(),'requested result');
 }
});

test('raw file paths preserve literal percent signs while Markdown references decode exactly once',t=>{
 const {outputDir,attachments,collector}=fixture(t),literal=path.join(outputDir,'report%20.txt'),spaced=path.join(outputDir,'report .txt');fs.writeFileSync(literal,'literal percent content');fs.writeFileSync(spaced,'space content');
 const direct=collector.readExplicit({outputDir,filePath:literal});assert.equal(direct.sourcePath,literal);assert.equal(attachments.read(direct.id).data.toString(),'literal percent content');
 const [explicit]=collector.archive({outputDir,onlyExplicit:true,explicitPaths:[literal]});assert.equal(explicit.sourcePath,literal);assert.equal(attachments.read(explicit.id).data.toString(),'literal percent content');
 for(const prefix of ['', 'sandbox:']){
  const [encoded]=collector.archive({outputDir,onlyExplicit:true,text:`[Literal](${prefix+encodeURI(literal.replaceAll('\\','/'))})`});assert.equal(encoded.sourcePath,literal);assert.equal(attachments.read(encoded.id).data.toString(),'literal percent content');
  const [space]=collector.archive({outputDir,onlyExplicit:true,text:`[Space](${prefix+encodeURI(spaced.replaceAll('\\','/'))})`});assert.equal(space.sourcePath,spaced);assert.equal(attachments.read(space.id).data.toString(),'space content');
 }
 const invalidPercent=path.join(outputDir,'report%zz.txt');fs.writeFileSync(invalidPercent,'literal invalid URI sequence');assert.equal(attachments.read(collector.readExplicit({outputDir,filePath:invalidPercent}).id).data.toString(),'literal invalid URI sequence');
});

test('direct output reads retain path, depth, type and five-file restrictions',t=>{
 const {outputDir,collector}=fixture(t),references=[];
 for(const segment of ['.private','secrets','auth-data','debug.log']){const directory=path.join(outputDir,segment);fs.mkdirSync(directory);const file=path.join(directory,'result.txt');fs.writeFileSync(file,'restricted');references.push(file);}
 const deep=path.join(outputDir,...Array.from({length:9},(_,index)=>'level'+index));fs.mkdirSync(deep,{recursive:true});const deepFile=path.join(deep,'result.txt');fs.writeFileSync(deepFile,'too deep');references.push(deepFile);
 const hardlink=path.join(outputDir,'shared.txt'),original=path.join(outputDir,'original.txt');fs.writeFileSync(original,'shared');fs.linkSync(original,hardlink);references.push(hardlink);
 const oversized=path.join(outputDir,'oversized.bin'),fd=fs.openSync(oversized,'w');try{fs.ftruncateSync(fd,MAX_ATTACHMENT_BYTES+1);}finally{fs.closeSync(fd);}references.push(oversized);
 assert.deepEqual(collector.archive({outputDir,onlyExplicit:true,explicitPaths:references}),[]);for(const filePath of references)assert.throws(()=>collector.readExplicit({outputDir,filePath}),/missing, restricted/);
 const allowed=path.join(outputDir,...Array.from({length:8},(_,index)=>'allowed'+index));fs.mkdirSync(allowed,{recursive:true});const allowedFile=path.join(allowed,'result.txt');fs.writeFileSync(allowedFile,'allowed');assert.equal(collector.archive({outputDir,onlyExplicit:true,explicitPaths:[allowedFile]}).length,1);
 const files=[];for(let index=0;index<7;index++){const file=path.join(outputDir,`valid-${index}.txt`);fs.writeFileSync(file,'valid '+index);files.push(file);}
 assert.equal(collector.archive({outputDir,onlyExplicit:true,explicitPaths:files}).length,5);
});

test('direct output reads reject files that change while their bounded snapshot is read',t=>{
 const {outputDir,collector}=fixture(t),file=path.join(outputDir,'result.txt');fs.writeFileSync(file,'original');const read=fs.readSync;let changed=false;
 t.mock.method(fs,'readSync',function(...args){const count=read.apply(this,args);if(!changed){changed=true;fs.appendFileSync(file,' changed');}return count;});
 assert.throws(()=>collector.readExplicit({outputDir,filePath:file}),/missing, restricted/);assert.equal(changed,true);
});

test('direct output reads reject file replacement between its identity check and open',t=>{
 const {outputDir,collector}=fixture(t),file=path.join(outputDir,'result.txt'),moved=path.join(outputDir,'moved.txt');fs.writeFileSync(file,'original');const open=fs.openSync;let replaced=false;
 t.mock.method(fs,'openSync',function(target,...args){if(!replaced&&path.basename(String(target))==='result.txt'){replaced=true;fs.renameSync(file,moved);fs.writeFileSync(file,'substitute');}return open.call(this,target,...args);});
 assert.throws(()=>collector.readExplicit({outputDir,filePath:file}),/missing, restricted/);assert.equal(replaced,true);assert.equal(fs.readFileSync(moved,'utf8'),'original');
});

test('direct output reads reject a redirected output root',t=>{
 const {dir,outputDir,collector}=fixture(t),realRoot=path.join(dir,'real-output');fs.renameSync(outputDir,realRoot);fs.writeFileSync(path.join(realRoot,'result.txt'),'redirected');fs.symlinkSync(realRoot,outputDir,process.platform==='win32'?'junction':'dir');
 assert.deepEqual(collector.archive({outputDir,onlyExplicit:true,explicitPaths:[path.join(outputDir,'result.txt')]}),[]);assert.throws(()=>collector.readExplicit({outputDir,filePath:path.join(outputDir,'result.txt')}),/missing, restricted/);
});
