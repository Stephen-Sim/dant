import { BackupMode, BackupPhase, ConnectionStatus, isEnumValue } from '../shared/states.mts';
import {
  BACKUP_CHECK_INTERVAL_MS,
  BACKUP_CATALOG_LIMIT,
  BACKUP_ERROR_CODES,
  BACKUP_INTERVAL_MINUTES,
  BACKUP_RETENTION_COUNT,
  BACKUP_WARNING_CODES,
} from './backup-limits.mts';
import type {
  BackupMetadata,
  BackupPreview,
  BackupSettings,
  BackupStatus,
} from './backup-types.ts';
import { backupId, isBackupMetadata } from './backup-contracts.mts';
import type {
  ApiRequest,
  CancelTimer,
  ScheduleTimer,
  Timer,
  UiState,
} from '../shared/contracts.mts';
import { isRecord, isSafeInteger, requestError } from '../shared/contracts.mts';
import { escapeHtml as escape } from '../shared/html.mts';
import { languageInfo } from '../i18n/languages.mts';
import { localizeMessages } from '../i18n/messages.mts';
import { backupMessages } from './vm-backup-copy.mts';
import { createBackupTransfer, validBackupPassphrase } from '../platform/backup-transfer.mts';
import type { BackupTransfer } from '../platform/backup-transfer.mts';
import {
  arrayOf,
  booleanValue as boolean,
  nullable,
  objectOf,
  optional,
  stringValue as string,
} from '../shared/validation.mts';

const BACKUP_BUSY_POLL_MS = 2_000;
const BACKUP_ID_LIMIT = 128;
const DATE_LIMIT = 8_640_000_000_000_000;
const timestamp = (value: unknown): value is number =>
  isSafeInteger(value) && value > 0 && value <= DATE_LIMIT;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= BACKUP_ID_LIMIT &&
  !/[\x00-\x20\x7f]/.test(value);
const sourceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{12}$/.test(value);
const interval = (value: unknown): value is number =>
  isSafeInteger(value) &&
  value >= BACKUP_INTERVAL_MINUTES.minimum &&
  value <= BACKUP_INTERVAL_MINUTES.maximum;
const retention = (value: unknown): value is number =>
  isSafeInteger(value) &&
  value >= BACKUP_RETENTION_COUNT.minimum &&
  value <= BACKUP_RETENTION_COUNT.maximum;
const settings = objectOf<BackupSettings>({
  mode: (value): value is BackupSettings['mode'] => isEnumValue(BackupMode, value),
  intervalMinutes: interval,
  onConnect: boolean,
  beforeVmChange: boolean,
  retainCount: retention,
});
const metadata = (value: unknown): value is BackupMetadata =>
  isBackupMetadata(value) && timestamp(value.createdAt);
