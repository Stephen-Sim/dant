BeforeAll {
    $repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $source = Join-Path $repositoryRoot 'native/speech.ps1'
    $ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$null)
    foreach ($name in @('Assert-SpeechOutputAvailable', 'Get-SpeechLocale', 'Select-SpeechVoice', 'Get-SpeechFailure')) {
        $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }.GetNewClosure(), $true)
        if (!$definition -or !$definition.Body.ParamBlock) { throw 'Speech fixture function is missing its validated signature.' }
        # Execute the original AST with its original file/line locations. Never run the device entrypoint.
        Set-Item -Path "Function:script:$name" -Value $definition.Body.GetScriptBlock()
    }
}

Describe 'Native speech policy without audio devices' {
    It 'uses the explicit registry locale and supported legacy language forms' {
        Get-SpeechLocale ([pscustomobject]@{locale = 'ja-JP'}) | Should -Be 'ja-JP'
        Get-SpeechLocale ([pscustomobject]@{language = 'zh'}) | Should -Be 'zh-CN'
        Get-SpeechLocale ([pscustomobject]@{language = 'en'}) | Should -Be 'en-US'
        { Get-SpeechLocale ([pscustomobject]@{language = 'invalid'}) } | Should -Throw 'speech-language-unavailable'
        foreach ($locale in @('en_US', "en`nUS", '')) {
            { Get-SpeechLocale ([pscustomobject]@{locale = $locale}) } | Should -Throw
        }
    }

    It 'requires an available output device before speaking' {
        { Assert-SpeechOutputAvailable -ReadCount { 0 } } | Should -Throw 'speech-output-unavailable'
        { Assert-SpeechOutputAvailable -ReadCount { 1 } } | Should -Not -Throw
        { Assert-SpeechOutputAvailable -ReadCount { throw 'fixture-device-failure' } } | Should -Throw 'fixture-device-failure'
    }

    It 'selects only an enabled voice in the requested locale' {
        $disabled = [pscustomobject]@{Enabled = $false; VoiceInfo = [pscustomobject]@{Culture = [Globalization.CultureInfo]::GetCultureInfo('en-US')}}
        $foreign = [pscustomobject]@{Enabled = $true; VoiceInfo = [pscustomobject]@{Culture = [Globalization.CultureInfo]::GetCultureInfo('ja-JP')}}
        $selected = [pscustomobject]@{Enabled = $true; VoiceInfo = [pscustomobject]@{Culture = [Globalization.CultureInfo]::GetCultureInfo('en-US')}}
        Select-SpeechVoice -Voices @($disabled, $foreign, $selected) -Locale 'en-US' | Should -Be $selected
        { Select-SpeechVoice -Voices @($disabled, $foreign) -Locale 'en-US' } | Should -Throw 'speech-language-unavailable'
        { Select-SpeechVoice -Voices @() -Locale 'en-US' } | Should -Throw 'speech-language-unavailable'
    }

    It 'classifies bounded failures without exposing exception text' {
        foreach ($code in @('speech-output-unavailable', 'speech-language-unavailable', 'speech-too-long', 'speech-invalid-request')) {
            $reply = Get-SpeechFailure -Failure ([Exception]::new($code)) -Phase 'request'
            $reply.errorCode | Should -Be $code
            $reply.ContainsKey('numericCode') | Should -BeFalse
        }
        foreach ($phase in @('recognition-input', 'recognition-run', 'speak-output', 'speak-run', 'other')) {
            $failure = [Exception]::new('Audio device error encountered: Error Code: 0x80004005')
            $reply = Get-SpeechFailure -Failure $failure -Phase $phase
            $expected = if ($phase -like 'recognition-*') { 'speech-input-unavailable' } elseif ($phase -like 'speak-*') { 'speech-output-unavailable' } else { 'speech-unavailable' }
            $reply.errorCode | Should -Be $expected
            $reply.numericCode | Should -Be 2147500037
            $reply.Count | Should -Be 3
        }
        $wrapped = [Exception]::new('private outer detail', [Exception]::new('speech-too-long'))
        (Get-SpeechFailure -Failure $wrapped -Phase 'request').errorCode | Should -Be 'speech-too-long'
        (Get-SpeechFailure -Failure ([Exception]::new('private detail')) -Phase 'request').errorCode | Should -Be 'speech-unavailable'
    }
}
