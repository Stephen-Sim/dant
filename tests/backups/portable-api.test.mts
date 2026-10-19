import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createControllerApp } from '../../src/app/controller.mts';
import { ControllerBackups } from '../../src/backups/controller-backups.mts';
import { createWorkerBackup } from '../../src/backups/worker-archive.mts';
import { isRecord } from '../../src/contracts/json.mts';
import { defined } from '../support/fixture-assertions.mts';
import {
  ControllerBridgeFixture,
  ProvisioningFixture,
  listeningPort,
} from '../support/service-fixtures.mts';

const PASSPHRASE = 'isolated cross-computer backup password';
async function account(t: TestContext) {
  const parent = path.resolve('.cache/tests');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'portable-api-'));
  const keys = new Map<string, string>();
  let backups: ControllerBackups | undefined;
  const bridge = new ControllerBridgeFixture();
  let requests = 0;
  bridge.request = async () => {
    requests++;
    throw Error('No VM requests are authorized by portable transfer');
  };
  bridge.close = () => {};
  const provisioning = new ProvisioningFixture();
  provisioning.snapshot = () => ({ status: 'idle', running: false });
  provisioning.close = () => {};
  const app = createControllerApp({
    dataDir: directory,
    projectRoot: path.resolve('.'),
    bridgeFactory: () => bridge,
    provisioningFactory: () => provisioning,
    profileOptions: {
      includeProject: false,
      registryFile: path.join(directory, 'profiles.json'),
      candidateDirs: [],
      env: {},
    },
    backupFactory: (options) => {
      backups = new ControllerBackups({
        ...options,
        automatic: false,
        protection: {
          protect: async (key) => {
            const id = randomUUID();
            keys.set(id, key);
            return Buffer.from(id);
          },
          unprotect: async (bytes) => defined(keys.get(bytes.toString())),
        },
      });
      return backups;
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${listeningPort(app.server)}`;
  const session: unknown = await (await fetch(base + '/api/session')).json();
  assert.ok(isRecord(session) && typeof session.token === 'string');
  return {
    app,
    bridge,
    requests: () => requests,
    directory,
    base,
    backups: defined(backups),
    token: session.token,
  };
}
async function seed(t: TestContext, f: Awaited<ReturnType<typeof account>>) {
  const dataDir = path.join(f.directory, 'source-data');
  const workspaceRoot = path.join(f.directory, 'source-workspace');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({ conversationId: 'portable-conversation', messages: [], workTasks: [] }),
  );
  fs.writeFileSync(path.join(workspaceRoot, 'project.ts'), 'export const project = true;\n');
  const source = createWorkerBackup({
    dataDir,
    workspaceRoot,
    sourceId: 'a'.repeat(64),
    appVersion: '0.4.7-beta.9',
  });
  t.after(() => source.cleanup());
  const metadata = { ...source.metadata, id: randomUUID(), source: 'a'.repeat(12) };
  await f.backups.vault.save(source.stream, metadata);
  source.cleanup();
  return metadata;
}

test('authenticated portable files migrate between independent offline Controllers without restoring a VM', async (t) => {
  const a = await account(t),
    b = await account(t),
    metadata = await seed(t, a);
  const exportUrl = `${a.base}/api/backups/${metadata.id}/export`;
  assert.equal(
    (
      await fetch(exportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: PASSPHRASE }),
      })
    ).status,
    401,
  );
  const exported = await fetch(exportUrl, {
    method: 'POST',
    headers: { 'X-Dant-Token': a.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: PASSPHRASE }),
  });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition') ?? '', /\.dant"$/);
  const bytes = Buffer.from(await exported.arrayBuffer());
  assert.equal(bytes.includes(Buffer.from('export const project')), false);
  const rejected = await fetch(`${b.base}/api/backups/import`, {
    method: 'POST',
    headers: {
      'X-Dant-Token': b.token,
      'Content-Type': 'application/octet-stream',
      'X-Dant-Backup-Passphrase': Buffer.from('a different isolated password').toString('base64'),
    },
    body: bytes,
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(b.backups.vault.list(), []);
  assert.equal(b.backups.busy, false);
  assert.equal(b.backups.phase, 'failed');
  const imported = await fetch(`${b.base}/api/backups/import`, {
    method: 'POST',
    headers: {
      'X-Dant-Token': b.token,
      'Content-Type': 'application/octet-stream',
      'X-Dant-Backup-Passphrase': Buffer.from(PASSPHRASE).toString('base64'),
    },
    body: bytes,
  });
  assert.equal(imported.status, 201, await imported.clone().text());
  const value: unknown = await imported.json();
  assert.ok(isRecord(value) && isRecord(value.backup));
  assert.equal(value.backup.id, metadata.id);
  assert.equal(b.backups.vault.list()[0]?.id, metadata.id);
  assert.equal(b.backups.lastRestoredId, null);
  assert.equal(b.backups.phase, 'idle');
  assert.equal(b.requests(), 0);
  const snapshot = await b.backups.vault.open(metadata.id);
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of snapshot.stream()) chunks.push(Buffer.from(chunk));
  } finally {
    await snapshot.close();
  }
  assert.match(Buffer.concat(chunks).toString(), /project\.ts/);
});

test('portable HTTP rejects malformed password headers and unknown export fields without admitting a transfer', async (t) => {
  const f = await account(t),
    metadata = await seed(t, f);
  for (const header of ['!', Buffer.from([255]).toString('base64'), '']) {
    const response = await fetch(`${f.base}/api/backups/import`, {
      method: 'POST',
      headers: {
        'X-Dant-Token': f.token,
        'Content-Type': 'application/octet-stream',
        'X-Dant-Backup-Passphrase': header,
      },
      body: Buffer.from('invalid'),
    });
    assert.equal(response.status, 400);
  }
  const response = await fetch(`${f.base}/api/backups/${metadata.id}/export`, {
    method: 'POST',
    headers: { 'X-Dant-Token': f.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: PASSPHRASE, path: '../private' }),
  });
  assert.equal(response.status, 400);
  assert.equal(f.backups.vault.list().length, 1);
  assert.equal(f.backups.busy, false);
});
