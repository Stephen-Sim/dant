import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {VoiceKeyStore,createWindowsDpapi,validateApiKey} from '../src/secrets.mjs';

const root=path.resolve('.cache','tests');fs.mkdirSync(root,{recursive:true});
const temp=t=>{const dir=fs.mkdtempSync(path.join(root,'secret-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const key='test-only-future-token-'+randomBytes(20).toString('hex');
function protection(){
  const encryptionKey=randomBytes(32);
  return {
    async protect(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},
    async unprotect(blob){const decipher=createDecipheriv('aes-256-gcm',encryptionKey,blob.subarray(0,12));decipher.setAuthTag(blob.subarray(12,28));return Buffer.concat([decipher.update(blob.subarray(28)),decipher.final()]).toString('utf8');}
  };
}

test('key validation supports modern/future formats without exposing rejected values',()=>{
  assert.equal(validateApiKey('  '+key+'  '),key);
  assert.equal(validateApiKey('future.format/with+characters=012345'), 'future.format/with+characters=012345');
  for(const value of [null,'short','x'.repeat(4097),'secret with internal spaces','secret-with-new\nline'])assert.throws(()=>validateApiKey(value));
});

test('only protected bytes are atomically saved; status/clear never return a key',async t=>{
  const dir=temp(t),store=new VoiceKeyStore(dir,{platform:'win32',env:{},...protection()});
  assert.deepEqual(store.status(),{configured:false,source:null,storage:'windows-dpapi'});
  const result=await store.set(key);
  assert.deepEqual(result,{configured:true,source:'stored',storage:'windows-dpapi'});
  assert.equal(JSON.stringify(result).includes(key),false);
  assert.deepEqual(fs.readdirSync(dir),['voice-key.dpapi']);
  assert.equal(fs.readFileSync(store.file).includes(Buffer.from(key)),false);
  assert.equal(await store.get(),key);
  assert.equal(fs.existsSync(path.join(dir,'state.json')),false);
  assert.equal((await store.clear()).configured,false);
  assert.equal(await store.get(),null);
  assert.deepEqual(fs.readdirSync(dir),[]);
});

test('failed protection preserves the previous key and sanitizes secret-bearing errors',async t=>{
  const dir=temp(t),protector=protection(),store=new VoiceKeyStore(dir,{platform:'win32',env:{},...protector});
  await store.set(key);const original=fs.readFileSync(store.file);
  store.protect=async value=>{throw Error(value);};
  await assert.rejects(store.set(key+'new'),error=>!error.message.includes(key));
  assert.deepEqual(fs.readFileSync(store.file),original);
  assert.equal(await store.get(),key);
  assert.deepEqual(fs.readdirSync(dir),['voice-key.dpapi']);
});

test('non-Windows only uses OPENAI_API_KEY and never saves plaintext',async t=>{
  const dir=temp(t),env={OPENAI_API_KEY:key};
  const store=new VoiceKeyStore(dir,{platform:'linux',env});
  assert.deepEqual(store.status(),{configured:true,source:'environment',storage:'environment'});
  assert.equal(await store.get(),key);
  await assert.rejects(store.set(key),/Windows DPAPI/);
  assert.deepEqual(fs.readdirSync(dir),[]);
  assert.equal((await store.clear()).source,'environment');
  delete env.OPENAI_API_KEY;assert.equal(store.status().configured,false);
});

test('corrupt stored credentials fail explicitly instead of falling back to another key',async t=>{
  const dir=temp(t),store=new VoiceKeyStore(dir,{platform:'win32',env:{OPENAI_API_KEY:key+'env'},...protection()});
  await store.set(key);const blob=fs.readFileSync(store.file);blob[blob.length-1]^=1;fs.writeFileSync(store.file,blob);
  await assert.rejects(store.get(),/Cannot unlock/);
  assert.equal((await store.clear()).source,'environment');
});

test('concurrent key updates/clear are serialized and leave no temporary files',async t=>{
  const dir=temp(t),store=new VoiceKeyStore(dir,{platform:'win32',env:{},...protection()});
  await Promise.all([store.set(key),store.set(key+'next'),store.clear()]);
  assert.equal(store.status().configured,false);assert.deepEqual(fs.readdirSync(dir),[]);
});

test('PowerShell receives secrets only on stdin and returns wrapped ciphertext on stdout',async()=>{
  const calls=[],opaque=Buffer.from('opaque-dpapi-ciphertext');
  const spawnProcess=(file,args,options)=>{
    assert.equal(args.some(value=>value.includes(key)),false);
    assert.equal(options.windowsHide,true);
    assert.deepEqual(options.stdio,['pipe','pipe','pipe']);
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    let input='';child.stdin.on('data',chunk=>input+=chunk);
    child.stdin.on('finish',()=>{
      const request=JSON.parse(input);let output;
      if(request.mode==='protect'){assert.equal(request.value,key);output=opaque.toString('base64');}
      else{
        assert.equal(request.value,undefined);assert.equal(request.blob,opaque.toString('base64'));
        const mask=Buffer.from(request.mask,'base64'),wrapped=Buffer.from(key);
        for(let i=0;i<wrapped.length;i++)wrapped[i]^=mask[i];
        output=wrapped.toString('base64');
      }
      assert.equal(output.includes(key),false);
      assert.notEqual(output,Buffer.from(key).toString('base64'));
      calls.push({mode:request.mode,output});child.stdout.write(output);child.stdout.end();queueMicrotask(()=>child.emit('close',0));
    });
    return child;
  };
  const dpapi=createWindowsDpapi({spawnProcess});
  const blob=await dpapi.protect(key);assert.deepEqual(blob,opaque);
  assert.equal(await dpapi.unprotect(blob),key);assert.deepEqual(calls.map(call=>call.mode),['protect','unprotect']);
});

test('real Windows CurrentUser DPAPI roundtrip stores ciphertext and detects tampering',{skip:process.platform!=='win32'},async t=>{
  const dir=temp(t),store=new VoiceKeyStore(dir,{env:{}});
  await store.set(key);const blob=fs.readFileSync(store.file);
  assert.equal(blob.includes(Buffer.from(key)),false);assert.equal(await store.get(),key);
  blob[blob.length-1]^=1;fs.writeFileSync(store.file,blob);await assert.rejects(store.get(),/Cannot unlock/);
  await store.clear();assert.equal(store.status().configured,false);
});
