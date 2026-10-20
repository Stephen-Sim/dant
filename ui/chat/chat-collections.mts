import { escapeHtml as escape } from '../shared/html.mts';
import { isRecord, isAttachment, requestError } from '../shared/contracts.mts';
import type {
  ApiRequest,
  Attachment,
  ChatMessage,
  UiModal,
  UiState,
} from '../shared/contracts.mts';
import { localizeMessages } from '../i18n/messages.mts';
import { languageInfo } from '../i18n/languages.mts';
import { collectionMessages } from './chat-collections-copy.mts';
import { formatMessageTime } from './render-cache.mts';
import { ConnectionStatus } from '../shared/states.mts';

const COLLECTION_PAGE_SIZE = 50;
const MAX_MESSAGE_LINKS = 100;
type CollectionKind = 'starred' | 'shared';
type SharedKind = 'media' | 'docs' | 'links';
type MetadataFlag = 'pinned' | 'starred';
interface CollectionOptions {
  document: Document;
  getState: () => UiState | null;
  getModal: () => UiModal | null;
  connected: () => boolean;
  request: ApiRequest;
  render: () => void;
  toast: (message: string) => void;
  openModal: (modal: UiModal) => void;
  closeModal: () => void;
  closeMessageMenu?: () => void;
  revealMessage: (id: string) => void;
  navigate?: (action: () => void) => void;
  openFile: (file: Attachment, download: boolean) => unknown;
  openLink: (url: string) => unknown;
  icon?: (name: string) => string;
}
export function messageLinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let raw = match[0].replace(/[.,;!?]+$/, '');
    for (const [opening, closing] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ] as const)
      while (raw.endsWith(closing) && raw.split(closing).length > raw.split(opening).length)
        raw = raw.slice(0, -1);
    try {
      const url = new URL(raw);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
        links.add(url.href);
    } catch {
      /* Invalid text stays plain text. */
    }
    if (links.size === MAX_MESSAGE_LINKS) break;
  }
  return [...links];
}
const publicMessage = (message: ChatMessage) =>
  message.role === 'user' || message.role === 'assistant';
const ownedFiles = (message: ChatMessage) => (message.attachments ?? []).filter(isAttachment);
const mediaFile = (file: Attachment) => /^(?:image|audio|video)\//i.test(file.type);
const viewKind = (value: unknown): value is CollectionKind =>
  value === 'starred' || value === 'shared';
const sharedKind = (value: unknown): value is SharedKind =>
  value === 'media' || value === 'docs' || value === 'links';

