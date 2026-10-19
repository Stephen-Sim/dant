import type { SettingsCategory } from '../../../ui/settings/settings-navigation.mts';
import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { createSettingsNavigation } from '../../../ui/settings/settings-navigation.mts';

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
function fixture({ language = 'en' } = {}) {
  const { document, Event } = parseHTML('<main id="app"></main>'),
    app = document.querySelector<HTMLElement>('#app'),
    loads: SettingsCategory[] = [],
    errors: unknown[] = [],
    focus: HTMLElement[] = [],
    scroll: { node: HTMLElement; options: boolean | ScrollIntoViewOptions | undefined }[] = [];
  let host = '',
    fontOpen = false,
    voiceDisabled = false,
    handler: (category: SettingsCategory) => Promise<unknown> = async () => {};
  const ui = createSettingsNavigation({
    document,
    getLanguage: () => language,
    onChange: render,
    onCategory: async (category) => {
      loads.push(category);
      await handler(category);
    },
    onError: (error) => errors.push(error),
  });
  function sections() {
    return {
      general:
        '<section class="settings-section"><button data-language="zh">中文</button><input type="checkbox" id="notifications"><input type="checkbox" id="showWorkSummary"></section><section class="settings-section text-editor-settings"><button data-editor-choose>Choose editor</button></section>',
      appearance: `<section class="settings-section"><button data-theme="light">Light</button><details id="appearance-font-picker" ${fontOpen ? 'open' : ''}><summary>System font</summary><input id="font-local-search" value="Arial"></details><details id="appearance-advanced"><summary>Advanced</summary><input id="appearance-size" type="number" value="13"></details></section>`,
      voice: `<section class="settings-section"><input type="checkbox" id="showCallCaptions"><select id="nativeVoice" ${voiceDisabled ? 'disabled' : ''}><option>Ember</option></select><details><summary>API</summary><input type="password" id="voice-api-key"></details></section>`,
      computer: `<section class="settings-section vm-settings"><input id="vm-host-draft" value="${host}"></section><section class="settings-section vm-backups vm-backup-import" data-setting-card="backup-import">Import backup file</section>`,
      account:
        '<section class="settings-section" data-setting-card="account">private-account@example.test<select id="model"><option>Default</option></select></section>',
      credentials:
        '<section class="settings-section credentials-settings"><input type="password" id="private-vault">Private credential nickname</section>',
      history:
        '<section class="settings-section conversation-settings">Private conversation text<button data-action="memory">Memory</button></section><section class="settings-section vm-backups">Backups</section>',
      telegram:
        '<section class="settings-section telegram-settings"><input type="password" id="telegram-token"></section>',
      about:
        '<section class="settings-section"><strong data-app-version>1.0.0</strong><button data-check-updates>Check for updates</button></section>',
    };
  }
  function render() {
    const template = document.createElement('template');
    template.innerHTML = ui.render(sections());
    reconcile(defined(app), template.content);
    for (const node of document.querySelectorAll<HTMLElement>(
      'button,input,select,summary,[tabindex],.settings-section,[data-settings-panel]',
    )) {
      node.focus = () => focus.push(node);
      node.scrollIntoView = (options) => scroll.push({ node, options });
    }
    const hostInput = defined(document.querySelector<HTMLInputElement>('#vm-host-draft'));
    hostInput.oninput = () => {
      host = hostInput.value;
    };
    const picker = defined(document.querySelector<HTMLDetailsElement>('#appearance-font-picker'));
    picker.ontoggle = () => {
      fontOpen = picker.open;
    };
    ui.bind();
  }
  render();
  ui.sync(true);
  return {
    ui,
    document,
    Event,
    loads,
    errors,
    focus,
    scroll,
    render,
    disableVoice() {
      voiceDisabled = true;
      render();
    },
    set handler(value: (category: SettingsCategory) => Promise<unknown>) {
      handler = value;
    },
    set language(value: string) {
      language = value;
    },
    async click(selector: string) {
      const node = document.querySelector<HTMLSelectElement>(selector);
      assert.ok(node, selector);
      node.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
      await settle();
    },
    async search(value: string) {
      const input = document.querySelector<HTMLInputElement>('#settings-search');
      defined(input).value = value;
      defined(input).dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    },
    async key(selector: string, key: string, extra: Partial<KeyboardEvent> = {}) {
      const event = new Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, { key, ...extra });
      defined(document.querySelector<HTMLSelectElement>(selector)).dispatchEvent(event);
      await settle();
      return event;
    },
  };
}
const visiblePanels = (f: ReturnType<typeof fixture>) =>
  [...f.document.querySelectorAll<HTMLButtonElement>('[data-settings-panel]')]
    .filter((node) => !node.hidden)
    .map((node) => node.dataset.settingsPanel);

