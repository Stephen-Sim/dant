import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createAppearance} from '../ui/appearance.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
 const elements=new Map(),stored=new Map(),styles=new Map(),requests=[],toasts=[],timers=new Map();let nextTimer=0;
 const document={documentElement:{dataset:{},style:{setProperty:(key,value)=>styles.set(key,value)}},querySelector:selector=>elements.get(selector)||null,querySelectorAll:selector=>elements.get(selector)||[]};
 const context={document,URL,Date,FormData:class{constructor(form){this.values=Object.entries(form.values);}*[Symbol.iterator](){yield* this.values;}},setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),fallbackLanguage:'zh',state:{settings:{language:'zh',theme:'system',font:'system',fontSize:13,vm:{host:'',user:'dant',port:22,keyPath:''}},worker:{status:'online',models:[]},messages:[]},eventConnected:true,page:'settings',modal:null,vmDraft:null,vmProfiles:null,vmProfilesVisible:false,vmProfilesBusy:false,vmProfilesError:'',selectedVMProfile:'',legacyVMDirectory:'',manualVMExpanded:false,telegramStatus:null,telegramLoading:false,telegramError:'',telegramPairing:null,telegramPairTimer:null,pendingActions:new Set(),voiceLoadedFor:'',
 localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)},render:()=>{},toast:message=>toasts.push(message),esc:value=>String(value??''),ico:()=>'',button:(action,icon,label)=>`<button data-action="${action}">${label}</button>`,formatTime:value=>new Date(value).toISOString(),
 api:async(route,options={})=>{requests.push({route,...options});if(route==='/state')return context.state;if(route==='/vm/profiles')return {current:null,candidates:[],requiresSelection:false};if(route==='/telegram')return {enabled:false,configured:false,connected:false,paired:false};return {ok:true};},
 };
 context.post=(route,body={})=>context.api(route,{method:'POST',body});context.appearance=createAppearance({document,storage:context.localStorage,matchMedia:()=>null,save:body=>context.api('/settings',{method:'PATCH',body})});
 vm.createContext(context);vm.runInContext([
  section('const zh={','const subscriptionVoiceUnavailable='),
  section('function renderAppearance(){','function renderVoiceSettings(settings){'),
  section('function formVM(form){','let inputChain='),
  section('async function action(a){','function clearSentDraft('),
 ].join('\n'),context);
 return {c:context,elements,stored,styles,requests,toasts,timers};
}
function manualForm(f,values={host:'172.20.0.5',user:'dant',port:'22',keyPath:'C:/private/vm-key'}){
 const form={values,reportValidity:()=>true};f.elements.set('#vm-form',form);return form;
}

test('rendered appearance controls apply and PATCH each selected preference through their actual handlers',async()=>{
 const f=fixture(),{c,elements,requests,styles}=f;
 for(const [id,value]of [['appearance-theme','dark'],['appearance-font','mono'],['appearance-size','18']])elements.set('#'+id,{value});
 c.bindAppearance();await elements.get('#appearance-theme').onchange();await elements.get('#appearance-font').onchange();await elements.get('#appearance-size').onchange();
 assert.equal(c.document.documentElement.dataset.theme,'dark');assert.match(styles.get('--app-font-family'),/Consolas/);assert.equal(styles.get('--app-font-size'),'18px');
 assert.deepEqual(requests.map(item=>item.route),['/settings','/settings','/settings']);assert.equal(requests[0].method,'PATCH');assert.equal(requests[0].body.theme,'dark');assert.equal(requests[1].body.font,'mono');assert.equal(requests[2].body.fontSize,18);
 const html=c.renderAppearance();assert.match(html,/value="dark" selected/);assert.match(html,/value="mono" selected/);assert.match(html,/value="18" selected/);c.state.settings.language='en';assert.match(c.renderAppearance(),/Follow system|Monospace|Text size/);
});

test('all interface components use theme tokens without filtering desktop or attachment pixels',()=>{
 const remaining=css.replace(/:root(?:\[data-theme="dark"\])?\{[^}]*\}/g,'');
 assert.doesNotMatch(remaining,/#(?:[a-f\d]{3,8})\b/i,'component colors must follow theme tokens');assert.doesNotMatch(css,/\binvert\s*\(/i);assert.match(css,/\.screen-target img\{[^}]*width:auto;height:auto/);assert.match(css,/font-size:calc\(var\(--app-font-size\)/);
 for(const selector of ['.rail','.app-header','.bubble','.computer-panel','.dialog','.composer-box','.call-view','.telegram-pair-code','.attachment-menu'])assert.ok(css.includes(selector));
});

