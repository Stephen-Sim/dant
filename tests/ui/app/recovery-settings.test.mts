import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  createRecoverySettings,
  readRecoveryConfiguration,
} from '../../../ui/app/recovery-settings.mts';
import { recoveryMessages } from '../../../ui/app/recovery-copy.mts';
import { loadLanguage } from '../../../ui/i18n/localization.mts';
import { languages } from '../../../ui/i18n/languages.mts';
import {
  BackupMode,
  BackupPhase,
  ConnectionStatus,
  ServiceUpdateStatus,
} from '../../../ui/shared/states.mts';
import type { ConnectionStatusValue } from '../../../ui/shared/api-types.ts';
import type { BackupStatus } from '../../../ui/settings/backup-types.ts';
import type { ApiOptions } from '../../../ui/shared/contracts.mts';
import { LocalRequestError, isRecord } from '../../../ui/shared/contracts.mts';
import { defined } from '../../support/fixture-assertions.mts';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { languageInfo } from '../../../ui/i18n/languages.mts';
import { sourceDeclaration } from '../../support/source-fixtures.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import postcss from 'postcss';

const configuration = (status: ConnectionStatusValue = ConnectionStatus.Offline) => ({
  version: '0.4.7-beta.9',
  language: 'en',
  vm: {
    host: '192.0.2.10',
    user: 'fixture',
    port: 22,
    keyPath: 'C:/fixture/key',
    knownHosts: 'C:/fixture/known',
  },
  status,
  serviceUpdate: {
    status: ServiceUpdateStatus.Checking,
    confirmed: false,
    targetVersion: '0.4.7-beta.9',
    runningVersion: null,
    reason: null,
  },
  updatesPaused: false,
  profiles: {
    current: null,
    candidates: [{ id: 'fixture-profile', label: 'Fixture work computer' }],
    error: null,
  },
  providers: {
    provider: null,
    availableProviders: [{ id: 'hyper-v', available: true, reason: null }],
  },
});
const backup = (): BackupStatus => ({
  settings: {
    mode: BackupMode.Automatic,
    intervalMinutes: 60,
    onConnect: true,
    beforeVmChange: true,
    retainCount: 10,
  },
  availability: { online: true, supported: true },
  backups: [],
  phase: BackupPhase.Idle,
  lastBackupAt: null,
  lastError: null,
  nextAt: null,
  lastRestoredId: null,
});
type Call = { route: string; options: ApiOptions | undefined };
type Hook = (call: Call, next: () => unknown) => unknown;
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};
function fixture(language = 'en') {
  const { document, Event, HTMLInputElement } = parseHTML(
      '<html><body><main id="app"></main></body></html>',
    ),
    container = defined(document.querySelector<HTMLElement>('#app')),
    calls: Call[] = [],
    opened: string[] = [];
  Object.defineProperty(HTMLInputElement.prototype, 'checked', {
    configurable: true,
    get() {
      return this.hasAttribute('checked');
    },
    set(value: boolean) {
      this.toggleAttribute('checked', value);
    },
  });
  let config = configuration(),
    status = backup(),
    hook: Hook | null = null,
    retries = 0,
    openFailure = false;
  const response = (call: Call): unknown => {
    if (call.route === '/api/controller/settings') return structuredClone(config);
    if (call.route === '/api/backups') return structuredClone(status);
    if (call.route === '/api/settings' || call.route === '/api/vm/import') return { ok: true };
    if (call.route === '/api/updates?channel=beta')
      return {
        currentVersion: '0.4.7-beta.8',
        latestVersion: '0.4.7-beta.9',
        channel: 'beta',
        updateAvailable: true,
        releaseUrl: 'https://github.com/Stephen-Sim/dant/releases/tag/v0.4.7-beta.9',
      };
    throw Error('Unexpected fixture route');
  };
  const ui = createRecoverySettings({
    container,
    getLanguage: () => language,
    request: async (route, options) => {
      const call = { route, options };
      calls.push(call);
      return hook ? hook(call, () => response(call)) : response(call);
    },
    onRetry: async () => {
      retries++;
    },
    openExternal: async (url) => {
      if (openFailure) throw Error('private open error');
      opened.push(url);
    },
  });
  const button = (selector: string) =>
    defined(container.querySelector<HTMLButtonElement>(selector));
  const click = async (selector: string) => {
    button(selector).click();
    await settle();
  };
  const input = (field: string, value: string) => {
    const item = defined(
      container.querySelector<HTMLInputElement>(`[data-recovery-field="${field}"]`),
    );
    item.value = value;
    item.dispatchEvent(new Event('input'));
  };
  const submit = async () => {
    defined(container.querySelector<HTMLFormElement>('[data-recovery-form]')).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await settle();
  };
  const writes = () =>
    calls.filter((call) => call.options?.method === 'PATCH' || call.options?.method === 'POST');
  const confirm = () => {
    const item = defined(container.querySelector<HTMLInputElement>('[data-recovery-consent]'));
    item.checked = true;
    item.dispatchEvent(new Event('change'));
  };
  ui.show({ stateUnavailable: true });
  return {
    ui,
    container,
    calls,
    opened,
    button,
    click,
    input,
    submit,
    writes,
    confirm,
    Event,
    get config() {
      return config;
    },
    set config(value) {
      config = value;
    },
    get backup() {
      return status;
    },
    set backup(value) {
      status = value;
    },
    setHook(value: Hook | null) {
      hook = value;
    },
    get retries() {
      return retries;
    },
    setOpenFailure() {
      openFailure = true;
    },
  };
}

