$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$recognizer = $null
$synthesizer = $null
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
function Get-SpeechFailure {
    param([Exception]$Failure, [string]$Phase)
    $leaf = $Failure
    for ($depth = 0; $depth -lt 4 -and $null -ne $leaf.InnerException; $depth++) { $leaf = $leaf.InnerException }
    $known = @('speech-output-unavailable', 'speech-language-unavailable', 'speech-too-long', 'speech-invalid-request')
    $audioError = $leaf.GetType().Name -eq 'AudioException' -or $leaf.Message -match '^Audio device error encountered'
    $code = if ($known -contains $leaf.Message) { $leaf.Message } elseif ($Phase -eq 'recognition-input' -or $Phase -eq 'recognition-run' -and $audioError) { 'speech-input-unavailable' } elseif ($Phase -eq 'speak-output' -or $Phase -eq 'speak-run' -and $audioError) { 'speech-output-unavailable' } else { 'speech-unavailable' }
    $numeric = if ($known -contains $leaf.Message) { $null } else { [long]$leaf.HResult }
    # This is an audio subsystem result, not a Win32 missing-file inference.
    if ($leaf.Message -match 'Error Code:\s*0x([0-9a-fA-F]{1,8})') { $numeric = [Convert]::ToInt64($matches[1], 16) }
    $result = @{ errorCode = $code; phase = $Phase }
    if ($null -ne $numeric) { $result.numericCode = $numeric }
    return $result
}
try {
    $phase = 'load'
    Add-Type -AssemblyName System.Speech | Out-Null
    $phase = 'request'
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $language = if ($request.language -eq 'zh') { 'zh-CN' } else { 'en-US' }
    if ($request.mode -eq 'recognize') {
        $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
        $selected = $installed | Where-Object { $_.Culture.Name -eq $language } | Select-Object -First 1
        if ($null -eq $selected) {
            throw 'speech-language-unavailable'
        }
        $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($selected)
        $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
        $phase = 'recognition-input'
        $recognizer.SetInputToDefaultAudioDevice()
        $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
        $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(900)
        $phase = 'recognition-run'
        $result = $recognizer.Recognize([TimeSpan]::FromSeconds(15))
        $text = if ($null -eq $result) { '' } else { [string]$result.Text }
        @{ text = $text } | ConvertTo-Json -Compress
    } elseif ($request.mode -eq 'speak') {
        $text = [string]$request.text
        if ($text.Length -gt 10000) { throw 'speech-too-long' }
        $phase = 'speak-output'
        Assert-SpeechOutputAvailable
        $phase = 'voice-selection'
        $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $voices = @($synthesizer.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $language })
        if ($voices.Count -gt 0) { $synthesizer.SelectVoice($voices[0].VoiceInfo.Name) }
        $phase = 'speak-output'
        $synthesizer.SetOutputToDefaultAudioDevice()
        $phase = 'speak-run'
        $synthesizer.Speak($text)
        @{ text = ''; spoken = $true } | ConvertTo-Json -Compress
    } elseif ($request.mode -eq 'capabilities') {
        @{ recognitionLanguages = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }) } | ConvertTo-Json -Compress
    } else {
        throw 'speech-invalid-request'
    }
} catch {
    Get-SpeechFailure -Failure $_.Exception -Phase $phase | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($null -ne $recognizer) { $recognizer.Dispose() }
    if ($null -ne $synthesizer) { $synthesizer.Dispose() }
}
