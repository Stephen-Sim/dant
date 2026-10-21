import type { CoreModule, Interval } from '../../ui/shared/contracts.mts';
import type { OverlayAction } from '../../ui/call/overlay-state.mts';
import { deferred, observedRecord } from '../support/service-fixtures.mts';
interface NativeInvocation {
  command: string;
  args: Record<string, unknown> | undefined;
}
interface ParentOptions {
  invoke?: (command: string, args?: Record<string, unknown>) => unknown;
  action?: (action: OverlayAction) => unknown;
}
interface ChildOptions {
  state?: unknown;
  invoke?: ParentOptions['invoke'];
}
import { defined } from '../support/fixture-assertions.mts';
import { languageInfo } from '../../ui/i18n/languages.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { createNativeCallOverlay } from '../../ui/platform/native-call-overlay.mts';
import { mountCallOverlay } from '../../ui/call/call-overlay.mts';

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
const call = (values: Record<string, unknown> = {}) => ({
  callId: 'call-a',
  status: 'talking',
  connectedAt: 90000,
  seconds: 10,
  confirmed: true,
  running: true,
  muted: false,
  canMute: true,
  language: 'en',
  theme: 'light',
  ...values,
});
const fakeWindow = () => {
  const listeners = new Map<string, () => void>();
  return {
    listeners,
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string, fn: () => void) => {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
  };
};
function parentFixture(options: ParentOptions = {}) {
  const { document } = parseHTML('<html data-theme="light"><body></body></html>'),
    window = fakeWindow(),
    calls: NativeInvocation[] = [],
    actions: OverlayAction[] = [],
    errors: string[] = [],
    observers: Observer[] = [];
  let receive: ((event: { payload: unknown }) => unknown) | undefined,
    stops = 0;
  class Observer {
    fn: () => void;
    node?: Node;
    config?: MutationObserverInit;
    disconnected = false;
    constructor(fn: () => void) {
      this.fn = fn;
      observers.push(this);
    }
    observe(node: Node, config: MutationObserverInit) {
      this.node = node;
      this.config = config;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const core: CoreModule = {
    invoke: async (command, args) => {
      calls.push({ command, args });
      return options.invoke?.(command, args);
    },
  };
  const bridge = createNativeCallOverlay({
    desktop: true,
    document,
    window,
    MutationObserver: Observer,
    loadCore: async () => core,
    loadEvents: async () => ({
      listen: async (name, fn) => {
        assert.equal(name, 'dant-call-overlay-action');
        receive = fn;
        return () => stops++;
      },
    }),
    onAction: async (value) => {
      actions.push(value);
      await options.action?.(value);
    },
    onError: (error) => errors.push(error.message),
    ...options,
  });
  return {
    bridge,
    document,
    window,
    calls,
    actions,
    errors,
    observers,
    get stops() {
      return stops;
    },
    async event(payload: unknown) {
      await defined(receive)({ payload });
    },
    receive: () => receive,
  };
}
function childFixture(options: ChildOptions = {}) {
  const html = fs.readFileSync(new URL('../../ui/call-overlay.html', import.meta.url), 'utf8'),
    { document } = parseHTML(html),
    window = fakeWindow(),
    calls: NativeInvocation[] = [],
    timers = new Map<Interval, () => void>();
  let receive: ((event: { payload: unknown }) => void) | undefined,
    stops = 0,
    time = 100000,
    requestId = 0;
  const ready = mountCallOverlay({
    document,
    window,
    loadCore: async () => ({
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (options.invoke) return options.invoke(command, args);
        if (command === 'call_overlay_get')
          return options.state === undefined ? call() : options.state;
      },
    }),
    loadEvents: async () => ({
      listen: async (name, fn) => {
        assert.equal(name, 'dant-call-overlay-state');
        receive = fn;
        return () => stops++;
      },
    }),
    now: () => time,
    schedule: (fn, ms) => {
      assert.equal(ms, 1000);
      timers.set(1, fn);
      return 1;
    },
    cancel: (id) => timers.delete(id),
    randomId: () => `request-${++requestId}`,
  });
  return {
    ready,
    document,
    window,
    calls,
    timers,
    get stops() {
      return stops;
    },
    event(value: unknown) {
      defined(receive)({ payload: value });
    },
    advance(ms: number) {
      time += ms;
      for (const tick of timers.values()) tick();
    },
    click: (id: string) => {
      const node = defined(document.querySelector<HTMLElement>(id));
      const result: unknown = Reflect.apply(defined(node.onclick), node, [new Event('click')]);
      return result;
    },
    root: document.querySelector<HTMLElement>('#call-overlay'),
  };
}

test('browser mode is inert and desktop snapshots contain call metadata only', async () => {
  let loads = 0;
  const browser = createNativeCallOverlay({
    loadCore: async () => {
      loads++;
      throw Error('Browser mode must not load native APIs.');
    },
    loadEvents: async () => {
      loads++;
      throw Error('Browser mode must not load native APIs.');
    },
  });
  browser.update(call());
  browser.dispose();
  assert.equal(loads, 0);
  const f = parentFixture();
  f.bridge.update({ ...call(), token: 'secret', transcript: 'private words', audio: 'bytes' });
  await settle();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { command: 'call_overlay_update', args: { state: call() } });
  assert.doesNotMatch(JSON.stringify(f.calls), /secret|private words|audio/);
  f.bridge.update(call());
  await settle();
  assert.equal(f.calls.length, 1);
  f.bridge.dispose();
  await settle();
  assert.equal(defined(defined(f.calls.at(-1)).args).state, null);
  assert.equal(f.stops, 1);
});

