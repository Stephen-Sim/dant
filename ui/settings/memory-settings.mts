import { escapeHtml as escape } from '../shared/html.mts';
import { isRecord } from '../shared/contracts.mts';
import type { ApiRequest, UiState } from '../shared/contracts.mts';
import { MemoryEntryStatus, ConnectionStatus } from '../../src/contracts/states.mts';
import {
  MEMORY_MANAGEMENT_PAGE_SIZE,
  MEMORY_MAX_BYTES,
} from '../../src/conversation/memory-constants.mts';
import { memoryManagementCopy } from './memory-management-copy.mts';
import { readManagedMemory } from './memory-management-contracts.mts';
import type { ManagedMemoryView, ManagedMemoryRecord } from './memory-management-contracts.mts';
const scope = (state: UiState | null) =>
  state?.conversationId ? JSON.stringify([state.conversationId, state.settings?.vm ?? null]) : null;
const revision = (state: UiState | null) =>
  JSON.stringify([
    state?.memory ?? '',
    state?.memoryFiles ?? [],
    state?.controller?.serviceUpdate?.runningVersion ?? null,
  ]);
export function createMemorySettings({
  request,
  getState,
  getLanguage = () => 'en',
  onChange = () => {},
  document = globalThis.document,
  connected = () => true,
  renderMarkdown = (text) => escape(text).replace(/\n/g, '<br>'),
}: {
  request: ApiRequest;
  getState: () => UiState | null;
  getLanguage?: () => unknown;
  onChange?: () => void;
  document?: Document;
  connected?: () => boolean;
  renderMarkdown?: (text: string) => string;
}) {
  let visible = false,
    generation = 0,
    mutationToken = 0,
    identity: string | null = null,
    lastRevision = '',
    lastOnline = false,
    data: ManagedMemoryView | null = null,
    reading = false,
    mutating = false,
    failed = false,
    uncertain = false,
    query = '',
    offset = 0,
    editor: { record: ManagedMemoryRecord; action: 'update' | 'delete'; text: string } | null =
      null;
  const online = () => {
    const state = getState();
    return (
      connected() &&
      (state?.mode === 'vm-controller'
        ? state.controller?.status === ConnectionStatus.Online && state.controller.cached !== true
        : state?.worker?.status === ConnectionStatus.Online)
    );
  };
  const changed = () => {
    if (visible) onChange();
  };
  function setVisible(value: unknown) {
    const entered = !visible && Boolean(value);
    visible = Boolean(value);
    if (!visible) {
      generation++;
      reading = false;
      if (mutating) uncertain = true;
      editor = null;
      return;
    }
    const next = scope(getState()),
      ready = online(),
      nextRevision = revision(getState()),
      switched = next !== identity,
      shouldLoad =
        entered ||
        switched ||
        (ready && !lastOnline) ||
        (lastRevision !== nextRevision && !editor && !uncertain);
    if (switched) {
      generation++;
      mutationToken++;
      data = null;
      editor = null;
      uncertain = false;
      failed = false;
      query = '';
      offset = 0;
      reading = false;
      mutating = false;
    }
    if (lastOnline && !ready) {
      generation++;
      reading = false;
    }
    identity = next;
    lastOnline = ready;
    lastRevision = nextRevision;
    if (ready && next && shouldLoad && !reading && !mutating)
      queueMicrotask(() => {
        if (visible && !reading && !mutating) void load();
      });
  }
  async function load() {
    const state = getState(),
      key = scope(state),
      selectedQuery = query,
      selectedOffset = offset;
    if (!visible || !state?.conversationId || !key || !online() || mutating || reading) return;
    const run = ++generation;
    reading = true;
    failed = false;
    changed();
    try {
      const result = readManagedMemory(
        await request(
          '/memory/manage?q=' + encodeURIComponent(selectedQuery) + '&offset=' + selectedOffset,
        ),
        state.conversationId,
      );
      if (
        !visible ||
        run !== generation ||
        scope(getState()) !== key ||
        !online() ||
        selectedQuery !== query ||
        selectedOffset !== offset
      )
        return;
      if (result.query !== selectedQuery || result.offset !== selectedOffset)
        throw Error('Mismatched memory query');
      data = result;
      uncertain = false;
      editor = null;
    } catch {
      if (visible && run === generation && scope(getState()) === key) failed = true;
    } finally {
      if (run === generation) {
        reading = false;
        changed();
      }
    }
  }
  async function mutate(
    record: ManagedMemoryRecord,
    action: 'update' | 'delete' | 'confirm',
    text?: string,
  ) {
    const key = scope(getState()),
      current = data;
    if (!visible || !current || !key || !online() || reading || mutating || uncertain || failed)
      return;
    const run = ++generation,
      operation = ++mutationToken;
    let acknowledged = false;
    mutating = true;
    changed();
    try {
      const result = await request(
        '/memory/manage/' +
          record.kind +
          '/' +
          encodeURIComponent(record.id) +
          (action === 'confirm' ? '/confirm' : ''),
        {
          method: action === 'delete' ? 'DELETE' : action === 'confirm' ? 'POST' : 'PATCH',
          body: {
            conversationId: current.conversationId,
            revision: current.revision,
            ...(action === 'update' ? { text } : {}),
          },
        },
      );
      if (!visible || run !== generation || scope(getState()) !== key) return;
      if (
        !isRecord(result) ||
        result.saved !== true ||
        result.conversationId !== current.conversationId ||
        typeof result.revision !== 'string' ||
        !/^[0-9]+:[0-9]+$/.test(result.revision)
      )
        throw Error('Unconfirmed memory write');
      acknowledged = true;
      mutating = false;
      editor = null;
      await load();
    } catch {
      if (visible && run === generation && scope(getState()) === key) uncertain = true;
    } finally {
      if (operation === mutationToken) {
        mutating = false;
        if (!acknowledged && scope(getState()) === key) uncertain = true;
        changed();
      }
    }
  }
  function render() {
    const tr = memoryManagementCopy(getLanguage()),
      w = tr.word,
      blocked = reading || mutating || uncertain || failed || !online(),
      button = (action: string, label: string, record?: ManagedMemoryRecord, disabled = blocked) =>
        `<button type="button" class="text-btn" data-memory-action="${action}" ${record ? `data-id="${escape(record.id)}" data-kind="${record.kind}"` : ''} ${disabled ? 'disabled' : ''}>${escape(label)}</button>`,
      title = (record: ManagedMemoryRecord) =>
        record.kind === 'note'
          ? w(record.id === 'identity.md' ? 'identityDoc' : 'workingDoc')
          : w(record.kind),
      renderRecord = (record: ManagedMemoryRecord) => {
        const editing = editor?.record.id === record.id && editor.record.kind === record.kind;
        const controls =
          editing && editor
            ? editor.action === 'update'
              ? `<textarea data-memory-editor aria-label="${escape(title(record))}" maxlength="${MEMORY_MAX_BYTES}" ${blocked ? 'disabled' : ''}>${escape(editor.text)}</textarea>${button('save', tr.save, record)}${button('cancel', tr.cancel, undefined, mutating)}`
              : `<p>${escape(w('deleteQuestion'))}</p>${button('delete-confirm', record.kind === 'note' ? w('clear') : tr.delete, record)}${button('cancel', tr.cancel, undefined, mutating)}`
            : button('edit', tr.edit, record, blocked || record.redacted) +
              button('delete', record.kind === 'note' ? w('clear') : tr.delete, record) +
              (record.status === MemoryEntryStatus.Candidate ||
              record.status === MemoryEntryStatus.Conflicted
                ? button('confirm', w('confirm'), record, blocked || record.redacted)
                : '');
        const source = record.source
          ? `<p class="muted">${escape(w('source'))}: ${escape(record.source.kind === 'inference' ? w('inference') : tr[record.source.kind])}${record.source.workId ? ` · <span>${escape(record.source.workId)}</span>` : ''}</p>`
          : '';
        return `<section class="setting-card"><div class="card-label"><h2>${escape(title(record))}</h2>${record.status ? `<p>${escape(w(record.status))}</p>` : `<p>${escape(w('logical'))}</p>`}${source}</div><div class="card-content"><div class="memory-content markdown" data-memory-record="${escape(record.id)}">${renderMarkdown(record.text)}</div>${record.redacted ? `<p class="muted">${escape(w('redacted'))}</p>` : ''}<div>${controls}</div></div></section>`;
      };
    const status = uncertain
      ? w('unknown')
      : !online()
        ? w(data ? 'cached' : 'offline')
        : failed
          ? w('failed')
          : reading || mutating
            ? tr.loading
            : '';
    return `<section class="settings-section memory-page"><div class="memory-page-header"><p class="card-description">${escape(w('description'))}</p>${button('refresh', tr.refresh, undefined, reading || mutating || !online())}</div><p role="status" class="muted" ${status ? '' : 'hidden'}>${escape(status)}</p><form data-memory-search><label>${escape(w('search'))}<input name="q" type="search" maxlength="256" value="${escape(query)}" ${mutating || !online() ? 'disabled' : ''}></label><button class="text-btn" type="submit" ${mutating || !online() ? 'disabled' : ''}>${escape(w('search'))}</button></form>${data ? data.records.map(renderRecord).join('') + (!data.records.length ? `<p>${escape(w('empty'))}</p>` : '') + `<div>${button('previous', tr.back, undefined, reading || mutating || offset === 0)}<span>${escape(String(data.total))}</span>${button('next', tr.next, undefined, reading || mutating || !data.hasMore)}</div>` + data.projects.map((project) => `<section class="setting-card"><div class="card-label"><h2>${escape(w('project'))}</h2><p>${escape(project.workId)}</p></div><div class="card-content memory-content markdown">${renderMarkdown(project.text)}</div></section>`).join('') + `<section class="setting-card"><div class="card-label"><h2>${escape(w('identity'))}</h2></div><details class="card-content"><summary>${escape(w('identity'))}</summary><div class="memory-content markdown" data-memory-identity>${renderMarkdown(data.identity.text)}</div></details></section>` : ''}</section>`;
  }
  function bind() {
    for (const element of document.querySelectorAll<HTMLButtonElement>('[data-memory-action]'))
      element.onclick = () => {
        const action = element.dataset.memoryAction;
        if (action === 'refresh') return void load();
        if (action === 'cancel') {
          if (!mutating) {
            editor = null;
            changed();
          }
          return;
        }
        if (action === 'previous' || action === 'next') {
          if (!reading && !mutating) {
            offset = Math.max(
              0,
              offset + (action === 'next' ? 1 : -1) * MEMORY_MANAGEMENT_PAGE_SIZE,
            );
            void load();
          }
          return;
        }
        const record = data?.records.find(
          (record) => record.id === element.dataset.id && record.kind === element.dataset.kind,
        );
        if (!record || !online() || reading || mutating || uncertain || failed) return;
        if (action === 'edit' || action === 'delete') {
          if (action === 'edit' && record.redacted) return;
          editor = { record, action: action === 'edit' ? 'update' : 'delete', text: record.text };
          changed();
        }
        if (action === 'save' && editor?.action === 'update')
          void mutate(record, 'update', editor.text);
        if (action === 'delete-confirm' && editor?.action === 'delete')
          void mutate(record, 'delete');
        if (action === 'confirm' && !record.redacted) void mutate(record, 'confirm');
      };
    const input = document.querySelector<HTMLTextAreaElement>('[data-memory-editor]');
    if (input)
      input.oninput = () => {
        if (editor?.action === 'update') editor.text = input.value;
      };
    const search = document.querySelector<HTMLFormElement>('[data-memory-search]');
    if (search) {
      for (const control of search.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        'input,button',
      ))
        control.disabled = reading || mutating || !online();
      search.onsubmit = (event) => {
        event.preventDefault();
        if (!mutating && !reading && online()) {
          query = search.querySelector<HTMLInputElement>('input')?.value ?? '';
          offset = 0;
          editor = null;
          void load();
        }
      };
    }
  }
  function dispose() {
    visible = false;
    generation++;
    data = null;
    editor = null;
  }
  return { setVisible, load, render, bind, dispose };
}
