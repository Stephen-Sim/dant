import { searchMessages } from '../../../ui/chat/chat-search.mts';
import type { Timer } from '../../../ui/shared/contracts.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { sourceIndex } from '../../support/source-fixtures.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { createChatScroll } from '../../../ui/chat/chat-scroll.mts';
import { reconcile } from '../../../ui/shared/dom.mts';
import { createChatHistory } from '../../../ui/chat/chat-history.mts';

function rect(top: number, bottom: number, width = 400): DOMRect {
  return {
    top,
    bottom,
    width,
    height: bottom - top,
    x: 0,
    y: top,
    left: 0,
    right: width,
    toJSON() {
      return { top, bottom, width, height: bottom - top };
    },
  };
}
function fixture({ observer = true } = {}) {
  const { document, Event } = parseHTML(
      '<main><div id="messages"><div class="message-column"><article data-id="a"></article><article data-id="b"></article><div data-id="call"></div><article data-id="d"></article><article data-id="e"></article></div></div><button data-search-message="a">Find</button></main>',
    ),
    window = document.createElement('aside'),
    viewport = defined(document.querySelector<HTMLElement>('#messages')),
    observers: Observer[] = [],
    timers = new Map<Timer, () => void>();
  let width = 400,
    height = 500,
    total = 1600,
    top = 0,
    positions = [0, 300, 650, 950, 1300],
    scope = 'vm-a/thread-a',
    timerId = 0,
    writes = 0;
  Object.defineProperties(viewport, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
    scrollHeight: { get: () => total },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        writes++;
        top = Math.max(0, Math.min(total - height, value));
      },
    },
  });
  defined(viewport).getBoundingClientRect = () => rect(100, 100 + height, width);
  function geometry() {
    for (const [index, node] of [
      ...defined(document.querySelector<HTMLElement>('.message-column')).children,
    ].entries())
      node.getBoundingClientRect = () =>
        rect(
          100 + defined(positions[index]) - top,
          100 + (positions[index + 1] ?? total) - top,
          width,
        );
  }
  geometry();
  class Observer {
    callback: () => void;
    targets: Element[] = [];
    disconnected = false;
    constructor(callback: () => void) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const scroll = createChatScroll({
    document,
    window,
    getScope: () => scope,
    ResizeObserver: observer ? Observer : null,
    schedule: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    cancel: (id) => id !== undefined && timers.delete(id),
  });
  scroll.restore();
  return {
    document,
    viewport,
    Event,
    window,
    scroll,
    observers,
    timers,
    get writes() {
      return writes;
    },
    get top() {
      return top;
    },
    offset(id: string) {
      return (
        defined(
          [...defined(document.querySelector<HTMLElement>('.message-column')).children]
            .find((node) => node.getAttribute('data-id') === id)
            ?.getBoundingClientRect(),
        ).top - 100
      );
    },
    resize(values: { width?: number; height?: number; total?: number; positions?: number[] }) {
      ({ width = width, height = height, total = total, positions = positions } = values);
    },
    notify() {
      observers.at(-1)?.callback();
    },
    settle() {
      for (const [id, fn] of [...timers]) {
        id !== undefined && timers.delete(id);
        fn();
      }
    },
    userScroll(value: number) {
      defined(viewport).dispatchEvent(new Event('wheel'));
      defined(viewport).scrollTop = value;
      defined(viewport).dispatchEvent(new Event('scroll'));
      this.settle();
    },
    scope(value: string) {
      scope = value;
    },
    patch() {
      const next = document.createElement('div');
      next.innerHTML =
        '<div class="message-column"><article data-id="a"></article><article data-id="b"></article><div data-id="call"></div><article data-id="d"></article><article data-id="e"></article></div>';
      reconcile(defined(viewport), next);
      geometry();
    },
    prepend(ids: string[], rowHeight: number) {
      scroll.capture();
      const addedHeight = ids.length * rowHeight,
        column = defined(document.querySelector<HTMLElement>('.message-column'));
      positions = [
        ...ids.map((_, index) => index * rowHeight),
        ...positions.map((value) => value + addedHeight),
      ];
      total += addedHeight;
      for (const id of [...ids].reverse()) {
        const node = document.createElement('article');
        node.dataset.id = id;
        column.prepend(node);
      }
      geometry();
      scroll.restore();
    },
  };
}

test('opening and closing Computer retains actual bottom through immediate and later decoded-image reflow', () => {
  const f = fixture();
  assert.equal(f.top, 1100);
  f.scroll.capture();
  f.resize({ width: 900, total: 1000, positions: [0, 180, 390, 580, 800] });
  f.patch();
  f.scroll.restore();
  assert.equal(f.top, 500);
  f.resize({ total: 1200, positions: [0, 180, 590, 780, 1000] });
  f.notify();
  assert.equal(f.top, 700);
  f.scroll.capture();
  f.resize({ width: 400, total: 1800, positions: [0, 300, 850, 1150, 1500] });
  f.scroll.restore();
  assert.equal(f.top, 1300);
  f.scroll.dispose();
});

