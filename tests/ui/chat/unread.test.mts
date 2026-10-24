import type { ReadMessage } from '../../../ui/chat/read-state.mts';
import type { ApiOptions, Timer } from '../../../ui/shared/contracts.mts';
import { isRecord } from '../../../ui/shared/json.mts';
type VisibilityOptions = NonNullable<Parameters<typeof createReadVisibility>[0]>;
type ReadBody = { ids?: string[]; attachmentSnapshots?: Record<string, string[]> };
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import {
  sourceEventListener,
  sourceSection,
  sourceSelectorBinding,
} from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createReadVisibility } from '../../../ui/chat/read-state.mts';
import { createTransport } from '../../../ui/platform/transport.mts';

function rect(value: {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    ...value,
    x: value.left,
    y: value.top,
    toJSON() {
      return { ...value };
    },
  };
}
function readBody(value: unknown): ReadBody {
  assert.ok(isRecord(value));
  const snapshots = value.attachmentSnapshots;
  assert.ok(isRecord(snapshots));
  const attachmentSnapshots: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(snapshots)) {
    assert.ok(Array.isArray(ids));
    attachmentSnapshots[key] = ids.map((id: unknown) => {
      assert.ok(typeof id === 'string');
      return id;
    });
  }
  return { attachmentSnapshots };
}
const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
const part = (start: string, end: string) => sourceSection(source, start, end);
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
const deferred = <Value = unknown,>() => {
  let resolve: ((value: Value) => void) | undefined,
    reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve: defined(resolve), reject: defined(reject) };
};
function nativeFixture(
  options: {
    failListen?: boolean;
    loadWindow?: VisibilityOptions['loadWindow'];
    onChange?: (visible: boolean) => void;
  } = {},
) {
  const listeners = new Map<string, (event: { payload?: unknown }) => void>(),
    changes: boolean[] = [],
    stops: string[] = [];
  let minimized = false,
    focused = true,
    query: { minimized: Promise<unknown>; focused: Promise<unknown> } | null = null;
  const native = {
    isMinimized: () => query?.minimized ?? Promise.resolve(minimized),
    isFocused: () => query?.focused ?? Promise.resolve(focused),
    onFocusChanged: async (callback: (event: { payload?: unknown }) => void) => {
      listeners.set('focus', callback);
      if (options.failListen) throw Error('Unavailable');
      return () => stops.push('focus');
    },
    onResized: async (callback: () => void) => {
      listeners.set('resize', callback);
      return () => stops.push('resize');
    },
  };
  const window = {
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string, callback: () => void) => {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
  };
  const guard = createReadVisibility({
    desktop: true,
    onChange: (value) => {
      changes.push(value);
      options.onChange?.(value);
    },
    loadWindow: options.loadWindow || (() => Promise.resolve({ getCurrentWindow: () => native })),
    window,
  });
  return {
    guard,
    changes,
    listeners,
    stops,
    get minimized() {
      return minimized;
    },
    set minimized(value: boolean) {
      minimized = value;
    },
    set focused(value: boolean) {
      focused = value;
    },
    set query(value: { minimized: Promise<unknown>; focused: Promise<unknown> } | null) {
      query = value;
    },
  };
}

test('native foreground is confirmed before reads and minimize invalidates visibility synchronously', async () => {
  const f = nativeFixture();
  assert.equal(f.guard.documentFocusRequired, false);
  assert.equal(f.guard.visible, false);
  await settle();
  assert.equal(f.guard.visible, true);
  f.minimized = true;
  defined(f.listeners.get('resize'))({ payload: { width: 0, height: 0 } });
  assert.equal(
    f.guard.visible,
    false,
    'a cached focused WebView cannot authorize reads during native minimize',
  );
  await settle();
  assert.equal(f.guard.visible, false);
  f.minimized = false;
  f.focused = false;
  defined(f.listeners.get('resize'))({});
  await settle();
  assert.equal(f.guard.visible, false);
  f.focused = true;
  defined(f.listeners.get('focus'))({ payload: true });
  assert.equal(f.guard.visible, false);
  await settle();
  assert.equal(f.guard.visible, true);
  defined(f.listeners.get('focus'))({ payload: false });
  assert.equal(f.guard.visible, false);
  await settle();
  assert.equal(
    f.guard.visible,
    false,
    'a focus-loss event wins even if a cached query would still report focused',
  );
  f.guard.dispose();
  assert.deepEqual(f.stops.sort(), ['focus', 'resize']);
  assert.equal(f.listeners.has('beforeunload'), false);
});

