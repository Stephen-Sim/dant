import type { ApiOptions, UiModal, UiActiveTask, UiState } from '../../../ui/shared/contracts.mts';
import { errorMessage } from '../../../src/contracts/json.mts';
import { htmlTag } from '../../support/fixture-assertions.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined, invokeHandler } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import { createTaskReplyController } from '../../../ui/work/task-reply.mts';
import { bindAttachmentImages } from '../../../ui/files/attachment-images.mts';
import test from 'node:test';
import { createCallSubtitles } from '../../../ui/call/call-subtitles.mts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as lucide from 'lucide';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { createManagedSettings } from '../../../ui/settings/managed-settings.mts';
import { createCallDuration, formatCallDuration } from '../../../ui/call/call-duration.mts';
import { createAppearance, appearanceDefaults } from '../../../ui/settings/appearance.mts';
import { formatPresence } from '../../../ui/chat/presence.mts';
import {
  workProgress,
  renderWorkEntry,
  renderWorkSummary,
} from '../../../ui/work/work-progress.mts';
import { createUpdates } from '../../../ui/settings/updates.mts';
import { createSettingsNavigation } from '../../../ui/settings/settings-navigation.mts';
import { createSchedules } from '../../../ui/schedules/schedules.mts';
import { createWorkDisclosures } from '../../../ui/work/work-disclosures.mts';
import { renderUsageSettings } from '../../../ui/settings/usage-settings.mts';
import { createUsageActivityController } from '../../../ui/settings/usage-activity.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
const part = (start: string, end: string) => sourceSection(source, start, end);
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
const optionalSettings: { showWorkSummary?: boolean } = {};
const optionalState: Pick<UiState, 'schedules'> = {};
function fixture({ language = 'en', online = true, live = false } = {}) {
  const { document, Event } = parseHTML(
      '<!doctype html><html><body><div id="app"></div></body></html>',
    ),
    requests: ({ route: string } & ApiOptions)[] = [],
    updateRequests: string[] = [],
    toasts: string[] = [],
    timers = new Map<number, () => void>();
  let nextTimer = 0;
  const peer = {
      connectionState: 'connected',
      close() {
        throw Error('Navigation must preserve the peer');
      },
    },
    stream = {
      getTracks: () => [
        {
          stop() {
            throw Error('Navigation must preserve media');
          },
        },
      ],
    },
    audio = {
      play: async () => {},
      pause() {
        throw Error('Navigation must preserve audio');
      },
    },
    call = {
      id: 'same-call',
      provider: 'subscription' as const,
      status: 'connected',
      connectedAt: 1000,
    };
  const c = uiEntrypointFixture({
    bindAttachmentImages,
    workProgress,
    renderWorkEntry,
    textEditor: { renderSettings: () => '', bind() {}, load: async () => {}, dispose() {} },
    nativeTray: { sync() {}, dispose() {} },
    downloads: { bind() {} },
    filePreview: { bind() {}, syncModal: (value: UiModal | null) => value },
    document,
    Event,
    window: {},
    app: document.querySelector<HTMLElement>('#app'),
    reconcile,
    icons: lucide,
    formatPresence,
    formatCallDuration,
    fallbackLanguage: language,
    state: {
      ...optionalState,
      conversationId: 'same-vm',
      settings: {
        ...appearanceDefaults,
        ...optionalSettings,
        language,
        vm: { host: 'vm.test', port: 22, user: 'dant' },
      },
      worker: { status: online ? 'online' : 'offline', models: [] },
      controller: { status: online ? 'online' : 'offline' },
      messages: [],
      queue: [],
      active: null as UiActiveTask | null,
      call: live ? call : null,
      credentials: { items: [], requests: [] },
      skills: {
        items: [
          {
            name: 'computer-check',
            description: 'Inspect the computer',
            path: '.agents/skills/computer-check',
            enabled: true,
          },
        ],
      },
    },
    vmDraft: null,
    eventConnected: online,
    page: 'chat',
    modal: null as UiModal | null,
    emojiFor: null,
    showComputer: false,
    chatMode: live ? 'voice' : 'text',
    callMini: false,
    callMuted: false,
    callConnected: live,
    callStarting: false,
    callStops: { pending: false },
    callChannel: { readyState: 'open' },
    pc: live ? peer : null,
    stream: live ? stream : null,
    audio: live ? audio : null,
    callId: live ? call.id : null,
    callProvider: 'subscription',
    composerDraft: 'Keep my draft',
    attachmentMenu: false,
    dictating: false,
    speakingId: null,
    pendingActions: new Set(),
    localStorage: { setItem() {} },
    chatHistory: { onClose() {}, bind() {}, bindModal() {}, renderSettings: () => '' },
    toast: (message: string) => toasts.push(message),
    errorText: (error: unknown) => errorMessage(error),
    humanControl: () => false,
    resizeComposer() {},
    positionReactionMenus() {},
    updateRead() {},
    restartScreen() {},
    bindSteer() {},
    bindProvision() {},
    bindVoiceKey() {},
    bindTelegram() {},
    bindAppearance() {},
    bindVMSettings() {},
    bindComputerInput() {},
    clearTelegramPairing() {},
    loadTelegram: async () => {},
    loadFonts: async () => {},
    loadVoices: async () => {},
    renderAppearance: () => '',
    renderVoiceSettings: () => '',
    renderVMSettings: () => '',
    renderLoginDetails: () => '',
    renderTelegramSettings: () => '',
    renderMemory: () => '',
    renderSchedules: () => '',
    renderCallReady: () => '',
    renderComputer: () => '',
    eyes: () => '<i class="call-avatar"></i>',
  });
  c.createElement = (definition) => {
    const previous = globalThis.document;
    globalThis.document = document;
    try {
      return lucide.createElement(definition);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, 'document');
      else globalThis.document = previous;
    }
  };
  c.renderWorkSummary = renderWorkSummary;
  c.renderUsageSettings = renderUsageSettings;
  c.usageActivity = createUsageActivityController({ document, onChange: () => c.render() });
  c.appearance = createAppearance({ document, storage: null, matchMedia: () => null });
  c.floatingCall = { sync() {} };
  c.nativeCallOverlay = { update() {} };
  c.progressActions = { bind() {}, renderConfirmation: () => '', onClose() {}, busy: false };
  c.callSubtitles = createCallSubtitles();
  c.workDisclosures = createWorkDisclosures({ getState: () => c.state, document });
  c.scheduledTasks = createSchedules({
    getState: () => c.state,
    document,
    connected: () => c.eventConnected,
    render: () => c.render(),
    toast: c.toast,
    request: async () => ({ items: c.state.schedules || [] }),
  });
  c.renderSchedules = () => defined(c.scheduledTasks).renderPage();
  c.callDuration = createCallDuration({
    now: () => 18000,
    schedule: (fn) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    cancel: (id) => timers.delete(id),
  });
  if (live) c.callDuration.start(call.id, call.connectedAt);
  c.renderChat = () =>
    `<div id="messages"></div><textarea id="composer">${c.composerDraft}</textarea>`;
  c.openModal = (next) => {
    c.modal = next;
    c.render();
  };
  c.closeModal = () => {
    defined(c.managedSettings).onClose(c.modal);
    c.modal = null;
    c.render();
  };
  c.managedSettings = createManagedSettings({
    getState: () => c.state,
    getModal: () => c.modal,
    document,
    connected: () => c.eventConnected,
    render: () => c.render(),
    toast: c.toast,
    openModal: c.openModal,
    closeModal: c.closeModal,
    request: async (route, options = {}) => {
      requests.push({ route, ...options });
      if (route === '/skills') return structuredClone(c.state.skills);
      if (route === '/credentials') return structuredClone(c.state.credentials);
      throw Error('Unexpected request: ' + route);
    },
  });
  c.renderModal = () => defined(c.managedSettings).renderModal(c.modal) || '';
  c.settingsNavigation = createSettingsNavigation({
    document,
    getLanguage: () => c.state.settings.language,
    onChange: () => c.render(),
    onCategory: (category) => c.loadSettingsCategory(category),
    onError: (error) => toasts.push(errorMessage(error)),
  });
  c.appUpdates = createUpdates({
    version: '1.0.0',
    document,
    getLanguage: () => c.state.settings.language,
    onChange: () => {
      if (c.page === 'settings') c.render();
    },
    request: async (route) => {
      updateRequests.push(route);
      return route === '/version'
        ? { version: '1.0.0' }
        : {
            currentVersion: '1.0.0',
            latestVersion: '1.1.0',
            updateAvailable: true,
            releaseUrl: 'https://github.com/Stephen-Sim/dant/releases/tag/v1.1.0',
          };
    },
  });
  c.updateInstalling = false;
  c.chatScroll ??= { capture() {}, restore() {}, dispose() {}, navigate: (action) => action() };
  c.memorySettings ??= { setVisible() {}, render: () => '', bind() {}, dispose() {} };
  c.taskReplies ??= createTaskReplyController({ document: c.document, getModel: () => ({}) });
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(
    stripTypeScriptTypes(
      [
        part('function currentState(', 'const subscriptionVoiceUnavailable='),
        part('const iconCache=', 'const eyes='),
        part('function render(){', 'function renderChat(){'),
        part('function renderSettings(){', 'const accentChoices='),
        part('function renderCall(){', 'function renderUnconfirmedMessage(){'),
        part('function bind(){', 'async function taskRequest('),
        part('async function action(a){', 'async function checkUnconfirmedMessage(){'),
      ].join('\n'),
    ),
    c,
  );
  c.render();
  return {
    c,
    document,
    requests,
    updateRequests,
    toasts,
    peer,
    stream,
    audio,
    call,
    timers,
    async click(selector: string) {
      const node = document.querySelector<HTMLSelectElement>(selector);
      assert.ok(node, selector);
      node.dispatchEvent(new Event('click', { bubbles: true }));
      await settle();
      assert.deepEqual(toasts, []);
    },
  };
}

