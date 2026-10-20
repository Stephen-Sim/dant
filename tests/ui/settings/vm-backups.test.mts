import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createVmBackups } from '../../../ui/settings/vm-backups.mts';
import { backupMessages } from '../../../ui/settings/vm-backup-copy.mts';
import { loadLanguage } from '../../../ui/i18n/localization.mts';
import { languages } from '../../../ui/i18n/languages.mts';
import { BackupMode, BackupPhase, ConnectionStatus } from '../../../ui/shared/states.mts';
import type {
  BackupMetadata,
  BackupPreview,
  BackupStatus,
} from '../../../ui/settings/backup-types.ts';
import type { ApiOptions, ApiRequest, Timer, UiState } from '../../../ui/shared/contracts.mts';
import { isRecord, LocalRequestError } from '../../../ui/shared/contracts.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { reconcile } from '../../../ui/shared/dom.mts';
import type { BackupTransfer } from '../../../ui/platform/backup-transfer.mts';
import fs from 'node:fs';
import { compactCss } from '../../support/source-fixtures.mts';

const BACKUP_ID = '00000000-0000-4000-8000-000000000001';
const NOW = Date.UTC(2026, 9, 20, 1);
const metadata = (): BackupMetadata => ({
  id: BACKUP_ID,
  createdAt: NOW - 60_000,
  appVersion: '0.4.7-beta.8',
  bytes: 2048,
  files: 12,
  source: '012345abcdef',
});
const snapshot = (): BackupStatus => ({
  settings: {
    mode: BackupMode.Automatic,
    intervalMinutes: 60,
    onConnect: true,
    beforeVmChange: true,
    retainCount: 42,
  },
  availability: { online: true, supported: true },
  backups: [metadata()],
  phase: BackupPhase.Idle,
  lastBackupAt: NOW - 60_000,
  lastError: null,
  nextAt: NOW + 3_600_000,
  lastRestoredId: null,
});
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
type Hook = (route: string, options: ApiOptions | undefined, next: () => unknown) => unknown;
function fixture({
  online = true,
  supported = true,
  language = 'en',
  desktop = false,
  transfer,
}: {
  online?: boolean;
  supported?: boolean;
  language?: string;
  desktop?: boolean;
  transfer?: BackupTransfer;
} = {}) {
  const { document, Event, HTMLInputElement } = parseHTML(
      '<html><body><main id="app"></main></body></html>',
    ),
    app = defined(document.querySelector<HTMLElement>('#app')),
    calls: { route: string; options: ApiOptions | undefined }[] = [],
    toasts: string[] = [],
    timers = new Map<Timer, { callback: () => void; delay: number }>(),
    state: UiState = {
      conversationId: 'conversation-a',
      settings: { language, vm: { host: '192.0.2.10', user: 'fixture' } },
      worker: { status: online ? ConnectionStatus.Online : ConnectionStatus.Offline },
      controller: {
        status: online ? ConnectionStatus.Online : ConnectionStatus.Offline,
        cached: false,
      },
    },
    backend = snapshot();
  backend.availability = { online, supported };
  let clock = NOW,
    nextTimer = 0,
    connected = true,
    hook: Hook | null = null,
    ui: ReturnType<typeof createVmBackups>;
  Object.defineProperty(HTMLInputElement.prototype, 'checked', {
    configurable: true,
    get() {
      return this.hasAttribute('checked');
    },
    set(value: boolean) {
      this.toggleAttribute('checked', value);
    },
  });
  function preview(): BackupPreview {
    return {
      backup: structuredClone(defined(backend.backups[0])),
      confirmation: 'fixture-confirmation-token',
      expiresAt: clock + 300_000,
      target: { id: 'abcdef012345', empty: false },
      warnings: ['replaces-current-data', 'tasks-remain-paused', 'sign-in-required'],
    };
  }
  function respond(route: string, options: ApiOptions | undefined): unknown {
    if (route === '/backups') return structuredClone(backend);
    if (route === '/backups/settings') {
      assert.equal(options?.method, 'PATCH');
      const body = options.body;
      assert.ok(isRecord(body));
      assert.ok(body.mode === BackupMode.Manual || body.mode === BackupMode.Automatic);
      assert.ok(typeof body.intervalMinutes === 'number');
      assert.ok(typeof body.onConnect === 'boolean');
      assert.ok(typeof body.beforeVmChange === 'boolean');
      assert.ok(typeof body.retainCount === 'number');
      backend.settings = {
        mode: body.mode,
        intervalMinutes: body.intervalMinutes,
        onConnect: body.onConnect,
        beforeVmChange: body.beforeVmChange,
        retainCount: body.retainCount,
      };
      return structuredClone(backend);
    }
    if (route === '/backups/run') {
      backend.phase = BackupPhase.BackingUp;
      return { started: true };
    }
    if (route === `/backups/${BACKUP_ID}/preview`) return preview();
    if (route === `/backups/${BACKUP_ID}/restore`) {
      assert.deepEqual(options?.body, { confirmation: 'fixture-confirmation-token' });
      backend.phase = BackupPhase.Restoring;
      return { started: true };
    }
    throw Error('Unexpected fixture route');
  }
  const request: ApiRequest = async (route, options) => {
    calls.push({ route, options });
    const next = () => respond(route, options);
    return hook ? hook(route, options, next) : next();
  };
  function render() {
    const template = document.createElement('template');
    template.innerHTML = ui.render() + ui.renderImport();
    reconcile(app, template.content);
    ui.bind();
  }
  ui = createVmBackups({
    desktop,
    ...(transfer ? { transfer } : {}),
    document,
    getState: () => state,
    getLanguage: () => state.settings?.language,
    connected: () => connected,
    onChange: render,
    toast: (message) => toasts.push(message),
    request,
    now: () => clock,
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id) => {
      if (id !== undefined) timers.delete(id);
    },
  });
  render();
  ui.setVisible(true);
  const button = (selector: string) => defined(document.querySelector<HTMLButtonElement>(selector));
  const passwordControls = new WeakSet<HTMLInputElement>();
  const input = (name: string) => {
    const node = defined(document.querySelector<HTMLInputElement>(`[name="${name}"]`));
    // LinkeDOM reflects value into attributes; browser passwords keep a dirty live value.
    if (node.type === 'password' && !passwordControls.has(node)) {
      let value = node.value;
      Object.defineProperty(node, 'value', {
        configurable: true,
        get: () => value,
        set: (next: string) => {
          value = next;
        },
      });
      passwordControls.add(node);
    }
    return node;
  };
  return {
    ui,
    state,
    backend,
    document,
    Event,
    calls,
    toasts,
    timers,
    render,
    button,
    input,
    preview,
    setHook(value: Hook | null) {
      hook = value;
    },
    setConnected(value: boolean) {
      connected = value;
      ui.setVisible(true);
      render();
    },
    advance(ms: number) {
      clock += ms;
    },
    async tick() {
      const entry = defined([...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0]);
      timers.delete(entry[0]);
      clock += entry[1].delay;
      entry[1].callback();
      await settle();
    },
    changeMode(mode: string) {
      const select = defined(document.querySelector<HTMLSelectElement>('[name="mode"]'));
      for (const option of select.querySelectorAll<HTMLOptionElement>('option'))
        option.toggleAttribute('selected', option.value === mode);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    },
    submit() {
      defined(document.querySelector<HTMLFormElement>('[data-backup-settings]')).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    },
  };
}

