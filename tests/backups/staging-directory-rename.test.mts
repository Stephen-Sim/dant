import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_MAX_FILES } from '../../src/backups/backup-constants.mts';
import {
  renamePrivateStagingDirectorySync,
  STAGING_RENAME_ATTEMPTS,
  STAGING_RENAME_DELAY_MS,
} from '../../src/backups/staging-directory-rename.mts';

const FIXTURE_RENAME_ATTEMPTS = 6;
const FIXTURE_RENAME_DELAY_MS = 10;
const fixtureRenamePause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const fixtureRenameCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);

interface FixtureRenameOptions {
  renameSync?: (source: string, destination: string) => void;
  platform?: NodeJS.Platform;
  pause?: (milliseconds: number) => void;
}

// These moves manufacture isolated test changes; their native sharing locks
// are independent of the injected error whose exact identity is under test.
function renameFixtureDirectory(
  root: string,
  source: string,
  destination: string,
  {
    renameSync = fs.renameSync,
    platform = process.platform,
    pause = (delay) => Atomics.wait(fixtureRenamePause, 0, 0, delay),
  }: FixtureRenameOptions = {},
) {
  const inside = (file: string) => {
    const relative = path.relative(root, file);
    return (
      path.isAbsolute(root) &&
      path.resolve(root) === root &&
      path.isAbsolute(file) &&
      path.resolve(file) === file &&
      relative !== '' &&
      !path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith('..' + path.sep)
    );
  };
  assert.ok(
    inside(source) && inside(destination),
    'A fixture move must stay inside its exact root',
  );
  assert.ok(
    source !== destination &&
      !source.startsWith(destination + path.sep) &&
      !destination.startsWith(source + path.sep),
    'Fixture move roots must not overlap',
  );

  const directory = (file: string) => {
    const stat = fs.lstatSync(file, { bigint: true });
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Fixture directories must be ordinary');
    return stat;
  };
  const parents = new Map<string, fs.BigIntStats>();
  for (const file of [source, destination]) {
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      parents.set(parent, directory(parent));
      if (parent === root) break;
      assert.ok(inside(parent), 'Fixture parents must stay inside their root');
    }
  }
  const original = directory(source);
  const unchanged = () => {
    try {
      for (const [file, expected] of parents) {
        const current = directory(file);
        if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
      }
      if (fs.lstatSync(destination, { bigint: true, throwIfNoEntry: false })) return false;
      const current = directory(source);
      return (
        current.dev === original.dev &&
        current.ino === original.ino &&
        current.mode === original.mode &&
        current.size === original.size &&
        current.nlink === original.nlink &&
        current.mtimeNs === original.mtimeNs &&
        current.ctimeNs === original.ctimeNs
      );
    } catch {
      return false;
    }
  };
  assert.ok(unchanged(), 'Fixture source and destination must be unchanged before moving');

  let failure: unknown;
  for (let attempt = 0; attempt < FIXTURE_RENAME_ATTEMPTS; attempt++) {
    if (attempt > 0 && !unchanged()) throw failure;
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (
        platform !== 'win32' ||
        typeof code !== 'string' ||
        !fixtureRenameCodes.has(code) ||
        attempt + 1 === FIXTURE_RENAME_ATTEMPTS ||
        !unchanged()
      )
        throw error;
      failure = error;
      pause(FIXTURE_RENAME_DELAY_MS * (attempt + 1));
    }
  }
}

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
function freezeDirectoryMetadata(t: TestContext, root: string) {
  const original = fs.lstatSync,
    observed = new Map<string, fs.Stats | fs.BigIntStats>();
  t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
    const value = original(...args),
      file = args[0];
    if (
      typeof file !== 'string' ||
      (file !== root && !file.startsWith(root + path.sep)) ||
      !value?.isDirectory()
    )
      return value;
    const previous = observed.get(file);
    if (previous) return previous;
    observed.set(file, value);
    return value;
  });
  return observed;
}

