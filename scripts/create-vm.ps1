#Requires -RunAsAdministrator
param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$')][string]$Name = 'dant',
    [Nullable[int]]$MemoryGB,
    [Nullable[int]]$Cpu,
    [Nullable[int]]$DiskGB,
    [switch]$Resume,
    [string]$DataDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'computer/hyperv-create.ps1')
Invoke-DantHyperVCreate -ProjectRoot (Split-Path $PSScriptRoot -Parent) -ScriptsRoot $PSScriptRoot @PSBoundParameters
