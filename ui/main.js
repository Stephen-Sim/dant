import './style.css';
import {createElement,MessageCircle,Monitor,Settings,Brain,ArrowUp,Plus,Phone,Mic,Square,X,ArrowLeft,Reply,Smile,Check,CheckCheck,Paperclip,Volume2,Clock,Minimize2,Maximize2,MicOff,LogIn,RefreshCw,ExternalLink,ChevronRight,Download,Pause,MoreHorizontal,ChevronDown,FileText,ArrowDown} from 'lucide';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import {reconcile} from './dom.js';
import {createTransport} from './transport.js';
import {createMessageSubmissions,createCallStops} from './pending.js';
import {SpeechHelper} from './speech.js';
const icons={MessageCircle,Monitor,Settings,Brain,ArrowUp,Plus,Phone,Mic,Square,X,ArrowLeft,Reply,Smile,Check,CheckCheck,Paperclip,Volume2,Clock,Minimize2,Maximize2,MicOff,LogIn,RefreshCw,ExternalLink,ChevronRight,Download,Pause,MoreHorizontal,ChevronDown,FileText,ArrowDown};
const base=window.__TAURI_INTERNALS__?'http://127.0.0.1:4317':'';
let token='',state=null,page='chat',showComputer=localStorage.getItem('computer')==='true',replyTo=null,attachments=[],ws,screenTimer,screenBusy=false,pc,stream,audio,callMini=false,callMuted=false,callStart=0,recording,recordChunks=[],lastAssistant=new Set(),initialized=false;
let composerDraft='',vmDraft=null,scheduleDraft={text:'',at:''},loginDetails=null,sending=false,uploading=0,eventConnected=false,callStarting=false,callGeneration=0,callTimeout,recordStarting=false,provisionDraft={cpu:4,memoryGB:6,diskGB:40,adminSudo:false},provisionExpanded=false,voiceApiExpanded=false,voiceChoices=[],voiceLoadedFor='',voiceError='',screenURL='',screenError='',screenFailures=0,unloading=false;
let chatMode='text',modal=null,modalFocus=null,emojiFor=null,manualVMExpanded=false,progressExpanded=false,screenLoad=null,screenAbort=null,screenEpoch=0,steerDraft='',steerExpectedTurn=null;
let apiVoiceChoices=[],callId=null,callChannel=null,callConnected=false,callProvider='subscription',dictating=false,speakingId=null,speechGeneration=0,attachmentMenu=false;
const speech=new SpeechHelper();
const reactionOptions=['👍','❤️','😂','👀','🎉'];
const transport=createTransport({base,onToken:value=>token=value});
const messageSubmissions=createMessageSubmissions(),callStops=createCallStops(id=>post('/call/stop',{callId:id}));
const app=document.querySelector('#app');
document.body.insertAdjacentHTML('beforeend','<div id="toast" role="status" aria-live="polite"></div>');
const zh={chat:'对话',computer:'工作电脑',settings:'设置',memory:'记忆',schedules:'提醒与任务',offline:'未连接',online:'在线',connecting:'连接中',working:'正在工作',takeover:'你正在接管',ready:'随时可以开始',hello:'嗨，我是 dant。',intro:'你的数字伙伴，有自己的电脑。',placeholder:'和 dant 说点什么…',setup:'连接我的电脑',setupHint:'先连接 Ubuntu 工作电脑，再登录 ChatGPT。',send:'发送',attach:'添加文件',call:'语音通话',record:'语音消息',stop:'停止',take:'接管电脑',give:'交还 dant',computerHint:'dant 的工作空间',computerEmpty:'电脑还未连接',computerSub:'在设置中连接 VM，即可查看桌面和接管操作。',close:'关闭',general:'通用',language:'语言',notify:'任务完成通知',notifySub:'完成后有未读消息时提醒我',connection:'工作电脑',host:'VM IP 地址',user:'用户名',port:'SSH 端口',key:'SSH 私钥路径',save:'保存',connect:'连接',account:'ChatGPT 账号',login:'登录 ChatGPT',logout:'退出登录',model:'模型',default:'账号默认',voice:'通话声音',voiceSub:'使用 Codex 实验实时通话接口，支持情况取决于账号。',memoryTitle:'dant 的记忆',memorySub:'由 dant 自己维护，独立于 ChatGPT 记忆。',memoryEmpty:'我们还没有共同的记忆。聊起来后，dant 会在这里记下值得保留的事情。',retry:'重试',failed:'发送失败',interrupted:'已停止',queued:'排队中',running:'处理中',read:'已读',completed:'已完成',callEnded:'通话已结束',calling:'正在连接…',talking:'正在通话',mic:'麦克风',hangup:'挂断',expand:'展开',minimize:'缩小',scheduleTitle:'稍后交给 dant',scheduleHint:'应用和 VM 在线时执行；离线错过的任务会在重连后执行。',task:'任务内容',at:'执行时间',add:'添加任务',pending:'待执行',dispatched:'已交付',onboarding:'从零搭建',onboardingSub:'Windows + Hyper-V · Ubuntu 24.04 · 独立桌面',onboardingBody:'运行项目中的 scripts/prepare-vm.ps1 准备镜像，再以管理员身份执行 scripts/create-vm.ps1。完成后连接信息会保存到 data/vm.json。',emptySchedules:'还没有定时任务',reply:'回复',fileLimit:'单个文件最多 10 MiB',recording:'正在录音，再次点击结束',refresh:'刷新连接',messageError:'请求失败',time:'时间'};
const en={chat:'Chat',computer:'Computer',settings:'Settings',memory:'Memory',schedules:'Scheduled tasks',offline:'Disconnected',online:'Online',connecting:'Connecting',working:'Working',takeover:'You have control',ready:'Ready when you are',hello:'Hey, I’m dant.',intro:'Your digital companion, with a computer of its own.',placeholder:'Message dant…',setup:'Connect my computer',setupHint:'Connect an Ubuntu computer, then sign in to ChatGPT.',send:'Send',attach:'Attach files',call:'Voice call',record:'Voice message',stop:'Stop',take:'Take control',give:'Return to dant',computerHint:'A space to get things done',computerEmpty:'Computer is not connected',computerSub:'Connect your VM in settings to see and control the desktop.',close:'Close',general:'General',language:'Language',notify:'Completion notifications',notifySub:'Notify me when work finishes with unread messages',connection:'Work computer',host:'VM IP address',user:'Username',port:'SSH port',key:'SSH private key path',save:'Save',connect:'Connect',account:'ChatGPT account',login:'Sign in with ChatGPT',logout:'Sign out',model:'Model',default:'Account default',voice:'Call voice',voiceSub:'Uses Codex experimental realtime calls; availability depends on your account.',memoryTitle:'dant’s memory',memorySub:'Maintained by dant, independently of ChatGPT memory.',memoryEmpty:'No shared memories yet. As we work together, dant will keep useful things here.',retry:'Retry',failed:'Failed',interrupted:'Stopped',queued:'Queued',running:'Working',read:'Read',completed:'Completed',callEnded:'Call ended',calling:'Connecting…',talking:'In a call',mic:'Microphone',hangup:'Hang up',expand:'Expand',minimize:'Minimize',scheduleTitle:'Leave it with dant',scheduleHint:'Runs while the app and VM are online. Missed tasks run after reconnecting.',task:'Task',at:'Run at',add:'Schedule task',pending:'Pending',dispatched:'Dispatched',onboarding:'Set up from scratch',onboardingSub:'Windows + Hyper-V · Ubuntu 24.04 · Private desktop',onboardingBody:'Run scripts/prepare-vm.ps1 to prepare the image, then run scripts/create-vm.ps1 as administrator. Connection details are saved to data/vm.json.',emptySchedules:'No scheduled tasks yet',reply:'Reply',fileLimit:'Maximum 10 MiB per file',recording:'Recording. Click again to finish.',refresh:'Reconnect',messageError:'Request failed',time:'Time'};
Object.assign(zh,{voiceKeyRequired:'独立 API 语音尚未配置，请在设置中添加可选的语音 Key。',voiceNativeInfo:'默认通话使用 ChatGPT 订阅额度，无需另配 API Key。',voiceNativeDoc:'ChatGPT 语音说明',voiceNativePricing:'订阅额度与定价',voiceApiOptional:'可选：独立 API 语音',voiceApiRequired:'独立 API 语音尚未配置。',voiceOptional:'可选',voiceBilling:'启用此可选通道后，语音通过 OpenAI API 单独计费；文字与电脑任务继续使用 ChatGPT 订阅。',voiceKeyConfigured:'独立 API Key 已配置',voiceKeyMissing:'独立 API Key 未配置',voiceKeyLabel:'OpenAI API Key',voiceKeySave:'保存 Key',voiceKeyUpdate:'更新 Key',voiceKeyRemove:'移除 Key',voiceKeySaved:'语音 Key 已保存',voiceKeyRemoved:'语音 Key 已移除',voiceKeyGet:'获取 API Key',voiceKeyUsage:'用量与费用',voiceKeyEnvironment:'来自启动环境；请在启动环境中移除。',voiceKeyValidation:'在独立 API 通话开始时验证 Key 是否可用。',voiceKeyCallActive:'请先结束通话再修改语音 Key。','awaiting-admin':'请在 Windows 提示中允许创建电脑',installing:'正在安装桌面与工作环境…',onboardingBody:'为 dant 创建独立的 Ubuntu 桌面。Windows 将请求管理员权限以配置虚拟机。',createComputer:'创建工作电脑',createReady:'电脑已创建',createOptions:'资源与权限',cpu:'处理器核心',memorySize:'内存 (GB)',diskSize:'磁盘 (GB)',vmAdmin:'允许 dant 管理自己的电脑',vmAdminHint:'允许在虚拟机中安装软件和修改系统设置',manualConnection:'连接现有电脑',preparing:'正在准备电脑…',creating:'正在创建电脑…','guest-installing':'正在安装桌面与工作环境…',provisionReady:'工作电脑准备完成',provisionFailed:'创建失败',voiceSub:'选择订阅通话使用的声音。',record:'录音附件',voiceUnavailable:'暂时无法获取声音选项，请检查电脑连接与登录状态。',callFailed:'通话连接失败，请重试',mediaUnavailable:'当前环境无法使用麦克风，请使用本地浏览器打开 dant',sendFailed:'发送失败，内容已保留',screenFailed:'桌面暂时无法刷新，请检查电脑连接',connectionLost:'本地服务已断开，正在重新连接…'});
Object.assign(en,{voiceKeyRequired:'Separate API voice is not configured. Add an optional voice key in settings.',voiceNativeInfo:'Calls use your ChatGPT subscription allowance by default. No separate API key is required.',voiceNativeDoc:'About ChatGPT voice',voiceNativePricing:'Subscription allowances and pricing',voiceApiOptional:'Optional: separate API voice',voiceApiRequired:'Separate API voice has not been configured.',voiceOptional:'Optional',voiceBilling:'When enabled, this optional voice channel is billed separately through the OpenAI API. Text and computer tasks continue to use your ChatGPT subscription.',voiceKeyConfigured:'Separate API key configured',voiceKeyMissing:'No separate API key configured',voiceKeyLabel:'OpenAI API key',voiceKeySave:'Save key',voiceKeyUpdate:'Update key',voiceKeyRemove:'Remove key',voiceKeySaved:'Voice key saved',voiceKeyRemoved:'Voice key removed',voiceKeyGet:'Get an API key',voiceKeyUsage:'Usage and billing',voiceKeyEnvironment:'Managed by the launch environment. Remove it there.',voiceKeyValidation:'The key will be validated when you start a separate API call.',voiceKeyCallActive:'End your call before changing the voice key.','awaiting-admin':'Allow setup in the Windows permission prompt',installing:'Installing the desktop and work environment…',onboardingBody:'Create a private Ubuntu desktop for dant. Windows will request administrator permission to set up the virtual machine.',createComputer:'Create work computer',createReady:'Computer created',createOptions:'Resources and permissions',cpu:'Processor cores',memorySize:'Memory (GB)',diskSize:'Disk (GB)',vmAdmin:'Allow dant to manage its computer',vmAdminHint:'Allow software installation and system changes inside the virtual machine',manualConnection:'Connect an existing computer',preparing:'Preparing the computer…',creating:'Creating the computer…','guest-installing':'Installing the desktop and work environment…',provisionReady:'Your work computer is ready',provisionFailed:'Setup failed',voiceSub:'Choose the voice for subscription calls.',record:'Record an attachment',voiceUnavailable:'Voice options are unavailable. Check the computer connection and sign-in status.',callFailed:'Call connection failed. Please try again.',mediaUnavailable:'Microphone access is unavailable. Open dant in a local browser.',sendFailed:'Message could not be sent. Your draft was kept.',screenFailed:'The desktop could not refresh. Check the computer connection.',connectionLost:'The local service disconnected. Reconnecting…'});
Object.assign(zh,{acceptTask:'接受结果',resumeTask:'继续任务',unknownOutcome:'结果未确认',unknownHint:'上次执行的结果尚未确认，重新执行可能重复已经完成的操作。',confirmRepeat:'我确认重新执行',viewUnknown:'查看未确认的任务',steerTask:'调整当前任务',steerHint:'补充或调整正在执行的任务…',sendSteer:'发送调整',steerChanged:'当前任务已变化，请检查后重新输入调整内容。',clear:'清空',fileLimit:'单个文件最多 10 MiB',attachmentLimit:'每条消息最多添加 5 个附件',connectionChanged:'工作电脑连接已变化，请重新接管。',review:'待验收',paused:'已暂停',accepted:'已收到',executorRead:'执行器已读',received:'已收到',you:'你',existingComputerConfigured:'已连接现有工作电脑。连接状态与信息如下。',settingsTitle:'设置与工作电脑',backChat:'返回聊天',details:'对话详情',files:'交付文件与附件',filesEmpty:'这段对话还没有文件。',progress:'工作进度',progressEmpty:'还没有任务记录。',currentTask:'正在处理',queuedTasks:'等待处理',taskHistory:'最近的任务',fileShared:'你发送的文件',fileDelivered:'dant 交付的文件',imagePreview:'图片预览',download:'下载文件',reactions:'添加表情',textMode:'文字对话',voiceMode:'语音通话',callReady:'准备好时，开始聊吧',startCall:'开始订阅通话',callUnavailable:'订阅通话暂时不可用，请检查连接与登录状态。',voiceSettings:'查看语音设置',controlledByDant:'由 dant 控制',viewComputer:'查看工作电脑',connectionSettings:'连接设置',computerDetails:'电脑状态',computerSystem:'Ubuntu 24.04 · amd64 · Hyper-V',adminPermissions:'管理权限',standardPermissions:'标准权限',fullPermissions:'允许管理',permissionsForNew:'在创建工作电脑时生效。',currentPermissions:'现有工作电脑的管理权限由其系统配置决定。',permissionsAdminHint:'允许 dant 在自己的虚拟机中安装软件、修改系统设置。',permissionsStandardHint:'dant 使用普通账户权限；需要管理权限的操作由你处理。',accountSubscription:'ChatGPT 订阅',subscriptionTasks:'文字对话与工作电脑任务使用此订阅。',languageHint:'用于界面文字和通知。',settingsMore:'记忆与定时任务',connectionDetails:'连接信息',takingControl:'正在接管…',returningControl:'正在交还…',voiceSetup:'语音设置',recordHint:'录音会作为附件发送',noActiveTask:'当前没有正在处理的任务',setupDetails:'准备工作电脑',setupSummary:'为 dant 配置自己的 Ubuntu 工作空间',setupReady:'工作电脑已准备好，可以开始聊天了。',setupBeforeCreate:'请确认资源与管理权限，然后创建工作电脑。',timeLabel:'最后更新',cancelled:'已取消',failed:'失败',completed:'已完成',read:'已读',stopWork:'停止当前工作'});
Object.assign(en,{acceptTask:'Accept result',resumeTask:'Resume task',unknownOutcome:'Outcome unconfirmed',unknownHint:'The previous outcome is unconfirmed. Running again may repeat work that already happened.',confirmRepeat:'I confirm: run again',viewUnknown:'Review unconfirmed task',steerTask:'Adjust current task',steerHint:'Add instructions for the task in progress…',sendSteer:'Send adjustment',steerChanged:'The current task changed. Review and re-enter your adjustment.',clear:'Clear',fileLimit:'Maximum 10 MiB per file',attachmentLimit:'Up to 5 attachments per message',connectionChanged:'The computer connection changed. Take control again.',review:'Awaiting review',paused:'Paused',accepted:'Received',executorRead:'Read by executor',received:'Received',you:'You',existingComputerConfigured:'An existing work computer is configured. Its connection details are shown below.',settingsTitle:'Settings & work computer',backChat:'Back to chat',details:'Conversation details',files:'Delivered files & attachments',filesEmpty:'No files in this conversation yet.',progress:'Work progress',progressEmpty:'No task history yet.',currentTask:'In progress',queuedTasks:'Waiting',taskHistory:'Recent tasks',fileShared:'Your attachment',fileDelivered:'Delivered by dant',imagePreview:'Image preview',download:'Download file',reactions:'Add a reaction',textMode:'Text chat',voiceMode:'Voice call',callReady:'Ready when you are',startCall:'Start subscription call',callUnavailable:'Subscription calls are unavailable. Check the connection and sign-in status.',voiceSettings:'Voice settings',controlledByDant:'Controlled by dant',viewComputer:'View work computer',connectionSettings:'Connection settings',computerDetails:'Computer status',computerSystem:'Ubuntu 24.04 · amd64 · Hyper-V',adminPermissions:'Administration',standardPermissions:'Standard access',fullPermissions:'Allow administration',permissionsForNew:'Applies when creating a work computer.',currentPermissions:'The existing computer’s system configuration determines its administration permissions.',permissionsAdminHint:'Allow dant to install software and change system settings inside its virtual machine.',permissionsStandardHint:'dant uses a standard account. You handle operations that require administration.',accountSubscription:'ChatGPT subscription',subscriptionTasks:'Text conversations and computer tasks use this subscription.',languageHint:'Used for interface text and notifications.',settingsMore:'Memory & scheduled tasks',connectionDetails:'Connection information',takingControl:'Taking control…',returningControl:'Returning control…',voiceSetup:'Voice settings',recordHint:'Recordings are sent as attachments',noActiveTask:'No task is running right now',setupDetails:'Prepare work computer',setupSummary:'Set up a private Ubuntu workspace for dant',setupReady:'Your work computer is ready. You can start chatting.',setupBeforeCreate:'Review resources and permissions, then create your work computer.',timeLabel:'Last updated',cancelled:'Cancelled',failed:'Failed',completed:'Completed',read:'Read',stopWork:'Stop current work'});
Object.assign(zh,{voiceApiVoice:'API 通话声音',voiceApiStart:'开始独立 API 通话',voiceApiHint:'独立 API 通话使用此声音。',voiceSubscriptionUsage:'使用 ChatGPT 订阅额度',voiceApiActive:'独立 API 通话 · 单独计费'});
Object.assign(en,{voiceApiVoice:'API call voice',voiceApiStart:'Start separate API call',voiceApiHint:'The voice used for separate API calls.',voiceSubscriptionUsage:'Uses your ChatGPT subscription allowance',voiceApiActive:'Separate API call · billed separately'});
Object.assign(zh,{sendUnknown:'发送结果未确认',sendUnknownHint:'请求可能已经送达。请先检查任务状态；明确重新发送可能重复已经执行的工作。',checkSend:'检查任务状态',confirmResend:'我确认重新发送',sendStillUnknown:'尚未找到这次发送的确认，草稿已保留。',sendFound:'已找到这条消息，任务不会重复发送。',callPendingStop:'连接已断开，正在等待结束通话。',callRecover:'工作电脑中仍有通话，请先结束后重新连接。',callNeedsStop:'请先结束尚未确认关闭的通话。',callAttachment:'通话期间暂不能发送附件，请结束通话后发送。'});
Object.assign(en,{sendUnknown:'Message outcome unconfirmed',sendUnknownHint:'The request may already have arrived. Check task status first. Explicitly sending again may repeat work that already happened.',checkSend:'Check task status',confirmResend:'I confirm: send again',sendStillUnknown:'No confirmation was found yet. Your draft was kept.',sendFound:'The message was found. It will not be sent again.',callPendingStop:'The connection was lost. Waiting to end the call.',callRecover:'A call remains on the work computer. End it before reconnecting.',callNeedsStop:'End the call whose shutdown is still unconfirmed first.',callAttachment:'Attachments cannot be sent during a call yet. Send them after ending the call.'});
Object.assign(zh,{dictate:'听写',dictating:'正在听写，点击停止',stopSpeech:'停止语音辅助',readAloud:'朗读',reading:'正在朗读',speechDuringCall:'请先结束通话，再使用听写或朗读。',emptyDictation:'没有识别到文字，请重试。',attachOptions:'附件选项',recordAttachment:'录音附件',finishRecording:'请先结束录音附件。'});
Object.assign(en,{dictate:'Dictate',dictating:'Listening. Click to stop.',stopSpeech:'Stop speech helper',readAloud:'Read aloud',reading:'Reading aloud',speechDuringCall:'End the call before using dictation or read aloud.',emptyDictation:'No words were recognized. Please try again.',attachOptions:'Attachment options',recordAttachment:'Record an attachment',finishRecording:'Finish recording the attachment first.'});
Object.assign(zh,{voiceTaskAdjust:'通话中的任务调整，请在聊天输入框发送文字。',resumeAfterCall:'结束通话后继续'});
Object.assign(en,{voiceTaskAdjust:'To adjust work during a call, send text in the chat composer.',resumeAfterCall:'End the call before resuming'});
const t=k=>(state?.settings.language==='en'?en:zh)[k]||k;
const subscriptionVoiceUnavailable=()=>state?.worker.realtime?.subscription?.available===false;
const apiVoiceUnavailable=()=>state?.worker.realtime?.api?.available===false||!voiceKeyConfigured();
const humanControl=()=>state?.computer?state.computer.status==='human':Boolean(state?.takeover);
const unknownTask=message=>Boolean(message?.unknownOutcome||message?.submission==='unknown');
const voiceKeyConfigured=()=>state?.worker.realtime?.key?.configured??(state?.worker.realtime?.provider==='openai'&&state?.worker.realtime?.available===true);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconCache=new Map();
const ico=(name,cls='')=>{const cacheKey=name+':'+cls;if(!iconCache.has(cacheKey)){const definition=icons[name.replace(/(^|-)([a-z])/g,(_,dash,char)=>char.toUpperCase())];iconCache.set(cacheKey,definition?createElement([definition[0],{...definition[1],class:cls,'aria-hidden':'true'},definition[2]]).outerHTML:'');}return iconCache.get(cacheKey);};
const button=(action,icon,label,cls='icon-btn')=>`<button type="button" class="${cls}" data-action="${action}" title="${esc(label)}" aria-label="${esc(label)}">${ico(icon)}${cls.includes('text-btn')?`<span>${esc(label)}</span>`:''}</button>`;
const eyes=(cls='')=>`<div class="eyes ${cls}" aria-hidden="true"><img src="/brand/${cls.includes('call')?'dant-avatar':'dant-logo'}.svg" alt="" draggable="false"></div>`;
async function api(route,options={}){
 if(!(options.body instanceof FormData))return transport.json('/api'+route,options);
 const response=await fetch(base+'/api'+route,{...options,headers:{'X-Dant-Token':token,...options.headers}});
 if(!response.ok){const body=await response.json().catch(()=>({error:response.statusText}));throw Error(body.error||t('messageError'));}
 return response.json();
}
const post=(p,body={})=>api(p,{method:'POST',body});
function toast(text){const box=document.querySelector('#toast');box.textContent=text;box.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>box.classList.remove('visible'),6500);}
function md(text){return DOMPurify.sanitize(marked.parse(text||'',{breaks:true}),{ALLOW_DATA_ATTR:false,SANITIZE_NAMED_PROPS:true,FORBID_TAGS:['img','iframe','style','form','input','video','button','textarea','select','audio'],FORBID_ATTR:['style']});}
function render(){
 const composer=document.querySelector('#composer');if(composer)composerDraft=composer.value;
 const scroll=document.querySelector('#messages'),nearBottom=!scroll||scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<90,oldScroll=scroll?.scrollTop||0;
 const status=!eventConnected?'offline':humanControl()?'takeover':state.active?'working':state.worker.status;
 document.documentElement.lang=state.settings.language;
 const template=document.createElement('template');
 template.innerHTML=`<nav class="rail" aria-label="dant"><button type="button" class="brand" data-action="chat" title="dant" aria-label="${t('chat')}">${eyes('small')}</button><div class="rail-bottom">${button('settings','settings',t('settings'),'icon-btn '+(page==='settings'?'selected':''))}</div></nav><main class="${page==='chat'?'chat-main':'settings-main'}">${renderHeader(status)}${page==='chat'?`<div class="workspace ${showComputer&&chatMode==='text'?'computer-visible':''}" data-key="workspace"><section class="conversation" data-key="conversation">${renderCall()}${chatMode==='voice'&&!pc&&!callStarting?renderCallReady():renderChat()}</section>${showComputer&&chatMode==='text'?renderComputer():''}</div>`:`<div class="full-page" data-key="page-${page}"><div class="settings-stack">${page==='settings'?renderSettings():page==='memory'?renderMemory():renderSchedules()}</div></div>`}</main><input type="file" id="file-input" hidden multiple>${renderModal()}`;
 reconcile(app,template.content);bind();resizeComposer();
 const nextScroll=document.querySelector('#messages');if(nextScroll)nextScroll.scrollTop=nearBottom?nextScroll.scrollHeight:oldScroll;
 updateRead();restartScreen();
}
function renderHeader(status){
 const settingsPage=page!=='chat',title=page==='settings'?t('settingsTitle'):page==='memory'?t('memoryTitle'):t('schedules');
 return `<header class="app-header">${settingsPage?`<div class="settings-header">${button('chat','arrow-left',t('backChat'),'text-btn back-button')}<h1>${title}</h1></div>`:`<div class="identity"><strong>dant</strong><span><i class="status-dot ${eventConnected?state.worker.status:'offline'}"></i>${t(status)}</span></div>`}<div class="header-actions">${settingsPage?(pc||state.call||callStops.pending?button('hangup','phone',t('hangup'),'icon-btn hangup-header'):''):`${button('voice-mode','phone',t('voiceMode'),'icon-btn mode-button '+(chatMode==='voice'?'selected':''))}${button('computer','monitor',t('computer'),'text-btn header-computer '+(showComputer&&chatMode==='text'?'selected':''))}${button('details','more-horizontal',t('details'))}`}</div></header>`;
}
function renderChat(){
 return `<div id="messages" class="messages"><div class="message-column" data-key="message-column">${state.messages.length?renderMessages():`<div class="welcome">${eyes('hero')}<h1>${t('hello')}</h1><p>${t('intro')}</p>${state.worker.status!=='online'?`<button type="button" class="text-btn" data-action="settings">${t('setup')}</button><small>${t('setupHint')}</small>`:''}</div>`}</div></div><div class="composer-wrap" data-key="composer-wrap">${replyTo?`<div class="reply-preview" data-key="reply-preview"><div><small>${t('reply')} ${state.messages.find(message=>message.id===replyTo)?.role==='assistant'?'dant':t('you')}</small><span>${esc((state.messages.find(message=>message.id===replyTo)?.text||'').slice(0,180))}</span></div>${button('cancel-reply','x',t('close'))}</div>`:''}${attachments.length?`<div class="attachment-chips" data-key="attachments">${attachments.map(file=>`<span data-id="${esc(file.id)}">${ico('paperclip')}${esc(file.name)}<button type="button" data-remove="${esc(file.id)}" aria-label="${t('close')}">×</button></span>`).join('')}</div>`:''}${renderUnconfirmedMessage()}<form id="message-form" class="composer-box"><textarea id="composer" rows="1" placeholder="${t('placeholder')}" aria-label="${t('placeholder')}">${esc(composerDraft)}</textarea><div class="composer-tools">${renderAttachmentOptions()}<button type="button" class="icon-btn ${dictating?'dictating':''}" data-action="dictate" title="${t(dictating?'dictating':'dictate')}" aria-label="${t(dictating?'stopSpeech':'dictate')}" ${speechBlocked()||recording||recordStarting?'disabled':''}>${ico(dictating?'square':'mic')}</button>${state.active||state.queue?.length?button('stop','square',t('stop')):''}<button class="send-btn" type="submit" title="${t('send')}" aria-label="${t('send')}" ${sending||uploading||!eventConnected?'disabled':''}>${ico('arrow-up')}</button></div></form>${uploading?`<small class="composer-status">${state.settings.language==='en'?'Uploading…':'正在上传…'}</small>`:recording?`<small class="composer-status recording-status">${t('recording')} <button type="button" class="text-link" data-action="record">${t('stop')}</button></small>`:dictating?`<small class="composer-status">${t('dictating')}</small>`:speakingId?`<small class="composer-status">${t('reading')} <button type="button" class="text-link" data-action="speech-stop">${t('stop')}</button></small>`:''}</div>`;
}
function renderAttachmentOptions(){return `<div class="attachment-control"><button type="button" class="icon-btn" data-action="attach-menu" aria-haspopup="menu" aria-expanded="${attachmentMenu}" title="${t('attachOptions')}" aria-label="${t('attachOptions')}">${ico('paperclip')}</button>${attachmentMenu?`<div class="attachment-menu" role="menu"><button type="button" role="menuitem" data-action="attach">${ico('paperclip')}${t('attach')}</button><button type="button" role="menuitem" data-action="record" ${speechBlocked()?'disabled':''}>${ico(recording?'square':'mic')}${t(recording?'stop':'recordAttachment')}</button></div>`:''}</div>`;}
function speechBlocked(){return !!pc||callStarting||!!state?.call||callStops.pending;}
async function stopSpeech(){speechGeneration++;dictating=false;speakingId=null;await speech.stop();if(state&&!unloading)render();}
async function toggleDictation(){
 if(dictating){await stopSpeech();return;}if(speechBlocked())throw Error(t('speechDuringCall'));if(recording||recordStarting)throw Error(t('finishRecording'));
 const generation=++speechGeneration;dictating=true;speakingId=null;attachmentMenu=false;render();
 try{const text=await speech.dictate(state.settings.language);if(generation!==speechGeneration||unloading||speechBlocked())return;if(!String(text||'').trim()){toast(t('emptyDictation'));return;}const current=document.querySelector('#composer'),draft=current?.value??composerDraft;composerDraft=draft+(draft&&!/\s$/.test(draft)?' ':'')+String(text).trim();if(current)current.value=composerDraft;render();document.querySelector('#composer')?.focus({preventScroll:true});}
 catch(error){if(generation===speechGeneration&&!unloading)toast(error.message||String(error));}
 finally{if(generation===speechGeneration){dictating=false;if(!unloading)render();}}
}
function spokenText(text){const node=document.createElement('div');node.innerHTML=md(text).replace(/<\/(?:p|li|pre|h[1-6])>|<br\s*\/?>/gi,'\n');return (node.textContent||'').trim();}
async function readAloud(id){
 if(speakingId===id){await stopSpeech();return;}if(speechBlocked())throw Error(t('speechDuringCall'));if(recording||recordStarting)throw Error(t('finishRecording'));const message=state.messages.find(item=>item.id===id&&item.role==='assistant');if(!message?.text)return;
 const generation=++speechGeneration;dictating=false;speakingId=id;render();try{await speech.speak(spokenText(message.text),state.settings.language);}catch(error){if(generation===speechGeneration&&!unloading)toast(error.message||String(error));}finally{if(generation===speechGeneration){speakingId=null;if(!unloading)render();}}
}
const fileURL=file=>base+'/api/files/'+encodeURIComponent(file.id)+'?token='+encodeURIComponent(token);
function formatTime(time,full=false){const value=new Date(time);if(!Number.isFinite(value.getTime()))return '';return new Intl.DateTimeFormat(state.settings.language==='en'?'en-MY':'zh-CN',full?{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}:{hour:'2-digit',minute:'2-digit'}).format(value);}
function renderAttachment(file){
 const url=fileURL(file),type=String(file.type||'');
 if(type.startsWith('image/'))return `<button type="button" class="image-attachment" data-preview="${esc(file.id)}" aria-label="${esc(file.name)}"><img class="attachment-image" src="${url}" alt="${esc(file.name)}" loading="lazy"></button>`;
 if(type.startsWith('audio/'))return `<audio controls preload="metadata" src="${url}" aria-label="${esc(file.name)}"></audio>`;
 return `<a class="file-card" href="${url}" download="${esc(file.name)}">${ico('file-text')}<span>${esc(file.name)}<small>${Math.max(1,Math.round((file.size||0)/1024))} KB</small></span>${ico('download')}</a>`;
}
function renderMessages(){
 let last=0;
 return state.messages.map(message=>{
  const separator=!last||message.time-last>1800000||new Date(message.time).toDateString()!==new Date(last).toDateString();last=message.time;
  const time=separator?`<div class="time-divider" data-key="time-${esc(message.id)}">${formatTime(message.time,true)}</div>`:'';
  if(message.kind==='call'){const seconds=Math.max(0,Number(message.seconds)||0);return time+`<div class="call-log" data-id="${esc(message.id)}"><span>${ico('phone')}${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}<small>· ${t('callEnded')}</small></span></div>`;}
  const replied=state.messages.find(item=>item.id===message.replyTo),isUser=message.role==='user';
  return time+`<article class="message ${isUser?'user':'assistant'} ${emojiFor===message.id?'has-picker':''}" data-id="${esc(message.id)}"><div class="message-content"><div class="bubble ${!message.text&&message.attachments?.length?'file-only':''}">${replied?`<blockquote><small>${t('reply')} ${replied.role==='assistant'?'dant':t('you')}</small>${esc((replied.text||'').slice(0,240))}</blockquote>`:''}${message.text?`<div class="markdown">${md(message.text)}</div>`:''}${(message.attachments||[]).map(renderAttachment).join('')}${message.status==='streaming'?'<span class="stream-cursor"></span>':''}</div><div class="message-meta"><div class="reactions">${(message.reactions||[]).map(emoji=>`<button type="button" data-react="${esc(message.id)}" data-emoji="${esc(emoji)}">${esc(emoji)}</button>`).join('')}</div><div class="message-actions"><button type="button" title="${t('reply')}" aria-label="${t('reply')}" data-reply="${esc(message.id)}">${ico('reply')}</button><button type="button" title="${t('reactions')}" aria-label="${t('reactions')}" data-picker="${esc(message.id)}">${ico('smile')}</button>${!isUser&&message.text?`<button type="button" title="${t(speakingId===message.id?'stopSpeech':'readAloud')}" aria-label="${t(speakingId===message.id?'stopSpeech':'readAloud')}" data-speak="${esc(message.id)}" ${speechBlocked()||recording||recordStarting||message.status==='streaming'?'disabled':''}>${ico(speakingId===message.id?'square':'volume-2')}</button>`:''}</div>${isUser?`${['review','paused','completed'].includes(message.status)?`<span class="task-status ${message.status}">${t(message.status)}</span>`:''}<span class="delivery-state" title="${t(message.executorConfirmedAt||message.receipt?.readAt?'executorRead':'received')}">${formatTime(message.time)}${(message.executorConfirmedAt||message.receipt?.readAt||message.status==='read')?ico('check-check'):(message.receivedAt||['queued','accepted','running','paused','review','completed'].includes(message.status))?ico('check'):''}</span>`:''}</div>${emojiFor===message.id?`<div class="reaction-menu" role="group" aria-label="${t('reactions')}">${reactionOptions.map(emoji=>`<button type="button" data-react="${esc(message.id)}" data-emoji="${esc(emoji)}" aria-label="${esc(emoji)}">${emoji}</button>`).join('')}</div>`:''}${isUser&&['failed','interrupted','cancelled'].includes(message.status)?`<button type="button" class="retry-message" data-retry="${esc(message.id)}">${unknownTask(message)?t('viewUnknown'):t(message.status)+' · '+t('retry')}</button>`:''}${message.error?`<small class="error">${esc(message.error)}</small>`:''}</div></article>`;
 }).join('');
}
function renderComputer(){
 const online=eventConnected&&state.worker.status==='online',maximum=Math.max(320,innerWidth-52-320),width=Math.max(320,Math.min(maximum,Number(localStorage.getItem('computerWidth'))||Math.round((innerWidth-52)*.64))),pending=pendingActions.has('takeover');
 return `<div data-key="resize" class="resize-handle" role="separator" aria-label="Resize computer" aria-orientation="vertical" tabindex="0"></div><aside data-key="computer-panel" class="computer-panel" style="width:${width}px"><div class="panel-header"><strong>${t('computer')}</strong>${button('hide-computer','x',t('close'))}</div><div class="computer-meta"><span>${online?t(humanControl()?'takeover':'controlledByDant'):t('computerEmpty')}</span>${button(online?'screen-refresh':'connect','refresh-cw',t('refresh'))}</div><div class="screen-frame"><div class="desktop-surface">${online?`<div class="screen-target ${humanControl()?'controlling':''}" id="screen-target" tabindex="0" aria-label="VM desktop"><img id="screen" ${screenURL?`src="${screenURL}"`:''} alt="Ubuntu desktop" draggable="false"><textarea id="vm-ime" aria-label="VM keyboard input" autocapitalize="off" autocomplete="off"></textarea>${!screenURL||screenError?`<div class="screen-status" data-key="screen-status">${esc(screenError||(state.settings.language==='en'?'Loading desktop…':'正在加载桌面…'))}</div>`:''}</div>`:`<div class="computer-empty">${ico('monitor')}<h3>${t('computerEmpty')}</h3><p>${t('computerSub')}</p><button type="button" class="text-btn" data-action="settings">${t('setup')}</button></div>`}</div></div><div class="computer-footer">${online?`<button type="button" class="text-btn primary takeover-button" data-action="takeover" ${pending?'disabled':''}>${t(pending?humanControl()?'returningControl':'takingControl':humanControl()?'give':'take')}</button>`:`<span>Ubuntu · ${t('computerHint')}</span>`}</div></aside>`;
}
function renderSettings(){
 const settings=state.settings,vm=vmDraft||settings.vm,existing=!!settings.vm.host||!!state.provisioning?.connection,online=state.worker.status==='online';
 return `<section class="settings-section setting-card language-card"><div class="card-label"><h2>${t('language')}</h2><p>${t('languageHint')}</p></div><div class="card-content"><div class="segmented" role="group" aria-label="${t('language')}"><button type="button" data-language="zh" class="${settings.language==='zh'?'selected':''}" aria-pressed="${settings.language==='zh'}">中文</button><button type="button" data-language="en" class="${settings.language==='en'?'selected':''}" aria-pressed="${settings.language==='en'}">English</button></div></div></section>${renderVoiceSettings(settings)}<section class="settings-section setting-card"><div class="card-label"><h2>${t('notify')}</h2></div><div class="card-content"><div class="setting-row"><div>${t('notifySub')}</div><input type="checkbox" id="notifications" ${settings.notifications?'checked':''} aria-label="${t('notify')}"></div></div></section><section class="settings-section setting-card"><div class="card-label"><h2>Ubuntu ${t('computer')}</h2></div><div class="card-content"><div class="setting-row computer-summary"><div><strong>${t('computerSystem')}</strong><small>${t(online?'online':state.worker.status)}${settings.vm.host?' · '+esc(settings.vm.host):''}</small></div><span class="status-label ${online?'connected':''}">${t(online?'online':'offline')}</span></div>${state.worker.error?`<p class="error" role="status">${esc(state.worker.error)}</p>`:''}<div class="inline-actions">${button('setup',existing?'monitor':'plus',t(existing?'computerDetails':'createComputer'),'text-btn')}${button('connect','refresh-cw',t(existing?'refresh':'connect'),'text-btn')}</div><details class="manual-vm-details" id="manual-vm-options" ${manualVMExpanded?'open':''}><summary>${t('connectionSettings')}</summary><form id="vm-form"><div class="form-grid"><label>${t('host')}<input name="host" value="${esc(vm.host)}" placeholder="172.20.0.10" required></label><label>${t('user')}<input name="user" value="${esc(vm.user)}" required></label><label>${t('port')}<input name="port" type="number" min="1" max="65535" value="${esc(vm.port)}" required></label><label class="wide">${t('key')}<input name="keyPath" value="${esc(vm.keyPath)}" placeholder="C:\…\data\vm-key" required></label></div><div class="form-actions"><button class="text-btn" type="submit">${t('save')}</button></div></form></details></div></section><section class="settings-section setting-card"><div class="card-label"><h2>${t('adminPermissions')}</h2></div><div class="card-content">${existing?`<p class="card-description">${t('currentPermissions')}</p>${button('computer','monitor',t('viewComputer'),'text-btn')}`:`<div class="segmented permission-options" role="group" aria-label="${t('adminPermissions')}"><button type="button" data-permission="standard" class="${!provisionDraft.adminSudo?'selected':''}" aria-pressed="${!provisionDraft.adminSudo}">${t('standardPermissions')}</button><button type="button" data-permission="admin" class="${provisionDraft.adminSudo?'selected':''}" aria-pressed="${provisionDraft.adminSudo}">${t('fullPermissions')}</button></div><p class="card-description">${t(provisionDraft.adminSudo?'permissionsAdminHint':'permissionsStandardHint')}</p><small class="muted">${t('permissionsForNew')}</small>`}</div></section><section class="settings-section setting-card"><div class="card-label"><h2>${t('accountSubscription')}</h2></div><div class="card-content"><div class="setting-row"><div><strong>${esc(state.worker.account?.email||'ChatGPT')}</strong><small>${esc(state.worker.account?.planType||t('offline'))}</small></div><button type="button" class="text-btn ${state.worker.account?'':'primary'}" data-action="${state.worker.account?'logout':'login'}">${t(state.worker.account?'logout':'login')}</button></div><p class="card-description">${t('subscriptionTasks')}</p><div id="login-details">${renderLoginDetails()}</div><div class="setting-row model-setting"><span>${t('model')}</span><select id="model" aria-label="${t('model')}"><option value="">${t('default')}</option>${state.worker.models.map(model=>`<option value="${esc(model.model)}" ${model.model===settings.model?'selected':''}>${esc(model.displayName||model.model)}</option>`).join('')}</select></div></div></section><div class="settings-links">${button('memory','brain',t('memory'),'text-btn')}${button('schedules','clock',t('schedules'),'text-btn')}</div>`;
}
function renderVoiceSettings(settings){
 const configured=voiceKeyConfigured(),busy=pendingActions.has('voice-key'),active=!!state.call||!!pc||callStarting,environment=state.worker.realtime?.key?.source==='environment',nativeVoice=settings.nativeVoice||settings.voice||'ember',apiVoice=settings.apiVoice||'marin';
 const choices=(current,list)=>[...new Set([current,...list])].filter(Boolean).map(voice=>`<option value="${esc(voice)}" ${voice===current?'selected':''}>${esc(voice)}</option>`).join('');
 return `<section class="settings-section setting-card voice-settings"><div class="card-label"><h2>${t('call')}</h2></div><div class="card-content"><p class="voice-native-info">${t('voiceNativeInfo')}</p><div class="setting-row native-voice-setting"><div>${t('voice')}<small>${esc(subscriptionVoiceUnavailable()?t('callUnavailable'):voiceError||t('voiceSub'))}</small></div><select id="nativeVoice" aria-label="${t('voice')}" ${subscriptionVoiceUnavailable()||active?'disabled':''}>${choices(nativeVoice,voiceChoices)}</select></div><div class="voice-reference-links"><a href="https://learn.chatgpt.com/docs/features/voice" target="_blank" rel="noopener noreferrer">${t('voiceNativeDoc')}${ico('external-link')}</a><a href="https://learn.chatgpt.com/docs/pricing" target="_blank" rel="noopener noreferrer">${t('voiceNativePricing')}${ico('external-link')}</a></div><details class="voice-api-options" id="voice-api-options" ${voiceApiExpanded?'open':''}><summary>${t('voiceApiOptional')}</summary><div class="voice-api-content"><p class="voice-billing" id="voice-billing">${t('voiceBilling')}</p><div class="voice-key-status"><span class="key-state ${configured?'configured':''}">${configured?ico('check'):''}${t(configured?'voiceKeyConfigured':'voiceKeyMissing')}</span>${configured?`<small>${t('voiceKeyValidation')}${environment?` ${t('voiceKeyEnvironment')}`:''}</small>`:''}</div><form id="voice-key-form" autocomplete="off"><label for="voice-api-key">${t('voiceKeyLabel')}<input id="voice-api-key" type="password" name="voiceKey" placeholder="sk-…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="voice-billing" required ${busy||active?'disabled':''}></label><div class="form-actions">${configured?`<button type="button" class="text-btn" id="voice-key-remove" ${environment||busy||active?'disabled':''}>${t('voiceKeyRemove')}</button>`:''}<button type="submit" class="text-btn primary" ${busy||active?'disabled':''}>${t(configured?'voiceKeyUpdate':'voiceKeySave')}</button></div></form><div class="voice-key-links"><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">${t('voiceKeyGet')}${ico('external-link')}</a><a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">${t('voiceKeyUsage')}${ico('external-link')}</a></div><div class="setting-row"><div>${t('voiceApiVoice')}<small>${esc(apiVoiceUnavailable()?t('voiceApiRequired'):t('voiceApiHint'))}</small></div><select id="apiVoice" aria-label="${t('voiceApiVoice')}" ${apiVoiceUnavailable()||active?'disabled':''}>${choices(apiVoice,apiVoiceChoices)}</select></div><button type="button" class="text-btn" data-action="call-api" ${apiVoiceUnavailable()||active||!eventConnected||state.worker.status!=='online'?'disabled':''}>${ico('phone')}${t('voiceApiStart')}</button></div></details></div></section>`;
}
function renderProvisionCard(){
 const current=state.provisioning||{status:'idle'},busy=current.running??['preparing','awaiting-admin','creating','installing'].includes(current.status),ready=current.status==='ready',existing=!!state.settings.vm.host||!!current.connection;
 const phases=['preparing','awaiting-admin','creating','installing','ready'],rank=phases.indexOf(current.status);
 return `<div class="provision-card"><p class="setup-summary">${t('computerSystem')}</p><p class="setup-lead">${t(ready?'setupReady':busy?current.status:existing?'existingComputerConfigured':'setupBeforeCreate')}</p>${current.status==='failed'?`<p class="error">${esc(current.error||t('provisionFailed'))}</p>`:''}${busy||ready?`<ol class="setup-phases">${phases.map((phase,index)=>`<li class="${index<rank||ready?'done':index===rank?'current':''}"><span>${index<rank||ready?ico('check'):index+1}</span>${t(phase==='ready'?'provisionReady':phase)}</li>`).join('')}</ol>`:''}${existing?`<div class="setup-connection"><strong>${t('connectionDetails')}</strong><span>${esc(state.settings.vm.user||current.connection?.user||'dant')}@${esc(state.settings.vm.host||current.connection?.host||'')}</span></div>`:''}<form id="provision-form"><details id="provision-options" ${provisionExpanded?'open':''}><summary>${t('createOptions')}</summary><div class="provision-resources"><label>${t('cpu')}<input name="cpu" type="number" min="1" max="64" value="${esc(provisionDraft.cpu)}" required ${busy||existing?'disabled':''}></label><label>${t('memorySize')}<input name="memoryGB" type="number" min="2" max="128" value="${esc(provisionDraft.memoryGB)}" required ${busy||existing?'disabled':''}></label><label>${t('diskSize')}<input name="diskGB" type="number" min="32" max="2048" value="${esc(provisionDraft.diskGB)}" required ${busy||existing?'disabled':''}></label></div><label class="provision-admin"><input name="adminSudo" type="checkbox" ${provisionDraft.adminSudo?'checked':''} ${busy||existing?'disabled':''}><span>${t('vmAdmin')}<small>${t('vmAdminHint')}</small></span></label></details><div class="setup-footer">${existing?button('connect','refresh-cw',t('refresh'),'text-btn'):''}<button type="submit" class="text-btn primary" ${busy||existing?'disabled':''}>${t(existing?'createReady':busy?current.status:'createComputer')}</button>${ready?button('setup-done','arrow-up',t('backChat'),'text-btn'):''}</div></form></div>`;
}
function renderMemory(){return `<section class="settings-section memory-page"><p class="card-description">${t('memorySub')}</p><div class="memory-content markdown">${state.memory?md(state.memory):`<div class="empty-state">${ico('brain')}<p>${t('memoryEmpty')}</p></div>`}</div></section>`;}
function renderSchedules(){return `<section class="settings-section schedule-page"><p class="card-description">${t('scheduleHint')}</p><form id="schedule-form"><label>${t('task')}<textarea name="text" rows="3" required>${esc(scheduleDraft.text)}</textarea></label><label>${t('at')}<input type="datetime-local" name="at" value="${esc(scheduleDraft.at)}" required></label><button class="text-btn primary" type="submit">${ico('plus')}${t('add')}</button></form><div>${state.schedules.length?state.schedules.map(schedule=>`<div class="schedule-item" data-id="${esc(schedule.id)}"><div><p>${esc(schedule.text)}</p><small>${formatTime(schedule.at,true)} · ${t(schedule.status)}</small></div><button type="button" class="icon-btn" data-cancel-schedule="${esc(schedule.id)}" aria-label="${t('close')}">${ico('x')}</button></div>`).join(''):`<p class="muted empty-schedules">${t('emptySchedules')}</p>`}</div></section>`;}
function renderCallReady(){
 const ready=eventConnected&&state.worker.status==='online'&&!subscriptionVoiceUnavailable()&&!state.call&&!callStops.pending;
 return `<div class="call-ready" data-key="call-ready"><div class="call-ready-top">${button('text-mode','arrow-left',t('backChat'),'text-btn back-button')}<span>${t('voiceMode')}</span></div><div class="call-ready-center">${eyes('call-avatar')}<p>${t('callReady')}</p></div><div class="call-ready-bottom"><button type="button" class="call-start" data-action="call" ${ready?'':'disabled'} title="${t('startCall')}" aria-label="${t('startCall')}">${ico('phone')}</button>${!ready?`<p>${t(state.call||callStops.pending?'callNeedsStop':subscriptionVoiceUnavailable()?'callUnavailable':'setupHint')}</p><button type="button" class="text-link" data-action="${state.call||callStops.pending?'hangup':'voice-settings'}">${t(state.call||callStops.pending?'hangup':subscriptionVoiceUnavailable()?'voiceSettings':'settings')}</button>`:`<p>${t('voiceSubscriptionUsage')}</p>`}</div></div>`;
}
function renderCall(){
 if(!pc&&!callStarting&&!state.call&&!callStops.pending)return '';
 const recovering=!pc&&!callStarting,provider=state.call?.provider||callProvider;
 return `<div data-key="call-view" class="call-view ${callMini?'mini':''}"><div class="call-top"><span>${callMini?'dant':t('voiceMode')}</span>${button('call-size',callMini?'maximize-2':'minimize-2',t(callMini?'expand':'minimize'))}</div>${eyes('call-avatar')}<small class="call-provider">${t(provider==='api'?'voiceApiActive':'voiceSubscriptionUsage')}</small><p>${t(recovering?(callStops.pending?'callPendingStop':'callRecover'):callConnected&&pc?.connectionState==='connected'&&callChannel?.readyState==='open'?'talking':'calling')}</p><div class="call-controls">${stream?button('mute',callMuted?'mic-off':'mic',t('mic'),'icon-btn '+(callMuted?'muted-mic':'')):''}${button('hangup','phone',t('hangup'),'icon-btn hangup')}</div></div>`;
}
function renderUnconfirmedMessage(){const uncertain=messageSubmissions.unknown;return uncertain?`<div class="unconfirmed-send" role="status"><strong>${t('sendUnknown')}</strong><p>${t('sendUnknownHint')}</p><small>${esc(uncertain.payload.text.slice(0,140))}</small><div><button type="button" class="text-btn" data-action="check-send">${t('checkSend')}</button><button type="button" class="text-btn" data-action="confirm-resend" ${sending?'disabled':''}>${t('confirmResend')}</button></div></div>`:'';}
function conversationFiles(){const files=new Map();for(const message of state.messages)for(const file of message.attachments||[])files.set(file.id,{...file,role:message.role,time:message.time});return [...files.values()];}
function renderProgress(){
 const active=state.messages.filter(message=>message.id===state.active?.messageId||state.active?.messageIds?.includes(message.id)),queue=state.messages.filter(message=>(state.queue||[]).includes(message.id)),history=state.messages.filter(message=>message.role==='user'&&!queue.includes(message)&&!active.includes(message)).slice(-12).reverse();
 const item=(message,status)=>{
  const pending=pendingActions.has('task:'+message.id),unknown=unknownTask(message),resumeBlocked=state.call?.provider==='subscription';
  return `<div class="progress-item" data-key="progress-${esc(message.id)}"><span class="progress-state ${status}">${status==='completed'?ico('check'):ico('clock')}</span><div><p>${esc(message.text||message.attachments?.map(file=>file.name).join(', ')||'')}</p><small>${t(status==='read'?'review':status)} · ${formatTime(message.time,true)}</small>${unknown?`<div class="unknown-outcome"><strong>${t('unknownOutcome')}</strong><p>${t('unknownHint')}</p></div>`:''}${status==='review'?`<div class="task-actions"><button type="button" class="text-btn" data-task-accept="${esc(message.id)}" ${pending?'disabled':''}>${t('acceptTask')}</button></div>`:['paused','failed'].includes(status)?`<div class="task-actions"><button type="button" class="text-btn" ${unknown?'data-task-unknown':'data-task-resume'}="${esc(message.id)}" ${pending||humanControl()||resumeBlocked?'disabled':''} ${resumeBlocked?`title="${t('resumeAfterCall')}"`:''}>${t(unknown?'confirmRepeat':'resumeTask')}</button>${resumeBlocked?`<small>${t('resumeAfterCall')}</small>`:''}</div>`:''}</div></div>`;
 };
 const voiceActive=state.active?.source==='voice';
 const changed=steerExpectedTurn&&steerExpectedTurn!==state.active?.turnId,steerDisabled=changed||!state.active?.turnId||pendingActions.has('steer');
 return `${active.length||voiceActive?`<h4>${t('currentTask')}</h4>${active.map(message=>item(message,'running')).join('')}${voiceActive?`<p class="muted native-steer-hint">${t('voiceTaskAdjust')}</p>`:`<form id="steer-form"><label>${t('steerTask')}<textarea id="steer-text" name="text" rows="2" placeholder="${t('steerHint')}" required ${pendingActions.has('steer')?'disabled':''}>${esc(steerDraft)}</textarea></label>${changed?`<p class="error">${t('steerChanged')}</p><button type="button" class="text-link" data-action="clear-steer">${t('clear')}</button>`:''}<div class="form-actions"><button type="button" class="text-btn" data-action="stop">${t('stop')}</button><button type="submit" class="text-btn primary" ${steerDisabled?'disabled':''}>${t('sendSteer')}</button></div></form>`}`:`<p class="muted">${t('noActiveTask')}</p>`}${queue.length?`<h4>${t('queuedTasks')}</h4>${queue.map(message=>item(message,'queued')).join('')}`:''}${history.length?`<h4>${t('taskHistory')}</h4>${history.map(message=>item(message,message.status)).join('')}`:''}${!active.length&&!voiceActive&&!queue.length&&!history.length?`<p class="muted">${t('progressEmpty')}</p>`:''}`;
}
function renderModal(){
 if(!modal)return '';
 if(modal.type==='image'){
  const file=conversationFiles().find(item=>item.id===modal.fileId);if(!file)return '';
  return `<div class="modal-backdrop image-backdrop" data-key="modal-backdrop"><section class="dialog image-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><h2 id="dialog-title">${esc(file.name)}</h2><div><a class="icon-btn" href="${fileURL(file)}" download="${esc(file.name)}" aria-label="${t('download')}">${ico('download')}</a>${button('close-modal','x',t('close'))}</div></div><div class="image-preview-body"><img src="${fileURL(file)}" alt="${esc(file.name)}"></div></section></div>`;
 }
 const setup=modal.type==='setup',files=conversationFiles();
 return `<div class="modal-backdrop" data-key="modal-backdrop"><section class="dialog ${setup?'setup-dialog':'details-dialog'}" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><h2 id="dialog-title">${t(setup?'setupDetails':'details')}</h2>${button('close-modal','x',t('close'))}</div><div class="dialog-body">${setup?renderProvisionCard():`<p class="details-caption">dant · ${state.messages.length?formatTime(state.messages.at(-1).time,true):t('ready')}</p><h3>${t('files')}</h3><div class="details-files">${files.length?files.map(file=>`<div class="details-file" data-id="${esc(file.id)}"><div>${ico(String(file.type).startsWith('audio/')?'volume-2':'file-text')}<div>${String(file.type).startsWith('image/')?`<button type="button" class="file-name" data-preview="${esc(file.id)}">${esc(file.name)}</button>`:`<a href="${fileURL(file)}" download="${esc(file.name)}">${esc(file.name)}</a>`}<small>${t(file.role==='assistant'?'fileDelivered':'fileShared')} · ${Math.max(1,Math.round((file.size||0)/1024))} KB</small></div></div><a class="icon-btn" href="${fileURL(file)}" download="${esc(file.name)}" aria-label="${t('download')}">${ico('download')}</a></div>`).join(''):`<p class="muted">${t('filesEmpty')}</p>`}</div><details class="work-progress" id="work-progress" ${progressExpanded?'open':''}><summary>${t('progress')}</summary><div>${renderProgress()}</div></details>`}</div></section></div>`;
}
function openModal(value){if(modal&&value.type==='image')value.parent=modal;else modalFocus=document.activeElement;modal=value;emojiFor=null;render();document.querySelector('.dialog')?.focus({preventScroll:true});}
function closeModal(){if(modal?.parent){modal=modal.parent;render();document.querySelector('.dialog')?.focus({preventScroll:true});return;}modal=null;render();if(modalFocus?.isConnected)modalFocus.focus({preventScroll:true});modalFocus=null;}
function resizeComposer(){const input=document.querySelector('#composer');if(input){input.style.height='auto';input.style.height=Math.min(130,input.scrollHeight)+'px';}}
function renderLoginDetails(){return loginDetails?`<div class="login-card"><strong>${esc(loginDetails.userCode)}</strong><a href="${esc(loginDetails.verificationUrl)}" target="_blank" rel="noopener noreferrer">${esc(loginDetails.verificationUrl)}</a></div>`:'';}
function formVM(form){const vm=Object.fromEntries(new FormData(form));vm.port=Number(vm.port);return vm;}
async function saveVM(){const form=document.querySelector('#vm-form');if(!form?.reportValidity())return false;const vm=formVM(form);await api('/settings',{method:'PATCH',body:{vm}});state.settings.vm={...state.settings.vm,...vm};vmDraft=null;return true;}
let inputChain=Promise.resolve();
function vmInput(input){const sessionId=state.computer?.sessionId;inputChain=inputChain.catch(()=>{}).then(()=>{if(!humanControl()||!eventConnected)throw Error(t('offline'));if(sessionId!==state.computer?.sessionId)throw Error(t('connectionChanged'));return post('/input',{...input,sessionId});}).catch(error=>toast(error.message));return inputChain;}
function bind(){
 document.querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>action(el.dataset.action).catch(e=>toast(e.message)));
 const composer=document.querySelector('#composer');
 if(composer){composer.oninput=()=>{composerDraft=composer.value;resizeComposer();};composer.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();send().catch(e=>toast(e.message));}};}
 const messageForm=document.querySelector('#message-form');if(messageForm)messageForm.onsubmit=e=>{e.preventDefault();send().catch(e=>toast(e.message));};
 document.querySelectorAll('[data-reply]').forEach(el=>el.onclick=()=>{replyTo=el.dataset.reply;render();document.querySelector('#composer')?.focus();});
 document.querySelectorAll('[data-react]').forEach(el=>el.onclick=async()=>{const id=el.dataset.react,emoji=el.dataset.emoji;emojiFor=null;render();await post('/messages/'+id+'/reaction',{emoji}).catch(error=>toast(error.message));});
 document.querySelectorAll('[data-speak]').forEach(el=>el.onclick=()=>readAloud(el.dataset.speak).catch(error=>toast(error.message||String(error))));
 document.querySelectorAll('[data-picker]').forEach(el=>el.onclick=()=>{emojiFor=emojiFor===el.dataset.picker?null:el.dataset.picker;render();});
 document.querySelectorAll('[data-preview]').forEach(el=>el.onclick=()=>openModal({type:'image',fileId:el.dataset.preview}));
 document.querySelectorAll('[data-language]').forEach(el=>el.onclick=async()=>{try{await api('/settings',{method:'PATCH',body:{language:el.dataset.language}});}catch(error){toast(error.message);}});
 document.querySelectorAll('[data-permission]').forEach(el=>el.onclick=()=>{provisionDraft.adminSudo=el.dataset.permission==='admin';render();});
 const manualOptions=document.querySelector('#manual-vm-options');if(manualOptions)manualOptions.ontoggle=()=>manualVMExpanded=manualOptions.open;
 const progressOptions=document.querySelector('#work-progress');if(progressOptions)progressOptions.ontoggle=()=>progressExpanded=progressOptions.open;
 const backdrop=document.querySelector('.modal-backdrop');if(backdrop)backdrop.onclick=event=>{if(event.target===backdrop)closeModal();};
 document.querySelectorAll('[data-retry]').forEach(el=>el.onclick=()=>{const message=state.messages.find(item=>item.id===el.dataset.retry);if(unknownTask(message)){progressExpanded=true;openModal({type:'details'});return;}resumeTask(el.dataset.retry,false).catch(error=>toast(error.message));});
 document.querySelectorAll('[data-task-resume]').forEach(el=>el.onclick=()=>resumeTask(el.dataset.taskResume,false).catch(error=>toast(error.message)));
 document.querySelectorAll('[data-task-unknown]').forEach(el=>el.onclick=()=>resumeTask(el.dataset.taskUnknown,true).catch(error=>toast(error.message)));
 document.querySelectorAll('[data-task-accept]').forEach(el=>el.onclick=()=>taskRequest(el.dataset.taskAccept,'/tasks/'+encodeURIComponent(el.dataset.taskAccept)+'/accept').catch(error=>toast(error.message)));
 bindSteer();
 document.querySelectorAll('[data-remove]').forEach(el=>el.onclick=()=>{attachments=attachments.filter(a=>a.id!==el.dataset.remove);render();});
 document.querySelector('#file-input').onchange=async e=>{const files=[...e.target.files];e.target.value='';for(const file of files)await upload(file).catch(error=>toast(error.message));};
 for(const key of ['language','model','nativeVoice','apiVoice','notifications']){const input=document.querySelector('#'+key);if(input)input.onchange=async e=>{try{if(key==='notifications'&&e.target.checked&&!await requestNotifications())throw Error(state.settings.language==='en'?'Notification permission was not granted':'通知权限尚未开启');await api('/settings',{method:'PATCH',body:{[key]:key==='notifications'?e.target.checked:e.target.value}});}catch(err){render();toast(err.message);}};}
 bindProvision();bindVoiceKey();
 const callView=document.querySelector('.call-view');if(callView)callView.onclick=()=>audio?.play().catch(()=>{});
 const vmForm=document.querySelector('#vm-form');if(vmForm){vmForm.oninput=()=>vmDraft=formVM(vmForm);vmForm.onsubmit=async e=>{e.preventDefault();try{if(await saveVM())toast(t('save')+' ✓');}catch(error){toast(error.message);}};}
 const scheduleForm=document.querySelector('#schedule-form');if(scheduleForm){scheduleForm.oninput=()=>scheduleDraft=Object.fromEntries(new FormData(scheduleForm));scheduleForm.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(scheduleForm));const at=new Date(data.at).getTime();if(!Number.isFinite(at)||at<=Date.now()){toast(state.settings.language==='en'?'Choose a future time':'请选择未来的时间');return;}const submit=scheduleForm.querySelector('[type="submit"]');submit.disabled=true;try{await post('/schedules',{text:data.text,at});scheduleDraft={text:'',at:''};render();}catch(error){toast(error.message);}finally{submit.disabled=false;}};}
 document.querySelectorAll('[data-cancel-schedule]').forEach(el=>el.onclick=()=>api('/schedules/'+el.dataset.cancelSchedule,{method:'DELETE'}).catch(e=>toast(e.message)));
 const handle=document.querySelector('.resize-handle');if(handle){const setWidth=width=>{const bounded=Math.max(320,Math.min(Math.max(320,innerWidth-52-320),width));document.querySelector('.computer-panel').style.width=bounded+'px';localStorage.setItem('computerWidth',bounded);};handle.onpointerdown=e=>{e.preventDefault();handle.setPointerCapture(e.pointerId);handle.onpointermove=ev=>setWidth(innerWidth-ev.clientX);handle.onpointerup=handle.onpointercancel=()=>handle.onpointermove=null;};handle.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setWidth(document.querySelector('.computer-panel').offsetWidth+(e.key==='ArrowLeft'?20:-20));}};}
 bindComputerInput();
 document.querySelectorAll('.markdown a,#login-details a,.voice-settings a').forEach(link=>{link.target='_blank';link.rel='noopener noreferrer';if(window.__TAURI_INTERNALS__)link.onclick=e=>{e.preventDefault();openExternal(link.href).catch(error=>toast(error.message));};});
}
async function taskRequest(id,route,body={}){const key='task:'+id;if(pendingActions.has(key))return;pendingActions.add(key);render();try{await post(route,body);state=await api('/state');}finally{pendingActions.delete(key);render();}}
function resumeTask(id,confirmUnknown){if(state.call?.provider==='subscription'){toast(t('resumeAfterCall'));return Promise.resolve();}const message=state.messages.find(item=>item.id===id);if(unknownTask(message)&&!confirmUnknown){progressExpanded=true;openModal({type:'details'});return Promise.resolve();}return taskRequest(id,'/tasks/resume',{ids:[id],...(confirmUnknown?{confirmUnknown:true}:{})});}
function bindSteer(){
 const form=document.querySelector('#steer-form');if(!form)return;const input=document.querySelector('#steer-text');
 input.oninput=()=>{steerDraft=input.value;if(!steerDraft.trim())steerExpectedTurn=null;else if(!steerExpectedTurn)steerExpectedTurn=state.active?.turnId;};
 form.onsubmit=async event=>{event.preventDefault();if(pendingActions.has('steer'))return;const text=input.value.trim(),expectedTurnId=steerExpectedTurn||state.active?.turnId;if(!text||!expectedTurnId)return;if(expectedTurnId!==state.active?.turnId){toast(t('steerChanged'));return;}pendingActions.add('steer');render();try{await post('/steer',{text,expectedTurnId,...(replyTo?{replyTo}:{})});steerDraft='';steerExpectedTurn=null;const current=document.querySelector('#steer-text');if(current)current.value='';state=await api('/state');}catch(error){toast(error.message);}finally{pendingActions.delete('steer');render();}};
}
function bindVoiceKey(){
 const options=document.querySelector('#voice-api-options');if(options)options.ontoggle=()=>{voiceApiExpanded=options.open;if(!options.open){const secret=document.querySelector('#voice-api-key');if(secret)secret.value='';}};
 const form=document.querySelector('#voice-key-form');if(!form)return;
 const input=document.querySelector('#voice-api-key');
 const change=async remove=>{
  if(pendingActions.has('voice-key'))return;
  if(state.call||pc||callStarting){toast(t('voiceKeyCallActive'));return;}
  if(!remove&&!input.reportValidity())return;
  pendingActions.add('voice-key');render();
  try{
   if(remove)await api('/voice-key',{method:'DELETE'});else await post('/voice-key',{key:input.value.trim()});
   input.value='';const currentInput=document.querySelector('#voice-api-key');if(currentInput)currentInput.value='';voiceLoadedFor='';voiceChoices=[];apiVoiceChoices=[];voiceError='';
   await api('/state').then(fresh=>state=fresh).catch(()=>{});toast(t(remove?'voiceKeyRemoved':'voiceKeySaved'));loadVoices();
  }catch(error){toast(error.message);}finally{pendingActions.delete('voice-key');render();}
 };
 form.onsubmit=e=>{e.preventDefault();return change(false);};
 const remove=document.querySelector('#voice-key-remove');if(remove)remove.onclick=()=>change(true);
}
function bindProvision(){
 const form=document.querySelector('#provision-form');if(!form)return;
 const options=document.querySelector('#provision-options');options.ontoggle=()=>provisionExpanded=options.open;
 const read=()=>({cpu:Number(form.elements.cpu.value),memoryGB:Number(form.elements.memoryGB.value),diskGB:Number(form.elements.diskGB.value),adminSudo:form.elements.adminSudo.checked});
 form.oninput=()=>provisionDraft=read();
 form.onsubmit=async e=>{e.preventDefault();if(pendingActions.has('provision'))return;pendingActions.add('provision');const button=form.querySelector('[type="submit"]');button.disabled=true;provisionDraft=read();try{await post('/provision',provisionDraft);}catch(error){toast(error.message);}finally{pendingActions.delete('provision');button.disabled=false;}};
}
function bindComputerInput(){
 const target=document.querySelector('#screen-target'),ime=document.querySelector('#vm-ime');if(!target||!ime)return;
 if(!humanControl()&&document.activeElement===ime)ime.blur();if(target._dantBound)return;target._dantBound=true;
 const point=e=>{const img=document.querySelector('#screen'),rect=img.getBoundingClientRect();if(!img.naturalWidth||!rect.width||screenError||e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)return null;return {x:Math.max(0,Math.min(img.naturalWidth-1,Math.round((e.clientX-rect.left)*img.naturalWidth/rect.width))),y:Math.max(0,Math.min(img.naturalHeight-1,Math.round((e.clientY-rect.top)*img.naturalHeight/rect.height)))};};
 target.onpointerdown=e=>{if(!humanControl())return;if(e.target===ime||![0,1,2].includes(e.button))return;const start=point(e);if(!start)return;e.preventDefault();target.setPointerCapture(e.pointerId);const drag={...start,button:e.button,clientX:e.clientX,clientY:e.clientY};target.onpointerup=up=>{target.onpointerup=null;const end=point(up);if(end){if(Math.hypot(up.clientX-drag.clientX,up.clientY-drag.clientY)>4)vmInput({type:'drag',startX:drag.x,startY:drag.y,endX:end.x,endY:end.y,button:drag.button});else vmInput({type:'click',...end,button:drag.button});}ime.focus({preventScroll:true});};};
 target.onpointercancel=()=>target.onpointerup=null;
 target.oncontextmenu=e=>{if(humanControl())e.preventDefault();};
 target.onwheel=e=>{if(!humanControl())return;e.preventDefault();if(e.deltaY)vmInput({type:'scroll',delta:Math.sign(e.deltaY)*3});};
 const sendText=()=>{const text=ime.value;ime.value='';if(!humanControl())return;if(text)vmInput({type:'text',text});};
 ime.oninput=e=>{if(!e.isComposing)sendText();};ime.oncompositionend=sendText;
 ime.onkeydown=e=>{if(!humanControl())return;if(e.isComposing||e.key==='Process'||e.keyCode===229)return;const keys={Enter:'Return',Backspace:'BackSpace',Tab:'Tab',Escape:'Escape',ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',Delete:'Delete',Home:'Home',End:'End',PageUp:'Prior',PageDown:'Next'};if(keys[e.key]||((e.ctrlKey||e.altKey)&&e.key.length===1&&e.key.toLowerCase()!=='v')){e.preventDefault();vmInput({type:'key',key:[e.ctrlKey?'ctrl':null,e.altKey?'alt':null,e.shiftKey?'shift':null,keys[e.key]||e.key].filter(Boolean).join('+')});}};
 target.onkeydown=e=>{if(humanControl()&&e.target===target&&e.key==='Enter'){e.preventDefault();ime.focus();}};
}
async function openExternal(url){const parsed=new URL(url);if(!['http:','https:','mailto:'].includes(parsed.protocol))throw Error('Unsupported link');const {openUrl}=await import('@tauri-apps/plugin-opener');await openUrl(parsed.href);}
const pendingActions=new Set();
async function action(a){
 if(['chat','settings','memory','schedules'].includes(a)){if(a!=='chat'&&(dictating||speakingId))await stopSpeech();attachmentMenu=false;if(a!=='settings'){const secret=document.querySelector('#voice-api-key');if(secret)secret.value='';}modal=null;emojiFor=null;if(a==='chat'){chatMode='text';if(pc)callMini=true;}page=a;render();return;}
 if(a==='clear-steer'){steerDraft='';steerExpectedTurn=null;render();return;}
 if(a==='details'){openModal({type:'details'});return;}
 if(a==='setup'){openModal({type:'setup'});return;}
 if(a==='close-modal'){closeModal();return;}
 if(a==='setup-done'){modal=null;page='chat';chatMode='text';render();return;}
 if(a==='voice-mode'){page='chat';if(pc){callMini=!callMini;chatMode=callMini?'text':'voice';}else chatMode=chatMode==='voice'?'text':'voice';render();return;}
 if(a==='text-mode'){chatMode='text';if(pc)callMini=true;render();return;}
 if(a==='voice-settings'){page='settings';voiceApiExpanded=false;render();document.querySelector('.voice-settings')?.scrollIntoView({block:'center'});return;}
 if(a==='screen-refresh'){screenError='';await screenLoad?.();return;}
 if(a==='computer'){showComputer=page==='chat'&&chatMode==='text'?!showComputer:true;chatMode='text';if(pc)callMini=true;page='chat';modal=null;localStorage.setItem('computer',showComputer);render();return;}
 if(a==='hide-computer'){showComputer=false;localStorage.setItem('computer',false);render();return;}
 if(a==='attach-menu'){attachmentMenu=!attachmentMenu;render();return;}
 if(a==='attach'){attachmentMenu=false;if(state.call?.provider==='subscription')throw Error(t('callAttachment'));render();document.querySelector('#file-input').click();return;}
 if(a==='dictate'){await toggleDictation();return;}
 if(a==='speech-stop'){await stopSpeech();return;}
 if(a==='cancel-reply'){replyTo=null;render();return;}
 if(a==='call-size'){callMini=!callMini;chatMode=callMini?'text':'voice';render();return;}
 if(a==='mute'){callMuted=!callMuted;stream?.getAudioTracks().forEach(track=>track.enabled=!callMuted);render();return;}
 if(pendingActions.has(a))return;pendingActions.add(a);
 try{
  if(a==='connect'){if(vmDraft&&document.querySelector('#vm-form')&&!await saveVM())return;voiceLoadedFor='';toast(t('connecting'));await post('/connect');toast(t('online'));}
  if(a==='login'){loginDetails=await post('/login');render();if(window.__TAURI_INTERNALS__)await openExternal(loginDetails.verificationUrl);}
  if(a==='logout'){await post('/logout');loginDetails=null;render();}
  if(a==='stop'){await post('/tasks/pause');state=await api('/state');}
  if(a==='takeover'){render();await post('/takeover',{enabled:!humanControl(),sessionId:state.computer?.sessionId});state=await api('/state');}
  if(a==='call'||a==='call-api')await startCall(a==='call-api'?'api':'subscription');
  if(a==='hangup')await endCall();
  if(a==='record'){attachmentMenu=false;await toggleRecord();}
  if(a==='check-send')await checkUnconfirmedMessage();
  if(a==='confirm-resend')await send(true);
 }finally{pendingActions.delete(a);if(a==='takeover')render();}
}
function clearSentDraft(raw,items,reply){const current=document.querySelector('#composer');if((current?.value??composerDraft)===raw){composerDraft='';if(current)current.value='';}attachments=attachments.filter(item=>!items.some(sent=>sent.id===item.id));if(replyTo===reply)replyTo=null;}
async function checkUnconfirmedMessage(){
 const uncertain=messageSubmissions.unknown;if(!uncertain)return;state=await api('/state');const found=messageSubmissions.find(state.messages);
 if(found){messageSubmissions.acknowledged(uncertain.clientMessageId);clearSentDraft(uncertain.raw,uncertain.items,uncertain.reply);toast(t('sendFound'));}else toast(t('sendStillUnknown'));progressExpanded=true;openModal({type:'details'});
}
async function send(confirmResend=false){
 const input=document.querySelector('#composer');if(!input||sending||uploading)return;
 const raw=input.value,text=raw.trim(),items=[...attachments],reply=replyTo;if(!text&&!items.length)return;
 if(messageSubmissions.unknown&&!confirmResend){toast(t('sendUnknownHint'));return;}
 if(!eventConnected)throw Error(t('connectionLost'));if(callStops.pending)throw Error(t('callNeedsStop'));
 const nativeCall=state.call?.provider==='subscription'?state.call:null;if(nativeCall&&items.length)throw Error(t('callAttachment'));
 const route=nativeCall?'/realtime/message':'/messages',payload=nativeCall?{callId:nativeCall.id||nativeCall.callId,text,...(reply?{replyTo:reply}:{})}:{text,attachments:items.map(item=>item.id),replyTo:reply};
 const attempt=messageSubmissions.prepare(route,payload,{confirmResend});attempt.raw=raw;attempt.items=items;attempt.reply=reply;
 sending=true;render();
 try{const result=await post(route,{...payload,clientMessageId:attempt.clientMessageId});if(result.unknownOutcome||(result.message||result).submission==='unknown')throw Object.assign(Error(t('sendUnknownHint')),{unknownOutcome:true});messageSubmissions.acknowledged(attempt.clientMessageId);clearSentDraft(raw,items,reply);}
 catch(error){if(error.unknownOutcome){messageSubmissions.unconfirmed(attempt);throw Error(t('sendUnknownHint'));}throw error;}
 finally{sending=false;render();document.querySelector('#composer')?.focus({preventScroll:true});}
}
async function upload(file){
 if(file.size>10*1024*1024)throw Error(t('fileLimit'));if(attachments.length+uploading>=5)throw Error(t('attachmentLimit'));uploading++;render();
 try{const form=new FormData();form.append('file',file);const item=await api('/upload',{method:'POST',body:form});attachments.push(item);}
 finally{uploading--;render();}
}
function screenVisible(){return !unloading&&page==='chat'&&chatMode==='text'&&showComputer&&eventConnected&&state?.worker.status==='online'&&!document.hidden&&document.hasFocus();}
function restartScreen(){
 if(!screenVisible()){clearInterval(screenTimer);screenTimer=null;screenLoad=null;screenEpoch++;screenAbort?.abort();return;}
 if(screenTimer)return;
 const load=async()=>{
  if(screenBusy||!screenVisible())return;
  screenBusy=true;const epoch=screenEpoch,controller=new AbortController();screenAbort=controller;const timeout=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await fetch(base+'/api/screen',{headers:{'X-Dant-Token':token},signal:controller.signal});if(!response.ok)throw Error('Screen unavailable');
   const blob=await response.blob();if(!blob.type.startsWith('image/'))throw Error('Invalid screen');if(epoch!==screenEpoch||!screenVisible())return;
   const url=URL.createObjectURL(blob),img=document.querySelector('#screen');
   if(img){const previous=screenURL;screenURL=url;screenFailures=0;const hadStatus=!!screenError||!previous;screenError='';img.src=url;img.onload=()=>{if(previous)URL.revokeObjectURL(previous);};if(hadStatus)render();}else URL.revokeObjectURL(url);
  }catch(error){if(epoch===screenEpoch&&screenVisible()){screenFailures++;if(screenFailures>=2&&!screenError){screenError=t('screenFailed');render();}}}
  finally{clearTimeout(timeout);if(screenAbort===controller)screenAbort=null;screenBusy=false;}
 };
 screenLoad=load;load();screenTimer=setInterval(load,1200);
}
async function loadVoices(){
 if(state.worker.status!=='online'){voiceLoadedFor='';voiceChoices=[];apiVoiceChoices=[];return;}
 const connection=[state.settings.vm.host,state.worker.account?.email||'',state.worker.realtime?.provider||'',voiceKeyConfigured(),state.worker.realtime?.subscription?.available].join('|');if(voiceLoadedFor===connection)return;voiceLoadedFor=connection;voiceError='';
 try{
  const result=await api('/voices'),supported=result.voices||result;
  const list=result.nativeV3||supported.v3||(Array.isArray(supported)?supported:[...(supported.v1||[]),...(supported.v2||[])]);
  const apiList=result.apiV2||result.api?.voices||supported.v2||[];
  const normalize=values=>[...new Set(Array.isArray(values)?values:[])].filter(value=>typeof value==='string'&&value.length>0&&value.length<=80);
  voiceChoices=normalize(list);apiVoiceChoices=normalize(apiList);if(!voiceChoices.length)voiceError=t('voiceUnavailable');
 }catch{voiceChoices=[];apiVoiceChoices=[];voiceError=t('voiceUnavailable');}if(page==='settings')render();
}
async function startCall(provider='subscription'){
 if(pc||callStarting)return;if(state.call||callStops.pending)throw Error(t('callNeedsStop'));if(state.worker.status!=='online'||!eventConnected)throw Error(t('setupHint'));
 if(provider==='api'&&apiVoiceUnavailable())throw Error(t('voiceKeyRequired'));
 if(provider==='subscription'&&subscriptionVoiceUnavailable())throw Error(t('callUnavailable'));
 if(recording||recordStarting)throw Error(state.settings.language==='en'?'Finish your recording before starting a call':'请先结束录音，再开始通话');
 if(!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection)throw Error(t('mediaUnavailable'));
 if(dictating||speakingId)await stopSpeech();
 const generation=++callGeneration;callStarting=true;callConnected=false;callId=null;callProvider=provider;page='chat';chatMode='voice';callMini=false;render();

 try{
  const acquired=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
  if(generation!==callGeneration){acquired.getTracks().forEach(track=>track.stop());return;}
  stream=acquired;const peer=new RTCPeerConnection();pc=peer;audio=new Audio();audio.autoplay=true;
  peer.ontrack=e=>{if(pc!==peer)return;audio.srcObject=e.streams[0]||new MediaStream([e.track]);audio.play().catch(()=>toast(state.settings.language==='en'?'Click the call to allow audio playback':'请点击通话区域以允许播放声音'));};
  stream.getTracks().forEach(track=>peer.addTrack(track,stream));const dc=peer.createDataChannel('oai-events');callChannel=dc;
  let confirming=false;
  const confirmConnection=async()=>{
   if(pc!==peer||generation!==callGeneration||confirming||callConnected||!callId||peer.connectionState!=='connected'||dc.readyState!=='open')return;
   const id=callId;confirming=true;
   try{await post('/call/connected',{callId:id});if(pc!==peer||generation!==callGeneration||id!==callId)return;callConnected=true;callStart=Date.now();clearTimeout(callTimeout);render();}
   catch{if(pc===peer&&generation===callGeneration){toast(t('callFailed'));endCall().catch(()=>{});}}
   finally{confirming=false;}
  };
  dc.onopen=()=>{confirmConnection();render();};
  dc.onclose=()=>{if(pc===peer&&callConnected){toast(t('callEnded'));endCall().catch(()=>{});}};
  dc.onerror=()=>{if(pc===peer){toast(t('callFailed'));endCall().catch(()=>{});}};
  dc.onmessage=e=>{try{const event=JSON.parse(e.data);if(event.type==='error')toast(event.error?.message||t('callFailed'));}catch{}};
  peer.onconnectionstatechange=()=>{if(pc!==peer)return;if(peer.connectionState==='failed'){toast(t('callFailed'));endCall().catch(()=>{});}else{confirmConnection();render();}};
  const offer=await peer.createOffer();await peer.setLocalDescription(offer);if(generation!==callGeneration)return;
  const result=await post('/call',{sdp:offer.sdp,provider});
  if(generation!==callGeneration){if(result.callId){callStops.add(result.callId);await flushCallStops();}return;}
  callId=result.callId||state.call?.callId||state.call?.id||null;
  const answer=result.sdp||result.transport?.sdp;if(answer&&!peer.remoteDescription)await peer.setRemoteDescription({type:'answer',sdp:answer});
  callStarting=false;callTimeout=setTimeout(()=>{if(pc===peer&&!callConnected){toast(t('callFailed'));endCall().catch(()=>{});}},30000);confirmConnection();render();
 }catch(error){if(generation===callGeneration){const id=callId;cleanupCall();if(id){callStops.add(id);flushCallStops();}render();throw error;}}
}
function cleanupCall(){
 clearTimeout(callTimeout);callGeneration++;callStarting=false;callConnected=false;callId=null;const dc=callChannel;callChannel=null;if(dc){dc.onopen=null;dc.onclose=null;dc.onerror=null;dc.onmessage=null;}const peer=pc;pc=null;if(peer){peer.onconnectionstatechange=null;peer.ontrack=null;peer.close();}stream?.getTracks().forEach(track=>track.stop());stream=null;audio?.pause();if(audio)audio.srcObject=null;audio=null;callMuted=false;callMini=false;
}
async function flushCallStops(){if(!eventConnected||unloading||!callStops.pending)return;const errors=await callStops.flush();if(!errors.length)try{state=await api('/state');}catch{}if(state)render();if(errors.length)toast(t('callNeedsStop'));}
async function endCall(){const id=callId||state.call?.id||state.call?.callId;cleanupCall();if(id)callStops.add(id);render();await flushCallStops();}
async function toggleRecord(){
 if(recording){if(recording.state==='recording')recording.stop();return;}if(recordStarting)return;
 if(speechBlocked())throw Error(t('speechDuringCall'));if(dictating||speakingId)await stopSpeech();
 if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw Error(t('mediaUnavailable'));
 recordStarting=true;let mic;
 try{mic=await navigator.mediaDevices.getUserMedia({audio:true});const recorder=new MediaRecorder(mic),chunks=[];recording=recorder;
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  recorder.onstop=async()=>{recording=null;mic.getTracks().forEach(track=>track.stop());const type=recorder.mimeType||chunks[0]?.type||'audio/webm';const extension=type.includes('ogg')?'ogg':type.includes('mp4')?'m4a':'webm';if(chunks.length)await upload(new File(chunks,`voice-${Date.now()}.${extension}`,{type})).catch(error=>toast(error.message));render();};
  recorder.onerror=()=>{toast(t('messageError'));if(recorder.state!=='inactive')recorder.stop();mic.getTracks().forEach(track=>track.stop());recording=null;render();};
  recorder.start();toast(t('recording'));render();
 }catch(error){mic?.getTracks().forEach(track=>track.stop());recording=null;throw error;}finally{recordStarting=false;}
}
async function requestNotifications(){if(window.__TAURI_INTERNALS__){const mod=await import('@tauri-apps/plugin-notification');return await mod.requestPermission()==='granted';}return 'Notification'in window&&await Notification.requestPermission()==='granted';}
async function notify(message){if(!state.settings.notifications||window.__TAURI_INTERNALS__)return;if('Notification'in window&&Notification.permission==='granted')new Notification('dant',{body:message});}
const readTimers=new Map(),readTargets=new Map(),readPending=new Set(),readBatch=new Set();
let readObserver=null,readRoot=null,readFlush=null;
function canReadMessages(){return !!state&&eventConnected&&page==='chat'&&chatMode==='text'&&!document.hidden&&document.hasFocus()&&!modal&&(!pc||callMini);}
function unreadAssistant(message){return message?.role==='assistant'&&message.status==='completed'&&message.read!==true&&!message.receipt?.readAt&&!message.readAt&&!message.visibleAt;}
function messageInViewport(element){
 if(!readRoot||!element?.isConnected)return false;
 const box=element.getBoundingClientRect(),viewport=readRoot.getBoundingClientRect();
 if(box.width<=0||box.height<=0||viewport.width<=0||viewport.height<=0)return false;
 const height=Math.min(box.bottom,viewport.bottom)-Math.max(box.top,viewport.top),width=Math.min(box.right,viewport.right)-Math.max(box.left,viewport.left);
 return height>=Math.min(box.height,viewport.height)*.5&&width>=Math.min(box.width,viewport.width)*.5;
}
function clearReadTimer(id){clearTimeout(readTimers.get(id));readTimers.delete(id);readBatch.delete(id);}
function stopReadTracking(){for(const id of readTimers.keys())clearReadTimer(id);readObserver?.disconnect();readObserver=null;readTargets.clear();readRoot=null;clearTimeout(readFlush);readFlush=null;readBatch.clear();}
function refreshReadTimers(){
 if(!canReadMessages()){stopReadTracking();return;}
 for(const [id,element] of readTargets){
  const message=state.messages.find(item=>item.id===id);
  if(!unreadAssistant(message)||!messageInViewport(element)){clearReadTimer(id);continue;}
  if(readTimers.has(id)||readPending.has(id)||readBatch.has(id))continue;
  readTimers.set(id,setTimeout(()=>{
   readTimers.delete(id);
   if(!canReadMessages()||!messageInViewport(element)||!unreadAssistant(state.messages.find(item=>item.id===id)))return;
   readBatch.add(id);if(readFlush===null)readFlush=setTimeout(flushReadReceipts,0);
  },450));
 }
}
function flushReadReceipts(){
 readFlush=null;const ids=[...readBatch].filter(id=>canReadMessages()&&messageInViewport(readTargets.get(id))&&unreadAssistant(state.messages.find(item=>item.id===id)));readBatch.clear();if(!ids.length)return;
 ids.forEach(id=>{readPending.add(id);clearReadTimer(id);});
 post('/read',{ids}).catch(()=>{ids.forEach(id=>readPending.delete(id));setTimeout(updateRead,1000);});
}
function updateRead(){
 if(!canReadMessages()){stopReadTracking();return;}
 const root=document.querySelector('#messages');if(!root){stopReadTracking();return;}
 if(readRoot!==root){stopReadTracking();readRoot=root;if('IntersectionObserver'in window){readObserver=new IntersectionObserver(refreshReadTimers,{root,threshold:[0,.25,.5,.75,1]});}root.onscroll=refreshReadTimers;}
 const nodes=new Map([...root.querySelectorAll('.message.assistant[data-id]')].map(element=>[element.dataset.id,element]));
 for(const [id,element] of readTargets)if(!nodes.has(id)||!unreadAssistant(state.messages.find(item=>item.id===id))){clearReadTimer(id);readObserver?.unobserve(element);readTargets.delete(id);readPending.delete(id);}
 for(const [id,element] of nodes)if(unreadAssistant(state.messages.find(item=>item.id===id))&&!readTargets.has(id)){readTargets.set(id,element);readObserver?.observe(element);}
 refreshReadTimers();
}
async function handleEvent(event){
 if(event.type==='state'){
  eventConnected=true;state=event.data;if(speechBlocked()&&(dictating||speakingId))stopSpeech().catch(()=>{});if(state.worker.account)loginDetails=null;
  for(const message of state.messages.filter(item=>item.role==='assistant'&&item.status==='completed')){if(initialized&&!lastAssistant.has(message.id)&&(document.hidden||!document.hasFocus()||page!=='chat'))notify(message.text.slice(0,160)||t('completed')).catch(()=>{});lastAssistant.add(message.id);}initialized=true;
  if(!state.call&&pc&&!callStarting)cleanupCall();render();loadVoices();
 }
 if(event.type==='notice')toast(event.data.message);
 if(event.type==='realtime'){
  const eventData=event.data,eventCallId=eventData.params?.callId;if(eventCallId&&eventCallId!==callId)return;
  if(eventData.method==='thread/realtime/sdp'&&pc?.signalingState==='have-local-offer')await pc.setRemoteDescription({type:'answer',sdp:eventData.params.sdp});
  if(eventData.method==='thread/realtime/error'){toast(eventData.params.message||t('callFailed'));cleanupCall();render();}
  if(eventData.method==='thread/realtime/closed'){cleanupCall();render();}
 }
}
function connectEvents(){
 transport.startEvents({onEvent:handleEvent,onConnection:connected=>{
  if(unloading||eventConnected===connected)return;
  const hadConnection=eventConnected;eventConnected=connected;
  if(!connected){if(callId)callStops.add(callId);cleanupCall();stopReadTracking();}
  else if(callStops.pending)flushCallStops();
  if(state)render();if(!connected&&hadConnection)toast(t('connectionLost'));
 }});
}
document.addEventListener('pointerdown',event=>{if(attachmentMenu&&!event.target.closest('.attachment-control')){attachmentMenu=false;render();}if(emojiFor&&!event.target.closest('.reaction-menu,[data-picker]')){emojiFor=null;render();}});
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&!event.isComposing){if(attachmentMenu){attachmentMenu=false;render();return;}if(dictating||speakingId){stopSpeech().catch(()=>{});return;}if(emojiFor){emojiFor=null;render();return;}if(modal){event.preventDefault();closeModal();return;}if(chatMode==='voice'&&!pc&&!callStarting){chatMode='text';render();return;}}
 if(event.key==='Tab'&&modal){const dialog=document.querySelector('.dialog');if(!dialog)return;const focusable=[...dialog.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(element=>element.getClientRects().length);if(!focusable.length){event.preventDefault();dialog.focus();return;}const first=focusable[0],last=focusable.at(-1),active=document.activeElement;if(event.shiftKey&&(active===first||active===dialog||!dialog.contains(active))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(active===last||active===dialog||!dialog.contains(active))){event.preventDefault();first.focus();}}
});
document.addEventListener('visibilitychange',()=>{updateRead();restartScreen();});window.addEventListener('focus',()=>{updateRead();restartScreen();});window.addEventListener('blur',()=>{stopReadTracking();restartScreen();});window.addEventListener('resize',updateRead);window.addEventListener('beforeunload',()=>{unloading=true;speechGeneration++;speech.stop().catch(()=>{});stopReadTracking();clearInterval(screenTimer);screenAbort?.abort();const hadCall=!!pc||callStarting||state?.call,id=callId;cleanupCall();recording?.stream?.getTracks().forEach(track=>track.stop());if(hadCall&&id)transport.json('/api/call/stop',{method:'POST',body:{callId:id},keepalive:true}).catch(()=>{});transport.close();if(screenURL)URL.revokeObjectURL(screenURL);});
async function boot(){try{const session=await transport.json('/api/session');transport.setToken(session.token);state=await api('/state');for(const message of state.messages.filter(m=>m.role==='assistant'&&m.status==='completed'))lastAssistant.add(message.id);render();connectEvents();}catch(e){app.innerHTML=`<div class="boot-error"><h1>dant</h1><p>${esc(e.message)}</p><button onclick="location.reload()">重新连接 / Retry</button></div>`;}}
boot();
