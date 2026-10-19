import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter, once} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {VmBridge,vmSourceFingerprint} from '../src/vm-bridge.mjs';

const testRoot = path.resolve('.cache/tests');
fs.mkdirSync(testRoot, {recursive:true});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
class Child extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
  }
  kill(signal) { this.kills.push(signal); queueMicrotask(() => this.emit('close', null)); return true; }
}
class Socket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.terminated = 0; }
  terminate() { this.terminated++; }
}
function fixture(t, overrides={}) {
  const root = fs.mkdtempSync(path.join(testRoot, 'bridge-'));
  const dataDir = path.join(root, 'data'), projectRoot = path.join(root, 'project');
  fs.mkdirSync(dataDir); fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(dataDir, 'test-key'), 'TEST KEY ONLY; never a credential');
  fs.writeFileSync(path.join(dataDir, 'vm.json'), JSON.stringify({host:'192.0.2.15', user:'dant', port:2222, keyPath:'test-key', knownHosts:'known_hosts'}));
  const calls = [], children = [], requests = [], sockets = [];
  const bridge = new VmBridge({
    dataDir, projectRoot,
    spawnProcess(command, args, options) { const child = new Child(); calls.push({command, args, options}); children.push(child); return child; },
    fetchImpl:async (url, options) => { requests.push({url, options}); return Response.json(url.endsWith('/api/session') ? {token:'fixture token'} : {messages:[{id:'from-vm'}]}); },
    WebSocketImpl:class extends Socket { constructor(url) { super(url); sockets.push(this); } },
    ...overrides,
    fetchImpl:async(url,options)=>url.endsWith('/api/version')?(overrides.versionImpl?overrides.versionImpl(url,options):Response.json({version:'0.4.7-beta.6'})):(overrides.fetchImpl?overrides.fetchImpl(url,options):(requests.push({url,options}),Response.json(url.endsWith('/api/session')?{token:'fixture token'}:{messages:[{id:'from-vm'}]})))
  });
  t.after(() => { bridge.close(); fs.rmSync(root, {recursive:true, force:true}); });
  return {bridge, root, dataDir, projectRoot, calls, children, requests, sockets};
}
function resources(directory) {
  for (const name of ['src/server.mjs', 'dist/index.html', 'LICENSE', 'package.json', 'package-lock.json', 'vm/install-worker.sh', 'vm/install-speech.sh', 'vm/install-transcription.sh', 'vm/transcription-requirements.txt', 'vm/migrate-state.mjs', 'vm/start-codex.sh', 'vm/guest.py', 'vm/desktop.py', 'vm/control.py', 'vm/voice_message.py', 'vm/transcribe_audio.py', 'vm/desktop_mcp.py']) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), {recursive:true});
    fs.writeFileSync(path.join(directory, name), `fixture ${name}`);
  }
}

test('bridge connects through an SSH tunnel and forwards VM state and events', async t => {
  const {bridge, calls, requests, sockets, children} = fixture(t);
  const events = [], states = [];
  bridge.on('event', event => events.push(event)); bridge.on('state', state => states.push(state));
  assert.deepEqual(await bridge.connect({deploy:false}), {messages:[{id:'from-vm'}]});
  assert.equal(bridge.status, 'online'); assert.equal(calls.length, 1);
  const call = calls[0]; assert.equal(call.command, 'ssh'); assert.equal(call.options.shell, false);
  assert.ok(call.args.includes(`127.0.0.1:${bridge.port}:127.0.0.1:4317`));
  assert.ok(call.args.includes('BatchMode=yes')); assert.ok(call.args.includes('ExitOnForwardFailure=yes'));
  assert.equal(call.args.at(-1), 'dant@192.0.2.15');
  assert.equal(requests[1].options.headers['X-Dant-Token'], 'fixture token');
  assert.match(sockets[0].url, /token=fixture%20token$/);
  children[0].stderr.write('PRIVATE TEST DIAGNOSTIC');
  sockets[0].emit('message', Buffer.from('{bad json'));
  sockets[0].emit('error', Error('ignored socket diagnostic'));
  sockets[0].emit('message', Buffer.from(JSON.stringify({type:'state', data:{messages:[{id:'updated'}]}})));
  sockets[0].emit('message', Buffer.from(JSON.stringify({type:'notice', data:{message:'VM notice'}})));
  assert.equal(states.at(-1).messages[0].id, 'updated');
  assert.deepEqual(events, [{type:'notice', data:{message:'VM notice'}}]);
  bridge.disconnect();
  sockets[0].emit('message', JSON.stringify({type:'state', data:{messages:[]}})); sockets[0].emit('close');
  assert.equal(bridge.status, 'offline'); assert.equal(bridge.cached.messages[0].id, 'updated');
  assert.equal(sockets[0].terminated, 1); assert.equal(children[0].kills.length, 1);
  bridge.close(); await assert.rejects(bridge.connect(), /closed/);
});

