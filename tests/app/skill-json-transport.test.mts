import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkerApp } from '../../src/app/server.mts';
import { createControllerApp } from '../../src/app/controller.mts';
import { API_JSON_BODY_BYTES } from '../../src/config/network.mts';
import { ConnectionStatus } from '../../src/contracts/states.mts';
import { SKILL_FILE_BYTES, SKILL_TOTAL_BYTES } from '../../src/skills/skill-limits.mts';
import { VoiceKeyStore } from '../../src/security/secrets.mts';
import type { VmRequestOptions } from '../../src/computer/vm-bridge.mts';
import {
  ControllerBridgeFixture,
  ProvisioningFixture,
  WorkerServiceFixture,
  listeningPort,
  observedRecord,
} from '../support/service-fixtures.mts';

class IsolatedProvisioning extends ProvisioningFixture {
  snapshot() {
    return { status: 'idle', running: false };
  }
  providers() {
    return { selected: 'auto', provider: '', availableProviders: [] };
  }
  resumeMonitoring() {
    return this.snapshot();
  }
  close() {}
}

class HttpWorkerBridge extends ControllerBridgeFixture {
  readonly origin: string;
  readonly token: string;
  requests = 0;
  constructor(origin: string, token: string) {
    super();
    this.origin = origin;
    this.token = token;
    this.status = ConnectionStatus.Online;
    this.error = null;
    this.generation = 0;
  }
  async refresh() {
    return this.cached;
  }
  async request(route: string, options: VmRequestOptions = {}) {
    assert.ok(options.body === undefined || typeof options.body === 'string');
    this.requests++;
    return fetch(this.origin + route, {
      method: options.method ?? 'GET',
      headers: { ...options.headers, 'X-Dant-Token': this.token },
      ...(typeof options.body === 'string' ? { body: options.body } : {}),
    });
  }
  close() {}
  disconnect() {
    this.status = ConnectionStatus.Offline;
  }
}

test('maximum raw skill text survives JSON escaping through Controller and Worker while oversized bodies stay bounded', async (t) => {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'skill-json-transport-')),
    workerDirectory = path.join(directory, 'worker'),
    controllerDirectory = path.join(directory, 'controller'),
    worker = new WorkerServiceFixture();
  fs.mkdirSync(workerDirectory);
  fs.mkdirSync(controllerDirectory);
  fs.writeFileSync(
    path.join(controllerDirectory, 'backup-settings.json'),
    JSON.stringify({ mode: 'manual' }),
  );
  worker.status = ConnectionStatus.Offline;
  worker.error = null;
  worker.models = null;
  worker.rpc = null;
  worker.disconnect = () => {};
  const workerApp = createWorkerApp({
    dataDir: workerDirectory,
    workerFactory: () => worker,
    secretFactory: (dir) => new VoiceKeyStore(dir, { platform: 'linux', env: {} }),
  });
  let controllerApp: ReturnType<typeof createControllerApp> | undefined;
  t.after(async () => {
    await controllerApp?.close();
    await workerApp.close();
    const relative = path.relative(base, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => workerApp.server.listen(0, '127.0.0.1', resolve));
  const workerOrigin = `http://127.0.0.1:${listeningPort(workerApp.server)}`,
    workerSession: unknown = await fetch(workerOrigin + '/api/session').then((res) => res.json()),
    workerToken = observedRecord(workerSession).token;
  assert.ok(typeof workerToken === 'string');
  const bridge = new HttpWorkerBridge(workerOrigin, workerToken);
  controllerApp = createControllerApp({
    dataDir: controllerDirectory,
    projectRoot: path.resolve('.'),
    bridgeFactory: () => bridge,
    provisioningFactory: () => new IsolatedProvisioning(),
    secretFactory: (dir) => new VoiceKeyStore(dir, { platform: 'linux', env: {} }),
    profileOptions: {
      registryFile: path.join(controllerDirectory, 'registry.json'),
      includeProject: false,
      candidateDirs: [],
      env: {},
    },
  });
  await new Promise<void>((resolve) => controllerApp?.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${listeningPort(controllerApp.server)}`,
    session: unknown = await fetch(origin + '/api/session').then((res) => res.json()),
    token = observedRecord(session).token;
  assert.ok(typeof token === 'string');
  const files = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [
        `assets/${index}.txt`,
        '"\\'.repeat(SKILL_FILE_BYTES / 2).slice(0, SKILL_FILE_BYTES - (index === 3 ? 1 : 0)),
      ]),
    ),
    input = {
      name: 'maximum-wire-skill',
      description: 'Maximum raw text with quotes and backslashes.',
      instructions: 'i',
      files,
    },
    wire = JSON.stringify(input);
  assert.equal(
    Buffer.byteLength(input.instructions) +
      Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0),
    SKILL_TOTAL_BYTES,
  );
  assert.ok(Buffer.byteLength(wire) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(wire) <= API_JSON_BODY_BYTES);
  const headers = { 'X-Dant-Token': token, 'Content-Type': 'application/json' },
    created = await fetch(origin + '/api/skills', { method: 'POST', headers, body: wire });
  assert.equal(created.status, 200);
  assert.deepEqual(observedRecord(await created.json()).files, files);
  const edited = await fetch(origin + '/api/skills/' + input.name, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ description: 'Edited without truncation.', instructions: 'i', files }),
  });
  assert.equal(edited.status, 200);
  const saved = observedRecord(await edited.json());
  assert.deepEqual(saved.files, files);
  assert.ok(typeof saved.path === 'string');
  for (const [relative, value] of Object.entries(files))
    assert.deepEqual(
      fs.readFileSync(path.join(path.dirname(saved.path), relative)),
      Buffer.from(value),
    );
  const oversized = JSON.stringify({ description: 'x'.repeat(API_JSON_BODY_BYTES) }),
    forwarded = bridge.requests,
    rejected = await fetch(origin + '/api/skills/' + input.name, {
      method: 'PATCH',
      headers,
      body: oversized,
    });
  assert.equal(rejected.status, 413);
  await rejected.arrayBuffer();
  assert.equal(bridge.requests, forwarded);
  const workerRejected = await fetch(workerOrigin + '/api/skills/' + input.name, {
    method: 'PATCH',
    headers: { ...headers, 'X-Dant-Token': workerToken },
    body: oversized,
  });
  assert.equal(workerRejected.status, 413);
  await workerRejected.arrayBuffer();
  assert.deepEqual(workerApp.skills.get(input.name).files, files);
  assert.deepEqual(workerApp.store.state.messages, []);
  assert.equal(workerApp.engine.active, null);
});