test('late native queries cannot restore visibility after minimize, failed query or disposal', async () => {
  const f = nativeFixture();
  await settle();
  const oldMin = deferred(),
    oldFocus = deferred();
  f.query = { minimized: oldMin.promise, focused: oldFocus.promise };
  const stale = f.guard.refresh();
  f.query = null;
  f.minimized = true;
  defined(f.listeners.get('resize'))({});
  await settle();
  oldMin.resolve(false);
  oldFocus.resolve(true);
  await stale;
  assert.equal(f.guard.visible, false);
  f.minimized = false;
  f.query = { minimized: Promise.reject(Error('Query failed')), focused: Promise.resolve(true) };
  await f.guard.refresh();
  assert.equal(f.guard.visible, false);
  f.query = null;
  await f.guard.refresh();
  assert.equal(f.guard.visible, true);
  const min = deferred(),
    focus = deferred();
  f.query = { minimized: min.promise, focused: focus.promise };
  const pending = f.guard.refresh();
  f.guard.dispose();
  min.resolve(false);
  focus.resolve(true);
  await pending;
  assert.equal(f.guard.visible, false);
  f.guard.dispose();
  assert.equal(f.stops.length, 2);
});

test('browser fallback does not load native APIs and native initialization failures remain unread', async () => {
  let loaded = 0;
  const browser = createReadVisibility({
    desktop: false,
    loadWindow: () => {
      loaded++;
      throw Error('Unexpected');
    },
  });
  assert.equal(browser.visible, true);
  assert.equal(browser.documentFocusRequired, true);
  await browser.refresh();
  browser.dispose();
  assert.equal(browser.visible, false);
  assert.equal(loaded, 0);
  const failed = nativeFixture({
    loadWindow: async () => {
      throw Error('Unavailable');
    },
  });
  await settle();
  assert.equal(failed.guard.visible, false);
  failed.guard.dispose();
  const listening = nativeFixture({ failListen: true });
  await settle();
  assert.equal(listening.guard.visible, false);
  await listening.guard.refresh();
  assert.equal(listening.guard.visible, false);
  listening.guard.dispose();
  assert.deepEqual(listening.stops, ['resize']);
  const load = deferred<Awaited<ReturnType<NonNullable<VisibilityOptions['loadWindow']>>>>(),
    disposed = nativeFixture({ loadWindow: () => load.promise });
  await settle();
  defined(disposed.listeners.get('beforeunload'))({});
  load.resolve({
    getCurrentWindow() {
      throw Error('Disposed UI must not bind');
    },
  });
  await settle();
  assert.equal(disposed.guard.visible, false);
  const subscriptions = deferred<() => void>(),
    lateStops: boolean[] = [],
    delayed = createReadVisibility({
      desktop: true,
      window: {},
      loadWindow: async () => ({
        getCurrentWindow: () => ({
          isMinimized: async () => false,
          isFocused: async () => true,
          onFocusChanged: () => subscriptions.promise,
          onResized: () => subscriptions.promise,
        }),
      }),
    });
  await settle();
  delayed.dispose();
  subscriptions.resolve(() => lateStops.push(true));
  await settle();
  assert.equal(lateStops.length, 2);
  assert.equal(delayed.visible, false);
});