test('concurrent connects share one preparation and one SSH process', async t => {
  const {bridge, calls} = fixture(t), gate = deferred(); let preparations = 0;
  bridge.prepare = async () => { preparations++; await gate.promise; };
  const first = bridge.connect(), second = bridge.connect();
  assert.equal(preparations, 1); gate.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.strictEqual(one, two); assert.equal(calls.length, 1); assert.equal(bridge.connecting, null);
});

test('manual reconnect waits for an automatic connection and then performs its own authorized deployment once', async t => {
 const {bridge,calls}=fixture(t),gate=deferred(),options=[];
 bridge.prepare=async (_vm,value)=>{options.push(value);if(options.length===1)await gate.promise;};
 const automatic=bridge.connect(),manual=bridge.connect({updateRunningWork:true}),secondClick=bridge.connect({updateRunningWork:true});
 assert.deepEqual(options,[{updateRunningWork:false}]);gate.resolve();
 await Promise.all([automatic,manual,secondClick]);
 assert.deepEqual(options,[{updateRunningWork:false},{updateRunningWork:true}]);assert.equal(calls.length,2);assert.equal(bridge.manualConnectionPending,null);
});

test('disconnect cancels a queued explicit update instead of deploying after the user leaves', async t => {
 const {bridge,calls}=fixture(t),gate=deferred(),options=[];
 bridge.prepare=async (_vm,value)=>{options.push(value);await gate.promise;};
 const automatic=bridge.connect(),manual=bridge.connect({updateRunningWork:true});bridge.disconnect();gate.resolve();
 const results=await Promise.allSettled([automatic,manual]);
 assert.ok(results.every(result=>result.status==='rejected'&&/cancelled/.test(result.reason.message)));
 assert.deepEqual(options,[{updateRunningWork:false}]);assert.equal(calls.length,0);
});

test('preparation failure preserves cached history and never opens an SSH tunnel', async t => {
  const {bridge, calls} = fixture(t); bridge.cached = {messages:[{id:'retained'}]};
  bridge.prepare = async () => { throw Error('VM package is incomplete'); };
  await assert.rejects(bridge.connect(), /package is incomplete/);
  assert.equal(bridge.status, 'offline'); assert.match(bridge.error, /incomplete/);
  assert.equal(calls.length, 0); assert.equal(bridge.cached.messages[0].id, 'retained');
});

test('a busy VM defers deployment but still connects to its existing service', async t => {
  const {bridge, calls} = fixture(t), events = [];
  bridge.prepare = async () => { throw Object.assign(Error('DANT_WORK_ACTIVE'), {updateDeferred:true}); };
  bridge.on('event', event => events.push(event)); await bridge.connect();
  assert.equal(bridge.status, 'online'); assert.equal(calls.length, 1);
  assert.equal(events[0].type, 'notice'); assert.match(events[0].data.message, /deferred/);
});

test('only explicit reconnect carries permission to pause running work into preparation', async t => {
  const {bridge} = fixture(t), options = [];
  bridge.prepare = async (_vm, value) => { options.push(value); };
  await bridge.connect(); await bridge.connect({updateRunningWork:'true'}); await bridge.connect({updateRunningWork:true});
  assert.deepEqual(options, [{updateRunningWork:false}, {updateRunningWork:false}, {updateRunningWork:true}]);
});

test('explicit reconnect reports a refused update instead of silently connecting to an old worker', async t => {
  const {bridge,calls} = fixture(t), events = [];
  bridge.prepare = async () => { throw Object.assign(Error('DANT_WORK_ACTIVE'), {updateDeferred:true}); };
  bridge.on('event', event => events.push(event));
  await assert.rejects(bridge.connect({updateRunningWork:true}), /DANT_WORK_ACTIVE/);
  assert.equal(bridge.status,'offline'); assert.equal(calls.length,0); assert.deepEqual(events,[]);
});

test('disconnect during preparation cancels the pending connection without starting SSH', async t => {
  const {bridge, calls} = fixture(t), gate = deferred(); bridge.prepare = () => gate.promise;
  const pending = bridge.connect(); bridge.disconnect(); gate.resolve();
  await assert.rejects(pending, /cancelled/); assert.equal(calls.length, 0); assert.equal(bridge.status, 'offline');
});

