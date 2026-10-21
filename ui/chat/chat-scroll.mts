import type { ScheduleTimer, CancelTimer } from '../shared/contracts.mts';
import type { Timer } from '../shared/contracts.mts';
interface ScrollMetrics {
  width: number;
  height: number;
  total: number;
}
interface ScrollAnchor {
  key: string | null;
  offset: number;
  height: number;
  fractional: boolean;
}
interface SavedScroll {
  bottom: boolean;
  top: number;
  metrics: ScrollMetrics;
  anchors: ScrollAnchor[];
}
interface ScrollObserver {
  observe(target: Element): void;
  disconnect(): void;
}
interface ScrollWindow {
  addEventListener(type: 'resize', callback: () => void): void;
  removeEventListener(type: 'resize', callback: () => void): void;
}
interface ChatScrollOptions {
  document?: Document;
  window?: ScrollWindow;
  getScope?: () => unknown;
  ResizeObserver?: (new (callback: () => void) => ScrollObserver) | null;
  onRestore?: () => void;
  schedule?: ScheduleTimer;
  cancel?: CancelTimer;
}
const SCROLL_SETTLE_MS = 180;
// Keep a reading position across width reflow and delayed attachment decoding.
// A pixel scrollTop alone refers to different messages after text wraps again.
export function createChatScroll({
  document = globalThis.document,
  window = globalThis.window,
  getScope = () => null,
  ResizeObserver = globalThis.ResizeObserver,
  onRestore = () => {},
  schedule = globalThis.setTimeout,
  cancel = globalThis.clearTimeout,
}: ChatScrollOptions = {}) {
  let viewport: HTMLElement | null = null,
    column: HTMLElement | null = null,
    observer: ScrollObserver | null = null,
    saved: SavedScroll | null = null,
    scope: unknown = null,
    expectedTop: number | null = null,
    disposed = false,
    generation = 0,
    settleTimer: Timer | null = null,
    userScrolling = false,
    loadListener: (() => void) | null = null;
  const metrics = () => ({
    width: viewport?.clientWidth ?? 0,
    height: viewport?.clientHeight ?? 0,
    total: viewport?.scrollHeight ?? 0,
  });
  const changed = () => {
    const next = metrics(),
      old = saved?.metrics;
    return (
      !old || next.width !== old.width || next.height !== old.height || next.total !== old.total
    );
  };
  const key = (node: Element) =>
    node.getAttribute('data-id')
      ? 'id:' + node.getAttribute('data-id')
      : node.getAttribute('data-key')
        ? 'key:' + node.getAttribute('data-key')
        : null;
  const nodes = () => [...(column?.children || [])].filter((node) => key(node));
  function remember() {
    if (!viewport || !viewport.clientHeight) return;
    const values = nodes(),
      bounds = viewport.getBoundingClientRect();
    let low = 0,
      high = values.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((values[middle]?.getBoundingClientRect().bottom ?? Infinity) <= bounds.top)
        low = middle + 1;
      else high = middle;
    }
    const candidates = [...values.slice(low, low + 4), ...(low ? values.slice(low - 1, low) : [])];
    const previous = new Map((saved?.anchors || []).map((anchor) => [anchor.key, anchor]));
    saved = {
      bottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2,
      top: viewport.scrollTop,
      metrics: metrics(),
      anchors: candidates.map((node) => {
        const rect = node.getBoundingClientRect(),
          id = key(node);
        return {
          key: id,
          offset: rect.top - bounds.top,
          height: rect.bottom - rect.top,
          fractional: previous.get(id)?.fractional === true,
        };
      }),
    };
  }
  function restorePosition() {
    if (!viewport || !viewport.clientHeight || disposed) return;
    if (saved?.anchors.length && !nodes().length) saved = null;
    if (!saved) {
      viewport.scrollTop = viewport.scrollHeight;
      remember();
      expectedTop = viewport.scrollTop;
      return;
    }
    let next = saved.top;
    if (saved.bottom) next = viewport.scrollHeight;
    else {
      const current = new Map(nodes().map((node) => [key(node), node])),
        anchor = saved.anchors.find((item) => current.has(item.key));
      if (anchor) {
        const rect = current.get(anchor.key)!.getBoundingClientRect(),
          height = rect.bottom - rect.top;
        if (
          anchor.offset < 0 &&
          anchor.height > 0 &&
          height > 0 &&
          (anchor.fractional || anchor.height > viewport.clientHeight || -anchor.offset >= height)
        ) {
          anchor.fractional = true;
          anchor.offset = (anchor.offset / anchor.height) * height;
          anchor.height = height;
        }
        next = viewport.scrollTop + rect.top - viewport.getBoundingClientRect().top - anchor.offset;
      }
    }
    const intent = saved;
    viewport.scrollTop = next;
    expectedTop = viewport.scrollTop;
    if (!intent.bottom && Math.abs(viewport.scrollTop - next) > 1)
      saved = { ...intent, top: viewport.scrollTop, metrics: metrics() };
    else {
      remember();
      if (saved) saved.bottom = intent.bottom;
    }
    onRestore();
  }
  function layout() {
    if (!viewport || disposed) return;
    if (userScrolling) {
      remember();
      return;
    }
    // Search/navigation may scroll without a wheel event. Do not undo that jump
    // when a ResizeObserver notification is merely the initial unchanged size.
    if (saved && !changed() && viewport.scrollTop !== saved.top) {
      remember();
      expectedTop = null;
      return;
    }
    restorePosition();
  }
  function scrolled() {
    if (!viewport || disposed) return;
    if (userScrolling) {
      expectedTop = null;
      remember();
      input();
      return;
    }
    if (expectedTop !== null && Math.abs(viewport.scrollTop - expectedTop) < 1) {
      expectedTop = null;
      return;
    }
    expectedTop = null;
    if (saved && changed()) restorePosition();
    else remember();
  }
  function input() {
    if (disposed) return;
    expectedTop = null;
    userScrolling = true;
    remember();
    if (settleTimer !== null) cancel(settleTimer);
    const epoch = generation;
    settleTimer = schedule(() => {
      if (epoch !== generation || disposed) return;
      settleTimer = null;
      userScrolling = false;
      remember();
    }, SCROLL_SETTLE_MS);
  }
  function navigation(event: Event) {
    if (
      (event.target as Element | null)?.closest?.(
        '[data-search-message],[data-progress-message],[data-first-unread]',
      )
    )
      input();
  }
  function detach() {
    generation++;
    if (settleTimer !== null) cancel(settleTimer);
    settleTimer = null;
    userScrolling = false;
    observer?.disconnect();
    observer = null;
    if (viewport) {
      viewport.removeEventListener('scroll', scrolled);
      if (loadListener) viewport.removeEventListener('load', loadListener, true);
      for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown'])
        viewport.removeEventListener(type, input);
    }
    viewport = column = null;
    expectedTop = null;
  }
  function capture() {
    if (!viewport || disposed) return;
    if (saved && changed() && !userScrolling) restorePosition();
    else if (!saved || viewport.scrollTop !== saved.top || userScrolling) remember();
  }
  function restore() {
    if (disposed) return;
    const next = document.querySelector<HTMLElement>('#messages'),
      nextColumn = next?.querySelector<HTMLElement>('.message-column') ?? null,
      nextScope = getScope();
    const scopeChanged = nextScope !== scope;
    if (scopeChanged) {
      scope = nextScope;
      saved = null;
    }
    if (scopeChanged || next !== viewport || nextColumn !== column) {
      detach();
      viewport = next;
      column = nextColumn;
      if (viewport) {
        const epoch = generation,
          owner = viewport;
        loadListener = () => {
          if (epoch === generation && viewport === owner) layout();
        };
        viewport.addEventListener('scroll', scrolled, { passive: true });
        viewport.addEventListener('load', loadListener, true);
        for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown'])
          viewport.addEventListener(type, input, { passive: true });
        if (ResizeObserver) {
          observer = new ResizeObserver(loadListener);
          observer.observe(viewport);
          if (column) observer.observe(column);
        }
      }
    }
    restorePosition();
  }
  window?.addEventListener?.('resize', layout);
  document.addEventListener('click', navigation, true);
  return {
    capture,
    restore,
    layout,
    navigate(action: () => void) {
      input();
      action();
      remember();
    },
    dispose() {
      disposed = true;
      detach();
      window?.removeEventListener?.('resize', layout);
      document.removeEventListener('click', navigation, true);
      saved = null;
    },
  };
}
