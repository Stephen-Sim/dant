BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $installer = Join-Path $repositoryRoot '.tools/rustup-init.exe'
    function ssh {
        $global:dantToolFixture.sshCalls += ,@($args)
        $global:LASTEXITCODE = $global:dantToolFixture.sshExit
    }
    function npm.cmd {
        $global:dantToolFixture.npmCalls += ,@($args)
        $global:LASTEXITCODE = $global:dantToolFixture.npmExit
    }
    Set-Item -LiteralPath ("Function:script:" + $installer) -Value {
        $global:dantToolFixture.rustCalls += ,@($args)
        $global:LASTEXITCODE = $global:dantToolFixture.rustExit
    }
    function New-CheckFixture {
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($data)
        $key = Join-Path $data 'key with spaces'
        [IO.File]::WriteAllText($key, 'synthetic file; never a real SSH key')
        $binding = @{host = '192.0.2.22'; user = 'fixture'; keyPath = $key; knownHosts = (Join-Path $data 'known_hosts')}
        [IO.File]::WriteAllText((Join-Path $data 'vm.json'), ($binding | ConvertTo-Json -Compress))
        [IO.File]::WriteAllText((Join-Path $data 'vm-setup-status.json'), '{"stage":"guest-installing","updatedAt":"original"}')
        return $data
    }
}

Describe 'Readiness and build launchers with isolated process boundaries' {
    BeforeEach {
        $global:dantToolFixture = @{sshCalls = @(); sshExit = 0; npmCalls = @(); npmExit = 0; rustCalls = @(); rustExit = 0}
        $savedLocation = Get-Location
        $savedCargo = $env:CARGO_HOME
        $savedRustup = $env:RUSTUP_HOME
        $savedPath = $env:PATH
        Mock Write-Host {}
    }
    AfterEach {
        Set-Location $savedLocation
        $env:CARGO_HOME = $savedCargo
        $env:RUSTUP_HOME = $savedRustup
        $env:PATH = $savedPath
    }

    It 'uses exact SSH arguments and promotes only confirmed readiness' {
        $data = New-CheckFixture
        & (Join-Path $repositoryRoot 'scripts/check-vm.ps1') -DataDirectory $data
        $LASTEXITCODE | Should -Be 0
        $calls = $global:dantToolFixture.sshCalls
        $calls.Count | Should -Be 1
        $calls[0] | Should -Contain '-T'
        $calls[0] | Should -Contain '22'
        $calls[0] | Should -Contain 'BatchMode=yes'
        $calls[0] | Should -Contain 'fixture@192.0.2.22'
        $calls[0] | Should -Contain (Join-Path $data 'key with spaces')
        $calls[0][-1] | Should -Match 'python3 /opt/dant/network_config.py bootstrap-screen-check'
        $calls[0][-1] | Should -Not -Match '4319|urllib.request'
        (Get-Content -LiteralPath (Join-Path $data 'vm-setup-status.json') -Raw | ConvertFrom-Json).stage | Should -Be 'ready'
    }

    It 'preserves failed readiness even when diagnostics succeeds and uses an explicit SSH port' {
        $data = New-CheckFixture
        $bindingPath = Join-Path $data 'vm.json'
        $binding = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json
        $binding | Add-Member -NotePropertyName port -NotePropertyValue 2222
        $binding | ConvertTo-Json | Set-Content -LiteralPath $bindingPath
        $global:dantToolFixture.sshExit = 7
        & (Join-Path $repositoryRoot 'scripts/check-vm.ps1') -DataDirectory $data -Diagnostics
        $LASTEXITCODE | Should -Be 1
        $global:dantToolFixture.sshCalls.Count | Should -Be 2
        $global:dantToolFixture.sshCalls[0] | Should -Contain '2222'
        (Get-Content -LiteralPath (Join-Path $data 'vm-setup-status.json') -Raw | ConvertFrom-Json).stage | Should -Be 'guest-installing'
    }

    It 'never runs SSH for absent or incomplete binding and does not invent setup status' {
        $data = New-CheckFixture
        Remove-Item -LiteralPath (Join-Path $data 'vm-setup-status.json')
        & (Join-Path $repositoryRoot 'scripts/check-vm.ps1') -DataDirectory $data
        Test-Path -LiteralPath (Join-Path $data 'vm-setup-status.json') | Should -BeFalse
        $global:dantToolFixture.sshCalls = @()
        [IO.File]::WriteAllText((Join-Path $data 'vm.json'), '{}')
        { & (Join-Path $repositoryRoot 'scripts/check-vm.ps1') -DataDirectory $data } | Should -Throw '*incomplete*'
        Remove-Item -LiteralPath (Join-Path $data 'vm.json')
        { & (Join-Path $repositoryRoot 'scripts/check-vm.ps1') -DataDirectory $data } | Should -Throw '*missing*'
        $global:dantToolFixture.sshCalls.Count | Should -Be 0
    }

    It 'prepares only the declared build environment and preserves npm build failure' {
        & (Join-Path $repositoryRoot 'scripts/build-desktop.ps1')
        $global:dantToolFixture.npmCalls.Count | Should -Be 1
        $global:dantToolFixture.npmCalls[0] -join ' ' | Should -Be 'run desktop:build'
        $env:CARGO_HOME | Should -Be (Join-Path $repositoryRoot '.tools/cargo')
        $env:RUSTUP_HOME | Should -Be (Join-Path $repositoryRoot '.tools/rustup')
        $global:dantToolFixture.npmExit = 3
        { & (Join-Path $repositoryRoot 'scripts/build-desktop.ps1') } | Should -Throw '*Desktop build failed*'
    }

    It 'installs only the fixed Rust toolchain command when cargo is absent and never downloads when present' {
        Mock New-Item {}
        Mock Invoke-WebRequest {}
        Mock Test-Path { $false }
        (Get-Command -Name $installer).CommandType | Should -Be 'Function'
        & (Join-Path $repositoryRoot 'scripts/setup-tools.ps1')
        $global:dantToolFixture.rustCalls.Count | Should -Be 1
        $global:dantToolFixture.rustCalls[0] -join ' ' | Should -Be '-y --no-modify-path --profile minimal --default-toolchain stable'
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly
        $global:dantToolFixture.rustExit = 9
        { & (Join-Path $repositoryRoot 'scripts/setup-tools.ps1') } | Should -Throw '*Rust installation failed*'
        Mock Test-Path { $true }
        $global:dantToolFixture.rustCalls = @()
        & (Join-Path $repositoryRoot 'scripts/setup-tools.ps1')
        $global:dantToolFixture.rustCalls.Count | Should -Be 0
    }
}

