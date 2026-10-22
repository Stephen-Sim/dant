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
            [switch]$NoReceipt,
            [string]$Failure,
            [string]$Metadata,
            [switch]$AutomaticCheckpoints
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
        $receiptPath = Join-Path $directory 'vm-lifecycle.json'
        $originalReceipt = $intent | ConvertTo-Json -Compress
        if (!$NoReceipt) { [IO.File]::WriteAllText($receiptPath, $originalReceipt) }
        $global:dantCoverageFixtureVmState = $State
        $global:dantCoverageFixtureSaves = 0
        $global:dantCoverageFixtureStarts = 0
        $global:dantCoverageFixtureQueries = 0
        $global:dantCoverageFixtureAdministrator = !$NoAdministrator
        $global:dantCoverageFixtureElevations = 0
        $global:dantCoverageFixtureElevationArguments = @()
        $global:dantCoverageFixtureCheckpoints = [bool]$AutomaticCheckpoints
        $global:dantCoverageFixtureCheckpointChanges = 0
        $global:dantCoverageFixtureEvents = [Collections.Generic.List[string]]::new()
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
            if ($Failure -eq 'permission') { throw 'Synthetic management permission refusal' }
            if ($ChangeBinding -and $global:dantCoverageFixtureQueries -gt 1) { [IO.File]::WriteAllText($bindingPath, '{}') }
            $identity = if ($Failure -eq 'wrong-identity' -or ($Failure -eq 'post-identity' -and $global:dantCoverageFixtureQueries -gt 2) -or ($Failure -eq 'checkpoint-identity' -and $global:dantCoverageFixtureCheckpointChanges)) { '22222222-2222-4222-8222-222222222222' } else { $vmIdentity }
            $observedState = if ($Failure -eq 'post-state' -and $global:dantCoverageFixtureQueries -gt 2) { 'Pausing' } elseif ($Failure -eq 'network-state' -and $global:dantCoverageFixtureQueries -gt 3) { 'Saved' } else { $global:dantCoverageFixtureVmState }
            if ($Failure -eq 'ambiguous') { return @([pscustomobject]@{Id = [guid]$identity; State = $observedState}, [pscustomobject]@{Id = [guid]$identity; State = $observedState}) }
            $policy = if ($Failure -eq 'checkpoint-type') { 'unknown' } else { $global:dantCoverageFixtureCheckpoints }
            return [pscustomobject]@{Id = [guid]$identity; State = $observedState; AutomaticCheckpointsEnabled = $policy}
        }
        function Get-VMHardDiskDrive { param($VM) return [pscustomobject]@{Path = $(if ($ForeignDisk -or $Failure -eq 'child-disk' -or ($Failure -eq 'checkpoint-disk' -and $global:dantCoverageFixtureCheckpointChanges)) { Join-Path $directory 'foreign.vhdx' } else { $disk })} }
        function Get-VHD { param($Path) if ($Failure -eq 'child-disk') { return [pscustomobject]@{ParentPath = $disk} }; throw 'Foreign ancestry stops inside the fixture' }
        function Get-VMNetworkAdapter {
            param($VM)
            if ($Failure -eq 'network-checkpoints') { $global:dantCoverageFixtureCheckpoints = $true }
            $addresses = if ($Failure -eq 'address-overflow') { @(1..17 | ForEach-Object { "192.0.2.$_" }) } else { @('192.0.2.44', '127.0.0.1', '169.254.3.2', '0.0.0.0', '224.0.0.1', '192.0.2.44', '2001:db8::1', '999.1.2.3', 123, '192.000.2.1') }
            return [pscustomobject]@{IPAddresses = $addresses}
        }
        function Save-VM { param($VM) $global:dantCoverageFixtureSaves++; $global:dantCoverageFixtureVmState = 'Saved' }
        function Set-VM {
            param($VM, $AutomaticCheckpointsEnabled)
            if ($VM.Id.ToString() -ne $vmIdentity -or $AutomaticCheckpointsEnabled -ne $false) { throw 'Unexpected fixture checkpoint mutation' }
            $global:dantCoverageFixtureCheckpointChanges++
            $global:dantCoverageFixtureEvents.Add('checkpoints')
            if ($Failure -eq 'checkpoint-failed') { throw 'Synthetic checkpoint policy failure' }
            if ($Failure -ne 'checkpoint-unconfirmed') { $global:dantCoverageFixtureCheckpoints = $false }
            if ($Failure -eq 'checkpoint-state') { $global:dantCoverageFixtureVmState = 'Off' }
            if ($Failure -eq 'checkpoint-binding') { [IO.File]::WriteAllText($bindingPath, '{}') }
            if ($Failure -eq 'checkpoint-intent') { [IO.File]::WriteAllText($receiptPath, '{}') }
        }
        function Start-VM { param($VM) $global:dantCoverageFixtureEvents.Add('start'); $global:dantCoverageFixtureStarts++; $global:dantCoverageFixtureVmState = 'Running' }
        function Start-Process {
            param($FilePath, $ArgumentList, $Verb, $WindowStyle, [switch]$PassThru)
            if ($Verb -ne 'RunAs' -or $WindowStyle -ne 'Hidden' -or !$PassThru) { throw 'Unexpected synthetic elevation contract' }
            $global:dantCoverageFixtureElevations++
            if ($Failure -eq 'elevation-refused') { throw 'Synthetic administrator authorization refusal' }
            $global:dantCoverageFixtureElevationArguments = $ArgumentList
            $index = [Array]::IndexOf($ArgumentList, '-ElevatedResult')
            $childResult = [string]$ArgumentList[$index + 1]
            $childReply = if ($Action -eq 'inspect') {
                @{ok = $true; provider = 'hyperv'; vmId = $vmIdentity; state = $(if ($State -eq 'Saved') { 'suspended' } elseif ($State -eq 'Off') { 'off' } else { 'running' }); changed = $false} | ConvertTo-Json -Compress
            } else { '{"ok":true,"provider":"hyperv","state":"suspended","changed":true}' }
            [IO.File]::WriteAllText($childResult.Trim('"'), $childReply)
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
            checkpointChanges = $global:dantCoverageFixtureCheckpointChanges
            checkpoints = $global:dantCoverageFixtureCheckpoints
            events = @($global:dantCoverageFixtureEvents)
            leftoverResults = @(Get-ChildItem -LiteralPath $directory -Filter '.vm-lifecycle-result-*.json').Count
            receiptUnchanged = $(if ($NoReceipt) { !(Test-Path -LiteralPath $receiptPath) } else { [IO.File]::ReadAllText($receiptPath) -ceq $originalReceipt })
        }
    }
}

