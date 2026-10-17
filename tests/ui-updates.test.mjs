import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {createUpdates} from '../ui/updates.js';

const releaseUrl='https://github.com/Stephen-Sim/dant/releases/tag/v1.2.0';
const update={currentVersion:'1.0.0',latestVersion:'1.2.0',updateAvailable:true,releaseUrl,checkedAt:1234};
const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture({language='en',native=false,version='1.0.0',openFailure=null}={}){
 const {document,Event}=parseHTML('<main id="app"></main>'),app=document.querySelector('#app'),requests=[],opened=[],errors=[];let request=async route=>route==='/version'?{version:'1.0.0'}:update;
 const ui=createUpdates({version,document,getLanguage:()=>language,onChange:render,request:async route=>{requests.push(route);return request(route);},...(native?{openExternal:async url=>{if(openFailure)throw openFailure;opened.push(url);}}:{}),onOpenError:error=>errors.push(error)});
 function render(){const template=document.createElement('template');template.innerHTML=ui.render();reconcile(app,template.content);ui.bind();}
 render();return {ui,document,Event,requests,opened,errors,set request(value){request=value;},set language(value){language=value;},render,async enter(){ui.setVisible(true);render();await settle();},async click(selector){const node=document.querySelector(selector);assert.ok(node,selector);node.dispatchEvent(new Event('click',{bubbles:true,cancelable:true}));await settle();}};
}

test('settings show the bundled version offline and only entering settings reads local version, without checking GitHub',async()=>{
 const f=fixture();assert.equal(f.document.querySelector('[data-app-version]').textContent,'1.0.0');await f.click('[data-check-updates]');assert.deepEqual(f.requests,[]);
 f.request=async()=>{throw Error('Local controller is offline');};await f.enter();
 assert.equal(f.document.querySelector('[data-app-version]').textContent,'1.0.0');assert.equal(f.document.querySelector('[data-check-updates]').disabled,false);assert.deepEqual(f.requests,['/version']);
 f.ui.setVisible(true);await settle();assert.deepEqual(f.requests,['/version']);
 f.ui.setVisible(false);f.request=async()=>({version:'1.0.1'});await f.enter();assert.equal(f.document.querySelector('[data-app-version]').textContent,'1.0.1');assert.deepEqual(f.requests,['/version','/version']);
});

test('actual check button disables duplicate checks, displays a newer release and uses the native external opener',async()=>{
 const f=fixture({native:true});await f.enter();const pending=deferred();f.request=()=>pending.promise;
 await f.click('[data-check-updates]');assert.equal(f.document.querySelector('[data-check-updates]').disabled,true);assert.equal(f.document.querySelector('[data-check-updates]').getAttribute('aria-busy'),'true');assert.match(f.document.querySelector('[role="status"]').textContent,/Checking/);
 await f.click('[data-check-updates]');assert.deepEqual(f.requests,['/version','/updates']);
 pending.resolve(update);await settle();assert.equal(f.document.querySelector('[data-check-updates]').disabled,false);assert.match(f.document.querySelector('[role="status"]').textContent,/1\.2\.0/);
 const link=f.document.querySelector('[data-update-release]');assert.equal(link.href,releaseUrl);assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');await f.click('[data-update-release]');assert.deepEqual(f.opened,[releaseUrl]);
});

test('both languages render current-version and retry states without exposing network or API details',async()=>{
 for(const [language,current,failed,retry]of [['en','You’re up to date.','Could not check for updates.','Try again'],['zh','已是最新版本。','无法检查更新','重试']]){
  const f=fixture({language});await f.enter();f.request=async()=>({...update,updateAvailable:false});await f.click('[data-check-updates]');assert.equal(f.document.querySelector('[role="status"]').textContent,current);assert.equal(f.document.querySelector('[data-update-release]'),null);
  f.request=async()=>{throw Error('private server body, token=abc');};await f.click('[data-check-updates]');assert.ok(f.document.querySelector('[role="status"]').textContent.startsWith(failed));assert.equal(f.document.querySelector('[data-check-updates]').textContent,retry);assert.doesNotMatch(f.document.body.textContent,/private|token=abc/);
  f.request=async()=>update;await f.click('[data-check-updates]');assert.ok(f.document.querySelector('[data-update-release]'));assert.equal(f.document.querySelector('[data-check-updates]').disabled,false);
 }
});

