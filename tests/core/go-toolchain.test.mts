import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import {
  GO_VERSION,
  coreGoMode,
  goEnvironment,
  resolveGoToolchain,
  runCoreGo,
} from '../../scripts/core/go.mts';
import type { GoRunner } from '../../scripts/core/go.mts';
import { isRecord } from '../../src/contracts/json.mts';

interface Call {
  executable: string;
  args: readonly string[];
  options: SpawnSyncOptionsWithStringEncoding;
}
function fixture({
  version = `go version go${GO_VERSION} linux/amd64\n`,
  local = true,
  formatter = true,
  reportedRoot,
  platform = process.platform,
  command = () => ({ status: 0, stdout: '', stderr: '' }),
}: {
  version?: string;
  local?: boolean;
  formatter?: boolean;
  reportedRoot?: string;
  platform?: NodeJS.Platform;
  command?: GoRunner;
} = {}) {
  const root = path.resolve('isolated-go-toolchain-fixture');
  const goroot = path.join(root, 'verified-go');
  const suffix = platform === 'win32' ? '.exe' : '';
  const go = path.join(root, '.tools', `go${GO_VERSION}`, 'go', 'bin', 'go' + suffix);
  const gofmt = path.join(goroot, 'bin', 'gofmt' + suffix);
  const calls: Call[] = [],
    output: string[] = [];
  const run: GoRunner = (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args[0] === 'version') return { status: 0, stdout: version };
    if (args[0] === 'env') return { status: 0, stdout: (reportedRoot ?? goroot) + '\n' };
    return command(executable, args, options);
  };
  const fileExists = (file: string) => (local && file === go) || (formatter && file === gofmt);
  const env = {
    GOTOOLCHAIN: 'auto',
    GOROOT: 'untrusted-root',
    GOFLAGS: '-x',
    PATH: 'fixture-path',
  };
  const options = {
    root,
    platform,
    run,
    fileExists,
    env,
    write: (text: string) => output.push(text),
  };
  return { root, go, gofmt, calls, output, run, options };
}

test('the explicit pinned install takes precedence and its own formatter is used instead of PATH gofmt', () => {
  const f = fixture(),
    toolchain = resolveGoToolchain(f.root, f.options);
  assert.equal(toolchain.go, f.go);
  assert.equal(toolchain.gofmt, f.gofmt);
  assert.deepEqual(
    f.calls.map((call) => call.args),
    [['version'], ['env', 'GOROOT']],
  );
  for (const call of f.calls) {
    assert.equal(call.executable, f.go);
    assert.equal(call.options.env?.GOTOOLCHAIN, 'local');
    assert.equal(call.options.env?.GOROOT, undefined);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 10000);
  }
  assert.equal(f.options.env.GOTOOLCHAIN, 'auto');
  assert.equal(f.options.env.GOROOT, 'untrusted-root');
});

test('PATH Go is accepted only at the exact release, never silently upgraded or downloaded', () => {
  const accepted = fixture({ local: false });
  assert.equal(resolveGoToolchain(accepted.root, accepted.options).go, 'go');
  for (const version of [
    'go version go1.23.1 windows/amd64\n',
    'go version go1.27.3 linux/amd64\n',
    'go version go1.27rc1 linux/amd64\n',
    'devel go1.27.2\n',
    'arbitrary-private-output',
  ]) {
    const f = fixture({ local: false, version });
    assert.throws(
      () => resolveGoToolchain(f.root, f.options),
      (error) =>
        error instanceof Error &&
        error.message.includes(`Go ${GO_VERSION} is required`) &&
        !error.message.includes(version),
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.executable, 'go');
    assert.equal(f.calls[0]?.options.env?.GOTOOLCHAIN, 'local');
  }
  const wrongLocal = fixture({ version: 'go version go1.23.1 windows/amd64\n' });
  assert.throws(
    () => resolveGoToolchain(wrongLocal.root, wrongLocal.options),
    /exact official toolchain/,
  );
  assert.equal(wrongLocal.calls.length, 1);
  assert.equal(wrongLocal.calls[0]?.executable, wrongLocal.go);
});

test('probe failures and invalid formatter locations fail closed without copying process output into errors', () => {
  const f = fixture();
  for (const result of [
    { status: null, error: Error('private fixture process detail') },
    { status: 1, stdout: `go version go${GO_VERSION} linux/amd64\n` },
  ]) {
    const run: GoRunner = () => result;
    assert.throws(
      () => resolveGoToolchain(f.root, { ...f.options, run }),
      /Go 1\.27\.2 is required/,
    );
  }
  for (const reportedRoot of [
    'relative-root',
    '/root\nother',
    '/root\0bad',
    '/' + 'a'.repeat(4097),
  ]) {
    const bad = fixture({ reportedRoot });
    assert.throws(() => resolveGoToolchain(bad.root, bad.options), /root could not be verified/);
  }
  const missing = fixture({ formatter: false });
  assert.throws(
    () => resolveGoToolchain(missing.root, missing.options),
    /matching pinned Go formatter/,
  );
  const failedEnvironment: GoRunner = (_executable, args) =>
    args[0] === 'version'
      ? { status: 0, stdout: `go version go${GO_VERSION} linux/amd64\n` }
      : { status: 1, stdout: 'private fixture root' };
  assert.throws(
    () => resolveGoToolchain(f.root, { ...f.options, run: failedEnvironment }),
    /root could not be verified/,
  );
});

