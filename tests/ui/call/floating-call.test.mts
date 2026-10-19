import type { OverlayState } from '../../../ui/call/overlay-state.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceIndex, compactCss } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { createFloatingCall } from '../../../ui/call/floating-call.mts';

function rect(value: {
  left: number;
  top: number;
  right: number;
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
function fixture() {
  const { document, Event } = parseHTML(
    '<html><body><main id="app"><section class="conversation"></section></main></body></html>',
  );
  const app = document.querySelector<HTMLElement>('#app'),
    anchor = document.querySelector<HTMLElement>('.conversation'),
    listeners = new Map<string, Set<() => void>>(),
    observers: Observer[] = [];
  const window = {
    document,
    addEventListener(name: string, fn: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      defined(listeners.get(name)).add(fn);
    },
    removeEventListener(name: string, fn: () => void) {
      listeners.get(name)?.delete(fn);
    },
  };
  const geometry = { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 },
    anchorBox = { left: 52, top: 66, right: 650, bottom: 700, width: 598, height: 634 },
    size = { width: 340, height: 68 };
  defined(app).getBoundingClientRect = () => rect(geometry);
  defined(anchor).getBoundingClientRect = () => rect(anchorBox);
  class Observer {
    callback: () => void;
    nodes = new Set<Element>();
    constructor(callback: () => void) {
      this.callback = callback;
      this.nodes = new Set();
      observers.push(this);
    }
    observe(node: Element) {
      this.nodes.add(node);
    }
    disconnect() {
      this.nodes.clear();
    }
  }
  let now = 1000,
    callKey = 'call-a',
    clicks = 0;
  const controller = createFloatingCall({ window, ResizeObserverImpl: Observer, now: () => now });
  function render(mini = true) {
    const template = document.createElement('template');
    template.innerHTML = `<div data-key="call-view" class="call-view ${mini ? 'mini' : ''}"><i class="call-avatar"><img></i><p>In a call</p><span data-call-duration>1:23</span><div class="call-controls"><button data-action="mute"><svg></svg></button><button data-action="hangup"></button><button data-action="call-size"></button></div></div>`;
    reconcile(defined(anchor), template.content);
    const node = Object.assign(defined(defined(anchor).querySelector<HTMLElement>('.call-view')), {
      captured: new Set<number>(),
    });
    defined(node).getBoundingClientRect = () =>
      rect({
        left: parseFloat(defined(node).style.left) || 0,
        top: parseFloat(defined(node).style.top) || 0,
        width: size.width,
        height: size.height,
        right: (parseFloat(defined(node).style.left) || 0) + size.width,
        bottom: (parseFloat(defined(node).style.top) || 0) + size.height,
      });
    const captured = node.captured;
    defined(node).setPointerCapture = (id) => captured.add(id);
    defined(node).hasPointerCapture = (id) => captured.has(id);
    defined(node).releasePointerCapture = (id) => captured.delete(id);
    defined(node).captured = captured;
    controller.sync(mini ? node : null, { callKey, bounds: app, anchor });
    return node;
  }
  const node = render();
  defined(node).addEventListener('click', () => clicks++);
  function event(target: EventTarget | null, type: string, values: Partial<PointerEvent> = {}) {
    const value = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(value, {
      pointerId: 7,
      button: 0,
      isPrimary: true,
      clientX: 400,
      clientY: 100,
      ...values,
    });
    defined(target).dispatchEvent(value);
    return value;
  }
  function drag(target: EventTarget | null = node, dx = 100, dy = 100) {
    event(target, 'pointerdown');
    event(document, 'pointermove', { clientX: 400 + dx, clientY: 100 + dy });
    event(document, 'pointerup', { clientX: 400 + dx, clientY: 100 + dy });
  }
  return {
    document,
    window,
    node,
    app,
    anchor,
    geometry,
    anchorBox,
    size,
    controller,
    observers,
    listeners,
    event,
    drag,
    render,
    get clicks() {
      return clicks;
    },
    newCall(key: string) {
      callKey = key;
    },
    advance(ms: number) {
      now += ms;
    },
    windowEvent(name: string) {
      for (const fn of [...(listeners.get(name) || [])]) fn();
    },
  };
}
const location = (node: HTMLElement) => ({
  x: parseFloat(node.style.left),
  y: parseFloat(node.style.top),
});

test('floating call drags by avatar, status or empty space across both app panes', () => {
  const f = fixture();
  assert.deepEqual(location(f.node), { x: 294, y: 82 });
  f.drag(defined(f.node).querySelector<HTMLImageElement>('.call-avatar img'), 450, 200);
  assert.deepEqual(location(f.node), { x: 652, y: 282 });
  assert.ok(
    location(f.node).x > f.anchorBox.right - f.size.width,
    'the computer pane is inside the permitted app area',
  );
  f.drag(defined(f.node).querySelector<HTMLElement>('p'), -100, -90);
  assert.deepEqual(location(f.node), { x: 552, y: 192 });
  f.drag(f.node, 0, 70);
  assert.deepEqual(location(f.node), { x: 552, y: 262 });
  assert.equal(defined(f.node).captured.size, 0);
  assert.equal(defined(f.node).hasAttribute('data-call-dragging'), false);
  f.controller.dispose();
});

test('mini call controls, media elements, links and editable targets never start a drag', () => {
  const f = fixture(),
    before = location(f.node);
  defined(f.node).insertAdjacentHTML(
    'beforeend',
    '<a href="#">Link</a><audio controls></audio><input><div contenteditable="true"><span>Edit</span></div>',
  );
  for (const target of defined(f.node).querySelectorAll(
    'button,button svg,a,audio,input,[contenteditable] span',
  )) {
    f.drag(target);
    assert.deepEqual(location(f.node), before);
    assert.equal(defined(f.node).captured.size, 0);
  }
  f.event(f.node, 'pointerdown', { button: 2 });
  f.event(f.document, 'pointermove', { clientX: 900 });
  assert.deepEqual(location(f.node), before);
  f.event(f.node, 'pointerdown', { isPrimary: false });
  f.event(f.document, 'pointermove', { clientX: 900 });
  assert.deepEqual(location(f.node), before);
  f.controller.dispose();
});

test('the bar keeps its position through keyed state updates, duration ticks, full view and page return', () => {
  const f = fixture();
  f.drag(f.node, 120, 130);
  const moved = location(f.node),
    avatar = defined(f.node).querySelector<HTMLElement>('.call-avatar'),
    mute = defined(f.node).querySelector<HTMLButtonElement>('[data-action="mute"]');
  defined(defined(f.node).querySelector<HTMLButtonElement>('[data-call-duration]')).textContent =
    '1:24';
  assert.deepEqual(location(f.node), moved);
  for (let i = 0; i < 3; i++) {
    assert.equal(f.render(), f.node);
    assert.deepEqual(location(f.node), moved);
  }
  assert.equal(defined(f.node).querySelector<HTMLElement>('.call-avatar'), avatar);
  assert.equal(defined(f.node).querySelector<HTMLButtonElement>('[data-action="mute"]'), mute);
  f.render(false);
  assert.equal(
    defined(f.node).getAttribute('style'),
    null,
    'the full call keeps its existing CSS geometry',
  );
  f.render(true);
  assert.deepEqual(location(f.node), moved);
  f.controller.sync(null, { callKey: 'call-a', bounds: f.app, anchor: f.anchor });
  defined(f.node).remove();
  const restored = f.render(true);
  assert.deepEqual(location(restored), moved);
  f.controller.dispose();
});

test('bounds and bar size changes clamp every edge; a new call resets the previous position', () => {
  const f = fixture();
  f.drag(f.node, -2000, -1000);
  assert.deepEqual(location(f.node), { x: 8, y: 8 });
  f.drag(f.node, 4000, 3000);
  assert.deepEqual(location(f.node), { x: 652, y: 624 });
  Object.assign(f.geometry, { right: 600, bottom: 400, width: 600, height: 400 });
  f.windowEvent('resize');
  assert.deepEqual(location(f.node), { x: 252, y: 324 });
  f.size.height = 100;
  defined(f.observers[0]).callback();
  assert.deepEqual(location(f.node), { x: 252, y: 292 });
  f.anchorBox.right = 480;
  f.anchorBox.width = 428;
  f.newCall('call-b');
  f.render();
  assert.deepEqual(location(f.node), { x: 124, y: 82 });
  f.controller.dispose();
});

test('capture survives a render mid-gesture, ignores other pointers and cleans up on cancel or blur', () => {
  const f = fixture();
  f.event(defined(f.node).querySelector<HTMLElement>('p'), 'pointerdown');
  assert.equal(defined(f.node).captured.has(7), true);
  f.event(f.document, 'pointermove', { pointerId: 8, clientX: 800 });
  assert.deepEqual(location(f.node), { x: 294, y: 82 });
  f.event(f.document, 'pointermove', { clientX: 450, clientY: 150 });
  assert.equal(defined(f.node).hasAttribute('data-call-dragging'), true);
  f.render();
  assert.equal(defined(f.node).hasAttribute('data-call-dragging'), true);
  f.event(f.document, 'pointermove', { clientX: 500, clientY: 180 });
  assert.deepEqual(location(f.node), { x: 394, y: 162 });
  f.event(f.document, 'pointercancel');
  assert.equal(defined(f.node).hasAttribute('data-call-dragging'), false);
  const after = location(f.node);
  f.event(f.document, 'pointermove', { clientX: 800, clientY: 500 });
  assert.deepEqual(location(f.node), after);
  f.event(f.node, 'pointerdown');
  f.event(f.document, 'pointermove', { clientX: 450, clientY: 150 });
  f.windowEvent('blur');
  assert.equal(defined(f.node).hasAttribute('data-call-dragging'), false);
  f.controller.dispose();
});

test('drag release suppresses its click without blocking a later control click or keyboard activation', () => {
  const f = fixture();
  f.drag();
  const click = f.event(f.node, 'click', { detail: 1 });
  assert.equal(click.defaultPrevented, true);
  assert.equal(f.clicks, 0);
  const mute = defined(f.node).querySelector<HTMLButtonElement>('[data-action="mute"]');
  let muted = 0;
  defined(mute).addEventListener('click', () => muted++);
  f.event(mute, 'pointerdown');
  f.event(mute, 'pointerup');
  f.event(mute, 'click', { detail: 1 });
  assert.equal(muted, 1);
  f.drag();
  f.event(mute, 'click', { detail: 0 });
  assert.equal(muted, 2, 'keyboard-generated clicks stay accessible');
  f.advance(501);
  f.event(f.node, 'click', { detail: 1 });
  assert.ok(f.clicks > 0);
  f.controller.dispose();
});

test('short clicks do not move the call and dispose removes all movement ownership', () => {
  const f = fixture(),
    before = location(f.node);
  f.event(f.node, 'pointerdown');
  f.event(f.document, 'pointermove', { clientX: 402, clientY: 101 });
  f.event(f.document, 'pointerup');
  f.event(f.node, 'click', { detail: 1 });
  assert.deepEqual(location(f.node), before);
  assert.equal(f.clicks, 1);
  f.event(f.node, 'pointerdown');
  f.controller.dispose();
  f.event(f.document, 'pointermove', { clientX: 800 });
  assert.deepEqual(location(f.node), before);
  assert.equal(defined(f.node).captured.size, 0);
  assert.ok([...f.listeners.values()].every((set) => set.size === 0));
  assert.equal(defined(f.observers[0]).nodes.size, 0);
  f.render();
  f.drag();
  assert.equal(
    defined(f.node).getAttribute('style'),
    null,
    'a disposed controller cannot reclaim the view',
  );
});

test('main render reapplies the controller after DOM reconciliation and fixed styling covers the app', () => {
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
    css = compactCss(fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'));
  assert.match(
    source,
    /import\s*\{\s*createFloatingCall\s*\}\s*from\s*['"]\.\/call\/floating-call\.mts['"]/,
  );
  const render = source.slice(
    sourceIndex(source, 'function render(){'),
    sourceIndex(source, 'function renderRail(){'),
  );
  assert.match(render, /reconcile\(app,\s*template\.content\)/);
  assert.ok(
    render.indexOf('floatingCall.sync') > render.indexOf('resizeComposer()'),
    'floating call geometry is rebound after DOM and composer layout',
  );
  assert.match(
    css,
    /\.call-view\.mini\{position:fixed;z-index:20;cursor:grab;touch-action:none;user-select:none\}/,
  );
  assert.match(css, /\.call-view\.mini\[data-call-dragging\]\{cursor:grabbing\}/);
});

function parentOverlay() {
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
    start = sourceIndex(source, 'function publishCallOverlay(){'),
    end = sourceIndex(source, 'function renderUnconfirmedMessage(){', start),
    updates: (OverlayState | null)[] = [],
    actions: string[] = [];
  const state = {
    call: { id: 'call-a', connectedAt: 1000 } as { id: string; connectedAt: number } | null,
    settings: { language: 'en' },
    messages: [{ text: 'private conversation' }],
    memory: 'private memory',
  };
  const context = uiEntrypointFixture({
    state,
    callId: 'call-a' as string | null,
    pc: { connectionState: 'connected' } as { connectionState: string } | null,
    callStarting: false,
    callConnected: true,
    callChannel: { readyState: 'open' },
    callStops: { pending: false },
    callDuration: { snapshot: { callId: 'call-a', seconds: 12, confirmed: true, running: true } },
    callMuted: false,
    stream: {
      getTracks() {
        throw Error('Overlay must not own media');
      },
    } as { getTracks?: () => never } | null,
    document: { documentElement: { dataset: { theme: 'dark' } } },
    language: () => state.settings.language,
    unloading: false,
    nativeCallOverlay: {
      update: (value: OverlayState | null) => updates.push(structuredClone(value)),
    },
    action: async (value: string) => {
      actions.push(value);
      if (value === 'mute') context.callMuted = !context.callMuted;
    },
  });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
  return { context, updates, actions };
}

test('native overlay publication contains only call display state and stops when the call ends', () => {
  const f = parentOverlay();
  f.context.publishCallOverlay();
  assert.deepEqual(f.updates.at(-1), {
    callId: 'call-a',
    status: 'talking',
    connectedAt: 1000,
    seconds: 12,
    confirmed: true,
    running: true,
    muted: false,
    canMute: true,
    language: 'en',
    theme: 'dark',
  });
  f.context.callMuted = true;
  f.context.state.settings.language = 'zh';
  f.context.document.documentElement.dataset.theme = 'light';
  f.context.callDuration.snapshot.seconds = 13;
  f.context.publishCallOverlay();
  assert.equal(defined(f.updates.at(-1)).muted, true);
  assert.equal(defined(f.updates.at(-1)).language, 'zh');
  assert.equal(defined(f.updates.at(-1)).theme, 'light');
  assert.equal(defined(f.updates.at(-1)).seconds, 13);
  f.context.pc = null;
  f.context.stream = null;
  f.context.callDuration.snapshot.running = false;
  f.context.publishCallOverlay();
  assert.equal(defined(f.updates.at(-1)).status, 'recovering');
  assert.equal(defined(f.updates.at(-1)).canMute, false);
  assert.equal(defined(f.updates.at(-1)).running, false);
  f.context.callId = null;
  f.context.state.call = null;
  f.context.publishCallOverlay();
  assert.equal(f.updates.at(-1), null);
  f.context.callStops.pending = true;
  f.context.publishCallOverlay();
  assert.equal(defined(f.updates.at(-1)).callId, 'call-a');
  assert.equal(defined(f.updates.at(-1)).status, 'stopping');
  assert.equal(defined(f.updates.at(-1)).canMute, false);
  assert.doesNotMatch(JSON.stringify(f.updates), /private conversation|private memory/);
  assert.deepEqual(f.actions, []);
});

test('native overlay actions target the current parent call and reuse its existing controls', async () => {
  const f = parentOverlay(),
    handle = f.context.handleNativeCallAction;
  await handle({ callId: 'old-call', action: 'hangup' });
  await handle({ callId: 'call-a', action: 'unknown' });
  assert.deepEqual(f.actions, []);
  await handle({ callId: 'call-a', action: 'mute', muted: true });
  await handle({ callId: 'call-a', action: 'mute', muted: true });
  await handle({ callId: 'call-a', action: 'mute' });
  await handle({ callId: 'call-a', action: 'hangup' });
  assert.deepEqual(f.actions, ['mute', 'hangup']);
  await handle({ callId: 'call-a', action: 'restore' });
  assert.deepEqual(
    f.actions,
    ['mute', 'hangup'],
    'native restoration must not toggle call size or recreate media',
  );
  f.context.stream = null;
  await handle({ callId: 'call-a', action: 'mute', muted: false });
  f.context.stream = {};
  f.context.callStops.pending = true;
  await handle({ callId: 'call-a', action: 'mute', muted: false });
  assert.deepEqual(f.actions, ['mute', 'hangup']);
  f.context.unloading = true;
  await handle({ callId: 'call-a', action: 'hangup' });
  assert.deepEqual(f.actions, ['mute', 'hangup']);
});

test('native mute actions set the desired state without replaying a stale toggle', async () => {
  const f = parentOverlay(),
    handle = f.context.handleNativeCallAction;
  await handle({ callId: 'call-a', action: 'mute', muted: true });
  await handle({ callId: 'call-a', action: 'mute', muted: true });
  assert.equal(f.context.callMuted, true);
  assert.deepEqual(f.actions, ['mute']);
  await handle({ callId: 'call-a', action: 'mute', muted: false });
  await handle({ callId: 'call-a', action: 'mute', muted: false });
  assert.equal(f.context.callMuted, false);
  assert.deepEqual(f.actions, ['mute', 'mute']);
});
