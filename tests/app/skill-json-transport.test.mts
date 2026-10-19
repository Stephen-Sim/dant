import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkerApp } from '../../src/app/server.mts';
import { createControllerApp } from '../../src/app/controller.mts';
import { API_JSON_BODY_BYTES } from '../../src/config/network.mts';
import { ConnectionStatus } from '../../src/contracts/states.mts';
import {
  SKILL_EDITOR_FILE_BYTES,
  SKILL_EDITOR_TOTAL_BYTES,
  SKILL_FILE_BYTES,
  SKILL_TOTAL_BYTES,
  SKILL_ARCHIVE_BYTES,
  SKILL_SUPPORT_FILE_LIMIT,
  SKILL_RELATIVE_PATH_CHARACTERS,
  SKILL_DESCRIPTION_BYTES,
} from '../../src/skills/skill-limits.mts';
import { MAX_ATTACHMENT_BYTES } from '../../src/config/limits.mts';
import { exportSkillZip } from '../../src/skills/skill-export.mts';
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

test('maximum editor text survives JSON escaping through Controller and Worker while oversized bodies stay bounded', async (t) => {
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
        ('a'.repeat(512) + '"\\'.repeat(SKILL_EDITOR_FILE_BYTES / 2)).slice(
          0,
          SKILL_EDITOR_FILE_BYTES - (index === 3 ? 1 : 0),
        ),
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
    SKILL_EDITOR_TOTAL_BYTES,
  );
  assert.ok(Buffer.byteLength(wire) > 2 * 1024 * 1024 - 4096);
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
  const largeFiles = {
    'assets/reference.png': Buffer.alloc(1_557_774, 0x89),
    'references/large.md': Buffer.from('Large reference text.\n'.repeat(75_000)),
  };
  fs.mkdirSync(path.join(path.dirname(saved.path), 'references'));
  for (const [relative, data] of Object.entries(largeFiles))
    fs.writeFileSync(path.join(path.dirname(saved.path), relative), data);
  const viewed = await fetch(origin + '/api/skills/' + input.name, { headers }),
    viewWire = await viewed.text(),
    view = observedRecord(JSON.parse(viewWire));
  assert.equal(viewed.status, 200);
  assert.ok(Buffer.byteLength(viewWire) < API_JSON_BODY_BYTES);
  assert.deepEqual(view.files, files);
  assert.ok(Array.isArray(view.assets));
  assert.deepEqual(
    view.assets
      .map((value: unknown) => {
        const asset = observedRecord(value);
        return [asset.path, asset.size];
      })
      .sort(),
    Object.entries(largeFiles)
      .map(([relative, data]) => [relative, data.length])
      .sort(),
  );
  assert.equal(Object.hasOwn(view, 'binaryFiles'), false);
  const preserved = await fetch(origin + '/api/skills/' + input.name, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      description: 'Edit preserves large text and PNG bytes.',
      instructions: 'i',
      files,
      preserveBinaryFiles: true,
    }),
  });
  assert.equal(preserved.status, 200);
  await preserved.arrayBuffer();
  for (const [relative, data] of Object.entries(largeFiles))
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(saved.path), relative)), data);

  // Exercise the complete download path at the storage limit without enlarging
  // chat attachments or submitting any model work. Paths also approach the
  // maximum UTF-8 ZIP name size while each component fits Linux NAME_MAX.
  const maximum = workerApp.skills.save({
      name: 'a'.repeat(64),
      description: 'd'.repeat(SKILL_DESCRIPTION_BYTES),
      instructions: 'i',
    }),
    maximumDirectory = path.dirname(maximum.path),
    maximumFiles = new Map<string, Buffer>(),
    largeText = Buffer.from('界'.repeat(Math.floor(SKILL_FILE_BYTES / 3)) + 'ab');
  assert.equal(largeText.length, SKILL_FILE_BYTES);
  let remaining = SKILL_TOTAL_BYTES - 1;
  for (let index = 0; index < SKILL_SUPPORT_FILE_LIMIT; index++) {
    const relative =
        `assets/${'界'.repeat(72)}/${'界'.repeat(72)}` +
        String(index).padStart(3, '0') +
        'a'.repeat(21) +
        '.bin',
      data =
        index === 0
          ? largeText
          : Buffer.alloc(Math.ceil(remaining / (SKILL_SUPPORT_FILE_LIMIT - index)));
    assert.equal(relative.length, SKILL_RELATIVE_PATH_CHARACTERS);
    remaining -= data.length;
    maximumFiles.set(relative, data);
    const target = path.join(maximumDirectory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  assert.equal(remaining, 0);
  worker.status = ConnectionStatus.Online;
  const maximumViewResponse = await fetch(origin + '/api/skills/' + maximum.name, { headers }),
    maximumView = observedRecord(await maximumViewResponse.json());
  assert.equal(maximumViewResponse.status, 200);
  assert.deepEqual(maximumView.files, {});
  assert.ok(Array.isArray(maximumView.assets));
  assert.equal(maximumView.assets.length, SKILL_SUPPORT_FILE_LIMIT);
  const maximumEdit = await fetch(origin + '/api/skills/' + maximum.name, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      description: maximum.description,
      instructions: 'i',
      files: {},
      preserveBinaryFiles: true,
    }),
  });
  assert.equal(maximumEdit.status, 200);
  await maximumEdit.arrayBuffer();
  for (const [relative, data] of maximumFiles)
    assert.deepEqual(fs.readFileSync(path.join(maximumDirectory, relative)), data);
  const exported = await fetch(origin + '/api/skills/' + maximum.name + '/export', {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(exported.status, 200);
  const attachment = observedRecord(await exported.json());
  assert.ok(typeof attachment.id === 'string' && typeof attachment.size === 'number');
  assert.ok(attachment.size > SKILL_TOTAL_BYTES);
  assert.ok(attachment.size < SKILL_ARCHIVE_BYTES && attachment.size < MAX_ATTACHMENT_BYTES);
  // Two ZIP headers per entry, bounded UTF-8 paths, plus a conservative
  // sixfold JSON expansion allowance for the frontmatter description.
  const maximumHeaderBytes =
    (SKILL_SUPPORT_FILE_LIMIT + 1) * (30 + 46 + 2 * (64 + 1 + 3 * SKILL_RELATIVE_PATH_CHARACTERS)) +
    6 * SKILL_DESCRIPTION_BYTES +
    256;
  assert.ok(maximumHeaderBytes < MAX_ATTACHMENT_BYTES - SKILL_TOTAL_BYTES);
  assert.ok(attachment.size - SKILL_TOTAL_BYTES < maximumHeaderBytes);
  const downloaded = await fetch(origin + '/api/files/' + attachment.id + '?download=1', {
    headers,
  });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition') ?? '', /^attachment/);
  assert.deepEqual(
    Buffer.from(await downloaded.arrayBuffer()),
    exportSkillZip(workerApp.skills, maximum.name).data,
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
