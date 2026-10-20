import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseTypeScriptCoverage,
  typeScriptCoverageMarkdown,
  typeScriptSources,
  runTypeScriptCoverage,
  C8_VERSION,
} from '../../../scripts/ci/typescript-coverage.mts';
import type { TypeScriptCoverageRunner } from '../../../scripts/ci/typescript-coverage.mts';
import type { TestContext } from 'node:test';

const location = (line = 1) => ({ start: { line, column: 0 }, end: { line, column: 8 } });

const file = (name: string, hit = 0) => ({
  path: name,
  s: { '0': hit, '1': 0, '2': 0 },
  statementMap: {
    '0': location(),
    '1': location(),
    '2': location(2),
  },
  f: { '0': hit },
  fnMap: { '0': { name: 'synthetic', line: 1, decl: location(), loc: location() } },
  b: { '0': [hit, 0] },
  branchMap: {
    '0': { type: 'branch', line: 1, loc: location(), locations: [location(), location()] },
  },
});

test('every statement, function and branch counter must have one valid source mapping', () => {
  const original = file('ui/main.mts', 1);
  for (const record of [
    { ...original, s: {} },
    { ...original, s: { ...original.s, extra: 1 } },
    { ...original, statementMap: {} },
    { ...original, statementMap: { ...original.statementMap, extra: location() } },
    {
      ...original,
      statementMap: {
        ...original.statementMap,
        '0': { start: { line: 1 }, end: { line: 1, column: 1 } },
      },
    },
    {
      ...original,
      statementMap: {
        ...original.statementMap,
        '0': { start: { line: 2, column: 5 }, end: { line: 1, column: 6 } },
      },
    },
    {
      ...original,
      statementMap: {
        ...original.statementMap,
        '0': { start: { line: 1, column: -1 }, end: { line: 1, column: 1 } },
      },
    },
    {
      ...original,
      statementMap: {
        ...original.statementMap,
        '0': { start: { line: 0, column: 0 }, end: { line: 1, column: 1 } },
      },
    },
    {
      ...original,
      statementMap: {
        ...original.statementMap,
        '0': { start: { line: 1, column: 5 }, end: { line: 1, column: 4 } },
      },
    },
    { ...original, f: {} },
    { ...original, f: { ...original.f, extra: 1 } },
    { ...original, fnMap: {} },
    { ...original, fnMap: { ...original.fnMap, extra: original.fnMap['0'] } },
    { ...original, fnMap: { '0': { ...original.fnMap['0'], loc: null } } },
    { ...original, fnMap: { '0': { ...original.fnMap['0'], decl: {} } } },
    { ...original, fnMap: { '0': { ...original.fnMap['0'], name: 3 } } },
    { ...original, fnMap: { '0': { ...original.fnMap['0'], line: 0 } } },
    { ...original, b: {} },
    { ...original, b: { ...original.b, extra: [1] } },
    { ...original, b: { '0': [1] } },
    {
      ...original,
      b: { '0': [] },
      branchMap: { '0': { ...original.branchMap['0'], locations: [] } },
    },
    { ...original, branchMap: {} },
    { ...original, branchMap: { ...original.branchMap, extra: original.branchMap['0'] } },
    { ...original, branchMap: { '0': { ...original.branchMap['0'], loc: null } } },
    {
      ...original,
      branchMap: { '0': { ...original.branchMap['0'], locations: [location(), null] } },
    },
    { ...original, branchMap: { '0': { ...original.branchMap['0'], type: '' } } },
    { ...original, branchMap: { '0': { ...original.branchMap['0'], line: 1.5 } } },
  ])
    assert.throws(() =>
      parseTypeScriptCoverage({ source: record }, process.cwd(), ['ui/main.mts']),
    );

  assert.throws(() =>
    parseTypeScriptCoverage({ source: original }, process.cwd(), ['ui/evil|.mts']),
  );
  assert.throws(() =>
    parseTypeScriptCoverage({ source: original }, process.cwd(), ['ui/main.mts', 'ui/main.mts']),
  );
  const empty = { ...original, s: {}, statementMap: {}, f: {}, fnMap: {}, b: {}, branchMap: {} };
  const parsed = parseTypeScriptCoverage(
    { empty: { ...empty, path: 'ui/types.mts' }, source: original },
    process.cwd(),
    ['ui/types.mts', 'ui/main.mts'],
  );
  assert.match(typeScriptCoverageMarkdown(parsed), /No executable points \(0\/0\)/);
});

