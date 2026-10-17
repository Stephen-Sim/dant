import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {createManagedSettings,parseSkillFiles} from '../ui/managed-settings.js';

const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const error=(code,status=400)=>Object.assign(Error('Private upstream detail must never appear'),{code,status});
function fixture({language='en',online=true}={}){
 const {document,Event}=parseHTML('<main id="app"></main>'),app=document.querySelector('#app'),calls=[],toasts=[],backend={items:[]},handlers=new Map();let modal=null,sequence=0,ui;
 const state={conversationId:'conversation-a',settings:{language,vm:{host:'vm-a',user:'dant',port:22}},worker:{status:online?'online':'offline'},skills:{items:[]},credentials:{items:[],requests:[]}};
 Object.defineProperty(document.defaultView.HTMLInputElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(value){this.toggleAttribute('checked',Boolean(value));}});
 const preview=()=>({id:'preview-'+ ++sequence,source:'https://github.com/example/skills/tree/0123456789abcdef/browser',name:'browser-check',description:'Inspect the desktop safely.',instructions:'Read the screenshot before acting. <img src=x onerror=alert(1)>',files:[{path:'SKILL.md',size:150},{path:'scripts/check.py',size:1024},{path:'LICENSE',size:1100}],expiresAt:Date.now()+600000});
 function render(){modal=ui.syncModal(modal,'skills');const template=document.createElement('template');template.innerHTML=ui.renderSkillPage()+(ui.renderModal(modal)||'');reconcile(app,template.content);ui.bind();document.querySelectorAll('[data-action="close-modal"]').forEach(node=>node.onclick=close);}
 function close(){ui.onClose(modal);modal=null;render();}
 async function request(route,options={}){calls.push({route,...options});if(handlers.has(route))return handlers.get(route)(options);if(route==='/skills/import/preview')return preview();if(route.startsWith('/skills/import/previews/')&&options.method==='DELETE')return {discarded:true};if(route==='/skills/import'){backend.items.push({name:options.body.name,description:'Imported skill',path:'.agents/skills/'+options.body.name,enabled:options.body.enabled});return {imported:true};}if(route==='/skills')return structuredClone(backend);throw Error('Unexpected route');}
 ui=createManagedSettings({document,getState:()=>state,getModal:()=>modal,request,render,toast:message=>toasts.push(message),openModal:value=>{modal=value;render();},closeModal:close});render();
 return {document,Event,ui,state,backend,calls,toasts,handlers,preview,render,close,get modal(){return modal;},show(value){modal=value;render();},async click(selector){const node=document.querySelector(selector);assert.ok(node,'Missing '+selector);node.dispatchEvent(new Event('click',{bubbles:true}));await settle();},input(name,value){const node=document.querySelector('[name="'+name+'"]');assert.ok(node,name);node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));return node;},async submit(){document.querySelector('#skill-import-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();},async file(file){const node=document.querySelector('#skill-import-file');Object.defineProperty(node,'files',{configurable:true,value:[file]});node.dispatchEvent(new Event('change',{bubbles:true}));await settle();},async open(){await this.click('[data-skill-import]');},async load(){this.input('url','https://github.com/example/skills/tree/main/browser');await this.click('[data-skill-import-preview]');}};
}

test('bilingual skills page imports a reviewed GitHub skill without modifying or executing its preview',async()=>{
 for(const language of ['en','zh']){
  const f=fixture({language});assert.equal(f.document.querySelector('.skills-page-actions [data-skill-import]').textContent,language==='en'?'Import skill':'导入技能');await f.open();await f.load();
  assert.deepEqual(f.calls[0],{route:'/skills/import/preview',method:'POST',body:{url:'https://github.com/example/skills/tree/main/browser'}});assert.equal(f.calls.length,1);assert.equal(f.document.querySelector('[name="name"]').value,'browser-check');assert.equal(f.document.querySelector('.skill-import-preview img'),null);assert.match(f.document.querySelector('#skill-import-instructions pre').textContent,/<img src=x/);assert.match(f.document.querySelector('.skill-import-files').textContent,/LICENSE/);assert.match(f.document.querySelector('.skill-import-files').textContent,/1\.0 KiB/);
  f.input('name','browser-custom');const enabled=f.document.querySelector('[name="enabled"]');enabled.checked=false;enabled.dispatchEvent(new f.Event('change',{bubbles:true}));f.render();assert.equal(f.document.querySelector('[name="name"]').value,'browser-custom');await f.submit();
  assert.deepEqual(f.calls.find(call=>call.route==='/skills/import').body,{id:'preview-1',name:'browser-custom',enabled:false});assert.equal(f.modal,null);assert.ok(f.document.querySelector('[data-key="skill-card-browser-custom"]'));assert.equal(f.toasts.length,1);assert.equal(f.calls.some(call=>/exec|tool|turn|messages/.test(call.route)),false);
 }
});

test('local SKILL.md and ZIP use multipart bytes and keep selected files through refreshes',async()=>{
 for(const [name,type]of [['SKILL.md','text/markdown'],['skill.zip','application/zip']]){
  const f=fixture();await f.open();await f.click('[data-skill-import-source="file"]');const file=new File(['real local bytes'],name,{type});await f.file(file);const input=f.document.querySelector('#skill-import-file');f.render();assert.equal(f.document.querySelector('#skill-import-file'),input);assert.match(f.document.querySelector('.skill-import-selected').textContent,new RegExp(name.replace('.','\\.')));await f.click('[data-skill-import-preview]');
  const body=f.calls[0].body;assert.ok(body instanceof FormData);assert.equal(body.get('file').name,name);assert.equal(await body.get('file').text(),'real local bytes');await f.submit();assert.equal(f.calls.filter(call=>call.route==='/skills/import').length,1);
 }
});

test('missing and oversized sources fail locally; offline import cannot start',async()=>{
 const f=fixture();await f.open();await f.click('[data-skill-import-preview]');assert.match(f.document.querySelector('[role="status"]').textContent,/Enter a public GitHub/);await f.click('[data-skill-import-source="file"]');await f.click('[data-skill-import-preview]');assert.equal(f.calls.length,0);await f.file(new File([new Uint8Array(1048577)],'huge.zip'));await f.click('[data-skill-import-preview]');assert.match(f.document.querySelector('[role="status"]').textContent,/size limit/);assert.equal(f.calls.length,0);
 const offline=fixture({online:false});assert.equal(offline.document.querySelector('[data-skill-import]').disabled,true);await offline.open();assert.equal(offline.modal,null);assert.equal(offline.calls.length,0);
});

test('preview errors keep the source and only render fixed localized messages',async()=>{
 for(const [language,code]of [['en','invalid_source'],['zh','fetch_failed'],['en','__proto__']]){
  const f=fixture({language});f.handlers.set('/skills/import/preview',()=>{throw error(code,502);});await f.open();f.input('url','https://github.com/example/skills/tree/main/browser');await f.click('[data-skill-import-preview]');assert.equal(f.document.querySelector('[name="url"]').value,'https://github.com/example/skills/tree/main/browser');assert.ok(f.document.querySelector('[role="status"]').textContent.length>10);assert.doesNotMatch(f.document.querySelector('[role="status"]').textContent,/Private upstream/);assert.equal(f.document.querySelector('.skill-import-preview'),null);f.handlers.delete('/skills/import/preview');await f.click('[data-skill-import-preview]');assert.ok(f.document.querySelector('.skill-import-preview'));
 }
});

test('name collision preserves the reviewed content and permits an explicit renamed import',async()=>{
 const f=fixture();await f.open();await f.load();f.handlers.set('/skills/import',()=>{throw error('name_exists',409);});await f.submit();assert.match(f.document.querySelector('[role="status"]').textContent,/already exists/);assert.equal(f.document.querySelector('[name="name"]').value,'browser-check');assert.ok(f.document.querySelector('.skill-import-preview'));assert.equal(f.document.querySelector('#skill-import-form [type="submit"]').disabled,false);f.input('name','another-name');f.handlers.delete('/skills/import');await f.submit();assert.equal(f.calls.filter(call=>call.route==='/skills/import').length,2);assert.equal(f.calls.filter(call=>call.route==='/skills/import/preview').length,1);assert.equal(f.modal,null);
});

test('unknown import outcomes cannot be retried before an explicit new preview',async()=>{
 const f=fixture();await f.open();await f.load();f.handlers.set('/skills/import',()=>{throw Object.assign(Error('Lost response'),{unknownOutcome:true});});await f.submit();assert.match(f.document.querySelector('[role="status"]').textContent,/unconfirmed/);assert.equal(f.document.querySelector('#skill-import-form [type="submit"]').disabled,true);await f.submit();assert.equal(f.calls.filter(call=>call.route==='/skills/import').length,1);await f.click('[data-skill-import-refresh]');assert.equal(f.calls.at(-1).route,'/skills');assert.equal(f.document.querySelector('#skill-import-form [type="submit"]').disabled,true);f.handlers.delete('/skills/import');await f.click('[data-skill-import-preview]');await f.submit();assert.equal(f.calls.filter(call=>call.route==='/skills/import').at(-1).body.id,'preview-2');assert.equal(f.modal,null);
});

test('pending preview disables duplicate actions and discards results after modal, conversation or VM ownership changes',async()=>{
 for(const change of ['close','modal','conversation','vm']){
  const f=fixture(),wait=deferred();f.handlers.set('/skills/import/preview',()=>wait.promise);await f.open();f.input('url','https://github.com/example/skills');await f.click('[data-skill-import-preview]');assert.equal(f.document.querySelector('[data-skill-import-preview]').disabled,true);assert.equal(f.document.querySelector('[name="url"]').disabled,true);await f.click('[data-skill-import-preview]');assert.equal(f.calls.length,1);
  if(change==='close'){f.close();await f.open();f.input('url','https://github.com/new-owner/new-skill');}else if(change==='modal')f.show({type:'image'});else if(change==='conversation'){f.state.conversationId='conversation-b';f.render();}else{f.state.settings.vm.host='vm-b';f.render();}
  wait.resolve(f.preview());await settle();assert.equal(f.document.querySelector('.skill-import-preview'),null);assert.equal(f.calls.some(call=>call.route==='/skills/import'),false);assert.equal(f.toasts.length,0);if(change==='close')assert.equal(f.document.querySelector('[name="url"]').value,'https://github.com/new-owner/new-skill');
 }
});

test('late commit responses cannot close a newer modal or overwrite a different VM skill snapshot',async()=>{
 for(const change of ['close','conversation','vm']){
  const f=fixture(),wait=deferred();await f.open();await f.load();f.handlers.set('/skills/import',()=>wait.promise);await f.submit();assert.equal(f.document.querySelector('#skill-import-form [type="submit"]').disabled,true);await f.submit();assert.equal(f.calls.filter(call=>call.route==='/skills/import').length,1);
  if(change==='close'){f.close();await f.open();f.input('url','https://github.com/new-owner/new-skill');}else if(change==='conversation'){f.state.conversationId='conversation-b';f.render();}else{f.state.settings.vm.host='vm-b';f.render();}
  f.state.skills={items:[{name:'new-vm-skill',description:'Keep',enabled:true}]};wait.resolve({imported:true});await settle();assert.equal(f.state.skills.items[0].name,'new-vm-skill');assert.equal(f.calls.some(call=>call.route==='/skills'),false);assert.equal(f.toasts.length,0);if(change==='close')assert.equal(f.document.querySelector('[name="url"]').value,'https://github.com/new-owner/new-skill');
 }
});

test('preview disclosure stays open on refresh; source changes require a fresh preview',async()=>{
 const f=fixture();await f.open();await f.load();const details=f.document.querySelector('#skill-import-instructions');details.setAttribute('open','');f.render();assert.equal(f.document.querySelector('#skill-import-instructions').hasAttribute('open'),true);f.input('name','saved-custom-name');f.render();assert.equal(f.document.querySelector('[name="name"]').value,'saved-custom-name');f.input('url','https://github.com/different/repo');assert.equal(f.document.querySelector('.skill-import-preview'),null);assert.equal(f.document.querySelector('#skill-import-form [type="submit"]'),null);assert.equal(f.calls.filter(call=>call.route==='/skills/import/preview').length,1);
});

test('unused previews are discarded on close or source changes without surfacing cleanup failures',async()=>{
 for(const action of ['close','url','mode','again']){
  const f=fixture();await f.open();await f.load();f.handlers.set('/skills/import/previews/preview-1',()=>{throw error('fetch_failed',502);});
  if(action==='close')f.close();else if(action==='url')f.input('url','https://github.com/another/repo');else if(action==='mode')await f.click('[data-skill-import-source="file"]');else await f.click('[data-skill-import-preview]');await settle();
  const cleanup=f.calls.filter(call=>call.route==='/skills/import/previews/preview-1');assert.equal(cleanup.length,1);assert.equal(cleanup[0].method,'DELETE');assert.equal(f.toasts.length,0);assert.doesNotMatch(f.document.querySelector('#app').textContent,/Private upstream/);
 }
});

test('late previews are cleaned only in their original VM; offline close relies on expiry',async()=>{
 for(const differentVM of [false,true]){
  const f=fixture(),wait=deferred();f.handlers.set('/skills/import/preview',()=>wait.promise);await f.open();f.input('url','https://github.com/example/repo');await f.click('[data-skill-import-preview]');f.close();if(differentVM)f.state.settings.vm.host='different-vm';wait.resolve(f.preview());await settle();assert.equal(f.calls.filter(call=>call.method==='DELETE').length,differentVM?0:1);
 }
 const offline=fixture();await offline.open();await offline.load();offline.state.worker.status='offline';offline.close();await settle();assert.equal(offline.calls.some(call=>call.method==='DELETE'),false);
});

test('expired previews never commit; confirmed imports stay successful if metadata refresh fails',async t=>{
 const f=fixture();await f.open();await f.load();const now=Date.now();t.mock.method(Date,'now',()=>now+700000);f.render();assert.match(f.document.querySelector('[role="status"]').textContent,/expired/);assert.equal(f.document.querySelector('#skill-import-form [type="submit"]').disabled,true);await f.submit();assert.equal(f.calls.some(call=>call.route==='/skills/import'),false);t.mock.restoreAll();
 const confirmed=fixture();await confirmed.open();await confirmed.load();confirmed.handlers.set('/skills',()=>{throw error('fetch_failed',502);});await confirmed.submit();assert.equal(confirmed.modal,null);assert.equal(confirmed.toasts.length,1);assert.equal(confirmed.calls.filter(call=>call.route==='/skills/import').length,1);
});

test('safe README, LICENSE and NOTICE support files survive editing without widening path access',()=>{
 const files={'README.md':'How to use','LICENSE':'MIT','LICENSE.txt':'Terms','LICENSE.md':'Terms','NOTICE':'Notice','NOTICE.md':'Notice','NOTICE.txt':'Notice','scripts/check.py':'print(1)'};assert.deepEqual(parseSkillFiles(JSON.stringify(files)),files);
 for(const path of ['package.json','AGENTS.md','readme.md','README.md/extra','LICENSE.js','NOTICE.sh','../LICENSE','scripts/../../NOTICE','scripts\\x.py'])assert.throws(()=>parseSkillFiles(JSON.stringify({[path]:'text'})),/skillFilesInvalid/);
});