test('the sidebar skill entry opens its own bilingual page and loads only skills', async () => {
  for (const language of ['zh', 'en']) {
    const f = fixture({ language }),
      entry = f.document.querySelector<HTMLElement>('.rail .rail-skills');
    assert.ok(defined(defined(entry).querySelector<HTMLElement>('svg')).childNodes.length);
    assert.equal(defined(entry).getAttribute('aria-label'), language === 'zh' ? '技能' : 'Skills');
    assert.equal(htmlTag(defined(entry).previousElementSibling, 'button').dataset.action, 'chat');
    await f.click('.rail [data-action="skills"]');
    assert.equal(f.c.page, 'skills');
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('.app-header h1')).textContent,
      language === 'zh' ? '技能' : 'Skills',
    );
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('.rail-skills')).getAttribute('aria-current'),
      'page',
    );
    assert.ok(
      f.document.querySelector<HTMLButtonElement>(
        '.skills-full-page [data-skill-edit="computer-check"]',
      ),
    );
    assert.equal(f.document.querySelector<HTMLElement>('.settings-stack'), null);
    assert.deepEqual(
      f.requests.map((item) => item.route),
      ['/skills'],
    );
    assert.ok(f.document.querySelector<HTMLInputElement>('#file-input'));
    await f.click('.rail [data-action="settings"]');
    assert.ok(f.document.querySelector<HTMLElement>('.credentials-settings'));
    assert.equal(
      f.document.querySelector<HTMLButtonElement>('[data-skill-add]'),
      null,
      'settings must not duplicate the independent skills page',
    );
    defined(f.c.callDuration).dispose();
  }
});

