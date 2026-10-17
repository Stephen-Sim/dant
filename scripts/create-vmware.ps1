param(
  [ValidateRange(2,128)][int]$MemoryGB = 6,
  [ValidateRange(1,64)][int]$Cpu = 4,
  [ValidateRange(32,2048)][int]$DiskGB = 40,
  [switch]$Resume,
  [switch]$AdminSudo,
  [ValidateRange(1,3600)][int]$IPTimeoutSeconds = 600,
  [string]$DataDirectory,
  [string]$VmrunPath,
  [string]$VdiskmanagerPath
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$dataRoot = if ($DataDirectory) { [System.IO.Path]::GetFullPath($DataDirectory) } else { Join-Path $projectRoot 'data' }
$arguments = @((Join-Path $PSScriptRoot 'vmware.py'), 'create', '--root', $projectRoot, '--data-directory', $dataRoot,
  '--cpu', "$Cpu", '--memory-gb', "$MemoryGB", '--disk-gb', "$DiskGB", '--ip-timeout-seconds', "$IPTimeoutSeconds")
if ($Resume) { $arguments += '--resume' }
# Sudo permission is fixed in prepare-vmware's seed. Creation never rewrites it.
if ($AdminSudo) { $arguments += '--admin-sudo' }
if ($VmrunPath) { $arguments += @('--vmrun-path', $VmrunPath) }
if ($VdiskmanagerPath) { $arguments += @('--vdiskmanager-path', $VdiskmanagerPath) }
& python @arguments
if ($LASTEXITCODE) { throw "VMware creation failed (exit $LASTEXITCODE). Existing VMs and disks were preserved; inspect vm-setup-status.json and its log." }
