import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessGoCoverage,
  appendGoCoverageSummary,
  CORE_CRITICAL_COVERAGE,
  createGoCoverageReport,
  goCoverageMarkdown,
  parseGoCoverage,
} from '../../../scripts/core/coverage.mts';
import { GO_VERSION, runCoreGo } from '../../../scripts/core/go.mts';
import type { GoRunner } from '../../../scripts/core/go.mts';

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

test('the Go summary reports weighted unique statements, exact package counts and independent language metrics', () => {
  const result = assessGoCoverage(
    parseGoCoverage(
      'mode: atomic\n' +
        block('internal/controller', 9, 0) +
        block('internal/controller', 9, 8) +
        block('internal/controller', 1, 0, '3.1,4.1') +
        block('internal/computer', 1) +
        block('internal/telegram', 1) +
        block('internal/memory', 1) +
        block('internal/memory', 89, 0, '3.1,4.1'),
    ),
    [...expected, prefix + 'internal/memory'],
  );
  assert.deepEqual(result.overall, { statements: 102, covered: 12, percent: (12 / 102) * 100 });
  const markdown = goCoverageMarkdown(result);
  assert.match(markdown, /\*\*Overall: 11\.7647% \(12\/102 statements covered\)\.\*\*/);
  assert.match(markdown, /Coverage gates: PASS/);
  assert.match(markdown, /`internal\/controller` \| 9 \/ 10 \| 90\.0000% \| >= 90% \| PASS/);
  assert.match(
    markdown,
    /`internal\/memory` \| 1 \/ 90 \| 1\.1111% \| Executable coverage \| PASS/,
  );
  assert.match(markdown, /separate from UI line, branch and function coverage/);
  assert.ok(markdown.indexOf('`internal/memory`') < markdown.indexOf('`internal/controller`'));
  assert.equal(markdown.split('\n').filter((line) => line.startsWith('| `')).length, 4);
});

test('Go summary failures retain missing coverage and the exact unrounded critical threshold', () => {
  const result = assessGoCoverage(
    parseGoCoverage(
      'mode: atomic\n' +
        block('internal/controller', 89999) +
        block('internal/controller', 10001, 0, '3.1,4.1') +
        block('internal/computer') +
        block('internal/memory', 10, 0) +
        block('cmd/dant-core', 2, 0),
    ),
    [...expected, prefix + 'internal/memory', prefix + 'internal/store', prefix + 'cmd/dant-core'],
  );
  const markdown = goCoverageMarkdown(result);
  assert.match(markdown, /Coverage gates: FAIL/);
  assert.match(
    markdown,
    /`internal\/controller` \| 89999 \/ 100000 \| 89\.9990% \| >= 90% \| FAIL/,
  );
  assert.match(markdown, /`internal\/telegram` \| Not reported \| Not reported \| >= 90% \| FAIL/);
  assert.match(
    markdown,
    /`internal\/store` \| Not reported \| Not reported \| Executable coverage \| FAIL/,
  );
  assert.match(
    markdown,
    /`internal\/memory` \| 0 \/ 10 \| 0\.0000% \| Executable coverage \| FAIL/,
  );
  assert.match(
    markdown,
    /`cmd\/dant-core` \| 0 \/ 2 \| 0\.0000% \| Reported entrypoint \| Reported/,
  );
});

test('every command entrypoint remains in the measured denominator even when its code is not executed', () => {
  const packages = [...expected, prefix + 'cmd/dant-core'];
  for (const profile of [passing(), passing() + block('cmd/dant-core', 0, 0)]) {
    const result = assessGoCoverage(parseGoCoverage(profile), packages);
    assert.match(
      result.failures.join('\n'),
      /Go entrypoint has no instrumented statements: cmd\/dant-core/,
    );
    assert.match(goCoverageMarkdown(result), /`cmd\/dant-core`[^\n]*\| FAIL \|/);
  }
  const result = assessGoCoverage(
    parseGoCoverage(passing() + block('cmd/dant-core', 2, 0)),
    packages,
  );
  assert.deepEqual(result.overall, { statements: 32, covered: 30, percent: 93.75 });
  assert.deepEqual(result.failures, []);
  assert.match(
    goCoverageMarkdown(result),
    /`cmd\/dant-core` \| 0 \/ 2 \| 0\.0000% \| Reported entrypoint \| Reported/,
  );
});

test('coverage metadata cannot inject Markdown or fabricate statement totals', () => {
  const packages = parseGoCoverage(passing());
  for (const name of [
    'internal/memory|FAKE',
    'internal/<script>',
    'internal/memory\n# Forged',
    '../outside',
  ])
    assert.throws(
      () => assessGoCoverage(packages, [...expected, prefix + name]),
      /incomplete or invalid/,
    );
  for (const item of [
    { package: 'internal/controller', statements: 10, covered: 11, percent: 110 },
    { package: 'internal/controller', statements: 10, covered: -1, percent: -10 },
    { package: 'internal/controller', statements: 10, covered: 9, percent: 100 },
    { package: 'internal/controller', statements: Number.MAX_SAFE_INTEGER, covered: 1, percent: 0 },
  ])
    assert.throws(
      () => assessGoCoverage([item, ...packages.slice(1)], expected),
      /incomplete or invalid/,
    );
  assert.throws(
    () => assessGoCoverage([...packages, packages[0]!], expected),
    /incomplete or invalid/,
  );
  const unsafe = {
    ...assessGoCoverage(packages, expected),
    expectedPackages: ['internal/unsafe`|'],
  };
  assert.throws(() => goCoverageMarkdown(unsafe), /incomplete or invalid/);
});

