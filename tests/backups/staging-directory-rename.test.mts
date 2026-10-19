import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  renamePrivateStagingDirectorySync,
  STAGING_RENAME_ATTEMPTS,
  STAGING_RENAME_DELAY_MS,
} from '../../src/backups/staging-directory-rename.mts';

function fixture(t: TestContext) {
  const base = path.resolve('.cache/tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'private-stage-rename-')),
    sourceGroup = path.join(root, 'validation'),
    targetGroup = path.join(root, 'owned'),
    sourceParent = path.join(sourceGroup, 'decoded'),
    targetParent = path.join(targetGroup, 'data-parent'),
    source = path.join(sourceParent, 'data'),
    destination = path.join(targetParent, 'restore-data.new');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(targetParent, { recursive: true });
  fs.writeFileSync(path.join(source, 'retained.txt'), 'Retained staged bytes');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sourceGroup, targetGroup, sourceParent, targetParent, source, destination };
}

test('private stage moves retry bounded Windows sharing failures while retaining bytes and checking offline on every attempt', (t) => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const f = fixture(t),
      waits: number[] = [];
    let attempts = 0,
      guards = 0;
    renamePrivateStagingDirectorySync(f.source, f.destination, {
      platform: 'win32',
      assertOffline() {
        guards++;
      },
      renameSync(from, to) {
        if (++attempts <= 2) throw Object.assign(Error('Isolated transient lock'), { code });
        fs.renameSync(from, to);
      },
      pause: (delay) => waits.push(delay),
    });
    assert.equal(attempts, 3);
    assert.equal(guards, attempts);
    assert.deepEqual(waits, [STAGING_RENAME_DELAY_MS, STAGING_RENAME_DELAY_MS * 2]);
    assert.equal(fs.existsSync(f.source), false);
    assert.equal(
      fs.readFileSync(path.join(f.destination, 'retained.txt'), 'utf8'),
      'Retained staged bytes',
    );
  }
});

test('exhaustion preserves the last actual error and other platforms or error codes attempt only once', (t) => {
  for (const [platform, code, expected] of [
    ['win32', 'EPERM', STAGING_RENAME_ATTEMPTS],
    ['win32', 'EACCES', STAGING_RENAME_ATTEMPTS],
    ['win32', 'EBUSY', STAGING_RENAME_ATTEMPTS],
    ['linux', 'EPERM', 1],
    ['darwin', 'EACCES', 1],
    ['win32', 'ENOSPC', 1],
    ['win32', undefined, 1],
  ] as const) {
    const f = fixture(t),
      waits: number[] = [];
    let attempts = 0,
      latest: unknown;
    assert.throws(
      () =>
        renamePrivateStagingDirectorySync(f.source, f.destination, {
          platform,
          assertOffline() {},
          renameSync() {
            latest = Object.assign(Error('Actual isolated failure ' + ++attempts), { code });
            throw latest;
          },
          pause: (delay) => waits.push(delay),
        }),
      (error) => error === latest,
    );
    assert.equal(attempts, expected);
    assert.deepEqual(
      waits,
      Array.from({ length: expected - 1 }, (_, index) => STAGING_RENAME_DELAY_MS * (index + 1)),
    );
    assert.equal(
      fs.readFileSync(path.join(f.source, 'retained.txt'), 'utf8'),
      'Retained staged bytes',
    );
    assert.equal(fs.existsSync(f.destination), false);
  }
});

