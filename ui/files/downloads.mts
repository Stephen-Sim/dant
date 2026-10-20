import { isRecord } from '../shared/contracts.mts';
import type { NativeInvoke } from '../platform/transport.mts';
import { MAX_ATTACHMENT_BYTES } from './attachment-limits.mts';
import { NATIVE_PROTOCOL, apiPath } from '../platform/native-protocol.mts';
import type { ScheduleTimer, CancelTimer } from '../shared/contracts.mts';
const MAX_BYTES = MAX_ATTACHMENT_BYTES;
import type { Attachment, Timer } from '../shared/contracts.mts';
interface DownloadFetchOptions {
  headers: { 'X-Dant-Token': string };
  redirect: 'error';
  credentials: 'omit';
  signal: AbortSignal;
}
interface DownloadWindow {
  addEventListener(type: 'beforeunload', listener: () => void): void;
  removeEventListener(type: 'beforeunload', listener: () => void): void;
}
interface DownloadsOptions {
  desktop?: boolean;
  base?: string;
  getToken?: () => string;
  fetchImpl?: (
    url: string,
    options: DownloadFetchOptions,
  ) => Promise<
    Pick<Response, 'ok' | 'redirected' | 'headers'> & {
      body?: ReadableStream<Uint8Array<ArrayBuffer>> | null;
    }
  >;
  loadCore?: () => Promise<{ invoke: NativeInvoke }>;
  document?: Document;
  URLImpl?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  window?: DownloadWindow;
  schedule?: ScheduleTimer;
  cancel?: CancelTimer;
  timeoutMs?: number;
}
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failed = () =>
  Object.assign(Error('The attachment could not be saved. Please try again.'), {
    code: 'download_failed',
  });
export function attachmentName(value: unknown) {
  let name = String(value || '')
    .split(/[\\/]/)
    .at(-1)!
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (!name) return 'download';
  const characters = [...name];
  if (characters.length > 180) {
    const extension = /\.[a-z0-9]{1,16}$/i.exec(name)?.[0] || '';
    name = characters.slice(0, 180 - extension.length).join('') + extension;
  }
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\s*(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
export function createDownloads({
  desktop = Boolean(globalThis.window?.__TAURI_INTERNALS__),
  base = '',
  getToken = () => '',
  fetchImpl = fetch,
  loadCore = () => import('@tauri-apps/api/core'),
  document = globalThis.document,
  URLImpl = globalThis.URL,
  window = globalThis.window,
  schedule = setTimeout,
  cancel = clearTimeout,
  timeoutMs = 60000,
}: DownloadsOptions = {}) {
  const pending = new Map<string, Promise<{ saved: boolean }>>(),
    controllers = new Set<AbortController>(),
    urls = new Map<string, Timer>();
  let closed = false;
  async function run(file: { id: string; name?: unknown }) {
    const token = getToken(),
      fileName = attachmentName(file.name);
    if (!/^[0-9a-f]{64}$/i.test(token) || !['', NATIVE_PROTOCOL.httpOrigin].includes(base))
      throw failed();
    if (desktop) {
      try {
        const { invoke } = await loadCore();
        if (closed) throw failed();
        const saved = await invoke('save_attachment', { fileId: file.id, token, fileName });
        if (typeof saved !== 'boolean') throw failed();
        return { saved };
      } catch {
        throw failed();
      }
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = schedule(() => controller.abort(), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
    try {
      const response = await fetchImpl(
        base + apiPath('/files/' + encodeURIComponent(file.id)) + '?download=1',
        {
          headers: { 'X-Dant-Token': token },
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal,
        },
      );
      if (
        closed ||
        controller.signal.aborted ||
        !response.ok ||
        response.redirected ||
        Number(response.headers.get('content-length')) > MAX_BYTES
      )
        throw failed();
      reader = response.body?.getReader();
      if (!reader) throw failed();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (closed || controller.signal.aborted || size > MAX_BYTES) throw failed();
        chunks.push(chunk.value);
      }
      if (closed || controller.signal.aborted) throw failed();
      const blob = new Blob(chunks, {
          type: response.headers.get('content-type') || 'application/octet-stream',
        }),
        url = URLImpl.createObjectURL(blob),
        link = document.createElement('a');
      let removal;
      try {
        link.href = url;
        link.download = fileName;
        link.hidden = true;
        document.body.append(link);
        link.click();
        removal = schedule(() => {
          URLImpl.revokeObjectURL(url);
          urls.delete(url);
        }, 1000);
        urls.set(url, removal);
      } catch {
        URLImpl.revokeObjectURL(url);
        throw failed();
      } finally {
        link.remove();
      }
      return { saved: true };
    } catch {
      throw failed();
    } finally {
      cancel(timer);
      controllers.delete(controller);
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  function save(file: unknown): Promise<{ saved: boolean }> {
    if (closed || !isRecord(file) || typeof file.id !== 'string' || !idPattern.test(file.id))
      return Promise.reject(failed());
    const fileId = file.id,
      previous = pending.get(fileId);
    if (previous) return previous;
    const operation = run({ id: fileId, name: file.name }).finally(() => {
      if (pending.get(fileId) === operation) pending.delete(fileId);
    });
    pending.set(fileId, operation);
    return operation;
  }
  function bind(
    getFile: (id: string | undefined) => Attachment | null | undefined,
    onError: (error: Error) => void = () => {},
  ) {
    document.querySelectorAll<HTMLButtonElement>('[data-download]').forEach((node) => {
      node.disabled = closed || pending.has(node.dataset.download || '');
      node.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        node.disabled = true;
        try {
          await save(getFile(node.dataset.download));
        } catch {
          onError(failed());
        } finally {
          if (node.isConnected) node.disabled = false;
        }
      };
    });
  }
  function dispose() {
    if (closed) return;
    closed = true;
    for (const controller of controllers) controller.abort();
    for (const [url, timer] of urls) {
      cancel(timer);
      URLImpl.revokeObjectURL(url);
    }
    urls.clear();
    window?.removeEventListener?.('beforeunload', dispose);
  }
  window?.addEventListener?.('beforeunload', dispose);
  return { save, bind, dispose };
}