test('a late session response cannot revive a cancelled or failed tunnel', async t => {
  for (const reason of ['disconnect', 'spawn-error', 'ssh-close']) {
    await t.test(reason, async t => {
      const session = deferred(), requested = deferred();
      const {bridge, children, sockets} = fixture(t, {fetchImpl:async url => {
        if (url.endsWith('/api/session')) { requested.resolve(); return session.promise; }
        return Response.json({messages:[]});
      }});
      const pending = bridge.connect({deploy:false}); await requested.promise;
      if (reason === 'disconnect') bridge.disconnect();
      else children[0].emit(reason === 'spawn-error' ? 'error' : 'close', reason === 'spawn-error' ? Error('fixture secret stderr') : 255);
      session.resolve(Response.json({token:'late token'}));
      await assert.rejects(pending, reason === 'spawn-error' ? /Could not start the SSH/ : reason === 'ssh-close' ? /connection was lost/ : /cancelled/);
      assert.equal(bridge.status, 'offline'); assert.equal(bridge.token, null); assert.equal(sockets.length, 0);
      assert.doesNotMatch(bridge.error || '', /fixture secret/);
    });
  }
});

test('disconnect while initial state is loading cannot open an event socket afterwards', async t => {
  const state = deferred(), requested = deferred();
  const {bridge, sockets} = fixture(t, {fetchImpl:async url => {
    if (url.endsWith('/api/session')) return Response.json({token:'test'});
    requested.resolve(); return state.promise;
  }});
  const pending = bridge.connect({deploy:false}); await requested.promise; bridge.disconnect();
  state.resolve(Response.json({messages:[{id:'last snapshot'}]}));
  await assert.rejects(pending, /cancelled/); assert.equal(bridge.status, 'offline'); assert.equal(sockets.length, 0);
});

test('event disconnection reconnects after a delay without redeploying or discarding history', async t => {
  const {bridge, calls, sockets} = fixture(t); let preparations = 0;
  bridge.prepare = async () => { preparations++; }; await bridge.connect();
  t.mock.timers.enable({apis:['setTimeout']});
  sockets[0].emit('close'); assert.equal(bridge.status, 'offline'); assert.equal(bridge.cached.messages[0].id, 'from-vm');
  assert.match(bridge.error, /event connection was lost/);
  const online = new Promise(resolve => bridge.on('change', () => { if (bridge.status === 'online') resolve(); }));
  t.mock.timers.tick(4999); assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await online;await bridge.connecting;
  assert.equal(calls.length, 2); assert.equal(preparations, 1); assert.equal(sockets.length, 2);
  sockets[0].emit('close'); assert.equal(bridge.status, 'online');
});

test('state refresh shares requests, retains a two second cache and reports non-success responses', async t => {
  const {bridge} = fixture(t); bridge.status = 'online'; bridge.token = 'token'; bridge.port = 1234;
  const gate = deferred(); let requests = 0;
  bridge.fetchImpl = async () => { requests++; return gate.promise; };
  const first = bridge.refresh(), second = bridge.refresh(); assert.equal(requests, 1);
  gate.resolve(Response.json({messages:[{id:'cached'}]})); assert.strictEqual(await first, await second);
  await bridge.refresh(); assert.equal(requests, 1);
  bridge.fetchImpl = async () => { requests++; return Response.json({messages:[]}); };
  bridge.cachedAt -= 2001; await bridge.refresh(); assert.equal(requests, 2);
  bridge.fetchImpl = async () => new Response('', {status:503});
  await assert.rejects(bridge.refresh(true), /VM state unavailable \(503\)/); assert.equal(bridge.refreshing, null);
});

test('fresh VM state clears an old connection error without reconnecting or replacing its conversation', async t => {
 const {bridge,sockets,calls}=fixture(t);await bridge.connect({deploy:false});const before=bridge.cached;bridge.error='An earlier state request failed';
 bridge.fetchImpl=async()=>new Response(null,{status:503});await assert.rejects(bridge.refresh(true),/503/);assert.equal(bridge.error,'An earlier state request failed');assert.equal(bridge.cached,before);
 bridge.fetchImpl=async()=>Response.json({conversationId:'original',messages:[{id:'preserved'}]});const state=await bridge.refresh(true);assert.equal(bridge.error,null);assert.equal(state.conversationId,'original');assert.equal(bridge.status,'online');assert.equal(calls.length,1);
 bridge.error='A later request timed out';sockets[0].emit('message',Buffer.from(JSON.stringify({type:'notice',data:{message:'Unrelated notice'}})));assert.equal(bridge.error,'A later request timed out');sockets[0].emit('message',Buffer.from(JSON.stringify({type:'state',data:state})));assert.equal(bridge.error,null);assert.deepEqual(bridge.cached.messages,[{id:'preserved'}]);assert.equal(calls.length,1);
});

