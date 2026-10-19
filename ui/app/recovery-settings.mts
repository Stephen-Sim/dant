import {
  BackupMode,
  BackupPhase,
  ConnectionStatus,
  ServiceUpdateStatus,
  isEnumValue,
} from '../../src/contracts/states.mts';
import type { ConnectionStatusValue } from '../../src/contracts/contracts.ts';
import { MAX_PORT } from '../../src/config/network.mts';
import { isLanguage, normalizeLanguage, languageInfo } from '../../src/i18n/languages.mts';
import type { LanguageCode } from '../../src/i18n/languages.mts';
import { localizeMessages } from '../../src/i18n/i18n.mts';
import { isRecord, requestError } from '../shared/contracts.mts';
import type { ApiRequest, UiServiceUpdate, VmSettings } from '../shared/contracts.mts';
import { escapeHtml as escape } from '../shared/html.mts';
import { readBackupStatus } from '../settings/vm-backups.mts';
import { arrayOf, booleanValue, nullable, objectOf, optional } from '../shared/validation.mts';
import { recoveryMessages } from './recovery-copy.mts';
import { loadLanguage } from '../i18n/localization.mts';

const MAX_CONFIGURATION_TEXT = 4096;
const MAX_PROFILES = 1000;
const DEFAULT_SSH_PORT = 22;
const RELEASE_PAGE = 'https://github.com/Stephen-Sim/dant/releases/tag/v';
const version = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 64 &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_CONFIGURATION_TEXT &&
  !/[\x00-\x1f\x7f]/.test(value);
const port = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_PORT;
interface RecoveryProfile {
  id: string;
  label?: string;
}
interface RecoveryConfiguration {
  version: string;
  language: LanguageCode;
  vm: VmSettings;
  status: ConnectionStatusValue;
  serviceUpdate: UiServiceUpdate | null;
  updatesPaused: boolean;
  profiles: { candidates: RecoveryProfile[]; current?: RecoveryProfile | null };
  providers: {
    provider?: string | null;
    availableProviders: { id: string; available: boolean; reason?: string | null }[];
  };
}
const profile = objectOf<RecoveryProfile>({
  id: (value): value is string => text(value) && value.length > 0,
  label: optional(text),
});
const configuration = objectOf<RecoveryConfiguration>({
  version,
  language: isLanguage,
  vm: objectOf<VmSettings>({
    host: optional(text),
    user: optional(text),
    port: optional(port),
    keyPath: optional(text),
    knownHosts: optional(text),
    provider: optional(text),
  }),
  status: (value): value is ConnectionStatusValue => isEnumValue(ConnectionStatus, value),
  serviceUpdate: nullable(
    (value): value is UiServiceUpdate =>
      isRecord(value) &&
      isEnumValue(ServiceUpdateStatus, value.status) &&
      typeof value.confirmed === 'boolean' &&
      version(value.targetVersion) &&
      (value.runningVersion === null || version(value.runningVersion)) &&
      (value.reason === null || text(value.reason)),
  ),
  updatesPaused: booleanValue,
  profiles: objectOf<RecoveryConfiguration['profiles']>({
    candidates: (value): value is RecoveryProfile[] =>
      Array.isArray(value) &&
      value.length <= MAX_PROFILES &&
      arrayOf(profile)(value) &&
      new Set(value.map((item) => item.id)).size === value.length,
    current: optional(nullable(profile)),
  }),
  providers: objectOf<RecoveryConfiguration['providers']>({
    provider: optional(nullable(text)),
    availableProviders: arrayOf(
      objectOf<RecoveryConfiguration['providers']['availableProviders'][number]>({
        id: text,
        available: booleanValue,
        reason: optional(nullable(text)),
      }),
    ),
  }),
});
export function readRecoveryConfiguration(value: unknown): RecoveryConfiguration {
  if (!configuration(value)) throw Error('Invalid recovery configuration');
  return value;
}
interface RecoveryOptions {
  container: HTMLElement;
  request: ApiRequest;
  getLanguage?: () => unknown;
  onRetry: () => Promise<void>;
  openExternal: (url: string) => Promise<unknown>;
}
interface ConnectionDraft {
  host: string;
  user: string;
  port: string;
  keyPath: string;
  knownHosts: string;
}

