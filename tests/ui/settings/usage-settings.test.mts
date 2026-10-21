import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { renderUsageSettings } from '../../../ui/settings/usage-settings.mts';
import { createSettingsNavigation } from '../../../ui/settings/settings-navigation.mts';

const counts = {
  inputTokens: 1000,
  cachedInputTokens: 300,
  outputTokens: 200,
  reasoningOutputTokens: 80,
  totalTokens: 1200,
};
test('usage settings distinguish no report, real zero and unreported fields in both languages', () => {
  for (const language of ['en', 'zh']) {
    const empty = parseHTML(
      '<html><body>' + renderUsageSettings({ language }) + '</body></html>',
    ).document;
    assert.equal(empty.querySelectorAll<HTMLButtonElement>('[data-usage-field]').length, 0);
    assert.match(empty.body.textContent, language === 'zh' ? /尚未收到 Token/ : /No token usage/);
    const usage = {
        subscription: {
          available: true,
          totals: {
            ...counts,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
          },
          lastResponse: { ...counts, at: 1000 },
        },
        apiVoice: {
          available: true,
          totals: { ...counts, cachedInputTokens: null },
          lastResponse: { ...counts, cachedInputTokens: null, at: 1000 },
        },
      },
      document = parseHTML(
        '<html><body>' + renderUsageSettings({ usage, language, cached: true }) + '</body></html>',
      ).document;
    assert.equal(
      defined(
        document.querySelector(
          '[data-usage-provider="subscription"] [data-usage-field="inputTokens"]',
        ),
      ).textContent,
      '0',
    );
    assert.match(
      defined(
        document.querySelector(
          '[data-usage-provider="apiVoice"] [data-usage-field="cachedInputTokens"]',
        ),
      ).textContent,
      language === 'zh' ? /暂无数据/ : /Unavailable/,
    );
    assert.match(document.body.textContent, language === 'zh' ? /保存的统计/ : /Saved statistics/);
    assert.match(
      document.body.textContent,
      language === 'zh' ? /最近一次模型响应/ : /Latest model response/,
    );
  }
});
test('the Usage category is searchable in English and Chinese without loading account data', () => {
  for (const query of ['token statistics', '用量统计', '缓存']) {
    const { document, Event } = parseHTML('<main></main>');
    let navigation: ReturnType<typeof createSettingsNavigation>;
    const render = () => {
      defined(document.querySelector<HTMLElement>('main')).innerHTML = navigation.render({
        usage: () => renderUsageSettings(),
      });
      navigation.bind();
    };
    navigation = createSettingsNavigation({ document, onChange: render });
    render();
    navigation.sync(true);
    const input = document.querySelector<HTMLInputElement>('#settings-search');
    defined(input).value = query;
    defined(input).dispatchEvent(new Event('input'));
    const result = document.querySelector<HTMLButtonElement>('[data-settings-result="usage"]');
    assert.ok(result, query);
    result.click();
    assert.equal(navigation.category, 'usage');
    assert.equal(
      defined(document.querySelector<HTMLButtonElement>('[data-settings-panel="usage"]')).hidden,
      false,
    );
  }
});
