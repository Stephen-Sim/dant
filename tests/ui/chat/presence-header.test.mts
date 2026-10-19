import type { UiState, CallState, Timer } from '../../../ui/shared/contracts.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { formatPresence } from '../../../ui/chat/presence.mts';
import {
  updateWorkTimers,
  workProgress,
  renderWorkEntry,
} from '../../../ui/work/work-progress.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
  part = (start: string, end: string) => sourceSection(source, start, end);
function fixture() {
  const { document } = parseHTML('<main></main><input id="credential-secret" type="password">'),
    timers = new Map<Timer, () => void>(),
    listeners = new Map<string, () => void>(),
    password = document.querySelector<HTMLInputElement>('#credential-secret');
  let now = 181000,
    sequence = 0;
  defined(password).value = 'private-live-value';
  const state: Omit<UiState, 'settings' | 'call'> & {
    settings: { language: string };
    call?: Partial<CallState> | null;
    presence: { lastActiveAt: number };
  } = {
    settings: { language: 'en' },
    controller: { status: 'online' },
    worker: { status: 'online' },
    presence: { lastActiveAt: 1000 },
    messages: [],
  };
  const c = uiEntrypointFixture({
    workProgress,
    renderWorkEntry,
    textEditor: { renderSettings: () => '', bind() {}, load: async () => {}, dispose() {} },
    nativeTray: { sync() {}, dispose() {} },
    updateWorkTimers,
    settingsNavigation: { sync() {} },
    appUpdates: { render: () => '', dispose() {} },
    document,
    window: {
      addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
    },
    formatPresence: (state: unknown, language: unknown) => formatPresence(state, language, now),
    fallbackLanguage: 'en',
    state,
    page: 'chat',
    eventConnected: true,
    pc: null as Pick<RTCPeerConnection, 'connectionState'> | null,
    stream: null,
    callStarting: false,
    callConnected: false,
    callChannel: null as Pick<RTCDataChannel, 'readyState'> | null,
    callStops: { pending: false },
    chatMode: 'text',
    showComputer: false,
    esc: (value: unknown) => String(value ?? ''),
    ico: () => '<svg></svg>',
    button: (action: string, _icon: string, label: string) =>
      `<button data-action="${action}">${label}</button>`,
    presenceTimer: undefined,
    setInterval: (fn: () => void, ms: number) => {
      assert.equal(ms, 30000);
      timers.set(++sequence, fn);
      return sequence;
    },
    clearInterval: (id: Timer | undefined) => id !== undefined && timers.delete(id),
    unloading: false,
    managedSettings: {
      clearSecret() {
        defined(password).value = '';
      },
    },
    clearTelegramPairing() {},
    appearance: { dispose() {} },
    speechGeneration: 0,
    speech: { stop: async () => {} },
    stopReadTracking() {},
    screenTimer: undefined,
    screenAbort: null,
    callId: null,
    cleanupCall() {},
    cancelRecording() {},
    recording: null,
    transport: { close() {} },
    screenURL: '',
    updateRead() {},
    restartScreen() {},
    positionReactionMenus() {},
  });
  c.updateInstalling = false;
  c.chatScroll ??= {
    capture() {},
    restore() {},
    dispose() {},
    navigate: (action: () => void) => action(),
  };
  c.memorySettings ??= { setVisible() {}, render: () => '', bind() {}, dispose() {} };
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(
    stripTypeScriptTypes(
      part('function currentState(', 'const subscriptionVoiceUnavailable=') +
        '\n' +
        part('function renderHeader(status){', 'function renderChat(){') +
        '\n' +
        part("document.addEventListener('visibilitychange'", 'async function boot(){'),
    ),
    c,
  );
  defined(document.querySelector<HTMLElement>('main')).innerHTML = c.renderHeader('online');
  c.startPresenceTicker();
  return {
    c,
    document,
    password,
    timers,
    listeners,
    advance(ms: number) {
      now += ms;
      for (const callback of timers.values()) callback();
    },
  };
}

test('presence ticks update real header nodes without rendering or resetting secure inputs, and unload cancels the timer', () => {
  const f = fixture(),
    label = f.document.querySelector<HTMLButtonElement>('[data-presence-label]'),
    detail = f.document.querySelector<HTMLButtonElement>('[data-presence-detail]');
  assert.equal(defined(label).textContent, 'Online');
  assert.match(defined(detail).textContent, /Idle/);
  assert.match(
    defined(f.document.querySelector<HTMLElement>('.presence-status')).title,
    /No task is running[\s\S]*Last active 3 minutes ago/,
  );
  f.advance(60000);
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-presence-label]'), label);
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-presence-detail]'), detail);
  assert.match(defined(detail).textContent, /Idle/);
  assert.match(
    defined(f.document.querySelector<HTMLElement>('.presence-status')).title,
    /Last active 4 minutes ago/,
  );
  assert.equal(defined(f.password).value, 'private-live-value');
  assert.equal(f.timers.size, 1);
  f.c.startPresenceTicker();
  assert.equal(f.timers.size, 1, 'starting twice never stacks intervals');
  defined(f.listeners.get('beforeunload'))();
  assert.equal(f.timers.size, 0);
  assert.equal(f.c.unloading, true);
  assert.equal(defined(f.password).value, '');
});

test('header presence follows language, real work/media connection, and controller disconnection over cached VM state', () => {
  const f = fixture();
  f.c.state.settings.language = 'zh';
  f.c.state.active = { turnId: 'known' };
  f.c.updatePresence();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-label]')).textContent,
    '在线',
  );
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-detail]')).textContent,
    /正在工作/,
  );
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-dot]')).className,
    /working/,
  );
  f.c.state.active = null;
  f.c.state.call = { status: 'connected' };
  f.c.pc = { connectionState: 'connected' };
  f.c.callConnected = true;
  f.c.callChannel = { readyState: 'open' };
  f.c.updatePresence();
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-detail]')).textContent,
    /正在通话/,
  );
  f.c.state.call = null;
  f.c.pc = null;
  f.c.state.workTasks = [{ id: 'waiting', status: 'waiting_user' }];
  f.c.updatePresence();
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-detail]')).textContent,
    /等待你回复/,
  );
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-dot]')).className,
    /online/,
  );
  assert.doesNotMatch(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-dot]')).className,
    /working/,
  );
  f.c.eventConnected = false;
  f.c.updatePresence();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-label]')).textContent,
    '未连接',
  );
  assert.doesNotMatch(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-detail]')).textContent,
    /正在通话|正在工作|等待你回复/,
  );
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-presence-dot]')).className,
    /offline/,
  );
  assert.equal(defined(f.password).value, 'private-live-value');
});
