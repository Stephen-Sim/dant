import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {bindAttachmentImages} from '../ui/attachment-images.js';
import {canPreviewFile} from '../ui/file-preview.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
function fixture(language='en'){
 const {document}=parseHTML('<main></main>'),context={canPreviewFile,language:()=>language,fileURL:file=>'/api/files/'+file.id+'?token=fixture',esc:value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),ico:name=>`<svg data-icon="${name}"></svg>`,t:value=>value};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function renderAttachment(file){'),source.indexOf('function renderMessages(){')),context);
 return {document,render(files){document.querySelector('main').innerHTML=context.renderAttachments(files);return document.querySelector('main');},context};
}
const imageFile={id:'image',name:'tetrio-live.png',type:'image/png',size:300000},textFile={id:'report',name:'tetrio-2026-10-17T14-26-55.997Z.json',type:'application/json',size:1024};
function dimensions(image,{complete=false,width=0,height=0}={}){
 Object.defineProperties(image,{complete:{configurable:true,value:complete},naturalWidth:{configurable:true,value:width},naturalHeight:{configurable:true,value:height}});
}

test('mixed attachments share a list and file controls stay inside one card with the full filename',()=>{
 const {render}=fixture(),root=render([imageFile,textFile,{...imageFile,id:'crop'}]),list=root.querySelector('.attachment-list');
 assert.equal(list.children.length,3);assert.ok(list.classList.contains('attachment-list-wide'));
 const card=list.children[1],view=card.querySelector('[data-file-preview]'),download=card.querySelector('[data-download]');
 assert.equal(card.className,'file-attachment');assert.equal(view.tagName,'BUTTON');assert.equal(view.querySelector('.file-attachment-name').textContent,textFile.name);assert.equal(view.querySelector('.file-view-label').textContent,'View');assert.equal(download.parentNode,card);assert.equal(download.tagName,'BUTTON');assert.equal(download.hasAttribute('href'),false);assert.equal(download.getAttribute('data-download'),textFile.id);assert.equal(root.querySelector('a'),null);
});

test('slow images reserve space and hide the broken-image alt representation until a valid load',()=>{
 const {render}=fixture('zh'),root=render([imageFile]),image=root.querySelector('img'),card=image.parentNode;
 assert.equal(card.dataset.imageState,'loading');assert.equal(card.getAttribute('aria-busy'),'true');assert.equal(image.getAttribute('loading'),'lazy');assert.equal(image.getAttribute('decoding'),'async');assert.equal(card.querySelector('.attachment-image-loading').textContent,'正在加载图片…');
 dimensions(image);bindAttachmentImages(root);assert.equal(card.dataset.imageState,'loading');
 dimensions(image,{complete:true,width:1440,height:900});image.onload();assert.equal(card.dataset.imageState,'ready');assert.equal(card.getAttribute('aria-busy'),'false');assert.equal(card.style.getPropertyValue('--attachment-width'),'432px');assert.equal(card.style.getPropertyValue('--attachment-ratio'),'1440 / 900');
});

test('portrait and small images retain their proportions and are never expanded beyond their source size',()=>{
 for(const [width,height,expected]of [[300,600,'135px'],[100,60,'100px'],[1920,1080,'440px']]){
  const {render}=fixture(),root=render([imageFile]),image=root.querySelector('img');dimensions(image,{complete:true,width,height});bindAttachmentImages(root);assert.equal(image.parentNode.style.getPropertyValue('--attachment-width'),expected);assert.equal(image.parentNode.dataset.imageState,'ready');
 }
});

test('failed and invalid image loads show a stable error card without replacing or navigating the preview button',()=>{
 const {render}=fixture(),root=render([imageFile]),image=root.querySelector('img'),card=image.parentNode;dimensions(image);bindAttachmentImages(root);image.onerror();assert.equal(card.dataset.imageState,'error');assert.equal(card.getAttribute('aria-busy'),'false');assert.equal(card.querySelector('.attachment-image-error').textContent,'Image unavailable');assert.equal(card.dataset.preview,'image');assert.equal(card.hasAttribute('href'),false);
 dimensions(image,{complete:true,width:120,height:0});bindAttachmentImages(root);assert.equal(card.dataset.imageState,'error');image.onload();assert.equal(card.dataset.imageState,'error');
});

test('reconciliation preserves image and audio nodes and restores loaded state without changing the source',()=>{
 const {render,document,context}=fixture(),files=[imageFile,{id:'voice',name:'Voice.webm',type:'audio/webm'}],root=render(files),image=root.querySelector('img'),audio=root.querySelector('audio');dimensions(image,{complete:true,width:1440,height:900});bindAttachmentImages(root);const originalURL=image.getAttribute('src');
 const next=document.createElement('main');next.innerHTML=context.renderAttachments(files);reconcile(root,next);bindAttachmentImages(root);
 assert.equal(root.querySelector('img'),image);assert.equal(root.querySelector('audio'),audio);assert.equal(image.getAttribute('src'),originalURL);assert.equal(image.parentNode.dataset.imageState,'ready');assert.equal(audio.getAttribute('controls'),'');assert.equal(audio.getAttribute('preload'),'metadata');
});

test('an offline or connecting image failure retries the same node and URL once when its connection is ready',()=>{
 const {render,document,context}=fixture(),root=render([imageFile]),image=root.querySelector('img'),card=image.parentNode,url=image.getAttribute('src'),scope='same-vm-and-conversation',set=image.setAttribute.bind(image),remove=image.removeAttribute.bind(image),loads=[];
 image.setAttribute=(name,value)=>{if(name==='src')loads.push(value);return set(name,value);};image.removeAttribute=name=>{if(name==='src')loads.push(null);return remove(name);};dimensions(image);bindAttachmentImages(root,{ready:false,scope});const oldLoad=image.onload,oldError=image.onerror;image.onerror();assert.equal(card.dataset.imageState,'error');
 for(let index=0;index<3;index++){const next=document.createElement('main');next.innerHTML=context.renderAttachments([imageFile]);reconcile(root,next);bindAttachmentImages(root,{ready:false,scope});}assert.deepEqual(loads,[]);
 bindAttachmentImages(root,{ready:true,scope});assert.equal(root.querySelector('img'),image);assert.equal(image.getAttribute('src'),url);assert.deepEqual(loads,[null,url]);assert.equal(card.dataset.imageState,'loading');assert.equal(card.getAttribute('aria-busy'),'true');dimensions(image,{complete:true,width:1440,height:900});oldLoad();oldError();assert.equal(card.dataset.imageState,'loading','late callbacks from the offline attempt cannot settle its replacement');image.onload();assert.equal(card.dataset.imageState,'ready');
 for(let index=0;index<5;index++)bindAttachmentImages(root,{ready:true,scope});bindAttachmentImages(root,{ready:false,scope});bindAttachmentImages(root,{ready:true,scope});assert.deepEqual(loads,[null,url],'successful cached images survive further connection changes');assert.equal(card.dataset.imageState,'ready');assert.equal(card.dataset.preview,'image');assert.equal(card.hasAttribute('href'),false);
});

test('pending offline loads also recover, but a rejected retry never loops on state refreshes',()=>{
 const {render}=fixture(),root=render([imageFile]),image=root.querySelector('img'),set=image.setAttribute.bind(image),loads=[];image.setAttribute=(name,value)=>{if(name==='src')loads.push(value);return set(name,value);};dimensions(image);bindAttachmentImages(root,{ready:false,scope:'same'});bindAttachmentImages(root,{ready:true,scope:'same'});assert.equal(loads.length,1);assert.equal(image.parentNode.dataset.imageState,'loading');image.onerror();
 for(let index=0;index<20;index++)bindAttachmentImages(root,{ready:true,scope:'same'});assert.equal(loads.length,1);assert.equal(image.parentNode.dataset.imageState,'error');bindAttachmentImages(root,{ready:false,scope:'same'});for(let index=0;index<20;index++)bindAttachmentImages(root,{ready:false,scope:'same'});assert.equal(loads.length,1);bindAttachmentImages(root,{ready:true,scope:'same'});assert.equal(loads.length,2,'a separate confirmed reconnect permits one new read');
});

test('changed image URLs and VM scopes reject stale events and never retry an old URL in another context',()=>{
 const {render}=fixture(),root=render([imageFile]),image=root.querySelector('img'),card=image.parentNode,set=image.setAttribute.bind(image),loads=[];image.setAttribute=(name,value)=>{if(name==='src')loads.push(value);return set(name,value);};dimensions(image);bindAttachmentImages(root,{ready:false,scope:'vm-a'});const firstLoad=image.onload,firstError=image.onerror;image.onerror();bindAttachmentImages(root,{ready:false,scope:'vm-b'});bindAttachmentImages(root,{ready:true,scope:'vm-b'});assert.equal(loads.length,0);dimensions(image,{complete:true,width:300,height:600});firstLoad();firstError();image.onload();assert.equal(card.dataset.imageState,'error');assert.equal(card.style.getPropertyValue('--attachment-ratio'),'');
 image.setAttribute('src','/api/files/current-vm-file?token=fixture');bindAttachmentImages(root,{ready:true,scope:'vm-b'});assert.equal(loads.length,1,'a current source URL is not sent a second time');assert.equal(card.dataset.imageState,'loading','old decoded dimensions never represent the changed URL');firstLoad();assert.equal(card.dataset.imageState,'loading');const currentLoad=image.onload;dimensions(image,{complete:true,width:200,height:100});image.onload();assert.equal(card.dataset.imageState,'ready');assert.equal(card.style.getPropertyValue('--attachment-ratio'),'200 / 100');
 image.setAttribute('src','/api/files/newer-source?token=fixture');currentLoad();assert.equal(card.dataset.imageState,'ready','a callback from another URL cannot update the current card');bindAttachmentImages(root,{ready:true,scope:'vm-b'});assert.equal(card.dataset.imageState,'loading');const detached=image.onload;root.replaceChildren();detached();assert.equal(card.dataset.imageState,'loading','detached images cannot be updated by an old response');
});

test('audio-only attachments keep their existing compact width and non-preview files still download explicitly',()=>{
 const {render}=fixture(),audio=render([{id:'voice',name:'voice.webm',type:'audio/webm'}]);assert.equal(audio.querySelector('.attachment-list').classList.contains('attachment-list-wide'),false);
 const root=render([{id:'binary',name:'archive.zip',type:'application/zip',size:2048}]);assert.equal(root.querySelector('[data-file-preview]'),null);assert.equal(root.querySelector('.file-card').dataset.download,'binary');assert.equal(root.querySelector('.file-attachment-name').textContent,'archive.zip');assert.equal(root.querySelector('.file-view-label'),null);
 assert.equal(render([]).children.length,0);assert.equal(render(undefined).children.length,0);
});

test('long text and binary filenames share consistent metadata without losing their full name or actions',()=>{
 const {render}=fixture('zh'),files=[
  {...textFile,name:'tetrio-2026-10-17T15-43-29.987Z-"final".json'},
  {id:'pixels',name:'tetrio-2026-10-17T15-43-29.987Z.ppm',type:'application/octet-stream',size:841728},
  {id:'archive',name:'tetrio-2026-10-17T15-44-08.732Z.zip',type:'application/zip',size:4096},
  {id:'notes',name:'README',type:'text/plain',size:52}
 ];
 const root=render(files),cards=[...root.querySelectorAll('.file-attachment')];
 assert.equal(cards.length,4);
 for(const [index,card]of cards.entries()){
  const file=files[index],primary=card.querySelector('.file-card'),name=primary.querySelector('.file-attachment-name'),download=card.querySelector('.file-download');
  assert.equal(name.textContent,file.name);assert.equal(name.getAttribute('title'),file.name);
  assert.ok(primary.getAttribute('aria-label').endsWith(file.name));assert.ok(download.getAttribute('aria-label').endsWith(file.name));assert.equal(download.getAttribute('title'),download.getAttribute('aria-label'));
  assert.equal(primary.parentNode,card);assert.equal(download.parentNode,card);assert.equal(card.children.length,2);assert.equal(primary.querySelectorAll('small').length,1);
  assert.equal(primary.querySelector('.file-attachment-meta').textContent,['JSON · 1 KB','PPM · 822 KB','ZIP · 4 KB','1 KB'][index]);
  assert.equal(primary.getAttribute(index===0||index===3?'data-file-preview':'data-download'),file.id);
 }
 assert.equal(cards[0].querySelector('.file-view-label').textContent,'查看');assert.equal(cards[1].querySelector('.file-view-label'),null);assert.equal(root.querySelector('a'),null);
});

test('attachment spacing and file actions have bounded responsive layout rules',()=>{
 const css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');assert.match(css,/\.attachment-list\{[^}]*flex-direction:column[^}]*gap:8px[^}]*max-width:100%/);assert.match(css,/\.attachment-list-wide\{width:440px\}/);assert.match(css,/\.file-card>\.file-view-label\{[^}]*flex:0 0 auto/);assert.match(css,/\.file-attachment\{[^}]*width:100%[^}]*min-height:64px[^}]*border:1px/);assert.match(css,/\.file-attachment-name\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/);assert.match(css,/\.attachment-list>\.image-attachment\{[^}]*aspect-ratio:var\(--attachment-ratio,16 \/ 10\)/);assert.match(css,/\.attachment-list \.attachment-image\{[^}]*opacity:0/);assert.match(css,/\[data-image-state="ready"\] \.attachment-image\{opacity:1\}/);
});
