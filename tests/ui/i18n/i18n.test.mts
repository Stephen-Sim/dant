import type { AppState } from '../../../ui/app/application-types.ts';
import type { ApiOptions, ChatMessage, Attachment } from '../../../ui/shared/contracts.mts';
import type { BrowserRecognition } from '../../../ui/platform/speech-types.ts';
import { en, zh } from '../../../ui/i18n/interface-copy.mts';
import { observedRecord } from '../../support/service-fixtures.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined, invokeHandler } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection, compactCss } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import { createTaskReplyController } from '../../../ui/work/task-reply.mts';
import { bindAttachmentImages } from '../../../ui/files/attachment-images.mts';
import test from 'node:test';
import { createCallSubtitles } from '../../../ui/call/call-subtitles.mts';
import { canPreviewFile } from '../../../ui/files/file-preview.mts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  workProgress,
  renderWorkPriority,
  renderWorkReply,
  renderWorkEntry,
  renderActiveWork,
  renderVoiceWorkHistory,
  renderWorkTaskHistory,
} from '../../../ui/work/work-progress.mts';
import { SpeechHelper, speechMessages } from '../../../ui/platform/speech.mts';
import { formatCallDuration } from '../../../ui/call/call-duration.mts';
import { defaultReactions } from '../../../src/conversation/reactions.mts';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { formatPresence } from '../../../ui/chat/presence.mts';
import { createSchedules } from '../../../ui/schedules/schedules.mts';
import { createMemorySettings } from '../../../ui/settings/memory-settings.mts';
import {
  telegramConnectionError,
  telegramDeliveryNotice,
} from '../../../ui/chat/telegram-delivery.mts';
import { renderUsageSettings } from '../../../ui/settings/usage-settings.mts';
import { createUsageActivityController } from '../../../ui/settings/usage-activity.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
const section = (start: string, end: string) => sourceSection(source, start, end);
function fixture(selected = 'zh') {
  const storage = new Map<string, string>(),
    requests: { route: string; options: ApiOptions | undefined }[] = [];
  const { document } = parseHTML('<html><body></body></html>');
  document.documentElement.dataset.theme = 'light';
  const context = uiEntrypointFixture({
    vmBackups: { setVisible() {}, render: () => '', bind() {}, dispose() {}, load: async () => {} },
    progressActions: { bind() {}, renderConfirmation: () => '', onClose() {}, busy: false },
    workDisclosures: { capture() {}, bind() {}, isOpen: () => false },
    bindAttachmentImages,
    textEditor: { renderSettings: () => '', bind() {}, load: async () => {}, dispose() {} },
    canPreviewFile,
    workProgress,
    renderWorkReply,
    renderWorkTaskHistory,
    renderWorkPriority,
    renderWorkEntry,
    renderActiveWork,
    renderVoiceWorkHistory,
    downloads: { bind() {} },
    filePreview: { bind() {}, syncModal: (value: unknown) => value },
    settingsNavigation: {
      render: (sections: Record<string, string>) => Object.values(sections).join(''),
    },
    appUpdates: { render: () => '', dispose() {} },
    formatPresence,
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
    defaultReactions,
    emojiFor: null as string | null,
    formatCallDuration,
    callDuration: {
      snapshot: { callId: null as string | null, confirmed: false, seconds: 0, finalized: false },
    },
    document,
    appearance: { preferences: { theme: 'system', font: 'system', fontSize: 13 } },
    fontInventory: null,
    fontLoading: false,
    fontError: '',
    fontSearch: '',
    fontMenuOpen: false,
    appearanceAdvanced: false,
    vmProviderInfo: null,
    vmProvidersBusy: false,
    vmProvidersError: '',
    vmProfiles: null,
    vmProfilesVisible: false,
    vmProfilesBusy: false,
    vmProfilesError: '',
    selectedVMProfile: '',
    legacyVMDirectory: '',
    telegramStatus: null,
    telegramLoading: false,
    telegramError: '',
    telegramPairing: null,
    telegramPairTimer: null,
    fallbackLanguage: 'zh',
    state: {
      settings: {
        language: selected,
        vm: { host: '', user: 'dant', port: 22, keyPath: '' },
        nativeVoice: 'ember',
        apiVoice: 'marin',
        notifications: false,
        model: '',
      },
      worker: {
        status: 'online',
        account: null,
        models: [],
        realtime: { subscription: { available: true }, key: { configured: false } },
      },
      messages: [],
      queue: [],
      schedules: [],
      active: null,
      call: null,
      memory: '',
    } as AppState,
    page: 'chat',
    chatMode: 'text',
    showComputer: false,
    eventConnected: true,
    pc: null as Pick<RTCPeerConnection, 'connectionState'> | null,
    stream: null,
    callStarting: false,
    callMini: false,
    callMuted: false,
    callConnected: false,
    callChannel: null as Pick<RTCDataChannel, 'readyState'> | null,
    callProvider: 'subscription',
    callStops: { pending: false },
    messageSubmissions: { unknown: null as { payload: { text: string } } | null },
    pendingActions: new Set(),
    voiceChoices: ['ember'],
    apiVoiceChoices: ['marin'],
    voiceApiExpanded: false,
    voiceError: '',
    vmDraft: null,
    manualVMExpanded: false,
    provisionDraft: { provider: 'auto', cpu: 4, memoryGB: 6, diskGB: 40, adminSudo: false },
    provisionExpanded: false,
    steerExpectedTurn: null,
    steerDraft: '',
    progressExpanded: false,
    scheduleDraft: { text: '', at: '' },
    composerDraft: '',
    replyTo: null,
    attachments: [],
    uploading: 0,
    sending: false,
    recording: null,
    recordStarting: false,
    recordDraft: null,
    dictating: false,
    speakingId: null,
    attachmentMenu: false,
    screenURL: '',
    screenError: '' as string | boolean,
    innerWidth: 1440,
    modal: null,
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    api: async (route: string, options?: ApiOptions) => {
      requests.push({ route, options });
      return { ok: true };
    },
    render: () => {},
    esc: (value: unknown) => String(value ?? ''),
    ico: (name: string) => `<svg>${name}</svg>`,
    button: (action: string, _icon: string, label: string) =>
      `<button data-action="${action}" aria-label="${label}">${label}</button>`,
    eyes: () => '',
    md: (text: string) => text,
    formatTime: () => '',
    humanControl: () => false,
    unknownTask: (message: ChatMessage | undefined) => message?.submission === 'unknown',
    speechBlocked: () => false,
    renderLoginDetails: () => '',
    fileURL: (file: Attachment) => '/fixture/' + file.id,
  });
  Object.assign(context, { telegramConnectionError, telegramDeliveryNotice, renderUsageSettings });
  context.usageActivity = createUsageActivityController({ document: context.document });
  const scheduledTasks = createSchedules({
    getState: () => context.state,
    document: parseHTML('<html><body></body></html>').document,
    request: context.api,
    connected: () => true,
    render() {},
    toast() {},
  });
  context.memorySettings = createMemorySettings({
    getState: () => context.state,
    getLanguage: () => context.state?.settings?.language || context.fallbackLanguage,
    request: context.api,
    connected: () => false,
  });
  context.callSubtitles = createCallSubtitles();
  context.taskReplies ??= createTaskReplyController({
    document: context.document,
    getModel: () => ({}),
  });
  const fixtureContext = Object.assign(context, {
    scheduledTasks,
    words: { en, zh, t: (key: string) => key },
  });
  vm.createContext(uiFixtureContext(fixtureContext));
  vm.runInContext(
    stripTypeScriptTypes(
      [
        section('function currentState(', 'const subscriptionVoiceUnavailable='),
        section('const subscriptionVoiceUnavailable=', 'const iconCache='),
        section('function renderHeader(status){', 'function renderAttachmentOptions(){'),
        section('function renderAttachmentOptions(){', 'function speechBlocked(){'),
        section('function renderAttachment(file){', 'function renderComputer(){'),
        section('function renderComputer(){', 'function openModal('),
      ].join('\n') + '\nglobalThis.words={zh,en,t};',
    ),
    context,
  );
  return { context: fixtureContext, storage, requests };
}

