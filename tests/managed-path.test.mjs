import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ordinaryDirectory, renameManaged } from '../src/files/managed-path.mjs';
import { CredentialVault } from '../src/security/credentials.mjs';
import { SkillLibrary } from '../src/skills/skill-library.mjs';
const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
test('managed storage checks all ancestors before creating a nested credential or skill directory', (t) => {
  const root = fs.mkdtempSync(path.join(base, 'managed-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const link = path.join(root, 'redirected');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => ordinaryDirectory(path.join(link, 'new', 'path'), { create: true }),
    /without links/,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.throws(() =>
    new CredentialVault({ dataDir: path.join(link, 'data') }).upsert({
      name: 'test',
      secret: 'synthetic-only',
    }),
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.throws(() =>
    new SkillLibrary({ workspace: path.join(link, 'workspace') }).save({
      name: 'test',
      description: 'test',
      instructions: 'test',
    }),
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  const target = path.join(root, 'ordinary', 'child');
  assert.throws(() => ordinaryDirectory(target));
  assert.equal(ordinaryDirectory(target, { create: true }), target);
  assert.equal(ordinaryDirectory(target), target);
  for (const invalid of ['', null, 'relative', 'nul\0'])
    assert.throws(() => ordinaryDirectory(invalid));
});

test('transient Windows file locks are retried within a fixed bound and other failures remain failures', () => {
  let attempts = 0;
  const pauses = [];
  renameManaged('source', 'destination', {
    platform: 'win32',
    pause: (ms) => pauses.push(ms),
    rename: () => {
      if (++attempts < 3) throw Object.assign(Error('held by scanner'), { code: 'EPERM' });
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(pauses, [20, 40]);
  attempts = 0;
  assert.throws(() =>
    renameManaged('source', 'destination', {
      platform: 'win32',
      pause: () => {},
      rename: () => {
        attempts++;
        throw Object.assign(Error('still held'), { code: 'EBUSY' });
      },
    }),
  );
  assert.equal(attempts, 6);
  attempts = 0;
  assert.throws(() =>
    renameManaged('source', 'destination', {
      platform: 'win32',
      rename: () => {
        attempts++;
        throw Object.assign(Error('invalid'), { code: 'EINVAL' });
      },
    }),
  );
  assert.equal(attempts, 1);
  assert.throws(() =>
    renameManaged('source', 'destination', {
      platform: 'linux',
      rename: () => {
        throw Object.assign(Error('denied'), { code: 'EACCES' });
      },
    }),
  );
});
