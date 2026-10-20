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

test('core build publication retries Windows locks without recompiling or changing verified bytes', (t) => {
  const f = fixture(t),
    delays: number[] = [],
    clock = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let attempts = 0;
  const result = buildCore({
    ...f.options,
    platform: 'win32',
    pause: (milliseconds) => {
      delays.push(milliseconds);
      Atomics.wait(clock, 0, 0, milliseconds);
    },
    renameSync: (source, destination) => {
      if (++attempts === 1) throw Object.assign(Error('Synthetic scanner lock'), { code: 'EPERM' });
      fs.renameSync(source, destination);
    },
  });
  assert.ok(attempts >= 2 && attempts <= 6);
  assert.deepEqual(
    delays,
    Array.from({ length: attempts - 1 }, (_, index) => (index + 1) * 50),
  );
  assert.equal(f.calls.filter((call) => call.args[0] === 'build').length, 2);
  verifyFiles(result.directory, result.manifest);
  assert.equal(
    fs.readFileSync(path.join(result.directory, CORE_WINDOWS), 'utf8'),
    'compiled windows',
  );
  assert.equal(fs.readFileSync(path.join(result.directory, CORE_LINUX), 'utf8'), 'compiled linux');
});

test('permanent publication locks are bounded and unrelated or non-Windows errors do not retry', (t) => {
  for (const [code, platform, expectedAttempts] of [
    ['EPERM', 'win32', 6],
    ['EACCES', 'win32', 6],
    ['EBUSY', 'win32', 6],
    ['EINVAL', 'win32', 1],
    ['EPERM', 'linux', 1],
  ] as const) {
    const f = fixture(t),
      delays: number[] = [];
    let attempts = 0,
      staging = '';
    assert.throws(
      () =>
        buildCore({
          ...f.options,
          platform,
          pause: (milliseconds) => delays.push(milliseconds),
          renameSync: (source) => {
            staging = String(source);
            attempts++;
            throw Object.assign(Error('Synthetic permanent lock'), { code });
          },
        }),
      /could not be published/,
    );
    assert.equal(attempts, expectedAttempts);
    assert.deepEqual(
      delays,
      Array.from({ length: expectedAttempts - 1 }, (_, index) => (index + 1) * 50),
    );
    assert.equal(fs.existsSync(path.join(f.root, '.cache/core/build')), false);
    assert.ok(staging);
    const manifest = readManifest(
      path.join(staging, CORE_BUILD_MANIFEST),
      [CORE_WINDOWS, CORE_LINUX],
      '1.2.3',
      f.commit,
    );
    verifyFiles(staging, manifest);
    assert.equal(f.calls.filter((call) => call.args[0] === 'build').length, 2);
  }
});

test('a binary changed while its peer is being verified cannot become the publication baseline', (t) => {
  const f = fixture(t),
    originalRead = fs.readSync;
  let linuxReads = 0,
    renames = 0,
    changed = '';
  t.mock.method(
    fs,
    'readSync',
    (
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset?: number | fs.ReadOptions,
      length?: number,
      position?: fs.ReadPosition | null,
    ) => {
      const count =
        typeof offset === 'number'
          ? originalRead(descriptor, buffer, offset, length ?? 0, position ?? null)
          : originalRead(descriptor, buffer, offset);
      const linux = f.calls.findLast(
        (call) => call.args[0] === 'build' && call.env?.GOOS === 'linux',
      );
      const file = linux?.args[(linux?.args.indexOf('-o') ?? -1) + 1];
      if (count === 0 && file && fs.existsSync(file)) {
        const opened = fs.fstatSync(descriptor, { bigint: true }),
          target = fs.lstatSync(file, { bigint: true });
        if (opened.dev === target.dev && opened.ino === target.ino && ++linuxReads === 3) {
          changed = path.join(path.dirname(file), CORE_WINDOWS);
          fs.writeFileSync(changed, 'modified windows');
        }
      }
      return count;
    },
  );
  assert.throws(
    () =>
      buildCore({
        ...f.options,
        renameSync: () => {
          renames++;
        },
      }),
    /changed during publication/,
  );
  assert.ok(changed, 'the simulated concurrent mutation must actually run');
  assert.equal(renames, 0);
  assert.equal(fs.readFileSync(changed, 'utf8'), 'modified windows');
  assert.equal(fs.existsSync(path.join(f.root, '.cache/core/build')), false);
});

