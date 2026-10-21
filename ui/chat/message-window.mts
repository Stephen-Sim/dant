import { translate } from '../i18n/messages.mts';
import { escapeHtml } from '../shared/html.mts';
import { isRecord } from '../shared/contracts.mts';

export const RECENT_MESSAGE_LIMIT = 80;
export const OLDER_MESSAGE_BATCH_SIZE = 80;
const HISTORY_LOAD_THRESHOLD_PX = 160;
const BOTTOM_TOLERANCE_PX = 2;
interface HistoryObserver {
  observe(target: Element): void;
  disconnect(): void;
}
interface MessageWindowOptions {
  IntersectionObserver?:
    | (new (
        callback: (entries: readonly { target: Element; isIntersecting: boolean }[]) => void,
        options: { root: Element; rootMargin: string; threshold: number },
      ) => HistoryObserver)
    | null;
}

export function messageHistoryScope(state: unknown): string {
  const settings = isRecord(state) && isRecord(state.settings) ? state.settings : null,
    vm = settings && isRecord(settings.vm) ? settings.vm : null;
  return JSON.stringify([
    isRecord(state) && typeof state.conversationId === 'string' ? state.conversationId : null,
    vm?.host ?? null,
    vm?.user ?? null,
    vm?.port ?? null,
    vm?.keyPath ?? null,
  ]);
}

export function createMessageWindow({
  IntersectionObserver = globalThis.IntersectionObserver,
}: MessageWindowOptions = {}) {
  let scope: unknown,
    firstId: string | null = null,
    start = 0,
    expanded = false,
    viewport: HTMLElement | null = null,
    viewportScope: unknown,
    load: (() => void) | null = null,
    loading = false,
    generation = 0,
    sentinel: Element | null = null,
    observer: HistoryObserver | null = null;
  function synchronize(messages: readonly { id: string }[], currentScope: unknown) {
    const previous =
      firstId === null ? -1 : messages.findIndex((message) => message.id === firstId);
    if (scope !== currentScope || previous < 0) {
      scope = currentScope;
      expanded = false;
      start = Math.max(0, messages.length - RECENT_MESSAGE_LIMIT);
    } else {
      if (
        viewport &&
        viewportScope === currentScope &&
        viewport.clientHeight > 0 &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > BOTTOM_TOLERANCE_PX
      )
        expanded = true;
      start = expanded ? previous : Math.max(0, messages.length - RECENT_MESSAGE_LIMIT);
    }
    firstId = messages[start]?.id ?? null;
  }
  function loadOlder(messages: readonly { id: string }[], currentScope: unknown): boolean {
    synchronize(messages, currentScope);
    if (!start) return false;
    expanded = true;
    start = Math.max(0, start - OLDER_MESSAGE_BATCH_SIZE);
    firstId = messages[start]?.id ?? null;
    return true;
  }
  function scrolled() {
    if (
      !viewport ||
      loading ||
      viewportScope !== scope ||
      !start ||
      viewport.scrollTop > HISTORY_LOAD_THRESHOLD_PX ||
      viewport.scrollHeight <= viewport.clientHeight
    )
      return;
    loading = true;
    try {
      load?.();
    } finally {
      loading = false;
    }
  }
  function detach() {
    generation++;
    observer?.disconnect();
    observer = null;
    sentinel = null;
    viewport?.removeEventListener('scroll', scrolled);
    viewport = null;
    viewportScope = undefined;
    load = null;
  }
  return {
    select<Message extends { id: string }>(
      messages: readonly Message[],
      currentScope: unknown,
    ): readonly Message[] {
      synchronize(messages, currentScope);
      return messages.slice(start);
    },
    control(messages: readonly { id: string }[], currentScope: unknown, language: unknown): string {
      synchronize(messages, currentScope);
      return start
        ? `<div class="message-history-more" data-key="message-history-more"><button type="button" class="message-history-load" data-load-older><span aria-hidden="true">↑</span>${escapeHtml(translate(language, 'Load earlier messages', '加载更早的消息'))}</button></div>`
        : '';
    },
    loadOlder,
    reveal(id: string, messages: readonly { id: string }[], currentScope: unknown): boolean {
      synchronize(messages, currentScope);
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0) return false;
      if (index < start) {
        expanded = true;
        start = index;
        firstId = id;
      }
      return true;
    },
    bind(next: HTMLElement | null, onLoad: () => void) {
      if (next !== viewport || viewportScope !== scope) {
        detach();
        viewport = next;
        viewportScope = scope;
        viewport?.addEventListener('scroll', scrolled, { passive: true });
      }
      load = onLoad;
      const owner = viewport,
        ownerScope = scope,
        epoch = generation,
        current = () =>
          epoch === generation &&
          viewport === owner &&
          viewportScope === ownerScope &&
          scope === ownerScope,
        nextSentinel = viewport?.querySelector('.message-history-more') ?? null;
      if (nextSentinel !== sentinel) {
        observer?.disconnect();
        observer = null;
        sentinel = nextSentinel;
        if (IntersectionObserver && viewport && sentinel) {
          const target = sentinel;
          observer = new IntersectionObserver(
            (entries) => {
              if (
                current() &&
                sentinel === target &&
                entries.some((entry) => entry.target === target && entry.isIntersecting)
              )
                scrolled();
            },
            { root: viewport, rootMargin: `${HISTORY_LOAD_THRESHOLD_PX}px 0px 0px`, threshold: 0 },
          );
          observer.observe(target);
        }
      }
      const button = viewport?.querySelector<HTMLButtonElement>('[data-load-older]');
      if (button)
        button.onclick = () => {
          if (current() && !loading && viewport?.querySelector('[data-load-older]') === button)
            onLoad();
        };
    },
    dispose() {
      detach();
      scope = undefined;
      firstId = null;
      start = 0;
      expanded = false;
    },
  };
}
