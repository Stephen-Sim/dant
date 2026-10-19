import { isRecord } from '../shared/contracts.mts';
import type { NativeInvoke } from './transport.mts';
import type { BrowserRecognition, RecognitionConstructor } from './speech-types.ts';
interface SpeechUtterance {
  text: string;
  lang: string;
  voice: SpeechSynthesisVoice | null;
  onend: ((event: never) => unknown) | null;
  onerror: ((event: never) => unknown) | null;
}
interface SpeechOutput {
  getVoices?(): SpeechSynthesisVoice[];
  speak(utterance: SpeechUtterance): void;
  cancel(): void;
}
type UtteranceConstructor = new (text: string) => SpeechUtterance;
interface SpeechOptions {
  desktop?: boolean;
  invoke?: NativeInvoke;
  recognizer?: RecognitionConstructor | null;
  synthesis?: SpeechOutput | null;
  Utterance?: UtteranceConstructor;
}
const READ_ALOUD_TEXT_LIMIT = 10_000;
import { localizeMessages } from '../../src/i18n/i18n.mts';
import { languageInfo } from '../../src/i18n/languages.mts';
export const speechMessages = {
  zh: {
    cancelled: '语音辅助已停止。',
    dictationUnsupported: '当前浏览器不支持听写，请使用 Windows 桌面版。',
    permissionDenied: '麦克风权限未获准，请在系统或浏览器设置中允许使用麦克风。',
    dictationFailed: '听写失败',
    noSpeech: '没有听到语音，请重试。',
    microphoneUnavailable: '无法读取麦克风，请检查设备连接或占用情况。',
    languageUnsupported: '当前听写语言不可用，请检查语音识别语言设置。',
    recognitionNetwork: '听写服务连接失败，请检查网络或使用 Windows 桌面版。',
    readUnsupported: '当前浏览器不支持朗读，请使用 Windows 桌面版。',
    readFailed: '朗读失败',
    outputUnavailable: '',
  },
  en: {
    cancelled: 'Speech helper stopped.',
    dictationUnsupported: 'Dictation is not supported in this browser. Use the Windows app.',
    permissionDenied:
      'Microphone permission was not granted. Allow it in system or browser settings.',
    dictationFailed: 'Dictation failed',
    noSpeech: 'No speech was heard. Please try again.',
    microphoneUnavailable:
      'The microphone could not be read. Check the device connection or whether it is in use.',
    languageUnsupported:
      'The dictation language is unavailable. Check the speech recognition language settings.',
    recognitionNetwork:
      'The dictation service could not connect. Check the network or use the Windows app.',
    readUnsupported: 'Read aloud is not supported in this browser. Use the Windows app.',
    readFailed: 'Read aloud failed',
    outputUnavailable: '',
  },
};
Object.assign(speechMessages.zh, {
  outputUnavailable: '无法打开播放设备，请检查Windows声音输出后重试。',
  readFailed: '朗读失败，请重试。',
});
Object.assign(speechMessages.en, {
  outputUnavailable:
    'The playback device could not be opened. Check Windows sound output and try again.',
  readFailed: 'Read aloud failed. Please try again.',
});
Object.assign(speechMessages.zh, {
  languageUnsupported: '尚未安装所选语音语言，请在 Windows 语音设置中添加。',
});
Object.assign(speechMessages.en, {
  languageUnsupported:
    'The selected speech language is not installed. Add it in Windows Speech settings.',
});
const speechText = (language: unknown, key: keyof typeof speechMessages.en) =>
  localizeMessages(speechMessages, language)[key];
const cancelled = (language: unknown) =>
  Object.assign(new Error(speechText(language, 'cancelled')), { code: 'speech-cancelled' });
const speechErrorCode = (error: unknown): string =>
  isRecord(error) && typeof error.code === 'string'
    ? error.code
    : typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : isRecord(error) && typeof error.message === 'string'
          ? error.message
          : '';
