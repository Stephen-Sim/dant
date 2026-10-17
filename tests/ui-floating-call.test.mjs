import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {reconcile} from '../ui/dom.js';
import {createFloatingCall} from '../ui/floating-call.js';

function fixture(){
 const {document,Event}=parseHTML('<html><body><main id="app"><section class="conversation"></section></main></body></html>');
 const app=document.querySelector('#app'),anchor=document.querySelector('.conversation'),listeners=new Map(),observers=[];
 const window={document,addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);}};
 const geometry={left:0,top:0,right:1000,bottom:700,width:1000,height:700},anchorBox={left:52,top:66,right:650,bottom:700,width:598,height:634},size={width:340,height:68};
 app.getBoundingClientRect=()=>({...geometry});anchor.getBoundingClientRect=()=>({...anchorBox});
 class Observer{constructor(callback){this.callback=callback;this.nodes=new Set();observers.push(this);}observe(node){this.nodes.add(node);}disconnect(){this.nodes.clear();}}
 let now=1000,callKey='call-a',clicks=0;
 const controller=createFloatingCall({window,ResizeObserverImpl:Observer,now:()=>now});
 function render(mini=true){
  const template=document.createElement('template');template.innerHTML=`<div data-key="call-view" class="call-view ${mini?'mini':''}"><i class="call-avatar"><img></i><p>In a call</p><span data-call-duration>1:23</span><div class="call-controls"><button data-action="mute"><svg></svg></button><button data-action="hangup"></button><button data-action="call-size"></button></div></div>`;
  reconcile(anchor,template.content);
  const node=anchor.querySelector('.call-view');
  node.getBoundingClientRect=()=>({left:parseFloat(node.style.left)||0,top:parseFloat(node.style.top)||0,width:size.width,height:size.height,right:(parseFloat(node.style.left)||0)+size.width,bottom:(parseFloat(node.style.top)||0)+size.height});
  const captured=new Set();node.setPointerCapture=id=>captured.add(id);node.hasPointerCapture=id=>captured.has(id);node.releasePointerCapture=id=>captured.delete(id);node.captured=captured;
  controller.sync(mini?node:null,{callKey,bounds:app,anchor});
  return node;
 }
 const node=render();node.addEventListener('click',()=>clicks++);
 function event(target,type,values={}){const value=new Event(type,{bubbles:true,cancelable:true});Object.assign(value,{pointerId:7,button:0,isPrimary:true,clientX:400,clientY:100,...values});target.dispatchEvent(value);return value;}
 function drag(target=node,dx=100,dy=100){event(target,'pointerdown');event(document,'pointermove',{clientX:400+dx,clientY:100+dy});event(document,'pointerup',{clientX:400+dx,clientY:100+dy});}
 return {document,window,node,app,anchor,geometry,anchorBox,size,controller,observers,listeners,event,drag,render,get clicks(){return clicks;},newCall(key){callKey=key;},advance(ms){now+=ms;},windowEvent(name){for(const fn of [...listeners.get(name)||[]])fn();}};
}
const location=node=>({x:parseFloat(node.style.left),y:parseFloat(node.style.top)});

test('floating call drags by avatar, status or empty space across both app panes',()=>{
 const f=fixture();assert.deepEqual(location(f.node),{x:294,y:82});
 f.drag(f.node.querySelector('.call-avatar img'),450,200);assert.deepEqual(location(f.node),{x:652,y:282});
 assert.ok(location(f.node).x>f.anchorBox.right-f.size.width,'the computer pane is inside the permitted app area');
 f.drag(f.node.querySelector('p'),-100,-90);assert.deepEqual(location(f.node),{x:552,y:192});
 f.drag(f.node,0,70);assert.deepEqual(location(f.node),{x:552,y:262});assert.equal(f.node.captured.size,0);assert.equal(f.node.hasAttribute('data-call-dragging'),false);f.controller.dispose();
});

test('mini call controls, media elements, links and editable targets never start a drag',()=>{
 const f=fixture(),before=location(f.node);f.node.insertAdjacentHTML('beforeend','<a href="#">Link</a><audio controls></audio><input><div contenteditable="true"><span>Edit</span></div>');
 for(const target of f.node.querySelectorAll('button,button svg,a,audio,input,[contenteditable] span')){f.drag(target);assert.deepEqual(location(f.node),before);assert.equal(f.node.captured.size,0);}
 f.event(f.node,'pointerdown',{button:2});f.event(f.document,'pointermove',{clientX:900});assert.deepEqual(location(f.node),before);
 f.event(f.node,'pointerdown',{isPrimary:false});f.event(f.document,'pointermove',{clientX:900});assert.deepEqual(location(f.node),before);f.controller.dispose();
});

