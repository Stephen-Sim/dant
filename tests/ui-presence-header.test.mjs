import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {formatPresence} from '../ui/presence.js';
import {updateWorkTimers,workProgress,renderWorkEntry} from '../ui/work-progress.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(){
 const {document}=parseHTML('<main></main><input id="credential-secret" type="password">'),timers=new Map(),listeners=new Map(),password=document.querySelector('#credential-secret');let now=181000,sequence=0;password.value='private-live-value';
 const c={workProgress,renderWorkEntry,textEditor:{renderSettings:()=>'',bind(){},load:async()=>{},dispose(){}},nativeTray:{sync(){},dispose(){}},updateWorkTimers,settingsNavigation:{sync(){}},appUpdates:{render:()=>'',dispose(){}},document,window:{addEventListener:(name,handler)=>listeners.set(name,handler)},formatPresence:(state,language)=>formatPresence(state,language,now),fallbackLanguage:'en',state:{settings:{language:'en'},controller:{status:'online'},worker:{status:'online'},presence:{lastActiveAt:1000},messages:[]},page:'chat',eventConnected:true,pc:null,stream:null,callStarting:false,callConnected:false,callChannel:null,callStops:{pending:false},chatMode:'text',showComputer:false,esc:value=>String(value??''),ico:()=>'<svg></svg>',button:(action,icon,label)=>`<button data-action="${action}">${label}</button>`,presenceTimer:undefined,setInterval:(fn,ms)=>{assert.equal(ms,30000);timers.set(++sequence,fn);return sequence;},clearInterval:id=>timers.delete(id),unloading:false,managedSettings:{clearSecret(){password.value='';}},clearTelegramPairing(){},appearance:{dispose(){}},speechGeneration:0,speech:{stop:async()=>{}},stopReadTracking(){},screenTimer:undefined,screenAbort:null,callId:null,cleanupCall(){},cancelRecording(){},recording:null,transport:{close(){}},screenURL:'',updateRead(){},restartScreen(){},positionReactionMenus(){}};
 vm.createContext(c);vm.runInContext(part('const zh={','const subscriptionVoiceUnavailable=')+'\n'+part('function renderHeader(status){','function renderChat(){')+'\n'+part("document.addEventListener('visibilitychange'",'async function boot(){'),c);document.querySelector('main').innerHTML=c.renderHeader('online');c.startPresenceTicker();
 return {c,document,password,timers,listeners,advance(ms){now+=ms;for(const callback of timers.values())callback();}};
}

test('presence ticks update real header nodes without rendering or resetting secure inputs, and unload cancels the timer',()=>{
 const f=fixture(),label=f.document.querySelector('[data-presence-label]'),detail=f.document.querySelector('[data-presence-detail]');assert.equal(label.textContent,'Online');assert.match(detail.textContent,/Last active 3 minutes ago/);assert.ok(f.document.querySelector('.presence-status').title.startsWith('Last active: '));assert.equal(f.document.querySelector('[data-chat-search]').getAttribute('aria-label'),'Search chat');
 f.advance(60000);assert.equal(f.document.querySelector('[data-presence-label]'),label);assert.equal(f.document.querySelector('[data-presence-detail]'),detail);assert.match(detail.textContent,/4 minutes ago/);assert.equal(f.password.value,'private-live-value');assert.equal(f.timers.size,1);f.c.startPresenceTicker();assert.equal(f.timers.size,1,'starting twice never stacks intervals');
 f.listeners.get('beforeunload')();assert.equal(f.timers.size,0);assert.equal(f.c.unloading,true);assert.equal(f.password.value,'');
});

test('header presence follows language, real work/media connection, and controller disconnection over cached VM state',()=>{
 const f=fixture();f.c.state.settings.language='zh';f.c.state.active={turnId:'known'};f.c.updatePresence();assert.equal(f.document.querySelector('[data-presence-label]').textContent,'在线');assert.match(f.document.querySelector('[data-presence-detail]').textContent,/正在工作/);assert.match(f.document.querySelector('[data-presence-dot]').className,/working/);
 f.c.state.active=null;f.c.state.call={status:'connected'};f.c.pc={connectionState:'connected'};f.c.callConnected=true;f.c.callChannel={readyState:'open'};f.c.updatePresence();assert.match(f.document.querySelector('[data-presence-detail]').textContent,/正在通话/);
 f.c.eventConnected=false;f.c.updatePresence();assert.equal(f.document.querySelector('[data-presence-label]').textContent,'未连接');assert.doesNotMatch(f.document.querySelector('[data-presence-detail]').textContent,/正在通话|正在工作/);assert.match(f.document.querySelector('[data-presence-dot]').className,/offline/);assert.equal(f.password.value,'private-live-value');
});
