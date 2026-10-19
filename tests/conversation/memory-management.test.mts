import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkerApp } from '../../src/app/server.mts';
import { MemoryStore } from '../../src/conversation/memory.mts';
import { VoiceKeyStore } from '../../src/security/secrets.mts';
import { ConnectionStatus, MemoryEntryStatus } from '../../src/contracts/states.mts';
import {
  WorkerServiceFixture,
  listeningPort,
  observedRecord,
  observedRecords,
} from '../support/service-fixtures.mts';
async function fixture(t: TestContext) {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(base, 'memory-management-')),
    worker = new WorkerServiceFixture();
  worker.status = ConnectionStatus.Offline;
  worker.error = null;
  worker.rpc = null;
  worker.models = null;
  worker.workspaceRoot = path.join(dataDir, 'workspaces');
  worker.disconnect = () => {};
  const app = createWorkerApp({
    dataDir,
    workerFactory: () => worker,
    secretFactory: (dir) => new VoiceKeyStore(dir, { env: {}, platform: 'linux' }),
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${listeningPort(app.server)}`,
    session = observedRecord(await fetch(url + '/api/session').then((response) => response.json())),
    token = session.token;
  assert.equal(typeof token, 'string');
  const headers = { 'X-Dant-Token': String(token), 'Content-Type': 'application/json' };
  const read = async (query = '') =>
    observedRecord(
      await fetch(url + '/api/memory/manage' + query, { headers }).then((response) =>
        response.json(),
      ),
    );
  return { ...app, dataDir, url, headers, read, memory: app.engine.memory };
}

test('SQLite management searches FTS records, edits with CAS, requires explicit confirmation and deletes durably', async (t) => {
  const f = await fixture(t),
    memory = f.memory;
  memory.write('identity.md', 'Prefer TypeScript for desktop applications');
  const candidate = memory.proposeEntry({
    kind: 'semantic',
    text: 'Use SQLite for durable storage',
    source: { kind: 'user' },
  });
  memory.confirmEntry(candidate.id);
  const taskBefore = JSON.stringify(f.store.state.workTasks),
    first = await f.read('?q=SQLite');
  assert.equal(first.storage, 'sqlite');
  assert.ok(observedRecords(first.records).some((record) => record.id === candidate.id));
  const route = f.url + '/api/memory/manage/semantic/' + candidate.id,
    edited = await fetch(route, {
      method: 'PATCH',
      headers: f.headers,
      body: JSON.stringify({
        conversationId: f.store.state.conversationId,
        revision: first.revision,
        text: 'Use PostgreSQL for this project',
      }),
    });
  assert.equal(edited.status, 200);
  assert.equal(
    memory.listEntries().find((entry) => entry.id === candidate.id)?.status,
    MemoryEntryStatus.Candidate,
  );
  assert.equal(
    memory.search('SQLite').some((entry) => entry.id === candidate.id),
    false,
  );
  assert.equal(
    memory.search('PostgreSQL').some((entry) => entry.id === candidate.id),
    false,
    'editing must not silently confirm a fact',
  );
  const stale = await fetch(route, {
    method: 'DELETE',
    headers: f.headers,
    body: JSON.stringify({
      conversationId: f.store.state.conversationId,
      revision: first.revision,
    }),
  });
  assert.equal(stale.status, 409);
  const current = await f.read('?q=PostgreSQL');
  assert.ok(observedRecords(current.records).some((record) => record.id === candidate.id));
  const confirmed = await fetch(route + '/confirm', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({
      conversationId: f.store.state.conversationId,
      revision: current.revision,
    }),
  });
  assert.equal(confirmed.status, 200);
  assert.ok(memory.search('PostgreSQL').some((entry) => entry.id === candidate.id));
  const beforeDelete = await f.read(),
    removed = await fetch(route, {
      method: 'DELETE',
      headers: f.headers,
      body: JSON.stringify({
        conversationId: f.store.state.conversationId,
        revision: beforeDelete.revision,
      }),
    });
  assert.equal(removed.status, 200);
  const reopened = new MemoryStore(f.dataDir);
  try {
    assert.equal(
      reopened.listEntries().some((entry) => entry.id === candidate.id),
      false,
    );
    assert.equal(reopened.search('PostgreSQL').length, 0);
  } finally {
    reopened.close();
  }
  assert.equal(JSON.stringify(f.store.state.workTasks), taskBefore);
  assert.equal(f.engine.active, null);
  assert.deepEqual(f.engine.queue, []);
});

test('logical documents are edited in SQLite and clearing does not remove their document identity', async (t) => {
  const f = await fixture(t),
    before = await f.read(),
    route = f.url + '/api/memory/manage/note/working-memory.md';
  const edit = await fetch(route, {
    method: 'PATCH',
    headers: f.headers,
    body: JSON.stringify({
      conversationId: before.conversationId,
      revision: before.revision,
      text: 'A durable architecture decision',
    }),
  });
  assert.equal(edit.status, 200);
  assert.equal(f.memory.read('working-memory.md'), 'A durable architecture decision');
  assert.equal(f.store.state.memory, 'A durable architecture decision');
  assert.ok(f.memory.search('architecture').some((item) => item.id === 'working-memory.md'));
  const next = await f.read(),
    clear = await fetch(route, {
      method: 'DELETE',
      headers: f.headers,
      body: JSON.stringify({ conversationId: next.conversationId, revision: next.revision }),
    });
  assert.equal(clear.status, 200);
  assert.equal(f.memory.read('working-memory.md'), '');
  assert.ok(f.memory.snapshot().some((item) => item.name === 'working-memory.md'));
  assert.equal(f.memory.search('architecture').length, 0);
});

test('management preserves scopes, rejects forged revisions and sensitive text, and never exposes redacted values', async (t) => {
  const f = await fixture(t),
    conversationId = f.store.state.conversationId,
    foreign = f.memory.proposeEntry({
      kind: 'episodic',
      text: 'other private project event',
      source: { kind: 'task', conversationId: 'other-conversation', workId: 'other-work' },
    });
  for (const conversation of [conversationId, 'other-conversation'])
    f.memory.writeProject(conversation, 'project-' + conversation, {
      version: 1,
      updatedAt: 1000,
      originalRequest: {
        messageId: 'source',
        at: 1000,
        text: 'unique project search phrase',
        attachments: [],
      },
      humanUpdates: [],
      results: [],
    });
  const view = await f.read('?q=unique');
  assert.equal(observedRecords(view.projects).length, 1);
  assert.equal(observedRecords(view.projects)[0]?.workId, 'project-' + conversationId);
  assert.equal(
    observedRecords((await f.read()).records).some((item) => item.id === foreign.id),
    false,
  );
  assert.equal((await fetch(f.url + '/api/memory/manage')).status, 401);
  const base = await f.read(),
    route = f.url + '/api/memory/manage/note/identity.md';
  for (const body of [
    { conversationId: 'forged', revision: base.revision, text: 'wrong scope' },
    { conversationId, revision: base.revision, text: 'password=private-credential-value' },
    { conversationId, revision: base.revision, text: 'safe', source: { kind: 'user' } },
  ])
    assert.equal(
      (await fetch(route, { method: 'PATCH', headers: f.headers, body: JSON.stringify(body) }))
        .status,
      400,
    );
  const blocked = await fetch(f.url + '/api/memory/manage/episodic/' + foreign.id, {
    method: 'DELETE',
    headers: f.headers,
    body: JSON.stringify({ conversationId, revision: base.revision }),
  });
  assert.equal(blocked.status, 400);
  assert.ok(f.memory.listEntries().some((entry) => entry.id === foreign.id));
  f.memory.write('identity.md', 'Known value PRIVATE_VAULT_VALUE');
  const redact = f.engine.redact.bind(f.engine);
  t.mock.method(f.engine, 'redact', (text: unknown) =>
    redact(text).replaceAll('PRIVATE_VAULT_VALUE', '[redacted]'),
  );
  const redacted = await f.read(),
    record = observedRecords(redacted.records).find((item) => item.id === 'identity.md');
  assert.equal(record?.redacted, true);
  assert.doesNotMatch(JSON.stringify(redacted), /PRIVATE_VAULT_VALUE/);
  assert.equal(
    (
      await fetch(route, {
        method: 'PATCH',
        headers: f.headers,
        body: JSON.stringify({
          conversationId,
          revision: redacted.revision,
          text: 'replace redacted content',
        }),
      })
    ).status,
    400,
  );
});

test('management validates query and mutation boundaries and cannot implicitly replace conflicting confirmed facts', async (t) => {
  const f = await fixture(t),
    conversationId = f.store.state.conversationId;
  for (const query of [
    '?offset=-1',
    '?offset=0.5',
    '?q=' + 'x'.repeat(257),
    '?q=%00',
    '?q[]=bad',
    '?offset[]=0',
  ])
    assert.equal(
      (await fetch(f.url + '/api/memory/manage' + query, { headers: f.headers })).status,
      400,
    );
  const confirmed = f.memory.proposeEntry({
    kind: 'semantic',
    key: 'editor',
    text: 'Prefer one editor',
    source: { kind: 'user' },
  });
  f.memory.confirmEntry(confirmed.id);
  const conflict = f.memory.proposeEntry({
    kind: 'semantic',
    key: 'editor',
    text: 'Prefer a different editor',
    source: { kind: 'inference' },
  });
  const view = await f.read(),
    body = JSON.stringify({ conversationId, revision: view.revision });
  assert.equal(
    (
      await fetch(f.url + '/api/memory/manage/semantic/' + conflict.id + '/confirm', {
        method: 'POST',
        headers: f.headers,
        body,
      })
    ).status,
    400,
  );
  assert.equal(
    f.memory.listEntries().find((entry) => entry.id === confirmed.id)?.status,
    MemoryEntryStatus.Confirmed,
  );
  const remove = await fetch(f.url + '/api/memory/manage/semantic/' + confirmed.id, {
    method: 'DELETE',
    headers: f.headers,
    body,
  });
  assert.equal(remove.status, 200);
  const reconciled = await f.read();
  assert.equal(
    (
      await fetch(f.url + '/api/memory/manage/semantic/' + conflict.id + '/confirm', {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify({ conversationId, revision: reconciled.revision }),
      })
    ).status,
    200,
  );
  const rejectedBody = JSON.stringify({ conversationId, revision: (await f.read()).revision });
  for (const route of ['/note/README.md', '/project/work-id', '/semantic/missing-id'])
    assert.equal(
      (
        await fetch(f.url + '/api/memory/manage' + route, {
          method: 'DELETE',
          headers: f.headers,
          body: rejectedBody,
        })
      ).status,
      400,
    );
  t.mock.method(f.memory, 'managementSnapshot', () => {
    throw Error('PRIVATE_FILESYSTEM_PATH');
  });
  const failed = await fetch(f.url + '/api/memory/manage', { headers: f.headers });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /PRIVATE_FILESYSTEM_PATH/);
});