test('settings default to General, render a bilingual category menu, and load only the chosen category', async () => {
  for (const [language, labels] of [
    [
      'en',
      [
        'General',
        'Appearance',
        'Voice',
        'Work computer',
        'ChatGPT',
        'Usage',
        'Credentials',
        'Chat & data',
        'Telegram',
        'About dant',
      ],
    ],
    [
      'zh',
      [
        '通用',
        '外观',
        '语音',
        '工作电脑',
        'ChatGPT 账号',
        '用量统计',
        '凭据与密钥',
        '聊天与数据',
        'Telegram 集成',
        '关于 dant',
      ],
    ],
  ] as const) {
    const f = fixture({ language });
    await settle();
    assert.deepEqual(
      [...f.document.querySelectorAll<HTMLButtonElement>('[data-settings-category]')].map(
        (node) => node.textContent,
      ),
      labels,
    );
    assert.deepEqual(visiblePanels(f), ['general']);
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('[aria-current]')).dataset.settingsCategory,
      'general',
    );
    assert.deepEqual(f.loads, ['general']);
    assert.ok(f.document.querySelector<HTMLElement>('label[for="settings-search"]'));
    assert.equal(f.document.querySelector<HTMLElement>('#settings-search-hint'), null);
    assert.equal(
      defined(f.document.querySelector<HTMLInputElement>('#settings-search')).getAttribute(
        'aria-describedby',
      ),
      null,
    );
    assert.doesNotMatch(
      f.document.body.textContent,
      /Search setting names in English or Chinese|支持搜索中文或英文设置名称/,
    );
    await f.click('[data-settings-category="appearance"]');
    assert.deepEqual(visiblePanels(f), ['appearance']);
    assert.deepEqual(f.loads, ['general', 'appearance']);
    f.render();
    await settle();
    assert.deepEqual(f.loads, ['general', 'appearance']);
    assert.equal(f.ui.isVisible('about'), false);
  }
});

test('English and Chinese search find settings in every category without requiring its visible panel or network data', async () => {
  const f = fixture();
  await settle();
  for (const [query, result, category] of [
    ['font', 'font', 'appearance'],
    ['字体', 'font', 'appearance'],
    ['voice key', 'voice-key', 'voice'],
    ['captions', 'call-captions', 'voice'],
    ['字幕', 'call-captions', 'voice'],
    ['重连', 'connection', 'computer'],
    ['login', 'subscription', 'account'],
    ['密钥管理', 'vault', 'credentials'],
    ['清空', 'clear-history', 'history'],
    ['backup', 'backups', 'history'],
    ['恢复', 'backups', 'history'],
    ['import backup', 'backup-import', 'computer'],
    ['导入备份', 'backup-import', 'computer'],
    ['telegram bot', 'telegram-token', 'telegram'],
    ['version', 'version', 'about'],
    ['语言', 'language', 'general'],
  ] as const) {
    await f.search(query);
    const node = f.document.querySelector<HTMLButtonElement>(`[data-settings-result="${result}"]`);
    assert.ok(node, query);
    assert.ok(defined(node.querySelector<HTMLElement>('small')).textContent);
    assert.ok(defined(node.querySelector<HTMLElement>('strong')).textContent);
    assert.deepEqual(visiblePanels(f), []);
    await f.click(`[data-settings-result="${result}"]`);
    assert.equal(f.ui.category, category);
    assert.deepEqual(visiblePanels(f), [category]);
    assert.equal(defined(f.document.querySelector<HTMLInputElement>('#settings-search')).value, '');
  }
  assert.equal(f.errors.length, 0);
});

test('search result selection expands advanced details and focuses and scrolls the concrete setting control', async () => {
  const f = fixture();
  await f.search('UI font size');
  await f.click('[data-settings-result="ui-size"]');
  const input = f.document.querySelector<HTMLInputElement>('#appearance-size');
  assert.equal(
    defined(f.document.querySelector<HTMLDetailsElement>('#appearance-advanced')).open,
    true,
  );
  assert.equal(f.focus.at(-1), input);
  assert.equal(defined(f.scroll.at(-1)).node, input);
  assert.deepEqual(defined(f.scroll.at(-1)).options, { block: 'center' });
  assert.equal(f.ui.category, 'appearance');
});

