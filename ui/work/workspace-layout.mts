interface WorkspaceWindow {
  addEventListener(type: 'resize' | 'blur', listener: () => void): void;
  removeEventListener(type: 'resize' | 'blur', listener: () => void): void;
}
interface WorkspaceLayoutOptions {
  document: Document;
  window: WorkspaceWindow;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
}
type Pane = 'progress' | 'computer';
type LayoutMode = 'columns' | 'split' | 'stacked';
interface Widths {
  mode: LayoutMode;
  progress: number;
  computer: number;
}
interface Gesture {
  id: number;
  startX: number;
  pane: Pane;
  handle: HTMLElement;
  workspace: HTMLElement;
  progress: HTMLElement | null;
  computer: HTMLElement | null;
  widths: Widths;
}
const CHAT_MIN_WIDTH = 280;
const PROGRESS_MIN_WIDTH = 260;
const COMPUTER_MIN_WIDTH = 320;
const DIVIDER_WIDTH = 8;
const DEFAULT_PROGRESS_WIDTH = 320;
const DEFAULT_COMPUTER_SHARE = 0.54;
const MAX_SAVED_WIDTH = 10000;
const KEYBOARD_STEP = 20;
const storageKeys = { progress: 'workProgressWidth', computer: 'computerWidth' } as const;
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

/** Pure geometry keeps every visible pane usable before enabling a divider. */
export function workspaceWidths(
  width: number,
  progressVisible: boolean,
  computerVisible: boolean,
  desired: { progress?: number; computer?: number } = {},
): Widths {
  const available = Number.isFinite(width) ? Math.max(0, width) : 0;
  const progress = desired.progress ?? DEFAULT_PROGRESS_WIDTH;
  const computer = desired.computer ?? Math.round(available * DEFAULT_COMPUTER_SHARE);
  const totalMinimum =
    CHAT_MIN_WIDTH +
    (progressVisible ? PROGRESS_MIN_WIDTH + DIVIDER_WIDTH : 0) +
    (computerVisible ? COMPUTER_MIN_WIDTH + DIVIDER_WIDTH : 0);
  const mode: LayoutMode =
    available >= totalMinimum
      ? 'columns'
      : progressVisible && available >= CHAT_MIN_WIDTH + PROGRESS_MIN_WIDTH + DIVIDER_WIDTH
        ? 'split'
        : 'stacked';
  const progressMaximum =
    available -
    CHAT_MIN_WIDTH -
    DIVIDER_WIDTH -
    (mode === 'columns' && computerVisible ? COMPUTER_MIN_WIDTH + DIVIDER_WIDTH : 0);
  const progressWidth = progressVisible ? clamp(progress, PROGRESS_MIN_WIDTH, progressMaximum) : 0;
  return {
    mode,
    progress: progressWidth,
    computer: computerVisible
      ? clamp(
          computer,
          COMPUTER_MIN_WIDTH,
          available -
            CHAT_MIN_WIDTH -
            DIVIDER_WIDTH -
            (progressVisible ? progressWidth + DIVIDER_WIDTH : 0),
        )
      : 0,
  };
}

