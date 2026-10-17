import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.mjs';
import {Engine,dynamicTools} from '../src/engine.mjs';

class Worker extends EventEmitter{
 constructor(){super();this.status='offline';this.replies=[];this.sent=[];this.calls=[];this.rpc={reply:(id,result)=>this.replies.push({id,result}),send:message=>this.sent.push(message)};}
 async request(method,params){this.calls.push({method,params});return method==='thread/start'?{thread:{id:'thread'}}:{};}
}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-emoji-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir),worker=new Worker(),engine=new Engine(store,worker);
 return {dir,store,worker,engine};
}
function active(engine){return engine.active={threadId:'thread',turnId:'turn',startAcknowledged:true,assistantIds:[],messageIds:[],outputs:new Map()};}
function request(turnId,messageId,emoji,id=1){return {id,method:'item/tool/call',params:{threadId:'thread',turnId,tool:'react_message',arguments:{messageId,emoji}}};}
function mcp(messageId,emoji,id='mcp-reaction'){return {id,type:'mcpToolCall',server:'dant_desktop',tool:'react_message',status:'completed',arguments:{messageId,emoji},result:{structuredContent:{dantReaction:{messageId,emoji}}}};}

test('dant reaction tool sets an independent persisted emoji idempotently and removes only its own reaction',async t=>{
 const {dir,store,engine}=fixture(t),message=store.add({role:'user',text:'Thanks for your help',status:'review',reactions:['👍'],read:false});
 let saves=0;const save=store.save.bind(store);store.save=()=>{saves++;return save();};
 const first=await engine.tool('react_message',{messageId:message.id,emoji:'👍'});assert.equal(first.changed,true);assert.equal(message.assistantReaction,'👍');assert.ok(message.assistantReactionUpdatedAt>0);const at=message.assistantReactionUpdatedAt;
 assert.deepEqual(message.reactions,['👍']);assert.equal(message.status,'review');assert.equal(message.read,false);
 const same=await engine.tool('react_message',{messageId:message.id,emoji:'👍'});assert.equal(same.changed,false);assert.equal(saves,1);assert.equal(message.assistantReactionUpdatedAt,at);
 assert.equal(new Store(dir).state.messages.find(item=>item.id===message.id).assistantReaction,'👍');
 await engine.tool('react_message',{messageId:message.id,emoji:'❤️'});assert.equal(message.assistantReaction,'❤️');
 const removed=await engine.tool('react_message',{messageId:message.id,emoji:null});assert.equal(removed.changed,true);assert.equal(message.assistantReaction,null);assert.deepEqual(message.reactions,['👍']);
 const before=saves;assert.equal((await engine.tool('react_message',{messageId:message.id,emoji:null})).changed,false);assert.equal(saves,before);assert.equal(new Store(dir).state.messages.find(item=>item.id===message.id).assistantReaction,null);
});

test('no reaction is inferred from message contents, task inputs, or reference creation',t=>{
 const {store,engine}=fixture(t),message=store.add({role:'user',text:'I love this! 😆 ❤️'});
 const input=engine.input(message);assert.ok(input[0].text.includes(message.id));assert.ok(input[0].text.includes(message.text));assert.match(input[0].text,/not a request to react/);assert.match(engine.instructions(),/Decide naturally and sparingly/);
 assert.equal(Object.hasOwn(message,'assistantReaction'),false);assert.deepEqual(message.reactions,[]);
 const schema=dynamicTools.find(tool=>tool.name==='react_message');assert.deepEqual(schema.inputSchema.required,['messageId','emoji']);assert.deepEqual(schema.inputSchema.properties.emoji.type,['string','null']);
 assert.doesNotMatch(engine.input({id:'voice-task-transient',text:'Ephemeral voice'})[0].text,/Current user message ID/);
});

test('invalid emoji, nonexistent targets and assistant/system messages never mutate the conversation',async t=>{
 const {store,engine}=fixture(t),user=store.add({role:'user',text:'user'}),assistant=store.add({role:'assistant',text:'assistant'}),system=store.add({role:'system',text:'system'});
 for(const emoji of ['hello','😆😮','',42,{},'👍\n',undefined])await assert.rejects(engine.tool('react_message',{messageId:user.id,emoji}),/supported emoji/);
 await assert.rejects(engine.tool('react_message',{messageId:user.id}),/supported emoji/);
 for(const id of ['missing',assistant.id,system.id])await assert.rejects(engine.tool('react_message',{messageId:id,emoji:'👍'}),/only user messages/);
 assert.ok(store.state.messages.every(message=>!Object.hasOwn(message,'assistantReaction')));
});

