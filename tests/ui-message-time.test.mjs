import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {formatCallDuration} from '../ui/call-duration.js';
import {createChatHistory} from '../ui/chat-history.js';
import {defaultReactions} from '../src/reactions.mjs';
import {canPreviewFile} from '../ui/file-preview.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const at=Date.parse('2026-10-17T12:15:00Z');
function fixture(language='en',theme='light'){
 const {document}=parseHTML('<html><body><main id="app"></main></body></html>'),state={settings:{language},messages:[]};document.documentElement.dataset.theme=theme;
 const c={canPreviewFile,state,document,formatCallDuration,defaultReactions,fallbackLanguage:language,emojiFor:null,speakingId:null,recording:null,recordStarting:false,speechBlocked:()=>false,unknownTask:()=>false,md:value=>String(value),fileURL:file=>'/files/'+file.id,ico:name=>`<svg data-icon="${name}"></svg>`,errorText:value=>String(value)};
 c.chatHistory=createChatHistory({getState:()=>state,document,icon:c.ico});vm.createContext(c);vm.runInContext(part('const zh={','const subscriptionVoiceUnavailable=')+'\n'+part('const esc=','const iconCache=')+'\n'+part('function unreadAssistant(','function revealMessage(){')+'\n'+part('function formatTime(','function renderComputer(){'),c);
 return {c,state,document,render(){const template=document.createElement('template');template.innerHTML=c.renderMessages();reconcile(document.querySelector('#app'),template.content);},time(id){return document.querySelector('[data-id="'+id+'"] .message-time');}};
}

test('every user and assistant text, image, file and audio message shows its original localized time',()=>{
 for(const language of ['en','zh'])for(const theme of ['light','dark']){
  const f=fixture(language,theme);f.state.messages=[{id:'user',role:'user',text:'Question',status:'review',time:at,executorConfirmedAt:at+9000},{id:'text',role:'assistant',text:'Answer',status:'completed',time:at+1000},{id:'image',role:'assistant',text:'',status:'completed',time:at+2000,attachments:[{id:'photo',name:'Screenshot.png',type:'image/png'}]},{id:'file',role:'assistant',text:'',status:'completed',time:at+3000,attachments:[{id:'report',name:'Report.pdf',type:'application/pdf'}]},{id:'audio',role:'assistant',text:'',status:'completed',time:at+4000,attachments:[{id:'clip',name:'Voice.wav',type:'audio/wav'}]}];f.render();
  assert.equal(f.document.querySelectorAll('.message-time').length,5);for(const message of f.state.messages){const time=f.time(message.id);assert.ok(time);assert.equal(time.tagName,'TIME');assert.equal(time.getAttribute('datetime'),new Date(message.time).toISOString());assert.equal(time.textContent,new Intl.DateTimeFormat(language==='en'?'en-MY':'zh-CN',{hour:'2-digit',minute:'2-digit'}).format(message.time));assert.equal(time.title,f.c.formatTime(message.time,true));}
  assert.ok(f.document.querySelector('[data-id="user"] .delivery-state .message-time'));assert.equal(f.document.querySelector('[data-id="text"] .delivery-state'),null);assert.ok(f.document.querySelector('[data-id="user"] .delivery-state [data-icon="check-check"]'));assert.equal(f.document.querySelector('[data-id="user"] .task-status.review'),null);assert.equal(f.document.querySelectorAll('.time-divider').length,1);
 }
});

test('editing, streaming and reaction refreshes retain sent time and existing audio playback nodes',()=>{
 const f=fixture();f.state.messages=[{id:'user',role:'user',text:'Original',status:'completed',time:at,reactions:['👍']},{id:'reply',role:'assistant',text:'A streamed response',status:'streaming',time:at+1000,replyTo:'user',attachments:[{id:'clip',name:'Voice.ogg',type:'audio/ogg'}]}];f.render();const audio=f.document.querySelector('audio'),stamp=f.time('reply'),original=f.time('user').getAttribute('datetime');f.state.messages[0].text='Edited';f.state.messages[0].editedAt=at+86400000;f.state.messages[1].text+=' continues';f.state.messages[1].status='completed';f.render();
 assert.equal(f.time('user').getAttribute('datetime'),original);assert.ok(f.document.querySelector('.edited-label'));assert.equal(f.time('reply'),stamp);assert.equal(f.document.querySelector('audio'),audio);assert.ok(f.document.querySelector('[data-reply="reply"]'));assert.ok(f.document.querySelector('.reactions [data-emoji="👍"]'));assert.match(f.document.querySelector('[data-id="reply"] blockquote').textContent,/Edited/);assert.equal(f.document.querySelector('.stream-cursor'),null);
});

test('day and long-gap separators stay independent from per-message time and call duration',()=>{
 const f=fixture();f.state.messages=[{id:'a',role:'assistant',text:'One',time:at},{id:'b',role:'assistant',text:'Two',time:at+60000},{id:'gap',role:'user',text:'Later',time:at+1900000},{id:'call',kind:'call',seconds:75,time:at+1960000},{id:'tomorrow',role:'assistant',text:'Next day',time:at+86400000}];f.render();assert.equal(f.document.querySelectorAll('.time-divider').length,3);assert.equal(f.document.querySelectorAll('.message-time').length,4);assert.match(f.document.querySelector('.call-log').textContent,/1:15/);assert.equal(f.document.querySelector('.call-log .message-time'),null);assert.ok(f.document.querySelector('[data-key="time-gap"]'));assert.ok(f.document.querySelector('[data-key="time-tomorrow"]'));
});

test('missing and invalid times remain blank without fabricating a current or epoch timestamp',()=>{
 const f=fixture();f.state.messages=[undefined,null,'','   ',false,NaN,Infinity,'not-a-date',{},[]].map((time,index)=>({id:'invalid-'+index,role:'assistant',text:'Saved message',time}));f.state.messages.push({id:'valid',role:'assistant',text:'Valid',time:at},{id:'missing',role:'user',text:'Unknown time'},{id:'after',role:'assistant',text:'Still same group',time:at+1000});f.render();assert.equal(f.document.querySelectorAll('.message-time').length,2);assert.equal(f.document.querySelectorAll('.time-divider').length,1);assert.doesNotMatch(f.document.querySelector('#app').textContent,/Invalid Date|1970|NaN/);assert.equal(f.c.formatTime(null),'');assert.equal(f.c.formatTime(''),'');assert.equal(f.c.formatTime(false),'');assert.ok(f.c.renderMessageTime('2026-10-17T12:15:00Z').includes('2026-10-17T12:15:00.000Z'));
});

test('time labels keep existing theme colors and compact numerical spacing',()=>{
 const css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8'),rule=css.match(/\.message-time\{([^}]+)\}/)?.[1];assert.ok(rule);assert.match(rule,/color:var\(--text-faint\)/);assert.match(rule,/font-size:inherit/);assert.match(rule,/font-variant-numeric:tabular-nums/);assert.match(rule,/white-space:nowrap/);assert.match(css,/\.assistant \.message-meta>\.message-time\{margin-left:auto\}/);
});