/** Recovery only consumes local Controller configuration, never a fabricated chat snapshot. */
export function createRecoverySettings({
  container,
  request,
  getLanguage = () => 'en',
  onRetry,
  openExternal,
}: RecoveryOptions) {
  let generation = 0,
    visible = false,
    busy = false,
    settingsOpen = false,
    stateUnavailable = false,
    settings: RecoveryConfiguration | null = null,
    draft: ConnectionDraft = {
      host: '',
      user: '',
      port: String(DEFAULT_SSH_PORT),
      keyPath: '',
      knownHosts: '',
    },
    selectedProfile = '',
    consent = false,
    submissionUnconfirmed = false,
    needsConsent = false,
    notice = '',
    releaseUrl = '',
    updateVersion = '';
  const words = () =>
    localizeMessages(recoveryMessages, settings?.language ?? normalizeLanguage(getLanguage()));
  const locale = () => languageInfo(settings?.language ?? normalizeLanguage(getLanguage()));
  const current = (run: number) => visible && run === generation;
  const disabled = () => (busy ? 'disabled aria-busy="true"' : '');
  function render() {
    if (!visible) return;
    const copy = words();
    const fields: [keyof ConnectionDraft, string][] = [
      ['host', copy.host],
      ['user', copy.user],
      ['port', copy.port],
      ['keyPath', copy.keyPath],
      ['knownHosts', copy.knownHosts],
    ];
    container.innerHTML = `<div class="boot-error recovery-settings" lang="${locale().locale}" dir="${locale().direction}"><h1>dant</h1><p>${escape(stateUnavailable || settings ? copy.unavailable : copy.connectionUnavailable)}</p><div class="inline-actions"><button type="button" data-recovery-retry ${disabled()}>${escape(copy.retry)}</button><button type="button" data-recovery-settings ${disabled()}>${escape(copy.settings)}</button><button type="button" data-recovery-updates ${disabled()}>${escape(copy.checkUpdates)}</button></div>${settingsOpen ? `<section class="setting-card"><div class="card-content"><h2>${escape(copy.settings)}</h2>${settings ? `<p>${escape(copy.localConnected)} · ${escape(copy.version)} ${escape(settings.version)} · ${escape(copy.settings)}: ${escape(settings.status === ConnectionStatus.Online ? copy.online : settings.status === ConnectionStatus.Connecting ? copy.connecting : copy.offline)}</p><form data-recovery-form>${fields.map(([name, label]) => `<label class="setting-row"><span>${escape(label)}</span><input data-recovery-field="${name}" name="${name}" value="${escape(draft[name])}" ${name === 'port' ? `type="number" min="1" max="${MAX_PORT}"` : 'type="text"'} ${disabled()} ${name === 'host' || name === 'user' ? 'required' : ''} autocomplete="off" spellcheck="false"></label>`).join('')}<div class="inline-actions"><button type="submit" ${disabled()} ${submissionUnconfirmed ? 'disabled' : ''}>${escape(copy.save)}</button></div></form>${settings.profiles.candidates.length ? `<label class="setting-row"><span>${escape(copy.profile)}</span><select data-recovery-profile ${disabled()}><option value="">${escape(copy.chooseProfile)}</option>${settings.profiles.candidates.map((item) => `<option value="${escape(item.id)}" ${item.id === selectedProfile ? 'selected' : ''}>${escape(item.label || item.id)}</option>`).join('')}</select></label><button type="button" data-recovery-import ${disabled()} ${submissionUnconfirmed ? 'disabled' : ''} ${selectedProfile ? '' : 'disabled'}>${escape(copy.useProfile)}</button>` : ''}${needsConsent ? `<label class="setting-row"><input type="checkbox" data-recovery-consent ${consent ? 'checked' : ''} ${disabled()}><span>${escape(copy.skipBackup)}</span></label><p>${escape(copy.keepOld)}</p>` : ''}` : `<p>${escape(copy.loadingFailed)}</p>`}</div></section>` : ''}<p role="status" aria-live="polite" data-recovery-notice>${escape(notice)}</p>${releaseUrl ? `<button type="button" data-recovery-release ${disabled()}>${escape(copy.openRelease)} ${escape(updateVersion)}</button>` : ''}</div>`;
    const retry = container.querySelector<HTMLButtonElement>('[data-recovery-retry]');
    if (retry)
      retry.onclick = () => {
        void retryConnection();
      };
    const open = container.querySelector<HTMLButtonElement>('[data-recovery-settings]');
    if (open)
      open.onclick = () => {
        void loadSettings();
      };
    const updates = container.querySelector<HTMLButtonElement>('[data-recovery-updates]');
    if (updates)
      updates.onclick = () => {
        void checkUpdates();
      };
    for (const [name] of fields) {
      const input = container.querySelector<HTMLInputElement>(`[data-recovery-field="${name}"]`);
      if (input)
        input.oninput = () => {
          draft[name] = input.value;
          consent = false;
        };
    }
    const select = container.querySelector<HTMLSelectElement>('[data-recovery-profile]');
    if (select)
      select.onchange = () => {
        selectedProfile = select.value;
        consent = false;
        render();
      };
    const checkbox = container.querySelector<HTMLInputElement>('[data-recovery-consent]');
    if (checkbox)
      checkbox.onchange = () => {
        consent = checkbox.checked;
      };
    const form = container.querySelector<HTMLFormElement>('[data-recovery-form]');
    if (form)
      form.onsubmit = (event) => {
        event.preventDefault();
        void save(false);
      };
    const use = container.querySelector<HTMLButtonElement>('[data-recovery-import]');
    if (use)
      use.onclick = () => {
        void save(true);
      };
    const release = container.querySelector<HTMLButtonElement>('[data-recovery-release]');
    if (release)
      release.onclick = () => {
        const url = releaseUrl;
        if (url)
          void openExternal(url).catch(() => {
            if (visible) {
              notice = words().updateFailed;
              render();
            }
          });
      };
  }
  async function loadSettings() {
    if (!visible || busy) return;
    const run = generation;
    busy = true;
    settingsOpen = true;
    notice = '';
    render();
    try {
      const result = readRecoveryConfiguration(await request('/api/controller/settings'));
      await loadLanguage(result.language);
      if (!current(run)) return;
      settings = result;
      draft = {
        host: result.vm.host ?? '',
        user: result.vm.user ?? '',
        port: String(result.vm.port ?? DEFAULT_SSH_PORT),
        keyPath: result.vm.keyPath ?? '',
        knownHosts: result.vm.knownHosts ?? '',
      };
      selectedProfile = '';
      consent = false;
      needsConsent = false;
      submissionUnconfirmed = false;
    } catch {
      if (current(run)) {
        settings = null;
        notice = words().loadingFailed;
      }
    } finally {
      if (current(run)) {
        busy = false;
        render();
      }
    }
  }
  async function retryConnection() {
    if (!visible || busy) return;
    const run = generation;
    busy = true;
    render();
    try {
      await onRetry();
    } catch {
      if (current(run)) notice = words().unavailable;
    } finally {
      if (current(run)) {
        busy = false;
        render();
      }
    }
  }
  async function checkUpdates() {
    if (!visible || busy) return;
    const run = generation;
    busy = true;
    notice = '';
    releaseUrl = '';
    updateVersion = '';
    render();
    try {
      const value = await request('/api/updates?channel=beta');
      if (!current(run)) return;
      if (
        !isRecord(value) ||
        !version(value.currentVersion) ||
        !version(value.latestVersion) ||
        value.channel !== 'beta' ||
        typeof value.updateAvailable !== 'boolean' ||
        value.releaseUrl !== RELEASE_PAGE + value.latestVersion
      )
        throw Error('Invalid update metadata');
      releaseUrl = RELEASE_PAGE + value.latestVersion;
      updateVersion = value.latestVersion;
      notice = value.updateAvailable ? words().updateAvailable : words().upToDate;
    } catch {
      if (current(run)) notice = words().updateFailed;
    } finally {
      if (current(run)) {
        busy = false;
        render();
      }
    }
  }
  async function save(useProfile: boolean) {
    if (!visible || busy || !settings || submissionUnconfirmed) return;
    if (useProfile && !settings.profiles.candidates.some((item) => item.id === selectedProfile))
      return;
    const connection = {
      host: draft.host.trim(),
      user: draft.user.trim(),
      port: Number(draft.port),
      keyPath: draft.keyPath.trim(),
      knownHosts: draft.knownHosts.trim(),
    };
    if (
      !useProfile &&
      (!connection.host ||
        !connection.user ||
        !Object.values(connection).every((value) =>
          typeof value === 'number' ? port(value) : text(value),
        ))
    ) {
      notice = words().invalid;
      render();
      return;
    }
    const run = generation,
      profileId = selectedProfile,
      confirmed = consent;
    let submitted = false;
    busy = true;
    notice = '';
    render();
    try {
      const latest = readRecoveryConfiguration(await request('/api/controller/settings'));
      if (!current(run)) return;
      if (JSON.stringify(latest.vm) !== JSON.stringify(settings.vm)) {
        consent = false;
        notice = words().changed;
        return;
      }
      const backup = readBackupStatus(await request('/api/backups'));
      if (!current(run)) return;
      if (
        backup.phase === BackupPhase.BackingUp ||
        backup.phase === BackupPhase.Restoring ||
        backup.phase === BackupPhase.Unknown ||
        backup.lastError === 'backup_restore_unconfirmed'
      ) {
        notice = words().backupBusy;
        return;
      }
      const cannotProtect =
        backup.settings.mode === BackupMode.Automatic &&
        backup.settings.beforeVmChange &&
        (!backup.availability.online || !backup.availability.supported);
      if (cannotProtect && !confirmed) {
        needsConsent = true;
        notice = words().backupUnavailable;
        return;
      }
      const once = cannotProtect && confirmed ? { skipBackupOnce: true } : {};
      submitted = true;
      const response = await request(useProfile ? '/api/vm/import' : '/api/settings', {
        method: useProfile ? 'POST' : 'PATCH',
        body: useProfile
          ? { id: profileId, replaceCurrent: true, ...once }
          : { vm: connection, ...once },
      });
      if (!current(run)) return;
      if (!isRecord(response) || response.ok !== true) throw Error('Invalid configuration result');
      consent = false;
      needsConsent = false;
      notice = words().saved;
    } catch (cause) {
      if (current(run)) {
        const error = requestError(cause);
        submissionUnconfirmed =
          submitted && (error.unknownOutcome === true || error.status === undefined);
        notice = submissionUnconfirmed
          ? words().unknown
          : error.code === 'backup_before_vm_change_required'
            ? words().backupFirst
            : words().saveFailed;
      }
    } finally {
      if (current(run)) {
        busy = false;
        render();
      }
    }
  }
  return {
    show(options: { stateUnavailable?: boolean } = {}) {
      stateUnavailable = options.stateUnavailable === true;
      generation++;
      visible = true;
      busy = false;
      settingsOpen = false;
      settings = null;
      consent = false;
      needsConsent = false;
      submissionUnconfirmed = false;
      releaseUrl = '';
      updateVersion = '';
      notice = '';
      render();
    },
    hide() {
      generation++;
      visible = false;
      busy = false;
      consent = false;
      needsConsent = false;
    },
  };
}