test('late refresh responses cannot overwrite or publish state after a new connection succeeds', async t => {
  for (const phase of ['response', 'json']) {
    await t.test(phase, async t => {
      const oldResponse = deferred(), oldJson = deferred(), oldStarted = deferred();
      const oldState = {messages:[{id:'old-VM'}]}, newState = {messages:[{id:'new-VM'}]}, tokens = [], states = [];
      let sessions = 0, stateRequests = 0, oldDecodes = 0;
      const old = {ok:true, json:async () => { oldDecodes++; oldStarted.resolve(); return oldJson.promise; }};
      const {bridge, sockets} = fixture(t, {fetchImpl:async (url, options) => {
        if (url.endsWith('/api/session')) return Response.json({token:`session-${++sessions}`});
        tokens.push(options.headers['X-Dant-Token']);
        if (++stateRequests === 1) {
          if (phase === 'response') { oldStarted.resolve(); return oldResponse.promise; }
          return old;
        }
        return Response.json(newState);
      }});
      bridge.on('state', state => states.push(state));
      const previous = bridge.connect({deploy:false}), rejected = assert.rejects(previous, /cancelled/);
      await oldStarted.promise; bridge.disconnect();
      const current = bridge.connect({deploy:false});
      assert.deepEqual(await current, newState); assert.equal(sessions, 2); assert.equal(stateRequests, 2);
      assert.deepEqual(tokens, ['session-1', 'session-2']);
      oldJson.resolve(oldState); oldResponse.resolve(old); await rejected;
      assert.deepEqual(bridge.cached, newState); assert.deepEqual(states, [newState]); assert.equal(bridge.status, 'online');
      assert.equal(bridge.token, 'session-2'); assert.equal(sockets.length, 1); assert.match(sockets[0].url, /token=session-2$/);
      assert.equal(oldDecodes, phase === 'json' ? 1 : 0);
    });
  }
});

test('a cancelled refresh cannot detach the new in-flight refresh or emit after close', async t => {
  const old = deferred(), current = deferred(), started = deferred(); const states = []; let requests = 0;
  const {bridge} = fixture(t, {fetchImpl:async () => { if (++requests === 1) return {ok:true, json:() => { started.resolve(); return old.promise; }}; return current.promise; }});
  bridge.on('state', state => states.push(state)); bridge.status = 'online'; bridge.token = 'old-token'; bridge.port = 1234;
  const previous = bridge.refresh(true), rejected = assert.rejects(previous, /cancelled/); await started.promise;
  bridge.disconnect(); bridge.status = 'online'; bridge.token = 'new-token';
  const pending = bridge.refresh(true), shared = bridge.refreshing; old.resolve({messages:[{id:'old'}]}); await rejected;
  assert.strictEqual(bridge.refreshing, shared); assert.equal(requests, 2); assert.deepEqual(states, []);
  bridge.close(); current.resolve(Response.json({messages:[{id:'closed'}]})); await assert.rejects(pending, /cancelled/);
  assert.equal(bridge.cached, undefined); assert.deepEqual(states, []);
});

test('API requests validate destinations and never replay mutations after an unknown outcome', async t => {
  const {bridge} = fixture(t); await assert.rejects(bridge.request('/api/state'), error => error.status === 503);
  bridge.status = 'online'; bridge.token = 'private token'; bridge.port = 1234;
  for (const route of ['https://example.com', '//example.com/api/state', '/events', '/api/http://evil']) await assert.rejects(bridge.request(route), /Invalid VM API/);
  let requests = 0; bridge.fetchImpl = async () => { requests++; throw Error('private token upstream diagnostic'); };
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    await assert.rejects(bridge.request('/api/messages', {method}), error => error.status === 502 && error.unknownOutcome === (method !== 'GET') && !error.message.includes('private token'));
  }
  assert.equal(requests, 4);
  const controller = new AbortController(); let forwarded;
  bridge.fetchImpl = async (_url, options) => { forwarded = options; return Response.json({ok:true}); };
  await bridge.request('/api/input', {method:'POST', headers:{'Content-Type':'application/json', 'X-Dant-Token':'untrusted'}, body:'{}', signal:controller.signal});
  assert.equal(forwarded.headers['X-Dant-Token'], 'private token'); assert.equal(forwarded.body, '{}'); assert.strictEqual(forwarded.signal, controller.signal);
});

test('prepare merges concurrent deployment and resets its latch after failure', async t => {
  const {bridge} = fixture(t), gate = deferred(); let deployments = 0;
  bridge.deploy = async () => { deployments++; await gate.promise; throw Error('fixture install rejected'); };
  const one = bridge.prepare(), two = bridge.prepare(); gate.resolve();
  const results = await Promise.allSettled([one, two]); assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(deployments, 1); assert.equal(bridge.preparing, null);
  bridge.deploy = async () => { deployments++; }; await bridge.prepare(); assert.equal(deployments, 2);
});

test('prepare forwards an exact explicit update option to deployment', async t => {
  const {bridge}=fixture(t),options=[];
  bridge.deploy=async (_vm,value)=>{options.push(value);};
  await bridge.prepare(); await bridge.prepare(bridge.binding(),{updateRunningWork:'true'}); await bridge.prepare(bridge.binding(),{updateRunningWork:true});
  assert.deepEqual(options,[{updateRunningWork:false},{updateRunningWork:false},{updateRunningWork:true}]);
});

