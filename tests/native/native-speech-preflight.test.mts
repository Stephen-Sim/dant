import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { observedRecord } from '../support/service-fixtures.mts';

function runSpeechFixture(script: string) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'dant-speech-preflight-'));
  const captured = fs.lstatSync(root, { bigint: true });
  const resolved = fs.realpathSync(root);
  const file = path.join(root, 'fixture.ps1');
  let written: fs.BigIntStats | undefined;
  try {
    // Keep the complete multiline fixture out of Windows' encoded command line.
    // Only its selected feature functions execute, with synthetic capabilities.
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
      // Windows PowerShell 5.1 requires a BOM to recognize a UTF-8 script file.
      fs.writeFileSync(descriptor, '\uFEFF' + script, 'utf8');
      written = fs.fstatSync(descriptor, { bigint: true });
    } finally {
      fs.closeSync(descriptor);
    }
    return spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
  } finally {
    const current = fs.lstatSync(root, { bigint: true, throwIfNoEntry: false });
    if (
      current &&
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === captured.dev &&
      current.ino === captured.ino &&
      fs.realpathSync(root) === resolved &&
      path.dirname(resolved) === parent &&
      path.basename(resolved).startsWith('dant-speech-preflight-')
    ) {
      const scriptFile = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (
        written &&
        scriptFile?.isFile() &&
        !scriptFile.isSymbolicLink() &&
        scriptFile.dev === written.dev &&
        scriptFile.ino === written.ino &&
        scriptFile.size === written.size &&
        scriptFile.mtimeNs === written.mtimeNs
      ) {
        fs.unlinkSync(file);
        if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
      }
    }
  }
}

test(
  'native speech preflight and failure classifier run without audio or microphone operations',
  { skip: process.platform !== 'win32' },
  () => {
    const source = fs.readFileSync(new URL('../../native/speech.ps1', import.meta.url), 'utf8');
    const script = String.raw`$ErrorActionPreference='Stop'
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SOURCE')),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'Fixture syntax error'}
 # Load only the two pure functions. The program, synthesizer and real device
 # enumeration are never invoked by this fixture.
 foreach($name in @('Assert-SpeechOutputAvailable','Get-SpeechFailure')){$function=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true) | Select-Object -First 1;Invoke-Expression $function.Extent.Text}
 $missing=$null
 try{Assert-SpeechOutputAvailable -ReadCount {0}}catch{$missing=Get-SpeechFailure -Failure $_.Exception -Phase 'speak-output'}
 Assert-SpeechOutputAvailable -ReadCount {1}
 $audio=Get-SpeechFailure -Failure ([Exception]::new('Audio device error encountered. Error Code: 0x2 PRIVATE text')) -Phase 'speak-run'
 $wrapped=[Reflection.TargetInvocationException]::new('PRIVATE wrapper',[Exception]::new('speech-language-unavailable'))
 $language=Get-SpeechFailure -Failure $wrapped -Phase 'request'
 $microphone=Get-SpeechFailure -Failure ([Exception]::new('Audio device error encountered. Error Code: 0x2 PRIVATE audio endpoint')) -Phase 'recognition-input'
 $unknown=Get-SpeechFailure -Failure ([Exception]::new('PRIVATE spoken text')) -Phase 'load'
 $unicodeFixturePreserved='中文🙂' -ceq [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5Lit5paH8J+Zgg=='))
 @{missing=$missing;audio=$audio;language=$language;microphone=$microphone;unknown=$unknown;playedAudio=$false;openedMicrophone=$false;unicodeFixturePreserved=$unicodeFixturePreserved} | ConvertTo-Json -Depth 5 -Compress
 `.replace('SOURCE', Buffer.from(source).toString('base64'));
    const result = runSpeechFixture(script);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Isolated PowerShell speech functions failed');
    const body = observedRecord(JSON.parse(result.stdout.replace(/^\uFEFF/, ''))),
      missing = observedRecord(body.missing),
      audio = observedRecord(body.audio),
      language = observedRecord(body.language),
      microphone = observedRecord(body.microphone),
      unknown = observedRecord(body.unknown);
    assert.equal(missing.errorCode, 'speech-output-unavailable');
    assert.equal(Object.hasOwn(missing, 'numericCode'), false);
    assert.equal(audio.errorCode, 'speech-output-unavailable');
    assert.equal(audio.numericCode, 2);
    assert.equal(language.errorCode, 'speech-language-unavailable');
    assert.equal(Object.hasOwn(language, 'numericCode'), false);
    assert.equal(microphone.errorCode, 'speech-input-unavailable');
    assert.equal(unknown.errorCode, 'speech-unavailable');
    assert.equal(body.playedAudio, false);
    assert.equal(body.openedMicrophone, false);
    assert.equal(body.unicodeFixturePreserved, true);
    assert.doesNotMatch(result.stdout, /PRIVATE|endpoint|wrapper/);
  },
);