test('Go environment disables compiler selection and ambient workspace/settings without mutating its source', () => {
  const source = {
    GOTOOLCHAIN: 'auto',
    GOENV: 'private-config',
    GOWORK: 'private-workspace',
    GOROOT: 'old-root',
    GOFLAGS: '-x',
    PATH: 'kept-path',
  };
  const result = goEnvironment(source);
  assert.equal(result.GOTOOLCHAIN, 'local');
  assert.equal(result.GOENV, 'off');
  assert.equal(result.GOWORK, 'off');
  assert.equal(result.GOFLAGS, '-mod=readonly');
  assert.equal(result.GOTELEMETRY, 'off');
  assert.equal(result.GOROOT, undefined);
  assert.equal(result.PATH, 'kept-path');
  assert.equal(source.GOROOT, 'old-root');
});

test('integrated core checks execute format-check, vet and uncached bounded tests inside core only', () => {
  const f = fixture();
  runCoreGo('check', f.options);
  const commands = f.calls.slice(2);
  assert.deepEqual(
    commands.map((call) => call.args),
    [
      ['-l', '.'],
      ['vet', './...'],
      ['test', '-count=1', '-timeout=120s', './...'],
    ],
  );
  assert.deepEqual(
    commands.map((call) => call.executable),
    [f.gofmt, f.go, f.go],
  );
  for (const call of commands) {
    assert.equal(call.options.cwd, path.join(f.root, 'core'));
    assert.equal(call.options.env?.GOTOOLCHAIN, 'local');
    assert.equal(call.options.env?.GOFLAGS, '-mod=readonly');
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 300000);
    assert.equal(call.options.maxBuffer, 8 * 1024 * 1024);
  }
});

test('format writes only on the explicit format action; format-check fails before vet or tests', () => {
  const format = fixture();
  runCoreGo('format', format.options);
  assert.deepEqual(format.calls.at(-1)?.args, ['-w', '.']);
  const dirty = fixture({ command: () => ({ status: 0, stdout: 'internal/work/work.go\n' }) });
  assert.throws(() => runCoreGo('check', dirty.options), /run npm run format:go/);
  assert.equal(dirty.calls.length, 3);
  assert.deepEqual(dirty.output, ['internal/work/work.go\n']);
});

test('failed or timed out commands stop checks and report the failed stage', () => {
  for (const result of [
    { status: 2, stderr: 'fixture compile failure' },
    { status: null, error: Error('fixture timeout') },
  ]) {
    const f = fixture({ command: () => result });
    assert.throws(() => runCoreGo('vet', f.options), /Go core vet failed/);
    assert.equal(f.calls.length, 3);
    if ('stderr' in result) assert.deepEqual(f.output, [result.stderr]);
  }
});

test('Linux race tests require their compiler prerequisite and never turn into a skipped Windows check', () => {
  const unsupported = fixture({ platform: 'win32' });
  assert.throws(
    () => runCoreGo('race', unsupported.options),
    /requires Linux and a working C compiler/,
  );
  assert.equal(unsupported.calls.length, 0);
  const linux = fixture({ platform: 'linux' });
  runCoreGo('race', linux.options);
  assert.deepEqual(linux.calls.at(-1)?.args, [
    'test',
    '-race',
    '-count=1',
    '-timeout=120s',
    './...',
  ]);
  assert.equal(linux.calls.at(-1)?.options.env?.CGO_ENABLED, '1');
  assert.equal(linux.calls.at(-1)?.options.env?.GOTOOLCHAIN, 'local');
});

test('the command boundary rejects missing, unknown and additional arguments', () => {
  for (const mode of ['format', 'format-check', 'vet', 'test', 'check', 'race'])
    assert.equal(coreGoMode([mode]), mode);
  for (const args of [[], ['other'], ['test', '--extra']])
    assert.throws(() => coreGoMode(args), /Usage:/);
});

test('npm scripts and dedicated CI retain all core gates and the same exact toolchain version', () => {
  const manifest: unknown = JSON.parse(
    fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  assert.ok(isRecord(manifest) && isRecord(manifest.scripts));
  const scripts = manifest.scripts;
  assert.equal(scripts['format:go'], 'node scripts/core/go.mts format');
  assert.equal(scripts['format:go:check'], 'node scripts/core/go.mts format-check');
  assert.match(String(scripts.format), /npm run format:go$/);
  assert.match(String(scripts['format:check']), /npm run format:go:check$/);
  assert.equal(scripts['check:core'], 'node scripts/core/go.mts check');
  assert.equal(scripts['check:contracts'], 'node scripts/core/generate-contracts.mts --check');
  const workflow = fs.readFileSync(
    new URL('../../.github/workflows/core.yml', import.meta.url),
    'utf8',
  );
  assert.ok(workflow.includes(`go-version: '${GO_VERSION}'`));
  assert.match(workflow, /GOTOOLCHAIN: local/);
  assert.match(workflow, /os: \[ubuntu-24\.04, windows-2025\]/);
  assert.match(workflow, /run: npm run check:contracts/);
  assert.match(workflow, /run: npm run check:core/);
  assert.match(workflow, /if: runner\.os == 'Linux'\s+run: npm run test:core:race/);
  for (const match of workflow.matchAll(/uses: actions\/[^@\s]+@([^\s]+)/g))
    assert.match(match[1] ?? '', /^[a-f0-9]{40}$/);
  const module = fs.readFileSync(new URL('../../core/go.mod', import.meta.url), 'utf8');
  assert.ok(module.includes('go ' + GO_VERSION));
});
