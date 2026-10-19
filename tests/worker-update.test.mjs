import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const script=fs.readFileSync('vm/install-worker.sh','utf8').replaceAll('\r\n','\n');
const check=script.match(/python3 - "\$\{1:-check\}" <<'PY'\n([\s\S]*?)\nPY/)[1];
const idle=()=>({active:null,call:null,queue:[],takeover:false,computer:{status:'dant',sessionId:null},worker:{status:'online'},messages:[],workTasks:[]});
const step=(route,value,options={})=>({route,value,...options});
const session=()=>step('/api/session',{token:'fixture-session'});
const state=value=>step('/api/state',value);
const pause=()=>step('/api/tasks/pause',{ok:true},{method:'POST',body:{}});
const witness=()=>step('/api/connect',{ok:true},{method:'POST',body:{idleRecovery:true}});
const harness=String.raw`
import io, json, sys, urllib.request
fixture=json.loads(sys.argv[1]); source=sys.argv[2]; sys.argv=['-',fixture.get('mode','pause')]
calls=[]; replies=list(fixture['replies'])
def urlopen(request, timeout):
    route=(request if isinstance(request,str) else request.full_url).removeprefix('http://127.0.0.1:4317')
    body=None if isinstance(request,str) or request.data is None else json.loads(request.data)
    method='GET' if body is None else 'POST'
    calls.append({'route':route,'method':method,'body':body})
    if not replies: raise RuntimeError('Unexpected network request')
    reply=replies.pop(0)
    if (route,method,body)!=(reply['route'],reply.get('method','GET'),reply.get('body')): raise RuntimeError('Unexpected request ownership')
    if reply.get('error'): raise TimeoutError('PRIVATE RESPONSE MUST NOT BE EXPOSED')
    return io.BytesIO(json.dumps(reply['value']).encode())
urllib.request.urlopen=urlopen
try:
    exec(compile(source,'worker-update-check','exec'))
finally:
    print(json.dumps({'calls':calls,'remaining':len(replies)}))
`;
function run(replies,{mode='pause'}={}){
 const result=spawnSync(process.env.PYTHON||'python',['-c',harness,JSON.stringify({mode,replies}),check],{encoding:'utf8',shell:false,timeout:10000});
 if(result.error)throw result.error;
 return {...result,report:JSON.parse(result.stdout)};
}

test('manual update pauses beta2 work twice and preserves its authoritative legacy idle witness',()=>{
 const busy={...idle(),active:{workId:'one',turnId:'turn'},queue:['queued'],workTasks:[{id:'one',status:'running'}]};
 const ended={...idle(),workTasks:[{id:'one',status:'continuing'}]};
 const paused={...idle(),workTasks:[{id:'one',status:'paused'}]};
 const result=run([session(),state(busy),pause(),state(ended),pause(),witness(),state(paused)]);
 assert.equal(result.status,0,result.stderr);assert.equal(result.report.remaining,0);
 assert.deepEqual(result.report.calls.map(call=>call.route),['/api/session','/api/state','/api/tasks/pause','/api/state','/api/tasks/pause','/api/connect','/api/state']);
});

test('automatic deployment leaves busy work running without issuing mutations',()=>{
 const result=run([session(),state({...idle(),active:{turnId:'current'}})],{mode:'check'});
 assert.equal(result.status,79);assert.match(result.stderr,/DANT_WORK_ACTIVE/);
 assert.ok(result.report.calls.every(call=>call.method==='GET'));
});

test('automatic deployment defers during human control and keeps the existing service available',()=>{
 for(const computer of [{status:'human',sessionId:'control'},{status:'taking-over',sessionId:null},{status:'dant',pending:true},{status:'dant',sessionId:'pending-control'}]){
  const result=run([session(),state({...idle(),computer})],{mode:'check'});
  assert.equal(result.status,79,JSON.stringify(computer)+' '+result.stderr);assert.match(result.stderr,/DANT_WORK_ACTIVE/);
  assert.ok(result.report.calls.every(call=>call.method==='GET'));
 }
});

