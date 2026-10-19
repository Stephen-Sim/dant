import { uiFixtureContext } from '../support/language-context.mts';
import { uiEntrypointFixture } from '../support/ui-entrypoint-fixtures.mts';
import {
  observedRecord,
  deferred,
  unexpectedFixtureOperation,
} from '../support/service-fixtures.mts';
import { errorCode, errorMessage, isRecord } from '../../src/contracts/json.mts';
import type { AppState } from '../../ui/app/application-types.ts';
import type { ApiOptions, Attachment } from '../../ui/shared/contracts.mts';
import type { BrowserRecognition } from '../../ui/platform/speech-types.ts';
import type { TranslationCatalog } from '../../src/i18n/i18n.mts';
import { defined, invokeHandler } from '../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { parseAst } from 'rollup/parseAst';
import {
  languages,
  isLanguage,
  normalizeLanguage,
  languageInfo,
} from '../../src/i18n/languages.mts';
import {
  registerLocale,
  translate,
  localizeMessages,
  translateCount,
} from '../../src/i18n/i18n.mts';
import { loadLanguage } from '../../ui/i18n/localization.mts';
import { telegramDeliveryNotice } from '../../ui/chat/telegram-delivery.mts';
import { trayStatus } from '../../ui/platform/native-tray.mts';
import { createNativeCallOverlay } from '../../ui/platform/native-call-overlay.mts';
import { SpeechHelper } from '../../ui/platform/speech.mts';
import { workProgress } from '../../ui/work/work-progress.mts';
import { renderUsageActivity } from '../../ui/settings/usage-activity.mts';
import { createSchedules } from '../../ui/schedules/schedules.mts';
import { reconcile } from '../../ui/shared/dom.mts';
import { createSettingsNavigation } from '../../ui/settings/settings-navigation.mts';
import type { createVmBackups } from '../../ui/settings/vm-backups.mts';
import {
  sourceDeclaration,
  sourceSection,
  sourceSelectorBinding,
} from '../support/source-fixtures.mts';