test('both UI and speech dictionaries have complete matching keys', () => {
  const { context } = fixture();
  const { zh, en } = context.words;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(speechMessages.zh).sort(), Object.keys(speechMessages.en).sort());
  for (const dictionary of [zh, en, speechMessages.zh, speechMessages.en])
    for (const [key, value] of Object.entries(dictionary))
      assert.ok(typeof value === 'string' && value.trim(), `Empty translation: ${key}`);
  for (const match of source.matchAll(/\bt\(['"]([^'"]+)['"]\)/g))
    assert.ok(defined(match[1]) in zh, `Missing UI phrase: ${match[1]}`);
});

test('Telegram hints explain new-message sync, VM availability and the existing-history boundary in both languages', () => {
  const { context } = fixture();
  assert.match(
    context.words.en.telegramHint,
    /new messages and attachments sync with desktop chat/,
  );
  assert.match(context.words.en.telegramHint, /VM online/);
  assert.match(context.words.en.telegramHint, /Existing history is not bulk exported/);
  assert.match(context.words.zh.telegramHint, /同步新消息和附件/);
  assert.match(context.words.zh.telegramHint, /VM 在线/);
  assert.match(context.words.zh.telegramHint, /不会批量发送已有记录/);
});

test('settings language persists and updates pages, status, accessibility and retained errors', async () => {
  const { context: c, storage, requests } = fixture();
  assert.match(c.renderHeader('online'), /在线/);
  assert.match(c.renderChat(), /aria-label="语音消息"/);
  c.voiceError = 'voiceUnavailable';
  c.screenError = true;
  await c.changeLanguage('en');
  assert.equal(storage.get('dant.language'), 'en');
  assert.equal(defined(requests[0]).route, '/settings');
  assert.equal(observedRecord(defined(defined(requests[0]).options).body).language, 'en');
  assert.match(c.renderHeader('online'), /Online/);
  assert.match(c.renderChat(), /Message dant…/);
  assert.match(c.renderChat(), /aria-label="Voice message"/);
  assert.doesNotMatch(c.renderChat(), /听写|上传|录音/);
  const computer = c.renderComputer();
  assert.match(computer, /aria-label="Resize computer panel"/);
  assert.match(computer, /aria-label="Work computer keyboard input"/);
  assert.match(computer, /The desktop could not refresh/);
  assert.match(c.renderSettings(), /Settings|Language|Call voice/);
  assert.match(c.renderVoiceSettings(c.state.settings), /Voice options are unavailable/);
  assert.match(c.renderMemory(), /shared identity and durable notes/);
  assert.match(c.renderSchedules(), /No scheduled tasks/);
  await c.changeLanguage('zh');
  assert.equal(storage.get('dant.language'), 'zh');
  assert.match(c.renderComputer(), /调整电脑区域宽度|桌面暂时无法刷新/);
  assert.match(c.renderVoiceSettings(c.state.settings), /暂时无法获取声音选项/);
  assert.match(c.renderMemory(), /共享身份与持久记忆/);
  assert.match(c.renderSchedules(), /暂无定时任务/);
  Reflect.set(c, 'state', null);
  c.fallbackLanguage = 'en';
  assert.equal(
    c.words.t('retryConnection'),
    'Reconnect',
    'boot failure uses the remembered language',
  );
  const defaultFixture = fixture();
  Reflect.set(defaultFixture.context, 'state', null);
  assert.equal(
    defaultFixture.context.words.t('retryConnection'),
    '重新连接',
    'an installation without a language preference defaults to Chinese',
  );
});

