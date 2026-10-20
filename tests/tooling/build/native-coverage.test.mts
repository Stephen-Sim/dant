import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  nativeSources,
  parseNativeCoverage,
  nativeCoverageMarkdown,
} from '../../../scripts/native/coverage.mts';

const expected = ['src-tauri/build.rs', 'src-tauri/src/main.rs'];
const metric = (covered = 2, count = 4) => ({ covered, count, percent: 99 });
const entry = (filename: string, covered = 2, total = 4) => ({
  filename,
  summary: {
    lines: metric(covered, total),
    functions: metric(covered, total),
    regions: metric(covered, total),
  },
});
const report = (...files: unknown[]) => ({ type: 'llvm.coverage.json.export', data: [{ files }] });

test('native coverage weighs actual counters, includes entrypoints and does not trust reported percentages', () => {
  const result = parseNativeCoverage(
    report(entry(expected[0]!, 1, 1), entry(expected[1]!, 0, 9), entry('/dependency.rs', 9, 9)),
    process.cwd(),
    expected,
  );
  assert.deepEqual(result.overall.lines, { covered: 1, total: 10 });
  assert.deepEqual(result.missing, []);
  const markdown = nativeCoverageMarkdown(result);
  assert.match(markdown, /10\.00% \(1\/10\)/);
  assert.match(markdown, /`src-tauri\/src\/main.rs`.*0\.00% \(0\/9\)/);
  assert.doesNotMatch(markdown, /dependency/);
  assert.match(markdown, /not branch coverage/);
});

test('native coverage never silently drops a missing compiled source', () => {
  const result = parseNativeCoverage(report(entry(expected[0]!)), process.cwd(), expected);
  assert.deepEqual(result.missing, [expected[1]]);
  assert.match(nativeCoverageMarkdown(result), /main\.rs` \| Not measured/);
  assert.match(nativeCoverageMarkdown(result), /FAIL:/);
});

test('malformed, duplicated and impossible LLVM counters cannot pass as coverage', () => {
  const invalid: unknown[] = [
    null,
    {},
    { type: 'other', data: [] },
    report(),
    report({ filename: expected[0], summary: {} }),
    report(entry(expected[0]!), entry(expected[0]!)),
    report(entry(expected[0]!, 5, 4)),
    report(entry(expected[0]!, -1, 4)),
    report(entry(expected[0]!, 0, 0)),
    report(entry(expected[0]!, 1, 1.1)),
  ];
  for (const value of invalid)
    assert.throws(() => parseNativeCoverage(value, process.cwd(), expected));
  assert.throws(() =>
    parseNativeCoverage(report(entry(expected[0]!)), process.cwd(), ['src-tauri/evil|.rs']),
  );
  assert.throws(() =>
    parseNativeCoverage(report(entry(expected[0]!)), process.cwd(), [expected[0]!, expected[0]!]),
  );
});

test('native inventory recursively discovers every Rust source while ignoring non-Rust files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-native-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src-tauri/src/nested'), { recursive: true });
  for (const file of [
    'src-tauri/build.rs',
    'src-tauri/src/main.rs',
    'src-tauri/src/nested/helper.rs',
    'src-tauri/src/readme.md',
  ])
    fs.writeFileSync(path.join(root, file), 'fixture');
  assert.deepEqual(nativeSources(root), [
    'src-tauri/build.rs',
    'src-tauri/src/main.rs',
    'src-tauri/src/nested/helper.rs',
  ]);
});
