import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { parseHTML } from 'linkedom';
import { createProgressPanel } from '../../../ui/work/progress-panel.mts';
import { reconcile } from '../../../ui/shared/dom.mts';
import { languageInfo } from '../../../src/i18n/languages.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { sourceDeclaration, compactCss } from '../../support/source-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import {
  workProgress,
  renderWorkEntry,
  renderWorkSummary,
} from '../../../ui/work/work-progress.mts';
import { TaskStatus } from '../../../src/contracts/states.mts';
import { createCallSubtitles } from '../../../ui/call/call-subtitles.mts';
import type { CallState, UiActiveTask } from '../../../ui/shared/contracts.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
function fixture() {
  const { document, Event, HTMLElement } = parseHTML(
      '<html><body><div id="app"></div></body></html>',
    ),
    app = defined(document.querySelector<HTMLElement>('#app')),
    state = {
      messages: [],
      settings: { language: 'en' },
      worker: { status: 'online' },
      active: null as UiActiveTask | null,
      queue: [] as string[],
      call: null as CallState | null,
    },
    c = uiEntrypointFixture({
      document,
      HTMLElement,
      app,
      languageInfo,
      state,
      page: 'chat',
      showComputer: true,
      chatMode: 'text',
      pc: null as { connectionState: string } | null,
      callStarting: false,
      callMini: false,
      callId: null,
      callStops: { pending: false },
      callSubtitles: createCallSubtitles(),
      callProvider: 'subscription',
      callConnected: true,
      callChannel: { readyState: 'open' },
      callDuration: { snapshot: { confirmed: false } },
      stream: {},
      callMuted: false,
      eyes: () => '<i class="call-avatar"></i>',
      eventConnected: true,
      composerDraft: 'Retained draft',
      modal: null,
      modalFocus: null,
      emojiFor: null,
      updateInstalling: false,
      currentState: () => state,
      language: () => 'en',
      t: (key: string) => key,
      esc: (value: unknown) => String(value ?? ''),
      ico: () => '<svg></svg>',
      button: (action: string, _icon: string, label: string) =>
        `<button data-action="${action}"><span>${label}</span></button>`,
      currentPresence: () => ({
        title: 'Online',
        label: 'Online',
        detail: '',
        active: false,
        online: true,
      }),
      humanControl: () => false,
      workProgress,
      renderWorkEntry,
      renderRail: () => '<nav class="rail"></nav>',
      renderCall: () => '',
      renderCallReady: () => '',
      renderChat: () =>
        `<div id="messages"><article>Retained chat</article></div><textarea id="composer">${c.composerDraft}</textarea>`,
      renderComputer: () =>
        '<div class="resize-handle" data-key="resize"></div><aside class="computer-panel" data-key="computer-panel">Computer</aside>',
      renderProgress: () => '<button data-task-fixture>Retained task</button>',
      renderSettings: () => '',
      renderMemory: () => '',
      renderSchedules: () => '',
      conversationFiles: () => [],
      chatSearchLabel: () => 'Search',
      formatTime: () => '',
      managedSettings: { syncModal: (value: null) => value, renderModal: () => null, onClose() {} },
      filePreview: { syncModal: (value: null) => value },
      chatHistory: { renderModal: () => null, onClose() {} },
      memorySettings: { setVisible() {} },
      vmBackups: { setVisible() {} },
      appUpdates: { setVisible() {} },
      settingsNavigation: { sync() {}, isVisible: () => false },
      appearance: { sync() {} },
      workDisclosures: { capture() {} },
      chatScroll: {
        capture() {},
        restore() {},
        navigate: (action: () => void) => action(),
        dispose() {},
      },
      progressActions: { onClose() {} },
      reconcile,
      resizeComposer() {},
      floatingCall: { sync() {} },
      publishCallOverlay() {},
      nativeTray: { sync() {} },
      positionReactionMenus() {},
      updateRead() {},
      restartScreen() {},
    });
  let scope = 'conversation-a',
    focused: Element | null = null,
    closed = 0;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  c.progressPanel = createProgressPanel({
    document,
    renderContent: () => c.renderProgress(),
    title: () => 'Work progress',
    closeLabel: () => 'Close',
    closeIcon: () => '<svg></svg>',
    getScope: () => scope,
    onChange: () => c.render(),
    onClose: () => closed++,
  });
  c.bind = () => {
    document.querySelectorAll<HTMLElement>('button,[tabindex]').forEach((node) => {
      node.focus = () => {
        focused = node;
      };
    });
    document.querySelectorAll<HTMLButtonElement>('[data-action="progress"]').forEach((node) => {
      node.onclick = () => {
        void c.action('progress');
      };
    });
    defined(c.progressPanel).bind();
  };
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(
    stripTypeScriptTypes(
      [
        sourceDeclaration(source, 'function render('),
        sourceDeclaration(source, 'function renderHeader('),
        sourceDeclaration(source, 'function renderCall('),
        sourceDeclaration(source, 'async function action('),
        sourceDeclaration(source, 'function openProgress('),
        sourceDeclaration(source, 'function renderModal('),
        sourceDeclaration(source, 'function openModal('),
        sourceDeclaration(source, 'function closeModal('),
      ].join('\n'),
    ),
    c,
  );
  c.render();
  return {
    c,
    document,
    Event,
    get focused() {
      return focused;
    },
    get closed() {
      return closed;
    },
    setScope(value: string) {
      scope = value;
    },
  };
}

