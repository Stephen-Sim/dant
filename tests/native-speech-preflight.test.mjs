import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

test(
  'native speech preflight and failure classifier run without audio or microphone operations',
  { skip: process.platform !== 'win32' },
  () => {
    const source = fs.readFileSync(new URL('../native/speech.ps1', import.meta.url), 'utf8');
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
 @{missing=$missing;audio=$audio;language=$language;microphone=$microphone;unknown=$unknown;playedAudio=$false;openedMicrophone=$false} | ConvertTo-Json -Depth 5 -Compress
 `.replace('SOURCE', Buffer.from(source).toString('base64'));
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Isolated PowerShell speech functions failed');
    const body = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
    assert.equal(body.missing.errorCode, 'speech-output-unavailable');
    assert.equal(Object.hasOwn(body.missing, 'numericCode'), false);
    assert.equal(body.audio.errorCode, 'speech-output-unavailable');
    assert.equal(body.audio.numericCode, 2);
    assert.equal(body.language.errorCode, 'speech-language-unavailable');
    assert.equal(Object.hasOwn(body.language, 'numericCode'), false);
    assert.equal(body.microphone.errorCode, 'speech-input-unavailable');
    assert.equal(body.unknown.errorCode, 'speech-unavailable');
    assert.equal(body.playedAudio, false);
    assert.equal(body.openedMicrophone, false);
    assert.doesNotMatch(result.stdout, /PRIVATE|endpoint|wrapper/);
    const speak = source.slice(
      source.indexOf("$request.mode -eq 'speak'"),
      source.indexOf("$request.mode -eq 'capabilities'"),
    );
    assert.ok(
      speak.indexOf('Assert-SpeechOutputAvailable') <
        speak.indexOf('New-Object System.Speech.Synthesis.SpeechSynthesizer'),
    );
    assert.ok(
      speak.indexOf('Assert-SpeechOutputAvailable') < speak.indexOf('$synthesizer.Speak($text)'),
    );
  },
);