test('recovery remains available without application state and never starts a VM or model', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.equal(f.container.querySelectorAll('button').length, 3);
  await f.click('[data-recovery-retry]');
  assert.equal(f.retries, 1);
  assert.equal(f.calls.length, 0);
  await f.click('[data-recovery-settings]');
  assert.equal(f.container.querySelectorAll('input[data-recovery-field]').length, 5);
  assert.deepEqual(
    f.calls.map((call) => call.route),
    ['/api/controller/settings'],
  );
  assert.equal(f.writes().length, 0);
});

test('recovery fields and separate actions retain scoped spacing and a stacked narrow layout', async () => {
  const f = fixture();
  await f.click('[data-recovery-settings]');
  await f.click('[data-recovery-updates]');
  assert.equal(f.container.querySelectorAll('[data-recovery-form] > .setting-row').length, 5);
  assert.ok(f.container.querySelector('[data-recovery-form] > .inline-actions > button'));
  assert.ok(f.container.querySelector('.card-content > [data-recovery-import]'));
  assert.ok(f.container.querySelector('.recovery-settings > [data-recovery-release]'));
  assert.equal(f.writes().length, 0);

  const styles = postcss.parse(
    fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'),
  );
  const declarations = (selector: string) => {
    const values = new Map<string, string>();
    styles.walkRules(selector, (rule) => {
      if (rule.parent?.type !== 'root') return;
      rule.walkDecls((declaration) => {
        values.set(declaration.prop, declaration.value);
      });
    });
    return values;
  };
  for (const selector of [
    '.recovery-settings .card-content',
    '.recovery-settings [data-recovery-form]',
  ]) {
    const values = declarations(selector);
    assert.equal(values.get('display'), 'grid');
    assert.ok(Number.parseFloat(defined(values.get('gap'))) > 0);
  }
  assert.equal(
    declarations('.recovery-settings [data-recovery-form] > .inline-actions').get(
      'justify-content',
    ),
    'flex-end',
  );
  assert.equal(
    declarations('.recovery-settings [data-recovery-import]').get('justify-self'),
    'end',
  );
  const narrowRules: string[] = [];
  styles.walkAtRules('media', (rule) => {
    if (rule.params !== '(max-width: 560px)') return;
    rule.walkRules('.recovery-settings .setting-row', (row) => {
      row.walkDecls('grid-template-columns', (declaration) => {
        narrowRules.push(declaration.value);
      });
    });
  });
  assert.deepEqual(narrowRules, ['minmax(0, 1fr)']);
});

