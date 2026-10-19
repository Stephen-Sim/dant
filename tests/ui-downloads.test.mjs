import {sourceIndex} from './source-fixtures.mjs';
import {languageContext} from './language-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {attachmentName,createDownloads} from '../ui/downloads.js';
import {canPreviewFile} from '../ui/file-preview.js';

const id='10b72b2a-346f-48c0-a243-1cb22871d91d',token='a'.repeat(64),file={id,name:'tetrio-run.json',type:'application/json'};
const png=Uint8Array.from([137,80,78,71,13,10,26,10]);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(options={}){
 const {document,Event}=parseHTML('<html><body><section class="dialog"><button type="button" data-download="'+id+'">Save</button><button type="button" id="close">Close</button><img id="preview" src="original-preview"></section></body></html>');
 const calls=[],blobs=[],revoked=[],clicked=[],timers=new Map(),listeners=new Map();let sequence=0;
 const window={location:{href:'tauri://localhost/'},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
 const create=document.createElement.bind(document);document.createElement=name=>{const node=create(name);if(name==='a')node.click=()=>clicked.push({href:node.href,name:node.download,connected:node.isConnected});return node;};
 const downloads=createDownloads({desktop:false,document,window,getToken:()=>token,fetchImpl:async(url,opts)=>{calls.push({url,opts});return new Response(png,{headers:{'content-type':'image/png'}});},URLImpl:{createObjectURL:blob=>{blobs.push(blob);return 'blob:download-'+blobs.length;},revokeObjectURL:url=>revoked.push(url)},schedule:(fn,ms)=>{const handle=++sequence;timers.set(handle,{fn,ms});return handle;},cancel:handle=>timers.delete(handle),...options});
 return {downloads,document,Event,window,calls,blobs,revoked,clicked,timers,listeners};
}
const safeFailure=error=>error.code==='download_failed'&&!/private|secret|token/i.test(error.message);

test('desktop save uses direct native IPC and preserves the original image preview and its close control',async()=>{
 const wait=deferred(),invocations=[],f=fixture({desktop:true,loadCore:async()=>({invoke:(command,args)=>{invocations.push({command,args});return wait.promise;}})}),dialog=f.document.querySelector('.dialog'),image=f.document.querySelector('#preview'),button=f.document.querySelector('[data-download]');
 f.document.querySelector('#close').onclick=()=>dialog.remove();f.downloads.bind(()=>({...file,name:'tetrio-live.png'}),()=>assert.fail('No failure expected'));
 const event=new f.Event('click',{bubbles:true,cancelable:true}),saving=button.onclick(event);await settle();
 assert.equal(event.defaultPrevented,true);assert.equal(f.window.location.href,'tauri://localhost/');assert.equal(f.document.querySelector('.dialog'),dialog);assert.equal(f.document.querySelector('#preview'),image);assert.equal(image.getAttribute('src'),'original-preview');assert.equal(button.disabled,true);
 assert.deepEqual(invocations,[{command:'save_attachment',args:{fileId:id,token,fileName:'tetrio-live.png'}}]);assert.equal(f.calls.length,0);assert.equal(f.clicked.length,0);
 wait.resolve(true);await saving;assert.equal(button.disabled,false);assert.equal(f.document.querySelector('.dialog'),dialog);f.document.querySelector('#close').onclick();assert.equal(f.document.querySelector('.dialog'),null);f.downloads.dispose();
});

test('native cancellation is quiet, duplicate saves share one dialog, and private native errors are hidden',async()=>{
 let invocations=0;const wait=deferred(),f=fixture({desktop:true,loadCore:async()=>({invoke:()=>{invocations++;return wait.promise;}})});
 const first=f.downloads.save(file),second=f.downloads.save(file);assert.equal(first,second);await settle();assert.equal(invocations,1);wait.resolve(false);assert.deepEqual(await first,{saved:false});
 f.downloads.dispose();await assert.rejects(f.downloads.save(file),safeFailure);
 for(const invoke of [async()=>{throw Error('private path and secret');},async()=>({saved:true})]){const bad=fixture({desktop:true,loadCore:async()=>({invoke})});await assert.rejects(bad.downloads.save(file),safeFailure);bad.downloads.dispose();}
});

test('browser saves fetch authenticated original bytes into a Blob without navigating the preview',async()=>{
 for(const [name,type,data]of [['tetrio-live.png','image/png',png],['tetrio-run.json','application/json',new TextEncoder().encode('{"result":true}')]]){
  const f=fixture({fetchImpl:async(url,opts)=>{f.calls.push({url,opts});return new Response(data,{headers:{'content-type':type}});}}),dialog=f.document.querySelector('.dialog');
  assert.deepEqual(await f.downloads.save({...file,name,type}),{saved:true});assert.equal(f.calls[0].url,'/api/files/'+id+'?download=1');assert.equal(f.calls[0].opts.headers['X-Dant-Token'],token);assert.equal(f.calls[0].opts.redirect,'error');assert.equal(f.calls[0].opts.credentials,'omit');
  assert.deepEqual(new Uint8Array(await f.blobs[0].arrayBuffer()),data);assert.equal(f.blobs[0].type,type);assert.deepEqual(f.clicked,[{href:'blob:download-1',name,connected:true}]);assert.equal(f.document.querySelector('a'),null);assert.equal(f.document.querySelector('.dialog'),dialog);assert.equal(f.window.location.href,'tauri://localhost/');
  assert.deepEqual(f.revoked,[]);for(const timer of [...f.timers.values()])if(timer.ms===1000)timer.fn();assert.deepEqual(f.revoked,['blob:download-1']);f.downloads.dispose();
 }
});

test('browser body, HTTP, redirect, and size failures create no download and expose fixed safe errors',async()=>{
 const cases=[
  async()=>new Response('private body',{status:401}),
  async()=>({ok:true,redirected:true,headers:new Headers()}),
  async()=>new Response('x',{headers:{'content-length':String(10*1024*1024+1)}}),
  async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(10*1024*1024));controller.enqueue(Uint8Array.of(1));controller.close();}})),
  async()=>new Response(new ReadableStream({start(controller){controller.error(Error('private body failure'));}})),
  async()=>({ok:true,redirected:false,headers:new Headers(),body:null}),
  async()=>{throw Error('secret connection failure');},
 ];
 for(const fetchImpl of cases){const f=fixture({fetchImpl});await assert.rejects(f.downloads.save(file),safeFailure);assert.equal(f.blobs.length,0);assert.equal(f.clicked.length,0);f.downloads.dispose();}
});

