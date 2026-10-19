import type {
  AppSettings,
  ProvisioningState,
  VmProfiles,
  VmProviderInfo,
  TelegramStatus,
  TelegramPairing,
  FontInventory,
} from '../../../ui/app/application-types.ts';
import type {
  ApiOptions,
  ChatMessage,
  Timer,
  UiModal,
  VmSettings,
} from '../../../ui/shared/contracts.mts';
import type { SettingsCategory } from '../../../ui/settings/settings-navigation.mts';
import { observedRecord } from '../../support/service-fixtures.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined, invokeHandler } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection, compactCss } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import { createTaskReplyController } from '../../../ui/work/task-reply.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import {
  createAppearance,
  exportAppearance as serializeAppearance,
  importAppearance as parseAppearance,
} from '../../../ui/settings/appearance.mts';
import {
  telegramConnectionError,
  telegramDeliveryNotice,
} from '../../../ui/chat/telegram-delivery.mts';
import { createSettingsNavigation } from '../../../ui/settings/settings-navigation.mts';
import { renderUsageSettings } from '../../../ui/settings/usage-settings.mts';
import { createUsageActivityController } from '../../../ui/settings/usage-activity.mts';
import { reconcile } from '../../../ui/shared/dom.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
  css = compactCss(fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'));
const section = (start: string, end: string) => sourceSection(source, start, end);
function fixture() {
  const elements = new Map<string, object>(),
    stored = new Map<string, string>(),
    styles = new Map<string, string>(),
    requests: ({ route: string } & ApiOptions)[] = [],
    toasts: string[] = [],
    timers = new Map<Timer, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const document = {
    documentElement: {
      dataset: {} as DOMStringMap,
      style: {
        colorScheme: '',
        setProperty: (key: string, value: string) => styles.set(key, value),
      },
    },
    querySelector: (selector: string) => elements.get(selector) || null,
    querySelectorAll: (selector: string) => elements.get(selector) || [],
  };
  const state: {
    settings: AppSettings & { telegramToken?: string };
    worker: { status: string; models: unknown[] };
    messages: ChatMessage[];
    telegram?: Omit<Partial<TelegramStatus>, 'delivery'> & {
      delivery?: Partial<NonNullable<TelegramStatus['delivery']>>;
    };
    provisioning?: Partial<ProvisioningState>;
  } = {
    settings: {
      language: 'zh',
      theme: 'system',
      font: 'system',
      fontSize: 13,
      vm: { host: '', user: 'dant', port: 22, keyPath: '' },
    },
    worker: { status: 'online', models: [] },
    messages: [],
  };
  const context = uiEntrypointFixture({
    textEditor: { renderSettings: () => '', bind() {}, load: async () => {}, dispose() {} },
    settingsCategory: 'general' as SettingsCategory,
    settingsNavigation: createSettingsNavigation({
      document: parseHTML('<main></main>').document,
      onCategory: (category) => {
        context.settingsCategory = category;
      },
    }),
    managedSettings: {
      renderRequests: () => '',
      renderCredentials: () => '',
      renderSkills: () => '',
      renderModal: () => null,
      bind() {},
      load: async () => {},
      onClose() {},
    },
    chatHistory: {
      renderActions: () => '',
      renderEdited: () => '',
      renderSettings: () => '',
      renderModal: () => null,
      bind() {},
      bindModal() {},
      onClose() {},
    },
    document,
    URL,
    Date,
    serializeAppearance,
    parseAppearance,
    FormData: class {
      values: [string, string][];
      constructor(form: { values: Record<string, string> }) {
        this.values = Object.entries(form.values);
      }
      get(name: string) {
        return this.values.find(([key]) => key === name)?.[1] ?? null;
      }
      *[Symbol.iterator]() {
        yield* this.values;
      }
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id: Timer | undefined) => id !== undefined && timers.delete(id),
    fallbackLanguage: 'zh',
    state,
    eventConnected: true,
    pc: null,
    callStarting: false,
    callStops: { pending: false },
    page: 'settings',
    modal: null as UiModal | null,
    vmDraft: null as VmSettings | null,
    fontInventory: null as FontInventory | null,
    fontLoading: false,
    fontError: '',
    fontSearch: '',
    fontMenuOpen: false,
    appearanceAdvanced: false,
    vmProviderInfo: null as VmProviderInfo | null,
    vmProvidersBusy: false,
    vmProvidersError: '',
    vmProfiles: null as VmProfiles | null,
    vmProfilesVisible: false,
    vmProfilesBusy: false,
    vmProfilesError: '',
    selectedVMProfile: '',
    legacyVMDirectory: '',
    manualVMExpanded: false,
    provisionDraft: { provider: 'auto', cpu: 4, memoryGB: 6, diskGB: 40, adminSudo: false },
    provisionExpanded: false,
    telegramStatus: null as Partial<TelegramStatus> | null,
    telegramLoading: false,
    telegramError: '',
    telegramPairing: null as TelegramPairing | null,
    telegramPairTimer: null as Timer | null,
    pendingActions: new Set(),
    voiceLoadedFor: '',
    localStorage: {
      getItem: (key: string) => stored.get(key) || null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    render: () => {},
    toast: (message: string) => toasts.push(message),
    esc: (value: unknown) => String(value ?? ''),
    ico: () => '',
    button: (action: string, _icon: string, label: string) =>
      `<button data-action="${action}">${label}</button>`,
    formatTime: (value: number) => new Date(value).toISOString(),
    api: async (route: string, options: ApiOptions = {}) => {
      requests.push({ route, ...options });
      if (route === '/state') return context.state;
      if (route === '/vm/profiles')
        return { current: null, candidates: [], requiresSelection: false };
      if (route === '/telegram')
        return { enabled: false, configured: false, connected: false, paired: false };
      return { ok: true };
    },
  });
  const selectCategory = context.settingsNavigation.select;
  context.settingsNavigation.select = (category, selector) => {
    const selected = selectCategory(category, selector);
    context.settingsCategory = context.settingsNavigation.category;
    return selected;
  };
  Object.assign(context, { telegramConnectionError, telegramDeliveryNotice, renderUsageSettings });
  context.usageActivity = createUsageActivityController({
    document: parseHTML('<main></main>').document,
    onChange: () => context.render(),
  });
  context.post = (route, body = {}) => context.api(route, { method: 'POST', body });
  context.appearance = createAppearance({
    document,
    storage: context.localStorage,
    matchMedia: () => null,
    save: (body) => context.api('/settings', { method: 'PATCH', body }),
  });
  context.updateInstalling = false;
  context.taskReplies ??= createTaskReplyController({
    getModel: () => ({}),
  });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(
    stripTypeScriptTypes(
      [
        section('function currentState(', 'const subscriptionVoiceUnavailable='),
        section('const subscriptionVoiceUnavailable=', 'const iconCache='),
        section('const accentChoices=', 'function renderVoiceSettings(settings){'),
        section('function renderProvisionCard(){', 'function renderMemory(){'),
        section('function bindProvision(){', 'function bindComputerInput(){'),
        section('function formVM(form){', 'let inputChain='),
        section('async function action(a){', 'function clearSentDraft('),
      ].join('\n'),
    ),
    context,
  );
  return { c: context, elements, stored, styles, requests, toasts, timers };
}
function manualForm(
  f: ReturnType<typeof fixture>,
  values = { host: '172.20.0.5', user: 'dant', port: '22', keyPath: 'C:/private/vm-key' },
) {
  const form = { values, reportValidity: () => true };
  f.elements.set('#vm-form', form);
  return form;
}

test('rendered appearance controls apply and PATCH each selected preference through their actual handlers', async () => {
  const f = fixture(),
    { c, elements, requests, styles } = f;
  const mode = { dataset: { theme: 'dark' } },
    font = { dataset: { font: 'mono' } };
  elements.set('.appearance-settings button[data-theme]', [mode]);
  elements.set('.appearance-settings button[data-font]', [font]);
  elements.set('#appearance-size', { value: '18' });
  c.bindAppearance();
  await invokeHandler(mode, 'click');
  await invokeHandler(font, 'click');
  await invokeHandler(elements.get('#appearance-size'), 'change');
  assert.equal(c.document.documentElement.dataset.theme, 'dark');
  assert.match(defined(styles.get('--app-font-family')), /Consolas/);
  assert.equal(styles.get('--app-font-size'), '18px');
  assert.deepEqual(
    requests.map((item) => item.route),
    ['/settings', '/settings', '/settings'],
  );
  assert.equal(defined(requests[0]).method, 'PATCH');
  assert.equal(observedRecord(defined(requests[0]).body).theme, 'dark');
  assert.equal(observedRecord(defined(requests[1]).body).font, 'mono');
  assert.equal(observedRecord(defined(requests[2]).body).fontSize, 18);
  const html = c.renderAppearance();
  assert.match(html, /data-theme="dark"[^>]*aria-pressed="true"/);
  assert.match(html, /data-font="mono"[^>]*aria-pressed="true"/);
  assert.match(html, /id="appearance-size"[^>]*value="18"/);
  c.state.settings.language = 'en';
  assert.match(c.renderAppearance(), /Follow system|Monospace|UI font size/);
  assert.doesNotMatch(html, /id="appearance-theme"/);
});

test('all interface components use theme tokens without filtering desktop or attachment pixels', () => {
  const remaining = css.replace(/:root(?:\[data-theme=["\x27]dark["\x27]\])?\{[^}]*\}/g, '');
  assert.doesNotMatch(
    remaining,
    /#(?:[a-f\d]{3,8})\b/i,
    'component colors must follow theme tokens',
  );
  assert.doesNotMatch(css, /\binvert\s*\(/i);
  assert.match(css, /\.screen-target img\{[^}]*width:auto;height:auto/);
  assert.match(css, /font-size:calc\(var\(--app-font-size\)/);
  for (const selector of [
    '.rail',
    '.app-header',
    '.bubble',
    '.computer-panel',
    '.dialog',
    '.composer-box',
    '.call-view',
    '.telegram-pair-code',
    '.attachment-menu',
  ])
    assert.ok(css.includes(selector));
});

test('Connect without binding discovers existing configurations and opens manual fields without creating a VM', async () => {
  const f = fixture();
  await f.c.connectVM();
  assert.equal(f.c.page, 'settings');
  assert.equal(f.c.settingsCategory, 'computer');
  assert.equal(f.c.manualVMExpanded, true);
  assert.equal(f.c.vmProfilesVisible, true);
  assert.equal(defined(f.requests[0]).route, '/vm/profiles');
  assert.equal(
    f.requests.some((item) => item.route === '/connect' || item.route === '/provision'),
    false,
  );
  const html = f.c.renderVMSettings();
  assert.match(html, /data-action="use-existing"/);
  assert.match(html, /id="manual-vm-options" open/);
  assert.match(html, /保存并连接/);
  f.c.vmProfiles = {
    current: null,
    candidates: [
      {
        id: 'old',
        label: 'Previous workspace',
        host: '172.20.0.5',
        user: 'dant',
        port: 22,
        directory: 'C:/old/data',
      },
    ],
  };
  f.c.selectedVMProfile = 'old';
  assert.match(f.c.renderVMProfiles(), /Previous workspace/);
  assert.doesNotMatch(f.c.renderVMProfiles(), /data-action="import-vm-profile"[^>]*disabled/);
});

test('computer setup entry points open Work computer and clear search while keeping drafts and generic Settings navigation', async () => {
  const f = fixture(),
    { c } = f,
    { document, Event } = parseHTML('<main></main>'),
    main = document.querySelector<HTMLElement>('main'),
    loads: SettingsCategory[] = [];
  Object.assign(c, {
    document,
    page: 'chat',
    dictating: false,
    speakingId: null,
    emojiFor: null,
    chatMode: 'text',
    clearTelegramPairing: () => {},
    eyes: () => '',
    replyTo: null,
    attachments: [],
    recordDraft: null,
    recordStarting: false,
    composerDraft: '',
    sending: false,
    uploading: 0,
    recording: null,
    renderUnreadControl: () => '',
    renderUnconfirmedMessage: () => '',
    renderVoiceRecorder: () => '',
    renderAttachmentOptions: () => '',
    speechBlocked: () => false,
    computerReachable: () => false,
    computerExecutorReady: () => false,
    innerWidth: 1280,
    callBlocksControl: () => false,
    humanControl: () => false,
  });
  vm.runInContext(
    stripTypeScriptTypes(
      section('function renderChat(){', 'function renderDraftAttachment(') +
        section('function renderComputer(){', 'function renderSettings(){'),
    ),
    c,
  );
  c.state.worker.status = 'offline';
  const entryActions: string[] = [];
  for (const language of ['zh', 'en']) {
    c.state.settings.language = language;
    for (const markup of [c.renderChat(), c.renderComputer()]) {
      const entry = parseHTML(markup).document.querySelector<HTMLButtonElement>(
        '[data-action="computer-settings"]',
      );
      assert.ok(entry, language);
      assert.equal(entry.textContent, language === 'en' ? 'Connect my computer' : '连接我的电脑');
      entryActions.push(defined(entry.dataset.action));
    }
  }
  c.state.settings.language = 'zh';
  const draft = (c.vmDraft = {
      host: '192.0.2.45',
      user: 'saved-draft',
      port: 2202,
      keyPath: 'C:/draft/key',
    }),
    settings = JSON.stringify(c.state.settings);
  c.settingsNavigation = createSettingsNavigation({
    document,
    onChange: () => c.render(),
    onCategory: async (category) => {
      loads.push(category);
      await c.loadSettingsCategory(category);
    },
  });
  c.render = () => {
    c.settingsNavigation.sync(c.page === 'settings');
    const template = document.createElement('template');
    template.innerHTML =
      c.page === 'settings'
        ? c.settingsNavigation.render({
            computer: c.renderVMSettings(),
            appearance: '<p>Appearance</p>',
          })
        : '<p>Chat</p>';
    reconcile(defined(main), template.content);
    if (c.page === 'settings') c.settingsNavigation.bind();
  };
  c.settingsNavigation.select('appearance');
  await c.action('settings');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.settingsNavigation.category, 'appearance');
  const input = document.querySelector<HTMLInputElement>('#settings-search');
  defined(input).value = 'Telegram';
  defined(input).dispatchEvent(new Event('input'));
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-settings-panel="computer"]')).hidden,
    true,
  );
  await c.action(defined(entryActions[0]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.page, 'settings');
  assert.equal(c.settingsNavigation.category, 'computer');
  assert.equal(
    defined(document.querySelector<HTMLElement>('[aria-current="page"]')).dataset.settingsCategory,
    'computer',
  );
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-settings-panel="computer"]')).hidden,
    false,
  );
  assert.equal(defined(document.querySelector<HTMLInputElement>('#settings-search')).value, '');
  assert.equal(
    defined(document.querySelector<HTMLElement>('.vm-settings')).getAttribute('tabindex'),
    '-1',
  );
  assert.equal(
    defined(document.querySelector<HTMLInputElement>('[name="host"]')).value,
    draft.host,
  );
  assert.equal(c.vmDraft, draft);
  assert.equal(JSON.stringify(c.state.settings), settings);
  assert.deepEqual(loads, ['appearance', 'computer']);
  assert.deepEqual(f.requests, []);
  await c.action('chat');
  c.settingsNavigation.select('appearance');
  await c.action('settings');
  assert.equal(
    c.settingsNavigation.category,
    'appearance',
    'the general Settings button keeps its existing category behavior',
  );
  for (const entry of entryActions.slice(1)) {
    await c.action('chat');
    await c.action(entry);
    assert.equal(c.settingsNavigation.category, 'computer');
    assert.equal(c.vmDraft, draft);
  }
  assert.deepEqual(f.requests, []);
});