test(
  'the real speech request preflights before its default synthesizer capability and preserves failure phases',
  { skip: process.platform !== 'win32' },
  () => {
    const source = fs.readFileSync(new URL('../../native/speech.ps1', import.meta.url), 'utf8');
    const script = String.raw`$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SOURCE')),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Fixture syntax error'}
$functions=@{}
foreach($name in @('Assert-SpeechOutputAvailable','Get-SpeechFailure','Get-SpeechLocale','Select-SpeechVoice','Invoke-SpeechRequest','New-SpeechServices')) {
    $matches=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true))
    if($matches.Count -ne 1){throw 'Missing exact feature function'}
    $functions[$name]=$matches[0]
    # Only named feature functions are defined. The program, Add-Type and its
    # default audio/process capabilities are never executed by this fixture.
    Invoke-Expression $matches[0].Extent.Text
}
$tables=@($functions['New-SpeechServices'].FindAll({param($node)$node -is [Management.Automation.Language.HashtableAst]},$true))
if($tables.Count -ne 1){throw 'Ambiguous speech capability adapter'}
$capabilities=@{}
foreach($pair in $tables[0].KeyValuePairs){$capabilities[$pair.Item1.Value]=$pair.Item2}
$output=@($capabilities['OutputCount'].FindAll({param($node)$node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Get-SpeechOutputDeviceCount'},$true))
$constructors=@($capabilities['CreateSynthesizer'].FindAll({param($node)$node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'New-Object' -and $node.CommandElements.Count -eq 2 -and $node.CommandElements[1].Value -eq 'System.Speech.Synthesis.SpeechSynthesizer'},$true))
if($output.Count -ne 1 -or $constructors.Count -ne 1){throw 'Default capabilities are not bound to the real audio adapters'}

$request=@{mode='speak';locale='en-US';text='synthetic fixture'}
$blocked=Invoke-SpeechRequest -Request $request -Services @{
    OutputCount={0}
    CreateSynthesizer={throw 'Factory must remain untouched before preflight succeeds'}
}
$events=[Collections.Generic.List[string]]::new()
$state=@{FailOutput=$false}
$voice=[pscustomobject]@{Enabled=$true;VoiceInfo=[pscustomobject]@{Culture=[Globalization.CultureInfo]::GetCultureInfo('en-US');Name='Fixture'}}
$synth=[pscustomobject]@{}
$synth | Add-Member ScriptMethod GetInstalledVoices { $events.Add('voices'); return $voice }
$synth | Add-Member ScriptMethod SelectVoice { param($name) $events.Add('select') }
$synth | Add-Member ScriptMethod SetOutputToDefaultAudioDevice { $events.Add('output'); if($state.FailOutput){throw 'Audio device error encountered. Error Code: 0x2 PRIVATE fixture'} }
$synth | Add-Member ScriptMethod Speak { param($text) $events.Add('speak') }
$synth | Add-Member ScriptMethod Dispose { $events.Add('dispose') }
$services=@{
    OutputCount={$events.Add('preflight');1}
    CreateSynthesizer={$events.Add('create');$synth}
}
$success=Invoke-SpeechRequest -Request $request -Services $services
$successOrder=$events.ToArray()
$events.Clear();$state.FailOutput=$true
$failure=Invoke-SpeechRequest -Request $request -Services $services
@{blocked=$blocked;success=$success;successOrder=$successOrder;failure=$failure;failureOrder=$events.ToArray();playedAudio=$false;openedMicrophone=$false;defaultAdapterVerified=$true} | ConvertTo-Json -Depth 6 -Compress
`.replace('SOURCE', Buffer.from(source).toString('base64'));
    const result = runSpeechFixture(script);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Isolated speech feature execution failed');
    const body = observedRecord(JSON.parse(result.stdout.replace(/^\uFEFF/, ''))),
      blocked = observedRecord(body.blocked),
      success = observedRecord(body.success),
      failure = observedRecord(body.failure);
    assert.equal(blocked.errorCode, 'speech-output-unavailable');
    assert.equal(blocked.phase, 'speak-output');
    assert.equal(success.spoken, true);
    assert.deepEqual(body.successOrder, [
      'preflight',
      'create',
      'voices',
      'select',
      'output',
      'speak',
      'dispose',
    ]);
    assert.equal(failure.errorCode, 'speech-output-unavailable');
    assert.equal(failure.phase, 'speak-output');
    assert.deepEqual(body.failureOrder, [
      'preflight',
      'create',
      'voices',
      'select',
      'output',
      'dispose',
    ]);
    assert.equal(body.defaultAdapterVerified, true);
    assert.equal(body.playedAudio, false);
    assert.equal(body.openedMicrophone, false);
    assert.doesNotMatch(result.stdout, /PRIVATE|Factory must/);
  },
);