test('an explicit preparation waits for automatic preparation and is not merged into its defer result', async t => {
 const {bridge}=fixture(t),gate=deferred(),options=[];
 bridge.deploy=async (_vm,value)=>{options.push(value);if(options.length===1){await gate.promise;throw Object.assign(Error('busy'),{updateDeferred:true});}};
 const automatic=bridge.prepare(),manual=bridge.prepare(bridge.binding(),{updateRunningWork:true}),repeat=bridge.prepare(bridge.binding(),{updateRunningWork:true});
 gate.resolve();const results=await Promise.allSettled([automatic,manual,repeat]);
 assert.equal(results[0].status,'rejected');assert.ok(results.slice(1).every(result=>result.status==='fulfilled'));
 assert.deepEqual(options,[{updateRunningWork:false},{updateRunningWork:true}]);assert.equal(bridge.manualPreparationPending,null);
});

test('queued explicit preparation is cancelled on close, disconnect or VM profile changes', async t => {
 for(const action of ['close','disconnect','binding'])await t.test(action,async t=>{
  const {bridge}=fixture(t),gate=deferred();let deployments=0;
  bridge.deploy=async()=>{deployments++;await gate.promise;};
  const automatic=bridge.prepare(),manual=bridge.prepare(bridge.binding(),{updateRunningWork:true});
  if(action==='binding')bridge.binding=()=>({host:'192.0.2.99',user:'dant'});else bridge[action]();
  gate.resolve();await automatic;await assert.rejects(manual,/connection changed/);assert.equal(deployments,1);
 });
});

test('preparation subprocess streams bounded output and stdin without a shell', async t => {
  const {bridge, calls, children, dataDir} = fixture(t), input = path.join(dataDir, 'archive');
  fs.writeFileSync(input, 'archive bytes'); const pending = bridge.run('fixture-tar', ['--safe'], {input});
  const child = children[0]; let received = ''; child.stdin.on('data', chunk => { received += chunk; });
  await once(child.stdin, 'finish'); child.stdout.write('normal output'); child.stderr.write(' warning'); child.emit('close', 0);
  assert.equal(await pending, 'normal output warning'); assert.equal(received, 'archive bytes');
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.cwd, bridge.projectRoot);
  assert.equal(bridge.preparationChildren.size, 0);
  const large = bridge.run('fixture-tar', []); children[1].stdout.write('x'.repeat(7000)); children[1].emit('close', 0); assert.equal((await large).length, 6000);
});

test('preparation reports spawn, active-work, missing-input, timeout and close failures', async t => {
  const {bridge, children, dataDir} = fixture(t);
  let pending = bridge.run('not-installed', []); children.at(-1).emit('error', Error('raw sensitive diagnostic'));
  await assert.rejects(pending, error => error.message === 'Could not start VM preparation.');
  pending = bridge.run('fixture-ssh', []); children.at(-1).stderr.write('DANT_WORK_ACTIVE'); children.at(-1).emit('close', 75);
  await assert.rejects(pending, error => error.updateDeferred === true && /75/.test(error.message));
  pending = bridge.run('fixture-ssh', [], {input:path.join(dataDir, 'does-not-exist')}); await assert.rejects(pending, {code:'ENOENT'}); assert.equal(children.at(-1).kills.length, 1);
  pending = bridge.run('fixture-ssh', [], {timeoutMs:5}); await assert.rejects(pending, /timed out.*preserved/); assert.equal(children.at(-1).kills.length, 1);
  pending = bridge.run('fixture-ssh', []); children.at(-1).stdin.emit('error', Error('closed stdin')); bridge.close(); await assert.rejects(pending, /VM preparation failed/);
  assert.equal(bridge.preparationChildren.size, 0);
});

function archiveRecorder(bridge, onInstall=()=>{}) {
  const calls = [], migrations = [], manifests = [];
  let probes=0;bridge.deployedSource=async()=>++probes%2?{sha256:null,active:true}:{sha256:bridge.desiredSource,active:true};
  bridge.run = async (command, args, options={}) => {
    calls.push({command, args, options});
    if (args[0] === '-cf') fs.writeFileSync(args[1], 'source archive fixture');
    if (args.at(-1) === 'deploy-manifest.json') manifests.push(JSON.parse(fs.readFileSync(path.join(args[3], 'deploy-manifest.json'))));
    if (args.at(-1) === 'migration') {
      const directory = path.join(args[3], 'migration');
      migrations.push({state:JSON.parse(fs.readFileSync(path.join(directory, 'state.json'))), manifest:JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))), files:fs.existsSync(path.join(directory, 'files')) ? fs.readdirSync(path.join(directory, 'files')) : []});
    }
    if (command === 'ssh') { assert.ok(fs.existsSync(options.input)); await onInstall(); }
    return '';
  };
  return {calls, migrations, manifests};
}