test('opening skills and returning to chat preserves draft, live media and elapsed call time', async () => {
  const f = fixture({ live: true }),
    clock = f.c.callDuration;
  defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value = 'Unsent message';
  await f.click('.rail [data-action="skills"]');
  assert.equal(f.c.composerDraft, 'Unsent message');
  assert.ok(f.document.querySelector<HTMLButtonElement>('.header-actions [data-action="hangup"]'));
  assert.equal(f.c.pc, f.peer);
  assert.equal(f.c.stream, f.stream);
  assert.equal(f.c.audio, f.audio);
  assert.equal(f.c.state.call, f.call);
  assert.equal(defined(clock).snapshot.seconds, 17);
  assert.equal(f.timers.size, 1);
  await f.click('.rail [data-action="chat"]');
  assert.equal(f.c.page, 'chat');
  assert.equal(
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
    'Unsent message',
  );
  assert.equal(f.c.callMini, true);
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('.call-view')).classList.contains('mini'),
    true,
  );
  assert.equal(f.c.pc, f.peer);
  assert.equal(f.c.callId, f.call.id);
  assert.equal(f.c.callDuration, clock);
  assert.equal(defined(clock).snapshot.running, true);
  assert.equal(f.timers.size, 1);
  assert.deepEqual(
    f.requests.map((item) => item.route),
    ['/skills'],
  );
  defined(clock).dispose();
});

