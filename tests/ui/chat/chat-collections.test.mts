import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { parseHTML } from 'linkedom';
import { createChatCollections, messageLinks } from '../../../ui/chat/chat-collections.mts';
import { collectionMessages } from '../../../ui/chat/chat-collections-copy.mts';
import { createChatHistory } from '../../../ui/chat/chat-history.mts';
import { searchMessages } from '../../../ui/chat/chat-search.mts';
import { createMessageWindow, messageHistoryScope } from '../../../ui/chat/message-window.mts';
import { reconcile } from '../../../ui/shared/dom.mts';
import { escapeHtml } from '../../../ui/shared/html.mts';
import { isRecord } from '../../../ui/shared/contracts.mts';
import { readAppState } from '../../../ui/app/application-state.mts';
import { ConnectionStatus, TaskStatus } from '../../../src/contracts/states.mts';
import { languages } from '../../../src/i18n/languages.mts';
import { registerLocale, localizeMessages } from '../../../src/i18n/i18n.mts';
import { defined, invokeHandler } from '../../support/fixture-assertions.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import { sourceDeclaration, compactCss } from '../../support/source-fixtures.mts';
import { createTransport } from '../../../ui/platform/transport.mts';
import type {
  ApiOptions,
  Attachment,
  ChatMessage,
  UiModal,
  UiState,
} from '../../../ui/shared/contracts.mts';

const files: Attachment[] = [
  { id: 'photo', name: '图片 <photo>.png', type: 'image/png', size: 10 },
  { id: 'sound', name: '声音.wav', type: 'audio/wav' },
  { id: 'report', name: 'Report.pdf', type: 'application/pdf', size: 20 },
];
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const { document, Event } = parseHTML('<html><body><main id="app"></main></body></html>'),
    app = defined(document.querySelector<HTMLElement>('#app')),
    state: UiState = {
      conversationId: 'conversation-one',
      settings: { language: 'en', vm: { host: 'vm-a', user: 'dant', port: 22 } },
      worker: { status: ConnectionStatus.Online },
      messages: [
        { id: 'first', role: 'user', text: 'Earlier 中文 <img src=x onerror=bad>', time: 1 },
        {
          id: 'files',
          role: 'assistant',
          text: 'The files',
          time: 2,
          attachments: structuredClone(files),
        },
        {
          id: 'links',
          role: 'assistant',
          text: 'https://example.test/docs and https://example.test/other',
          time: 3,
        },
        { id: 'hidden', role: 'system', text: 'not a public message', pinned: true, starred: true },
      ],
      active: { turnId: 'turn', status: TaskStatus.Running, messageIds: ['first'] },
      queue: ['first'],
      call: { id: 'call-one', provider: 'subscription', status: 'connected' },
    },
    requests: { route: string; options: ApiOptions }[] = [],
    toasts: string[] = [],
    navigation: string[] = [],
    openedFiles: { file: Attachment; download: boolean }[] = [],
    openedLinks: string[] = [],
    window = createMessageWindow();
  let modal: UiModal | null = null,
    connected = true,
    focused: HTMLElement | null = null,
    ui: ReturnType<typeof createChatCollections>,
    history: ReturnType<typeof createChatHistory>,
    respond: ((route: string, options: ApiOptions) => Promise<unknown>) | null = null;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  function render() {
    const template = document.createElement('template');
    template.innerHTML =
      `<div class="header-actions"><button data-action="details">Menu</button>${ui.renderMenu()}</div>` +
      ui.renderPinnedBar() +
      '<div id="messages">' +
      window
        .select(state.messages ?? [], messageHistoryScope(state))
        .map(
          (message) =>
            `<article class="message" data-id="${escapeHtml(message.id)}"><p>${escapeHtml(message.text)}</p><div class="message-actions">${history.renderActions(message)}</div>${history.renderEdited(message)}</article>`,
        )
        .join('') +
      '</div>' +
      (history.renderModal(modal) ?? ui.renderModal(modal) ?? '');
    reconcile(app, template.content);
    document.querySelectorAll<HTMLElement>('button,[tabindex],article').forEach((node) => {
      node.focus = () => {
        focused = node;
      };
      node.scrollIntoView = () => {
        navigation.push('scroll:' + node.dataset.id);
      };
    });
    history.bind();
    history.bindModal(modal);
    ui.bind();
    defined(document.querySelector<HTMLButtonElement>('[data-action="details"]')).onclick =
      ui.toggleMenu;
  }
  function closeModal() {
    navigation.push('close');
    modal = null;
    ui.onClose();
    history.onClose();
    render();
  }
  const request = async (route: string, options: ApiOptions = {}) => {
    const { beforeSend, ...wireOptions } = options;
    requests.push({ route, options: structuredClone(wireOptions) });
    if (respond) return respond(route, options);
    if (beforeSend && !beforeSend()) throw Object.assign(Error('Target changed'), { status: 409 });
    assert.ok(isRecord(options.body));
    return {
      conversationId: state.conversationId,
      message: {
        id: decodeURIComponent(defined(route.split('/').at(-2))),
        pinned: options.body.pinned ?? false,
        starred: options.body.starred ?? false,
      },
    };
  };
  ui = createChatCollections({
    document,
    getState: () => state,
    getModal: () => modal,
    connected: () => connected,
    request,
    render,
    toast: (value) => toasts.push(value),
    openModal: (value) => {
      modal = value;
      render();
    },
    closeModal,
    closeMessageMenu: () => history.onClose(),
    revealMessage: (id) => {
      assert.equal(modal, null);
      navigation.push('reveal:' + id);
      window.reveal(id, state.messages ?? [], messageHistoryScope(state));
      render();
    },
    navigate: (action) => {
      navigation.push('navigate');
      action();
    },
    openFile: (file, download) => openedFiles.push({ file, download }),
    openLink: (url) => openedLinks.push(url),
  });
  history = createChatHistory({
    document,
    getState: () => state,
    request,
    render,
    toast: (value) => toasts.push(value),
    openModal: (value) => {
      modal = value;
      render();
    },
    closeModal,
    searchMessages,
    callActive: () => !!state.call,
    renderMetadataActions: (message) => ui.renderMessageActions(message),
    renderMetadataMarkers: (message) => ui.renderMarkers(message),
    onOpenMenu: () => ui.onClose(),
  });
  render();
  return {
    ui,
    history,
    document,
    Event,
    state,
    requests,
    toasts,
    navigation,
    openedFiles,
    openedLinks,
    render,
    closeModal,
    get modal() {
      return modal;
    },
    get focused() {
      return focused;
    },
    set connected(value: boolean) {
      connected = value;
    },
    set respond(value: typeof respond) {
      respond = value;
    },
    node(selector: string) {
      return defined(document.querySelector<HTMLElement>(selector), selector);
    },
    async click(selector: string) {
      await invokeHandler(document.querySelector<HTMLElement>(selector), 'click');
      await settle();
    },
    async open(kind: 'starred' | 'shared') {
      ui.toggleMenu();
      await invokeHandler(
        document.querySelector<HTMLElement>(`[data-chat-collection="${kind}"]`),
        'click',
      );
      await settle();
    },
    dispose() {
      ui.dispose();
      window.dispose();
    },
  };
}

