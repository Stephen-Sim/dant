import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeUpdates } from '../ui/platform/native-updates.js';
const asset = {
  version: '0.5.0-beta.2',
  channel: 'beta',
  url: 'https://github.com/Stephen-Sim/dant/releases/download/v0.5.0-beta.2/dant_0.5.0-beta.2_windows_x64_setup.exe',
  sha256: 'a'.repeat(64),
  name: 'dant_0.5.0-beta.2_windows_x64_setup.exe',
  size: 1000,
};
const result = { ...asset, url: undefined, ready: true, packageId: asset.sha256 };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ install = true, invoke } = {}) {
  const calls = [];
  let listener,
    stopped = 0;
  const bridge = createNativeUpdates({
    desktop: true,
    getToken: () => 'b'.repeat(64),
    loadCore: async () => ({
      invoke: async (name, args) => {
        calls.push({ name, args });
        if (invoke) return invoke(name, args);
        return name === 'update_capabilities'
          ? { download: true, install }
          : name === 'download_update'
            ? result
            : { launched: true };
      },
    }),
    loadEvents: async () => ({
      listen: async (name, callback) => {
        listener = callback;
        return () => stopped++;
      },
    }),
  });
  return {
    bridge,
    calls,
    emit: (payload) => listener?.({ payload }),
    get stopped() {
      return stopped;
    },
  };
}
test('native updater fetches its own descriptor and uses only an opaque verified cache identity for installation', async () => {
  const f = fixture();
  assert.equal(f.bridge.installSupported, false);
  await f.bridge.ready();
  assert.equal(f.bridge.installSupported, true);
  assert.equal((await f.bridge.download(asset)).ready, true);
  assert.deepEqual(f.calls.find((call) => call.name === 'download_update').args, {
    channel: 'beta',
    token: 'b'.repeat(64),
    expectedVersion: asset.version,
  });
  assert.deepEqual(await f.bridge.install(asset), { launched: true });
  assert.deepEqual(f.calls.find((call) => call.name === 'install_update').args, {
    packageId: asset.sha256,
    token: 'b'.repeat(64),
  });
  assert.equal(JSON.stringify(f.calls).includes('https:'), false);
});
test('background download deduplicates and rejects stale or malformed progress without blocking unrelated work', async () => {
  let resolve;
  const f = fixture({
      invoke: async (name) =>
        name === 'download_update'
          ? new Promise((done) => (resolve = done))
          : { download: true, install: true },
    }),
    seen = [];
  const first = f.bridge.download(asset, (p) => seen.push(p)),
    second = f.bridge.download(asset, (p) => seen.push(p));
  await tick();
  assert.equal(f.calls.filter((call) => call.name === 'download_update').length, 1);
  f.emit({
    version: 'other',
    channel: 'beta',
    sha256: asset.sha256,
    total: 1000,
    received: 500,
    status: 'downloading',
  });
  f.emit({ ...asset, total: 1000, received: 1001, status: 'downloading' });
  assert.equal(seen.length, 0);
  f.emit({ ...asset, total: 1000, received: 500, status: 'downloading' });
  assert.equal(seen.length, 2);
  resolve(result);
  await Promise.all([first, second]);
});
test('mismatched verified identity never enables install and failed download is explicitly retryable', async () => {
  let bad = true;
  const f = fixture({
    invoke: async (name) =>
      name === 'update_capabilities'
        ? { download: true, install: true }
        : name === 'download_update'
          ? { ...result, sha256: bad ? 'c'.repeat(64) : asset.sha256 }
          : { launched: true },
  });
  await assert.rejects(f.bridge.download(asset), /identity changed/);
  await assert.rejects(f.bridge.install(asset), /unavailable/);
  assert.equal(
    f.calls.some((call) => call.name === 'install_update'),
    false,
  );
  bad = false;
  await f.bridge.download(asset);
  assert.equal(f.calls.filter((call) => call.name === 'download_update').length, 2);
});
test('portable or external controller capability keeps installation disabled while preserving download', async () => {
  const f = fixture({ install: false });
  await f.bridge.ready();
  await f.bridge.download(asset);
  await assert.rejects(f.bridge.install(asset), /unavailable/);
  assert.equal(
    f.calls.some((call) => call.name === 'install_update'),
    false,
  );
});
test('disposing the view ignores later progress without cancelling or stopping VM work', async () => {
  const f = fixture(),
    seen = [];
  await f.bridge.download(asset, (p) => seen.push(p));
  f.bridge.dispose();
  f.emit({ ...asset, total: 1000, received: 1000, status: 'ready' });
  assert.equal(seen.length, 0);
  assert.equal(f.stopped, 1);
  assert.equal(
    f.calls.some((call) => /pause|stop|call|deploy/.test(call.name)),
    false,
  );
  await assert.rejects(f.bridge.install(asset), /unavailable/);
});
test('descriptor snapshots cannot change during an in-flight verified download', async () => {
  let resolve;
  const f = fixture({ invoke: async () => new Promise((done) => (resolve = done)) }),
    selected = { ...asset },
    pending = f.bridge.download(selected);
  await tick();
  selected.version = '9.0.0';
  selected.sha256 = 'd'.repeat(64);
  resolve(result);
  assert.equal((await pending).version, asset.version);
  assert.equal(f.calls[0].args.expectedVersion, asset.version);
});
