import { defined } from '../support/fixture-assertions.mts';
import { errorMessage } from '../../src/contracts/json.mts';
import type { VmLifecycleOptions } from '../../src/computer/vm-lifecycle.mts';
interface PowerCall {
  command: string;
  args: readonly string[];
  options: Parameters<NonNullable<VmLifecycleOptions['run']>>[2];
  action: string;
}
interface FixtureOptions {
  provider?: string;
  run?: (action: string, calls: readonly PowerCall[]) => string | Promise<string>;
  host?: VmLifecycleOptions['host'];
}
import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VmLifecycle } from '../../src/computer/vm-lifecycle.mts';
import { createHostPlatform } from '../../src/platform/host-platform.mts';
import { observedRecord } from '../support/service-fixtures.mts';

const vmId = '312961c7-77b3-4b59-8c39-437c9ca99bd1';
function fixture(t: NodeTestContext, { provider = 'hyperv', run, host }: FixtureOptions = {}) {
  const root = path.resolve('.cache/tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'dant-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = provider === 'vmware' ? path.join(dir, 'vmware') : dir;
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'vm-key'), 'private test fixture');
  const binding: {
    host: string;
    user: string;
    port: number;
    keyPath: string;
    provider?: string;
    vmwareId?: string;
  } = {
    host: '192.0.2.1',
    user: 'dant',
    port: 22,
    keyPath: path.join(base, 'vm-key'),
    provider,
  };
  if (provider === 'hyperv') {
    fs.mkdirSync(path.join(base, 'vm'));
    fs.writeFileSync(path.join(base, 'vm', 'dant.vhdx'), 'test disk');
    fs.writeFileSync(
      path.join(base, 'vm-setup-status.json'),
      JSON.stringify({ name: 'dant', stage: 'ready' }),
    );
  } else if (provider === 'vmware') {
    binding.vmwareId = vmId;
    fs.writeFileSync(path.join(base, 'dant.vmx'), `annotation = "dant-vmware-v1:${vmId}"\n`);
    fs.writeFileSync(path.join(base, 'dant.vmdk'), 'test disk');
    fs.writeFileSync(
      path.join(base, 'manifest.json'),
      JSON.stringify({
        version: 1,
        owner: 'dant-vmware-v1',
        provider: 'vmware',
        id: vmId,
        vmx: path.join(base, 'dant.vmx'),
        disk: path.join(base, 'dant.vmdk'),
        phase: 'connected',
      }),
    );
  }
  fs.writeFileSync(path.join(dir, 'vm.json'), JSON.stringify(binding));
  const calls: PowerCall[] = [];
  const lifecycle = new VmLifecycle({
    dataDir: dir,
    platform: 'win32',
    ...(host ? { host } : {}),
    run: async (command, args, options) => {
      const action = defined(args[args.indexOf('-Action') + 1]);
      calls.push({ command, args, options, action });
      return run
        ? run(action, calls)
        : JSON.stringify({
            ok: true,
            provider,
            vmId,
            state: action === 'suspend' ? 'suspended' : 'running',
            changed: true,
          });
    },
  });
  return { dir, base, binding, lifecycle, calls };
}