test('the remote installation receives a fixed update flag only for an explicitly authorized reconnect', async t => {
  const {bridge,projectRoot}=fixture(t);resources(projectRoot);const {calls}=archiveRecorder(bridge);
  await bridge.deploy(bridge.binding()); await bridge.deploy(bridge.binding(),{updateRunningWork:'--anything'}); await bridge.deploy(bridge.binding(),{updateRunningWork:true});
  const commands=calls.filter(call=>call.command==='ssh').map(call=>call.args.at(-1));
  assert.ok(commands.slice(0,2).every(command=>command.endsWith('"$stage"')));
  assert.ok(commands[2].endsWith('"$stage" --update-running-work'));
});
test('deployment uses a source allowlist, preserves host data and migrates only once after confirmation', async t => {
  const {bridge, dataDir, projectRoot} = fixture(t); resources(projectRoot);
  const original = JSON.stringify({messages:[{id:'history', text:'retain this'}], settings:{vm:{host:'old', keyPath:'private path'}, language:'en'}});
  fs.writeFileSync(path.join(dataDir, 'state.json'), original); fs.mkdirSync(path.join(dataDir, 'files')); fs.writeFileSync(path.join(dataDir, 'files', 'result.txt'), 'keep this attachment');
  // These are deliberate isolated sentinels, never real host credentials or runtime files.
  for (const name of ['data/private-key', '.dant-codex/credential-sentinel', 'node_modules/excluded', 'runtime/node.exe']) { fs.mkdirSync(path.dirname(path.join(projectRoot, name)), {recursive:true}); fs.writeFileSync(path.join(projectRoot, name), 'must not enter source archive'); }
  const recorded = archiveRecorder(bridge); await bridge.deploy(bridge.binding());
  const sourceCall = recorded.calls.find(call => call.args[0] === '-cf');
  assert.ok(sourceCall.args.includes('src')); assert.ok(sourceCall.args.includes('dist')); assert.ok(sourceCall.args.includes('vm/desktop_mcp.py')); assert.ok(sourceCall.args.includes('LICENSE'));
  assert.ok(sourceCall.args.slice(4).every(name => !['data', '.dant-codex', 'node_modules', 'runtime'].some(excluded => name.startsWith(excluded))));
  assert.equal(recorded.migrations.length, 1); assert.equal(recorded.migrations[0].state.messages[0].text, 'retain this');
  assert.deepEqual(recorded.migrations[0].state.settings.vm, {host:'', user:'dant', port:22, keyPath:'', knownHosts:''});
  assert.equal(recorded.migrations[0].state.settings.language, 'en'); assert.deepEqual(recorded.migrations[0].files, ['result.txt']);
  const digest = createHash('sha256').update(original).digest('hex');
  assert.equal(recorded.migrations[0].manifest.id, digest); assert.equal(recorded.migrations[0].manifest.messages, 1);
  assert.equal(recorded.manifests[0].schemaVersion,2);assert.equal(recorded.manifests[0].sha256,vmSourceFingerprint(projectRoot));
  const backups = fs.readdirSync(path.join(dataDir, 'migration-backups')); assert.equal(backups.length, 1);
  const backup = path.join(dataDir, 'migration-backups', backups[0]); assert.equal(fs.readFileSync(path.join(backup, 'state.json'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(backup, 'files/result.txt'), 'utf8'), 'keep this attachment');
  assert.equal(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), original);
  const receipt = JSON.parse(fs.readFileSync(path.join(dataDir, 'vm-migration.json'))); assert.equal(receipt.id, digest); assert.equal(receipt.host, '192.0.2.15');
  assert.ok(!fs.readdirSync(dataDir).some(name => name.startsWith('deploy-')));
  await bridge.deploy(bridge.binding()); assert.equal(recorded.migrations.length, 1); assert.equal(fs.readdirSync(path.join(dataDir, 'migration-backups')).length, 1);
});

test('failed deployment leaves a backup and source state intact, without a success receipt', async t => {
  const {bridge, dataDir, projectRoot} = fixture(t); resources(projectRoot);
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{"messages":[{"id":"preserved"}]}');
  archiveRecorder(bridge, async () => { throw Error('remote install failed'); });
  await assert.rejects(bridge.deploy(bridge.binding()), /remote install failed/);
  assert.equal(fs.existsSync(path.join(dataDir, 'vm-migration.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'))).messages[0].id, 'preserved');
  assert.equal(fs.readdirSync(path.join(dataDir, 'migration-backups')).length, 1);
  assert.ok(!fs.readdirSync(dataDir).some(name => name.startsWith('deploy-')));
});

