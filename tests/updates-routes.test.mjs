import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createControllerApp } from '../src/app/controller.mjs';
import { createWorkerApp } from '../src/app/server.mjs';
import { UpdateService, REPOSITORY_URL, RELEASES_URL } from '../src/updates/updates.mjs';

const root = path.resolve('.cache/tests');
fs.mkdirSync(root, { recursive: true });
class Bridge extends EventEmitter {
  constructor() {
    super();
    this.status = 'offline';
    this.requests = [];
  }
  request(route) {
    this.requests.push(route);
    throw Error('VM is offline');
  }
  close() {}
}
class Provisioning extends EventEmitter {
  snapshot() {
    return { status: 'idle' };
  }
  close() {}
}
class Worker extends EventEmitter {
  constructor() {
    super();
    this.status = 'offline';
    this.calls = [];
    this.rpc = { reply() {}, send() {} };
  }
  request(method) {
    this.calls.push(method);
    throw Error('Worker is offline');
  }
  disconnect() {}
}
async function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(root, 'updates-route-')),
    bridge = new Bridge(),
    worker = new Worker();
  let calls = 0,
    modeError = false;
  const updatesFactory = (options) =>
    new UpdateService({
      ...options,
      fetchImpl: async (url) => {
        calls++;
        if (modeError) throw Error('private-upstream-error');
        const release = {
          draft: false,
          prerelease: false,
          published_at: '2026-10-17T00:00:00Z',
          tag_name: 'v9.0.0',
          html_url: RELEASES_URL + '/tag/v9.0.0',
        };
        return Response.json(url.includes('?') ? [release] : release);
      },
    });
  const instance =
    mode === 'worker'
      ? createWorkerApp({ dataDir: dir, workerFactory: () => worker, updatesFactory })
      : createControllerApp({
          dataDir: dir,
          projectRoot: path.resolve('.'),
          bridgeFactory: () => bridge,
          provisioningFactory: () => new Provisioning(),
          updatesFactory,
          profileOptions: {
            registryFile: path.join(dir, 'registry.json'),
            includeProject: false,
            candidateDirs: [],
            env: {},
          },
        });
  t.after(async () => {
    await instance.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + instance.server.address().port,
    { token } = await fetch(base + '/api/session').then((response) => response.json());
  return {
    instance,
    bridge,
    worker,
    base,
    headers: { 'X-Dant-Token': token },
    calls: () => calls,
    fail: () => (modeError = true),
  };
}

for (const mode of ['controller', 'worker'])
  test(
    mode +
      ' version and manual update routes are authenticated, local and usable while its VM/executor is offline',
    async (t) => {
      const { instance, bridge, worker, base, headers, calls } = await fixture(t, mode),
        version = JSON.parse(fs.readFileSync('package.json')).version;
      for (const route of ['/api/version', '/api/updates']) {
        assert.equal((await fetch(base + route)).status, 401);
        assert.equal(
          (await fetch(base + route, { headers: { ...headers, Origin: 'https://evil.example' } }))
            .status,
          403,
        );
        for (const method of ['POST', 'DELETE', 'HEAD'])
          assert.equal((await fetch(base + route, { method, headers })).status, 405);
      }
      assert.equal(calls(), 0);
      const info = await fetch(base + '/api/version', { headers });
      assert.equal(info.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await info.json(), {
        version,
        repositoryUrl: REPOSITORY_URL,
        releasesUrl: RELEASES_URL,
      });
      assert.equal(calls(), 0);
      const result = await fetch(
        base + '/api/updates?url=https://evil.example&token=private-query',
        { headers },
      ).then((response) => response.json());
      assert.equal(result.currentVersion, version);
      assert.equal(result.latestVersion, '9.0.0');
      assert.equal(result.updateAvailable, true);
      assert.equal(result.releaseUrl, RELEASES_URL + '/tag/v9.0.0');
      assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
      assert.equal(calls(), 1);
      await fetch(base + '/api/updates', { headers });
      assert.equal(calls(), 1);
      assert.deepEqual(bridge.requests, []);
      assert.deepEqual(worker.calls, []);
      assert.equal(instance.snapshot?.().call || instance.engine?.call || null, null);
      const beta = await fetch(base + '/api/updates?channel=beta', { headers }).then((response) =>
        response.json(),
      );
      assert.equal(beta.channel, 'beta');
      assert.equal(calls(), 2);
      await fetch(base + '/api/updates?channel=beta', { headers });
      assert.equal(calls(), 2);
      for (const query of ['channel=nightly', 'channel=stable&channel=beta']) {
        const response = await fetch(base + '/api/updates?' + query, { headers });
        assert.equal(response.status, 400);
      }
      assert.equal(calls(), 2);
      const diagnostics = instance.diagnostics.recent(50);
      assert.ok(
        diagnostics.some((entry) => entry.route === '/api/updates' && entry.status === 405),
      );
      assert.equal(JSON.stringify(diagnostics).includes('private-'), false);
      await instance.close();
      assert.equal(instance.updates.closed, true);
    },
  );

test('update failure is a bounded, safe response and local version remains readable', async (t) => {
  const { base, headers, fail, calls } = await fixture(t, 'controller');
  fail();
  const response = await fetch(base + '/api/updates', { headers }),
    body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, 'UPDATE_UNAVAILABLE');
  assert.equal(JSON.stringify(body).includes('private-'), false);
  assert.equal((await fetch(base + '/api/version', { headers })).status, 200);
  await fetch(base + '/api/updates', { headers });
  assert.equal(calls(), 2);
});