test('an unsupported injected host never powers a VM or writes a suspend receipt', async (t) => {
  const f = fixture(t, { host: createHostPlatform({ platform: 'darwin' }) });
  assert.deepEqual(await f.lifecycle.suspend(), {
    ok: true,
    supported: false,
    vmSuspended: false,
  });
  assert.deepEqual(await f.lifecycle.resume(), { ok: true, resumed: false });
  assert.deepEqual(await f.lifecycle.resumeForReconnect(), { ok: true, resumed: false });
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.lifecycle.file), false);
});
test('suspends the configured managed VM then resumes only its durable identity on next launch', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.lifecycle.resume(), { ok: true, resumed: false });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.lifecycle.suspend(), {
    ok: true,
    supported: true,
    vmSuspended: true,
    state: 'suspended',
  });
  const receipt = JSON.parse(fs.readFileSync(f.lifecycle.file, 'utf8'));
  assert.equal(receipt.phase, 'suspended');
  assert.equal(receipt.vmId, vmId);
  assert.match(receipt.operationId, /^[a-f0-9-]{36}$/);
  assert.ok(receipt.expiresAt > Date.now());
  assert.doesNotMatch(JSON.stringify(receipt), /private test|192\.0\.2|vm-key/);
  assert.equal(defined(f.calls[0]).command, 'powershell.exe');
  assert.equal(defined(f.calls[0]).options.shell, false);
  assert.equal(defined(f.calls[0]).options.windowsHide, true);
  assert.ok(defined(defined(f.calls[0]).options.timeout) <= 85000);
  assert.deepEqual(await f.lifecycle.resume(), { ok: true, resumed: true, state: 'running' });
  assert.equal(fs.existsSync(f.lifecycle.file), false);
  assert.ok(defined(f.calls[1]).args.includes(vmId));
  assert.notEqual(
    defined(f.calls[0]).args[defined(f.calls[0]).args.indexOf('-ExpectedOperation') + 1],
    defined(f.calls[1]).args[defined(f.calls[1]).args.indexOf('-ExpectedOperation') + 1],
  );
});
test('VMware requires its binding, manifest, VMX annotation and matching paths', async (t) => {
  const f = fixture(t, { provider: 'vmware' });
  assert.equal((await f.lifecycle.suspend()).vmSuspended, true);
  await f.lifecycle.resume();
  fs.writeFileSync(path.join(f.base, 'dant.vmx'), 'annotation = "another virtual machine"');
  assert.equal((await f.lifecycle.suspend()).supported, false);
  assert.equal(f.calls.length, 2);
});
test('SSH and missing managed ownership pause elsewhere without guessing a local VM', async (t) => {
  const f = fixture(t, { provider: 'ssh' });
  assert.deepEqual(await f.lifecycle.suspend(), { ok: true, supported: false, vmSuspended: false });
  assert.equal(f.calls.length, 0);
  const g = fixture(t);
  fs.unlinkSync(path.join(g.base, 'vm-setup-status.json'));
  assert.equal((await g.lifecycle.suspend()).supported, false);
  assert.equal(g.calls.length, 0);
});
test('old Hyper-V bindings are identified by their own setup record and disk rather than default VM name', async (t) => {
  const f = fixture(t);
  delete f.binding.provider;
  fs.writeFileSync(path.join(f.dir, 'vm.json'), JSON.stringify(f.binding));
  assert.equal((await f.lifecycle.suspend()).vmSuspended, true);
});
test('manual saved or powered-off VMs are never automatically started by merely opening dant', async (t) => {
  for (const state of ['suspended', 'off']) {
    const f = fixture(t, {
      run: () => JSON.stringify({ ok: true, provider: 'hyperv', vmId, state, changed: false }),
    });
    await f.lifecycle.suspend();
    assert.equal(fs.existsSync(f.lifecycle.file), false);
    await f.lifecycle.resume();
    assert.equal(f.calls.length, 1);
  }
});
test('an uncertain suspend keeps a receipt so reopening reconciles that one VM without resending suspend', async (t) => {
  const f = fixture(t, {
    run: (action) => {
      if (action === 'suspend') throw Error('private host error');
      return JSON.stringify({
        ok: true,
        provider: 'hyperv',
        vmId,
        state: 'running',
        changed: true,
      });
    },
  });
  await assert.rejects(f.lifecycle.suspend(), /vm_lifecycle_unconfirmed/);
  assert.equal(JSON.parse(fs.readFileSync(f.lifecycle.file, 'utf8')).phase, 'suspending');
  assert.equal((await f.lifecycle.resume()).resumed, true);
  assert.deepEqual(
    f.calls.map((value) => value.action),
    ['suspend', 'resume'],
  );
});
test('changed binding, changed identity, malformed receipt and response do not authorize a power operation', async (t) => {
  const f = fixture(t);
  await f.lifecycle.suspend();
  f.binding.host = '192.0.2.2';
  fs.writeFileSync(path.join(f.dir, 'vm.json'), JSON.stringify(f.binding));
  await assert.rejects(f.lifecycle.resume(), /binding_changed/);
  assert.equal(f.calls.length, 1);
  const g = fixture(t);
  fs.writeFileSync(g.lifecycle.file, '{}');
  await assert.rejects(g.lifecycle.suspend(), /invalid_receipt/);
  assert.equal(g.calls.length, 0);
  const h = fixture(t, {
    run: () =>
      JSON.stringify({
        ok: true,
        provider: 'hyperv',
        vmId: 'invalid',
        state: 'suspended',
        changed: true,
      }),
  });
  await assert.rejects(h.lifecycle.suspend(), /unconfirmed/);
  assert.equal(fs.existsSync(h.lifecycle.file), true);
  const i = fixture(t);
  await i.lifecycle.suspend();
  i.lifecycle.run = async () =>
    JSON.stringify({
      ok: true,
      provider: 'hyperv',
      vmId: '11111111-1111-4111-8111-111111111111',
      state: 'running',
      changed: true,
    });
  await assert.rejects(i.lifecycle.resume(), /unconfirmed/);
});
test('concurrent lifecycle writes are refused and private subprocess output is never exposed', async (t) => {
  let finish: ((result: string) => void) | undefined;
  const f = fixture(t, {
    run: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  });
  const first = f.lifecycle.suspend();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.lifecycle.suspend(), /busy/);
  defined(finish)('private credential/path diagnostics');
  await assert.rejects(first, (error) => errorMessage(error) === 'vm_lifecycle_unconfirmed');
});
test('binding changes while a command is outstanding retain the receipt for explicit recovery', async (t) => {
  const f = fixture(t, {
    run: () => {
      fs.writeFileSync(
        path.join(f.dir, 'vm.json'),
        JSON.stringify({ ...f.binding, host: '192.0.2.3' }),
      );
      return JSON.stringify({
        ok: true,
        provider: 'hyperv',
        vmId,
        state: 'suspended',
        changed: true,
      });
    },
  });
  await assert.rejects(f.lifecycle.suspend(), /binding_changed/);
  assert.equal(fs.existsSync(f.lifecycle.file), true);
});
test('only explicit Reconnect can resume an owned legacy Saved VM without a suspend receipt', async (t) => {
  const f = fixture(t);
  delete f.binding.provider;
  fs.writeFileSync(path.join(f.dir, 'vm.json'), JSON.stringify(f.binding));
  assert.deepEqual(await f.lifecycle.resume(), { ok: true, resumed: false });
  assert.equal(f.calls.length, 0);
  const before = Date.now();
  f.lifecycle.run = async (_command, args) => {
    const receipt = f.lifecycle.receipt();
    assert.equal(receipt?.phase, 'resuming');
    assert.equal(receipt?.vmId, null);
    assert.ok(defined(receipt?.expiresAt) >= before);
    assert.ok(defined(receipt?.expiresAt) <= Date.now() + 85000);
    assert.equal(args[args.indexOf('-ExpectedOperation') + 1], receipt?.operationId);
    assert.equal(args[args.indexOf('-ExpectedDeadline') + 1], String(receipt?.expiresAt));
    return JSON.stringify({ ok: true, provider: 'hyperv', vmId, state: 'running', changed: true });
  };
  assert.deepEqual(await f.lifecycle.resumeForReconnect(), {
    ok: true,
    resumed: true,
    state: 'running',
  });
  assert.equal(fs.existsSync(f.lifecycle.file), false);
});
test('explicit Reconnect observes Off without starting it and never guesses SSH ownership', async (t) => {
  const f = fixture(t, {
    run: () => JSON.stringify({ ok: true, provider: 'hyperv', vmId, state: 'off', changed: false }),
  });
  assert.deepEqual(await f.lifecycle.resumeForReconnect(), {
    ok: true,
    resumed: false,
    state: 'off',
  });
  assert.equal(fs.existsSync(f.lifecycle.file), false);
  const ssh = fixture(t, { provider: 'ssh' });
  assert.deepEqual(await ssh.lifecycle.resumeForReconnect(), { ok: true, resumed: false });
  assert.equal(ssh.calls.length, 0);
});
test('legacy version-one receipts migrate to a fresh bounded resume intent', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.lifecycle.file,
    JSON.stringify({
      version: 1,
      phase: 'suspended',
      provider: 'hyperv',
      binding: defined(f.lifecycle.binding()).digest,
      vmId,
    }),
  );
  f.lifecycle.run = async (_command, args) => {
    assert.equal(f.lifecycle.receipt()?.phase, 'resuming');
    assert.ok(args.includes('-ExpectedOperation'));
    assert.ok(args.includes('-ExpectedVmId'));
    return JSON.stringify({ ok: true, provider: 'hyperv', vmId, state: 'running', changed: true });
  };
  assert.equal((await f.lifecycle.resume()).resumed, true);
});
test('a timed-out command revokes its nonce and deadline while preserving uncertain intent', async (t) => {
  const f = fixture(t, {
    run: () => {
      throw Error('synthetic timeout');
    },
  });
  await assert.rejects(f.lifecycle.resumeForReconnect(), /unconfirmed/);
  const receipt = defined(f.lifecycle.receipt());
  const original = defined(f.calls[0]);
  assert.equal(receipt.phase, 'resuming');
  assert.equal(receipt.expiresAt, 1);
  assert.notEqual(
    receipt.operationId,
    original.args[original.args.indexOf('-ExpectedOperation') + 1],
  );
});
test('a stale helper result cannot erase a newer durable intent', async (t) => {
  const f = fixture(t);
  f.lifecycle.run = async () => {
    const receipt = defined(f.lifecycle.receipt());
    fs.writeFileSync(
      f.lifecycle.file,
      JSON.stringify({ ...receipt, operationId: '11111111-1111-4111-8111-111111111111' }),
    );
    return JSON.stringify({ ok: true, provider: 'hyperv', vmId, state: 'running', changed: true });
  };
  await assert.rejects(f.lifecycle.resumeForReconnect(), /intent_changed/);
  assert.equal(f.lifecycle.receipt()?.operationId, '11111111-1111-4111-8111-111111111111');
});