test('the actual startup catch routes invalid state and transport errors to distinct recovery views', async () => {
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
  for (const [message, expected] of [
    ['Invalid application state', true],
    ['private network details', false],
  ] as const) {
    const { document } = parseHTML('<html><body><main id="app"></main></body></html>');
    const shown: { stateUnavailable?: boolean }[] = [],
      routes: string[] = [];
    const context = uiEntrypointFixture({
      document,
      Error,
      languageInfo,
      language: () => 'en' as const,
      loadLanguage: async () => {},
      isRecord,
      transport: {
        json: async (route: string) => {
          routes.push(route);
          return { token: 'synthetic-local-session' };
        },
        setToken: (value: string) => assert.equal(value, 'synthetic-local-session'),
      },
      api: async (route: string) => {
        routes.push(route);
        throw Error(message);
      },
      state: null,
      recoverySettings: {
        show: (options: { stateUnavailable?: boolean } = {}) => shown.push(options),
        hide: () => {},
      },
    });
    vm.createContext(uiFixtureContext(context));
    vm.runInContext(
      stripTypeScriptTypes(sourceDeclaration(source, 'async function boot')),
      context,
    );
    await context.boot();
    assert.equal(shown.length, 1);
    assert.equal(defined(shown[0]).stateUnavailable, expected);
    assert.deepEqual(routes, ['/api/session', '/state']);
    assert.doesNotMatch(document.body.innerHTML, /private network details|synthetic-local-session/);
  }
});

test('valid local nullable observations are accepted; malformed configuration never becomes a safe connection', () => {
  assert.equal(readRecoveryConfiguration(configuration()).serviceUpdate?.confirmed, false);
  const values: unknown[] = [
    null,
    {},
    { ...configuration(), version: 'private content' },
    { ...configuration(), language: 'xx' },
    { ...configuration(), vm: { port: 65536 } },
    { ...configuration(), status: 'invented' },
    { ...configuration(), serviceUpdate: { ...configuration().serviceUpdate, confirmed: 'yes' } },
    { ...configuration(), profiles: { candidates: [{ id: 'same' }, { id: 'same' }] } },
    { ...configuration(), providers: { availableProviders: [{ id: 'x', available: 'yes' }] } },
  ];
  for (const value of values)
    assert.throws(() => readRecoveryConfiguration(value), /Invalid recovery configuration/);
});

test('local configuration success reports the actual work computer status without claiming chat connected', async () => {
  for (const status of [
    ConnectionStatus.Online,
    ConnectionStatus.Offline,
    ConnectionStatus.Connecting,
  ]) {
    const f = fixture();
    f.config.status = status;
    await f.click('[data-recovery-settings]');
    assert.match(f.container.textContent ?? '', /Local service connected/);
    assert.ok(
      f.container.textContent?.includes(
        status === ConnectionStatus.Online
          ? 'Online'
          : status === ConnectionStatus.Offline
            ? 'Disconnected'
            : 'Connecting',
      ),
    );
    assert.match(f.container.textContent ?? '', /Could not open chat/);
  }
  const f = fixture();
  f.ui.show();
  assert.match(f.container.textContent ?? '', /Could not reach the local service/);
});

test('SSH edits save the exact five fields after fresh configuration and backup validation', async () => {
  const f = fixture();
  await f.click('[data-recovery-settings]');
  f.input('host', '192.0.2.20');
  f.input('user', 'worker');
  f.input('port', '2222');
  await f.submit();
  assert.deepEqual(f.writes(), [
    {
      route: '/api/settings',
      options: {
        method: 'PATCH',
        body: {
          vm: {
            host: '192.0.2.20',
            user: 'worker',
            port: 2222,
            keyPath: 'C:/fixture/key',
            knownHosts: 'C:/fixture/known',
          },
        },
      },
    },
  ]);
  assert.match(f.container.textContent ?? '', /Connection saved/);
  assert.equal(f.retries, 0);
  assert.deepEqual(
    f.calls.map((call) => call.route),
    ['/api/controller/settings', '/api/controller/settings', '/api/backups', '/api/settings'],
  );
});

test('offline backup protection requires explicit consent and carries only a single-use bypass', async () => {
  const f = fixture();
  f.backup.availability.online = false;
  await f.click('[data-recovery-settings]');
  f.input('host', '192.0.2.20');
  await f.submit();
  assert.equal(f.writes().length, 0);
  assert.ok(f.container.querySelector('[data-recovery-consent]'));
  f.confirm();
  await f.submit();
  const call = defined(f.writes()[0]);
  assert.ok(isRecord(call.options?.body));
  assert.equal(call.options.body.skipBackupOnce, true);
  assert.equal(f.backup.settings.mode, BackupMode.Automatic);
  assert.equal(f.backup.settings.beforeVmChange, true);
  assert.ok(f.calls.every((call) => call.route !== '/api/backups/settings'));
});