test('the bar keeps its position through keyed state updates, duration ticks, full view and page return',()=>{
 const f=fixture();f.drag(f.node,120,130);const moved=location(f.node),avatar=f.node.querySelector('.call-avatar'),mute=f.node.querySelector('[data-action="mute"]');
 f.node.querySelector('[data-call-duration]').textContent='1:24';assert.deepEqual(location(f.node),moved);
 for(let i=0;i<3;i++){assert.equal(f.render(),f.node);assert.deepEqual(location(f.node),moved);}
 assert.equal(f.node.querySelector('.call-avatar'),avatar);assert.equal(f.node.querySelector('[data-action="mute"]'),mute);
 f.render(false);assert.equal(f.node.getAttribute('style'),null,'the full call keeps its existing CSS geometry');
 f.render(true);assert.deepEqual(location(f.node),moved);
 f.controller.sync(null,{callKey:'call-a',bounds:f.app,anchor:f.anchor});f.node.remove();const restored=f.render(true);assert.deepEqual(location(restored),moved);f.controller.dispose();
});

test('bounds and bar size changes clamp every edge; a new call resets the previous position',()=>{
 const f=fixture();f.drag(f.node,-2000,-1000);assert.deepEqual(location(f.node),{x:8,y:8});
 f.drag(f.node,4000,3000);assert.deepEqual(location(f.node),{x:652,y:624});
 Object.assign(f.geometry,{right:600,bottom:400,width:600,height:400});f.windowEvent('resize');assert.deepEqual(location(f.node),{x:252,y:324});
 f.size.height=100;f.observers[0].callback();assert.deepEqual(location(f.node),{x:252,y:292});
 f.anchorBox.right=480;f.anchorBox.width=428;f.newCall('call-b');f.render();assert.deepEqual(location(f.node),{x:124,y:82});f.controller.dispose();
});

test('capture survives a render mid-gesture, ignores other pointers and cleans up on cancel or blur',()=>{
 const f=fixture();f.event(f.node.querySelector('p'),'pointerdown');assert.equal(f.node.captured.has(7),true);
 f.event(f.document,'pointermove',{pointerId:8,clientX:800});assert.deepEqual(location(f.node),{x:294,y:82});
 f.event(f.document,'pointermove',{clientX:450,clientY:150});assert.equal(f.node.hasAttribute('data-call-dragging'),true);
 f.render();assert.equal(f.node.hasAttribute('data-call-dragging'),true);
 f.event(f.document,'pointermove',{clientX:500,clientY:180});assert.deepEqual(location(f.node),{x:394,y:162});
 f.event(f.document,'pointercancel');assert.equal(f.node.hasAttribute('data-call-dragging'),false);const after=location(f.node);
 f.event(f.document,'pointermove',{clientX:800,clientY:500});assert.deepEqual(location(f.node),after);
 f.event(f.node,'pointerdown');f.event(f.document,'pointermove',{clientX:450,clientY:150});f.windowEvent('blur');assert.equal(f.node.hasAttribute('data-call-dragging'),false);f.controller.dispose();
});

test('drag release suppresses its click without blocking a later control click or keyboard activation',()=>{
 const f=fixture();f.drag();const click=f.event(f.node,'click',{detail:1});assert.equal(click.defaultPrevented,true);assert.equal(f.clicks,0);
 const mute=f.node.querySelector('[data-action="mute"]');let muted=0;mute.addEventListener('click',()=>muted++);f.event(mute,'pointerdown');f.event(mute,'pointerup');f.event(mute,'click',{detail:1});assert.equal(muted,1);
 f.drag();f.event(mute,'click',{detail:0});assert.equal(muted,2,'keyboard-generated clicks stay accessible');
 f.advance(501);f.event(f.node,'click',{detail:1});assert.ok(f.clicks>0);f.controller.dispose();
});

test('short clicks do not move the call and dispose removes all movement ownership',()=>{
 const f=fixture(),before=location(f.node);f.event(f.node,'pointerdown');f.event(f.document,'pointermove',{clientX:402,clientY:101});f.event(f.document,'pointerup');f.event(f.node,'click',{detail:1});assert.deepEqual(location(f.node),before);assert.equal(f.clicks,1);
 f.event(f.node,'pointerdown');f.controller.dispose();f.event(f.document,'pointermove',{clientX:800});assert.deepEqual(location(f.node),before);assert.equal(f.node.captured.size,0);assert.ok([...f.listeners.values()].every(set=>set.size===0));assert.equal(f.observers[0].nodes.size,0);f.render();f.drag();assert.equal(f.node.getAttribute('style'),null,'a disposed controller cannot reclaim the view');
});