test('prepending an older message batch retains the visible message and pixel offset', () => {
  const f = fixture();
  f.userScroll(80);
  const before = f.offset('a');
  f.prepend(
    Array.from({ length: 80 }, (_, index) => 'older-' + index),
    100,
  );
  assert.equal(f.offset('a'), before);
  assert.equal(f.top, 8_080);
  f.scroll.dispose();
});

test('middle reading keeps the visible message offset across both width directions instead of restoring raw pixels', () => {
  const f = fixture();
  f.userScroll(350);
  const before = f.offset('b');
  assert.equal(before, -50);
  f.scroll.capture();
  f.resize({ width: 900, total: 1150, positions: [0, 210, 440, 690, 940] });
  f.patch();
  f.scroll.restore();
  assert.equal(f.top, 260);
  assert.equal(f.offset('b'), before);
  f.scroll.capture();
  f.resize({ width: 400, total: 1900, positions: [0, 410, 850, 1190, 1600] });
  f.scroll.restore();
  assert.equal(f.top, 460);
  assert.equal(f.offset('b'), before);
  f.scroll.dispose();
});

test('near-bottom reading is an anchor, not a request to jump to the newest message', () => {
  const f = fixture();
  f.userScroll(1050);
  const before = f.offset('d');
  assert.equal(before, -100);
  f.scroll.capture();
  f.resize({ width: 800, total: 2100, positions: [0, 390, 850, 1250, 1750] });
  f.scroll.restore();
  assert.equal(f.offset('d'), before);
  assert.equal(f.top, 1350);
  assert.notEqual(f.top, 1600);
  f.resize({ total: 2300, positions: [0, 390, 850, 1250, 1950] });
  f.notify();
  assert.equal(f.top, 1350, 'new content below the visible message does not drag the reader');
  f.scroll.dispose();
});

test('panel dragging, viewport height changes and lazy images restore the tracked message without another render', () => {
  const f = fixture();
  f.userScroll(720);
  const offset = f.offset('call');
  f.resize({ width: 650, height: 420, total: 1500, positions: [0, 230, 570, 870, 1200] });
  f.notify();
  assert.equal(f.offset('call'), offset);
  assert.equal(f.top, 640);
  f.resize({ total: 1800, positions: [0, 230, 870, 1170, 1500] });
  f.notify();
  assert.equal(f.offset('call'), offset);
  assert.equal(f.top, 940);
  f.scroll.dispose();
});

test('search navigation and manual scrolling supersede pending old resize or image intentions', () => {
  const f = fixture();
  f.resize({ width: 850, total: 1300, positions: [0, 200, 480, 730, 1030] });
  defined(f.document.querySelector<HTMLButtonElement>('[data-search-message]')).dispatchEvent(
    new f.Event('click', { bubbles: true }),
  );
  defined(f.viewport).scrollTop = 220;
  defined(f.viewport).dispatchEvent(new f.Event('scroll'));
  f.notify();
  assert.equal(f.top, 220, 'a search jump cannot be snapped back to the former bottom');
  f.settle();
  const offset = f.offset('b');
  f.resize({ total: 1500, positions: [0, 300, 680, 930, 1230] });
  f.notify();
  assert.equal(f.offset('b'), offset);
  f.resize({ total: 1700, positions: [0, 300, 680, 1030, 1430] });
  f.userScroll(600);
  f.notify();
  assert.equal(f.top, 600);
  f.scroll.navigate(() => {
    defined(f.viewport).scrollTop = 100;
  });
  f.notify();
  assert.equal(f.top, 100);
  f.settle();
  f.scroll.dispose();
});

test('the real search-result handler hands programmatic navigation to scroll tracking before late layout', async () => {
  const f = fixture(),
    target = f.document.querySelector<HTMLButtonElement>('[data-id=a]'),
    history = createChatHistory({
      document: f.document,
      request: async () => {
        throw Error('Unexpected history mutation');
      },
      render() {},
      toast() {},
      openModal() {},
      searchMessages,
      getState: () => ({
        settings: { language: 'en' },
        worker: { status: 'online' },
        messages: [],
      }),
      closeModal() {},
      revealMessage() {
        f.scroll.capture();
        f.resize({ width: 800, total: 1300, positions: [0, 200, 480, 730, 1030] });
        f.scroll.restore();
      },
      navigate: (action) => f.scroll.navigate(action),
    });
  defined(target).scrollIntoView = () => {
    defined(f.viewport).scrollTop = 180;
  };
  history.bind();
  defined(f.document.querySelector<HTMLButtonElement>('[data-search-message]')).click();
  await Promise.resolve();
  f.notify();
  assert.equal(f.top, 180);
  assert.equal(defined(target).classList.contains('search-hit'), true);
  f.settle();
  f.notify();
  assert.equal(f.top, 180);
  f.scroll.dispose();
});