test('summary appends preserve other checks and expose only fixed errors for invalid destinations', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-go-summary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'summary.md');
  fs.writeFileSync(file, '## UI coverage\n\nExisting independent metrics.\n\n');
  const result = assessGoCoverage(parseGoCoverage(passing()), expected);
  appendGoCoverageSummary(result);
  appendGoCoverageSummary(result, file);
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '## UI coverage\n\nExisting independent metrics.\n\n' + goCoverageMarkdown(result),
  );
  for (const destination of ['relative-summary.md', file + '\0suffix'])
    assert.throws(
      () => appendGoCoverageSummary(result, destination),
      /^Error: The Go coverage summary destination is invalid\.$/,
    );
  assert.throws(
    () => appendGoCoverageSummary(result, path.join(root, 'private-fixture-name', 'missing.md')),
    /^Error: The Go coverage summary could not be written\.$/,
  );
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
  fs.writeFileSync(path.join(root, '.cache/core/coverage.md'), 'stale metrics');
  const fresh = createGoCoverageReport(root);
  assert.throws(() => fresh.read(), /ENOENT/);
  fs.writeFileSync(fresh.file, passing());
  const result = assessGoCoverage(parseGoCoverage(fresh.read()), expected);
  fresh.save(result);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, '.cache/core/coverage.json'), 'utf8')),
    result,
  );
  assert.equal(
    fs.readFileSync(path.join(root, '.cache/core/coverage.md'), 'utf8'),
    goCoverageMarkdown(result),
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
  assert.equal(fs.existsSync(path.join(root, '.cache/core/coverage.md')), false);
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
        env: {},
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

test('the actual check runner publishes only fresh assessed coverage and still rejects failed gates', (t) => {
  for (const outcome of [
    'pass',
    'below-threshold',
    'test-failed',
    'list-failed',
    'malformed',
    'toolchain-failed',
    'format-failed',
  ] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-go-check-summary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const destination = path.join(root, 'github-summary.md');
    const previous = '## UI coverage\n\nSeparate fixture metrics.\n\n';
    fs.writeFileSync(destination, previous);
    fs.mkdirSync(path.join(root, '.cache/core'), { recursive: true });
    for (const name of ['coverage.out', 'coverage.json', 'coverage.md'])
      fs.writeFileSync(
        path.join(root, '.cache/core', name),
        'stale coverage must never be published',
      );
    const profile =
      outcome === 'below-threshold'
        ? passing().replace(' 10 1', ' 10 0')
        : outcome === 'malformed'
          ? 'private fixture text is not coverage'
          : passing();
    const run: GoRunner = (_executable, args) => {
      if (args[0] === 'version')
        return {
          status: outcome === 'toolchain-failed' ? 1 : 0,
          stdout: `go version go${GO_VERSION} linux/amd64\n`,
        };
      if (args[0] === 'env') return { status: 0, stdout: root + '\n' };
      if (args[0] === '-l')
        return { status: 0, stdout: outcome === 'format-failed' ? 'fixture.go\n' : '' };
      if (args[0] === 'list')
        return { status: outcome === 'list-failed' ? 1 : 0, stdout: expected.join('\n') };
      if (args[0] === 'test') {
        const file = args
          .find((argument) => argument.startsWith('-coverprofile='))
          ?.slice('-coverprofile='.length);
        assert.ok(file);
        fs.writeFileSync(file, profile);
        return { status: outcome === 'test-failed' ? 1 : 0 };
      }
      return { status: 0 };
    };
    const execute = () =>
      runCoreGo('check', {
        root,
        run,
        env: { GITHUB_STEP_SUMMARY: destination },
        fileExists: () => true,
        write: () => {},
        createTestOverlay: () => ({
          file: path.join(root, 'overlay.json'),
          layout: { files: [], replacements: {} },
          close: () => {},
        }),
      });
    if (outcome === 'pass') execute();
    else assert.throws(execute);

    const assessed = outcome === 'pass' || outcome === 'below-threshold';
    if (assessed) {
      const result = assessGoCoverage(parseGoCoverage(profile), expected);
      assert.equal(fs.readFileSync(destination, 'utf8'), previous + goCoverageMarkdown(result));
      assert.equal(
        fs.readFileSync(path.join(root, '.cache/core/coverage.md'), 'utf8'),
        goCoverageMarkdown(result),
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(root, '.cache/core/coverage.json'), 'utf8')),
        result,
      );
    } else {
      assert.equal(fs.readFileSync(destination, 'utf8'), previous);
      assert.deepEqual(fs.readdirSync(path.join(root, '.cache/core')), []);
    }
  }
});
