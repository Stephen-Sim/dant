import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renameAtomicFileSync } from '../../src/files/atomic-file-rename.mts';

function fixture(t: NodeTestContext, { target = true } = {}) {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'atomic-rename-'));
  const directory = path.join(root, 'data');
  fs.mkdirSync(directory);
  const source = path.join(directory, 'record.json.tmp');
  const destination = path.join(directory, 'record.json');
  fs.writeFileSync(source, 'replacement');
  if (target) fs.writeFileSync(destination, 'previous');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, source, destination };
}

test('atomic file replacement retries only transient Windows rename failures with an increasing bounded delay', (t) => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const f = fixture(t);
    let attempts = 0;
    const waits: number[] = [];
    renameAtomicFileSync(f.source, f.destination, {
      platform: 'win32',
      renameSync(from, to) {
        attempts++;
        if (attempts <= 2) throw Object.assign(Error('Transient fixture lock'), { code });
        fs.renameSync(from, to);
      },
      pause: (delay) => waits.push(delay),
    });
    assert.ok(attempts >= 3 && attempts <= 6);
    assert.deepEqual(
      waits,
      Array.from({ length: attempts - 1 }, (_, index) => (index + 1) * 10),
    );
    assert.equal(fs.existsSync(f.source), false);
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'replacement');
  }
});

test('atomic file replacement preserves the actual final failure, stops after six attempts, and does not retry other platforms or errors', (t) => {
  for (const [platform, code, expected] of [
    ['win32', 'EPERM', 6],
    ['win32', 'EACCES', 6],
    ['win32', 'EBUSY', 6],
    ['linux', 'EPERM', 1],
    ['darwin', 'EACCES', 1],
    ['win32', 'ENOSPC', 1],
    ['win32', undefined, 1],
  ] as const) {
    const f = fixture(t);
    const failure = Object.assign(Error('Original fixture error'), { code });
    let attempts = 0;
    const waits: number[] = [];
    assert.throws(
      () =>
        renameAtomicFileSync(f.source, f.destination, {
          platform,
          renameSync: () => {
            attempts++;
            throw failure;
          },
          pause: (delay) => waits.push(delay),
        }),
      (error) => error === failure,
    );
    assert.equal(attempts, expected);
    assert.deepEqual(
      waits,
      Array.from({ length: expected - 1 }, (_, index) => (index + 1) * 10),
    );
    assert.equal(fs.readFileSync(f.source, 'utf8'), 'replacement');
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'previous');
  }
});

test('a failed rename that already changed the files is not replayed or treated as a confirmed save', (t) => {
  const f = fixture(t);
  const failure = Object.assign(Error('Outcome unconfirmed'), { code: 'EPERM' });
  let attempts = 0;
  assert.throws(
    () =>
      renameAtomicFileSync(f.source, f.destination, {
        platform: 'win32',
        renameSync(from, to) {
          attempts++;
          fs.renameSync(from, to);
          throw failure;
        },
        pause: () => assert.fail('An unconfirmed rename must not be replayed'),
      }),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'replacement');
});

test('source, target, presence, hard-link and parent changes during a retry delay preserve the original error and stop before another rename', (t) => {
  for (const change of [
    'source-content',
    'source-replaced',
    'source-removed',
    'source-link',
    'target-content',
    'target-replaced',
    'target-removed',
    'target-link',
    'target-appeared',
    'parent',
  ]) {
    const f = fixture(t, { target: change !== 'target-appeared' });
    const failure = Object.assign(Error('Original sharing lock'), { code: 'EPERM' });
    let attempts = 0;
    assert.throws(
      () =>
        renameAtomicFileSync(f.source, f.destination, {
          platform: 'win32',
          renameSync: () => {
            attempts++;
            throw failure;
          },
          pause() {
            if (change === 'source-content') fs.appendFileSync(f.source, ' changed');
            if (change === 'source-replaced') {
              fs.renameSync(f.source, f.source + '.previous');
              fs.writeFileSync(f.source, 'replacement');
            }
            if (change === 'source-removed') fs.unlinkSync(f.source);
            if (change === 'source-link') fs.linkSync(f.source, path.join(f.root, 'source-link'));
            if (change === 'target-content') fs.appendFileSync(f.destination, ' changed');
            if (change === 'target-replaced') {
              fs.renameSync(f.destination, f.destination + '.previous');
              fs.writeFileSync(f.destination, 'previous');
            }
            if (change === 'target-removed') fs.unlinkSync(f.destination);
            if (change === 'target-link')
              fs.linkSync(f.destination, path.join(f.root, 'target-link'));
            if (change === 'target-appeared') fs.writeFileSync(f.destination, 'new owner');
            if (change === 'parent') {
              fs.renameSync(f.directory, path.join(f.root, 'original-data'));
              fs.mkdirSync(f.directory);
              fs.writeFileSync(f.source, 'replacement');
              fs.writeFileSync(f.destination, 'previous');
            }
          },
        }),
      (error) => error === failure,
      change,
    );
    assert.equal(attempts, 1, change);
  }
});

