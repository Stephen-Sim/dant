import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveBuildPaths, assertStagingPath } from '../scripts/ci/build-paths.mjs';

const root = path.resolve('.cache/build-path-fixture');
test('default build, runtime staging and download paths retain their original locations', () => {
  const target = path.join(root, 'src-tauri', 'target'),
    release = path.join(target, 'release');
  assert.deepEqual(resolveBuildPaths(root, {}), {
    target,
    release,
    backend: path.join(release, 'backend'),
    resources: path.join(root, 'src-tauri', 'resources'),
    output: path.join(target, 'ci-artifacts'),
    stagingPrefix: path.join(target, 'ci-portable-'),
  });
});

test('an absolute Cargo target isolates exe, installer and runtime staging while downloads stay fixed', () => {
  const custom = path.join(root, 'src-tauri', 'target', 'updates'),
    paths = resolveBuildPaths(root, { CARGO_TARGET_DIR: custom });
  assert.equal(paths.target, custom);
  assert.equal(paths.release, path.join(custom, 'release'));
  assert.equal(paths.backend, path.join(custom, 'release', 'backend'));
  assert.equal(paths.stagingPrefix, path.join(custom, 'ci-portable-'));
  assert.equal(paths.output, path.join(root, 'src-tauri', 'target', 'ci-artifacts'));
  assert.equal(paths.resources, path.join(root, 'src-tauri', 'resources'));
  assert.notEqual(paths.release, resolveBuildPaths(root, {}).release);
  const external = path.resolve('.cache', 'separate-cargo-target');
  assert.equal(
    resolveBuildPaths(root, { CARGO_TARGET_DIR: path.join(external, 'nested', '..') }).target,
    external,
  );
});

test('invalid Cargo target or project roots fail before any filesystem access', () => {
  for (const value of ['relative-target', '', 'bad\0path', root + '\0', null, 42])
    assert.throws(
      () => resolveBuildPaths(root, { CARGO_TARGET_DIR: value }),
      /CARGO_TARGET_DIR must be an absolute path/,
    );
  for (const value of ['relative-root', '', root + '\0', null])
    assert.throws(() => resolveBuildPaths(value, {}), /Project root must be an absolute path/);
});

test('staging cleanup is restricted to an allocated direct child of the selected target', () => {
  const paths = resolveBuildPaths(root, {
      CARGO_TARGET_DIR: path.join(root, 'src-tauri', 'target', 'updates'),
    }),
    safe = paths.stagingPrefix + 'Ab123Z';
  assert.equal(assertStagingPath(paths.target, safe), safe);
  for (const candidate of [
    paths.target,
    path.dirname(paths.target),
    path.join(paths.target, 'arbitrary'),
    paths.stagingPrefix,
    path.join(paths.target, 'nested', 'ci-portable-Ab123Z'),
    path.join(paths.target, '..', 'ci-portable-Ab123Z'),
    path.join(paths.target + '-other', 'ci-portable-Ab123Z'),
    resolveBuildPaths(root, {}).stagingPrefix + 'Ab123Z',
  ])
    assert.throws(() => assertStagingPath(paths.target, candidate), /Refusing to remove/);
  assert.throws(() => assertStagingPath(paths.target, 'relative-stage'), /absolute path/);
  assert.throws(() => assertStagingPath(paths.target, safe + '\0'), /NUL/);
});
