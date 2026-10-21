param(
  [Nullable[int]]$MemoryGB,
  [Nullable[int]]$Cpu,
  [Nullable[int]]$DiskGB,
  [switch]$Resume,
  [switch]$AdminSudo,
  [ValidateRange(1,3600)][int]$IPTimeoutSeconds = 600,
  [string]$DataDirectory,
  [string]$VmrunPath,
  [string]$VdiskmanagerPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'computer/resource-config.ps1')
$resources = Get-DantComputerResources
$MemoryGB = Resolve-DantComputerResource $resources.memoryGB $MemoryGB ($PSBoundParameters.ContainsKey('MemoryGB'))
$Cpu = Resolve-DantComputerResource $resources.cpu $Cpu ($PSBoundParameters.ContainsKey('Cpu'))
$DiskGB = Resolve-DantComputerResource $resources.diskGB $DiskGB ($PSBoundParameters.ContainsKey('DiskGB'))
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