test('latest call ownership, allowed actions, desired mute state and request IDs guard parent actions', async () => {
  const f = parentFixture();
  f.bridge.update(call());
  await settle();
  for (const value of [
    null,
    { callId: 'old', action: 'hangup', requestId: 'a' },
    { callId: 'call-a', action: 'exec', requestId: 'b' },
    { callId: 'call-a', action: 'hide', requestId: 'hide-only-native' },
    { callId: 'call-a', action: 'mute', requestId: 'c' },
    { callId: 'call-a', action: 'mute', requestId: 'd', muted: false },
    { callId: 'call-a', action: 'hangup', requestId: 'bad\nID' },
  ])
    await f.event(value);
  assert.equal(f.actions.length, 0);
  const request = { callId: 'call-a', action: 'mute', requestId: 'mute-1', muted: true };
  await f.event(request);
  await f.event(request);
  assert.deepEqual(f.actions, [{ callId: 'call-a', action: 'mute', muted: true }]);
  await f.event({ callId: 'call-a', action: 'restore', requestId: 'restore-1' });
  assert.equal(defined(f.actions.at(-1)).action, 'restore');
  f.bridge.update(call({ callId: 'call-b', canMute: false }));
  await f.event({ callId: 'call-a', action: 'hangup', requestId: 'late' });
  await f.event({ callId: 'call-b', action: 'mute', requestId: 'mute-b', muted: true });
  assert.equal(f.actions.length, 2);
  f.bridge.dispose();
  await f.event({ callId: 'call-b', action: 'hangup', requestId: 'ended' });
  assert.equal(f.actions.length, 2);
});

test('inflight metadata coalesces updates, ends a call after a failed earlier state, and clears after disposal', async () => {
  const wait = deferred(),
    f = parentFixture({
      invoke: (_command, args) =>
        args?.state && observedRecord(args.state).seconds === 10 ? wait.promise : undefined,
    });
  f.bridge.update(call());
  await settle();
  f.bridge.update(null);
  wait.reject(Error('Private native failure'));
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(defined(defined(f.calls.at(-1)).args).state, null);
  assert.deepEqual(f.errors, ['The floating call window is unavailable.']);
  f.bridge.dispose();
  await settle();
  const pending = deferred(),
    g = parentFixture({ invoke: (_command, args) => (args?.state ? pending.promise : undefined) });
  g.bridge.update(call());
  await settle();
  g.bridge.dispose();
  await settle();
  assert.equal(g.calls.length, 1, 'clear must follow the already submitted snapshot');
  pending.resolve();
  await settle();
  assert.equal(defined(defined(g.calls.at(-1)).args).state, null);
  assert.equal(g.stops, 1);
});