const snapshot = objectOf<BackupStatus>({
  settings,
  availability: objectOf<BackupStatus['availability']>({
    online: boolean,
    supported: boolean,
    reason: optional(string),
  }),
  backups: (value): value is BackupMetadata[] =>
    Array.isArray(value) &&
    value.length <= BACKUP_CATALOG_LIMIT &&
    arrayOf(metadata)(value) &&
    new Set(value.map((item) => item.id)).size === value.length,
  phase: (value): value is BackupStatus['phase'] => isEnumValue(BackupPhase, value),
  lastBackupAt: nullable(timestamp),
  lastError: nullable(string),
  nextAt: nullable(timestamp),
  lastRestoredId: nullable(backupId),
});
export function readBackupStatus(value: unknown): BackupStatus {
  if (!snapshot(value)) throw Error('Invalid backup metadata');
  return value;
}
const preview = objectOf<BackupPreview>({
  backup: metadata,
  confirmation: (value): value is string =>
    identifier(value) ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\x00-\x20\x7f]/.test(value)),
  expiresAt: timestamp,
  target: objectOf<BackupPreview['target']>({ id: sourceId, empty: boolean }),
  warnings: (value): value is BackupPreview['warnings'] =>
    Array.isArray(value) &&
    value.length <= BACKUP_WARNING_CODES.length &&
    value.every((item) => BACKUP_WARNING_CODES.some((code) => code === item)) &&
    new Set(value).size === value.length,
});
interface BackupDraft extends Omit<BackupSettings, 'intervalMinutes'> {
  intervalMinutes: string;
}
interface Operation {
  kind: 'read' | 'save' | 'backup' | 'preview' | 'restore' | 'export' | 'import';
  generation: number;
  scope: string;
}
interface AdmittedOperation {
  kind: 'backup' | 'restore';
  backupId?: string;
  previousBackupAt: number | null;
}
interface BackupOptions {
  request: ApiRequest;
  getState: () => UiState | null;
  getLanguage?: () => unknown;
  connected?: () => boolean;
  onChange?: () => void;
  toast?: (message: string) => void;
  document?: Document;
  now?: () => number;
  setTimer?: ScheduleTimer;
  clearTimer?: CancelTimer;
  desktop?: boolean;
  getToken?: () => string;
  transfer?: BackupTransfer;
}
type TransferForm = { kind: 'import' } | { kind: 'export'; id: string };
type BackupSurface = 'backups' | 'import';
const stateScope = (state: UiState | null): string =>
  JSON.stringify([
    state?.conversationId ?? null,
    state?.settings?.vm?.host ?? null,
    state?.settings?.vm?.user ?? null,
    state?.settings?.vm?.port ?? null,
    state?.settings?.vm?.keyPath ?? null,
    state?.settings?.vm?.knownHosts ?? null,
    state?.settings?.vm?.provider ?? null,
  ]);
const computerOnline = (state: UiState | null): boolean =>
  state?.controller
    ? state.controller.status === ConnectionStatus.Online && state.controller.cached !== true
    : state?.worker?.status === ConnectionStatus.Online;
const busyPhase = (phase: BackupStatus['phase'] | undefined): boolean =>
  phase === BackupPhase.BackingUp || phase === BackupPhase.Restoring;