test('backup fields keep separate spaced rows, associated labels and bounded controls that stack on narrow screens', async () => {
  const f = fixture();
  await settle();
  const form = defined(f.document.querySelector<HTMLElement>('[data-backup-settings]')),
    mode = defined(form.querySelector<HTMLSelectElement>('#backup-mode')),
    interval = defined(form.querySelector<HTMLInputElement>('#backup-interval'));
  assert.notEqual(mode.parentElement, interval.parentElement);
  assert.equal(
    defined(form.querySelector('label[for="backup-mode"]')).parentElement,
    mode.parentElement,
  );
  assert.equal(
    defined(form.querySelector('label[for="backup-interval"]')).parentElement,
    interval.parentElement,
  );
  assert.equal(mode.name, 'mode');
  assert.equal(interval.name, 'intervalMinutes');
  assert.equal(form.querySelectorAll('input[type="checkbox"]').length, 2);
  const css = compactCss(
    fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'),
  );
  assert.match(css, /\.vm-backups \[data-backup-settings\]\{[^}]*display:grid;[^}]*gap:12px;/);
  assert.match(css, /\.vm-backups \[data-backup-settings\]>div\.setting-row\{[^}]*flex-wrap:wrap/);
  assert.match(
    css,
    /\.vm-backups \[data-backup-settings\]>\.setting-row>select,[^{]+\{[^}]*width:190px;[^}]*max-width:100%/,
  );
  assert.match(
    css,
    /@media\(max-width:600px\)\{\.vm-backups \[data-backup-settings\]>div\.setting-row\{[^}]*flex-direction:column;[^}]*align-items:stretch;[^}]*gap:8px/,
  );
  assert.match(
    css,
    /\.vm-backups \[data-backup-settings\]>\.setting-row>select,[^{]+\{width:100%;flex:auto/,
  );
  assert.deepEqual(
    f.calls.map((call) => call.route),
    ['/backups'],
  );
  f.ui.dispose();
});

