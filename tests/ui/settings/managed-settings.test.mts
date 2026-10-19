import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import {
  createManagedSettings,
  managedMessages,
  parseSkillFiles,
} from '../../../ui/settings/managed-settings.mts';
import type {
  ApiOptions,
  CredentialVault,
  SkillItem,
  UiModal,
  UiSettings,
} from '../../../ui/shared/contracts.mts';
import { observedRecord, observedString } from '../../support/service-fixtures.mts';
import { SKILL_SUPPORT_FILE_LIMIT } from '../../../src/skills/skill-limits.mts';

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
interface FixtureSkill extends SkillItem {
  instructions?: string;
  files?: Record<string, string>;
}
interface FixtureSkills {
  items: FixtureSkill[];
  error?: string | boolean;
}
interface FixtureOptions {
  language?: string;
  online?: boolean;
  page?: string;
  credentials?: CredentialVault;
  skills?: FixtureSkills;
}
interface FixtureState {
  conversationId?: string;
  settings: UiSettings;
  worker: { status: string };
  credentials: CredentialVault;
  skills: FixtureSkills;
}
type Hook = (route: string, options: ApiOptions) => unknown;
function fixture({
  language = 'en',
  online = true,
  page = 'settings',
  credentials = { items: [], requests: [] },
  skills = { items: [] },
}: FixtureOptions = {}) {
  const { document, Event } = parseHTML('<main id="app"></main>'),
    app = defined(document.querySelector<HTMLElement>('#app')),
    calls: ({ route: string } & ApiOptions)[] = [],
    toasts: string[] = [],
    backend = { credentials: structuredClone(credentials), skills: structuredClone(skills) },
    state: FixtureState = {
      settings: { language },
      worker: { status: online ? 'online' : 'offline' },
      credentials: structuredClone(credentials),
      skills: structuredClone(skills),
    };
  let modal: UiModal | null = null,
    ui: ReturnType<typeof createManagedSettings>,
    fail: Hook | null = null,
    approve = true,
    wait: Hook | null = null,
    currentPage = page;
  Object.defineProperty(defined(document.defaultView).HTMLInputElement.prototype, 'checked', {
    configurable: true,
    get() {
      return this.hasAttribute('checked');
    },
    set(value) {
      this.toggleAttribute('checked', !!value);
    },
  });
  function render() {
    modal = ui.syncModal(modal, currentPage);
    const template = document.createElement('template');
    template.innerHTML =
      (currentPage === 'skills'
        ? ui.renderSkillPage()
        : ui.renderCredentials() + ui.renderSkills()) + (ui.renderModal(modal) || '');
    for (const textarea of template.content.querySelectorAll<HTMLTextAreaElement>('textarea')) {
      const decoder = document.createElement('div');
      decoder.innerHTML = textarea.textContent;
      textarea.textContent = decoder.textContent;
    }
    reconcile(app, template.content);
    const password = document.querySelector<HTMLInputElement>('#credential-secret');
    if (password && !Object.hasOwn(password, 'value')) {
      let live = '';
      Object.defineProperty(password, 'value', {
        get: () => live,
        set: (value: string) => (live = String(value)),
      });
    }
    ui.bind();
    document
      .querySelectorAll<HTMLButtonElement>('[data-action="close-modal"]')
      .forEach((node) => (node.onclick = closeModal));
  }
  function closeModal() {
    ui.onClose(modal);
    modal = null;
    render();
  }
  const request = async (route: string, options: ApiOptions = {}) => {
    calls.push({ route, ...structuredClone(options) });
    if (wait) await wait(route, options);
    const rejected = fail?.(route, options);
    if (rejected)
      throw rejected instanceof Error ? rejected : Error('server rejected secret-do-not-echo');
    const method = options.method || 'GET';
    if (route === '/credentials' && method === 'GET') return structuredClone(backend.credentials);
    if (route === '/skills' && method === 'GET') return structuredClone(backend.skills);
    if (route.startsWith('/credentials/requests/')) {
      backend.credentials.requests = backend.credentials.requests.filter(
        (item) => item.id !== route.split('/').at(-1),
      );
      if (method === 'POST')
        backend.credentials.items.push({
          id: 'requested',
          name: 'Requested account',
          service: 'example.test',
          username: observedString(observedRecord(options.body).username),
        });
      return { stored: true };
    }
    if (route.startsWith('/credentials')) {
      if (method === 'POST')
        backend.credentials.items.push({
          id: 'created',
          name: observedString(observedRecord(options.body).name),
          service: observedString(observedRecord(options.body).service),
          username: observedString(observedRecord(options.body).username),
        });
      if (method === 'PATCH') {
        const item = backend.credentials.items.find((item) => item.id === route.split('/').at(-1));
        Object.assign(defined(item), {
          name: observedString(observedRecord(options.body).name),
          service: observedString(observedRecord(options.body).service),
          username: observedString(observedRecord(options.body).username),
        });
      }
      if (method === 'DELETE')
        backend.credentials.items = backend.credentials.items.filter(
          (item) => item.id !== route.split('/').at(-1),
        );
      return { ok: true };
    }
    if (route.startsWith('/skills/')) {
      const name = route.split('/').at(-1),
        item = backend.skills.items.find((item) => item.name === name);
      if (method === 'GET')
        return {
          ...item,
          instructions: item?.instructions ?? 'Use the computer carefully.',
          files: structuredClone(item?.files ?? { 'scripts/check.py': 'print(1)' }),
        };
      if (method === 'DELETE')
        backend.skills.items = backend.skills.items.filter((item) => item.name !== name);
      if (method === 'PATCH') Object.assign(defined(item), options.body);
      return { ok: true };
    }
    if (route === '/skills' && method === 'POST') {
      backend.skills.items.push({
        name: observedString(observedRecord(options.body).name),
        description: observedString(observedRecord(options.body).description),
        enabled: observedRecord(options.body).enabled === true,
        ...observedRecord(options.body),
        path:
          '/home/dant/workspace/.agents/skills/' +
          observedString(observedRecord(options.body).name) +
          '/SKILL.md',
      });
      return { ok: true };
    }
    throw Error('Unexpected route ' + route);
  };
  ui = createManagedSettings({
    getState: () => state,
    getModal: () => modal,
    request,
    render,
    toast: (value: string) => toasts.push(value),
    openModal: (value) => {
      modal = value;
      render();
    },
    closeModal,
    document,
    confirm: () => approve,
    icon: (name) => `<svg data-icon="${name}" aria-hidden="true"></svg>`,
  });
  render();
  return {
    ui,
    document,
    state,
    backend,
    calls,
    toasts,
    get modal() {
      return modal;
    },
    set fail(value: Hook | null) {
      fail = value;
    },
    set wait(value: Hook | null) {
      wait = value;
    },
    navigate(value: string) {
      ui.onClose(modal);
      modal = null;
      currentPage = value;
      render();
    },
    showModal(value: UiModal) {
      modal = value;
      render();
    },
    set approve(value: boolean) {
      approve = value;
    },
    render,
    closeModal,
    async click(selector: string | HTMLElement | null) {
      const node =
        typeof selector === 'string'
          ? document.querySelector<HTMLSelectElement>(selector)
          : selector;
      assert.ok(node, 'Missing click target ' + selector);
      node.dispatchEvent(new Event('click', { bubbles: true }));
      await settle();
    },
    input(name: string, value: string) {
      const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        '[name="' + name + '"]',
      );
      defined(node).value = value;
      defined(node).dispatchEvent(new Event('input', { bubbles: true }));
      return node;
    },
    async submit(id: string) {
      defined(document.querySelector<HTMLElement>(id)).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle();
    },
  };
}

