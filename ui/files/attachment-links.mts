import { canPreviewFile } from './file-preview.mts';
import { isRecord } from '../shared/contracts.mts';
import type { Attachment } from '../shared/contracts.mts';

const controls = /[\x00-\x1f\x7f]/;
function localPath(value: unknown): { path: string | null; relative?: boolean } | null {
  if (typeof value !== 'string') return null;
  let path = value.trim();
  if (!path || path.startsWith('#') || path.startsWith('//')) return null;
  if (controls.test(path)) return { path: null };
  const localScheme = /^(?:file|sandbox|attachment):/i.test(path);
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !localScheme && !/^[a-z]:[/\\]/i.test(path)) return null;
  if (localScheme) {
    if (/^file:/i.test(path)) {
      try {
        const url = new URL(path);
        if ((url.hostname && url.hostname !== 'localhost') || url.search || url.hash)
          return { path: null };
        path = url.pathname;
        if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      } catch {
        return { path: null };
      }
    } else path = path.replace(/^(?:sandbox|attachment):/i, '');
  }
  if (/[?#]/.test(path)) return { path: null };
  try {
    path = decodeURIComponent(path);
  } catch {
    return { path: null };
  }
  if (controls.test(path)) return { path: null };
  path = path.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-z]:\//i.test(path)) return { path };
  if (/^(?:\.\/)?output\//.test(path)) {
    path = path.replace(/^\.\//, '');
    if (path.split('/').some((part) => !part || part === '.' || part === '..'))
      return { path: null };
    return { path, relative: true };
  }
  // Other relative file references must not navigate the webview as app routes.
  return localScheme || path.includes('/') || /\.[a-z\d]{1,16}$/i.test(path)
    ? { path: null }
    : null;
}

export function resolveMessageAttachmentLink<File>(
  href: unknown,
  attachments: readonly File[] = [],
) {
  const reference = localPath(href);
  if (!reference) return { local: false, file: null };
  if (!reference.path) return { local: true, file: null };
  const matches = attachments.filter((file) => {
    if (!isRecord(file) || typeof file.id !== 'string' || typeof file.sourcePath !== 'string')
      return false;
    const source = file.sourcePath.replaceAll('\\', '/');
    if (controls.test(source) || (!source.startsWith('/') && !/^[a-z]:\//i.test(source)))
      return false;
    if (!reference.relative) return source === reference.path;
    const marker = source.lastIndexOf('/output/');
    return marker >= 0 && 'output/' + source.slice(marker + 8) === reference.path;
  });
  return { local: true, file: matches.length === 1 ? matches[0] : null };
}

// Local links open an immutable attachment, with an optional scoped recovery
// of the exact saved reference. Paths never navigate the browser or OS.
export function bindMessageAttachmentLink(
  link: HTMLAnchorElement,
  {
    getMessage,
    onImage,
    onFile,
    onDownload,
    onResolve,
    getScope = () => null,
    getModal = () => null,
    onUnavailable = () => {},
    onError = () => {},
  }: {
    getMessage: (
      id: string,
    ) => { id: string; text?: string; attachments?: Attachment[] } | undefined | null;
    onImage: (file: Attachment) => unknown;
    onFile: (file: Attachment) => unknown;
    onDownload: (file: Attachment) => unknown;
    onResolve?: (reference: {
      messageId: string;
      href: string | null;
    }) => Attachment | null | Promise<Attachment | null>;
    getScope?: () => unknown;
    getModal?: () => unknown;
    onUnavailable?: () => void;
    onError?: (error: unknown) => void;
  },
) {
  const article = link.closest<HTMLElement>('.message[data-id]');
  if (!article) return false;
  const href = link.getAttribute('href'),
    messageId = article.dataset.id;
  if (!messageId) return false;
  if (!resolveMessageAttachmentLink(href, getMessage(messageId)?.attachments).local) return false;
  const button = link.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'attachment-link';
  if (link.title) button.title = link.title;
  button.append(...link.childNodes);
  link.replaceWith(button);
  let pending: Promise<unknown> | null = null;
  const open = (file: Attachment) =>
    String(file.type || '').startsWith('image/')
      ? onImage(file)
      : canPreviewFile(file)
        ? onFile(file)
        : onDownload(file);
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (pending) return pending;
    const message = getMessage(messageId),
      file = resolveMessageAttachmentLink(href, message?.attachments).file;
    if (file) {
      try {
        return Promise.resolve(open(file)).catch(onError);
      } catch (error) {
        onError(error);
        return;
      }
    }
    if (typeof onResolve !== 'function') {
      onUnavailable();
      return;
    }
    const scope = getScope(),
      modal = getModal(),
      text = message?.text;
    const current = () => {
      const latest = getMessage(messageId);
      return !!latest && getScope() === scope && getModal() === modal && latest.text === text;
    };
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    pending = Promise.resolve()
      .then(() => (current() ? onResolve({ messageId, href }) : null))
      .then((restored) => {
        if (!current()) return;
        if (!restored) {
          onUnavailable();
          return;
        }
        return open(restored);
      })
      .catch((error) => {
        if (current()) onError(error);
      })
      .finally(() => {
        pending = null;
        button.disabled = false;
        button.removeAttribute('aria-busy');
      });
    return pending;
  };
  return true;
}
