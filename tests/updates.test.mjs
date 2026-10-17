import test from 'node:test';
import assert from 'node:assert/strict';
import {UpdateService,compareVersions,REPOSITORY_URL,RELEASES_URL,LATEST_RELEASE_API} from '../src/updates.mjs';

const release=(tag='v0.5.0',patch={})=>({draft:false,prerelease:false,tag_name:tag,html_url:RELEASES_URL+'/tag/'+tag,...patch});
const service=options=>new UpdateService({version:'0.4.5',...options});
const code=expected=>error=>{assert.equal(error.code,expected);assert.equal(error.status,expected==='UPDATE_TIMEOUT'?504:expected==='UPDATE_RATE_LIMITED'?503:502);assert.ok(!error.message.includes('private-'));return true;};

test('version metadata is available locally and constructing an update service never makes a request',()=>{
 let calls=0;const updates=service({fetchImpl:()=>calls++});assert.deepEqual(updates.info(),{version:'0.4.5',repositoryUrl:REPOSITORY_URL,releasesUrl:RELEASES_URL});assert.equal(calls,0);updates.close();
});

test('SemVer comparison handles numeric releases, prereleases, metadata and large components',()=>{
 for(const [left,right,expected]of [['0.4.10','0.4.9',1],['1.0.0','0.99.99',1],['0.9.9','1.0.0',-1],['1.0.1','1.0.2',-1],['1.0.0','1.0.0',0],['1.0.0+build.2','1.0.0+build.1',0],['1.0.0','1.0.0-rc.1',1],['1.0.0-beta','1.0.0',-1],['1.0.0-beta.2','1.0.0-beta.11',-1],['1.0.0-beta.11','1.0.0-beta.2',1],['1.0.0-1','1.0.0-beta',-1],['1.0.0-beta','1.0.0-1',1],['1.0.0-alpha','1.0.0-beta',-1],['1.0.0-rc','1.0.0-beta',1],['1.0.0-rc','1.0.0-rc.1',-1],['1.0.0-rc.1','1.0.0-rc',1],['1.0.0-rc.1','1.0.0-rc.1',0],['9007199254740993.0.0','9007199254740992.0.0',1]])assert.equal(compareVersions(left,right),expected,left+' vs '+right);
 for(const invalid of ['unknown','01.0.0','1.0','1.0.0-01','v1.0.0',null,'1'.repeat(65)])assert.throws(()=>compareVersions(invalid,'1.0.0'),/Invalid application version/);
});

test('manual checks use a fixed unauthenticated endpoint, deduplicate requests and cache success for one minute',async()=>{
 let calls=0,finish,now=Date.UTC(2026,9,17);const updates=service({now:()=>now,fetchImpl:async(url,options)=>{calls++;assert.equal(url,LATEST_RELEASE_API);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['X-Dant-Token'],undefined);assert.equal(options.headers['X-GitHub-Api-Version'],'2022-11-28');assert.ok(options.signal instanceof AbortSignal);if(calls===1)await new Promise(resolve=>finish=resolve);return Response.json(release());}});
 const first=updates.check(),second=updates.check();assert.equal(calls,1);assert.equal(first,second);finish();const result=await first;assert.deepEqual(result,{currentVersion:'0.4.5',latestVersion:'0.5.0',updateAvailable:true,releaseUrl:RELEASES_URL+'/tag/v0.5.0',checkedAt:'2026-10-17T00:00:00.000Z'});
 const cached=await updates.check();cached.latestVersion='mutated';assert.equal((await updates.check()).latestVersion,'0.5.0');assert.equal(calls,1);now+=60000;assert.equal((await updates.check()).checkedAt,'2026-10-17T00:01:00.000Z');assert.equal(calls,2);updates.close();await assert.rejects(updates.check(),code('UPDATE_UNAVAILABLE'));
});

test('equal, older and prerelease installed versions never produce a false downgrade',async()=>{
 for(const [version,tag,available]of [['0.5.0','v0.5.0',false],['0.6.0','v0.5.0',false],['0.5.0-beta.1','v0.5.0',true],['0.6.0-beta.1','0.5.0',false]]){
  const updates=service({version,fetchImpl:async()=>Response.json(release(tag))});assert.equal((await updates.check()).updateAvailable,available);updates.close();
 }
});

