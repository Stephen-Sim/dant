$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$scripts = Get-ChildItem -LiteralPath (Join-Path $repository 'scripts') -Filter '*.ps1' -Recurse -File
$failed = $false
foreach ($script in $scripts) {
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors)
    foreach ($parseError in $parseErrors) {
        Write-Host "$($script.FullName):$($parseError.Extent.StartLineNumber): $($parseError.Message)"
        $failed = $true
    }
}
if ($failed) { throw 'PowerShell syntax validation failed.' }
Write-Host "PowerShell syntax verified: $($scripts.Count) scripts (without execution)."