test('opening backup settings reads metadata without initiating any automatic backup or restore', async () => {
  const f = fixture();
  await settle();
  assert.deepEqual(
    f.calls.map((call) => call.route),
    ['/backups'],
  );
  assert.match(f.document.body.textContent, /Work computer backups/);
  assert.match(f.document.body.textContent, /0\.4\.7-beta\.8/);
  assert.match(f.document.body.textContent, /12 files/);
  assert.match(f.document.body.textContent, /2,048 bytes/);
  assert.equal(f.button('[data-backup-run]').disabled, false);
  await f.tick();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.route === '/backups'));
  f.ui.setVisible(false);
  assert.equal(f.timers.size, 0);
  f.ui.dispose();
});

test('an isolated invalid backup shows the fixed catalog warning while valid snapshots remain available', async () => {
  const f = fixture();
  f.backend.lastError = 'backup_invalid';
  await settle();
  await f.ui.load();
  assert.match(f.document.body.textContent, /Backup information could not be loaded/);
  assert.ok(f.document.querySelector('[data-backup-id]'));
  assert.equal(f.button('[data-backup-prepare]').disabled, false);
});

test('import is a separate work-computer card and export stays visible with an explanation before any backup exists', async () => {
  const f = fixture();
  f.backend.backups = [];
  f.backend.lastBackupAt = null;
  await settle();
  const { document } = parseHTML(f.ui.render()),
    imported = parseHTML(f.ui.renderImport()).document;
  assert.ok(document.querySelector('[data-backup-settings]'));
  assert.equal(document.querySelector('[data-backup-import]'), null);
  assert.ok(imported.querySelector('.vm-backup-import[data-setting-card="backup-import"]'));
  assert.ok(imported.querySelector('[data-backup-import]'));
  assert.equal(imported.querySelector('[data-backup-settings]'), null);
  assert.equal(imported.querySelector('[data-backup-export-selected]'), null);
  assert.equal(f.button('[data-backup-export-selected]').disabled, true);
  assert.equal(
    defined(f.document.querySelector<HTMLSelectElement>('[data-backup-export-select]')).disabled,
    true,
  );
  assert.equal(
    defined(f.document.querySelector('[data-backup-export-hint]')).textContent,
    backupMessages.en.exportNeedsBackup,
  );
  f.button('[data-backup-export-selected]').click();
  assert.equal(f.document.querySelector('[data-backup-transfer]'), null);
  assert.ok(f.calls.every((call) => call.route === '/backups'));
  f.ui.dispose();
});