test('vault and skill dictionaries are balanced and both languages render safe metadata and offline controls', async () => {
  assert.deepEqual(Object.keys(managedMessages.zh).sort(), Object.keys(managedMessages.en).sort());
  for (const words of Object.values(managedMessages))
    for (const value of Object.values(words)) assert.ok(observedString(value).trim());
  for (const language of ['zh', 'en']) {
    const f = fixture({
      language,
      online: false,
      credentials: {
        items: [{ id: 'id', name: '<vault>', service: 'example.test', username: 'account' }],
        requests: [],
      },
      skills: {
        items: [
          { name: 'computer', description: 'A task', enabled: false, path: '/managed/SKILL.md' },
        ],
      },
    });
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-credential-add]')).disabled,
      true,
    );
    assert.match(
      defined(f.document.querySelector<HTMLElement>('.credentials-settings')).textContent,
      /example.test/,
    );
    assert.equal(f.document.querySelector<HTMLElement>('vault'), null);
    assert.equal(
      defined(f.document.querySelector<HTMLInputElement>('[data-skill-toggle]')).disabled,
      true,
    );
    assert.ok(f.document.body?.textContent !== undefined || f.document.textContent !== undefined);
    await f.click('[data-credential-add]');
    assert.equal(f.modal, null);
    await f.ui.load();
    assert.equal(f.calls.length, 0);
  }
});