test('Work progress docks between retained chat and computer; closing it preserves their nodes, draft and scroll', () => {
  const f = fixture(),
    composer = defined(f.document.querySelector<HTMLTextAreaElement>('#composer')),
    messages = defined(f.document.querySelector<HTMLElement>('#messages')),
    computer = defined(f.document.querySelector('.computer-panel')),
    trigger = defined(f.document.querySelector<HTMLButtonElement>('[data-action="progress"]'));
  composer.value = 'Unsent edited draft';
  messages.scrollTop = 170;
  trigger.focus();
  trigger.click();
  const panel = defined(f.document.querySelector<HTMLElement>('[data-progress-panel]')),
    workspace = defined(f.document.querySelector('.workspace'));
  assert.deepEqual(
    [...workspace.children].map((node) => node.className),
    [
      'conversation',
      'resize-handle progress-resize-handle',
      'progress-panel',
      'resize-handle',
      'computer-panel',
    ],
  );
  assert.equal(f.document.querySelector('.modal-backdrop'), null);
  assert.equal(panel.getAttribute('aria-modal'), null);
  assert.equal(f.focused, panel);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(f.document.querySelector('#composer'), composer);
  assert.equal(composer.value, 'Unsent edited draft');
  assert.equal(f.document.querySelector('#messages'), messages);
  assert.equal(messages.scrollTop, 170);
  assert.equal(f.document.querySelector('.computer-panel'), computer);
  defined(f.document.querySelector<HTMLButtonElement>('[data-progress-panel-close]')).click();
  assert.equal(f.document.querySelector('[data-progress-panel]'), null);
  assert.equal(f.document.querySelector('.computer-panel'), computer);
  assert.equal(composer.value, 'Unsent edited draft');
  assert.equal(messages.scrollTop, 170);
  assert.equal(f.c.showComputer, true);
  assert.equal(f.closed, 1);
  assert.equal(f.focused, trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('dock scroll is independent, survives refresh and reopening, resets on conversation change, and Escape closes only the pane', () => {
  const f = fixture();
  f.c.openProgress();
  const body = defined(f.document.querySelector<HTMLElement>('[data-progress-panel-body]'));
  body.scrollTop = 345;
  f.c.render();
  assert.equal(f.document.querySelector('[data-progress-panel-body]'), body);
  assert.equal(body.scrollTop, 345);
  defined(f.c.progressPanel).close();
  f.c.openProgress();
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('[data-progress-panel-body]')).scrollTop,
    345,
  );
  f.setScope('conversation-b');
  f.c.render();
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('[data-progress-panel-body]')).scrollTop,
    0,
  );
  assert.equal(f.closed, 2, 'a changed conversation clears the old task confirmation');
  const event = new f.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value: 'Escape' });
  defined(f.document.querySelector('[data-progress-panel]')).dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.document.querySelector('[data-progress-panel]'), null);
  assert.ok(f.document.querySelector('.computer-panel'));
  defined(f.c.progressPanel).close();
  assert.equal(f.closed, 3, 'closing an already closed pane is inert');
});

test('legacy progress opens use the dock and ordinary dialogs still render and close independently', () => {
  const f = fixture();
  f.c.openModal({ type: 'progress' });
  assert.ok(f.document.querySelector('[data-progress-panel]'));
  assert.equal(f.c.modal, null);
  f.c.openModal({ type: 'details' });
  assert.ok(f.document.querySelector('[aria-modal="true"]'));
  assert.ok(f.document.querySelector('[data-progress-panel]'));
  assert.equal(f.document.querySelector('.dialog .work-progress-body'), null);
  const event = new f.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value: 'Escape' });
  defined(f.document.querySelector('[data-progress-panel]')).dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, 'a dialog retains its own Escape handling');
  f.c.closeModal();
  assert.equal(f.document.querySelector('[aria-modal="true"]'), null);
  assert.ok(f.document.querySelector('[data-progress-panel]'));
  assert.ok(f.document.querySelector('.computer-panel'));
});

