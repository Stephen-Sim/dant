param([string]$ProjectRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ProjectRoot)
$output = Join-Path $root '.cache/coverage/powershell'
[void][IO.Directory]::CreateDirectory($output)
foreach ($name in @('coverage.xml', 'coverage.json', 'coverage.md', 'tests.xml')) {
    $file = Join-Path $output $name
    if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
}

$pesterVersion = '5.9.0'
$minimumCommandCoverage = 95.0
$localModule = Join-Path $root ".tools/powershell/Modules/Pester/$pesterVersion/Pester.psd1"
if (Test-Path -LiteralPath $localModule -PathType Leaf) {
    Import-Module $localModule -RequiredVersion $pesterVersion -ErrorAction Stop
} else {
    Import-Module Pester -RequiredVersion $pesterVersion -ErrorAction Stop
}

$sources = @(& git -C $root ls-files --cached --others --exclude-standard -- '*.ps1' |
    Where-Object { $_ -notmatch '^tests/' } | Sort-Object -Unique)
if ($LASTEXITCODE -ne 0 -or !$sources.Count) { throw 'PowerShell source inventory is unavailable.' }
$configuration = New-PesterConfiguration
$configuration.Run.Path = Join-Path $root 'tests/powershell'
$configuration.Run.PassThru = $true
$configuration.TestResult.Enabled = $true
$configuration.TestResult.OutputPath = Join-Path $output 'tests.xml'
$configuration.CodeCoverage.Enabled = $true
$configuration.CodeCoverage.Path = @($sources | ForEach-Object { Join-Path $root $_ })
$configuration.CodeCoverage.OutputPath = Join-Path $output 'coverage.xml'
$configuration.CodeCoverage.OutputFormat = 'JaCoCo'
$configuration.CodeCoverage.CoveragePercentTarget = $minimumCommandCoverage
$configuration.Output.Verbosity = 'Normal'
$result = Invoke-Pester -Configuration $configuration
$coverage = $result.CodeCoverage
if (!$coverage -or $coverage.CommandsAnalyzedCount -le 0) { throw 'PowerShell coverage is empty.' }

$files = @()
$reportedCommands = @($coverage.CommandsExecuted) + @($coverage.CommandsMissed)
foreach ($command in $reportedCommands) {
    $name = [IO.Path]::GetRelativePath($root, [IO.Path]::GetFullPath($command.File, $root)).Replace('\', '/')
    if ($name -notin $sources) { throw 'PowerShell coverage contains an unexpected source file.' }
}
foreach ($source in $sources) {
    $full = [IO.Path]::GetFullPath((Join-Path $root $source))
    $covered = @($coverage.CommandsExecuted | Where-Object { [IO.Path]::GetFullPath($_.File, $root) -eq $full })
    $missing = @($coverage.CommandsMissed | Where-Object { [IO.Path]::GetFullPath($_.File, $root) -eq $full })
    $files += [pscustomobject][ordered]@{
        file = $source
        covered = $covered.Count
        total = $covered.Count + $missing.Count
        missingLines = @($missing | ForEach-Object { $_.Line } | Sort-Object -Unique)
    }
}
if (($files | Measure-Object -Property total -Sum).Sum -ne $coverage.CommandsAnalyzedCount -or
    ($files | Measure-Object -Property covered -Sum).Sum -ne $coverage.CommandsExecutedCount) {
    throw 'PowerShell coverage inventory does not match the measured command totals.'
}
$report = [ordered]@{
    metric = 'PowerShell executable commands'
    platform = [Environment]::OSVersion.Platform.ToString()
    tool = "Pester $pesterVersion"
    covered = $coverage.CommandsExecutedCount
    total = $coverage.CommandsAnalyzedCount
    minimum = $minimumCommandCoverage
    files = $files
}
[IO.File]::WriteAllText((Join-Path $output 'coverage.json'), ($report | ConvertTo-Json -Depth 8) + "`n")
$percent = 100.0 * $report.covered / $report.total
$rows = @('# PowerShell command coverage', '', ('Overall: {0:F2}% ({1}/{2} executable commands).' -f $percent, $report.covered, $report.total), '', '| Source | Covered/total commands | Coverage |', '| --- | ---: | ---: |')
foreach ($file in $files) {
    $value = if ($file.total) { '{0:F2}%' -f (100.0 * $file.covered / $file.total) } else { 'No executable commands' }
    $rows += ('| `{0}` | {1}/{2} | {3} |' -f $file.file, $file.covered, $file.total, $value)
}
$rows += @('', 'Measured by Pester against every maintained PowerShell source. Unexecuted commands remain in the denominator. This is command coverage, not branch coverage or a syntax-check result. Tests do not open audio devices or operate a real VM.', '')
$markdown = $rows -join "`n"
[IO.File]::WriteAllText((Join-Path $output 'coverage.md'), $markdown)
if ($env:GITHUB_STEP_SUMMARY) { [IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, $markdown) }
if ($result.FailedCount -or $result.FailedContainersCount -or $result.Result -ne 'Passed') {
    throw 'PowerShell behavior or coverage collection failed.'
}
if ($report.covered * 100 -lt $report.total * $minimumCommandCoverage) {
    throw ('PowerShell command coverage is below {0}%.' -f $minimumCommandCoverage)
}
Write-Output ('PowerShell coverage: {0:F2}% ({1}/{2} commands).' -f $percent, $report.covered, $report.total)