test('the fixed export entry selects a retained local backup and exports only after explicit password confirmation', async () => {
  const exports: string[] = [],
    secondId = '00000000-0000-4000-8000-000000000002',
    f = fixture({
      desktop: true,
      online: false,
      transfer: {
        importBackup: async () => null,
        exportBackup: async (id) => {
          exports.push(id);
          return true;
        },
      },
    });
  f.backend.backups.push({
    ...metadata(),
    id: secondId,
    createdAt: NOW,
    appVersion: '0.4.7-beta.9',
  });
  await settle();
  assert.equal(f.button('[data-backup-export-selected]').disabled, false);
  const select = defined(
    f.document.querySelector<HTMLSelectElement>('[data-backup-export-select]'),
  );
  for (const option of select.querySelectorAll<HTMLOptionElement>('option'))
    option.toggleAttribute('selected', option.value === secondId);
  select.dispatchEvent(new f.Event('change', { bubbles: true }));
  f.render();
  assert.equal(
    defined(f.document.querySelector<HTMLSelectElement>('[data-backup-export-select]')).value,
    secondId,
  );
  f.button('[data-backup-export-selected]').click();
  assert.deepEqual(exports, []);
  assert.ok(f.document.querySelector('[data-setting-card="backups"] [data-backup-transfer]'));
  assert.equal(f.document.querySelector('.vm-backup-import [data-backup-transfer]'), null);
  f.input('backupPassphrase').value = 'isolated export passphrase';
  f.input('backupPassphraseConfirm').value = 'isolated export passphrase';
  defined(f.document.querySelector<HTMLFormElement>('[data-backup-transfer]')).dispatchEvent(
    new f.Event('submit', { cancelable: true }),
  );
  await settle();
  assert.deepEqual(exports, [secondId]);
  assert.equal(f.toasts.at(-1), backupMessages.en.exported);
  assert.ok(f.calls.every((call) => call.route === '/backups'));
  f.ui.dispose();
});

test('switching backup settings surfaces clears passwords and discards their transfer form without taking an action', async () => {
  const f = fixture({ desktop: true });
  await settle();
  await f.ui.openImport();
  const importPassword = f.input('backupPassphrase');
  importPassword.value = 'isolated import passphrase';
  assert.ok(f.document.querySelector('.vm-backup-import [data-backup-transfer]'));
  assert.equal(
    f.document.querySelector('[data-setting-card="backups"] [data-backup-transfer]'),
    null,
  );
  f.ui.setVisible(true, 'backups');
  f.render();
  assert.equal(importPassword.value, '');
  assert.equal(f.document.querySelector('[data-backup-transfer]'), null);
  await settle();
  f.button('[data-backup-export]').click();
  const exportPassword = f.input('backupPassphrase');
  exportPassword.value = 'isolated export passphrase';
  f.ui.setVisible(true, 'import');
  f.render();
  assert.equal(exportPassword.value, '');
  assert.equal(f.document.querySelector('[data-backup-transfer]'), null);
  assert.ok(f.calls.every((call) => call.route === '/backups'));
  f.ui.dispose();
});

test('portable import is available before a work computer is online and never restores or starts work', async () => {
  const imported: string[] = [];
  const f = fixture({
    online: false,
    desktop: true,
    transfer: {
      exportBackup: async () => false,
      importBackup: async (password) => {
        imported.push(password);
        return metadata();
      },
    },
  });
  await settle();
  await f.ui.openImport();
  f.input('backupPassphrase').value = 'isolated passphrase';
  defined(f.document.querySelector<HTMLFormElement>('[data-backup-transfer]')).dispatchEvent(
    new f.Event('submit', { cancelable: true }),
  );
  await settle();
  assert.deepEqual(imported, ['isolated passphrase']);
  assert.equal(f.toasts.at(-1), backupMessages.en.imported);
  assert.ok(f.calls.every((call) => call.route === '/backups'));
  assert.doesNotMatch(f.document.body.innerHTML, /isolated passphrase/);
});

test('export requires matching passwords, clears fields before IPC, and treats dialog cancellation as cancellation', async () => {
  const calls: { id: string; password: string }[] = [];
  const f = fixture({
    desktop: true,
    transfer: {
      importBackup: async () => null,
      exportBackup: async (id, password) => {
        calls.push({ id, password });
        assert.equal(f.input('backupPassphrase').value, '');
        return false;
      },
    },
  });
  await settle();
  f.button('[data-backup-export]').click();
  f.input('backupPassphrase').value = 'isolated passphrase';
  f.input('backupPassphraseConfirm').value = 'different phrase';
  const submit = () =>
    defined(f.document.querySelector<HTMLFormElement>('[data-backup-transfer]')).dispatchEvent(
      new f.Event('submit', { cancelable: true }),
    );
  submit();
  await settle();
  assert.equal(calls.length, 0);
  assert.match(f.document.body.textContent, /passphrases do not match/);
  f.input('backupPassphraseConfirm').value = 'isolated passphrase';
  submit();
  await settle();
  assert.deepEqual(calls, [{ id: BACKUP_ID, password: 'isolated passphrase' }]);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.input('backupPassphrase').value, '');
});

