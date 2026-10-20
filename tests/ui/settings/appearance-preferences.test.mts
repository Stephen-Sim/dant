import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appearanceDefaults,
  appearanceKeys,
  readAppearance,
  validateAppearancePatch,
  exportAppearance,
  importAppearance,
} from '../../../ui/settings/appearance-preferences.mts';
import { observedRecord } from '../../support/service-fixtures.mts';
import { errorMessage } from '../../../ui/shared/json.mts';
test('appearance validation is strict for patches and tolerant per field on disk', () => {
  assert.deepEqual(readAppearance(null), appearanceDefaults);
  assert.deepEqual(readAppearance([]), appearanceDefaults);
  assert.deepEqual(
    readAppearance({ theme: 'broken', fontSize: 18, accentColor: '#aabbcc', language: 'zh' }),
    { ...appearanceDefaults, fontSize: 18, accentColor: '#AABBCC' },
  );
  assert.deepEqual(
    validateAppearancePatch({ language: 'en', themePreset: 'warm', fontFamily: ' 微软雅黑 ' }),
    { themePreset: 'warm', fontFamily: '微软雅黑' },
  );
  const bad = {
    theme: ['blue', null],
    themePreset: ['other', 42],
    font: ['serif', null],
    reduceMotion: ['yes', true],
    fontSize: [11, 19, 13.5, '14'],
    contentFontSize: [11, 25],
    codeFontSize: [10, 23],
    accentColor: ['red', '#fff', 'url(x)', 42],
    backgroundColor: ['#1234567'],
    foregroundColor: ['transparent'],
    fontFamily: ['x; color:red', '"Arial"', 'x\\y', 'x\u0000y', 'x'.repeat(129), 42],
  };
  for (const [key, values] of Object.entries(bad))
    for (const value of values)
      assert.throws(
        () => validateAppearancePatch({ [key]: value }),
        (error) => observedRecord(error).status === 400 && errorMessage(error).includes(key),
      );
  for (const value of [null, [], 42])
    assert.throws(() => validateAppearancePatch(value), { status: 400 });
  for (const fontSize of [12, 18])
    assert.equal(validateAppearancePatch({ fontSize }).fontSize, fontSize);
  for (const contentFontSize of [12, 24])
    assert.equal(validateAppearancePatch({ contentFontSize }).contentFontSize, contentFontSize);
  for (const codeFontSize of [11, 22])
    assert.equal(validateAppearancePatch({ codeFontSize }).codeFontSize, codeFontSize);
  assert.equal(validateAppearancePatch({ fontFamily: '', accentColor: null }).accentColor, null);
  assert.equal(appearanceKeys.length, Object.keys(appearanceDefaults).length);
});

test('theme export is a portable whitelist and import rejects foreign or excessive data', () => {
  const saved = {
    ...appearanceDefaults,
    theme: 'dark',
    fontFamily: 'Arial',
    backgroundColor: '#abcdef',
    secret: 'never-export',
    language: 'zh',
  };
  const text = exportAppearance(saved);
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('language'), false);
  assert.equal(importAppearance(text).backgroundColor, '#ABCDEF');
  const document = JSON.parse(text);
  assert.equal(document.schema, 'dant-appearance');
  assert.equal(
    importAppearance(
      JSON.stringify({ schema: 'dant-appearance', version: 1, appearance: { fontSize: 14 } }),
    ).fontSize,
    14,
  );
  for (const value of [
    'not-json',
    null,
    '中'.repeat(22000),
    JSON.stringify(null),
    JSON.stringify([]),
    JSON.stringify({ ...document, version: 2 }),
    JSON.stringify({ ...document, auth: 'no' }),
    JSON.stringify({ ...document, appearance: [] }),
    JSON.stringify({ ...document, appearance: { vmHost: 'no' } }),
  ])
    assert.throws(() => importAppearance(value));
  assert.throws(
    () => importAppearance(JSON.stringify({ ...document, appearance: { fontSize: 500 } })),
    /Invalid appearance/,
  );
});