const source = fs.readFileSync(new URL('../../ui/main.mts', import.meta.url), 'utf8');
const codes = languages.map((item) => item.code);
const readCatalog = (code: string): TranslationCatalog => {
  const value: unknown = JSON.parse(
    fs.readFileSync(new URL(`../../src/i18n/locales/${code}.json`, import.meta.url), 'utf8'),
  );
  assert.ok(isRecord(value));
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    assert.equal(typeof text, 'string');
    if (typeof text !== 'string') throw Error('Expected catalog text');
    result[key] = text;
  }
  return result;
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const escape = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function mainFixture() {
  const { document } = parseHTML('<html><body><div id="app"></div></body></html>'),
    stored = new Map<string, string>(),
    requests: (ApiOptions & { route: string })[] = [],
    errors: unknown[] = [];
  const empty = () => '',
    noop = () => {},
    same = (value: unknown) => value;
  const context = uiEntrypointFixture({
    document,
    HTMLInputElement: defined(document.defaultView).HTMLInputElement,
    app: document.querySelector('#app'),
    languages,
    isLanguage,
    normalizeLanguage,
    languageInfo,
    translate,
    loadLanguage,
    Intl,
    Date,
    fallbackLanguage: 'en',
    pendingActions: new Set(),
    state: {
      settings: { language: 'en', notifications: false, vm: {} },
      worker: { status: 'online', models: [] },
      messages: [{ id: 'user', role: 'user', text: 'Language', status: 'completed', time: 1000 }],
      memory: 'Language',
    } as AppState,
    localStorage: {
      getItem: (key: string) => stored.get(key),
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    api: async (route: string, options?: ApiOptions): Promise<unknown> => {
      requests.push({ route, ...options });
      return { ok: true };
    },
    toast: (error: unknown) => errors.push(error),
    esc: escape,
    ico: empty,
    button: empty,
    renderAppearance: empty,
    renderVoiceSettings: empty,
    renderVMSettings: empty,
    renderLoginDetails: empty,
    renderUsageSettings: empty,
    renderTelegramSettings: empty,
    textEditor: { renderSettings: empty },
    usageActivity: { state: {} },
    provisionDraft: { adminSudo: false },
    managedSettings: { renderCredentials: empty, syncModal: same },
    filePreview: { syncModal: same },
    chatHistory: { renderSettings: empty, renderActions: empty, renderEdited: empty },
    settingsNavigation: {
      sync: noop,
      isVisible: () => false,
      bind: noop,
      render: (
        sections: Partial<
          Record<import('../../ui/settings/settings-navigation.mts').SettingsCategory, string>
        >,
      ) => sections.general ?? '',
    } as Pick<
      ReturnType<typeof createSettingsNavigation>,
      'sync' | 'isVisible' | 'render' | 'bind'
    >,
    memorySettings: { setVisible: noop },
    vmBackups: { setVisible: noop, render: empty, renderImport: empty } satisfies Pick<
      ReturnType<typeof createVmBackups>,
      'setVisible' | 'render' | 'renderImport'
    >,
    workDisclosures: { capture: noop },
    appUpdates: { setVisible: noop, render: empty },
    appearance: { sync: noop },
    chatScroll: { capture: noop, restore: noop },
    modal: null,
    page: 'settings',
    eventConnected: true,
    humanControl: () => false,
    composerDraft: 'Language',
    updateInstalling: false,
    renderRail: empty,
    renderHeader: empty,
    renderModal: empty,
    reconcile: (_app: Node, fragment: Node) =>
      defined(document.querySelector('#app')).replaceChildren(fragment.cloneNode(true)),
    bind: noop,
    resizeComposer: noop,
    floatingCall: { sync: noop },
    nativeTray: { sync: noop },
    pc: null,
    callId: null,
    callStarting: false,
    callStops: { pending: false },
    callDuration: { snapshot: {} },
    showComputer: false,
    chatMode: 'text',
    publishCallOverlay: noop,
    positionReactionMenus: noop,
    updateRead: noop,
    restartScreen: noop,
    emojiFor: null,
    defaultReactions: [],
    taskReplies: { renderMessageReference: empty },
    renderAttachments: empty,
    md: escape,
    renderAssistantReadState: empty,
    fileURL: (file: Attachment) => '/fixture/' + file.id,
    canPreviewFile: () => true,
  });
  vm.createContext(Object.assign(uiFixtureContext(context), { loadLanguage }));
  vm.runInContext(
    stripTypeScriptTypes(
      [
        sourceSection(source, 'function currentState(', 'const subscriptionVoiceUnavailable='),
        ...[
          'function renderSettings',
          'function render',
          'function messageDate',
          'function formatTime',
          'function renderMessages',
          'function renderAttachment',
        ].map((marker) => sourceDeclaration(source, marker)),
      ].join('\n'),
    ),
    context,
  );
  return { context, stored, requests, errors, document };
}

function settingsBindingSequence() {
  const declaration = sourceDeclaration(source, 'function bind'),
    bind = parseAst(declaration).body[0],
    languageBinding = sourceSelectorBinding(declaration, 'select[data-language]'),
    loops = (() => {
      assert.ok(bind && bind.type === 'FunctionDeclaration');
      const matches = [];
      for (const node of bind.body.body) {
        if (node.type !== 'ForOfStatement' || node.right.type !== 'ArrayExpression') continue;
        const elements = node.right.elements;
        if (
          ['model', 'nativeVoice', 'apiVoice', 'notifications'].every((key) =>
            elements.some((item) => item?.type === 'Literal' && item.value === key),
          )
        )
          matches.push(node);
      }
      return matches;
    })();
  assert.equal(loops.length, 1, 'find the actual generic settings loop independently of language');
  const generic = observedRecord(defined(loops[0])),
    languageAt = declaration.indexOf(languageBinding);
  assert.ok(typeof generic.start === 'number' && typeof generic.end === 'number');
  assert.ok(languageAt >= 0);
  return [
    { start: languageAt, text: languageBinding },
    { start: generic.start, text: declaration.slice(generic.start, generic.end) },
  ]
    .sort((left, right) => left.start - right.start)
    .map((item) => item.text)
    .join('\n');
}

test('the 16 registered choices have complete matching catalogs and intact placeholders', async () => {
  assert.deepEqual(codes, [
    'en',
    'zh',
    'zh-TW',
    'ja',
    'ko',
    'es',
    'fr',
    'de',
    'pt',
    'ru',
    'ar',
    'hi',
    'id',
    'ms',
    'it',
    'tr',
  ]);
  const expected = Object.keys(readCatalog('es')).sort();
  assert.ok(expected.length >= 914);
  for (const code of codes.filter((code) => !['en', 'zh'].includes(code))) {
    const catalog = readCatalog(code);
    assert.deepEqual(Object.keys(catalog).sort(), expected, code);
    for (const [english, value] of Object.entries(catalog)) {
      assert.equal(typeof value, 'string');
      assert.ok(value.trim(), code + ' ' + english);
      for (const placeholder of english.match(/\{[^{}]+\}/g) || [])
        assert.ok(value.includes(placeholder), code + ' ' + english);
    }
    await loadLanguage(code);
    assert.equal(translate(code, 'Language'), catalog.Language);
    assert.notEqual(translate(code, 'Language'), 'Language');
  }
  for (const code of codes) {
    assert.ok(isLanguage(code));
    assert.equal(normalizeLanguage(code), code);
    assert.ok(languageInfo(code).speech);
  }
  assert.equal(languageInfo('ar').direction, 'rtl');
  assert.equal(isLanguage('private text'), false);
});

test('catalog registration updates nested application dictionaries without touching reference objects', () => {
  const real = readCatalog('fr'),
    dictionary = {
      en: { label: 'Language', nested: { label: 'Settings' }, items: ['Language'] },
      zh: { label: '语言' },
    },
    before = structuredClone(dictionary);
  try {
    registerLocale('fr', { Language: 'Langue test', Settings: 'Paramètres test' });
    assert.deepEqual(localizeMessages(dictionary, 'fr'), {
      label: 'Langue test',
      nested: { label: 'Paramètres test' },
      items: ['Langue test'],
    });
    registerLocale('fr', { Language: 'Langue actuelle', Settings: 'Paramètres actuels' });
    assert.equal(localizeMessages(dictionary, 'fr').label, 'Langue actuelle');
    assert.deepEqual(dictionary, before);
    assert.throws(() => registerLocale('xx', {}), /Invalid language/);
    assert.throws(() => registerLocale('fr', { Language: '' }), /Invalid language/);
  } finally {
    registerLocale('fr', real);
  }
});

test('the actual main language combobox saves all choices and renders native labels, metadata and locale dates', async () => {
  const f = mainFixture();
  for (const item of languages) {
    await f.context.changeLanguage(item.code);
    const select = f.document.querySelector<HTMLSelectElement>('select[data-language]');
    assert.ok(select);
    assert.equal(select.getAttribute('aria-label'), translate(item.code, 'Language', '语言'));
    assert.equal(select.querySelectorAll('option').length, 16);
    assert.equal(
      defined(select.querySelector<HTMLOptionElement>('option[selected]')).value,
      item.code,
    );
    assert.deepEqual(
      [...select.querySelectorAll('option')].map((option) => option.textContent),
      languages.map((language) => language.label),
    );
    assert.equal(f.document.documentElement.lang, item.locale);
    assert.equal(f.document.documentElement.dir, item.direction);
    assert.equal(f.stored.get('dant.language'), item.code);
    assert.equal(f.context.state.settings.language, item.code);
    assert.equal(observedRecord(defined(f.requests.at(-1)).body).language, item.code);
    assert.equal(f.context.pendingActions.size, 0);
  }
  for (const code of ['fr', 'ja']) {
    await f.context.changeLanguage(code);
    const at = Date.UTC(2026, 9, 19, 8, 15);
    assert.equal(
      f.context.formatTime(at, true),
      new Intl.DateTimeFormat(languageInfo(code).locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(at)),
    );
  }
  await f.context.changeLanguage('ar');
  assert.equal(defined(f.context.state.messages[0]).text, 'Language');
  assert.equal(f.context.state.memory, 'Language');
  assert.equal(f.context.composerDraft, 'Language');
  const messages = parseHTML('<body>' + f.context.renderMessages() + '</body>').document;
  assert.equal(defined(messages.querySelector('.markdown')).textContent, 'Language');
  const file = parseHTML(
    '<body>' +
      f.context.renderAttachment({ id: 'file', name: 'Language', type: 'text/plain', size: 100 }) +
      '</body>',
  ).document;
  assert.equal(defined(file.querySelector('.file-attachment-name')).textContent, 'Language');
});

test('actual combobox changes retain their language lifecycle after all settings bindings run', async () => {
  const f = mainFixture(),
    binding = settingsBindingSequence(),
    changeLanguage = f.context.changeLanguage;
  let saving: Promise<void> | undefined;
  // Observe the real helper's promise through its event binding, so the test
  // also waits for a catalog's first asynchronous import when run on its own.
  f.context.changeLanguage = (value) => (saving = changeLanguage(value));
  f.context.reconcile = reconcile;
  f.context.settingsNavigation = createSettingsNavigation({
    document: f.document,
    getLanguage: () => f.context.state.settings.language,
    onChange: () => f.context.render(),
  });
  // Run both assignments in their real bind order. A generic settings loop
  // that includes language must fail rather than silently replace onchange.
  f.context.bind = () => {
    vm.runInContext(stripTypeScriptTypes(binding), f.context);
    f.context.settingsNavigation.bind();
  };
  f.context.render();
  for (const item of languages) {
    const before = f.requests.length,
      select = f.document.querySelector<HTMLSelectElement>('select[data-language]');
    assert.equal(typeof defined(select).onchange, 'function');
    defined(select)
      .querySelector<HTMLOptionElement>('option[selected]')
      ?.removeAttribute('selected');
    defined(defined(select).querySelector(`option[value="${item.code}"]`)).setAttribute(
      'selected',
      '',
    );
    assert.equal(defined(select).value, item.code);
    saving = undefined;
    defined(select).dispatchEvent(
      new (defined(f.document.defaultView).Event)('change', { bubbles: true }),
    );
    const currentSaving = () => saving;
    assert.equal(
      typeof defined(currentSaving()).then,
      'function',
      'the DOM event invokes the real save handler',
    );
    await saving;
    assert.equal(f.requests.length, before + 1, 'one DOM event sends one save: ' + item.code);
    assert.equal(defined(f.requests.at(-1)).route, '/settings');
    assert.equal(defined(f.requests.at(-1)).method, 'PATCH');
    assert.equal(observedRecord(defined(f.requests.at(-1)).body).language, item.code);
    assert.equal(f.context.state.settings.language, item.code);
    assert.equal(f.stored.get('dant.language'), item.code);
    const rendered = f.document.querySelector<HTMLSelectElement>('select[data-language]');
    assert.equal(
      defined(rendered).getAttribute('aria-label'),
      translate(item.code, 'Language', '语言'),
    );
    assert.equal(
      defined(f.document.querySelector('.language-card h2')).textContent,
      translate(item.code, 'Language', '语言'),
    );
    assert.equal(
      defined(f.document.querySelector('[data-settings-category="general"]')).textContent,
      translate(item.code, 'General', '通用'),
    );
    assert.equal(
      defined(defined(rendered).querySelector<HTMLOptionElement>('option[selected]')).value,
      item.code,
    );
    assert.equal(
      typeof defined(rendered).onchange,
      'function',
      'the rendered select remains bound',
    );
    assert.equal(f.document.documentElement.lang, item.locale);
    assert.equal(f.document.documentElement.dir, item.direction);
    assert.equal(f.context.pendingActions.size, 0);
    assert.equal(f.context.composerDraft, 'Language');
    assert.equal(defined(f.context.state.messages[0]).text, 'Language');
  }
  assert.deepEqual(f.errors, []);
  const before = f.requests.length,
    notifications = f.document.querySelector<HTMLInputElement>('#notifications');
  assert.equal(
    typeof defined(notifications).onchange,
    'function',
    'generic settings bindings still run',
  );
  defined(notifications).checked = false;
  defined(notifications).dispatchEvent(
    new (defined(f.document.defaultView).Event)('change', { bubbles: true }),
  );
  await settle();
  assert.equal(f.requests.length, before + 1);
  assert.equal(observedRecord(defined(f.requests.at(-1)).body).notifications, false);
  assert.equal(f.context.state.settings.language, defined(languages.at(-1)).code);
  assert.deepEqual(f.errors, []);
});

test('the actual change handler retains the chosen preference and draft when a save fails', async () => {
  const f = mainFixture();
  f.context.render();
  f.stored.set('dant.language', 'en');
  const failure = deferred<unknown>();
  f.context.api = () => failure.promise;
  vm.runInContext(stripTypeScriptTypes(settingsBindingSequence()), f.context);
  const select = f.document.querySelector<HTMLSelectElement>('select[data-language]');
  defined(defined(select).querySelector('[selected]')).removeAttribute('selected');
  defined(defined(select).querySelector('[value=fr]')).setAttribute('selected', '');
  const sending = invokeHandler(select, 'change');
  await settle();
  assert.ok(f.context.pendingActions.has('setting:language'));
  assert.equal(
    defined(f.document.querySelector<HTMLSelectElement>('select[data-language]')).hasAttribute(
      'disabled',
    ),
    true,
  );
  failure.reject(Error('synthetic save failure'));
  await sending;
  assert.equal(f.stored.get('dant.language'), 'en');
  assert.equal(f.context.state.settings.language, 'en');
  assert.equal(f.context.fallbackLanguage, 'en');
  assert.equal(f.context.pendingActions.size, 0);
  assert.equal(f.context.composerDraft, 'Language');
  assert.equal(f.errors.length, 1);
  const before = f.requests.length;
  await f.context.changeLanguage('unknown');
  assert.equal(f.requests.length, before);
});

test('Telegram issue summaries use real locale strings and numbers without mutating delivery records', async () => {
  const status = {
      enabled: true,
      configured: true,
      connected: true,
      paired: true,
      delivery: {
        unknown: 1234,
        failed: 1,
        lastIssue: { status: 'unknown', at: 1000, reason: 'timeout' },
      },
    },
    before = structuredClone(status);
  for (const item of languages) {
    await loadLanguage(item.code);
    const notice = telegramDeliveryNotice(status, { language: item.code });
    assert.ok(defined(notice).summary.includes(new Intl.NumberFormat(item.locale).format(1234)));
    if (!['en', 'zh'].includes(item.code)) {
      assert.ok(
        defined(notice).latest.includes(defined(readCatalog(item.code)['Request timed out'])),
      );
      assert.ok(
        defined(notice).hint.includes(
          defined(
            readCatalog(item.code)[
              'Check Telegram to see whether these messages arrived before sending again, to avoid duplicates. They will not be resent automatically.'
            ],
          ),
        ),
      );
    }
  }
  assert.deepEqual(status, before);
});

test('native adapters retain each supported language and only emit bounded call metadata', async () => {
  for (const code of codes) {
    assert.equal(trayStatus({ settings: { language: code } }).language, code);
    const calls: { command: string; args: Record<string, unknown> | undefined }[] = [],
      bridge = createNativeCallOverlay({
        desktop: true,
        loadCore: async () => ({ invoke: async (command, args) => calls.push({ command, args }) }),
        loadEvents: async () => ({ listen: async () => () => {} }),
      });
    bridge.update({
      callId: 'call',
      status: 'talking',
      language: code,
      theme: 'light',
      seconds: 1,
      privateText: 'Language',
    });
    await settle();
    await settle();
    assert.equal(observedRecord(defined(defined(calls[0]).args).state).language, code);
    assert.equal(JSON.stringify(calls).includes('privateText'), false);
    bridge.dispose();
    await settle();
  }
});

test('browser speech uses each shared BCP47 locale and preserves spoken and recognized user text', async () => {
  for (const item of languages) {
    let recognition: Recognizer | undefined, utterance: Utterance | undefined;
    class Recognizer implements BrowserRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: BrowserRecognition['onresult'] = null;
      onerror: BrowserRecognition['onerror'] = null;
      onend: BrowserRecognition['onend'] = null;
      abort() {}
      constructor() {
        recognition = this;
      }
      start() {
        queueMicrotask(() => {
          defined(this.onresult)({
            results: [
              Object.assign([{ transcript: 'Language', confidence: 1 }], { isFinal: true }),
            ],
          });
          defined(this.onend)();
        });
      }
    }
    class Utterance {
      text: string;
      lang = '';
      voice: SpeechSynthesisVoice | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    const matching: SpeechSynthesisVoice = {
        name: 'fixture',
        lang: item.speech,
        default: true,
        localService: true,
        voiceURI: 'fixture',
      },
      helper = new SpeechHelper({
        desktop: false,
        recognizer: Recognizer,
        Utterance,
        synthesis: {
          cancel() {},
          getVoices: () => [matching],
          speak: (value: Utterance) => {
            utterance = value;
            queueMicrotask(() => defined(value.onend)());
          },
        },
      });
    assert.equal(await helper.dictate(item.code), 'Language');
    assert.equal(defined(recognition).lang, item.speech);
    await helper.speak('Language', item.code);
    assert.equal(defined(utterance).lang, item.speech);
    assert.equal(defined(utterance).text, 'Language');
    assert.equal(defined(utterance).voice, matching);
  }
});

test('missing native speech languages report translated guidance without retries or private errors', async () => {
  for (const code of codes) {
    await loadLanguage(code);
    const calls: { command: string; args: Record<string, unknown> | undefined }[] = [],
      helper = new SpeechHelper({
        desktop: true,
        invoke: async (command, args) => {
          calls.push({ command, args });
          if (command === 'speech_start')
            throw Object.assign(Error('private device details'), {
              code: 'speech-language-unavailable',
            });
        },
      });
    await assert.rejects(
      helper.speak('Language', code),
      (error) =>
        errorCode(error) === 'speech-language-unavailable' &&
        errorMessage(error) ===
          translate(
            code,
            'The selected speech language is not installed. Add it in Windows Speech settings.',
            '尚未安装所选语音语言，请在 Windows 语音设置中添加。',
          ),
    );
    assert.deepEqual(
      calls.map((call) => call.command),
      ['speech_stop', 'speech_start'],
    );
    assert.equal(defined(defined(calls[1]).args).language, code);
  }
});

test('usage streaks, work badges and schedule counts translate their dynamic text and preserve user task names', async () => {
  const now = Date.UTC(2026, 9, 19, 12),
    at = now + 86400000,
    usage = {
      activity: {
        timeZone: 'UTC',
        recordedSince: now,
        days: [
          { date: '2026-10-18', subscription: { inputTokens: 1, outputTokens: 0 } },
          { date: '2026-10-19', subscription: { inputTokens: 1, outputTokens: 0 } },
        ],
      },
    };
  for (const code of codes.filter((code) => !['en', 'zh'].includes(code))) {
    await loadLanguage(code);
    const catalog = readCatalog(code),
      number = new Intl.NumberFormat(languageInfo(code).locale).format(2);
    const chart = parseHTML(
      '<body>' + renderUsageActivity({ usage, language: code, now }) + '</body>',
    ).document;
    assert.equal(
      defined(chart.querySelector('[data-usage-stat=longest]')).textContent,
      defined(catalog['{count} days']).replace('{count}', number),
    );
    const model = workProgress(
      { messages: [], workTasks: [], worker: { status: 'online' } },
      { language: code },
    );
    assert.equal(
      model.labels.queuedCount(2),
      defined(catalog['{count} queued']).replace('{count}', number),
    );
    assert.equal(
      model.labels.reviewCount(2),
      defined(catalog['{count} awaiting review']).replace('{count}', number),
    );
    const state = {
      settings: { language: code, vm: {} },
      worker: { status: 'online' },
      schedules: [
        { id: 'one', text: 'Language', status: 'pending', at, timeZone: 'UTC' },
        { id: 'two', text: 'Settings', status: 'pending', at, timeZone: 'UTC' },
      ],
    };
    const { document } = parseHTML('<body></body>');
    const schedules = createSchedules({
      getState: () => state,
      document,
      now: () => now,
      timeZone: () => 'UTC',
      request: async () => unexpectedFixtureOperation(),
      render() {},
      toast() {},
    });
    const page = parseHTML('<body>' + schedules.renderPage() + '</body>').document;
    assert.equal(
      defined(page.querySelector('.skills-count')).textContent,
      defined(catalog['{count} tasks']).replace('{count}', number),
    );
    assert.equal(defined(page.querySelector('.schedule-card-text')).textContent, 'Language');
    assert.equal(
      defined(page.querySelector('time')).textContent,
      new Intl.DateTimeFormat(languageInfo(code).locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(at)),
    );
  }
  assert.equal(translateCount('fr', 2, '{count} day', '{count} days'), '2 jours');
  assert.equal(translateCount('ja', 2, '{count} day', '{count} days'), '2 日');
  for (const value of ['private text', -1, Infinity, NaN])
    assert.throws(
      () => Reflect.apply(translateCount, undefined, ['fr', value, '{count} day', '{count} days']),
      /Invalid localized count/,
    );
});
