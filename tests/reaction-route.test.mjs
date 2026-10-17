import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createWorkerApp} from '../src/server.mjs';
import {defaultReactions} from '../src/reactions.mjs';

test('reaction HTTP updates authoritative feedback for voice context without executing a task',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dant-reaction-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const worker=new EventEmitter();Object.assign(worker,{status:'offline',calls:[],request(...args){this.calls.push(args);},disconnect(){}});
 const provider=new EventEmitter();provider.close=async()=>{};let voiceOptions;
 const instance=createWorkerApp({dataDir:directory,workerFactory:()=>worker,voiceFactory:options=>{voiceOptions=options;return provider;}});t.after(()=>instance.close());
 const message=instance.store.add({role:'assistant',text:'Delivered screenshot',attachments:[{name:'screen.png'}]});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+instance.server.address().port;
 const {token}=await fetch(base+'/api/session').then(r=>r.json());const react=emoji=>fetch(base+'/api/messages/'+message.id+'/reaction',{method:'POST',headers:{'X-Dant-Token':token,'Content-Type':'application/json'},body:JSON.stringify({emoji})});
 assert.equal((await react('👍')).status,200);assert.deepEqual(message.reactions,['👍']);assert.ok(message.reactionUpdatedAt>0);
 let context=voiceOptions.context();assert.match(context,/Delivered screenshot/);assert.match(context,/screen\.png/);assert.match(context,/👍/);
 assert.equal((await react('👍')).status,200);assert.deepEqual(message.reactions,[]);context=voiceOptions.context();assert.doesNotMatch(context,/👍/);assert.match(context,/"reactions":\[\]/);
 assert.equal((await react('👀')).status,200);assert.match(voiceOptions.context(),/👀/);assert.equal(worker.calls.length,0);assert.equal(instance.engine.queue.length,0);assert.equal(instance.store.state.messages.length,1);
 assert.equal((await react('unsupported')).status,400);assert.deepEqual(message.reactions,['👀']);
});

test('reaction HTTP accepts six defaults and Unicode emoji while preserving legacy feedback and rejecting text',async t=>{
 const testRoot=path.resolve('.cache/tests');fs.mkdirSync(testRoot,{recursive:true});const directory=fs.mkdtempSync(path.join(testRoot,'reaction-route-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const worker=new EventEmitter();Object.assign(worker,{status:'offline',calls:[],request(...args){this.calls.push(args);},disconnect(){}});
 const instance=createWorkerApp({dataDir:directory,workerFactory:()=>worker});t.after(()=>instance.close());const message=instance.store.add({role:'assistant',text:'Historical result',reactions:['😂','👀','🎉']});
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+instance.server.address().port,{token}=await fetch(base+'/api/session').then(response=>response.json());
 const react=(emoji,id=message.id)=>fetch(base+'/api/messages/'+id+'/reaction',{method:'POST',headers:{'X-Dant-Token':token,'Content-Type':'application/json'},body:JSON.stringify({emoji})});
 for(const {emoji}of defaultReactions){assert.equal((await react(emoji)).status,200);assert.ok(message.reactions.includes(emoji));assert.equal((await react(emoji)).status,200);assert.equal(message.reactions.includes(emoji),false);}
 assert.deepEqual(message.reactions,['😂','👀','🎉']);for(const emoji of ['👍🏽','👩‍💻','🇲🇾'])assert.equal((await react(emoji)).status,200);
 const previous=[...message.reactions],timestamp=message.reactionUpdatedAt;for(const emoji of ['😆😮','hello','赞','👩\u200d','🏽','👍\n','👍\r\n','😆\u2028',null,{},'x'.repeat(10000)]){assert.equal((await react(emoji)).status,400);assert.deepEqual(message.reactions,previous);assert.equal(message.reactionUpdatedAt,timestamp);}
 assert.equal((await react('👍','missing-message')).status,404);assert.equal(worker.calls.length,0);assert.equal(instance.engine.queue.length,0);
 const legacy=instance.store.add({role:'assistant',text:'Old message without a reactions field'});delete legacy.reactions;assert.equal((await react('😮',legacy.id)).status,200);assert.deepEqual(legacy.reactions,['😮']);
});
