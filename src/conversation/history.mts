import type { WorkMessage } from '../work/engine-types.ts';
import type { Store } from './store.mts';
import type { ChatMessage, ChatCompletion } from './types.ts';
interface HistoryEngine {
  call: unknown;
  active: { messageId?: string | null; messageIds?: string[] } | null;
  finishing?: unknown;
  pendingFollowups?: { readonly size: number };
  callReferences?: { readonly size: number };
  nativeVoice?: { active: unknown } | null;
  voiceTasks?: { readonly size: number; has(id: string): boolean };
  queue: WorkMessage[];
  change?: () => void;
  enqueue: (message: WorkMessage) => unknown;
}
const fail = (message: string, status: number) => Object.assign(Error(message), { status });

// These actions change the visible local history. The executor's persistent
// conversation and workspace deliberately retain their existing identity.
export class ConversationHistory {
  readonly store: Store;
  readonly engine: HistoryEngine;
  constructor({ store, engine }: { store: Store; engine: HistoryEngine }) {
    this.store = store;
    this.engine = engine;
  }
  hasDeletedClientId(id: unknown) {
    return (
      typeof id === 'string' && this.store.state.deletedClientMessageIds?.includes(id) === true
    );
  }
  deletedClientIds(messages: readonly ChatMessage[]) {
    const additions = messages
        .filter(
          (item): item is ChatMessage & { clientMessageId: string } =>
            item.role === 'user' &&
            typeof item.clientMessageId === 'string' &&
            item.clientMessageId.length > 0 &&
            item.clientMessageId.length <= 128,
        )
        .map((item) => item.clientMessageId),
      prior = Array.isArray(this.store.state.deletedClientMessageIds)
        ? this.store.state.deletedClientMessageIds
        : [];
    return [...new Set([...prior.filter((id) => !additions.includes(id)), ...additions])].slice(
      -2000,
    );
  }
  message(id: unknown) {
    if (typeof id !== 'string' || !id || id.length > 128) throw fail('Invalid message ID', 400);
    const message = this.store.state.messages.find((item) => item.id === id);
    if (!message) throw fail('Message not found', 404);
    return message;
  }
  callGuard() {
    if (this.engine.call) throw fail('End the voice call before changing history', 409);
  }
  idleGuard() {
    this.callGuard();
    if (
      this.engine.active ||
      this.engine.finishing ||
      this.engine.pendingFollowups?.size ||
      this.engine.callReferences?.size ||
      this.engine.nativeVoice?.active
    )
      throw fail('Stop active work before changing history', 409);
  }
  commit(
    messages: ChatMessage[],
    completions: ChatCompletion[],
    deletedClientMessageIds = this.store.state.deletedClientMessageIds,
  ) {
    const state = this.store.state,
      before = {
        messages: state.messages,
        completions: state.completions,
        deletedClientMessageIds: state.deletedClientMessageIds,
      };
    state.messages = messages;
    state.completions = completions;
    state.deletedClientMessageIds = deletedClientMessageIds;
    try {
      this.store.save();
    } catch (error) {
      Object.assign(state, before);
      throw error;
    }
  }
  changed() {
    this.engine.change?.();
  }
  edit(id: string, { text, resubmit = false }: { text?: unknown; resubmit?: unknown } = {}) {
    this.idleGuard();
    const original = this.message(id);
    if (original.role !== 'user') throw fail('Only user message text can be edited', 400);
    if (typeof text !== 'string' || !text.trim() || typeof resubmit !== 'boolean')
      throw fail('Message text must be non-empty and resubmit must be a boolean', 400);
    const message: ChatMessage = { ...original, text: text.trim(), editedAt: Date.now() };
    if (resubmit)
      Object.assign(message, {
        status: this.engine.queue.some((item) => item.id === id) ? 'queued' : 'draft',
        submission: null,
        turnId: null,
        executorConfirmedAt: null,
        error: null,
        acceptedAt: null,
        parentTaskId: null,
        pauseReason: null,
      });
    this.commit(
      this.store.state.messages.map((item) => (item.id === id ? message : item)),
      this.store.state.completions || [],
    );
    this.engine.queue = this.engine.queue.map((item) => (item.id === id ? message : item));
    if (resubmit) this.engine.enqueue(message);
    this.changed();
    return { edited: true, message, resubmitted: resubmit };
  }
  remove(requestId: unknown) {
    this.callGuard();
    const message = this.message(requestId),
      id = message.id,
      active = this.engine.active;
    const isActive = active?.messageId === id || active?.messageIds?.includes(id);
    const withdrawn =
      message.role === 'user' &&
      !isActive &&
      !this.engine.voiceTasks?.has(id) &&
      this.engine.queue.some((item) => item.id === id);
    if (!withdrawn) this.idleGuard();
    const messages = this.store.state.messages
      .filter((item) => item.id !== id)
      .map((item) => (item.replyTo === id ? { ...item, replyTo: null } : item));
    const completions = (this.store.state.completions || [])
      .map((item) => ({
        ...item,
        messageIds: item.messageIds.filter((messageId) => messageId !== id),
        ...(item.taskId === id ? { taskId: null } : {}),
      }))
      .filter((item) => item.messageIds.length);
    this.commit(messages, completions, this.deletedClientIds([message]));
    this.engine.queue = this.engine.queue.filter((item) => item.id !== id);
    this.changed();
    return { removed: true, id, withdrawn };
  }
  clear({ confirm = false }: { confirm?: unknown } = {}) {
    if (confirm !== true) throw fail('Confirm clearing the visible history', 400);
    this.idleGuard();
    if (this.engine.voiceTasks?.size) throw fail('Stop active work before changing history', 409);
    const count = this.store.state.messages.length;
    this.commit([], [], this.deletedClientIds(this.store.state.messages));
    this.engine.queue = [];
    this.changed();
    return { cleared: true, count };
  }
}
