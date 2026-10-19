import {createTaskReplyController} from '../ui/task-reply.js';
import {bindAttachmentImages} from '../ui/attachment-images.js';
import test from 'node:test';
import {createCallSubtitles} from '../ui/call-subtitles.js';
import {canPreviewFile} from '../ui/file-preview.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {workProgress,renderWorkPriority,renderWorkEntry,renderActiveWork,renderVoiceWorkHistory} from '../ui/work-progress.js';
import {SpeechHelper,speechMessages} from '../ui/speech.js';
import {formatCallDuration} from '../ui/call-duration.js';
import {defaultReactions} from '../src/reactions.mjs';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {formatPresence} from '../ui/presence.js';
import {createSchedules} from '../ui/schedules.js';
import {createMemorySettings} from '../ui/memory-settings.js';
import {telegramConnectionError,telegramDeliveryNotice} from '../ui/telegram-delivery.js';
import {renderUsageSettings} from '../ui/usage-settings.js';
import {createUsageActivityController} from '../ui/usage-activity.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(selected='zh'){
 const storage=new Map(),requests=[];
 const context={progressActions:{bind(){},renderConfirmation:()=>'',onClose(){},busy:false},workDisclosures:{capture(){},bind(){},isOpen:()=>false},bindAttachmentImages,textEditor:{renderSettings:()=>'',bind(){},load:async()=>{},dispose(){}},canPreviewFile,workProgress,renderWorkPriority,renderWorkEntry,renderActiveWork,renderVoiceWorkHistory,downloads:{bind(){}},filePreview:{bind(){},syncModal:value=>value},settingsNavigation:{render:sections=>Object.values(sections).join('')},appUpdates:{render:()=>'',dispose(){}},formatPresence,managedSettings:{renderRequests:()=>'',renderCredentials:()=>'',renderSkills:()=>'',renderModal:()=>null,bind(){},load:async()=>{},onClose(){}},chatHistory:{renderActions:()=>'',renderEdited:()=>'',renderSettings:()=>'',renderModal:()=>null,bind(){},bindModal(){},onClose(){}},defaultReactions,emojiFor:null,formatCallDuration,callDuration:{snapshot:{callId:null,confirmed:false,seconds:0,finalized:false}},document:{documentElement:{dataset:{theme:'light'}}},appearance:{preferences:{theme:'system',font:'system',fontSize:13}},fontInventory:null,fontLoading:false,fontError:'',fontSearch:'',fontMenuOpen:false,appearanceAdvanced:false,vmProviderInfo:null,vmProvidersBusy:false,vmProvidersError:'',vmProfiles:null,vmProfilesVisible:false,vmProfilesBusy:false,vmProfilesError:'',selectedVMProfile:'',legacyVMDirectory:'',telegramStatus:null,telegramLoading:false,telegramError:'',telegramPairing:null,telegramPairTimer:null,fallbackLanguage:'zh',state:{settings:{language:selected,vm:{host:'',user:'dant',port:22,keyPath:''},nativeVoice:'ember',apiVoice:'marin',notifications:false,model:''},worker:{status:'online',account:null,models:[],realtime:{subscription:{available:true},key:{configured:false}}},messages:[],queue:[],schedules:[],active:null,call:null,memory:''},page:'chat',chatMode:'text',showComputer:false,eventConnected:true,pc:null,stream:null,callStarting:false,callMini:false,callMuted:false,callConnected:false,callChannel:null,callProvider:'subscription',callStops:{pending:false},messageSubmissions:{unknown:null},pendingActions:new Set(),voiceChoices:['ember'],apiVoiceChoices:['marin'],voiceApiExpanded:false,voiceError:'',vmDraft:null,manualVMExpanded:false,provisionDraft:{provider:'auto',cpu:4,memoryGB:6,diskGB:40,adminSudo:false},provisionExpanded:false,steerExpectedTurn:null,steerDraft:'',progressExpanded:false,scheduleDraft:{text:'',at:''},composerDraft:'',replyTo:null,attachments:[],uploading:0,sending:false,recording:null,recordStarting:false,recordDraft:null,dictating:false,speakingId:null,attachmentMenu:false,screenURL:'',screenError:'',innerWidth:1440,modal:null,
 localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},api:async(route,options)=>{requests.push({route,options});return {ok:true};},render:()=>{},esc:value=>String(value??''),ico:name=>`<svg>${name}</svg>`,button:(action,icon,label)=>`<button data-action="${action}" aria-label="${label}">${label}</button>`,eyes:()=>'',md:text=>text,formatTime:()=>'',humanControl:()=>false,unknownTask:message=>message?.submission==='unknown',speechBlocked:()=>false,renderLoginDetails:()=>'',fileURL:file=>'/fixture/'+file.id,
 };
 Object.assign(context,{telegramConnectionError,telegramDeliveryNotice,renderUsageSettings});context.usageActivity=createUsageActivityController({document:context.document});context.scheduledTasks=createSchedules({getState:()=>context.state,document:parseHTML('<html><body></body></html>').document,request:context.api,connected:()=>true});
 context.memorySettings=createMemorySettings({getState:()=>context.state,getLanguage:()=>context.state?.settings?.language||context.fallbackLanguage,request:context.api,connected:()=>false});
 context.callSubtitles=createCallSubtitles();context.taskReplies??=createTaskReplyController({document:{querySelector:(...args)=>context.document?.querySelector?.(...args),querySelectorAll:(...args)=>context.document?.querySelectorAll?.(...args)||[]},getModel:()=>({})});vm.createContext(context);vm.runInContext([
 section('const zh={','const subscriptionVoiceUnavailable='),
 section('const subscriptionVoiceUnavailable=','const esc='),
 section('function renderHeader(status){','function renderAttachmentOptions(){'),
 section('function renderAttachmentOptions(){','function speechBlocked(){'),
 section('function renderAttachment(file){','function renderComputer(){'),
 section('function renderComputer(){','function openModal('),
 ].join('\n')+'\nglobalThis.words={zh,en,t};',context);
 return {context,storage,requests};
}