test('replaced, missing, linked or changed staging, new destinations and changed parents stop before another move', (t) => {
  for (const change of [
    'source-replaced',
    'source-removed',
    'source-linked',
    'source-file',
    'source-entry-added',
    'target-directory',
    'target-file',
    'target-linked',
    'source-parent',
    'target-parent',
    'source-ancestor',
    'target-ancestor',
  ] as const) {
    const f = fixture(t),
      failure = Object.assign(Error('Original isolated lock'), { code: 'EPERM' });
    let attempts = 0;
    assert.throws(
      () =>
        renamePrivateStagingDirectorySync(f.source, f.destination, {
          platform: 'win32',
          assertOffline() {},
          renameSync() {
            attempts++;
            throw failure;
          },
          pause() {
            if (
              change.startsWith('source-') &&
              ['source-replaced', 'source-removed', 'source-linked', 'source-file'].includes(change)
            ) {
              fs.renameSync(f.source, f.source + '.retired');
              if (change === 'source-replaced') fs.mkdirSync(f.source);
              if (change === 'source-file') fs.writeFileSync(f.source, 'Different type');
              if (change === 'source-linked')
                fs.symlinkSync(
                  f.source + '.retired',
                  f.source,
                  process.platform === 'win32' ? 'junction' : 'dir',
                );
            }
            if (change === 'source-entry-added')
              fs.writeFileSync(path.join(f.source, 'new.txt'), 'Changed private tree');
            if (change === 'target-directory') fs.mkdirSync(f.destination);
            if (change === 'target-file') fs.writeFileSync(f.destination, 'New owner');
            if (change === 'target-linked')
              fs.symlinkSync(
                f.source,
                f.destination,
                process.platform === 'win32' ? 'junction' : 'dir',
              );
            const parent =
              change === 'source-parent'
                ? f.sourceParent
                : change === 'target-parent'
                  ? f.targetParent
                  : change === 'source-ancestor'
                    ? f.sourceGroup
                    : change === 'target-ancestor'
                      ? f.targetGroup
                      : null;
            if (parent) {
              fs.renameSync(parent, parent + '.retired');
              if (change.startsWith('source-')) fs.mkdirSync(f.source, { recursive: true });
              else fs.mkdirSync(f.targetParent, { recursive: true });
            }
          },
        }),
      (error) => error === failure,
      change,
    );
    assert.equal(attempts, 1, change);
  }
});

test('a move that may already have applied is never retried or reported as confirmed success', (t) => {
  const f = fixture(t),
    failure = Object.assign(Error('Unconfirmed isolated result'), { code: 'EPERM' });
  let attempts = 0;
  assert.throws(
    () =>
      renamePrivateStagingDirectorySync(f.source, f.destination, {
        platform: 'win32',
        assertOffline() {},
        renameSync(from, to) {
          attempts++;
          fs.renameSync(from, to);
          throw failure;
        },
        pause: () => assert.fail('An unconfirmed move must not be repeated'),
      }),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.equal(
    fs.readFileSync(path.join(f.destination, 'retained.txt'), 'utf8'),
    'Retained staged bytes',
  );
});

test('a newly online service stops a pending retry while the first move remains unapplied', (t) => {
  const f = fixture(t),
    offlineFailure = Error('Isolated offline confirmation lost');
  let guards = 0,
    attempts = 0;
  assert.throws(
    () =>
      renamePrivateStagingDirectorySync(f.source, f.destination, {
        platform: 'win32',
        assertOffline() {
          if (++guards > 1) throw offlineFailure;
        },
        renameSync() {
          attempts++;
          throw Object.assign(Error('Isolated sharing lock'), { code: 'EPERM' });
        },
        pause() {},
      }),
    (error) => error === offlineFailure,
  );
  assert.equal(attempts, 1);
  assert.equal(fs.existsSync(f.source), true);
  assert.equal(fs.existsSync(f.destination), false);
});

test('unsafe initial directories, paths, ancestors and occupied targets cannot reach a move', (t) => {
  for (const kind of [
    'source-link',
    'source-file',
    'target-exists',
    'source-parent-link',
    'target-parent-link',
  ] as const) {
    const f = fixture(t);
    if (kind === 'source-link' || kind === 'source-file') {
      fs.renameSync(f.source, f.source + '.retired');
      if (kind === 'source-link')
        fs.symlinkSync(
          f.source + '.retired',
          f.source,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      else fs.writeFileSync(f.source, 'Different type');
    }
    if (kind === 'target-exists') fs.mkdirSync(f.destination);
    const parent =
      kind === 'source-parent-link'
        ? f.sourceParent
        : kind === 'target-parent-link'
          ? f.targetParent
          : null;
    if (parent) {
      fs.renameSync(parent, parent + '.retired');
      fs.symlinkSync(
        parent + '.retired',
        parent,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    assert.throws(
      () =>
        renamePrivateStagingDirectorySync(f.source, f.destination, {
          assertOffline() {},
          renameSync: () => assert.fail('Unsafe staging must not reach rename'),
        }),
      { code: 'ERR_RESTORE_STAGE_CHANGED' },
    );
  }
  const f = fixture(t);
  for (const [from, to] of [
    [f.source, f.source],
    [f.source, path.join(f.source, 'nested')],
    [f.sourceParent, f.source],
    ['relative', f.destination],
    [f.source, f.destination + '\0'],
  ] as const)
    assert.throws(
      () =>
        renamePrivateStagingDirectorySync(from, to, {
          assertOffline() {},
          renameSync: () => assert.fail('Invalid paths must not reach rename'),
        }),
      { code: 'ERR_RESTORE_STAGE_CHANGED' },
    );
});