test('fixture directory moves tolerate only bounded known-unapplied sharing locks', (t) => {
  const f = fixture(t),
    waits: number[] = [];
  let attempts = 0;
  renameFixtureDirectory(f.root, f.source, f.destination, {
    platform: 'win32',
    renameSync(from, to) {
      if (++attempts < 3) throw Object.assign(Error('Isolated fixture lock'), { code: 'EPERM' });
      renameFixtureDirectory(f.root, from, to);
    },
    pause: (delay) => waits.push(delay),
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [FIXTURE_RENAME_DELAY_MS, FIXTURE_RENAME_DELAY_MS * 2]);
  assert.equal(
    fs.readFileSync(path.join(f.destination, 'retained.txt'), 'utf8'),
    'Retained staged bytes',
  );

  const exhausted = fixture(t),
    failure = Object.assign(Error('Last isolated fixture lock'), { code: 'EBUSY' });
  attempts = 0;
  assert.throws(
    () =>
      renameFixtureDirectory(exhausted.root, exhausted.source, exhausted.destination, {
        platform: 'win32',
        renameSync() {
          attempts++;
          throw failure;
        },
        pause() {},
      }),
    (error) => error === failure,
  );
  assert.equal(attempts, FIXTURE_RENAME_ATTEMPTS);
});

test('fixture move retries stop on changed roots, links, parents, destinations or unconfirmed application', (t) => {
  for (const change of ['applied', 'source', 'source-linked', 'parent', 'destination'] as const) {
    const f = fixture(t),
      failure = Object.assign(Error('Original isolated fixture lock'), { code: 'EACCES' });
    let attempts = 0;
    assert.throws(
      () =>
        renameFixtureDirectory(f.root, f.source, f.destination, {
          platform: 'win32',
          renameSync(from, to) {
            attempts++;
            if (change === 'applied') renameFixtureDirectory(f.root, from, to);
            throw failure;
          },
          pause() {
            if (change === 'destination') fs.mkdirSync(f.destination);
            else if (change === 'parent') {
              renameFixtureDirectory(f.root, f.targetParent, f.targetParent + '.retired');
              fs.mkdirSync(f.targetParent);
            } else if (change === 'source' || change === 'source-linked') {
              renameFixtureDirectory(f.root, f.source, f.source + '.retired');
              if (change === 'source') fs.mkdirSync(f.source);
              else
                fs.symlinkSync(
                  f.source + '.retired',
                  f.source,
                  process.platform === 'win32' ? 'junction' : 'dir',
                );
            } else assert.fail('An unconfirmed fixture move must never be repeated');
          },
        }),
      (error) => error === failure,
      change,
    );
    assert.equal(attempts, 1, change);
  }

  const f = fixture(t),
    other = fixture(t);
  assert.throws(() =>
    renameFixtureDirectory(f.root, f.source, other.destination, {
      renameSync: () => assert.fail('A fixture mutation must not leave its root'),
    }),
  );
});

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
        renameFixtureDirectory(f.root, from, to);
      },
      pause: (delay) => waits.push(delay),
    });
    assert.equal(attempts, 3);
    assert.equal(guards, attempts * 2);
    assert.deepEqual(waits, [STAGING_RENAME_DELAY_MS, STAGING_RENAME_DELAY_MS * 2]);
    assert.equal(fs.existsSync(f.source), false);
    assert.equal(
      fs.readFileSync(path.join(f.destination, 'retained.txt'), 'utf8'),
      'Retained staged bytes',
    );
  }
});

