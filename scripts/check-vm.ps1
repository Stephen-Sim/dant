param([switch]$Diagnostics, [string]$DataDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$dataRoot = if ($DataDirectory) { [System.IO.Path]::GetFullPath($DataDirectory) } else { Join-Path $projectRoot 'data' }
$binding = Join-Path $dataRoot 'vm.json'
if (!(Test-Path -LiteralPath $binding)) { throw 'VM connection is missing. Complete create-vm.ps1 (or use -Resume for an existing VM) first.' }
$vm = Get-Content -LiteralPath $binding -Raw | ConvertFrom-Json
if (!$vm.host -or !$vm.user -or !(Test-Path -LiteralPath $vm.keyPath)) { throw 'VM connection or SSH key is incomplete.' }
$port = if ($vm.port) { [int]$vm.port } else { 22 }
$sshArgs = @('-T','-p',"$port",'-i',$vm.keyPath,'-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=accept-new','-o',"UserKnownHostsFile=$($vm.knownHosts)","$($vm.user)@$($vm.host)")
$command = @'
set -e
test -f /home/dant/work/.dant-ready
systemctl is-active dant-display.service dant-desktop.service dant-guest.service
DISPLAY=:0 xdpyinfo >/dev/null
python3 -c 'import urllib.request; assert urllib.request.urlopen("http://127.0.0.1:4319/screen", timeout=10).read(8)==b"\x89PNG\r\n\x1a\n"'
if [ -x "$HOME/.local/bin/codex" ]; then "$HOME/.local/bin/codex" --version; else /usr/local/bin/codex --version; fi
'@
& ssh @sshArgs $command
$ready = $LASTEXITCODE -eq 0
if ($Diagnostics) {
  $diagnosticsCommand = @'
cloud-init status --long
systemctl status dant-bootstrap.service dant-display.service dant-desktop.service dant-guest.service --no-pager --full
journalctl -u dant-bootstrap.service -n 35 --no-pager
tail -n 35 /var/log/dant-bootstrap.log
'@
  & ssh @sshArgs $diagnosticsCommand
}
if (!$ready) {
  Write-Host 'Guest is not ready. The installer retries automatically; run check-vm.ps1 -Diagnostics for details.'
  exit 1
}
Write-Host 'dant VM is ready: SSH, XFCE display, screenshot bridge and Codex passed.'
$statusPath = Join-Path $dataRoot 'vm-setup-status.json'
if (Test-Path -LiteralPath $statusPath) {
  $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  $status.stage = 'ready'
  $status.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $status | ConvertTo-Json | Set-Content -Encoding utf8 $statusPath
}
exit 0
