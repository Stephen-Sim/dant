import { errorCode, errorMessage } from '../../../ui/shared/json.mts';
import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechHelper, speechMessages } from '../../../ui/platform/speech.mts';

test('desktop dictation and read aloud are user-triggered native requests', async () => {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [],
    helper = new SpeechHelper({
      desktop: true,
      invoke: async (command, args) => {
        calls.push({ command, args });
        return command === 'speech_start' && defined(args).mode === 'recognize'
          ? 'Recognized words'
          : '';
      },
    });
  assert.deepEqual([...calls], []);
  assert.equal(await helper.dictate('en'), 'Recognized words');
  assert.equal(defined(defined(calls[1]).args).mode, 'recognize');
  assert.equal(defined(defined(calls[1]).args).language, 'en');
  await helper.speak('Hello', 'en');
  assert.equal(defined(defined(calls.at(-1)).args).text, 'Hello');
  await helper.stop();
  assert.equal(defined(calls.at(-1)).command, 'speech_stop');
});

test('cancelling while native stop is pending never resurrects dictation or read-aloud', async () => {
  for (const mode of ['dictate', 'speak']) {
    let finish: (() => void) | undefined;
    const calls: string[] = [],
      helper = new SpeechHelper({
        desktop: true,
        invoke: (command) => {
          calls.push(command);
          return calls.length === 1
            ? new Promise<void>((resolve) => (finish = resolve))
            : Promise.resolve();
        },
      });
    const operation =
      mode === 'dictate' ? helper.dictate('zh') : helper.speak('Do not replay', 'zh');
    await helper.stop();
    defined(finish)();
    await assert.rejects(operation, (error) => errorCode(error) === 'speech-cancelled');
    assert.deepEqual(calls, ['speech_stop', 'speech_stop']);
  }
});

test('unsupported browser dictation reports a concrete fallback instead of recording audio', async () => {
  const helper = new SpeechHelper({ desktop: false, recognizer: null, synthesis: null });
  await assert.rejects(helper.dictate('en'), /Windows app/);
});

test('native playback device failures use fixed localized guidance for stable codes and legacy audio errors', async () => {
  const legacy =
    'Exception calling SetOutputToDefaultAudioDevice: Audio device error encountered. (Exception from HRESULT: 0x2) C:\\private\\speech.ps1';
  for (const language of ['en', 'zh'] as const)
    for (const failure of [
      'speech-output-unavailable',
      Object.assign(Error('private native details'), { code: 'speech-output-unavailable' }),
      Error(legacy),
      legacy,
    ] as const) {
      const calls: { command: string; args: Record<string, unknown> | undefined }[] = [],
        helper = new SpeechHelper({
          desktop: true,
          synthesis: {
            cancel() {},
            speak() {
              assert.fail('native errors must not switch speech providers');
            },
          },
          invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === 'speech_start') throw failure;
          },
        });
      await assert.rejects(
        helper.speak('Private message text', language),
        (error) =>
          errorCode(error) === 'speech-output-unavailable' &&
          errorMessage(error) === speechMessages[language].outputUnavailable &&
          !/private|HRESULT|0x2|ps1/i.test(errorMessage(error)),
      );
      assert.deepEqual(
        calls.map((call) => call.command),
        ['speech_stop', 'speech_start'],
      );
      assert.deepEqual(defined(defined(calls[1]).args), {
        mode: 'speak',
        language,
        text: 'Private message text',
      });
    }
});

test('unknown read-aloud errors never expose diagnostics, paths or message text and do not retry', async () => {
  for (const language of ['en', 'zh'] as const)
    for (const phase of ['speech_stop', 'speech_start'])
      for (const failure of [
        Error('C:\\private\\speech.ps1 Secret message text'),
        { code: 'unexpected-native-code', message: 'Private device and Secret message text' },
        'raw exception and Secret message text',
      ]) {
        const calls: string[] = [],
          helper = new SpeechHelper({
            desktop: true,
            invoke: async (command) => {
              calls.push(command);
              if (command === phase) throw failure;
            },
          });
        await assert.rejects(
          helper.speak('Secret message text', language),
          (error) =>
            errorCode(error) === 'read-failed' &&
            errorMessage(error) === speechMessages[language].readFailed &&
            !/private|Secret|ps1|exception|unexpected/i.test(errorMessage(error)),
        );
        assert.deepEqual(
          calls,
          phase === 'speech_stop' ? ['speech_stop'] : ['speech_stop', 'speech_start'],
        );
      }
});