test('a staged tree change is rejected even when every directory stat stays unchanged, including changes inside the first failed rename', (t) => {
  for (const phase of ['rename', 'pause'] as const)
    for (const change of [
      'root-add',
      'nested-add',
      'nested-delete',
      'nested-replace',
      'nested-edit',
    ] as const) {
      const f = fixture(t),
        nested = path.join(f.source, 'nested'),
        retained = path.join(nested, 'retained.txt'),
        failure = Object.assign(Error('Original isolated sharing failure'), { code: 'EPERM' });
      fs.mkdirSync(nested);
      fs.writeFileSync(retained, 'Original nested bytes');
      const frozen = freezeDirectoryMetadata(t, f.source);
      let attempts = 0,
        changed = false;
      function changeTree() {
        changed = true;
        if (change === 'root-add') fs.writeFileSync(path.join(f.source, 'new.txt'), 'New entry');
        if (change === 'nested-add')
          fs.writeFileSync(path.join(nested, 'new.txt'), 'New nested entry');
        if (change === 'nested-delete') fs.unlinkSync(retained);
        if (change === 'nested-replace') {
          fs.renameSync(retained, retained + '.retired');
          fs.writeFileSync(retained, 'Replacement nested bytes');
        }
        if (change === 'nested-edit') fs.appendFileSync(retained, ' Appended bytes');
        // Model filesystems where directory metadata gives no witness of this change.
        assert.equal(fs.lstatSync(f.source, { bigint: true }), frozen.get(f.source));
        assert.equal(fs.lstatSync(nested, { bigint: true }), frozen.get(nested));
      }
      assert.throws(
        () =>
          renamePrivateStagingDirectorySync(f.source, f.destination, {
            platform: 'win32',
            assertOffline() {},
            renameSync() {
              attempts++;
              if (phase === 'rename') changeTree();
              throw failure;
            },
            pause() {
              if (phase === 'pause') changeTree();
            },
          }),
        (error) => error === failure,
        phase + ':' + change,
      );
      assert.equal(changed, true);
      assert.equal(attempts, 1, phase + ':' + change);
      assert.equal(fs.existsSync(f.destination), false);
      t.mock.restoreAll();
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
              renameFixtureDirectory(f.root, f.source, f.source + '.retired');
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
              renameFixtureDirectory(f.root, parent, parent + '.retired');
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
          renameFixtureDirectory(f.root, from, to);
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
          if (++guards > 2) throw offlineFailure;
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

test('going online during the initial tree scan prevents the first move', (t) => {
  const f = fixture(t),
    original = fs.opendirSync,
    offlineFailure = Error('Isolated offline confirmation lost during scan');
  let online = false;
  t.mock.method(fs, 'opendirSync', (...args: Parameters<typeof fs.opendirSync>) => {
    online = true;
    return original(...args);
  });
  assert.throws(
    () =>
      renamePrivateStagingDirectorySync(f.source, f.destination, {
        platform: 'win32',
        assertOffline() {
          if (online) throw offlineFailure;
        },
        renameSync: () => assert.fail('The service must remain offline after scanning'),
      }),
    (error) => error === offlineFailure,
  );
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
      renameFixtureDirectory(f.root, f.source, f.source + '.retired');
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
      renameFixtureDirectory(f.root, parent, parent + '.retired');
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

test('Windows staging inventories reject nested links, hardlinked files and special entries before a move', (t) => {
  for (const kind of ['directory-link', 'hardlink', 'special'] as const) {
    const f = fixture(t),
      nested = path.join(f.source, 'nested');
    fs.mkdirSync(nested);
    if (kind === 'directory-link')
      fs.symlinkSync(
        f.targetParent,
        path.join(nested, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    if (kind === 'hardlink')
      fs.linkSync(path.join(f.source, 'retained.txt'), path.join(nested, 'linked.txt'));
    if (kind === 'special') {
      const special = path.join(nested, 'special'),
        original = fs.lstatSync;
      fs.writeFileSync(special, 'Isolated placeholder');
      t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
        const value = original(...args);
        if (args[0] !== special || !value) return value;
        return new Proxy(value, {
          get(target, key, receiver) {
            if (key === 'isFile') return () => false;
            return Reflect.get(target, key, receiver);
          },
        });
      });
    }
    assert.throws(
      () =>
        renamePrivateStagingDirectorySync(f.source, f.destination, {
          platform: 'win32',
          assertOffline() {},
          renameSync: () => assert.fail('A linked or special tree entry must not reach rename'),
        }),
      { code: 'ERR_RESTORE_STAGE_CHANGED' },
      kind,
    );
    t.mock.restoreAll();
  }
});

test('Windows inventory streams a bounded number of entries and closes the directory on rejection', (t) => {
  const f = fixture(t),
    original = fs.lstatSync,
    ordinaryFile = original(path.join(f.source, 'retained.txt'), { bigint: true });
  let reads = 0,
    closed = false;
  t.mock.method(fs, 'opendirSync', () => ({
    readSync() {
      return { name: 'entry-' + ++reads };
    },
    closeSync() {
      closed = true;
    },
  }));
  t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
    const file = args[0];
    if (typeof file === 'string' && path.dirname(file) === f.source) return ordinaryFile;
    return original(...args);
  });
  assert.throws(
    () =>
      renamePrivateStagingDirectorySync(f.source, f.destination, {
        platform: 'win32',
        assertOffline() {},
        renameSync: () => assert.fail('An over-limit tree must not reach rename'),
      }),
    { code: 'ERR_RESTORE_STAGE_CHANGED' },
  );
  assert.equal(reads, BACKUP_MAX_FILES + 2);
  assert.equal(closed, true);
});

test('a non-Windows move does not enumerate the staging tree', (t) => {
  const f = fixture(t);
  t.mock.method(fs, 'opendirSync', () => assert.fail('A non-retrying move needs no tree scan'));
  renamePrivateStagingDirectorySync(f.source, f.destination, {
    platform: 'linux',
    assertOffline() {},
    renameSync: (from, to) => renameFixtureDirectory(f.root, from, to),
  });
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(
    fs.readFileSync(path.join(f.destination, 'retained.txt'), 'utf8'),
    'Retained staged bytes',
  );
});