test('call lifecycle, uncertain messages, task states and provisioning have meaningful text in both languages', () => {
  const expected = {
    zh: {
      ready: '开始订阅通话',
      recover: '工作电脑中仍有通话',
      pending: '正在等待结束通话',
      unknown: '发送结果未确认',
      check: '检查任务状态',
      confirm: '我确认重新发送',
      install: '正在安装桌面与工作环境',
      draft: '草稿',
      waiting_user: '等待你回答',
      pausing: '正在暂停',
    },
    en: {
      ready: 'Start subscription call',
      recover: 'A call remains on the work computer',
      pending: 'Waiting to end the call',
      unknown: 'Message outcome unconfirmed',
      check: 'Check task status',
      confirm: 'I confirm: send again',
      install: 'Installing the desktop and work environment',
      draft: 'Draft',
      waiting_user: 'Waiting for your answer',
      pausing: 'Pausing',
    },
  };
  for (const language of ['zh', 'en'] as const) {
    const { context: c } = fixture(language),
      text = expected[language];
    assert.ok(c.renderCallReady().includes(text.ready));
    c.state.call = { id: 'fixture-call', provider: 'subscription' };
    assert.ok(c.renderCall().includes(text.recover));
    c.callStops.pending = true;
    assert.ok(c.renderCall().includes(text.pending));
    c.messageSubmissions.unknown = { payload: { text: 'Preserved draft' } };
    const warning = c.renderUnconfirmedMessage();
    for (const value of [text.unknown, text.check, text.confirm, 'Preserved draft'])
      assert.ok(warning.includes(value));
    c.state.provisioning = { status: 'installing', running: true };
    assert.ok(c.renderProvisionCard().includes(text.install));
    for (const status of ['draft', 'waiting_user', 'pausing'] as const)
      assert.equal(c.words.t(status), text[status]);
    c.state.conversationId = 'conversation';
    c.state.capabilities = { workReply: true, taskReopen: true };
    c.state.workTasks = [
      {
        id: 'work',
        turnId: 'voice-turn',
        title: 'Saved task',
        status: 'running',
        plan: { steps: [{ step: 'Verify', status: 'inProgress' }] },
      },
    ];
    c.state.active = {
      workId: 'work',
      source: 'voice',
      turnId: 'voice-turn',
      messageId: null,
      canSteer: true,
    };
    assert.match(c.renderProgress(), language === 'zh' ? /回复任务/ : /Reply to task/);
    assert.doesNotMatch(c.renderProgress(), /id="steer-form"|textarea/);
  }
});