test('portable errors show only fixed text, never resend, and retain no passwords', async () => {
  for (const code of [
    'backup_passphrase_invalid',
    'backup_invalid',
    'backup_size_limit',
    'backup_exists',
    'backup_busy',
    'backup_transfer_unconfirmed',
    'unknown-private-error',
  ]) {
    let count = 0;
    const f = fixture({
      desktop: true,
      transfer: {
        exportBackup: async () => false,
        importBackup: async () => {
          count++;
          throw Object.assign(Error('raw private error'), { code });
        },
      },
    });
    await settle();
    await f.ui.openImport();
    f.input('backupPassphrase').value = 'isolated passphrase';
    defined(f.document.querySelector<HTMLFormElement>('[data-backup-transfer]')).dispatchEvent(
      new f.Event('submit', { cancelable: true }),
    );
    await settle();
    assert.equal(count, 1);
    assert.equal(f.input('backupPassphrase').value, '');
    assert.doesNotMatch(
      f.document.body.innerHTML,
      /raw private error|isolated passphrase|unknown-private-error/,
    );
    assert.ok(f.calls.every((call) => call.route === '/backups'));
    f.ui.dispose();
  }
});

test('leaving settings clears password fields and an old import cannot clear a newly opened form', async () => {
  let resolve: (value: BackupMetadata | null) => void = () => {
    throw Error('Missing import');
  };
  const f = fixture({
    desktop: true,
    transfer: {
      exportBackup: async () => false,
      importBackup: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  });
  await settle();
  await f.ui.openImport();
  f.input('backupPassphrase').value = 'isolated old passphrase';
  defined(f.document.querySelector<HTMLFormElement>('[data-backup-transfer]')).dispatchEvent(
    new f.Event('submit', { cancelable: true }),
  );
  f.ui.setVisible(false);
  assert.equal(f.input('backupPassphrase').value, '');
  await f.ui.openImport();
  f.input('backupPassphrase').value = 'new unsubmitted passphrase';
  resolve(metadata());
  await settle();
  assert.equal(f.input('backupPassphrase').value, 'new unsubmitted passphrase');
  assert.equal(f.toasts.length, 0);
  f.ui.dispose();
});

test('the local catalog can contain separate retained backups for more than one work computer', async () => {
  const f = fixture();
  f.backend.backups = Array.from({ length: 101 }, (_, index) => ({
    ...metadata(),
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    source: index.toString(16).padStart(12, '0'),
  }));
  await settle();
  assert.equal(f.document.querySelectorAll('[data-backup-id]').length, 101);
  assert.equal(f.button('[data-backup-prepare]').disabled, false);
  f.ui.dispose();
});

test('manual or automatic settings preserve retention and disabled automatic options, and validate the interval locally', async () => {
  const f = fixture();
  await settle();
  f.changeMode(BackupMode.Manual);
  assert.equal(f.input('intervalMinutes').disabled, true);
  assert.equal(f.input('onConnect').disabled, true);
  f.submit();
  await settle();
  assert.deepEqual(f.calls.find((call) => call.route === '/backups/settings')?.options?.body, {
    mode: BackupMode.Manual,
    intervalMinutes: 60,
    onConnect: true,
    beforeVmChange: true,
    retainCount: 42,
  });
  assert.equal(f.toasts.at(-1), 'Backup settings saved');
  f.changeMode(BackupMode.Automatic);
  f.input('intervalMinutes').value = '10';
  f.submit();
  await settle();
  assert.equal(f.calls.filter((call) => call.route === '/backups/settings').length, 1);
  assert.match(f.document.body.textContent, /valid backup interval/);
  f.input('intervalMinutes').value = '120';
  f.input('onConnect').checked = false;
  f.submit();
  await settle();
  assert.equal(f.backend.settings.intervalMinutes, 120);
  assert.equal(f.backend.settings.onConnect, false);
  assert.equal(f.backend.settings.beforeVmChange, true);
  f.ui.dispose();
});

test('failed or malformed settings responses retain the draft and never announce success', async () => {
  const f = fixture();
  await settle();
  f.input('intervalMinutes').value = '180';
  f.setHook((route, _options, next) => {
    if (route.endsWith('/settings')) throw Error('PRIVATE_FAILURE');
    return next();
  });
  f.submit();
  await settle();
  assert.equal(f.input('intervalMinutes').value, '180');
  assert.equal(f.toasts.length, 0);
  assert.match(f.document.body.textContent, /previous settings were kept/);
  assert.doesNotMatch(f.document.body.textContent, /PRIVATE_FAILURE/);
  f.setHook((route, _options, next) => (route.endsWith('/settings') ? { ok: true } : next()));
  f.submit();
  await settle();
  assert.equal(f.toasts.length, 0);
  f.ui.dispose();
});

test('old or offline work computers keep local settings available but cannot back up or restore', async () => {
  for (const options of [{ online: false }, { supported: false }]) {
    const f = fixture(options);
    await settle();
    assert.equal(f.button('[data-backup-run]').disabled, true);
    assert.equal(f.button('[data-backup-prepare]').disabled, true);
    f.button('[data-backup-run]').click();
    f.button('[data-backup-prepare]').click();
    await settle();
    assert.deepEqual(
      f.calls.map((call) => call.route),
      ['/backups'],
    );
    assert.match(
      f.document.body.textContent,
      options.online === false ? /Connect the work computer/ : /Update the work computer/,
    );
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[type="submit"]')).disabled,
      false,
    );
    f.ui.dispose();
  }
});