test('chat menu has three requested entries; message menus can pin and star during a live call and task', async () => {
  const f = fixture(),
    original = structuredClone(f.state);
  assert.equal(f.ui.renderMessageActions(defined(f.state.messages?.[3])), '');
  assert.equal(f.ui.renderMarkers(defined(f.state.messages?.[3])), '');
  await f.click('[data-action="details"]');
  const menu = f.node('[data-chat-header-menu]');
  assert.deepEqual(
    [...menu.querySelectorAll('button')].map((node) => node.textContent),
    ['Starred messages', 'Search', 'Media, docs & links'],
  );
  assert.equal(menu.querySelector('[data-chat-collection="pinned"]'), null);
  assert.equal(f.node('[data-action="details"]').getAttribute('aria-expanded'), 'true');
  assert.equal(f.focused?.textContent, 'Starred messages');
  await f.click('[data-message-more="first"]');
  assert.equal(f.document.querySelector('[data-chat-header-menu]'), null);
  assert.equal(f.node('[data-message-pin="first"]').hasAttribute('disabled'), false);
  assert.equal(f.node('[data-message-star="first"]').hasAttribute('disabled'), false);
  assert.equal(f.node('[data-message-edit="first"]').hasAttribute('disabled'), true);
  await f.click('[data-message-star="first"]');
  assert.deepEqual(f.requests, [
    {
      route: '/messages/first/metadata',
      options: { method: 'PATCH', body: { conversationId: 'conversation-one', starred: true } },
    },
  ]);
  assert.equal(f.state.messages?.[0]?.starred, true);
  assert.equal(f.state.messages?.[0]?.read, undefined);
  assert.deepEqual(f.state.call, original.call);
  assert.deepEqual(f.state.active, original.active);
  assert.deepEqual(f.state.queue, original.queue);
  assert.deepEqual(f.state.messages?.[0]?.text, original.messages?.[0]?.text);
  await f.click('[data-message-more="first"]');
  assert.equal(f.node('[data-message-star="first"]').textContent, 'Unstar');
  await f.click('[data-message-pin="first"]');
  assert.equal(
    f.state.messages?.[0]?.starred,
    true,
    'pin response must not clear an unrelated flag',
  );
  assert.equal(f.state.messages?.[0]?.pinned, true);
  assert.equal(f.node('.chat-pinned-preview').textContent.includes('Earlier 中文 <img'), true);
  assert.equal(f.document.querySelector('.chat-pinned-preview img'), null);
  await f.click('[data-message-more="first"]');
  assert.equal(f.node('[data-message-pin="first"]').textContent, 'Unpin');
  await f.click('[data-message-pin="first"]');
  assert.equal(f.document.querySelector('.chat-pinned-bar'), null, 'no permanent empty pin space');
  f.dispose();
});

