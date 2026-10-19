import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  prepareResources,
  stageReleaseResources,
  assertGeneratedPath,
} from '../scripts/package-resources.mjs';
import { resolveBuildPaths } from '../scripts/ci/build-paths.mjs';

const base = path.resolve('.cache/tests');
fs.mkdirSync(base, { recursive: true });
function write(root, name, text = 'fixture') {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(base, 'packaging-'));
  t.after(() => {
    const relative = path.relative(base, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const directory of [
    'src',
    'dist/assets',
    'node_modules/express',
    'scripts',
    'vm',
    'src-tauri',
  ])
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  write(root, 'package.json', JSON.stringify({ name: 'dant', version: '1.2.3' }));
  write(root, 'package-lock.json', JSON.stringify({ name: 'dant', version: '1.2.3' }));
  write(root, 'src-tauri/tauri.conf.json', JSON.stringify({ version: '1.2.3' }));
  write(root, 'src-tauri/Cargo.toml', '[package]\nname="dant"\nversion="1.2.3"\n');
  write(root, 'LICENSE', 'MIT fixture');
  write(root, 'src/server.mjs', 'export const current=true;');
  write(root, 'dist/index.html', '<script src="/assets/current.js"></script>');
  write(root, 'dist/assets/current.js', 'current build');
  write(root, 'node_modules/express/package.json', '{"name":"express"}');
  write(root, 'scripts/tool.mjs', 'tool');
  write(root, 'vm/desktop.py', 'desktop');
  const nodeExecutable = write(root, 'fixture-node.exe', 'tiny fixture node executable'),
    paths = resolveBuildPaths(root, {}),
    options = {
      projectRoot: root,
      nodeExecutable,
      env: {},
      runNode: () => ({ status: 0, stdout: 'dant-typescript-runtime-ok' }),
    };
  return { root, nodeExecutable, paths, options };
}
function tree(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name),
        stat = fs.lstatSync(file);
      entries.push(path.relative(root, file).split(path.sep).join('/'));
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file);
    }
  };
  walk(root);
  return entries;
}
function link(t, target, destination) {
  try {
    fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('Directory links are unavailable on this host');
      return false;
    }
    throw error;
  }
}

test('fresh resources remove obsolete hashed assets and deleted source files without copying local data or caches', (t) => {
  const f = fixture(t);
  prepareResources(f.options);
  write(f.paths.resources, 'dist/assets/stale-old.js', 'stale');
  write(f.paths.resources, 'src/deleted.mjs', 'stale');
  write(f.paths.resources, 'unexpected-extra.txt', 'stale');
  write(f.root, 'data/private-key', 'never packaged');
  write(f.root, '.env', 'never packaged');
  write(f.root, 'scripts/.cache/private.txt', 'never packaged');
  write(f.root, 'vm/__pycache__/old.pyc', 'never packaged');
  write(f.root, 'dist/assets/next.js', 'next build');
  fs.unlinkSync(path.join(f.root, 'dist/assets/current.js'));
  prepareResources(f.options);
  assert.equal(fs.existsSync(path.join(f.paths.resources, 'dist/assets/current.js')), false);
  assert.equal(fs.existsSync(path.join(f.paths.resources, 'dist/assets/stale-old.js')), false);
  assert.equal(fs.existsSync(path.join(f.paths.resources, 'src/deleted.mjs')), false);
  assert.equal(fs.existsSync(path.join(f.paths.resources, 'unexpected-extra.txt')), false);
  assert.equal(
    fs.readFileSync(path.join(f.paths.resources, 'dist/assets/next.js'), 'utf8'),
    'next build',
  );
  assert.equal(
    fs.readFileSync(path.join(f.paths.resources, 'node.exe'), 'utf8'),
    'tiny fixture node executable',
  );
  assert.ok(
    !tree(f.paths.resources).some((name) => /data\/|private|\.cache|__pycache__|\.env/.test(name)),
  );
  assert.equal(fs.readFileSync(path.join(f.root, 'data/private-key'), 'utf8'), 'never packaged');
});

test('standalone backend staging replaces its full tree and preserves the exe and neighboring release files', (t) => {
  const f = fixture(t);
  prepareResources(f.options);
  stageReleaseResources(f.options);
  write(f.paths.backend, 'dist/assets/obsolete.js', 'old');
  write(f.paths.backend, 'old-runtime.txt', 'old');
  write(f.paths.release, 'dant.exe', 'keep executable');
  write(f.paths.release, 'bundle/keep.txt', 'keep installer');
  stageReleaseResources(f.options);
  assert.deepEqual(tree(f.paths.backend), tree(f.paths.resources));
  assert.equal(fs.readFileSync(path.join(f.paths.release, 'dant.exe'), 'utf8'), 'keep executable');
  assert.equal(
    fs.readFileSync(path.join(f.paths.release, 'bundle/keep.txt'), 'utf8'),
    'keep installer',
  );
  assert.equal(fs.existsSync(path.join(f.paths.backend, 'old-runtime.txt')), false);
});