test('timeouts and disposal abort browser requests and release all owned object URLs',async()=>{
 const f=fixture({fetchImpl:(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private abort')),{once:true}))}),pending=f.downloads.save(file),failure=assert.rejects(pending,safeFailure);
 for(const timer of [...f.timers.values()])if(timer.ms===60000)timer.fn();await failure;assert.equal(f.timers.size,0);f.downloads.dispose();
 const g=fixture({fetchImpl:(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private disposal')),{once:true}))}),request=g.downloads.save(file),closed=assert.rejects(request,safeFailure);g.downloads.dispose();await closed;
 const h=fixture();await h.downloads.save(file);h.downloads.dispose();h.downloads.dispose();assert.deepEqual(h.revoked,['blob:download-1']);assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);
});

test('unloaded UI cannot invoke a late-loaded native helper, and malformed file IDs or auth never reach the network',async()=>{
 const wait=deferred();let invoked=0;const f=fixture({desktop:true,loadCore:()=>wait.promise}),pending=f.downloads.save(file),failure=assert.rejects(pending,safeFailure);f.downloads.dispose();wait.resolve({invoke:()=>{invoked++;}});await failure;assert.equal(invoked,0);
 for(const options of [{getToken:()=>''},{getToken:()=>token+'\r\n'},{base:'https://outside.test'}]){const g=fixture(options);await assert.rejects(g.downloads.save(file),safeFailure);assert.equal(g.calls.length,0);g.downloads.dispose();}
 const g=fixture();for(const item of [null,{}, {...file,id:'../private'},{...file,id:'https://outside.test'}])await assert.rejects(g.downloads.save(item),safeFailure);assert.equal(g.calls.length,0);g.downloads.dispose();
});

test('default file names remove path/control characters and preserve PNG or JSON extensions when shortened',()=>{
 assert.equal(attachmentName('../tetrio-run.json'),'tetrio-run.json');assert.equal(attachmentName('C:\\private\\tetrio-live.png'),'tetrio-live.png');assert.equal(attachmentName('中文截图.png'),'中文截图.png');assert.equal(attachmentName('CON .txt'),'_CON .txt');assert.equal(attachmentName('\0<>:"|?*'),'download');
 for(const extension of ['.png','.json']){const name=attachmentName('a'.repeat(240)+extension);assert.equal(name.length,180);assert.ok(name.endsWith(extension));}assert.equal(attachmentName('📷'.repeat(200)+'.png').endsWith('.png'),true);
});

test('binding reports failure without replacing the current dialog or opening any URL',async()=>{
 const errors=[],f=fixture({desktop:true,loadCore:async()=>({invoke:async()=>{throw Error('private path');}})}),button=f.document.querySelector('[data-download]'),dialog=f.document.querySelector('.dialog');f.downloads.bind(()=>file,error=>errors.push(error));await button.onclick(new f.Event('click',{cancelable:true}));assert.equal(errors.length,1);assert.equal(errors[0].code,'download_failed');assert.equal(button.disabled,false);assert.equal(f.document.querySelector('.dialog'),dialog);assert.equal(f.clicked.length,0);f.downloads.dispose();
});

test('all app attachment download affordances are buttons and image preview remains independently closable',()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),attachment=source.slice(sourceIndex(source,'function renderAttachment(file){'),sourceIndex(source,'function renderMessages(){')),modal=source.slice(sourceIndex(source,'function renderModal(){'),sourceIndex(source,'function bind(){'));
 const {document}=parseHTML('<html><body></body></html>'),context={canPreviewFile,language:()=>'en',base:'',token:'token',fileURL:()=>'/original-inline-image',esc:value=>String(value),ico:name=>`<svg data-icon="${name}"></svg>`,t:value=>value,button:(action,icon,label)=>`<button type="button" data-action="${action}">${label}</button>`,modal:{type:'image',fileId:id},managedSettings:{renderModal:()=>null},chatHistory:{renderModal:()=>null},conversationFiles:()=>[{...file,type:'image/png',name:'tetrio-live.png'}]};
 vm.createContext(Object.assign(context,languageContext));vm.runInContext(attachment+modal,context);document.body.innerHTML=context.renderModal();const download=document.querySelector('[data-download]');assert.equal(download.tagName,'BUTTON');assert.equal(download.getAttribute('href'),null);assert.equal(download.getAttribute('type'),'button');assert.ok(document.querySelector('[data-action="close-modal"]'));assert.equal(document.querySelector('img').getAttribute('src'),'/original-inline-image');
 document.body.innerHTML=context.renderAttachment(file);assert.equal(document.querySelector('.file-card').tagName,'BUTTON');assert.equal(document.querySelector('.file-card').getAttribute('data-file-preview'),id);assert.equal(document.querySelector('[data-download]').tagName,'BUTTON');assert.equal(document.querySelector('[data-download]').getAttribute('data-download'),id);assert.equal(document.querySelector('a'),null);assert.doesNotMatch(modal,/<a[^>]+download=/);assert.match(source,/downloads\.bind\(id=>conversationFiles\(\)\.find/);
});