test('metadata writes require authoritative live state and reject old bindings, stale replies and deleted targets', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.state.conversationId = 'new-conversation';
    },
    (f: ReturnType<typeof fixture>) => {
      defined(f.state.settings).vm = { host: 'vm-b' };
    },
    (f: ReturnType<typeof fixture>) => {
      f.connected = false;
    },
  ]) {
    const f = fixture();
    await f.click('[data-message-more="first"]');
    const old = f.node('[data-message-star="first"]'),
      oldHandler = old.onclick;
    assert.ok(oldHandler);
    change(f);
    await Reflect.apply(oldHandler, old, [new f.Event('click')]);
    assert.equal(f.requests.length, 0, 'a stale DOM action must not target a reused message id');
    f.dispose();
  }
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.state.conversationId = 'other';
    },
    (f: ReturnType<typeof fixture>) => {
      defined(f.state.settings).vm = { host: 'vm-b' };
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.messages = f.state.messages?.filter((message) => message.id !== 'first') ?? [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.connected = false;
    },
  ]) {
    const f = fixture();
    let resolve: (value: unknown) => void = () => assert.fail('request not started');
    f.respond = () =>
      new Promise((done) => {
        resolve = done;
      });
    await f.click('[data-message-more="first"]');
    const pending = invokeHandler(f.node('[data-message-star="first"]'), 'click');
    assert.equal(f.requests.length, 1);
    assert.equal(f.node('[data-message-star="first"]').hasAttribute('disabled'), true);
    await invokeHandler(f.node('[data-message-star="first"]'), 'click');
    assert.equal(f.requests.length, 1, 'one request per message while the outcome is pending');
    change(f);
    resolve({
      conversationId: 'conversation-one',
      message: { id: 'first', pinned: false, starred: true },
    });
    await pending;
    assert.equal(f.state.messages?.find((message) => message.id === 'first')?.starred, undefined);
    assert.deepEqual(f.toasts, []);
    f.dispose();
  }
  const f = fixture();
  f.state.controller = { status: ConnectionStatus.Online, cached: true };
  f.render();
  await f.click('[data-message-more="first"]');
  assert.equal(f.node('[data-message-pin="first"]').hasAttribute('disabled'), true);
  await f.click('[data-message-star="first"]');
  assert.equal(f.requests.length, 0);
  assert.match(defined(f.toasts.at(-1)), /Connect the work computer/);
  f.dispose();
});

