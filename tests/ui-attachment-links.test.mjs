import {sourceIndex} from './source-fixtures.mjs';
import {languageContext} from './language-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
 const {document}=parseHTML(`<article ${message?'class="message" data-id="reply"':''}><div class="markdown"><a target="_blank" rel="noopener">Screenshot</a></div></article>`),link=document.querySelector('a'),calls=[],messages=new Map([['reply',{id:'reply',text:'Saved screenshot',attachments:files}]]);link.setAttribute('href',href);
 const options={getMessage:id=>messages.get(id),onImage:file=>calls.push(['image',file.id]),onFile:file=>calls.push(['file',file.id]),onDownload:file=>calls.push(['download',file.id]),onUnavailable:()=>calls.push(['unavailable']),onError:()=>calls.push(['error'])};
 const click=()=>{const event={preventDefault(){calls.push(['prevent']);},stopPropagation(){calls.push(['stop']);}};return(document.querySelector('button')||link).onclick?.(event);};return {document,link,calls,messages,options,click};
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

test('chat binding scopes recovery and preserves the normal viewer, download and bilingual unavailable handlers',()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');assert.match(source,/bindMessageAttachmentLink\(link,\{getMessage:id=>state\.messages\.find/);assert.match(source,/onResolve:resolveMessageOutputLink,getScope:outputLinkScope,getModal:\(\)=>modal/);assert.match(source,/onImage:file=>openModal\(\{type:'image',fileId:file\.id\}\)/);assert.match(source,/onFile:file=>filePreview\.open\(file\)/);assert.match(source,/onDownload:file=>downloads\.save\(file\)/);assert.match(source,/这个本地文件暂时无法恢复/);assert.match(source,/This local file could not be restored/);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
test('missing local links recover once under rapid clicks and use existing image, text and download actions',async()=>{
 for(const [type,name,action]of [['image/png','restored.png','image'],['text/plain','restored.txt','file'],['application/zip','restored.zip','download']]){
  const f=fixture({files:[]}),wait=deferred(),requests=[];bindMessageAttachmentLink(f.link,{...f.options,onResolve:input=>{requests.push(input);return wait.promise;}});
  const first=f.click(),second=f.click(),button=f.document.querySelector('button');assert.equal(first,second);assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-busy'),'true');await Promise.resolve();assert.deepEqual(requests,[{messageId:'reply',href:image.sourcePath}]);wait.resolve({...image,id:'restored',type,name});await first;assert.deepEqual(f.calls.filter(call=>['image','file','download'].includes(call[0])),[[action,'restored']]);assert.equal(button.disabled,false);assert.equal(button.hasAttribute('aria-busy'),false);
 }
});

test('recovery callbacks cannot replace another modal or act after a conversation, page, VM or message change',async()=>{
 for(const change of ['scope','modal','text','deleted']){
  const f=fixture({files:[]}),wait=deferred();let scope='vm-a/conversation/chat',modal=null;bindMessageAttachmentLink(f.link,{...f.options,getScope:()=>scope,getModal:()=>modal,onResolve:()=>wait.promise});const pending=f.click();await Promise.resolve();
  if(change==='scope')scope='vm-b/conversation/settings';else if(change==='modal')modal={type:'another-image'};else if(change==='text')f.messages.get('reply').text='different source';else f.messages.delete('reply');wait.resolve(image);await pending;assert.deepEqual(f.calls,[['prevent'],['stop']],change);
 }
 for(const rejected of [false,true]){
  const f=fixture({files:[]}),wait=deferred();let scope='original';bindMessageAttachmentLink(f.link,{...f.options,getScope:()=>scope,onResolve:()=>wait.promise});const pending=f.click();await Promise.resolve();scope='different';if(rejected)wait.reject(Error('late failure'));else wait.resolve(null);await pending;assert.deepEqual(f.calls,[['prevent'],['stop']]);
 }
});

test('a scope change before asynchronous recovery dispatch makes no request to the next work computer',async()=>{
 const f=fixture({files:[]});let scope='vm-a',requests=0;bindMessageAttachmentLink(f.link,{...f.options,getScope:()=>scope,onResolve:()=>{requests++;return image;}});const pending=f.click();scope='vm-b';await pending;assert.equal(requests,0);assert.deepEqual(f.calls,[['prevent'],['stop']]);
});

test('current recovery failures are reported and can be retried without leaving a disabled link',async()=>{
 const f=fixture({files:[]});let requests=0;bindMessageAttachmentLink(f.link,{...f.options,onResolve:()=>{requests++;if(requests===1)throw Error('unavailable');return null;}});await f.click();assert.deepEqual(f.calls.at(-1),['error']);assert.equal(f.document.querySelector('button').disabled,false);await f.click();assert.equal(requests,2);assert.deepEqual(f.calls.at(-1),['unavailable']);
});

function mainRecoveryFixture(){
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),pending=[],context={state:{conversationId:'conversation-a',settings:{vm:{host:'vm-a',user:'dant',port:22,keyPath:'fixture-key'}},controller:{status:'online',cached:false},messages:[{id:'reply',role:'assistant',text:'Saved screenshot',attachments:[{id:'older'}]}]},page:'chat',eventConnected:true,language:()=> 'en',renders:0,render:()=>{context.renders++;},post:(route,body)=>{const wait=deferred();pending.push({route,body,...wait});return wait.promise;}};
 vm.createContext(Object.assign(context,languageContext));vm.runInContext(source.slice(sourceIndex(source,'const outputLinkRecoveries=new Map();'),sourceIndex(source,'function renderProgress(){')),context);return {context,pending,resolve:()=>context.resolveMessageOutputLink({messageId:'reply',href:image.sourcePath}),result:()=>({conversationId:'conversation-a',messageId:'reply',attachment:image})};
}

