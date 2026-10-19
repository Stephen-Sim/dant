import { fixtureString } from '../support/engine-fixtures.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TracingWorkerFixture } from '../support/worker-fixtures.mts';
import { RpcFixture, VoiceFixture } from '../support/protocol-fixtures.mts';
import { NativeVoiceFixture } from '../support/native-service-fixtures.mts';
import { listeningPort, observedRecord } from '../support/service-fixtures.mts';
import { MemoryStore } from '../../src/conversation/memory.mts';
import { DANT_IDENTITY_INSTRUCTIONS } from '../../src/conversation/identity.mts';
import { currentMemoryView } from '../../src/conversation/memory-view.mts';
import { createWorkerApp } from '../../src/app/server.mts';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
const directory = (t: NodeTestContext) => {
  const dir = fs.mkdtempSync(path.join(base, 'memory-view-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('read-only memory view returns the actual shared persona and exact effective redacted durable context', (t) => {
  const dir = directory(t),
    memory = new MemoryStore(dir);
  memory.write('identity.md', 'Preference: Chinese.\nBearer fake_private_token_for_memory_only');
  memory.write('working-memory.md', 'Current project: PRIVATE_VAULT_VALUE');
  fs.writeFileSync(path.join(dir, 'private-auth.json'), 'PRIVATE_CONFIG_MUST_NOT_BE_READ');
  const before = Object.fromEntries(
      memory.snapshot().map((file) => [file.name, fs.readFileSync(memory.file(file.name))]),
    ),
    engine = {
      store: { state: { conversationId: 'current' } },
      memory,
      redact: (text: string) => text.replaceAll('PRIVATE_VAULT_VALUE', '[redacted]'),
    },
    result = currentMemoryView(engine);
  assert.deepEqual(result, {
    conversationId: 'current',
    readOnly: true,
    identity: { text: DANT_IDENTITY_INSTRUCTIONS },
    memory: { text: engine.redact(memory.context()) },
  });
  assert.match(result.memory.text, /Preference: Chinese/);
  assert.match(result.memory.text, /identity.md/);
  assert.match(result.memory.text, /working-memory.md/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /fake_private_token|PRIVATE_VAULT_VALUE|PRIVATE_CONFIG/,
  );
  for (const [name, bytes] of Object.entries(before))
    assert.deepEqual(fs.readFileSync(memory.file(name)), bytes);
});

test('memory view API is authenticated and read-only without running or modifying tasks', async (t) => {
  const dir = directory(t);
  class Worker extends TracingWorkerFixture {
    methods: string[];
    constructor() {
      super();
      this.status = 'offline';
      this.methods = [];
      this.rpc = Object.assign(new RpcFixture(), { reply() {}, send() {} });
    }
    async request(method: string): Promise<never> {
      this.methods.push(method);
      throw Error('No VM operation expected');
    }
    disconnect() {}
  }
  const worker = new Worker(),
    instance = createWorkerApp({
      dataDir: dir,
      workerFactory: () => worker,
      voiceFactory: () =>
        Object.assign(new VoiceFixture(), { state: { available: false }, close: async () => {} }),
      nativeVoiceFactory: () =>
        Object.assign(new NativeVoiceFixture(), { ownsEvent: () => false, close: async () => {} }),
    });
  t.after(() => instance.close());
  instance.engine.memory.write('identity.md', 'Actual personality preference');
  instance.engine.memory.write('working-memory.md', 'Actual durable project');
  const before = fs.readFileSync(instance.store.file);
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', () => resolve()));
  const root = 'http://127.0.0.1:' + listeningPort(instance.server),
    session = await fetch(root + '/api/session').then(async (response) =>
      observedRecord(await response.json()),
    ),
    token = fixtureString(session.token),
    headers = { 'X-Dant-Token': token };
  assert.equal((await fetch(root + '/api/memory/view')).status, 401);
  assert.equal(
    (
      await fetch(root + '/api/memory/view', {
        headers: { ...headers, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  const response = await fetch(root + '/api/memory/view?name=private-auth.json', { headers }),
    body = observedRecord(await response.json());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(observedRecord(body.identity).text, DANT_IDENTITY_INSTRUCTIONS);
  assert.match(fixtureString(observedRecord(body.memory).text), /Actual personality preference/);
  assert.match(fixtureString(observedRecord(body.memory).text), /Actual durable project/);
  assert.deepEqual(Object.keys(body).sort(), ['conversationId', 'identity', 'memory', 'readOnly']);
  for (const method of ['POST', 'PATCH', 'DELETE'])
    assert.equal((await fetch(root + '/api/memory/view', { method, headers })).status, 405);
  assert.deepEqual(fs.readFileSync(instance.store.file), before);
  assert.deepEqual(worker.methods, []);
  instance.engine.memory.context = () => {
    throw Error('PRIVATE_PATH_AND_TOKEN');
  };
  const failed = await fetch(root + '/api/memory/view', { headers });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /PRIVATE_PATH_AND_TOKEN/);
});