test('canonical acknowledgments do not overwrite newer records and invalid or unknown outcomes are never retried', async () => {
  for (const response of [
    { conversationId: 'wrong', message: { id: 'first', pinned: false, starred: true } },
    { conversationId: 'conversation-one', message: { id: 'wrong', pinned: false, starred: true } },
    {
      conversationId: 'conversation-one',
      message: { id: 'first', pinned: false, starred: 'true' },
    },
    { conversationId: 'conversation-one', message: { id: 'first', starred: true } },
    null,
  ]) {
    const f = fixture();
    f.respond = async () => response;
    await f.click('[data-message-more="first"]');
    await f.click('[data-message-star="first"]');
    assert.equal(f.state.messages?.[0]?.starred, undefined);
    assert.equal(f.requests.length, 1);
    assert.match(defined(f.toasts.at(-1)), /unconfirmed/);
    f.dispose();
  }
  for (const error of [
    Object.assign(Error('private data'), { status: 404 }),
    Object.assign(Error('private data'), { unknownOutcome: true }),
    Object.assign(Error('private data'), { status: 503 }),
  ]) {
    const f = fixture();
    f.respond = async () => {
      throw error;
    };
    await f.click('[data-message-more="first"]');
    await f.click('[data-message-pin="first"]');
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.messages?.[0]?.pinned, undefined);
    assert.doesNotMatch(f.toasts.join(''), /private data/);
    assert.match(
      defined(f.toasts.at(-1)),
      'status' in error && error.status === 404 ? /Could not update/ : /unconfirmed/,
    );
    f.dispose();
  }
  const f = fixture();
  f.respond = async () => {
    const current = defined(f.state.messages?.[0]);
    defined(f.state.messages)[0] = { ...current, starred: false };
    return {
      conversationId: 'conversation-one',
      message: { id: 'first', pinned: false, starred: true },
    };
  };
  await f.click('[data-message-more="first"]');
  await f.click('[data-message-star="first"]');
  assert.equal(f.state.messages?.[0]?.starred, false);
  f.dispose();
});

test('pinned summaries cycle without removing pins and reveal an exact old record through the lazy window', async () => {
  const f = fixture();
  f.state.messages = Array.from({ length: 260 }, (_, index): ChatMessage => ({
    id: 'm-' + index,
    role: 'assistant',
    text: 'Message ' + index,
    pinned: index === 2 || index === 5,
  }));
  f.render();
  assert.equal(f.document.querySelector('.message[data-id="m-5"]'), null);
  assert.equal(f.node('.chat-pinned-preview').dataset.collectionGo, 'm-5');
  await f.click('[data-pin-next]');
  assert.equal(f.node('.chat-pinned-preview').dataset.collectionGo, 'm-2');
  await f.click('.chat-pinned-preview');
  assert.deepEqual(f.navigation, ['reveal:m-2', 'navigate', 'scroll:m-2']);
  assert.equal(f.focused?.dataset.id, 'm-2');
  assert.equal(f.state.messages.filter((message) => message.pinned).length, 2);
  assert.equal(f.requests.length, 0);
  f.dispose();
});

test('starred list is paged, escapes contents and navigates after closing its dialog', async () => {
  const f = fixture();
  defined(f.state.messages)[0] = { ...defined(f.state.messages?.[0]), starred: true };
  await f.open('starred');
  assert.equal(f.document.querySelector('.chat-collection-list img'), null);
  assert.match(f.node('.chat-collection-list').textContent, /Earlier 中文 <img/);
  assert.doesNotMatch(f.node('.chat-collection-list').textContent, /not a public message/);
  await f.click('[data-collection-go="first"]');
  assert.deepEqual(f.navigation, ['close', 'reveal:first', 'navigate', 'scroll:first']);
  assert.equal(f.modal, null);
  f.state.messages = Array.from({ length: 120 }, (_, index): ChatMessage => ({
    id: 'star-' + index,
    role: 'user',
    text: 'Star ' + index,
    starred: true,
  }));
  await f.open('starred');
  assert.equal(f.document.querySelectorAll('.chat-collection-item').length, 50);
  await f.click('[data-collection-more]');
  assert.equal(f.document.querySelectorAll('.chat-collection-item').length, 100);
  await f.click('[data-collection-more]');
  assert.equal(f.document.querySelectorAll('.chat-collection-item').length, 120);
  assert.equal(f.document.querySelector('[data-collection-more]'), null);
  assert.equal(f.requests.length, 0);
  f.dispose();
});

