$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot
$env:CARGO_HOME=Join-Path $projectRoot '.tools\cargo'
$env:RUSTUP_HOME=Join-Path $projectRoot '.tools\rustup'
$env:PATH="$env:CARGO_HOME\bin;$env:PATH"
& npm.cmd run desktop:build
if ($LASTEXITCODE) { throw 'Desktop build failed' }
