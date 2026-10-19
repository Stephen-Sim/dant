export interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}
export interface RecognitionResult extends ArrayLike<RecognitionAlternative> {
  isFinal: boolean;
}
export interface RecognitionResults extends ArrayLike<RecognitionResult> {}
export interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: RecognitionResults }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
export type RecognitionConstructor = new () => BrowserRecognition;