test('the Working bar and header toggle the same dock without changing active work, queue, draft or chat scroll', () => {
  const f = fixture();
  const active: UiActiveTask = {
    messageId: 'task-fixture',
    turnId: 'turn-fixture',
    source: 'chat',
    status: TaskStatus.Running,
  };
  f.c.state.active = active;
  f.c.state.queue = ['queued-fixture'];
  const renderChat = f.c.renderChat;
  f.c.renderChat = () =>
    renderWorkSummary(workProgress(f.c.state, { language: 'en', connected: true })) + renderChat();
  let requests = 0;
  f.c.api = f.c.post = async () => {
    requests++;
    throw Error('A dock toggle must not submit work');
  };
  f.c.render();
  const summary = defined(f.document.querySelector<HTMLButtonElement>('.work-summary'));
  const header = defined(f.document.querySelector<HTMLButtonElement>('.header-work'));
  const messages = defined(f.document.querySelector<HTMLElement>('#messages'));
  const composer = defined(f.document.querySelector<HTMLTextAreaElement>('#composer'));
  const computer = f.document.querySelector('.computer-panel');
  composer.value = 'Keep this unsent draft';
  messages.scrollTop = 180;
  summary.focus();
  summary.click();
  assert.equal(defined(f.c.progressPanel).visible, true);
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
  summary.click();
  assert.equal(defined(f.c.progressPanel).visible, false);
  assert.equal(summary.getAttribute('aria-expanded'), 'false');
  assert.equal(f.focused, summary);
  header.click();
  assert.equal(defined(f.c.progressPanel).visible, true);
  header.click();
  assert.equal(defined(f.c.progressPanel).visible, false);
  assert.equal(f.c.state.active, active);
  assert.deepEqual(f.c.state.queue, ['queued-fixture']);
  assert.equal(requests, 0);
  assert.equal(f.document.querySelector('#messages'), messages);
  assert.equal(f.document.querySelector('#composer'), composer);
  assert.equal(f.document.querySelector('.computer-panel'), computer);
  assert.equal(composer.value, 'Keep this unsent draft');
  assert.equal(messages.scrollTop, 180);
});

test('header keyboard order is call, work progress, computer and details; responsive dock styles never overlay chat', () => {
  const f = fixture();
  assert.deepEqual(
    [...f.document.querySelectorAll<HTMLElement>('.header-actions [data-action]')].map(
      (node) => node.dataset.action,
    ),
    ['voice-mode', 'progress', 'computer', 'details'],
  );
  const css = compactCss(
    fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'),
  );
  assert.match(css, /\.progress-panel\{display:flex;flex-direction:column/);
  assert.match(css, /\.progress-panel-body\{[^}]*min-height:0;[^}]*overflow:auto/);
  assert.match(css, /\.workspace\.progress-visible\[data-workspace-layout='split'\]\{display:grid/);
  assert.match(css, /\.workspace\.progress-visible>\.computer-panel\{position:static;inset:auto/);
  assert.match(
    css,
    /\.workspace\.progress-visible\[data-workspace-layout='stacked'\]\{display:grid;grid-template-columns:minmax\(0,1fr\)/,
  );
  assert.match(
    css,
    /\.workspace\.progress-visible\.computer-visible\[data-workspace-layout='stacked'\]\{grid-template-rows:repeat\(3,minmax\(180px,1fr\)\)/,
  );
});

test('expanding a live call stays inside conversation and retains the Computer and Work progress panes, draft and scroll', async () => {
  const f = fixture();
  f.c.openProgress();
  const computer = defined(f.document.querySelector('.computer-panel')),
    progress = defined(f.document.querySelector('[data-progress-panel]')),
    messages = defined(f.document.querySelector<HTMLElement>('#messages')),
    composer = defined(f.document.querySelector<HTMLTextAreaElement>('#composer')),
    peer = { connectionState: 'connected' };
  composer.value = 'Draft while talking';
  messages.scrollTop = 140;
  f.c.pc = peer;
  f.c.state.call = { id: 'live-call', provider: 'subscription', status: 'connected' };
  f.c.callMini = true;
  await f.c.action('call-size');
  assert.equal(f.c.callMini, false);
  assert.equal(f.c.chatMode, 'voice');
  assert.equal(
    f.document.querySelector('.call-view:not(.mini)')?.parentElement?.className,
    'conversation',
  );
  assert.equal(f.document.querySelector('.computer-panel'), computer);
  assert.equal(f.document.querySelector('[data-progress-panel]'), progress);
  assert.equal(f.c.showComputer, true);
  assert.equal(defined(f.c.progressPanel).visible, true);
  assert.equal(f.document.querySelector('#composer'), composer);
  assert.equal(composer.value, 'Draft while talking');
  assert.equal(messages.scrollTop, 140);
  await f.c.action('call-size');
  assert.equal(f.c.callMini, true);
  assert.equal(f.c.pc, peer);
  assert.equal(f.document.querySelector('.computer-panel'), computer);
  assert.equal(f.document.querySelector('[data-progress-panel]'), progress);
  const css = compactCss(
    fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'),
  );
  assert.match(css, /\.conversation>\.call-view:not\(\.mini\)\{position:absolute;inset:0/);
});
