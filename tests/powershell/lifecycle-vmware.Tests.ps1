BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $source = Join-Path $repositoryRoot 'scripts/vm-lifecycle.ps1'
    function Invoke-VmwareLifecycleFixture {
        param([string]$Action = 'suspend', [switch]$Running, [switch]$Saved,
            [string]$Failure = '', [switch]$ExpectedIdentity, [string]$Metadata = '')
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $base = Join-Path $data 'vmware'
        $program = Join-Path $data 'program/VMware/VMware Workstation'
        [void][IO.Directory]::CreateDirectory($base)
        [void][IO.Directory]::CreateDirectory($program)
        $vmId = '22222222-2222-4222-8222-222222222222'
        $vmx = Join-Path $base 'dant.vmx'
        $disk = Join-Path $base 'dant.vmdk'
        $key = Join-Path $base 'vm-key'
        foreach ($file in @($disk, $key, (Join-Path $program 'vmrun.exe'))) {
            [IO.File]::WriteAllText($file, 'synthetic ordinary file; never an executable or virtual disk')
        }
        $vmxText = 'annotation = "dant-vmware-v1:' + $vmId + '"'
        if ($Metadata -eq 'annotation') { $vmxText = 'annotation = "foreign"' }
        if ($Metadata -eq 'saved-path') { $vmxText += "`ncheckpoint.vmState = `"../foreign.vmss`"" }
        [IO.File]::WriteAllText($vmx, $vmxText)
        if ($Saved) { [IO.File]::WriteAllText((Join-Path $base 'dant.vmss'), 'synthetic saved-state marker') }
        $manifest = @{owner = 'dant-vmware-v1'; version = 1; provider = 'vmware'; id = $vmId; vmx = $vmx; disk = $disk; phase = 'connected'}
        if ($Metadata -eq 'owner') { $manifest.owner = 'foreign' }
        [IO.File]::WriteAllText((Join-Path $base 'manifest.json'), ($manifest | ConvertTo-Json -Compress))
        $binding = @{provider = 'vmware'; vmwareId = $vmId; keyPath = $key}
        if ($Metadata -eq 'ssh') { $binding.provider = 'ssh' }
        if ($Metadata -eq 'provider') { $binding.provider = 'unknown' }
        if ($Metadata -eq 'key') { $binding.keyPath = 'relative-key' }
        $raw = $binding | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $data 'vm.json'), $raw)
        $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($raw))).ToLowerInvariant()
        $operation = [guid]::NewGuid().ToString()
        $deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 80000
        $intent = @{version = 1; phase = $(if ($Action -eq 'suspend') { 'suspending' } else { 'resuming' }); provider = 'vmware';
            binding = $digest; vmId = $(if ($ExpectedIdentity) { $vmId } else { $null }); operationId = $operation; expiresAt = $deadline}
        if ($Metadata -eq 'intent') { $intent.operationId = [guid]::NewGuid().ToString() }
        [IO.File]::WriteAllText((Join-Path $data 'vm-lifecycle.json'), ($intent | ConvertTo-Json -Compress))
        $global:dantVmwareLifecycle = @{running = [bool]$Running; calls = @(); disposed = 0; vmx = $vmx; failure = $Failure; saved = [bool]$Saved}
        function New-Object {
            param([string]$TypeName, [Parameter(ValueFromRemainingArguments = $true)][object[]]$ArgumentList)
            if ($TypeName -eq 'System.Diagnostics.Process') {
                $process = [pscustomobject]@{StartInfo = $null; ExitCode = $(if ($Failure -eq 'exit') { 9 } else { 0 });
                    StandardOutput = [IO.StringReader]::new(''); StandardError = [IO.StringReader]::new('synthetic private error')}
                $process | Add-Member -MemberType ScriptMethod -Name Start -Value {
                    $command = $this.StartInfo.Arguments
                    $global:dantVmwareLifecycle.calls += $command
                    $text = ''
                    if ($command -match '"list"') {
                        $text = if ($global:dantVmwareLifecycle.running) { "Total running VMs: 1`n$($global:dantVmwareLifecycle.vmx)`n" } else { "Total running VMs: 0`n" }
                        if ($global:dantVmwareLifecycle.failure -eq 'list') { $text = 'private malformed VM listing' }
                        if ($global:dantVmwareLifecycle.failure -eq 'overflow') { $text = 'x' * 16385 }
                    } elseif ($command -match '"suspend"') {
                        $global:dantVmwareLifecycle.running = $false
                    } elseif ($command -match '"start"') {
                        $global:dantVmwareLifecycle.running = $true
                    } else { throw 'Unexpected synthetic VMware command' }
                    $this.StandardOutput.Dispose()
                    $this.StandardOutput = [IO.StringReader]::new($text)
                    return $global:dantVmwareLifecycle.failure -ne 'start'
                }
                $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
                    param($Timeout)
                    if ($Timeout -le 0 -or $Timeout -gt 60000) { throw 'Synthetic process lost its bounded timeout' }
                    return $global:dantVmwareLifecycle.failure -ne 'timeout'
                }
                $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
                    $global:dantVmwareLifecycle.disposed++
                    $this.StandardOutput.Dispose()
                    $this.StandardError.Dispose()
                }
                return $process
            }
            Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
        }
        function Start-Process { throw 'VMware lifecycle fixture never starts a real process or requests UAC' }
        $previousProgram = $env:ProgramFiles
        $previousProgramX86 = ${env:ProgramFiles(x86)}
        try {
            $env:ProgramFiles = Join-Path $data 'program'
            ${env:ProgramFiles(x86)} = ''
            if ($Metadata -eq 'tool') { $env:ProgramFiles = Join-Path $data 'missing' }
            $parameters = @{Action = $Action; DataDirectory = $data; ExpectedBinding = $digest; ExpectedOperation = $operation; ExpectedDeadline = $deadline}
            if ($ExpectedIdentity) { $parameters.ExpectedVmId = $vmId }
            $reply = & $source @parameters | ConvertFrom-Json
            return @{reply = $reply; calls = @($global:dantVmwareLifecycle.calls); disposed = $global:dantVmwareLifecycle.disposed}
        } finally {
            $env:ProgramFiles = $previousProgram
            ${env:ProgramFiles(x86)} = $previousProgramX86
        }
    }
}

