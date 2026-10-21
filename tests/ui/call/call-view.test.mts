import type { UiModal, Timer, CallState } from '../../../ui/shared/contracts.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection, compactCss } from '../../support/source-fixtures.mts';
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
import { createCallDuration, formatCallDuration } from '../../../ui/call/call-duration.mts';
import { createAppearance, appearanceDefaults } from '../../../ui/settings/appearance.mts';
import { createWorkDisclosures } from '../../../ui/work/work-disclosures.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
  css = compactCss(fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'));
const part = (start: string, end: string) => sourceSection(source, start, end),
  settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(language = 'en', theme = 'light') {
  const { document, Event } = parseHTML(
      '<!doctype html><html><body><main id="app"></main></body></html>',
    ),
    app = document.querySelector<HTMLElement>('#app'),
    intervals = new Map<Timer, () => void>(),
    requests: { route: string; body?: unknown }[] = [];
  let now = 18000,
    nextTimer = 0;
  const peer = {
      connectionState: 'connected',
      close() {
        throw Error('View changes must not close the peer');
      },
    },
    track = {
      stop() {
        throw Error('View changes must not stop media');
      },
    },
    stream = { getTracks: () => [track] },
    audio = {
      play: async () => {},
      pause() {
        throw Error('View changes must not pause audio');
      },
    },
    call: CallState & { id: string; connectedAt: number } = {
      id: 'live-call',
      provider: 'subscription',
      status: 'connected',
      connectedAt: 1000,
    };
  const c = uiEntrypointFixture({
    bindAttachmentImages,
    downloads: { bind() {} },
    filePreview: { bind() {}, syncModal: (value: UiModal | null) => value },
    modal: null,
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
    Event,
    window: {},
    icons: lucide,
    createElement: (definition: Parameters<typeof lucide.createElement>[0]) =>
      lucide.createElement(definition),
    renderIcon: (_name: string): string => {
      throw Error('Icon source has not loaded');
    },
    formatCallDuration,
    esc: (value: unknown) => String(value ?? ''),
    eyes: () => '<i class="call-avatar"></i>',
    fallbackLanguage: language,
    state: { settings: { ...appearanceDefaults, theme, language }, call, messages: [] },
    eventConnected: true,
    pc: peer,
    stream,
    audio,
    callId: call.id,
    callConnected: true,
    callStarting: false,
    callChannel: { readyState: 'open' },
    callMini: false,
    callMuted: false,
    callProvider: 'subscription',
    callStops: { pending: false },
    page: 'chat',
    chatMode: 'voice',
    pendingActions: new Set(),
    render() {},
    toast(message: string) {
      throw Error(message);
    },
    bindSteer() {},
    bindProvision() {},
    bindVoiceKey() {},
    bindTelegram() {},
    bindAppearance() {},
    bindVMSettings() {},
    bindComputerInput() {},
  });
  c.progressActions = { bind() {}, renderConfirmation: () => '', onClose() {}, busy: false };
  c.callSubtitles = createCallSubtitles();
  c.workDisclosures = createWorkDisclosures({ getState: () => c.state, document });
  c.createElement = (definition: Parameters<typeof lucide.createElement>[0]) => {
    const previous = globalThis.document;
    globalThis.document = document;
    try {
      return lucide.createElement(definition);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, 'document');
      else globalThis.document = previous;
    }
  };
  c.callDuration = createCallDuration({
    now: () => now,
    schedule: (fn) => {
      intervals.set(++nextTimer, fn);
      return nextTimer;
    },
    cancel: (id) => id !== undefined && intervals.delete(id),
  });
  c.callDuration.start(call.id, call.connectedAt);
  c.appearance = createAppearance({ document, storage: null, matchMedia: () => null });
  c.appearance.sync(c.state.settings);
  c.post = async (route, body) => {
    requests.push({ route, body });
    throw Error('View changes must not send an API request');
  };
  c.updateInstalling = false;
  c.chatScroll ??= { capture() {}, restore() {}, dispose() {}, navigate: (action) => action() };
  c.memorySettings ??= { setVisible() {}, render: () => '', bind() {}, dispose() {} };
  c.vmBackups ??= {
    setVisible() {},
    render: () => '',
    renderImport: () => '',
    bind() {},
    dispose() {},
    load: async () => {},
    openImport: async () => {},
  };
  c.taskReplies ??= createTaskReplyController({ document: c.document, getModel: () => ({}) });
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(
    stripTypeScriptTypes(
      part('function currentState(', 'const subscriptionVoiceUnavailable=') +
        '\n' +
        part('const iconCache=', 'const eyes=') +
        '\n' +
        part('function renderCall(){', 'function renderUnconfirmedMessage(){') +
        '\n' +
        part('function bind(){', 'async function taskRequest(') +
        '\n' +
        part('async function action(a){', 'async function checkUnconfirmedMessage(){') +
        '\nglobalThis.renderIcon=ico;',
    ),
    c,
  );
  c.render = () => {
    const template = document.createElement('template');
    template.innerHTML = c.renderCall() + '<input id="file-input" type="file" hidden>';
    reconcile(defined(app), template.content);
    c.bind();
  };
  c.render();
  return {
    c,
    document,
    requests,
    intervals,
    peer,
    stream,
    audio,
    call,
    async click(node: HTMLElement | null) {
      defined(node).dispatchEvent(new Event('pointerdown', { bubbles: true }));
      defined(node).dispatchEvent(new Event('pointerup', { bubbles: true }));
      defined(node).dispatchEvent(new Event('click', { bubbles: true }));
      await settle();
    },
    advance(ms: number) {
      now += ms;
      for (const fn of intervals.values()) fn();
    },
  };
}