test('known errors localize precisely while unknown backend diagnostics remain intact', () => {
  const { context: c } = fixture();
  assert.match(c.errorText(Error('The voice call changed')), /通话已变化/);
  assert.match(
    c.errorText({ name: 'NotAllowedError', message: 'Permission denied' }),
    /麦克风权限未获准/,
  );
  assert.match(c.errorText(Error('Invalid JSON response from local service')), /无效的 JSON/);
  assert.match(
    c.errorText(Error('Check the unconfirmed message before sending again')),
    /请求可能已经送达/,
  );
  const busyConnection =
    'Stop active work and return computer control before changing its connection';
  assert.match(c.errorText(Error(busyConnection)), /停止当前工作、结束通话并交还电脑控制权/);
  const diagnostic = 'Worker failed with diagnostic 0x80370102';
  assert.equal(c.errorText(Error(diagnostic)), '请求失败：' + diagnostic);
  assert.equal(c.errorText(diagnostic, 'serviceNotice'), '服务提示：' + diagnostic);
  c.state.settings.language = 'en';
  assert.equal(c.errorText(Error(diagnostic)), 'Request failed: ' + diagnostic);
  assert.match(c.errorText(Error('The voice call changed')), /The call changed/);
  assert.match(
    c.errorText({ name: 'NotFoundError', message: 'device missing' }),
    /No microphone was found/,
  );
  assert.match(
    c.errorText(
      Error('The computer connected, but its default response language could not be updated.'),
    ),
    /default response language could not be updated/,
  );
  assert.match(
    c.errorText(Error(busyConnection)),
    /Stop active work, end the call and return computer control/,
  );
});

test('speech fallback failures and microphone permissions follow the requested language without device access', async () => {
  for (const language of ['zh', 'en'] as const) {
    const helper = new SpeechHelper({ desktop: false, recognizer: null, synthesis: null });
    await assert.rejects(
      helper.dictate(language),
      language === 'zh' ? /当前浏览器不支持听写/ : /Dictation is not supported/,
    );
    await assert.rejects(
      helper.speak('fixture', language),
      language === 'zh' ? /当前浏览器不支持朗读/ : /Read aloud is not supported/,
    );
    let recognition: Recognizer | undefined;
    class Recognizer implements BrowserRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: BrowserRecognition['onresult'] = null;
      onerror: BrowserRecognition['onerror'] = null;
      onend: BrowserRecognition['onend'] = null;
      constructor() {
        recognition = this;
      }
      start() {}
      abort() {
        this.onend?.();
      }
    }
    const recognizer = new SpeechHelper({
      desktop: false,
      recognizer: Recognizer,
      synthesis: null,
    });
    const listening = recognizer.dictate(language);
    await Promise.resolve();
    defined(defined(recognition).onerror)({ error: 'not-allowed' });
    defined(defined(recognition).onend)();
    await assert.rejects(
      listening,
      language === 'zh' ? /麦克风权限未获准/ : /Microphone permission was not granted/,
    );
  }
});

test('live and completed call durations use the same clock format and localized labels', () => {
  for (const language of ['zh', 'en'] as const) {
    const { context: c } = fixture(language);
    c.state.call = { id: 'call-test', provider: 'subscription', connectedAt: null };
    c.callStarting = true;
    assert.doesNotMatch(c.renderCall(), /data-call-duration/);
    c.callStarting = false;
    c.callConnected = true;
    c.pc = { connectionState: 'connected' };
    c.callChannel = { readyState: 'open' };
    c.callDuration.snapshot = {
      callId: 'call-test',
      confirmed: true,
      seconds: 75,
      finalized: false,
    };
    const live = c.renderCall();
    assert.match(live, /data-call-duration[^>]*>1:15/);
    assert.ok(live.includes(language === 'zh' ? '通话时长' : 'Call duration'));
    assert.ok(live.includes(language === 'zh' ? '正在通话' : 'In a call'));
    c.pc = null;
    c.state.call = null;
    c.callDuration.snapshot.finalized = true;
    assert.ok(
      c.renderCallReady().includes((language === 'zh' ? '通话已结束' : 'Call ended') + ' · 1:15'),
    );
    c.state.messages = [
      {
        id: 'history',
        role: 'system',
        kind: 'call',
        callId: 'call-test',
        seconds: 75,
        time: 1,
        text: '',
      },
    ];
    assert.match(c.renderMessages(), /1:15/);
  }
});

