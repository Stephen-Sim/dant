import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProjectEnv } from '../../../scripts/config/project-env.mts';
import {
  PROTOCOL_PATHS,
  readNetworkConfig,
  configLoopback,
  configPort,
} from '../../../scripts/config/network.mts';

function directory(t: NodeTestContext) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const folder = fs.mkdtempSync(path.join(root, 'runtime-config-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test('build and development endpoints retain bounded loopback defaults and detached configuration', () => {
  const network = readNetworkConfig({});
  assert.equal(network.api.httpOrigin, 'http://127.0.0.1:4317');
  assert.equal(network.development.port, 4318);
  assert.equal(PROTOCOL_PATHS.health, '/health');
  assert.equal(PROTOCOL_PATHS.screen, '/screen');
  assert.ok(Object.isFrozen(network) && Object.isFrozen(network.api));
  const custom = readNetworkConfig({
    DANT_HOST: 'localhost',
    DANT_PORT: '5400',
    DANT_DEV_PORT: '5401',
  });
  assert.equal(custom.api.httpOrigin, 'http://localhost:5400');
  assert.equal(custom.development.port, 5401);
  assert.equal(readNetworkConfig({}).api.port, 4317);
});

test('invalid ports and non-loopback hosts are rejected without exposing their values', () => {
  for (const value of [
    0,
    -1,
    65536,
    NaN,
    Infinity,
    1.1,
    true,
    null,
    {},
    [],
    '0',
    '-1',
    '65536',
    '4320.0',
    '+4320',
    '04320',
    ' 4320',
    '4320 ',
    '4e3',
    'private-secret',
  ]) {
    assert.throws(
      () => configPort(value, 'DANT_PORT', 4320),
      /^Error: DANT_PORT must be an integer from 1 to 65535\.$/,
    );
  }
  assert.equal(configPort(undefined, 'PORT', 4320), 4320);
  assert.equal(configPort('', 'PORT', 4320), 4320);
  assert.equal(configPort(65535, 'PORT', 4320), 65535);
  for (const value of [
    '0.0.0.0',
    '192.0.2.1',
    'example.com',
    '127.0.0.1.evil',
    '127.1',
    '::',
    '::1',
    'localhost.',
    'LOCALHOST',
    'localhost:4320',
    'http://localhost',
    'user@localhost',
    ' localhost',
    true,
    null,
    {},
  ]) {
    assert.throws(
      () => configLoopback(value, 'DANT_HOST'),
      /^Error: DANT_HOST must be 127\.0\.0\.1 or localhost\.$/,
    );
  }
  assert.equal(configLoopback('', 'HOST'), '127.0.0.1');
});

test('native Node env loading preserves process precedence and does not need dotenv', (t) => {
  const root = directory(t);
  fs.writeFileSync(
    path.join(root, '.env'),
    'DANT_PORT=5432\nDANT_CONFIG_TEST_VALUE="quoted value"\n',
  );
  const module = new URL('../../../scripts/config/project-env.mts', import.meta.url).href;
  const code = `import {loadProjectEnv} from ${JSON.stringify(module)};loadProjectEnv({projectRoot:process.argv[1]});process.stdout.write(JSON.stringify({port:process.env.DANT_PORT,value:process.env.DANT_CONFIG_TEST_VALUE}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, root], {
    encoding: 'utf8',
    env: { ...process.env, DANT_PORT: '5544' },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { port: '5544', value: 'quoted value' });
});

test('env loading is optional and rejects directories, oversized files and alternate paths', (t) => {
  const root = directory(t);
  assert.equal(loadProjectEnv({ projectRoot: root }), false);
  assert.throws(
    () =>
      loadProjectEnv({
        projectRoot: root,
        // @ts-expect-error Deliberately invalid runtime input; typed callers can only select .env.
        file: '../.env',
      }),
    /Only the project/,
  );
  fs.mkdirSync(path.join(root, '.env'));
  assert.throws(() => loadProjectEnv({ projectRoot: root }), /ordinary file/);
  fs.rmdirSync(path.join(root, '.env'));
  fs.writeFileSync(path.join(root, '.env'), 'x'.repeat(65537));
  assert.throws(() => loadProjectEnv({ projectRoot: root }), /64 KiB/);
});
