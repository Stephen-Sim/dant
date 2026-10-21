BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $creatorModule = Join-Path $repositoryRoot 'scripts/computer/hyperv-create.ps1'
    . $creatorModule

    function Invoke-CreationFixture {
        param(
            [string]$ExistingState,
            [switch]$Resume,
            [switch]$DefaultData,
            [string]$Failure,
            [long]$Capacity = 32GB,
            [int]$SourceCount = 1,
            [int]$MemoryGB = 8,
            [int]$Cpu = 4,
            [int]$DiskGB = 64,
            [switch]$DifferencingDisk,
            [switch]$FallbackSwitch,
            [switch]$SparseSource
        )
        $directory = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $data = Join-Path $directory 'data'
        $cache = if ($DefaultData) { Join-Path $directory '.cache/vm' } else { Join-Path $data 'cache/vm' }
        $disks = Join-Path $data 'vm'
        [void][IO.Directory]::CreateDirectory($cache)
        [void][IO.Directory]::CreateDirectory($disks)
        $source = Join-Path $disks 'livecd.ubuntu-cpc.azure.vhd'
        $disk = Join-Path $disks 'dant.vhdx'
        if ($Failure -ne 'missing-seed') { [IO.File]::WriteAllText((Join-Path $cache 'seed.iso'), 'synthetic ISO bytes') }
        if ($Failure -ne 'missing-archive') { [IO.File]::WriteAllText((Join-Path $cache 'ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz'), 'synthetic archive bytes') }
        for ($index = 0; $index -lt $SourceCount; $index++) {
            $file = if (!$index -and $Failure -ne 'unexpected-source') { $source } else { Join-Path $disks "foreign-$index.vhd" }
            [IO.File]::WriteAllText($file, 'synthetic VHD bytes; never a virtual disk')
        }
        if ($Failure -eq 'existing-disk') { [IO.File]::WriteAllText($disk, 'preserved synthetic destination') }
        $fixture = @{
            directory = $directory; source = $source; disk = $disk; data = $data; now = [datetime]'2026-01-02T03:04:05Z'
            calls = [Collections.Generic.List[object]]::new(); starts = 0; converts = 0; resizes = @(); creates = @()
            patches = @(); transcriptions = 0; transcriptStops = 0; networkReads = 0; error = $null
            allocations = 0; clearedSparse = $false
        }
        function Assert-CreationFixturePath([string]$Path) {
            $resolved = [IO.Path]::GetFullPath($Path)
            if (!$resolved.StartsWith($fixture.directory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'fixture path escaped TestDrive'
            }
        }
        function Import-Module { param($Name) if ($Name -ne 'Hyper-V') { throw 'fixture import denied' } }
        function Start-Transcript { param($Path) Assert-CreationFixturePath $Path; $fixture.transcriptions++ }
        function Stop-Transcript { $fixture.transcriptStops++ }
        function Write-Host {}
        function Get-Date {
            param([string]$Format)
            if ($Format) { return $fixture.now.ToString($Format) }
            return $fixture.now
        }
        function Start-Sleep {
            param([int]$Seconds)
            $fixture.now = $fixture.now.AddSeconds($(if ($Failure -eq 'missing-ip') { 600 } else { $Seconds }))
        }
        function Get-VM {
            param([string]$Name)
            if ($Name) {
                if ($ExistingState) { return [pscustomobject]@{Name = 'fixture'; State = $ExistingState} }
                return
            }
            if ($Failure -eq 'registered-source') { return [pscustomobject]@{Name = 'registered-fixture'} }
        }
        function Get-VMHardDiskDrive {
            param([Parameter(ValueFromPipeline = $true)]$VM, [string]$VMName)
            process {
                if ($VMName) {
                    return [pscustomobject]@{Path = $(if ($Failure -eq 'foreign-disk') { Join-Path $disks 'foreign.vhdx' } elseif ($DifferencingDisk) { Join-Path $disks 'child.avhdx' } else { $disk })}
                }
                if ($VM) { return [pscustomobject]@{Path = $fixture.source} }
            }
        }
        function Get-VHD {
            param([string]$Path)
            Assert-CreationFixturePath $Path
            if ($Path -eq $fixture.source) { return [pscustomobject]@{Attached = ($Failure -eq 'attached-source')} }
            if ($Path -eq $fixture.disk) { return [pscustomobject]@{Size = $Capacity} }
            return [pscustomobject]@{ParentPath = $(if ($DifferencingDisk) { $disk } else { $null })}
        }
        function Get-VMSwitch {
            param([string]$Name)
            if ($Failure -eq 'missing-switch') { return }
            if ($FallbackSwitch -and !$Name) { return [pscustomobject]@{Id = 'foreign'; Name = 'foreign'} }
            return [pscustomobject]@{Id = 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444'; Name = 'fixture-switch'}
        }
        function Get-Volume {
            param([string]$FilePath)
            Assert-CreationFixturePath $FilePath
            if ($Failure -eq 'missing-volume') { return }
            return [pscustomobject]@{FileSystemType = $(if ($Failure -eq 'unsupported-volume') { 'FAT32' } else { 'NTFS' }); SizeRemaining = $(if ($Failure -eq 'space' -or ($Failure -eq 'sparse-space-after' -and $fixture.allocations)) { 0 } else { 20GB })}
        }
        function Get-DantHyperVAttributes {
            param([string]$Path)
            Assert-CreationFixturePath $Path
            if ($Path -eq $fixture.source) {
                if ($Failure -eq 'compressed-source') { return [IO.FileAttributes]::Compressed }
                if ($Failure -eq 'reparse-source') { return [IO.FileAttributes]::ReparsePoint }
                if ($SparseSource -and (!$fixture.clearedSparse -or $Failure -eq 'sparse-attributes')) { return [IO.FileAttributes]::SparseFile }
            }
            if ($Path -eq $disks -and $Failure -eq 'encrypted-directory') { return [IO.FileAttributes]::Encrypted }
            return [IO.File]::GetAttributes($Path)
        }
        function Convert-VHD {
            param($Path, $DestinationPath, $VHDType)
            Assert-CreationFixturePath $Path
            Assert-CreationFixturePath $DestinationPath
            $fixture.converts++
            if ($Failure -eq 'convert') { throw 'synthetic conversion failure' }
            if ($VHDType -ne 'Dynamic') { throw 'fixture only accepts dynamic conversion' }
            [IO.File]::WriteAllText($DestinationPath, 'synthetic converted disk bytes')
        }
        function Resize-VHD {
            param($Path, $SizeBytes)
            Assert-CreationFixturePath $Path
            $fixture.resizes += $SizeBytes
        }
        function New-VM {
            param($Name, $Generation, $MemoryStartupBytes, $VHDPath, $SwitchName, $Path)
            Assert-CreationFixturePath $Path
            Assert-CreationFixturePath $VHDPath
            $fixture.creates += ,@{generation = $Generation; memory = $MemoryStartupBytes; disk = $VHDPath; switch = $SwitchName}
        }
        function Set-VMProcessor { param($VMName, $Count) $fixture.calls.Add(@{command = 'cpu'; count = $Count}) }
        function Set-VM { param($Name, $AutomaticStartAction, $AutomaticStopAction, $AutomaticCheckpointsEnabled) $fixture.calls.Add(@{command = 'policy'; start = $AutomaticStartAction; stop = $AutomaticStopAction; checkpoints = $AutomaticCheckpointsEnabled}) }
        function Set-VMDvdDrive { param($VMName, $Path) Assert-CreationFixturePath $Path; $fixture.calls.Add(@{command = 'dvd'; path = $Path}) }
        function Start-VM { param($Name) $fixture.starts++; if ($Failure -eq 'start') { throw 'synthetic start failure' } }
        function Get-VMNetworkAdapter {
            param($VMName)
            $fixture.networkReads++
            return [pscustomobject]@{IPAddresses = $(if ($Failure -eq 'missing-ip') { @('127.0.0.1', '169.254.1.2', '0.2.3.4', '2001:db8::1') } else { @('127.0.0.1', '169.254.1.2', '192.0.2.44') })}
        }
        function tar.exe {
            $fixture.calls.Add(@{command = 'tar'; arguments = @($args)})
            $global:LASTEXITCODE = $(if ($Failure -eq 'extract') { 9 } else { 0 })
            if (!$global:LASTEXITCODE -and $Failure -ne 'empty-archive') { [IO.File]::WriteAllText($fixture.source, 'synthetic extracted disk bytes') }
        }
        function python {
            $fixture.patches += ,@($args)
            $global:LASTEXITCODE = $(if ($Failure -eq 'patch' -or ($Failure -eq 'sparse-validation' -and $fixture.patches.Count -gt 1)) { 8 } else { 0 })
        }
        function fsutil.exe {
            if (!$SparseSource -or (@($args) -join '|') -ne "sparse|setflag|$($fixture.source)|0") { throw 'sparse allocation is not authorized by this fixture' }
            $fixture.allocations++
            $global:LASTEXITCODE = $(if ($Failure -eq 'sparse-command') { 7 } else { 0 })
            $fixture.clearedSparse = !$global:LASTEXITCODE
            if ($Failure -eq 'sparse-length') { [IO.File]::WriteAllText($fixture.source, 'changed synthetic disk length') }
        }
        function Start-Process { throw 'process launch is not authorized by this fixture' }
        function Invoke-WebRequest { throw 'network download is not authorized by this fixture' }
        function ssh { throw 'SSH is not authorized by this fixture' }

        $parameters = @{ProjectRoot = $directory; ScriptsRoot = (Join-Path $repositoryRoot 'scripts'); MemoryGB = $MemoryGB; Cpu = $Cpu; DiskGB = $DiskGB; Resume = $Resume}
        if (!$DefaultData) { $parameters.DataDirectory = $data }
        try { Invoke-DantHyperVCreate @parameters | Out-Null } catch { $fixture.error = $_.Exception.Message }
        $status = Join-Path $data 'vm-setup-status.json'
        $binding = Join-Path $data 'vm.json'
        $fixture.status = if ([IO.File]::Exists($status)) { [IO.File]::ReadAllText($status) | ConvertFrom-Json } else { $null }
        $fixture.binding = if ([IO.File]::Exists($binding)) { [IO.File]::ReadAllText($binding) | ConvertFrom-Json } else { $null }
        $fixture.preservedSource = [IO.File]::Exists($source)
        $fixture.sourceCount = @(Get-ChildItem -LiteralPath $disks -Filter '*.vhd' -File).Count
        $fixture.preservedDisk = [IO.File]::Exists($disk)
        return $fixture
    }
}

Describe 'Hyper-V creation with only synthetic disks and denied external boundaries' {
    BeforeEach { $savedExitCode = $global:LASTEXITCODE }
    AfterEach { $global:LASTEXITCODE = $savedExitCode }

    It 'retains the administrator-only small entrypoint and default public parameter contract' {
        $entry = [IO.File]::ReadAllText((Join-Path $repositoryRoot 'scripts/create-vm.ps1'))
        $entry | Should -Match '^#Requires -RunAsAdministrator\r?\n'
        $entry | Should -Match 'computer/hyperv-create.ps1'
        $entry | Should -Match 'Invoke-DantHyperVCreate .*@PSBoundParameters'
        $command = Get-Command Invoke-DantHyperVCreate
        foreach ($name in @('Name', 'MemoryGB', 'Cpu', 'DiskGB', 'Resume', 'DataDirectory')) { $command.Parameters.ContainsKey($name) | Should -BeTrue }
        $result = Invoke-CreationFixture
        $result.error | Should -BeNullOrEmpty
        $result.creates[0].memory | Should -Be 8GB
        $result.resizes[0] | Should -Be 64GB
    }

    It 'reads default file attributes without suppressing original filesystem errors' {
        $file = Join-Path $TestDrive 'ordinary-attributes.txt'
        [IO.File]::WriteAllText($file, 'synthetic ordinary bytes')
        (Get-DantHyperVAttributes $file) | Should -Be ([IO.File]::GetAttributes($file))
        { Get-DantHyperVAttributes (Join-Path $TestDrive 'missing-attributes.txt') } | Should -Throw
    }

    It 'creates exactly one generation-one VM with explicit resources and a successful bounded binding' {
        $result = Invoke-CreationFixture -MemoryGB 16 -Cpu 12 -DiskGB 128 -FallbackSwitch -DefaultData
        $result.error | Should -BeNullOrEmpty
        $result.converts | Should -Be 1
        $result.resizes | Should -Be @(128GB)
        $result.creates.Count | Should -Be 1
        $result.creates[0].generation | Should -Be 1
        $result.creates[0].memory | Should -Be 16GB
        $result.starts | Should -Be 1
        $result.calls.Where({$_.command -eq 'cpu'})[0].count | Should -Be 12
        $result.calls.Where({$_.command -eq 'policy'})[0].checkpoints | Should -BeFalse
        $result.patches.Count | Should -Be 1
        $result.patches[0] | Should -Contain '--apply'
        $result.status.stage | Should -Be 'guest-installing'
        $result.binding.host | Should -Be '192.0.2.44'
        $result.binding.port | Should -Be 22
        $result.binding.keyPath | Should -Be (Join-Path $result.data 'vm-key')
        $result.transcriptions | Should -Be 1
        $result.transcriptStops | Should -Be 1
    }

    It 'preserves equal and larger destination capacities instead of shrinking or replaying resize' {
        foreach ($capacity in @(64GB, 128GB)) {
            $result = Invoke-CreationFixture -Capacity $capacity
            $result.error | Should -BeNullOrEmpty
            $result.resizes.Count | Should -Be 0
            $result.creates.Count | Should -Be 1
        }
    }

    It 'resumes only the verified existing disk or its child and never converts or changes resources' {
        foreach ($state in @('Off', 'Saved', 'Running')) {
            $result = Invoke-CreationFixture -ExistingState $state -Resume -DifferencingDisk
            $result.error | Should -BeNullOrEmpty
            $result.starts | Should -Be $(if ($state -eq 'Running') { 0 } else { 1 })
            $result.converts | Should -Be 0
            $result.creates.Count | Should -Be 0
            $result.resizes.Count | Should -Be 0
            $result.patches.Count | Should -Be 0
            $result.binding.host | Should -Be '192.0.2.44'
        }
    }

    It 'preserves existing or foreign VM ownership and unresolved states without starting anything' {
        foreach ($parameters in @(@{ExistingState = 'Running'}, @{Resume = $true}, @{ExistingState = 'Running'; Resume = $true; Failure = 'foreign-disk'}, @{ExistingState = 'Pausing'; Resume = $true})) {
            $result = Invoke-CreationFixture @parameters
            $result.error | Should -Not -BeNullOrEmpty
            $result.starts | Should -Be 0
            $result.converts | Should -Be 0
            $result.creates.Count | Should -Be 0
            $result.binding | Should -BeNullOrEmpty
            $result.status.stage | Should -Be 'failed:checking-hyper-v'
            $result.transcriptStops | Should -Be 1
        }
    }

    It 'rejects missing preparation, multiple or unexpected source disks and unsafe host volume before conversion' {
        foreach ($failure in @('existing-disk', 'missing-seed', 'missing-switch', 'unexpected-source', 'attached-source', 'registered-source', 'missing-volume', 'unsupported-volume', 'space', 'patch')) {
            $result = Invoke-CreationFixture -Failure $failure
            $result.error | Should -Not -BeNullOrEmpty
            $result.starts | Should -Be 0
            $result.converts | Should -Be 0
            $result.creates.Count | Should -Be 0
            $result.binding | Should -BeNullOrEmpty
            $result.sourceCount | Should -Be 1
            $result.status.stage | Should -Match '^failed:'
            $result.transcriptStops | Should -Be 1
        }
        $multiple = Invoke-CreationFixture -SourceCount 2
        $multiple.error | Should -Match 'Multiple source VHD'
        $multiple.converts | Should -Be 0
    }

    It 'extracts the official image once and preserves all files when extraction is missing or unsuccessful' {
        $result = Invoke-CreationFixture -SourceCount 0
        $result.error | Should -BeNullOrEmpty
        $result.calls.Where({$_.command -eq 'tar'}).Count | Should -Be 1
        foreach ($failure in @('missing-archive', 'extract', 'empty-archive')) {
            $result = Invoke-CreationFixture -SourceCount 0 -Failure $failure
            $result.error | Should -Not -BeNullOrEmpty
            $result.converts | Should -Be 0
            $result.starts | Should -Be 0
            $result.status.stage | Should -Be 'failed:extracting-image'
            $result.transcriptStops | Should -Be 1
        }
    }

    It 'retains failure stage, original disk and transcript completion without retrying unknown actions' {
        foreach ($failure in @('convert', 'start', 'missing-ip')) {
            $result = Invoke-CreationFixture -Failure $failure
            $result.error | Should -Not -BeNullOrEmpty
            $result.preservedSource | Should -BeTrue
            $result.converts | Should -Be 1
            $result.starts | Should -Be $(if ($failure -eq 'convert') { 0 } else { 1 })
            $result.binding | Should -BeNullOrEmpty
            $result.status.stage | Should -Be $(switch ($failure) {'convert' {'failed:converting-disk'} 'start' {'failed:booting-vm'} 'missing-ip' {'failed:waiting-for-ip'}})
            $result.transcriptStops | Should -Be 1
        }
    }

    It 'refuses compressed encrypted or reparse metadata before patching any synthetic source' {
        foreach ($failure in @('compressed-source', 'encrypted-directory', 'reparse-source')) {
            $result = Invoke-CreationFixture -Failure $failure
            $result.error | Should -Match 'compressed/encrypted|reparse point'
            $result.patches.Count | Should -Be 0
            $result.converts | Should -Be 0
            $result.starts | Should -Be 0
            $result.preservedSource | Should -BeTrue
            $result.status.stage | Should -Be 'failed:checking-hyper-v'
            $result.transcriptStops | Should -Be 1
        }
    }

    It 'allocates a sparse source only once and validates its unchanged bytes before conversion' {
        $result = Invoke-CreationFixture -SparseSource
        $result.error | Should -BeNullOrEmpty
        $result.allocations | Should -Be 1
        $result.patches.Count | Should -Be 2
        $result.patches[0] | Should -Contain '--apply'
        $result.patches[1] | Should -Not -Contain '--apply'
        $result.converts | Should -Be 1
        $result.starts | Should -Be 1
        $result.status.stage | Should -Be 'guest-installing'
        $result.transcriptStops | Should -Be 1
    }

    It 'preserves the source and never converts after uncertain allocation metadata length validation or space' {
        foreach ($failure in @('sparse-command', 'sparse-attributes', 'sparse-length', 'sparse-validation', 'sparse-space-after')) {
            $result = Invoke-CreationFixture -SparseSource -Failure $failure
            $result.error | Should -Not -BeNullOrEmpty
            $result.allocations | Should -Be 1
            $result.converts | Should -Be 0
            $result.starts | Should -Be 0
            $result.binding | Should -BeNullOrEmpty
            $result.preservedSource | Should -BeTrue
            $result.status.stage | Should -Be 'failed:allocating-source-disk'
            $result.transcriptStops | Should -Be 1
        }
    }
}
