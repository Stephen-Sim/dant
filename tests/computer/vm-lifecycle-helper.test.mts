import type { TestContext as NodeTestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { observedRecord } from '../support/service-fixtures.mts';

const helper = fileURLToPath(new URL('../../scripts/vm-lifecycle.ps1', import.meta.url));
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function fixture(
  t: NodeTestContext,
  { state = 'Running', foreign = false, expected = '', action = 'suspend' } = {},
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
  const wrapper = path.join(dir, 'fixture.ps1');
  fs.writeFileSync(
    wrapper,
    `
$ErrorActionPreference='Stop'
$global:dantFixtureState=${literal(state)}; $global:dantSaves=0; $global:dantStarts=0
function New-Object {
 param([string]$TypeName,[Parameter(ValueFromRemainingArguments=$true)][object[]]$ArgumentList)
 if($TypeName -eq 'Security.Principal.WindowsPrincipal') { $value=[pscustomobject]@{}; $value|Add-Member -MemberType ScriptMethod -Name IsInRole -Value {param($role) return $true}; return $value }
 Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
}
function Import-Module {param($Name) if($Name -ne 'Hyper-V'){throw 'Unexpected module'} }
function Get-VM {param($Name,$Id) return [pscustomobject]@{Id=[guid]'312961c7-77b3-4b59-8c39-437c9ca99bd1'; State=$global:dantFixtureState} }
function Get-VMHardDiskDrive {param($VM) return [pscustomobject]@{Path=${literal(foreign ? path.join(dir, 'other.vhdx') : disk)}} }
function Get-VHD {throw 'Foreign disk must never be traversed in this fixture'}
function Save-VM {param($VM) $global:dantSaves++; $global:dantFixtureState='Saved' }
function Start-VM {param($VM) $global:dantStarts++; $global:dantFixtureState='Running' }
function Start-Process {throw 'No real process or elevation is permitted by this fixture'}
$reply = & ${literal(helper)} -Action ${action} -DataDirectory ${literal(dir)} -ExpectedBinding ${digest} ${expected ? `-ExpectedVmId ${expected}` : ''} | ConvertFrom-Json
@{reply=$reply;saves=$global:dantSaves;starts=$global:dantStarts;state=$global:dantFixtureState}|ConvertTo-Json -Compress
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
    ]) {
      const result = fixture(t, options);
      assert.equal(result.reply.ok, false);
      assert.equal(result.saves, 0);
      assert.equal(result.starts, 0);
    }
  },
);
test(
  'VMware helper suspends and restores its exact annotated VM with confirmed vmrun state',
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
      keyPath: path.join(base, 'vm-key'),
      host: '192.0.2.2',
      user: 'dant',
    });
    fs.writeFileSync(path.join(dir, 'vm.json'), raw);
    const digest = createHash('sha256').update(raw).digest('hex'),
      state = path.join(base, 'fixture-state');
    fs.writeFileSync(state, 'running');
    const wrapper = path.join(dir, 'fixture.ps1');
    fs.writeFileSync(
      wrapper,
      `
$ErrorActionPreference='Stop'
$env:ProgramFiles=${literal(path.join(dir, 'programs'))}; [Environment]::SetEnvironmentVariable('ProgramFiles(x86)',$env:ProgramFiles)
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
$paused = & ${literal(helper)} -Action suspend -DataDirectory ${literal(dir)} -ExpectedBinding ${digest} | ConvertFrom-Json
$pausedError = if (!$paused.ok -and $Error.Count) {
  # Only synthetic fixture operations run here; production results stay bounded
  # and do not expose process output, SSH details or credentials.
  $failure = $Error[0]
  $detail = $failure.FullyQualifiedErrorId + ': ' + $failure.Exception.Message
  $detail.Substring(0, [Math]::Min(512, $detail.Length))
} else { '' }
$Error.Clear()
$resumed = & ${literal(helper)} -Action resume -DataDirectory ${literal(dir)} -ExpectedBinding ${digest} -ExpectedVmId ${vmId} | ConvertFrom-Json
$resumedError = if (!$resumed.ok -and $Error.Count) {
  $failure = $Error[0]
  $detail = $failure.FullyQualifiedErrorId + ': ' + $failure.Exception.Message
  $detail.Substring(0, [Math]::Min(512, $detail.Length))
} else { '' }
@{paused=$paused;resumed=$resumed;pausedError=$pausedError;resumedError=$resumedError}|ConvertTo-Json -Compress
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
      resumed = observedRecord(result.resumed);
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
  },
);
