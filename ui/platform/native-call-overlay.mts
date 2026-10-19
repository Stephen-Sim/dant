import type {
  OverlayLifecycleWindow,
  OverlayMutationObserver,
  OverlayMutationObserverConstructor,
} from '../call/overlay-ports.ts';
import { identifier, isOverlayAction, overlaySnapshot } from '../call/overlay-state.mts';
import type { OverlayAction, OverlayState } from '../call/overlay-state.mts';
import { isRecord } from '../shared/contracts.mts';
import type { CoreModule, EventModule, Cleanup } from '../shared/contracts.mts';
interface NativeCallOptions {
  desktop?: boolean;
  onAction?: (action: OverlayAction) => unknown;
  onError?: (error: Error) => void;
  loadCore?: () => Promise<CoreModule>;
  loadEvents?: () => Promise<EventModule>;
  window?: OverlayLifecycleWindow;
  document?: Document;
  MutationObserver?: OverlayMutationObserverConstructor;
}
export function createNativeCallOverlay({
  desktop = false,
  onAction = () => {},
  onError = () => {},
  loadCore = () => import('@tauri-apps/api/core'),
  loadEvents = () => import('@tauri-apps/api/event'),
  window = globalThis.window,
  document = globalThis.document,
  MutationObserver = globalThis.MutationObserver,
}: NativeCallOptions = {}) {
  let latest: OverlayState | null = null,
    closed = false,
    revision = 0,
    queued = false,
    unlisten: Cleanup | null = null,
    observer: OverlayMutationObserver | null = null,
    lastSent = '',
    ready: Promise<CoreModule> | null = null,
    sending: Promise<unknown> = Promise.resolve(),
    reported = false;
  const seen = new Set<string>();
  const report = () => {
    if (reported) return;
    reported = true;
    try {
      onError(Error('The floating call window is unavailable.'));
    } catch {}
  };
  async function receive(event: { payload: unknown }) {
    const value = event.payload;
    if (
      closed ||
      !latest ||
      !isRecord(value) ||
      value.callId !== latest.callId ||
      !identifier(value.requestId) ||
      !isOverlayAction(value.action) ||
      seen.has(value.requestId)
    )
      return;
    seen.add(value.requestId);
    while (seen.size > 128) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
    if (
      value.action === 'mute' &&
      (!latest.canMute || typeof value.muted !== 'boolean' || latest.muted === value.muted)
    )
      return;
    try {
      await onAction(
        value.action === 'mute'
          ? { callId: latest.callId, action: 'mute', muted: value.muted === true }
          : { callId: latest.callId, action: value.action },
      );
    } catch {
      report();
    }
  }
  function initialize() {
    return (ready ||= Promise.all([loadCore(), loadEvents()]).then(async ([core, events]) => {
      const stop = await events.listen('dant-call-overlay-action', receive);
      if (closed) stop();
      else unlisten = stop;
      return core;
    }));
  }
  async function flush() {
    if (queued || closed || !desktop) return;
    queued = true;
    let attempted = revision,
      retry = false;
    try {
      const core = await initialize();
      while (!closed) {
        const current = revision,
          value = latest,
          encoded = JSON.stringify(value);
        attempted = current;
        if (encoded !== lastSent) {
          sending = core.invoke('call_overlay_update', { state: value });
          await sending;
          lastSent = encoded;
          reported = false;
        }
        if (current === revision) break;
      }
    } catch {
      report();
      retry = revision !== attempted;
    } finally {
      queued = false;
      if (retry && !closed) void flush();
    }
  }
  function update(value: unknown) {
    if (closed || !desktop) return;
    const next = overlaySnapshot(value);
    if (latest?.callId !== next?.callId) seen.clear();
    latest = next;
    revision++;
    void flush();
  }
  function dispose() {
    if (closed) return;
    closed = true;
    unlisten?.();
    unlisten = null;
    observer?.disconnect();
    observer = null;
    window?.removeEventListener?.('beforeunload', dispose);
    if (desktop && ready)
      void ready
        .then(async (core) => {
          await sending.catch(() => {});
          return core.invoke('call_overlay_update', { state: null });
        })
        .catch(() => {});
    latest = null;
    seen.clear();
  }
  if (desktop) {
    window?.addEventListener?.('beforeunload', dispose);
    if (MutationObserver && document?.documentElement) {
      observer = new MutationObserver(() => {
        if (latest) {
          const theme = document.documentElement.dataset.theme;
          if ((theme === 'light' || theme === 'dark') && theme !== latest.theme)
            update({ ...latest, theme });
        }
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
    }
  }
  return { update, dispose };
}
