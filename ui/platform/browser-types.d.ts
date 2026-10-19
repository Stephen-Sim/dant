import type { RecognitionConstructor } from './speech-types.ts';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
  var SpeechRecognition: RecognitionConstructor | undefined;
  var webkitSpeechRecognition: RecognitionConstructor | undefined;
}