function fixture(language = 'en') {
  const { document, Event } = parseHTML(
    '<html><body><nav id="rail"></nav><section id="messages"><article class="message assistant" data-id="a"></article></section><div id="control"></div></body></html>',
  );
  let hidden = false,
    focused = true,
    now = 0,
    sequence = 0,
    rectangle = { left: 20, right: 220, top: 20, bottom: 80, width: 200, height: 60 },
    fail = false;
  Object.defineProperty(document, 'hidden', { get: () => hidden });
  document.hasFocus = () => focused;
  const root = document.querySelector<HTMLElement>('#messages'),
    article = document.querySelector<HTMLElement>('article'),
    timers = new Map<Timer, { callback: () => void; at: number }>(),
    requests: { route: string; body: unknown }[] = [],
    observerCalls: (() => void)[] = [],
    windowListeners = new Map<string, () => void>();
  defined(root).getBoundingClientRect = () =>
    rect({
      left: 0,
      right: 300,
      top: 0,
      bottom: 300,
      width: 300,
      height: 300,
    });
  defined(article).getBoundingClientRect = () => rect(rectangle);
  const state: {
    conversationId?: string;
    settings: { language: string };
    messages: ReadMessage[];
  } = {
    settings: { language },
    messages: [
      {
        id: 'a',
        role: 'assistant',
        text: 'Completed result',
        status: 'completed',
        read: false,
        time: 1,
      },
    ],
  };
  const c = uiEntrypointFixture({
    document,
    window: {
      IntersectionObserver: true,
      addEventListener: (name: string, callback: () => void) => {
        windowListeners.set(name, callback);
      },
    },
    state,
    eventConnected: true,
    page: 'chat',
    chatMode: 'text',
    readVisibility: {
      visible: true,
      documentFocusRequired: true,
      async refresh() {},
    },
    modal: null as string | null,
    pc: null as object | null,
    callMini: false,
    fallbackLanguage: language,
    positionReactionMenus() {},
    restartScreen() {},
    ico: (name: string) => `<svg data-icon="${name}"></svg>`,
    eyes: () => '<i></i>',
    button: () => '<button></button>',
    post: (route: string, body: unknown) => {
      requests.push({ route, body: structuredClone(body) });
      return fail ? Promise.reject(Error('Offline')) : Promise.resolve({ ok: true });
    },
    setTimeout: (callback: () => void, ms: number) => {
      const id = ++sequence;
      timers.set(id, { callback, at: now + ms });
      return id;
    },
    clearTimeout: (id: Timer | undefined) => id !== undefined && timers.delete(id),
    IntersectionObserver: class {
      constructor(callback: () => void) {
        observerCalls.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  c.api = (route, options) => {
    if (options?.beforeSend && options.beforeSend() !== true)
      return Promise.reject(Error('Receipt target changed'));
    return c.post(route, options?.body);
  };
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(
    stripTypeScriptTypes(
      part('function currentState(', 'const subscriptionVoiceUnavailable=') +
        '\n' +
        '' +
        '\n' +
        part('function unreadAssistant(', 'function revealMessage(){') +
        '\n' +
        part('function renderRail(){', 'function renderHeader(') +
        '\n' +
        part('const readTimers=', 'async function handleEvent(') +
        '\n' +
        sourceEventListener(source, 'window', 'blur'),
    ),
    c,
  );
  const advance = (ms: number) => {
    const end = now + ms;
    while (true) {
      const first = [...timers.entries()]
        .filter(([, entry]) => entry.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      timers.delete(first[0]);
      now = first[1].at;
      first[1].callback();
    }
    now = end;
  };
  const render = () => {
    defined(document.querySelector<HTMLElement>('#rail')).innerHTML = c.renderRail();
    defined(document.querySelector<HTMLElement>('#control')).innerHTML = c.renderUnreadControl();
  };
  render();
  return {
    c,
    document,
    Event,
    article,
    root,
    requests,
    timers,
    windowListeners,
    render,
    advance,
    get rectangle() {
      return rectangle;
    },
    set rectangle(value) {
      rectangle = value;
    },
    set hidden(value: boolean) {
      hidden = value;
    },
    set focused(value: boolean) {
      focused = value;
    },
    set fail(value: boolean) {
      fail = value;
    },
  };
}

test('acknowledged receipts let a slow native state poll deliver the authoritative read state', async () => {
  const f = fixture(),
    pendingReads: ReturnType<typeof deferred>[] = [];
  let backendRead = false;
  const response = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });
  const transport = createTransport({
    desktop: true,
    pollDelay: 5,
    invokeRequest: async (_command, request) => {
      if (request.method === 'POST') {
        assert.equal(request.route, '/api/read');
        assert.ok(request.body);
        const body: unknown = JSON.parse(request.body);
        f.requests.push({ route: '/read', body });
        backendRead = true;
        return response({ ok: true });
      }
      assert.equal(request.route, '/api/state');
      const pending = deferred();
      pendingReads.push(pending);
      return pending.promise;
    },
  });
  f.c.api = (route, options) => transport.json('/api' + route, options);
  // This is the same transport used by the desktop. It discards state reads
  // crossing a mutation, so repeated receipts cannot be allowed to starve it.
  f.c.post = (route, body) => transport.json('/api' + route, { method: 'POST', body });
  transport.startEvents({
    onEvent: (event) => {
      assert.ok(isRecord(event.data));
      assert.ok(typeof event.data.read === 'boolean');
      defined(f.c.state.messages[0]).read = event.data.read;
      f.render();
      f.c.updateRead();
    },
  });
  try {
    assert.equal(pendingReads.length, 1);
    f.c.updateRead();
    f.advance(450);
    await settle();
    assert.equal(f.requests.length, 1);
    assert.equal(backendRead, true);
    assert.equal(defined(f.c.state.messages[0]).read, false, 'a POST is not a state snapshot');
    // Hold the native state request beyond the 450ms dwell, as with the SSH
    // round-trip in the installed Controller, and keep it delayed for seconds.
    f.advance(2000);
    await settle();
    assert.equal(f.requests.length, 1, 'a successful receipt waits for state reconciliation');
    defined(pendingReads[0]).resolve(response({ read: false }));
    await settle();
    assert.equal(pendingReads.length, 2, 'the crossed old snapshot is discarded');
    f.advance(2000);
    await settle();
    assert.equal(f.requests.length, 1, 'there is no receipt storm during the next slow poll');
    defined(pendingReads[1]).resolve(response({ read: backendRead }));
    await settle();
    assert.equal(defined(f.c.state.messages[0]).read, true);
    assert.match(
      f.c.renderAssistantReadState(defined(f.c.state.messages[0])),
      /data-read-state="read"/,
    );
    assert.equal(f.c.unreadMessages().length, 0);
    assert.equal(f.document.querySelector('.unread-jump'), null);
    f.advance(2000);
    await settle();
    assert.equal(f.requests.length, 1);
  } finally {
    transport.close();
    for (const pending of pendingReads) pending.resolve(response({ read: backendRead }));
    f.c.stopReadTracking();
    await settle();
  }
});

test('late receipt outcomes cannot release the pending receipt of the same ID in another conversation', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    const f = fixture(),
      first = deferred(),
      second = deferred();
    f.c.state.conversationId = 'first-conversation';
    f.c.post = (route, body) => {
      f.requests.push({ route, body: structuredClone(body) });
      return f.requests.length === 1 ? first.promise : second.promise;
    };
    f.c.updateRead();
    f.advance(450);
    assert.equal(f.requests.length, 1);
    f.c.state.conversationId = 'second-conversation';
    f.c.updateRead();
    f.advance(450);
    assert.equal(f.requests.length, 2, 'the new conversation completes its own dwell');
    if (outcome === 'success') first.resolve({ ok: true });
    else first.reject(Error('Old connection closed'));
    await settle();
    f.advance(2000);
    await settle();
    assert.equal(f.requests.length, 2, 'an old callback does not release the new pending receipt');
    assert.equal(defined(f.c.state.messages[0]).read, false);
    second.resolve({ ok: true });
    await settle();
    f.advance(1000);
    await settle();
    assert.equal(f.requests.length, 2);
    defined(f.c.state.messages[0]).read = true;
    f.c.updateRead();
    f.c.stopReadTracking();
  }
});

test('a queued receipt captures its conversation and cannot cross a changed target', async () => {
  const f = fixture(),
    pending = deferred(),
    api = f.c.api;
  let queued: ApiOptions | undefined;
  f.c.state.conversationId = 'first-conversation';
  f.c.api = (_route, options) => {
    queued = options;
    return pending.promise;
  };
  f.c.updateRead();
  f.advance(450);
  const captured = defined(queued),
    body = captured.body;
  assert.ok(isRecord(body));
  assert.equal(body.conversationId, 'first-conversation');
  assert.equal(defined(captured.beforeSend)(), true);
  f.c.state.conversationId = 'second-conversation';
  f.c.updateRead();
  assert.equal(
    defined(captured.beforeSend)(),
    false,
    'the native queue must not dispatch this receipt',
  );
  assert.equal(body.conversationId, 'first-conversation', 'the captured body is unchanged');
  f.c.api = api;
  pending.reject(Error('Receipt target changed'));
  await settle();
  f.advance(450);
  await settle();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0], {
    route: '/read',
    body: { conversationId: 'second-conversation', ids: ['a'], attachmentSnapshots: { a: [] } },
  });
  f.c.stopReadTracking();
});

