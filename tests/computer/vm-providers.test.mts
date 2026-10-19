import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostPlatform } from '../../src/platform/host-platform.mts';
import { createVmProviders } from '../../src/computer/providers/vm-providers.mts';
import { VmProviderId, ProvisioningStatus } from '../../src/contracts/states.mts';

const setup = {
  dataDir: 'C:\\Fixture data',
  cpu: 4,
  memoryGB: 6,
  diskGB: 40,
  adminSudo: false,
};
const lifecycle = {
  projectRoot: 'C:\\Fixture app',
  dataDir: setup.dataDir,
  action: 'suspend' as const,
  binding: 'a'.repeat(64),
  vmId: null,
  operationId: 'ccf5904d-b6ea-43f5-8847-b6dd974853af',
  expiresAt: 1800000000000,
};

test('provider registry keeps stable IDs and SSH can never be selected as an automatic VM adapter', () => {
  const registry = createVmProviders(createHostPlatform({ platform: 'win32', env: {} }), {
    fileExists: () => false,
    readRegistry: () => null,
  });
  assert.deepEqual(
    registry.managed.map((provider) => provider.id),
    [VmProviderId.HyperV, VmProviderId.VMware],
  );
  assert.equal(registry.get(VmProviderId.HyperV), registry.managed[0]);
  assert.equal(registry.get(VmProviderId.VMware), registry.managed[1]);
  assert.equal(registry.get(VmProviderId.Ssh), registry.ssh);
  assert.deepEqual(registry.ssh.capabilities, {
    automaticSetup: false,
    powerLifecycle: false,
    existingConnection: true,
  });
  assert.equal('setupPlan' in registry.ssh, false);
  assert.equal('lifecycleCommand' in registry.ssh, false);
  for (const id of [undefined, null, 'qemu', 'parallels', ''])
    assert.throws(() => registry.get(id), /Invalid VM provider/);
});

test('Windows provider setup plans preserve tool paths, resource arguments and administrator flow', () => {
  const registry = createVmProviders(createHostPlatform({ platform: 'win32', env: {} }));
  const hyperv = registry.managed[0].setupPlan({ ...setup, adminSudo: true });
  assert.deepEqual(hyperv, {
    prepare: { script: 'prepare-vm.ps1', args: ['-DataDirectory', setup.dataDir, '-AdminSudo'] },
    create: {
      script: 'launch-vm.ps1',
      args: ['-DataDirectory', setup.dataDir, '-Cpu', '4', '-MemoryGB', '6', '-DiskGB', '40'],
    },
    stage: ProvisioningStatus.AwaitingAdmin,
  });
  const tools = {
    directory: 'D:\\VMware tools',
    vmrun: 'D:\\VMware tools\\vmrun.exe',
    vdiskmanager: 'D:\\VMware tools\\vmware-vdiskmanager.exe',
  };
  const vmware = registry.managed[1].setupPlan({ ...setup, tools });
  assert.equal(vmware.prepare.script, 'prepare-vmware.ps1');
  assert.equal(vmware.create.script, 'create-vmware.ps1');
  assert.equal(vmware.stage, ProvisioningStatus.Creating);
  assert.deepEqual(vmware.prepare.args, [
    '-DataDirectory',
    setup.dataDir,
    '-VmrunPath',
    tools.vmrun,
    '-VdiskmanagerPath',
    tools.vdiskmanager,
  ]);
  const incomplete = registry.managed[1].setupPlan({
    ...setup,
    tools: { directory: 'D:\\VMware tools', vmrun: null, vdiskmanager: null },
  });
  assert.deepEqual(incomplete.prepare.args, [
    '-DataDirectory',
    setup.dataDir,
    '-VmrunPath',
    '',
    '-VdiskmanagerPath',
    '',
  ]);
});

test('provider power command retains fixed helper argv and exact captured identity', () => {
  const registry = createVmProviders(createHostPlatform({ platform: 'win32', env: {} }));
  for (const adapter of registry.managed) {
    const command = adapter.lifecycleCommand(lifecycle);
    assert.equal(command.command, 'powershell.exe');
    assert.deepEqual(command.args.slice(-10), [
      '-Action',
      'suspend',
      '-DataDirectory',
      setup.dataDir,
      '-ExpectedBinding',
      lifecycle.binding,
      '-ExpectedOperation',
      lifecycle.operationId,
      '-ExpectedDeadline',
      String(lifecycle.expiresAt),
    ]);
    assert.equal(command.args.includes('-ExpectedVmId'), false);
    const resumed = adapter.lifecycleCommand({
      ...lifecycle,
      action: 'resume',
      vmId: 'exact fixture identity',
    });
    assert.deepEqual(resumed.args.slice(-2), ['-ExpectedVmId', 'exact fixture identity']);
    assert.equal(resumed.args[resumed.args.indexOf('-Action') + 1], 'resume');
  }
});

test('unimplemented macOS and Linux managed adapters fail before probes or process commands', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const registry = createVmProviders(createHostPlatform({ platform }), {
      fileExists: () => assert.fail('No Windows file probe'),
      readRegistry: () => assert.fail('No Windows registry probe'),
    });
    assert.equal(registry.ssh.capabilities.existingConnection, true);
    for (const adapter of registry.managed) {
      assert.equal(adapter.capabilities.automaticSetup, false);
      assert.equal(adapter.capabilities.powerLifecycle, false);
      assert.deepEqual(adapter.detect(), {
        id: adapter.id,
        label: adapter.label,
        available: false,
        reason: 'Automatic VM setup requires Windows.',
      });
      assert.throws(() => adapter.setupPlan(setup), /requires Windows/);
      assert.throws(() => adapter.lifecycleCommand(lifecycle), /unavailable on this host/);
    }
  }
});
