import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AttachmentStore,inspectContent,MAX_ATTACHMENT_BYTES} from '../src/attachments.mjs';
import {DeliverableCollector} from '../src/deliverables.mjs';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-files-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const outputDir=path.join(dir,'output'),attachments=new AttachmentStore(path.join(dir,'attachments')),collector=new DeliverableCollector(attachments);fs.mkdirSync(outputDir);return {dir,outputDir,attachments,collector};}

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

test('symlink output escape is never archived', {skip:process.platform==='win32'},t=>{
 const {dir,outputDir,collector}=fixture(t),baseline=collector.captureBaseline({outputDir});
 fs.writeFileSync(path.join(dir,'private.txt'),'private');fs.symlinkSync(path.join(dir,'private.txt'),path.join(outputDir,'visible.txt'));
 fs.symlinkSync(dir,path.join(outputDir,'nested'));assert.deepEqual(collector.archive({outputDir,baseline}),[]);
});