test('both UI and speech dictionaries have complete matching keys',()=>{
 const {context}=fixture();const {zh,en}=context.words;
 assert.deepEqual(Object.keys(zh).sort(),Object.keys(en).sort());
 assert.deepEqual(Object.keys(speechMessages.zh).sort(),Object.keys(speechMessages.en).sort());
 for(const dictionary of [zh,en,speechMessages.zh,speechMessages.en])for(const [key,value]of Object.entries(dictionary))assert.ok(typeof value==='string'&&value.trim(),`Empty translation: ${key}`);
 for(const match of source.matchAll(/\bt\(['"]([^'"]+)['"]\)/g))assert.ok(match[1] in zh,`Missing UI phrase: ${match[1]}`);
});

test('Telegram hints explain new-message sync, VM availability and the existing-history boundary in both languages',()=>{
 const {context}=fixture();assert.match(context.words.en.telegramHint,/new messages and attachments sync with desktop chat/);assert.match(context.words.en.telegramHint,/VM online/);assert.match(context.words.en.telegramHint,/Existing history is not bulk exported/);assert.match(context.words.zh.telegramHint,/同步新消息和附件/);assert.match(context.words.zh.telegramHint,/VM 在线/);assert.match(context.words.zh.telegramHint,/不会批量发送已有记录/);
});

test('settings language persists and updates pages, status, accessibility and retained errors',async()=>{
 const {context:c,storage,requests}=fixture();assert.match(c.renderHeader('online'),/在线/);assert.match(c.renderChat(),/aria-label="语音消息"/);
 c.voiceError='voiceUnavailable';c.screenError=true;
 await c.changeLanguage('en');assert.equal(storage.get('dant.language'),'en');assert.equal(requests[0].route,'/settings');assert.equal(requests[0].options.body.language,'en');
 assert.match(c.renderHeader('online'),/Online/);assert.match(c.renderChat(),/Message dant…/);assert.match(c.renderChat(),/aria-label="Voice message"/);assert.doesNotMatch(c.renderChat(),/听写|上传|录音/);
 const computer=c.renderComputer();assert.match(computer,/aria-label="Resize computer panel"/);assert.match(computer,/aria-label="Work computer keyboard input"/);assert.match(computer,/The desktop could not refresh/);
 assert.match(c.renderSettings(),/Settings|Language|Call voice/);assert.match(c.renderVoiceSettings(c.state.settings),/Voice options are unavailable/);assert.match(c.renderMemory(),/shared identity and durable notes/);assert.match(c.renderSchedules(),/No scheduled tasks/);
 await c.changeLanguage('zh');assert.equal(storage.get('dant.language'),'zh');assert.match(c.renderComputer(),/调整电脑区域宽度|桌面暂时无法刷新/);assert.match(c.renderVoiceSettings(c.state.settings),/暂时无法获取声音选项/);assert.match(c.renderMemory(),/共享身份与持久记忆/);assert.match(c.renderSchedules(),/暂无定时任务/);
 c.state=null;c.fallbackLanguage='en';assert.equal(c.words.t('retryConnection'),'Reconnect','boot failure uses the remembered language');
 const defaultFixture=fixture();defaultFixture.context.state=null;assert.equal(defaultFixture.context.words.t('retryConnection'),'重新连接','an installation without a language preference defaults to Chinese');
});

