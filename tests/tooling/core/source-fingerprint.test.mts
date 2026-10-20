import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CORE_PARITY_SOURCE_FILES,
  fingerprintCoreSources,
} from '../../../scripts/core/source-fingerprint.mts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-core-source-'));
  const write = (relative: string, text: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  for (const file of CORE_PARITY_SOURCE_FILES) write(file, 'fixture ' + file);
  write('core/go.mod', 'module fixture\n');
  write('core/go.sum', 'fixture dependency checksum\n');
  write('core/internal/memory/reader.go', 'package memory\n');
  write('tests/go/internal/memory/reader_test.go', 'package memory\n');
  write('resources/contracts/core-protocol.json', '{"version":1}\n');
  write('ui/app/application-state.mts', 'export const fixture = true;\n');
  write('ui/shared/fixture.ts', 'export type Fixture = string;\n');
  return { root, write, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('source fingerprints are deterministic and include nested Go sources and fixed tooling', () => {
  const f = fixture();
  try {
    const original = fingerprintCoreSources(f.root);
    assert.match(original.digest, /^[0-9a-f]{64}$/);
    assert.equal(original.algorithm, 'sha256');
    assert.equal(original.version, 5);
    assert.equal(original.files, CORE_PARITY_SOURCE_FILES.length + 7);
    assert.deepEqual(fingerprintCoreSources(f.root), original);
    f.write('core/ignored.bin', 'not a maintained Go input');
    assert.deepEqual(fingerprintCoreSources(f.root), original);
    f.write('core/internal/memory/reader.go', 'package memory\n// changed\n');
    assert.notEqual(fingerprintCoreSources(f.root).digest, original.digest);
    f.write('core/internal/memory/reader.go', 'package memory\n');
    assert.deepEqual(fingerprintCoreSources(f.root), original);
    f.write('scripts/core/shadow-client.mts', 'changed client');
    assert.notEqual(fingerprintCoreSources(f.root).digest, original.digest);
  } finally {
    f.close();
  }
});

test('centralized recursive Go tests and their overlay tooling participate in source provenance', () => {
  const f = fixture();
  try {
    const original = fingerprintCoreSources(f.root);
    f.write('tests/go/internal/memory/reader_test.go', 'package memory\n// changed fixture\n');
    assert.notEqual(fingerprintCoreSources(f.root).digest, original.digest);
    f.write('tests/go/internal/memory/nested/another_test.go', 'package nested\n');
    assert.equal(fingerprintCoreSources(f.root).files, original.files + 1);
    const beforeToolChange = fingerprintCoreSources(f.root);
    f.write('scripts/core/test-layout.mts', 'changed overlay policy');
    assert.notEqual(fingerprintCoreSources(f.root).digest, beforeToolChange.digest);
  } finally {
    f.close();
  }
});

test('Go embedded text and JSON assets participate in source provenance', () => {
  const f = fixture();
  try {
    const original = fingerprintCoreSources(f.root);
    f.write('core/internal/history/assets/reactions.txt', 'fixture reactions\n');
    const textAsset = fingerprintCoreSources(f.root);
    assert.equal(textAsset.files, original.files + 1);
    assert.notEqual(textAsset.digest, original.digest);
    f.write('core/internal/history/assets/reactions.txt', 'changed reactions\n');
    assert.notEqual(fingerprintCoreSources(f.root).digest, textAsset.digest);
    f.write('core/internal/i18n/language-registry.json', '[{"code":"fixture"}]\n');
    const jsonAsset = fingerprintCoreSources(f.root);
    assert.equal(jsonAsset.files, original.files + 2);
    f.write('core/internal/i18n/language-registry.json', '[{"code":"changed"}]\n');
    assert.notEqual(fingerprintCoreSources(f.root).digest, jsonAsset.digest);
  } finally {
    f.close();
  }
});

test('recursive source provenance includes transitive runtime dependencies and new modules', () => {
  const f = fixture();
  try {
    const original = fingerprintCoreSources(f.root);
    f.write('ui/app/application-state.mts', 'export const fixture = false;\n');
    assert.notEqual(fingerprintCoreSources(f.root).digest, original.digest);
    f.write('ui/app/application-state.mts', 'export const fixture = true;\n');
    assert.deepEqual(fingerprintCoreSources(f.root), original);
    f.write('ui/files/managed-fixture.mts', 'export const nestedDependency = true;\n');
    const added = fingerprintCoreSources(f.root);
    assert.notEqual(added.digest, original.digest);
    assert.equal(added.files, original.files + 1);
    f.write('ui/files/managed-fixture.mts', 'export const nestedDependency = false;\n');
    assert.notEqual(fingerprintCoreSources(f.root).digest, added.digest);
    const beforeDeclaration = fingerprintCoreSources(f.root);
    f.write('ui/shared/fixture.ts', 'export type Fixture = number;\n');
    assert.notEqual(fingerprintCoreSources(f.root).digest, beforeDeclaration.digest);
    const beforeContract = fingerprintCoreSources(f.root);
    f.write('resources/contracts/core-protocol.json', '{"version":2}\n');
    assert.notEqual(fingerprintCoreSources(f.root).digest, beforeContract.digest);
  } finally {
    f.close();
  }
});

test('paths and byte boundaries participate in the digest independently of creation order', () => {
  const first = fixture(),
    second = fixture();
  try {
    first.write('core/a.go', 'a');
    first.write('core/z.go', 'bc');
    second.write('core/z.go', 'bc');
    second.write('core/a.go', 'a');
    assert.deepEqual(fingerprintCoreSources(first.root), fingerprintCoreSources(second.root));
    second.write('core/z.go', 'c');
    second.write('core/a.go', 'ab');
    assert.notEqual(
      fingerprintCoreSources(first.root).digest,
      fingerprintCoreSources(second.root).digest,
    );
    first.write('core/a.go', 'a');
    fs.renameSync(path.join(first.root, 'core/a.go'), path.join(first.root, 'core/b.go'));
    second.write('core/a.go', 'a');
    second.write('core/z.go', 'bc');
    assert.notEqual(
      fingerprintCoreSources(first.root).digest,
      fingerprintCoreSources(second.root).digest,
    );
  } finally {
    first.close();
    second.close();
  }
});

test('missing fixed sources and linked core directories fail without revealing paths', () => {
  const f = fixture();
  try {
    const original = fingerprintCoreSources(f.root);
    const file = path.join(f.root, 'scripts/core/shadow-client.mts');
    fs.unlinkSync(file);
    assert.throws(() => fingerprintCoreSources(f.root), /^Error: core_source_unstable$/);
    f.write('scripts/core/shadow-client.mts', 'fixture scripts/core/shadow-client.mts');
    assert.deepEqual(fingerprintCoreSources(f.root), original);
    fs.symlinkSync(path.join(f.root, 'ui'), path.join(f.root, 'core/linked'), 'junction');
    assert.throws(() => fingerprintCoreSources(f.root), /^Error: core_source_unstable$/);
  } finally {
    f.close();
  }
});

test('linked transitive source directories are rejected even when their files are not selected', () => {
  const f = fixture();
  try {
    fs.symlinkSync(path.join(f.root, 'core'), path.join(f.root, 'resources/linked'), 'junction');
    assert.throws(() => fingerprintCoreSources(f.root), /^Error: core_source_unstable$/);
  } finally {
    f.close();
  }
});