test('unsupported local protection and unrecognized server failures show fixed explanations and block restore', async () => {
  for (const issue of ['backup_protection_unavailable', 'PRIVATE_FAILURE_CODE']) {
    const f = fixture();
    if (issue === 'backup_protection_unavailable') {
      f.backend.availability = { online: true, supported: false, reason: issue };
    } else f.backend.lastError = issue;
    await settle();
    assert.equal(f.button('[data-backup-prepare]').disabled, true);
    assert.doesNotMatch(f.document.body.textContent, /PRIVATE_FAILURE_CODE/);
    assert.match(
      f.document.body.textContent,
      issue === 'backup_protection_unavailable'
        ? /Local backup protection is unavailable/
        : /outcome is unconfirmed/,
    );
    f.ui.dispose();
  }
});

test('backup admission is not completion, duplicate starts are blocked, and only metadata polling confirms the saved backup', async () => {
  const f = fixture();
  await settle();
  f.button('[data-backup-run]').click();
  f.button('[data-backup-run]').click();
  await settle();
  assert.equal(f.calls.filter((call) => call.route === '/backups/run').length, 1);
  assert.equal(f.toasts.length, 0);
  assert.match(f.document.body.textContent, /Backing up…/);
  assert.equal(f.button('[data-backup-run]').disabled, true);
  f.backend.phase = BackupPhase.Idle;
  f.backend.lastBackupAt = NOW + 1;
  await f.tick();
  assert.equal(f.toasts.at(-1), 'Backup saved');
  assert.equal(f.button('[data-backup-run]').disabled, false);
  f.ui.dispose();
});

test('restoring requires the metadata and warning preview plus a separate explicit single-use confirmation', async () => {
  const f = fixture();
  await settle();
  f.button('[data-backup-prepare]').click();
  await settle();
  assert.equal(f.calls.filter((call) => call.route.endsWith('/restore')).length, 0);
  assert.match(f.document.body.textContent, /Restoring replaces the current work computer data/);
  assert.match(f.document.body.textContent, /tasks stay paused/);
  assert.match(f.document.body.textContent, /sign in again/);
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[data-backup-preview]')).textContent,
    /12 files/,
  );
  f.button('[data-backup-confirm]').click();
  await settle();
  assert.equal(f.calls.filter((call) => call.route.endsWith('/restore')).length, 1);
  assert.equal(f.document.querySelector('[data-backup-confirm]'), null);
  assert.equal(f.toasts.length, 0);
  assert.match(f.document.body.textContent, /Restoring…/);
  f.backend.phase = BackupPhase.Idle;
  f.backend.lastRestoredId = BACKUP_ID;
  await f.tick();
  assert.equal(f.toasts.at(-1), 'Restore completed');
  f.ui.dispose();
});