test('manual form saves before connecting and preserves typed connection details after a connection error', async () => {
  const f = fixture(),
    form = manualForm(f);
  f.c.bindVMSettings();
  invokeHandler(form, 'input');
  await invokeHandler(form, 'submit');
  assert.deepEqual(
    f.requests.map((item) => item.route),
    ['/settings', '/connect', '/state'],
  );
  assert.equal(observedRecord(observedRecord(defined(f.requests[0]).body).vm).host, '172.20.0.5');
  assert.equal(observedRecord(observedRecord(defined(f.requests[0]).body).vm).port, 22);
  const failed = fixture(),
    failedForm = manualForm(failed);
  failed.c.api = async (route, options = {}) => {
    failed.requests.push({ route, ...options });
    if (route === '/connect') throw Error('SSH key unavailable');
    return { ok: true };
  };
  failed.c.bindVMSettings();
  invokeHandler(failedForm, 'input');
  await invokeHandler(failedForm, 'submit');
  assert.equal(failedForm.values.host, '172.20.0.5');
  assert.equal(failedForm.values.keyPath, 'C:/private/vm-key');
  assert.equal(failed.c.state.settings.vm.keyPath, 'C:/private/vm-key');
  assert.match(defined(failed.toasts.at(-1)), /SSH key unavailable/);
  assert.equal(failed.c.pendingActions.has('connect'), false);
});