test('acknowledged receipts survive DOM replacement and reconcile while minimized without fabricating reads', async () => {
  const f = fixture(),
    attachment = '10000000-0000-4000-8000-000000000001';
  f.c.updateRead();
  f.advance(450);
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(defined(f.c.state.messages[0]).read, false);
  const replacement = defined(f.article).cloneNode(true);
  assert.ok(replacement instanceof defined(f.document.defaultView).HTMLElement);
  replacement.getBoundingClientRect = () => rect(f.rectangle);
  defined(f.article).replaceWith(replacement);
  f.c.updateRead();
  f.advance(2000);
  await settle();
  assert.equal(f.requests.length, 1, 'new markup is not a new receipt revision');
  f.c.readVisibility.visible = false;
  f.c.updateRead();
  defined(f.c.state.messages[0]).read = true;
  f.c.updateRead();
  Object.assign(defined(f.c.state.messages[0]), {
    read: false,
    attachments: [{ id: attachment }],
    visibleAttachmentIds: [],
  });
  f.c.updateRead();
  f.advance(1000);
  assert.equal(f.requests.length, 1, 'minimized windows do not acknowledge new attachments');
  f.c.readVisibility.visible = true;
  f.c.updateRead();
  f.advance(449);
  assert.equal(f.requests.length, 1);
  f.advance(1);
  assert.equal(
    f.requests.length,
    2,
    'the prior receipt was reconciled outside the rendered target map',
  );
  assert.deepEqual(readBody(defined(f.requests[1]).body).attachmentSnapshots, { a: [attachment] });
  await settle();
  f.c.stopReadTracking();
});

test('a receipt acknowledged while minimized waits for state and releases a later attachment revision', async () => {
  const f = fixture(),
    pending = deferred(),
    attachment = '10000000-0000-4000-8000-000000000001';
  f.c.post = (route, body) => {
    f.requests.push({ route, body: structuredClone(body) });
    return pending.promise;
  };
  f.c.updateRead();
  f.advance(450);
  f.c.readVisibility.visible = false;
  f.c.updateRead();
  pending.resolve({ ok: true });
  await settle();
  f.advance(2000);
  assert.equal(f.requests.length, 1);
  assert.equal(
    defined(f.c.state.messages[0]).read,
    false,
    'a background callback does not invent a read',
  );
  defined(f.c.state.messages[0]).read = true;
  f.c.updateRead();
  Object.assign(defined(f.c.state.messages[0]), {
    read: false,
    attachments: [{ id: attachment }],
    visibleAttachmentIds: [],
  });
  f.c.readVisibility.visible = true;
  f.c.updateRead();
  f.advance(450);
  await settle();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(readBody(defined(f.requests[1]).body).attachmentSnapshots, { a: [attachment] });
  f.c.stopReadTracking();
});