Describe 'Managed VM lifecycle with synthetic Hyper-V commands' {
    It 'inspects Running Saved and Off owners without a receipt or a power change' {
        foreach ($state in @('Running', 'Saved', 'Off')) {
            $result = Invoke-LifecycleFixture -Action inspect -State $state -NoReceipt
            $result.reply.ok | Should -BeTrue
            $result.reply.state | Should -Be $(if ($state -eq 'Saved') { 'suspended' } else { $state.ToLowerInvariant() })
            $result.reply.changed | Should -BeFalse
            $result.saves | Should -Be 0
            $result.starts | Should -Be 0
            $result.receiptUnchanged | Should -BeTrue
        }
    }

    It 'retains unknown power receipts while inspecting and rejects stale or unconfirmed ownership' {
        $result = Invoke-LifecycleFixture -Action inspect -State Saved
        $result.reply.ok | Should -BeTrue
        $result.receiptUnchanged | Should -BeTrue
        foreach ($options in @(@{Expired = $true}, @{ForeignDisk = $true}, @{ChangeBinding = $true}, @{State = 'Saving'}, @{Failure = 'permission'}, @{ExpectedIdentity = $true; Failure = 'wrong-identity'}, @{ExpectedIdentity = $true; Failure = 'post-identity'}, @{Failure = 'post-state'})) {
            $result = Invoke-LifecycleFixture -Action inspect @options
            $result.reply.ok | Should -BeFalse
            $result.saves | Should -Be 0
            $result.starts | Should -Be 0
            $result.receiptUnchanged | Should -BeTrue
        }
    }

    It 'uses bounded administrator inspection without granting permissions or writing power receipts' {
        $result = Invoke-LifecycleFixture -Action inspect -State Saved -NoAdministrator -NoReceipt -ExpectedIdentity
        $result.reply.ok | Should -BeTrue
        $result.reply.changed | Should -BeFalse
        $result.elevations | Should -Be 1
        $result.saves | Should -Be 0
        $result.starts | Should -Be 0
        $result.receiptUnchanged | Should -BeTrue
        $result.arguments | Should -Contain 'inspect'
        $result.leftoverResults | Should -Be 0
        foreach ($failure in @('elevation-refused', 'elevation-timeout')) {
            $result = Invoke-LifecycleFixture -Action inspect -NoAdministrator -NoReceipt -Failure $failure
            $result.reply.ok | Should -BeFalse
            $result.elevations | Should -Be 1
            $result.saves | Should -Be 0
            $result.starts | Should -Be 0
            $result.receiptUnchanged | Should -BeTrue
            $result.leftoverResults | Should -Be 0
        }
    }

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

    It 'repairs enabled automatic checkpoints only during owned resume and before starting' {
        foreach ($state in @('Saved', 'Running', 'Off')) {
            $result = Invoke-LifecycleFixture -Action resume -State $state -AutomaticCheckpoints
            $result.reply.ok | Should -BeTrue
            $result.checkpointChanges | Should -Be 1
            $result.checkpoints | Should -BeFalse
            $result.events[0] | Should -Be 'checkpoints'
            $result.starts | Should -Be $(if ($state -eq 'Saved') { 1 } else { 0 })
            $result.reply.changed | Should -Be ($state -eq 'Saved')
        }
        foreach ($action in @('inspect', 'suspend')) {
            $result = Invoke-LifecycleFixture -Action $action -AutomaticCheckpoints
            $result.reply.ok | Should -BeTrue
            $result.checkpointChanges | Should -Be 0
            $result.checkpoints | Should -BeTrue
        }
        $disabled = Invoke-LifecycleFixture -Action resume -State Saved
        $disabled.checkpointChanges | Should -Be 0
        $disabled.starts | Should -Be 1
    }

    It 'does not start after unconfirmed checkpoint policy or a changed VM, disk, binding or intent' {
        foreach ($failure in @('checkpoint-type', 'checkpoint-failed', 'checkpoint-unconfirmed', 'checkpoint-identity', 'checkpoint-disk', 'checkpoint-state', 'checkpoint-binding', 'checkpoint-intent')) {
            $result = Invoke-LifecycleFixture -Action resume -State Saved -AutomaticCheckpoints -Failure $failure
            $result.reply.ok | Should -BeFalse
            $result.saves | Should -Be 0
            $result.starts | Should -Be 0
            $result.checkpointChanges | Should -Be $(if ($failure -eq 'checkpoint-type') { 0 } else { 1 })
        }
        $foreign = Invoke-LifecycleFixture -Action resume -State Saved -AutomaticCheckpoints -ForeignDisk
        $foreign.reply.ok | Should -BeFalse
        $foreign.checkpointChanges | Should -Be 0
        $networkChange = Invoke-LifecycleFixture -Action resume -State Running -Failure network-checkpoints
        $networkChange.reply.ok | Should -BeFalse
        $networkChange.starts | Should -Be 0
        $networkChange.checkpointChanges | Should -Be 0
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