test('rejected manual saves retain the unsaved draft and do not connect or create a VM', async () => {
  const f = fixture(),
    form = manualForm(f);
  f.c.api = async (route, options = {}) => {
    f.requests.push({ route, ...options });
    throw Error('Private key file not found');
  };
  f.c.bindVMSettings();
  invokeHandler(form, 'input');
  await invokeHandler(form, 'submit');
  assert.equal(defined(f.c.vmDraft).host, '172.20.0.5');
  assert.equal(defined(f.c.vmDraft).keyPath, 'C:/private/vm-key');
  assert.deepEqual(
    f.requests.map((item) => item.route),
    ['/settings'],
  );
  assert.match(defined(f.toasts.at(-1)), /Private key file not found/);
});

test('explicit profile or directory imports refresh binding then connect and cannot overwrite a protected current profile', async () => {
  const f = fixture();
  f.c.api = async (route, options = {}) => {
    f.requests.push({ route, ...options });
    if (route === '/state') {
      f.c.state.settings.vm = { host: '172.20.0.6', user: 'dant', port: 22, keyPath: 'C:/old/key' };
      return f.c.state;
    }
    return { ok: true };
  };
  await f.c.importVMProfile({ id: 'old' });
  assert.deepEqual(
    f.requests.map((item) => item.route),
    ['/vm/import', '/state', '/connect', '/state'],
  );
  assert.equal(observedRecord(defined(f.requests[0]).body).id, 'old');
  const directory = fixture(),
    form = {
      elements: {
        directory: { tagName: 'INPUT', value: 'C:/previous/data' },
        namedItem(name: string): unknown {
          return Reflect.get(this, name);
        },
      },
    };
  directory.elements.set('#vm-import-form', form);
  directory.c.api = f.c.api;
  directory.c.importVMProfile = async (body) => {
    directory.requests.push({ route: '/vm/import', body });
  };
  directory.c.bindVMSettings();
  invokeHandler(form, 'input');
  await invokeHandler(form, 'submit');
  assert.equal(observedRecord(defined(directory.requests[0]).body).directory, 'C:/previous/data');
  f.c.vmProfiles = {
    current: { id: 'current', host: '172.20.0.6' },
    candidates: [{ id: 'old', host: '172.20.0.7' }],
  };
  f.c.selectedVMProfile = 'old';
  assert.match(f.c.renderVMProfiles(), /data-action="import-vm-profile"[^>]*disabled/);
  assert.doesNotMatch(f.c.renderVMProfiles(), /id="vm-import-form"/);
});