test('nested environment files are omitted from both packaged and staged trees', (t) => {
  const f = fixture(t);
  for (const name of [
    'src/config/.env',
    'src/config/.env.production',
    'node_modules/pkg/.Env',
    'scripts/helper/.ENV.LOCAL',
    'dist/.env.build',
  ])
    write(f.root, name, 'private-fixture-value');
  write(f.root, 'src/config/.environment.json', 'ordinary source filename');
  prepareResources(f.options);
  assert.ok(!tree(f.paths.resources).some((name) => /(?:^|\/)\.env(?:\.|$)/i.test(name)));
  assert.equal(
    fs.readFileSync(path.join(f.paths.resources, 'src/config/.environment.json'), 'utf8'),
    'ordinary source filename',
  );
  write(f.paths.resources, 'src/config/.env.staging', 'private-fixture-value');
  stageReleaseResources(f.options);
  assert.ok(!tree(f.paths.backend).some((name) => /(?:^|\/)\.env(?:\.|$)/i.test(name)));
  assert.equal(
    fs.readFileSync(path.join(f.root, 'src/config/.env'), 'utf8'),
    'private-fixture-value',
  );
});

test('source, build, node and package validation all precede cleanup of the previous generated resources', (t) => {
  const f = fixture(t);
  prepareResources(f.options);
  const sentinel = write(f.paths.resources, 'keep-before-validation.txt', 'previous build');
  for (const [name, change, restore] of [
    [
      'missing build',
      () =>
        fs.renameSync(path.join(f.root, 'dist/index.html'), path.join(f.root, 'dist/away.html')),
      () =>
        fs.renameSync(path.join(f.root, 'dist/away.html'), path.join(f.root, 'dist/index.html')),
    ],
    [
      'wrong package',
      () => write(f.root, 'package.json', '{"name":"other","version":"1.2.3"}'),
      () => write(f.root, 'package.json', '{"name":"dant","version":"1.2.3"}'),
    ],
    [
      'version mismatch',
      () => write(f.root, 'src-tauri/tauri.conf.json', '{"version":"9.0.0"}'),
      () => write(f.root, 'src-tauri/tauri.conf.json', '{"version":"1.2.3"}'),
    ],
    [
      'missing node',
      () => fs.renameSync(f.nodeExecutable, f.nodeExecutable + '.away'),
      () => fs.renameSync(f.nodeExecutable + '.away', f.nodeExecutable),
    ],
  ]) {
    change();
    assert.throws(() => prepareResources(f.options), undefined, name);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'previous build');
    restore();
  }
  assert.ok(
    fs
      .readdirSync(path.join(f.root, 'src-tauri'))
      .every((name) => !name.startsWith('.dant-resources-')),
  );
});

test('stage validation rejects missing, mismatched or polluted resources before deleting an existing backend', (t) => {
  const f = fixture(t);
  prepareResources(f.options);
  stageReleaseResources(f.options);
  const sentinel = write(f.paths.backend, 'keep.txt', 'previous runtime');
  fs.unlinkSync(path.join(f.paths.resources, 'node.exe'));
  assert.throws(() => stageReleaseResources(f.options), /node.exe/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'previous runtime');
  prepareResources(f.options);
  write(f.paths.resources, 'package.json', '{"name":"dant","version":"0.0.1"}');
  assert.throws(() => stageReleaseResources(f.options), /version does not match/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'previous runtime');
  prepareResources(f.options);
  write(f.paths.resources, 'data/private.txt', 'never staged');
  assert.throws(() => stageReleaseResources(f.options), /unexpected files/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'previous runtime');
});

test('cleanup guards accept only absolute exact generated directories inside the intended roots', (t) => {
  const f = fixture(t);
  for (const target of [
    f.root,
    path.dirname(f.root),
    path.join(f.root, 'data'),
    path.join(f.root, 'src-tauri/resources-neighbor'),
    path.join(f.root, 'src-tauri/target/release'),
    path.join(f.root, 'src-tauri/resources/child'),
  ])
    assert.throws(() => assertGeneratedPath(f.root, target, {}), /outside the generated/);
  for (const target of ['relative', '', null, f.paths.resources + '\0'])
    assert.throws(() => assertGeneratedPath(f.root, target, {}), /must be absolute/);
  assert.equal(assertGeneratedPath(f.root, f.paths.resources, {}), f.paths.resources);
  assert.equal(assertGeneratedPath(f.root, f.paths.backend, {}), f.paths.backend);
  assert.throws(
    () => prepareResources({ ...f.options, projectRoot: '.' }),
    /root must be absolute/,
  );
});