test('credential creation uses a private live field, survives reconciliation, and clears it after successful save', async () => {
  const f = fixture();
  await f.click('[data-credential-add]');
  f.input('name', 'Website');
  f.input('service', 'example.test');
  f.input('username', 'my-account');
  const password = f.input('secret', 'secret-do-not-echo');
  f.render();
  assert.equal(f.document.querySelector<HTMLInputElement>('#credential-secret'), password);
  assert.equal(defined(password).value, 'secret-do-not-echo');
  assert.doesNotMatch(defined(f.ui.renderModal(f.modal)), /secret-do-not-echo/);
  assert.equal(defined(password).getAttribute('autocomplete'), 'off');
  assert.equal(defined(password).type, 'password');
  await f.submit('#credential-form');
  assert.equal(defined(f.calls[0]).route, '/credentials');
  assert.equal(defined(f.calls[0]).method, 'POST');
  assert.equal(observedRecord(defined(f.calls[0]).body).secret, 'secret-do-not-echo');
  assert.equal(observedRecord(defined(f.calls[0]).body).username, 'my-account');
  assert.equal(defined(password).value, '');
  assert.equal(f.modal, null);
  assert.doesNotMatch(JSON.stringify(f.state), /secret-do-not-echo/);
  assert.doesNotMatch(JSON.stringify(f.toasts), /secret-do-not-echo/);
  assert.match(
    defined(f.document.querySelector<HTMLElement>('.credentials-settings')).textContent,
    /Website/,
  );
});

test('credential edits never fetch or prefill secrets, support keeping the existing value, and respect removal confirmation', async () => {
  const f = fixture({
    credentials: {
      items: [{ id: 'original', name: 'Website', service: 'example.test', username: 'old' }],
      requests: [],
    },
  });
  await f.click('[data-credential-edit]');
  assert.equal(f.calls.length, 0);
  assert.equal(defined(f.document.querySelector<HTMLInputElement>('#credential-secret')).value, '');
  assert.match(
    defined(f.document.querySelector<HTMLElement>('#credential-form')).textContent,
    /Leave blank/,
  );
  f.input('username', 'new');
  await f.submit('#credential-form');
  assert.equal(defined(f.calls[0]).method, 'PATCH');
  assert.equal(defined(f.calls[0]).route, '/credentials/original');
  assert.equal(Object.hasOwn(observedRecord(defined(f.calls[0]).body), 'secret'), false);
  f.approve = false;
  await f.click('[data-credential-remove]');
  assert.equal(f.calls.filter((call) => call.method === 'DELETE').length, 0);
  f.approve = true;
  await f.click('[data-credential-remove]');
  assert.equal(defined(f.calls.at(-2)).method, 'DELETE');
  assert.equal(f.state.credentials.items.length, 0);
});

test('credential failures retain only current input, expose a fixed localized error, and closing clears the live secret', async () => {
  const f = fixture({ language: 'zh' });
  await f.click('[data-credential-add]');
  f.input('name', 'Website');
  f.input('service', 'example.test');
  const secret = f.input('secret', 'secret-do-not-echo');
  f.fail = () => true;
  await f.submit('#credential-form');
  assert.equal(defined(secret).value, 'secret-do-not-echo');
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /凭据操作失败/,
  );
  assert.doesNotMatch(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /secret-do-not-echo/,
  );
  assert.doesNotMatch(JSON.stringify(f.toasts), /secret-do-not-echo/);
  const close = f.document.querySelector<HTMLButtonElement>(
    '.dialog-header [data-action="close-modal"]',
  );
  assert.equal(defined(close).getAttribute('aria-label'), '关闭');
  assert.equal(defined(close).title, '关闭');
  assert.ok(defined(close).classList.contains('icon-btn'));
  assert.ok(defined(close).querySelector<HTMLButtonElement>('[data-icon="x"]'));
  assert.equal(
    defined(
      f.document.querySelector<HTMLButtonElement>('.form-actions [data-action="close-modal"]'),
    ).textContent,
    '取消',
  );
  await f.click(close);
  assert.equal(defined(secret).value, '');
  assert.equal(f.modal, null);
  const invalid = fixture();
  await invalid.click('[data-credential-add]');
  await invalid.submit('#credential-form');
  assert.equal(invalid.calls.length, 0);
  assert.match(
    defined(invalid.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /Enter the name/,
  );
});