test('unsupported old Worker requires explicit backup acknowledgement; manual mode needs no bypass', async () => {
  const f = fixture();
  f.backup.availability.supported = false;
  await f.click('[data-recovery-settings]');
  await f.submit();
  assert.equal(f.writes().length, 0);
  f.confirm();
  f.backup.settings.mode = BackupMode.Manual;
  await f.submit();
  const body = defined(f.writes()[0]).options?.body;
  assert.ok(isRecord(body));
  assert.equal(body.skipBackupOnce, undefined);
});

test('changing any proposed connection field invalidates prior backup consent', async () => {
  const f = fixture();
  f.backup.availability.online = false;
  await f.click('[data-recovery-settings]');
  await f.submit();
  f.confirm();
  f.input('host', '192.0.2.40');
  await f.submit();
  assert.equal(f.writes().length, 0);
});

test('running, restoring and unknown backups cannot be bypassed, including unconfirmed restores', async () => {
  for (const phase of [BackupPhase.BackingUp, BackupPhase.Restoring, BackupPhase.Unknown]) {
    const f = fixture();
    f.backup.availability.online = false;
    await f.click('[data-recovery-settings]');
    await f.submit();
    f.confirm();
    f.backup.phase = phase;
    await f.submit();
    assert.equal(f.writes().length, 0);
    assert.match(f.container.textContent ?? '', /Wait for the backup/);
  }
  const f = fixture();
  f.backup.lastError = 'backup_restore_unconfirmed';
  await f.click('[data-recovery-settings]');
  await f.submit();
  assert.equal(f.writes().length, 0);
});

test('profile selection is explicit and imports with replacement consent without deleting saved profiles', async () => {
  const f = fixture();
  await f.click('[data-recovery-settings]');
  const select = defined(f.container.querySelector<HTMLSelectElement>('[data-recovery-profile]'));
  defined(select.querySelector<HTMLOptionElement>('option[value="fixture-profile"]')).selected =
    true;
  select.dispatchEvent(new f.Event('change'));
  await f.click('[data-recovery-import]');
  assert.deepEqual(f.writes(), [
    {
      route: '/api/vm/import',
      options: { method: 'POST', body: { id: 'fixture-profile', replaceCurrent: true } },
    },
  ]);
  assert.equal(f.config.profiles.candidates.length, 1);
});

test('invalid form values and changed VM identity cannot be submitted', async () => {
  for (const [field, value] of [
    ['host', ''],
    ['user', ''],
    ['port', '0'],
    ['port', '65536'],
    ['port', '1.5'],
    ['host', 'bad\nvalue'],
  ]) {
    assert.ok(field !== undefined && value !== undefined);
    const f = fixture();
    await f.click('[data-recovery-settings]');
    f.input(field, value);
    await f.submit();
    assert.equal(f.writes().length, 0);
  }
  const f = fixture();
  await f.click('[data-recovery-settings]');
  f.config.vm.host = '192.0.2.99';
  await f.submit();
  assert.equal(f.writes().length, 0);
  assert.match(f.container.textContent ?? '', /connection changed/);
});

test('backup failures and unknown payloads never turn into an unprotected connection change', async () => {
  for (const value of [null, {}, { ...backup(), phase: 'surprise' }]) {
    const f = fixture();
    f.setHook((call, next) => (call.route === '/api/backups' ? value : next()));
    await f.click('[data-recovery-settings]');
    await f.submit();
    assert.equal(f.writes().length, 0);
  }
  const f = fixture();
  f.setHook((call, next) => {
    if (call.route === '/api/backups') throw Error('private backup error');
    return next();
  });
  await f.click('[data-recovery-settings]');
  await f.submit();
  assert.equal(f.writes().length, 0);
  assert.doesNotMatch(f.container.innerHTML, /private backup error/);
});

test('backup preparation never causes an automatic mutation retry', async () => {
  const f = fixture();
  f.setHook((call, next) => {
    if (call.options?.method === 'PATCH') {
      const error = new LocalRequestError('private server message');
      error.code = 'backup_before_vm_change_required';
      error.status = 409;
      throw error;
    }
    return next();
  });
  await f.click('[data-recovery-settings]');
  await f.submit();
  assert.equal(f.writes().length, 1);
  assert.match(f.container.textContent ?? '', /backup is being prepared/);
  await settle();
  assert.equal(f.writes().length, 1);
  assert.doesNotMatch(f.container.innerHTML, /private server message/);
});

