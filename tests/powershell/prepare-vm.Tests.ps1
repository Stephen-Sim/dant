BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $helper = Join-Path $repositoryRoot 'scripts/prepare-vm.ps1'
    $archiveName = 'ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz'
    $archiveBytes = [Text.Encoding]::UTF8.GetBytes('synthetic archive; never a VM image')
    $archiveDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($archiveBytes)).ToLowerInvariant()
    function python {
        $values = @($args)
        $global:dantPrepareFixture.calls += ,@{arguments = $values; pythonPath = $env:PYTHONPATH}
        $kind = if ($values[0] -like '*vm-key.py') { 'key' } elseif ($values[0] -eq '-c') { 'probe' } elseif ($values[0] -eq '-m') { 'pip' } elseif ($values[0] -like '*seed.py') { 'seed' } else { throw 'Unexpected synthetic Python command' }
        $global:LASTEXITCODE = $global:dantPrepareFixture[$kind]
    }
    function curl.exe {
        $values = @($args)
        $global:dantPrepareFixture.downloads += ,$values
        if (!$global:dantPrepareFixture.download) {
            $target = $values[$values.IndexOf('-o') + 1]
            if (![IO.Path]::GetFullPath($target).StartsWith([IO.Path]::GetFullPath($TestDrive))) { throw 'Synthetic download escaped TestDrive' }
            [IO.File]::WriteAllBytes($target, $archiveBytes)
        }
        $global:LASTEXITCODE = $global:dantPrepareFixture.download
    }
}

Describe 'Hyper-V image preparation through private files and fake network/processes' {
    BeforeEach {
        $global:dantPrepareFixture = @{calls = @(); downloads = @(); key = 0; probe = 0; pip = 0; seed = 0; download = 0; checksum = 'valid'}
        $savedLocation = Get-Location
        $savedPythonPath = $env:PYTHONPATH
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        Mock Write-Host {}
        Mock Invoke-WebRequest {
            if ($Uri -ne 'https://cloud-images.ubuntu.com/releases/noble/release/SHA256SUMS') { throw 'Unexpected synthetic download endpoint' }
            if (![IO.Path]::GetFullPath($OutFile).StartsWith([IO.Path]::GetFullPath($TestDrive))) { throw 'Synthetic checksum escaped TestDrive' }
            $content = switch ($global:dantPrepareFixture.checksum) {
                missing { 'checksum for an unrelated image' }
                mismatch { ('a' * 64) + ' *' + $archiveName }
                default { $archiveDigest + ' *' + $archiveName }
            }
            [IO.File]::WriteAllText($OutFile, $content)
        }
    }
    AfterEach {
        Set-Location $savedLocation
        $env:PYTHONPATH = $savedPythonPath
    }

    It 'verifies real fixture archive bytes and forwards only explicit sudo permission and private data paths' {
        $global:dantPrepareFixture.probe = 1
        $env:PYTHONPATH = 'original fixture path'
        & $helper -DataDirectory $data -AdminSudo
        $global:dantPrepareFixture.downloads.Count | Should -Be 1
        $global:dantPrepareFixture.calls.Count | Should -Be 4
        $seed = $global:dantPrepareFixture.calls[-1]
        $seed.arguments[0] | Should -Be (Join-Path $repositoryRoot 'scripts/seed.py')
        $seed.arguments | Should -Contain 'true'
        $seed.arguments | Should -Contain $data
        $seed.pythonPath | Should -Be (Join-Path $data 'tools/python')
        $global:dantPrepareFixture.calls[2].arguments | Should -Contain 'pycdlib==1.14.0'
        $env:PYTHONPATH | Should -Be 'original fixture path'
        (Get-FileHash -LiteralPath (Join-Path $data "cache/vm/$archiveName") -Algorithm SHA256).Hash.ToLowerInvariant() | Should -Be $archiveDigest
    }

    It 'reuses a verified archive and existing dependency without downloading or installing again' {
        $cache = Join-Path $data 'cache/vm'
        [void][IO.Directory]::CreateDirectory($cache)
        [IO.File]::WriteAllBytes((Join-Path $cache $archiveName), $archiveBytes)
        & $helper -DataDirectory $data
        $global:dantPrepareFixture.downloads.Count | Should -Be 0
        $global:dantPrepareFixture.calls.Count | Should -Be 3
        $global:dantPrepareFixture.calls[-1].arguments | Should -Contain 'false'
    }

    It 'replaces an unverified fixture cache only through the declared download and rechecks its checksum' {
        $cache = Join-Path $data 'cache/vm'
        [void][IO.Directory]::CreateDirectory($cache)
        [IO.File]::WriteAllText((Join-Path $cache $archiveName), 'corrupt synthetic cache')
        & $helper -DataDirectory $data
        $global:dantPrepareFixture.downloads.Count | Should -Be 1
        $global:dantPrepareFixture.calls[-1].arguments | Should -Contain 'false'
    }

    It 'stops missing checksums failed downloads and mismatched bytes before ISO preparation' {
        foreach ($mode in @('missing', 'download', 'mismatch')) {
            $private = Join-Path $data $mode
            $global:dantPrepareFixture.calls = @()
            $global:dantPrepareFixture.checksum = $(if ($mode -eq 'download') { 'valid' } else { $mode })
            $global:dantPrepareFixture.download = $(if ($mode -eq 'download') { 7 } else { 0 })
            { & $helper -DataDirectory $private } | Should -Throw
            $global:dantPrepareFixture.calls.Count | Should -Be 1
            $global:dantPrepareFixture.calls[0].arguments[0] | Should -BeLike '*vm-key.py'
        }
    }

    It 'propagates key dependency and seed failures without losing the previous Python environment' {
        foreach ($kind in @('key', 'pip', 'seed')) {
            $private = Join-Path $data $kind
            $global:dantPrepareFixture.key = 0
            $global:dantPrepareFixture.pip = 0
            $global:dantPrepareFixture.seed = 0
            $global:dantPrepareFixture.probe = 1
            $global:dantPrepareFixture[$kind] = 9
            $env:PYTHONPATH = 'prior fixture path'
            { & $helper -DataDirectory $private } | Should -Throw
            $env:PYTHONPATH | Should -Be 'prior fixture path'
        }
    }

    It 'keeps the documented default locations without touching real repository data' {
        Mock New-Item {}
        Mock Invoke-WebRequest {}
        Mock Get-Content { $archiveDigest + ' *' + $archiveName }
        Mock Test-Path { $true }
        Mock Get-FileHash { [pscustomobject]@{Hash = $archiveDigest} }
        & $helper
        $global:dantPrepareFixture.downloads.Count | Should -Be 0
        $global:dantPrepareFixture.calls[0].arguments[1] | Should -Be (Join-Path $repositoryRoot 'data/vm-key')
        $global:dantPrepareFixture.calls[-1].arguments | Should -Contain (Join-Path $repositoryRoot '.cache/vm')
    }
}

AfterAll {
    Remove-Variable -Scope Global -Name dantPrepareFixture -ErrorAction SilentlyContinue
}
