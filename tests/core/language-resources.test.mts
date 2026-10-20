import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { languageResourceOutputs } from '../../scripts/core/generate-contracts.mts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dant-shared-languages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative: string, value: unknown) => {
    const file = path.join(root, 'resources/i18n', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value) + '\n');
  };
  write('language-registry.json', [
    { code: 'en' },
    { code: 'zh' },
    { code: 'ja' },
    { code: 'zh-TW' },
  ]);
  write('locales/ja.json', { Refresh: '更新' });
  write('locales/zh-TW.json', { Refresh: '重新整理' });
  return { root, write };
}

test('Go language resources retain canonical registry and catalog bytes for every non-base language', async (t) => {
  const f = fixture(t);
  const outputs = await languageResourceOutputs(f.root);
  assert.equal(outputs.length, 3);
  for (const [relative, contents] of outputs)
    assert.equal(
      contents,
      fs.readFileSync(
        path.join(f.root, 'resources/i18n', relative.replace('core/internal/i18n/', '')),
        'utf8',
      ),
    );
  f.write('locales/ja.json', { Refresh: '新しい翻訳' });
  assert.notDeepEqual(await languageResourceOutputs(f.root), outputs);
});

test('missing, extra, empty and unsafe language data cannot produce a partial embedded catalog', async (t) => {
  const f = fixture(t);
  f.write('locales/extra.json', { Refresh: 'extra' });
  await assert.rejects(languageResourceOutputs(f.root), /do not match/);
  fs.unlinkSync(path.join(f.root, 'resources/i18n/locales/extra.json'));
  f.write('locales/ja.json', { Refresh: '' });
  await assert.rejects(languageResourceOutputs(f.root), /Invalid shared language catalog/);
  for (const registry of [
    [{ code: '../outside' }],
    [{ code: 'en' }, { code: 'en' }],
    [{ code: 'en' }],
    null,
    [],
  ]) {
    f.write('language-registry.json', registry);
    await assert.rejects(languageResourceOutputs(f.root));
  }
});

test('maintained generated Go language bytes exactly match the canonical resources', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  for (const [relative, contents] of await languageResourceOutputs(root))
    assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), contents, relative);
});
