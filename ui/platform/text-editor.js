import { localizeMessages } from '../../src/i18n/i18n.mts';
import { canPreviewFile } from '../files/file-preview.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const installedIds = new Set([
  'notepad',
  'vscode',
  'vscode-insiders',
  'notepadpp',
  'notepad3',
  'notepad4',
  'sublime',
  'zed',
  'cursor',
  'visualstudio',
  'androidstudio',
  'intellij',
  'intellij-community',
  'pycharm',
  'pycharm-community',
]);
const messages = {
  en: {
    title: 'Open with',
    hint: 'Choose the app used to open text and code attachments. It opens a local copy; the chat attachment stays unchanged.',
    choose: 'Choose another editor…',
    desktop: 'Available in the desktop app.',
    failed:
      'The editor setting could not be changed. Choose a supported installed editor and try again.',
    loading: 'Loading apps…',
    retry: 'Retry',
    current: 'Current editor',
    unavailable: 'No longer detected',
    notepad: 'Notepad',
  },
  zh: {
    title: '打开方式',
    hint: '选择用于打开文本和代码附件的应用。打开的是本地副本，聊天中的附件保持不变。',
    choose: '选择其他编辑器…',
    desktop: '此功能适用于桌面应用。',
    failed: '无法更改编辑器设置，请选择已安装且受支持的编辑器后重试。',
    loading: '正在读取应用…',
    retry: '重试',
    current: '当前编辑器',
    unavailable: '未检测到此应用',
    notepad: '记事本',
  },
};
const failure = () =>
  Object.assign(
    Error('The text editor could not open this attachment. Check your editor in Settings.'),
    { code: 'editor_failed' },
  );
const safeName = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\\/:\x00-\x1f\x7f]/.test(value);
const svg = (content) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
function appIcon(id) {
  if (id === 'vscode' || id === 'vscode-insiders')
    return svg(
      '<path d="m16 3 5 2v14l-5 2-10-9L3 15V9l3 3L16 3Z"/><path d="M16 3v18M6 12l10 6M6 12l10-6"/>',
    );
  if (id === 'cursor') return svg('<path d="m5 3 14 10-7 1-3 7L5 3Z"/><path d="m12 14 5 6"/>');
  if (id === 'sublime') return svg('<path d="m19 4-14 4 14 4-14 4 14 4M5 8v4l14 4v4"/>');
  if (id === 'zed') return svg('<path d="M4 5h16L5 19h15M4 10h8M12 14h8"/>');
  if (id === 'visualstudio') return svg('<path d="m3 9 4-3 9 7V3l5 2v14l-5 2V11L7 18l-4-3V9Z"/>');
  if (
    ['intellij', 'intellij-community', 'pycharm', 'pycharm-community', 'androidstudio'].includes(id)
  )
    return svg(
      `<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M7 17h5"/>${id === 'androidstudio' ? '<path d="m8 13 4-7 4 7M9 11h6"/>' : id.startsWith('pycharm') ? '<path d="M8 13V7h3a2 2 0 0 1 0 4H8M16 8c-3-2-3 5 0 3"/>' : '<path d="M8 7v6M11 7h4v4a2 2 0 0 1-4 0"/>'}`,
    );
  if (id === 'notepadpp')
    return svg(
      '<rect x="4" y="3" width="14" height="18" rx="2"/><path d="M8 7h6M8 11h4M8 15h2M18 13v6M15 16h6"/>',
    );
  if (id === 'custom')
    return svg(
      '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m9 8-4 4 4 4m6-8 4 4-4 4m-2-9-2 10"/>',
    );
  return svg(
    '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h6M3 7h4M3 12h4M3 17h4"/>',
  );
}

