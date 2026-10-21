param([string]$ProjectRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$ErrorActionPreference = 'Stop'

$pesterVersion = '5.9.0'
$repositoryName = 'PSGallery'
$officialSources = @('https://www.powershellgallery.com/api/v2', 'https://www.powershellgallery.com/api/v2/')

$repositories = @(Get-PSRepository -ErrorAction Stop | Where-Object { $_.Name -ieq $repositoryName })
if ($repositories.Count -eq 0) {
    Register-PSRepository -Default -ErrorAction Stop
    $repositories = @(Get-PSRepository -ErrorAction Stop | Where-Object { $_.Name -ieq $repositoryName })
}
if ($repositories.Count -ne 1 -or $repositories[0].SourceLocation -isnot [string] -or
    $repositories[0].SourceLocation -cnotin $officialSources) {
    throw 'The Pester module repository is unconfirmed.'
}

$destination = Join-Path ([IO.Path]::GetFullPath($ProjectRoot)) '.tools/powershell/Modules'
[void][IO.Directory]::CreateDirectory($destination)
$installation = @{
    Name = 'Pester'
    RequiredVersion = $pesterVersion
    Path = $destination
    Repository = $repositoryName
    Force = $true
    AcceptLicense = $true
    ErrorAction = 'Stop'
}
Save-Module @installation

$manifestPath = Join-Path $destination "Pester/$pesterVersion/Pester.psd1"
$manifest = Test-ModuleManifest -Path $manifestPath -ErrorAction Stop
if ($manifest.Name -cne 'Pester' -or $manifest.Version -isnot [version] -or
    $manifest.Version -ne [version]$pesterVersion) {
    throw 'The saved Pester module manifest is unconfirmed.'
}