test('Telegram unconfigured and offline states disable configuration actions without requesting the service', async () => {
  const f = fixture();
  assert.match(f.c.renderTelegramSettings(), /尚未配置机器人令牌/);
  assert.match(f.c.renderTelegramSettings(), /data-action="telegram-toggle"[^>]*disabled/);
  f.c.state.worker.status = 'offline';
  await f.c.loadTelegram();
  assert.equal(f.requests.length, 0);
  const html = f.c.renderTelegramSettings();
  assert.match(html, /请先连接工作电脑/);
  assert.match(html, /id="telegram-token"[^>]*disabled/);
  assert.doesNotMatch(html, /id="telegram-token"[^>]*\bvalue=/);
});

test('new appearance, existing-computer, and Telegram surfaces follow English and authoritative pairing updates', () => {
  const f = fixture();
  f.c.state.settings.language = 'en';
  assert.match(f.c.renderAppearance(), /Appearance|Follow system|Sans serif|Monospace/);
  assert.match(f.c.renderVMSettings(), /Use existing computer/);
  assert.match(f.c.renderVMSettings(), /Save and connect/);
  assert.match(f.c.renderTelegramSettings(), /No bot token configured/);
  f.c.state.telegram = {
    enabled: true,
    configured: true,
    connected: true,
    bot: { username: 'live_bot' },
    paired: true,
    owner: { userId: 12, chatId: 13 },
  };
  assert.equal(f.c.currentTelegram().paired, true);
  const html = f.c.renderTelegramSettings();
  assert.match(html, /Account paired/);
  assert.match(html, /@live_bot/);
  assert.match(html, /Telegram connected/);
  assert.match(html, /Unpair account/);
});

