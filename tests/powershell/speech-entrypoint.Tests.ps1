BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $speechSource = Join-Path $repositoryRoot 'native/speech.ps1'
    $ast = [Management.Automation.Language.Parser]::ParseFile($speechSource, [ref]$null, [ref]$null)
    foreach ($name in @('Assert-SpeechOutputAvailable', 'Get-SpeechLocale', 'Select-SpeechVoice', 'Get-SpeechFailure', 'Invoke-SpeechRequest')) {
        $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }.GetNewClosure(), $true)
        if (!$definition -or !$definition.Body.ParamBlock) { throw 'Speech policy function is unavailable.' }
        Set-Item -Path "Function:script:$name" -Value $definition.Body.GetScriptBlock()
    }

    function Assert-FixtureSpeechPhase([string]$Phase) {
        if ($global:dantSpeechFixture.Failure -eq $Phase) {
            throw 'Audio device error encountered: Error Code: 0x80004005'
        }
    }

    function New-FixtureRecognizer {
        $recognizer = [pscustomobject]@{
            InitialSilenceTimeout = [TimeSpan]::Zero
            EndSilenceTimeout = [TimeSpan]::Zero
        }
        $recognizer | Add-Member -MemberType ScriptMethod -Name LoadGrammar -Value {
            param($grammar)
            if ($grammar.kind -ne 'synthetic-grammar') { throw 'Unexpected fixture grammar' }
            $global:dantSpeechFixture.GrammarCount++
        }
        $recognizer | Add-Member -MemberType ScriptMethod -Name SetInputToDefaultAudioDevice -Value {
            $global:dantSpeechFixture.InputCount++
            Assert-FixtureSpeechPhase input
        }
        $recognizer | Add-Member -MemberType ScriptMethod -Name Recognize -Value {
            param($duration)
            $global:dantSpeechFixture.RecognitionSeconds = $duration.TotalSeconds
            $global:dantSpeechFixture.InitialSeconds = $this.InitialSilenceTimeout.TotalSeconds
            $global:dantSpeechFixture.EndMilliseconds = $this.EndSilenceTimeout.TotalMilliseconds
            Assert-FixtureSpeechPhase recognize
            if ($global:dantSpeechFixture.NullRecognition) { return $null }
            return [pscustomobject]@{Text = 'synthetic recognition'}
        }
        $recognizer | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
            $global:dantSpeechFixture.RecognizerDisposed++
        }
        return $recognizer
    }

    function New-FixtureSynthesizer {
        $synthesizer = [pscustomobject]@{}
        $synthesizer | Add-Member -MemberType ScriptMethod -Name GetInstalledVoices -Value {
            if ($global:dantSpeechFixture.NoVoices) { return @() }
            return @([pscustomobject]@{
                Enabled = $true
                VoiceInfo = [pscustomobject]@{
                    Culture = [Globalization.CultureInfo]::GetCultureInfo('en-US')
                    Name = 'Synthetic Voice'
                }
            })
        }
        $synthesizer | Add-Member -MemberType ScriptMethod -Name SelectVoice -Value {
            param($name)
            $global:dantSpeechFixture.SelectedVoice = $name
        }
        $synthesizer | Add-Member -MemberType ScriptMethod -Name SetOutputToDefaultAudioDevice -Value {
            Assert-FixtureSpeechPhase output
        }
        $synthesizer | Add-Member -MemberType ScriptMethod -Name Speak -Value {
            param($text)
            $global:dantSpeechFixture.SpeakCount++
            Assert-FixtureSpeechPhase speak
        }
        $synthesizer | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
            $global:dantSpeechFixture.SynthesizerDisposed++
        }
        return $synthesizer
    }

    function Invoke-SpeechFixture([object]$Request) {
        $services = @{
            Recognizers = {
                if (!$global:dantSpeechFixture.NoRecognizers) {
                    foreach ($locale in @('en-US', 'zh-CN')) {
                        [pscustomobject]@{Culture = [Globalization.CultureInfo]::GetCultureInfo($locale)}
                    }
                }
            }
            CreateRecognizer = { param($selected) New-FixtureRecognizer }
            CreateGrammar = { [pscustomobject]@{kind = 'synthetic-grammar'} }
            OutputCount = {
                $global:dantSpeechFixture.DeviceQueries++
                return $global:dantSpeechFixture.Devices
            }
            CreateSynthesizer = { New-FixtureSynthesizer }
        }
        # Invoke the original policy AST with its original coverage locations.
        # These callbacks contain no native assembly, process or audio API.
        return Invoke-SpeechRequest -Request ([pscustomobject]$Request) -Services $services |
            ConvertTo-Json -Compress | ConvertFrom-Json
    }

    function Invoke-SpeechEntryFixture([string]$Raw) {
        $originalInput = [Console]::In
        $originalInputEncoding = [Console]::InputEncoding
        $originalOutputEncoding = [Console]::OutputEncoding
        $global:dantSpeechFixtureReader = [IO.StringReader]::new($Raw)
        try {
            return (& $speechSource) | ConvertFrom-Json
        } finally {
            [Console]::InputEncoding = $originalInputEncoding
            [Console]::OutputEncoding = $originalOutputEncoding
            [Console]::SetIn($originalInput)
            $global:dantSpeechFixtureReader.Dispose()
        }
    }
}

