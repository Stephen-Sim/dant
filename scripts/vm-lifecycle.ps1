param(
  [Parameter(Mandatory=$true)][ValidateSet('suspend','resume')][string]$Action,
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedBinding,
  [ValidatePattern('^[a-fA-F0-9-]{36}$')][string]$ExpectedVmId,
  [string]$ElevatedResult
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$utf8 = New-Object System.Text.UTF8Encoding $false
function Assert-Directory([string]$Path) {
  $current = [System.IO.Path]::GetFullPath($Path)
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force
    if (!$item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Invalid VM directory' }
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }; $current = $parent
  }
}
function Assert-File([string]$Path, [long]$Limit = 65536) {
  Assert-Directory ([System.IO.Path]::GetDirectoryName($Path))
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Limit) { throw 'Invalid VM file' }
  return $item
}
function Read-File([string]$Path, [long]$Limit = 65536) {
  $item = Assert-File $Path $Limit
  return [System.IO.File]::ReadAllText($item.FullName)
}
function Quote-Argument([string]$Value) {
  if ($Value -match '["\r\n\x00]') { throw 'Invalid VM argument' }
  return '"' + [regex]::Replace($Value,'(\\+)$','$1$1') + '"'
}
function Invoke-Vmrun([string[]]$Arguments, [int]$Timeout = 60000) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $script:vmrun; $start.Arguments = ($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process; $process.StartInfo = $start
  try {
    if (!$process.Start()) { throw 'VMware operation did not start' }
    $output = $process.StandardOutput.ReadToEndAsync(); $errors = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit($Timeout)) { throw 'VMware outcome unconfirmed' }
    if ($process.ExitCode -ne 0) { throw 'VMware outcome unconfirmed' }
    $text = $output.GetAwaiter().GetResult(); [void]$errors.GetAwaiter().GetResult()
    if ($text.Length -gt 16384) { throw 'VMware output exceeds limit' }; return $text
  } finally { $process.Dispose() }
}
function Vmware-Running {
  $text = Invoke-Vmrun @('-T','ws','list') 15000
  $lines = @($text -split '\r?\n' | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
  if (!$lines.Count -or $lines[0] -notmatch '^Total running VMs: (\d+)$' -or [int]$Matches[1] -ne $lines.Count - 1) { throw 'VMware state unconfirmed' }
  return @($lines | Select-Object -Skip 1 | Where-Object { [System.IO.Path]::GetFullPath($_) -eq $script:vmx }).Count -eq 1
}
function Vmware-Saved {
  $text = Read-File $script:vmx 1048576
  $saved = 'dant.vmss'
  $match = [regex]::Match($text,'(?m)^checkpoint\.vmState\s*=\s*"([^"\r\n]+)"\s*$')
  if ($match.Success) { $saved = $match.Groups[1].Value }
  if ([System.IO.Path]::GetFileName($saved) -ne $saved -or $saved -notmatch '\.vmss$') { throw 'Invalid VMware saved state' }
  $savedPath = Join-Path $script:base $saved
  if (!(Test-Path -LiteralPath $savedPath)) { return $false }
  [void](Assert-File $savedPath 1099511627776)
  return (Get-Item -LiteralPath $savedPath).Length -gt 0
}
function Invoke-Lifecycle {
  $script:dataRoot = [System.IO.Path]::GetFullPath($DataDirectory); Assert-Directory $script:dataRoot
  $bindingPath = Join-Path $script:dataRoot 'vm.json'; $raw = Read-File $bindingPath
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $digest = ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($raw)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  if ($digest -ne $ExpectedBinding) { throw 'VM binding changed' }
  $binding = $raw | ConvertFrom-Json
  if (!$binding.keyPath -or ![System.IO.Path]::IsPathRooted($binding.keyPath) -or [System.IO.Path]::GetFileName($binding.keyPath) -ne 'vm-key' -or $binding.provider -eq 'ssh') { throw 'This connection has no managed VM identity' }
  $script:base = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($binding.keyPath)); Assert-Directory $script:base
  [void](Read-File $binding.keyPath)
  $provider = if ($binding.provider -eq 'vmware') { 'vmware' } elseif (!$binding.provider -or $binding.provider -eq 'hyperv') { 'hyperv' } else { throw 'Unsupported VM provider' }
  if ($provider -eq 'hyperv') {
    $status = (Read-File (Join-Path $script:base 'vm-setup-status.json')) | ConvertFrom-Json
    if ($status.stage -notin @('ready','guest-installing') -or $status.name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$' -or ($binding.name -and $binding.name -ne $status.name)) { throw 'Managed Hyper-V identity unavailable' }
    $disk = Join-Path $script:base 'vm\dant.vhdx'; [void](Assert-File $disk 1099511627776)
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      if ($ElevatedResult) { throw 'Hyper-V management permission unavailable' }
      # Explicit Exit may request Windows administrator permission. Closing the
      # window never runs this script, and refusal leaves dant open with work paused.
      $resultPath = Join-Path $script:dataRoot ('.vm-lifecycle-result-' + [guid]::NewGuid().ToString() + '.json')
      [System.IO.File]::WriteAllText($resultPath,'{}',$utf8)
      try {
        $arguments = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Quote-Argument $PSCommandPath),'-Action',$Action,'-DataDirectory',(Quote-Argument $script:dataRoot),'-ExpectedBinding',$ExpectedBinding,'-ElevatedResult',(Quote-Argument $resultPath))
        if ($ExpectedVmId) { $arguments += @('-ExpectedVmId',$ExpectedVmId) }
        $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru
        if (!$process.WaitForExit(75000)) { throw 'VM suspend outcome unconfirmed' }
        return (Read-File $resultPath) | ConvertFrom-Json
      } finally { Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue }
    }
    Import-Module Hyper-V
    $vms = @(Get-VM -Name $status.name -ErrorAction Stop)
    if ($vms.Count -ne 1) { throw 'VM identity is ambiguous' }; $vm = $vms[0]; $vmId = $vm.Id.ToString().ToLowerInvariant()
    if ($ExpectedVmId -and $vmId -ne $ExpectedVmId.ToLowerInvariant()) { throw 'VM identity changed' }
    $owned = $false
    foreach ($drive in @(Get-VMHardDiskDrive -VM $vm)) {
      $candidate = $drive.Path
      for ($depth=0; $candidate -and $depth -lt 16; $depth++) {
        if ([System.IO.Path]::GetFullPath($candidate) -eq [System.IO.Path]::GetFullPath($disk)) { $owned = $true; break }
        $candidate = (Get-VHD -Path $candidate).ParentPath
      }
    }
    if (!$owned) { throw 'VM does not use its owned dant disk' }
    $changed = $false
    if ($Action -eq 'suspend' -and $vm.State -eq 'Running') { Save-VM -VM $vm; $changed = $true }
    elseif ($Action -eq 'resume' -and $vm.State -eq 'Saved') { Start-VM -VM $vm | Out-Null; $changed = $true }
    elseif ($vm.State -notin @('Running','Saved','Off')) { throw 'VM power state unconfirmed' }
    $vm = Get-VM -Id $vm.Id
    $state = switch ([string]$vm.State) { 'Saved' { 'suspended' }; 'Running' { 'running' }; 'Off' { 'off' }; default { throw 'VM power state unconfirmed' } }
    return @{ok=$true;provider=$provider;vmId=$vmId;state=$state;changed=$changed}
  }
  $manifest = (Read-File (Join-Path $script:base 'manifest.json')) | ConvertFrom-Json
  $script:vmx = Join-Path $script:base 'dant.vmx'; $disk = Join-Path $script:base 'dant.vmdk'
  $vmId = [string]$manifest.id
  if ($manifest.owner -ne 'dant-vmware-v1' -or $manifest.version -ne 1 -or $manifest.provider -ne 'vmware' -or $vmId -notmatch '^[a-fA-F0-9-]{36}$' -or $binding.vmwareId -ne $vmId -or ($ExpectedVmId -and $ExpectedVmId -ne $vmId) -or [System.IO.Path]::GetFullPath($manifest.vmx) -ne $script:vmx -or [System.IO.Path]::GetFullPath($manifest.disk) -ne $disk -or $manifest.phase -notin @('created','starting','started','connected')) { throw 'VMware ownership unconfirmed' }
  $text = Read-File $script:vmx 1048576
  if ($text -notmatch ('(?m)^annotation\s*=\s*"dant-vmware-v1:' + [regex]::Escape($vmId) + '"\s*$')) { throw 'VMware annotation changed' }
  [void](Assert-File $disk 1099511627776)
  $script:vmrun = $null
  foreach ($directory in @(${env:ProgramFiles(x86)},$env:ProgramFiles)) {
    if (!$directory) { continue }; $candidate = Join-Path $directory 'VMware\VMware Workstation\vmrun.exe'
    if (Test-Path -LiteralPath $candidate) { [void](Assert-File $candidate 104857600); $script:vmrun = $candidate; break }
  }
  if (!$script:vmrun) { throw 'VMware management tool unavailable' }
  $running = Vmware-Running; $changed = $false
  if ($Action -eq 'suspend' -and $running) { [void](Invoke-Vmrun @('-T','ws','suspend',$script:vmx,'soft')); $changed = $true }
  elseif ($Action -eq 'resume' -and !$running -and (Vmware-Saved)) { [void](Invoke-Vmrun @('-T','ws','start',$script:vmx,'nogui')); $changed = $true }
  $state = if (Vmware-Running) { 'running' } elseif (Vmware-Saved) { 'suspended' } else { 'off' }
  return @{ok=$true;provider=$provider;vmId=$vmId.ToLowerInvariant();state=$state;changed=$changed}
}
try { $result = Invoke-Lifecycle } catch { $result = @{ok=$false;reason='unconfirmed'} }
$json = $result | ConvertTo-Json -Compress
if ($ElevatedResult) {
  $expectedParent = [System.IO.Path]::GetFullPath($DataDirectory)
  if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($ElevatedResult)) -ne $expectedParent -or [System.IO.Path]::GetFileName($ElevatedResult) -notmatch '^\.vm-lifecycle-result-[a-fA-F0-9-]{36}\.json$') { throw 'Invalid VM result path' }
  [void](Read-File $ElevatedResult); [System.IO.File]::WriteAllText($ElevatedResult,$json,$utf8)
} else { Write-Output $json }