test('a confirmed credential write is not offered as a failed create when its metadata refresh fails', async () => {
  const f = fixture();
  await f.click('[data-credential-add]');
  f.input('name', 'Website');
  f.input('service', 'example.test');
  const secret = f.input('secret', 'secret-do-not-echo');
  f.fail = (route, options) => route === '/credentials' && !options.method;
  await f.submit('#credential-form');
  assert.equal(f.modal, null);
  assert.equal(defined(secret).value, '');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.match(defined(f.toasts.at(-1)), /saved/);
});

test('pending credential requests show purpose, can be dismissed and reopened, and fulfill or cancel through dedicated endpoints', async () => {
  const request = {
    id: 'request-1',
    name: 'Login',
    service: 'example.test',
    reason: 'Sign in to retrieve your report',
  };
  const f = fixture({ page: 'chat', credentials: { items: [], requests: [request] } });
  assert.equal(defined(f.modal).type, 'credential');
  assert.match(
    defined(f.document.querySelector<HTMLElement>('.credential-purpose')).textContent,
    /retrieve your report/,
  );
  assert.equal(
    defined(
      f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="name"]'),
    ).hasAttribute('readonly'),
    true,
  );
  const secret = f.input('secret', 'private');
  f.closeModal();
  assert.equal(defined(secret).value, '');
  assert.equal(f.modal, null);
  assert.ok(f.document.querySelector<HTMLButtonElement>('[data-credential-request]'));
  await f.click('[data-credential-request]');
  f.input('username', 'account');
  f.input('secret', 'private');
  await f.submit('#credential-form');
  assert.equal(defined(f.calls[0]).route, '/credentials/requests/request-1');
  assert.deepEqual(observedRecord(defined(f.calls[0]).body), {
    username: 'account',
    secret: 'private',
  });
  assert.equal(f.state.credentials.requests.length, 0);
  assert.equal(f.modal, null);
  assert.equal(
    f.calls.some((call) => call.route === '/messages'),
    false,
  );
  const cancel = fixture({ page: 'chat', credentials: { items: [], requests: [request] } });
  await cancel.click('[data-credential-cancel]');
  assert.equal(defined(cancel.calls[0]).method, 'DELETE');
  assert.equal(defined(cancel.calls[0]).route, '/credentials/requests/request-1');
  assert.equal(cancel.modal, null);
  const removed = fixture({ page: 'chat', credentials: { items: [], requests: [request] } }),
    field = removed.input('secret', 'private');
  removed.state.credentials.requests = [];
  removed.render();
  assert.equal(defined(field).value, '');
  assert.equal(removed.modal, null);
});

test('skills create, load, edit, toggle and remove real supporting text files without executing helpers', async () => {
  const f = fixture();
  await f.click('[data-skill-add]');
  f.input('name', 'computer-check');
  f.input('description', 'Inspect the desktop');
  f.input('instructions', 'Read the screenshot before acting.');
  f.input(
    'files',
    JSON.stringify({ 'scripts/check.py': 'print(1)', 'references/help.md': 'A guide' }),
  );
  await f.submit('#skill-form');
  assert.equal(defined(f.calls[0]).route, '/skills');
  assert.equal(defined(f.calls[0]).method, 'POST');
  assert.equal(
    observedRecord(observedRecord(defined(f.calls[0]).body).files)['scripts/check.py'],
    'print(1)',
  );
  assert.equal(observedRecord(defined(f.calls[0]).body).enabled, true);
  assert.equal(f.modal, null);
  assert.match(defined(f.toasts.at(-1)), /not been executed/);
  await f.click('[data-skill-edit]');
  assert.equal(defined(f.calls.at(-1)).route, '/skills/computer-check');
  assert.equal(
    defined(
      f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="name"]'),
    ).hasAttribute('readonly'),
    true,
  );
  assert.match(
    defined(f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="files"]'))
      .value,
    /scripts\/check.py/,
  );
  f.input('instructions', 'Updated instructions');
  f.render();
  assert.equal(
    defined(
      f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="instructions"]'),
    ).value,
    'Updated instructions',
  );
  await f.submit('#skill-form');
  assert.equal(defined(f.calls.at(-2)).method, 'PATCH');
  assert.equal(observedRecord(defined(f.calls.at(-2)).body).instructions, 'Updated instructions');
  const toggle = f.document.querySelector<HTMLInputElement>('[data-skill-toggle]');
  defined(toggle).checked = false;
  defined(toggle).dispatchEvent(
    new (defined(f.document.defaultView).Event)('change', { bubbles: true }),
  );
  await settle();
  assert.equal(observedRecord(defined(f.calls.at(-2)).body).enabled, false);
  f.approve = false;
  await f.click('[data-skill-remove]');
  assert.equal(f.state.skills.items.length, 1);
  f.approve = true;
  await f.click('[data-skill-remove]');
  assert.equal(f.state.skills.items.length, 0);
  assert.equal(
    f.calls.some((call) => /exec|tool|turn/.test(call.route)),
    false,
  );
});

