param(
  [Parameter(Mandatory=$true)][ValidateSet('suspend','resume','inspect')][string]$Action,
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedBinding,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')][string]$ExpectedOperation,
  [Parameter(Mandatory=$true)][ValidateRange(1,9223372036854775807)][long]$ExpectedDeadline,
  [ValidatePattern('^[a-fA-F0-9-]{36}$')][string]$ExpectedVmId,
  [string]$ElevatedResult
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$utf8 = New-Object System.Text.UTF8Encoding $false
$maximumOperationMilliseconds = 85000
$maximumGuestAddresses = 16
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
function Binding-Digest {
  $raw = Read-File (Join-Path $script:dataRoot 'vm.json')
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($raw)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Assert-Intent([string]$Provider) {
  if ((Binding-Digest) -ne $ExpectedBinding) { throw 'VM binding changed' }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($ExpectedDeadline -le $now -or $ExpectedDeadline - $now -gt $maximumOperationMilliseconds) { throw 'VM observation expired' }
  if ($Action -eq 'inspect') { return }
  $intent = (Read-File (Join-Path $script:dataRoot 'vm-lifecycle.json')) | ConvertFrom-Json
  $phase = if ($Action -eq 'suspend') { 'suspending' } else { 'resuming' }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($intent.version -ne 1 -or $intent.provider -ne $Provider -or $intent.binding -ne $ExpectedBinding -or $intent.phase -ne $phase -or $intent.operationId -ne $ExpectedOperation -or $intent.expiresAt -isnot [ValueType] -or [long]$intent.expiresAt -ne $ExpectedDeadline -or $ExpectedDeadline -le $now -or $ExpectedDeadline - $now -gt $maximumOperationMilliseconds -or ($ExpectedVmId -and $intent.vmId -ne $ExpectedVmId) -or (!$ExpectedVmId -and $null -ne $intent.vmId)) { throw 'VM operation intent expired or changed' }
}
function Test-OwnedDisk($Vm, [string]$Disk) {
  foreach ($drive in @(Get-VMHardDiskDrive -VM $Vm)) {
    $candidate = $drive.Path
    for ($depth=0; $candidate -and $depth -lt 16; $depth++) {
      if ([System.IO.Path]::GetFullPath($candidate) -eq [System.IO.Path]::GetFullPath($Disk)) { return $true }
      try { $candidate = (Get-VHD -Path $candidate -ErrorAction Stop).ParentPath } catch { break }
    }
  }
  return $false
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
  Assert-Intent $provider
  if ($provider -eq 'hyperv') {
    $status = (Read-File (Join-Path $script:base 'vm-setup-status.json')) | ConvertFrom-Json
    if ($status.stage -notin @('ready','guest-installing') -or $status.name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$' -or ($binding.name -and $binding.name -ne $status.name)) { throw 'Managed Hyper-V identity unavailable' }
    $disk = Join-Path $script:base 'vm\dant.vhdx'; [void](Assert-File $disk 1099511627776)
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      if ($ElevatedResult) { throw 'Hyper-V management permission unavailable' }
      # Lifecycle changes may request administrator permission. The bounded durable
      # intent is rechecked by the elevated child after the user accepts UAC.
      $resultPath = Join-Path $script:dataRoot ('.vm-lifecycle-result-' + [guid]::NewGuid().ToString() + '.json')
      [System.IO.File]::WriteAllText($resultPath,'{}',$utf8)
      try {
        $arguments = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Quote-Argument $PSCommandPath),'-Action',$Action,'-DataDirectory',(Quote-Argument $script:dataRoot),'-ExpectedBinding',$ExpectedBinding,'-ExpectedOperation',$ExpectedOperation,'-ExpectedDeadline',$ExpectedDeadline,'-ElevatedResult',(Quote-Argument $resultPath))
        if ($ExpectedVmId) { $arguments += @('-ExpectedVmId',$ExpectedVmId) }
        $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru
        if (!$process.WaitForExit(75000)) { throw 'VM suspend outcome unconfirmed' }
        return (Read-File $resultPath) | ConvertFrom-Json
      } finally { Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue }
    }
    Import-Module Hyper-V
    if ($ExpectedVmId) { $vms = @(Get-VM -Id ([guid]$ExpectedVmId) -ErrorAction Stop) }
    else {
      # Legacy bindings do not contain VMID. Only the unique VM using the exact
      # owned VHD (or its differencing descendant) can establish that identity.
      $vms = @(Get-VM -ErrorAction Stop | Where-Object { Test-OwnedDisk $_ $disk })
    }
    if ($vms.Count -ne 1) { throw 'VM identity is ambiguous' }; $vm = $vms[0]; $vmId = $vm.Id.ToString().ToLowerInvariant()
    if ($ExpectedVmId -and $vmId -ne $ExpectedVmId.ToLowerInvariant()) { throw 'VM identity changed' }
    if (!(Test-OwnedDisk $vm $disk)) { throw 'VM does not use its owned dant disk' }
    $vm = Get-VM -Id $vm.Id
    if ($vm.Id.ToString().ToLowerInvariant() -ne $vmId -or !(Test-OwnedDisk $vm $disk)) { throw 'VM identity changed' }
    Assert-Intent $provider
    $observedState = [string]$vm.State
    $changed = $false
    if ($vm.State -notin @('Running','Saved','Off')) { throw 'VM power state unconfirmed' }
    if ($Action -eq 'resume') {
        if ($vm.AutomaticCheckpointsEnabled -isnot [bool]) { throw 'VM checkpoint policy unconfirmed' }
        if ($vm.AutomaticCheckpointsEnabled) {
            Set-VM -VM $vm -AutomaticCheckpointsEnabled $false -ErrorAction Stop
            $vm = Get-VM -Id $vm.Id
            if ($vm.Id.ToString().ToLowerInvariant() -ne $vmId -or !(Test-OwnedDisk $vm $disk) -or
                [string]$vm.State -ne $observedState -or $vm.AutomaticCheckpointsEnabled -isnot [bool] -or
                $vm.AutomaticCheckpointsEnabled -ne $false) { throw 'VM identity, checkpoint policy or power state changed' }
            Assert-Intent $provider
        }
    }
    if ($Action -eq 'suspend' -and $vm.State -eq 'Running') { Save-VM -VM $vm; $changed = $true }
    elseif ($Action -eq 'resume' -and $vm.State -eq 'Saved') { Start-VM -VM $vm | Out-Null; $changed = $true }
    $vm = Get-VM -Id $vm.Id
    if ($vm.Id.ToString().ToLowerInvariant() -ne $vmId -or !(Test-OwnedDisk $vm $disk)) { throw 'VM identity changed' }
    Assert-Intent $provider
    if ($Action -eq 'resume' -and ($vm.AutomaticCheckpointsEnabled -isnot [bool] -or $vm.AutomaticCheckpointsEnabled -ne $false)) { throw 'VM checkpoint policy unconfirmed' }
    if ($Action -eq 'inspect' -and [string]$vm.State -ne $observedState) { throw 'VM power state changed during inspection' }
    $state = switch ([string]$vm.State) { 'Saved' { 'suspended' }; 'Running' { 'running' }; 'Off' { 'off' }; default { throw 'VM power state unconfirmed' } }
    $result = @{ok=$true;provider=$provider;vmId=$vmId;state=$state;changed=$changed}
    if ($Action -eq 'resume' -and $state -eq 'running') {
      $addresses = @()
      foreach ($adapter in @(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)) {
        foreach ($candidate in @($adapter.IPAddresses)) {
          $parsed = $null
          if ($candidate -isnot [string] -or $candidate -notmatch '^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$' -or ![System.Net.IPAddress]::TryParse($candidate, [ref]$parsed)) { continue }
          if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or $parsed.ToString() -ne $candidate) { continue }
          $bytes = $parsed.GetAddressBytes()
          if ($bytes[0] -eq 0 -or $bytes[0] -eq 127 -or $bytes[0] -ge 224 -or ($bytes[0] -eq 169 -and $bytes[1] -eq 254)) { continue }
          if ($addresses -notcontains $candidate) { $addresses += $candidate }
          if ($addresses.Count -gt $maximumGuestAddresses) { throw 'VM address count exceeds limit' }
        }
      }
      # Network discovery never replaces VM or operation ownership confirmation.
      $vm = Get-VM -Id $vm.Id
      if ($vm.Id.ToString().ToLowerInvariant() -ne $vmId -or !(Test-OwnedDisk $vm $disk) -or
          [string]$vm.State -ne 'Running' -or $vm.AutomaticCheckpointsEnabled -isnot [bool] -or
          $vm.AutomaticCheckpointsEnabled -ne $false) { throw 'VM identity, checkpoint policy or power state changed' }
      Assert-Intent $provider
      $result.addresses = @($addresses)
    }
    return $result
  }
  $manifestPath = Join-Path $script:base 'manifest.json'
  $manifestText = Read-File $manifestPath
  $manifest = $manifestText | ConvertFrom-Json
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
  Assert-Intent $provider
  if ($Action -eq 'suspend' -and $running) { [void](Invoke-Vmrun @('-T','ws','suspend',$script:vmx,'soft')); $changed = $true }
  elseif ($Action -eq 'resume' -and !$running -and (Vmware-Saved)) { [void](Invoke-Vmrun @('-T','ws','start',$script:vmx,'nogui')); $changed = $true }
  $observedRunning = Vmware-Running
  if ($Action -eq 'inspect') {
    if ($running -ne $observedRunning -or $manifestText -cne (Read-File $manifestPath) -or $text -cne (Read-File $script:vmx 1048576)) { throw 'VMware identity or power state changed during inspection' }
    if (!$observedRunning -and @(Get-ChildItem -LiteralPath $script:base -Filter '*.lck' -Force -ErrorAction Stop | Select-Object -First 1).Count) { throw 'VMware power transition unconfirmed' }
  }
  $state = if ($observedRunning) { 'running' } elseif (Vmware-Saved) { 'suspended' } else { 'off' }
  Assert-Intent $provider
  return @{ok=$true;provider=$provider;vmId=$vmId.ToLowerInvariant();state=$state;changed=$changed}
}
try { $result = Invoke-Lifecycle } catch { $result = @{ok=$false;reason='unconfirmed'} }
$json = $result | ConvertTo-Json -Compress
if ($ElevatedResult) {
  $expectedParent = [System.IO.Path]::GetFullPath($DataDirectory)
  if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($ElevatedResult)) -ne $expectedParent -or [System.IO.Path]::GetFileName($ElevatedResult) -notmatch '^\.vm-lifecycle-result-[a-fA-F0-9-]{36}\.json$') { throw 'Invalid VM result path' }
  [void](Read-File $ElevatedResult); [System.IO.File]::WriteAllText($ElevatedResult,$json,$utf8)
} else { Write-Output $json }
