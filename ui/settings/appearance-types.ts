export interface Appearance {
  theme: 'system' | 'light' | 'dark';
  themePreset: 'dant' | 'chatgpt' | 'warm' | 'custom';
  accentColor: string | null;
  backgroundColor: string | null;
  foregroundColor: string | null;
  font: 'system' | 'sans' | 'mono';
  fontFamily: string;
  fontSize: number;
  contentFontSize: number;
  codeFontSize: number;
  reduceMotion: 'system' | 'reduce' | 'full';
}

export type AppearanceKey = keyof Appearance;
export type AppearancePatch = Partial<Appearance>;
