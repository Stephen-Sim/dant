BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $runner = Join-Path $repositoryRoot 'scripts/ci/powershell-coverage.ps1'
    $syntax = Join-Path $repositoryRoot 'scripts/ci/check-powershell.ps1'
    function Invoke-CoverageContract {
        param([string]$Directory, [object]$Measured, [string[]]$Inventory = @('scripts/fixture.ps1', 'native/fixture.ps1'), [int]$GitExit = 0)
        function git {
            $global:LASTEXITCODE = $GitExit
            return $Inventory
        }
        function Import-Module {
            param($Name, $RequiredVersion)
            if ($RequiredVersion -ne '5.9.0') { throw 'Coverage toolchain version changed' }
        }
        function Invoke-Pester {
            param($Configuration)
            if (!$Configuration.CodeCoverage.Enabled.Value -or $Configuration.CodeCoverage.Path.Value.Count -ne $Inventory.Count) {
                throw 'Coverage dropped a maintained fixture source'
            }
            if (!$Configuration.TestResult.Enabled.Value -or
                $Configuration.TestResult.OutputPath.Value -ne (Join-Path $Directory '.cache/coverage/powershell/tests.xml')) {
                throw 'Test results escaped the private coverage output'
            }
            return $Measured
        }
        & $runner -ProjectRoot $Directory
    }
    function New-CoverageContract {
        param([string]$Directory)
        $first = Join-Path $Directory 'scripts/fixture.ps1'
        $second = Join-Path $Directory 'native/fixture.ps1'
        return [pscustomobject]@{
            CodeCoverage = [pscustomobject]@{
                CommandsAnalyzedCount = 3
                CommandsExecutedCount = 3
                CommandsExecuted = @(
                    [pscustomobject]@{File = $first; Line = 1},
                    [pscustomobject]@{File = $second; Line = 1},
                    [pscustomobject]@{File = $second; Line = 2}
                )
                CommandsMissed = @()
            }
            FailedCount = 0
            FailedContainersCount = 0
            Result = 'Passed'
        }
    }
}

Describe 'Coverage runner public reports and complete source inventory' {
    BeforeEach {
        $private = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($private)
        $savedSummary = $env:GITHUB_STEP_SUMMARY
        $env:GITHUB_STEP_SUMMARY = Join-Path $private 'step-summary.md'
        $measured = New-CoverageContract $private
    }
    AfterEach { $env:GITHUB_STEP_SUMMARY = $savedSummary }

    It 'writes real weighted command counts for every source with the exact toolchain and summary' {
        Invoke-CoverageContract $private $measured | Out-Null
        $output = Join-Path $private '.cache/coverage/powershell'
        $result = Get-Content -LiteralPath (Join-Path $output 'coverage.json') -Raw | ConvertFrom-Json
        $result.metric | Should -Be 'PowerShell executable commands'
        $result.tool | Should -Be 'Pester 5.9.0'
        $result.minimum | Should -Be 95
        $result.covered | Should -Be 3
        $result.total | Should -Be 3
        $result.files.Count | Should -Be 2
        $result.files[0].file | Should -Be 'native/fixture.ps1'
        $result.files[0].covered | Should -Be 2
        (Get-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Raw) | Should -Match '100.00% \(3/3 executable commands\)'
        # Repeat the real reporting code against existing artifacts and a locally pinned module path.
        $module = Join-Path $private '.tools/powershell/Modules/Pester/5.9.0/Pester.psd1'
        [void][IO.Directory]::CreateDirectory((Split-Path $module -Parent))
        [IO.File]::WriteAllText($module, 'synthetic module; Import-Module is isolated')
        Invoke-CoverageContract $private $measured | Out-Null
        (Get-Content -LiteralPath (Join-Path $output 'coverage.json') -Raw | ConvertFrom-Json).total | Should -Be 3
    }

    It 'keeps missed commands visible and fails 95 percent without rounding' {
        $missed = $measured.CodeCoverage.CommandsExecuted[-1]
        $measured.CodeCoverage.CommandsExecuted = @($measured.CodeCoverage.CommandsExecuted | Select-Object -First 2)
        $measured.CodeCoverage.CommandsExecutedCount = 2
        $measured.CodeCoverage.CommandsMissed = @($missed)
        { Invoke-CoverageContract $private $measured } | Should -Throw '*below 95*'
        $report = Get-Content -LiteralPath (Join-Path $private '.cache/coverage/powershell/coverage.json') -Raw | ConvertFrom-Json
        $report.covered | Should -Be 2
        $report.total | Should -Be 3
        $report.files[0].missingLines | Should -Contain 2
    }

    It 'rejects missing inventory zero measurements unexpected sources inconsistent totals and failed behavior' {
        { Invoke-CoverageContract $private $measured -Inventory @() } | Should -Throw '*inventory*'
        { Invoke-CoverageContract $private $measured -GitExit 1 } | Should -Throw '*inventory*'
        $measured.CodeCoverage.CommandsAnalyzedCount = 0
        { Invoke-CoverageContract $private $measured } | Should -Throw '*empty*'
        $measured = New-CoverageContract $private
        $measured.CodeCoverage.CommandsExecuted[0].File = Join-Path $private 'unknown.ps1'
        { Invoke-CoverageContract $private $measured } | Should -Throw '*unexpected source*'
        $measured = New-CoverageContract $private
        $measured.CodeCoverage.CommandsAnalyzedCount = 4
        { Invoke-CoverageContract $private $measured } | Should -Throw '*totals*'
        $measured = New-CoverageContract $private
        $measured.FailedCount = 1
        $measured.Result = 'Failed'
        { Invoke-CoverageContract $private $measured } | Should -Throw '*behavior*'
    }
}

Describe 'PowerShell syntax checker parses source without executing it' {
    It 'accepts all maintained source and rejects an isolated malformed fixture' {
        & $syntax
        $folder = Join-Path $TestDrive 'syntax/scripts'
        [void][IO.Directory]::CreateDirectory($folder)
        $file = Join-Path $folder 'invalid.ps1'
        [IO.File]::WriteAllText($file, 'function MissingBrace {')
        Mock Resolve-Path { [pscustomobject]@{Path = (Split-Path $folder -Parent)} }
        Mock Write-Host {}
        { & $syntax } | Should -Throw '*syntax validation failed*'
    }
}