test('scheduled tasks open from the sidebar beside skills while retaining live call media and chat draft', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ language, live: true });
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value = 'Keep this message';
    await f.click('.rail [data-action="schedules"]');
    const entry = f.document.querySelector<HTMLElement>('.rail-schedules');
    assert.equal(f.c.page, 'schedules');
    assert.equal(htmlTag(defined(entry).previousElementSibling, 'button').dataset.action, 'skills');
    assert.equal(defined(entry).getAttribute('aria-current'), 'page');
    assert.equal(
      defined(entry).getAttribute('aria-label'),
      language === 'en' ? 'Scheduled tasks' : '定时任务',
    );
    assert.ok(f.document.querySelector<HTMLButtonElement>('.schedules-page [data-schedule-add]'));
    assert.equal(f.document.querySelector<HTMLElement>('#schedule-form'), null);
    assert.equal(f.c.pc, f.peer);
    assert.equal(f.c.state.call, f.call);
    assert.deepEqual(f.requests, []);
    await f.click('.rail [data-action="chat"]');
    assert.equal(
      defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
      'Keep this message',
    );
    assert.equal(f.c.stream, f.stream);
    assert.equal(defined(f.c.callDuration).snapshot.running, true);
    defined(f.c.callDuration).dispose();
  }
});

test('offline navigation keeps cached skills visible and never starts a request or task', async () => {
  const f = fixture({ online: false });
  await f.click('.rail [data-action="skills"]');
  assert.equal(f.c.page, 'skills');
  assert.match(
    defined(f.document.querySelector<HTMLElement>('.skills-full-page')).textContent,
    /computer-check/,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-skill-add]')).disabled,
    true,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLInputElement>('[data-skill-toggle]')).disabled,
    true,
  );
  assert.deepEqual(f.requests, []);
  defined(f.c.callDuration).dispose();
});

