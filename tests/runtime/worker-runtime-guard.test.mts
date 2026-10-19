import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sqliteProbeRunner, unavailableSqliteModules } from '../support/runtime-probe-fixtures.mts';

const source = fs.readFileSync('vm/install-worker.sh', 'utf8').replaceAll('\r\n', '\n');
const matchedProbe = source.match(/--input-type=module-typescript -e '([^']+)'/);
const probe = matchedProbe?.[1];
assert.ok(probe, 'The installer contains the fixed runtime probe.');
const bash =
  process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe')
    : 'bash';
const shellPath = (value: string) =>
  process.platform === 'win32'
    ? value
        .replaceAll('\\', '/')
        .replace(/^([A-Za-z]):/, (_: string, drive: string) => '/' + drive.toLowerCase())
    : value;

test('the VM runtime probe executes erasable TypeScript and rejects disabled stripping or unsupported versions', () => {
  const supported = spawnSync(process.execPath, ['--input-type=module-typescript', '-e', probe], {
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
  });
  if (supported.error) throw supported.error;
  assert.equal(supported.status, 0, supported.stderr);
  const disabled = spawnSync(
    process.execPath,
    ['--no-experimental-strip-types', '--input-type=module-typescript', '-e', probe],
    { encoding: 'utf8', shell: false, timeout: 10000 },
  );
  if (disabled.error) throw disabled.error;
  assert.notEqual(disabled.status, 0);
  for (const version of ['20.20.0', '22.17.9', '23.0.0', '23.6.0']) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module-typescript',
        '-e',
        `Object.defineProperty(process.versions, 'node', {value:${JSON.stringify(version)}});${probe}`,
      ],
      { encoding: 'utf8', shell: false, timeout: 10000 },
    );
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0, version);
  }
});

test('the fixed VM probe rejects missing SQLite, FTS5 and unconfirmed search results before deployment', () => {
  for (const source of unavailableSqliteModules) {
    const result = sqliteProbeRunner(source)(
      process.execPath,
      ['--input-type=module-typescript', '-e', probe],
      { encoding: 'utf8', shell: false, timeout: 10000 },
    );
    if (result.error) throw result.error;
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});

test('an incompatible existing VM runtime fails before configuration, downloads or service changes and is never replaced', (t) => {
  const testRoot = path.resolve('.cache/tests');
  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, 'worker-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const stage = path.join(home, 'dant/releases/source.fixture');
  const files = {
    'dant/runtime/node/bin/node':
      '#!/bin/bash\nprintf probe >> "$HOME/probe-events"\nprintf PRIVATE_RUNTIME_ERROR >&2\nexit 1\n',
    'dant/data/state.json': '{"workTasks":[{"id":"saved","status":"paused"}]}',
    'dant/deployed-source.json': 'previous-source',
    'dant/app': 'previous-app',
    '.config/systemd/user/dant-worker.service': 'previous-worker-service',
    '.config/systemd/user/dant-guest-local.service': 'previous-guest-service',
  };
  fs.mkdirSync(stage, { recursive: true });
  // Invalid source configuration must never be read by an incompatible runtime.
  fs.writeFileSync(path.join(stage, 'deploy-manifest.json'), 'PRIVATE_INVALID_SOURCE');
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(home, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode: 0o700 });
  }
  const prefix = source.slice(0, source.indexOf('mkdir -p "$HOME/dant/runtime"'));
  const fixture = path.join(root, 'runtime-fixture.sh');
  fs.writeFileSync(fixture, 'export HOME="$2"\nset -- "$1"\nid() { printf "1000\\n"; }\n' + prefix);
  const result = spawnSync(
    bash,
    ['--noprofile', '--norc', shellPath(fixture), shellPath(stage), shellPath(home)],
    { encoding: 'utf8', shell: false, timeout: 20000 },
  );
  if (result.error) throw result.error;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^DANT_UPDATE_FAILED:runtime-incompatible:prepare$/m);
  assert.doesNotMatch(result.stderr, /PRIVATE|Invalid public VM|Traceback/);
  assert.equal(fs.readFileSync(path.join(home, 'probe-events'), 'utf8'), 'probe');
  for (const [name, bytes] of Object.entries(files))
    assert.equal(fs.readFileSync(path.join(home, name), 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(home, 'dant/releases/source.fixture/rollback')), false);
});