test('disconnect clears unreconciled receipt ownership and a new connection requires fresh visible dwell', async () => {
  const f = fixture();
  f.c.updateRead();
  f.advance(450);
  await settle();
  assert.equal(f.requests.length, 1);
  f.c.eventConnected = false;
  f.c.updateRead();
  f.advance(2000);
  assert.equal(f.requests.length, 1);
  f.c.eventConnected = true;
  f.c.updateRead();
  f.advance(449);
  assert.equal(f.requests.length, 1);
  f.advance(1);
  await settle();
  assert.equal(f.requests.length, 2);
  assert.equal(defined(f.c.state.messages[0]).read, false);
  f.c.stopReadTracking();
});

test('changing only the known-hosts file or provider releases acknowledged receipts for cloned message IDs', async () => {
  for (const field of ['knownHosts', 'provider'] as const) {
    const f = fixture();
    f.c.state.conversationId = 'same-conversation';
    Object.assign(f.c.state.settings, { vm: { [field]: 'first-target' } });
    f.c.updateRead();
    f.advance(450);
    await settle();
    assert.equal(f.requests.length, 1);
    f.advance(1000);
    await settle();
    assert.equal(f.requests.length, 1, 'an unchanged target retains the acknowledged receipt');
    Object.assign(f.c.state.settings, { vm: { [field]: 'second-target' } });
    f.c.updateRead();
    f.advance(449);
    assert.equal(f.requests.length, 1);
    f.advance(1);
    await settle();
    assert.equal(f.requests.length, 2, `${field} changes require a new target receipt`);
    assert.equal(defined(f.c.state.messages[0]).read, false);
    f.c.stopReadTracking();
  }
});

test('a queued receipt rejects changes to only known-hosts or provider and preserves legacy omissions', async () => {
  for (const field of ['knownHosts', 'provider'] as const) {
    const f = fixture(),
      pending = deferred();
    let queued: ApiOptions | undefined;
    f.c.api = (_route, options) => {
      queued = options;
      return pending.promise;
    };
    f.c.updateRead();
    f.advance(450);
    const captured = defined(queued),
      body = captured.body;
    assert.ok(isRecord(body));
    assert.equal(
      Object.hasOwn(body, 'conversationId'),
      false,
      'legacy state receives no invented identity',
    );
    assert.equal(defined(captured.beforeSend)(), true);
    Object.assign(f.c.state.settings, { vm: {} });
    assert.equal(
      defined(captured.beforeSend)(),
      true,
      'omitted optional target fields remain absent',
    );
    Object.assign(f.c.state.settings, { vm: { [field]: 'new-target' } });
    assert.equal(
      defined(captured.beforeSend)(),
      false,
      `${field} changes cannot cross the native queue`,
    );
    f.c.updateRead();
    pending.reject(Error('Receipt target changed'));
    await settle();
    f.c.stopReadTracking();
  }
});

test('history outside the rendered message window remains unread and is never acknowledged by the visible message tracker', async () => {
  const f = fixture();
  f.c.state.messages.unshift(
    ...Array.from({ length: 600 }, (_, index): ReadMessage => ({
      id: 'hidden-' + index,
      role: 'assistant',
      status: 'completed',
      read: false,
    })),
  );
  f.c.updateRead();
  f.advance(500);
  await Promise.resolve();
  assert.equal(f.c.unreadMessages().length, 601);
  assert.deepEqual(
    f.requests.map(({ route }) => route),
    ['/read'],
  );
  const body = f.requests[0]?.body;
  assert.ok(isRecord(body));
  assert.deepEqual(body.ids, ['a']);
  f.c.stopReadTracking();
});