test('numeric Lucide icon names render their real SVG paths instead of empty buttons', () => {
  const { c, document } = fixture();
  for (const name of ['minimize-2', 'maximize-2', 'volume-2']) {
    const template = document.createElement('template');
    template.innerHTML = c.renderIcon(name);
    assert.ok(template.content.querySelector<HTMLElement>('svg'), name + ' must produce an SVG');
    assert.ok(defined(template.content.querySelector<HTMLElement>('svg')).childNodes.length > 0);
  }
});

test('icon-only minimize and expand controls preserve the live call through real bubbling button events', async () => {
  for (const [language, theme, minimize, expand] of [
    ['zh', 'light', '缩小到聊天', '展开通话'],
    ['en', 'dark', 'Minimize to chat', 'Expand call'],
  ]) {
    const f = fixture(language, theme),
      button = f.document.querySelector<HTMLButtonElement>('.call-top [data-action="call-size"]'),
      clock = f.c.callDuration;
    assert.equal(defined(button).textContent.trim(), '');
    assert.equal(defined(button).querySelector<HTMLElement>('span'), null);
    assert.equal(defined(button).type, 'button');
    assert.equal(defined(button).title, minimize);
    assert.equal(defined(button).getAttribute('aria-label'), minimize);
    assert.ok(defined(button).querySelector<HTMLElement>('svg'));
    assert.equal(defined(button).hidden, false);
    assert.equal(defined(button).disabled, false);
    assert.equal(defined(button).classList.contains('icon-btn'), true);
    assert.equal(defined(button).classList.contains('call-size-toggle'), true);
    assert.equal(f.document.documentElement.dataset.theme, theme);
    const foreground = f.document.documentElement.style.getPropertyValue('--appearance-foreground'),
      background = f.document.documentElement.style.getPropertyValue('--appearance-background');
    assert.notEqual(foreground, background);
    await f.click(button);
    assert.equal(f.c.callMini, true);
    assert.equal(f.c.chatMode, 'text');
    assert.equal(f.c.pc, f.peer);
    assert.equal(f.c.stream, f.stream);
    assert.equal(f.c.audio, f.audio);
    assert.equal(f.c.state.call, f.call);
    assert.equal(f.c.callId, 'live-call');
    assert.equal(f.c.callDuration, clock);
    assert.equal(f.intervals.size, 1);
    assert.equal(defined(clock).snapshot.seconds, 17);
    assert.equal(f.requests.length, 0);
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('.call-view')).classList.contains('mini'),
      true,
    );
    const restoring = f.document.querySelector<HTMLButtonElement>(
      '.call-top [data-action="call-size"]',
    );
    assert.equal(restoring, button);
    assert.equal(defined(restoring).textContent.trim(), '');
    assert.equal(defined(restoring).querySelector<HTMLElement>('span'), null);
    assert.equal(defined(restoring).title, expand);
    assert.equal(defined(restoring).getAttribute('aria-label'), expand);
    assert.ok(defined(restoring).querySelector<HTMLElement>('svg'));
    f.advance(1000);
    await f.click(restoring);
    assert.equal(f.c.callMini, false);
    assert.equal(f.c.chatMode, 'voice');
    assert.equal(f.c.pc, f.peer);
    assert.equal(f.c.stream, f.stream);
    assert.equal(f.c.callId, 'live-call');
    assert.equal(defined(clock).snapshot.seconds, 18);
    assert.equal(defined(clock).snapshot.running, true);
    assert.equal(f.intervals.size, 1);
    assert.equal(f.requests.length, 0);
    defined(clock).dispose();
  }
  const rule = css.match(/\.call-size-toggle\{([^}]+)\}/)?.[1] || '';
  assert.match(rule, /background:transparent/);
  assert.match(rule, /border:0/);
  assert.match(rule, /opacity:1/);
  assert.match(rule, /visibility:visible/);
  assert.match(css, /\.call-top\{[^}]*z-index:2/);
});

test('revealing a search result switches full-call layout to chat without changing the media session or clock', () => {
  const f = fixture(),
    clock = f.c.callDuration;
  f.c.speechBlocked = () =>
    Boolean(f.c.pc || f.c.callStarting || f.c.state.call || f.c.callStops.pending);
  vm.runInContext(
    stripTypeScriptTypes(part('function revealMessage(){', 'function updatePresence(){')),
    f.c,
  );
  assert.equal(f.c.callMini, false);
  assert.equal(f.c.chatMode, 'voice');
  f.c.page = 'settings';
  f.c.revealMessage('search-target');
  assert.equal(f.c.page, 'chat');
  assert.equal(f.c.chatMode, 'text');
  assert.equal(f.c.callMini, true);
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('.call-view')).classList.contains('mini'),
    true,
  );
  assert.equal(f.c.pc, f.peer);
  assert.equal(f.c.stream, f.stream);
  assert.equal(f.c.audio, f.audio);
  assert.equal(f.c.state.call, f.call);
  assert.equal(f.c.callId, 'live-call');
  assert.equal(f.c.callDuration, clock);
  assert.equal(defined(clock).snapshot.seconds, 17);
  assert.equal(f.intervals.size, 1);
  assert.equal(f.requests.length, 0);
  defined(clock).dispose();
});
