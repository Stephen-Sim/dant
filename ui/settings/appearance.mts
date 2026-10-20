import { isRecord } from '../shared/contracts.mts';
import {
  appearanceDefaults,
  appearanceKeys,
  readAppearance,
  validateAppearancePatch,
  exportAppearance,
  importAppearance,
} from './appearance-preferences.mts';
import type { Appearance, AppearancePatch } from './appearance-types.ts';
import type { Cleanup } from '../shared/contracts.mts';
export {
  appearanceDefaults,
  appearanceKeys,
  validateAppearancePatch,
  exportAppearance,
  importAppearance,
};
export const normalizeAppearance = readAppearance;
export const fontFamilies = Object.freeze({
  system:
    'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  sans: 'Inter, Arial, "Noto Sans", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  mono: '"Cascadia Code", Consolas, "SFMono-Regular", "Noto Sans Mono CJK SC", "Microsoft YaHei UI", "Microsoft YaHei", monospace',
});
const palettes = {
  dant: { light: ['#FFFFFF', '#262626', '#3468FF'], dark: ['#1B1D22', '#E3E5E9', '#7AA2FF'] },
  chatgpt: { light: ['#FFFFFF', '#1A1C1F', '#3468FF'], dark: ['#212121', '#ECECEC', '#7AA2FF'] },
  warm: { light: ['#FAF8F4', '#37312B', '#A46C32'], dark: ['#24201C', '#EEE4D7', '#DBAC73'] },
} as const;
export function resolveAppearance(values: unknown, { dark = false, reduced = false } = {}) {
  const preferences = readAppearance(values),
    theme = preferences.theme === 'system' ? (dark ? 'dark' : 'light') : preferences.theme;
  const [background, foreground, accent] = (
    preferences.themePreset === 'custom' ? palettes.chatgpt : palettes[preferences.themePreset]
  )[theme];
  return {
    theme,
    motion:
      preferences.reduceMotion === 'system'
        ? reduced
          ? 'reduce'
          : 'full'
        : preferences.reduceMotion,
    background: preferences.backgroundColor || background,
    foreground: preferences.foregroundColor || foreground,
    accent: preferences.accentColor || accent,
    fontFamily:
      (preferences.fontFamily ? JSON.stringify(preferences.fontFamily) + ', ' : '') +
      fontFamilies[preferences.font],
  };
}
interface AppearanceMedia {
  matches: boolean;
  addEventListener?: (name: 'change', listener: () => void) => void;
  removeEventListener?: (name: 'change', listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}
interface AppearanceDocument {
  documentElement: {
    dataset: DOMStringMap;
    style: Pick<CSSStyleDeclaration, 'setProperty' | 'colorScheme'>;
  };
}
interface AppearanceStorage {
  getItem(key: string): string | null | undefined;
  setItem(key: string, value: string): unknown;
}
export function createAppearance({
  document = globalThis.document,
  storage = globalThis.localStorage,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  save = async () => {},
  setNativeTheme,
}: {
  document?: AppearanceDocument | null;
  storage?: AppearanceStorage | null;
  matchMedia?: ((query: string) => AppearanceMedia | null) | null;
  save?: (values: AppearancePatch) => Promise<unknown>;
  setNativeTheme?: (theme: 'light' | 'dark' | null) => unknown;
} = {}) {
  let saved: unknown;
  try {
    saved = JSON.parse(storage?.getItem('dant.appearance') || 'null');
  } catch {}
  let confirmed = readAppearance(saved || {}),
    current = { ...confirmed },
    chain: Promise<unknown> = Promise.resolve(),
    nativeTheme: Appearance['theme'] | undefined;
  const pending: { patch: AppearancePatch }[] = [];
  const colorMedia = matchMedia?.('(prefers-color-scheme: dark)'),
    motionMedia = matchMedia?.('(prefers-reduced-motion: reduce)');
  function paint() {
    const root = document?.documentElement;
    if (!root) return;
    const resolved = resolveAppearance(current, {
      dark: colorMedia?.matches ?? false,
      reduced: motionMedia?.matches ?? false,
    });
    Object.assign(root.dataset, {
      theme: resolved.theme,
      themePreference: current.theme,
      themePreset: current.themePreset,
      font: current.font,
      reducedMotion: resolved.motion,
    });
    root.style.colorScheme = resolved.theme;
    for (const [key, value] of Object.entries({
      '--app-font-family': resolved.fontFamily,
      '--app-font-size': current.fontSize + 'px',
      '--content-font-size': current.contentFontSize + 'px',
      '--code-font-size': current.codeFontSize + 'px',
      '--appearance-background': resolved.background,
      '--appearance-foreground': resolved.foreground,
      '--accent-color': resolved.accent,
    }))
      root.style.setProperty(key, value);
    if (setNativeTheme && nativeTheme !== current.theme) {
      const selected = current.theme;
      nativeTheme = selected;
      Promise.resolve()
        .then(() => setNativeTheme(selected === 'system' ? null : selected))
        .catch(() => {});
    }
  }
  function project() {
    current = readAppearance(Object.assign({}, confirmed, ...pending.map((item) => item.patch)));
    try {
      storage?.setItem('dant.appearance', JSON.stringify(current));
    } catch {}
    paint();
  }
  const onSystemChange = () => paint();
  const cleanups: Cleanup[] = [];
  for (const media of [colorMedia, motionMedia]) {
    if (media?.addEventListener) {
      media.addEventListener('change', onSystemChange);
      cleanups.push(() => media.removeEventListener?.('change', onSystemChange));
    } else if (media?.addListener) {
      media.addListener(onSystemChange);
      cleanups.push(() => media.removeListener?.(onSystemChange));
    }
  }
  paint();
  return {
    get preferences() {
      return { ...current };
    },
    get saving() {
      return pending.length > 0;
    },
    sync(input: unknown = {}) {
      const values = isRecord(input) ? input : {};
      if (!pending.length) {
        const selected = Object.fromEntries(
          appearanceKeys
            .filter((key) => values[key] !== undefined)
            .map((key) => [key, values[key]]),
        );
        confirmed = readAppearance({ ...confirmed, ...selected });
        project();
      }
      return { ...current };
    },
    update(values: unknown) {
      let patch;
      try {
        patch = validateAppearancePatch(values);
      } catch (error) {
        return Promise.reject(error);
      }
      if (!Object.keys(patch).length) return Promise.resolve({ ...current });
      const job = { patch };
      pending.push(job);
      project();
      const operation = chain.then(async () => {
        try {
          await save(patch);
          confirmed = readAppearance({ ...confirmed, ...patch });
        } finally {
          pending.splice(pending.indexOf(job), 1);
          project();
        }
        return { ...current };
      });
      chain = operation.catch(() => {});
      return operation;
    },
    dispose() {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
