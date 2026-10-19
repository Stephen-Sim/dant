import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createControllerApp } from '../../src/app/controller.mts';
import { ControllerBackups } from '../../src/backups/controller-backups.mts';
import type { BackupTarget, BackupTransport } from '../../src/backups/controller-backups.mts';
import { BackupPhase, ConnectionStatus } from '../../src/contracts/states.mts';
import { isRecord } from '../../src/contracts/json.mts';
import {
  ControllerBridgeFixture,
  ProvisioningFixture,
  listeningPort,
} from '../support/service-fixtures.mts';

class Bridge extends ControllerBridgeFixture {
  override status = ConnectionStatus.Offline;
  override generation = 1;
  override async refresh() {
    return this.cached;
  }
  override close() {}
  override disconnect() {
    this.status = ConnectionStatus.Offline;
  }
}
class Provisioning extends ProvisioningFixture {
  override snapshot() {
    return { status: 'idle', running: false };
  }
  override close() {}
}
async function fixture(t: TestContext) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'backup-api-'));
  let restored = false,
    failRestore = false,
    exports = 0,
    restores = 0;
  const target: BackupTarget = {
    identity: 'a'.repeat(64),
    generation: 1,
    online: true,
    supported: true,
    empty: false,
    version: '0.4.7-beta.8',
  };
  const transport: BackupTransport = {
    target: async () => ({ ...target }),
    export: async () => {
      exports++;
      return {
        metadata: { createdAt: Date.now(), appVersion: '0.4.7-beta.8', files: 1, bytes: 7 },
        stream: Readable.from(['fixture']),
        close: async () => {},
      };
    },
    restore: async (stream) => {
      restores++;
      for await (const _chunk of stream) {
        /* Drain the isolated archive. */
      }
      if (failRestore) throw Error('Isolated lost acknowledgement');
      restored = true;
    },
    reconcile: async () => restored,
    rejected: async () => false,
  };
  const app = createControllerApp({
    dataDir: directory,
    projectRoot: path.resolve('.'),
    bridgeFactory: () => new Bridge(),
    provisioningFactory: () => new Provisioning(),
    profileOptions: {
      includeProject: false,
      registryFile: path.join(directory, 'profiles.json'),
      candidateDirs: [],
      env: {},
    },
    backupFactory: (options) =>
      new ControllerBackups({
        ...options,
        transport,
        protection: {
          protect: async (value) => Buffer.from(value),
          unprotect: async (value) => value.toString(),
        },
      }),
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${listeningPort(app.server)}`;
  const session: unknown = await (await fetch(base + '/api/session')).json();
  assert.ok(isRecord(session) && typeof session.token === 'string');
  const headers = { 'X-Dant-Token': session.token, 'Content-Type': 'application/json' };
  const api = (route: string, method = 'GET', body?: unknown) =>
    fetch(base + route, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    app,
    api,
    base,
    failRestore: () => {
      failRestore = true;
    },
    counts: () => ({ exports, restores }),
  };
}
async function backup(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await f.api('/api/backups/run', 'POST', {})).status, 202);
  await f.app.backups.pending;
  const status: unknown = await (await f.api('/api/backups')).json();
  assert.ok(
    isRecord(status) &&
      Array.isArray(status.backups) &&
      isRecord(status.backups[0]) &&
      typeof status.backups[0].id === 'string',
  );
  return status.backups[0].id;
}

test('Controller backup API authenticates every operation and persists manual scheduling preferences', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/backups')).status, 401);
  assert.equal((await fetch(f.base + '/api/backups/run', { method: 'POST' })).status, 401);
  assert.equal(
    (
      await f.api('/api/backups/settings', 'PATCH', {
        mode: 'manual',
        intervalMinutes: 120,
        onConnect: false,
        beforeVmChange: false,
      })
    ).status,
    200,
  );
  const invalid = await f.api('/api/backups/settings', 'PATCH', { intervalMinutes: '120' });
  assert.equal(invalid.status, 400);
  const status: unknown = await (await f.api('/api/backups')).json();
  assert.ok(isRecord(status) && isRecord(status.settings));
  assert.equal(status.settings.mode, 'manual');
  assert.equal(status.settings.intervalMinutes, 120);
  assert.deepEqual(f.counts(), { exports: 0, restores: 0 });
});

test('Controller HTTP backup and explicit preview restore expose bounded metadata and confirm asynchronously', async (t) => {
  const f = await fixture(t),
    id = await backup(f);
  assert.equal(
    (await f.api(`/api/backups/${id}/restore`, 'POST', { confirmation: 'missing-preview' })).status,
    409,
  );
  const preview: unknown = await (await f.api(`/api/backups/${id}/preview`, 'POST', {})).json();
  assert.ok(
    isRecord(preview) && typeof preview.confirmation === 'string' && isRecord(preview.target),
  );
  assert.equal(preview.target.id, 'a'.repeat(12));
  assert.equal(
    (await f.api(`/api/backups/${id}/restore`, 'POST', { confirmation: preview.confirmation }))
      .status,
    202,
  );
  await f.app.backups.pending;
  const status: unknown = await (await f.api('/api/backups')).json();
  assert.ok(isRecord(status));
  assert.equal(status.phase, BackupPhase.Idle);
  assert.equal(status.lastRestoredId, id);
  assert.deepEqual(f.counts(), { exports: 1, restores: 1 });
});

test('an unconfirmed HTTP restore fences model input, VM changes and installers without replay', async (t) => {
  const f = await fixture(t),
    id = await backup(f);
  const preview: unknown = await (await f.api(`/api/backups/${id}/preview`, 'POST', {})).json();
  assert.ok(isRecord(preview));
  f.failRestore();
  assert.equal(
    (await f.api(`/api/backups/${id}/restore`, 'POST', { confirmation: preview.confirmation }))
      .status,
    202,
  );
  await f.app.backups.pending;
  for (const [route, method, body] of [
    ['/api/messages', 'POST', { text: 'This must not execute' }],
    ['/api/settings', 'PATCH', { vm: { host: '192.0.2.100' } }],
    ['/api/connect', 'POST', {}],
    ['/api/desktop/exit', 'POST', {}],
    ['/api/updates/install-lease', 'POST', {}],
  ] as const) {
    const response = await f.api(route, method, body);
    assert.equal(response.status, 409);
  }
  assert.equal((await f.api('/api/backups/run', 'POST', {})).status, 409);
  assert.deepEqual(f.counts(), { exports: 1, restores: 1 });
});
