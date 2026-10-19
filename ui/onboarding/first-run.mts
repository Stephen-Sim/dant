import { normalizeLanguage, languageInfo } from '../../src/i18n/languages.mts';
import { escapeHtml as escape } from '../shared/html.mts';
import type { ApiRequest } from '../shared/contracts.mts';
import { profiles, providerInfo, read } from '../app/application-state.mts';
import type { VmProfiles, VmProviderInfo } from '../app/application-types.ts';
import { firstRunMessages } from './first-run-copy.mts';

interface FirstRunState {
  mode?: string;
  conversationId?: string | null;
  settings?: { vm?: { host?: string } };
  messages?: readonly unknown[] | undefined;
  workTasks?: readonly unknown[];
  completions?: readonly unknown[];
  provisioning?: { connection?: { host?: string } | null; running?: boolean };
}
interface FirstRunOptions {
  getState: () => FirstRunState | null;
  getLanguage: () => unknown;
  request: ApiRequest;
  onChange: () => void;
  onCreate: () => void | Promise<void>;
  onExisting: () => void | Promise<void>;
  onManual: () => void | Promise<void>;
  onBackupImport: () => void | Promise<void>;
}

/** A first-use guide. Discovery is read-only; each next step is a user action. */
export function createFirstRun({
  getState,
  getLanguage,
  request,
  onChange,
  onCreate,
  onExisting,
  onManual,
  onBackupImport,
}: FirstRunOptions) {
  let scope: string | null = null,
    generation = 0,
    disposed = false,
    busy = false,
    checked = false,
    failed = false,
    creating = false,
    inventory: VmProfiles | null = null,
    providers: VmProviderInfo | null = null;
  function eligible() {
    const state = getState();
    return Boolean(
      !disposed &&
      state?.mode === 'vm-controller' &&
      !state.settings?.vm?.host &&
      !state.provisioning?.connection?.host &&
      !state.provisioning?.running &&
      Array.isArray(state.messages) &&
      !state.messages.length &&
      !(state.workTasks?.length || state.completions?.length),
    );
  }
  const identity = () => {
    const state = getState();
    return JSON.stringify([
      state?.mode,
      state?.conversationId,
      state?.settings?.vm?.host,
      state?.provisioning?.connection?.host,
    ]);
  };
  const existing = () => Boolean(inventory?.current || inventory?.candidates.length);
  const unavailable = () =>
    providers !== null &&
    !providers.availableProviders.some(
      (provider) => provider.available && (provider.id === 'hyperv' || provider.id === 'vmware'),
    );
  async function observe() {
    if (!eligible() || !creating) {
      if (!eligible()) creating = false;
      if (scope !== null) {
        generation++;
        scope = null;
        busy = false;
        checked = false;
        inventory = providers = null;
      }
      return;
    }
    const captured = identity();
    if (scope === captured && (checked || busy)) return;
    const run = ++generation;
    scope = captured;
    busy = true;
    failed = false;
    inventory = providers = null;
    onChange();
    const results = await Promise.allSettled([
      Promise.resolve()
        .then(() => request('/vm/profiles'))
        .then((value) => read(value, profiles, 'existing computers')),
      Promise.resolve()
        .then(() => request('/vm/providers'))
        .then((value) => read(value, providerInfo, 'VM providers')),
    ]);
    if (disposed || run !== generation || captured !== identity() || !eligible() || !creating)
      return;
    const [found, detected] = results;
    if (found.status === 'fulfilled') inventory = found.value;
    if (detected.status === 'fulfilled') providers = detected.value;
    failed =
      found.status === 'rejected' || detected.status === 'rejected' || Boolean(inventory?.error);
    busy = false;
    checked = true;
    onChange();
  }
  function render() {
    if (!eligible()) return '';
    const code = normalizeLanguage(getLanguage()),
      tr = firstRunMessages[code],
      locale = languageInfo(code),
      hasExisting = existing(),
      blocked = busy || unavailable(),
      create = `<button type="button" class="text-btn ${hasExisting ? '' : 'primary'}" data-action="onboarding-create" ${blocked ? 'disabled' : ''}>${escape(tr.create)}</button>`,
      useExisting = `<button type="button" class="text-btn ${hasExisting ? 'primary' : ''}" data-action="onboarding-existing">${escape(tr.existing)}</button>`;
    if (!creating)
      return `<section class="first-run" data-key="first-run" aria-labelledby="first-run-title" lang="${locale.locale}" dir="${locale.direction}">
      <h1 id="first-run-title">${escape(tr.backupTitle)}</h1>
      <p class="first-run-intro">${escape(tr.backupIntro)}</p>
      <div class="first-run-actions"><button type="button" class="text-btn primary" data-action="onboarding-import">${escape(tr.importBackup)}</button><button type="button" class="text-btn" data-action="onboarding-new">${escape(tr.noBackup)}</button></div>
      <button type="button" class="text-link first-run-manual" data-action="onboarding-existing">${escape(tr.existing)}</button>
      <button type="button" class="text-link first-run-manual" data-action="onboarding-manual">${escape(tr.manual)}</button>
    </section>`;
    return `<section class="first-run" data-key="first-run" aria-labelledby="first-run-title" lang="${locale.locale}" dir="${locale.direction}">
      <button type="button" class="text-link first-run-back" data-action="onboarding-back">${escape(tr.back)}</button>
      <h1 id="first-run-title">${escape(tr.title)}</h1>
      <p class="first-run-intro">${escape(hasExisting ? tr.found : tr.intro)}</p>
      ${hasExisting ? '' : `<ol class="first-run-steps"><li>${escape(tr.choose)}</li><li>${escape(tr.review)}</li><li>${escape(tr.signin)}</li></ol>`}
      ${busy ? `<p class="first-run-status" role="status">${escape(tr.checking)}</p>` : ''}
      ${unavailable() ? `<p class="first-run-status" role="status">${escape(tr.unsupported)}</p>` : ''}
      ${failed ? `<p class="first-run-status" role="status">${escape(tr.loadFailed)}</p>` : ''}
      <div class="first-run-actions">${hasExisting ? useExisting + create : create + useExisting}</div>
      <button type="button" class="text-link first-run-manual" data-action="onboarding-manual">${escape(tr.manual)}</button>
      <small>${escape(tr.permissions)}</small>
    </section>`;
  }
  async function handle(action: string) {
    if (!eligible()) return false;
    if (action === 'onboarding-import') {
      await onBackupImport();
      return true;
    }
    if (action === 'onboarding-new') {
      creating = true;
      await observe();
      return true;
    }
    if (action === 'onboarding-back') {
      creating = false;
      await observe();
      onChange();
      return true;
    }
    if (action === 'onboarding-create') {
      if (creating && !busy && !unavailable()) await onCreate();
      return true;
    }
    if (action === 'onboarding-existing') {
      await onExisting();
      return true;
    }
    if (action === 'onboarding-manual') {
      await onManual();
      return true;
    }
    return false;
  }
  return {
    render,
    observe,
    handle,
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