export function createTextEditor({
  desktop = Boolean(globalThis.window?.__TAURI_INTERNALS__),
  getLanguage = () => 'en',
  getToken = () => '',
  render = () => {},
  document = globalThis.document,
  invoke,
  loadCore = () => import('@tauri-apps/api/core'),
} = {}) {
  let preference = { editor: 'notepad', id: 'notepad', name: 'Notepad' },
    preferenceKnown = false,
    editors = [],
    loaded = false,
    busy = false,
    error = false,
    closed = false,
    loading = null,
    menuOpen = false,
    focused = null;
  const pending = new Map();
  const tr = (key) => localizeMessages(messages, getLanguage())[key];
  const call = async (command, args) => {
    const core = invoke ? { invoke } : await loadCore();
    if (closed) throw failure();
    return core.invoke(command, args);
  };
  function validate(value) {
    if (!value || !['notepad', 'custom'].includes(value.editor) || !safeName(value.name))
      throw failure();
    const id = value.id ?? (value.editor === 'notepad' ? 'notepad' : 'custom');
    if (
      (id !== 'custom' && !installedIds.has(id)) ||
      (value.editor === 'notepad' && id !== 'notepad') ||
      (value.editor === 'custom' && id === 'notepad')
    )
      throw failure();
    return { editor: value.editor, id, name: value.name };
  }
  function inventory(value) {
    if (!Array.isArray(value?.editors) || value.editors.length > 64) throw failure();
    const result = [],
      seen = new Set();
    for (const editor of value.editors) {
      if (!editor || !installedIds.has(editor.id) || !safeName(editor.name)) throw failure();
      if (!seen.has(editor.id)) {
        seen.add(editor.id);
        result.push({ id: editor.id, name: editor.name });
      }
    }
    return result;
  }
  function choices() {
    const list = [
      { id: 'notepad', name: tr('notepad') },
      ...editors.filter((item) => item.id !== 'notepad'),
    ];
    if (!list.some((item) => item.id === preference.id))
      list.push({
        id: preference.id,
        name: preference.name,
        current: true,
        unavailable: preference.id !== 'custom',
      });
    return list;
  }
  const displayName = () => (preference.id === 'notepad' ? tr('notepad') : preference.name);
  function focusTrigger({ respectFocus = false } = {}) {
    const active = document?.activeElement;
    if (
      respectFocus &&
      active &&
      active !== document.body &&
      active !== document.documentElement &&
      !active.closest('[data-editor-control]')
    )
      return;
    const trigger = document?.querySelector('[data-editor-menu-trigger]');
    if (trigger && !trigger.closest('[hidden]')) trigger.focus({ preventScroll: true });
  }
  function focusOption(id) {
    focused = id;
    const node = [...document.querySelectorAll('[data-editor-option],[data-editor-choose]')].find(
      (item) => (item.dataset.editorOption || 'browse') === id && !item.disabled,
    );
    if (node) {
      for (const peer of document.querySelectorAll('[data-editor-option],[data-editor-choose]'))
        peer.tabIndex = peer === node ? 0 : -1;
      node.focus({ preventScroll: true });
      node.scrollIntoView?.({ block: 'nearest' });
    }
  }
  function closeMenu(restoreFocus = false) {
    if (!menuOpen) return;
    menuOpen = false;
    render();
    if (restoreFocus) focusTrigger();
  }
  function openMenu(where = 'selected') {
    if (closed || !desktop || busy || loading) return;
    menuOpen = true;
    const list = choices()
      .filter((item) => !item.unavailable)
      .map((item) => item.id);
    focused =
      where === 'last'
        ? 'browse'
        : where === 'first'
          ? list[0]
          : list.includes(preference.id)
            ? preference.id
            : list[0];
    render();
    focusOption(focused);
  }
  function load() {
    if (closed || !desktop || loaded || busy) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      const results = await Promise.allSettled([
        call('editor_preferences'),
        call('installed_text_editors'),
      ]);
      if (closed) return;
      let failed = false;
      try {
        if (results[0].status !== 'fulfilled') throw failure();
        preference = validate(results[0].value);
        preferenceKnown = true;
      } catch {
        failed = true;
        preferenceKnown = false;
      }
      try {
        if (results[1].status !== 'fulfilled') throw failure();
        editors = inventory(results[1].value);
      } catch {
        failed = true;
        editors = [];
      }
      loaded = true;
      error = failed;
    })().finally(() => {
      loading = null;
      if (!closed) render();
    });
    render();
    return loading;
  }
  async function change(command, args) {
    if (closed || !desktop || busy || loading) return;
    busy = true;
    error = false;
    menuOpen = false;
    render();
    try {
      const value = await call(command, args);
      if (value !== null && !closed) {
        preference = validate(value);
        preferenceKnown = true;
        loaded = true;
      }
    } catch {
      if (!closed) error = true;
    } finally {
      busy = false;
      if (!closed) {
        render();
        focusTrigger({ respectFocus: true });
      }
    }
  }
  function select(id) {
    if (closed || !menuOpen || busy || loading) return;
    const item = choices().find((item) => item.id === id);
    if (!item || item.unavailable) return;
    if (id === preference.id && (preferenceKnown || id === 'custom')) {
      closeMenu(true);
      return;
    }
    return id === 'notepad'
      ? change('reset_text_editor')
      : installedIds.has(id) && editors.some((item) => item.id === id)
        ? change('select_text_editor', { editorId: id })
        : undefined;
  }
  function renderSettings() {
    const locked = !desktop || busy || Boolean(loading),
      options = choices(),
      menu = menuOpen
        ? `<div id="text-editor-app-menu" class="text-editor-menu" role="menu" aria-label="${tr('title')}" data-editor-menu>${options.map((item) => `<button type="button" role="menuitemradio" aria-checked="${item.id === preference.id}" data-editor-option="${item.id}" tabindex="${item.id === focused ? '0' : '-1'}" ${item.unavailable ? 'disabled' : ''}><span class="text-editor-app-icon">${appIcon(item.id)}</span><span class="text-editor-option-label">${escape(item.name)}${item.current ? `<small>${tr(item.unavailable ? 'unavailable' : 'current')}</small>` : ''}</span><span class="text-editor-check">${item.id === preference.id ? svg('<path d="m5 12 4 4L19 6"/>') : ''}</span></button>`).join('')}<div class="text-editor-menu-separator" role="separator"></div><button type="button" role="menuitem" data-editor-choose tabindex="${focused === 'browse' ? '0' : '-1'}"><span class="text-editor-app-icon">${svg('<path d="M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3"/>')}</span><span class="text-editor-option-label">${tr('choose')}</span></button></div>`
        : '';
    return `<section class="settings-section setting-card text-editor-settings" aria-label="${tr('title')}"><div class="card-label"><h2>${tr('title')}</h2></div><div class="card-content"><div class="text-editor-setting-row"><p class="card-description">${tr('hint')}</p><div class="text-editor-control" data-editor-control><button type="button" class="text-editor-trigger" data-editor-menu-trigger aria-label="${escape(`${tr('title')}: ${displayName()}`)}" aria-haspopup="menu" aria-controls="text-editor-app-menu" aria-expanded="${menuOpen}" ${locked ? 'disabled' : ''}><span class="text-editor-app-icon">${appIcon(preference.id)}</span><span data-editor-name>${escape(displayName())}</span>${svg('<path d="m8 10 4 4 4-4"/>')}</button>${menu}</div></div>${!desktop ? `<p class="muted">${tr('desktop')}</p>` : ''}${loading ? `<p role="status" class="muted">${tr('loading')}</p>` : ''}${error ? `<div class="text-editor-load-error" role="status"><span class="error">${tr('failed')}</span><button type="button" class="text-link" data-editor-retry ${locked ? 'disabled' : ''}>${tr('retry')}</button></div>` : ''}</div></section>`;
  }
  function menuKey(event) {
    if (!menuOpen) return;
    const nodes = [...document.querySelectorAll('[data-editor-menu] [role^="menuitem"]')].filter(
        (node) => !node.disabled,
      ),
      current = event.target?.closest?.('[role^="menuitem"]'),
      index = nodes.indexOf(current);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu(true);
      return;
    }
    let next;
    if (event.key === 'ArrowDown') next = nodes[(index + 1) % nodes.length];
    else if (event.key === 'ArrowUp') next = nodes[(index - 1 + nodes.length) % nodes.length];
    else if (event.key === 'Home') next = nodes[0];
    else if (event.key === 'End') next = nodes.at(-1);
    if (next) {
      event.preventDefault();
      focusOption(next.dataset.editorOption || 'browse');
    } else if ((event.key === 'Enter' || event.key === ' ') && current) {
      event.preventDefault();
      current.click();
    }
  }
  const outside = (event) => {
    if (menuOpen && !event.target?.closest?.('[data-editor-control]')) closeMenu(false);
  };
  const escapeMenu = (event) => {
    if (menuOpen && event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    }
  };
  document?.addEventListener('pointerdown', outside);
  document?.addEventListener('keydown', escapeMenu);
  function bind() {
    document.querySelectorAll('[data-editor-menu-trigger]').forEach((node) => {
      node.onclick = (event) => {
        event.preventDefault();
        if (menuOpen) closeMenu(true);
        else openMenu();
      };
      node.onkeydown = (event) => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault();
          openMenu(
            event.key === 'ArrowUp' ? 'last' : event.key === 'ArrowDown' ? 'first' : 'selected',
          );
        }
      };
    });
    document.querySelectorAll('[data-editor-option]').forEach(
      (node) =>
        (node.onclick = () => {
          void select(node.dataset.editorOption);
        }),
    );
    document.querySelectorAll('[data-editor-choose]').forEach(
      (node) =>
        (node.onclick = (event) => {
          event.preventDefault();
          if (menuOpen) void change('choose_text_editor');
        }),
    );
    document.querySelectorAll('[data-editor-retry]').forEach(
      (node) =>
        (node.onclick = () => {
          if (busy || loading) return;
          loaded = false;
          void load();
        }),
    );
    document.querySelectorAll('[data-editor-menu]').forEach((node) => (node.onkeydown = menuKey));
  }
  function open(file) {
    if (
      closed ||
      !desktop ||
      !file ||
      !uuid.test(file.id || '') ||
      !canPreviewFile(file) ||
      !/^[a-f0-9]{64}$/i.test(getToken())
    )
      return Promise.reject(failure());
    if (pending.has(file.id)) return pending.get(file.id);
    const token = getToken(),
      operation = (async () => {
        try {
          const result = await call('open_attachment_in_editor', {
            fileId: file.id,
            token,
            fileName: String(file.name || ''),
          });
          if (result?.opened !== true) throw failure();
          return { opened: true };
        } catch {
          throw failure();
        } finally {
          if (pending.get(file.id) === operation) pending.delete(file.id);
        }
      })();
    pending.set(file.id, operation);
    return operation;
  }
  function dispose() {
    closed = true;
    menuOpen = false;
    document?.removeEventListener('pointerdown', outside);
    document?.removeEventListener('keydown', escapeMenu);
  }
  return { load, renderSettings, bind, open, dispose };
}