test('a known current call is closed normally and then saved work is paused again',()=>{
 const busy={...idle(),active:{turnId:'work'},call:{id:'call-one'}};
 const result=run([session(),state(busy),pause(),state({...idle(),call:{id:'call-one'}}),step('/api/call/stop',{stopped:true},{method:'POST',body:{callId:'call-one'}}),pause(),witness(),state(idle())]);
 assert.equal(result.status,0,result.stderr);assert.equal(result.report.remaining,0);
});

test('manual update refuses changed call ownership without stopping the replacement call',()=>{
 for(const initial of [null,{id:'first'}]){
  const result=run([session(),state({...idle(),call:initial}),pause(),state({...idle(),call:{id:'replacement'}})]);
  assert.equal(result.status,1);assert.equal(result.report.calls.filter(call=>call.method==='POST').length,1);
  assert.ok(result.report.calls.every(call=>call.route!=='/api/call/stop'));
 }
});

test('a pause timeout is an unknown result and is never resent',()=>{
 const result=run([session(),state({...idle(),active:{turnId:'work'}}),{...pause(),error:true}]);
 assert.equal(result.status,1);assert.equal(result.report.calls.filter(call=>call.route==='/api/tasks/pause').length,1);
 assert.match(result.stderr,/no unconfirmed action was resent/);assert.doesNotMatch(result.stderr,/PRIVATE RESPONSE/);
});

test('malformed state, human control and unconfirmed work fail before any mutation',()=>{
 const cases=[{}, {...idle(),queue:{}}, {...idle(),takeover:true}, {...idle(),active:'bad'}, {...idle(),call:{id:''}}, {...idle(),worker:{status:'offline'}}, {...idle(),computer:{status:'dant',pending:true}}, {...idle(),computer:{status:'dant',sessionId:'lease'}}, {...idle(),messages:[{role:'user',status:'paused',submission:'unknown'}]}, {...idle(),workTasks:[{status:'unknown'}]}, {...idle(),workTasks:[{continuation:{dispatch:{phase:'submitting'}}}]}, {...idle(),workTasks:[{continuation:{invalid:true}}]}];
 for(const snapshot of cases){
  const result=run([session(),state(snapshot)]);assert.equal(result.status,1,JSON.stringify(snapshot));
  assert.ok(result.report.calls.every(call=>call.method==='GET'));
 }
});

test('new activity or unresolved continuation after pause blocks replacement',()=>{
 for(const current of [{...idle(),active:{turnId:'new'}},{...idle(),queue:['new']},{...idle(),call:{id:'new'}},{...idle(),takeover:true},{...idle(),workTasks:[{status:'continuing'}]},{...idle(),workTasks:[{status:'paused',continuation:{dispatch:{phase:'acknowledged'}}}]}]){
  const result=run([session(),state(idle()),pause(),state(idle()),pause(),witness(),state(current)]);
  assert.equal(result.status,1,JSON.stringify(current));assert.equal(result.report.remaining,0);
 }
});

test('final state rejection aborts after confirmed pauses and the existing legacy witness',()=>{
 const result=run([session(),state(idle()),pause(),state(idle()),pause(),witness(),{...state(idle()),error:true}]);
 assert.equal(result.status,1);assert.equal(result.report.calls.at(-1).route,'/api/state');assert.equal(result.report.calls.filter(call=>call.route==='/api/connect').length,1);
 assert.match(result.stderr,/^DANT_UPDATE_FAILED:state-unavailable:final$/m);
 assert.match(result.stderr,/Saved task records were preserved/);
});

test('rollback idle validation preserves its legacy witness without task pause or call stop on newly started work',()=>{
 for(const current of [{...idle(),active:{turnId:'new'}},{...idle(),call:{id:'new-call'}},{...idle(),queue:['new']}]){
  const result=run([session(),state(idle()),witness(),state(current)],{mode:'idle'});
  assert.equal(result.status,79);assert.ok(result.report.calls.every(call=>call.method==='GET'||call.route==='/api/connect'));assert.match(result.stderr,/^DANT_UPDATE_DEFERRED:work-still-active:rollback$/m);
 }
});