test('drafts, prereleases, invalid versions and external release URLs are rejected',async()=>{
 for(const payload of [null,[],{},release('v0.5.0',{draft:true}),release('v0.5.0',{prerelease:true}),release('v0.5.0',{draft:undefined}),release('v0.5.0',{prerelease:undefined}),release('v0.5.0-rc.1'),release('v00.5.0'),release('v0.5.0+meta'),release('V0.5.0'),release('v0.5.0',{tag_name:5}),release('v0.5.0',{html_url:'https://evil.example/releases/tag/v0.5.0'}),release('v0.5.0',{html_url:RELEASES_URL+'/tag/v0.5.0?token=private-token'}),release('v0.5.0',{html_url:RELEASES_URL+'/tag/v0.5.1'}),release('v0.5.0',{html_url:'https://github.com/Stephen-Sim/dant.evil/releases/tag/v0.5.0'})]){
  const updates=service({fetchImpl:async()=>Response.json(payload)});await assert.rejects(updates.check(),code('UPDATE_INVALID_RELEASE'));updates.close();
 }
 let calls=0;const invalid=service({version:'unknown',fetchImpl:async()=>{calls++;}});await assert.rejects(invalid.check(),code('UPDATE_INVALID_RELEASE'));assert.equal(calls,0);invalid.close();
});

test('HTTP/network errors contain no upstream error text and a subsequent manual check retries',async()=>{
 for(const [status,expected]of [[403,'UPDATE_RATE_LIMITED'],[429,'UPDATE_RATE_LIMITED'],[404,'UPDATE_UNAVAILABLE'],[500,'UPDATE_UNAVAILABLE'],[302,'UPDATE_UNAVAILABLE']]){
  let calls=0;const updates=service({fetchImpl:async()=>++calls===1?new Response('private-upstream-body',{status}):Response.json(release())});await assert.rejects(updates.check(),code(expected));assert.equal((await updates.check()).updateAvailable,true);assert.equal(calls,2);updates.close();
 }
 const updates=service({fetchImpl:async()=>{throw Error('private-network-token');}});await assert.rejects(updates.check(),code('UPDATE_UNAVAILABLE'));updates.close();
});

test('JSON responses are bounded by both content length and actual bytes, including malformed/empty bodies',async()=>{
 let cancelled=false;const oversized=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(129));},cancel(){cancelled=true;}}));
 for(const response of [new Response('{}',{headers:{'Content-Length':'129'}}),oversized,new Response('private-invalid-json'),new Response(null)]){
  const updates=service({maxBytes:128,fetchImpl:async()=>response});await assert.rejects(updates.check(),code('UPDATE_INVALID_RELEASE'));updates.close();
 }assert.equal(cancelled,true);
});

test('stream and cancellation failures never expose their raw error or replace the safe failure',async()=>{
 const failed=new Response(new ReadableStream({start(controller){controller.error(Error('private-stream-error'));}})),updates=service({fetchImpl:async()=>failed});await assert.rejects(updates.check(),code('UPDATE_UNAVAILABLE'));updates.close();
 const tooLong=new Response(new ReadableStream({cancel(){throw Error('private-cancellation-error');}}),{headers:{'Content-Length':'999'}}),bounded=service({maxBytes:128,fetchImpl:async()=>tooLong});await assert.rejects(bounded.check(),code('UPDATE_INVALID_RELEASE'));bounded.close();
});

test('the deadline covers connection and response body stalls and aborts the request',async()=>{
 for(const bodyStall of [false,true]){
  let signal,cancelled=false;const updates=service({timeoutMs:15,fetchImpl:async(url,options)=>{signal=options.signal;if(!bodyStall)return new Promise(()=>{});return new Response(new ReadableStream({cancel(){cancelled=true;}}));}});
  await assert.rejects(updates.check(),code('UPDATE_TIMEOUT'));assert.equal(signal.aborted,true);assert.equal(cancelled,bodyStall);updates.close();
 }
});

test('closing cancels an in-flight request without waiting for the network timeout',async()=>{
 let signal;const updates=service({fetchImpl:async(url,options)=>{signal=options.signal;return new Promise(()=>{});}}),pending=updates.check();updates.close();await assert.rejects(pending,code('UPDATE_UNAVAILABLE'));assert.equal(signal.aborted,true);assert.equal(updates.cached,null);
});