test('shared media, documents and links resolve current owned records before preview or download', async () => {
  const f = fixture();
  await f.open('shared');
  assert.equal(f.document.querySelectorAll('[data-collection-file]').length, 2);
  assert.match(f.node('.chat-collection-list').textContent, /图片 <photo>.png/);
  assert.equal(f.document.querySelector('.chat-collection-list img'), null);
  await f.click('[data-collection-file="photo"]');
  await f.click('[data-collection-download="sound"]');
  assert.deepEqual(f.openedFiles, [
    { file: files[0], download: false },
    { file: files[1], download: true },
  ]);
  await f.click('[data-collection-tab="docs"]');
  assert.equal(f.node('[data-collection-tab="docs"]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.document.querySelectorAll('[data-collection-file]').length, 1);
  const removed = f.node('[data-collection-file="report"]');
  defined(f.state.messages?.find((message) => message.id === 'files')).attachments = [];
  await invokeHandler(removed, 'click');
  assert.equal(
    f.openedFiles.length,
    2,
    'deleted or moved attachments cannot be opened from stale markup',
  );
  await f.click('[data-collection-tab="links"]');
  assert.equal(f.document.querySelectorAll('[data-collection-link]').length, 2);
  await f.click('[data-collection-link]');
  assert.deepEqual(f.openedLinks, ['https://example.test/docs']);
  const stale = f.node('[data-collection-link]');
  defined(f.state.messages?.find((message) => message.id === 'links')).text = 'javascript:alert(1)';
  await invokeHandler(stale, 'click');
  assert.equal(f.openedLinks.length, 1);
  f.render();
  assert.match(f.node('.chat-collection-list').textContent, /No messages here yet/);
  assert.equal(f.requests.length, 0);
  f.dispose();
});

test('URL extraction is inert, credential-free, deduplicated and preserves balanced parentheses', () => {
  assert.deepEqual(
    messageLinks(
      'javascript:alert(1) data:text/html,bad ftp://bad.test https://user:password@example.test/ <a href="https://safe.test/a">x</a> (https://safe.test/a). https://safe.test/wiki/Foo_(bar) https://safe.test/x] HTTPS://SAFE.test/a invalid https://',
    ),
    ['https://safe.test/a', 'https://safe.test/wiki/Foo_(bar)', 'https://safe.test/x'],
  );
  assert.equal(
    messageLinks(Array.from({ length: 120 }, (_, index) => 'https://safe.test/' + index).join(' '))
      .length,
    100,
  );
});

test('header and individual message menus support keyboard navigation and dismiss without activating messages', async () => {
  const f = fixture();
  await f.click('[data-action="details"]');
  const key = (target: HTMLElement | Document, value: string) => {
    const event = new f.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value });
    target.dispatchEvent(event);
  };
  key(f.node('[data-chat-header-menu]'), 'End');
  assert.equal(f.focused?.textContent, 'Media, docs & links');
  key(f.node('[data-chat-header-menu]'), 'Home');
  assert.equal(f.focused?.textContent, 'Starred messages');
  key(f.node('[data-chat-header-menu]'), 'ArrowDown');
  assert.equal(f.focused?.textContent, 'Search');
  key(f.document, 'Escape');
  assert.equal(f.document.querySelector('[data-chat-header-menu]'), null);
  assert.equal(f.focused?.dataset.action, 'details');
  await f.click('[data-message-more="first"]');
  key(f.node('.history-menu'), 'End');
  assert.equal(f.focused?.dataset.messageStar, 'first');
  key(f.node('.history-menu'), 'Escape');
  assert.equal(f.document.querySelector('.history-menu'), null);
  assert.equal(f.focused?.dataset.messageMore, 'first');
  await f.click('[data-action="details"]');
  f.node('#messages').dispatchEvent(new f.Event('pointerdown', { bubbles: true }));
  assert.equal(f.document.querySelector('[data-chat-header-menu]'), null);
  await f.click('[data-action="details"]');
  await f.click('[data-chat-search]');
  assert.equal(f.modal?.type, 'chat-search');
  assert.equal(f.document.querySelector('[data-chat-header-menu]'), null);
  assert.equal(f.requests.length, 0);
  f.dispose();
});

test('optional pinned and starred state flags reject malformed values while preserving legacy omissions', () => {
  const base = {
    mode: 'vm-controller',
    conversationId: 'conversation',
    settings: { language: 'en', vm: {} },
    worker: { status: ConnectionStatus.Online, models: [], account: null },
    controller: { status: ConnectionStatus.Online, cached: false },
    messages: [{ id: 'message', role: 'assistant', text: 'Hello' }],
    active: null,
    queue: [],
    call: null,
  };
  assert.equal(readAppState(base).messages[0]?.starred, undefined);
  assert.equal(
    readAppState({ ...base, messages: [{ ...base.messages[0], pinned: true, starred: false }] })
      .messages[0]?.pinned,
    true,
  );
  for (const key of ['pinned', 'starred'])
    for (const value of ['true', 1, null, {}])
      assert.throws(() =>
        readAppState({ ...base, messages: [{ ...base.messages[0], [key]: value }] }),
      );
});