test('explicit Running observation refreshes one owned Hyper-V IPv4 after clearing its exact receipt', async (t) => {
  const f = fixture(t, {
    run: () =>
      JSON.stringify({
        ok: true,
        provider: 'hyperv',
        vmId,
        state: 'running',
        changed: false,
        addresses: ['192.0.2.44'],
      }),
  });
  const file = path.join(f.dir, 'vm.json'),
    knownHosts = path.join(f.dir, 'vm-known-hosts');
  const original = {
    ...f.binding,
    port: 2202,
    knownHosts,
    name: 'dant',
    custom: { keep: true },
    fingerprint: 'fixture-identity',
  };
  fs.writeFileSync(file, JSON.stringify(original));
  fs.writeFileSync(knownHosts, 'synthetic SSH known-host identity');
  const rename = fs.renameSync;
  let replacements = 0;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target) === file) {
      replacements++;
      assert.equal(
        fs.existsSync(f.lifecycle.file),
        false,
        'the old binding receipt must be gone before endpoint replacement',
      );
    }
    return rename(source, target);
  });
  assert.deepEqual(await f.lifecycle.resumeForReconnect(), {
    ok: true,
    resumed: false,
    state: 'running',
  });
  assert.deepEqual(observedRecord(JSON.parse(fs.readFileSync(file, 'utf8'))), {
    ...original,
    host: '192.0.2.44',
  });
  assert.equal(fs.readFileSync(knownHosts, 'utf8'), 'synthetic SSH known-host identity');
  assert.equal(replacements, 1);
  assert.equal(fs.existsSync(f.lifecycle.file), false);
  assert.equal(
    fs.readdirSync(f.dir).some((name) => name.startsWith('.vm-endpoint-')),
    false,
  );
});