test('call lifecycle, uncertain messages, task states and provisioning have meaningful text in both languages',()=>{
 const expected={zh:{ready:'开始订阅通话',recover:'工作电脑中仍有通话',pending:'正在等待结束通话',unknown:'发送结果未确认',check:'检查任务状态',confirm:'我确认重新发送',install:'正在安装桌面与工作环境',draft:'草稿',waiting_user:'等待你回答',pausing:'正在暂停'},en:{ready:'Start subscription call',recover:'A call remains on the work computer',pending:'Waiting to end the call',unknown:'Message outcome unconfirmed',check:'Check task status',confirm:'I confirm: send again',install:'Installing the desktop and work environment',draft:'Draft',waiting_user:'Waiting for your answer',pausing:'Pausing'}};
 for(const language of ['zh','en']){
  const {context:c}=fixture(language),text=expected[language];assert.ok(c.renderCallReady().includes(text.ready));
  c.state.call={id:'fixture-call',provider:'subscription'};assert.ok(c.renderCall().includes(text.recover));c.callStops.pending=true;assert.ok(c.renderCall().includes(text.pending));
  c.messageSubmissions.unknown={payload:{text:'Preserved draft'}};const warning=c.renderUnconfirmedMessage();for(const value of [text.unknown,text.check,text.confirm,'Preserved draft'])assert.ok(warning.includes(value));
  c.state.provisioning={status:'installing',running:true};assert.ok(c.renderProvisionCard().includes(text.install));
  for(const status of ['draft','waiting_user','pausing'])assert.equal(c.words.t(status),text[status]);
  c.state.active={source:'voice',turnId:'voice-turn',messageId:null};assert.match(c.renderProgress(),language==='zh'?/通话中的任务调整/:/To adjust work during a call/);assert.doesNotMatch(c.renderProgress(),/id="steer-form"/);
 }
});

test('known errors localize precisely while unknown backend diagnostics remain intact',()=>{
 const {context:c}=fixture();assert.match(c.errorText(Error('The voice call changed')),/通话已变化/);assert.match(c.errorText({name:'NotAllowedError',message:'Permission denied'}),/麦克风权限未获准/);assert.match(c.errorText(Error('Invalid JSON response from local service')),/无效的 JSON/);assert.match(c.errorText(Error('Check the unconfirmed message before sending again')),/请求可能已经送达/);
 const busyConnection='Stop active work and return computer control before changing its connection';assert.match(c.errorText(Error(busyConnection)),/停止当前工作、结束通话并交还电脑控制权/);
 const diagnostic='Worker failed with diagnostic 0x80370102';assert.equal(c.errorText(Error(diagnostic)),'请求失败：'+diagnostic);assert.equal(c.errorText(diagnostic,'serviceNotice'),'服务提示：'+diagnostic);
 c.state.settings.language='en';assert.equal(c.errorText(Error(diagnostic)),'Request failed: '+diagnostic);assert.match(c.errorText(Error('The voice call changed')),/The call changed/);assert.match(c.errorText({name:'NotFoundError',message:'device missing'}),/No microphone was found/);assert.match(c.errorText(Error('The computer connected, but its default response language could not be updated.')),/default response language could not be updated/);
 assert.match(c.errorText(Error(busyConnection)),/Stop active work, end the call and return computer control/);
});

