import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows-build.yml'), 'utf8');
const step = workflow.slice(
  workflow.indexOf('      - name: Create draft or replace assets on an existing draft'),
);
const script = step
  .slice(step.indexOf('        run: |') + '        run: |'.length)
  .trimStart()
  .split(/\r?\n/)
  .map((line) => line.replace(/^          /, ''))
  .join('\n');
const bash =
  process.platform === 'win32'
    ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe')
    : 'bash';

// Execute the actual workflow Bash against a local function, not the network.
// Every would-be gh invocation is captured as an argument array.
function run(t: TestContext, version: string, state = 'missing', { editFails = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-draft-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'artifacts'));
  fs.writeFileSync(path.join(directory, 'artifacts', 'fixture.txt'), 'fixture');
  const log = path.join(directory, 'calls.txt'),
    shell =
      String.raw`
gh() {
  printf '%s\034' "$@" >> "$GH_FIXTURE_LOG"
  printf '\n' >> "$GH_FIXTURE_LOG"
  case "$1 $2" in
    'release view')
      case "$GH_FIXTURE_STATE" in
        missing) return 1 ;;
        draft) printf 'true\n' ;;
        published) printf 'false\n' ;;
        *) return 90 ;;
      esac ;;
    'release edit') test "$GH_FIXTURE_EDIT_FAILS" != true ;;
    'release create'|'release upload') return 0 ;;
    *) return 91 ;;
  esac
}
` + script;
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', shell], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      VERSION: version,
      TAG: 'v' + version,
      RUNNER_TEMP: directory,
      GITHUB_SERVER_URL: 'https://github.invalid',
      GITHUB_REPOSITORY: 'fixture/dant',
      GITHUB_RUN_ID: 'local-fixture',
      GH_FIXTURE_STATE: state,
      GH_FIXTURE_LOG: log,
      GH_FIXTURE_EDIT_FAILS: String(editFails),
    },
    timeout: 15000,
  });
  if (result.error) throw result.error;
  const calls = fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => line.split('\x1c').slice(0, -1))
    : [];
  return { ...result, calls };
}

test('draft workflow Bash has valid syntax and creates stable versus prerelease drafts accurately', (t) => {
  const syntax = spawnSync(bash, ['--noprofile', '--norc', '-n'], {
    input: script,
    encoding: 'utf8',
  });
  if (syntax.error) throw syntax.error;
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const [version, flag] of [
    ['0.4.7', false],
    ['0.4.7-beta.1', true],
    ['0.4.7-rc.2', true],
  ] as const) {
    const result = run(t, version);
    assert.equal(result.status, 0, result.stderr);
    const created = result.calls.find((call) => call[1] === 'create');
    assert.ok(created, 'a missing release should create a draft');
    assert.ok(created.includes('--draft'));
    assert.ok(created.includes('--verify-tag'));
    assert.ok(created.includes('--prerelease=' + flag));
    assert.equal(created[2], 'v' + version);
    assert.equal(
      result.calls.some((call) => call[1] === 'upload' || call[1] === 'edit'),
      false,
    );
  }
});

test('updating a draft corrects its channel flag before replacing assets', (t) => {
  for (const [version, flag] of [
    ['0.4.7', false],
    ['0.4.7-beta.1', true],
  ] as const) {
    const result = run(t, version, 'draft');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.calls.map((call) => call[1]),
      ['view', 'edit', 'upload'],
    );
    assert.deepEqual(result.calls[1], ['release', 'edit', 'v' + version, '--prerelease=' + flag]);
    assert.ok(result.calls[2]?.includes('--clobber'));
  }
  const failed = run(t, '0.4.7-beta.1', 'draft', { editFails: true });
  assert.notEqual(failed.status, 0);
  assert.equal(
    failed.calls.some((call) => call[1] === 'upload'),
    false,
    'a failed prerelease correction cannot upload assets',
  );
});

test('published stable and prerelease versions reject all mutations', (t) => {
  for (const version of ['0.4.7', '0.4.7-beta.1']) {
    const result = run(t, version, 'published');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already published release/);
    assert.deepEqual(
      result.calls.map((call) => call[1]),
      ['view'],
    );
  }
});
