$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$env:CARGO_HOME = Join-Path $projectRoot '.tools\cargo'
$env:RUSTUP_HOME = Join-Path $projectRoot '.tools\rustup'
New-Item -ItemType Directory -Force (Join-Path $projectRoot '.tools') | Out-Null
$installer = Join-Path $projectRoot '.tools\rustup-init.exe'
if (!(Test-Path (Join-Path $env:CARGO_HOME 'bin\cargo.exe'))) {
  Invoke-WebRequest https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe -OutFile $installer
  & $installer -y --no-modify-path --profile minimal --default-toolchain stable
  if ($LASTEXITCODE) { throw 'Rust installation failed' }
}