test('Telegram historical delivery issues do not mask a healthy paired connection and remain single-language', () => {
  for (const language of ['zh', 'en']) {
    const f = fixture();
    f.c.state.settings.language = language;
    f.c.state.telegram = {
      enabled: true,
      configured: true,
      connected: true,
      paired: true,
      bot: { username: 'fixture_bot' },
      owner: { userId: 12, chatId: 13 },
      connectionError: null,
      lastError: 'Request failed',
      delivery: {
        unknown: 26,
        failed: 1,
        lastIssue: { status: 'unknown', at: 1234, reason: 'timeout' },
      },
    };
    const html = f.c.renderTelegramSettings();
    assert.doesNotMatch(html, /Request failed|telegram-connection-error/);
    assert.match(html, /class="telegram-delivery-notice" role="status"/);
    assert.match(html, /1970-01-01T00:00:01.234Z/);
    assert.doesNotMatch(html, /data-action="telegram-(?:retry|resend)"/);
    assert.equal(f.requests.length, 0);
    if (language === 'zh') {
      assert.match(html, /Telegram 已连接/);
      assert.match(html, /账号已配对/);
      assert.match(html, /26 条消息的发送结果未确认/);
      assert.match(html, /1 条消息未送达/);
      assert.match(html, /请求超时/);
      assert.match(html, /连接和账号配对仍然有效，新消息可以继续发送/);
      assert.match(html, /先检查 Telegram/);
      assert.doesNotMatch(html, /unconfirmed delivery|New messages can still/);
    } else {
      assert.match(html, /Telegram connected/);
      assert.match(html, /Account paired/);
      assert.match(html, /26 messages with unconfirmed delivery/);
      assert.match(html, /1 message was not delivered/);
      assert.match(html, /Request timed out/);
      assert.match(html, /New messages can still be sent/);
      assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
    }
  }
});

test('Telegram settings operations and actual connection errors display independently with legacy fallback', () => {
  const f = fixture();
  f.c.state.telegram = {
    enabled: true,
    configured: true,
    connected: false,
    paired: true,
    connectionError: 'Connection unavailable',
    lastError: 'Old delivery failed',
    delivery: { unknown: 2 },
  };
  f.c.telegramError = 'Settings operation rejected';
  let html = f.c.renderTelegramSettings();
  assert.match(html, /Settings operation rejected/);
  assert.match(html, /class="error telegram-connection-error"[^>]*>[^<]*Connection unavailable/);
  assert.doesNotMatch(html, /Old delivery failed|连接和账号配对仍然有效/);
  f.c.telegramError = '';
  delete f.c.state.telegram.connectionError;
  html = f.c.renderTelegramSettings();
  assert.match(html, /Old delivery failed/);
  f.c.state.telegram.connected = true;
  html = f.c.renderTelegramSettings();
  assert.doesNotMatch(html, /Old delivery failed|telegram-connection-error/);
  assert.match(html, /2 条消息的发送结果未确认/);
});

test('Telegram token form sends only to configuration, clears on success, and never persists or renders the token', async () => {
  const f = fixture(),
    token = '123456:private-test-token',
    input = { value: token },
    form = { reportValidity: () => true };
  f.elements.set('#telegram-token-form', form);
  f.elements.set('#telegram-token', input);
  f.c.api = async (route, options = {}) => {
    f.requests.push({ route, ...options });
    return {
      enabled: false,
      configured: true,
      connected: false,
      bot: { username: 'fixture_bot' },
      paired: false,
    };
  };
  f.c.bindTelegram();
  await invokeHandler(form, 'submit');
  assert.equal(defined(f.requests[0]).route, '/telegram/config');
  assert.equal(observedRecord(defined(f.requests[0]).body).token, token);
  assert.equal(input.value, '');
  assert.equal(f.c.state.messages.length, 0);
  assert.doesNotMatch(f.c.renderTelegramSettings(), new RegExp(token));
  assert.equal(
    [...f.stored.values()].some((value) => String(value).includes(token)),
    false,
  );
  assert.match(f.c.renderTelegramSettings(), /机器人令牌已配置/);
  assert.doesNotMatch(f.c.renderTelegramSettings(), /id="telegram-token"[^>]*\bvalue=/);
});

