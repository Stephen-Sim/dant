import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {Rpc} from '../src/rpc.mjs';

function setup(t){const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kills:0,kill(){this.kills++;return true;}});t.mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();const rpc=new Rpc('fake-command',[]);t.after(()=>{rpc.close();child.stdout.end();child.stderr.end();t.mock.restoreAll();syncBuiltinESMExports();});const lifecycle=[];rpc.on('lifecycle',event=>lifecycle.push(event));return {child,rpc,lifecycle};}

test('RPC timeout diagnostics contain only method/count/timing and disconnect once',async t=>{
 const {rpc,child,lifecycle}=setup(t);t.mock.timers.enable({apis:['setTimeout']});
 const waiting=rpc.request('private-method-secret',{secret:'private-argument-secret'}),rejected=assert.rejects(waiting,/Timed out/);t.mock.timers.tick(60000);await rejected;child.emit('close',1,'SIGTERM');
 assert.deepEqual(lifecycle,[{code:'rpc.timeout',method:'other',durationMs:60000,count:1},{code:'rpc.disconnected',reason:'timeout',method:'other',count:1}]);assert.equal(child.kills,1);assert.equal(JSON.stringify(lifecycle).includes('private'),false);
});

test('RPC process failure and stderr remain separate from safe lifecycle metadata',async t=>{
 const {rpc,child,lifecycle}=setup(t),stderr=[];rpc.on('diagnostic',value=>stderr.push(value));child.stderr.write('private stderr sk-fixture-not-a-real-key');
 const waiting=rpc.request('turn/start',{text:'private prompt'}),rejected=assert.rejects(waiting,/private error/);child.emit('error',Error('private error containing secret'));await rejected;child.emit('close',2,'SIGTERM');
 assert.deepEqual(lifecycle,[{code:'rpc.disconnected',reason:'process-error',count:1}]);assert.equal(stderr.length,1);assert.equal(JSON.stringify(lifecycle).includes('private'),false);
});

test('RPC exit diagnostics keep numeric exit code and only recognized signals',async t=>{
 const {rpc,child,lifecycle}=setup(t);child.emit('close',23,'SIGTERM');assert.deepEqual(lifecycle,[{code:'rpc.disconnected',reason:'process-closed',exitCode:23,signal:'SIGTERM',count:0}]);assert.equal(rpc.closed,true);
});