Describe 'Native speech policy through injected synthetic services' {
    BeforeEach {
        $global:dantSpeechFixture = @{
            Devices = 1
            NoRecognizers = $false
            NoVoices = $false
            NullRecognition = $false
            Failure = ''
            SelectedVoice = ''
            InputCount = 0
            GrammarCount = 0
            SpeakCount = 0
            RecognizerDisposed = 0
            SynthesizerDisposed = 0
            DeviceQueries = 0
        }
        $global:dantSpeechFixtureLoadFailure = $false
        Mock Add-Type {
            if ($AssemblyName -ne 'System.Speech' -or $TypeDefinition) { throw 'Unexpected native type request' }
            [Console]::SetIn($global:dantSpeechFixtureReader)
            if ($global:dantSpeechFixtureLoadFailure) { throw 'private synthetic load failure' }
        }
    }

    It 'lists capabilities without opening an input or output device' {
        $reply = Invoke-SpeechFixture @{mode = 'capabilities'; locale = 'en-US'}
        $reply.recognitionLanguages | Should -Contain 'en-US'
        $reply.recognitionLanguages | Should -Contain 'zh-CN'
        $global:dantSpeechFixture.InputCount | Should -Be 0
        $global:dantSpeechFixture.SpeakCount | Should -Be 0
        $global:dantSpeechFixture.DeviceQueries | Should -Be 0
    }

    It 'recognizes bounded synthetic results and always disposes the recognizer' {
        $reply = Invoke-SpeechFixture @{mode = 'recognize'; language = 'en'}
        $reply.text | Should -Be 'synthetic recognition'
        $global:dantSpeechFixture.InitialSeconds | Should -Be 8
        $global:dantSpeechFixture.EndMilliseconds | Should -Be 900
        $global:dantSpeechFixture.RecognitionSeconds | Should -Be 15
        $global:dantSpeechFixture.GrammarCount | Should -Be 1
        $global:dantSpeechFixture.RecognizerDisposed | Should -Be 1
        $global:dantSpeechFixture.NullRecognition = $true
        (Invoke-SpeechFixture @{mode = 'recognize'; locale = 'en-US'}).text | Should -Be ''
        $global:dantSpeechFixture.RecognizerDisposed | Should -Be 2
    }

    It 'does not invent recognizers and classifies input/run failures without raw exception content' {
        $global:dantSpeechFixture.NoRecognizers = $true
        (Invoke-SpeechFixture @{mode = 'recognize'; locale = 'en-US'}).errorCode | Should -Be 'speech-language-unavailable'
        $global:dantSpeechFixture.RecognizerDisposed | Should -Be 0
        $global:dantSpeechFixture.NoRecognizers = $false
        foreach ($failure in @('input', 'recognize')) {
            $global:dantSpeechFixture.Failure = $failure
            $reply = Invoke-SpeechFixture @{mode = 'recognize'; locale = 'en-US'}
            $reply.errorCode | Should -Be 'speech-input-unavailable'
            $reply.numericCode | Should -Be 2147500037
            @($reply.PSObject.Properties).Count | Should -Be 3
        }
        $global:dantSpeechFixture.RecognizerDisposed | Should -Be 2
    }

    It 'speaks only through the selected available voice and disposes it' {
        $reply = Invoke-SpeechFixture @{mode = 'speak'; locale = 'en-US'; text = 'synthetic text'}
        $reply.spoken | Should -BeTrue
        $reply.text | Should -Be ''
        $global:dantSpeechFixture.SelectedVoice | Should -Be 'Synthetic Voice'
        $global:dantSpeechFixture.SpeakCount | Should -Be 1
        $global:dantSpeechFixture.SynthesizerDisposed | Should -Be 1
        $global:dantSpeechFixture.DeviceQueries | Should -Be 1
    }

    It 'rejects excessive text absent devices and absent voices before speaking' {
        (Invoke-SpeechFixture @{mode = 'speak'; locale = 'en-US'; text = ('x' * 10001)}).errorCode | Should -Be 'speech-too-long'
        $global:dantSpeechFixture.DeviceQueries | Should -Be 0
        $global:dantSpeechFixture.Devices = 0
        (Invoke-SpeechFixture @{mode = 'speak'; locale = 'en-US'; text = 'fixture'}).errorCode | Should -Be 'speech-output-unavailable'
        $global:dantSpeechFixture.SynthesizerDisposed | Should -Be 0
        $global:dantSpeechFixture.Devices = 1
        $global:dantSpeechFixture.NoVoices = $true
        (Invoke-SpeechFixture @{mode = 'speak'; locale = 'en-US'; text = 'fixture'}).errorCode | Should -Be 'speech-language-unavailable'
        $global:dantSpeechFixture.SpeakCount | Should -Be 0
        $global:dantSpeechFixture.SynthesizerDisposed | Should -Be 1
    }

    It 'preserves output failures and never replays synthesis' {
        foreach ($failure in @('output', 'speak')) {
            $global:dantSpeechFixture.Failure = $failure
            $reply = Invoke-SpeechFixture @{mode = 'speak'; locale = 'en-US'; text = 'fixture'}
            $reply.errorCode | Should -Be 'speech-output-unavailable'
            $reply.numericCode | Should -Be 2147500037
        }
        $global:dantSpeechFixture.SpeakCount | Should -Be 1
        $global:dantSpeechFixture.SynthesizerDisposed | Should -Be 2
    }

    It 'keeps the public stdin/out error protocol without loading native assemblies' {
        (Invoke-SpeechFixture @{mode = 'unknown'; locale = 'en-US'}).errorCode | Should -Be 'speech-invalid-request'
        (Invoke-SpeechEntryFixture 'invalid json').errorCode | Should -Be 'speech-unavailable'
        (Invoke-SpeechEntryFixture '{"mode":"unknown","locale":"en-US"}').errorCode | Should -Be 'speech-invalid-request'
        $global:dantSpeechFixtureLoadFailure = $true
        $reply = Invoke-SpeechEntryFixture '{"mode":"capabilities","locale":"en-US"}'
        $reply.errorCode | Should -Be 'speech-unavailable'
        $reply.phase | Should -Be 'load'
        ($reply | ConvertTo-Json -Compress) | Should -Not -Match 'private synthetic load failure'
        $global:dantSpeechFixture.InputCount | Should -Be 0
        $global:dantSpeechFixture.SpeakCount | Should -Be 0
    }
}

AfterAll {
    Remove-Variable -Scope Global -Name dantSpeechFixture, dantSpeechFixtureReader, dantSpeechFixtureLoadFailure -ErrorAction SilentlyContinue
}
