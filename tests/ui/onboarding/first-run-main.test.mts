import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createFirstRun } from '../../../ui/onboarding/first-run.mts';
import type { UiModal } from '../../../ui/shared/contracts.mts';
import { sourceDeclaration } from '../../support/source-fixtures.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
function fixture() {
  const { document } = parseHTML('<html><body></body></html>');
  const calls: string[] = [],
    dialogs: UiModal[] = [],
    categories: string[] = [];
  const state = {
    mode: 'vm-controller',
    conversationId: 'fresh',
    messages: [],
    workTasks: [],
    settings: { language: 'en', vm: { host: '' } },
    worker: { status: 'offline', models: [] },
  };
  const c = uiEntrypointFixture({
    document,
    state,
    createFirstRun,
    language: () => 'en',
    unloading: false,
    updateInstalling: false,
    modal: null as UiModal | null,
    page: 'chat',
    manualVMExpanded: false,
    dictating: false,
    speakingId: null,
    attachmentMenu: false,
    emojiFor: null,
    chatMode: 'text',
    pc: null,
    managedSettings: { onClose() {}, renderRequests: () => '' },
    chatHistory: { onClose() {} },
    settingsNavigation: { select: (category: string) => categories.push(category) },
    vmBackups: {
      openImport: async () => {
        calls.push('open-backup-import');
      },
    },
    useExistingComputer: async () => {
      calls.push('existing-settings');
    },
    loadVMProviders: async () => {
      calls.push('GET /vm/providers');
    },
    api: async (route: string) => {
      calls.push('GET ' + route);
      if (route === '/vm/profiles') return { candidates: [] };
      if (route === '/vm/providers')
        return { provider: 'hyperv', availableProviders: [{ id: 'hyperv', available: true }] };
      throw Error('Unexpected fixture route');
    },
    post: async () => {
      throw Error('Opening setup must not create a VM.');
    },
    render() {},
    openModal: (value: UiModal) => {
      dialogs.push(value);
      c.modal = value;
    },
    closeModal: () => {
      c.modal = null;
    },
    stopSpeech: async () => {},
    clearTelegramPairing() {},
    replyTo: null,
    attachments: [],
    taskReplies: { render: () => '' },
    renderUnreadControl: () => '',
    renderUnconfirmedMessage: () => '',
    renderVoiceRecorder: () => '',
    recordDraft: null,
    recordStarting: false,
    composerDraft: '',
    renderAttachmentOptions: () => '',
    speechBlocked: () => false,
    recording: null,
    sending: false,
    uploading: false,
    eventConnected: true,
    ico: () => '',
    eyes: () => '',
    button: (action: string) => `<button data-action="${action}"></button>`,
    t: (key: string) => key,
  });
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(
    [
      sourceDeclaration(source, 'const firstRun ='),
      sourceDeclaration(source, 'async function action('),
      sourceDeclaration(source, 'function renderChat('),
      'globalThis.firstRun = firstRun;',
    ].join('\n'),
    c,
  );
  return {
    c,
    calls,
    dialogs,
    categories,
    modal: (): UiModal | null => c.modal,
    document: () => parseHTML(c.renderChat()).document,
  };
}

test('the real main welcome wires backup choice, VM setup and cancel/re-entry without provisioning', async () => {
  const f = fixture();
  assert.equal(
    f.document().querySelector('.first-run-actions .primary')?.getAttribute('data-action'),
    'onboarding-import',
  );
  await f.c.action('onboarding-new');
  assert.equal(
    f.document().querySelector('.first-run-actions .primary')?.getAttribute('data-action'),
    'onboarding-create',
  );
  assert.deepEqual(f.calls, ['GET /vm/profiles', 'GET /vm/providers']);
  await f.c.action('onboarding-create');
  assert.equal(f.modal()?.type, 'setup');
  assert.deepEqual(
    f.dialogs.map((dialog) => dialog.type),
    ['setup'],
  );
  await f.c.action('close-modal');
  assert.equal(f.modal(), null);
  await f.c.action('onboarding-create');
  assert.equal(f.modal()?.type, 'setup');
  assert.equal(f.dialogs.length, 2);
  assert.ok(f.calls.every((route) => route.startsWith('GET ')));
});

test('backup and SSH choices use main settings navigation while the existing-computer entry stays reachable', async () => {
  const f = fixture();
  await f.c.action('onboarding-import');
  assert.equal(f.c.page, 'settings');
  assert.deepEqual(f.categories, ['computer']);
  // The injected import capability is attached by the portable backup module.
  // Navigating here is never a restore or a VM creation request.
  assert.deepEqual(f.calls, ['open-backup-import']);
  await f.c.action('onboarding-manual');
  assert.equal(f.c.manualVMExpanded, true);
  assert.equal(f.c.page, 'settings');
  await f.c.action('onboarding-existing');
  assert.equal(f.calls.at(-1), 'existing-settings');
  assert.equal(f.modal(), null);
});