test('native cancellation stays localized and late read-aloud completions cannot survive a stop', async () => {
  for (const language of ['en', 'zh'] as const) {
    for (const failure of [
      'speech-cancelled',
      'Speech cancelled',
      Object.assign(Error('Private cancelled details'), { code: 'speech-cancelled' }),
    ]) {
      const helper = new SpeechHelper({
        desktop: true,
        invoke: async (command) => {
          if (command === 'speech_start') throw failure;
        },
      });
      await assert.rejects(
        helper.speak('Do not repeat', language),
        (error) =>
          errorCode(error) === 'speech-cancelled' &&
          errorMessage(error) === speechMessages[language].cancelled,
      );
    }
    for (const lateFailure of [false, true]) {
      let finish: (() => void) | undefined, start: (() => void) | undefined;
      const started = new Promise<void>((resolve) => (start = resolve)),
        calls: string[] = [],
        helper = new SpeechHelper({
          desktop: true,
          invoke: (command) => {
            calls.push(command);
            if (command === 'speech_start') {
              defined(start)();
              return new Promise<string>(
                (resolve, reject) =>
                  (finish = () =>
                    lateFailure ? reject(Error('Private late audio device failure')) : resolve('')),
              );
            }
            return Promise.resolve();
          },
        });
      const speech = helper.speak('Never replay this request', language);
      await started;
      await helper.stop();
      defined(finish)();
      await assert.rejects(
        speech,
        (error) =>
          errorCode(error) === 'speech-cancelled' &&
          errorMessage(error) === speechMessages[language].cancelled,
      );
      assert.deepEqual(calls, ['speech_stop', 'speech_start', 'speech_stop']);
    }
  }
});

test('browser read-aloud events and synchronous failures also use safe text while cancellation remains distinct', async () => {
  for (const language of ['en', 'zh'] as const)
    for (const mode of ['event', 'throw', 'cancel']) {
      class Utterance {
        text: string;
        lang = '';
        voice: SpeechSynthesisVoice | null = null;
        onend: (() => void) | null = null;
        onerror: ((event: { error: string }) => void) | null = null;
        constructor(text: string) {
          this.text = text;
        }
      }
      let helper;
      const synthesis = {
        cancel() {},
        getVoices: () => [],
        speak: (utterance: Utterance) => {
          if (mode === 'throw') throw Error('Private browser output details');
          queueMicrotask(() =>
            defined(utterance.onerror)({
              error: mode === 'cancel' ? 'interrupted' : 'private-device-error',
            }),
          );
        },
      };
      helper = new SpeechHelper({ desktop: false, synthesis, Utterance });
      await assert.rejects(
        helper.speak('Private original words', language),
        (error) =>
          errorCode(error) === (mode === 'cancel' ? 'speech-cancelled' : 'read-failed') &&
          errorMessage(error) ===
            speechMessages[language][mode === 'cancel' ? 'cancelled' : 'readFailed'],
      );
    }
});

test('native dictation keeps localized stable input and language failures without exposing native diagnostics', async () => {
  for (const language of ['en', 'zh'] as const)
    for (const [failure, key, code] of [
      ['speech-language-unavailable', 'languageUnsupported', 'speech-language-unavailable'],
      ['speech-input-unavailable', 'microphoneUnavailable', 'speech-input-unavailable'],
      ['speech-cancelled', 'cancelled', 'speech-cancelled'],
      ['Speech cancelled', 'cancelled', 'speech-cancelled'],
      ['speech-unavailable', 'dictationFailed', 'dictation-failed'],
      [Error('Private C:\\speech.ps1 audio diagnostic'), 'dictationFailed', 'dictation-failed'],
    ] as const) {
      const calls: { command: string; args: Record<string, unknown> | undefined }[] = [],
        helper = new SpeechHelper({
          desktop: true,
          invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === 'speech_start') throw failure;
          },
        });
      await assert.rejects(
        helper.dictate(language),
        (error) =>
          errorCode(error) === code &&
          errorMessage(error) === speechMessages[language][key] &&
          !/Private|ps1|diagnostic/.test(errorMessage(error)),
      );
      assert.deepEqual(
        calls.map((call) => call.command),
        ['speech_stop', 'speech_start'],
      );
      assert.deepEqual(defined(defined(calls[1]).args), {
        mode: 'recognize',
        language,
        text: null,
      });
    }
  for (const language of ['en', 'zh'] as const) {
    let finish: (() => void) | undefined, start: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (start = resolve)),
      calls: string[] = [],
      helper = new SpeechHelper({
        desktop: true,
        invoke: (command) => {
          calls.push(command);
          if (command === 'speech_start') {
            defined(start)();
            return new Promise<string>(
              (resolve) => (finish = () => resolve('Stale private transcript')),
            );
          }
          return Promise.resolve();
        },
      }),
      operation = helper.dictate(language);
    await started;
    await helper.stop();
    defined(finish)();
    await assert.rejects(
      operation,
      (error) =>
        errorCode(error) === 'speech-cancelled' &&
        errorMessage(error) === speechMessages[language].cancelled,
    );
    assert.deepEqual(calls, ['speech_stop', 'speech_start', 'speech_stop']);
  }
});