test('durable unread UI counts only completed unseen assistant messages, in both languages', () => {
  for (const language of ['en', 'zh']) {
    const f = fixture(language);
    f.c.state.messages.push(
      { id: 'user', role: 'user', status: 'completed' },
      { id: 'call', role: 'assistant', kind: 'call', status: 'completed' },
      { id: 'stream', role: 'assistant', status: 'streaming' },
      { id: 'read', role: 'assistant', status: 'completed', read: true },
      { id: 'readAt', role: 'assistant', status: 'completed', readAt: 10 },
      { id: 'visible', role: 'assistant', status: 'completed', visibleAt: 10 },
      { id: 'receipt', role: 'assistant', status: 'completed', receipt: { readAt: 10 } },
    );
    f.render();
    assert.equal(f.c.unreadMessages().length, 1);
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-unread-count]')).dataset
        .unreadCount,
      '1',
    );
    assert.match(
      defined(f.document.querySelector<HTMLButtonElement>('[data-first-unread]')).textContent,
      language === 'en' ? /1 unread message$/ : /1 条未读消息/,
    );
    assert.match(
      defined(defined(f.document.querySelector<HTMLElement>('.brand')).getAttribute('aria-label')),
      language === 'en' ? /Chat · 1 unread message/ : /对话 · 1 条未读消息/,
    );
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-first-unread]')).type,
      'button',
    );
    assert.match(
      f.c.renderAssistantReadState(defined(f.c.state.messages[0])),
      language === 'en' ? />Unread</ : />未读</,
    );
    f.c.state = structuredClone(f.c.state);
    assert.equal(
      f.c.unreadMessages().length,
      1,
      'a state refresh/reload keeps unread until a durable receipt arrives',
    );
    defined(f.c.state.messages[0]).read = true;
    defined(f.c.state.messages[0]).visibleAt = 20;
    f.render();
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-unread-count]')).hidden,
      true,
    );
    assert.equal(f.document.querySelector<HTMLButtonElement>('[data-first-unread]'), null);
    assert.match(
      f.c.renderAssistantReadState(defined(f.c.state.messages[0])),
      language === 'en' ? />Read</ : />已读</,
    );
    f.c.state.messages = Array.from({ length: 101 }, (_, index) => ({
      id: String(index),
      role: 'assistant',
      status: 'completed',
    }));
    f.render();
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-unread-count]')).textContent,
      '99+',
    );
    assert.match(
      defined(
        defined(f.document.querySelector<HTMLButtonElement>('[data-first-unread]')).getAttribute(
          'aria-label',
        ),
      ),
      /101/,
    );
  }
});

test('only foreground visible bubbles receive a receipt after a continuous viewport dwell', () => {
  const f = fixture();
  f.c.updateRead();
  f.advance(449);
  assert.equal(f.requests.length, 0);
  f.advance(1);
  assert.deepEqual(f.requests, [
    { route: '/read', body: { ids: ['a'], attachmentSnapshots: { a: [] } } },
  ]);
  f.advance(1000);
  f.c.updateRead();
  f.advance(500);
  assert.equal(f.requests.length, 1, 'pending acknowledgements are not submitted repeatedly');
  assert.equal(
    defined(f.c.state.messages[0]).read,
    false,
    'the request itself does not fabricate a durable read flag',
  );
  defined(f.c.state.messages[0]).read = true;
  f.c.updateRead();
  assert.equal(f.timers.size, 0);
});

test('confirmed native foreground reads visible retained replies while WebView document focus lags', async () => {
  const f = fixture(),
    native = nativeFixture({ onChange: () => f.c.updateRead() });
  f.c.readVisibility = native.guard;
  f.focused = false;
  defined(f.c.state.messages[0]).status = 'paused';
  f.c.updateRead();
  f.advance(1000);
  assert.equal(f.requests.length, 0, 'native initialization must confirm foreground first');
  await settle();
  f.advance(449);
  assert.equal(f.requests.length, 0);
  f.advance(1);
  assert.deepEqual(f.requests, [
    { route: '/read', body: { ids: ['a'], attachmentSnapshots: { a: [] } } },
  ]);
  assert.equal(defined(f.c.state.messages[0]).read, false);
  native.guard.dispose();
  f.c.stopReadTracking();
});

test('WebView blur cancels dwell until a fresh native foreground query confirms the window', async () => {
  const f = fixture(),
    native = nativeFixture({ onChange: () => f.c.updateRead() });
  f.c.readVisibility = native.guard;
  await settle();
  f.advance(300);
  const minimized = deferred(),
    focused = deferred();
  native.query = { minimized: minimized.promise, focused: focused.promise };
  f.focused = false;
  defined(f.windowListeners.get('blur'))();
  assert.equal(native.guard.visible, false, 'cached native focus cannot authorize a read');
  f.advance(1000);
  assert.equal(f.requests.length, 0, 'a pending native query does not complete viewport dwell');
  minimized.resolve(false);
  focused.resolve(true);
  await settle();
  f.advance(449);
  assert.equal(f.requests.length, 0, 'fresh focus restarts the entire viewport dwell');
  f.advance(1);
  assert.equal(f.requests.length, 1);
  native.guard.dispose();
  f.c.stopReadTracking();
});

test('native focus loss invalidates a delayed WebView blur query and preserves unread state', async () => {
  const f = fixture(),
    native = nativeFixture({ onChange: () => f.c.updateRead() });
  f.c.readVisibility = native.guard;
  await settle();
  f.advance(300);
  const minimized = deferred(),
    focused = deferred();
  native.query = { minimized: minimized.promise, focused: focused.promise };
  f.focused = false;
  defined(f.windowListeners.get('blur'))();
  defined(native.listeners.get('focus'))({ payload: false });
  minimized.resolve(false);
  focused.resolve(true);
  await settle();
  f.advance(1000);
  assert.equal(native.guard.visible, false);
  assert.equal(f.requests.length, 0);
  assert.equal(defined(f.c.state.messages[0]).read, false);
  native.guard.dispose();
  f.c.stopReadTracking();
});

