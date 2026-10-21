$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$phase = 'request'

function Get-SpeechOutputDeviceCount {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class DantSpeechAudioOutput {
    [DllImport("winmm.dll")] public static extern uint waveOutGetNumDevs();
}
'@ | Out-Null
    return [DantSpeechAudioOutput]::waveOutGetNumDevs()
}

function Assert-SpeechOutputAvailable {
    param([ScriptBlock]$ReadCount = { Get-SpeechOutputDeviceCount })
    if ((& $ReadCount) -lt 1) { throw 'speech-output-unavailable' }
}

function Get-SpeechLocale {
    param([object]$Request)

    # Current hosts resolve this from the shared language registry. Keep the
    # original two request forms compatible without guessing a new language.
    $locale = if ($Request.locale) {
        [string]$Request.locale
    } elseif ($Request.language -eq 'zh') {
        'zh-CN'
    } elseif ($Request.language -eq 'en') {
        'en-US'
    } else {
        throw 'speech-language-unavailable'
    }
    if ($locale -notmatch '^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$') { throw 'speech-invalid-request' }
    try { return [Globalization.CultureInfo]::GetCultureInfo($locale).Name } catch { throw 'speech-language-unavailable' }
}

function Select-SpeechVoice {
    param([object[]]$Voices, [string]$Locale)
    $matching = @($Voices | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $Locale })
    if ($matching.Count -eq 0) { throw 'speech-language-unavailable' }
    return $matching[0]
}

function Get-SpeechFailure {
    param([Exception]$Failure, [string]$Phase)

    $leaf = $Failure
    for ($depth = 0; $depth -lt 4 -and $null -ne $leaf.InnerException; $depth++) {
        $leaf = $leaf.InnerException
    }
    $known = @('speech-output-unavailable', 'speech-language-unavailable', 'speech-too-long', 'speech-invalid-request')
    $audioError = $leaf.GetType().Name -eq 'AudioException' -or $leaf.Message -match '^Audio device error encountered'
    $code = if ($known -contains $leaf.Message) {
        $leaf.Message
    } elseif ($Phase -eq 'recognition-input' -or $Phase -eq 'recognition-run' -and $audioError) {
        'speech-input-unavailable'
    } elseif ($Phase -eq 'speak-output' -or $Phase -eq 'speak-run' -and $audioError) {
        'speech-output-unavailable'
    } else {
        'speech-unavailable'
    }
    $numeric = if ($known -contains $leaf.Message) { $null } else { [long]$leaf.HResult }
    # This is an audio subsystem result, not a Win32 missing-file inference.
    if ($leaf.Message -match 'Error Code:\s*0x([0-9a-fA-F]{1,8})') { $numeric = [Convert]::ToInt64($matches[1], 16) }
    $result = @{ errorCode = $code; phase = $Phase }
    if ($null -ne $numeric) { $result.numericCode = $numeric }
    return $result
}

function New-SpeechServices {
    return @{
        Recognizers = { [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() }
        CreateRecognizer = { param($selected) [System.Speech.Recognition.SpeechRecognitionEngine]::new($selected) }
        CreateGrammar = { New-Object System.Speech.Recognition.DictationGrammar }
        OutputCount = { Get-SpeechOutputDeviceCount }
        CreateSynthesizer = { New-Object System.Speech.Synthesis.SpeechSynthesizer }
    }
}

function Invoke-SpeechRequest {
    param([object]$Request, [hashtable]$Services)

    $recognizer = $null
    $synthesizer = $null
    $phase = 'request'
    try {
        $language = Get-SpeechLocale -Request $Request
        if ($Request.mode -eq 'recognize') {
            $installed = @(& $Services.Recognizers)
            $selected = $installed | Where-Object { $_.Culture.Name -eq $language } | Select-Object -First 1
            if ($null -eq $selected) {
                throw 'speech-language-unavailable'
            }

            $recognizer = & $Services.CreateRecognizer $selected
            $recognizer.LoadGrammar((& $Services.CreateGrammar))
            $phase = 'recognition-input'
            $recognizer.SetInputToDefaultAudioDevice()
            $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
            $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(900)

            $phase = 'recognition-run'
            $result = $recognizer.Recognize([TimeSpan]::FromSeconds(15))
            $text = if ($null -eq $result) { '' } else { [string]$result.Text }
            return @{ text = $text }
        } elseif ($Request.mode -eq 'speak') {
            $text = [string]$Request.text
            if ($text.Length -gt 10000) { throw 'speech-too-long' }

            $phase = 'speak-output'
            Assert-SpeechOutputAvailable -ReadCount $Services.OutputCount
            $phase = 'voice-selection'
            $synthesizer = & $Services.CreateSynthesizer
            $selectedVoice = Select-SpeechVoice -Voices @($synthesizer.GetInstalledVoices()) -Locale $language
            $synthesizer.SelectVoice($selectedVoice.VoiceInfo.Name)

            $phase = 'speak-output'
            $synthesizer.SetOutputToDefaultAudioDevice()
            $phase = 'speak-run'
            $synthesizer.Speak($text)
            return @{ text = ''; spoken = $true }
        } elseif ($Request.mode -eq 'capabilities') {
            return @{ recognitionLanguages = @((& $Services.Recognizers) | ForEach-Object { $_.Culture.Name }) }
        } else {
            throw 'speech-invalid-request'
        }
    } catch {
        return Get-SpeechFailure -Failure $_.Exception -Phase $phase
    } finally {
        if ($null -ne $recognizer) { $recognizer.Dispose() }
        if ($null -ne $synthesizer) { $synthesizer.Dispose() }
    }
}

try {
    $phase = 'load'
    Add-Type -AssemblyName System.Speech | Out-Null
    $phase = 'request'
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $reply = Invoke-SpeechRequest -Request $request -Services (New-SpeechServices)
    $reply | ConvertTo-Json -Compress
    if ($reply.errorCode) { exit 1 }
} catch {
    Get-SpeechFailure -Failure $_.Exception -Phase $phase | ConvertTo-Json -Compress
    exit 1
}
