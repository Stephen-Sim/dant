import { defined } from '../support/fixture-assertions.mts';
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CredentialVault, CredentialRequests } from '../../src/security/credentials.mts';
const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
function setup(t: NodeTestContext) {
  const dir = fs.mkdtempSync(path.join(base, 'credentials-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = new CredentialVault({ dataDir: dir });
  return { dir, vault };
}
test('vault encrypts values, restarts, updates without revealing old secrets, and removes credentials', (t) => {
  const { dir, vault } = setup(t);
  assert.deepEqual(vault.list(), []);
  const secret = 'a-private-password-for-this-test',
    item = vault.upsert({ name: 'Work', service: 'work.example', username: 'me', secret });
  assert.equal('secret' in item, false);
  assert.equal(JSON.stringify(vault).includes(secret), false);
  assert.equal(fs.readFileSync(vault.file, 'utf8').includes(secret), false);
  assert.equal(fs.statSync(vault.keyFile).size, 32);
  const reopened = new CredentialVault({ dataDir: dir });
  assert.equal(reopened.get(item.id).secret, secret);
  assert.equal(defined(reopened.find('WORK')[0]).id, item.id);
  assert.equal(reopened.find('other').length, 0);
  const edited = reopened.upsert({ id: item.id, name: 'Work login' });
  assert.equal(edited.name, 'Work login');
  assert.equal(reopened.get(item.id).secret, secret);
  reopened.upsert({ id: item.id, secret: 'replacement-private-value' });
  assert.equal(reopened.get(item.id).secret, 'replacement-private-value');
  assert.equal(reopened.containsSecret('value replacement-private-value'), true);
  assert.equal(reopened.redact('value replacement-private-value'), 'value [credential redacted]');
  assert.equal(reopened.remove(item.id).removed, true);
  assert.deepEqual(reopened.list(), []);
  assert.throws(() => reopened.get(item.id), /not found/);
});
test('vault rejects invalid entries and preserves encrypted data on corruption or a missing master key', (t) => {
  const { vault } = setup(t);
  for (const value of [
    null,
    [],
    {},
    { name: 'Name', secret: '' },
    { name: 'Name', secret: 'x'.repeat(16385) },
    { name: 'Name', secret: 'valid', username: '\0' },
  ])
    assert.throws(() => vault.upsert(value));
  assert.throws(() => vault.get('../key'));
  assert.throws(() => vault.find(42));
  assert.throws(() => vault.remove('invalid'));
  assert.throws(
    () => vault.upsert({ id: '00000000-0000-0000-0000-000000000000', name: 'x', secret: 'x' }),
    /not found/,
  );
  const item = vault.upsert({ name: 'Safe', secret: 'test-secret' }),
    saved = fs.readFileSync(vault.file);
  fs.unlinkSync(vault.keyFile);
  assert.throws(() => vault.list(), /cannot be unlocked/);
  assert.deepEqual(fs.readFileSync(vault.file), saved);
  assert.throws(() => vault.upsert({ id: item.id, secret: 'changed' }));
  fs.writeFileSync(vault.keyFile, Buffer.alloc(32), { mode: 0o600 });
  assert.throws(() => vault.list());
  assert.deepEqual(fs.readFileSync(vault.file), saved);
});
test('vault refuses linked storage and limits entry count', (t) => {
  const { vault } = setup(t);
  for (let index = 0; index < 100; index++)
    vault.upsert({ name: 'Entry ' + index, secret: 'secret-' + index });
  assert.throws(() => vault.upsert({ name: 'overflow', secret: 'secret' }), /full/);
  assert.equal(vault.list().length, 100);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(vault.dir).mode & 0o077, 0);
    assert.equal(fs.statSync(vault.keyFile).mode & 0o077, 0);
    fs.chmodSync(vault.file, 0o644);
    assert.throws(() => vault.list());
  }
});
test('credential secure forms save and resume exactly once, never expose secrets in snapshots', async (t) => {
  const { vault } = setup(t),
    events: ReturnType<CredentialRequests['snapshot']>[] = [],
    requests = new CredentialRequests({ vault, change: () => events.push(requests.snapshot()) });
  let current = true;
  const pending = requests.request(
      { name: 'Example', service: 'example.test', reason: 'Sign in to do the requested work' },
      { owner: 'turn', isCurrent: () => current },
    ),
    again = requests.request(
      { name: 'Example', service: 'example.test' },
      { owner: 'turn', isCurrent: () => current },
    );
  assert.equal(pending, again);
  const id = defined(requests.snapshot().requests[0]).id;
  assert.equal(Object.hasOwn(defined(requests.snapshot().requests[0]), 'owner'), false);
  assert.throws(() => requests.fulfill(id, { secret: '' }));
  assert.equal(requests.snapshot().requests.length, 1);
  const result = requests.fulfill(id, { username: 'test', secret: 'not-in-chat-value' });
  assert.equal(result.stored, true);
  assert.equal((await pending).credential.id, result.credential.id);
  assert.equal(JSON.stringify(events).includes('not-in-chat-value'), false);
  assert.equal(requests.get(result.credential.id).secret, 'not-in-chat-value');
  assert.equal(requests.find('Example').length, 1);
  assert.equal(requests.containsSecret('not-in-chat-value'), true);
  assert.equal(requests.redact('not-in-chat-value'), '[credential redacted]');
  assert.throws(() => requests.fulfill(id, { secret: 'duplicate' }));
  const next = requests.request(
    { name: 'Example', service: 'example.test' },
    { owner: 'turn', isCurrent: () => true },
  );
  requests.fulfill(defined(requests.snapshot().requests[0]).id, {
    username: 'test',
    secret: 'new-value',
  });
  await next;
  assert.equal(vault.list().length, 1);
  current = false;
  requests.close();
});
test('credential forms cancel with owner, timeout, stale operation and shutdown; no secret saved', async (t) => {
  const { vault } = setup(t),
    requests = new CredentialRequests({ vault, timeoutMs: 10 });
  await assert.rejects(requests.request({ name: 'x' }, { owner: 'old', isCurrent: () => false }));
  const pending = requests.request({ name: 'one' }, { owner: 'turn', isCurrent: () => true });
  requests.cancelOwner('other');
  assert.equal(requests.snapshot().requests.length, 1);
  requests.cancelOwner('turn');
  await assert.rejects(pending, /cancelled/);
  let current = true;
  const stale = requests.request({ name: 'stale' }, { owner: 'old', isCurrent: () => current });
  current = false;
  assert.throws(
    () =>
      requests.fulfill(defined(requests.snapshot().requests[0]).id, { secret: 'must-not-save' }),
    /no longer/,
  );
  await assert.rejects(stale);
  assert.equal(vault.list().length, 0);
  const timeout = requests.request({ name: 'timeout' }, { owner: 'turn', isCurrent: () => true });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await assert.rejects(timeout, /cancelled/);
  const closing = requests.request({ name: 'close' }, { owner: 'turn', isCurrent: () => true });
  requests.close();
  await assert.rejects(closing, /cancelled/);
  await assert.rejects(
    requests.request({ name: 'later' }, { owner: 'turn', isCurrent: () => true }),
  );
  assert.deepEqual(requests.snapshot(), { items: [], requests: [] });
});
test('credential request bounds and validation preserve active requests', async (t) => {
  const { vault } = setup(t),
    requests = new CredentialRequests({ vault });
  assert.throws(() => requests.request({ name: '' }, { owner: 'turn', isCurrent: () => true }));
  const pending = [];
  for (let n = 0; n < 10; n++)
    pending.push(
      requests.request({ name: 'entry-' + n }, { owner: 'turn', isCurrent: () => true }),
    );
  await assert.rejects(
    requests.request({ name: 'full' }, { owner: 'turn', isCurrent: () => true }),
    /Too many/,
  );
  assert.throws(() => requests.cancel('missing'));
  requests.close();
  await Promise.allSettled(pending);
  const item = requests.upsert({ name: 'added', secret: 'added-secret' });
  assert.equal(requests.remove(item.id).removed, true);
});

test('credential storage refuses a redirected directory before reading or writing secrets', (t) => {
  const { dir, vault } = setup(t),
    outside = fs.mkdtempSync(path.join(base, 'outside-vault-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(
    outside,
    path.join(dir, 'credentials'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => vault.upsert({ name: 'private', secret: 'must-not-write' }));
  assert.deepEqual(fs.readdirSync(outside), []);
});