test('rollback validates the current online idle executor without starting an offline executor',()=>{
 const ready=run([session(),state(idle()),witness(),state(idle())],{mode:'idle'});
 assert.equal(ready.status,0,ready.stderr);assert.equal(ready.report.remaining,0);
 const offline=run([session(),state({...idle(),worker:{status:'offline'}})],{mode:'idle'});
 assert.equal(offline.status,79);assert.ok(offline.report.calls.every(call=>call.method==='GET'));assert.match(offline.stderr,/^DANT_UPDATE_DEFERRED:executor-offline:rollback$/m);
});

test('idle automatic check accepts paused or completed work without changing saved records',()=>{
 const result=run([session(),state({...idle(),workTasks:[{id:'saved',status:'paused'},{id:'complete',status:'completed'}]})],{mode:'check'});
 assert.equal(result.status,0,result.stderr);assert.equal(result.report.calls.length,2);
});

test('passive checks defer saved runnable work between turns and only accept an explicitly ended user wait',()=>{
 for(const mode of ['check','final']){
  for(const record of ['running','queued','accepted','continuing','pausing','unknown'].map(status=>({status})).concat([{}, {executionEndedAt:0},{executionEndedAt:-1},{executionEndedAt:true},{executionEndedAt:'1'}].map(extra=>({status:'waiting_user',...extra})))){
   const result=run([session(),state({...idle(),workTasks:[record]})],{mode});assert.equal(result.status,79,JSON.stringify({mode,record}));assert.match(result.stderr,new RegExp('^DANT_UPDATE_DEFERRED:work-still-active:'+(mode==='idle'?'rollback':mode==='final'?'final':'initial')+'$','m'));assert.ok(result.report.calls.every(call=>call.method==='GET'));
  }
  const ended=run([session(),state({...idle(),workTasks:[{status:'waiting_user',executionEndedAt:1}]})],{mode});assert.equal(ended.status,0,ended.stderr);
 }
});

test('passive checks defer every unconfirmed executor status using GET only, including a post-pause offline race',()=>{
 for(const mode of ['check','final','idle'])for(const worker of [undefined,null,{}, {status:'offline'},{status:'connecting'},{status:'unknown'}]){
  const current={...idle(),worker},result=run([session(),state(current)],{mode});assert.equal(result.status,79);assert.match(result.stderr,/^DANT_WORK_ACTIVE$/m);assert.match(result.stderr,new RegExp('^DANT_UPDATE_DEFERRED:executor-offline:'+(mode==='idle'?'rollback':mode==='final'?'final':'initial')+'$','m'));assert.ok(result.report.calls.every(call=>call.method==='GET'));
 }
 const race=run([session(),state(idle()),pause(),state(idle()),pause(),witness(),state({...idle(),worker:{status:'offline'}})]);assert.equal(race.status,1);assert.match(race.stderr,/^DANT_UPDATE_FAILED:executor-offline:final$/m);assert.equal(race.report.calls.filter(call=>call.method==='POST').length,3);
});

test('fixed guard reasons identify the failed stage without exposing private responses or replaying requests',()=>{
 const cases=[
  [[{...session(),error:true}],'session-unavailable','initial'],
  [[step('/api/session',{})],'session-invalid','initial'],
  [[session(),state({})],'state-invalid','initial'],
  [[session(),state({...idle(),computer:{status:'human'}})],'control-busy','initial'],
  [[session(),state({...idle(),messages:[{status:'paused',submission:'unknown'}]})],'work-unconfirmed','initial'],
  [[session(),state({...idle(),call:{id:''}})],'call-owner-invalid','initial'],
  [[session(),state(idle()),{...pause(),error:true}],'pause-unconfirmed','pause'],
  [[session(),state(idle()),pause(),{...state(idle()),error:true}],'state-unavailable','post-pause'],
  [[session(),state({...idle(),call:{id:'old'}}),pause(),state({...idle(),call:{id:'other'}})],'call-owner-changed','post-pause'],
  [[session(),state({...idle(),call:{id:'old'}}),pause(),state({...idle(),call:{id:'old'}}),step('/api/call/stop',{stopped:false},{method:'POST',body:{callId:'old'}})],'call-stop-unconfirmed','call-stop'],
  [[session(),state(idle()),pause(),state(idle()),{...pause(),error:true}],'saved-pause-unconfirmed','saved-pause'],
  [[session(),state(idle()),pause(),state(idle()),pause(),{...witness(),error:true}],'idle-unconfirmed','final'],
  [[session(),state(idle()),pause(),state(idle()),pause(),witness(),state({...idle(),active:{turnId:'new'}})],'work-still-active','final']
 ];
 for(const [replies,reason,stage]of cases){const result=run(replies);assert.equal(result.status,1);assert.match(result.stderr,new RegExp('^DANT_UPDATE_FAILED:'+reason+':'+stage+'$','m'));assert.doesNotMatch(result.stderr,/PRIVATE|fixture-session|Traceback|TimeoutError/);assert.equal(result.report.remaining,0);assert.ok(result.report.calls.filter(call=>call.route==='/api/connect').length<=1);}
});