test('Telegram enable, disable, and removal actions send explicit changes and failed configuration retains only the local input', async () => {
  const f = fixture();
  f.c.setTelegramStatus({ enabled: false, configured: true, paired: false });
  f.c.api = async (route, options = {}) => {
    f.requests.push({ route, ...options });
    return route === '/telegram/disconnect'
      ? { enabled: false, configured: false, paired: false }
      : { enabled: observedRecord(options.body).enabled, configured: true, paired: false };
  };
  await f.c.action('telegram-toggle');
  assert.equal(observedRecord(defined(f.requests.at(-1)).body).enabled, true);
  assert.equal(f.c.currentTelegram().enabled, true);
  await f.c.action('telegram-toggle');
  assert.equal(observedRecord(defined(f.requests.at(-1)).body).enabled, false);
  await f.c.action('telegram-remove');
  assert.equal(observedRecord(defined(f.requests.at(-1)).body).clearToken, true);
  assert.equal(f.c.currentTelegram().configured, false);
  const failed = fixture(),
    input = { value: '123456:unsaved-token' },
    form = { reportValidity: () => true };
  failed.elements.set('#telegram-token', input);
  failed.elements.set('#telegram-token-form', form);
  failed.c.api = async () => {
    throw Error('Telegram rejected the request (401)');
  };
  failed.c.bindTelegram();
  await invokeHandler(form, 'submit');
  assert.equal(input.value, '123456:unsaved-token');
  assert.equal(failed.c.state.messages.length, 0);
  assert.equal(
    [...failed.stored.values()].some((value) => String(value).includes('unsaved-token')),
    false,
  );
  assert.match(defined(failed.toasts.at(-1)), /401/);
});

test('Telegram pairing codes are ephemeral, expire locally, and only safe bot links can be opened', async () => {
  const f = fixture(),
    expiresAt = Date.now() + 600000;
  f.c.setTelegramStatus({
    enabled: true,
    configured: true,
    connected: true,
    paired: false,
    bot: { username: 'fixture_bot' },
  });
  f.c.api = async (route, options = {}) => {
    f.requests.push({ route, ...options });
    if (route === '/telegram/pair')
      return {
        code: 'one-time-pair-code',
        expiresAt,
        botUrl: 'https://t.me/fixture_bot?start=one-time-pair-code',
      };
    return { enabled: false, configured: true, paired: false };
  };
  await f.c.updateTelegram('pair');
  assert.equal(defined(f.requests[0]).route, '/telegram/pair');
  assert.match(f.c.renderTelegramSettings(), /one-time-pair-code/);
  assert.match(f.c.renderTelegramSettings(), /https:\/\/t\.me\/fixture_bot/);
  assert.equal(
    [...f.stored.values()].some((value) => String(value).includes('one-time-pair-code')),
    false,
  );
  assert.equal(f.c.telegramBotURL('javascript:alert(1)'), '');
  assert.equal(f.c.telegramBotURL('https://evil.example/bot'), '');
  defined([...f.timers.values()][0]).fn();
  assert.equal(f.c.telegramPairing, null);
  assert.doesNotMatch(f.c.renderTelegramSettings(), /one-time-pair-code/);
  f.c.setTelegramStatus({
    enabled: true,
    configured: true,
    paired: true,
    owner: { userId: 77, chatId: 77 },
  });
  assert.match(f.c.renderTelegramSettings(), /账号已配对/);
  assert.match(f.c.renderTelegramSettings(), /data-action="telegram-pair"[^>]*disabled/);
  await f.c.updateTelegram('disconnect', { clearToken: false });
  assert.equal(defined(f.requests.at(-1)).route, '/telegram/disconnect');
  assert.equal(observedRecord(defined(f.requests.at(-1)).body).clearToken, false);
});

test('provider detection is read only and automatic VMware setup never shows a Hyper-V approval phase', async () => {
  const f = fixture();
  f.c.api = async (route, options = {}) => {
    f.requests.push({ route, ...options });
    return {
      selected: 'auto',
      provider: 'vmware',
      availableProviders: [
        { id: 'hyperv', available: false, reason: 'Hyper-V is not enabled' },
        { id: 'vmware', available: true },
      ],
    };
  };
  await f.c.loadVMProviders();
  assert.deepEqual(
    f.requests.map((item) => item.route),
    ['/vm/providers'],
  );
  assert.equal(f.c.vmProvidersBusy, false);
  let html = f.c.renderProvisionCard();
  assert.match(html, /value="auto" selected/);
  assert.match(html, /VMware Workstation/);
  assert.match(html, /无需 Hyper-V 管理员授权/);
  assert.doesNotMatch(html, /请在 Windows 提示中允许/);
  f.c.state.provisioning = {
    running: true,
    status: 'creating',
    provider: 'vmware',
    stage: 'booting-vm',
  };
  html = f.c.renderProvisionCard();
  assert.match(html, /正在启动工作电脑/);
  assert.doesNotMatch(html, /请在 Windows 提示中允许/);
  f.c.state.settings.language = 'en';
  html = f.c.renderProvisionCard();
  assert.match(html, /Starting the work computer/);
  assert.match(html, /does not require Hyper-V administrator authorization/);
  assert.doesNotMatch(html, /Allow setup in the Windows permission prompt/);
});