test('missing build resources and invalid legacy state fail before remote installation', async t => {
  const {bridge, dataDir, projectRoot, calls} = fixture(t);
  await assert.rejects(bridge.deploy(bridge.binding()), /Build resources are missing: src/); assert.equal(calls.length, 0);
  assert.ok(!fs.readdirSync(dataDir).some(name => name.startsWith('deploy-')));
  resources(projectRoot); const recorded = archiveRecorder(bridge); fs.writeFileSync(path.join(dataDir, 'state.json'), '{');
  await assert.rejects(bridge.deploy(bridge.binding()), SyntaxError);
  assert.equal(recorded.calls.some(call => call.command === 'ssh'), false); assert.equal(fs.existsSync(path.join(dataDir, 'vm-migration.json')), false);
});

test('source identity depends on file names and bytes, never filesystem timestamps',t=>{
 const {projectRoot}=fixture(t);resources(projectRoot);const first=vmSourceFingerprint(projectRoot),file=path.join(projectRoot,'src/server.mjs');fs.utimesSync(file,new Date(1),new Date(2));assert.equal(vmSourceFingerprint(projectRoot),first);fs.appendFileSync(file,'\nchanged');assert.notEqual(vmSourceFingerprint(projectRoot),first);fs.renameSync(file,path.join(projectRoot,'src/renamed.mjs'));assert.notEqual(vmSourceFingerprint(projectRoot),first);
});

test('already deployed content skips archive upload, installation and pauses',async t=>{
 const {bridge,projectRoot}=fixture(t);resources(projectRoot);let probes=0;bridge.deployedSource=async()=>{probes++;return {sha256:vmSourceFingerprint(projectRoot),active:true};};bridge.run=()=>assert.fail('Matching source must not run tar or installer');
 assert.equal((await bridge.deploy(bridge.binding(),{updateRunningWork:true})).current,true);assert.equal(probes,1);
});

test('a binding change during archive preparation cannot install old source into another VM',async t=>{
 const {bridge,projectRoot,dataDir}=fixture(t);resources(projectRoot);const recorder=archiveRecorder(bridge),run=bridge.run;bridge.run=async(command,args,options)=>{await run(command,args,options);if(args[0]==='-cf'){const file=path.join(dataDir,'vm.json'),binding=JSON.parse(fs.readFileSync(file));binding.host='192.0.2.99';fs.writeFileSync(file,JSON.stringify(binding));bridge.disconnect();}};
 await assert.rejects(bridge.deploy(bridge.binding()),/connection changed/);assert.equal(recorder.calls.some(call=>call.command==='ssh'),false);assert.ok(!fs.readdirSync(dataDir).some(name=>name.startsWith('deploy-')));
});

test('unknown deployment is durable across bridge restart and only read-only remote confirmation clears it',async t=>{
 const {bridge,dataDir,projectRoot}=fixture(t);resources(projectRoot);archiveRecorder(bridge,()=>{throw Error('SSH disconnected during installation');});await assert.rejects(bridge.deploy(bridge.binding()),error=>error.unknownOutcome===true);
 const file=path.join(dataDir,'vm-update-attempts.json'),saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.entries.length,1);assert.equal(JSON.stringify(saved).includes('192.0.2.15'),false);
 const restarted=new VmBridge({dataDir,projectRoot});t.after(()=>restarted.close());restarted.deployedSource=async()=>({sha256:null,active:true});restarted.run=()=>assert.fail('An unknown installation must not be resent after restart');await assert.rejects(restarted.deploy(restarted.binding()),error=>error.unknownOutcome===true);assert.deepEqual(JSON.parse(fs.readFileSync(file)),saved);
 fs.appendFileSync(path.join(projectRoot,'src/server.mjs'),'new desktop version');await assert.rejects(restarted.deploy(restarted.binding()),error=>error.unknownOutcome===true);assert.deepEqual(JSON.parse(fs.readFileSync(file)),saved,'a new source hash cannot bypass an older unknown update on the same VM');
 fs.writeFileSync(path.join(projectRoot,'src/server.mjs'),'fixture src/server.mjs');
 restarted.deployedSource=async()=>({sha256:vmSourceFingerprint(projectRoot),active:true});assert.equal((await restarted.deploy(restarted.binding())).current,true);assert.equal(JSON.parse(fs.readFileSync(file)).entries.length,0);
});

test('invalid or full unknown-update receipts fail closed without overwriting saved evidence',async t=>{
 const {bridge,dataDir,projectRoot}=fixture(t);resources(projectRoot);bridge.deployedSource=async()=>({sha256:null,active:true});bridge.run=()=>assert.fail('Invalid receipts must prevent mutation');const file=path.join(dataDir,'vm-update-attempts.json');
 for(const raw of ['not json',JSON.stringify({schemaVersion:1,entries:[{binding:'private host',source:'bad'}]})]){fs.writeFileSync(file,raw);await assert.rejects(bridge.deploy(bridge.binding()),error=>error.unknownOutcome===true);assert.equal(fs.readFileSync(file,'utf8'),raw);}
 const entries=Array.from({length:64},(_,i)=>({binding:createHash('sha256').update(String(i)).digest('hex'),source:'a'.repeat(64)}));fs.writeFileSync(file,JSON.stringify({schemaVersion:1,entries}));const raw=fs.readFileSync(file,'utf8');assert.throws(()=>bridge.updateAttempts(bridge.binding(),'b'.repeat(64),'start'),error=>error.unknownOutcome===true);assert.equal(fs.readFileSync(file,'utf8'),raw);
});