test('late responses after leaving settings never render or overwrite a later visit',async()=>{
 const f=fixture(),oldVersion=deferred(),oldCheck=deferred();f.request=route=>route==='/version'?oldVersion.promise:oldCheck.promise;
 f.ui.setVisible(true);await f.click('[data-check-updates]');f.ui.setVisible(false);
 f.request=async route=>route==='/version'?{version:'2.0.0'}:{...update,currentVersion:'2.0.0',latestVersion:'2.0.0',updateAvailable:false};await f.enter();await f.click('[data-check-updates]');const status=f.document.querySelector('[role="status"]').textContent;
 oldVersion.resolve({version:'0.1.0'});oldCheck.resolve(update);await settle();assert.equal(f.document.querySelector('[data-app-version]').textContent,'2.0.0');assert.equal(f.document.querySelector('[role="status"]').textContent,status);assert.equal(f.document.querySelector('[data-update-release]'),null);
});

test('leaving or unloading during a failed check ignores rejection and allows a clean next visit',async()=>{
 for(const dispose of [false,true]){
  const f=fixture();await f.enter();const pending=deferred();f.request=()=>pending.promise;await f.click('[data-check-updates]');if(dispose)f.ui.dispose();else f.ui.setVisible(false);pending.reject(Error('old failure'));await settle();
  f.request=async route=>route==='/version'?{version:'1.0.0'}:update;await f.enter();await f.click('[data-check-updates]');assert.ok(f.document.querySelector('[data-update-release]'));
 }
});

test('malformed versions and noncanonical update URLs cannot create an external link',async()=>{
 const invalid=[{...update,releaseUrl:'not a url'},{...update,releaseUrl:'javascript:alert(1)'},{...update,releaseUrl:'https://evil.example/release'}, {...update,releaseUrl:'https://github.com.evil.example/Stephen-Sim/dant/releases/tag/v1.2.0'}, {...update,releaseUrl:releaseUrl+'?token=abc'}, {...update,releaseUrl:releaseUrl+'#bad'}, {...update,releaseUrl:'https://user@github.com/Stephen-Sim/dant/releases/tag/v1.2.0'}, {...update,releaseUrl:'https://github.com:8443/Stephen-Sim/dant/releases/tag/v1.2.0'}, {...update,releaseUrl:22}, {...update,releaseUrl:'x'.repeat(501)}, {...update,currentVersion:'<img onerror=alert(1)>'}, {...update,latestVersion:'garbage'}, {...update,updateAvailable:'yes'}, null];
 const f=fixture({native:true});await f.enter();for(const item of invalid){f.request=async()=>item;await f.click('[data-check-updates]');assert.equal(f.document.querySelector('[data-update-release]'),null);assert.match(f.document.querySelector('[role="status"]').textContent,/Could not check/);assert.equal(f.document.querySelector('img'),null);}assert.deepEqual(f.opened,[]);
});

test('browser release links keep standard safe navigation and invalid local versions preserve a safe bundled value',async()=>{
 const f=fixture({version:'<unsafe>'});assert.equal(f.document.querySelector('[data-app-version]').textContent,'—');f.request=async route=>route==='/version'?{version:'<unsafe>'}:update;await f.enter();assert.equal(f.document.querySelector('[data-app-version]').textContent,'—');await f.click('[data-check-updates]');assert.equal(f.document.querySelector('[data-update-release]').onclick,null);assert.equal(f.document.querySelector('[data-update-release]').href,releaseUrl);assert.equal(f.document.querySelector('unsafe'),null);
});

test('native opener errors are handled and stale detached links cannot launch after navigation',async()=>{
 const error=Error('OS browser unavailable'),failed=fixture({native:true,openFailure:error});await failed.enter();await failed.click('[data-check-updates]');await failed.click('[data-update-release]');assert.deepEqual(failed.errors,[error]);assert.equal(failed.document.querySelector('[data-check-updates]').disabled,false);
 const f=fixture({native:true});await f.enter();await f.click('[data-check-updates]');const link=f.document.querySelector('[data-update-release]');f.ui.setVisible(false);link.dispatchEvent(new f.Event('click',{cancelable:true}));await settle();assert.deepEqual(f.opened,[]);
});
