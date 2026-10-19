import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createFirstRun } from '../../../ui/onboarding/first-run.mts';
import { firstRunMessages } from '../../../ui/onboarding/first-run-copy.mts';
import { languages } from '../../../src/i18n/languages.mts';
import type { ApiRequest } from '../../../ui/shared/contracts.mts';
import { deferred } from '../../support/service-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';

type State = NonNullable<ReturnType<Parameters<typeof createFirstRun>[0]['getState']>>;
const firstUse = (): State => ({
  mode: 'vm-controller',
  conversationId: 'new-conversation',
  settings: { vm: {} },
  messages: [],
  workTasks: [],
  completions: [],
  provisioning: {},
});
const available = {
  provider: 'hyperv',
  availableProviders: [
    { id: 'hyperv', available: true },
    { id: 'vmware', available: true },
  ],
};
function fixture({ language = 'en', request }: { language?: string; request?: ApiRequest } = {}) {
  let state: State | null = firstUse();
  const calls: string[] = [],
    actions: string[] = [];
  let changes = 0;
  const module = createFirstRun({
    getState: () => state,
    getLanguage: () => language,
    request: async (route, options) => {
      assert.ok(!options?.method || options.method === 'GET', 'discovery must stay read-only');
      calls.push(route);
      return request
        ? await request(route, options)
        : route === '/vm/profiles'
          ? { candidates: [] }
          : available;
    },
    onChange: () => {
      changes++;
    },
    onCreate: () => {
      actions.push('create-dialog');
    },
    onExisting: () => {
      actions.push('existing-settings');
    },
    onManual: () => {
      actions.push('ssh-settings');
    },
    onBackupImport: () => {
      actions.push('backup-import');
    },
  });
  return {
    module,
    calls,
    actions,
    changes: () => changes,
    setState(value: State | null) {
      state = value;
    },
    document: () => parseHTML('<main>' + module.render() + '</main>').document,
  };
}

test('a first-use screen asks about a backup before VM discovery or creation', async () => {
  const f = fixture();
  await f.module.observe();
  const document = f.document();
  assert.equal(document.querySelector('h1')?.textContent, firstRunMessages.en.backupTitle);
  assert.equal(
    document.querySelector('.first-run-actions .primary')?.getAttribute('data-action'),
    'onboarding-import',
  );
  assert.ok(document.querySelector('[data-action="onboarding-new"]'));
  assert.equal(document.querySelector('[data-action="onboarding-create"]'), null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.actions, []);
  await f.module.handle('onboarding-create');
  assert.deepEqual(f.actions, [], 'a forged create action cannot skip the backup choice');
});

test('backup import is an explicit injected UI action and cancellation leaves the entry available', async () => {
  const f = fixture();
  assert.equal(await f.module.handle('onboarding-import'), true);
  assert.deepEqual(f.actions, ['backup-import']);
  assert.deepEqual(f.calls, [], 'opening import cannot create, connect or inspect a VM');
  assert.ok(f.document().querySelector('[data-action="onboarding-import"]'));
  await f.module.handle('onboarding-import');
  assert.deepEqual(f.actions, ['backup-import', 'backup-import']);
});

test('only choosing no backup discovers providers and offers an explicit creation dialog', async () => {
  const f = fixture();
  await f.module.handle('onboarding-new');
  assert.deepEqual(f.calls, ['/vm/profiles', '/vm/providers']);
  const document = f.document();
  assert.equal(document.querySelector('h1')?.textContent, firstRunMessages.en.title);
  assert.deepEqual(
    [...document.querySelectorAll('li')].map((node) => node.textContent),
    [firstRunMessages.en.choose, firstRunMessages.en.review, firstRunMessages.en.signin],
  );
  const create = defined(
    document.querySelector<HTMLButtonElement>('[data-action="onboarding-create"]'),
  );
  assert.equal(create.disabled, false);
  assert.equal(create.classList.contains('primary'), true);
  assert.deepEqual(f.actions, []);
  await f.module.handle('onboarding-create');
  assert.deepEqual(f.actions, ['create-dialog']);
  assert.deepEqual(f.calls, ['/vm/profiles', '/vm/providers']);
  // Cancelling the existing setup dialog does not discard the guide or start work.
  await f.module.handle('onboarding-create');
  assert.deepEqual(f.actions, ['create-dialog', 'create-dialog']);
});