test('clamping a short wide layout does not forget a historical anchor on the next narrow layout', () => {
  const f = fixture();
  f.userScroll(350);
  const offset = f.offset('b');
  f.scroll.capture();
  f.resize({ width: 1200, total: 480, positions: [0, 40, 140, 240, 350] });
  f.scroll.restore();
  assert.equal(f.top, 0);
  f.scroll.capture();
  f.resize({ width: 400, total: 1600, positions: [0, 300, 650, 950, 1300] });
  f.scroll.restore();
  assert.equal(f.offset('b'), offset);
  f.scroll.dispose();
});

test('a clipped long message keeps its approximate reading fraction visible when it shrinks and expands', () => {
  const f = fixture();
  f.resize({ total: 3200, positions: [0, 300, 2300, 2600, 2900] });
  f.notify();
  f.userScroll(1500);
  assert.equal(f.offset('b'), -1200);
  f.scroll.capture();
  f.resize({ width: 1000, total: 1700, positions: [0, 300, 800, 1100, 1400] });
  f.scroll.restore();
  assert.equal(f.offset('b'), -300);
  assert.equal(
    f.top,
    600,
    'the same long message remains visible instead of being scrolled completely above the viewport',
  );
  f.scroll.capture();
  f.resize({ width: 400, total: 3200, positions: [0, 300, 2300, 2600, 2900] });
  f.scroll.restore();
  assert.equal(f.offset('b'), -1200);
  assert.equal(f.top, 1500);
  f.scroll.dispose();
});

test('removed messages use a saved visible neighbor and missing layout APIs do not force history to bottom', () => {
  const f = fixture({ observer: false });
  f.userScroll(350);
  const callOffset = f.offset('call');
  defined(f.document.querySelector<HTMLButtonElement>('[data-id=b]')).remove();
  f.resize({ total: 1500, positions: [0, 550, 850, 1200] });
  f.patch = () => {};
  for (const [index, node] of [
    ...defined(f.document.querySelector<HTMLElement>('.message-column')).children,
  ].entries())
    node.getBoundingClientRect = () =>
      rect(
        100 + defined([0, 550, 850, 1200][index]) - f.top,
        100 + defined([550, 850, 1200, 1500][index]) - f.top,
      );
  f.window.dispatchEvent(new f.Event('resize'));
  assert.equal(f.offset('call'), callOffset);
  assert.equal(f.top, 250);
  f.scroll.dispose();
});

test('detached nodes, scope changes and disposed observers cannot apply old callbacks or timers', () => {
  const f = fixture();
  f.userScroll(350);
  const old = f.observers[0];
  f.scroll.navigate(() => {
    defined(f.viewport).scrollTop = 500;
  });
  const oldTimer = [...f.timers.values()][0];
  f.scope('vm-b/thread-b');
  f.scroll.restore();
  assert.equal(f.top, 1100);
  assert.equal(defined(old).disconnected, true);
  const writes = f.writes;
  defined(old).callback();
  defined(oldTimer)();
  assert.equal(f.writes, writes);
  assert.equal(f.timers.size, 0);
  defined(f.viewport).remove();
  f.scroll.restore();
  const detachedWrites = f.writes;
  defined(f.observers.at(-1)).callback();
  assert.equal(f.writes, detachedWrites);
  f.scroll.dispose();
  f.window.dispatchEvent(new f.Event('resize'));
  f.scroll.capture();
  f.scroll.restore();
  assert.equal(f.writes, detachedWrites);
});

test('cleared visible history drops vanished message anchors before later messages arrive', () => {
  const f = fixture();
  f.userScroll(350);
  defined(f.document.querySelector<HTMLElement>('.message-column')).replaceChildren();
  f.resize({ total: 500 });
  f.scroll.restore();
  assert.equal(f.top, 0);
  f.resize({ total: 900 });
  f.notify();
  assert.equal(f.top, 400);
  f.scroll.dispose();
});

test('main captures before appearance or DOM mutation, restores after composer layout and disposes on unload', () => {
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
    render = source.slice(
      sourceIndex(source, 'function render(){'),
      sourceIndex(source, 'function renderRail(){'),
    );
  assert.ok(render.indexOf('chatScroll.capture()') < render.indexOf('appearance.sync'));
  assert.ok(render.indexOf('chatScroll.capture()') < render.indexOf('reconcileOutgoingMessages()'));
  assert.ok(render.indexOf('chatScroll.restore()') > render.indexOf('resizeComposer()'));
  assert.doesNotMatch(render, /oldScroll|nearBottom/);
  assert.match(source, /unloading\s*=\s*true;\s*chatScroll\.dispose\(\)/);
});