test('invalid or failed skill forms preserve the draft and never POST malformed supporting files', async () => {
  const f = fixture();
  await f.click('[data-skill-add]');
  await f.submit('#skill-form');
  assert.equal(f.calls.length, 0);
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /Check the skill/,
  );
  f.input('name', 'computer');
  f.input('description', 'Useful');
  f.input('instructions', 'Read first.');
  f.input('files', '{"scripts/test.py": 42}');
  await f.submit('#skill-form');
  assert.equal(f.calls.length, 0);
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /JSON object/,
  );
  f.input('files', '{}');
  f.fail = () => true;
  await f.submit('#skill-form');
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /Existing files/,
  );
  assert.equal(
    defined(
      f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="instructions"]'),
    ).value,
    'Read first.',
  );
  f.closeModal();
  assert.equal(f.modal, null);
});

test('support-file validation enforces text, containment, UTF-8 byte and count limits', () => {
  assert.deepEqual(parseSkillFiles('{"assets/data.json":"{}"}'), { 'assets/data.json': '{}' });
  for (const value of [
    'null',
    '[]',
    'false',
    '{"../secret":"x"}',
    '{"scripts/../secret":"x"}',
    '{"scripts/a":"\u0000"}',
    '{"scripts/a":2}',
    '{"scripts/a:b":"x"}',
  ])
    assert.throws(() => parseSkillFiles(value));
  const boundary = Object.fromEntries(
    Array.from({ length: SKILL_SUPPORT_FILE_LIMIT }, (_, i) => ['scripts/' + i, 'x']),
  );
  assert.equal(SKILL_SUPPORT_FILE_LIMIT, 128);
  assert.deepEqual(parseSkillFiles(JSON.stringify(boundary)), boundary);
  assert.throws(() => parseSkillFiles(JSON.stringify({ ...boundary, 'scripts/overflow': 'x' })));
  assert.throws(() => parseSkillFiles(JSON.stringify({ 'scripts/a': '中'.repeat(22000) })));
  assert.throws(() =>
    parseSkillFiles(
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => ['scripts/' + i, 'x'.repeat(65536)]),
        ),
      ),
    ),
  );
});

test('a complete thirty-file skill opens and saves every helper without partial maps or automatic writes', async () => {
  const files = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`scripts/check-${index}.py`, `print(${index})\n`]),
    ),
    skill = {
      name: 'tetrio',
      description: 'A complete tested skill',
      instructions: 'Use the packaged helpers.',
      files,
      enabled: true,
      path: '/vm/.agents/skills/tetrio/SKILL.md',
    },
    f = fixture({ page: 'skills', skills: { items: [skill] } });
  await f.click('[data-skill-edit]');
  assert.equal(defined(f.modal).type, 'skill');
  assert.deepEqual(
    JSON.parse(
      defined(f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="files"]'))
        .value,
    ),
    files,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(defined(f.calls[0]).method, undefined);
  assert.match(defined(f.document.querySelector<HTMLElement>('.skill-files')).textContent, /128/);
  f.input('instructions', 'Updated instructions with all helpers.');
  f.render();
  assert.equal(f.calls.length, 1, 'opening and rerendering never saves the skill');
  await f.submit('#skill-form');
  const saved = f.calls.find((call) => call.method === 'PATCH');
  assert.equal(defined(saved).route, '/skills/tetrio');
  assert.deepEqual(observedRecord(defined(saved).body).files, files);
  assert.equal(
    observedRecord(defined(saved).body).instructions,
    'Updated instructions with all helpers.',
  );
  assert.equal(f.modal, null);
  assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, 1);
});

