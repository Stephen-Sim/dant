import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import type { BashCoverageRunner } from '../../../scripts/ci/bash-coverage.mts';
import {
  parseBashCoverage,
  bashCoverageMarkdown,
  runBashCoverage,
} from '../../../scripts/ci/bash-coverage.mts';

const expected = ['vm/bootstrap.sh', 'vm/start-codex.sh'];
const row = (file: string, covered = '1', total = '2') => ({
  file,
  covered_lines: covered,
  total_lines: total,
  percent_covered: '100.00',
});
test('original Bash entrypoints preserve readiness/failure and launch only synthetic fixture commands', () => {
  const bash =
    process.platform === 'win32'
      ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')
      : 'bash';
  const result = spawnSync(bash, ['--noprofile', '--norc', 'tests/bash/run.test.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Bash runtime fixtures passed/);
});
test('Bash coverage uses kcov executable counts, retains missing scripts and does not claim Python heredoc coverage', () => {
  const report = parseBashCoverage(
    { files: [row(expected[0]!, '1', '9'), row(expected[1]!, '1', '1')] },
    process.cwd(),
    expected,
  );
  assert.equal(report.covered, 2);
  assert.equal(report.total, 10);
  assert.deepEqual(report.missing, []);
  assert.match(bashCoverageMarkdown(report), /20\.00% \(2\/10\)/);
  assert.match(bashCoverageMarkdown(report), /does not prove that a Python heredoc was exercised/);
  const missing = parseBashCoverage({ files: [row(expected[0]!)] }, process.cwd(), expected);
  assert.deepEqual(missing.missing, [expected[1]]);
  assert.match(bashCoverageMarkdown(missing), /start-codex\.sh` \| Not measured/);
});
test('empty, impossible, duplicate or malformed Bash counts cannot imply full coverage', () => {
  for (const value of [
    null,
    {},
    { files: [] },
    { files: [row(expected[0]!, '3', '2')] },
    { files: [row(expected[0]!, '-1')] },
    { files: [row(expected[0]!, '1.5')] },
    { files: [row(expected[0]!), row(expected[0]!)] },
  ])
    assert.throws(() => parseBashCoverage(value, process.cwd(), expected));
  assert.throws(() =>
    parseBashCoverage({ files: [row(expected[0]!)] }, process.cwd(), ['vm/unsafe|.sh']),
  );
});

function collectorFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-bash-collector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'vm'));
  for (const file of expected)
    fs.writeFileSync(
      path.join(root, file),
      'exit 99 # Source discovery must not execute fixtures.\n',
    );
  const output = path.join(root, '.cache/coverage/bash');
  const generated = path.join(output, 'runtime.test.sh/coverage.json');
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  const report = { files: expected.map((file) => row(file, '1', '2')) };
  for (const file of [
    'coverage.json',
    'coverage.md',
    'summary.json',
    'runtime.test.sh/coverage.json',
  ])
    fs.writeFileSync(path.join(output, file), 'stale-report');
  const calls: Parameters<BashCoverageRunner>[] = [];
  const run: BashCoverageRunner = (...args) => {
    calls.push(args);
    if (args[1][0] === '--version') return { status: 0, stdout: 'kcov v43\n' };
    fs.writeFileSync(generated, JSON.stringify(report));
    return { status: 0 };
  };
  const published = () =>
    ['coverage.json', 'coverage.md', 'summary.json'].filter((file) =>
      fs.existsSync(path.join(output, file)),
    );
  return { root, output, generated, report, calls, run, published };
}

test('Bash collector uses the pinned upstream version/options and publishes actual counts with complete inventory', (t) => {
  const fixture = collectorFixture(t);
  const summary = path.join(fixture.root, 'summary.md');
  const messages: string[] = [];
  const environment = { GITHUB_STEP_SUMMARY: summary, FIXTURE_ONLY: 'preserved' };
  const local = path.join(fixture.root, '.tools/kcov/bin/kcov');
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, 'Never execute this synthetic file.');
  runBashCoverage(fixture.root, {
    platform: 'linux',
    environment,
    write: (message) => messages.push(message),
    run: (...args) => {
      assert.equal(args[0], local);
      assert.equal(args[2].shell, false);
      assert.equal(args[2].encoding, 'utf8');
      assert.equal(args[2].cwd, fixture.root);
      assert.equal(args[2].env?.FIXTURE_ONLY, 'preserved');
      assert.deepEqual(fixture.published(), []);
      assert.equal(fs.existsSync(fixture.generated), false);
      return fixture.run(...args);
    },
  });
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls[0]![1], ['--version']);
  const [, args, options] = fixture.calls[1]!;
  assert.deepEqual(args, [
    '--clean',
    '--bash-method=DEBUG',
    `--bash-parse-files-in-dirs=${path.join(fixture.root, 'vm')}`,
    `--include-path=${path.join(fixture.root, 'vm')}`,
    fixture.output,
    path.join(fixture.root, 'tests/bash/runtime.test.sh'),
  ]);
  assert.equal(options.timeout, 120_000);
  assert.equal(options.env?.DANT_BASH_REPOSITORY, fixture.root);
  assert.equal(fs.existsSync(options.env!.DANT_BASH_FIXTURE_ROOT!), false);
  assert.deepEqual(fixture.published().sort(), ['coverage.json', 'coverage.md', 'summary.json']);
  assert.equal(messages.length, 1);
  assert.equal(fs.readFileSync(summary, 'utf8'), messages[0]);
  assert.match(messages[0]!, /50\.00% \(2\/4\)/);
  const measured: unknown = JSON.parse(
    fs.readFileSync(path.join(fixture.output, 'summary.json'), 'utf8'),
  );
  assert.deepEqual(measured, {
    tool: 'kcov 43',
    files: expected.map((file) => ({ file, covered: 1, total: 2 })),
    covered: 2,
    total: 4,
    missing: [],
  });
});

test('unsupported platforms and malformed or unpinned tools clear stale reports without running fixtures', (t) => {
  for (const probe of [
    { status: 0, stdout: 'kcov v42\n' },
    { status: 0, stdout: 'kcov v43-dirty\n' },
    { status: 0, stdout: 'kcov v43.1\n' },
    { status: 0, stdout: 'kcov 43\n' },
    { status: 0, stdout: 'kcov v43\nprivate-tool-output' },
    { status: 0, stdout: ' '.repeat(4097) + 'kcov v43' },
    { status: 0 },
    { status: null, stdout: 'kcov v43' },
    { status: 1, stdout: 'kcov v43' },
    { status: 0, stdout: 'kcov v43', error: Error('private-tool-error') },
  ]) {
    const fixture = collectorFixture(t);
    let calls = 0;
    assert.throws(
      () =>
        runBashCoverage(fixture.root, {
          platform: 'linux',
          run: () => {
            calls++;
            return probe;
          },
        }),
      { message: 'The pinned kcov 43 tool is required.' },
    );
    assert.equal(calls, 1);
    assert.deepEqual(fixture.published(), []);
    assert.equal(fs.existsSync(fixture.generated), false);
  }
  const fixture = collectorFixture(t);
  assert.throws(
    () =>
      runBashCoverage(fixture.root, { platform: 'win32', run: () => assert.fail('must not run') }),
    /No platform skip is counted as coverage/,
  );
  assert.deepEqual(fixture.published(), []);
});

test('fixture failures and missing current instrumentation cannot reuse old passing reports', (t) => {
  for (const result of [
    { status: 1 },
    { status: null },
    { status: 0, error: Error('private-runtime-error') },
    { status: 0 },
  ]) {
    const fixture = collectorFixture(t);
    const calls: Parameters<BashCoverageRunner>[] = [];
    assert.throws(() =>
      runBashCoverage(fixture.root, {
        platform: 'linux',
        run: (...args) => {
          calls.push(args);
          return args[1][0] === '--version' ? { status: 0, stdout: 'kcov v43' } : result;
        },
      }),
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(fixture.published(), []);
    assert.equal(fs.existsSync(calls[1]![2].env!.DANT_BASH_FIXTURE_ROOT!), false);
  }
});

test('malformed or oversized reports fail without exposing raw output; missing sources remain visible', (t) => {
  for (const body of [
    'private-report-content',
    JSON.stringify({ files: [] }),
    'oversized',
    'missing-source',
  ]) {
    const fixture = collectorFixture(t);
    const messages: string[] = [];
    assert.throws(
      () =>
        runBashCoverage(fixture.root, {
          platform: 'linux',
          write: (message) => messages.push(message),
          run: (...args) => {
            if (args[1][0] === '--version') return { status: 0, stdout: 'kcov v43' };
            if (body === 'oversized') {
              const descriptor = fs.openSync(fixture.generated, 'w');
              try {
                fs.ftruncateSync(descriptor, 8 * 1024 * 1024 + 1);
              } finally {
                fs.closeSync(descriptor);
              }
            } else
              fs.writeFileSync(
                fixture.generated,
                body === 'missing-source' ? JSON.stringify({ files: [row(expected[0]!)] }) : body,
              );
            return { status: 0 };
          },
        }),
      (error: unknown) =>
        error instanceof Error && !error.message.includes('private-report-content'),
    );
    if (body === 'missing-source') {
      assert.match(messages[0]!, /start-codex\.sh` \| Not measured/);
      assert.equal(fixture.published().length, 3);
    } else assert.deepEqual(fixture.published(), []);
  }
  const fixture = collectorFixture(t);
  for (const file of expected) fs.rmSync(path.join(fixture.root, file));
  assert.throws(
    () => runBashCoverage(fixture.root, { platform: 'linux', run: fixture.run }),
    /No maintained Bash/,
  );
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.published(), []);
});
