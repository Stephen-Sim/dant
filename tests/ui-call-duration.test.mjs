import test from 'node:test';
import {createCallSubtitles} from '../ui/call-subtitles.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createCallDuration,formatCallDuration} from '../ui/call-duration.js';
import {createCallStops} from '../ui/pending.js';

function fixture(){let now=10000,next=0;const timers=new Map(),ticks=[];const clock=createCallDuration({now:()=>now,schedule:(fn,ms)=>{assert.equal(ms,1000);timers.set(++next,fn);return next;},cancel:id=>timers.delete(id),onTick:value=>ticks.push(value)});return {clock,timers,ticks,advance(ms){now+=ms;for(const tick of timers.values())tick();}};}

test('negotiation does not count; a confirmed connection starts at the authoritative timestamp',()=>{
 const f=fixture();f.clock.sync({id:'a',status:'connecting',connectedAt:null});f.advance(5000);assert.equal(f.clock.snapshot.seconds,0);assert.equal(f.clock.snapshot.confirmed,false);assert.equal(f.timers.size,0);
 f.clock.start('',0);f.clock.start('a',NaN);f.clock.start('a',-1);assert.equal(f.timers.size,0);
 f.clock.start('a',15000);f.advance(3000);assert.equal(f.clock.snapshot.seconds,3);assert.equal(f.clock.snapshot.running,true);assert.equal(f.timers.size,1);
 f.clock.sync({id:'a',status:'connected',connectedAt:15000});f.advance(1000);assert.equal(f.clock.snapshot.seconds,4);assert.equal(f.timers.size,1,'snapshot broadcasts must not stack timers');
});

test('disconnect and pending hangup freeze the timer and only the exact history record finalizes it',()=>{
 const f=fixture();f.clock.start('a',10000);f.advance(1200);f.clock.stop('wrong');assert.equal(f.timers.size,1);f.clock.stop('a');assert.equal(f.clock.snapshot.seconds,1);assert.equal(f.timers.size,0);f.advance(5000);
 f.clock.sync({id:'a',status:'stop-unconfirmed',connectedAt:10000},[{kind:'call',callId:'other',seconds:99}]);assert.equal(f.timers.size,0);assert.equal(f.clock.snapshot.seconds,1);assert.equal(f.clock.snapshot.finalized,false);
 f.clock.sync(null,[{kind:'call',callId:'a',seconds:7}]);assert.equal(f.clock.snapshot.seconds,7);assert.equal(f.clock.snapshot.finalized,true);assert.equal(f.clock.snapshot.running,false);assert.equal(formatCallDuration(f.clock.snapshot.seconds),'0:07');
});

test('new calls reset elapsed time; old records and late hangups cannot affect the new call',()=>{
 const f=fixture();f.clock.start('a',10000);f.advance(65000);f.clock.sync(null);assert.equal(f.clock.snapshot.seconds,65);assert.equal(f.timers.size,0);f.clock.reset();assert.equal(f.clock.snapshot.seconds,0);assert.equal(f.clock.snapshot.callId,null);f.clock.stop();
 f.clock.sync({callId:'b',connectedAt:75000},[{kind:'call',callId:'a',seconds:67}]);assert.equal(f.clock.snapshot.callId,'b');assert.equal(f.clock.snapshot.seconds,0);f.clock.stop('a',100);f.advance(2000);assert.equal(f.clock.snapshot.seconds,2);f.clock.dispose();assert.equal(f.timers.size,0);f.advance(5000);assert.equal(f.clock.snapshot.seconds,2);
});

test('duration formatting matches chat history for zero, long calls and invalid values',()=>{
 assert.equal(formatCallDuration(0),'0:00');assert.equal(formatCallDuration(61),'1:01');assert.equal(formatCallDuration(3599),'59:59');assert.equal(formatCallDuration(3600),'1:00:00');assert.equal(formatCallDuration(3601),'1:00:01');assert.equal(formatCallDuration(3903),'1:05:03');assert.equal(formatCallDuration(4666),'1:17:46');assert.equal(formatCallDuration(36000),'10:00:00');assert.equal(formatCallDuration(86461),'24:01:01');assert.equal(formatCallDuration(-1),'0:00');assert.equal(formatCallDuration(NaN),'0:00');assert.equal(formatCallDuration(9.9),'0:09');
});

