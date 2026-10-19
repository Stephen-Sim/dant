import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadProjectEnv} from '../src/config/env.mjs';
import {LocalWorker, assertVmRuntime} from '../src/local-worker.mjs';
import {
  NETWORK_DEFAULTS, NATIVE_PROTOCOL, PROTOCOL_PATHS,
  readNetworkConfig, configLoopback, configPort, allowedLocalOrigin, applicationEndpoint,
  publicVmEnvironment, validatePublicVmEnvironment,
} from '../src/config/network.mjs';

function directory(t) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, {recursive: true});
  const folder = fs.mkdtempSync(path.join(root, 'runtime-config-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  return folder;
}

test('network defaults and protocol paths keep native IPC fixed and guest health/screen aligned', () => {
  const network = readNetworkConfig({});
  assert.deepEqual(NETWORK_DEFAULTS, {host: '127.0.0.1', apiPort: 4317, devPort: 4318, guestPort: 4320});
  assert.equal(network.api.httpOrigin, NATIVE_PROTOCOL.httpOrigin);
  assert.equal(network.development.port, 4318);
  assert.equal(network.guest.httpOrigin + PROTOCOL_PATHS.health, 'http://127.0.0.1:4320/health');
  assert.equal(network.guest.httpOrigin + PROTOCOL_PATHS.screen, 'http://127.0.0.1:4320/screen');
  assert.ok(Object.isFrozen(network) && Object.isFrozen(network.guest) && Object.isFrozen(PROTOCOL_PATHS));
  const custom = readNetworkConfig({DANT_PORT: '5400', DANT_DEV_PORT: '5401', DANT_GUEST_HOST: 'localhost', DANT_GUEST_PORT: '5402'});
  assert.equal(custom.api.port, 5400);
  assert.equal(custom.development.port, 5401);
  assert.equal(custom.guest.httpOrigin, 'http://localhost:5402');
  assert.equal(NATIVE_PROTOCOL.httpOrigin, 'http://127.0.0.1:4317');
  assert.equal(applicationEndpoint({DANT_PORT:'5400'}).port,5400);
  assert.strictEqual(applicationEndpoint({DANT_MANAGED:'1',DANT_PORT:'5400',DANT_HOST:'localhost'}),NATIVE_PROTOCOL);
  assert.strictEqual(applicationEndpoint({DANT_PORT:'5400'},{vmWorker:true}),NATIVE_PROTOCOL);
});

test('invalid ports and non-loopback hosts are rejected without exposing their values', () => {
  for (const value of [0, -1, 65536, NaN, Infinity, 1.1, true, null, {}, [], '0', '-1', '65536', '4320.0', '+4320', '04320', ' 4320', '4320 ', '4e3', 'private-secret']) {
    assert.throws(() => configPort(value, 'DANT_GUEST_PORT', 4320), /^Error: DANT_GUEST_PORT must be an integer from 1 to 65535\.$/);
  }
  assert.equal(configPort(undefined, 'PORT', 4320), 4320);
  assert.equal(configPort('', 'PORT', 4320), 4320);
  assert.equal(configPort(65535, 'PORT', 4320), 65535);
  for (const value of ['0.0.0.0', '192.0.2.1', 'example.com', '127.0.0.1.evil', '127.1', '::', '::1', 'localhost.', 'LOCALHOST', 'localhost:4320', 'http://localhost', 'user@localhost', ' localhost', true, null, {}]) {
    assert.throws(() => configLoopback(value, 'DANT_GUEST_HOST'), /^Error: DANT_GUEST_HOST must be 127\.0\.0\.1 or localhost\.$/);
  }
  assert.equal(configLoopback('', 'HOST'), '127.0.0.1');
});

test('only allowlisted public VM network settings can enter a deployment', () => {
  const config = publicVmEnvironment({DANT_GUEST_HOST: 'localhost', DANT_GUEST_PORT: '5440', DANT_PORT: '5500', OPENAI_API_KEY: 'private-test-sentinel', TELEGRAM_TOKEN: 'private-test-sentinel'});
  assert.deepEqual(config, {DANT_GUEST_HOST: 'localhost', DANT_GUEST_PORT: '5440'});
  assert.doesNotMatch(JSON.stringify(config), /private|OPENAI|TELEGRAM|5500/);
  assert.deepEqual(validatePublicVmEnvironment(config), config);
  for (const value of [null, [], {}, {DANT_GUEST_PORT: '5440'}, {...config, OPENAI_API_KEY: 'private-test-sentinel'}, {...config, DANT_GUEST_HOST: '0.0.0.0'}, {...config, DANT_GUEST_PORT: '5440;command'}]) {
    assert.throws(() => validatePublicVmEnvironment(value));
  }
});

test('origin allowlist admits only exact local configured origins and native Tauri origins', () => {
  const env = {DANT_PORT: '5400', DANT_DEV_PORT: '5401'};
  for (const origin of [undefined, '', 'http://127.0.0.1:5400', 'http://localhost:5401', 'https://localhost:5400', 'http://localhost', 'http://tauri.localhost', 'tauri://localhost']) {
    assert.equal(allowedLocalOrigin(origin, env), true, origin);
  }
  for (const origin of ['http://127.0.0.1:4317', 'http://127.0.0.1:5402', 'http://localhost:5400/', 'http://localhost:5400/path', 'http://localhost:5400?secret=private', 'http://localhost:5400#x', 'http://user@localhost:5400', 'http:localhost:5400', 'http://localhost.evil:5400', 'http://192.0.2.1:5400', 'file:///tmp/x', 'null']) {
    assert.equal(allowedLocalOrigin(origin, env), false, origin);
  }
});

test('native Node env loading preserves process precedence and does not need dotenv', t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, '.env'), 'DANT_GUEST_PORT=5432\nDANT_CONFIG_TEST_VALUE="quoted value"\n');
  const module = new URL('../src/config/env.mjs', import.meta.url).href;
  const code = `import {loadProjectEnv} from ${JSON.stringify(module)};loadProjectEnv({projectRoot:process.argv[1]});process.stdout.write(JSON.stringify({port:process.env.DANT_GUEST_PORT,value:process.env.DANT_CONFIG_TEST_VALUE}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], {encoding: 'utf8', env: {...process.env, DANT_GUEST_PORT: '5544'}});
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {port: '5544', value: 'quoted value'});
});

test('env loading is optional and rejects directories, oversized files and alternate paths', t => {
  const root = directory(t);
  assert.equal(loadProjectEnv({projectRoot: root}), false);
  assert.throws(() => loadProjectEnv({projectRoot: root, file: '../.env'}), /Only the project/);
  fs.mkdirSync(path.join(root, '.env'));
  assert.throws(() => loadProjectEnv({projectRoot: root}), /ordinary file/);
  fs.rmdirSync(path.join(root, '.env'));
  fs.writeFileSync(path.join(root, '.env'), 'x'.repeat(65537));
  assert.throws(() => loadProjectEnv({projectRoot: root}), /64 KiB/);
});

test('custom guest configuration reaches runtime verification and desktop operations without changing route guards', async () => {
  const environment = {DANT_GUEST_HOST: 'localhost', DANT_GUEST_PORT: '5480'}, requests = [];
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const fetchImpl = async (url, options) => {
    requests.push({url, options});
    return url.endsWith(PROTOCOL_PATHS.health) ? Response.json({ok: true}) : new Response(png);
  };
  await assertVmRuntime({platform: 'linux', uid: 1000, detect: () => 'kvm', environment, fetchImpl});
  const worker = new LocalWorker({state: {}}, {platform: 'linux', environment, fetchImpl});
  await worker.guest(PROTOCOL_PATHS.screen);
  await assert.rejects(worker.guest(PROTOCOL_PATHS.input, {type: 'key'}), /offline/);
  worker.status = 'online';
  await worker.guest(PROTOCOL_PATHS.input, {type: 'key', sessionId: 'fixture-session'});
  await assert.rejects(worker.guest('/screen?redirect=http://example.com'), /Unsupported desktop operation/);
  assert.deepEqual(requests.map(request => request.url), [
    'http://localhost:5480/health', 'http://localhost:5480/screen',
    'http://localhost:5480/screen', 'http://localhost:5480/input',
  ]);
  assert.equal(requests.at(-1).options.method, 'POST');
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {type: 'key', sessionId: 'fixture-session'});
});