/** Browses current public records; metadata writes never send agent input or read receipts. */
export function createChatCollections({
  document,
  getState,
  getModal,
  connected,
  request,
  render,
  toast,
  openModal,
  closeModal,
  closeMessageMenu = () => {},
  revealMessage,
  navigate = (action) => action(),
  openFile,
  openLink,
  icon = () => '',
}: CollectionOptions) {
  let menuOpen = false,
    tab: SharedKind = 'media',
    limit = COLLECTION_PAGE_SIZE,
    pinnedSelection: string | null = null,
    generation = 0,
    scope = '',
    sequence = 0;
  const pending = new Map<string, number>();
  const copy = () => localizeMessages(collectionMessages, getState()?.settings?.language);
  const messages = () => (getState()?.messages ?? []).filter(publicMessage);
  const currentScope = () => {
    const state = getState(),
      vm = state?.settings?.vm;
    return JSON.stringify([
      state?.conversationId ?? null,
      vm?.host ?? null,
      vm?.user ?? null,
      vm?.port ?? null,
      vm?.keyPath ?? null,
      vm?.knownHosts ?? null,
      vm?.provider ?? null,
      connected(),
    ]);
  };
  function synchronize() {
    const next = currentScope();
    if (next !== scope) {
      scope = next;
      generation++;
      menuOpen = false;
      pending.clear();
      limit = COLLECTION_PAGE_SIZE;
      pinnedSelection = null;
    }
  }
  const online = () =>
    connected() &&
    getState()?.controller?.cached !== true &&
    (getState()?.controller
      ? getState()?.controller?.status === ConnectionStatus.Online
      : getState()?.worker?.status === ConnectionStatus.Online);
  const snippet = (message: ChatMessage) =>
    (
      message.text ||
      ownedFiles(message)
        .map((file) => file.name)
        .join(', ')
    ).slice(0, 240);
  const action = (label: string, attributes: string, disabled = false) =>
    `<button type="button" class="text-btn" ${attributes} ${disabled ? 'disabled' : ''}>${escape(label)}</button>`;
  const removeAction = (message: ChatMessage, flag: MetadataFlag, attribute: string) => {
    if (message[flag] !== true) return '';
    const label = flag === 'pinned' ? copy().unpin : copy().unstar;
    return `<button type="button" class="text-btn chat-collection-remove" data-key="remove-${flag}-${escape(message.id)}" ${attribute}="${escape(message.id)}" aria-label="${escape(label)}" title="${escape(label)}" ${!online() || pending.has(message.id) ? 'disabled' : ''}>${icon('x')}<span>${escape(label)}</span></button>`;
  };
  function messageTime(message: ChatMessage) {
    if (typeof message.time !== 'number' || !Number.isFinite(message.time) || message.time <= 0)
      return '';
    const date = new Date(message.time);
    if (!Number.isFinite(date.getTime())) return '';
    const text = formatMessageTime(date, languageInfo(getState()?.settings?.language).locale, true);
    return `<time datetime="${escape(date.toISOString())}">${escape(text)}</time>`;
  }
  function renderMenu() {
    synchronize();
    if (getModal()) menuOpen = false;
    if (!menuOpen) return '';
    const tr = copy();
    return `<div class="chat-header-menu" role="menu" aria-label="${escape(tr.menu)}" data-chat-header-menu data-key="chat-header-menu">${action(tr.starred, 'role="menuitem" data-chat-collection="starred"')}${action(tr.search, 'role="menuitem" data-chat-search')}${action(tr.shared, 'role="menuitem" data-chat-collection="shared"')}</div>`;
  }
  function toggleMenu() {
    synchronize();
    menuOpen = !menuOpen;
    closeMessageMenu();
    render();
    if (menuOpen)
      document.querySelector<HTMLElement>('[data-chat-header-menu] [role="menuitem"]')?.focus();
  }
  function renderMessageActions(message: Pick<ChatMessage, 'id' | 'role' | 'pinned' | 'starred'>) {
    synchronize();
    if (message.role !== 'user' && message.role !== 'assistant') return '';
    const tr = copy(),
      disabled = !online() || pending.has(message.id);
    return (
      action(
        message.pinned ? tr.unpin : tr.pin,
        `role="menuitem" data-message-pin="${escape(message.id)}"`,
        disabled,
      ) +
      action(
        message.starred ? tr.unstar : tr.star,
        `role="menuitem" data-message-star="${escape(message.id)}"`,
        disabled,
      )
    );
  }
  function renderMarkers(message: Pick<ChatMessage, 'role' | 'pinned' | 'starred'>) {
    if (message.role !== 'user' && message.role !== 'assistant') return '';
    const tr = copy();
    return `${message.pinned ? `<span class="message-marker" title="${escape(tr.pinned)}" aria-label="${escape(tr.pinned)}">${icon('pin') || '⌖'}</span>` : ''}${message.starred ? `<span class="message-marker" title="${escape(tr.starred)}" aria-label="${escape(tr.starred)}">${icon('star') || '★'}</span>` : ''}`;
  }
  function renderPinnedBar() {
    synchronize();
    const pinned = messages().filter((message) => message.pinned === true),
      selected = pinned.find((message) => message.id === pinnedSelection) ?? pinned.at(-1),
      tr = copy();
    if (!selected) return '';
    const number = new Intl.NumberFormat(languageInfo(getState()?.settings?.language).locale),
      index = pinned.indexOf(selected);
    return `<section class="chat-pinned-bar" data-key="chat-pinned-bar" aria-label="${escape(tr.pinned)}"><button type="button" class="chat-pinned-preview" data-collection-go="${escape(selected.id)}" aria-label="${escape(tr.go)}">${icon('pin') || '⌖'}<span><strong>${escape(tr.pinned)}</strong><small>${escape(snippet(selected))}</small></span></button>${pinned.length > 1 ? `<button type="button" class="text-btn" data-pin-next aria-label="${escape(tr.nextPin)}">${number.format(index + 1)} / ${number.format(pinned.length)}${icon('chevron-down')}</button>` : ''}${removeAction(selected, 'pinned', 'data-pin-remove')}</section>`;
  }
  async function setFlag(id: string | undefined, flag: MetadataFlag, desired?: boolean) {
    synchronize();
    const state = getState(),
      message = messages().find((item) => item.id === id);
    if (!online()) {
      toast(copy().offline);
      return;
    }
    if (!message || !state?.conversationId || pending.has(message.id)) return;
    if (desired === false && message[flag] !== true) return;
    const operation = ++sequence,
      owner = generation,
      ownerScope = scope,
      conversationId = state.conversationId;
    pending.set(message.id, operation);
    render();
    try {
      const result: unknown = await request(
        '/messages/' + encodeURIComponent(message.id) + '/metadata',
        {
          method: 'PATCH',
          body: { conversationId, [flag]: desired ?? message[flag] !== true },
          beforeSend: () => {
            synchronize();
            return (
              owner === generation &&
              ownerScope === scope &&
              pending.get(message.id) === operation &&
              online() &&
              messages().filter((item) => item.id === message.id).length === 1
            );
          },
        },
      );
      synchronize();
      if (owner !== generation || ownerScope !== scope || pending.get(message.id) !== operation)
        return;
      if (
        !isRecord(result) ||
        result.conversationId !== conversationId ||
        !isRecord(result.message) ||
        result.message.id !== message.id ||
        typeof result.message.pinned !== 'boolean' ||
        typeof result.message.starred !== 'boolean'
      )
        throw Error('Invalid message metadata');
      const value = result.message[flag];
      if (typeof value !== 'boolean') throw Error('Invalid message flag');
      const current = messages().find((item) => item.id === message.id);
      if (!current || (current !== message && current[flag] !== value)) return;
      current[flag] = value;
      closeMessageMenu();
    } catch (cause) {
      synchronize();
      if (owner === generation && ownerScope === scope) {
        const failure = requestError(cause);
        toast(
          failure.unknownOutcome || failure.status === undefined || failure.status >= 500
            ? copy().unconfirmed
            : copy().failed,
        );
      }
    } finally {
      if (pending.get(message.id) === operation) {
        pending.delete(message.id);
        render();
      }
    }
  }
  async function removeFlag(node: HTMLElement, flag: MetadataFlag, id: string | undefined) {
    const owner = generation,
      modal = getModal(),
      restoreFocus = document.activeElement === node;
    await setFlag(id, flag, false);
    synchronize();
    if (
      !restoreFocus ||
      owner !== generation ||
      modal !== getModal() ||
      (document.activeElement &&
        document.activeElement !== document.body &&
        document.activeElement !== node)
    )
      return;
    const target = node.isConnected
      ? node
      : modal
        ? (document.querySelector<HTMLElement>('.chat-collection-dialog [data-collection-go]') ??
          document.querySelector<HTMLElement>(
            '.chat-collection-dialog [data-action="close-modal"]',
          ))
        : (document.querySelector<HTMLElement>('.chat-pinned-preview') ??
          document.querySelector<HTMLElement>('.header-actions [data-action="details"]'));
    target?.focus({ preventScroll: true });
  }
  function go(id: string | undefined) {
    synchronize();
    if (!id || !messages().some((message) => message.id === id)) return;
    menuOpen = false;
    if (getModal()) closeModal();
    revealMessage(id);
    const target = [
      ...document.querySelectorAll<HTMLElement>('.message[data-id],.call-log[data-id]'),
    ].find((node) => node.dataset.id === id);
    navigate(() => target?.scrollIntoView({ block: 'center', behavior: 'auto' }));
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }
  function renderModal(modal: UiModal | null) {
    synchronize();
    if (modal?.type !== 'chat-collection' || !viewKind(modal.key)) return null;
    const tr = copy(),
      kind = modal.key,
      selected = messages()
        .filter((message) =>
          kind === 'shared'
            ? tab === 'links'
              ? messageLinks(message.text).length > 0
              : ownedFiles(message).some((file) =>
                  tab === 'media' ? mediaFile(file) : !mediaFile(file),
                )
            : message[kind] === true,
        )
        .toReversed(),
      items = selected
        .slice(0, limit)
        .map((message) => {
          const files =
            kind === 'shared' && tab !== 'links'
              ? ownedFiles(message).filter((file) =>
                  tab === 'media' ? mediaFile(file) : !mediaFile(file),
                )
              : [];
          const links = kind === 'shared' && tab === 'links' ? messageLinks(message.text) : [];
          return `<article class="chat-collection-item" data-key="collection-${escape(message.id)}"><div class="chat-collection-meta"><strong>${message.role === 'user' ? escape(tr.you) : 'dant'}</strong>${messageTime(message)}</div><p class="chat-collection-message">${escape(snippet(message))}</p>${files.map((file) => `<div class="chat-collection-file"><span>${escape(file.name)}</span>${action(tr.open, `data-collection-file="${escape(file.id)}" data-collection-message="${escape(message.id)}"`)}${action(tr.download, `data-collection-download="${escape(file.id)}" data-collection-message="${escape(message.id)}"`)}</div>`).join('')}${links.map((url) => action(url, `data-collection-link="${escape(url)}" data-collection-message="${escape(message.id)}"`)).join('')}<div class="chat-collection-footer">${action(tr.go, `data-collection-go="${escape(message.id)}"`)}<div class="chat-collection-actions">${removeAction(message, 'pinned', 'data-collection-unpin')}${removeAction(message, 'starred', 'data-collection-unstar')}</div></div></article>`;
        })
        .join('');
    const emptyIcon =
      kind === 'starred'
        ? 'star'
        : tab === 'media'
          ? 'paperclip'
          : tab === 'docs'
            ? 'file-text'
            : 'external-link';
    return `<div class="modal-backdrop" data-key="chat-collection-${kind}"><section class="dialog chat-collection-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><h2 id="dialog-title">${escape(tr[kind])}</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="${escape(tr.close)}">${icon('x') || '×'}</button></div><div class="dialog-body">${kind === 'shared' ? `<div class="chat-collection-tabs" role="group" aria-label="${escape(tr.shared)}">${(['media', 'docs', 'links'] as const).map((value) => action(tr[value], `data-collection-tab="${value}" aria-pressed="${tab === value}"`)).join('')}</div>` : ''}<div class="chat-collection-list">${items || `<div class="chat-collection-empty" role="status"><span aria-hidden="true">${icon(emptyIcon) || (kind === 'starred' ? '☆' : '')}</span><h3>${escape(kind === 'starred' ? tr.emptyStarred : tr.empty)}</h3>${kind === 'starred' ? `<p>${escape(tr.starHint)}</p>` : ''}</div>`}</div>${selected.length > limit ? action(tr.more, 'data-collection-more') : ''}</div></section></div>`;
  }
  function bind() {
    synchronize();
    const bindingGeneration = generation;
    const click = (selector: string, handler: (node: HTMLElement) => unknown) =>
      document.querySelectorAll<HTMLElement>(selector).forEach((node) => {
        node.onclick = () => {
          synchronize();
          if (bindingGeneration !== generation) return;
          return Promise.resolve(handler(node)).catch(() => toast(copy().failed));
        };
      });
    document
      .querySelectorAll<HTMLElement>('.header-actions [data-action="details"]')
      .forEach((node) => {
        node.setAttribute('aria-haspopup', 'menu');
        node.setAttribute('aria-expanded', String(menuOpen));
        node.setAttribute('aria-label', copy().menu);
      });
    click('[data-chat-collection]', (node) => {
      const kind = node.dataset.chatCollection;
      if (!viewKind(kind)) return;
      menuOpen = false;
      limit = COLLECTION_PAGE_SIZE;
      openModal({ type: 'chat-collection', key: kind });
    });
    click('[data-message-pin]', (node) => setFlag(node.dataset.messagePin, 'pinned'));
    click('[data-message-star]', (node) => setFlag(node.dataset.messageStar, 'starred'));
    click('[data-pin-remove]', (node) => removeFlag(node, 'pinned', node.dataset.pinRemove));
    click('[data-collection-unpin]', (node) =>
      removeFlag(node, 'pinned', node.dataset.collectionUnpin),
    );
    click('[data-collection-unstar]', (node) =>
      removeFlag(node, 'starred', node.dataset.collectionUnstar),
    );
    click('[data-collection-go]', (node) => go(node.dataset.collectionGo));
    click('[data-pin-next]', () => {
      const pinned = messages().filter((message) => message.pinned === true),
        index = pinned.findIndex((message) => message.id === pinnedSelection),
        current = index < 0 ? pinned.length - 1 : index;
      pinnedSelection = pinned[(current + 1) % pinned.length]?.id ?? null;
      render();
    });
    click('[data-collection-tab]', (node) => {
      if (sharedKind(node.dataset.collectionTab)) {
        tab = node.dataset.collectionTab;
        limit = COLLECTION_PAGE_SIZE;
        render();
      }
    });
    click('[data-collection-more]', () => {
      limit += COLLECTION_PAGE_SIZE;
      render();
    });
    const fileAction = (node: HTMLElement, download: boolean) => {
      const file = messages()
        .find((message) => message.id === node.dataset.collectionMessage)
        ?.attachments?.find(
          (file) =>
            file.id === (download ? node.dataset.collectionDownload : node.dataset.collectionFile),
        );
      if (file && isAttachment(file)) return openFile(file, download);
    };
    click('[data-collection-file]', (node) => fileAction(node, false));
    click('[data-collection-download]', (node) => fileAction(node, true));
    click('[data-collection-link]', (node) => {
      const message = messages().find((item) => item.id === node.dataset.collectionMessage),
        url = node.dataset.collectionLink;
      if (message && url && messageLinks(message.text).includes(url)) return openLink(url);
    });
    const menu = document.querySelector<HTMLElement>('[data-chat-header-menu]');
    if (menu)
      menu.onkeydown = (event) => {
        const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')],
          current = items.indexOf(document.activeElement as HTMLElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          items[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          ]?.focus();
        }
      };
  }
  function onPointer(event: PointerEvent) {
    const target = event.target;
    if (
      !menuOpen ||
      !target ||
      !('closest' in target) ||
      typeof target.closest !== 'function' ||
      target.closest('[data-chat-header-menu],.header-actions [data-action="details"]')
    )
      return;
    menuOpen = false;
    render();
  }
  function onKey(event: KeyboardEvent) {
    if (menuOpen && event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      menuOpen = false;
      render();
      document.querySelector<HTMLElement>('.header-actions [data-action="details"]')?.focus();
    }
  }
  document.addEventListener('pointerdown', onPointer);
  document.addEventListener('keydown', onKey);
  return {
    renderMenu,
    toggleMenu,
    renderMessageActions,
    renderMarkers,
    renderPinnedBar,
    renderModal,
    bind,
    onClose() {
      menuOpen = false;
    },
    dispose() {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      pending.clear();
      generation++;
    },
  };
}