const bash=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Git/bin/bash.exe'):'bash';
const shellPath=value=>process.platform==='win32'?value.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase()):value;

test('the same deployed manifest returns current without pausing work or restarting services, including manual reconnect',t=>{
 const testRoot=path.resolve('.cache/tests');fs.mkdirSync(testRoot,{recursive:true});
 const root=fs.mkdtempSync(path.join(testRoot,'worker-current-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),stage=path.join(home,'dant/releases/source.fixture');fs.mkdirSync(stage,{recursive:true});
 fs.writeFileSync(path.join(stage,'deploy-manifest.json'),'same-source');fs.writeFileSync(path.join(home,'dant/deployed-source.json'),'same-source');
 const current=script.slice(script.indexOf('if [ -f "$HOME/dant/deployed-source.json" ]'),script.indexOf('if [ -e "$HOME/dant/app" ]'));
 const harness=String.raw`
set -euo pipefail
export HOME="$1"
source_dir="$2"
update_running_work="$3"
cd "$source_dir"
prepare_transcription() { printf 'transcription\n' >> "$HOME/events"; }
node() { printf 'node:%s\n' "$*" >> "$HOME/events"; }
systemctl() { printf 'systemctl:%s\n' "$*" >> "$HOME/events"; [[ "$*" == '--user is-active --quiet dant-worker.service dant-guest-local.service' ]]; }
check_idle_worker() { printf 'pause-check\n' >> "$HOME/events"; exit 9; }
`;
 const runFile=path.join(root,'current-fixture.sh');fs.writeFileSync(runFile,harness+'\n'+current);
 for(const manual of ['false','true']){
  fs.writeFileSync(path.join(home,'events'),'');
  const result=spawnSync(bash,['--noprofile','--norc',shellPath(runFile),shellPath(home),shellPath(stage),manual],{encoding:'utf8',shell:false,timeout:10000});
  if(result.error)throw result.error;
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/^DANT_UPDATE_CURRENT$/m);
  const events=fs.readFileSync(path.join(home,'events'),'utf8');assert.match(events,/is-active/);assert.doesNotMatch(events,/pause-check|restart|stop/);
 }
});

function deployment(t,{failure='',rollbackBusy=false,initialState='active',becomeActive=false,rollbackFailure=''}={}){
 const testRoot=path.resolve('.cache/tests');fs.mkdirSync(testRoot,{recursive:true});
 const root=fs.mkdtempSync(path.join(testRoot,'worker-install-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),stage=path.join(home,'dant/releases/source.fixture'),old=path.join(home,'dant/releases/source.old');
 for(const name of [stage,old,path.join(stage,'vm'),path.join(home,'dant/vm'),path.join(home,'dant/data'),path.join(home,'.config/systemd/user')])fs.mkdirSync(name,{recursive:true});
 for(const name of ['guest.py','desktop.py','control.py','voice_message.py','transcribe_audio.py','desktop_mcp.py']){
  fs.writeFileSync(path.join(stage,'vm',name),'new '+name);fs.writeFileSync(path.join(home,'dant/vm',name),'old '+name);
 }
 for(const name of ['dant-guest-local.service','dant-worker.service'])fs.writeFileSync(path.join(home,'.config/systemd/user',name),'old '+name);
 fs.writeFileSync(path.join(stage,'deploy-manifest.json'),'new-source');fs.writeFileSync(path.join(home,'dant/deployed-source.json'),'old-source');
 fs.writeFileSync(path.join(home,'dant/data/state.json'),'{"tasks":[{"status":"paused"}],"messages":["preserved"]}');
 // Model symlink metadata with plain files so the same transaction tests work
 // on Windows without changing the host's symlink privilege or VM services.
 fs.writeFileSync(path.join(home,'dant/app'),shellPath(old));
 const harness=String.raw`
set -euo pipefail
export HOME="$1"
source_dir="$2"
failure="$3"
rollback_busy="$4"
printf '%s' "$5" > "$HOME/worker-active"
become_active="$6"
rollback_failure="$7"
ln() {
  if [[ "$rollback_failure" == link && "$3" == */app.restore ]]; then return 1; fi
  printf '%s' "$2" > "$3"
}
cp() {
  if [[ "$rollback_failure" == helper && "$2" == */rollback.*/vm/desktop.py || "$rollback_failure" == service && "$2" == */rollback.*/services/dant-worker.service ]]; then return 1; fi
  command cp "$@"
}
readlink() { cat "$1"; }
[() { if [[ "$1" == '-L' && "$2" == "$HOME/dant/app" ]]; then builtin [ -f "$2" ]; else builtin [ "$@"; fi; }
check_idle_worker() {
  local mode=check
  if (( $# )); then mode="$1"; fi
  if [[ "$become_active" == true && "$mode" == final ]]; then printf active > "$HOME/worker-active"; fi
  worker_checked_state=$(worker_service_state) || return 1
  printf 'check:%s\n' "$mode" >> "$HOME/events"
  if [[ "$failure" == 'precheck' && "$mode" == 'final' ]]; then return 1; fi
  if [[ "$rollback_busy" == 'true' && "$mode" == 'idle' ]]; then return 1; fi
}
systemctl() {
  printf 'systemctl:%s\n' "$*" >> "$HOME/events"
  if [[ "$2" == 'show' ]]; then cat "$HOME/worker-active"; return 0; fi
  if [[ "$2" == 'stop' && "$3" == 'dant-worker.service' ]]; then
    if [[ "$failure" == 'stop' ]]; then return 1; fi
    printf inactive > "$HOME/worker-active"
  fi
  if [[ "$2" == 'restart' && "$3" == 'dant-worker.service' ]]; then
    if [[ "$failure" == 'restart' && "$(cat "$HOME/dant/app")" == "$source_dir" ]]; then return 1; fi
    printf active > "$HOME/worker-active"
  fi
  if [[ "$2" == 'start' && "$3" == 'dant-worker.service' ]]; then printf active > "$HOME/worker-active"; fi
}
loginctl() { if [[ "$1" == 'show-user' ]]; then echo yes; fi; }
python3() { [[ "$failure" != 'readiness' ]]; }
sleep() { :; }
`;
 const tail=script.slice(script.indexOf('# Preserve the old executable files/configuration'));
 const serviceState=script.slice(script.indexOf('worker_service_state() {'),script.indexOf('check_idle_worker() {'));
 const runFile=path.join(root,'run-fixture.sh');fs.writeFileSync(runFile,harness+'\n'+serviceState+'\n'+tail);
 const result=spawnSync(bash,['--noprofile','--norc',shellPath(runFile),shellPath(home),shellPath(stage),failure,String(rollbackBusy),initialState,String(becomeActive),rollbackFailure],{encoding:'utf8',shell:false,timeout:15000});
 if(result.error)throw result.error;
 return {...result,home,stage,old,events:fs.existsSync(path.join(home,'events'))?fs.readFileSync(path.join(home,'events'),'utf8'):''};
}

test('installation switches a confirmed idle worker, preserves paused data and commits its manifest only after readiness',t=>{
 const result=deployment(t);assert.equal(result.status,0,result.stderr);
 assert.equal(fs.readFileSync(path.join(result.home,'dant/app'),'utf8'),shellPath(result.stage));
 assert.equal(fs.readFileSync(path.join(result.home,'dant/deployed-source.json'),'utf8'),'new-source');
 assert.equal(JSON.parse(fs.readFileSync(path.join(result.home,'dant/data/state.json'),'utf8')).tasks[0].status,'paused');
 assert.ok(result.events.indexOf('check:final')<result.events.indexOf('systemctl:--user stop dant-worker.service'));
});

test('a failed new worker restores the previous app, helpers and services without rolling back authoritative data',async t=>{
 for(const failure of ['restart','readiness'])await t.test(failure,t=>{
  const result=deployment(t,{failure});assert.notEqual(result.status,0);
  assert.equal(fs.readFileSync(path.join(result.home,'dant/app'),'utf8'),shellPath(result.old),result.stderr+'\n'+result.events);
  assert.equal(fs.readFileSync(path.join(result.home,'dant/vm/desktop.py'),'utf8'),'old desktop.py');
  assert.equal(fs.readFileSync(path.join(result.home,'.config/systemd/user/dant-worker.service'),'utf8'),'old dant-worker.service');
  assert.equal(fs.readFileSync(path.join(result.home,'dant/deployed-source.json'),'utf8'),'old-source');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.home,'dant/data/state.json'),'utf8')).messages[0],'preserved');
  assert.match(result.stderr,/previous service files were restored/);
 });
});