test('theme changes and unload synchronize only metadata and release listeners', async () => {
  const f = parentFixture();
  f.bridge.update(call());
  await settle();
  f.document.documentElement.dataset.theme = 'dark';
  defined(f.observers[0]).fn();
  await settle();
  assert.equal(observedRecord(defined(defined(f.calls.at(-1)).args).state).theme, 'dark');
  assert.deepEqual(defined(f.observers[0]).config, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  f.document.documentElement.dataset.theme = 'invalid';
  defined(f.observers[0]).fn();
  await settle();
  assert.equal(f.calls.length, 2);
  defined(f.window.listeners.get('beforeunload'))();
  await settle();
  assert.equal(defined(f.observers[0]).disconnected, true);
  assert.equal(f.window.listeners.size, 0);
  assert.equal(defined(defined(f.calls.at(-1)).args).state, null);
  f.bridge.dispose();
});

test('invalid metadata hides the overlay and parent action errors never leak details', async () => {
  const f = parentFixture({
    action: () => {
      throw Error('Private error');
    },
  });
  f.bridge.update(call());
  await settle();
  await f.event({ callId: 'call-a', action: 'hangup', requestId: 'hangup' });
  assert.deepEqual(f.errors, ['The floating call window is unavailable.']);
  f.bridge.update(call({ callId: 'bad\nID' }));
  await settle();
  assert.equal(defined(defined(f.calls.at(-1)).args).state, null);
  f.bridge.update(call({ status: 'private message' }));
  await settle();
  f.bridge.dispose();
});

test('child renders bilingual metadata and elapsed duration without opening audio or network channels', async () => {
  for (const language of ['en', 'zh']) {
    const f = childFixture({ state: call({ language, theme: 'dark' }) }),
      dispose = await f.ready;
    assert.equal(defined(f.root).hidden, false);
    assert.equal(f.document.documentElement.lang, languageInfo(language).locale);
    assert.equal(f.document.documentElement.dataset.theme, 'dark');
    assert.equal(
      defined(f.document.querySelector('#call-status')).textContent,
      language === 'en' ? 'In a call' : '正在通话',
    );
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('#call-duration')).textContent,
      '0:10',
    );
    f.advance(2500);
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('#call-duration')).textContent,
      '0:13',
    );
    assert.ok(
      defined(f.document.querySelector<HTMLButtonElement>('#call-mute')).getAttribute('aria-label'),
    );
    assert.equal(f.calls.length, 1);
    f.event(
      call({ language, status: 'recovering', confirmed: false, running: false, canMute: false }),
    );
    assert.equal(defined(f.document.querySelector<HTMLElement>('#call-duration')).hidden, true);
    assert.equal(defined(f.document.querySelector<HTMLButtonElement>('#call-mute')).hidden, true);
    f.event(null);
    assert.equal(defined(f.root).hidden, true);
    await f.click('#call-hangup');
    assert.equal(f.calls.length, 1);
    dispose();
    assert.equal(f.timers.size, 0);
    assert.equal(f.stops, 1);
  }
});