test('backup search opens Chat & data and results have no separate numeric counter', async () => {
  const f = fixture();
  await f.search('backup');
  assert.equal(f.document.querySelector('.settings-result-count'), null);
  assert.equal(f.document.querySelector('#settings-results-title')?.textContent, 'Search results');
  assert.equal(
    f.document.querySelector('.settings-search-results > div')?.getAttribute('aria-live'),
    'polite',
  );
  await f.click('[data-settings-result="backups"]');
  assert.equal(f.ui.category, 'history');
  assert.deepEqual(visiblePanels(f), ['history']);
  assert.ok(f.document.querySelector('[data-settings-panel="history"] .vm-backups'));
  assert.equal(f.document.querySelector('[data-settings-panel="history"] .vm-backup-import'), null);
  assert.equal(f.focus.at(-1)?.classList.contains('vm-backups'), true);
});

test('backup import search opens its separate Work computer card without opening the backup list', async () => {
  const f = fixture();
  for (const query of ['import backup file', '导入备份文件']) {
    await f.search(query);
    await f.click('[data-settings-result="backup-import"]');
    assert.equal(f.ui.category, 'computer');
    assert.deepEqual(visiblePanels(f), ['computer']);
    assert.equal(f.focus.at(-1), f.document.querySelector('.vm-backup-import'));
    assert.equal(f.ui.isVisible('history'), false);
  }
});

test('English and Chinese editor searches reveal the fixed General setting without indexing a configured private path', async () => {
  const f = fixture();
  for (const query of ['VS Code', 'text editor', '编辑器', '记事本']) {
    await f.search(query);
    assert.ok(f.document.querySelector<HTMLButtonElement>('[data-settings-result="text-editor"]'));
    await f.click('[data-settings-result="text-editor"]');
    assert.equal(f.ui.category, 'general');
    assert.equal(
      defined(f.scroll.at(-1)).node,
      f.document.querySelector<HTMLElement>('.text-editor-settings'),
    );
  }
});

test('work summary search finds its General preference and focuses the actual checkbox in either language', async () => {
  const f = fixture();
  for (const query of ['work progress', 'show work', '任务进度', '隐藏']) {
    await f.search(query);
    assert.ok(f.document.querySelector<HTMLButtonElement>('[data-settings-result="work-summary"]'));
    await f.click('[data-settings-result="work-summary"]');
    assert.equal(f.ui.category, 'general');
    assert.equal(f.focus.at(-1), f.document.querySelector<HTMLInputElement>('#showWorkSummary'));
  }
});

test('category switches and settings search preserve real DOM nodes, unsaved VM and secret inputs, and an open font picker', async () => {
  const f = fixture();
  await f.click('[data-settings-category="computer"]');
  const host = f.document.querySelector<HTMLInputElement>('#vm-host-draft');
  defined(host).value = '192.0.2.123';
  defined(host).dispatchEvent(new f.Event('input', { bubbles: true }));
  const password = f.document.querySelector<HTMLInputElement>('#telegram-token');
  let secret = 'private-live-token',
    writes = 0;
  Object.defineProperty(password, 'value', {
    configurable: true,
    get: () => secret,
    set: (value: string) => {
      writes++;
      secret = value;
    },
  });
  await f.click('[data-settings-category="appearance"]');
  const picker = f.document.querySelector<HTMLDetailsElement>('#appearance-font-picker');
  defined(picker).open = true;
  defined(picker).dispatchEvent(new f.Event('toggle'));
  await f.search('密钥');
  await f.click('[data-settings-category="telegram"]');
  assert.equal(f.document.querySelector<HTMLInputElement>('#telegram-token'), password);
  assert.equal(defined(password).value, 'private-live-token');
  assert.equal(writes, 0);
  assert.equal(f.document.querySelector<HTMLInputElement>('#vm-host-draft'), host);
  assert.equal(defined(host).value, '192.0.2.123');
  assert.equal(f.document.querySelector<HTMLDetailsElement>('#appearance-font-picker'), picker);
  assert.equal(defined(picker).open, true);
  await f.click('[data-settings-category="computer"]');
  assert.equal(defined(host).value, '192.0.2.123');
});