test('c8 newline branch locations retain their counters without allowing arbitrary negative coordinates', () => {
  const source = file('ui/main.mts', 2);
  const boundary = { start: { line: 69, column: -1 }, end: { line: 69, column: 43 } };
  source.branchMap['0'] = {
    type: 'branch',
    line: 69,
    loc: boundary,
    locations: [boundary, location(70)],
  };
  const parsed = parseTypeScriptCoverage({ source }, process.cwd(), ['ui/main.mts']);
  assert.deepEqual(parsed.overall.branches, { covered: 1, total: 2 });
  boundary.start.column = -2;
  assert.throws(() => parseTypeScriptCoverage({ source }, process.cwd(), ['ui/main.mts']));
});

function runnerFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-ts-collector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of [
    'ui/main.mts',
    'scripts/build.mts',
    'vite.config.mts',
    'node_modules/c8/package.json',
  ]) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      name.endsWith('.json') ? JSON.stringify({ version: C8_VERSION }) : 'synthetic source',
    );
  }
  const output = path.join(root, '.cache/coverage/typescript');
  fs.mkdirSync(output, { recursive: true });
  const outputs = ['coverage-final.json', 'lcov.info', 'coverage.md', 'summary.json'];
  for (const name of outputs) fs.writeFileSync(path.join(output, name), 'stale-private-report');
  const expected = ['ui/main.mts', 'scripts/build.mts', 'vite.config.mts'];
  const write = (
    input: unknown = Object.fromEntries(
      expected.map((name, index) => [name, file(name, index === 0 ? 2 : 0)]),
    ),
  ) => {
    fs.writeFileSync(path.join(output, 'coverage-final.json'), JSON.stringify(input));
    fs.writeFileSync(path.join(output, 'lcov.info'), 'synthetic-lcov');
  };
  const assertFresh = () => {
    for (const name of outputs) assert.equal(fs.existsSync(path.join(output, name)), false, name);
  };
  return {
    root,
    output,
    expected,
    write,
    assertFresh,
    summary: path.join(root, 'step-summary.md'),
  };
}

test('collector invokes locked c8 once over the complete inventory and publishes only fresh measured results', (t) => {
  const fixture = runnerFixture(t);
  fs.writeFileSync(fixture.summary, 'Previous independent summary\n');
  let calls = 0;
  const environment = { GITHUB_STEP_SUMMARY: fixture.summary, SYNTHETIC_OPTION: 'kept' };
  const run: TypeScriptCoverageRunner = (executable, args, options) => {
    calls++;
    fixture.assertFresh();
    assert.equal(executable, process.execPath);
    assert.equal(args[0], path.join(fixture.root, 'node_modules/c8/bin/c8.js'));
    for (const option of [
      '--all',
      '--extension=.mts',
      '--include=ui/**/*.mts',
      '--include=scripts/**/*.mts',
      '--include=vite.config.mts',
      '--reporter=json',
      '--reporter=lcovonly',
    ])
      assert.ok(args.includes(option));
    assert.deepEqual(args.slice(-2), [process.execPath, 'scripts/ci/coverage.mts']);
    assert.equal(options.cwd, fixture.root);
    assert.equal(options.env, environment);
    assert.equal(options.shell, false);
    fixture.write();
    return { status: 0 };
  };
  runTypeScriptCoverage(fixture.root, { run, env: environment });
  assert.equal(calls, 1);
  const result: unknown = JSON.parse(
    fs.readFileSync(path.join(fixture.output, 'summary.json'), 'utf8'),
  );
  assert.deepEqual(
    result,
    parseTypeScriptCoverage(
      JSON.parse(fs.readFileSync(path.join(fixture.output, 'coverage-final.json'), 'utf8')),
      fixture.root,
      fixture.expected.sort(),
    ),
  );
  const markdown = fs.readFileSync(path.join(fixture.output, 'coverage.md'), 'utf8');
  assert.match(markdown, /16\.67% \(1\/6\)/);
  assert.match(markdown, /`scripts\/build\.mts`.*0\.00%/);
  assert.equal(
    fs.readFileSync(fixture.summary, 'utf8'),
    'Previous independent summary\n' + markdown,
  );
  assert.doesNotMatch(markdown, /stale-private-report/);
});