test('speech fallback failures and microphone permissions follow the requested language without device access',async()=>{
 for(const language of ['zh','en']){
  const helper=new SpeechHelper({desktop:false,recognizer:null,synthesis:null});await assert.rejects(helper.dictate(language),language==='zh'?/当前浏览器不支持听写/:/Dictation is not supported/);await assert.rejects(helper.speak('fixture',language),language==='zh'?/当前浏览器不支持朗读/:/Read aloud is not supported/);
  let recognition;class Recognizer{constructor(){recognition=this;}start(){}abort(){this.onend?.();}}
  const recognizer=new SpeechHelper({desktop:false,recognizer:Recognizer,synthesis:null});const listening=recognizer.dictate(language);await Promise.resolve();recognition.onerror({error:'not-allowed'});recognition.onend();await assert.rejects(listening,language==='zh'?/麦克风权限未获准/:/Microphone permission was not granted/);
 }
});

test('live and completed call durations use the same clock format and localized labels',()=>{
 for(const language of ['zh','en']){
  const {context:c}=fixture(language);c.state.call={id:'call-test',provider:'subscription',connectedAt:null};c.callStarting=true;assert.doesNotMatch(c.renderCall(),/data-call-duration/);
  c.callStarting=false;c.callConnected=true;c.pc={connectionState:'connected'};c.callChannel={readyState:'open'};c.callDuration.snapshot={callId:'call-test',confirmed:true,seconds:75,finalized:false};
  const live=c.renderCall();assert.match(live,/data-call-duration[^>]*>1:15/);assert.ok(live.includes(language==='zh'?'通话时长':'Call duration'));assert.ok(live.includes(language==='zh'?'正在通话':'In a call'));
  c.pc=null;c.state.call=null;c.callDuration.snapshot.finalized=true;assert.ok(c.renderCallReady().includes((language==='zh'?'通话已结束':'Call ended')+' · 1:15'));
  c.state.messages=[{id:'history',role:'system',kind:'call',callId:'call-test',seconds:75,time:1}];assert.match(c.renderMessages(),/1:15/);
 }
});

test('the rendered reaction picker contains the six standard reactions with Chinese and English names',()=>{
 const expectedEmoji=['👍','❤️','😆','😮','😢','😡'],expectedIds=['like','love','haha','wow','sad','angry'],names={zh:['赞','爱','大笑','惊讶','难过','生气'],en:['Like','Love','Haha','Wow','Sad','Angry']};
 for(const language of ['zh','en']){
  const {context:c}=fixture(language);c.emojiFor='reaction-message';c.state.messages=[{id:'reaction-message',role:'assistant',status:'completed',text:'A completed reply',time:1,attachments:[],reactions:['👍','😂','👀','🎉']}];
  const {document}=parseHTML('<main>'+c.renderMessages()+'</main>'),buttons=[...document.querySelectorAll('.reaction-menu button')];assert.equal(document.querySelector('.reaction-menu').parentNode,document.querySelector('.message-actions'),'the picker must anchor to the adjacent toolbar');
  assert.deepEqual(buttons.map(button=>button.dataset.emoji),expectedEmoji);assert.deepEqual(buttons.map(button=>button.dataset.reactionId),expectedIds);assert.deepEqual(buttons.map(button=>button.title),names[language]);assert.deepEqual(buttons.map(button=>button.getAttribute('aria-label')),names[language]);assert.equal(buttons[0].getAttribute('aria-pressed'),'true');assert.equal(buttons[2].getAttribute('aria-pressed'),'false');
  const historical=[...document.querySelectorAll('.reactions button')];assert.deepEqual(historical.map(button=>button.dataset.emoji),['👍','😂','👀','🎉']);for(const button of historical){assert.equal(button.dataset.react,'reaction-message');assert.match(button.getAttribute('aria-label'),language==='zh'?/^取消表情: /:/^Remove reaction: /);assert.equal(button.getAttribute('aria-pressed'),'true');}
 }
});

