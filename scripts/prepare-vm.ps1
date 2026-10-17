param([switch]$AdminSudo, [string]$DataDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot
$data = if ($DataDirectory) { [System.IO.Path]::GetFullPath($DataDirectory) } else { Join-Path $projectRoot 'data' }
$cache = if ($DataDirectory) { Join-Path $data 'cache\vm' } else { Join-Path $projectRoot '.cache\vm' }
$pythonTools = if ($DataDirectory) { Join-Path $data 'tools\python' } else { Join-Path $projectRoot '.tools\python' }
New-Item -ItemType Directory -Force $cache,$data | Out-Null
$key = Join-Path $data 'vm-key'
& python (Join-Path $PSScriptRoot 'vm-key.py') $key
if ($LASTEXITCODE) { throw 'SSH machine-key preparation failed; see the diagnostic above.' }
$baseUrl = 'https://cloud-images.ubuntu.com/releases/noble/release'
$filename = 'ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz'
$archive = Join-Path $cache $filename
Invoke-WebRequest "$baseUrl/SHA256SUMS" -OutFile (Join-Path $cache 'SHA256SUMS')
$sumLine = Get-Content (Join-Path $cache 'SHA256SUMS') | Where-Object { $_ -match "\s\*?$([regex]::Escape($filename))$" }
if (!$sumLine) { throw 'Official image checksum missing' }
$expected = ($sumLine -split '\s+')[0]
if (!(Test-Path $archive) -or (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $expected) {
  Write-Host 'Downloading official Ubuntu image (~810 MB)...'
  & curl.exe -L --fail --retry 3 -o "$archive" "$baseUrl/$filename"
  if ($LASTEXITCODE) { throw 'Image download failed' }
}
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Ubuntu image checksum mismatch' }
Write-Host 'Ubuntu SHA256 verified.'
$previousPythonPath = $env:PYTHONPATH
try {
  $env:PYTHONPATH = $pythonTools
  & python -c 'import importlib.util,sys;sys.exit(0 if importlib.util.find_spec("pycdlib") else 1)'
  if ($LASTEXITCODE) {
    & python -m pip install --target $pythonTools pycdlib==1.14.0
    if ($LASTEXITCODE) { throw 'ISO dependency install failed' }
  }
  $sudoMode = if ($AdminSudo) { 'true' } else { 'false' }
  & python (Join-Path $PSScriptRoot 'seed.py') $projectRoot $sudoMode --data-directory $data --cache-directory $cache
  if ($LASTEXITCODE) { throw 'Seed creation failed' }
} finally {
  $env:PYTHONPATH = $previousPythonPath
}
Write-Host 'Ready. Run scripts/create-vm.ps1 in an administrator PowerShell.'
