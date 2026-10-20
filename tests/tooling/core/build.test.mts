import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildCore } from '../../../scripts/core/build.mts';
import {
  CORE_WINDOWS,
  CORE_LINUX,
  CORE_BUILD_MANIFEST,
  readManifest,
  verifyFiles,
  VM_BUNDLE_FILES,
} from '../../../scripts/core/bundle.mts';
import type { GoRunner } from '../../../scripts/core/go.mts';

const base = path.resolve('.cache/tests/core-build');
fs.mkdirSync(base, { recursive: true });

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(base, 'fixture-'));
  t.after(() => {
    const relative = path.relative(base, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (name: string, text: string) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  write('package.json', JSON.stringify({ version: '1.2.3' }));
  write('src-tauri/tauri.conf.json', JSON.stringify({ version: '1.2.3' }));
  write('src-tauri/Cargo.toml', '[package]\nversion="1.2.3"\n');
  const commit = 'a'.repeat(40);
  const asset = 'core/internal/fixture/assets/config.json';
  write(asset, '{"fixture":true}');
  const state = { dirty: false, fail: false, changed: false, ignoredAsset: false };
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const run: GoRunner = (_executable, args, options) => {
    calls.push({ args, env: options.env });
    if (args[0] === 'version') return { status: 0, stdout: 'go version go1.27.2 windows/amd64\n' };
    if (args[0] === 'env')
      return { status: 0, stdout: path.join(root, 'verified-toolchain') + '\n' };
    if (state.fail) return { status: 1, stderr: 'bounded isolated compiler failure' };
    if (args[0] === 'list')
      return {
        status: 0,
        stdout:
          JSON.stringify({
            directory: path.join(root, 'core/internal/fixture'),
            files: ['assets/config.json'],
          }) + '\n',
      };
    const output = args[args.indexOf('-o') + 1];
    assert.equal(typeof output, 'string');
    if (!output) throw Error('fixture requires owned compiler output');
    fs.writeFileSync(output, 'compiled ' + options.env?.GOOS);
    if (state.changed) state.dirty = true;
    return { status: 0, stdout: '' };
  };
  const runGit: GoRunner = (_executable, args) => ({
    status: 0,
    stdout:
      args[0] === 'rev-parse'
        ? commit + '\n'
        : args[0] === 'ls-files'
          ? state.ignoredAsset
            ? ''
            : asset + '\0'
          : state.dirty
            ? ' M core/internal/app/worker.go\n'
            : '',
  });
  return {
    root,
    write,
    state,
    calls,
    commit,
    options: {
      root,
      run,
      runGit,
      fileExists: () => true,
      env: { GOTOOLCHAIN: 'auto', GOFLAGS: '-x', GOOS: 'untrusted', GITHUB_SHA: commit },
    },
  };
}

test('production core builds both static targets with exact version/source and a verified artifact manifest', (t) => {
  const f = fixture(t),
    result = buildCore(f.options);
  assert.equal(result.directory, path.join(f.root, '.cache/core/build'));
  const manifest = readManifest(
    path.join(result.directory, CORE_BUILD_MANIFEST),
    [CORE_WINDOWS, CORE_LINUX],
    '1.2.3',
    f.commit,
  );
  verifyFiles(result.directory, manifest);
  const builds = f.calls.filter((call) => call.args[0] === 'build');
  assert.equal(builds.length, 2);
  assert.deepEqual(
    builds.map((call) => call.env?.GOOS),
    ['windows', 'linux'],
  );
  for (const call of builds) {
    assert.equal(call.env?.CGO_ENABLED, '0');
    assert.equal(call.env?.GOARCH, 'amd64');
    assert.equal(call.env?.GOTOOLCHAIN, 'local');
    assert.equal(call.env?.GOFLAGS, '-mod=readonly');
    assert.ok(call.args.includes('-trimpath'));
    assert.ok(call.args.includes('-buildvcs=false'));
    assert.match(
      call.args[call.args.indexOf('-ldflags') + 1] ?? '',
      new RegExp('buildinfo.Source=' + f.commit),
    );
    assert.match(call.args[call.args.indexOf('-ldflags') + 1] ?? '', /buildinfo.Version=1\.2\.3/);
  }
});

test('dirty source, compiler failure and source changes never replace the previous verified build', (t) => {
  for (const mode of ['dirty', 'fail', 'changed'] as const) {
    const f = fixture(t);
    const previous = f.write('.cache/core/build/keep.txt', 'previous');
    f.state[mode] = true;
    assert.throws(() => buildCore(f.options));
    assert.equal(fs.readFileSync(previous, 'utf8'), 'previous');
    assert.equal(
      fs
        .readdirSync(path.dirname(path.dirname(previous)))
        .some((name) => name.startsWith('.dant-core-')),
      false,
    );
    if (mode === 'dirty') assert.equal(f.calls.length, 0);
  }
});

test('unverified source SHA and unsafe output destinations fail before compilation or deletion', (t) => {
  const f = fixture(t),
    outside = f.write('private/keep.txt', 'keep');
  assert.throws(
    () => buildCore({ ...f.options, env: { GITHUB_SHA: 'b'.repeat(40) } }),
    /source commit/,
  );
  for (const outputDir of [
    f.root,
    path.join(f.root, '.cache/core'),
    path.join(f.root, 'private'),
    path.join(f.root, '.cache/core/build/child'),
  ])
    assert.throws(() => buildCore({ ...f.options, outputDir }), /owned build directory/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.equal(f.calls.length, 0);
});

test('artifact verification rejects changed bytes and unsupported manifest paths', (t) => {
  const f = fixture(t),
    result = buildCore(f.options);
  fs.appendFileSync(path.join(result.directory, CORE_LINUX), 'changed');
  assert.throws(() => verifyFiles(result.directory, result.manifest), /verified manifest/);
  const manifest = {
    ...result.manifest,
    files: result.manifest.files.map((item, index) =>
      index === 0 ? { ...item, path: '../private' } : item,
    ),
  };
  fs.writeFileSync(path.join(result.directory, CORE_BUILD_MANIFEST), JSON.stringify(manifest));
  assert.throws(
    () =>
      readManifest(
        path.join(result.directory, CORE_BUILD_MANIFEST),
        [CORE_WINDOWS, CORE_LINUX],
        '1.2.3',
      ),
    /invalid file/,
  );
});

test('ignored embedded assets fail provenance checks before either binary is built', (t) => {
  const f = fixture(t);
  f.state.ignoredAsset = true;
  const previous = f.write('.cache/core/build/keep.txt', 'previous');
  assert.throws(() => buildCore(f.options), /embedded Go input must belong to the source commit/);
  assert.equal(f.calls.filter((call) => call.args[0] === 'build').length, 0);
  assert.equal(fs.readFileSync(previous, 'utf8'), 'previous');
});

test('VM resource allowlist matches both the Go deployer and Python cutover installer', () => {
  const go = fs.readFileSync('core/internal/computer/deployment.go', 'utf8');
  const goBlock = go.match(/var bundleAllowlist = map\[string\]bool\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(goBlock);
  const goFiles = [...goBlock.matchAll(/"([^"\n]+)"\s*:\s*true/g)]
    .map((match) => match[1])
    .filter((name): name is string => !!name);
  const goConfig = fs.readFileSync('core/internal/config/network.go', 'utf8');
  const protocolPath = goConfig.match(/\bProtocolResourcePath\s*=\s*"([^"\n]+)"/)?.[1];
  assert.equal(protocolPath, 'resources/config/protocol.json');
  assert.match(goBlock, /\bconfig\.ProtocolResourcePath\s*:\s*true/);
  goFiles.push(protocolPath);
  goFiles.push('resources/core/dant-core-linux-amd64');
  const python = fs.readFileSync('vm/worker-install.py', 'utf8');
  const pythonBlock = python.match(/ALLOWLIST = frozenset\(\{([\s\S]*?)\}\)/)?.[1];
  assert.ok(pythonBlock);
  assert.match(python, /^PROTOCOL_PATH = 'resources\/config\/protocol\.json'$/m);
  assert.match(python, /^LEGACY_PROTOCOL_PATH = 'src\/config\/protocol\.json'$/m);
  assert.match(pythonBlock, /\bPROTOCOL_PATH,/);
  const pythonFiles = [...pythonBlock.matchAll(/'([^'\n]+)'/g)]
    .map((match) => match[1])
    .filter((name): name is string => !!name);
  pythonFiles.push('resources/core/dant-core-linux-amd64');
  pythonFiles.push(protocolPath);
  assert.equal(
    VM_BUNDLE_FILES.some((name) => name.startsWith('src/')),
    false,
  );
  assert.deepEqual([...VM_BUNDLE_FILES].sort(), goFiles.sort());
  assert.deepEqual([...VM_BUNDLE_FILES].sort(), pythonFiles.sort());
});
