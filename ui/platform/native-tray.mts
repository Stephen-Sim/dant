import { normalizeLanguage } from '../i18n/languages.mts';
import { isRecord } from '../shared/contracts.mts';
import { TaskStatus, ConnectionStatus } from '../shared/states.mts';
import type { CoreModule, EventModule, Cleanup } from '../shared/contracts.mts';
const taskStates = new Set<string>([
  TaskStatus.WaitingUser,
  TaskStatus.Pausing,
  TaskStatus.Unknown,
]);
export function trayStatus(value: unknown = {}) {
  const state = isRecord(value) ? value : {},
    settings = isRecord(state.settings) ? state.settings : {},
    controller = isRecord(state.controller) ? state.controller : {},
    worker = isRecord(state.worker) ? state.worker : {},
    bridge = controller.status,
    disconnected =
      controller.cached === true || (bridge !== undefined && bridge !== ConnectionStatus.Online),
    connection =
      !disconnected && worker.status === ConnectionStatus.Online
        ? ConnectionStatus.Online
        : bridge === ConnectionStatus.Connecting ||
            (!disconnected && worker.status === ConnectionStatus.Connecting)
          ? ConnectionStatus.Connecting
          : ConnectionStatus.Offline,
    observed = isRecord(state.active) ? state.active : null,
    active =
      observed?.visible === false &&
      !taskStates.has(typeof observed.status === 'string' ? observed.status : '')
        ? null
        : observed,
    task = active
      ? taskStates.has(typeof active.status === 'string' ? active.status : '')
        ? String(active.status)
        : active.background
          ? 'background'
          : TaskStatus.Running
      : 'idle';
  return {
    language: normalizeLanguage(settings.language),
    connection,
    task,
    queued: Math.min(999, Array.isArray(state.queue) ? state.queue.length : 0),
  };
}
interface NativeTrayOptions {
  desktop?: boolean;
  onProgress?: () => void;
  loadCore?: () => Promise<CoreModule>;
  loadEvents?: () => Promise<EventModule>;
}
export function createNativeTray({
  desktop = false,
  onProgress = () => {},
  loadCore = () => import('@tauri-apps/api/core'),
  loadEvents = () => import('@tauri-apps/api/event'),
}: NativeTrayOptions = {}) {
  let latest: ReturnType<typeof trayStatus> | null = null,
    last = '',
    ready: Promise<CoreModule> | null = null,
    unlisten: Cleanup | null = null,
    closed = false,
    sending = false;
  function initialize() {
    return (ready ||= Promise.all([loadCore(), loadEvents()])
      .then(async ([core, events]) => {
        const stop = await events.listen('dant-tray-progress', () => {
          if (!closed) onProgress();
        });
        if (closed) stop();
        else unlisten = stop;
        return core;
      })
      .catch((error) => {
        ready = null;
        throw error;
      }));
  }
  async function flush() {
    if (sending || closed || !desktop) return;
    sending = true;
    let attempted = JSON.stringify(latest);
    try {
      const core = await initialize();
      while (!closed) {
        const current = JSON.stringify(latest);
        attempted = current;
        if (current !== last) {
          await core.invoke('tray_status_update', { status: latest });
          last = current;
        }
        if (current === JSON.stringify(latest)) break;
      }
    } catch {
      /* An unavailable tray leaves ordinary window close available. */
    } finally {
      sending = false;
      if (!closed && JSON.stringify(latest) !== attempted) void flush();
    }
  }
  function sync(state: unknown) {
    if (closed || !desktop) return;
    latest = trayStatus(state);
    void flush();
  }
  function dispose() {
    if (closed) return;
    closed = true;
    unlisten?.();
    unlisten = null;
  }
  return { sync, dispose };
}