test('skill path disclosures survive status refresh and filtering until that card is explicitly closed', async () => {
  const f = fixture({ live: true });
  f.c.state.skills.items.push({
    name: 'browser-check',
    description: 'Inspect the browser',
    path: '.agents/skills/browser-check',
    enabled: true,
  });
  await f.click('.rail [data-action="skills"]');
  const details = (name: string) =>
      f.document.querySelector<HTMLButtonElement>(
        '[data-key="skill-card-' + name + '"] .skill-card-path',
      ),
    toggle = (node: HTMLElement | null, open: boolean) => {
      node = defined(node);
      node.toggleAttribute('open', open);
      node.dispatchEvent(new f.c.Event('toggle'));
    };
  const computer = details('computer-check');
  toggle(computer, true);
  for (let n = 0; n < 3; n++) {
    f.c.state = {
      ...f.c.state,
      worker: { ...f.c.state.worker, status: n === 1 ? 'connecting' : 'online' },
    };
    f.c.render();
    assert.equal(
      defined(details('computer-check')).hasAttribute('open'),
      true,
      'status refresh must preserve the chosen open state',
    );
    assert.equal(defined(details('browser-check')).hasAttribute('open'), false);
  }
  const search = f.document.querySelector<HTMLInputElement>('#skills-search');
  defined(search).value = 'browser';
  defined(search).dispatchEvent(new f.c.Event('input', { bubbles: true }));
  assert.equal(details('computer-check'), null);
  assert.equal(defined(computer).isConnected, false);
  toggle(computer, false);
  defined(search).value = '';
  defined(search).dispatchEvent(new f.c.Event('input', { bubbles: true }));
  assert.equal(
    defined(details('computer-check')).hasAttribute('open'),
    true,
    'a detached toggle from reconciliation cannot collapse the saved card',
  );
  assert.equal(f.document.querySelector<HTMLInputElement>('#skills-search'), search);
  assert.equal(defined(search).value, '');
  toggle(details('browser-check'), true);
  toggle(details('computer-check'), false);
  f.c.render();
  assert.equal(defined(details('computer-check')).hasAttribute('open'), false);
  assert.equal(
    defined(details('browser-check')).hasAttribute('open'),
    true,
    'closing one card must not change another card',
  );
  await f.click('.rail [data-action="chat"]');
  assert.equal(
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
    'Keep my draft',
  );
  await f.click('.rail [data-action="skills"]');
  assert.equal(defined(details('computer-check')).hasAttribute('open'), false);
  assert.equal(defined(details('browser-check')).hasAttribute('open'), true);
  assert.equal(f.c.pc, f.peer);
  assert.equal(f.c.stream, f.stream);
  assert.equal(defined(f.c.callDuration).snapshot.seconds, 17);
  defined(f.c.callDuration).dispose();
});

test('a rapid refresh preserves the live disclosure state and a different work computer starts collapsed', async () => {
  const f = fixture();
  await f.click('.rail [data-action="skills"]');
  const selector = '[data-key="skill-card-computer-check"] .skill-card-path',
    details = f.document.querySelector<HTMLSelectElement>(selector);
  defined(details).setAttribute('open', '');
  f.c.render();
  assert.equal(
    defined(f.document.querySelector<HTMLSelectElement>(selector)).hasAttribute('open'),
    true,
    'refresh before the browser toggle event must preserve the live user choice',
  );
  f.c.state = { ...f.c.state, conversationId: 'different-computer' };
  f.c.render();
  assert.equal(
    defined(f.document.querySelector<HTMLSelectElement>(selector)).hasAttribute('open'),
    false,
  );
  defined(details).dispatchEvent(new f.c.Event('toggle'));
  f.c.render();
  assert.equal(
    defined(f.document.querySelector<HTMLSelectElement>(selector)).hasAttribute('open'),
    false,
  );
  defined(f.c.callDuration).dispose();
});

test('settings version and manual update checks preserve a live call and typed draft independently of the VM', async () => {
  const f = fixture({ live: true, online: false });
  defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value =
    'Preserve this unsent message';
  await f.click('.rail [data-action="settings"]');
  assert.deepEqual(f.updateRequests, []);
  await f.click('[data-settings-category="about"]');
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-app-version]')).textContent,
    '1.0.0',
  );
  assert.deepEqual(f.updateRequests, ['/version']);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-check-updates]')).disabled,
    false,
  );
  await f.click('[data-check-updates]');
  assert.deepEqual(f.updateRequests, ['/version', '/updates']);
  assert.equal(
    defined(f.document.querySelector<HTMLAnchorElement>('[data-update-release]')).href,
    'https://github.com/Stephen-Sim/dant/releases/tag/v1.1.0',
  );
  assert.equal(f.c.pc, f.peer);
  assert.equal(f.c.state.call, f.call);
  assert.equal(f.timers.size, 1);
  await f.click('.rail [data-action="chat"]');
  assert.equal(
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
    'Preserve this unsent message',
  );
  assert.equal(f.c.pc, f.peer);
  assert.equal(f.c.stream, f.stream);
  assert.equal(f.c.audio, f.audio);
  assert.equal(f.c.callId, f.call.id);
  assert.equal(defined(f.c.callDuration).snapshot.seconds, 17);
  assert.deepEqual(f.requests, []);
  defined(f.c.callDuration).dispose();
});