test('atomic file replacement rejects invalid input paths before a rename and supports a new destination', (t) => {
  const f = fixture(t, { target: false });
  renameAtomicFileSync(f.source, f.destination);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'replacement');
  fs.writeFileSync(f.source, 'next');
  const renameSync = () => assert.fail('Unsafe paths must not reach rename');
  for (const [source, destination] of [
    [f.source, f.source],
    [f.source, path.join(f.root, 'other.json')],
    [f.source + '\0', f.destination],
    [f.source, f.destination + '\0'],
  ] as const)
    assert.throws(() => renameAtomicFileSync(source, destination, { renameSync }), {
      code: 'ERR_ATOMIC_RENAME_UNSAFE',
    });
});

test('a stable linked ancestor preserves the first real rename and disables retries when a Windows lock is reported', (t) => {
  const f = fixture(t);
  const linkedDirectory = path.join(f.root, 'linked-data');
  fs.symlinkSync(f.directory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  const source = path.join(linkedDirectory, 'record.json.tmp');
  const destination = path.join(linkedDirectory, 'record.json');
  let attempts = 0;
  renameAtomicFileSync(source, destination, {
    platform: 'win32',
    renameSync(from, to) {
      attempts++;
      assert.equal(from, source);
      assert.equal(to, destination);
      fs.renameSync(from, to);
    },
    pause: () => assert.fail('An unconfirmed linked path must never be retried'),
  });
  assert.equal(attempts, 1);
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'replacement');

  fs.writeFileSync(f.source, 'next');
  attempts = 0;
  const failure = Object.assign(Error('Original linked-path lock'), { code: 'EPERM' });
  assert.throws(
    () =>
      renameAtomicFileSync(source, destination, {
        platform: 'win32',
        renameSync(from, to) {
          attempts++;
          assert.equal(from, source);
          assert.equal(to, destination);
          throw failure;
        },
        pause: () => assert.fail('An unconfirmed linked path must never be retried'),
      }),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'next');
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'replacement');
});

test('invalid initial file identities remain rejected before the first rename', (t) => {
  for (const kind of [
    'missing-source',
    'source-directory',
    'source-link',
    'target-link',
    'target-directory',
  ]) {
    const f = fixture(t);
    let source = f.source;
    if (kind === 'missing-source') source = path.join(f.directory, 'missing');
    if (kind === 'source-directory') {
      source = path.join(f.directory, 'source-directory');
      fs.mkdirSync(source);
    }
    if (kind === 'source-link') fs.linkSync(source, path.join(f.root, 'source-link'));
    if (kind === 'target-link') fs.linkSync(f.destination, path.join(f.root, 'target-link'));
    if (kind === 'target-directory') {
      fs.unlinkSync(f.destination);
      fs.mkdirSync(f.destination);
    }
    assert.throws(
      () =>
        renameAtomicFileSync(source, f.destination, {
          platform: 'win32',
          renameSync: () => assert.fail('Invalid files must not reach rename'),
          pause: () => assert.fail('Invalid files must never be retried'),
        }),
      { code: 'ERR_ATOMIC_RENAME_UNSAFE' },
      kind,
    );
  }
});