test('startup resume may refresh the owned endpoint only while reconciling its durable receipt', async (t) => {
  const f = fixture(t, {
    run: (action) =>
      JSON.stringify({
        ok: true,
        provider: 'hyperv',
        vmId,
        state: action === 'suspend' ? 'suspended' : 'running',
        changed: true,
        ...(action === 'resume' ? { addresses: ['192.0.2.45'] } : {}),
      }),
  });
  await f.lifecycle.suspend();
  assert.equal(fs.existsSync(f.lifecycle.file), true);
  assert.deepEqual(await f.lifecycle.resume(), { ok: true, resumed: true, state: 'running' });
  assert.equal(
    observedRecord(JSON.parse(fs.readFileSync(path.join(f.dir, 'vm.json'), 'utf8'))).host,
    '192.0.2.45',
  );
  assert.deepEqual(await f.lifecycle.resume(), { ok: true, resumed: false });
  assert.equal(f.calls.length, 2);
});

test('endpoint discovery never guesses between addresses or rewrites Off, VMware or unowned connections', async (t) => {
  for (const options of [
    { provider: 'hyperv', state: 'running', addresses: [] },
    { provider: 'hyperv', state: 'running', addresses: ['192.0.2.1'] },
    { provider: 'hyperv', state: 'running', addresses: ['192.0.2.44', '192.0.2.45'] },
    { provider: 'hyperv', state: 'running', addresses: ['192.0.2.44', '192.0.2.1'] },
    { provider: 'hyperv', state: 'off', addresses: ['192.0.2.44'] },
    { provider: 'vmware', state: 'running', addresses: ['192.0.2.44'] },
    { provider: 'ssh', state: 'running', addresses: ['192.0.2.44'] },
  ]) {
    const f = fixture(t, {
      provider: options.provider,
      run: () =>
        JSON.stringify({
          ok: true,
          vmId,
          changed: false,
          ...options,
        }),
    });
    const file = path.join(f.dir, 'vm.json'),
      before = fs.readFileSync(file, 'utf8');
    await f.lifecycle.resumeForReconnect();
    assert.equal(fs.readFileSync(file, 'utf8'), before, JSON.stringify(options));
    assert.equal(fs.existsSync(f.lifecycle.file), false);
    if (options.provider === 'ssh') assert.equal(f.calls.length, 0);
  }
});

