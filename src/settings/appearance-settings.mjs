// Shared by the local Controller and browser; no VM state or credentials belong here.
export const appearanceDefaults = Object.freeze({
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
export const appearanceKeys = Object.freeze(Object.keys(appearanceDefaults));
const choices = {
  theme: ['system', 'light', 'dark'],
  themePreset: ['dant', 'chatgpt', 'warm', 'custom'],
  font: ['system', 'sans', 'mono'],
  reduceMotion: ['system', 'reduce', 'full'],
};
const ranges = { fontSize: [12, 18], contentFontSize: [12, 24], codeFontSize: [11, 22] };
function valueFor(key, value) {
  if (choices[key]) {
    if (choices[key].includes(value)) return value;
  } else if (ranges[key]) {
    const [min, max] = ranges[key];
    if (Number.isInteger(value) && value >= min && value <= max) return value;
  } else if (key.endsWith('Color')) {
    if (value === null) return null;
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
  } else if (
    key === 'fontFamily' &&
    typeof value === 'string' &&
    value.length <= 128 &&
    !/[\x00-\x1f\x7f;{}"'\\]/.test(value)
  )
    return value.trim();
  throw Object.assign(Error('Invalid appearance preference: ' + key), { status: 400 });
}
export function readAppearance(values = {}) {
  const result = { ...appearanceDefaults };
  if (!values || typeof values !== 'object' || Array.isArray(values)) return result;
  for (const key of appearanceKeys)
    if (values[key] !== undefined)
      try {
        result[key] = valueFor(key, values[key]);
      } catch {}
  return result;
}
export function validateAppearancePatch(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw Object.assign(Error('Invalid appearance preferences'), { status: 400 });
  const result = {};
  for (const key of appearanceKeys)
    if (values[key] !== undefined) result[key] = valueFor(key, values[key]);
  return result;
}
export function exportAppearance(values) {
  return JSON.stringify(
    { schema: 'dant-appearance', version: 1, appearance: readAppearance(values) },
    null,
    2,
  );
}
export function importAppearance(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 64 * 1024)
    throw Error('Appearance file must be at most 64 KiB');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Error('Appearance file is not valid JSON');
  }
  if (
    !value ||
    value.schema !== 'dant-appearance' ||
    value.version !== 1 ||
    !value.appearance ||
    typeof value.appearance !== 'object' ||
    Array.isArray(value.appearance) ||
    Object.keys(value).some((key) => !['schema', 'version', 'appearance'].includes(key)) ||
    Object.keys(value.appearance).some((key) => !appearanceKeys.includes(key))
  )
    throw Error('Unsupported appearance file');
  return validateAppearancePatch(value.appearance);
}