test('replacing a visible message element rebinds its observer and restarts viewport dwell', () => {
  const f = fixture();
  f.c.updateRead();
  f.advance(300);
  const replacement = defined(f.article).cloneNode(true);
  assert.ok(replacement instanceof defined(f.document.defaultView).HTMLElement);
  replacement.getBoundingClientRect = () => rect(f.rectangle);
  defined(f.article).replaceWith(replacement);
  assert.equal(defined(f.article).isConnected, false);
  f.c.updateRead();
  f.advance(449);
  assert.equal(f.requests.length, 0, 'a new DOM element must complete its own viewport dwell');
  f.advance(1);
  assert.equal(f.requests.length, 1, 'the detached old node must not strand the read receipt');
});

test('replacing a message element preserves its in-flight receipt and observes later attachments', async () => {
  const f = fixture(),
    pending = deferred(),
    attachment = '10000000-0000-4000-8000-000000000001';
  f.c.post = (route, body) => {
    f.requests.push({ route, body: structuredClone(body) });
    return pending.promise;
  };
  f.c.updateRead();
  f.advance(450);
  assert.equal(f.requests.length, 1);
  const replacement = defined(f.article).cloneNode(true);
  assert.ok(replacement instanceof defined(f.document.defaultView).HTMLElement);
  replacement.getBoundingClientRect = () => rect(f.rectangle);
  defined(f.article).replaceWith(replacement);
  defined(f.c.state.messages[0]).attachments = [{ id: attachment }];
  f.c.updateRead();
  f.advance(1000);
  assert.equal(f.requests.length, 1, 'DOM replacement must not duplicate an in-flight receipt');
  pending.resolve({ ok: true });
  await settle();
  f.advance(449);
  assert.equal(f.requests.length, 1);
  f.advance(1);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(readBody(defined(f.requests[1]).body).attachmentSnapshots, { a: [attachment] });
  f.c.stopReadTracking();
});

test('a retained last reply shows unread independently of task status and still requires viewport dwell', () => {
  const f = fixture(),
    last = defined(f.c.state.messages.at(-1));
  last.status = 'streaming';
  assert.equal(f.c.renderAssistantReadState(last), '');
  f.c.updateRead();
  f.advance(1000);
  assert.equal(f.requests.length, 0);
  last.status = 'paused';
  assert.match(f.c.renderAssistantReadState(last), /data-read-state="unread"/);
  f.rectangle = { left: 20, right: 220, top: 250, bottom: 850, width: 200, height: 600 };
  f.c.updateRead();
  f.advance(1000);
  assert.equal(
    f.requests.length,
    0,
    'a small visible fragment does not acknowledge the last reply',
  );
  assert.equal(last.status, 'paused');
  delete last.status;
  assert.match(f.c.renderAssistantReadState(last), /data-read-state="unread"/);
  f.rectangle = { left: 20, right: 220, top: 0, bottom: 600, width: 200, height: 600 };
  f.c.updateRead();
  f.advance(449);
  assert.equal(f.requests.length, 0);
  f.advance(1);
  assert.equal(f.requests.length, 1);
  assert.equal(last.read, false, 'posting a receipt does not fabricate a durable read flag');
  assert.match(f.c.renderAssistantReadState(last), /data-read-state="unread"/);
  last.visibleAt = 10;
  assert.match(f.c.renderAssistantReadState(last), /data-read-state="read"/);
  assert.equal(last.status, undefined);
  assert.equal(
    f.c.renderAssistantReadState({ id: 'system', role: 'system', status: 'completed' }),
    '',
  );
});

test('minimize, blur, hidden page, modal, settings, offline and full voice view cancel pending reads', () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => {
      f.c.readVisibility.visible = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.hidden = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.focused = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.modal = 'details';
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.page = 'settings';
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.eventConnected = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.chatMode = 'voice';
    },
    (f: ReturnType<typeof fixture>) => {
      f.c.pc = {};
      f.c.callMini = false;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    f.c.updateRead();
    f.advance(300);
    change(f);
    f.c.updateRead();
    f.advance(500);
    assert.equal(f.requests.length, 0);
    assert.equal(defined(f.c.state.messages[0]).read, false);
    assert.equal(f.timers.size, 0);
  }
  const mini = fixture();
  mini.c.pc = {};
  mini.c.callMini = true;
  mini.c.updateRead();
  mini.advance(450);
  assert.equal(mini.requests.length, 1, 'chat bubbles remain readable with the miniature call');
});

