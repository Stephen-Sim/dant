import { MAX_ATTACHMENT_BYTES } from '../files/attachment-limits.mts';
import type { Attachment } from '../shared/contracts.mts';
import { isRecord } from '../shared/contracts.mts';
import { messageHistoryScope } from './message-window.mts';

export const MAX_COMPOSER_ATTACHMENTS = 5;
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};
interface ClipboardImages {
  files?: ArrayLike<File>;
  items?: ArrayLike<Pick<DataTransferItem, 'kind' | 'type' | 'getAsFile'>>;
}
interface ComposerAttachmentOptions {
  getScope: () => string;
  isReady: () => boolean;
  getAttachments: () => readonly Attachment[];
  request: (file: File, signal: AbortSignal) => Promise<Attachment>;
  add: (attachment: Attachment) => void;
  setUploading: (count: number) => void;
  render: () => void;
  error: (key: 'fileLimit' | 'attachmentLimit') => string;
  unavailable: () => string;
  failed: (error: unknown) => void;
}

export function composerAttachmentScope(state: unknown): string {
  const settings = isRecord(state) && isRecord(state.settings) ? state.settings : null,
    vm = settings && isRecord(settings.vm) ? settings.vm : null;
  return JSON.stringify([messageHistoryScope(state), vm?.knownHosts ?? null, vm?.provider ?? null]);
}

export function clipboardImages(data: ClipboardImages | null): File[] {
  if (!data) return [];
  const candidates: { file: File; type: string }[] = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file' || !IMAGE_MIME.test(item.type)) continue;
    const file = item.getAsFile();
    if (file && (!file.type || IMAGE_MIME.test(file.type)))
      candidates.push({ file, type: file.type || item.type });
  }
  if (!candidates.length)
    for (const file of Array.from(data.files || []))
      if (IMAGE_MIME.test(file.type)) candidates.push({ file, type: file.type });
  const seen = new Set<File>();
  return candidates.flatMap(({ file, type }, index) => {
    if (!file.size || seen.has(file)) return [];
    seen.add(file);
    if (file.name && file.type) return [file];
    const name = file.name || `image-${index + 1}.${IMAGE_EXTENSIONS[type.toLowerCase()] || 'img'}`;
    return [new File([file], name, { type, lastModified: file.lastModified })];
  });
}

export function createComposerAttachments(options: ComposerAttachmentOptions) {
  const pending = new Set<AbortController>(),
    pasteTimers = new Set<ReturnType<typeof setTimeout>>();
  let scope: string | undefined,
    ready = false,
    generation = 0,
    disposed = false,
    composer: HTMLTextAreaElement | null = null,
    paste: ((event: ClipboardEvent) => void) | null = null;

  function sync() {
    const nextScope = options.getScope(),
      nextReady = !disposed && options.isReady();
    if (scope !== nextScope || ready !== nextReady) {
      scope = nextScope;
      ready = nextReady;
      generation++;
      for (const timer of pasteTimers) clearTimeout(timer);
      pasteTimers.clear();
      for (const controller of pending) controller.abort();
      pending.clear();
      options.setUploading(0);
    }
    return generation;
  }
  const current = (owner: number) => sync() === owner && ready;

  async function upload(file: File): Promise<void> {
    const owner = sync();
    if (!ready) throw Error(options.unavailable());
    if (file.size > MAX_ATTACHMENT_BYTES) throw Error(options.error('fileLimit'));
    if (options.getAttachments().length + pending.size >= MAX_COMPOSER_ATTACHMENTS)
      throw Error(options.error('attachmentLimit'));
    const controller = new AbortController();
    pending.add(controller);
    options.setUploading(pending.size);
    options.render();
    try {
      if (!current(owner)) return;
      const item = await options.request(file, controller.signal);
      if (
        current(owner) &&
        !options.getAttachments().some((attachment) => attachment.id === item.id)
      )
        options.add(item);
    } catch (error) {
      if (current(owner)) throw error;
    } finally {
      if (pending.delete(controller)) {
        options.setUploading(pending.size);
        options.render();
      }
    }
  }
  async function uploadFiles(files: readonly File[], owner = sync()) {
    if (!current(owner)) {
      if (generation === owner) options.failed(Error(options.unavailable()));
      return;
    }
    const available = Math.max(
      0,
      MAX_COMPOSER_ATTACHMENTS - options.getAttachments().length - pending.size,
    );
    if (files.length > available) options.failed(Error(options.error('attachmentLimit')));
    for (const file of files.slice(0, available)) {
      if (!current(owner)) {
        return;
      }
      if (options.getAttachments().length + pending.size >= MAX_COMPOSER_ATTACHMENTS) {
        options.failed(Error(options.error('attachmentLimit')));
        return;
      }
      try {
        await upload(file);
      } catch (error) {
        if (current(owner)) options.failed(error);
      }
    }
  }
  function bind(input: HTMLTextAreaElement | null) {
    sync();
    if (composer === input) return;
    if (composer && paste) composer.removeEventListener('paste', paste);
    composer = input;
    paste = null;
    if (!composer) return;
    const target = composer;
    paste = (event) => {
      if (disposed || composer !== target) return;
      const files = clipboardImages(event.clipboardData);
      if (!files.length) return;
      if (!event.clipboardData?.getData('text/plain')) event.preventDefault();
      const owner = sync();
      // The next task runs after the browser's native text paste default action.
      const timer = setTimeout(() => {
        pasteTimers.delete(timer);
        void uploadFiles(files, owner);
      }, 0);
      pasteTimers.add(timer);
    };
    target.addEventListener('paste', paste);
  }
  function dispose() {
    disposed = true;
    bind(null);
  }
  return { bind, sync, upload, uploadFiles, dispose };
}
