import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createCoreGoTestOverlay,
  discoverCoreGoTests,
} from '../../../scripts/core/test-layout.mts';

function fixture(t: test.TestContext) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'dant-go-test-layout-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^dant-go-test-layout-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (relative: string, content: string) => {
    const name = path.join(root, relative);
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, content);
  };
  write('core/internal/feature/feature.go', 'package feature\nvar privateValue = 1\n');
  write('tests/go/internal/feature/feature_test.go', 'package feature\n');
  return { root, write };
}

test('recursive mirror discovery retains private and external tests and all platform suffixes', (t) => {
  const f = fixture(t);
  f.write('core/internal/feature/nested/state.go', 'package nested\n');
  f.write('tests/go/internal/feature/nested/state_test.go', 'package nested\n');
  f.write('tests/go/internal/feature/external_test.go', 'package feature_test\n');
  for (const platform of ['windows', 'linux', 'darwin'])
    f.write(`tests/go/internal/feature/feature_${platform}_test.go`, 'package feature\n');
  const layout = discoverCoreGoTests(f.root);
  assert.equal(layout.files.length, 6);
  assert.equal(Object.keys(layout.replacements).length, 6);
  for (const file of layout.files) {
    assert.equal(file.target, file.source.replace(/^tests\/go\//, 'core/'));
    assert.equal(
      layout.replacements[path.join(f.root, file.target)],
      path.join(f.root, file.source),
    );
    assert.equal(fs.existsSync(path.join(f.root, file.target)), false);
  }
  assert.equal(
    layout.files.find((file) => file.source.endsWith('external_test.go'))?.packageName,
    'feature_test',
  );
});

test('private overlay is explicit, reads centralized sources and cleans up without writing source directories', (t) => {
  const f = fixture(t),
    before = fs.readdirSync(path.join(f.root, 'core/internal/feature')),
    overlay = createCoreGoTestOverlay(f.root);
  const value: unknown = JSON.parse(fs.readFileSync(overlay.file, 'utf8'));
  assert.deepEqual(value, { Replace: overlay.layout.replacements });
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'core/internal/feature')), before);
  assert.ok(path.dirname(overlay.file).startsWith(path.join(f.root, '.cache/core/test-overlay-')));
  overlay.close();
  overlay.close();
  assert.equal(fs.existsSync(path.dirname(overlay.file)), false);
  assert.equal(fs.existsSync(path.join(f.root, 'tests/go/internal/feature/feature_test.go')), true);
});

test('empty, misplaced, unmapped and package-mismatched Go tests fail instead of silently disappearing', (t) => {
  for (const invalid of [
    'empty',
    'legacy',
    'helper',
    'unmapped',
    'package',
    'path-case',
    'hidden',
  ]) {
    const f = fixture(t);
    if (invalid === 'empty')
      fs.unlinkSync(path.join(f.root, 'tests/go/internal/feature/feature_test.go'));
    if (invalid === 'legacy') f.write('core/internal/feature/legacy_test.go', 'package feature\n');
    if (invalid === 'helper') f.write('tests/go/internal/feature/helper.go', 'package feature\n');
    if (invalid === 'unmapped')
      f.write('tests/go/internal/missing/missing_test.go', 'package missing\n');
    if (invalid === 'package')
      f.write('tests/go/internal/feature/feature_test.go', 'package other\n');
    if (invalid === 'path-case') f.write('tests/go/Other/other_test.go', 'package feature\n');
    if (invalid === 'hidden')
      f.write('tests/go/internal/feature/_hidden_test.go', 'package feature\n');
    assert.throws(
      () => discoverCoreGoTests(f.root),
      /^Error: The Go test layout is incomplete or invalid\.$/,
      invalid,
    );
  }
});

test('case-sensitive filesystems cannot create ambiguous Windows overlay targets', (t) => {
  const f = fixture(t);
  f.write('tests/go/internal/feature/CASE_test.go', 'package feature\n');
  f.write('tests/go/internal/feature/case_test.go', 'package feature\n');
  const entries = fs.readdirSync(path.join(f.root, 'tests/go/internal/feature'));
  if (entries.includes('CASE_test.go') && entries.includes('case_test.go'))
    assert.throws(() => discoverCoreGoTests(f.root), /layout is incomplete or invalid/);
  else assert.equal(discoverCoreGoTests(f.root).files.length, 2);
});

test('linked test directories and hardlinked sources never enter an overlay', (t) => {
  for (const link of ['directory', 'file']) {
    const f = fixture(t);
    if (link === 'directory')
      fs.symlinkSync(
        path.join(f.root, 'tests/go/internal/feature'),
        path.join(f.root, 'tests/go/internal/linked'),
        'junction',
      );
    else
      fs.linkSync(
        path.join(f.root, 'tests/go/internal/feature/feature_test.go'),
        path.join(f.root, 'tests/go/internal/feature/linked_test.go'),
      );
    assert.throws(() => discoverCoreGoTests(f.root), /layout is incomplete or invalid/);
  }
});
