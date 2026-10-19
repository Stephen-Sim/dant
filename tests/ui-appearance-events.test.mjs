import {sourceIndex,sourceSection} from './source-fixtures.mjs';
import {languageContext} from './language-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {createAppearance,appearanceDefaults,exportAppearance,importAppearance} from '../ui/appearance.js';

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8');
const part=(start,end)=>sourceSection(source,start,end);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({defer=false}={}){
 const {document,Event}=parseHTML('<!doctype html><html><body><main id="app"></main><button id="outside" type="button">Outside appearance</button></body></html>'),app=document.querySelector('#app'),requests=[],pending=[],stored=new Map();
 const c={document,URL,Date,serializeAppearance:exportAppearance,parseAppearance:importAppearance,fallbackLanguage:'en',state:{settings:{...appearanceDefaults,font:'sans',language:'en'}},fontInventory:{source:'windows',fonts:['Arial Rounded MT','Microsoft YaHei']},fontLoading:false,fontError:'',fontSearch:'',fontMenuOpen:false,appearanceAdvanced:false,attachmentMenu:false,emojiFor:null,esc:value=>String(value??''),ico:()=>'',toast(){}};
 c.appearance=createAppearance({document,storage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)},matchMedia:()=>null,save:async patch=>{requests.push({...patch});if(defer)await new Promise(resolve=>pending.push(resolve));}});
 c.render=()=>{
  c.appearance.sync(c.state.settings);const before=document.querySelector('#appearance-font-picker'),wasOpen=before?.hasAttribute('open');
  const next=document.createElement('template');next.innerHTML=c.renderAppearance();reconcile(app,next.content);
  const picker=document.querySelector('#appearance-font-picker');if(!Object.hasOwn(picker,'open'))Object.defineProperty(picker,'open',{get(){return this.hasAttribute('open');},set(value){this.toggleAttribute('open',value);}});
  c.bindAppearance();if(before===picker&&wasOpen!==picker.open)queueMicrotask(()=>picker.dispatchEvent(new Event('toggle')));
 };
 vm.createContext(Object.assign(c,languageContext));vm.runInContext(part('const zh={','const subscriptionVoiceUnavailable=')+'\n'+part('const appearanceFields=','function bindVMSettings(){')+'\n'+part("document.addEventListener('pointerdown'","document.addEventListener('keydown'"),c);c.render();
 // LinkeDOM supplies actual bubbling EventTarget/DOM behavior, but not native
 // details activation. Complete the summary's browser default after dispatch.
 async function click(node){node.dispatchEvent(new Event('pointerdown',{bubbles:true}));node.dispatchEvent(new Event('pointerup',{bubbles:true}));const event=new Event('click',{bubbles:true,cancelable:true});node.dispatchEvent(event);if(node.tagName==='SUMMARY'&&!event.defaultPrevented){const picker=node.parentElement;picker.open=!picker.open;picker.dispatchEvent(new Event('toggle'));}await settle();}
 return {c,document,requests,pending,click};
}

test('a real bubbling font selection survives html appearance attributes and later unrelated clicks',async()=>{
 const f=fixture();assert.equal(f.document.documentElement.dataset.font,'sans');assert.equal(f.document.documentElement.dataset.theme,'light');
 await f.click(f.document.querySelector('#appearance-font-picker>summary'));assert.equal(f.document.querySelector('#appearance-font-picker').open,true);assert.equal(f.requests.length,0,'opening the list must not persist a font reset');
 await f.click(f.document.querySelector('[data-font-family="Arial Rounded MT"]'));await settle();assert.deepEqual(f.requests,[{fontFamily:'Arial Rounded MT'}]);assert.equal(f.c.appearance.preferences.fontFamily,'Arial Rounded MT');assert.equal(f.c.state.settings.fontFamily,'Arial Rounded MT');assert.match(f.document.querySelector('#appearance-font-picker>summary').textContent,/Arial Rounded MT/);assert.match(f.document.documentElement.style.getPropertyValue('--app-font-family'),/^"Arial Rounded MT",/);assert.equal(f.document.documentElement.onclick,null,'the html element is never an appearance action');
 await f.click(f.document.querySelector('#outside'));assert.equal(f.requests.length,1);assert.equal(f.c.appearance.preferences.fontFamily,'Arial Rounded MT');
});

test('a bubbling theme click saves only its mode and font search retains selection through pending snapshots',async()=>{
 const f=fixture({defer:true});await f.click(f.document.querySelector('[data-theme="dark"]'));assert.deepEqual(f.requests,[{theme:'dark'}]);assert.equal(f.document.documentElement.dataset.theme,'dark');f.pending.shift()();await settle();
 await f.click(f.document.querySelector('#appearance-font-picker>summary'));const search=f.document.querySelector('#appearance-font-search');search.value='yahei';search.dispatchEvent(new f.document.defaultView.Event('input',{bubbles:true}));assert.equal(f.document.querySelector('[data-font-family="Arial Rounded MT"]'),null);
 await f.click(f.document.querySelector('[data-font-family="Microsoft YaHei"]'));assert.deepEqual(f.requests.at(-1),{fontFamily:'Microsoft YaHei'});f.c.state.settings={...appearanceDefaults,font:'sans',language:'en'};f.c.render();assert.match(f.document.querySelector('#appearance-font-picker>summary').textContent,/Microsoft YaHei/,'an older snapshot cannot clear an optimistic selection');f.pending.shift()();await settle();
 assert.equal(f.requests.length,2);assert.equal(f.c.state.settings.fontFamily,'Microsoft YaHei');assert.equal(f.c.appearance.preferences.fontFamily,'Microsoft YaHei');
});
