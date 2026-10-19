import test from 'node:test';
import assert from 'node:assert/strict';
import { HostPlatformId } from '../../src/contracts/states.mts';
import { createHostPlatform } from '../../src/platform/host-platform.mts';
import { hostConfiguration } from '../../src/config/host-config.mts';
import { defined } from '../support/fixture-assertions.mts';

test('Windows exposes the existing command names and validated absolute system paths', () => {
  const host = createHostPlatform({ platform: 'win32', env: { SystemRoot: 'W:\\Windows' } });
  assert.equal(host.id, HostPlatformId.Windows);
  assert.deepEqual(host.capabilities, {
    managedVm: true,
    existingSsh: true,
    secretProtection: true,
  });
  assert.equal(host.commands.powershell, 'powershell.exe');
  assert.equal(host.commands.registry, 'reg.exe');
  assert.equal(host.commands.archive, 'W:\\Windows\\System32\\tar.exe');
  assert.equal(
    defined(host.windows).powershell,
    'W:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(typeof defined(host.secretProtection).protect, 'function');
  assert.ok(Object.isFrozen(host));
  assert.ok(Object.isFrozen(host.capabilities));
});

test('macOS and Linux keep SSH transport but never claim managed VM or plaintext secret protection', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const host = createHostPlatform({ platform, env: { SystemRoot: 'invalid\nWindows path' } });
    assert.equal(host.id, platform);
    assert.deepEqual(host.capabilities, {
      managedVm: false,
      existingSsh: true,
      secretProtection: false,
    });
    assert.equal(host.commands.powershell, null);
    assert.equal(host.commands.registry, null);
    assert.equal(host.commands.archive, 'tar');
    assert.equal(host.windows, null);
    assert.equal(host.secretProtection, undefined);
  }
  const unsupported = createHostPlatform({ platform: 'aix' });
  assert.equal(unsupported.id, HostPlatformId.Unsupported);
  assert.equal(unsupported.capabilities.existingSsh, false);
  assert.equal(unsupported.secretProtection, undefined);
});

test('an explicitly supplied secure provider is retained on another platform', async () => {
  const protection = {
    async protect(value: string) {
      return Buffer.from(`protected:${value}`);
    },
    async unprotect(blob: Buffer) {
      return blob.toString().slice('protected:'.length);
    },
  };
  const host = createHostPlatform({ platform: 'darwin', secretProtection: protection });
  assert.equal(host.secretProtection, protection);
  assert.equal(host.capabilities.secretProtection, true);
  const encrypted = await defined(host.secretProtection).protect('isolated fixture');
  assert.equal(await defined(host.secretProtection).unprotect(encrypted), 'isolated fixture');
  assert.equal(host.capabilities.managedVm, false);
});

test('host configuration snapshots OS environment and rejects unsafe OS or registry paths', () => {
  const env = { FIXTURE_VMWARE: 'D:\\Installed tools', SystemRoot: 'C:\\Windows' };
  const config = hostConfiguration(env);
  env.FIXTURE_VMWARE = 'E:\\Changed later';
  assert.equal(config.expandWindowsDirectory('%FIXTURE_VMWARE%'), 'D:\\Installed tools');
  assert.equal(config.expandWindowsDirectory('D:\\Installed tools\\..\\VMware'), 'D:\\VMware');
  for (const value of [null, '', 'relative', 'D:\\unsafe\npath', 'D:\\unsafe\0path'])
    assert.equal(config.expandWindowsDirectory(value), null);
  assert.equal(hostConfiguration({ BAD: 'unsafe\nvalue' }).expandWindowsDirectory('%BAD%'), null);
  assert.throws(
    () => hostConfiguration({ SystemRoot: 'relative' }),
    /Invalid host system directory/,
  );
  assert.throws(
    () => hostConfiguration({ ProgramFiles: 'C:\\bad\rpath' }),
    /Invalid host system directory/,
  );
});