test('child uses idempotent desired mute and clock-only updates cannot unlock pending actions', async () => {
  const f = childFixture(),
    dispose = await f.ready;
  await f.click('#call-mute');
  const request = f.calls.at(-1);
  assert.deepEqual(request, {
    command: 'call_overlay_action',
    args: { callId: 'call-a', action: 'mute', requestId: 'request-1', muted: true },
  });
  assert.equal(defined(f.document.querySelector<HTMLButtonElement>('#call-mute')).disabled, true);
  f.event(call({ seconds: 11 }));
  assert.equal(defined(f.document.querySelector<HTMLButtonElement>('#call-mute')).disabled, true);
  await f.click('#call-mute');
  assert.equal(f.calls.length, 2);
  f.event(call({ muted: true, seconds: 12 }));
  assert.equal(defined(f.document.querySelector<HTMLButtonElement>('#call-mute')).disabled, false);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('#call-mute')).getAttribute('aria-pressed'),
    'true',
  );
  await f.click('#call-mute');
  assert.equal(defined(defined(f.calls.at(-1)).args).muted, false);
  f.event(call({ muted: false }));
  await f.click('#call-hangup');
  f.event(call({ seconds: 15 }));
  await f.click('#call-hangup');
  assert.equal(f.calls.filter((call) => call.args?.action === 'hangup').length, 1);
  await f.click('#call-restore');
  assert.equal(defined(defined(f.calls.at(-1)).args).action, 'restore');
  dispose();
});

test('child native dragging ignores controls and only starts from its background', async () => {
  const f = childFixture(),
    dispose = await f.ready;
  let prevented = 0;
  const event = (button: number, target: EventTarget | null) => ({
    button,
    target,
    preventDefault() {
      prevented++;
    },
  });
  Reflect.apply(defined(defined(f.root).onpointerdown), f.root, [event(2, f.root)]);
  Reflect.apply(defined(defined(f.root).onpointerdown), f.root, [
    event(0, f.document.querySelector('#call-mute svg')),
  ]);
  assert.equal(f.calls.length, 1);
  Reflect.apply(defined(defined(f.root).onpointerdown), f.root, [
    event(0, f.document.querySelector('.call-details')),
  ]);
  await settle();
  assert.equal(defined(f.calls.at(-1)).command, 'call_overlay_drag');
  assert.equal(prevented, 1);
  dispose();
  assert.equal(defined(f.root).onpointerdown, null);
  assert.equal(defined(f.document.querySelector<HTMLButtonElement>('#call-mute')).onclick, null);
});

test('hide uses a call-scoped native visibility action with localized controls and leaves pending media actions alone', async () => {
  for (const language of ['en', 'zh']) {
    const f = childFixture({ state: call({ language }) }),
      dispose = await f.ready,
      hide = f.document.querySelector<HTMLButtonElement>('#call-hide');
    assert.equal(defined(hide).title, language === 'en' ? 'Hide call window' : '隐藏通话窗口');
    assert.equal(defined(hide).getAttribute('aria-label'), defined(hide).title);
    await f.click('#call-mute');
    assert.equal(defined(f.document.querySelector<HTMLButtonElement>('#call-mute')).disabled, true);
    await f.click('#call-hide');
    assert.deepEqual(f.calls.at(-1), {
      command: 'call_overlay_action',
      args: { callId: 'call-a', action: 'hide', requestId: 'request-2' },
    });
    f.event(call({ language, seconds: 12 }));
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('#call-mute')).disabled,
      true,
      'hiding must not acknowledge an unfinished microphone action',
    );
    assert.equal(f.calls.filter((value) => value.args?.action === 'hangup').length, 0);
    assert.equal(f.timers.size, 1, 'the call duration clock remains active');
    f.event(null);
    await f.click('#call-hide');
    assert.equal(f.calls.length, 3);
    dispose();
    assert.equal(defined(hide).onclick, null);
  }
});

test('late hide failure cannot alter a different call and a current failure stays localized', async () => {
  const wait = deferred(),
    f = childFixture({
      state: call({ language: 'zh' }),
      invoke: (command) =>
        command === 'call_overlay_get' ? call({ language: 'zh' }) : wait.promise,
    }),
    dispose = await f.ready;
  const hiding = f.click('#call-hide');
  f.event(call({ callId: 'call-b' }));
  wait.reject(Error('Private native error'));
  await hiding;
  assert.equal(defined(f.document.querySelector('#call-status')).textContent, 'In a call');
  dispose();
  const g = childFixture({
      invoke: (command) => {
        if (command === 'call_overlay_get') return call({ language: 'zh' });
        throw Error('Private native error');
      },
    }),
    stop = await g.ready;
  await g.click('#call-hide');
  assert.equal(
    defined(g.document.querySelector('#call-status')).textContent,
    '操作未确认，请返回 dant。',
  );
  stop();
});