test('an explicit provider is sent only on form submit and preserves resource choices after failure', async () => {
  const f = fixture(),
    options = { open: true },
    form = {
      elements: {
        provider: { tagName: 'SELECT', value: 'vmware' },
        cpu: { tagName: 'INPUT', value: '6' },
        memoryGB: { tagName: 'INPUT', value: '8' },
        diskGB: { tagName: 'INPUT', value: '64' },
        adminSudo: { tagName: 'INPUT', checked: true },
        namedItem(name: string): unknown {
          return Reflect.get(this, name);
        },
      },
    };
  f.elements.set('#provision-form', form);
  f.elements.set('#provision-options', options);
  f.c.bindProvision();
  invokeHandler(form.elements.provider, 'change');
  assert.equal(f.c.provisionDraft.provider, 'vmware');
  assert.equal(f.requests.length, 0, 'choosing a provider must not create a computer');
  f.c.api = async (route, request) => {
    f.requests.push({ route, ...request });
    throw Error('VMware disk preparation failed');
  };
  await invokeHandler(form, 'submit');
  assert.equal(defined(f.requests[0]).route, '/provision');
  assert.equal(observedRecord(defined(f.requests[0]).body).provider, 'vmware');
  assert.equal(observedRecord(defined(f.requests[0]).body).cpu, 6);
  assert.equal(observedRecord(defined(f.requests[0]).body).memoryGB, 8);
  assert.equal(observedRecord(defined(f.requests[0]).body).diskGB, 64);
  assert.equal(observedRecord(defined(f.requests[0]).body).adminSudo, true);
  assert.equal(f.c.provisionDraft.provider, 'vmware');
  assert.match(defined(f.toasts.at(-1)), /VMware disk preparation failed/);
  f.c.api = async (route, request) => {
    f.requests.push({ route, ...request });
    return { provider: 'vmware', status: 'creating', running: true };
  };
  await invokeHandler(form, 'submit');
  await invokeHandler(form, 'submit');
  assert.equal(f.requests.length, 2, 'a running setup cannot be submitted twice');
});

test('existing VM labels use its actual provider and unknown SSH never inherits a new setup candidate', () => {
  const f = fixture();
  f.c.vmProviderInfo = { provider: 'hyperv', availableProviders: [] };
  f.c.state.settings.vm = { host: '10.0.0.7', user: 'dant', port: 22, keyPath: 'key' };
  assert.match(f.c.renderVMSettings(), /Linux · SSH/);
  assert.doesNotMatch(f.c.renderVMSettings(), /Ubuntu[^<]*Hyper-V/);
  f.c.state.settings.vm.provider = 'vmware';
  assert.match(f.c.renderVMSettings(), /Ubuntu · VMware Workstation/);
  f.c.state.settings.vm.provider = 'hyperv';
  assert.match(f.c.renderVMSettings(), /Ubuntu · Hyper-V/);
  delete f.c.state.settings.vm.provider;
  f.c.state.provisioning = { provider: 'vmware', connection: { host: '10.0.0.8' } };
  assert.equal(f.c.vmSystemDescription(), 'Linux · SSH');
  defined(f.c.state.provisioning.connection).host = '10.0.0.7';
  assert.equal(f.c.vmSystemDescription(), 'Ubuntu · VMware Workstation');
});

test('unavailable explicit providers remain visible without silently choosing a different hypervisor', () => {
  const f = fixture();
  f.c.provisionDraft.provider = 'vmware';
  f.c.vmProviderInfo = {
    provider: 'hyperv',
    availableProviders: [
      { id: 'hyperv', available: true },
      { id: 'vmware', available: false, reason: 'Workstation tools are missing' },
    ],
  };
  const html = f.c.renderProvisionCard();
  assert.match(html, /value="vmware" selected disabled/);
  assert.match(html, /此虚拟化软件暂不可用/);
  assert.match(html, /Workstation tools are missing/);
  assert.match(html, /type="submit"[^>]*disabled/);
  assert.equal(f.c.vmProviderStatus().provider, 'vmware');
  f.c.provisionDraft.provider = 'auto';
  defined(f.c.vmProviderInfo.availableProviders[0]).available = false;
  assert.match(f.c.renderProvisionCard(), /没有检测到可用的虚拟化软件/);
});

test('preparation, boot and networking stages have meaningful text in both languages', () => {
  const f = fixture(),
    checks = {
      zh: {
        'downloading-image': '下载 Ubuntu 镜像',
        'configuring-nocloud': '首次启动配置',
        'booting-vm': '启动工作电脑',
        'waiting-for-ip': '电脑网络连接',
      },
      en: {
        'downloading-image': 'Downloading the Ubuntu image',
        'configuring-nocloud': 'first-boot configuration',
        'booting-vm': 'Starting the work computer',
        'waiting-for-ip': 'computer network',
      },
    };
  for (const [language, stages] of Object.entries(checks)) {
    f.c.state.settings.language = language;
    for (const [stage, expected] of Object.entries(stages))
      assert.ok(f.c.setupStageText({ stage, status: 'creating' }).includes(expected));
  }
});