Describe 'Owned VMware lifecycle with an in-memory process implementation' {
    It 'suspends one running owner and confirms its existing saved state' {
        $result = Invoke-VmwareLifecycleFixture -Running -Saved -ExpectedIdentity
        $result.reply.ok | Should -BeTrue
        $result.reply.state | Should -Be 'suspended'
        $result.reply.changed | Should -BeTrue
        @($result.calls | Where-Object { $_ -match '"suspend"' }).Count | Should -Be 1
        $result.disposed | Should -Be $result.calls.Count
    }

    It 'resumes one saved owner and never replays already running or off states' {
        $result = Invoke-VmwareLifecycleFixture -Action resume -Saved
        $result.reply.ok | Should -BeTrue
        $result.reply.state | Should -Be 'running'
        @($result.calls | Where-Object { $_ -match '"start"' }).Count | Should -Be 1
        $result = Invoke-VmwareLifecycleFixture -Action resume -Running
        $result.reply.changed | Should -BeFalse
        $result = Invoke-VmwareLifecycleFixture -Action resume
        $result.reply.state | Should -Be 'off'
        $result.reply.changed | Should -BeFalse
    }

    It 'treats failed start timeout exit malformed listing and oversized output as unknown without replay' {
        foreach ($failure in @('start', 'timeout', 'exit', 'list', 'overflow')) {
            $result = Invoke-VmwareLifecycleFixture -Running -Saved -Failure $failure
            $result.reply.ok | Should -BeFalse
            $result.reply.reason | Should -Be 'unconfirmed'
            $result.calls.Count | Should -Be 1
            $result.disposed | Should -Be 1
            ($result.reply | ConvertTo-Json -Compress) | Should -Not -Match 'private|malformed'
        }
    }

    It 'rejects changed managed ownership transport and intent before any process' {
        foreach ($metadata in @('annotation', 'owner', 'ssh', 'provider', 'key', 'intent', 'tool', 'saved-path')) {
            $result = Invoke-VmwareLifecycleFixture -Action resume -Metadata $metadata
            $result.reply.ok | Should -BeFalse
            if ($metadata -ne 'saved-path') { $result.calls.Count | Should -Be 0 }
        }
    }
}

AfterAll {
    Remove-Variable -Scope Global -Name dantVmwareLifecycle -ErrorAction SilentlyContinue
}