test('skill read size errors show a fixed actionable message in both languages and keep an existing draft', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({
      language,
      page: 'skills',
      skills: { items: [{ name: 'tetrio', description: 'Existing skill', enabled: true }] },
    });
    f.fail = (route) =>
      route === '/skills/tetrio'
        ? Object.assign(Error('private VM path and contents'), { status: 400, code: 'size_limit' })
        : false;
    await f.click('[data-skill-edit]');
    assert.equal(f.modal, null);
    assert.match(
      defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
      /128/,
    );
    assert.match(
      defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
      language === 'en' ? /Reduce the file count or size/ : /减少文件数量或大小/,
    );
    assert.doesNotMatch(f.document.toString(), /private VM path/);
    assert.equal(f.calls.length, 1);
    await f.click('[data-skill-add]');
    f.input('name', 'my-draft');
    f.input('instructions', 'Keep this draft.');
    await f.click('[data-skill-edit]');
    assert.equal(
      defined(f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="name"]'))
        .value,
      'my-draft',
    );
    assert.equal(
      defined(
        f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="instructions"]'),
      ).value,
      'Keep this draft.',
    );
    assert.equal(f.calls.filter((call) => call.method).length, 0);
    assert.match(
      defined(f.document.querySelector<HTMLElement>('#skill-form [role="status"]')).textContent,
      /128/,
    );
  }
});

test('safe refresh handles independent read failures without requesting secrets', async () => {
  const f = fixture();
  f.fail = (route) => route === '/credentials';
  await f.ui.load();
  assert.match(
    defined(f.document.querySelector<HTMLElement>('.credentials-settings')).textContent,
    /credential action failed/,
  );
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.calls.every((call) => !call.method),
    true,
  );
  f.fail = (route) => route === '/skills';
  await f.ui.load();
  assert.match(
    defined(f.document.querySelector<HTMLElement>('.skills-settings')).textContent,
    /skill action failed/,
  );
});

test('the dedicated skills page renders bilingual plugin cards and searches current names and descriptions locally', async () => {
  const items = [
    {
      name: 'browser-check',
      description: 'Inspect browser tabs',
      enabled: true,
      path: '/workspace/.agents/skills/browser-check/SKILL.md',
    },
    {
      name: '桌面检查',
      description: '截图后确认窗口',
      enabled: false,
      path: '/workspace/.dant-disabled-skills/desktop/SKILL.md',
    },
    {
      name: 'report',
      description: '<script>report</script>',
      enabled: true,
      path: '/workspace/.agents/skills/report/SKILL.md',
    },
  ];
  for (const language of ['zh', 'en']) {
    const f = fixture({ page: 'skills', language, skills: { items } });
    assert.equal(f.document.querySelector<HTMLElement>('.credentials-settings'), null);
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('#skills-page-title')).textContent,
      language === 'zh' ? '技能' : 'Skills',
    );
    assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 3);
    assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card-icon svg').length, 3);
    assert.equal(f.document.querySelector<HTMLElement>('script'), null);
    assert.equal(
      f.document.querySelectorAll<HTMLButtonElement>('.skill-card [data-skill-edit]').length,
      3,
    );
    assert.equal(
      f.document.querySelectorAll<HTMLButtonElement>('.skill-card [data-skill-remove]').length,
      3,
    );
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('.skill-card [role="switch"]')).getAttribute(
        'aria-checked',
      ),
      'true',
    );
    const search = f.document.querySelector<HTMLInputElement>('#skills-search');
    defined(search).value = 'BROWSER';
    defined(search).dispatchEvent(
      new (defined(f.document.defaultView).Event)('input', { bubbles: true }),
    );
    assert.equal(f.document.querySelector<HTMLInputElement>('#skills-search'), search);
    assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 1);
    assert.match(
      defined(f.document.querySelector<HTMLElement>('.skill-card')).textContent,
      /browser-check/,
    );
    assert.equal(f.calls.length, 0);
    defined(search).value = '截图';
    defined(search).dispatchEvent(
      new (defined(f.document.defaultView).Event)('input', { bubbles: true }),
    );
    assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 1);
    assert.match(
      defined(f.document.querySelector<HTMLElement>('.skill-card')).textContent,
      /桌面检查/,
    );
    assert.match(
      defined(f.document.querySelector<HTMLElement>('.skill-card-path code')).textContent,
      /dant-disabled-skills/,
    );
    defined(search).value = 'missing';
    defined(search).dispatchEvent(
      new (defined(f.document.defaultView).Event)('input', { bubbles: true }),
    );
    assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 0);
    assert.equal(
      defined(f.document.querySelector<HTMLElement>('.skills-page-empty p')).textContent,
      language === 'zh' ? '没有匹配的技能。' : 'No matching skills.',
    );
    assert.equal(
      f.document.querySelector<HTMLButtonElement>('.skills-page-empty [data-skill-add]'),
      null,
    );
    assert.equal(f.calls.length, 0);
  }
});

