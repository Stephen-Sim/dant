import { translate } from '../../src/i18n/i18n.mts';
import { escapeHtml } from '../shared/html.mts';
import { isRecord } from '../shared/contracts.mts';

export const RECENT_MESSAGE_LIMIT = 80;
export const OLDER_MESSAGE_BATCH_SIZE = 80;
const HISTORY_LOAD_THRESHOLD_PX = 160;
const BOTTOM_TOLERANCE_PX = 2;

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

export function createMessageWindow() {
  let scope: unknown,
    firstId: string | null = null,
    start = 0,
    expanded = false,
    viewport: HTMLElement | null = null,
    viewportScope: unknown,
    load: (() => void) | null = null,
    loading = false;
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
        ? `<div class="message-history-more"><button type="button" class="text-btn" data-load-older>${escapeHtml(translate(language, 'Load earlier messages', '加载更早的消息'))}</button></div>`
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
      if (next !== viewport) {
        detach();
        viewport = next;
        viewport?.addEventListener('scroll', scrolled, { passive: true });
      }
      load = onLoad;
      viewportScope = scope;
      const button = viewport?.querySelector<HTMLButtonElement>('[data-load-older]');
      if (button) button.onclick = onLoad;
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