test('the rendered reaction picker contains the six standard reactions with Chinese and English names', () => {
  const expectedEmoji = ['👍', '❤️', '😆', '😮', '😢', '😡'],
    expectedIds = ['like', 'love', 'haha', 'wow', 'sad', 'angry'],
    names = {
      zh: ['赞', '爱', '大笑', '惊讶', '难过', '生气'],
      en: ['Like', 'Love', 'Haha', 'Wow', 'Sad', 'Angry'],
    };
  for (const language of ['zh', 'en'] as const) {
    const { context: c } = fixture(language);
    c.emojiFor = 'reaction-message';
    c.state.messages = [
      {
        id: 'reaction-message',
        role: 'assistant',
        status: 'completed',
        text: 'A completed reply',
        time: 1,
        attachments: [],
        reactions: ['👍', '😂', '👀', '🎉'],
      },
    ];
    const { document } = parseHTML('<main>' + c.renderMessages() + '</main>'),
      buttons = [...document.querySelectorAll<HTMLButtonElement>('.reaction-menu button')];
    assert.equal(
      defined(document.querySelector<HTMLElement>('.reaction-menu')).parentNode,
      document.querySelector<HTMLElement>('.message-actions'),
      'the picker must anchor to the adjacent toolbar',
    );
    assert.deepEqual(
      buttons.map((button) => button.dataset.emoji),
      expectedEmoji,
    );
    assert.deepEqual(
      buttons.map((button) => button.dataset.reactionId),
      expectedIds,
    );
    assert.deepEqual(
      buttons.map((button) => button.title),
      names[language],
    );
    assert.deepEqual(
      buttons.map((button) => button.getAttribute('aria-label')),
      names[language],
    );
    assert.equal(defined(buttons[0]).getAttribute('aria-pressed'), 'true');
    assert.equal(defined(buttons[2]).getAttribute('aria-pressed'), 'false');
    const historical = [...document.querySelectorAll<HTMLButtonElement>('.reactions button')];
    assert.deepEqual(
      historical.map((button) => button.dataset.emoji),
      ['👍', '😂', '👀', '🎉'],
    );
    for (const button of historical) {
      assert.equal(button.dataset.react, 'reaction-message');
      assert.match(
        defined(button.getAttribute('aria-label')),
        language === 'zh' ? /^取消表情: / : /^Remove reaction: /,
      );
      assert.equal(button.getAttribute('aria-pressed'), 'true');
    }
  }
});