test('settings categories and search deep links keep call media and drafts, and About alone loads app version', async () => {
  const f = fixture({ live: true, online: false });
  defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value =
    'Keep this draft through settings search';
  await f.c.action('voice-settings');
  await settle();
  assert.equal(f.c.page, 'settings');
  assert.equal(defined(f.c.settingsNavigation).category, 'voice');
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-settings-panel="voice"]')).hidden,
    false,
  );
  assert.deepEqual(f.updateRequests, []);
  await f.click('[data-settings-category="general"]');
  const search = f.document.querySelector<HTMLInputElement>('#settings-search');
  defined(search).value = '更新';
  defined(search).dispatchEvent(new f.c.Event('input', { bubbles: true }));
  await settle();
  assert.ok(f.document.querySelector<HTMLButtonElement>('[data-settings-result="updates"]'));
  assert.deepEqual(f.updateRequests, []);
  await f.click('[data-settings-result="updates"]');
  assert.equal(defined(f.c.settingsNavigation).category, 'about');
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-settings-panel="about"]')).hidden,
    false,
  );
  assert.deepEqual(f.updateRequests, ['/version']);
  await f.click('[data-settings-category="computer"]');
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-settings-panel="about"]')).hidden,
    true,
  );
  assert.deepEqual(f.updateRequests, ['/version']);
  assert.equal(f.c.pc, f.peer);
  assert.equal(f.c.stream, f.stream);
  assert.equal(f.c.audio, f.audio);
  assert.equal(defined(f.c.callDuration).snapshot.seconds, 17);
  await f.click('.rail [data-action="chat"]');
  assert.equal(
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
    'Keep this draft through settings search',
  );
  assert.equal(f.c.callId, f.call.id);
  assert.equal(f.c.state.call, f.call);
  assert.deepEqual(f.requests, []);
  defined(f.c.callDuration).dispose();
});