test('all supported locales include collection controls without translating message contents', () => {
  assert.deepEqual(
    Object.keys(collectionMessages.en).sort(),
    Object.keys(collectionMessages.zh).sort(),
  );
  for (const language of languages) {
    if (language.code !== 'en' && language.code !== 'zh') {
      const catalog: unknown = JSON.parse(
        fs.readFileSync(
          new URL('../../../src/i18n/locales/' + language.code + '.json', import.meta.url),
          'utf8',
        ),
      );
      assert.ok(isRecord(catalog));
      for (const key of Object.values(collectionMessages.en))
        assert.equal(typeof catalog[key], 'string', `${language.code}: ${key}`);
      registerLocale(language.code, catalog);
    }
    const f = fixture();
    defined(f.state.settings).language = language.code;
    defined(f.state.messages)[0] = { ...defined(f.state.messages?.[0]), pinned: true };
    f.render();
    assert.match(f.node('.chat-pinned-bar').textContent, /Earlier 中文 <img/);
    const copy = localizeMessages(collectionMessages, language.code);
    assert.match(
      f.ui.renderMessageActions(defined(f.state.messages?.[0])),
      new RegExp(escapeHtml(copy.unpin)),
    );
    f.dispose();
  }
});

test('real entrypoint message navigation minimizes a call without changing media or either side pane', () => {
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
    messages: ChatMessage[] = Array.from({ length: 240 }, (_, index) => ({
      id: 'm-' + index,
      role: 'assistant',
      text: 'Message ' + index,
    })),
    state = {
      messages,
      settings: { language: 'en', vm: { host: 'vm' } },
      conversationId: 'conversation',
    },
    peer = { connectionState: 'connected' },
    messageWindow = createMessageWindow(),
    c = uiEntrypointFixture({
      state,
      page: 'settings',
      chatMode: 'voice',
      callMini: false,
      pc: peer,
      showComputer: true,
      progressPanel: { visible: true },
      messageWindow,
      speechBlocked: () => true,
      currentState: () => state,
      render() {},
    });
  messageWindow.select(messages, messageHistoryScope(state));
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(stripTypeScriptTypes(sourceDeclaration(source, 'function revealMessage(')), c);
  c.revealMessage('m-2');
  assert.equal(c.page, 'chat');
  assert.equal(c.chatMode, 'text');
  assert.equal(c.callMini, true);
  assert.equal(c.pc, peer);
  assert.equal(c.showComputer, true);
  assert.equal(c.progressPanel.visible, true);
  assert.equal(messageWindow.select(messages, messageHistoryScope(state))[0]?.id, 'm-2');
  const css = compactCss(
    fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'),
  );
  assert.match(css, /\.chat-pinned-bar\{display:flex;[^}]*flex:0 0 auto/);
  assert.match(css, /\.chat-collection-item \[data-collection-link\]\{[^}]*overflow-wrap:anywhere/);
});

test('real main API and native queue reject metadata behind a VM switch even before the UI observes new state', async () => {
  const f = fixture(),
    source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
    sent: { route: string; vm: string }[] = [];
  let activeVm = 'vm-a',
    finishConnection: ((value: unknown) => void) | undefined;
  const transport = createTransport({
      desktop: true,
      invokeRequest: async (_command, request) => {
        sent.push({ route: request.route, vm: activeVm });
        if (request.route === '/api/connect')
          return new Promise((resolve) => {
            finishConnection = resolve;
          });
        assert.fail('A stale metadata request must not reach the new VM');
      },
    }),
    c = uiEntrypointFixture({
      transport,
      FormData,
      decodeApiResult: (_route: string, value: unknown) => value,
    });
  vm.createContext(c);
  vm.runInContext(stripTypeScriptTypes(sourceDeclaration(source, 'async function api(')), c);
  f.respond = (route, options) => c.api(route, options);
  const connecting = c.api('/connect', { method: 'POST' });
  await settle();
  await f.click('[data-message-more="first"]');
  const marking = invokeHandler(f.node('[data-message-star="first"]'), 'click');
  activeVm = 'vm-b';
  assert.equal(
    f.state.settings?.vm?.host,
    'vm-a',
    'the renderer has not received a state poll yet',
  );
  assert.equal(
    f.state.conversationId,
    'conversation-one',
    'restored backups may retain the same conversation and message ids',
  );
  defined(finishConnection)({ status: 200, body: '{"ok":true}' });
  await Promise.all([connecting, marking]);
  assert.deepEqual(sent, [{ route: '/api/connect', vm: 'vm-a' }]);
  assert.equal(f.state.messages?.[0]?.starred, undefined);
  assert.match(defined(f.toasts.at(-1)), /Could not update/);
  assert.doesNotMatch(f.toasts.join(''), /unconfirmed/);
  transport.close();
  f.dispose();
});