test('a symlink or Windows junction resource root is rejected without touching its outside target', (t) => {
  const f = fixture(t),
    outside = path.join(f.root, 'keep-outside');
  write(outside, 'private.txt', 'keep private');
  if (!link(t, outside, f.paths.resources)) return;
  assert.throws(() => prepareResources(f.options), /links or junctions/);
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'keep private');
  assert.equal(fs.lstatSync(f.paths.resources).isSymbolicLink(), true);
});

test('linked project, source and backend ancestor directories are rejected before replacement', (t) => {
  const f = fixture(t),
    alias = path.join(f.root, 'project-alias');
  if (!link(t, f.root, alias)) return;
  assert.throws(() => prepareResources({ ...f.options, projectRoot: alias }), /links or junctions/);
  fs.unlinkSync(alias);
  const original = path.join(f.root, 'src'),
    moved = path.join(f.root, 'src-original');
  fs.renameSync(original, moved);
  if (!link(t, moved, original)) return;
  assert.throws(() => prepareResources(f.options), /links or junctions/);
  fs.unlinkSync(original);
  fs.renameSync(moved, original);
  prepareResources(f.options);
  const outside = path.join(f.root, 'private-release');
  write(outside, 'backend/private.txt', 'keep private');
  fs.mkdirSync(f.paths.target, { recursive: true });
  if (!link(t, outside, f.paths.release)) return;
  assert.throws(() => stageReleaseResources(f.options), /links or junctions/);
  assert.equal(fs.readFileSync(path.join(outside, 'backend/private.txt'), 'utf8'), 'keep private');
});

test('custom Cargo targets receive a clean backend without changing the default target or allowing overlapping resources', (t) => {
  const f = fixture(t);
  prepareResources(f.options);
  const custom = path.join(f.root, 'isolated-cargo'),
    options = { ...f.options, env: { CARGO_TARGET_DIR: custom } },
    paths = resolveBuildPaths(f.root, options.env);
  write(f.paths.backend, 'preserved.txt', 'default target');
  stageReleaseResources(options);
  write(paths.backend, 'obsolete.txt', 'old custom');
  stageReleaseResources(options);
  assert.equal(fs.existsSync(path.join(paths.backend, 'obsolete.txt')), false);
  assert.equal(
    fs.readFileSync(path.join(f.paths.backend, 'preserved.txt'), 'utf8'),
    'default target',
  );
  assert.deepEqual(tree(paths.backend), tree(f.paths.resources));
  assert.throws(
    () => stageReleaseResources({ ...f.options, env: { CARGO_TARGET_DIR: f.paths.resources } }),
    /must not overlap/,
  );
  assert.equal(
    fs.readFileSync(path.join(f.paths.resources, 'node.exe'), 'utf8'),
    'tiny fixture node executable',
  );
});

test('Windows generated-directory rename retries a transient sharing lock with bounded delay', (t) => {
  const f = fixture(t),
    delays = [];
  let calls = 0;
  prepareResources({
    ...f.options,
    platform: 'win32',
    pause: (ms) => delays.push(ms),
    renameSync: (source, destination) => {
      if (++calls === 1) throw Object.assign(Error('Transient scanner lock'), { code: 'EPERM' });
      fs.renameSync(source, destination);
    },
  });
  // Windows can add a real scanner lock after the injected one. Verify the
  // bounded retry policy instead of assuming the second OS call must succeed.
  assert.ok(calls >= 2 && calls <= 6);
  assert.deepEqual(
    delays,
    Array.from({ length: calls - 1 }, (_, index) => (index + 1) * 25),
  );
  assert.equal(
    fs.readFileSync(path.join(f.paths.resources, 'dist/assets/current.js'), 'utf8'),
    'current build',
  );
});

test('a permanent generated-directory lock stops after six attempts and unrelated rename errors do not retry', (t) => {
  for (const [code, platform, expected] of [
    ['EPERM', 'win32', 6],
    ['EINVAL', 'win32', 1],
    ['EPERM', 'linux', 1],
  ]) {
    const f = fixture(t),
      delays = [];
    let calls = 0;
    assert.throws(
      () =>
        prepareResources({
          ...f.options,
          platform,
          pause: (ms) => delays.push(ms),
          renameSync: () => {
            calls++;
            throw Object.assign(Error('Synthetic rename failure'), { code });
          },
        }),
      /Synthetic rename failure/,
    );
    assert.equal(calls, expected);
    assert.deepEqual(
      delays,
      Array.from({ length: expected - 1 }, (_, index) => (index + 1) * 25),
    );
    assert.equal(
      fs
        .readdirSync(path.dirname(f.paths.resources))
        .some((name) => name.startsWith('.dant-resources-')),
      false,
      'owned staging is cleaned after failure',
    );
  }
});
