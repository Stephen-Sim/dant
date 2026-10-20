BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $helper = Join-Path $repositoryRoot 'scripts/vm-lifecycle.ps1'
    function Invoke-LifecycleFixture {
        param(
            [string]$Action = 'suspend',
            [string]$State = 'Running',
            [switch]$ForeignDisk,
            [switch]$Expired,
            [switch]$ChangeBinding,
            [switch]$ExpectedIdentity,
            [switch]$NoAdministrator,
            [switch]$ElevatedOutput,
            [string]$Failure,
            [string]$Metadata
        )
        $directory = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory((Join-Path $directory 'vm'))
        $disk = Join-Path $directory 'vm/dant.vhdx'
        [IO.File]::WriteAllText($disk, 'synthetic disk, never a virtual disk')
        $key = Join-Path $directory 'vm-key'
        [IO.File]::WriteAllText($key, 'synthetic key, never an SSH private key')
        $status = @{stage = 'ready'; name = 'fixture'}
        if ($Metadata -eq 'setup-stage') { $status.stage = 'failed' }
        if ($Metadata -eq 'setup-name') { $status.name = '../unowned' }
        [IO.File]::WriteAllText((Join-Path $directory 'vm-setup-status.json'), ($status | ConvertTo-Json -Compress))
        $binding = @{host = '192.0.2.44'; user = 'fixture'; keyPath = $key} | ConvertTo-Json -Compress
        $bindingPath = Join-Path $directory 'vm.json'
        [IO.File]::WriteAllText($bindingPath, $binding)
        $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($binding))).ToLowerInvariant()
        $operation = [guid]::NewGuid().ToString()
        $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $(if ($Expired) { -1 } else { 85000 })
        $intent = @{version = 1; phase = $(if ($Action -eq 'suspend') {'suspending'} else {'resuming'}); provider = 'hyperv'; binding = $digest; vmId = $null; operationId = $operation; expiresAt = $deadline}
        $vmIdentity = '11111111-1111-4111-8111-111111111111'
        if ($ExpectedIdentity) { $intent.vmId = $vmIdentity }
        if ($Metadata -eq 'intent-version') { $intent.version = 2 }
        if ($Metadata -eq 'intent-provider') { $intent.provider = 'vmware' }
        if ($Metadata -eq 'intent-identity') { $intent.vmId = '22222222-2222-4222-8222-222222222222' }
        if ($Metadata -eq 'intent-deadline') { $intent.expiresAt = 'not-a-timestamp' }
        if ($Metadata -eq 'oversized') { [IO.File]::WriteAllText($bindingPath, (' ' * 65537)) }
        [IO.File]::WriteAllText((Join-Path $directory 'vm-lifecycle.json'), ($intent | ConvertTo-Json -Compress))
        $global:dantCoverageFixtureVmState = $State
        $global:dantCoverageFixtureSaves = 0
        $global:dantCoverageFixtureStarts = 0
        $global:dantCoverageFixtureQueries = 0
        $global:dantCoverageFixtureAdministrator = !$NoAdministrator
        $global:dantCoverageFixtureElevations = 0
        $global:dantCoverageFixtureElevationArguments = @()
        function New-Object {
            param([string]$TypeName, [Parameter(ValueFromRemainingArguments = $true)][object[]]$ArgumentList)
            if ($TypeName -eq 'Security.Principal.WindowsPrincipal') {
                $value = [pscustomobject]@{}
                $value | Add-Member -MemberType ScriptMethod -Name IsInRole -Value {param($role) return $global:dantCoverageFixtureAdministrator}
                return $value
            }
            Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
        }
        function Import-Module { param($Name) if ($Name -ne 'Hyper-V') { throw 'Unexpected fixture import' } }
        function Get-VM {
            param($Name, $Id)
            $global:dantCoverageFixtureQueries++
            if ($ChangeBinding -and $global:dantCoverageFixtureQueries -gt 1) { [IO.File]::WriteAllText($bindingPath, '{}') }
            $identity = if ($Failure -eq 'wrong-identity' -or ($Failure -eq 'post-identity' -and $global:dantCoverageFixtureQueries -gt 2)) { '22222222-2222-4222-8222-222222222222' } else { $vmIdentity }
            $observedState = if ($Failure -eq 'post-state' -and $global:dantCoverageFixtureQueries -gt 2) { 'Pausing' } elseif ($Failure -eq 'network-state' -and $global:dantCoverageFixtureQueries -gt 3) { 'Saved' } else { $global:dantCoverageFixtureVmState }
            if ($Failure -eq 'ambiguous') { return @([pscustomobject]@{Id = [guid]$identity; State = $observedState}, [pscustomobject]@{Id = [guid]$identity; State = $observedState}) }
            return [pscustomobject]@{Id = [guid]$identity; State = $observedState}
        }
        function Get-VMHardDiskDrive { param($VM) return [pscustomobject]@{Path = $(if ($ForeignDisk -or $Failure -eq 'child-disk') { Join-Path $directory 'foreign.vhdx' } else { $disk })} }
        function Get-VHD { param($Path) if ($Failure -eq 'child-disk') { return [pscustomobject]@{ParentPath = $disk} }; throw 'Foreign ancestry stops inside the fixture' }
        function Get-VMNetworkAdapter {
            param($VM)
            $addresses = if ($Failure -eq 'address-overflow') { @(1..17 | ForEach-Object { "192.0.2.$_" }) } else { @('192.0.2.44', '127.0.0.1', '169.254.3.2', '0.0.0.0', '224.0.0.1', '192.0.2.44', '2001:db8::1', '999.1.2.3', 123, '192.000.2.1') }
            return [pscustomobject]@{IPAddresses = $addresses}
        }
        function Save-VM { param($VM) $global:dantCoverageFixtureSaves++; $global:dantCoverageFixtureVmState = 'Saved' }
        function Start-VM { param($VM) $global:dantCoverageFixtureStarts++; $global:dantCoverageFixtureVmState = 'Running' }
        function Start-Process {
            param($FilePath, $ArgumentList, $Verb, $WindowStyle, [switch]$PassThru)
            if ($Verb -ne 'RunAs' -or $WindowStyle -ne 'Hidden' -or !$PassThru) { throw 'Unexpected synthetic elevation contract' }
            $global:dantCoverageFixtureElevations++
            $global:dantCoverageFixtureElevationArguments = $ArgumentList
            $index = [Array]::IndexOf($ArgumentList, '-ElevatedResult')
            $childResult = [string]$ArgumentList[$index + 1]
            [IO.File]::WriteAllText($childResult.Trim('"'), '{"ok":true,"provider":"hyperv","state":"suspended","changed":true}')
            $process = [pscustomobject]@{FixtureTimeout = ($Failure -eq 'elevation-timeout')}
            $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
                param($milliseconds)
                if ($milliseconds -ne 75000) { throw 'Unexpected fixture elevation budget' }
                return !$this.FixtureTimeout
            }
            return $process
        }
        $arguments = @{Action = $Action; DataDirectory = $directory; ExpectedBinding = $digest; ExpectedOperation = $operation; ExpectedDeadline = $deadline}
        if ($ExpectedIdentity) { $arguments.ExpectedVmId = $vmIdentity }
        if ($ElevatedOutput) {
            $resultPath = Join-Path $directory ('.vm-lifecycle-result-' + [guid]::NewGuid().ToString() + '.json')
            [IO.File]::WriteAllText($resultPath, '{}')
            $arguments.ElevatedResult = $resultPath
        }
        if ($Metadata -eq 'result-path') { $arguments.ElevatedResult = Join-Path $directory 'unowned-result.json' }
        $reply = & $helper @arguments
        if ($ElevatedOutput) { $reply = [IO.File]::ReadAllText($resultPath) }
        return @{
            reply = ($reply | ConvertFrom-Json)
            saves = $global:dantCoverageFixtureSaves
            starts = $global:dantCoverageFixtureStarts
            queries = $global:dantCoverageFixtureQueries
            elevations = $global:dantCoverageFixtureElevations
            arguments = $global:dantCoverageFixtureElevationArguments
            leftoverResults = @(Get-ChildItem -LiteralPath $directory -Filter '.vm-lifecycle-result-*.json').Count
        }
    }
}

