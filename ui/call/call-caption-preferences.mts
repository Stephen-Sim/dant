import { escapeHtml as escape } from '../shared/html.mts';
import { isRecord } from '../shared/contracts.mts';
import type { ApiRequest } from '../shared/contracts.mts';
import { callCaptionCopy } from './call-caption-copy.mts';

interface PreferenceState {
  settings?: { showCallCaptions?: boolean };
}
export function callCaptionScope(state: unknown): string {
  const settings = isRecord(state) && isRecord(state.settings) ? state.settings : null,
    vm = settings && isRecord(settings.vm) ? settings.vm : null;
  return JSON.stringify([
    isRecord(state) ? (state.conversationId ?? null) : null,
    vm?.host ?? null,
    vm?.user ?? null,
    vm?.port ?? null,
    vm?.keyPath ?? null,
    vm?.knownHosts ?? null,
  ]);
}
export function createCallCaptionPreferences({
  document,
  getState,
  getLanguage,
  request,
  connected = () => true,
  onChange = () => {},
  onError = () => {},
}: {
  document: Document;
  getState: () => PreferenceState | null;
  getLanguage: () => unknown;
  request: ApiRequest;
  connected?: () => boolean;
  onChange?: () => void;
  onError?: (text: string) => void;
}) {
  let pending = false,
    uncertain: PreferenceState | null = null;
  const enabled = () => getState()?.settings?.showCallCaptions !== false;
  function blocked() {
    if (uncertain && getState() !== uncertain) uncertain = null;
    return pending || Boolean(uncertain) || !connected();
  }
  async function save(value: boolean) {
    if (blocked() || !getState()?.settings) return;
    const scope = callCaptionScope(getState());
    pending = true;
    onChange();
    try {
      const response = await request('/settings', {
        method: 'PATCH',
        body: { showCallCaptions: value },
      });
      if (!isRecord(response) || response.ok !== true)
        throw Error('Unconfirmed caption preference');
      const current = getState();
      if (callCaptionScope(current) === scope && current?.settings)
        current.settings.showCallCaptions = value;
    } catch (cause) {
      if (callCaptionScope(getState()) !== scope) return;
      if (isRecord(cause) && cause.unknownOutcome === true) uncertain = getState();
      onError(callCaptionCopy(getLanguage()).failed);
    } finally {
      pending = false;
      onChange();
    }
  }
  return {
    get enabled() {
      return enabled();
    },
    renderSetting() {
      const words = callCaptionCopy(getLanguage());
      return `<div class="setting-row call-caption-setting"><label for="showCallCaptions">${escape(words.title)}<small>${escape(words.hint)}</small></label><input type="checkbox" id="showCallCaptions" data-call-caption-setting aria-label="${escape(words.title)}" ${enabled() ? 'checked' : ''} ${blocked() ? 'disabled' : ''}></div>`;
    },
    renderToggle({ mini = false } = {}) {
      if (mini) return '';
      const words = callCaptionCopy(getLanguage()),
        label = enabled() ? words.hide : words.show;
      return `<button type="button" class="text-btn call-caption-toggle" data-call-caption-toggle aria-label="${escape(label)}" title="${escape(label)}" aria-pressed="${enabled()}" ${blocked() ? 'disabled' : ''}>CC</button>`;
    },
    bind() {
      const setting = document.querySelector<HTMLInputElement>('[data-call-caption-setting]');
      if (setting)
        setting.onchange = () => {
          void save(setting.checked);
        };
      for (const button of document.querySelectorAll<HTMLButtonElement>(
        '[data-call-caption-toggle]',
      ))
        button.onclick = (event) => {
          event.stopPropagation();
          void save(!enabled());
        };
    },
  };
}