test('main coalesces requests across replaced link nodes and adds only the restored attachment to that assistant message',async()=>{
 const f=mainRecoveryFixture(),first=f.resolve(),second=f.resolve();assert.equal(first,second);assert.equal(f.pending.length,1);assert.equal(f.pending[0].route,'/messages/reply/output-link/resolve');assert.deepEqual(JSON.parse(JSON.stringify(f.pending[0].body)),{conversationId:'conversation-a',href:image.sourcePath});f.pending[0].resolve(f.result());assert.equal(await first,image);assert.deepEqual(Array.from(f.context.state.messages[0].attachments,file=>file.id),['older','image']);assert.equal(f.context.renders,1);
 const third=f.resolve();assert.equal(f.pending.length,2);f.pending[1].resolve(f.result());await third;assert.equal(f.context.state.messages[0].attachments.length,2);
});

test('main discards recovery responses from an old conversation, VM, page or source message',async()=>{
 for(const change of ['conversation','host','user','port','keyPath','page','message','response']){
  const f=mainRecoveryFixture(),pending=f.resolve();if(change==='conversation')f.context.state.conversationId='conversation-b';else if(['host','user','port','keyPath'].includes(change))f.context.state.settings.vm[change]='different';else if(change==='page')f.context.page='settings';else if(change==='message')f.context.state.messages[0].text='edited';const response=f.result();if(change==='response')response.messageId='other';f.pending[0].resolve(response);assert.equal(await pending,null,change);assert.deepEqual(f.context.state.messages[0].attachments.map(file=>file.id),['older']);assert.equal(f.context.renders,0);
 }
});

test('main rejects offline, cached and non-assistant recovery without posting and permits retry after a rejected request',async()=>{
 for(const change of ['offline','cached','controller','user']){
  const f=mainRecoveryFixture();if(change==='offline')f.context.eventConnected=false;else if(change==='cached')f.context.state.controller.cached=true;else if(change==='controller')f.context.state.controller.status='connecting';else f.context.state.messages[0].role='user';await assert.rejects(f.resolve(),/Reconnect the original work computer/);assert.equal(f.pending.length,0);
 }
 const f=mainRecoveryFixture(),first=f.resolve();f.pending[0].reject(Error('request failed'));await assert.rejects(first,/request failed/);const retry=f.resolve();assert.equal(f.pending.length,2);f.pending[1].resolve(f.result());assert.equal(await retry,image);
});
