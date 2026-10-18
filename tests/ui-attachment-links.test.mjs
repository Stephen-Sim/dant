import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';
import {bindMessageAttachmentLink,resolveMessageAttachmentLink} from '../ui/attachment-links.js';

const image={id:'image',name:'result.png',type:'image/png',sourcePath:'/home/dant/workspaces/task/output/result.png'};
test('message local links resolve only exact archived sources and explicit output-relative references',()=>{
 for(const href of [image.sourcePath,'file://'+image.sourcePath,'sandbox:'+image.sourcePath,'output/result.png','./output/result.png'])assert.equal(resolveMessageAttachmentLink(href,[image]).file,image,href);
 const nested={...image,sourcePath:'/home/dant/workspaces/task/output/screens/截图 1.png'};
 for(const href of [nested.sourcePath,encodeURI(nested.sourcePath),'output/screens/%E6%88%AA%E5%9B%BE%201.png'])assert.equal(resolveMessageAttachmentLink(href,[nested]).file,nested);
 const percent={...image,sourcePath:'/home/dant/workspaces/task/output/100%20.png'};
 assert.equal(resolveMessageAttachmentLink('/home/dant/workspaces/task/output/100%2520.png',[percent]).file,percent,'stored source paths are not URI decoded twice');
 const windows={...image,sourcePath:'C:\\dant\\workspace\\output\\result.png'};assert.equal(resolveMessageAttachmentLink('C:/dant/workspace/output/result.png',[windows]).file,windows);
});

test('unmatched, ambiguous and traversal paths never guess a same-named attachment',()=>{
 for(const href of ['/etc/passwd','/different/result.png','result.png','output/../result.png','./output/./result.png','output//result.png','../output/result.png',image.sourcePath+'?download=1',image.sourcePath+'#fragment','/home/dant/%zz','file://other-host'+image.sourcePath,'attachment:missing','/home/dant/%00result.png','/home/dant/\nresult.png'])assert.deepEqual(resolveMessageAttachmentLink(href,[image]),{local:true,file:null},href);
 assert.equal(resolveMessageAttachmentLink(image.sourcePath,[{...image,sourcePath:undefined}]).file,null);
 assert.equal(resolveMessageAttachmentLink(image.sourcePath,[image,{...image,id:'different-snapshot'}]).file,null);
 assert.equal(resolveMessageAttachmentLink('output/result.png',[image,{...image,id:'other',sourcePath:'/other/task/output/result.png'}]).file,null,'different output roots are ambiguous');
 assert.equal(resolveMessageAttachmentLink(image.sourcePath,[]).file,null);
 assert.equal(resolveMessageAttachmentLink(image.sourcePath,[{...image,id:null}]).file,null);
 assert.equal(resolveMessageAttachmentLink(image.sourcePath,[{...image,sourcePath:'relative/result.png'}]).file,null);
});

test('ordinary external and fragment links retain the existing external-link behavior',()=>{
 for(const href of ['https://example.com/result.png','http://example.com/','mailto:example@example.com','tel:123','#heading','//example.com/image.png','',null,'section'])assert.deepEqual(resolveMessageAttachmentLink(href,[image]),{local:false,file:null});
});

function fixture({href=image.sourcePath,files=[image],message=true}={}){
 const {document}=parseHTML(`<article ${message?'class="message" data-id="reply"':''}><div class="markdown"><a target="_blank" rel="noopener">Screenshot</a></div></article>`),link=document.querySelector('a'),calls=[],messages=new Map([['reply',{id:'reply',attachments:files}]]);link.setAttribute('href',href);
 const options={getMessage:id=>messages.get(id),onImage:file=>calls.push(['image',file.id]),onFile:file=>calls.push(['file',file.id]),onDownload:file=>calls.push(['download',file.id]),onUnavailable:()=>calls.push(['unavailable']),onError:()=>calls.push(['error'])};
 const click=()=>{const event={preventDefault(){calls.push(['prevent']);},stopPropagation(){calls.push(['stop']);}};(document.querySelector('button')||link).onclick?.(event);};return {document,link,calls,messages,options,click};
}

test('archived local screenshot links open the existing image viewer without external navigation',()=>{
 const f=fixture();assert.equal(bindMessageAttachmentLink(f.link,f.options),true);const button=f.document.querySelector('.attachment-link');assert.equal(button.tagName,'BUTTON');assert.equal(button.type,'button');assert.equal(f.document.querySelector('a'),null);assert.equal(button.hasAttribute('href'),false);f.click();assert.deepEqual(f.calls,[['prevent'],['stop'],['image','image']]);assert.equal(button.textContent,'Screenshot');
});

test('local document links use the existing text preview and other files download explicitly',()=>{
 for(const [type,name,expected]of [['application/json','result.json','file'],['application/zip','result.zip','download']]){
  const file={...image,type,name},f=fixture({files:[file]});bindMessageAttachmentLink(f.link,f.options);f.click();assert.deepEqual(f.calls.at(-1),[expected,image.id]);
 }
});

test('attachment lookup is same-message and rechecked at click time after message changes',()=>{
 const f=fixture();bindMessageAttachmentLink(f.link,f.options);f.messages.set('reply',{id:'reply',attachments:[]});f.click();assert.deepEqual(f.calls.at(-1),['unavailable']);assert.equal(f.calls.some(call=>call[0]==='image'),false);
 const unrelated=fixture({message:false});assert.equal(bindMessageAttachmentLink(unrelated.link,unrelated.options),false);assert.equal(unrelated.link.onclick,null);
 const external=fixture({href:'https://example.com/image.png'});assert.equal(bindMessageAttachmentLink(external.link,external.options),false);assert.equal(external.link.getAttribute('target'),'_blank');
});

test('unavailable local links explain the missing delivery and viewer errors are handled',async()=>{
 const missing=fixture({files:[]});assert.equal(bindMessageAttachmentLink(missing.link,missing.options),true);missing.click();assert.deepEqual(missing.calls.at(-1),['unavailable']);
 for(const onImage of [()=>{throw Error('unavailable');},()=>Promise.reject(Error('unavailable'))]){const f=fixture();bindMessageAttachmentLink(f.link,{...f.options,onImage});f.click();await Promise.resolve();assert.deepEqual(f.calls.at(-1),['error']);}
});

test('chat binding routes only matched archived files and provides both language hints',()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');assert.match(source,/bindMessageAttachmentLink\(link,\{getMessage:id=>state\.messages\.find/);assert.match(source,/onImage:file=>openModal\(\{type:'image',fileId:file\.id\}\)/);assert.match(source,/onFile:file=>filePreview\.open\(file\)/);assert.match(source,/onDownload:file=>downloads\.save\(file\)/);assert.match(source,/本地文件尚未作为附件交付/);assert.match(source,/This local file has not been delivered as an attachment/);
});