test('work summary preference saves on and off, survives snapshots, and opens the same panel without disturbing a live call', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ language, live: true });
    Object.assign(f.c, {
      replyTo: null,
      attachments: [],
      renderUnreadControl: () => '',
      renderUnconfirmedMessage: () => '',
      renderVoiceRecorder: () => '',
      renderAttachmentOptions: () => '',
      speechBlocked: () => true,
      recordDraft: null,
      recordStarting: false,
      recording: null,
      sending: false,
      uploading: false,
    });
    vm.runInContext(
      stripTypeScriptTypes(part('function renderChat(){', 'function renderDraftAttachment(')),
      f.c,
    );
    f.c.api = async (route, options) => {
      f.requests.push({ route, ...structuredClone(options) });
      assert.equal(route, '/settings');
      return { ok: true };
    };
    f.c.state.active = {
      turnId: 'actual-work',
      source: 'voice',
      status: 'running',
      title: 'Verify <project> output',
    };
    f.c.render();
    defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value =
      'Keep this unsent draft';
    assert.equal(f.document.querySelector<HTMLElement>('.work-summary'), null);
    assert.ok(f.document.querySelector<HTMLElement>('.header-work'));
    await f.click('.rail [data-action="settings"]');
    let toggle = f.document.querySelector<HTMLInputElement>('#showWorkSummary');
    assert.equal(defined(toggle).hasAttribute('checked'), false);
    assert.equal(
      defined(toggle).getAttribute('aria-label'),
      language === 'en' ? 'Show work progress in chat' : '在聊天中显示任务进度',
    );
    defined(toggle).checked = true;
    await invokeHandler(defined(toggle), 'change');
    assert.equal(f.c.state.settings.showWorkSummary, true);
    assert.deepEqual(f.requests[0], {
      route: '/settings',
      method: 'PATCH',
      body: { showWorkSummary: true },
    });
    f.c.state = { ...f.c.state, settings: structuredClone(f.c.state.settings) };
    f.c.render();
    assert.equal(
      defined(f.document.querySelector<HTMLInputElement>('#showWorkSummary')).hasAttribute(
        'checked',
      ),
      true,
    );
    await f.click('.rail [data-action="chat"]');
    assert.ok(f.document.querySelector<HTMLElement>('.work-summary'));
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('.work-summary strong')).textContent,
      'Verify <project> output',
    );
    assert.equal(f.document.querySelector<HTMLElement>('project'), null);
    assert.equal(
      defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
      'Keep this unsent draft',
    );
    await f.click('.work-summary');
    assert.equal(defined(f.c.modal).type, 'progress');
    f.c.closeModal();
    await f.click('.header-work');
    assert.equal(defined(f.c.modal).type, 'progress');
    f.c.closeModal();
    await f.click('.rail [data-action="settings"]');
    toggle = f.document.querySelector<HTMLInputElement>('#showWorkSummary');
    defined(toggle).checked = false;
    await invokeHandler(defined(toggle), 'change');
    assert.equal(f.c.state.settings.showWorkSummary, false);
    f.c.render();
    assert.equal(
      defined(f.document.querySelector<HTMLInputElement>('#showWorkSummary')).hasAttribute(
        'checked',
      ),
      false,
    );
    await f.click('.rail [data-action="chat"]');
    assert.equal(f.document.querySelector<HTMLElement>('.work-summary'), null);
    assert.ok(f.document.querySelector<HTMLElement>('.header-work'));
    assert.equal(
      defined(f.document.querySelector<HTMLTextAreaElement>('#composer')).value,
      'Keep this unsent draft',
    );
    assert.deepEqual(
      f.requests.map((request) => request.body),
      [{ showWorkSummary: true }, { showWorkSummary: false }],
    );
    assert.equal(f.c.pc, f.peer);
    assert.equal(f.c.stream, f.stream);
    assert.equal(f.c.audio, f.audio);
    assert.equal(f.c.state.call, f.call);
    assert.equal(f.c.callId, f.call.id);
    assert.equal(defined(f.c.callDuration).snapshot.seconds, 17);
    defined(f.c.callDuration).dispose();
  }
});

test('work summary setting serializes a pending save and rolls a rejected checkbox back without notification permissions', async () => {
  const f = fixture();
  await f.click('.rail [data-action="settings"]');
  let reject: ((reason?: unknown) => void) | undefined;
  const pending = new Promise<void>((_resolve, no) => (reject = no));
  f.c.requestNotifications = () => {
    throw Error('Work display never requests notification permissions');
  };
  f.c.api = async (route, options) => {
    f.requests.push({ route, ...structuredClone(options) });
    await pending;
    return { ok: true };
  };
  const toggle = f.document.querySelector<HTMLInputElement>('#showWorkSummary');
  defined(toggle).checked = true;
  const save = invokeHandler(defined(toggle), 'change');
  assert.equal(defined(toggle).disabled, true);
  assert.ok(f.c.pendingActions.has('setting:showWorkSummary'));
  await invokeHandler(defined(toggle), 'change');
  assert.equal(f.requests.length, 1);
  defined(reject)(Error('Save rejected'));

  await save;
  assert.equal(f.c.state.settings.showWorkSummary, undefined);
  assert.equal(
    defined(f.document.querySelector<HTMLInputElement>('#showWorkSummary')).hasAttribute('checked'),
    false,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLInputElement>('#showWorkSummary')).hasAttribute(
      'disabled',
    ),
    false,
  );
  assert.equal(f.c.pendingActions.has('setting:showWorkSummary'), false);
  assert.equal(f.toasts.length, 1);
  assert.match(defined(f.toasts[0]), /Save rejected/);
  defined(f.c.callDuration).dispose();
});
