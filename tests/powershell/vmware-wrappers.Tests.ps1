BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    function python {
        $global:dantCoveragePythonArguments = @($args)
        $global:LASTEXITCODE = $global:dantCoveragePythonExit
    }
}

Describe 'VMware command wrappers with an isolated Python boundary' {
    BeforeEach {
        $global:dantCoveragePythonExit = 0
        $global:dantCoveragePythonArguments = @()
    }

    It 'uses the shared default VM sizes and explicit data paths' {
        $data = Join-Path $TestDrive 'data with spaces'
        & (Join-Path $repositoryRoot 'scripts/create-vmware.ps1') -DataDirectory $data
        $arguments = $global:dantCoveragePythonArguments
        $arguments[1] | Should -Be 'create'
        $arguments[$arguments.IndexOf('--memory-gb') + 1] | Should -Be '8'
        $arguments[$arguments.IndexOf('--disk-gb') + 1] | Should -Be '64'
        $arguments[$arguments.IndexOf('--cpu') + 1] | Should -Be '4'
        $arguments[$arguments.IndexOf('--data-directory') + 1] | Should -Be $data
        $arguments | Should -Not -Contain '--admin-sudo'
    }

    It 'forwards every explicit creation option as a distinct argument without executing VMware' {
        & (Join-Path $repositoryRoot 'scripts/create-vmware.ps1') -MemoryGB 16 -Cpu 8 -DiskGB 128 -Resume -AdminSudo -IPTimeoutSeconds 25 -VmrunPath 'synthetic vmrun.exe' -VdiskmanagerPath 'synthetic diskmanager.exe'
        $arguments = $global:dantCoveragePythonArguments
        foreach ($flag in @('--resume', '--admin-sudo', '--vmrun-path', '--vdiskmanager-path')) { $arguments | Should -Contain $flag }
        $arguments[$arguments.IndexOf('--memory-gb') + 1] | Should -Be '16'
        $arguments[$arguments.IndexOf('--ip-timeout-seconds') + 1] | Should -Be '25'
        $arguments[$arguments.IndexOf('--vmrun-path') + 1] | Should -Be 'synthetic vmrun.exe'
    }

    It 'preserves failure outcomes and rejects invalid resource requests before Python starts' {
        $global:dantCoveragePythonExit = 9
        { & (Join-Path $repositoryRoot 'scripts/create-vmware.ps1') } | Should -Throw '*creation failed*'
        $global:dantCoveragePythonArguments = @()
        { & (Join-Path $repositoryRoot 'scripts/create-vmware.ps1') -MemoryGB 1 } | Should -Throw
        $global:dantCoveragePythonArguments.Count | Should -Be 0
    }

    It 'forwards preparation options and reports setup failure without rewriting permission' {
        & (Join-Path $repositoryRoot 'scripts/prepare-vmware.ps1') -DataDirectory (Join-Path $TestDrive 'new data') -AdminSudo -VmrunPath 'synthetic vmrun.exe' -VdiskmanagerPath 'synthetic diskmanager.exe'
        $arguments = $global:dantCoveragePythonArguments
        $arguments[1] | Should -Be 'prepare'
        foreach ($flag in @('--admin-sudo', '--vmrun-path', '--vdiskmanager-path')) { $arguments | Should -Contain $flag }
        & (Join-Path $repositoryRoot 'scripts/prepare-vmware.ps1')
        $global:dantCoveragePythonArguments | Should -Not -Contain '--admin-sudo'
        $global:dantCoveragePythonExit = 7
        { & (Join-Path $repositoryRoot 'scripts/prepare-vmware.ps1') } | Should -Throw '*preparation failed*'
    }
}

AfterAll {
    Remove-Variable -Scope Global -Name dantCoveragePythonArguments, dantCoveragePythonExit -ErrorAction SilentlyContinue
}
