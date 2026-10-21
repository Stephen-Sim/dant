param(
  [Parameter(Mandatory=$true)][string]$DataDirectory,
  [Nullable[int]]$MemoryGB,
  [Nullable[int]]$Cpu,
  [Nullable[int]]$DiskGB
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'computer/resource-config.ps1')
$resources = Get-DantComputerResources
$MemoryGB = Resolve-DantComputerResource $resources.memoryGB $MemoryGB ($PSBoundParameters.ContainsKey('MemoryGB'))
$Cpu = Resolve-DantComputerResource $resources.cpu $Cpu ($PSBoundParameters.ContainsKey('Cpu'))
$DiskGB = Resolve-DantComputerResource $resources.diskGB $DiskGB ($PSBoundParameters.ContainsKey('DiskGB'))
$dataRoot = [System.IO.Path]::GetFullPath($DataDirectory)
$createScript = Join-Path $PSScriptRoot 'create-vm.ps1'

# Start-Process joins ArgumentList into a native Windows command line. These
# paths cannot contain double quotes or newlines; quote each to preserve spaces.
function Quote-PathArgument([string]$Value) {
  if ($Value -match '["\r\n\x00]') { throw 'Invalid VM setup path' }
  $escaped = [regex]::Replace($Value,'(\\+)$','$1$1')
  return '"' + $escaped + '"'
}
$arguments = @(
  '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
  '-File',(Quote-PathArgument $createScript),
  '-DataDirectory',(Quote-PathArgument $dataRoot),
  '-Cpu',"$Cpu",'-MemoryGB',"$MemoryGB",'-DiskGB',"$DiskGB"
)
try {
  $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $process.ExitCode
} catch {
  $cancelled = $_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223
  if ($cancelled) {
    [Console]::Error.WriteLine('DANT_UAC_CANCELLED: Administrator approval was cancelled.')
    exit 1223
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