Describe 'Elevated launcher contract without starting any process or showing UAC' {
    BeforeEach {
        $global:dantToolFixture = @{startCalls = @(); startExit = 0; startFailure = $null}
        Mock Start-Process {
            $global:dantToolFixture.startCalls += ,@{file = $FilePath; arguments = $ArgumentList; verb = $Verb; window = $WindowStyle; wait = $Wait}
            if ($global:dantToolFixture.startFailure) { throw $global:dantToolFixture.startFailure }
            return [pscustomobject]@{ExitCode = $global:dantToolFixture.startExit}
        }
    }
    It 'passes quoted paths and bounded resources to one hidden administrator process and returns its exit code' {
        $global:dantToolFixture.startExit = 4
        & (Join-Path $repositoryRoot 'scripts/launch-vm.ps1') -DataDirectory (Join-Path $TestDrive 'data with spaces') -MemoryGB 16 -Cpu 6 -DiskGB 128
        $LASTEXITCODE | Should -Be 4
        $global:dantToolFixture.startCalls.Count | Should -Be 1
        $call = $global:dantToolFixture.startCalls[0]
        $call.verb | Should -Be 'RunAs'
        $call.window | Should -Be 'Hidden'
        $call.wait | Should -BeTrue
        $call.arguments | Should -Contain '16'
        $call.arguments | Should -Contain '128'
        $call.arguments | Should -Contain '6'
        @($call.arguments | Where-Object { $_ -like '*data with spaces*' })[0] | Should -Match '^".*"$'
    }
    It 'classifies cancelled and other start failures without retrying' {
        $global:dantToolFixture.startFailure = [ComponentModel.Win32Exception]::new(1223)
        & (Join-Path $repositoryRoot 'scripts/launch-vm.ps1') -DataDirectory $TestDrive
        $LASTEXITCODE | Should -Be 1223
        $global:dantToolFixture.startCalls.Count | Should -Be 1
        $global:dantToolFixture.startFailure = [InvalidOperationException]::new('synthetic start failure')
        & (Join-Path $repositoryRoot 'scripts/launch-vm.ps1') -DataDirectory $TestDrive
        $LASTEXITCODE | Should -Be 1
        $global:dantToolFixture.startCalls.Count | Should -Be 2
    }
    It 'rejects invalid paths and resources before the process boundary' {
        { & (Join-Path $repositoryRoot 'scripts/launch-vm.ps1') -DataDirectory 'bad"fixture' } | Should -Throw '*Invalid VM setup path*'
        { & (Join-Path $repositoryRoot 'scripts/launch-vm.ps1') -DataDirectory $TestDrive -MemoryGB 1 } | Should -Throw
        $global:dantToolFixture.startCalls.Count | Should -Be 0
    }
}

AfterAll {
    Remove-Item -LiteralPath ("Function:script:" + $installer) -ErrorAction SilentlyContinue
    Remove-Variable -Scope Global -Name dantToolFixture -ErrorAction SilentlyContinue
}