test('skill-only refresh shows loading, keeps cached cards on error, and never reads or changes credential status', async () => {
  const f = fixture({
    page: 'skills',
    skills: {
      items: [
        { name: 'computer', description: 'Useful', enabled: true, path: '/managed/SKILL.md' },
      ],
    },
  });
  let release: (() => void) | undefined;
  f.wait = (route) =>
    route === '/skills' ? new Promise<void>((resolve) => (release = resolve)) : undefined;
  const pending = f.ui.loadSkills();
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('.skills-grid')).getAttribute('aria-busy'),
    'true',
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-skills-refresh]')).disabled,
    true,
  );
  assert.match(
    defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
    /Loading/,
  );
  assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 1);
  await f.ui.loadSkills();
  assert.equal(f.calls.length, 1, 'duplicate refreshes stay serialized');
  defined(release)();
  await pending;
  assert.deepEqual(
    f.calls.map((call) => call.route),
    ['/skills'],
  );
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('.skills-grid')).getAttribute('aria-busy'),
    'false',
  );
  f.wait = null;
  f.fail = () => true;
  await f.click('[data-skills-refresh]');
  assert.match(
    defined(f.document.querySelector<HTMLElement>('.skills-page-notice.error')).textContent,
    /skill action failed/,
  );
  assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 1);
  assert.equal(f.state.credentials.error, undefined);
  const offline = fixture({ page: 'skills', online: false });
  assert.match(
    defined(offline.document.querySelector<HTMLElement>('.skills-page-notice')).textContent,
    /Connect the work computer/,
  );
  assert.match(
    defined(offline.document.querySelector<HTMLElement>('.skills-page-empty')).textContent,
    /No managed skills/,
  );
  assert.equal(
    defined(offline.document.querySelector<HTMLButtonElement>('[data-skill-add]')).disabled,
    true,
  );
  await offline.ui.loadSkills();
  assert.equal(offline.calls.length, 0);
});

test('plugin page actions retain existing CRUD and supporting-file drafts across state refreshes', async () => {
  const f = fixture({ page: 'skills' });
  await f.click('.skill-page-add');
  f.input('name', 'computer');
  f.input('description', 'Useful steps');
  f.input('instructions', 'Read before acting.');
  f.input('files', '{"scripts/check.py":"print(1)"}');
  const instructions = f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '[name="instructions"]',
    ),
    files = f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="files"]');
  await f.ui.loadSkills();
  assert.equal(
    f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="instructions"]'),
    instructions,
  );
  assert.equal(defined(instructions).value, 'Read before acting.');
  assert.equal(defined(files).value, '{"scripts/check.py":"print(1)"}');
  await f.submit('#skill-form');
  assert.equal(defined(f.calls.find((call) => call.method === 'POST')).route, '/skills');
  assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 1);
  const toggle = f.document.querySelector<HTMLInputElement>('[data-skill-toggle]');
  defined(toggle).checked = false;
  defined(toggle).dispatchEvent(
    new (defined(f.document.defaultView).Event)('change', { bubbles: true }),
  );
  await settle();
  assert.equal(defined(f.calls.at(-2)).method, 'PATCH');
  assert.deepEqual(observedRecord(defined(f.calls.at(-2)).body), { enabled: false });
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('.skill-card')).classList.contains('disabled'),
    true,
  );
  await f.click('[data-skill-edit]');
  assert.equal(defined(f.modal).type, 'skill');
  assert.match(
    defined(f.document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="files"]'))
      .value,
    /scripts\/check.py/,
  );
  f.closeModal();
  await f.click('[data-skill-remove]');
  assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 0);
  assert.equal(
    f.calls.some((call) => /run|exec|turn/.test(call.route)),
    false,
  );
});

test('a safe error snapshot keeps same-VM plugin cards but never carries them into a different conversation', async () => {
  const f = fixture({
    page: 'skills',
    skills: { items: [{ name: 'computer', description: 'Cached skill', enabled: true }] },
  });
  f.backend.skills = { items: [], error: 'Managed skills could not be read.' };
  await f.ui.loadSkills();
  assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 1);
  assert.match(
    defined(f.document.querySelector<HTMLElement>('.skills-page-notice.error')).textContent,
    /skill action failed/,
  );
  f.state.skills = { items: [], error: 'Managed skills could not be read.' };
  f.render();
  assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 1);
  f.state.conversationId = 'different-vm';
  f.render();
  assert.equal(f.document.querySelectorAll<HTMLElement>('.skill-card').length, 0);
  assert.equal(f.state.skills.items.length, 0);
});

