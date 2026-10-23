import { observedRecord } from '../../support/service-fixtures.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import { createTaskReplyController } from '../../../ui/work/task-reply.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { bindAttachmentImages } from '../../../ui/files/attachment-images.mts';
import { createWorkDisclosures } from '../../../ui/work/work-disclosures.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
  part = (start: string, end: string) => sourceSection(source, start, end),
  settle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
function fixture(language = 'en') {
  const { document, Event } = parseHTML('<main id="app"></main>'),
    app = document.querySelector<HTMLElement>('#app'),
    requests: { route: string; body?: unknown }[] = [],
    screens: { url: string; options: { signal: AbortSignal } }[] = [],
    toasts: string[] = [],
    intervals = new Map<number, () => void>(),
    timeouts = new Map<number, { callback: () => void; ms: number }>(),
    revoked: string[] = [],
    images: FrameImage[] = [];
  let sequence = 0,
    screenSequence = 0,
    wait: (() => Promise<void>) | null = null,
    decode = 'ok';
  class FrameImage {
    naturalWidth: number;
    naturalHeight: number;
    value = '';
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    decode: (() => Promise<void>) | undefined;
    constructor() {
      this.naturalWidth = 1280;
      this.naturalHeight = 960;
      images.push(this);
    }
    get src() {
      return this.value || '';
    }
    set src(value) {
      this.value = value;
      if (value && decode !== 'pending')
        queueMicrotask(() => (decode === 'error' ? this.onerror?.() : this.onload?.()));
    }
  }
  document.hasFocus = () => true;
  const c = uiEntrypointFixture({
    bindAttachmentImages,
    Image: FrameImage,
    filePreview: { bind() {} },
    fetch: async (url: string, options: { signal: AbortSignal }) => {
      screens.push({ url, options });
      if (wait) await wait();
      return { ok: true, blob: async () => ({ type: 'image/png' }) };
    },
    downloads: { bind() {} },
    document,
    Event,
    window: {},
    AbortController,
    innerWidth: 1440,
    base: '',
    token: 'test',
    localStorage: { getItem: () => null, setItem() {} },
    fallbackLanguage: language,
    state: {
      ...({ controller: { status: 'online', cached: false } } as {
        controller?: { status: string; cached: boolean };
      }),
      settings: {
        language,
        vm: { host: '192.0.2.10', user: 'dant', port: 22, keyPath: 'C:/vm-key' },
      },
      worker: { status: 'offline' },
      computer: { status: 'agent', sessionId: 'lease-1' },
      messages: [],
      call: null as { id: string; provider: string; status: string } | null,
    },
    eventConnected: true,
    unloading: false,
    page: 'chat',
    chatMode: 'text',
    showComputer: true,
    pc: null as { close: () => void } | null,
    callStarting: false,
    callStops: { pending: false },
    pendingActions: new Set(),
    screenURL: 'blob:existing-frame',
    screenError: '',
    screenFailures: 0,
    screenTimer: null,
    screenLoad: null,
    screenAbort: null,
    screenBusy: false,
    screenEpoch: 0,
    vmDraft: null,
    voiceLoadedFor: '',
    modal: null,
    managedSettings: { bind() {} },
    chatHistory: { bind() {}, bindModal() {} },
    icons: {},
    createElement: () => ({ outerHTML: '<svg></svg>' }),
    toast: (value: string) => toasts.push(value),
    bindSteer() {},
    bindProvision() {},
    bindVoiceKey() {},
    bindTelegram() {},
    bindAppearance() {},
    bindVMSettings() {},
    setInterval: (callback: () => void, ms: number) => {
      assert.equal(ms, 1200);
      intervals.set(++sequence, callback);
      return sequence;
    },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (callback: () => void, ms: number) => {
      timeouts.set(++sequence, { callback, ms });
      return sequence;
    },
    clearTimeout: (id: number) => timeouts.delete(id),
    URL: {
      createObjectURL: () => `blob:screen-${++screenSequence}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    },
  });
  c.progressActions = { bind() {}, renderConfirmation: () => '', onClose() {}, busy: false };
  c.workDisclosures = createWorkDisclosures({ getState: () => c.state, document });
  c.post = async (route, body) => {
    requests.push({ route, body });
    if (route === '/connect') c.state.worker.status = 'online';
    if (route === '/takeover')
      c.state.computer.status = observedRecord(body).enabled ? 'human' : 'agent';
    return { ok: true };
  };
  c.api = async (route) => {
    requests.push({ route });
    assert.equal(route, '/state');
    return c.state;
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
      [
        part('function currentState(', 'const subscriptionVoiceUnavailable='),
        part('const subscriptionVoiceUnavailable=', 'const eyes='),
        part('function renderComputer(){', 'function renderSettings(){'),
        part('function hasVMConnection(){', 'function renderVMSettings(){'),
        part('async function connectVM(){', 'async function saveAndConnectVM(){'),
        part('let inputChain=', 'async function taskRequest('),
        part('const boundComputerInputs=', 'async function openExternal('),
        part('async function action(a){', 'async function checkUnconfirmedMessage(){'),
        part('function screenVisible(){', 'async function loadVoices(){'),
      ].join('\n'),
    ),
    c,
  );
  c.render = () => {
    const template = document.createElement('template');
    template.innerHTML = c.renderComputer() + '<input type="file" id="file-input" hidden>';
    reconcile(defined(app), template.content);
    const img = document.querySelector<HTMLImageElement>('#screen');
    if (img) {
      Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1280 });
      Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 960 });
      img.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        toJSON: () => ({}),
        left: 0,
        top: 0,
        right: 640,
        bottom: 480,
        width: 640,
        height: 480,
      });
    }
    c.bind();
  };
  c.render();
  return {
    c,
    document,
    requests,
    screens,
    toasts,
    intervals,
    timeouts,
    revoked,
    images,
    set wait(value: typeof wait) {
      wait = value;
    },
    set decode(value: string) {
      decode = value;
    },
    async click(selector: string) {
      const node = document.querySelector<HTMLSelectElement>(selector);
      assert.ok(node, selector);
      node.dispatchEvent(new Event('click', { bubbles: true }));
      await settle();
    },
    async tick() {
      for (const callback of intervals.values()) callback();
      await settle();
    },
  };
}

test('a connected VM retains the real desktop while its agent is offline, with localized manual recovery and no automatic connect', async () => {
  for (const [language, status, hint] of [
    ['zh', 'VM 已连接 · 执行器离线', '执行器离线时只能查看桌面。请重新连接后再接管。'],
    [
      'en',
      'VM connected · agent offline',
      'The agent is offline. Reconnect before taking control.',
    ],
  ] as const) {
    const f = fixture(language),
      img = f.document.querySelector<HTMLImageElement>('#screen');
    assert.ok(img);
    assert.match(
      defined(f.document.querySelector<HTMLElement>('.computer-meta')).textContent,
      new RegExp(status),
    );
    assert.equal(img.getAttribute('src'), 'blob:existing-frame');
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-action="takeover"]')).disabled,
      true,
    );
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-action="takeover"]')).title,
      hint,
    );
    const reconnect = defined(
      f.document.querySelector<HTMLButtonElement>('.computer-meta [data-action="connect"]'),
    );
    assert.equal(reconnect.textContent, language === 'en' ? 'Reconnect' : '刷新连接');
    assert.equal(reconnect.type, 'button');
    assert.equal(f.document.querySelectorAll('[data-action="connect"]').length, 1);
    assert.equal(f.document.querySelector('[data-action="screen-refresh"]'), null);
    assert.equal(f.document.querySelector('.computer-agent-notice'), null);
    assert.equal(f.document.querySelector('.computer-footer .takeover-call-hint'), null);
    assert.equal(
      defined(f.document.querySelector('[data-action="takeover"]')).getAttribute(
        'aria-describedby',
      ),
      'computer-connection-status',
    );
    assert.equal(
      defined(f.document.querySelector('#computer-connection-status')).getAttribute('role'),
      'status',
    );
    assert.equal(f.c.screenVisible(), true);
    f.c.restartScreen();
    await settle();
    assert.equal(f.screens.length, 1);
    assert.equal(f.document.querySelector<HTMLImageElement>('#screen'), img);
    assert.equal(img.getAttribute('src'), 'blob:screen-1');
    assert.equal(f.intervals.size, 1);
    await f.tick();
    assert.equal(f.screens.length, 2);
    assert.equal(f.requests.length, 0, 'previewing must not reconnect or replay work');
  }
});

test('screen requests stay serialized and abort immediately when controller or events disconnect, regardless of cached agent state', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  f.wait = () => new Promise<void>((resolve) => (release = resolve));
  f.c.restartScreen();
  assert.equal(f.screens.length, 1);
  await f.tick();
  assert.equal(f.screens.length, 1);
  const signal = defined(f.screens[0]).options.signal;
  f.c.eventConnected = false;
  f.c.restartScreen();
  assert.equal(signal.aborted, true);
  assert.equal(f.intervals.size, 0);
  defined(release)();
  await settle();
  assert.equal(f.c.screenURL, 'blob:existing-frame');
  assert.equal(f.requests.length, 0);
  const cached = fixture();
  cached.c.state.controller = { status: 'offline', cached: true };
  cached.c.state.worker.status = 'online';
  cached.c.render();
  assert.equal(cached.c.screenVisible(), false);
  assert.equal(cached.document.querySelector<HTMLImageElement>('#screen'), null);
  cached.c.restartScreen();
  assert.equal(cached.screens.length, 0);
});

test('agent-offline takeover and all input routes stay blocked even while the desktop is reachable', async () => {
  const f = fixture();
  await f.click('[data-action="takeover"]');
  assert.equal(f.requests.length, 0);
  assert.match(defined(f.toasts.at(-1)), /agent is offline/);
  f.c.state.computer.status = 'human';
  f.c.render();
  const ime = f.document.querySelector<HTMLTextAreaElement>('#vm-ime');
  defined(ime).value = 'must not type';
  defined(ime).dispatchEvent(
    new (defined(f.document.defaultView).Event)('input', { bubbles: true }),
  );
  await f.c.vmInput({ type: 'click', x: 1, y: 1 });
  assert.equal(f.requests.length, 0);
  assert.equal(
    defined(f.document.querySelector<HTMLImageElement>('#screen-target')).classList.contains(
      'controlling',
    ),
    false,
  );
  f.c.state.worker.status = 'online';
  f.c.callStops.pending = true;
  f.c.render();
  await f.c.vmInput({ type: 'key', key: 'Return' });
  assert.equal(f.requests.length, 0, 'a pending unknown call stop never enables human input');
});

test('an existing human lease may still be returned while the agent is offline or a call stop is pending', async () => {
  const f = fixture();
  f.c.state.computer.status = 'human';
  f.c.callStops.pending = true;
  f.c.render();
  const release = f.document.querySelector<HTMLButtonElement>('[data-action="takeover"]');
  assert.equal(defined(release).disabled, false);
  assert.equal(defined(release).textContent, 'Return to dant');
  await f.click('[data-action="takeover"]');
  assert.equal(defined(f.requests[0]).route, '/takeover');
  assert.deepEqual(JSON.parse(JSON.stringify(defined(f.requests[0]).body)), {
    enabled: false,
    sessionId: 'lease-1',
  });
  assert.equal(f.c.state.computer.status, 'agent');
});
test('human input keeps its exact lease during a connected call without sending a media stop', async () => {
  const f = fixture(),
    call = { id: 'live', provider: 'subscription', status: 'connected' },
    peer = {
      close() {
        throw Error('Call media must stay connected');
      },
    };
  f.c.state.worker.status = 'online';
  f.c.state.computer.status = 'human';
  f.c.state.call = call;
  f.c.pc = peer;
  f.c.render();
  await f.c.vmInput({ type: 'click', x: 12, y: 34 });
  await f.c.vmInput({ type: 'text', text: 'ordinary test input' });
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [
    { route: '/input', body: { type: 'click', x: 12, y: 34, sessionId: 'lease-1' } },
    { route: '/input', body: { type: 'text', text: 'ordinary test input', sessionId: 'lease-1' } },
  ]);
  assert.equal(f.c.state.call, call);
  assert.equal(f.c.pc, peer);
  f.c.state.computer.status = 'agent';
  await f.c.vmInput({ type: 'key', key: 'Return' });
  assert.equal(f.requests.length, 2, 'returning the lease immediately blocks further human input');
});

test('manual Reconnect restores the executor path explicitly without resuming or replaying a task', async () => {
  const f = fixture();
  await f.click('.computer-meta [data-action="connect"]');
  assert.deepEqual(
    f.requests.map((item) => item.route),
    ['/connect', '/state'],
  );
  assert.equal(f.c.state.worker.status, 'online');
  assert.equal(f.document.querySelector('[data-action="connect"]'), null);
  assert.ok(f.document.querySelector('.computer-meta [data-action="screen-refresh"]'));
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-action="takeover"]')).disabled,
    false,
  );
  assert.equal(f.screens.length, 0);
});

test('the single connection row announces connecting and prevents duplicate reconnects until completion', async () => {
  for (const [language, connecting] of [
    ['en', 'Connecting'],
    ['zh', '连接中'],
  ] as const) {
    const f = fixture(language),
      post = f.c.post;
    let release: (() => void) | undefined,
      attempts = 0;
    const wait = new Promise<void>((resolve) => (release = resolve));
    f.c.post = async (route, body) => {
      attempts++;
      await wait;
      return post(route, body);
    };
    const request = f.c.action('connect'),
      reconnect = defined(
        f.document.querySelector<HTMLButtonElement>('.computer-meta [data-action="connect"]'),
      );
    assert.equal(reconnect.disabled, true);
    assert.equal(reconnect.getAttribute('aria-busy'), 'true');
    assert.equal(reconnect.textContent, connecting);
    assert.equal(
      defined(f.document.querySelector('#computer-connection-status')).textContent,
      connecting,
    );
    assert.equal(f.document.querySelector('[data-action="screen-refresh"]'), null);
    await f.c.action('connect');
    assert.equal(attempts, 1);
    defined(release)();
    await request;
    assert.equal(f.document.querySelector('[data-action="connect"]'), null);
    assert.equal(f.c.pendingActions.has('connect'), false);
    assert.ok(f.document.querySelector('[data-action="screen-refresh"]'));
  }
});

test('connection snapshots keep one recovery action and restore it after a failed manual reconnect', async () => {
  for (const boundary of ['controller', 'worker'] as const) {
    const f = fixture();
    defined(f.c.state[boundary]).status = 'connecting';
    f.c.render();
    const reconnect = defined(
      f.document.querySelector<HTMLButtonElement>('.computer-meta [data-action="connect"]'),
    );
    assert.equal(reconnect.disabled, true);
    assert.equal(reconnect.getAttribute('aria-busy'), 'true');
    assert.equal(f.document.querySelector('[data-action="screen-refresh"]'), null);
    assert.equal(f.document.querySelectorAll('[data-action="connect"]').length, 1);
  }
  const f = fixture();
  f.c.post = async (route) => {
    f.requests.push({ route });
    throw Error('Fixture connection failure');
  };
  await assert.rejects(f.c.action('connect'), /Fixture connection failure/);
  const reconnect = defined(
    f.document.querySelector<HTMLButtonElement>('.computer-meta [data-action="connect"]'),
  );
  assert.equal(reconnect.disabled, false);
  assert.equal(reconnect.getAttribute('aria-busy'), null);
  assert.equal(reconnect.textContent, 'Reconnect');
  assert.deepEqual(
    f.requests.map((item) => item.route),
    ['/connect'],
  );
  assert.equal(f.c.pendingActions.has('connect'), false);
});

test('online connection status preserves agent control, human control and desktop refresh without reconnect', () => {
  for (const [control, status] of [
    ['agent', 'Controlled by dant'],
    ['human', 'You have control'],
  ]) {
    const f = fixture();
    f.c.state.worker.status = 'online';
    f.c.state.computer.status = defined(control);
    f.c.render();
    assert.equal(
      defined(f.document.querySelector('#computer-connection-status')).textContent,
      status,
    );
    assert.equal(f.document.querySelector('[data-action="connect"]'), null);
    assert.ok(f.document.querySelector('.computer-meta [data-action="screen-refresh"]'));
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-action="takeover"]')).disabled,
      false,
    );
  }
});

test('older snapshots without a controller retain their previous online-only preview contract', () => {
  const f = fixture();
  delete f.c.state.controller;
  assert.equal(f.c.screenVisible(), false);
  f.c.state.worker.status = 'online';
  f.c.render();
  assert.equal(f.c.screenVisible(), true);
  assert.ok(f.document.querySelector<HTMLImageElement>('#screen'));
});

test('a slow frame decodes before publication while the prior image survives state reconciliation', async () => {
  const f = fixture(),
    img = f.document.querySelector<HTMLImageElement>('#screen');
  f.decode = 'pending';
  f.c.restartScreen();
  await settle();
  assert.equal(f.images.length, 1);
  assert.equal(defined(f.images[0]).src, 'blob:screen-1');
  assert.equal(f.c.screenBusy, true);
  assert.equal(f.c.screenURL, 'blob:existing-frame');
  assert.equal(defined(img).src, 'blob:existing-frame');
  assert.deepEqual(f.revoked, []);
  await f.tick();
  assert.equal(f.screens.length, 1, 'decode remains part of the serialized frame request');
  f.c.state.settings.language = 'zh';
  f.c.render();
  assert.ok(f.document.querySelector<HTMLImageElement>('#screen') === img);
  assert.equal(defined(img).src, 'blob:existing-frame');
  defined(defined(f.images[0]).onload)();
  await settle();
  assert.equal(f.c.screenURL, 'blob:screen-1');
  assert.equal(defined(img).src, 'blob:screen-1');
  assert.equal(f.c.screenBusy, false);
  assert.deepEqual(f.revoked, ['blob:existing-frame']);
  assert.equal(defined(f.images[0]).onload, null);
  assert.equal(defined(f.images[0]).onerror, null);
});

test('decode errors keep the last good frame, report localized retry status and recover on a valid refresh', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture(language);
    f.c.state.worker.status = 'online';
    f.c.render();
    const img = f.document.querySelector<HTMLImageElement>('#screen');
    f.decode = 'error';
    f.c.restartScreen();
    await settle();
    assert.equal(f.c.screenURL, 'blob:existing-frame');
    assert.equal(defined(img).src, 'blob:existing-frame');
    assert.equal(f.c.screenFailures, 1);
    assert.deepEqual(f.revoked, ['blob:screen-1']);
    await f.tick();
    assert.equal(f.c.screenURL, 'blob:existing-frame');
    assert.ok(f.document.querySelector<HTMLImageElement>('#screen') === img);
    assert.match(
      defined(f.document.querySelector<HTMLElement>('.screen-status')).textContent,
      language === 'en' ? /could not refresh/ : /暂时无法刷新/,
    );
    assert.deepEqual(f.revoked, ['blob:screen-1', 'blob:screen-2']);
    f.decode = 'ok';
    await f.click('[data-action="screen-refresh"]');
    assert.equal(f.c.screenURL, 'blob:screen-3');
    assert.equal(defined(img).src, 'blob:screen-3');
    assert.equal(f.c.screenError, '');
    assert.equal(f.c.screenFailures, 0);
    assert.ok(f.document.querySelector<HTMLElement>('.screen-status') === null);
    assert.deepEqual(f.revoked, ['blob:screen-1', 'blob:screen-2', 'blob:existing-frame']);
    assert.equal(f.requests.length, 0, 'frame recovery never reconnects, hangs up or replays work');
  }
});

test('decode abort and late load callbacks cannot publish or revoke a different frame', async () => {
  const f = fixture();
  f.decode = 'pending';
  f.c.restartScreen();
  await settle();
  const pending = f.images[0],
    lateLoad = defined(pending).onload;
  f.c.page = 'settings';
  f.c.restartScreen();
  await settle();
  assert.equal(defined(f.screens[0]).options.signal.aborted, true);
  assert.equal(defined(pending).src, '');
  assert.equal(f.c.screenBusy, false);
  assert.equal(f.c.screenURL, 'blob:existing-frame');
  assert.equal(f.c.screenFailures, 0);
  assert.deepEqual(f.revoked, ['blob:screen-1']);
  f.c.page = 'chat';
  f.decode = 'ok';
  f.c.restartScreen();
  await settle();
  assert.equal(f.c.screenURL, 'blob:screen-2');
  defined(lateLoad)();
  await settle();
  assert.equal(f.c.screenURL, 'blob:screen-2');
  assert.deepEqual(f.revoked, ['blob:screen-1', 'blob:existing-frame']);
  assert.equal(defined(f.document.querySelector<HTMLImageElement>('#screen')).src, 'blob:screen-2');
});

test('the request timeout also bounds image decoding and zero-sized frames are rejected', async () => {
  const f = fixture();
  f.decode = 'pending';
  f.c.restartScreen();
  await settle();
  const timeout = [...f.timeouts.values()].find((value) => value.ms === 10000);
  assert.ok(timeout);
  timeout.callback();
  await settle();
  assert.equal(f.c.screenBusy, false);
  assert.equal(f.c.screenURL, 'blob:existing-frame');
  assert.equal(f.c.screenFailures, 1);
  assert.deepEqual(f.revoked, ['blob:screen-1']);
  await f.tick();
  assert.equal(f.screens.length, 2);
  defined(f.images[1]).naturalWidth = 0;
  defined(defined(f.images[1]).onload)();
  await settle();
  assert.equal(f.c.screenURL, 'blob:existing-frame');
  assert.equal(f.c.screenFailures, 2);
  assert.ok(f.document.querySelector<HTMLElement>('.screen-status'));
  assert.deepEqual(f.revoked, ['blob:screen-1', 'blob:screen-2']);
});

test('a decoded candidate from an older epoch or removed panel is released without replacing the active URL', async () => {
  const f = fixture();
  f.decode = 'pending';
  f.c.restartScreen();
  await settle();
  f.c.screenEpoch++;
  defined(defined(f.images[0]).onload)();
  await settle();
  assert.equal(f.c.screenURL, 'blob:existing-frame');
  assert.deepEqual(f.revoked, ['blob:screen-1']);
  await f.tick();
  defined(f.document.querySelector<HTMLImageElement>('#screen')).remove();
  defined(defined(f.images[1]).onload)();
  await settle();
  assert.equal(f.c.screenURL, 'blob:existing-frame');
  assert.deepEqual(f.revoked, ['blob:screen-1', 'blob:screen-2']);
});

test('loaded image bytes must finish pixel decoding before publication, and decode failures retain the prior frame', async () => {
  const f = fixture();
  f.decode = 'pending';
  f.c.restartScreen();
  await settle();
  let finishDecode: (() => void) | undefined;
  defined(f.images[0]).decode = () => new Promise<void>((resolve) => (finishDecode = resolve));
  defined(defined(f.images[0]).onload)();
  await settle();
  assert.equal(f.c.screenURL, 'blob:existing-frame');
  assert.equal(f.c.screenBusy, true);
  defined(finishDecode)();
  await settle();
  assert.equal(f.c.screenURL, 'blob:screen-1');
  assert.deepEqual(f.revoked, ['blob:existing-frame']);
  await f.tick();
  defined(f.images[1]).decode = async () => {
    throw Error('Invalid pixel data');
  };
  defined(defined(f.images[1]).onload)();
  await settle();
  assert.equal(f.c.screenURL, 'blob:screen-1');
  assert.equal(f.c.screenFailures, 1);
  assert.deepEqual(f.revoked, ['blob:existing-frame', 'blob:screen-2']);
  await f.tick();
  let lateDecode: (() => void) | undefined;
  defined(f.images[2]).decode = () => new Promise<void>((resolve) => (lateDecode = resolve));
  defined(defined(f.images[2]).onload)();
  await settle();
  f.c.showComputer = false;
  f.c.restartScreen();
  await settle();
  assert.equal(f.c.screenURL, 'blob:screen-1');
  assert.equal(f.c.screenBusy, false);
  defined(lateDecode)();
  await settle();
  assert.deepEqual(f.revoked, ['blob:existing-frame', 'blob:screen-2', 'blob:screen-3']);
  assert.equal(f.c.screenURL, 'blob:screen-1');
});