/** Local backup metadata and explicit restore consent; never starts an agent turn. */
export function createVmBackups({
  request,
  getState,
  getLanguage = () => 'en',
  connected = () => true,
  onChange = () => {},
  toast = () => {},
  document = globalThis.document,
  now = Date.now,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  desktop = false,
  getToken = () => '',
  transfer = createBackupTransfer({ desktop, getToken }),
}: BackupOptions) {
  let visible = false,
    surface: BackupSurface = 'backups',
    disposed = false,
    generation = 0,
    identity = stateScope(getState()),
    lastConnected = connected(),
    lastComputerOnline = computerOnline(getState()),
    data: BackupStatus | null = null,
    draft: BackupDraft | null = null,
    consent: BackupPreview | null = null,
    pending: Operation | null = null,
    admitted: AdmittedOperation | null = null,
    timer: Timer | undefined,
    error: keyof typeof backupMessages.en | null = null,
    uncertain = false,
    fresh = false,
    refreshNeeded = true,
    transferForm: TransferForm | null = null,
    exportSelection: string | null = null,
    transferNotice: keyof typeof backupMessages.en | null = null;
  const copy = () => localizeMessages(backupMessages, getLanguage());
  const changed = () => {
    if (visible && !disposed) onChange();
  };
  const stopTimer = () => {
    clearTimer(timer);
    timer = undefined;
  };
  function clearTransferFields() {
    document.querySelectorAll<HTMLInputElement>('[data-backup-transfer] input').forEach((input) => {
      input.value = '';
    });
  }
  function synchronize() {
    const scope = stateScope(getState()),
      online = connected(),
      reachable = computerOnline(getState());
    if (scope !== identity || (lastConnected && !online) || (lastComputerOnline && !reachable)) {
      clearTransferFields();
      transferForm = null;
      transferNotice = null;
      generation++;
      pending = null;
      consent = null;
      admitted = null;
      fresh = false;
      stopTimer();
      refreshNeeded = true;
      if (scope !== identity) {
        exportSelection = null;
        data = null;
        draft = null;
        error = null;
        uncertain = false;
      }
      identity = scope;
    }
    if ((!lastConnected && online) || (!lastComputerOnline && reachable)) refreshNeeded = true;
    lastConnected = online;
    lastComputerOnline = reachable;
    if (consent && consent.expiresAt <= now()) {
      consent = null;
      error = 'expired';
    }
  }
  const current = (operation: Operation) =>
    visible &&
    !disposed &&
    pending === operation &&
    operation.generation === generation &&
    operation.scope === stateScope(getState()) &&
    connected();
  const ready = () =>
    fresh &&
    connected() &&
    computerOnline(getState()) &&
    data?.availability.online === true &&
    data.availability.supported === true;
  const unknownFailure = () =>
    data !== null &&
    ([data.lastError, data.availability.reason].some(
      (value) =>
        value !== undefined && value !== null && !BACKUP_ERROR_CODES.some((code) => code === value),
    ) ||
      data.lastError === 'backup_restore_unconfirmed');
  const locked = () =>
    Boolean(
      pending ||
      admitted ||
      busyPhase(data?.phase) ||
      data?.phase === BackupPhase.Unknown ||
      uncertain ||
      unknownFailure(),
    );
  function schedule() {
    stopTimer();
    if (visible && !disposed && connected() && !pending) {
      const delay =
        admitted || busyPhase(data?.phase) ? BACKUP_BUSY_POLL_MS : BACKUP_CHECK_INTERVAL_MS;
      timer = setTimer(() => {
        timer = undefined;
        void load();
      }, delay);
    }
  }
  function begin(kind: Operation['kind']): Operation | null {
    synchronize();
    if (!visible || disposed || !connected() || pending) return null;
    stopTimer();
    const operation = { kind, generation, scope: identity };
    pending = operation;
    changed();
    return operation;
  }
  function finish(operation: Operation) {
    if (pending === operation) {
      pending = null;
      changed();
      schedule();
    }
  }
  function observe(value: BackupStatus) {
    data = value;
    fresh = true;
    if (value.phase !== BackupPhase.Unknown) uncertain = false;
    if (busyPhase(value.phase)) error = null;
    if (
      consent &&
      (!value.backups.some((item) => item.id === consent?.backup.id) ||
        !value.availability.online ||
        !value.availability.supported ||
        busyPhase(value.phase))
    )
      consent = null;
    if (!admitted) return;
    if (value.phase === BackupPhase.Failed || value.phase === BackupPhase.Unknown) {
      error = value.phase === BackupPhase.Unknown ? BackupPhase.Unknown : BackupPhase.Failed;
      admitted = null;
    } else if (
      value.phase === BackupPhase.Idle &&
      ((admitted.kind === 'backup' && value.lastBackupAt !== admitted.previousBackupAt) ||
        (admitted.kind === 'restore' && value.lastRestoredId === admitted.backupId))
    ) {
      toast(copy()[admitted.kind === 'backup' ? 'saved' : 'restored']);
      admitted = null;
    }
  }
  async function load(manual = false) {
    if (manual) {
      consent = null;
      error = null;
    }
    refreshNeeded = false;
    const operation = begin('read');
    if (!operation) return;
    try {
      const result = await request('/backups');
      if (!current(operation)) return;
      if (!snapshot(result)) throw Error('Invalid backup metadata');
      if (error === 'loadFailed') error = null;
      observe(result);
    } catch {
      if (current(operation)) {
        error = 'loadFailed';
        fresh = false;
        consent = null;
      }
    } finally {
      finish(operation);
    }
  }
  function capture(form: HTMLFormElement): BackupDraft | null {
    const mode = form.querySelector<HTMLSelectElement>('[name="mode"]'),
      minutes = form.querySelector<HTMLInputElement>('[name="intervalMinutes"]'),
      onConnect = form.querySelector<HTMLInputElement>('[name="onConnect"]'),
      beforeVmChange = form.querySelector<HTMLInputElement>('[name="beforeVmChange"]');
    if (
      !mode ||
      !minutes ||
      !onConnect ||
      !beforeVmChange ||
      !data ||
      !isEnumValue(BackupMode, mode.value)
    )
      return null;
    draft = {
      mode: mode.value,
      intervalMinutes: minutes.value,
      onConnect: onConnect.checked,
      beforeVmChange: beforeVmChange.checked,
      retainCount: draft?.retainCount ?? data.settings.retainCount,
    };
    return draft;
  }
  async function save(form: HTMLFormElement) {
    if (pending || admitted || busyPhase(data?.phase)) return;
    const proposed = capture(form);
    if (!proposed) return;
    const body = { ...proposed, intervalMinutes: Number(proposed.intervalMinutes) };
    if (!settings(body)) {
      error = 'invalidSettings';
      changed();
      return;
    }
    const operation = begin('save');
    if (!operation) return;
    try {
      const result = await request('/backups/settings', { method: 'PATCH', body });
      if (!current(operation)) return;
      if (!snapshot(result)) throw Error('Invalid backup settings result');
      observe(result);
      draft = null;
      error = null;
      consent = null;
      toast(copy().settingsSaved);
    } catch {
      if (current(operation)) error = 'settingsFailed';
    } finally {
      finish(operation);
    }
  }
  async function backUp() {
    synchronize();
    if (!ready() || locked()) return;
    const operation = begin('backup');
    if (!operation) return;
    const previousBackupAt = data?.lastBackupAt ?? null;
    try {
      const result = await request('/backups/run', { method: 'POST', body: {} });
      if (!current(operation)) return;
      if (!isRecord(result) || result.started !== true) throw Error('Backup admission unconfirmed');
      admitted = { kind: 'backup', previousBackupAt };
      error = null;
      consent = null;
    } catch (cause) {
      if (current(operation)) {
        const status = requestError(cause).status;
        uncertain = status === undefined || status >= 500 || status === 408;
        error = uncertain ? BackupPhase.Unknown : BackupPhase.Failed;
      }
    } finally {
      finish(operation);
    }
    if (
      visible &&
      operation.generation === generation &&
      operation.scope === stateScope(getState())
    )
      await load();
  }
  async function prepare(id: string) {
    synchronize();
    if (!ready() || locked() || !data?.backups.some((item) => item.id === id)) return;
    consent = null;
    const operation = begin('preview');
    if (!operation) return;
    try {
      const result = await request(`/backups/${encodeURIComponent(id)}/preview`, {
        method: 'POST',
        body: {},
      });
      if (!current(operation)) return;
      if (!preview(result) || result.backup.id !== id || result.expiresAt <= now())
        throw Error('Invalid restore preview');
      consent = result;
      error = null;
    } catch {
      if (current(operation)) error = 'previewFailed';
    } finally {
      finish(operation);
    }
    if (consent && operation.generation === generation)
      document.querySelector<HTMLElement>('[data-backup-preview]')?.focus({ preventScroll: true });
  }
  async function restore() {
    synchronize();
    if (!consent || !ready() || locked()) return;
    const approved = consent,
      operation = begin('restore');
    if (!operation) return;
    // A confirmation is single use locally too. An ambiguous response never resends it.
    consent = null;
    try {
      const result = await request(`/backups/${encodeURIComponent(approved.backup.id)}/restore`, {
        method: 'POST',
        body: { confirmation: approved.confirmation },
      });
      if (!current(operation)) return;
      if (!isRecord(result) || result.started !== true)
        throw Error('Restore admission unconfirmed');
      admitted = {
        kind: 'restore',
        backupId: approved.backup.id,
        previousBackupAt: data?.lastBackupAt ?? null,
      };
      error = null;
    } catch (cause) {
      if (current(operation)) {
        const status = requestError(cause).status;
        uncertain = status === undefined || status >= 500 || status === 408;
        error = uncertain ? BackupPhase.Unknown : BackupPhase.Failed;
      }
    } finally {
      finish(operation);
    }
    if (
      visible &&
      operation.generation === generation &&
      operation.scope === stateScope(getState())
    )
      await load();
  }
  async function transferFile(form: HTMLFormElement) {
    const selected = transferForm;
    if (!selected || pending || disposed || !visible || !connected()) return;
    const password = form.querySelector<HTMLInputElement>('[name="backupPassphrase"]')?.value ?? '';
    const confirmation = form.querySelector<HTMLInputElement>(
      '[name="backupPassphraseConfirm"]',
    )?.value;
    const file = form.querySelector<HTMLInputElement>('[name="backupTransferFile"]')?.files?.[0];
    if (!validBackupPassphrase(password)) {
      transferNotice = 'passphraseInvalid';
      changed();
      return;
    }
    if (selected.kind === 'export' && confirmation !== password) {
      transferNotice = 'passphraseMismatch';
      changed();
      return;
    }
    clearTransferFields();
    const operation = begin(selected.kind);
    if (!operation) return;
    transferNotice = null;
    try {
      if (selected.kind === 'export') {
        const saved = await transfer.exportBackup(selected.id, password);
        if (!current(operation)) return;
        if (saved) {
          toast(copy().exported);
          transferForm = null;
        }
      } else {
        const imported = await transfer.importBackup(password, file);
        if (!current(operation)) return;
        if (imported !== null) {
          if (!isBackupMetadata(imported)) throw Error('Invalid portable backup');
          toast(copy().imported);
          transferForm = null;
        }
      }
    } catch (cause) {
      if (current(operation)) {
        const code = requestError(cause).code;
        transferNotice =
          code === 'backup_passphrase_invalid'
            ? 'passphraseInvalid'
            : code === 'backup_invalid'
              ? 'portableInvalid'
              : code === 'backup_size_limit'
                ? 'transferTooLarge'
                : code === 'backup_exists'
                  ? 'alreadyImported'
                  : code === 'backup_busy'
                    ? 'transferBusy'
                    : code === 'backup_transfer_unconfirmed'
                      ? 'transferUnknown'
                      : 'transferFailed';
      }
    } finally {
      if (pending === operation) clearTransferFields();
      finish(operation);
    }
    if (
      visible &&
      operation.generation === generation &&
      operation.scope === stateScope(getState())
    )
      await load();
  }
  async function openImport() {
    if (disposed || pending) return;
    setVisible(true, 'import');
    clearTransferFields();
    transferForm = { kind: 'import' };
    transferNotice = null;
    changed();
    if (connected() && !pending) await load();
    document.querySelector<HTMLInputElement>('[name="backupPassphrase"]')?.focus();
  }
  function openExport(id: string | undefined) {
    synchronize();
    if (
      disposed ||
      !visible ||
      pending ||
      !connected() ||
      !id ||
      !data?.backups.some((item) => item.id === id)
    )
      return;
    clearTransferFields();
    exportSelection = id;
    transferForm = { kind: 'export', id };
    transferNotice = null;
    changed();
    document.querySelector<HTMLInputElement>('[name="backupPassphrase"]')?.focus();
  }
  function renderTransfer(kind: TransferForm['kind']) {
    if (transferForm?.kind !== kind) return '';
    const tr = copy();
    return `<form data-backup-transfer data-key="backup-portable-form-${kind}" class="manual-vm-details"><h3>${kind === 'import' ? tr.importFile : tr.exportFile}</h3><p class="muted">${tr.passwordHint}</p><label>${tr.passphrase}<input type="password" name="backupPassphrase" autocomplete="off" required ${pending ? 'disabled' : ''}></label>${kind === 'export' ? `<label>${tr.confirmPassphrase}<input type="password" name="backupPassphraseConfirm" autocomplete="off" required ${pending ? 'disabled' : ''}></label>` : !desktop ? `<label>${tr.portableFile}<input type="file" name="backupTransferFile" accept=".dant" required ${pending ? 'disabled' : ''}></label>` : ''}<div class="inline-actions"><button type="submit" class="text-btn" ${pending || !connected() ? 'disabled' : ''}>${pending ? tr.transferring : kind === 'export' ? tr.exportFile : desktop ? tr.chooseImport : tr.importFile}</button><button type="button" class="text-btn" data-backup-transfer-cancel ${pending ? 'disabled' : ''}>${tr.cancel}</button></div></form>`;
  }
  function renderImport() {
    synchronize();
    const tr = copy();
    return `<section class="settings-section setting-card vm-backups vm-backup-import" data-setting-card="backup-import"><div class="card-label"><h2>${tr.importFile}</h2><p>${tr.portableDescription}</p></div><div class="card-content">${!desktop ? `<p class="muted">${tr.webTransferLimit}</p>` : ''}<button type="button" class="text-btn" data-backup-import ${pending || !connected() ? 'disabled' : ''}>${tr.importFile}</button>${transferForm?.kind === 'import' && transferNotice ? `<p role="status">${tr[transferNotice]}</p>` : ''}${renderTransfer('import')}</div></section>`;
  }
  function render() {
    synchronize();
    const tr = copy(),
      locale = languageInfo(getLanguage()).locale,
      number = (value: number) => new Intl.NumberFormat(locale).format(value),
      date = (value: number) =>
        escape(
          new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
            value,
          ),
        ),
      disabled = locked() || !connected(),
      settingsDisabled = Boolean(pending || admitted || busyPhase(data?.phase) || !connected()),
      selected =
        draft ??
        (data
          ? { ...data.settings, intervalMinutes: String(data.settings.intervalMinutes) }
          : null),
      automatic = selected?.mode === BackupMode.Automatic;
    const details = (value: BackupMetadata) =>
      `<small class="muted">${date(value.createdAt)} · ${tr.version} ${escape(value.appVersion)} · ${number(value.files)} ${tr.files} · ${number(value.bytes)} ${tr.bytes}</small>`;
    const status =
      data?.phase === BackupPhase.Idle && data.lastError === 'backup_invalid'
        ? tr.loadFailed
        : data?.phase === BackupPhase.Failed && data.lastError === 'backup_restore_rejected'
          ? tr.rejected
          : error
            ? tr[error]
            : unknownFailure()
              ? tr.unknown
              : !connected() || data?.availability.online === false
                ? tr.offline
                : data?.availability.reason === 'backup_protection_unavailable'
                  ? tr.protectionUnavailable
                  : data?.availability.supported === false
                    ? tr.unsupported
                    : admitted?.kind === 'restore' || data?.phase === BackupPhase.Restoring
                      ? tr.restoring
                      : admitted?.kind === 'backup' || data?.phase === BackupPhase.BackingUp
                        ? tr.backingUp
                        : data?.phase === BackupPhase.Unknown
                          ? tr.unknown
                          : data?.phase === BackupPhase.Failed
                            ? tr.failed
                            : pending?.kind === 'read'
                              ? tr.loading
                              : '';
    const warningCopy: Record<BackupPreview['warnings'][number], string> = {
      'replaces-current-data': tr.replaces,
      'different-computer': tr.different,
      'service-version-differs': tr.differentVersion,
      'tasks-remain-paused': tr.paused,
      'sign-in-required': tr.signIn,
    };
    const selectedExport =
        data?.backups.find((item) => item.id === exportSelection) ?? data?.backups[0],
      exportDisabled = Boolean(pending || !connected() || !selectedExport),
      portableControls = `<div class="manual-vm-details backup-export-controls" data-key="backup-portable-controls"><p class="muted">${tr.portableDescription}</p>${!desktop ? `<small class="muted">${tr.webTransferLimit}</small>` : ''}<label for="backup-export-selection">${tr.backups}</label><div class="backup-export-row"><select id="backup-export-selection" data-backup-export-select ${exportDisabled ? 'disabled' : ''}>${data?.backups.length ? data.backups.map((item) => `<option value="${escape(item.id)}" ${item.id === selectedExport?.id ? 'selected' : ''}>${date(item.createdAt)} · ${tr.version} ${escape(item.appVersion)}</option>`).join('') : `<option value="">${tr.empty}</option>`}</select><button type="button" class="text-btn" data-backup-export-selected ${exportDisabled ? 'disabled' : ''}>${tr.exportFile}</button></div>${!selectedExport ? `<p class="muted" data-backup-export-hint>${tr.exportNeedsBackup}</p>` : ''}${transferForm?.kind === 'export' && transferNotice ? `<p role="status">${tr[transferNotice]}</p>` : ''}${renderTransfer('export')}</div>`;
    const restorePreview = consent
      ? `<section class="setting-card" data-backup-preview tabindex="-1" aria-label="${tr.previewTitle}"><h3>${tr.previewTitle}</h3>${details(consent.backup)}<p>${tr.replaces}</p>${consent.warnings
          .filter((code) => code !== 'replaces-current-data')
          .map((code) => `<p class="muted">${escape(warningCopy[code])}</p>`)
          .join(
            '',
          )}<div class="inline-actions"><button type="button" class="text-btn" data-backup-confirm ${!ready() || disabled || consent.expiresAt <= now() ? 'disabled' : ''}>${tr.restore}</button><button type="button" class="text-btn" data-backup-cancel>${tr.cancel}</button></div></section>`
      : '';
    return `<section class="settings-section setting-card vm-backups" data-setting-card="backups"><div class="card-label"><h2>${tr.title}</h2><p>${tr.description}</p></div><div class="card-content"><div class="setting-row"><strong>${tr.backups}</strong><button type="button" class="text-btn" data-backup-refresh ${pending || !connected() ? 'disabled' : ''}>${tr.refresh}</button></div>${status ? `<p class="muted" role="status">${status}</p>` : ''}${selected ? `<form data-backup-settings><div class="setting-row"><label for="backup-mode">${tr.mode}</label><select id="backup-mode" name="mode" ${settingsDisabled ? 'disabled' : ''}><option value="${BackupMode.Manual}" ${!automatic ? 'selected' : ''}>${tr.manual}</option><option value="${BackupMode.Automatic}" ${automatic ? 'selected' : ''}>${tr.automatic}</option></select></div><div class="setting-row"><label for="backup-interval">${tr.interval}</label><input id="backup-interval" name="intervalMinutes" type="number" min="${BACKUP_INTERVAL_MINUTES.minimum}" max="${BACKUP_INTERVAL_MINUTES.maximum}" step="1" value="${escape(selected.intervalMinutes)}" required ${settingsDisabled || !automatic ? 'disabled' : ''}></div><label class="setting-row"><span>${tr.onConnect}</span><input name="onConnect" type="checkbox" ${selected.onConnect ? 'checked' : ''} ${settingsDisabled || !automatic ? 'disabled' : ''}></label><label class="setting-row"><span>${tr.beforeChange}</span><input name="beforeVmChange" type="checkbox" ${selected.beforeVmChange ? 'checked' : ''} ${settingsDisabled || !automatic ? 'disabled' : ''}></label><div class="form-actions"><button type="submit" class="text-btn" ${settingsDisabled ? 'disabled' : ''}>${tr.save}</button><button type="button" class="text-btn" data-backup-run ${!ready() || disabled ? 'disabled' : ''}>${tr.backupNow}</button></div></form>` : ''}${data ? `<div class="backup-list">${data.backups.length ? data.backups.map((item) => `<article class="setting-row" data-backup-id="${escape(item.id)}"><div>${details(item)}</div><button type="button" class="text-btn" data-backup-export="${escape(item.id)}" ${pending || !connected() ? 'disabled' : ''}>${tr.exportFile}</button><button type="button" class="text-btn" data-backup-prepare="${escape(item.id)}" ${!ready() || disabled ? 'disabled' : ''}>${tr.preview}</button></article>`).join('') : `<p class="muted">${tr.empty}</p>`}</div>` : ''}${restorePreview}${portableControls}</div></section>`;
  }
  function bind() {
    const importButton = document.querySelector<HTMLButtonElement>('[data-backup-import]');
    if (importButton)
      importButton.onclick = () => {
        void openImport();
      };
    document.querySelectorAll<HTMLButtonElement>('[data-backup-export]').forEach((button) => {
      button.onclick = () => openExport(button.dataset.backupExport);
    });
    const exportSelect = document.querySelector<HTMLSelectElement>('[data-backup-export-select]');
    if (exportSelect)
      exportSelect.onchange = () => {
        if (!pending && data?.backups.some((item) => item.id === exportSelect.value))
          exportSelection = exportSelect.value;
      };
    const exportButton = document.querySelector<HTMLButtonElement>('[data-backup-export-selected]');
    if (exportButton) exportButton.onclick = () => openExport(exportSelect?.value);
    const transferElement = document.querySelector<HTMLFormElement>('[data-backup-transfer]');
    if (transferElement)
      transferElement.onsubmit = (event) => {
        event.preventDefault();
        void transferFile(transferElement);
      };
    const cancelTransfer = document.querySelector<HTMLButtonElement>(
      '[data-backup-transfer-cancel]',
    );
    if (cancelTransfer)
      cancelTransfer.onclick = () => {
        if (pending) return;
        clearTransferFields();
        transferForm = null;
        transferNotice = null;
        changed();
      };
    const form = document.querySelector<HTMLFormElement>('[data-backup-settings]');
    if (form) {
      form.oninput = () => {
        if (!pending) capture(form);
      };
      form.onchange = () => {
        if (!pending) {
          capture(form);
          changed();
        }
      };
      form.onsubmit = (event) => {
        event.preventDefault();
        return save(form);
      };
    }
    const refresh = document.querySelector<HTMLButtonElement>('[data-backup-refresh]');
    if (refresh) refresh.onclick = () => load(true);
    const run = document.querySelector<HTMLButtonElement>('[data-backup-run]');
    if (run) run.onclick = backUp;
    document.querySelectorAll<HTMLButtonElement>('[data-backup-prepare]').forEach((button) => {
      button.onclick = () => {
        const id = button.dataset.backupPrepare;
        return id ? prepare(id) : undefined;
      };
    });
    const confirm = document.querySelector<HTMLButtonElement>('[data-backup-confirm]');
    if (confirm) confirm.onclick = restore;
    const cancel = document.querySelector<HTMLButtonElement>('[data-backup-cancel]');
    if (cancel)
      cancel.onclick = () => {
        consent = null;
        error = null;
        changed();
      };
  }
  function setVisible(value: unknown, nextSurface: BackupSurface = 'backups') {
    synchronize();
    if (visible && value && surface !== nextSurface) {
      clearTransferFields();
      transferForm = null;
      transferNotice = null;
      generation++;
      pending = null;
      consent = null;
      stopTimer();
      refreshNeeded = true;
    }
    surface = nextSurface;
    const entered = !visible && Boolean(value);
    visible = Boolean(value);
    if (!visible) {
      clearTransferFields();
      transferForm = null;
      transferNotice = null;
      generation++;
      pending = null;
      consent = null;
      stopTimer();
      return;
    }
    if ((entered || refreshNeeded) && connected()) {
      refreshNeeded = false;
      const run = generation;
      queueMicrotask(() => {
        if (visible && generation === run) void load();
      });
    } else if (visible && connected() && !pending && !timer) schedule();
  }
  function dispose() {
    clearTransferFields();
    transferForm = null;
    transferNotice = null;
    disposed = true;
    visible = false;
    generation++;
    pending = null;
    consent = null;
    admitted = null;
    draft = null;
    data = null;
    stopTimer();
  }
  return { setVisible, load, render, renderImport, bind, dispose, openImport };
}