test('appearance presets, colors and independent text sizes update real preferences through their controls', async () => {
  const f = fixture(),
    preset = { value: 'warm' },
    accent = { dataset: { accent: '#8660D9' } },
    reset = { dataset: { resetColor: 'backgroundColor' } };
  f.elements.set('#appearance-preset', preset);
  f.elements.set('.appearance-settings button[data-accent]', [accent]);
  f.elements.set('.appearance-settings button[data-reset-color]', [reset]);
  for (const [id, value] of [
    ['appearance-backgroundColor', '#203040'],
    ['appearance-foregroundColor', '#EEEEEE'],
    ['appearance-content-size', '22'],
    ['appearance-code-size', '19'],
    ['appearance-motion', 'reduce'],
  ])
    f.elements.set('#' + id, { value });
  f.c.bindAppearance();
  await invokeHandler(preset, 'change');
  assert.equal(observedRecord(defined(f.requests.at(-1)).body).themePreset, 'warm');
  assert.equal(observedRecord(defined(f.requests.at(-1)).body).backgroundColor, null);
  await invokeHandler(accent, 'click');
  assert.equal(defined(f.c.appearance).preferences.accentColor, '#8660D9');
  await invokeHandler(f.elements.get('#appearance-backgroundColor'), 'change');
  await invokeHandler(f.elements.get('#appearance-foregroundColor'), 'change');
  await invokeHandler(f.elements.get('#appearance-content-size'), 'change');
  await invokeHandler(f.elements.get('#appearance-code-size'), 'change');
  await invokeHandler(f.elements.get('#appearance-motion'), 'change');
  assert.equal(f.styles.get('--appearance-background'), '#203040');
  assert.equal(f.styles.get('--appearance-foreground'), '#EEEEEE');
  assert.equal(f.styles.get('--content-font-size'), '22px');
  assert.equal(f.styles.get('--code-font-size'), '19px');
  assert.equal(f.styles.get('--app-font-size'), '13px');
  assert.equal(f.c.document.documentElement.dataset.reducedMotion, 'reduce');
  await invokeHandler(reset, 'click');
  assert.equal(defined(f.c.appearance).preferences.backgroundColor, null);
  const html = f.c.renderAppearance();
  assert.match(html, /mode-preview/);
  assert.match(html, /appearance-advanced/);
  assert.match(html, /减少动态效果/);
  assert.match(css, /--surface:var\(--appearance-background\)/);
  assert.match(css, /--text:var\(--appearance-foreground\)/);
  assert.match(css, /\.bubble,\.memory-content\{font-size:var\(--content-font-size\)/);
  assert.match(css, /\.markdown pre,\.markdown code\{font-size:var\(--code-font-size\)/);
});

test('local font inventory is searched and only genuine returned families can be selected', async () => {
  const f = fixture();
  f.c.api = async (route, request = {}) => {
    f.requests.push({ route, ...request });
    return route === '/fonts'
      ? { source: 'windows', fonts: ['Arial', 'Microsoft YaHei', 'Arial'] }
      : {};
  };
  await f.c.loadFonts();
  await f.c.loadFonts();
  assert.equal(f.requests.filter((item) => item.route === '/fonts').length, 1);
  const search = { value: 'yahei' },
    font = { dataset: { fontFamily: 'Microsoft YaHei' } },
    unlisted = { dataset: { fontFamily: 'Invented font' } },
    picker = { open: true };
  f.elements.set('#appearance-font-search', search);
  f.elements.set('.appearance-settings button[data-font-family]', [font, unlisted]);
  f.elements.set('#appearance-font-picker', picker);
  f.c.bindAppearance();
  invokeHandler(search, 'input');
  let html = f.c.renderAppearance();
  assert.match(html, /data-font-family="Microsoft YaHei"/);
  assert.doesNotMatch(html, /data-font-family="Arial"/);
  const before = f.requests.length;
  await invokeHandler(unlisted, 'click');
  assert.equal(f.requests.length, before);
  await invokeHandler(font, 'click');
  assert.equal(observedRecord(defined(f.requests.at(-1)).body).fontFamily, 'Microsoft YaHei');
  assert.match(defined(f.styles.get('--app-font-family')), /^"Microsoft YaHei",/);
  assert.equal(f.c.fontMenuOpen, false);
  f.c.state.settings.language = 'en';
  f.c.fontSearch = 'missing';
  html = f.c.renderAppearance();
  assert.match(html, /No matching local fonts/);
  assert.doesNotMatch(html, /没有匹配/);
});

test('appearance import and export use a validated versioned document containing only appearance fields', async () => {
  const f = fixture();
  f.c.state.settings.telegramToken = 'private';
  f.c.state.settings.vm.keyPath = 'C:/private/key';
  const data = observedRecord(f.c.appearanceExportData());
  assert.equal(data.schema, 'dant-appearance');
  assert.equal(data.version, 1);
  assert.equal(Object.hasOwn(observedRecord(data.appearance), 'vm'), false);
  assert.equal(JSON.stringify(data).includes('private'), false);
  observedRecord(data.appearance).theme = 'dark';
  observedRecord(data.appearance).contentFontSize = 20;
  await f.c.importAppearanceData(JSON.stringify(data));
  assert.equal(defined(f.c.appearance).preferences.theme, 'dark');
  assert.equal(defined(f.c.appearance).preferences.contentFontSize, 20);
  assert.match(defined(f.toasts.at(-1)), /外观已导入/);
  const prior = f.requests.length;
  await assert.rejects(f.c.importAppearanceData('{broken'), /外观文件无效/);
  await assert.rejects(
    f.c.importAppearanceData(JSON.stringify({ ...data, appearance: { vm: { host: 'other' } } })),
    /外观文件无效/,
  );
  assert.equal(f.requests.length, prior);
  const file = {
      value: 'selected',
      files: [
        {
          size: 65537,
          text: async () => {
            throw Error('oversized files must not be read');
          },
        },
      ],
    },
    trigger = { clicks: 0 };
  Object.assign(file, { click: () => trigger.clicks++ });

  f.elements.set('#appearance-import-file', file);
  f.elements.set('#appearance-import', trigger);
  f.c.bindAppearance();
  invokeHandler(trigger, 'click');
  assert.equal(trigger.clicks, 1);
  await invokeHandler(file, 'change');
  assert.equal(file.value, '');
  assert.match(defined(f.toasts.at(-1)), /64 KiB/);
});