test('Connect without binding discovers existing configurations and opens manual fields without creating a VM',async()=>{
 const f=fixture();await f.c.connectVM();assert.equal(f.c.page,'settings');assert.equal(f.c.manualVMExpanded,true);assert.equal(f.c.vmProfilesVisible,true);assert.equal(f.requests[0].route,'/vm/profiles');assert.equal(f.requests.some(item=>item.route==='/connect'||item.route==='/provision'),false);
 const html=f.c.renderVMSettings();assert.match(html,/data-action="use-existing"/);assert.match(html,/id="manual-vm-options" open/);assert.match(html,/保存并连接/);
 f.c.vmProfiles={current:null,candidates:[{id:'old',label:'Previous workspace',host:'172.20.0.5',user:'dant',port:22,directory:'C:/old/data'}]};f.c.selectedVMProfile='old';assert.match(f.c.renderVMProfiles(),/Previous workspace/);assert.doesNotMatch(f.c.renderVMProfiles(),/data-action="import-vm-profile"[^>]*disabled/);
});

test('manual form saves before connecting and preserves typed connection details after a connection error',async()=>{
 const f=fixture(),form=manualForm(f);f.c.bindVMSettings();form.oninput();await form.onsubmit({preventDefault(){}});assert.deepEqual(f.requests.map(item=>item.route),['/settings','/connect','/state']);assert.equal(f.requests[0].body.vm.host,'172.20.0.5');assert.equal(f.requests[0].body.vm.port,22);
 const failed=fixture(),failedForm=manualForm(failed);failed.c.api=async(route,options={})=>{failed.requests.push({route,...options});if(route==='/connect')throw Error('SSH key unavailable');return {ok:true};};failed.c.bindVMSettings();failedForm.oninput();await failedForm.onsubmit({preventDefault(){}});
 assert.equal(failedForm.values.host,'172.20.0.5');assert.equal(failedForm.values.keyPath,'C:/private/vm-key');assert.equal(failed.c.state.settings.vm.keyPath,'C:/private/vm-key');assert.match(failed.toasts.at(-1),/SSH key unavailable/);assert.equal(failed.c.pendingActions.has('connect'),false);
});

test('rejected manual saves retain the unsaved draft and do not connect or create a VM',async()=>{
 const f=fixture(),form=manualForm(f);f.c.api=async(route,options={})=>{f.requests.push({route,...options});throw Error('Private key file not found');};f.c.bindVMSettings();form.oninput();await form.onsubmit({preventDefault(){}});
 assert.equal(f.c.vmDraft.host,'172.20.0.5');assert.equal(f.c.vmDraft.keyPath,'C:/private/vm-key');assert.deepEqual(f.requests.map(item=>item.route),['/settings']);assert.match(f.toasts.at(-1),/Private key file not found/);
});

test('explicit profile or directory imports refresh binding then connect and cannot overwrite a protected current profile',async()=>{
 const f=fixture();f.c.api=async(route,options={})=>{f.requests.push({route,...options});if(route==='/state'){f.c.state.settings.vm={host:'172.20.0.6',user:'dant',port:22,keyPath:'C:/old/key'};return f.c.state;}return {ok:true};};await f.c.importVMProfile({id:'old'});assert.deepEqual(f.requests.map(item=>item.route),['/vm/import','/state','/connect','/state']);assert.equal(f.requests[0].body.id,'old');
 const directory=fixture(),form={elements:{directory:{value:'C:/previous/data'}}};directory.elements.set('#vm-import-form',form);directory.c.api=f.c.api;directory.c.importVMProfile=async body=>directory.requests.push({body});directory.c.bindVMSettings();form.oninput();await form.onsubmit({preventDefault(){}});assert.equal(directory.requests[0].body.directory,'C:/previous/data');
 f.c.vmProfiles={current:{id:'current',host:'172.20.0.6'},candidates:[{id:'old',host:'172.20.0.7'}]};f.c.selectedVMProfile='old';assert.match(f.c.renderVMProfiles(),/data-action="import-vm-profile"[^>]*disabled/);assert.doesNotMatch(f.c.renderVMProfiles(),/id="vm-import-form"/);
});

test('Telegram unconfigured and offline states disable configuration actions without requesting the service',async()=>{
 const f=fixture();assert.match(f.c.renderTelegramSettings(),/尚未配置机器人令牌/);assert.match(f.c.renderTelegramSettings(),/data-action="telegram-toggle"[^>]*disabled/);f.c.state.worker.status='offline';await f.c.loadTelegram();assert.equal(f.requests.length,0);const html=f.c.renderTelegramSettings();assert.match(html,/请先连接工作电脑/);assert.match(html,/id="telegram-token"[^>]*disabled/);assert.doesNotMatch(html,/id="telegram-token"[^>]*\bvalue=/);
});