test('initial read success or rejection cannot replace a newer call-state event', async () => {
  for (const reject of [false, true]) {
    const wait = deferred<unknown>(),
      f = childFixture({
        invoke: (command) => (command === 'call_overlay_get' ? wait.promise : undefined),
      });
    await settle();
    f.event(call({ callId: 'new-call', language: 'zh' }));
    if (reject) wait.reject(Error('Private failure'));
    else wait.resolve(call({ callId: 'old-call' }));
    const dispose = await f.ready;
    assert.equal(f.document.documentElement.lang, 'zh-CN');
    assert.equal(defined(f.root).hidden, false);
    dispose();
  }
});

test('child action failures stay localized and a changed call discards stale failure responses', async () => {
  const wait = deferred(),
    f = childFixture({
      invoke: (command) =>
        command === 'call_overlay_get' ? call({ language: 'zh' }) : wait.promise,
    }),
    dispose = await f.ready;
  const action = f.click('#call-hangup');
  wait.reject(Error('Private failure'));
  await action;
  assert.equal(
    defined(f.document.querySelector('#call-status')).textContent,
    '操作未确认，请返回 dant。',
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('#call-hangup')).disabled,
    false,
  );
  dispose();
  const late = deferred(),
    g = childFixture({
      invoke: (command) => (command === 'call_overlay_get' ? call() : late.promise),
    }),
    stop = await g.ready;
  const request = g.click('#call-mute');
  g.event(call({ callId: 'new-call' }));
  late.reject(Error('Old action'));
  await request;
  assert.equal(defined(g.document.querySelector('#call-status')).textContent, 'In a call');
  stop();
});

test('child asset capabilities and CSP exclude general APIs, external pages, speech and media', () => {
  const html = fs.readFileSync(new URL('../../ui/call-overlay.html', import.meta.url), 'utf8'),
    js = fs.readFileSync(new URL('../../ui/call/call-overlay.mts', import.meta.url), 'utf8'),
    rust = fs.readFileSync(new URL('../../src-tauri/src/call_overlay.rs', import.meta.url), 'utf8'),
    main = fs.readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8'),
    cap = observedRecord(
      JSON.parse(
        fs.readFileSync(
          new URL('../../src-tauri/capabilities/call-overlay.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  assert.deepEqual(cap.windows, ['call-overlay']);
  assert.deepEqual(cap.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten']);
  assert.match(html, /connect-src ipc: http:\/\/ipc\.localhost;/);
  assert.doesNotMatch(html, /127\.0\.0\.1|https:|wss:|<audio|<video/);
  assert.match(html, /media-src 'none'/);
  assert.doesNotMatch(
    js,
    /getUserMedia|RTCPeerConnection|fetch\(|api_request|speech_start|Audio\(/,
  );
  assert.match(rust, /WebviewUrl::App\("call-overlay\.html"\.into\(\)\)/);
  assert.match(rust, /always_on_top\(true\)\s*\.skip_taskbar\(true\)/);
  assert.match(rust, /visible\(false\)\s*\.focused\(false\)/);
  assert.match(rust, /work_area\(\)/);
  const setup = main.slice(main.indexOf('fn application_setup'), main.indexOf('fn native_setup')),
    controller = main.slice(
      main.indexOf('fn configure_controller'),
      main.indexOf('struct StartupDirectories'),
    ),
    overlaySetup = setup.indexOf('call_overlay::setup(app)'),
    configureController = setup.indexOf('configure_controller('),
    existingController = controller.indexOf('(effects.existing)(context.source)?'),
    startController = controller.indexOf('(effects.start)(');
  assert.ok(overlaySetup >= 0);
  assert.ok(configureController > overlaySetup);
  assert.ok(existingController >= 0);
  assert.ok(startController > existingController);
  assert.match(
    main,
    /existing:\s*\|source: &str\| transport::ControllerLink::default\(\)\.existing\(source\)/,
  );
});
