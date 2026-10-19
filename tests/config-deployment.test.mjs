import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {VmBridge, vmSourceFingerprint} from '../src/vm-bridge.mjs';
import {publicVmEnvironment} from '../src/config/network.mjs';

const sourceNames = [
  'src/server.mjs', 'dist/index.html', 'LICENSE', 'package.json', 'package-lock.json',
  'vm/install-worker.sh', 'vm/install-speech.sh', 'vm/install-transcription.sh',
  'vm/transcription-requirements.txt', 'vm/migrate-state.mjs', 'vm/start-codex.sh',
  'vm/guest.py', 'vm/desktop.py', 'vm/control.py', 'vm/voice_message.py',
  'vm/transcribe_audio.py', 'vm/desktop_mcp.py',
];
function fixture(t) {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, {recursive:true});
  const root = fs.mkdtempSync(path.join(base, 'config-deployment-'));
  const projectRoot = path.join(root, 'project'), dataDir = path.join(root, 'data');
  fs.mkdirSync(projectRoot); fs.mkdirSync(dataDir);
  for (const name of sourceNames) {
    const file = path.join(projectRoot,name);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,'fixture');
  }
  fs.mkdirSync(path.join(projectRoot,'src/config'),{recursive:true});
  fs.copyFileSync('src/config/protocol.json',path.join(projectRoot,'src/config/protocol.json'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  return {root,projectRoot,dataDir};
}
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows','System32/tar.exe') : 'tar';
function runTar(args) {
  const result = spawnSync(tar,args,{encoding:'utf8',shell:false,timeout:10000});
  if (result.error) throw result.error;
  assert.equal(result.status,0,result.stderr);
  return result.stdout;
}

test('public guest settings alter deployment identity, while private environment files and secrets do not', t => {
  const {projectRoot} = fixture(t), defaults = publicVmEnvironment({});
  const first = vmSourceFingerprint(projectRoot,defaults);
  for (const name of ['.env','src/config/.env','src/config/.ENV.production']) {
    fs.writeFileSync(path.join(projectRoot,name),'PRIVATE_FIXTURE_ONE');
  }
  assert.equal(vmSourceFingerprint(projectRoot,defaults),first);
  fs.writeFileSync(path.join(projectRoot,'src/config/.env'),'PRIVATE_FIXTURE_TWO');
  assert.equal(vmSourceFingerprint(projectRoot,publicVmEnvironment({OPENAI_API_KEY:'PRIVATE_FIXTURE_TWO'})),first);
  assert.notEqual(vmSourceFingerprint(projectRoot,publicVmEnvironment({DANT_GUEST_PORT:'5540'})),first);
  assert.notEqual(vmSourceFingerprint(projectRoot,publicVmEnvironment({DANT_GUEST_HOST:'localhost'})),first);
  assert.throws(() => vmSourceFingerprint(projectRoot,{...defaults,PRIVATE_KEY:'fixture'}),/Invalid public VM/);
});

test('the actual VM archive includes only public guest settings and excludes nested environment files', async t => {
  const {projectRoot,dataDir} = fixture(t);
  for (const name of ['.env','src/config/.env','src/config/.Env.private','dist/.ENV']) {
    fs.writeFileSync(path.join(projectRoot,name),'PRIVATE_ARCHIVE_FIXTURE');
  }
  fs.writeFileSync(path.join(projectRoot,'src/config/settings.json'),'public source');
  const environment = {DANT_GUEST_HOST:'localhost',DANT_GUEST_PORT:'5540',OPENAI_API_KEY:'PRIVATE_ARCHIVE_FIXTURE',TELEGRAM_TOKEN:'PRIVATE_ARCHIVE_FIXTURE'};
  const bridge = new VmBridge({projectRoot,dataDir,environment});
  t.after(() => bridge.close());
  const keyPath=path.join(dataDir,'fixture-key');fs.writeFileSync(keyPath,'TEST FIXTURE ONLY; never a credential');
  bridge.binding = () => ({host:'192.0.2.1',user:'dant',port:22,keyPath,knownHosts:path.join(dataDir,'fixture-hosts')});
  let probes = 0, entries, manifest;
  bridge.deployedSource = async () => ++probes === 1 ? {sha256:null,active:true} : {sha256:bridge.desiredSource,active:true};
  bridge.run = async (command,args,options = {}) => {
    if (command === 'ssh') {
      entries = runTar(['-tf',options.input]).split(/\r?\n/).filter(Boolean);
      manifest = JSON.parse(runTar(['-xOf',options.input,'deploy-manifest.json']));
      return '';
    }
    return runTar(args);
  };
  await bridge.deploy(bridge.binding());
  assert.ok(entries.includes('src/config/settings.json'));
  assert.ok(!entries.some(name => /(?:^|\/)\.env(?:\.|$)/i.test(name)));
  assert.deepEqual(manifest.publicEnvironment,{DANT_GUEST_HOST:'localhost',DANT_GUEST_PORT:'5540'});
  assert.equal(manifest.sha256,vmSourceFingerprint(projectRoot,publicVmEnvironment(environment)));
  assert.doesNotMatch(JSON.stringify(manifest),/PRIVATE_ARCHIVE_FIXTURE|OPENAI_API_KEY|TELEGRAM_TOKEN/);
});

const installer = fs.readFileSync('vm/install-worker.sh','utf8').replaceAll('\r\n','\n');
const environmentParser = installer.match(/public_environment=\$\(python3 - "\$source_dir" <<'PY'\n([\s\S]*?)\nPY\n\)/)[1];
function parseManifest(t,value,withField = true) {
  const {projectRoot} = fixture(t);
  fs.writeFileSync(path.join(projectRoot,'deploy-manifest.json'),JSON.stringify({schemaVersion:2,sha256:'a'.repeat(64),...(withField ? {publicEnvironment:value} : {})}));
  const result = spawnSync(process.env.PYTHON || 'python',['-c',environmentParser,projectRoot],{encoding:'utf8',shell:false,timeout:10000});
  if (result.error) throw result.error;
  return result;
}

test('the installer consumes the public allowlist with matching defaults and no shell interpretation', t => {
  const defaults = parseManifest(t,null,false);
  assert.equal(defaults.status,0,defaults.stderr);
  assert.equal(defaults.stdout.trim(),'127.0.0.1\t4320\t4317');
  const custom = parseManifest(t,{DANT_GUEST_HOST:'localhost',DANT_GUEST_PORT:'5540'});
  assert.equal(custom.status,0,custom.stderr);
  assert.equal(custom.stdout.trim(),'localhost\t5540\t4317');
});

test('the installer rejects unknown keys, remote addresses and malformed ports without exposing their values', t => {
  const valid = {DANT_GUEST_HOST:'localhost',DANT_GUEST_PORT:'5540'};
  for (const value of [null, [], {}, {DANT_GUEST_PORT:'5540'}, {...valid,OPENAI_API_KEY:'PRIVATE_CONFIG_FIXTURE'}, {...valid,DANT_GUEST_HOST:'0.0.0.0'}, {...valid,DANT_GUEST_HOST:'localhost\nExecStart=PRIVATE_CONFIG_FIXTURE'}, {...valid,DANT_GUEST_PORT:'5540;PRIVATE_CONFIG_FIXTURE'}, {...valid,DANT_GUEST_PORT:'65536'}, {...valid,DANT_GUEST_PORT:'05540'}, {...valid,DANT_GUEST_PORT:5540}]) {
    const result = parseManifest(t,value);
    assert.equal(result.status,1);
    assert.equal(result.stdout,'');
    assert.equal(result.stderr.trim(),'Invalid public VM network configuration; existing services were preserved.');
  }
});
