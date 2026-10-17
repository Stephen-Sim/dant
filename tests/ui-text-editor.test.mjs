import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';
import {createTextEditor} from '../ui/text-editor.js';
const id='10b72b2a-346f-48c0-a243-1cb22871d91d',token='a'.repeat(64),file={id,name:'source.ps1',type:'text/plain'};
const tick=()=>new Promise(resolve=>setImmediate(resolve)),deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
function fixture(options={}){
 const {document,Event}=parseHTML('<html><body><main></main></body></html>'),calls=[];let renders=0;const render=()=>{renders++;document.querySelector('main').innerHTML=ui.renderSettings();ui.bind();};
 const ui=createTextEditor({desktop:true,document,getToken:()=>token,render,invoke:async(command,args)=>{calls.push({command,args});return command==='open_attachment_in_editor'?{opened:true}:{editor:'notepad',name:'Notepad'};},...options});render();return {ui,document,Event,calls,render,get renders(){return renders;}};
}
test('preferences load once, show only the editor basename and use native picker/reset without accepting free-form commands',async()=>{
 const f=fixture({invoke:async(command,args)=>{f.calls.push({command,args});return command==='choose_text_editor'?{editor:'custom',name:'Code.exe'}:{editor:'notepad',name:'Notepad'};}});await Promise.all([f.ui.load(),f.ui.load()]);assert.equal(f.calls.length,1);assert.equal(f.document.querySelector('[data-editor-name]').textContent,'Notepad');f.document.querySelector('[data-editor-choose]').click();await tick();assert.equal(f.document.querySelector('[data-editor-name]').textContent,'Code.exe');assert.equal(f.document.querySelector('[data-editor-reset]').disabled,false);f.document.querySelector('[data-editor-reset]').click();await tick();assert.equal(f.document.querySelector('[data-editor-name]').textContent,'Notepad');assert.equal(f.document.querySelector('input'),null);assert.deepEqual(f.calls.map(call=>call.command),['editor_preferences','choose_text_editor','reset_text_editor']);assert.ok(f.calls.every(call=>call.args===undefined));f.ui.dispose();
});
test('picker cancellation is quiet, repeated clicks share one picker and private errors never render',async()=>{
 const wait=deferred();let picks=0;const f=fixture({invoke:async()=>{picks++;return wait.promise;}});f.document.querySelector('[data-editor-choose]').click();f.document.querySelector('[data-editor-choose]').click();assert.equal(picks,1);wait.resolve(null);await tick();assert.equal(f.document.querySelector('.error'),null);assert.equal(f.document.querySelector('[data-editor-name]').textContent,'Notepad');f.ui.dispose();
 for(const invoke of [async()=>{throw Error('private directory and secret');},async()=>({editor:'custom',name:'C:\\private\\Code.exe'})]){const bad=fixture({invoke});await bad.ui.load();assert.ok(bad.document.querySelector('.error'));assert.doesNotMatch(bad.document.body.textContent,/private|secret/);bad.ui.dispose();}
});

test('pending preference reads disable choosing an editor and cannot overwrite a newer saved preference',async()=>{
 const wait=deferred(),commands=[],f=fixture({invoke:async command=>{commands.push(command);return command==='editor_preferences'?wait.promise:{editor:'custom',name:'Code.exe'};}}),loading=f.ui.load();assert.equal(f.document.querySelector('[data-editor-choose]').disabled,true);f.document.querySelector('[data-editor-choose]').onclick({preventDefault(){}});assert.deepEqual(commands,['editor_preferences']);wait.resolve({editor:'notepad',name:'Notepad'});await loading;f.document.querySelector('[data-editor-choose]').click();await tick();await f.ui.load();assert.equal(f.document.querySelector('[data-editor-name]').textContent,'Code.exe');assert.equal(f.document.querySelector('[data-editor-reset]').disabled,false);f.ui.dispose();
});
test('opening a text attachment directly invokes the fixed native command once, with no URL, local destination or command arguments',async()=>{
 const wait=deferred(),f=fixture({invoke:async(command,args)=>{f.calls.push({command,args});return wait.promise;}}),first=f.ui.open(file),second=f.ui.open(file);assert.equal(first,second);assert.deepEqual(f.calls,[{command:'open_attachment_in_editor',args:{fileId:id,token,fileName:'source.ps1'}}]);wait.resolve({opened:true});assert.deepEqual(await first,{opened:true});f.ui.dispose();
});
test('browser, malformed auth/id, executable attachments and private native errors never launch an editor',async()=>{
 for(const options of [{desktop:false},{getToken:()=>''}]){const f=fixture(options);await assert.rejects(f.ui.open(file),error=>error.code==='editor_failed');assert.equal(f.calls.length,0);f.ui.dispose();}
 const f=fixture();for(const value of [null,{...file,id:'../private'},{...file,name:'run.exe',type:'text/plain'},{...file,name:'file.zip',type:'application/zip'}])await assert.rejects(f.ui.open(value));assert.equal(f.calls.length,0);f.ui.dispose();
 for(const invoke of [async()=>{throw Error('private process path');},async()=>({opened:false})]){const bad=fixture({invoke});await assert.rejects(bad.ui.open(file),error=>!error.message.includes('private')&&error.code==='editor_failed');bad.ui.dispose();}
});
test('disposal prevents late dynamic imports from invoking native commands or changing settings',async()=>{
 const wait=deferred(),calls=[],f=fixture({invoke:undefined,loadCore:()=>wait.promise}),opening=f.ui.open(file),failed=assert.rejects(opening,error=>error.code==='editor_failed'),loading=f.ui.load();f.ui.dispose();wait.resolve({invoke:async command=>{calls.push(command);return {editor:'custom',name:'Code.exe'};}});await failed;await loading;assert.equal(calls.length,0);assert.equal(f.document.querySelector('[data-editor-name]').textContent,'Notepad');await assert.rejects(f.ui.open(file));
});
test('Chinese settings and browser availability are localized and do not contact the VM',async()=>{
 const f=fixture({desktop:false,getLanguage:()=> 'zh'});await f.ui.load();assert.match(f.document.body.textContent,/文本编辑器/);assert.match(f.document.body.textContent,/桌面应用/);assert.equal(f.document.querySelector('[data-editor-choose]').disabled,true);assert.equal(f.calls.length,0);f.ui.dispose();
});
test('native editor opens only safe cached text with a fixed Notepad or picked editor, never a shell or file association',()=>{
 const source=fs.readFileSync(new URL('../src-tauri/src/text_editor.rs',import.meta.url),'utf8');assert.match(source,/window\.label\(\) == "main"/);assert.match(source,/127\.0\.0\.1:4317\/api\/files\/\{file_id\}/);assert.match(source,/no_proxy\(\)\.redirect\(reqwest::redirect::Policy::none\(\)\)/);assert.match(source,/Command::new\(executable\)\.arg\(target\)/);assert.doesNotMatch(source,/cmd\s*\/c|powershell|opener\(\)|open_path|shell_execute/i);assert.match(source,/join\("System32"\)\.join\("notepad.exe"\)/);assert.match(source,/text_payload\(&bytes/);assert.match(source,/Sha256::digest/);assert.match(source,/create_new\(true\)/);assert.match(source,/file_attributes\(\) & 0x400/);assert.match(source,/3 \* 24 \* 60 \* 60/);assert.match(source,/Preserve a user's edits/);
});