test('main render reapplies the controller after DOM reconciliation and fixed styling covers the app',()=>{
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');
 assert.match(source,/import \{createFloatingCall\} from '\.\/floating-call\.js'/);assert.match(source,/reconcile\(app,template\.content\);bind\(\);resizeComposer\(\);\s*floatingCall\.sync/);
 assert.match(css,/\.call-view\.mini\{position:fixed;z-index:20;cursor:grab;touch-action:none;user-select:none\}/);assert.match(css,/\.call-view\.mini\[data-call-dragging\]\{cursor:grabbing\}/);
});

function parentOverlay(){
 const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),start=source.indexOf('function publishCallOverlay(){'),end=source.indexOf('function renderUnconfirmedMessage(){',start),updates=[],actions=[];
 const state={call:{id:'call-a',connectedAt:1000},settings:{language:'en'},messages:[{text:'private conversation'}],memory:'private memory'};
 const context={state,callId:'call-a',pc:{connectionState:'connected'},callStarting:false,callConnected:true,callChannel:{readyState:'open'},callStops:{pending:false},callDuration:{snapshot:{callId:'call-a',seconds:12,confirmed:true,running:true}},callMuted:false,stream:{getTracks(){throw Error('Overlay must not own media');}},document:{documentElement:{dataset:{theme:'dark'}}},language:()=>state.settings.language,unloading:false,nativeCallOverlay:{update:value=>updates.push(structuredClone(value))},action:async value=>{actions.push(value);if(value==='mute')context.callMuted=!context.callMuted;}};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);return {context,updates,actions};
}

test('native overlay publication contains only call display state and stops when the call ends',()=>{
 const f=parentOverlay();f.context.publishCallOverlay();
 assert.deepEqual(f.updates.at(-1),{callId:'call-a',status:'talking',connectedAt:1000,seconds:12,confirmed:true,running:true,muted:false,canMute:true,language:'en',theme:'dark'});
 f.context.callMuted=true;f.context.state.settings.language='zh';f.context.document.documentElement.dataset.theme='light';f.context.callDuration.snapshot.seconds=13;f.context.publishCallOverlay();assert.equal(f.updates.at(-1).muted,true);assert.equal(f.updates.at(-1).language,'zh');assert.equal(f.updates.at(-1).theme,'light');assert.equal(f.updates.at(-1).seconds,13);
 f.context.pc=null;f.context.stream=null;f.context.callDuration.snapshot.running=false;f.context.publishCallOverlay();assert.equal(f.updates.at(-1).status,'recovering');assert.equal(f.updates.at(-1).canMute,false);assert.equal(f.updates.at(-1).running,false);
 f.context.callId=null;f.context.state.call=null;f.context.publishCallOverlay();assert.equal(f.updates.at(-1),null);
 f.context.callStops.pending=true;f.context.publishCallOverlay();assert.equal(f.updates.at(-1).callId,'call-a');assert.equal(f.updates.at(-1).status,'stopping');assert.equal(f.updates.at(-1).canMute,false);
 assert.doesNotMatch(JSON.stringify(f.updates),/private conversation|private memory/);assert.deepEqual(f.actions,[]);
});

test('native overlay actions target the current parent call and reuse its existing controls',async()=>{
 const f=parentOverlay(),handle=f.context.handleNativeCallAction;
 await handle({callId:'old-call',action:'hangup'});await handle({callId:'call-a',action:'unknown'});assert.deepEqual(f.actions,[]);
 await handle({callId:'call-a',action:'mute',muted:true});await handle({callId:'call-a',action:'mute',muted:true});await handle({callId:'call-a',action:'mute'});await handle({callId:'call-a',action:'hangup'});assert.deepEqual(f.actions,['mute','hangup']);
 await handle({callId:'call-a',action:'restore'});assert.deepEqual(f.actions,['mute','hangup'],'native restoration must not toggle call size or recreate media');
 f.context.stream=null;await handle({callId:'call-a',action:'mute',muted:false});f.context.stream={};f.context.callStops.pending=true;await handle({callId:'call-a',action:'mute',muted:false});assert.deepEqual(f.actions,['mute','hangup']);
 f.context.unloading=true;await handle({callId:'call-a',action:'hangup'});assert.deepEqual(f.actions,['mute','hangup']);
});

test('native mute actions set the desired state without replaying a stale toggle',async()=>{
 const f=parentOverlay(),handle=f.context.handleNativeCallAction;
 await handle({callId:'call-a',action:'mute',muted:true});await handle({callId:'call-a',action:'mute',muted:true});assert.equal(f.context.callMuted,true);assert.deepEqual(f.actions,['mute']);
 await handle({callId:'call-a',action:'mute',muted:false});await handle({callId:'call-a',action:'mute',muted:false});assert.equal(f.context.callMuted,false);assert.deepEqual(f.actions,['mute','mute']);
});
