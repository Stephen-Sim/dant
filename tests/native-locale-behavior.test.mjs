import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseHTML } from 'linkedom';
import { languages, languageInfo } from '../src/i18n/languages.mts';
import { mountCallOverlay } from '../ui/call/call-overlay.js';

test('a separate floating-call context loads its locale and applies RTL without audio or general API calls', async () => {
  const html = fs.readFileSync(new URL('../ui/call-overlay.html', import.meta.url), 'utf8');
  for (const code of ['fr', 'ja', 'ar']) {
    const catalog = JSON.parse(
      fs.readFileSync(new URL(`../src/i18n/locales/${code}.json`, import.meta.url), 'utf8'),
    );
    const { document } = parseHTML(html),
      calls = [],
      state = {
        callId: 'call-' + code,
        status: 'talking',
        language: code,
        theme: 'dark',
        seconds: 10,
        confirmed: true,
        running: false,
        canMute: false,
      };
    const dispose = await mountCallOverlay({
      document,
      window: { addEventListener() {}, removeEventListener() {} },
      loadCore: async () => ({
        invoke: async (command, args) => {
          calls.push({ command, args });
          return command === 'call_overlay_get' ? state : undefined;
        },
      }),
      loadEvents: async () => ({ listen: async () => () => {} }),
      schedule: () => 1,
      cancel() {},
    });
    for (
      let attempt = 0;
      attempt < 50 && document.querySelector('#call-status').textContent !== catalog['In a call'];
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(document.querySelector('#call-status').textContent, catalog['In a call']);
    assert.equal(document.documentElement.lang, languageInfo(code).locale);
    assert.equal(document.documentElement.dir, languageInfo(code).direction);
    assert.equal(
      document.querySelector('#call-hangup').getAttribute('aria-label'),
      catalog['End call'],
    );
    assert.deepEqual(
      calls.map((call) => call.command),
      ['call_overlay_get'],
    );
    dispose();
  }
});

test(
  'native locale selection and installed-voice matching never touch audio devices',
  { skip: process.platform !== 'win32' },
  () => {
    const source = fs.readFileSync(new URL('../native/speech.ps1', import.meta.url), 'utf8');
    const script = String.raw`$ErrorActionPreference='Stop'
 [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
 $tokens=$null;$errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SOURCE')),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'Invalid speech syntax'}
 foreach($name in @('Get-SpeechLocale','Select-SpeechVoice')){
  $function=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true) | Select-Object -First 1
  Invoke-Expression $function.Extent.Text
 }
 $items=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('REGISTRY')) | ConvertFrom-Json
 $result=@()
 foreach($item in $items){
  $locale=Get-SpeechLocale -Request @{language=$item.code;locale=$item.speech}
  $wrong=if($locale -eq 'en-US'){'zh-CN'}else{'en-US'}
  $matching=[PSCustomObject]@{Enabled=$true;VoiceInfo=[PSCustomObject]@{Name='selected';Culture=[PSCustomObject]@{Name=$locale}}}
  $other=[PSCustomObject]@{Enabled=$true;VoiceInfo=[PSCustomObject]@{Name='wrong';Culture=[PSCustomObject]@{Name=$wrong}}}
  $disabled=[PSCustomObject]@{Enabled=$false;VoiceInfo=[PSCustomObject]@{Name='disabled';Culture=[PSCustomObject]@{Name=$locale}}}
  $selected=Select-SpeechVoice -Voices @($other,$disabled,$matching) -Locale $locale
  if($selected.VoiceInfo.Name -ne 'selected'){throw 'Wrong voice selected'}
  $missing=$false
  try{Select-SpeechVoice -Voices @($other,$disabled) -Locale $locale | Out-Null}catch{if($_.Exception.Message -ne 'speech-language-unavailable'){throw};$missing=$true}
  if(!$missing){throw 'Missing voice silently fell back'}
  $result+=@{code=$item.code;locale=$locale;missing=$missing}
 }
 @{results=$result;openedAudio=$false;openedMicrophone=$false} | ConvertTo-Json -Depth 5 -Compress
 `
      .replace('SOURCE', Buffer.from(source).toString('base64'))
      .replace('REGISTRY', Buffer.from(JSON.stringify(languages)).toString('base64'));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      input: script,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
    assert.equal(body.openedAudio, false);
    assert.equal(body.openedMicrophone, false);
    assert.equal(body.results.length, 16);
    for (const item of body.results) {
      assert.equal(item.locale, languageInfo(item.code).speech);
      assert.equal(item.missing, true);
    }
  },
);