test('existing computers are offered first without importing or replacing them automatically', async () => {
  const f = fixture({
    request: async (route) =>
      route === '/vm/profiles'
        ? { candidates: [{ id: 'existing', host: '192.0.2.4' }] }
        : available,
  });
  await f.module.handle('onboarding-new');
  const document = f.document();
  assert.equal(
    document.querySelector('.first-run-actions .primary')?.getAttribute('data-action'),
    'onboarding-existing',
  );
  assert.equal(document.querySelector('.first-run-intro')?.textContent, firstRunMessages.en.found);
  assert.equal(document.querySelector('ol'), null);
  assert.deepEqual(f.actions, []);
  await f.module.handle('onboarding-existing');
  assert.deepEqual(f.actions, ['existing-settings']);
});

test('an imported current profile is preserved and shown as existing', async () => {
  const f = fixture({
    request: async (route) =>
      route === '/vm/profiles'
        ? { current: { id: 'current', host: '192.0.2.8' }, candidates: [] }
        : available,
  });
  await f.module.handle('onboarding-new');
  assert.equal(
    f.document().querySelector('.first-run-actions .primary')?.getAttribute('data-action'),
    'onboarding-existing',
  );
  assert.deepEqual(f.actions, []);
});

test('configured, returning, Worker and in-progress users are not forced into first-use setup', async () => {
  for (const state of [
    null,
    { ...firstUse(), settings: { vm: { host: '192.0.2.1' } } },
    { ...firstUse(), provisioning: { connection: { host: '192.0.2.1' } } },
    { ...firstUse(), provisioning: { running: true } },
    { ...firstUse(), messages: [{ role: 'assistant', text: 'Previous conversation' }] },
    { ...firstUse(), workTasks: [{ id: 'saved' }] },
    { ...firstUse(), completions: [{ id: 'finished' }] },
    { ...firstUse(), mode: 'vm-worker' },
    { ...firstUse(), messages: undefined },
  ]) {
    const f = fixture();
    f.setState(state);
    await f.module.observe();
    assert.equal(f.module.render(), '');
    assert.equal(await f.module.handle('onboarding-new'), false);
    assert.equal(await f.module.handle('onboarding-import'), false);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.actions, []);
  }
});

test('unsupported hosts keep SSH and existing-computer settings available without creation', async () => {
  const f = fixture({
    request: async (route) =>
      route === '/vm/profiles'
        ? { candidates: [] }
        : {
            provider: null,
            availableProviders: [
              { id: 'hyperv', available: false, reason: 'unsupported' },
              { id: 'vmware', available: false, reason: 'not-installed' },
            ],
          },
  });
  await f.module.handle('onboarding-new');
  const document = f.document();
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-action="onboarding-create"]'))
      .disabled,
    true,
  );
  assert.equal(
    document.querySelector('[role="status"]')?.textContent,
    firstRunMessages.en.unsupported,
  );
  await f.module.handle('onboarding-create');
  await f.module.handle('onboarding-existing');
  await f.module.handle('onboarding-manual');
  assert.deepEqual(f.actions, ['existing-settings', 'ssh-settings']);
});

test('a future or malformed provider never masquerades as an available Hyper-V or VMware adapter', async () => {
  for (const value of [
    { provider: 'future', availableProviders: [{ id: 'future', available: true }] },
    { availableProviders: [{ id: 'hyperv', available: 'true' }] },
  ]) {
    const f = fixture({
      request: async (route) => (route === '/vm/profiles' ? { candidates: [] } : value),
    });
    await f.module.handle('onboarding-new');
    assert.deepEqual(f.actions, []);
    assert.equal(f.document().querySelectorAll('button[data-action]').length > 0, true);
    if (value.provider === 'future') {
      assert.equal(
        defined(f.document().querySelector<HTMLButtonElement>('[data-action="onboarding-create"]'))
          .disabled,
        true,
      );
    } else {
      assert.equal(
        f.document().querySelector('[role="status"]')?.textContent,
        firstRunMessages.en.loadFailed,
      );
    }
  }
});

