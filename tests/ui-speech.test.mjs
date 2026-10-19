import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechHelper,speechMessages} from '../ui/speech.js';

test('desktop dictation and read aloud are user-triggered native requests',async()=>{
 const calls=[],helper=new SpeechHelper({desktop:true,invoke:async(command,args)=>{calls.push({command,args});return command==='speech_start'&&args.mode==='recognize'?'Recognized words':'';}});
 assert.deepEqual(calls,[]);assert.equal(await helper.dictate('en'),'Recognized words');assert.equal(calls[1].args.mode,'recognize');assert.equal(calls[1].args.language,'en');await helper.speak('Hello','en');assert.equal(calls.at(-1).args.text,'Hello');await helper.stop();assert.equal(calls.at(-1).command,'speech_stop');
});

test('cancelling while native stop is pending never resurrects dictation or read-aloud',async()=>{
 for(const mode of ['dictate','speak']){
  let finish;const calls=[],helper=new SpeechHelper({desktop:true,invoke:(command)=>{calls.push(command);return calls.length===1?new Promise(resolve=>finish=resolve):Promise.resolve();}});
  const operation=mode==='dictate'?helper.dictate('zh'):helper.speak('Do not replay','zh');await helper.stop();finish();await assert.rejects(operation,error=>error.code==='speech-cancelled');assert.deepEqual(calls,['speech_stop','speech_stop']);
 }
});

test('unsupported browser dictation reports a concrete fallback instead of recording audio',async()=>{
 const helper=new SpeechHelper({desktop:false,recognizer:null,synthesis:null});await assert.rejects(helper.dictate('en'),/Windows app/);
});

test('native playback device failures use fixed localized guidance for stable codes and legacy audio errors',async()=>{
 const legacy='Exception calling SetOutputToDefaultAudioDevice: Audio device error encountered. (Exception from HRESULT: 0x2) C:\\private\\speech.ps1';
 for(const language of ['en','zh'])for(const failure of ['speech-output-unavailable',Object.assign(Error('private native details'),{code:'speech-output-unavailable'}),Error(legacy),legacy]){
  const calls=[],helper=new SpeechHelper({desktop:true,synthesis:{cancel(){},speak(){assert.fail('native errors must not switch speech providers');}},invoke:async(command,args)=>{calls.push({command,args});if(command==='speech_start')throw failure;}});
  await assert.rejects(helper.speak('Private message text',language),error=>error.code==='speech-output-unavailable'&&error.message===speechMessages[language].outputUnavailable&&!/private|HRESULT|0x2|ps1/i.test(error.message));
  assert.deepEqual(calls.map(call=>call.command),['speech_stop','speech_start']);assert.deepEqual(calls[1].args,{mode:'speak',language,text:'Private message text'});
 }
});

test('unknown read-aloud errors never expose diagnostics, paths or message text and do not retry',async()=>{
 for(const language of ['en','zh'])for(const phase of ['speech_stop','speech_start'])for(const failure of [Error('C:\\private\\speech.ps1 Secret message text'),{code:'unexpected-native-code',message:'Private device and Secret message text'},'raw exception and Secret message text']){
  const calls=[],helper=new SpeechHelper({desktop:true,invoke:async(command)=>{calls.push(command);if(command===phase)throw failure;}});
  await assert.rejects(helper.speak('Secret message text',language),error=>error.code==='read-failed'&&error.message===speechMessages[language].readFailed&&!/private|Secret|ps1|exception|unexpected/i.test(error.message));
  assert.deepEqual(calls,phase==='speech_stop'?['speech_stop']:['speech_stop','speech_start']);
 }
});

test('native cancellation stays localized and late read-aloud completions cannot survive a stop',async()=>{
 for(const language of ['en','zh']){
  for(const failure of ['speech-cancelled','Speech cancelled',Object.assign(Error('Private cancelled details'),{code:'speech-cancelled'})]){
   const helper=new SpeechHelper({desktop:true,invoke:async command=>{if(command==='speech_start')throw failure;}});await assert.rejects(helper.speak('Do not repeat',language),error=>error.code==='speech-cancelled'&&error.message===speechMessages[language].cancelled);
  }
  for(const lateFailure of [false,true]){
   let finish,start;const started=new Promise(resolve=>start=resolve),calls=[],helper=new SpeechHelper({desktop:true,invoke:command=>{calls.push(command);if(command==='speech_start'){start();return new Promise((resolve,reject)=>finish=()=>lateFailure?reject(Error('Private late audio device failure')):resolve(''));}return Promise.resolve();}});
   const speech=helper.speak('Never replay this request',language);await started;await helper.stop();finish();await assert.rejects(speech,error=>error.code==='speech-cancelled'&&error.message===speechMessages[language].cancelled);assert.deepEqual(calls,['speech_stop','speech_start','speech_stop']);
  }
 }
});

test('browser read-aloud events and synchronous failures also use safe text while cancellation remains distinct',async()=>{
 for(const language of ['en','zh'])for(const mode of ['event','throw','cancel']){
  class Utterance{constructor(text){this.text=text;}}
  let helper;const synthesis={cancel(){},getVoices:()=>[],speak:utterance=>{if(mode==='throw')throw Error('Private browser output details');queueMicrotask(()=>utterance.onerror({error:mode==='cancel'?'interrupted':'private-device-error'}));}};helper=new SpeechHelper({desktop:false,synthesis,Utterance});
  await assert.rejects(helper.speak('Private original words',language),error=>error.code===(mode==='cancel'?'speech-cancelled':'read-failed')&&error.message===speechMessages[language][mode==='cancel'?'cancelled':'readFailed']);
 }
});

test('native dictation keeps localized stable input and language failures without exposing native diagnostics',async()=>{
 for(const language of ['en','zh'])for(const [failure,key,code]of [['speech-language-unavailable','languageUnsupported','speech-language-unavailable'],['speech-input-unavailable','microphoneUnavailable','speech-input-unavailable'],['speech-cancelled','cancelled','speech-cancelled'],['Speech cancelled','cancelled','speech-cancelled'],['speech-unavailable','dictationFailed','dictation-failed'],[Error('Private C:\\speech.ps1 audio diagnostic'),'dictationFailed','dictation-failed']]){
  const calls=[],helper=new SpeechHelper({desktop:true,invoke:async(command,args)=>{calls.push({command,args});if(command==='speech_start')throw failure;}});
  await assert.rejects(helper.dictate(language),error=>error.code===code&&error.message===speechMessages[language][key]&&!/Private|ps1|diagnostic/.test(error.message));assert.deepEqual(calls.map(call=>call.command),['speech_stop','speech_start']);assert.deepEqual(calls[1].args,{mode:'recognize',language,text:null});
 }
 for(const language of ['en','zh']){
  let finish,start;const started=new Promise(resolve=>start=resolve),calls=[],helper=new SpeechHelper({desktop:true,invoke:command=>{calls.push(command);if(command==='speech_start'){start();return new Promise(resolve=>finish=()=>resolve('Stale private transcript'));}return Promise.resolve();}}),operation=helper.dictate(language);await started;await helper.stop();finish();await assert.rejects(operation,error=>error.code==='speech-cancelled'&&error.message===speechMessages[language].cancelled);assert.deepEqual(calls,['speech_stop','speech_start','speech_stop']);
 }
});