test('message actions sit beside each bubble while reactions, receipts and attachments keep their own controls',()=>{
 const {context:c}=fixture();c.state.messages=[{id:'assistant-layout',role:'assistant',status:'completed',text:'A long reply '.repeat(80),time:1,reactions:['❤️'],attachments:[{id:'picture',name:'Picture.png',type:'image/png',size:1200},{id:'report',name:'Long-report-name.txt',type:'text/plain',size:100}]},{id:'user-layout',role:'user',status:'review',text:'User message',time:2,reactions:[],executorConfirmedAt:2,attachments:[]}];
 const {document,Event}=parseHTML('<main>'+c.renderMessages()+'</main>');
 for(const article of document.querySelectorAll('article.message')){
  const content=article.querySelector('.message-content'),row=content.querySelector('.message-bubble-row'),bubble=row.querySelector('.bubble'),actions=row.querySelector('.message-actions'),meta=content.querySelector('.message-meta');
  assert.equal(bubble.parentNode,row);assert.equal(actions.parentNode,row);assert.equal(bubble.nextElementSibling,actions);assert.equal(actions.getAttribute('role'),'toolbar');assert.equal(actions.getAttribute('aria-label'),'消息操作');assert.equal(meta.querySelector('.message-actions'),null);assert.equal(meta.previousElementSibling,row);assert.equal(actions.querySelector('[data-reply]').dataset.reply,article.dataset.id);assert.equal(actions.querySelector('[data-picker]').dataset.picker,article.dataset.id);
 }
 const assistant=document.querySelector('.assistant'),user=document.querySelector('.user');assert.equal(assistant.querySelector('.message-meta .reactions button').dataset.emoji,'❤️');assert.ok(user.querySelector('.message-meta .delivery-state'));assert.equal(user.querySelector('.message-meta .task-status'),null);
 const image=assistant.querySelector('[data-preview="picture"]'),download=assistant.querySelector('button[data-download="report"]'),view=assistant.querySelector('button[data-file-preview="report"]');assert.equal(image.closest('.bubble'),assistant.querySelector('.bubble'));assert.equal(download.closest('.bubble'),assistant.querySelector('.bubble'));assert.equal(download.getAttribute('type'),'button');assert.equal(download.hasAttribute('href'),false);assert.match(view.textContent,/Long-report-name.txt/);assert.equal(download.querySelector('.message-actions'),null);
 const reply=assistant.querySelector('[data-reply]');let clicked=0;reply.addEventListener('click',()=>clicked++);c.state.messages[0].text+=' New streamed text';const next=document.createElement('main');next.innerHTML=c.renderMessages();reconcile(document.querySelector('main'),next);assert.equal(document.querySelector('.assistant [data-reply]'),reply);reply.dispatchEvent(new Event('click'));assert.equal(clicked,1);
 const css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');assert.match(css,/\.message-bubble-row\{[^}]*display:flex;align-items:center/);assert.match(css,/\.user \.message-bubble-row\{flex-direction:row-reverse/);assert.match(css,/@media\(hover:none\),\(pointer:coarse\)\{\.message-bubble-row>\.message-actions\{opacity:1;pointer-events:auto/);assert.match(css,/\.message-bubble-row \.file-card\{min-width:0/);assert.match(css,/\.message-bubble-row>\.bubble\{[^}]*min-width:0/);
 const actionRules=[...css.matchAll(/([^{}]*\.message-actions[^{}]*)\{([^{}]*)\}/g)].map(match=>match[2]).join(';');assert.doesNotMatch(actionRules,/position\s*:\s*(?:absolute|fixed)/);
});

