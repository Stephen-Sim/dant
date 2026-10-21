import type { Appearance, AppearanceKey, AppearancePatch } from './appearance-types.ts';
// Shared by the local Controller and browser; no VM state or credentials belong here.
export const appearanceDefaults = Object.freeze<Appearance>({
  theme: 'system',
  themePreset: 'chatgpt',
  accentColor: null,
  backgroundColor: null,
  foregroundColor: null,
  font: 'system',
  fontFamily: '',
  fontSize: 13,
  contentFontSize: 14,
  codeFontSize: 13,
  reduceMotion: 'system',
});
export const appearanceKeys = Object.freeze(Object.keys(appearanceDefaults) as AppearanceKey[]);
const choices = {
  theme: ['system', 'light', 'dark'],
  themePreset: ['dant', 'chatgpt', 'warm', 'custom'],
  font: ['system', 'sans', 'mono'],
  reduceMotion: ['system', 'reduce', 'full'],
} as const;
export const appearanceFontRanges = Object.freeze({
  fontSize: Object.freeze([12, 18] as const),
  contentFontSize: Object.freeze([12, 24] as const),
  codeFontSize: Object.freeze([11, 22] as const),
});
const MAX_FONT_FAMILY_CHARACTERS = 128;
export const MAX_APPEARANCE_IMPORT_BYTES = 64 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function valueFor<Key extends AppearanceKey>(key: Key, value: unknown): Appearance[Key] {
  if (key in choices) {
    const accepted: readonly string[] = choices[key as keyof typeof choices];
    if (typeof value === 'string' && accepted.includes(value)) return value as Appearance[Key];
  } else if (key in appearanceFontRanges) {
    const [min, max] = appearanceFontRanges[key as keyof typeof appearanceFontRanges];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max)
      return value as Appearance[Key];
  } else if (key.endsWith('Color')) {
    if (value === null) return null as Appearance[Key];
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
      return value.toUpperCase() as Appearance[Key];
  } else if (
    key === 'fontFamily' &&
    typeof value === 'string' &&
    value.length <= MAX_FONT_FAMILY_CHARACTERS &&
    !/[\x00-\x1f\x7f;{}"'\\]/.test(value)
  )
    return value.trim() as Appearance[Key];
  throw Object.assign(Error('Invalid appearance preference: ' + key), { status: 400 });
}
export function readAppearance(values: unknown = {}): Appearance {
  const result = { ...appearanceDefaults };
  if (!record(values)) return result;
  for (const key of appearanceKeys)
    if (values[key] !== undefined)
      try {
        setPreference(result, key, values[key]);
      } catch {}
  return result;
}
export function validateAppearancePatch(values: unknown): AppearancePatch {
  if (!record(values))
    throw Object.assign(Error('Invalid appearance preferences'), { status: 400 });
  const result = {};
  for (const key of appearanceKeys)
    if (values[key] !== undefined) setPreference(result, key, values[key]);
  return result;
}
export function exportAppearance(values: unknown) {
  return JSON.stringify(
    { schema: 'dant-appearance', version: 1, appearance: readAppearance(values) },
    null,
    2,
  );
}
export function importAppearance(text: unknown) {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > MAX_APPEARANCE_IMPORT_BYTES
  )
    throw Error('Appearance file must be at most 64 KiB');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw Error('Appearance file is not valid JSON');
  }
  if (
    !record(value) ||
    value.schema !== 'dant-appearance' ||
    value.version !== 1 ||
    !record(value.appearance) ||
    Object.keys(value).some((key) => !['schema', 'version', 'appearance'].includes(key)) ||
    Object.keys(value.appearance).some(
      (key) => !appearanceKeys.some((accepted) => accepted === key),
    )
  )
    throw Error('Unsupported appearance file');
  return validateAppearancePatch(value.appearance);
}

function setPreference<Key extends AppearanceKey>(
  result: AppearancePatch,
  key: Key,
  value: unknown,
): void {
  result[key] = valueFor(key, value);
}