test('restore alone does not read offscreen results and scrolling away resets the dwell', () => {
  const f = fixture();
  f.c.readVisibility.visible = false;
  f.c.updateRead();
  f.advance(1000);
  f.rectangle = { left: 20, right: 220, top: 400, bottom: 460, width: 200, height: 60 };
  f.c.readVisibility.visible = true;
  f.c.updateRead();
  f.advance(1000);
  assert.equal(f.requests.length, 0);
  assert.equal(f.c.unreadMessages().length, 1);
  f.rectangle = { left: 20, right: 220, top: 20, bottom: 80, width: 200, height: 60 };
  defined(f.root).dispatchEvent(new f.Event('scroll'));
  f.advance(300);
  f.rectangle = { left: 20, right: 220, top: 280, bottom: 340, width: 200, height: 60 };
  defined(f.root).dispatchEvent(new f.Event('scroll'));
  f.advance(500);
  assert.equal(f.requests.length, 0);
  f.rectangle = { left: 20, right: 220, top: 20, bottom: 80, width: 200, height: 60 };
  defined(f.root).dispatchEvent(new f.Event('scroll'));
  f.advance(449);
  assert.equal(f.requests.length, 0);
  f.advance(1);
  assert.equal(f.requests.length, 1);
});

test('jump to first unread scrolls and focuses the bubble without bypassing visibility or dwell', () => {
  const f = fixture();
  f.c.state.messages.unshift({ id: 'user', role: 'user', status: 'completed' });
  let revealed: string | undefined,
    scrolled: boolean | ScrollIntoViewOptions | undefined,
    focused: FocusOptions | undefined,
    navigated = 0;
  f.c.chatScroll = {
    capture() {},
    restore() {},
    dispose() {},
    navigate(action: () => void) {
      navigated++;
      action();
    },
  };
  f.c.revealMessage = (id) => (revealed = id);
  defined(f.article).scrollIntoView = (options) => (scrolled = options);
  defined(f.article).focus = (options) => (focused = options);
  vm.runInContext(stripTypeScriptTypes(sourceSelectorBinding(source, '[data-first-unread]')), f.c);
  defined(f.document.querySelector<HTMLButtonElement>('[data-first-unread]')).dispatchEvent(
    new f.Event('click'),
  );
  assert.equal(revealed, 'a');
  assert.equal(navigated, 1);
  assert.ok(typeof scrolled === 'object');
  assert.equal(scrolled.block, 'center');
  assert.equal(defined(focused).preventScroll, true);
  assert.equal(defined(f.article).getAttribute('tabindex'), '-1');
  assert.equal(f.requests.length, 0);
  f.advance(450);
  assert.equal(f.requests.length, 1);
});

test('failed read receipts preserve unread state and retry only after another visibility check', async () => {
  const f = fixture();
  f.fail = true;
  f.c.updateRead();
  f.advance(450);
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.c.unreadMessages().length, 1);
  f.c.readVisibility.visible = false;
  f.advance(1000);
  f.advance(500);
  assert.equal(f.requests.length, 1);
  f.fail = false;
  f.c.readVisibility.visible = true;
  f.c.updateRead();
  f.advance(450);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.at(-1), {
    route: '/read',
    body: { ids: ['a'], attachmentSnapshots: { a: [] } },
  });
});

test('new attachments restart the viewport dwell and read receipts contain only the observed attachment revision', () => {
  const f = fixture(),
    first = '10000000-0000-4000-8000-000000000001',
    second = '10000000-0000-4000-8000-000000000002';
  Object.assign(defined(f.c.state.messages[0]), {
    visibleAt: 10,
    visibleAttachmentIds: [],
    attachments: [{ id: first }],
  });
  assert.equal(
    f.c.unreadMessages().length,
    1,
    'new unseen attachments override an older text receipt',
  );
  f.c.updateRead();
  f.advance(300);
  defined(defined(f.c.state.messages[0]).attachments).push({ id: second });
  f.c.updateRead();
  f.advance(449);
  assert.equal(f.requests.length, 0);
  f.advance(1);
  assert.deepEqual(f.requests, [
    { route: '/read', body: { ids: ['a'], attachmentSnapshots: { a: [first, second] } } },
  ]);
});

test('an in-flight receipt cannot prevent a later attachment from receiving its own visibility check', async () => {
  const f = fixture(),
    pending = deferred(),
    first = '10000000-0000-4000-8000-000000000001',
    second = '10000000-0000-4000-8000-000000000002';
  Object.assign(defined(f.c.state.messages[0]), {
    attachments: [{ id: first }],
    visibleAttachmentIds: [],
  });
  f.c.post = (route, body) => {
    f.requests.push({ route, body: structuredClone(body) });
    return pending.promise;
  };
  f.c.updateRead();
  f.advance(450);
  assert.deepEqual(readBody(defined(f.requests[0]).body).attachmentSnapshots, { a: [first] });
  Object.assign(defined(f.c.state.messages[0]), {
    read: false,
    visibleAt: 20,
    visibleAttachmentIds: [first],
    attachments: [{ id: first }, { id: second }],
  });
  f.c.updateRead();
  f.advance(500);
  assert.equal(f.requests.length, 1);
  pending.resolve({ ok: true });
  await settle();
  f.advance(450);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(readBody(defined(f.requests[1]).body).attachmentSnapshots, {
    a: [first, second],
  });
  defined(f.c.state.messages[0]).read = true;
  await settle();
  f.c.updateRead();
});