test('cancelled chat messages retain their content and receipts without retry or task-error furniture in either language',()=>{
 for(const language of ['zh','en']){
  const {context:c}=fixture(language);c.state.messages=[
   {id:'cancelled',role:'user',status:'cancelled',text:'Please find my profile',time:1,executorConfirmedAt:2,error:'The task stopped before completion.',attachments:[{id:'note',name:'note.txt',type:'text/plain',size:12}]},
   {id:'reply',role:'assistant',status:'completed',text:'Do you mean the page link or the configuration file?',replyTo:'cancelled',time:2,attachments:[]},
   {id:'failed',role:'user',status:'failed',text:'A separate failed request',time:3,error:'A real failure'},
   {id:'interrupted',role:'user',status:'interrupted',text:'An interrupted request',time:4},
   {id:'unknown',role:'user',status:'failed',submission:'unknown',text:'An uncertain request',time:5}
  ];
  const {document}=parseHTML('<main>'+c.renderMessages()+'</main>'),cancelled=document.querySelector('[data-id="cancelled"]');
  assert.match(cancelled.querySelector('.markdown').textContent,/Please find my profile/);assert.ok(cancelled.querySelector('[data-file-preview="note"]'));assert.ok(cancelled.querySelector('[data-reply]'));assert.ok(cancelled.querySelector('.delivery-state'));assert.equal(cancelled.querySelector('.delivery-state').title,language==='zh'?'执行器已读':'Read by executor');
  assert.equal(cancelled.querySelector('[data-retry],.retry-message,.task-status,.error'),null);assert.doesNotMatch(cancelled.textContent,/Cancelled|已取消|Retry|重试|The task stopped before completion/);
  const reply=document.querySelector('[data-id="reply"]');assert.match(reply.querySelector('.markdown').textContent,/page link or the configuration file/);assert.match(reply.querySelector('blockquote').textContent,/Please find my profile/);
  assert.match(document.querySelector('[data-retry="failed"]').textContent,language==='zh'?/失败 · 重试/:/Failed · Retry/);assert.ok(document.querySelector('[data-id="failed"] .error'));assert.ok(document.querySelector('[data-retry="interrupted"]'));assert.equal(document.querySelector('[data-retry="unknown"]').textContent,language==='zh'?'查看未确认的任务':'Review unconfirmed task');
 }
});

test('an already-bound chat retry cannot replay a message cancelled or removed before the click',async()=>{
 const {context:c}=fixture('en'),attempts=[],toasts=[];c.state.messages=[{id:'was-failed',role:'user',status:'failed',text:'A request',time:1}];
 const {document}=parseHTML('<main>'+c.renderMessages()+'</main><input id="file-input" type="file" hidden>');c.document=document;
 for(const method of ['bindSteer','bindProvision','bindVoiceKey','bindTelegram','bindAppearance','bindVMSettings','bindComputerInput'])c[method]=()=>{};
 c.resumeTask=async id=>attempts.push(id);c.toast=text=>toasts.push(text);c.openModal=()=>attempts.push('review');vm.runInContext(section('function bind(){','async function taskRequest('),c);c.bind();
 const button=document.querySelector('[data-retry]');assert.ok(button);c.state.messages[0].status='cancelled';c.state.messages[0].submission='unknown';await button.onclick();assert.deepEqual(attempts,[],'a stale cancelled button cannot resume or open an unrelated recovery flow');
 c.state.messages=[];await button.onclick();assert.deepEqual(attempts,[]);assert.deepEqual(toasts,[]);
 c.state.messages=[{id:'was-failed',role:'user',status:'failed'}];await button.onclick();assert.deepEqual(attempts,['was-failed'],'a still-valid failure retains its existing retry action');
});

test('dant-owned reactions on user messages stay distinct, localized and non-editable beside matching human feedback',async()=>{
 for(const [language,label]of [['zh','dant 的回应：赞'],['en','dant reacted: Like']]){
  const {context:c}=fixture(language),requests=[];c.state.messages=[{id:'reacted-user',role:'user',status:'review',text:'Thank you',time:1,reactions:['👍'],assistantReaction:'👍',assistantReactionUpdatedAt:2,attachments:[]}];
  const {document,Event}=parseHTML('<main>'+c.renderMessages()+'</main><input id="file-input" type="file" hidden>');c.document=document;
  for(const method of ['bindSteer','bindProvision','bindVoiceKey','bindTelegram','bindAppearance','bindVMSettings','bindComputerInput'])c[method]=()=>{};
  c.post=async(route,body)=>requests.push({route,body});c.toast=()=>{};vm.runInContext(section('function bind(){','async function taskRequest('),c);c.bind();
  const badge=document.querySelector('.user .assistant-reaction'),human=document.querySelector('.user .reactions button');assert.ok(badge,'an actual dant reaction must be visible');assert.equal(badge.tagName,'SPAN');assert.equal(badge.getAttribute('role'),'img');assert.equal(badge.title,label);assert.equal(badge.getAttribute('aria-label'),label);assert.equal(badge.querySelector('small').textContent,'dant');assert.equal(badge.querySelector('span').textContent,'👍');assert.equal(badge.hasAttribute('data-react'),false);assert.equal(badge.querySelector('button,[data-react],[data-action]'),null);assert.equal(badge.hasAttribute('tabindex'),false);
  assert.ok(human);assert.equal(human.dataset.emoji,'👍');assert.equal(human.dataset.react,'reacted-user');assert.equal(document.querySelectorAll('.user .reactions').length,1);assert.equal(document.querySelectorAll('.user .reactions > *').length,2,'the same emoji may belong to dant and the human independently');
  badge.dispatchEvent(new Event('click',{bubbles:true}));await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,0,'a user cannot toggle dant-owned feedback');
  human.dispatchEvent(new Event('click',{bubbles:true}));await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,1);assert.equal(requests[0].route,'/messages/reacted-user/reaction');assert.equal(requests[0].body.emoji,'👍');assert.equal(c.state.messages[0].assistantReaction,'👍');
 }
});