test('failure to confirm idle state or service shutdown never switches the existing app',async t=>{
 for(const failure of ['precheck','stop'])await t.test(failure,t=>{
  const result=deployment(t,{failure});assert.notEqual(result.status,0);
  assert.equal(fs.readFileSync(path.join(result.home,'dant/app'),'utf8'),shellPath(result.old));
  assert.equal(fs.readFileSync(path.join(result.home,'dant/vm/desktop.py'),'utf8'),'old desktop.py');
  assert.equal(fs.readFileSync(path.join(result.home,'dant/deployed-source.json'),'utf8'),'old-source');
  if(failure==='precheck')assert.doesNotMatch(result.events,/stop dant-worker/);
 });
});

test('a new worker with unconfirmed activity is left in place instead of being forcibly stopped for rollback',t=>{
 const result=deployment(t,{failure:'readiness',rollbackBusy:true});assert.notEqual(result.status,0);
 assert.equal(fs.readFileSync(path.join(result.home,'dant/app'),'utf8'),shellPath(result.stage),result.stderr+'\n'+result.events);
 assert.equal(result.events.split('stop dant-worker.service').length-1,1);
 assert.match(result.stderr,/no executor was forcibly stopped/);
 assert.equal(fs.readFileSync(path.join(result.home,'dant/deployed-source.json'),'utf8'),'old-source');
});

