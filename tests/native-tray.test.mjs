import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {trayStatus,createNativeTray} from '../ui/native-tray.js';

const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const state=values=>({settings:{language:'en'},worker:{status:'online'},queue:[],...values});
function fixture(options={}){
 const calls=[];let handler,stops=0,opened=0;
 const tray=createNativeTray({desktop:true,loadCore:async()=>({invoke:async(command,args)=>{calls.push({command,args});return options.invoke?.(command,args);}}),loadEvents:async()=>({listen:async(name,callback)=>{assert.equal(name,'dant-tray-progress');handler=callback;return ()=>stops++;}}),onProgress:()=>opened++,...options});
 return {tray,calls,event:()=>handler?.({payload:'ignored'}),get stops(){return stops;},get opened(){return opened;}};
}
test('tray status projects only bounded public metadata and separates active work from call presence',()=>{
 assert.deepEqual(trayStatus(),{language:'zh',connection:'offline',task:'idle',queued:0});
 assert.deepEqual(trayStatus(state({call:{id:'secret-call'},messages:[{text:'private'}],token:'secret'})),{language:'en',connection:'online',task:'idle',queued:0});
 assert.equal(trayStatus(state({active:{status:'running',background:true,text:'private task'}})).task,'background');
 for(const status of ['waiting_user','pausing','unknown'])assert.equal(trayStatus(state({active:{status,background:true}})).task,status);
 assert.equal(trayStatus(state({active:{status:'private exception'}})).task,'running');
 assert.equal(trayStatus(state({worker:{status:'offline'}})).connection,'offline');
 assert.equal(trayStatus(state({controller:{status:'offline'}})).connection,'offline');
 assert.equal(trayStatus(state({controller:{status:'connecting'}})).connection,'connecting');
 assert.equal(trayStatus(state({controller:{status:'error'}})).connection,'offline');
 assert.equal(trayStatus(state({worker:{status:'connecting'}})).connection,'connecting');
 assert.equal(trayStatus(state({controller:{cached:true},active:{status:'running'}})).connection,'offline');
 assert.equal(trayStatus(state({queue:Array(1200).fill('private id')})).queued,999);
 assert.equal(trayStatus(state({queue:'invalid'})).queued,0);
});
test('browser mode never imports native APIs or emits tray updates',()=>{
 let loads=0;const tray=createNativeTray({loadCore:()=>loads++,loadEvents:()=>loads++});tray.sync(state());tray.dispose();tray.sync(state());assert.equal(loads,0);
});
test('native status deduplicates identical snapshots and the fixed progress event opens work progress',async()=>{
 const f=fixture();f.tray.sync(state({messages:[{text:'never sent'}]}));await settle();f.tray.sync(state());await settle();
 assert.deepEqual(f.calls,[{command:'tray_status_update',args:{status:trayStatus(state())}}]);assert.doesNotMatch(JSON.stringify(f.calls),/never sent/);
 f.event();assert.equal(f.opened,1);f.tray.dispose();f.event();f.tray.sync(state({active:{}}));await settle();assert.equal(f.calls.length,1);assert.equal(f.stops,1);assert.equal(f.opened,1);f.tray.dispose();
});
test('native updates coalesce in flight while changed state survives an earlier failure',async()=>{
 const wait=deferred(),f=fixture({invoke:()=>f.calls.length===1?wait.promise:undefined});f.tray.sync(state());await settle();f.tray.sync(state({active:{background:true}}));f.tray.sync(state({active:{status:'waiting_user'}}));wait.reject(Error('Private OS error'));await settle();assert.equal(f.calls.length,2);assert.equal(f.calls[1].args.status.task,'waiting_user');f.tray.dispose();
 const pending=deferred(),g=fixture({invoke:()=>g.calls.length===1?pending.promise:undefined});g.tray.sync(state());await settle();g.tray.sync(state({active:{}}));pending.resolve();await settle();assert.equal(g.calls.length,2);assert.equal(g.calls[1].args.status.task,'running');g.tray.dispose();
});
test('tray initialization failures are bounded and disposal during initialization releases the listener',async()=>{
 let attempts=0;const f=fixture({loadCore:async()=>{attempts++;throw Error('Private import error');}});f.tray.sync(state());await settle();assert.equal(attempts,1);assert.equal(f.calls.length,0);f.tray.sync(state());await settle();assert.equal(attempts,2);f.tray.dispose();
 const wait=deferred();let stops=0;const g=fixture({loadEvents:async()=>({listen:()=>wait.promise})});g.tray.sync(state());await settle();g.tray.dispose();wait.resolve(()=>stops++);await settle();assert.equal(stops,1);assert.equal(g.calls.length,0);
});
test('native lifecycle installs one instance first, hides only after successful tray setup, and uses graceful exit',()=>{
 const main=fs.readFileSync(new URL('../src-tauri/src/main.rs',import.meta.url),'utf8'),tray=fs.readFileSync(new URL('../src-tauri/src/tray.rs',import.meta.url),'utf8'),overlay=fs.readFileSync(new URL('../src-tauri/src/call_overlay.rs',import.meta.url),'utf8'),cargo=fs.readFileSync(new URL('../src-tauri/Cargo.toml',import.meta.url),'utf8');
 assert.ok(main.indexOf('.plugin(tauri_plugin_single_instance::init')<main.indexOf('.plugin(tauri_plugin_notification::init'));
 assert.match(main,/if !tray::on_window_event\(window,event\)\{call_overlay::on_window_event/);
 assert.match(main,/RunEvent::Exit=event/);assert.match(main,/drop\(child\.stdin\.take\(\)\)/);
 assert.match(tray,/window\.hide\(\)\.is_ok\(\)[\s\S]*api\.prevent_close\(\)/);assert.match(tray,/state\.ready\.store\(true/);assert.match(tray,/state\.exiting\.store\(true[\s\S]*app\.exit\(0\)/);
 assert.match(tray,/window\.label\(\) != "main"/);assert.match(tray,/dant-tray-progress/);assert.doesNotMatch(tray,/process::exit|api\/call\/stop|turn\/interrupt/);
 assert.match(overlay,/let background = minimized \|\| !main\.is_visible/);assert.match(overlay,/if !background \|\| call\.is_none\(\)/);assert.match(cargo,/features = \["tray-icon"\]/);
});