test('ambiguous configuration writes require a fresh local read before another submission', async () => {
  const f = fixture();
  f.setHook((call, next) => {
    if (call.options?.method === 'PATCH') {
      const error = new LocalRequestError('private network output');
      error.unknownOutcome = true;
      throw error;
    }
    return next();
  });
  await f.click('[data-recovery-settings]');
  await f.submit();
  await f.submit();
  assert.equal(f.writes().length, 1);
  assert.match(f.container.textContent ?? '', /could not be confirmed/);
  f.setHook(null);
  await f.click('[data-recovery-settings]');
  await f.submit();
  assert.equal(f.writes().length, 2);
});

test('updates work independently of configuration and only open the matching official release', async () => {
  const f = fixture();
  await f.click('[data-recovery-updates]');
  assert.deepEqual(
    f.calls.map((call) => call.route),
    ['/api/updates?channel=beta'],
  );
  await f.click('[data-recovery-release]');
  assert.deepEqual(f.opened, ['https://github.com/Stephen-Sim/dant/releases/tag/v0.4.7-beta.9']);
  assert.equal(f.writes().length, 0);
  f.setOpenFailure();
  await f.click('[data-recovery-release]');
  assert.match(f.container.textContent ?? '', /Could not check/);
  assert.doesNotMatch(f.container.innerHTML, /private open error/);
});

test('untrusted release metadata is not rendered as a release link', async () => {
  for (const releaseUrl of [
    'https://evil.example/Stephen-Sim/dant/releases/tag/v0.4.7-beta.9',
    'https://github.com/Stephen-Sim/dant/releases/tag/v0.4.7-beta.9?token=x',
    'javascript:alert(1)',
    'https://github.com/Stephen-Sim/dant/releases/tag/v0.4.7-beta.8',
  ]) {
    const f = fixture();
    f.setHook((call, next) => {
      const value = next();
      return call.route === '/api/updates?channel=beta' && isRecord(value)
        ? { ...value, releaseUrl }
        : value;
    });
    await f.click('[data-recovery-updates]');
    assert.equal(f.container.querySelector('[data-recovery-release]'), null);
    assert.deepEqual(f.opened, []);
  }
});

test('late local responses cannot replace a subsequent boot screen or apply an old VM change', async () => {
  const f = fixture();
  let resolve: (value: unknown) => void = () => {
    throw Error('Missing read');
  };
  f.setHook((call, next) =>
    call.route === '/api/controller/settings'
      ? new Promise((done) => {
          resolve = done;
        })
      : next(),
  );
  f.button('[data-recovery-settings]').click();
  f.ui.hide();
  f.container.innerHTML = '<p>new boot screen</p>';
  resolve(configuration());
  await settle();
  assert.equal(f.container.textContent, 'new boot screen');
  assert.equal(f.writes().length, 0);
});

test('malformed local settings keep retry and update actions available without displaying raw errors', async () => {
  const f = fixture();
  f.setHook((call, next) =>
    call.route === '/api/controller/settings' ? { private: 'secret fixture text' } : next(),
  );
  await f.click('[data-recovery-settings]');
  assert.equal(f.container.querySelector('form'), null);
  assert.ok(f.container.querySelector('[data-recovery-retry]'));
  assert.ok(f.container.querySelector('[data-recovery-updates]'));
  assert.doesNotMatch(f.container.innerHTML, /secret fixture text/);
});

test('all 16 recovery languages use the registered catalogs and preserve profile content', async () => {
  for (const language of languages) {
    await loadLanguage(language.code);
    const f = fixture(language.code);
    f.config.language = language.code;
    f.config.profiles.candidates[0] = {
      id: 'fixture-profile',
      label: '<img src=x onerror=bad> User title',
    };
    await f.click('[data-recovery-settings]');
    assert.equal(f.container.querySelectorAll('img').length, 0);
    assert.equal(
      f.container.querySelector('.recovery-settings')?.getAttribute('dir'),
      languageInfo(language.code).direction,
    );
    assert.ok(f.container.textContent?.includes('<img src=x onerror=bad> User title'));
    if (language.code !== 'en')
      assert.ok(!f.container.textContent?.includes(recoveryMessages.en.unavailable), language.code);
  }
});
