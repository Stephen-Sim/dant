import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { observedRecord } from '../../support/service-fixtures.mts';

const helper = fileURLToPath(new URL('../../../scripts/vm-lifecycle.ps1', import.meta.url));
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function fixture(
  t: NodeTestContext,
  {
    state = 'Running',
    foreign = false,
    expected = '',
    action = 'suspend',
    ambiguous = false,
    renamed = false,
    ancestor = false,
    stale = false,
    expired = false,
    excessiveDeadline = false,
    changeIntent = false,
    changeBinding = false,
    addresses = ['192.0.2.44'],
    changeNetworkIntent = false,
    changeNetworkBinding = false,
    changeNetworkState = false,
    changeNetworkDisk = false,
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-power-helper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const disk = path.join(dir, 'vm', 'dant.vhdx');
  fs.mkdirSync(path.dirname(disk));
  fs.writeFileSync(disk, 'fixture only');
  fs.writeFileSync(path.join(dir, 'vm-key'), 'fixture only');
  fs.writeFileSync(
    path.join(dir, 'vm-setup-status.json'),
    JSON.stringify({ stage: 'ready', name: 'dant' }),
  );
  const raw = JSON.stringify({
    host: '192.0.2.2',
    user: 'dant',
    keyPath: path.join(dir, 'vm-key'),
  });
  fs.writeFileSync(path.join(dir, 'vm.json'), raw);
  const digest = createHash('sha256').update(raw).digest('hex');
  const operationId = randomUUID(),
    deadline = Date.now() + (expired ? -1 : excessiveDeadline ? 120000 : 85000);
  const intentFile = path.join(dir, 'vm-lifecycle.json');
  fs.writeFileSync(
    intentFile,
    JSON.stringify({
      version: 1,
      phase: action === 'suspend' ? 'suspending' : 'resuming',
      provider: 'hyperv',
      binding: digest,
      vmId: expected || null,
      operationId: stale ? randomUUID() : operationId,
      expiresAt: deadline,
    }),
  );
  const wrapper = path.join(dir, 'fixture.ps1');
  fs.writeFileSync(
    wrapper,
    `
$ErrorActionPreference='Stop'
$global:dantFixtureState=${literal(state)}; $global:dantSaves=0; $global:dantStarts=0; $global:dantQueries=0; $global:dantNameLookup=$false; $global:dantNetworkQueries=0; $global:dantNetworkRead=$false
function New-Object {
 param([string]$TypeName,[Parameter(ValueFromRemainingArguments=$true)][object[]]$ArgumentList)
 if($TypeName -eq 'Security.Principal.WindowsPrincipal') { $value=[pscustomobject]@{}; $value|Add-Member -MemberType ScriptMethod -Name IsInRole -Value {param($role) return $true}; return $value }
 Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
}
function Import-Module {param($Name) if($Name -ne 'Hyper-V'){throw 'Unexpected module'} }
function Get-VM {
 param($Name,$Id)
 $global:dantQueries++
 if($Name) { $global:dantNameLookup=$true; ${renamed ? "throw 'Old name no longer exists'" : ''} }
 ${changeIntent ? `if($Id) { $intent=Get-Content -LiteralPath ${literal(intentFile)} -Raw|ConvertFrom-Json; $intent.operationId=[guid]::NewGuid().ToString(); [IO.File]::WriteAllText(${literal(intentFile)},($intent|ConvertTo-Json -Compress)) }` : ''}
 ${changeBinding ? `if($Id) { [IO.File]::WriteAllText(${literal(path.join(dir, 'vm.json'))},'{}') }` : ''}
 if($Id -and [string]$Id -ne '312961c7-77b3-4b59-8c39-437c9ca99bd1') { throw 'Unexpected VMID' }
 $vm=[pscustomobject]@{Id=[guid]'312961c7-77b3-4b59-8c39-437c9ca99bd1';State=$global:dantFixtureState}
 if(!$Id -and ${ambiguous ? '$true' : '$false'}) { return @($vm,[pscustomobject]@{Id=[guid]'21111111-1111-4111-8111-111111111111';State=$global:dantFixtureState}) }
 return $vm
}
function Get-VMHardDiskDrive {param($VM) if($global:dantNetworkRead -and ${changeNetworkDisk ? '$true' : '$false'}) {return [pscustomobject]@{Path=${literal(path.join(dir, 'foreign-after-network.vhdx'))}}}; return [pscustomobject]@{Path=${literal(foreign || ancestor ? path.join(dir, 'other.vhdx') : disk)}} }
function Get-VHD {param($Path) ${ancestor ? `return [pscustomobject]@{ParentPath=${literal(disk)}}` : "throw 'Foreign disk must never be traversed in this fixture'"} }
function Get-VMNetworkAdapter {
 param($VM)
 if([string]$VM.Id -ne '312961c7-77b3-4b59-8c39-437c9ca99bd1') {throw 'Wrong network VM identity'}
 $global:dantNetworkQueries++; $global:dantNetworkRead=$true
 ${changeNetworkIntent ? ` $intent=Get-Content -LiteralPath ${literal(intentFile)} -Raw|ConvertFrom-Json; $intent.operationId=[guid]::NewGuid().ToString(); [IO.File]::WriteAllText(${literal(intentFile)},($intent|ConvertTo-Json -Compress))` : ''}
 ${changeNetworkBinding ? `[IO.File]::WriteAllText(${literal(path.join(dir, 'vm.json'))},'{}')` : ''}
 ${changeNetworkState ? "$global:dantFixtureState='Off'" : ''}
 return [pscustomobject]@{IPAddresses=@(${addresses.map(literal).join(',')})}
}
function Save-VM {param($VM) $global:dantSaves++; $global:dantFixtureState='Saved' }
function Start-VM {param($VM) $global:dantStarts++; $global:dantFixtureState='Running' }
function Start-Process {throw 'No real process or elevation is permitted by this fixture'}
$reply = & ${literal(helper)} -Action ${action} -DataDirectory ${literal(dir)} -ExpectedBinding ${digest} -ExpectedOperation ${operationId} -ExpectedDeadline ${deadline} ${expected ? `-ExpectedVmId ${expected}` : ''} | ConvertFrom-Json
@{reply=$reply;saves=$global:dantSaves;starts=$global:dantStarts;state=$global:dantFixtureState;nameLookup=$global:dantNameLookup;networkQueries=$global:dantNetworkQueries}|ConvertTo-Json -Compress
`,
  );
  return JSON.parse(
    execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ),
  );
}
test(
  'Hyper-V helper saves only its owned disk and confirms Saved; resume starts only Saved state',
  { skip: process.platform !== 'win32' },
  (t) => {
    const paused = fixture(t);
    assert.equal(paused.reply.ok, true);
    assert.equal(paused.reply.state, 'suspended');
    assert.equal(paused.saves, 1);
    assert.equal(paused.starts, 0);
    const resumed = fixture(t, { action: 'resume', state: 'Saved' });
    assert.equal(resumed.reply.state, 'running');
    assert.equal(resumed.starts, 1);
    assert.equal(resumed.saves, 0);
    for (const state of ['Off', 'Running']) {
      const result = fixture(t, { action: 'resume', state });
      assert.equal(result.reply.ok, true);
      assert.equal(result.starts, 0);
    }
  },
);
test(
  'Hyper-V helper rejects replaced VM identity, foreign disks and unknown power states before mutation',
  { skip: process.platform !== 'win32' },
  (t) => {
    for (const options of [
      { expected: '11111111-1111-4111-8111-111111111111' },
      { foreign: true },
      { state: 'Pausing' },
      { ambiguous: true },
      { stale: true },
      { expired: true },
      { excessiveDeadline: true },
      { changeIntent: true },
      { changeBinding: true },
    ]) {
      const result = fixture(t, options);
      assert.equal(result.reply.ok, false);
      assert.equal(result.saves, 0);
      assert.equal(result.starts, 0);
    }
  },
);
test(
  'legacy Hyper-V lookup accepts only unique owned disk ancestry despite a renamed VM',
  { skip: process.platform !== 'win32' },
  (t) => {
    const result = fixture(t, { action: 'resume', state: 'Saved', renamed: true, ancestor: true });
    assert.equal(result.reply.ok, true);
    assert.equal(result.starts, 1);
    assert.equal(result.nameLookup, false);
    const known = fixture(t, {
      action: 'resume',
      state: 'Saved',
      expected: '312961c7-77b3-4b59-8c39-437c9ca99bd1',
      renamed: true,
    });
    assert.equal(known.reply.ok, true);
    assert.equal(known.starts, 1);
    assert.equal(known.nameLookup, false);
  },
);
test(
  'Hyper-V resume reports only bounded canonical guest IPv4 for its confirmed Running VM',
  { skip: process.platform !== 'win32' },
  (t) => {
    const result = fixture(t, {
      action: 'resume',
      state: 'Running',
      addresses: [
        '::1',
        'fe80::abcd',
        '127.0.0.1',
        '169.254.1.2',
        '0.0.0.0',
        '224.0.0.1',
        '255.255.255.255',
        '192.000.2.4',
        '10.1',
        '192.0.2.44',
        '192.0.2.44',
      ],
    });
    assert.equal(result.reply.ok, true);
    assert.equal(result.reply.state, 'running');
    assert.deepEqual(result.reply.addresses, ['192.0.2.44']);
    assert.equal(result.networkQueries, 1);
    assert.equal(result.starts, 0);
    assert.equal(result.saves, 0);
    assert.deepEqual(Object.keys(result.reply).sort(), [
      'addresses',
      'changed',
      'ok',
      'provider',
      'state',
      'vmId',
    ]);
    const empty = fixture(t, { action: 'resume', state: 'Running', addresses: [] });
    assert.deepEqual(empty.reply.addresses, []);
    const off = fixture(t, { action: 'resume', state: 'Off' });
    assert.equal(off.reply.ok, true);
    assert.equal(off.reply.addresses, undefined);
    assert.equal(off.networkQueries, 0);
  },
);

