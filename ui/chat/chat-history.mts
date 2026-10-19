import { escapeHtml as esc } from '../shared/html.mts';
import { isRecord } from '../shared/contracts.mts';
import type {
  ApiRequest,
  ApiOptions,
  ChatMessage,
  UiModal,
  UiState,
} from '../shared/contracts.mts';
import type { searchMessages as SearchMessages } from './chat-search.mts';
export interface HistoryMessage extends Omit<ChatMessage, 'attachments'> {
  attachments?: { name: string }[];
}
interface SpeechState {
  active: boolean;
  disabled: boolean;
}
interface ChatHistoryOptions {
  getState: () => (Pick<UiState, 'settings' | 'worker'> & { messages?: HistoryMessage[] }) | null;
  request: ApiRequest;
  render: () => void;
  toast: (message: string) => void;
  openModal: (modal: UiModal) => void;
  closeModal: () => void;
  revealMessage?: (id: string) => void;
  navigate?: (action: () => void) => void;
  document?: Document;
  connected?: () => boolean;
  callActive?: () => boolean;
  searchMessages: typeof SearchMessages;
  icon?: (name: string) => string;
  getSpeechState?: (message: HistoryMessage) => unknown;
  onReadAloud?: (id: string) => unknown;
  renderMetadataActions?: (message: HistoryMessage) => string;
  renderMetadataMarkers?: (message: HistoryMessage) => string;
  onOpenMenu?: () => void;
}
import { localizeMessages } from '../../src/i18n/i18n.mts';
export const historyMessages = {
  zh: {
    conversation: '对话记录',
    conversationHint: '管理当前聊天中可见的消息记录。',
    more: '更多消息操作',
    edit: '编辑',
    remove: '删除',
    withdraw: '撤回',
    edited: '已编辑',
    saveOnly: '仅保存修改',
    saveSend: '保存并重新发送',
    cancel: '取消',
    close: '关闭',
    editTitle: '编辑消息',
    editHint: '仅保存会修改可见记录，不重新提交任务，也不改变模型会话或已有上下文。',
    removeTitle: '删除消息',
    removeHint: '仅删除此可见记录，模型会话与上下文保留。',
    removeConfirm: '确认删除',
    clear: '清空聊天记录',
    clearTitle: '清空可见聊天记录',
    clearHint: '可见聊天记录将被移除，模型会话与上下文保留；文件、凭据、技能和记忆不变。',
    clearConfirm: '确认清空',
    messageCount: '消息数量',
    callBlocked: '请先结束通话，再修改聊天记录。',
    offline: '先连接工作电脑，才能修改聊天记录。',
    failed: '聊天记录操作未完成。请检查连接及任务状态后重试。',
    busy: '正在处理…',
    search: '搜索聊天',
    searchPlaceholder: '搜索消息或附件名称…',
    searchEmpty: '没有匹配的消息。',
    searchHint: '在当前聊天中搜索文字与附件名称，不读取附件内容。',
    you: '你',
    dant: 'dant',
    clearDone: '可见聊天记录已清空',
    recordChanged: '该消息已经变化或被删除，请重新打开。',
    readAloud: '',
    stopReading: '',
  },
  en: {
    conversation: 'Conversation',
    conversationHint: 'Manage the visible records in this chat.',
    more: 'More message actions',
    edit: 'Edit',
    remove: 'Delete',
    withdraw: 'Withdraw',
    edited: 'Edited',
    saveOnly: 'Save changes only',
    saveSend: 'Save and send again',
    cancel: 'Cancel',
    close: 'Close',
    editTitle: 'Edit message',
    editHint:
      'Saving only updates the visible record. It does not resubmit work or change the model session or existing context.',
    removeTitle: 'Delete message',
    removeHint: 'Remove this visible record only. The model session and context remain.',
    removeConfirm: 'Confirm delete',
    clear: 'Clear chat history',
    clearTitle: 'Clear visible chat history',
    clearHint:
      'Visible chat records will be removed. The model session and context, files, credentials, skills and memory stay.',
    clearConfirm: 'Confirm clear',
    messageCount: 'Messages',
    callBlocked: 'End the call before changing chat history.',
    offline: 'Connect the work computer to change chat history.',
    failed:
      'The history action could not be completed. Check the connection and task status, then try again.',
    busy: 'Working…',
    search: 'Search chat',
    searchPlaceholder: 'Search messages or attachment names…',
    searchEmpty: 'No matching messages.',
    searchHint:
      'Searches text and attachment names in this chat, without reading attachment contents.',
    you: 'You',
    dant: 'dant',
    clearDone: 'Visible chat history cleared',
    recordChanged: 'This message changed or was deleted. Open it again.',
    readAloud: '',
    stopReading: '',
  },
};
Object.assign(historyMessages.zh, { readAloud: '朗读', stopReading: '停止朗读' });
Object.assign(historyMessages.en, { readAloud: 'Read aloud', stopReading: 'Stop reading' });
export function createChatHistory({
  getState,
  request,
  render,
  toast,
  openModal,
  closeModal,
  revealMessage = () => {},
  navigate = (action) => action(),
  document = globalThis.document,
  connected = () => true,
  callActive = () => false,
  searchMessages,
  icon = () => '',
  getSpeechState = () => null,
  onReadAloud,
  renderMetadataActions = () => '',
  renderMetadataMarkers = () => '',
  onOpenMenu = () => {},
}: ChatHistoryOptions) {
  let menuId: string | null = null,
    editDraft: string | null = null,
    error = '',
    busy = false,
    query = '';
  const tr = (key: keyof typeof historyMessages.en) =>
    localizeMessages(historyMessages, getState()?.settings?.language)[key] || key;
  const online = () => connected() && getState()?.worker?.status === 'online';
  const blocked = () => (callActive() ? 'callBlocked' : !online() ? 'offline' : null);
  const speechState = (message: HistoryMessage | undefined): SpeechState | null => {
    if (
      typeof onReadAloud !== 'function' ||
      message?.role !== 'assistant' ||
      message.kind === 'call' ||
      typeof message.text !== 'string' ||
      !message.text.trim()
    )
      return null;
    try {
      const value = getSpeechState(message);
      return isRecord(value) &&
        typeof value.active === 'boolean' &&
        typeof value.disabled === 'boolean'
        ? { active: value.active, disabled: value.disabled }
        : null;
    } catch {
      return null;
    }
  };
  const button = (
    label: keyof typeof historyMessages.en,
    attributes: string,
    disabled = false,
    cls = 'text-btn',
  ) =>
    `<button type="button" class="${cls}" ${attributes} ${disabled ? 'disabled' : ''}>${tr(label)}</button>`;
  function renderActions(message: HistoryMessage) {
    const reason = blocked(),
      speech = menuId === message.id ? speechState(message) : null;
    return `<button type="button" data-message-more="${esc(message.id)}" title="${tr('more')}" aria-label="${tr('more')}" aria-haspopup="menu" aria-expanded="${menuId === message.id}">${icon('more-horizontal')}</button>${menuId === message.id ? `<div class="history-menu" role="menu" data-key="history-menu-${esc(message.id)}">${renderMetadataActions(message)}${speech ? `<button type="button" class="text-btn" data-message-speak="${esc(message.id)}" role="menuitem" ${speech.disabled ? 'disabled' : ''}>${icon(speech.active ? 'square' : 'volume-2')}${tr(speech.active ? 'stopReading' : 'readAloud')}</button>` : ''}${reason ? `<p class="muted">${tr(reason)}</p>` : ''}${message.role === 'user' ? button('edit', `data-message-edit="${esc(message.id)}" role="menuitem"`, !!reason) : ''}${button(message.role === 'user' && message.status === 'queued' ? 'withdraw' : 'remove', `data-message-remove="${esc(message.id)}" role="menuitem"`, !!reason)}</div>` : ''}`;
  }
  function renderEdited(message: HistoryMessage) {
    return (
      renderMetadataMarkers(message) +
      (message.editedAt
        ? `<small class="edited-label" title="${esc(new Date(message.editedAt).toLocaleString())}">${tr('edited')}</small>`
        : '')
    );
  }
  function renderSettings() {
    const reason = blocked();
    return `<section class="settings-section setting-card conversation-settings"><div class="card-label"><h2>${tr('conversation')}</h2></div><div class="card-content"><p class="card-description">${tr('conversationHint')}</p>${reason ? `<p class="muted">${tr(reason)}</p>` : ''}${button('clear', 'data-history-clear', !!reason || busy || !getState()?.messages?.length)}</div></section>`;
  }
  function shell(title: string, key: unknown, body: string) {
    return `<div class="modal-backdrop" data-key="history-${esc(key)}"><section class="dialog history-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="dialog-header"><h2 id="dialog-title">${title}</h2><button type="button" class="icon-btn" data-action="close-modal" title="${tr('close')}" aria-label="${tr('close')}" ${busy ? 'disabled' : ''}>${icon('x') || '×'}</button></div><div class="dialog-body">${body}</div></section></div>`;
  }
  function renderModal(modal: UiModal | null) {
    if (modal?.type === 'chat-search') {
      const results = query.trim()
        ? searchMessages(getState()?.messages || [], query, { limit: 50 })
        : [];
      return shell(
        tr('search'),
        'search',
        `<label class="search-label">${tr('search')}<input id="chat-search-input" type="search" value="${esc(query)}" placeholder="${tr('searchPlaceholder')}" autocomplete="off"></label><p class="muted">${tr('searchHint')}</p><div class="search-results">${results.map((item) => `<button type="button" class="search-result" data-search-message="${esc(item.messageId)}"><small>${tr(item.role === 'user' ? 'you' : 'dant')}</small><span>${esc(item.snippet)}</span></button>`).join('') || (query.trim() ? `<p class="muted">${tr('searchEmpty')}</p>` : '')}</div>`,
      );
    }
    if (!modal || !['message-edit', 'message-delete', 'history-clear'].includes(modal.type))
      return null;
    const message = getState()?.messages?.find((item) => item.id === modal.messageId),
      reason = blocked(),
      disabled = !!reason || busy;
    if (modal.type !== 'history-clear' && !message)
      return shell(tr('conversation'), 'missing', `<p class="error">${tr('recordChanged')}</p>`);
    const status =
      reason || error
        ? `<p class="error" role="status">${tr((reason || error) as keyof typeof historyMessages.en)}</p>`
        : '';
    if (modal.type === 'message-edit')
      return shell(
        tr('editTitle'),
        modal.messageId,
        `<form id="message-edit-form"><p class="card-description">${tr('editHint')}</p><textarea name="text" rows="8" required aria-label="${tr('editTitle')}">${esc(editDraft ?? message?.text ?? '')}</textarea>${status}<div class="form-actions">${button('cancel', 'data-action="close-modal"', busy)}<button class="text-btn primary" type="submit" ${disabled ? 'disabled' : ''}>${tr('saveOnly')}</button>${button('saveSend', 'data-history-resubmit', disabled)}</div></form>`,
      );
    const clear = modal.type === 'history-clear';
    return shell(
      tr(clear ? 'clearTitle' : 'removeTitle'),
      clear ? 'clear' : modal.messageId,
      `<p class="card-description">${tr(clear ? 'clearHint' : 'removeHint')}</p>${clear ? `<p>${tr('messageCount')}: ${getState()?.messages?.length ?? 0}</p>` : `<blockquote class="history-record-preview">${esc(message?.text || '')}</blockquote>`}${status}<div class="form-actions">${button('cancel', 'data-action="close-modal"', busy)}${button(clear ? 'clearConfirm' : 'removeConfirm', clear ? 'data-history-confirm-clear' : `data-history-confirm-remove="${esc(modal.messageId)}"`, disabled, 'text-btn primary')}</div>`,
    );
  }
  async function mutate(route: string, options: ApiOptions) {
    const reason = blocked();
    if (reason) {
      error = reason;
      render();
      return false;
    }
    if (busy) return false;
    busy = true;
    error = '';
    render();
    try {
      await request(route, options);
      try {
        const fresh = await request('/state');
        const state = getState();
        if (state && isRecord(fresh)) Object.assign(state, fresh);
      } catch {
        /* State events can refresh a mutation that was already acknowledged. */
      }
      menuId = null;
      closeModal();
      return true;
    } catch {
      error = 'failed';
      render();
      return false;
    } finally {
      busy = false;
      render();
    }
  }
  function open(type: string, messageId?: string) {
    menuId = null;
    error = '';
    editDraft = null;
    if (type === 'message-edit')
      editDraft = getState()?.messages?.find((item) => item.id === messageId)?.text || '';
    openModal({ type, ...(messageId === undefined ? {} : { messageId }) });
  }
  function bind() {
    const click = (selector: string, handler: (node: HTMLElement) => unknown) =>
      document.querySelectorAll<HTMLElement>(selector).forEach(
        (node) =>
          (node.onclick = () =>
            Promise.resolve(handler(node)).catch(() => {
              error = 'failed';
              render();
            })),
      );
    click('[data-message-more]', (node) => {
      onOpenMenu();
      menuId = menuId === node.dataset.messageMore ? null : node.dataset.messageMore || null;
      render();
      document
        .querySelector<HTMLElement>('.history-menu [role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    document.querySelectorAll<HTMLElement>('.history-menu').forEach((menu) => {
      menu.onkeydown = (event) => {
        const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')],
          current = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === 'Escape' && !event.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          const id = menuId;
          menuId = null;
          render();
          [...document.querySelectorAll<HTMLElement>('[data-message-more]')]
            .find((node) => node.dataset.messageMore === id)
            ?.focus();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
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
    });
    click('[data-message-speak]', (node) => {
      const id = node.dataset.messageSpeak;
      if (!id || menuId !== id) return;
      const message = getState()?.messages?.find((item) => item.id === id),
        speech = speechState(message);
      if (!speech || speech.disabled) {
        render();
        return;
      }
      menuId = null;
      render();
      return onReadAloud?.(id);
    });
    click('[data-message-edit]', (node) => {
      if (!blocked()) open('message-edit', node.dataset.messageEdit);
    });
    click('[data-message-remove]', (node) => {
      if (!blocked()) open('message-delete', node.dataset.messageRemove);
    });
    click('[data-history-clear]', () => {
      if (!blocked()) open('history-clear');
    });
    click('[data-history-confirm-remove]', (node) =>
      mutate('/messages/' + encodeURIComponent(node.dataset.historyConfirmRemove || ''), {
        method: 'DELETE',
      }),
    );
    click('[data-history-confirm-clear]', async () => {
      if (await mutate('/history', { method: 'DELETE', body: { confirm: true } }))
        toast(tr('clearDone'));
    });
    const form = document.querySelector<HTMLFormElement>('#message-edit-form');
    if (form) {
      const input = form.querySelector<HTMLTextAreaElement>('[name="text"]');
      if (!input) return;
      form.oninput = () => (editDraft = input.value);
      form.onsubmit = (event) => {
        event.preventDefault();
        editDraft = input.value;
        const message = getState()?.messages?.find((item) => item.id === form.dataset.messageId);
        if (message)
          return mutate('/messages/' + encodeURIComponent(message.id), {
            method: 'PATCH',
            body: { text: editDraft, resubmit: false },
          });
      };
    }
    const search = document.querySelector<HTMLInputElement>('#chat-search-input');
    if (search)
      search.oninput = () => {
        query = search.value;
        render();
      };
    click('[data-chat-search]', () => {
      menuId = null;
      openModal({ type: 'chat-search' });
      document.querySelector<HTMLInputElement>('#chat-search-input')?.focus();
    });
    click('[data-search-message]', (node) => {
      const id = node.dataset.searchMessage;
      if (!id) return;
      closeModal();
      revealMessage(id);
      const target = [...document.querySelectorAll<HTMLElement>('[data-id]')].find(
        (element) => element.dataset.id === id,
      );
      navigate(() => target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }));
      target?.classList.add('search-hit');
    });
  }
  function bindModal(modal: UiModal | null) {
    if (!modal) return;
    const form = document.querySelector<HTMLFormElement>('#message-edit-form');
    if (!form) return;
    form.dataset.messageId = modal.messageId || '';
    const input = form.querySelector<HTMLTextAreaElement>('[name="text"]');
    const submit = document.querySelector<HTMLElement>('[data-history-resubmit]');
    if (!input || !submit || !modal.messageId) return;
    const messageId = modal.messageId;
    submit.onclick = () => {
      editDraft = input.value;
      return mutate('/messages/' + encodeURIComponent(messageId), {
        method: 'PATCH',
        body: { text: editDraft, resubmit: true },
      });
    };
  }
  function onClose() {
    menuId = null;
    editDraft = null;
    error = '';
  }
  return { renderActions, renderEdited, renderSettings, renderModal, bind, bindModal, onClose };
}