function readError(error: unknown, language: unknown) {
  const value = speechErrorCode(error),
    message =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : isRecord(error) && typeof error.message === 'string'
            ? error.message
            : '';
  if (value === 'speech-cancelled' || /^Speech cancell?ed\.?$/i.test(value))
    return cancelled(language);
  if (value === 'speech-language-unavailable')
    return Object.assign(Error(speechText(language, 'languageUnsupported')), {
      code: 'speech-language-unavailable',
    });
  if (
    value === 'speech-output-unavailable' ||
    message === 'speech-output-unavailable' ||
    /Audio device error encountered[\s\S]*\b0x0*2\b/i.test(message)
  )
    return Object.assign(Error(speechText(language, 'outputUnavailable')), {
      code: 'speech-output-unavailable',
    });
  return Object.assign(Error(speechText(language, 'readFailed')), { code: 'read-failed' });
}
function dictationError(error: unknown, language: unknown) {
  const code = speechErrorCode(error);
  if (code === 'speech-cancelled' || /^Speech cancell?ed\.?$/i.test(code))
    return cancelled(language);
  if (code === 'speech-language-unavailable' || code === 'speech-input-unavailable')
    return Object.assign(
      Error(
        speechText(
          language,
          code === 'speech-language-unavailable' ? 'languageUnsupported' : 'microphoneUnavailable',
        ),
      ),
      { code },
    );
  return Object.assign(Error(speechText(language, 'dictationFailed')), {
    code: 'dictation-failed',
  });
}
export class SpeechHelper {
  readonly desktop: boolean;
  readonly invoke: NativeInvoke | undefined;
  readonly Recognizer: RecognitionConstructor | null | undefined;
  readonly synthesis: SpeechOutput | null | undefined;
  readonly Utterance: UtteranceConstructor | undefined;
  generation = 0;
  recognition: BrowserRecognition | null = null;
  cancelRecognition: (() => void) | null = null;
  constructor({
    desktop = !!globalThis.window?.__TAURI_INTERNALS__,
    invoke,
    recognizer = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
    synthesis = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
  }: SpeechOptions = {}) {
    this.desktop = desktop;
    this.invoke = invoke;
    this.Recognizer = recognizer;
    this.synthesis = synthesis;
    this.Utterance = Utterance;
    this.generation = 0;
  }
  async native(command: string, args: Record<string, unknown>): Promise<unknown> {
    const invoke = this.invoke || (await import('@tauri-apps/api/core')).invoke;
    return invoke(command, args);
  }
  async dictate(language = 'zh'): Promise<string> {
    const generation = this.generation + 1;
    if (this.desktop) {
      try {
        await this.stop();
        if (generation !== this.generation) throw cancelled(language);
        const result = await this.native('speech_start', {
          mode: 'recognize',
          language,
          text: null,
        });
        if (generation !== this.generation) throw cancelled(language);
        if (typeof result !== 'string') throw Error('Invalid dictation response.');
        return result;
      } catch (error) {
        throw generation !== this.generation
          ? cancelled(language)
          : dictationError(error, language);
      }
    }
    await this.stop();
    if (generation !== this.generation) throw cancelled(language);
    if (!this.Recognizer) throw Error(speechText(language, 'dictationUnsupported'));
    return new Promise<string>((resolve, reject) => {
      const Recognizer = this.Recognizer;
      if (!Recognizer) throw Error(speechText(language, 'dictationUnsupported'));
      const recognition = new Recognizer();
      this.recognition = recognition;
      recognition.lang = languageInfo(language).speech;
      recognition.continuous = false;
      recognition.interimResults = false;
      let text = '',
        error: Error | undefined;
      this.cancelRecognition = () => {
        error = cancelled(language);
        recognition.abort();
      };
      recognition.onresult = (event) => {
        text = Array.from(event.results || [])
          .filter((result) => result.isFinal)
          .map((result) => result[0]?.transcript || '')
          .join(' ');
      };
      recognition.onerror = (event) => {
        const known: Readonly<Partial<Record<string, keyof typeof speechMessages.en>>> = {
          'not-allowed': 'permissionDenied',
          'service-not-allowed': 'permissionDenied',
          'no-speech': 'noSpeech',
          'audio-capture': 'microphoneUnavailable',
          'language-not-supported': 'languageUnsupported',
          network: 'recognitionNetwork',
        };
        error = Error(
          known[event.error]
            ? speechText(language, known[event.error] ?? 'dictationFailed')
            : speechText(language, 'dictationFailed') + ': ' + event.error,
        );
      };
      recognition.onend = () => {
        if (this.recognition === recognition) {
          this.recognition = null;
          this.cancelRecognition = null;
        }
        if (generation !== this.generation) reject(cancelled(language));
        else if (error) reject(error);
        else resolve(text);
      };
      try {
        recognition.start();
      } catch (error) {
        this.recognition = null;
        this.cancelRecognition = null;
        reject(error);
      }
    });
  }
  async speak(text: unknown, language = 'zh'): Promise<unknown> {
    if (typeof text !== 'string' || !text.trim()) return;
    const generation = this.generation + 1;
    try {
      await this.stop();
      if (generation !== this.generation) throw cancelled(language);
    } catch (error) {
      throw generation !== this.generation ? cancelled(language) : readError(error, language);
    }
    if (this.desktop) {
      try {
        const result = await this.native('speech_start', {
          mode: 'speak',
          language,
          text: text.slice(0, READ_ALOUD_TEXT_LIMIT),
        });
        if (generation !== this.generation) throw cancelled(language);
        return result;
      } catch (error) {
        throw generation !== this.generation ? cancelled(language) : readError(error, language);
      }
    }
    if (!this.synthesis || !this.Utterance) throw Error(speechText(language, 'readUnsupported'));
    try {
      return await new Promise<void>((resolve, reject) => {
        const Utterance = this.Utterance;
        if (!Utterance) throw Error(speechText(language, 'readUnsupported'));
        const utterance = new Utterance(text.slice(0, READ_ALOUD_TEXT_LIMIT));
        utterance.lang = languageInfo(language).speech;
        const output = this.synthesis;
        if (!output?.getVoices) throw Error('Speech voices unavailable');
        const voice = output
          .getVoices()
          .find((voice) => voice.lang.toLowerCase() === utterance.lang.toLowerCase());
        if (voice) utterance.voice = voice;
        utterance.onend = () =>
          generation === this.generation ? resolve() : reject(cancelled(language));
        utterance.onerror = (event: { error?: unknown }) =>
          reject(
            event.error === 'canceled' || event.error === 'interrupted'
              ? cancelled(language)
              : readError(
                  event.error === 'language-unavailable' || event.error === 'voice-unavailable'
                    ? 'speech-language-unavailable'
                    : event,
                  language,
                ),
          );
        output.speak(utterance);
      });
    } catch (error) {
      throw generation !== this.generation ? cancelled(language) : readError(error, language);
    }
  }
  async stop() {
    this.generation++;
    this.cancelRecognition?.();
    this.synthesis?.cancel();
    if (this.desktop) await this.native('speech_stop', {});
  }
}
