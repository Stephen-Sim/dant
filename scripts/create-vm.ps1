#Requires -RunAsAdministrator
param(
  [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$')][string]$Name = 'dant',
  [ValidateRange(2,128)][int]$MemoryGB = 6,
  [ValidateRange(1,64)][int]$Cpu = 4,
  [ValidateRange(32,2048)][int]$DiskGB = 40,
  [switch]$Resume,
  [string]$DataDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$dataRoot = if ($DataDirectory) { [System.IO.Path]::GetFullPath($DataDirectory) } else { Join-Path $projectRoot 'data' }
$cache = if ($DataDirectory) { Join-Path $dataRoot 'cache\vm' } else { Join-Path $projectRoot '.cache\vm' }
$vmRoot = Join-Path $dataRoot 'vm'
$logs = Join-Path $dataRoot 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$logPath = Join-Path $logs ("create-vm-{0}-{1}.log" -f $Name,(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$statusPath = Join-Path $dataRoot 'vm-setup-status.json'
$stage = 'starting'
function Save-Stage([string]$Value, [string]$ErrorMessage = '') {
  $script:stage = $Value
  @{name=$Name;stage=$Value;updatedAt=(Get-Date).ToUniversalTime().ToString('o');log=$logPath;error=$ErrorMessage} |
    ConvertTo-Json | Set-Content -Encoding utf8 $statusPath
  Write-Host "VM setup: $Value"
}
Start-Transcript -Path $logPath | Out-Null
try {
  Save-Stage 'checking-hyper-v'
  Import-Module Hyper-V
  $disk = Join-Path $vmRoot 'dant.vhdx'
  $existing = Get-VM -Name $Name -ErrorAction SilentlyContinue
  if ($existing -and !$Resume) { throw "VM '$Name' already exists. Use -Resume to refresh its connection; it has not been modified." }
  if ($existing) {
    $attached = @(Get-VMHardDiskDrive -VMName $Name)
    $usesExpectedDisk = $false
    foreach ($drive in $attached) {
      $candidate = $drive.Path
      for ($depth=0; $candidate -and $depth -lt 16; $depth++) {
        if ([System.IO.Path]::GetFullPath($candidate) -eq [System.IO.Path]::GetFullPath($disk)) { $usesExpectedDisk=$true; break }
        $candidate = (Get-VHD -Path $candidate).ParentPath
      }
    }
    if (!$usesExpectedDisk) {
      throw "VM '$Name' does not use the expected dant disk. Refusing to operate on it."
    }
    if ($existing.State -eq 'Off' -or $existing.State -eq 'Saved') { Start-VM -Name $Name }
    elseif ($existing.State -ne 'Running') { throw "VM is $($existing.State). Resolve that state in Hyper-V Manager, then use -Resume." }
  } else {
    if ($Resume) { throw "VM '$Name' does not exist. Run without -Resume for initial creation." }
    if (Test-Path -LiteralPath $disk) { throw "Disk '$disk' already exists. It has been preserved; inspect vm-setup-status.json and the previous log before recovery." }
    if (!(Test-Path (Join-Path $cache 'seed.iso'))) { throw 'Run prepare-vm.ps1 first.' }
    $switch = Get-VMSwitch | Where-Object { $_.Id -eq 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444' } | Select-Object -First 1
    if (!$switch) { $switch = Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue }
    if (!$switch) { throw 'Hyper-V Default Switch is unavailable. Configure a NAT switch before proceeding.' }
    New-Item -ItemType Directory -Force $vmRoot | Out-Null
    $source = @(Get-ChildItem -LiteralPath $vmRoot -Filter '*.vhd' -File)
    if ($source.Count -gt 1) { throw 'Multiple source VHD files exist; no image was modified.' }
    if (!$source.Count) {
      Save-Stage 'extracting-image'
      $archive = Join-Path $cache 'ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz'
      if (!(Test-Path -LiteralPath $archive)) { throw 'Ubuntu archive missing. Run prepare-vm.ps1.' }
      & tar.exe -xf $archive -C $vmRoot
      if ($LASTEXITCODE) { throw 'Image extraction failed. Source files have been preserved for inspection.' }
      $source = @(Get-ChildItem -LiteralPath $vmRoot -Filter '*.vhd' -File)
    }
    if ($source.Count -ne 1) { throw 'Expected exactly one source VHD in the official image archive.' }
    $sourceDisk = $source[0].FullName
    if ($source[0].Name -ne 'livecd.ubuntu-cpc.azure.vhd') { throw 'Unexpected source VHD name. Only the official prepared Ubuntu image is supported.' }
    $unsupportedAttributes = [System.IO.FileAttributes]::Compressed -bor [System.IO.FileAttributes]::Encrypted
    $sourceAttributes = [System.IO.File]::GetAttributes($sourceDisk)
    $directoryAttributes = [System.IO.File]::GetAttributes($vmRoot)
    if (($sourceAttributes -band $unsupportedAttributes) -or ($directoryAttributes -band $unsupportedAttributes)) {
      throw 'The source VHD or VM directory is compressed/encrypted. Select an uncompressed, unencrypted data directory; host directory policies were not changed.'
    }
    if ($sourceAttributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Source VHD is a reparse point; no image was modified.' }
    # Patch only a fixed source disk which is not attached to any VM. Never
    # patch an existing VHDX or registered VM, including partially created VMs.
    if ((Get-VHD -Path $sourceDisk).Attached) { throw 'Source VHD is attached; no image was modified.' }
    $usedSource = Get-VM | Get-VMHardDiskDrive | Where-Object { $_.Path -eq $sourceDisk }
    if ($usedSource) { throw 'Source VHD is registered with a VM; no image was modified.' }
    Save-Stage 'configuring-nocloud'
    $audit = Join-Path $cache 'image-patch-audit.json'
    & python (Join-Path $PSScriptRoot 'patch-image.py') $sourceDisk --apply --audit $audit
    if ($LASTEXITCODE) { throw 'Offline NoCloud preparation failed; see image patch diagnostics above.' }
    # tar may retain the archive's sparse-file representation. Hyper-V rejects
    # sparse backing files (0xC03A001A). On current Windows, clearing the flag
    # allocates the holes; only this unattached source file is affected.
    $sourceLength = (Get-Item -LiteralPath $sourceDisk).Length
    $volume = Get-Volume -FilePath $sourceDisk
    if (!$volume -or $volume.FileSystemType -notin @('NTFS','ReFS')) { throw 'Source VHD must be on a supported local NTFS/ReFS volume.' }
    $isSparse = ($sourceAttributes -band [System.IO.FileAttributes]::SparseFile) -ne 0
    # Reserve a full destination copy plus metadata. Before unsparsing also
    # reserve a full source allocation; this is deliberately conservative.
    $requiredFree = $sourceLength + 1GB
    if ($isSparse) { $requiredFree += $sourceLength }
    if ([long]$volume.SizeRemaining -lt $requiredFree) {
      throw ("Not enough free space: require at least {0:N1} GiB for source allocation/conversion, available {1:N1} GiB. Source was preserved." -f ($requiredFree / 1GB),($volume.SizeRemaining / 1GB))
    }
    if ($isSparse) {
      Save-Stage 'allocating-source-disk'
      Write-Host ("Allocating sparse source VHD ({0:N1} GiB logical size). This can take several minutes." -f ($sourceLength / 1GB))
      & fsutil.exe sparse setflag $sourceDisk 0
      if ($LASTEXITCODE) { throw 'Could not clear source VHD sparse flag. File and audit were preserved; inspect free space and the log before retrying.' }
      $afterAttributes = [System.IO.File]::GetAttributes($sourceDisk)
      if ($afterAttributes -band ([System.IO.FileAttributes]::SparseFile -bor $unsupportedAttributes)) { throw 'Source VHD remains sparse/compressed/encrypted; conversion was not attempted.' }
      if ((Get-Item -LiteralPath $sourceDisk).Length -ne $sourceLength) { throw 'Source VHD length changed during allocation; conversion was not attempted.' }
      & python (Join-Path $PSScriptRoot 'patch-image.py') $sourceDisk
      if ($LASTEXITCODE) { throw 'Source VHD did not pass read-back validation after sparse allocation.' }
      $volume = Get-Volume -FilePath $sourceDisk
      if ([long]$volume.SizeRemaining -lt ($sourceLength + 1GB)) { throw 'Source was allocated, but insufficient free space remains for conversion. The source was preserved.' }
    }
    Save-Stage 'converting-disk'
    Convert-VHD -Path $sourceDisk -DestinationPath $disk -VHDType Dynamic
    Save-Stage 'resizing-disk'
    Resize-VHD -Path $disk -SizeBytes ($DiskGB * 1GB)
    Save-Stage 'registering-vm'
    # The official Azure VHD has legacy BIOS boot support.
    New-VM -Name $Name -Generation 1 -MemoryStartupBytes ($MemoryGB * 1GB) -VHDPath $disk -SwitchName $switch.Name -Path $vmRoot | Out-Null
    Set-VMProcessor -VMName $Name -Count $Cpu
    Set-VM -Name $Name -AutomaticStartAction Start -AutomaticStopAction Save -AutomaticCheckpointsEnabled $false
    Set-VMDvdDrive -VMName $Name -Path (Join-Path $cache 'seed.iso')
    Save-Stage 'booting-vm'
    Start-VM -Name $Name
  }
  Save-Stage 'waiting-for-ip'
  $deadline = (Get-Date).AddMinutes(8)
  $guestAddress = $null
  while ((Get-Date) -lt $deadline -and !$guestAddress) {
    $guestAddress = (Get-VMNetworkAdapter -VMName $Name).IPAddresses |
      Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notmatch '^(169\.254\.|127\.|0\.)' } | Select-Object -First 1
    if (!$guestAddress) { Start-Sleep -Seconds 5 }
  }
  if (!$guestAddress) { throw 'VM exists but its IP is unavailable. Inspect Hyper-V Manager, then use -Resume; do not recreate it.' }
  $connection = @{host=$guestAddress;user='dant';port=22;keyPath=(Join-Path $dataRoot 'vm-key');knownHosts=(Join-Path $dataRoot 'known_hosts')}
  $connection | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $dataRoot 'vm.json')
  Save-Stage 'guest-installing'
  Write-Host "VM reachable at $guestAddress. Desktop installation may take 10-20 minutes."
  Write-Host 'Run scripts/check-vm.ps1 to check readiness, then restart dant to load the connection.'
} catch {
  $failedStage = $stage
  Save-Stage "failed:$failedStage" $_.Exception.Message
  Write-Host "VM setup stopped at '$failedStage'. Log: $logPath"
  Write-Host 'Existing VM and disk files were preserved.'
  throw
} finally {
  Stop-Transcript | Out-Null
}