test('cancel, refresh, expiry and closing settings discard restoration consent without resending an action', async () => {
  for (const change of ['cancel', 'refresh', 'expire', 'hide']) {
    const f = fixture();
    await settle();
    f.button('[data-backup-prepare]').click();
    await settle();
    const confirmation = f.button('[data-backup-confirm]');
    if (change === 'cancel') f.button('[data-backup-cancel]').click();
    if (change === 'refresh') {
      f.button('[data-backup-refresh]').click();
      await settle();
    }
    if (change === 'expire') {
      f.advance(300_001);
      f.render();
    }
    if (change === 'hide') {
      f.ui.setVisible(false);
      f.ui.setVisible(true);
      await settle();
    }
    confirmation.click();
    await settle();
    assert.equal(f.calls.filter((call) => call.route.endsWith('/restore')).length, 0, change);
    f.ui.dispose();
  }
});

test('ambiguous restore failures never retry or report success and a fresh preview is required', async () => {
  const f = fixture();
  await settle();
  f.button('[data-backup-prepare]').click();
  await settle();
  f.setHook((route, _options, next) => {
    if (route.endsWith('/restore')) {
      f.backend.phase = BackupPhase.Unknown;
      throw Error('PRIVATE_RESTORE_FAILURE');
    }
    return next();
  });
  f.button('[data-backup-confirm]').click();
  await settle();
  await f.tick();
  assert.equal(f.calls.filter((call) => call.route.endsWith('/restore')).length, 1);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.document.querySelector('[data-backup-confirm]'), null);
  assert.equal(f.button('[data-backup-prepare]').disabled, true);
  assert.match(f.document.body.textContent, /unconfirmed/);
  assert.doesNotMatch(f.document.body.textContent, /PRIVATE_RESTORE_FAILURE/);
  f.changeMode(BackupMode.Manual);
  f.submit();
  await settle();
  assert.equal(f.backend.settings.mode, BackupMode.Manual);
  f.ui.dispose();
});

test('definitive restore rejection stays safe and requires another preview before a new attempt', async () => {
  const f = fixture();
  await settle();
  f.button('[data-backup-prepare]').click();
  await settle();
  f.setHook((route, _options, next) => {
    if (route.endsWith('/restore')) {
      const error = new LocalRequestError('PRIVATE_REJECTION');
      error.status = 409;
      throw error;
    }
    return next();
  });
  f.button('[data-backup-confirm]').click();
  await settle();
  assert.equal(f.document.querySelector('[data-backup-confirm]'), null);
  assert.equal(f.toasts.length, 0);
  assert.match(f.document.body.textContent, /operation failed/);
  assert.doesNotMatch(f.document.body.textContent, /PRIVATE_REJECTION/);
  f.ui.dispose();
});

test('malformed preview identities, expiries and warning codes cannot produce a confirmation button', async () => {
  for (const mutate of [
    (value: BackupPreview) => ({ ...value, backup: { ...value.backup, id: 'different-backup' } }),
    (value: BackupPreview) => ({ ...value, expiresAt: NOW - 1 }),
    (value: BackupPreview) => ({ ...value, warnings: ['PRIVATE_WARNING'] }),
    (value: BackupPreview) => ({ ...value, target: { id: '../target', empty: true } }),
    (value: BackupPreview) => ({ ...value, confirmation: '' }),
  ]) {
    const f = fixture();
    await settle();
    f.setHook((route, _options, next) =>
      route.endsWith('/preview') ? mutate(f.preview()) : next(),
    );
    f.button('[data-backup-prepare]').click();
    await settle();
    assert.equal(f.document.querySelector('[data-backup-confirm]'), null);
    assert.doesNotMatch(f.document.body.textContent, /PRIVATE_WARNING/);
    f.ui.dispose();
  }
});