test('message actions sit beside each bubble while reactions, receipts and attachments keep their own controls', () => {
  const { context: c } = fixture();
  c.state.messages = [
    {
      id: 'assistant-layout',
      role: 'assistant',
      status: 'completed',
      text: 'A long reply '.repeat(80),
      time: 1,
      reactions: ['❤️'],
      attachments: [
        { id: 'picture', name: 'Picture.png', type: 'image/png', size: 1200 },
        { id: 'report', name: 'Long-report-name.txt', type: 'text/plain', size: 100 },
      ],
    },
    {
      id: 'user-layout',
      role: 'user',
      status: 'review',
      text: 'User message',
      time: 2,
      reactions: [],
      executorConfirmedAt: 2,
      attachments: [],
    },
  ];
  const { document, Event } = parseHTML('<main>' + c.renderMessages() + '</main>');
  for (const article of document.querySelectorAll<HTMLElement>('article.message')) {
    const content = article.querySelector<HTMLElement>('.message-content'),
      row = defined(content).querySelector<HTMLElement>('.message-bubble-row'),
      bubble = defined(row).querySelector<HTMLElement>('.bubble'),
      actions = defined(row).querySelector<HTMLElement>('.message-actions'),
      meta = defined(content).querySelector<HTMLElement>('.message-meta');
    assert.equal(defined(bubble).parentNode, row);
    assert.equal(defined(actions).parentNode, row);
    assert.equal(defined(bubble).nextElementSibling, actions);
    assert.equal(defined(actions).getAttribute('role'), 'toolbar');
    assert.equal(defined(actions).getAttribute('aria-label'), '消息操作');
    assert.equal(defined(meta).querySelector<HTMLElement>('.message-actions'), null);
    assert.equal(defined(meta).previousElementSibling, row);
    assert.equal(
      defined(defined(actions).querySelector<HTMLButtonElement>('[data-reply]')).dataset.reply,
      article.dataset.id,
    );
    assert.equal(
      defined(defined(actions).querySelector<HTMLButtonElement>('[data-picker]')).dataset.picker,
      article.dataset.id,
    );
  }
  const assistant = document.querySelector<HTMLElement>('.assistant'),
    user = document.querySelector<HTMLElement>('.user');
  assert.equal(
    defined(defined(assistant).querySelector<HTMLButtonElement>('.message-meta .reactions button'))
      .dataset.emoji,
    '❤️',
  );
  assert.ok(defined(user).querySelector<HTMLElement>('.message-meta .delivery-state'));
  assert.equal(defined(user).querySelector<HTMLElement>('.message-meta .task-status'), null);
  const image = defined(assistant).querySelector<HTMLButtonElement>('[data-preview="picture"]'),
    download = defined(assistant).querySelector<HTMLButtonElement>(
      'button[data-download="report"]',
    ),
    view = defined(assistant).querySelector<HTMLButtonElement>(
      'button[data-file-preview="report"]',
    );
  assert.equal(
    defined(image).closest('.bubble'),
    defined(assistant).querySelector<HTMLElement>('.bubble'),
  );
  assert.equal(
    defined(download).closest('.bubble'),
    defined(assistant).querySelector<HTMLElement>('.bubble'),
  );
  assert.equal(defined(download).getAttribute('type'), 'button');
  assert.equal(defined(download).hasAttribute('href'), false);
  assert.match(defined(view).textContent, /Long-report-name.txt/);
  assert.equal(defined(download).querySelector<HTMLElement>('.message-actions'), null);
  const reply = defined(assistant).querySelector<HTMLButtonElement>('[data-reply]');
  let clicked = 0;
  defined(reply).addEventListener('click', () => clicked++);
  defined(c.state.messages[0]).text += ' New streamed text';
  const next = document.createElement('main');
  next.innerHTML = c.renderMessages();
  reconcile(defined(document.querySelector<HTMLElement>('main')), next);
  assert.equal(document.querySelector<HTMLButtonElement>('.assistant [data-reply]'), reply);
  defined(reply).dispatchEvent(new Event('click'));
  assert.equal(clicked, 1);
  const css = compactCss(
    fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'),
  );
  assert.match(css, /\.message-bubble-row\{[^}]*display:flex;align-items:center/);
  assert.match(css, /\.user \.message-bubble-row\{flex-direction:row-reverse/);
  assert.match(
    css,
    /@media\(hover:none\),\(pointer:coarse\)\{\.message-bubble-row>\.message-actions\{opacity:1;pointer-events:auto/,
  );
  assert.match(css, /\.message-bubble-row \.file-card\{min-width:0/);
  assert.match(css, /\.message-bubble-row>\.bubble\{[^}]*min-width:0/);
  const actionRules = [...css.matchAll(/([^{}]*\.message-actions[^{}]*)\{([^{}]*)\}/g)]
    .map((match) => match[2])
    .join(';');
  assert.doesNotMatch(actionRules, /position\s*:\s*(?:absolute|fixed)/);
});

test('cancelled chat messages retain their content and receipts without retry or task-error furniture in either language', () => {
  for (const language of ['zh', 'en'] as const) {
    const { context: c } = fixture(language);
    c.state.messages = [
      {
        id: 'cancelled',
        role: 'user',
        status: 'cancelled',
        text: 'Please find my profile',
        time: 1,
        executorConfirmedAt: 2,
        error: 'The task stopped before completion.',
        attachments: [{ id: 'note', name: 'note.txt', type: 'text/plain', size: 12 }],
      },
      {
        id: 'reply',
        role: 'assistant',
        status: 'completed',
        text: 'Do you mean the page link or the configuration file?',
        replyTo: 'cancelled',
        time: 2,
        attachments: [],
      },
      {
        id: 'failed',
        role: 'user',
        status: 'failed',
        text: 'A separate failed request',
        time: 3,
        error: 'A real failure',
      },
      {
        id: 'interrupted',
        role: 'user',
        status: 'interrupted',
        text: 'An interrupted request',
        time: 4,
      },
      {
        id: 'unknown',
        role: 'user',
        status: 'failed',
        submission: 'unknown',
        text: 'An uncertain request',
        time: 5,
      },
    ];
    const { document } = parseHTML('<main>' + c.renderMessages() + '</main>'),
      cancelled = document.querySelector<HTMLButtonElement>('[data-id="cancelled"]');
    assert.match(
      defined(defined(cancelled).querySelector<HTMLElement>('.markdown')).textContent,
      /Please find my profile/,
    );
    assert.ok(defined(cancelled).querySelector<HTMLButtonElement>('[data-file-preview="note"]'));
    assert.ok(defined(cancelled).querySelector<HTMLButtonElement>('[data-reply]'));
    assert.ok(defined(cancelled).querySelector<HTMLElement>('.delivery-state'));
    assert.equal(
      defined(defined(cancelled).querySelector<HTMLElement>('.delivery-state')).title,
      language === 'zh' ? '执行器已读' : 'Read by executor',
    );
    assert.equal(
      defined(cancelled).querySelector<HTMLButtonElement>(
        '[data-retry],.retry-message,.task-status,.error',
      ),
      null,
    );
    assert.doesNotMatch(
      defined(cancelled).textContent,
      /Cancelled|已取消|Retry|重试|The task stopped before completion/,
    );
    const reply = document.querySelector<HTMLButtonElement>('[data-id="reply"]');
    assert.match(
      defined(defined(reply).querySelector<HTMLElement>('.markdown')).textContent,
      /page link or the configuration file/,
    );
    assert.match(
      defined(defined(reply).querySelector<HTMLElement>('blockquote')).textContent,
      /Please find my profile/,
    );
    assert.match(
      defined(document.querySelector<HTMLButtonElement>('[data-retry="failed"]')).textContent,
      language === 'zh' ? /失败 · 重试/ : /Failed · Retry/,
    );
    assert.ok(document.querySelector<HTMLButtonElement>('[data-id="failed"] .error'));
    assert.ok(document.querySelector<HTMLButtonElement>('[data-retry="interrupted"]'));
    assert.equal(
      defined(document.querySelector<HTMLButtonElement>('[data-retry="unknown"]')).textContent,
      language === 'zh' ? '查看未确认的任务' : 'Review unconfirmed task',
    );
  }
});

test('an already-bound chat retry cannot replay a message cancelled or removed before the click', async () => {
  const { context: c } = fixture('en'),
    attempts: string[] = [],
    toasts: unknown[] = [];
  c.state.messages = [
    { id: 'was-failed', role: 'user', status: 'failed', text: 'A request', time: 1 },
  ];
  const { document } = parseHTML(
    '<main>' + c.renderMessages() + '</main><input id="file-input" type="file" hidden>',
  );
  c.document = document;
  for (const method of [
    'bindSteer',
    'bindProvision',
    'bindVoiceKey',
    'bindTelegram',
    'bindAppearance',
    'bindVMSettings',
    'bindComputerInput',
  ] as const)
    c[method] = () => {};
  c.resumeTask = async (id) => {
    attempts.push(id);
  };
  c.toast = (text) => toasts.push(text);
  c.openModal = () => attempts.push('review');
  vm.runInContext(
    stripTypeScriptTypes(section('function bind(){', 'async function taskRequest(')),
    c,
  );
  c.bind();
  const button = document.querySelector<HTMLButtonElement>('[data-retry]');
  assert.ok(button);
  defined(c.state.messages[0]).status = 'cancelled';
  defined(c.state.messages[0]).submission = 'unknown';
  await invokeHandler(button, 'click');
  assert.deepEqual(
    attempts,
    [],
    'a stale cancelled button cannot resume or open an unrelated recovery flow',
  );
  c.state.messages = [];
  await invokeHandler(button, 'click');
  assert.deepEqual(attempts, []);
  assert.deepEqual(toasts, []);
  c.state.messages = [{ id: 'was-failed', role: 'user', status: 'failed', text: '' }];
  await invokeHandler(button, 'click');
  assert.deepEqual(
    attempts,
    ['was-failed'],
    'a still-valid failure retains its existing retry action',
  );
});

test('dant-owned reactions on user messages stay distinct, localized and non-editable beside matching human feedback', async () => {
  for (const [language, label] of [
    ['zh', 'dant 的回应：赞'],
    ['en', 'dant reacted: Like'],
  ]) {
    const { context: c } = fixture(language),
      requests: { route: string; body: unknown }[] = [];
    c.state.messages = [
      {
        id: 'reacted-user',
        role: 'user',
        status: 'review',
        text: 'Thank you',
        time: 1,
        reactions: ['👍'],
        assistantReaction: '👍',
        attachments: [],
      },
    ];
    const { document, Event } = parseHTML(
      '<main>' + c.renderMessages() + '</main><input id="file-input" type="file" hidden>',
    );
    c.document = document;
    for (const method of [
      'bindSteer',
      'bindProvision',
      'bindVoiceKey',
      'bindTelegram',
      'bindAppearance',
      'bindVMSettings',
      'bindComputerInput',
    ] as const)
      c[method] = () => {};
    c.post = async (route, body) => requests.push({ route, body });
    c.toast = () => {};
    vm.runInContext(
      stripTypeScriptTypes(section('function bind(){', 'async function taskRequest(')),
      c,
    );
    c.bind();
    const badge = document.querySelector<HTMLElement>('.user .assistant-reaction'),
      human = document.querySelector<HTMLButtonElement>('.user .reactions button');
    assert.ok(badge, 'an actual dant reaction must be visible');
    assert.equal(badge.tagName, 'SPAN');
    assert.equal(badge.getAttribute('role'), 'img');
    assert.equal(badge.title, label);
    assert.equal(badge.getAttribute('aria-label'), label);
    assert.equal(defined(badge.querySelector<HTMLElement>('small')).textContent, 'dant');
    assert.equal(defined(badge.querySelector<HTMLElement>('span')).textContent, '👍');
    assert.equal(badge.hasAttribute('data-react'), false);
    assert.equal(badge.querySelector<HTMLButtonElement>('button,[data-react],[data-action]'), null);
    assert.equal(badge.hasAttribute('tabindex'), false);
    assert.ok(human);
    assert.equal(human.dataset.emoji, '👍');
    assert.equal(human.dataset.react, 'reacted-user');
    assert.equal(document.querySelectorAll<HTMLElement>('.user .reactions').length, 1);
    assert.equal(
      document.querySelectorAll<HTMLElement>('.user .reactions > *').length,
      2,
      'the same emoji may belong to dant and the human independently',
    );
    badge.dispatchEvent(new Event('click', { bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0, 'a user cannot toggle dant-owned feedback');
    human.dispatchEvent(new Event('click', { bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(defined(requests[0]).route, '/messages/reacted-user/reaction');
    assert.equal(observedRecord(defined(requests[0]).body).emoji, '👍');
    assert.equal(defined(c.state.messages[0]).assistantReaction, '👍');
  }
});

test('dant reactions are never guessed from message content and only apply to user messages', () => {
  const { context: c } = fixture();
  c.state.messages = [
    {
      id: 'plain-user',
      role: 'user',
      status: 'review',
      text: 'I love this! 👍',
      time: 1,
      reactions: [],
      attachments: [],
    },
    {
      id: 'assistant',
      role: 'assistant',
      status: 'completed',
      text: 'Thanks!',
      time: 2,
      reactions: [],
      assistantReaction: '❤️',
      attachments: [],
    },
  ];
  const { document } = parseHTML('<main>' + c.renderMessages() + '</main>');
  assert.equal(document.querySelector<HTMLElement>('.assistant-reaction'), null);
  defined(c.state.messages[0]).assistantReaction = '❤️';
  let next = document.createElement('main');
  next.innerHTML = c.renderMessages();
  reconcile(defined(document.querySelector<HTMLElement>('main')), next);
  assert.equal(
    defined(document.querySelector<HTMLElement>('.user .assistant-reaction')).getAttribute(
      'aria-label',
    ),
    'dant 的回应：爱',
  );
  Reflect.set(defined(c.state.messages[0]), 'assistantReaction', null);
  next = document.createElement('main');
  next.innerHTML = c.renderMessages();
  reconcile(defined(document.querySelector<HTMLElement>('main')), next);
  assert.equal(
    document.querySelector<HTMLElement>('.assistant-reaction'),
    null,
    'backend cancellation removes only dant feedback',
  );
});

test('reaction popups expand from the adjacent toolbar and remain within the chat viewport', () => {
  const { context: c } = fixture(),
    { document } = parseHTML(
      '<html><body><div id="messages"><div class="reaction-menu"></div></div></body></html>',
    ),
    menu = defined(document.querySelector<HTMLElement>('.reaction-menu')),
    viewport = defined(document.querySelector<HTMLElement>('#messages'));
  let rect = { left: -78, right: 112, top: 60 };
  const domRect = (value: {
    left: number;
    right: number;
    top: number;
    width?: number;
  }): DOMRect => ({
    ...value,
    x: value.left,
    y: value.top,
    bottom: value.top,
    width: value.width ?? value.right - value.left,
    height: 0,
    toJSON() {
      return { ...value };
    },
  });
  viewport.getBoundingClientRect = () => domRect({ left: 44, right: 364, top: 20, width: 320 });
  menu.getBoundingClientRect = () => domRect(rect);
  c.document = document;
  c.positionReactionMenus();
  assert.equal(menu.style.getPropertyValue('--reaction-shift'), '130px');
  assert.equal(menu.style.maxWidth, '304px');
  assert.equal(menu.dataset.placement, 'above');
  assert.equal(rect.left + 130, 52, 'short assistant bubbles stay in chat');
  rect = { left: 300, right: 490, top: 0 };
  c.positionReactionMenus();
  assert.equal(menu.style.getPropertyValue('--reaction-shift'), '-134px');
  assert.equal(menu.dataset.placement, 'below');
  assert.equal(rect.right - 134, 356, 'right-aligned bubbles stay in chat');
  rect = { left: 100, right: 290, top: 70 };
  c.positionReactionMenus();
  assert.equal(menu.style.getPropertyValue('--reaction-shift'), '0px');
  assert.equal(menu.dataset.placement, 'above');
  viewport.remove();
  assert.doesNotThrow(() => c.positionReactionMenus());
  document.body.append(viewport);
  viewport.getBoundingClientRect = () => domRect({ left: 0, right: 0, top: 0, width: 0 });
  assert.doesNotThrow(() => c.positionReactionMenus());
  c.emojiFor = 'user-menu';
  c.state.messages = [
    {
      id: 'user-menu',
      role: 'user',
      text: 'Hi',
      status: 'review',
      time: 1,
      attachments: [],
      reactions: [],
    },
  ];
  const rendered = parseHTML('<main>' + c.renderMessages() + '</main>').document;
  assert.equal(
    defined(rendered.querySelector<HTMLElement>('.reaction-menu')).parentNode,
    rendered.querySelector<HTMLElement>('.user .message-actions'),
  );
  const css = compactCss(
    fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'),
  );
  assert.match(css, /\.message-bubble-row>\.message-actions\{position:relative;display:flex/);
  assert.match(
    css,
    /\.reaction-menu\{position:absolute;left:auto;right:0;bottom:calc\(100% \+ 8px\)/,
  );
  assert.match(css, /\.user \.reaction-menu\{left:0;right:auto/);
  assert.doesNotMatch(css, /\.reaction-menu\{[^}]*left:22px/);
});