test('collector fails closed before execution when its c8 package does not match the pinned dependency', (t) => {
  const fixture = runnerFixture(t);
  fs.writeFileSync(
    path.join(fixture.root, 'node_modules/c8/package.json'),
    JSON.stringify({ version: '0.0.0' }),
  );
  assert.throws(
    () =>
      runTypeScriptCoverage(fixture.root, {
        run: () => {
          throw Error('child must not start');
        },
        env: {},
      }),
    /locked c8/,
  );
  fixture.assertFresh();
  const manifest: unknown = JSON.parse(
    fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  assert.ok(manifest && typeof manifest === 'object');
  const dependencies: unknown = Reflect.get(manifest, 'devDependencies');
  assert.ok(dependencies && typeof dependencies === 'object');
  assert.equal(Reflect.get(dependencies, 'c8'), C8_VERSION);
  const lock: unknown = JSON.parse(
    fs.readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'),
  );
  assert.ok(lock && typeof lock === 'object');
  const packages: unknown = Reflect.get(lock, 'packages');
  assert.ok(packages && typeof packages === 'object');
  const installed: unknown = Reflect.get(packages, 'node_modules/c8');
  assert.ok(installed && typeof installed === 'object');
  assert.equal(Reflect.get(installed, 'version'), C8_VERSION);
});

test('missing and malformed package metadata never launches a collector or preserves old reports', (t) => {
  for (const contents of [null, 'not JSON', '{}', '{"version":1}']) {
    const fixture = runnerFixture(t);
    const packagePath = path.join(fixture.root, 'node_modules/c8/package.json');
    if (contents === null) fs.rmSync(packagePath);
    else fs.writeFileSync(packagePath, contents);
    let calls = 0;
    assert.throws(
      () =>
        runTypeScriptCoverage(fixture.root, {
          run: () => {
            calls++;
            return { status: 0 };
          },
          env: {},
        }),
      /locked c8/,
    );
    assert.equal(calls, 0);
    fixture.assertFresh();
  }
});

test('child failures, missing and malformed reports cannot reuse stale successful artifacts', (t) => {
  for (const failure of [
    'exit',
    'partial-exit',
    'error',
    'throw',
    'missing',
    'invalid',
    'syntax',
    'oversized',
  ] as const) {
    const fixture = runnerFixture(t);
    let calls = 0;
    const run: TypeScriptCoverageRunner = () => {
      calls++;
      fixture.assertFresh();
      if (failure === 'exit') return { status: 1 };
      if (failure === 'partial-exit') {
        fixture.write();
        return { status: 1 };
      }
      if (failure === 'error') return { status: null, error: Error('PRIVATE_CHILD_OUTPUT') };
      if (failure === 'throw') throw Error('PRIVATE_CHILD_OUTPUT');
      if (failure === 'invalid')
        fs.writeFileSync(path.join(fixture.output, 'coverage-final.json'), '{}');
      if (failure === 'syntax')
        fs.writeFileSync(
          path.join(fixture.output, 'coverage-final.json'),
          'PRIVATE_CHILD_OUTPUT not JSON',
        );
      if (failure === 'oversized') {
        const descriptor = fs.openSync(path.join(fixture.output, 'coverage-final.json'), 'w');
        try {
          fs.ftruncateSync(descriptor, 64 * 1024 * 1024 + 1);
        } finally {
          fs.closeSync(descriptor);
        }
      }
      return { status: 0 };
    };
    assert.throws(
      () =>
        runTypeScriptCoverage(fixture.root, { run, env: { GITHUB_STEP_SUMMARY: fixture.summary } }),
      (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE_CHILD_OUTPUT'),
    );
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(fixture.output, 'summary.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.output, 'coverage.md')), false);
    assert.equal(fs.existsSync(fixture.summary), false);
  }
});

test('a missing maintained source produces an explicit incomplete report and a failing collection', (t) => {
  const fixture = runnerFixture(t);
  assert.throws(
    () =>
      runTypeScriptCoverage(fixture.root, {
        run: () => {
          fixture.write({ source: file('ui/main.mts', 1) });
          return { status: 0 };
        },
        env: { GITHUB_STEP_SUMMARY: fixture.summary },
      }),
    /inventory is incomplete/,
  );
  const markdown = fs.readFileSync(fixture.summary, 'utf8');
  assert.match(markdown, /FAIL: TypeScript source inventory is incomplete/);
  assert.match(markdown, /scripts\/build\.mts` \| Not measured/);
});

test('full TypeScript coverage includes unloaded entrypoints and tools without changing the UI gates', () => {
  const expected = ['ui/main.mts', 'scripts/ci/version.mts'];
  const result = parseTypeScriptCoverage(
    { a: file(expected[0]!, 2), b: file(expected[1]!) },
    process.cwd(),
    expected,
  );
  assert.deepEqual(result.overall, {
    lines: { covered: 1, total: 4 },
    functions: { covered: 1, total: 2 },
    branches: { covered: 1, total: 4 },
  });
  assert.deepEqual(result.missing, []);
  const markdown = typeScriptCoverageMarkdown(result);
  assert.match(markdown, /25\.00% \(1\/4\)/);
  assert.match(markdown, /`scripts\/ci\/version\.mts` \| 0\.00% \(0\/2\)/);
  assert.match(markdown, /existing UI feature gates remain independently enforced/);
});

test('a missing source is visible, and malformed counters or duplicate records never become 100%', () => {
  const expected = ['ui/main.mts', 'scripts/ci/version.mts'];
  const result = parseTypeScriptCoverage({ a: file(expected[0]!, 1) }, process.cwd(), expected);
  assert.deepEqual(result.missing, [expected[1]]);
  assert.match(typeScriptCoverageMarkdown(result), /version\.mts` \| Not measured/);
  for (const input of [
    null,
    {},
    { a: null },
    { a: file(expected[0]!), b: file(expected[0]!) },
    { a: { ...file(expected[0]!), s: { '0': -1 } } },
    { a: { ...file(expected[0]!), b: { '0': [Number.NaN] } } },
    { a: { ...file(expected[0]!), f: { '0': '1' } } },
  ])
    assert.throws(() => parseTypeScriptCoverage(input, process.cwd(), expected));
});

test('TypeScript inventory includes all feature/tool modules and the Vite entrypoint', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-ts-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'ui/chat'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/ci'), { recursive: true });
  for (const file of [
    'ui/main.mts',
    'ui/chat/window.mts',
    'ui/types.ts',
    'scripts/ci/build.mts',
    'vite.config.mts',
  ])
    fs.writeFileSync(path.join(root, file), 'fixture');
  assert.deepEqual(typeScriptSources(root), [
    'scripts/ci/build.mts',
    'ui/chat/window.mts',
    'ui/main.mts',
    'vite.config.mts',
  ]);
});

test('inventory rejects linked feature trees and a non-file Vite entrypoint', (t) => {
  const fixture = runnerFixture(t);
  const target = path.join(fixture.root, 'isolated-target');
  fs.mkdirSync(target);
  const link = path.join(fixture.root, 'ui/linked');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => typeScriptSources(fixture.root), /symbolic link/);
  fs.unlinkSync(link);
  const vite = path.join(fixture.root, 'vite.config.mts');
  fs.rmSync(vite);
  fs.mkdirSync(vite);
  assert.throws(() => typeScriptSources(fixture.root), /entrypoint is not a regular file/);
});