/** Presentation-only divider gestures never rerender chat, media, or the desktop. */
export function createWorkspaceLayout({ document, window, storage }: WorkspaceLayoutOptions) {
  const desired: { progress?: number; computer?: number } = {};
  for (const pane of ['progress', 'computer'] as const) {
    try {
      const raw = storage.getItem(storageKeys[pane]);
      if (raw && /^\d+(?:\.\d+)?$/.test(raw)) {
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0 && value <= MAX_SAVED_WIDTH) desired[pane] = value;
      }
    } catch {}
  }
  let gesture: Gesture | null = null;
  let disposed = false;
  const workspace = () => document.querySelector<HTMLElement>('.workspace');
  const progressPanel = () => document.querySelector<HTMLElement>('[data-progress-panel]');
  const computerPanel = () => document.querySelector<HTMLElement>('.computer-panel');
  const paneVisible = (pane: Pane) =>
    Boolean(pane === 'progress' ? progressPanel() : computerPanel());
  const width = (node: HTMLElement) => node.getBoundingClientRect().width;
  function currentWidths(node: HTMLElement) {
    return workspaceWidths(
      width(node),
      Boolean(progressPanel()),
      Boolean(computerPanel()),
      desired,
    );
  }
  function bounds(pane: Pane, node: HTMLElement, sizes: Widths) {
    const minimum = pane === 'progress' ? PROGRESS_MIN_WIDTH : COMPUTER_MIN_WIDTH;
    const maximum =
      pane === 'computer' && progressPanel()
        ? sizes.progress + sizes.computer - PROGRESS_MIN_WIDTH
        : width(node) -
          CHAT_MIN_WIDTH -
          DIVIDER_WIDTH -
          (pane === 'progress' && sizes.mode === 'columns' && computerPanel()
            ? sizes.computer + DIVIDER_WIDTH
            : 0);
    return { minimum, maximum: Math.max(minimum, maximum) };
  }
  function apply(node: HTMLElement, sizes: Widths) {
    node.dataset.workspaceLayout = sizes.mode;
    node.style.setProperty('--progress-pane-width', sizes.progress + 'px');
    node.style.setProperty('--computer-pane-width', sizes.computer + 'px');
    const progress = progressPanel(),
      computer = computerPanel();
    if (progress) progress.style.width = sizes.progress + 'px';
    if (computer) computer.style.width = sizes.computer + 'px';
    node.querySelectorAll<HTMLElement>('[data-workspace-resize]').forEach((handle) => {
      const pane = handle.dataset.workspaceResize === 'progress' ? 'progress' : 'computer';
      const enabled =
        paneVisible(pane) &&
        (sizes.mode === 'columns' || (sizes.mode === 'split' && pane === 'progress'));
      handle.hidden = !enabled;
      handle.tabIndex = enabled ? 0 : -1;
      const range = bounds(pane, node, sizes);
      handle.setAttribute('aria-valuemin', String(Math.round(range.minimum)));
      handle.setAttribute('aria-valuemax', String(Math.round(range.maximum)));
      handle.setAttribute('aria-valuenow', String(Math.round(sizes[pane])));
    });
  }
  function resize(pane: Pane, value: number, node: HTMLElement, initial: Widths) {
    const range = bounds(pane, node, initial);
    const next = { ...initial, [pane]: Math.round(clamp(value, range.minimum, range.maximum)) };
    if (pane === 'computer' && progressPanel())
      next.progress = initial.progress + initial.computer - next.computer;
    desired[pane] = next[pane];
    if (pane === 'computer' && progressPanel()) desired.progress = next.progress;
    apply(node, next);
  }
  function persist() {
    for (const pane of ['progress', 'computer'] as const) {
      const value = desired[pane];
      if (value !== undefined) {
        try {
          storage.setItem(storageKeys[pane], String(value));
        } catch {}
      }
    }
  }
  function finish(event?: PointerEvent) {
    if (!gesture || (event && event.pointerId !== gesture.id)) return;
    const previous = gesture;
    gesture = null;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    previous.workspace.removeAttribute('data-workspace-resizing');
    try {
      if (previous.handle.hasPointerCapture?.(previous.id))
        previous.handle.releasePointerCapture(previous.id);
    } catch {}
    persist();
  }
  function move(event: PointerEvent) {
    const active = gesture;
    if (!active || event.pointerId !== active.id || !Number.isFinite(event.clientX)) return;
    if (
      !active.workspace.isConnected ||
      !active.handle.isConnected ||
      active.progress !== progressPanel() ||
      active.computer !== computerPanel()
    ) {
      finish();
      return;
    }
    event.preventDefault();
    const direction = document.documentElement.dir === 'rtl' ? -1 : 1;
    resize(
      active.pane,
      active.widths[active.pane] + (active.startX - event.clientX) * direction,
      active.workspace,
      active.widths,
    );
  }
  function bind() {
    if (disposed) return;
    const node = workspace();
    if (!node) {
      finish();
      return;
    }
    const sizes = currentWidths(node);
    if (
      gesture &&
      (gesture.workspace !== node ||
        !gesture.handle.isConnected ||
        sizes.mode !== gesture.widths.mode ||
        gesture.progress !== progressPanel() ||
        gesture.computer !== computerPanel())
    )
      finish();
    apply(node, sizes);
    node.querySelectorAll<HTMLElement>('[data-workspace-resize]').forEach((handle) => {
      const pane: Pane = handle.dataset.workspaceResize === 'progress' ? 'progress' : 'computer';
      handle.onpointerdown = (event) => {
        if (
          handle.hidden ||
          event.button !== 0 ||
          event.isPrimary === false ||
          !Number.isFinite(event.clientX)
        )
          return;
        finish();
        event.preventDefault();
        gesture = {
          id: event.pointerId,
          startX: event.clientX,
          pane,
          handle,
          workspace: node,
          progress: progressPanel(),
          computer: computerPanel(),
          widths: currentWidths(node),
        };
        node.dataset.workspaceResizing = pane;
        try {
          handle.setPointerCapture?.(event.pointerId);
        } catch {}
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', finish);
      };
      handle.onkeydown = (event) => {
        if (
          handle.hidden ||
          event.isComposing ||
          !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
        )
          return;
        event.preventDefault();
        finish();
        const before = currentWidths(node),
          range = bounds(pane, node, before);
        const direction = document.documentElement.dir === 'rtl' ? -1 : 1;
        const next =
          event.key === 'Home'
            ? range.minimum
            : event.key === 'End'
              ? range.maximum
              : before[pane] +
                (event.key === 'ArrowLeft' ? KEYBOARD_STEP : -KEYBOARD_STEP) * direction;
        resize(pane, next, node, before);
        persist();
      };
      handle.onlostpointercapture = finish;
    });
  }
  const refresh = () => {
    finish();
    bind();
  };
  const blur = () => finish();
  window.addEventListener('resize', refresh);
  window.addEventListener('blur', blur);
  return {
    bind,
    dispose() {
      finish();
      disposed = true;
      window.removeEventListener('resize', refresh);
      window.removeEventListener('blur', blur);
    },
  };
}
