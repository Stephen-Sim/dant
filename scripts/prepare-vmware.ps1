param(
  [switch]$AdminSudo,
  [string]$DataDirectory,
  [string]$VmrunPath,
  [string]$VdiskmanagerPath
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$dataRoot = if ($DataDirectory) { [System.IO.Path]::GetFullPath($DataDirectory) } else { Join-Path $projectRoot 'data' }
$arguments = @((Join-Path $PSScriptRoot 'vmware.py'), 'prepare', '--root', $projectRoot, '--data-directory', $dataRoot)
if ($AdminSudo) { $arguments += '--admin-sudo' }
if ($VmrunPath) { $arguments += @('--vmrun-path', $VmrunPath) }
if ($VdiskmanagerPath) { $arguments += @('--vdiskmanager-path', $VdiskmanagerPath) }
& python @arguments
if ($LASTEXITCODE) { throw "VMware preparation failed (exit $LASTEXITCODE). Existing VMs and disks were preserved; inspect vm-setup-status.json and its log." }
