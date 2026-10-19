import { escapeHtml } from '../shared/html.mts';

interface ProgressPanelOptions {
  document: Document;
  renderContent: () => string;
  title: () => string;
  closeLabel: () => string;
  closeIcon: () => string;
  onChange: () => void;
  onClose?: () => void;
  getScope?: () => string;
}

/** A workspace pane: opening it never owns or replaces chat and computer state. */
export function createProgressPanel({
  document,
  renderContent,
  title,
  closeLabel,
  closeIcon,
  onChange,
  onClose = () => {},
  getScope = () => '',
}: ProgressPanelOptions) {
  let visible = false,
    scrollTop = 0,
    scope = getScope(),
    opener: HTMLElement | null = null;
  function capture() {
    const nextScope = getScope();
    if (scope !== nextScope) {
      scope = nextScope;
      scrollTop = 0;
      opener = null;
      onClose();
      return;
    }
    const body = document.querySelector<HTMLElement>('[data-progress-panel-body]');
    if (body && Number.isFinite(body.scrollTop)) scrollTop = Math.max(0, body.scrollTop);
  }
  function open() {
    if (!visible) {
      const active = document.activeElement;
      opener = active && 'focus' in active ? (active as HTMLElement) : null;
      visible = true;
    }
    onChange();
    document.querySelector<HTMLElement>('[data-progress-panel]')?.focus({ preventScroll: true });
  }
  function close() {
    if (!visible) return;
    capture();
    visible = false;
    onClose();
    onChange();
    const target = opener?.isConnected
      ? opener
      : document.querySelector<HTMLElement>('[data-action="progress"]');
    target?.focus({ preventScroll: true });
    opener = null;
  }
  function render() {
    if (!visible) return '';
    return `<aside class="progress-panel" data-progress-panel data-key="progress-panel" id="work-progress-panel" aria-labelledby="work-progress-panel-title" tabindex="-1"><div class="panel-header"><strong id="work-progress-panel-title">${escapeHtml(title())}</strong><button type="button" class="icon-btn" data-progress-panel-close title="${escapeHtml(closeLabel())}" aria-label="${escapeHtml(closeLabel())}">${closeIcon()}</button></div><div class="progress-panel-body work-progress-body" data-progress-panel-body data-key="progress-panel-body" tabindex="0" role="region" aria-label="${escapeHtml(title())}">${renderContent()}</div></aside>`;
  }
  function bind() {
    const panel = document.querySelector<HTMLElement>('[data-progress-panel]'),
      body = document.querySelector<HTMLElement>('[data-progress-panel-body]');
    if (body) body.scrollTop = scrollTop;
    document.querySelectorAll<HTMLElement>('[data-action="progress"]').forEach((button) => {
      button.setAttribute('aria-controls', 'work-progress-panel');
      button.setAttribute('aria-expanded', String(visible));
    });
    const closeButton = panel?.querySelector<HTMLButtonElement>('[data-progress-panel-close]');
    if (closeButton) closeButton.onclick = close;
    if (panel)
      panel.onkeydown = (event) => {
        if (
          event.key === 'Escape' &&
          !event.isComposing &&
          !event.defaultPrevented &&
          !document.querySelector('[aria-modal="true"]')
        ) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      };
  }
  return {
    get visible() {
      return visible;
    },
    capture,
    open,
    close,
    render,
    bind,
  };
}
