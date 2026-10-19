import type { OverlayLifecycleWindow } from './overlay-ports.ts';
import { overlaySnapshot } from './overlay-state.mts';
import type { OverlayState } from './overlay-state.mts';
import type { CoreModule, EventModule, Interval } from '../shared/contracts.mts';
interface OverlayOptions {
  document?: Document;
  window?: OverlayLifecycleWindow;
  loadCore?: () => Promise<CoreModule>;
  loadEvents?: () => Promise<EventModule>;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => Interval;
  cancel?: (timer: Interval) => void;
  randomId?: () => string;
}
import { languageInfo } from '../../src/i18n/languages.mts';
import { localizeMessages } from '../../src/i18n/i18n.mts';
import { loadLanguage } from '../i18n/localization.mts';
import { formatCallDuration } from './call-duration.mts';

const words = {
  en: {
    calling: 'Connecting…',
    talking: 'In a call',
    recovering: 'Call needs reconnecting',
    stopping: 'Ending call…',
    mute: 'Mute microphone',
    unmute: 'Unmute microphone',
    hangup: 'End call',
    restore: 'Return to dant',
    hide: 'Hide call window',
    duration: 'Call duration',
    failed: 'Action unconfirmed. Return to dant.',
  },
  zh: {
    calling: '正在连接…',
    talking: '正在通话',
    recovering: '通话需要重新连接',
    stopping: '正在结束通话…',
    mute: '关闭麦克风',
    unmute: '开启麦克风',
    hangup: '结束通话',
    restore: '返回 dant',
    hide: '隐藏通话窗口',
    duration: '通话时长',
    failed: '操作未确认，请返回 dant。',
  },
};
export async function mountCallOverlay({
  document = globalThis.document,
  window = globalThis.window,
  loadCore = () => import('@tauri-apps/api/core'),
  loadEvents = () => import('@tauri-apps/api/event'),
  now = Date.now,
  schedule = setInterval,
  cancel = clearInterval,
  randomId = () => crypto.randomUUID(),
}: OverlayOptions = {}) {
  const rootNode = document.querySelector<HTMLElement>('#call-overlay');
  if (!rootNode) return () => {};
  const root: HTMLElement = rootNode;
  const [core, events] = await Promise.all([loadCore(), loadEvents()]);
  let state: OverlayState | null = null,
    pending: { requestId: string; callId: string; action: string; muted: boolean } | null = null,
    failure = false,
    closed = false,
    revision = 0;
  function required<E extends HTMLElement>(selector: string): E {
    const node = document.querySelector<E>(selector);
    if (!node) throw Error('The call overlay is incomplete.');
    return node;
  }
  const status = required<HTMLElement>('#call-status'),
    duration = required<HTMLElement>('#call-duration'),
    mute = required<HTMLButtonElement>('#call-mute'),
    hangup = required<HTMLButtonElement>('#call-hangup'),
    restore = required<HTMLButtonElement>('#call-restore'),
    hide = required<HTMLButtonElement>('#call-hide'),
    slash = required<HTMLElement>('#mute-slash');
  function tick() {
    if (!state) return;
    const seconds =
      state.running && typeof state.connectedAt === 'number' && Number.isFinite(state.connectedAt)
        ? Math.max(state.seconds, Math.round((now() - state.connectedAt) / 1000))
        : state.seconds;
    duration.textContent = formatCallDuration(seconds);
  }
  function render() {
    root.hidden = !state;
    if (!state) return;
    const text = localizeMessages(words, state.language);
    document.documentElement.lang = languageInfo(state.language).locale;
    document.documentElement.dir = languageInfo(state.language).direction;
    document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light';
    root.setAttribute('aria-label', text.talking);
    status.textContent = failure ? text.failed : text[state.status] || text.calling;
    status.title = status.textContent;
    duration.hidden = !state.confirmed;
    duration.setAttribute('aria-label', text.duration);
    tick();
    for (const [node, label] of [
      [mute, text[state.muted ? 'unmute' : 'mute']],
      [hangup, text.hangup],
      [restore, text.restore],
      [hide, text.hide],
    ] as const) {
      node.title = label;
      node.setAttribute('aria-label', label);
    }
    mute.hidden = !state.canMute;
    mute.disabled = !!pending;
    hangup.disabled = !!pending || state.status === 'stopping';
    mute.setAttribute('aria-pressed', String(!!state.muted));
    slash.hidden = !state.muted;
  }
  function update(input: unknown) {
    const value = overlaySnapshot(input);
    const current = ++revision;
    if (closed) return;
    if (!value || typeof value.callId !== 'string' || !value.callId) {
      state = null;
      pending = null;
      render();
      return;
    }
    if (
      pending &&
      (pending.callId !== value.callId ||
        (pending.action === 'mute' && pending.muted === value.muted) ||
        pending.action === 'restore')
    )
      pending = null;
    state = value;
    failure = false;
    render();
    if (!['en', 'zh'].includes(value.language))
      void loadLanguage(value.language)
        .then(() => {
          if (!closed && revision === current) render();
        })
        .catch(() => {});
  }
  async function action(name: 'mute' | 'hangup' | 'restore' | 'hide') {
    if (
      closed ||
      !state ||
      (pending && !['restore', 'hide'].includes(name)) ||
      (name === 'mute' && !state.canMute)
    )
      return;
    const call = state.callId,
      requestId = randomId(),
      muted = !state.muted;
    if (name === 'hide') {
      try {
        await core.invoke('call_overlay_action', { callId: call, action: name, requestId });
      } catch {
        if (!closed && state?.callId === call) {
          failure = true;
          render();
        }
      }
      return;
    }
    pending = { requestId, callId: call, action: name, muted };
    failure = false;
    render();
    try {
      await core.invoke('call_overlay_action', {
        callId: call,
        action: name,
        requestId,
        ...(name === 'mute' ? { muted } : {}),
      });
    } catch {
      if (!closed && state?.callId === call && pending?.requestId === requestId) {
        pending = null;
        failure = true;
        render();
      }
    }
  }
  mute.onclick = () => action('mute');
  hangup.onclick = () => action('hangup');
  restore.onclick = () => action('restore');
  hide.onclick = () => action('hide');
  root.onpointerdown = (event) => {
    if (event.button !== 0 || (event.target as Element | null)?.closest('button') || !state) return;
    event.preventDefault();
    void core.invoke('call_overlay_drag').catch(() => {});
  };
  const stop = await events.listen('dant-call-overlay-state', (event) => update(event.payload));
  const initialRevision = revision;
  try {
    const initial = await core.invoke('call_overlay_get');
    if (revision === initialRevision) update(initial);
  } catch {
    if (revision === initialRevision) update(null);
  }
  const timer = schedule(tick, 1000);
  function dispose() {
    if (closed) return;
    closed = true;
    stop();
    cancel(timer);
    window?.removeEventListener?.('beforeunload', dispose);
    root.onpointerdown = null;
    mute.onclick = null;
    hangup.onclick = null;
    restore.onclick = null;
    hide.onclick = null;
  }
  window?.addEventListener?.('beforeunload', dispose);
  return dispose;
}
if (globalThis.window?.__TAURI_INTERNALS__ && globalThis.document?.querySelector('#call-overlay'))
  void mountCallOverlay().catch(() => {});
