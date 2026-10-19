import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { detectHypervisors, selectHypervisor } from '../src/computer/hypervisors.mjs';

const hypervFiles = [
  'C:\\Windows\\System32\\vmms.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Hyper-V\\Hyper-V.psd1',
];
const vmwareFiles = (directory) => [
  directory + '\\vmrun.exe',
  directory + '\\vmware-vdiskmanager.exe',
];
const options = (files) => ({
  platform: 'win32',
  env: {},
  fileExists: (file) => files.includes(file),
  readRegistry: () => null,
});

test('discovery on another OS never inspects Windows paths or executes commands', () => {
  const providers = detectHypervisors({
    platform: 'linux',
    fileExists: () => assert.fail('No Windows file probe'),
    readRegistry: () => assert.fail('No Windows registry probe'),
  });
  assert.equal(providers.length, 2);
  assert.ok(providers.every((item) => !item.available && /requires Windows/.test(item.reason)));
});

test('discovery recognizes complete Hyper-V and VMware installations without launching either', () => {
  const directory = 'C:\\Program Files (x86)\\VMware\\VMware Workstation';
  const providers = detectHypervisors({
    ...options([...hypervFiles, ...vmwareFiles(directory)]),
    readRegistry: () => assert.fail('Common paths do not need registry probes'),
  });
  assert.equal(providers[0].available, true);
  assert.equal(providers[1].available, true);
  assert.equal(providers[1].tools.vmrun, directory + '\\vmrun.exe');
  assert.equal(providers[1].reason, null);
  const custom = 'D:\\Applications\\VMware\\VMware Workstation';
  const moved = detectHypervisors({
    ...options(vmwareFiles(custom)),
    env: {
      'ProgramFiles(x86)': 'D:\\Applications',
      ProgramFiles: 'E:\\Apps',
      SystemRoot: 'W:\\Windows',
    },
  });
  assert.equal(moved[0].available, false);
  assert.equal(moved[1].tools.directory, custom);
});

test('registry-only VMware locations are validated and incomplete installs stay unavailable', () => {
  const directory = 'D:\\My VMware',
    queried = [];
  const providers = detectHypervisors({
    ...options(vmwareFiles(directory)),
    readRegistry: (key) => {
      queried.push(key);
      return queried.length === 1
        ? 'relative/path'
        : queried.length === 2
          ? 'bad\npath'
          : directory;
    },
  });
  assert.equal(providers[1].available, true);
  assert.equal(queried.length, 3);
  assert.equal(providers[1].tools.directory, directory);
  const partial = detectHypervisors(
    options(['C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe']),
  );
  assert.equal(partial[1].available, false);
  assert.match(partial[1].reason, /installation is incomplete/);
  assert.equal(partial[1].tools.vdiskmanager, null);
  const absent = detectHypervisors(options([]));
  assert.match(absent[0].reason, /management tools/);
  assert.match(absent[1].reason, /was not found/);
});

test('the production registry reader uses fixed read-only argv and expands installation paths', (t) => {
  let reads = 0;
  const directory = 'V:\\Installed VMware',
    files = vmwareFiles(directory);
  t.mock.method(fs, 'statSync', (file) => {
    if (files.includes(file)) return { isFile: () => true };
    throw Object.assign(Error('fixture absent'), { code: 'ENOENT' });
  });
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    reads++;
    assert.equal(command, 'reg.exe');
    assert.deepEqual(args.slice(-2), ['/v', 'InstallPath']);
    assert.equal(args[0], 'query');
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 3000);
    if (reads === 1) throw Error('Registry key absent');
    if (reads === 2) return 'Unrelated REG_SZ ignored';
    return '    InstallPath    REG_EXPAND_SZ    %VMWARE_TEST_DIRECTORY%\r\n';
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const providers = detectHypervisors({
    platform: 'win32',
    env: { VMWARE_TEST_DIRECTORY: directory },
  });
  assert.equal(providers[1].available, true);
  assert.equal(reads, 3);
  assert.equal(providers[1].tools.directory, directory);
});

test('provider selection preserves an existing choice and never falls back after failure', () => {
  const both = [
    { id: 'hyperv', available: true },
    { id: 'vmware', available: true },
  ];
  assert.equal(selectHypervisor({ availableProviders: both }), 'hyperv');
  assert.equal(selectHypervisor({ availableProviders: both, preferred: 'vmware' }), 'vmware');
  assert.equal(
    selectHypervisor({ requested: 'vmware', availableProviders: both, preferred: 'hyperv' }),
    'vmware',
  );
  assert.throws(
    () => selectHypervisor({ requested: 'other', availableProviders: both }),
    /Invalid VM provider/,
  );
  const partial = [
    { id: 'hyperv', available: true },
    { id: 'vmware', available: false, reason: 'VMware unavailable in fixture' },
  ];
  assert.throws(
    () => selectHypervisor({ preferred: 'vmware', availableProviders: partial }),
    /VMware unavailable/,
  );
  assert.throws(
    () => selectHypervisor({ requested: 'vmware', availableProviders: partial }),
    /VMware unavailable/,
  );
  assert.throws(
    () => selectHypervisor({ preferred: 'hyperv', availableProviders: [] }),
    /was not replaced/,
  );
  assert.throws(() => selectHypervisor(), /No supported hypervisor/);
});