const source=fs.readFileSync(new URL('../ui/main.js',import.meta.url),'utf8'),part=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),settle=()=>new Promise(resolve=>setImmediate(resolve));
function callFixture(){
 let now=10000,next=0;const intervals=new Map(),requests=[];
 class Peer{constructor(){this.connectionState='new';}addTrack(){}createDataChannel(){return this.dc={readyState:'connecting'};}async createOffer(){return {sdp:'offer'};}async setLocalDescription(){}async setRemoteDescription(value){this.remoteDescription=value;}close(){this.connectionState='closed';}}
 const track={stop(){}},media={getTracks:()=>[track]},c={Date:class extends Date{static now(){return now;}},navigator:{mediaDevices:{getUserMedia:async()=>media}},window:{RTCPeerConnection:Peer},RTCPeerConnection:Peer,Audio:class{pause(){}},setTimeout:()=>1,clearTimeout(){},pc:null,callStarting:false,callConnected:false,callId:null,callGeneration:0,callProvider:'subscription',callMini:false,callChannel:null,callTimeout:null,stream:null,audio:null,callMuted:false,dictating:false,speakingId:null,recording:null,recordStarting:false,recordDraft:null,unloading:false,eventConnected:true,page:'chat',chatMode:'text',state:{worker:{status:'online'},settings:{language:'en'},messages:[],call:null},subscriptionVoiceUnavailable:()=>false,apiVoiceUnavailable:()=>false,render(){},toast(){},handleEvent(){},t:value=>value,stopSpeech:async()=>{},stopReadTracking(){},stopFailure:false,transport:{startEvents(value){c.connectionHandler=value.onConnection;}}};
 c.callDuration=createCallDuration({now:()=>now,schedule:fn=>{intervals.set(++next,fn);return next;},cancel:id=>intervals.delete(id)});
 c.post=async(route,body)=>{requests.push({route,body});if(route==='/call'){const id='call-'+requests.length;c.state.call={id,provider:'subscription',status:'connecting',connectedAt:null};return {callId:id,sdp:'answer'};}if(route==='/call/connected'){c.state.call.connectedAt=now;c.state.call.status='connected';return {callId:body.callId,connected:true,connectedAt:now};}if(route==='/call/stop'){if(c.stopFailure)throw Object.assign(Error('Network disconnected'),{unknownOutcome:true});c.state.messages.push({kind:'call',callId:body.callId,seconds:8});c.state.call=null;return {stopped:true};}throw Error('Unexpected mock route');};c.api=async()=>c.state;c.callStops=createCallStops(id=>c.post('/call/stop',{callId:id}));
 c.updateInstalling=false;c.callSubtitles=createCallSubtitles();
 vm.createContext(c);vm.runInContext(part('async function startCall(','async function toggleRecord(){')+'\n'+part('function connectEvents(){',"document.addEventListener('pointerdown'"),c);
 return {c,intervals,requests,advance(ms){now+=ms;for(const tick of intervals.values())tick();},async connect(){await c.startCall();const peer=c.pc;assert.equal(intervals.size,0);peer.connectionState='connected';peer.onconnectionstatechange();await settle();assert.equal(intervals.size,0,'peer connection alone does not start duration');peer.dc.readyState='open';peer.dc.onopen();await settle();assert.equal(c.callConnected,true);assert.equal(intervals.size,1);return peer;}};
}

test('actual hangup handler freezes pending stops and later reconciles the authoritative final history duration',async()=>{
 const f=callFixture();await f.connect();f.advance(1200);const id=f.c.callId;f.c.stopFailure=true;await f.c.endCall();assert.equal(f.c.callDuration.snapshot.seconds,1);assert.equal(f.intervals.size,0);assert.equal(f.c.callStops.pending,true);assert.equal(f.requests.at(-1).body.callId,id);
 f.c.callDuration.sync(f.c.state.call,f.c.state.messages);f.advance(5000);assert.equal(f.c.callDuration.snapshot.seconds,1,'stale connected state cannot restart an ended local connection');f.c.stopFailure=false;await f.c.flushCallStops();assert.equal(f.c.callDuration.snapshot.seconds,8);assert.equal(f.c.callDuration.snapshot.finalized,true);assert.equal(f.intervals.size,0);
 await f.c.startCall();assert.equal(f.c.callDuration.snapshot.seconds,0);assert.equal(f.c.callDuration.snapshot.confirmed,false);f.c.cleanupCall();
});

test('actual service-disconnect handler freezes the duration and retains the exact call for recovery',async()=>{
 const f=callFixture();await f.connect();f.c.connectEvents();f.advance(2600);const id=f.c.callId;f.c.connectionHandler(false);assert.equal(f.c.callDuration.snapshot.seconds,3);assert.equal(f.intervals.size,0);assert.equal(f.c.pc,null);assert.equal(f.c.callStops.pending,true);
 f.c.stopFailure=true;f.c.connectionHandler(true);await settle();assert.equal(f.requests.at(-1).body.callId,id);f.advance(5000);assert.equal(f.c.callDuration.snapshot.seconds,3);assert.equal(f.intervals.size,0);
});
