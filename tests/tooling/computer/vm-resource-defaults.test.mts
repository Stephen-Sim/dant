import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { observedRecord } from '../../support/service-fixtures.mts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

test(
  'PowerShell VM launch defaults agree and Hyper-V resume or larger disks never shrink',
  {
    skip: process.platform !== 'win32',
  },
  (t) => {
    const entry = fs.readFileSync(path.join(root, 'scripts/create-vm.ps1'), 'utf8');
    assert.match(entry, /^#Requires -RunAsAdministrator\r?\n/);
    assert.match(entry, /computer\/hyperv-create\.ps1/);
    assert.match(entry, /Invoke-DantHyperVCreate .*@PSBoundParameters/);
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-vm-defaults-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const program = `
$ErrorActionPreference = 'Stop'
$fixtureDirectory = ${literal(fixture)}
$scriptDirectory = ${literal(path.join(root, 'scripts'))}
. (Join-Path $scriptDirectory 'computer/resource-config.ps1')
$defaults = @()
foreach ($name in @('create-vm.ps1', 'launch-vm.ps1', 'create-vmware.ps1')) {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $scriptDirectory $name), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw 'fixture_parse_failed' }
    # Invoke only the real parameter block, never a launcher or its Requires directive.
    $body = $ast.ParamBlock.Extent.Text + '\n$resources=Get-DantComputerResources
$MemoryGB=Resolve-DantComputerResource $resources.memoryGB $MemoryGB ($PSBoundParameters.ContainsKey("MemoryGB"))
$Cpu=Resolve-DantComputerResource $resources.cpu $Cpu ($PSBoundParameters.ContainsKey("Cpu"))
$DiskGB=Resolve-DantComputerResource $resources.diskGB $DiskGB ($PSBoundParameters.ContainsKey("DiskGB"))
[pscustomobject]@{memory=$MemoryGB;disk=$DiskGB;cpu=$Cpu}'
    $parameters = [scriptblock]::Create($body)
    $defaults += & $parameters -DataDirectory $fixtureDirectory
    $custom = & $parameters -DataDirectory $fixtureDirectory -MemoryGB 16 -DiskGB 128 -Cpu 12
    if ($custom.memory -ne 16 -or $custom.disk -ne 128 -or $custom.cpu -ne 12) { throw 'fixture_custom_size_lost' }
}

$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $scriptDirectory 'computer/hyperv-create.ps1'), [ref]$tokens, [ref]$parseErrors)
$guard = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
    $node.Clauses[0].Item1.Extent.Text -match 'Get-VHD' -and
    $node.Clauses[0].Item1.Extent.Text -match '\\.Size'
}, $true)
if (!$guard) { throw 'fixture_growth_guard_missing' }
$script:resizes = @()
function Get-VHD { param($Path) [pscustomobject]@{ Size=$script:capacity; ParentPath=$null } }
function Resize-VHD { param($Path, $SizeBytes) $script:resizes += $SizeBytes }
$disk = Join-Path $fixtureDirectory 'dant.vhdx'
$DiskGB = 64
foreach ($size in @(32GB,64GB,128GB)) {
    $script:capacity = $size
    & ([scriptblock]::Create($guard.Extent.Text))
}
if ($script:resizes.Count -ne 1 -or $script:resizes[0] -ne 64GB) { throw 'fixture_shrink_or_redundant_resize' }

$existingBranch = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
    $node.Clauses[0].Item1.Extent.Text -eq '$existing'
}, $true)
if (!$existingBranch) { throw 'fixture_resume_branch_missing' }
$existing = [pscustomobject]@{State='Running';MemoryStartup=16GB}
$Name = 'isolated-fixture'
$script:capacity = 128GB
$before = $script:resizes.Count
function Get-VMHardDiskDrive { param($VMName) [pscustomobject]@{Path=$disk} }
function Start-VM { throw 'fixture_unexpected_start' }
function New-VM { throw 'fixture_unexpected_create' }
function Set-VMMemory { throw 'fixture_unexpected_memory_change' }
function Set-VMProcessor { throw 'fixture_unexpected_processor_change' }
$block = $existingBranch.Clauses[0].Item2.Extent.Text
& ([scriptblock]::Create($block.Substring(1,$block.Length-2)))
if ($script:resizes.Count -ne $before -or $existing.MemoryStartup -ne 16GB -or $script:capacity -ne 128GB) { throw 'fixture_existing_size_changed' }
@{defaults=$defaults;growthCalls=$script:resizes.Count;existingPreserved=$true;realVMOperations=0} | ConvertTo-Json -Compress -Depth 3
`;
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(program, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    const result = observedRecord(JSON.parse(output));
    assert.deepEqual(
      result.defaults,
      Array.from({ length: 3 }, () => ({ memory: 8, disk: 64, cpu: 4 })),
    );
    assert.equal(result.growthCalls, 1);
    assert.equal(result.existingPreserved, true);
    assert.equal(result.realVMOperations, 0);
  },
);