test('discovery errors expose only fixed copy and retain manual recovery paths', async () => {
  const f = fixture({
    request: async () => {
      throw Error('PRIVATE ACCOUNT OR FILE CONTENT');
    },
  });
  await f.module.handle('onboarding-new');
  const html = f.module.render();
  assert.ok(html.includes(firstRunMessages.en.loadFailed));
  assert.doesNotMatch(html, /PRIVATE/);
  await f.module.handle('onboarding-manual');
  assert.deepEqual(f.actions, ['ssh-settings']);
});

test('a failed profile scan cannot silently imply that no existing computer exists', async () => {
  const f = fixture({
    request: async (route) =>
      route === '/vm/profiles'
        ? { candidates: [], error: 'PRIVATE PROFILE SCAN DETAILS' }
        : available,
  });
  await f.module.handle('onboarding-new');
  assert.equal(
    f.document().querySelector('[role="status"]')?.textContent,
    firstRunMessages.en.loadFailed,
  );
  assert.doesNotMatch(f.module.render(), /PRIVATE PROFILE/);
  await f.module.handle('onboarding-existing');
  assert.deepEqual(f.actions, ['existing-settings']);
});

test('busy discovery cannot open creation, and back cancels stale results before re-entry', async () => {
  const waiting = deferred<unknown>();
  let initial = true;
  const f = fixture({
    request: async (route) =>
      initial ? waiting.promise : route === '/vm/profiles' ? { candidates: [] } : available,
  });
  const pending = f.module.handle('onboarding-new');
  assert.equal(
    defined(f.document().querySelector<HTMLButtonElement>('[data-action="onboarding-create"]'))
      .disabled,
    true,
  );
  await f.module.handle('onboarding-create');
  assert.deepEqual(f.actions, []);
  await f.module.handle('onboarding-back');
  assert.equal(f.document().querySelector('h1')?.textContent, firstRunMessages.en.backupTitle);
  initial = false;
  await f.module.handle('onboarding-new');
  waiting.resolve({ private: 'stale malformed reply' });
  await pending;
  assert.equal(f.document().querySelector('[role="status"]'), null);
  assert.equal(
    defined(f.document().querySelector<HTMLButtonElement>('[data-action="onboarding-create"]'))
      .disabled,
    false,
  );
  assert.equal(f.calls.length, 4);
});

test('a changed computer or disposed screen cannot receive an old discovery result', async () => {
  for (const dispose of [false, true]) {
    const waiting = deferred<unknown>();
    const f = fixture({ request: async () => waiting.promise });
    const pending = f.module.handle('onboarding-new');
    if (dispose) f.module.dispose();
    else {
      f.setState({ ...firstUse(), settings: { vm: { host: '192.0.2.1' } } });
      await f.module.observe();
    }
    const changes = f.changes();
    waiting.resolve({ candidates: [{ id: 'stale' }] });
    await pending;
    assert.equal(f.module.render(), '');
    assert.equal(f.changes(), changes);
    assert.deepEqual(f.actions, []);
  }
});

test('all 16 registered languages have complete backup and VM guidance, including RTL', async () => {
  assert.equal(languages.length, 16);
  for (const language of languages) {
    const tr = firstRunMessages[language.code],
      f = fixture({ language: language.code });
    assert.deepEqual(Object.keys(tr), Object.keys(firstRunMessages.en));
    assert.ok(
      Object.values(tr).every((text) => typeof text === 'string' && text.trim().length > 0),
    );
    let document = f.document();
    assert.equal(document.querySelector('h1')?.textContent, tr.backupTitle);
    assert.equal(document.querySelector('.first-run')?.getAttribute('dir'), language.direction);
    await f.module.handle('onboarding-new');
    document = f.document();
    assert.equal(document.querySelector('h1')?.textContent, tr.title);
    assert.equal(
      document.querySelector('[data-action="onboarding-create"]')?.textContent,
      tr.create,
    );
    assert.equal(document.querySelector('small')?.textContent, tr.permissions);
    f.module.dispose();
  }
});
