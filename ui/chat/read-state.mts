// WebView document visibility alone is not a reliable Windows minimize signal.
// This guard never reads chat content or changes a receipt by itself.
import type { Cleanup, ChatMessage, Attachment } from '../shared/contracts.mts';
export type ReadMessage = Omit<Partial<ChatMessage>, 'attachments' | 'id'> & {
  id: string;
  attachments?: Pick<Attachment, 'id'>[];
};
interface NativeReadWindow {
  isMinimized(): Promise<unknown>;
  isFocused(): Promise<unknown>;
  onFocusChanged(callback: (event: { payload?: unknown }) => void): Promise<Cleanup>;
  onResized(callback: () => void): Promise<Cleanup>;
}
interface ReadWindow {
  addEventListener?: (type: 'beforeunload', callback: () => void) => void;
  removeEventListener?: (type: 'beforeunload', callback: () => void) => void;
}
interface ReadVisibilityOptions {
  desktop?: boolean;
  onChange?: (visible: boolean) => void;
  loadWindow?: () => Promise<{ getCurrentWindow: () => NativeReadWindow }>;
  window?: ReadWindow;
}
export function createReadVisibility({
  desktop = false,
  onChange = () => {},
  loadWindow = () => import('@tauri-apps/api/window'),
  window = globalThis.window,
}: ReadVisibilityOptions = {}) {
  let visible = !desktop,
    closed = false,
    generation = 0,
    api: NativeReadWindow | null = null;
  const stops: Cleanup[] = [];
  const publish = (value: boolean) => {
    if (closed || visible === value) return;
    visible = value;
    onChange(value);
  };
  async function refresh() {
    if (closed || !api) return;
    const current = ++generation;
    publish(false);
    try {
      const [minimized, focused] = await Promise.all([api.isMinimized(), api.isFocused()]);
      if (!closed && current === generation) publish(minimized === false && focused === true);
    } catch {
      if (!closed && current === generation) publish(false);
    }
  }
  function dispose() {
    if (closed) return;
    closed = true;
    generation++;
    visible = false;
    for (const stop of stops) stop();
    stops.length = 0;
    window?.removeEventListener?.('beforeunload', dispose);
  }
  if (desktop) {
    window?.addEventListener?.('beforeunload', dispose);
    void Promise.resolve()
      .then(loadWindow)
      .then(async (module) => {
        if (closed) return;
        api = module.getCurrentWindow();
        const subscriptions = await Promise.allSettled([
          api.onFocusChanged((event) => {
            generation++;
            publish(false);
            if (event.payload === true) void refresh();
          }),
          api.onResized(() => {
            publish(false);
            void refresh();
          }),
        ]);
        for (const result of subscriptions)
          if (result.status === 'fulfilled') {
            if (closed) result.value();
            else stops.push(result.value);
          }
        if (subscriptions.some((result) => result.status === 'rejected')) {
          generation++;
          api = null;
          publish(false);
          return;
        }
        await refresh();
      })
      .catch(() => publish(false));
  }
  return {
    // Native focus remains authoritative when WebView document focus lags.
    documentFocusRequired: !desktop,
    get visible() {
      return visible;
    },
    refresh,
    dispose,
  };
}