test('a definitely deferred installation permits a later idle attempt and preserves exact guard diagnostics',async t=>{
 const {bridge,children,projectRoot,dataDir}=fixture(t);resources(projectRoot);let probes=0;bridge.deployedSource=async()=>{probes++;return {sha256:null,active:true};};const run=bridge.run;bridge.run=async(command,args,options)=>{if(command!=='ssh'){if(args[0]==='-cf')fs.writeFileSync(args[1],'fixture');return '';}const pending=run.call(bridge,command,args,options);children.at(-1).stderr.write('PRIVATE DETAIL\nDANT_WORK_ACTIVE\nDANT_UPDATE_DEFERRED:executor-offline:final\n');children.at(-1).emit('close',79);return pending;};
 await assert.rejects(bridge.deploy(bridge.binding()),error=>error.updateDeferred===true&&error.updateReason==='executor-offline'&&error.updateGuardReason==='executor-offline'&&error.updateStage==='final'&&!error.message.includes('PRIVATE'));assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir,'vm-update-attempts.json'))).entries.length,0);assert.equal(probes,1);
});

test('automatic deferred deployment keeps the old service connected and confirms its actual remote version',async t=>{
 const {bridge,requests}=fixture(t,{versionImpl:async(url,options)=>{requests.push({url,options});return Response.json({version:'0.4.7-beta.5'});}});bridge.serviceUpdate.targetVersion='0.4.7-beta.6';bridge.prepare=async()=>{throw Object.assign(Error('busy'),{updateDeferred:true,updateReason:'work-active'});};const notices=[];bridge.on('event',event=>notices.push(event));await bridge.connect({autoUpdate:true});
 assert.equal(bridge.status,'online');assert.deepEqual(bridge.serviceUpdate,{status:'pending',targetVersion:'0.4.7-beta.6',runningVersion:'0.4.7-beta.5',confirmed:true,reason:'work-active'});assert.equal(requests.filter(value=>value.url.endsWith('/api/version')).length,1);assert.deepEqual(notices,[]);bridge.disconnect();assert.equal(bridge.serviceUpdate.confirmed,false);
});

test('unknown automatic updates connect to existing chat without treating a matching version as deployment success',async t=>{
 const {bridge}=fixture(t);bridge.serviceUpdate.targetVersion='0.4.7-beta.6';bridge.prepare=async()=>{throw Object.assign(Error('unconfirmed'),{unknownOutcome:true});};await bridge.connect({autoUpdate:true});assert.equal(bridge.serviceUpdate.status,'failed');assert.equal(bridge.serviceUpdate.reason,'update-unconfirmed');assert.equal(bridge.serviceUpdate.confirmed,true);assert.equal(bridge.status,'online');
});

test('remote version confirmation can recover without installing and stale replies cannot confirm a new connection',async t=>{
 let available=false;const {bridge}=fixture(t,{versionImpl:async()=>available?Response.json({version:'0.4.7-beta.6'}):Response.json({}, {status:503})});bridge.serviceUpdate.targetVersion='0.4.7-beta.6';bridge.prepare=async()=>{};await bridge.connect({autoUpdate:true});assert.equal(bridge.serviceUpdate.reason,'version-unconfirmed');available=true;await bridge.confirmServiceVersion();assert.equal(bridge.serviceUpdate.status,'current');assert.equal(bridge.serviceUpdate.confirmed,true);
 const gate=deferred();bridge.fetchImpl=()=>gate.promise;const pending=bridge.confirmServiceVersion();bridge.disconnect();gate.resolve(Response.json({version:'99.0.0'}));await pending;assert.equal(bridge.serviceUpdate.runningVersion,'0.4.7-beta.6');assert.equal(bridge.serviceUpdate.confirmed,false);
});

test('read-only deployment probe rejects invalid responses and never uploads source',async t=>{
 const {bridge}=fixture(t);let calls=0;bridge.run=async(command,args,options)=>{calls++;assert.equal(command,'ssh');assert.equal(options.input,undefined);assert.equal(args.at(-1).includes('/api/connect'),false);return '{"sha256":null,"active":true}';};assert.deepEqual(await bridge.deployedSource(),{sha256:null,active:true});assert.equal(calls,1);
 for(const raw of ['bad','{}','{"sha256":"bad","active":true}','{"sha256":null,"active":"true"}']){bridge.run=async()=>raw;await assert.rejects(bridge.deployedSource(),error=>error.updateRetryable===true);}
});
