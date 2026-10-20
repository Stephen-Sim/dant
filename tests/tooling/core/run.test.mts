import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { coreLaunch } from '../../../scripts/core/run.mts';
import { CORE_GUEST_BINARY, CORE_WINDOWS } from '../../../scripts/core/bundle.mts';

test('development launches the verified Go binary with separate dynamic resource and config roots', () => {
  const root = path.resolve('.cache/tests/不同用户 dant');
  const env = { DANT_PORT: '4417', DANT_MANAGED: '1', DANT_DATA: path.join(root, 'private') };
  let verified = false;
  const launch = coreLaunch({
    root,
    env,
    platform: 'win32',
    version: () => '1.2.3',
    verify: (directory, version) => {
      assert.equal(directory, path.join(root, 'src-tauri/resources'));
      assert.equal(version, '1.2.3');
      verified = true;
      return { schemaVersion: 1, version, sourceCommit: 'a'.repeat(40), files: [] };
    },
  });

  assert.equal(verified, true);
  assert.equal(launch.executable, path.join(launch.cwd, CORE_WINDOWS));
  assert.deepEqual(launch.args, ['--role=controller', '--root', launch.cwd, '--config-root', root]);
  assert.equal(launch.env.DANT_DATA, env.DANT_DATA);
  assert.equal(launch.env.DANT_MANAGED_STDIN, '1');
  assert.equal(launch.env.DANT_MANAGED, undefined);
  assert.equal(launch.env.DANT_PORT, '4417');
  assert.equal(env.DANT_MANAGED, '1', 'the caller environment is not mutated');
});

test('Linux development selects its compiled artifact and defaults data to the project root', () => {
  const root = path.resolve('.cache/tests/linux-core-launch');
  const launch = coreLaunch({
    root,
    env: {},
    platform: 'linux',
    version: () => '1.2.3',
    verify: (_directory, version) => ({
      schemaVersion: 1,
      version,
      sourceCommit: 'a'.repeat(40),
      files: [],
    }),
  });

  assert.equal(launch.executable, path.join(launch.cwd, CORE_GUEST_BINARY));
  assert.equal(launch.env.DANT_DATA, path.join(root, 'data'));
});

test('missing or changed compiled resources fail before launching the runtime', () => {
  const root = path.resolve('.cache/tests/rejected-core-launch');
  assert.throws(
    () =>
      coreLaunch({
        root,
        platform: 'win32',
        version: () => '1.2.3',
        verify: () => {
          throw Error('isolated artifact mismatch');
        },
      }),
    /artifact mismatch/,
  );
  assert.throws(() => coreLaunch({ root, platform: 'darwin' }), /not available/);
});