test('only an accepted current ordinary tool turn may apply a model reaction',async t=>{
 const {store,engine,worker}=fixture(t),message=store.add({role:'user',text:'Hello'});active(engine);
 await engine.handle(request('wrong-turn',message.id,'👍'));assert.equal(message.assistantReaction,undefined);assert.equal(worker.sent.at(-1).error.code,-32602);
 await engine.handle({...request('turn',message.id,'👍',2),params:{...request('turn',message.id,'👍').params,threadId:'other'}});assert.equal(message.assistantReaction,undefined);
 await engine.handle(request('turn',message.id,'👍',3));assert.equal(message.assistantReaction,'👍');assert.equal(worker.replies.at(-1).result.success,true);
 engine.active=null;await engine.handle(request('turn',message.id,'❤️',4));assert.equal(message.assistantReaction,'👍');assert.equal(worker.sent.at(-1).error.code,-32602);
});

test('resumed conversations receive the MCP reaction tool without creating a new Codex thread',async t=>{
 const {store,engine,worker}=fixture(t),message=store.add({role:'user',text:'Existing user'});
 store.state.threadId='thread';store.state.threadRuntime=engine.runtimeId;store.state.threadConversationId=store.state.conversationId;
 await engine.thread();assert.equal(worker.calls[0].method,'thread/resume');assert.equal(worker.calls.some(call=>call.method==='thread/start'),false);
 const turn=active(engine);await engine.handle({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:mcp(message.id,'🎉')}});assert.equal(message.assistantReaction,'🎉');assert.equal(turn.deliveredMcpIds.has('mcp-reaction'),true);
 const at=message.assistantReactionUpdatedAt;await engine.acceptMcpResult(mcp(message.id,'🎉'),turn);assert.equal(message.assistantReactionUpdatedAt,at);
 const remove=mcp(message.id,null,'remove');remove.result={content:[{type:'text',text:JSON.stringify({dantReaction:{messageId:message.id,emoji:null}})}]};assert.equal(await engine.acceptMcpResult(remove,turn),true);assert.equal(message.assistantReaction,null);
});

test('MCP reactions require owned completed tool events and matching arguments/result',async t=>{
 const {store,engine}=fixture(t),message=store.add({role:'user',text:'Hello'}),turn=active(engine);
 for(const changed of [{server:'foreign'},{tool:'unrelated'},{status:'failed'},{result:{isError:true}},{arguments:{messageId:'other',emoji:'👍'}}])assert.equal(await engine.acceptMcpResult({...mcp(message.id,'👍'),...changed},turn),false);
 assert.equal(await engine.acceptMcpResult(mcp(message.id,'👍'),null),false);
 await engine.handle({method:'item/completed',params:{threadId:'thread',turnId:'stale-turn',item:mcp(message.id,'👍')}});assert.equal(message.assistantReaction,undefined);
 const invalid=mcp(message.id,'not an emoji','invalid');await assert.rejects(engine.acceptMcpResult(invalid,turn),/supported emoji/);assert.equal(message.assistantReaction,undefined);
});

test('a failed reaction save rolls back the in-memory field and reports failure',async t=>{
 const {store,engine}=fixture(t),message=store.add({role:'user',text:'Hello'});const save=store.save;store.save=()=>{throw Error('injected disk failure');};
 await assert.rejects(engine.tool('react_message',{messageId:message.id,emoji:'👍'}),/disk failure/);assert.equal(Object.hasOwn(message,'assistantReaction'),false);assert.equal(Object.hasOwn(message,'assistantReactionUpdatedAt'),false);
 store.save=save;await engine.tool('react_message',{messageId:message.id,emoji:'👍'});const at=message.assistantReactionUpdatedAt;store.save=()=>{throw Error('injected disk failure');};
 await assert.rejects(engine.tool('react_message',{messageId:message.id,emoji:null}),/disk failure/);assert.equal(message.assistantReaction,'👍');assert.equal(message.assistantReactionUpdatedAt,at);
});