test('invalid refreshed metadata keeps the last list visible but cannot authorize restore from stale state', async () => {
  const f = fixture();
  await settle();
  f.button('[data-backup-prepare]').click();
  await settle();
  f.setHook((route, _options, next) =>
    route === '/backups' ? { ...snapshot(), phase: 'success' } : next(),
  );
  f.button('[data-backup-refresh]').click();
  await settle();
  assert.match(f.document.body.textContent, /12 files/);
  assert.equal(f.document.querySelector('[data-backup-confirm]'), null);
  assert.equal(f.button('[data-backup-prepare]').disabled, true);
  assert.match(f.document.body.textContent, /could not be loaded/);
  f.ui.dispose();
});

test('VM and conversation changes discard a pending preview and its late response cannot authorize the new target', async () => {
  const f = fixture();
  await settle();
  let resolve: (value: unknown) => void = () => {
    throw Error('Preview resolver missing');
  };
  f.setHook((route, _options, next) =>
    route.endsWith('/preview')
      ? new Promise((done) => {
          resolve = done;
        })
      : next(),
  );
  f.button('[data-backup-prepare]').click();
  await settle();
  const previous = f.preview();
  f.state.conversationId = 'conversation-b';
  if (f.state.settings) f.state.settings.vm = { host: '192.0.2.20', user: 'other' };
  f.ui.setVisible(true);
  f.render();
  resolve(previous);
  await settle();
  assert.equal(f.document.querySelector('[data-backup-confirm]'), null);
  assert.equal(f.calls.filter((call) => call.route.endsWith('/restore')).length, 0);
  assert.equal(f.toasts.length, 0);
  f.ui.dispose();
});

test('disconnecting invalidates a loaded preview even if the same work computer later reconnects', async () => {
  const f = fixture();
  await settle();
  f.button('[data-backup-prepare]').click();
  await settle();
  const button = f.button('[data-backup-confirm]');
  f.setConnected(false);
  button.click();
  await settle();
  f.setConnected(true);
  await settle();
  assert.equal(f.document.querySelector('[data-backup-confirm]'), null);
  assert.equal(f.calls.filter((call) => call.route.endsWith('/restore')).length, 0);
  f.ui.dispose();
});

test('reconnecting the work computer invalidates consent even while the local Controller event stream stays connected', async () => {
  const f = fixture();
  await settle();
  f.button('[data-backup-prepare]').click();
  await settle();
  const confirmation = f.button('[data-backup-confirm]');
  f.state.controller = { status: ConnectionStatus.Offline, cached: true };
  f.ui.setVisible(true);
  f.render();
  confirmation.click();
  await settle();
  f.state.controller = { status: ConnectionStatus.Online, cached: false };
  f.ui.setVisible(true);
  f.render();
  await settle();
  assert.equal(f.document.querySelector('[data-backup-confirm]'), null);
  assert.equal(f.calls.filter((call) => call.route.endsWith('/restore')).length, 0);
  f.ui.dispose();
});

test('a reachable work computer can back up before the model provider signs in', async () => {
  const f = fixture();
  f.state.worker = { status: ConnectionStatus.Offline };
  await settle();
  assert.equal(f.button('[data-backup-run]').disabled, false);
  f.button('[data-backup-run]').click();
  await settle();
  assert.equal(f.calls.filter((call) => call.route === '/backups/run').length, 1);
  f.ui.dispose();
});

test('all 16 languages have localized fixed backup text and metadata remains unchanged', async () => {
  for (const language of languages) {
    await loadLanguage(language.code);
    const f = fixture({ language: language.code });
    await settle();
    if (language.code !== 'en' && language.code !== 'zh') {
      const catalog: unknown = JSON.parse(
        fs.readFileSync(
          new URL(`../../../resources/i18n/locales/${language.code}.json`, import.meta.url),
          'utf8',
        ),
      );
      assert.ok(isRecord(catalog));
      for (const english of Object.values(backupMessages.en))
        assert.equal(typeof catalog[english], 'string', `${language.code}: ${english}`);
    }
    assert.match(f.document.body.textContent, /0\.4\.7-beta\.8/);
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('[data-backup-id]')).dataset.backupId,
      BACKUP_ID,
    );
    f.ui.dispose();
  }
});
