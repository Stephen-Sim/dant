import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import protocol from '../../../resources/config/protocol.json' with { type: 'json' };
import {
  nativeProtocolFields,
  nativeProtocolOutputs,
} from '../../../scripts/config/native-protocol.mts';

test('native protocol projections share validated loopback ports without reading the environment', () => {
  const result = nativeProtocolFields({ loopbackHost: 'localhost', apiPort: 5217, devPort: 5218 });
  assert.equal(result.devUrl, 'http://localhost:5218');
  assert.match(result.beforeDevCommand, /--host localhost --port 5218$/);
  assert.match(result.csp, /http:\/\/localhost:5217 ws:\/\/localhost:5217/);
  assert.doesNotMatch(result.csp, /4317|4318/);
  for (const value of [
    null,
    {},
    { loopbackHost: 'remote.invalid', apiPort: 5217, devPort: 5218 },
    { loopbackHost: '127.0.0.1', apiPort: '5217', devPort: 5218 },
    { loopbackHost: '127.0.0.1', apiPort: 0, devPort: 5218 },
    { loopbackHost: '127.0.0.1', apiPort: 5217, devPort: 65536 },
  ])
    assert.throws(() => nativeProtocolFields(value));
});

test('generated native network fields replace stale duplicates while preserving application choices', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-native-protocol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'resources/config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.writeFileSync(
    path.join(root, 'resources/config/protocol.json'),
    JSON.stringify({
      ...protocol,
      apiPort: 5217,
      devPort: 5218,
      bootstrapGuestPort: 5219,
      guestPort: 5220,
    }),
  );
  const configuration = {
    productName: 'fixture',
    version: '1.2.3',
    build: { frontendDist: '../dist', devUrl: 'stale', beforeDevCommand: 'stale' },
    app: { windows: [{ width: 900 }], security: { csp: 'stale', capabilities: ['fixture'] } },
    bundle: { targets: ['nsis'] },
  };
  const file = path.join(root, 'src-tauri/tauri.conf.json');
  fs.writeFileSync(file, JSON.stringify(configuration));
  const outputs = await nativeProtocolOutputs(root);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.[0], 'src-tauri/tauri.conf.json');
  const expected = {
    ...configuration,
    build: {
      ...configuration.build,
      devUrl: 'http://127.0.0.1:5218',
      beforeDevCommand: 'npm run package:resources && npx vite --host 127.0.0.1 --port 5218',
    },
    app: {
      ...configuration.app,
      security: {
        ...configuration.app.security,
        csp: nativeProtocolFields({ loopbackHost: '127.0.0.1', apiPort: 5217, devPort: 5218 }).csp,
      },
    },
  };
  const actual: unknown = JSON.parse(outputs[0]![1]);
  assert.deepEqual(actual, expected);
  assert.ok(typeof actual === 'object' && actual !== null);
  assert.doesNotMatch(JSON.stringify(actual), /5219|5220/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, configuration);
  for (const invalid of [
    null,
    {},
    { build: {}, app: {} },
    { build: {}, app: { security: null } },
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    await assert.rejects(nativeProtocolOutputs(root), /native application configuration/);
  }
});