test('search indexes only the fixed labels, never account, credential, input or conversation contents', async () => {
  const f = fixture();
  defined(f.document.querySelector<HTMLInputElement>('#private-vault')).value =
    'super-private-secret';
  for (const query of [
    'private-account@example.test',
    'Private credential nickname',
    'Private conversation text',
    'super-private-secret',
  ] as const) {
    await f.search(query);
    assert.equal(
      f.document.querySelectorAll<HTMLButtonElement>('[data-settings-result]').length,
      0,
    );
    assert.match(
      defined(f.document.querySelector<HTMLElement>('.settings-search-empty')).textContent,
      /No matching settings/,
    );
  }
  assert.deepEqual(f.loads, ['general']);
  await f.search('<img src=x onerror=alert(1)>');
  assert.equal(f.document.querySelector<HTMLImageElement>('img'), null);
  assert.equal(
    defined(f.document.querySelector<HTMLInputElement>('#settings-search')).value,
    '<img src=x onerror=alert(1)>',
  );
  assert.equal(f.document.querySelectorAll<HTMLButtonElement>('[data-settings-result]').length, 0);
});

test('keyboard navigation selects categories and search results; Escape and clear restore the selected view', async () => {
  const f = fixture();
  await f.key('[data-settings-category="general"]', 'ArrowDown');
  assert.equal(f.ui.category, 'appearance');
  assert.equal(defined(f.focus.at(-1)).dataset.settingsCategory, 'appearance');
  await f.key('[data-settings-category="appearance"]', 'End');
  assert.equal(f.ui.category, 'about');
  await f.key('[data-settings-category="about"]', 'Home');
  assert.equal(f.ui.category, 'general');
  await f.key('[data-settings-category="general"]', 'ArrowLeft');
  assert.equal(f.ui.category, 'about');
  await f.search('字体');
  await f.key('#settings-search', 'ArrowDown');
  assert.equal(defined(f.focus.at(-1)).dataset.settingsResult, 'font');
  await f.key('#settings-search', 'Enter');
  assert.equal(f.ui.category, 'appearance');
  assert.equal(
    f.focus.at(-1),
    f.document.querySelector<HTMLDetailsElement>('#appearance-font-picker>summary'),
  );
  await f.search('no match');
  await f.key('#settings-search', 'Escape', { isComposing: true });
  assert.equal(
    defined(f.document.querySelector<HTMLInputElement>('#settings-search')).value,
    'no match',
  );
  const event = await f.key('#settings-search', 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(visiblePanels(f), ['appearance']);
  await f.search('telegram');
  await f.click('[data-settings-clear]');
  assert.equal(defined(f.document.querySelector<HTMLInputElement>('#settings-search')).value, '');
  assert.equal(defined(f.focus.at(-1)).id, 'settings-search');
});

test('rapid switches load only the final category, and late failures after leaving settings cannot change it', async () => {
  const f = fixture();
  await settle();
  f.ui.select('appearance');
  f.ui.select('telegram');
  await settle();
  assert.deepEqual(f.loads, ['general', 'telegram']);
  let reject: ((reason: unknown) => void) | undefined;
  f.handler = () => new Promise<unknown>((_resolve, no) => (reject = no));
  f.ui.select('about');
  await settle();
  f.ui.sync(false);
  defined(reject)(Error('old category failed'));
  await settle();
  assert.deepEqual(f.errors, []);
  assert.equal(f.ui.isVisible('about'), false);
  f.handler = async () => {
    throw Error('current category failed');
  };
  f.ui.sync(true);
  await settle();
  assert.equal(f.errors.length, 1);
});

test('deep links select their category and focus a real card, with safe fallback for absent or disabled controls', async () => {
  const f = fixture();
  f.ui.sync(false);
  assert.equal(f.ui.select('unknown'), false);
  f.ui.select('voice', '.settings-section');
  assert.equal(f.ui.category, 'voice');
  f.ui.sync(true);
  f.render();
  await settle();
  assert.equal(f.ui.isVisible('voice'), true);
  assert.equal(
    defined(defined(f.focus.at(-1)).closest<HTMLElement>('[data-settings-panel]')).dataset
      .settingsPanel,
    'voice',
  );
  f.disableVoice();
  f.ui.select('voice', '#nativeVoice');
  assert.equal(defined(f.focus.at(-1)).classList.contains('settings-section'), true);
  f.ui.select('computer', '#missing-control');
  assert.equal(defined(f.focus.at(-1)).dataset.settingsPanel, 'computer');
});