test(
  'network observation cannot bypass the final VM disk, Running state, binding or operation fence',
  { skip: process.platform !== 'win32' },
  (t) => {
    for (const extra of [
      { changeNetworkIntent: true },
      { changeNetworkBinding: true },
      { changeNetworkState: true },
      { changeNetworkDisk: true },
      { addresses: Array.from({ length: 17 }, (_, index) => '192.0.2.' + (index + 1)) },
    ]) {
      const result = fixture(t, { action: 'resume', state: 'Running', ...extra });
      assert.equal(result.reply.ok, false, JSON.stringify(extra));
      assert.equal(result.reply.addresses, undefined);
      assert.equal(result.starts, 0);
      assert.equal(result.saves, 0);
      assert.equal(result.networkQueries, 1);
    }
  },
);

test(
  'VMware helper confirms its canonical key, manifest and vmrun aliases before suspend and resume',
  { skip: process.platform !== 'win32' },
  (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-vmware-power-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const base = path.join(dir, 'vmware'),
      tools = path.join(dir, 'programs', 'VMware', 'VMware Workstation');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(tools, { recursive: true });
    const vmId = '312961c7-77b3-4b59-8c39-437c9ca99bd1',
      vmx = path.join(base, 'dant.vmx');
    fs.writeFileSync(vmx, `annotation = "dant-vmware-v1:${vmId}"\n`);
    fs.writeFileSync(path.join(base, 'dant.vmdk'), 'fixture');
    fs.writeFileSync(path.join(base, 'vm-key'), 'fixture');
    fs.writeFileSync(
      path.join(base, 'manifest.json'),
      JSON.stringify({
        owner: 'dant-vmware-v1',
        version: 1,
        provider: 'vmware',
        id: vmId,
        phase: 'connected',
        vmx,
        disk: path.join(base, 'dant.vmdk'),
      }),
    );
    const raw = JSON.stringify({
      provider: 'vmware',
      vmwareId: vmId,
      keyPath: fs.realpathSync.native(path.join(base, 'vm-key')),
      host: '192.0.2.2',
      user: 'dant',
    });
    fs.writeFileSync(path.join(dir, 'vm.json'), raw);
    const digest = createHash('sha256').update(raw).digest('hex'),
      state = path.join(base, 'fixture-state');
    const operationId = randomUUID();
    fs.writeFileSync(state, 'running');
    const wrapper = path.join(dir, 'fixture.ps1');
    fs.writeFileSync(
      wrapper,
      `
$ErrorActionPreference='Stop'
$env:ProgramFiles=${literal(path.join(dir, 'programs'))}; [Environment]::SetEnvironmentVariable('ProgramFiles(x86)',$env:ProgramFiles)
function Start-Process { throw 'No elevation or real VM process may start in this fixture' }
function Import-Module { throw 'No hypervisor module may load in this fixture' }
# Keep the manifest paths as supplied while the binding uses the real path.
# Windows PowerShell 5 must expand DOS aliases before comparing ownership.
$pathProof=@{
  vmx=([IO.Path]::GetFullPath(${literal(vmx)}) -eq ${literal(fs.realpathSync.native(vmx))})
  disk=([IO.Path]::GetFullPath(${literal(path.join(base, 'dant.vmdk'))}) -eq ${literal(fs.realpathSync.native(path.join(base, 'dant.vmdk')))})
  mixed=(${literal(path.join(base, 'vm-key'))} -cne ${literal(fs.realpathSync.native(path.join(base, 'vm-key')))})
}
# Exercise equivalent path spelling, including the 8.3 temp paths used by Windows runners.
$env:DANT_FIXTURE_VMX=${literal(path.dirname(vmx) + path.sep + '.' + path.sep + path.basename(vmx))}; $env:DANT_FIXTURE_STATE=${literal(state)}
Add-Type -OutputType ConsoleApplication -OutputAssembly ${literal(path.join(tools, 'vmrun.exe'))} -TypeDefinition @'
using System; using System.IO;
class DantFixtureVmrun { static int Main(string[] args) {
 var vmx=Path.GetFullPath(Environment.GetEnvironmentVariable("DANT_FIXTURE_VMX")); var file=Environment.GetEnvironmentVariable("DANT_FIXTURE_STATE");
 if(args.Length<3) return 2;
 if(args[2]=="list") { var running=File.ReadAllText(file)=="running"; Console.WriteLine("Total running VMs: "+(running?1:0)); if(running) Console.WriteLine(vmx); return 0; }
 if(args.Length<4||!String.Equals(Path.GetFullPath(args[3]),vmx,StringComparison.OrdinalIgnoreCase)) return 3;
 if(args[2]=="suspend") {File.WriteAllText(file,"saved");File.WriteAllText(Path.Combine(Path.GetDirectoryName(vmx),"dant.vmss"),"fixture");return 0;}
 if(args[2]=="start") {File.WriteAllText(file,"running");return 0;} return 4;
} }
'@
$Error.Clear()
$deadline=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+85000
$intent=@{version=1;phase='suspending';provider='vmware';binding='${digest}';vmId=$null;operationId='${operationId}';expiresAt=$deadline}
[IO.File]::WriteAllText(${literal(path.join(dir, 'vm-lifecycle.json'))},($intent|ConvertTo-Json -Compress))
$paused = & ${literal(helper)} -Action suspend -DataDirectory ${literal(dir)} -ExpectedBinding ${digest} -ExpectedOperation ${operationId} -ExpectedDeadline $deadline | ConvertFrom-Json
$pausedError = if (!$paused.ok -and $Error.Count) {
  # Only synthetic fixture operations run here; production results stay bounded
  # and do not expose process output, SSH details or credentials.
  $failure = $Error[0]
  $detail = $failure.FullyQualifiedErrorId + ': ' + $failure.Exception.Message
  $detail.Substring(0, [Math]::Min(512, $detail.Length))
} else { '' }
$Error.Clear()
$intent.phase='resuming'; $intent.vmId='${vmId}'; $intent.operationId=[guid]::NewGuid().ToString(); $intent.expiresAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+85000
[IO.File]::WriteAllText(${literal(path.join(dir, 'vm-lifecycle.json'))},($intent|ConvertTo-Json -Compress))
$resumed = & ${literal(helper)} -Action resume -DataDirectory ${literal(dir)} -ExpectedBinding ${digest} -ExpectedVmId ${vmId} -ExpectedOperation $intent.operationId -ExpectedDeadline $intent.expiresAt | ConvertFrom-Json
$resumedError = if (!$resumed.ok -and $Error.Count) {
  $failure = $Error[0]
  $detail = $failure.FullyQualifiedErrorId + ': ' + $failure.Exception.Message
  $detail.Substring(0, [Math]::Min(512, $detail.Length))
} else { '' }
@{paused=$paused;resumed=$resumed;pausedError=$pausedError;resumedError=$resumedError;pathProof=$pathProof}|ConvertTo-Json -Compress
`,
    );
    const result = observedRecord(
      JSON.parse(
        execFileSync(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            wrapper,
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 20000 },
        ),
      ),
    );
    const paused = observedRecord(result.paused),
      resumed = observedRecord(result.resumed),
      pathProof = observedRecord(result.pathProof);
    assert.equal(pathProof.vmx, true);
    assert.equal(pathProof.disk, true);
    assert.equal(
      pathProof.mixed,
      path.join(base, 'vm-key') !== fs.realpathSync.native(path.join(base, 'vm-key')),
    );
    assert.equal(
      paused.ok,
      true,
      JSON.stringify({ reply: paused, fixtureError: result.pausedError }),
    );
    assert.equal(paused.state, 'suspended');
    assert.equal(paused.changed, true);
    assert.equal(
      resumed.ok,
      true,
      JSON.stringify({ reply: resumed, fixtureError: result.resumedError }),
    );
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.changed, true);
    assert.equal(fs.readFileSync(path.join(base, 'dant.vmdk'), 'utf8'), 'fixture');
    assert.equal(fs.readFileSync(vmx, 'utf8'), `annotation = "dant-vmware-v1:${vmId}"\n`);
  },
);