test('dant reactions are never guessed from message content and only apply to user messages',()=>{
 const {context:c}=fixture();c.state.messages=[{id:'plain-user',role:'user',status:'review',text:'I love this! 👍',time:1,reactions:[],attachments:[]},{id:'assistant',role:'assistant',status:'completed',text:'Thanks!',time:2,reactions:[],assistantReaction:'❤️',attachments:[]}];
 const {document}=parseHTML('<main>'+c.renderMessages()+'</main>');assert.equal(document.querySelector('.assistant-reaction'),null);
 c.state.messages[0].assistantReaction='❤️';let next=document.createElement('main');next.innerHTML=c.renderMessages();reconcile(document.querySelector('main'),next);assert.equal(document.querySelector('.user .assistant-reaction').getAttribute('aria-label'),'dant 的回应：爱');
 c.state.messages[0].assistantReaction=null;next=document.createElement('main');next.innerHTML=c.renderMessages();reconcile(document.querySelector('main'),next);assert.equal(document.querySelector('.assistant-reaction'),null,'backend cancellation removes only dant feedback');
});

test('reaction popups expand from the adjacent toolbar and remain within the chat viewport',()=>{
 const {context:c}=fixture(),properties=new Map(),menu={dataset:{},style:{setProperty:(key,value)=>properties.set(key,value)},getBoundingClientRect:()=>rect},viewport={getBoundingClientRect:()=>({left:44,right:364,top:20,width:320}),querySelectorAll:()=>[menu]};let rect={left:-78,right:112,top:60};c.document.querySelector=selector=>selector==='#messages'?viewport:null;
 c.positionReactionMenus();assert.equal(properties.get('--reaction-shift'),'130px');assert.equal(menu.style.maxWidth,'304px');assert.equal(menu.dataset.placement,'above');assert.equal(rect.left+130,52,'short assistant bubbles cannot place the menu over the sidebar');
 rect={left:300,right:490,top:0};c.positionReactionMenus();assert.equal(properties.get('--reaction-shift'),'-134px');assert.equal(menu.dataset.placement,'below');assert.equal(rect.right-134,356,'right-aligned user bubbles cannot push the menu outside chat');
 rect={left:100,right:290,top:70};c.positionReactionMenus();assert.equal(properties.get('--reaction-shift'),'0px');assert.equal(menu.dataset.placement,'above');
 c.document.querySelector=()=>null;assert.doesNotThrow(()=>c.positionReactionMenus());c.document.querySelector=()=>({getBoundingClientRect:()=>({width:0})});assert.doesNotThrow(()=>c.positionReactionMenus());
 c.emojiFor='user-menu';c.state.messages=[{id:'user-menu',role:'user',text:'Hi',status:'review',time:1,attachments:[],reactions:[]}];const {document}=parseHTML('<main>'+c.renderMessages()+'</main>');assert.equal(document.querySelector('.reaction-menu').parentNode,document.querySelector('.user .message-actions'));
 const css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');assert.match(css,/\.message-bubble-row>\.message-actions\{position:relative;display:flex/);assert.match(css,/\.reaction-menu\{position:absolute;left:auto;right:0;bottom:calc\(100% \+ 8px\)/);assert.match(css,/\.user \.reaction-menu\{left:0;right:auto/);assert.doesNotMatch(css,/\.reaction-menu\{[^}]*left:22px/);
});