test('malformed or excessive address metadata remains unconfirmed and cannot change a binding', async (t) => {
  for (const addresses of [
    null,
    '192.0.2.44',
    {},
    [123],
    [''],
    ['::1'],
    ['127.0.0.1'],
    ['169.254.1.2'],
    ['0.0.0.0'],
    ['224.0.0.1'],
    ['255.255.255.255'],
    ['192.000.2.4'],
    ['192.0.2.44', '192.0.2.44'],
    Array.from({ length: 17 }, (_, index) => '192.0.2.' + (index + 1)),
  ]) {
    const f = fixture(t, {
      run: () =>
        JSON.stringify({
          ok: true,
          provider: 'hyperv',
          vmId,
          state: 'running',
          changed: false,
          addresses,
        }),
    });
    const file = path.join(f.dir, 'vm.json'),
      before = fs.readFileSync(file, 'utf8');
    await assert.rejects(f.lifecycle.resumeForReconnect(), /unconfirmed/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(f.lifecycle.receipt()?.phase, 'resuming');
    assert.equal(f.lifecycle.receipt()?.expiresAt, 1);
    assert.equal(f.calls.length, 1);
  }
});

test('an endpoint write failure preserves binding data without stranding a receipt or repeating VM actions', async (t) => {
  const f = fixture(t, {
    run: () =>
      JSON.stringify({
        ok: true,
        provider: 'hyperv',
        vmId,
        state: 'running',
        changed: false,
        addresses: ['192.0.2.44'],
      }),
  });
  const file = path.join(f.dir, 'vm.json'),
    before = fs.readFileSync(file, 'utf8'),
    rename = fs.renameSync;
  let fail = true;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target) === file && fail)
      throw Object.assign(Error('Synthetic fixture filesystem failure'), { code: 'EROFS' });
    return rename(source, target);
  });
  await assert.rejects(f.lifecycle.resumeForReconnect(), { code: 'EROFS' });
  assert.equal(fs.existsSync(f.lifecycle.file), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(
    fs.readdirSync(f.dir).some((name) => name.startsWith('.vm-endpoint-')),
    false,
  );
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.lifecycle.resume(), { ok: true, resumed: false });
  assert.equal(f.calls.length, 1, 'a failed host update is not an automatic power retry');
  fail = false;
  await f.lifecycle.resumeForReconnect();
  assert.equal(f.calls.length, 2, 'explicit retry observes the same owned Running VM again');
  assert.equal(observedRecord(JSON.parse(fs.readFileSync(file, 'utf8'))).host, '192.0.2.44');
});

test('a replaced binding cannot be overwritten by a returned address from an older operation', async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, 'vm.json'),
    replacement = { ...f.binding, host: '192.0.2.99', user: 'replacement' };
  f.lifecycle.run = async () => {
    fs.writeFileSync(file, JSON.stringify(replacement));
    return JSON.stringify({
      ok: true,
      provider: 'hyperv',
      vmId,
      state: 'running',
      changed: false,
      addresses: ['192.0.2.44'],
    });
  };
  await assert.rejects(f.lifecycle.resumeForReconnect(), /binding_changed/);
  assert.deepEqual(observedRecord(JSON.parse(fs.readFileSync(file, 'utf8'))), replacement);
  assert.equal(fs.existsSync(f.lifecycle.file), true);
});
