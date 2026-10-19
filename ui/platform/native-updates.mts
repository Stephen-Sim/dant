import { isRecord, isSafeInteger } from '../shared/contracts.mts';
import type { CoreModule, EventModule, Cleanup } from '../shared/contracts.mts';
export interface UpdateAsset {
  channel: 'stable' | 'beta';
  version: string;
  sha256: string;
  size: number;
  name: string;
  url?: string;
}
export interface UpdatePackage extends UpdateAsset {
  ready: true;
  packageId: string;
}
export interface UpdateProgress {
  status: 'downloading' | 'ready' | 'failed';
  channel: string;
  version: string;
  sha256: string;
  received: number;
  total: number;
}
interface NativeUpdateOptions {
  desktop?: boolean;
  getToken?: () => string;
  loadCore?: () => Promise<CoreModule>;
  loadEvents?: () => Promise<EventModule>;
}
const MAX_UPDATE_BYTES = 512 * 1024 * 1024;
const version = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 80 &&
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
const key = (asset: UpdateAsset | null | undefined) =>
  asset &&
  ['stable', 'beta'].includes(asset.channel) &&
  version(asset.version) &&
  /^[a-f0-9]{64}$/.test(asset.sha256 || '') &&
  Number.isSafeInteger(asset.size) &&
  asset.size > 0 &&
  asset.size <= MAX_UPDATE_BYTES &&
  asset.name === `dant_${asset.version}_windows_x64_setup.exe`
    ? `${asset.channel}:${asset.version}:${asset.sha256}`
    : null;
const same = (asset: UpdateAsset, result: unknown): result is UpdateAsset =>
  isRecord(result) &&
  result.version === asset.version &&
  result?.channel === asset.channel &&
  result?.sha256 === asset.sha256 &&
  result?.name === asset.name &&
  result.size === asset.size;
export function createNativeUpdates({
  desktop = false,
  getToken = () => '',
  loadCore = () => import('@tauri-apps/api/core'),
  loadEvents = () => import('@tauri-apps/api/event'),
}: NativeUpdateOptions = {}) {
  let closed = false,
    installing = false,
    installSupported = false,
    corePromise: Promise<CoreModule> | null = null,
    readyPromise: Promise<void> | null = null,
    eventPromise: Promise<void> | null = null,
    unlisten: Cleanup | null = null;
  const pending = new Map<string, Promise<UpdatePackage>>(),
    packages = new Map<string, UpdatePackage>(),
    listeners = new Map<
      string,
      { asset: UpdateAsset; callbacks: Set<(progress: UpdateProgress) => void> }
    >();
  const core = () => (corePromise ||= loadCore());
  const token = () => {
    const value = getToken();
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))
      throw Error('The local update session is unavailable.');
    return value;
  };
  function ready() {
    return (readyPromise ||= (async () => {
      if (!desktop || closed) return;
      try {
        const api = await core(),
          result = await api.invoke('update_capabilities');
        if (!closed)
          installSupported =
            isRecord(result) && result.install === true && result.download === true;
      } catch {
        installSupported = false;
      }
    })());
  }
  function events() {
    return (eventPromise ||= (async () => {
      const api = await loadEvents();
      const stop = await api.listen('dant-update-progress', (event) => {
        if (closed) return;
        const result = event?.payload;
        if (
          !isRecord(result) ||
          (result.status !== 'downloading' &&
            result.status !== 'ready' &&
            result.status !== 'failed') ||
          typeof result.channel !== 'string' ||
          typeof result.version !== 'string' ||
          typeof result.sha256 !== 'string'
        )
          return;
        const id = `${result.channel}:${result.version}:${result.sha256}`,
          entry = listeners.get(id);
        if (
          !entry ||
          result.total !== entry.asset.size ||
          !isSafeInteger(result.received) ||
          typeof result.total !== 'number' ||
          result.received < 0 ||
          result.received > result.total
        )
          return;
        for (const callback of entry.callbacks)
          try {
            callback({
              status: result.status,
              channel: result.channel,
              version: result.version,
              sha256: result.sha256,
              received: result.received,
              total: result.total,
            });
          } catch {}
      });
      if (closed) stop();
      else unlisten = stop;
    })());
  }
  async function download(
    asset: UpdateAsset,
    onProgress: (progress: UpdateProgress) => void = () => {},
  ): Promise<UpdatePackage> {
    const selected = { ...asset },
      id = key(selected);
    if (!desktop || closed || !id) throw Error('The verified update download is unavailable.');
    let entry = listeners.get(id);
    if (!entry) {
      entry = { asset: selected, callbacks: new Set() };
      listeners.set(id, entry);
    }
    entry.callbacks.add(onProgress);
    const saved = packages.get(id);
    if (saved) return saved;
    const underway = pending.get(id);
    if (underway) return underway;
    const operation = (async () => {
      await events();
      if (closed) throw Error('The update view is closed.');
      const api = await core(),
        result = await api.invoke('download_update', {
          channel: selected.channel,
          token: token(),
          expectedVersion: selected.version,
        });
      if (
        !isRecord(result) ||
        !result.ready ||
        !same(selected, result) ||
        typeof result.packageId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(result.packageId) ||
        result.packageId !== selected.sha256
      )
        throw Error('The update package identity changed. Check for updates again.');
      const verified: UpdatePackage = { ...selected, ready: true, packageId: result.packageId };
      packages.set(id, verified);
      return verified;
    })().finally(() => pending.delete(id));
    pending.set(id, operation);
    return operation;
  }
  async function install(asset: UpdateAsset) {
    const id = key(asset),
      item = id ? packages.get(id) : undefined;
    await ready();
    if (!desktop || closed || !installSupported || !item || installing)
      throw Error('The verified update installation is unavailable.');
    installing = true;
    try {
      const api = await core(),
        result = await api.invoke('install_update', { packageId: item.packageId, token: token() });
      if (!isRecord(result) || result.launched !== true)
        throw Error('The update handoff was not confirmed.');
      return result;
    } finally {
      installing = false;
    }
  }
  function dispose() {
    closed = true;
    installSupported = false;
    unlisten?.();
    unlisten = null;
    listeners.clear();
  }
  return {
    available: desktop === true,
    get installSupported() {
      return installSupported;
    },
    ready,
    download,
    install,
    dispose,
  };
}
