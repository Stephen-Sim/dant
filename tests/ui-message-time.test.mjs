import {createTaskReplyController} from '../ui/task-reply.js';
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
 c.chatHistory=createChatHistory({getState:()=>state,document,icon:c.ico});c.taskReplies??=createTaskReplyController({document:c.document,getModel:()=>({})});vm.createContext(c);vm.runInContext(part('const zh={','const subscriptionVoiceUnavailable=')+'\n'+part('const esc=','const iconCache=')+'\n'+part('function unreadAssistant(','function revealMessage(){')+'\n'+part('function formatTime(','function renderComputer(){'),c);
 return {c,state,document,render(){const template=document.createElement('template');template.innerHTML=c.renderMessages();reconcile(document.querySelector('#app'),template.content);}};
}

test('nearby text and attachment messages share one localized divider while retaining receipts',()=>{
 for(const language of ['en','zh'])for(const theme of ['light','dark']){
  const f=fixture(language,theme);f.state.messages=[{id:'user',role:'user',text:'Question',status:'review',time:at,executorConfirmedAt:at+9000},{id:'text',role:'assistant',text:'Answer',status:'completed',time:at+1000},{id:'image',role:'assistant',text:'',status:'completed',time:at+2000,attachments:[{id:'photo',name:'Screenshot.png',type:'image/png'}]},{id:'file',role:'assistant',text:'',status:'completed',time:at+3000,attachments:[{id:'report',name:'Report.pdf',type:'application/pdf'}]},{id:'audio',role:'assistant',text:'',status:'completed',time:at+4000,attachments:[{id:'clip',name:'Voice.wav',type:'audio/wav'}]}];f.render();
  assert.equal(f.document.querySelectorAll('time.message-time').length,5);assert.equal(f.document.querySelectorAll('.time-divider').length,1);assert.equal(f.document.querySelector('.time-divider').textContent,f.c.formatTime(at,true));
  for(const message of f.state.messages){const article=f.document.querySelector(`[data-id="${message.id}"]`),stamp=article.querySelector('.message-meta>time.message-time'),full=new Intl.DateTimeFormat(language==='en'?'en-MY':'zh-CN',{dateStyle:'medium',timeStyle:'medium'}).format(new Date(message.time));assert.ok(stamp);assert.equal(stamp.textContent,f.c.formatTime(message.time));assert.equal(stamp.getAttribute('datetime'),new Date(message.time).toISOString());assert.equal(stamp.getAttribute('aria-label'),full);assert.equal(stamp.parentElement.lastElementChild,stamp);assert.equal(stamp.hasAttribute('title'),false);assert.equal(article.querySelector('.bubble').hasAttribute('title'),false);}
  assert.equal(f.document.querySelector('[data-id="text"] .delivery-state'),null);assert.ok(f.document.querySelector('[data-id="user"] .delivery-state [data-icon="check-check"]'));assert.ok(f.document.querySelector('[data-id="text"] .message-read-state'));assert.equal(f.document.querySelector('[data-id="user"] .task-status.review'),null);
 }
});

test('editing, streaming and reaction refreshes retain the group divider and audio playback nodes',()=>{
 const f=fixture();f.state.messages=[{id:'user',role:'user',text:'Original',status:'completed',time:at,reactions:['👍']},{id:'reply',role:'assistant',text:'A streamed response',status:'streaming',time:at+1000,replyTo:'user',attachments:[{id:'clip',name:'Voice.ogg',type:'audio/ogg'}]}];f.render();const audio=f.document.querySelector('audio'),divider=f.document.querySelector('.time-divider'),original=divider.textContent,stamp=f.document.querySelector('[data-id="user"] .message-time');f.state.messages[0].text='Edited';f.state.messages[0].editedAt=at+86400000;f.state.messages[1].text+=' continues';f.state.messages[1].status='completed';f.render();
 assert.equal(f.document.querySelector('.time-divider'),divider);assert.equal(divider.textContent,original);assert.equal(f.state.messages[0].time,at);assert.equal(f.document.querySelectorAll('.message-time').length,2);assert.equal(f.document.querySelector('[data-id="user"] .message-time'),stamp);assert.equal(stamp.getAttribute('datetime'),new Date(at).toISOString());assert.equal(stamp.textContent,f.c.formatTime(at));assert.ok(f.document.querySelector('.edited-label'));assert.equal(f.document.querySelector('audio'),audio);assert.ok(f.document.querySelector('[data-reply="reply"]'));assert.ok(f.document.querySelector('.reactions [data-emoji="👍"]'));assert.match(f.document.querySelector('[data-id="reply"] blockquote').textContent,/Edited/);assert.equal(f.document.querySelector('.stream-cursor'),null);
});

test('day and long-gap separators remain visible alongside the call duration',()=>{
 const f=fixture();f.state.messages=[{id:'a',role:'assistant',text:'One',time:at},{id:'b',role:'assistant',text:'Two',time:at+60000},{id:'gap',role:'user',text:'Later',time:at+1900000},{id:'call',kind:'call',seconds:75,time:at+1960000},{id:'tomorrow',role:'assistant',text:'Next day',time:at+86400000}];f.render();assert.equal(f.document.querySelectorAll('.time-divider').length,3);assert.equal(f.document.querySelectorAll('.message-time').length,4);assert.match(f.document.querySelector('.call-log').textContent,/1:15/);assert.equal(f.document.querySelector('.call-log .message-time'),null);assert.equal(f.document.querySelector('.call-log>span').getAttribute('title'),new Intl.DateTimeFormat('en-MY',{dateStyle:'medium',timeStyle:'medium'}).format(new Date(at+1960000)));assert.ok(f.document.querySelector('[data-key="time-gap"]'));assert.ok(f.document.querySelector('[data-key="time-tomorrow"]'));
});

test('missing and invalid times remain blank without fabricating a current or epoch timestamp',()=>{
 const f=fixture();f.state.messages=[undefined,null,'','   ',false,NaN,Infinity,'not-a-date',{},[]].map((time,index)=>({id:'invalid-'+index,role:'assistant',text:'Saved message',time}));f.state.messages.push({id:'valid',role:'assistant',text:'Valid',time:at},{id:'missing',role:'user',text:'Unknown time'},{id:'after',role:'assistant',text:'Still same group',time:at+1000});f.render();assert.equal(f.document.querySelectorAll('.message-time').length,2);assert.deepEqual([...f.document.querySelectorAll('.message-time')].map(node=>node.closest('.message').dataset.id),['valid','after']);assert.equal(f.document.querySelectorAll('.time-divider').length,1);assert.doesNotMatch(f.document.querySelector('#app').textContent,/Invalid Date|1970|NaN/);assert.equal(f.c.formatTime(null),'');assert.equal(f.c.formatTime(''),'');assert.equal(f.c.formatTime(false),'');assert.equal(f.c.formatTime('2026-10-17T12:15:00Z',true),f.c.formatTime(at,true));
});
