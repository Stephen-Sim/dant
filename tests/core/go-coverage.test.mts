import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessGoCoverage,
  CORE_CRITICAL_COVERAGE,
  createGoCoverageReport,
  parseGoCoverage,
} from '../../scripts/core/coverage.mts';
import { GO_VERSION, runCoreGo } from '../../scripts/core/go.mts';
import type { GoRunner } from '../../scripts/core/go.mts';

const prefix = 'github.com/Stephen-Sim/dant/core/';
const expected = CORE_CRITICAL_COVERAGE.map((name) => prefix + name);
const block = (name: string, statements = 10, hit = 1, location = '1.1,2.1') =>
  `${prefix}${name}/feature.go:${location} ${statements} ${hit}\n`;
const passing = () => 'mode: atomic\n' + CORE_CRITICAL_COVERAGE.map((name) => block(name)).join('');

test('Go coverage weighs executable statements and merges duplicate block hits without inflating totals', () => {
  const packages = parseGoCoverage(
    'mode: atomic\n' +
      block('internal/controller', 9, 0) +
      block('internal/controller', 9, 8) +
      block('internal/controller', 1, 0, '3.1,4.1'),
  );
  assert.deepEqual(packages, [
    { package: 'internal/controller', statements: 10, covered: 9, percent: 90 },
  ]);
  assert.equal(assessGoCoverage(parseGoCoverage(passing()), expected).failures.length, 0);
});

test('whole-module instrumentation accepts repeated blocks from many test binaries within the byte budget', () => {
  // -coverpkg=./... repeats instrumented spans in each package's test binary.
  const profile =
    'mode: atomic\n' +
    block('internal/controller', 9, 0).repeat(250_001) +
    block('internal/controller', 9);
  assert.deepEqual(parseGoCoverage(profile), [
    { package: 'internal/controller', statements: 9, covered: 9, percent: 100 },
  ]);
  assert.throws(
    () => parseGoCoverage('mode: atomic\n' + block('internal/controller').repeat(1_000_001)),
    /incomplete or invalid/,
  );
});

test('critical modules, every feature package, and an unrounded ninety percent minimum are enforced', () => {
  const packages = parseGoCoverage(
    'mode: count\n' +
      block('internal/controller', 89999) +
      block('internal/controller', 10001, 0, '3.1,4.1') +
      block('internal/computer'),
  );
  const result = assessGoCoverage(packages, [...expected, prefix + 'internal/memory']);
  assert.match(
    result.failures.join('\n'),
    /controller statement coverage 89999\/100000 \(89.9990%\) is below 90%/,
  );
  assert.match(
    result.failures.join('\n'),
    /Required Go package has no coverage: internal\/telegram/,
  );
  assert.match(
    result.failures.join('\n'),
    /Go package has no executable coverage: internal\/memory/,
  );
  assert.throws(() => assessGoCoverage(packages, []), /incomplete or invalid/);
  assert.throws(
    () => assessGoCoverage(packages, [...expected, prefix + 'internal/controller']),
    /incomplete or invalid/,
  );
  assert.throws(
    () => assessGoCoverage(packages, [prefix + 'internal/unrelated']),
    /incomplete or invalid/,
  );
  const neverExecuted = assessGoCoverage(
    parseGoCoverage(passing() + block('internal/memory', 10, 0)),
    [...expected, prefix + 'internal/memory'],
  );
  assert.match(neverExecuted.failures.join('\n'), /no executable coverage: internal\/memory/);
});

test('empty, malformed, foreign, contradictory and unsafe Go profiles cannot pass', () => {
  for (const profile of [
    '',
    'mode: atomic\n',
    passing().replace('mode: atomic', 'mode: fabricated'),
    passing().replace(' 10 1', ' 10 -1'),
    passing().replace('1.1,2.1', '2.1,1.1'),
    passing().replace('1.1,2.1', '0.1,2.1'),
    passing().replace(prefix, '../outside/'),
    passing().replace(' 10 1', ' 9007199254740992 1'),
    'mode: set\n' + block('internal/controller', 1) + block('internal/controller', 2),
  ])
    assert.throws(() => parseGoCoverage(profile), /incomplete or invalid/);
});

test('a fresh profile is required and a previous saved report is never reused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-go-coverage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.cache/core'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cache/core/coverage.out'), passing());
  const fresh = createGoCoverageReport(root);
  assert.throws(() => fresh.read(), /ENOENT/);
  fs.writeFileSync(fresh.file, passing());
  const result = assessGoCoverage(parseGoCoverage(fresh.read()), expected);
  fresh.save(result);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, '.cache/core/coverage.json'), 'utf8')),
    result,
  );
  fresh.close();
  fresh.close();
  assert.equal(fs.existsSync(path.dirname(fresh.file)), false);

  // A toolchain/format failure occurs before tests, but must still invalidate old summaries.
  assert.throws(
    () => runCoreGo('check', { root, run: () => ({ status: 1 }), fileExists: () => false }),
    /Go .* is required/,
  );
  assert.equal(fs.existsSync(path.join(root, '.cache/core/coverage.out')), false);
  assert.equal(fs.existsSync(path.join(root, '.cache/core/coverage.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, '.cache/core')), []);
});

test('failed tests never read or save coverage, and invalid or missing reports fail after a successful process', () => {
  for (const outcome of [
    'test-failed',
    'missing-profile',
    'invalid-profile',
    'valid-profile',
    'list-failed',
  ] as const) {
    const root = path.resolve('isolated-go-coverage-boundary');
    let reads = 0,
      saves = 0,
      closed = 0,
      overlayClosed = 0;
    const calls: string[][] = [];
    const run: GoRunner = (_executable, args) => {
      calls.push([...args]);
      if (args[0] === 'version')
        return { status: 0, stdout: `go version go${GO_VERSION} linux/amd64\n` };
      if (args[0] === 'env') return { status: 0, stdout: root + '\n' };
      if (args[0] === 'list')
        return { status: outcome === 'list-failed' ? 1 : 0, stdout: expected.join('\n') };
      return { status: outcome === 'test-failed' ? 1 : 0 };
    };
    const execute = () =>
      runCoreGo('coverage', {
        root,
        run,
        fileExists: () => true,
        write: () => {},
        createTestOverlay: () => ({
          file: path.join(root, 'overlay.json'),
          layout: { files: [], replacements: {} },
          close: () => {
            overlayClosed++;
          },
        }),
        createCoverageReport: () => ({
          file: path.join(root, 'fresh.out'),
          read: () => {
            reads++;
            if (outcome === 'missing-profile') throw Error('missing profile');
            return outcome === 'invalid-profile' ? '' : passing();
          },
          save: () => {
            saves++;
          },
          close: () => {
            closed++;
          },
        }),
      });
    if (outcome === 'valid-profile') execute();
    else assert.throws(execute);
    assert.equal(reads, outcome === 'test-failed' || outcome === 'list-failed' ? 0 : 1);
    assert.equal(saves, outcome === 'valid-profile' ? 1 : 0);
    assert.equal(closed, 1);
    assert.equal(overlayClosed, 1);
    assert.equal(
      calls.filter((args) => args[0] === 'test').length,
      outcome === 'list-failed' ? 0 : 1,
    );
  }
});
