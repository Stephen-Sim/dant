import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {SpeechHelper,speechMessages} from '../ui/speech.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture(selected='zh'){
 const storage=new Map(),requests=[];
 const context={fallbackLanguage:'zh',state:{settings:{language:selected,vm:{host:'',user:'dant',port:22,keyPath:''},nativeVoice:'ember',apiVoice:'marin',notifications:false,model:''},worker:{status:'online',account:null,models:[],realtime:{subscription:{available:true},key:{configured:false}}},messages:[],queue:[],schedules:[],active:null,call:null,memory:''},page:'chat',chatMode:'text',showComputer:false,eventConnected:true,pc:null,stream:null,callStarting:false,callMini:false,callMuted:false,callConnected:false,callChannel:null,callProvider:'subscription',callStops:{pending:false},messageSubmissions:{unknown:null},pendingActions:new Set(),voiceChoices:['ember'],apiVoiceChoices:['marin'],voiceApiExpanded:false,voiceError:'',vmDraft:null,manualVMExpanded:false,provisionDraft:{cpu:4,memoryGB:6,diskGB:40,adminSudo:false},provisionExpanded:false,steerExpectedTurn:null,steerDraft:'',progressExpanded:false,scheduleDraft:{text:'',at:''},composerDraft:'',replyTo:null,attachments:[],uploading:0,sending:false,recording:null,recordStarting:false,dictating:false,speakingId:null,attachmentMenu:false,screenURL:'',screenError:'',innerWidth:1440,modal:null,
 localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},api:async(route,options)=>{requests.push({route,options});return {ok:true};},render:()=>{},esc:value=>String(value??''),ico:name=>`<svg>${name}</svg>`,button:(action,icon,label)=>`<button data-action="${action}" aria-label="${label}">${label}</button>`,eyes:()=>'',md:text=>text,formatTime:()=>'',humanControl:()=>false,unknownTask:message=>message?.submission==='unknown',speechBlocked:()=>false,renderLoginDetails:()=>'',fileURL:file=>'/fixture/'+file.id,
 };
 vm.createContext(context);vm.runInContext([
 section('const zh={','const subscriptionVoiceUnavailable='),
 section('const subscriptionVoiceUnavailable=','const esc='),
 section('function renderHeader(status){','function renderAttachmentOptions(){'),
 section('function renderAttachmentOptions(){','function speechBlocked(){'),
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

test('settings language persists and updates pages, status, accessibility and retained errors',async()=>{
 const {context:c,storage,requests}=fixture();assert.match(c.renderHeader('online'),/在线/);assert.match(c.renderChat(),/aria-label="听写"/);
 c.voiceError='voiceUnavailable';c.screenError=true;
 await c.changeLanguage('en');assert.equal(storage.get('dant.language'),'en');assert.equal(requests[0].route,'/settings');assert.equal(requests[0].options.body.language,'en');
 assert.match(c.renderHeader('online'),/Online/);assert.match(c.renderChat(),/Message dant…/);assert.match(c.renderChat(),/aria-label="Dictate"/);assert.doesNotMatch(c.renderChat(),/听写|上传|录音/);
 const computer=c.renderComputer();assert.match(computer,/aria-label="Resize computer panel"/);assert.match(computer,/aria-label="Work computer keyboard input"/);assert.match(computer,/The desktop could not refresh/);
 assert.match(c.renderSettings(),/Settings|Language|Call voice/);assert.match(c.renderVoiceSettings(c.state.settings),/Voice options are unavailable/);assert.match(c.renderMemory(),/No shared memories yet/);assert.match(c.renderSchedules(),/No scheduled tasks yet/);
 await c.changeLanguage('zh');assert.equal(storage.get('dant.language'),'zh');assert.match(c.renderComputer(),/调整电脑区域宽度|桌面暂时无法刷新/);assert.match(c.renderVoiceSettings(c.state.settings),/暂时无法获取声音选项/);assert.match(c.renderMemory(),/我们还没有共同的记忆/);assert.match(c.renderSchedules(),/还没有定时任务/);
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
 const diagnostic='Worker failed with diagnostic 0x80370102';assert.equal(c.errorText(Error(diagnostic)),'请求失败：'+diagnostic);assert.equal(c.errorText(diagnostic,'serviceNotice'),'服务提示：'+diagnostic);
 c.state.settings.language='en';assert.equal(c.errorText(Error(diagnostic)),'Request failed: '+diagnostic);assert.match(c.errorText(Error('The voice call changed')),/The call changed/);assert.match(c.errorText({name:'NotFoundError',message:'device missing'}),/No microphone was found/);assert.match(c.errorText(Error('The computer connected, but its default response language could not be updated.')),/default response language could not be updated/);
});

test('speech fallback failures and microphone permissions follow the requested language without device access',async()=>{
 for(const language of ['zh','en']){
  const helper=new SpeechHelper({desktop:false,recognizer:null,synthesis:null});await assert.rejects(helper.dictate(language),language==='zh'?/当前浏览器不支持听写/:/Dictation is not supported/);await assert.rejects(helper.speak('fixture',language),language==='zh'?/当前浏览器不支持朗读/:/Read aloud is not supported/);
  let recognition;class Recognizer{constructor(){recognition=this;}start(){}abort(){this.onend?.();}}
  const recognizer=new SpeechHelper({desktop:false,recognizer:Recognizer,synthesis:null});const listening=recognizer.dictate(language);await Promise.resolve();recognition.onerror({error:'not-allowed'});recognition.onend();await assert.rejects(listening,language==='zh'?/麦克风权限未获准/:/Microphone permission was not granted/);
 }
});
