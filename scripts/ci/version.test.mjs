import test from 'node:test';
import assert from 'node:assert/strict';
import { readVersion, validateVersions } from './version.mjs';

const versions = { package: '0.1.0', 'Cargo.toml': '0.1.0', 'tauri.conf.json': '0.1.0' };

test('all three release versions agree in the checked-out project', () => {
  assert.match(readVersion(undefined, {}), /^\d+\.\d+\.\d+/);
  assert.equal(
    readVersion(undefined, { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'test-build' }),
    readVersion(undefined, {}),
  );
});

test('a mismatched native version prevents packaging', () => {
  assert.throws(() => validateVersions({ ...versions, 'Cargo.toml': '0.2.0' }), /Version mismatch/);
});

test('only the exact matching version tag can produce a release', () => {
  assert.equal(validateVersions(versions, 'v0.1.0'), '0.1.0');
  for (const tag of ['v0.2.0', 'v0.1.0-extra', 'v0.1.0\nversion=other']) {
    assert.throws(() => validateVersions(versions, tag), /Release tag must/);
  }
});

test('invalid version text cannot write additional workflow outputs', () => {
  assert.throws(() => validateVersions({ package: '0.1.0\n' }), /release version/);
});