Describe 'Managed VM lifecycle with synthetic Hyper-V commands' {
    It 'suspends an owned VM once and confirms its final state' {
        $result = Invoke-LifecycleFixture
        $result.reply.ok | Should -BeTrue
        $result.reply.state | Should -Be 'suspended'
        $result.saves | Should -Be 1
        $result.starts | Should -Be 0
    }

    It 'resumes a saved VM once and returns only bounded canonical IPv4 addresses' {
        $result = Invoke-LifecycleFixture -Action resume -State Saved
        $result.reply.ok | Should -BeTrue
        $result.reply.state | Should -Be 'running'
        $result.starts | Should -Be 1
        @($result.reply.addresses).Count | Should -Be 1
        $result.reply.addresses[0] | Should -Be '192.0.2.44'
    }

    It 'does not replay already satisfied lifecycle changes' {
        $result = Invoke-LifecycleFixture -Action resume -State Running
        $result.reply.ok | Should -BeTrue
        $result.starts | Should -Be 0
        (Invoke-LifecycleFixture -State Saved).saves | Should -Be 0
        (Invoke-LifecycleFixture -Action resume -State Off).starts | Should -Be 0
    }

    It 'rejects expired ownership, foreign disks, changed bindings and unconfirmed states' {
        foreach ($options in @(@{Expired = $true}, @{ForeignDisk = $true}, @{ChangeBinding = $true}, @{State = 'Pausing'})) {
            $result = Invoke-LifecycleFixture @options
            $result.reply.ok | Should -BeFalse
            $result.reply.reason | Should -Be 'unconfirmed'
            $result.saves | Should -Be 0
            $result.starts | Should -Be 0
        }
    }

    It 'uses exact captured VM identity and validates owned differencing ancestry' {
        $result = Invoke-LifecycleFixture -ExpectedIdentity -Failure child-disk
        $result.reply.ok | Should -BeTrue
        $result.saves | Should -Be 1
        $result.reply.vmId | Should -Be '11111111-1111-4111-8111-111111111111'
        foreach ($failure in @('wrong-identity', 'ambiguous')) {
            $result = Invoke-LifecycleFixture -ExpectedIdentity -Failure $failure
            $result.reply.ok | Should -BeFalse
            $result.saves | Should -Be 0
        }
    }

    It 'preserves unconfirmed results after a mutation or network discovery race without replay' {
        foreach ($failure in @('post-identity', 'post-state')) {
            $result = Invoke-LifecycleFixture -ExpectedIdentity -Failure $failure
            $result.reply.ok | Should -BeFalse
            $result.saves | Should -Be 1
            $result.starts | Should -Be 0
        }
        foreach ($failure in @('address-overflow', 'network-state')) {
            $result = Invoke-LifecycleFixture -Action resume -State Running -Failure $failure
            $result.reply.ok | Should -BeFalse
            $result.starts | Should -Be 0
            $result.reply.PSObject.Properties.Name | Should -Not -Contain 'addresses'
        }
    }

    It 'performs one mocked elevation with the original ownership parameters and removes only its result' {
        $result = Invoke-LifecycleFixture -ExpectedIdentity -NoAdministrator
        $result.reply.ok | Should -BeTrue
        $result.elevations | Should -Be 1
        $result.queries | Should -Be 0
        $result.saves | Should -Be 0
        $result.arguments | Should -Contain '-ExpectedVmId'
        $result.arguments | Should -Contain '11111111-1111-4111-8111-111111111111'
        $result.leftoverResults | Should -Be 0
        $timeout = Invoke-LifecycleFixture -NoAdministrator -Failure elevation-timeout
        $timeout.reply.ok | Should -BeFalse
        $timeout.elevations | Should -Be 1
        $timeout.leftoverResults | Should -Be 0
    }

    It 'writes only the owned elevated result and never recursively elevates an unprivileged child' {
        $result = Invoke-LifecycleFixture -ExpectedIdentity -ElevatedOutput
        $result.reply.ok | Should -BeTrue
        $result.leftoverResults | Should -Be 1
        $result = Invoke-LifecycleFixture -NoAdministrator -ElevatedOutput
        $result.reply.ok | Should -BeFalse
        $result.elevations | Should -Be 0
        { Invoke-LifecycleFixture -Metadata result-path } | Should -Throw 'Invalid VM result path'
    }

    It 'rejects malformed setup receipts intents and oversized bindings before VM admission' {
        foreach ($metadata in @('setup-stage', 'setup-name', 'intent-version', 'intent-provider', 'intent-identity', 'intent-deadline', 'oversized')) {
            $result = Invoke-LifecycleFixture -Metadata $metadata
            $result.reply.ok | Should -BeFalse
            $result.queries | Should -Be 0
            $result.saves | Should -Be 0
            $result.starts | Should -Be 0
            $result.elevations | Should -Be 0
        }
    }
}