test('late skill reads cannot open an editor after navigation, a different modal or a VM change', async () => {
  for (const change of ['navigation', 'modal', 'conversation', 'endpoint']) {
    const f = fixture({
      page: 'skills',
      skills: { items: [{ name: 'computer', description: 'Useful', enabled: true }] },
    });
    let release: (() => void) | undefined;
    f.state.conversationId = 'old';
    f.wait = (route, options) =>
      route === '/skills/computer' && !options.method
        ? new Promise<void>((resolve) => (release = resolve))
        : undefined;
    await f.click('[data-skill-edit]');
    assert.equal(f.modal, null);
    const unrelated = { type: 'search' };
    if (change === 'navigation') f.navigate('settings');
    else if (change === 'modal') f.showModal(unrelated);
    else if (change === 'conversation') f.state.conversationId = 'new';
    else f.state.settings.vm = { host: 'other-vm', user: 'dant', port: 22 };
    defined(release)();
    await settle();
    assert.equal(f.modal, change === 'modal' ? unrelated : null, change);
    assert.equal(f.document.querySelector<HTMLElement>('#skill-form'), null, change);
  }
});

test('late credential and skill snapshots are never applied to a different conversation or VM endpoint', async () => {
  for (const method of ['load', 'loadSkills'] as const)
    for (const change of ['conversation', 'endpoint']) {
      const f = fixture({
          page: 'skills',
          skills: { items: [{ name: 'old', description: 'Old', enabled: true }] },
        }),
        releases: (() => void)[] = [];
      f.state.conversationId = 'old';
      f.wait = () => new Promise<void>((resolve) => releases.push(resolve));
      const pending = f.ui[method]();
      assert.ok(releases.length);
      if (change === 'conversation') f.state.conversationId = 'new';
      else f.state.settings.vm = { host: 'other-vm' };
      f.state.skills = { items: [{ name: 'new', description: 'Current VM', enabled: true }] };
      f.state.credentials = {
        items: [{ id: 'new-vault', name: 'New vault', service: '' }],
        requests: [],
      };
      for (const release of releases) defined(release)();
      await pending;
      assert.equal(defined(f.state.skills.items[0]).name, 'new');
      assert.equal(defined(f.state.credentials.items[0]).name, 'New vault');
      assert.match(
        defined(f.document.querySelector<HTMLElement>('.skill-card')).textContent,
        /Current VM/,
      );
    }
});

test('acknowledged saves preserve later modal ownership and never replay or overwrite another VM snapshot', async () => {
  for (const kind of ['skill', 'credential']) {
    const f = fixture({ page: kind === 'skill' ? 'skills' : 'settings' });
    if (kind === 'skill') {
      await f.click('[data-skill-add]');
      f.input('name', 'computer');
      f.input('description', 'Useful');
      f.input('instructions', 'Read first.');
    } else {
      await f.click('[data-credential-add]');
      f.input('name', 'Account');
      f.input('service', 'example.test');
      f.input('secret', 'private');
    }
    let release: (() => void) | undefined;
    f.wait = (_route, options) =>
      options.method === 'POST' ? new Promise<void>((resolve) => (release = resolve)) : undefined;
    await f.submit(kind === 'skill' ? '#skill-form' : '#credential-form');
    f.navigate('skills');
    const unrelated = { type: 'other' };
    f.showModal(unrelated);
    defined(release)();
    await settle();
    assert.equal(f.modal, unrelated, kind);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
    assert.match(defined(f.toasts.at(-1)), /saved/i);
  }
  const changed = fixture({ page: 'skills' });
  changed.state.conversationId = 'old';
  await changed.click('[data-skill-add]');
  changed.input('name', 'computer');
  changed.input('description', 'Useful');
  changed.input('instructions', 'Read first.');
  let release: (() => void) | undefined;
  changed.wait = (_route, options) =>
    options.method === 'POST' ? new Promise<void>((resolve) => (release = resolve)) : undefined;
  await changed.submit('#skill-form');
  changed.state.conversationId = 'new';
  changed.state.skills = { items: [{ name: 'current', description: 'Current VM', enabled: true }] };
  defined(release)();
  await settle();
  assert.equal(defined(changed.state.skills.items[0]).name, 'current');
  assert.equal(changed.calls.filter((call) => call.route === '/skills' && !call.method).length, 0);
});
