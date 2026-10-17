import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechHelper} from '../ui/speech.js';

test('desktop dictation and read aloud are user-triggered native requests',async()=>{
 const calls=[],helper=new SpeechHelper({desktop:true,invoke:async(command,args)=>{calls.push({command,args});return command==='speech_start'&&args.mode==='recognize'?'Recognized words':'';}});
 assert.deepEqual(calls,[]);assert.equal(await helper.dictate('en'),'Recognized words');assert.equal(calls[1].args.mode,'recognize');assert.equal(calls[1].args.language,'en');await helper.speak('Hello','en');assert.equal(calls.at(-1).args.text,'Hello');await helper.stop();assert.equal(calls.at(-1).command,'speech_stop');
});

test('cancelling while native stop is pending never resurrects dictation',async()=>{
 let finish;const calls=[],helper=new SpeechHelper({desktop:true,invoke:(command)=>{calls.push(command);return calls.length===1?new Promise(resolve=>finish=resolve):Promise.resolve();}});
 const dictation=helper.dictate('zh');await helper.stop();finish();await assert.rejects(dictation,error=>error.code==='speech-cancelled');assert.deepEqual(calls,['speech_stop','speech_stop']);
});

test('unsupported browser dictation reports a concrete fallback instead of recording audio',async()=>{
 const helper=new SpeechHelper({desktop:false,recognizer:null,synthesis:null});await assert.rejects(helper.dictate('en'),/Windows app/);
});
