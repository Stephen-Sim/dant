$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$recognizer = $null
$synthesizer = $null
try {
    Add-Type -AssemblyName System.Speech | Out-Null
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $language = if ($request.language -eq 'zh') { 'zh-CN' } else { 'en-US' }
    if ($request.mode -eq 'recognize') {
        $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
        $selected = $installed | Where-Object { $_.Culture.Name -eq $language } | Select-Object -First 1
        if ($null -eq $selected) {
            throw 'The Windows speech recognition language is not installed. Add the matching Speech language in Windows Settings.'
        }
        $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($selected)
        $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
        $recognizer.SetInputToDefaultAudioDevice()
        $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
        $recognizer.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(900)
        $result = $recognizer.Recognize([TimeSpan]::FromSeconds(15))
        $text = if ($null -eq $result) { '' } else { [string]$result.Text }
        @{ text = $text } | ConvertTo-Json -Compress
    } elseif ($request.mode -eq 'speak') {
        $text = [string]$request.text
        if ($text.Length -gt 10000) { throw 'Read-aloud text exceeds 10000 characters.' }
        $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $voices = @($synthesizer.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $language })
        if ($voices.Count -gt 0) { $synthesizer.SelectVoice($voices[0].VoiceInfo.Name) }
        $synthesizer.SetOutputToDefaultAudioDevice()
        $synthesizer.Speak($text)
        @{ text = ''; spoken = $true } | ConvertTo-Json -Compress
    } elseif ($request.mode -eq 'capabilities') {
        @{ recognitionLanguages = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }) } | ConvertTo-Json -Compress
    } else {
        throw 'Unsupported speech operation.'
    }
} catch {
    @{ error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($null -ne $recognizer) { $recognizer.Dispose() }
    if ($null -ne $synthesizer) { $synthesizer.Dispose() }
}
