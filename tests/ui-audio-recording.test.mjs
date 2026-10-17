import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {createMessageSubmissions} from '../ui/pending.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
function fixture({language='en',deferPermission=false,permissionError=null,mime='audio/webm;codecs=opus'}={}){
 const {document,Event}=parseHTML('<main id="app"></main>'),app=document.querySelector('#app'),recorders=[],tracks=[],mediaRequests=[],uploads=[],messages=[],toasts=[],speechCalls=[];let resolvePermission,rejectPermission;
 const bytes=Uint8Array.from([26,69,223,163,129,1,2,3]);
 class Recorder{
  static isTypeSupported(type){return type===mime;}
  constructor(stream,options){this.stream=stream;this.mimeType=options.mimeType;this.state='inactive';recorders.push(this);}
  start(){this.state='recording';}
  stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob([bytes],{type:this.mimeType})});Promise.resolve(this.onstop?.()).catch(error=>toasts.push(error.message));});}
 }
 const c={document,Event,Blob,File,FormData,Date,MediaRecorder:Recorder,window:{MediaRecorder:Recorder},navigator:{mediaDevices:{getUserMedia:async options=>{mediaRequests.push(options);const track={stops:0,stop(){this.stops++;}},stream={getTracks:()=>[track]};tracks.push(track);if(permissionError)throw permissionError;if(deferPermission)return new Promise((resolve,reject)=>{resolvePermission=()=>resolve(stream);rejectPermission=reject;});return stream;}}},fallbackLanguage:language,state:{settings:{language},worker:{status:'online'},messages:[],queue:[],call:null},pc:null,callStarting:false,callStops:{pending:false},recording:null,recordStarting:false,recordGeneration:0,dictating:false,speakingId:null,speechGeneration:0,unloading:false,recordChunks:[],composerDraft:'Keep my typed draft',attachments:[],replyTo:null,sending:false,uploading:0,eventConnected:true,attachmentMenu:false,pendingActions:new Set(),messageSubmissions:createMessageSubmissions(),managedSettings:{renderRequests:()=>'',bind(){}},chatHistory:{bind(){},bindModal(){}},modal:null,speech:{dictate:async()=>{speechCalls.push('dictate');return 'Recognized text';},speak:async()=>{},stop:async()=>speechCalls.push('stop')},renderMessages:()=>'',renderUnconfirmedMessage:()=>'',eyes:()=>'',ico:name=>'<svg>'+name+'</svg>',button:()=>'',resizeComposer(){},bindSteer(){},bindProvision(){},bindVoiceKey(){},bindTelegram(){},bindAppearance(){},bindVMSettings(){},bindComputerInput(){},fileURL:file=>'/api/files/'+file.id,toast:value=>toasts.push(value)};
 c.api=async(route,options)=>{assert.equal(route,'/upload');const file=options.body.get('file');uploads.push({file,bytes:new Uint8Array(await file.arrayBuffer())});return {id:'audio-'+uploads.length,name:file.name,type:file.type,size:file.size};};c.post=async(route,body)=>{assert.equal(route,'/messages');messages.push(structuredClone(body));return {message:{id:'sent',submission:'confirmed'}};};
 vm.createContext(c);vm.runInContext([
  part('const zh={','const subscriptionVoiceUnavailable='),part('const esc=','const iconCache='),
  part('function renderChat(){','function spokenText('),part('function bind(){','async function taskRequest('),part('async function action(a){','async function checkUnconfirmedMessage(){'),part('async function send(confirmResend=false){','function screenVisible(){'),part('function cancelRecording(){','async function requestNotifications('),
 ].join('\n'),c);
 c.render=()=>{const current=document.querySelector('#composer');if(current)c.composerDraft=current.value;const template=document.createElement('template');template.innerHTML=c.renderChat()+'<input id="file-input" type="file" hidden>';reconcile(app,template.content);c.bind();};c.render();
 return {c,document,recorders,tracks,mediaRequests,uploads,messages,toasts,speechCalls,bytes,grant(){resolvePermission();},deny(error){rejectPermission(error);},async click(selector){const node=document.querySelector(selector);assert.ok(node,selector);node.dispatchEvent(new Event('click',{bubbles:true}));await settle();},async send(){document.querySelector('#message-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();}};
}

test('primary mic records a real audio File, leaves typed text untouched, previews it, and sends only on explicit Send',async()=>{
 const f=fixture(),mic=f.document.querySelector('.composer-tools [data-action="record"]');assert.equal(mic.title,'Record a voice message');assert.equal(f.mediaRequests.length,0);assert.equal(f.document.querySelector('.composer-tools [data-action="dictate"]'),null);
 await f.click('.composer-tools [data-action="record"]');assert.equal(f.mediaRequests.length,1);assert.equal(f.recorders.length,1);assert.equal(f.recorders[0].mimeType,'audio/webm;codecs=opus');assert.equal(f.document.querySelector('#composer').value,'Keep my typed draft');assert.equal(f.document.querySelector('.composer-tools [data-action="record"]').disabled,false,'Stop must work without any state broadcast');assert.equal(f.document.querySelector('.composer-tools [data-action="record"]').title,'Stop recording');assert.equal(f.document.querySelector('.send-btn').disabled,true);
 await f.click('.composer-tools [data-action="record"]');assert.equal(f.uploads.length,1);assert.ok(f.uploads[0].file instanceof File);assert.match(f.uploads[0].file.name,/^voice-\d+\.webm$/);assert.deepEqual(f.uploads[0].bytes,f.bytes);assert.equal(f.tracks[0].stops,1);assert.equal(f.c.attachments[0].id,'audio-1');assert.equal(f.messages.length,0);assert.equal(f.document.querySelector('#composer').value,'Keep my typed draft');assert.equal(f.document.querySelector('.draft-audio audio').getAttribute('src'),'/api/files/audio-1');assert.equal(f.document.querySelector('.draft-audio audio').hasAttribute('controls'),true);assert.equal(f.document.querySelector('.draft-audio audio').hasAttribute('autoplay'),false);const preview=f.document.querySelector('.draft-audio audio');f.c.render();assert.equal(f.document.querySelector('.draft-audio audio'),preview);assert.deepEqual(f.speechCalls,[]);
 await f.send();assert.equal(f.messages.length,1);assert.equal(f.messages[0].text,'Keep my typed draft');assert.deepEqual(f.messages[0].attachments,['audio-1']);assert.match(f.messages[0].clientMessageId,/^[\w-]+$/);assert.equal(f.c.attachments.length,0);
});

test('speech to text remains an explicit menu action with separate bilingual labels',async()=>{
 for(const [language,record,dictate]of [['zh','录制语音消息','语音转文字'],['en','Record a voice message','Speech to text']]){
  const f=fixture({language});assert.equal(f.document.querySelector('.composer-tools [data-action="record"]').getAttribute('aria-label'),record);await f.click('[data-action="attach-menu"]');assert.match(f.document.querySelector('[data-action="dictate"]').textContent,new RegExp(dictate));await f.click('[data-action="dictate"]');assert.deepEqual(f.speechCalls,['dictate']);assert.equal(f.mediaRequests.length,0);assert.equal(f.document.querySelector('#composer').value,'Keep my typed draft Recognized text');assert.equal(f.uploads.length,0);
 }
});

test('cancelled recordings discard audio and stop tracks; removed draft audio never becomes a sent attachment',async()=>{
 const f=fixture();await f.click('.composer-tools [data-action="record"]');await f.click('[data-action="cancel-record"]');assert.equal(f.c.recording,null);assert.equal(f.uploads.length,0);assert.ok(f.tracks[0].stops>=1);assert.equal(f.document.querySelector('#composer').value,'Keep my typed draft');
 await f.click('.composer-tools [data-action="record"]');await f.click('.composer-tools [data-action="record"]');assert.equal(f.uploads.length,1);await f.click('[data-remove="audio-1"]');assert.equal(f.c.attachments.length,0);await f.send();assert.deepEqual(f.messages[0].attachments,[]);
});

test('pending microphone permission disables new starts and cancellation disposes a late granted stream',async()=>{
 const f=fixture({deferPermission:true});await f.click('.composer-tools [data-action="record"]');assert.equal(f.c.recordStarting,true);assert.equal(f.document.querySelector('.composer-tools [data-action="record"]').disabled,true);await f.send();assert.equal(f.messages.length,0);await f.click('[data-action="cancel-record"]');assert.equal(f.c.recordStarting,false);f.grant();await settle();assert.equal(f.recorders.length,0);assert.equal(f.uploads.length,0);assert.equal(f.tracks[0].stops,1);assert.equal(f.document.querySelector('.composer-tools [data-action="record"]').disabled,false);
});

test('permission and recorder errors keep text, release devices, and never upload partial audio',async()=>{
 const denied=fixture({permissionError:Object.assign(Error('denied'),{name:'NotAllowedError'})});await denied.click('.composer-tools [data-action="record"]');assert.equal(denied.c.recordStarting,false);assert.equal(denied.c.recording,null);assert.equal(denied.uploads.length,0);assert.match(denied.toasts.at(-1),/Microphone permission/);assert.equal(denied.document.querySelector('.composer-tools [data-action="record"]').disabled,false);
 const failed=fixture();await failed.click('.composer-tools [data-action="record"]');failed.recorders[0].ondataavailable({data:new Blob([failed.bytes])});failed.recorders[0].onerror();await settle();assert.equal(failed.uploads.length,0);assert.ok(failed.tracks[0].stops>=1);assert.equal(failed.c.recording,null);assert.match(failed.toasts.at(-1),/Recording failed/);assert.equal(failed.document.querySelector('#composer').value,'Keep my typed draft');
});

test('recording is blocked during calls, dictation or unsupported formats without requesting the microphone',async()=>{
 const call=fixture();call.c.state.call={id:'live',provider:'subscription'};call.c.render();assert.equal(call.document.querySelector('.composer-tools [data-action="record"]').disabled,true);await call.click('.composer-tools [data-action="record"]');assert.equal(call.mediaRequests.length,0);assert.match(call.toasts.at(-1),/End the call/);
 const dictated=fixture();dictated.c.dictating=true;dictated.c.render();assert.equal(dictated.document.querySelector('.composer-tools [data-action="record"]').disabled,true);await dictated.click('.composer-tools [data-action="record"]');assert.equal(dictated.mediaRequests.length,0);
 const unsupported=fixture({mime:'audio/mp4'});await unsupported.click('.composer-tools [data-action="record"]');assert.equal(unsupported.mediaRequests.length,0);assert.match(unsupported.toasts.at(-1),/WebM or Ogg/);
});

test('waiting for read-aloud to stop owns the recording guard before any await and ignores duplicate starts',async()=>{
 const f=fixture();let finishSpeech;f.c.speakingId='reading';f.c.speech.stop=()=>new Promise(resolve=>finishSpeech=resolve);
 await f.click('.composer-tools [data-action="record"]');assert.equal(f.c.recordStarting,true);assert.equal(f.document.querySelector('.composer-tools [data-action="record"]').disabled,true);assert.ok(f.document.querySelector('[data-action="cancel-record"]'));assert.equal(f.mediaRequests.length,0);
 await f.click('.composer-tools [data-action="record"]');assert.equal(f.mediaRequests.length,0);finishSpeech();await settle();assert.equal(f.mediaRequests.length,1);assert.equal(f.recorders.length,1);assert.equal(f.c.recording,f.recorders[0]);assert.equal(f.c.recordStarting,false);assert.equal(f.document.querySelector('.composer-tools [data-action="record"]').disabled,false);
 await f.click('.composer-tools [data-action="record"]');assert.equal(f.tracks[0].stops,1);assert.equal(f.uploads.length,1);
});

test('cancel, call changes and unload during read-aloud shutdown never acquire the microphone afterward',async()=>{
 for(const reason of ['cancel','call','unload']){
  const f=fixture();let finishSpeech;f.c.speakingId='reading';f.c.speech.stop=()=>new Promise(resolve=>finishSpeech=resolve);await f.click('.composer-tools [data-action="record"]');assert.equal(f.c.recordStarting,true);
  if(reason==='cancel')await f.click('[data-action="cancel-record"]');else if(reason==='call')f.c.state.call={id:'remote-call',provider:'subscription'};else f.c.unloading=true;
  finishSpeech();await settle();assert.equal(f.mediaRequests.length,0,reason);assert.equal(f.recorders.length,0,reason);assert.equal(f.c.recordStarting,false,reason);assert.equal(f.uploads.length,0,reason);assert.equal(f.document.querySelector('#composer').value,'Keep my typed draft');
 }
});

test('an old cancelled read-aloud wait cannot clear or overwrite a newer live recording',async()=>{
 const f=fixture();let finishSpeech;f.c.speakingId='reading';f.c.speech.stop=()=>new Promise(resolve=>finishSpeech=resolve);await f.click('.composer-tools [data-action="record"]');await f.click('[data-action="cancel-record"]');await f.click('.composer-tools [data-action="record"]');const current=f.c.recording;assert.ok(current);assert.equal(f.mediaRequests.length,1);
 finishSpeech();await settle();assert.equal(f.c.recording,current);assert.equal(f.recorders.length,1);assert.equal(f.tracks[0].stops,0);await f.click('[data-action="cancel-record"]');assert.ok(f.tracks[0].stops>=1);assert.equal(f.uploads.length,0);
});

test('a call or unload arriving during microphone permission releases the late stream without recording',async()=>{
 for(const reason of ['call','unload']){const f=fixture({deferPermission:true});await f.click('.composer-tools [data-action="record"]');if(reason==='call')f.c.state.call={id:'remote-call'};else f.c.unloading=true;f.grant();await settle();assert.equal(f.recorders.length,0);assert.equal(f.tracks[0].stops,1);assert.equal(f.c.recordStarting,false);assert.equal(f.uploads.length,0);}
});