test('new appearance, existing-computer, and Telegram surfaces follow English and authoritative pairing updates',()=>{
 const f=fixture();f.c.state.settings.language='en';assert.match(f.c.renderAppearance(),/Appearance|Follow system|Sans serif|Monospace/);assert.match(f.c.renderVMSettings(),/Use existing computer/);assert.match(f.c.renderVMSettings(),/Save and connect/);assert.match(f.c.renderTelegramSettings(),/No bot token configured/);
 f.c.state.telegram={enabled:true,configured:true,connected:true,bot:{username:'live_bot'},paired:true,owner:{userId:12,chatId:13}};assert.equal(f.c.currentTelegram().paired,true);const html=f.c.renderTelegramSettings();assert.match(html,/Account paired/);assert.match(html,/@live_bot/);assert.match(html,/Telegram connected/);assert.match(html,/Unpair account/);
});

test('Telegram token form sends only to configuration, clears on success, and never persists or renders the token',async()=>{
 const f=fixture(),token='123456:private-test-token',input={value:token},form={reportValidity:()=>true};f.elements.set('#telegram-token-form',form);f.elements.set('#telegram-token',input);f.c.api=async(route,options={})=>{f.requests.push({route,...options});return {enabled:false,configured:true,connected:false,bot:{username:'fixture_bot'},paired:false};};f.c.bindTelegram();await form.onsubmit({preventDefault(){}});
 assert.equal(f.requests[0].route,'/telegram/config');assert.equal(f.requests[0].body.token,token);assert.equal(input.value,'');assert.equal(f.c.state.messages.length,0);assert.doesNotMatch(f.c.renderTelegramSettings(),new RegExp(token));assert.equal([...f.stored.values()].some(value=>String(value).includes(token)),false);
 assert.match(f.c.renderTelegramSettings(),/机器人令牌已配置/);assert.doesNotMatch(f.c.renderTelegramSettings(),/id="telegram-token"[^>]*\bvalue=/);
});

test('Telegram enable, disable, and removal actions send explicit changes and failed configuration retains only the local input',async()=>{
 const f=fixture();f.c.setTelegramStatus({enabled:false,configured:true,paired:false});f.c.api=async(route,options={})=>{f.requests.push({route,...options});return route==='/telegram/disconnect'?{enabled:false,configured:false,paired:false}:{enabled:options.body.enabled,configured:true,paired:false};};
 await f.c.action('telegram-toggle');assert.equal(f.requests.at(-1).body.enabled,true);assert.equal(f.c.currentTelegram().enabled,true);await f.c.action('telegram-toggle');assert.equal(f.requests.at(-1).body.enabled,false);await f.c.action('telegram-remove');assert.equal(f.requests.at(-1).body.clearToken,true);assert.equal(f.c.currentTelegram().configured,false);
 const failed=fixture(),input={value:'123456:unsaved-token'},form={reportValidity:()=>true};failed.elements.set('#telegram-token',input);failed.elements.set('#telegram-token-form',form);failed.c.api=async()=>{throw Error('Telegram rejected the request (401)');};failed.c.bindTelegram();await form.onsubmit({preventDefault(){}});assert.equal(input.value,'123456:unsaved-token');assert.equal(failed.c.state.messages.length,0);assert.equal([...failed.stored.values()].some(value=>String(value).includes('unsaved-token')),false);assert.match(failed.toasts.at(-1),/401/);
});

test('Telegram pairing codes are ephemeral, expire locally, and only safe bot links can be opened',async()=>{
 const f=fixture(),expiresAt=Date.now()+600000;f.c.setTelegramStatus({enabled:true,configured:true,connected:true,paired:false,bot:{username:'fixture_bot'}});f.c.api=async(route,options={})=>{f.requests.push({route,...options});if(route==='/telegram/pair')return {code:'one-time-pair-code',expiresAt,botUrl:'https://t.me/fixture_bot?start=one-time-pair-code'};return {enabled:false,configured:true,paired:false};};await f.c.updateTelegram('pair');
 assert.equal(f.requests[0].route,'/telegram/pair');assert.match(f.c.renderTelegramSettings(),/one-time-pair-code/);assert.match(f.c.renderTelegramSettings(),/https:\/\/t\.me\/fixture_bot/);assert.equal([...f.stored.values()].some(value=>String(value).includes('one-time-pair-code')),false);assert.equal(f.c.telegramBotURL('javascript:alert(1)'),'');assert.equal(f.c.telegramBotURL('https://evil.example/bot'),'');
 [...f.timers.values()][0].fn();assert.equal(f.c.telegramPairing,null);assert.doesNotMatch(f.c.renderTelegramSettings(),/one-time-pair-code/);f.c.setTelegramStatus({enabled:true,configured:true,paired:true,owner:{userId:77,chatId:77}});assert.match(f.c.renderTelegramSettings(),/账号已配对/);assert.match(f.c.renderTelegramSettings(),/data-action="telegram-pair"[^>]*disabled/);await f.c.updateTelegram('disconnect',{clearToken:false});assert.equal(f.requests.at(-1).route,'/telegram/disconnect');assert.equal(f.requests.at(-1).body.clearToken,false);
});
