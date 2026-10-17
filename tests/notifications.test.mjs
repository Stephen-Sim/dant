import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NotificationHub} from '../src/notifications.mjs';

test('host notifications ignore old completions, wait for unread grace and persist acknowledgements',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-notify-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1000;
 const hub=new NotificationHub(dir,{now:()=>now});
 hub.observe({completions:[{id:'old',at:10,messageIds:['a']}],messages:[{id:'a',role:'assistant'}]});
 hub.configure(true);now=1500;
 const snapshot={conversationId:'chat',completions:[{id:'old',at:10,messageIds:['a']},{id:'new',at:1400,messageIds:['b']}],messages:[{id:'a'},{id:'b',text:'private task contents'}]};
 hub.observe(snapshot);assert.deepEqual(hub.pending(),[]);now=4501;const [notification]=hub.pending();assert.equal(notification.id,'new');assert.ok(!JSON.stringify(notification).includes('private task'));
 hub.acknowledge('new');assert.deepEqual(hub.pending(),[]);const reloaded=new NotificationHub(dir,{now:()=>now});reloaded.observe(snapshot);assert.deepEqual(reloaded.pending(),[]);
});

test('viewing a completion during the grace period prevents a notification',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dant-notify-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1000;
 const hub=new NotificationHub(dir,{now:()=>now});hub.configure(true);now=1200;
 const snapshot={completions:[{id:'one',at:1100,messageIds:['m']}],messages:[{id:'m',read:false}]};hub.observe(snapshot);now=2000;snapshot.messages[0].read=true;hub.observe(snapshot);now=8000;assert.deepEqual(hub.pending(),[]);
});