test('publication aborts on changed artifacts, manifests, staging identities, parents and destinations', (t) => {
  for (const kind of ['binary', 'manifest', 'source', 'parent', 'destination'] as const) {
    const f = fixture(t);
    let attempts = 0,
      staging = '',
      destination = '',
      preserved = '';
    assert.throws(
      () =>
        buildCore({
          ...f.options,
          platform: 'win32',
          renameSync: (source, target) => {
            staging = String(source);
            destination = String(target);
            attempts++;
            throw Object.assign(Error('Synthetic scanner lock'), { code: 'EPERM' });
          },
          pause: () => {
            assert.equal(path.dirname(staging), path.join(f.root, '.cache/core'));
            assert.match(path.basename(staging), /^\.dant-core-[A-Za-z0-9]{6}$/);
            if (kind === 'binary') {
              preserved = path.join(staging, CORE_LINUX);
              fs.writeFileSync(preserved, 'modified linux');
            } else if (kind === 'manifest') {
              preserved = path.join(staging, CORE_BUILD_MANIFEST);
              fs.appendFileSync(preserved, '\n');
            } else {
              const replaced =
                kind === 'source'
                  ? staging
                  : kind === 'parent'
                    ? path.dirname(staging)
                    : destination;
              if (kind !== 'destination') fs.rmSync(replaced, { recursive: true });
              fs.mkdirSync(replaced);
              preserved = path.join(replaced, 'foreign.txt');
              fs.writeFileSync(preserved, 'keep foreign data');
            }
          },
        }),
      /changed during publication/,
    );
    assert.equal(attempts, 1, 'changed ownership or content must stop before a second rename');
    assert.ok(fs.existsSync(preserved), 'publication failure must preserve the changed tree');
    if (kind === 'source' || kind === 'parent' || kind === 'destination') {
      assert.equal(fs.readFileSync(preserved, 'utf8'), 'keep foreign data');
    }
  }
});

test('a moved-then-thrown rename is reconciled by exact identity and verified published bytes', (t) => {
  const f = fixture(t),
    clock = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let attempts = 0,
    completedMoves = 0;
  const result = buildCore({
    ...f.options,
    platform: 'win32',
    pause: (milliseconds) => Atomics.wait(clock, 0, 0, milliseconds),
    renameSync: (source, target) => {
      attempts++;
      fs.renameSync(source, target);
      completedMoves++;
      throw Object.assign(Error('Synthetic late error'), { code: 'EPERM' });
    },
  });
  assert.equal(completedMoves, 1, 'a confirmed physical move must never be replayed');
  assert.ok(attempts >= 1 && attempts <= 6);
  verifyFiles(result.directory, result.manifest);
  assert.equal(fs.readFileSync(path.join(result.directory, CORE_LINUX), 'utf8'), 'compiled linux');
});

test('an unconfirmed no-op rename cannot publish or remove the verified staging tree', (t) => {
  const f = fixture(t);
  let attempts = 0,
    staging = '';
  assert.throws(
    () =>
      buildCore({
        ...f.options,
        renameSync: (source) => {
          attempts++;
          staging = String(source);
        },
      }),
    /changed during publication/,
  );
  assert.equal(attempts, 1);
  assert.equal(fs.existsSync(path.join(f.root, '.cache/core/build')), false);
  assert.equal(fs.readFileSync(path.join(staging, CORE_LINUX), 'utf8'), 'compiled linux');
});

test('a foreign source recreated after a physical move is preserved without replay or cleanup', (t) => {
  const f = fixture(t),
    clock = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let attempts = 0,
    completedMoves = 0,
    foreign = '';
  assert.throws(
    () =>
      buildCore({
        ...f.options,
        platform: 'win32',
        pause: (milliseconds) => Atomics.wait(clock, 0, 0, milliseconds),
        renameSync: (source, destination) => {
          attempts++;
          fs.renameSync(source, destination);
          completedMoves++;
          fs.mkdirSync(source);
          foreign = path.join(String(source), 'foreign.txt');
          fs.writeFileSync(foreign, 'keep foreign data');
          throw Object.assign(Error('Synthetic late error after replacement'), { code: 'EPERM' });
        },
      }),
    /changed during publication/,
  );
  assert.equal(completedMoves, 1);
  assert.ok(attempts >= 1 && attempts <= 6);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep foreign data');
  const output = path.join(f.root, '.cache/core/build');
  const manifest = readManifest(
    path.join(output, CORE_BUILD_MANIFEST),
    [CORE_WINDOWS, CORE_LINUX],
    '1.2.3',
    f.commit,
  );
  verifyFiles(output, manifest);
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