test('an old worker that became active during preparation is stopped after the fresh idle check',t=>{
 const result=deployment(t,{initialState:'inactive',becomeActive:true});assert.equal(result.status,0,result.stderr);
 assert.match(result.events,/check:final[\s\S]*systemctl:--user stop dant-worker.service/);
});

test('transitional or unknown systemd state never permits a live app replacement',async t=>{
 for(const initialState of ['activating','deactivating','reloading','unknown'])await t.test(initialState,t=>{
  const result=deployment(t,{initialState});assert.notEqual(result.status,0);
  assert.equal(fs.readFileSync(path.join(result.home,'dant/app'),'utf8'),shellPath(result.old));
  assert.doesNotMatch(result.events,/stop dant-worker/);assert.match(result.stderr,/changing state/);
 });
});

test('incomplete rollback keeps the worker stopped and never reports a completed restoration',async t=>{
 for(const rollbackFailure of ['link','helper','service'])await t.test(rollbackFailure,t=>{
  const result=deployment(t,{failure:'restart',rollbackFailure});assert.notEqual(result.status,0);
  assert.match(result.stderr,/could not be fully restored/);assert.doesNotMatch(result.stderr,/previous service files were restored;/);
  assert.doesNotMatch(result.events,/systemctl:--user start dant-worker.service/);
  assert.equal(fs.readFileSync(path.join(result.home,'worker-active'),'utf8'),'inactive');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.home,'dant/data/state.json'),'utf8')).messages[0],'preserved');
 });
});
