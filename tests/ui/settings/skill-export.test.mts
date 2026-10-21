import type { Attachment, ApiOptions } from '../../../ui/shared/contracts.mts';
import { deferred, unexpectedFixtureOperation } from '../../support/service-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { createManagedSettings } from '../../../ui/settings/managed-settings.mts';

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
function fixture({
  language = 'en',
  online = true,
  save = async () => ({ saved: true }),
  request: provided,
}: {
  language?: string;
  online?: boolean;
  save?: ((file: Attachment) => Promise<{ saved: boolean }>) | undefined;
  request?: ((route: string, options?: ApiOptions) => unknown) | undefined;
} = {}) {
  const { document, Event } = parseHTML('<main id="app"></main>'),
    app = document.querySelector<HTMLElement>('#app'),
    calls: ({ route: string } & ApiOptions)[] = [],
    downloads: Attachment[] = [],
    toasts: string[] = [];
  const state = {
    conversationId: 'chat-a',
    settings: { language, vm: { host: 'vm-a', user: 'dant', port: 22 } },
    worker: { status: online ? 'online' : 'offline' },
    skills: {
      items: [
        {
          name: 'desktop-check',
          description: 'Check the screen',
          path: '/work/.agents/skills/desktop-check/SKILL.md',
          enabled: true,
        },
      ],
    },
  };
  const file = { id: 'export-id', name: 'desktop-check.zip', type: 'application/zip', size: 500 };
  let ui: ReturnType<typeof createManagedSettings>;
  function render() {
    const template = document.createElement('template');
    template.innerHTML = ui.renderSkillPage();
    reconcile(defined(app), template.content);
    ui.bind();
  }
  ui = createManagedSettings({
    document,
    openModal: unexpectedFixtureOperation,
    closeModal: unexpectedFixtureOperation,
    getState: () => state,
    render,
    toast: (value: string) => toasts.push(value),
    request: async (route, options) => {
      calls.push({ route, ...options });
      return provided ? provided(route, options) : file;
    },
    download: async (value) => {
      downloads.push(value);
      return save(value);
    },
  });
  render();
  return {
    document,
    state,
    calls,
    downloads,
    toasts,
    ui,
    render,
    file,
    async click() {
      defined(document.querySelector<HTMLButtonElement>('[data-skill-export]')).dispatchEvent(
        new Event('click', { bubbles: true }),
      );
      await settle();
    },
  };
}

test('each bilingual skill card exports once through the shared save flow without opening a URL', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ language }),
      button = f.document.querySelector<HTMLButtonElement>('[data-skill-export]');
    assert.equal(defined(button).textContent, language === 'en' ? 'Download ZIP' : '下载 ZIP');
    assert.equal(defined(button).tagName, 'BUTTON');
    assert.equal(defined(button).getAttribute('type'), 'button');
    assert.equal(defined(button).hasAttribute('href'), false);
    await f.click();
    assert.deepEqual(f.calls, [
      { route: '/skills/desktop-check/export', method: 'POST', body: {} },
    ]);
    assert.deepEqual(f.downloads, [f.file]);
    assert.equal(f.toasts.length, 1);
    assert.ok(f.document.querySelector<HTMLButtonElement>('[data-skill-edit]'));
    assert.match(f.ui.renderSkills(), /data-skill-export="desktop-check"/);
  }
});

test('pending export and save disable duplicate actions and preserve an expanded skill path', async () => {
  const exporting = deferred<unknown>(),
    saving = deferred<{ saved: boolean }>(),
    f = fixture({ request: () => exporting.promise, save: () => saving.promise });
  defined(f.document.querySelector<HTMLDetailsElement>('[data-skill-path]')).setAttribute(
    'open',
    '',
  );
  await f.click();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-skill-export]')).disabled,
    true,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-skill-edit]')).disabled,
    true,
  );
  await f.click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.downloads.length, 0);
  exporting.resolve(f.file);
  await settle();
  assert.equal(f.downloads.length, 1);
  await f.click();
  assert.equal(f.calls.length, 1);
  assert.equal(
    defined(f.document.querySelector<HTMLDetailsElement>('[data-skill-path]')).hasAttribute('open'),
    true,
  );
  saving.resolve({ saved: true });
  await settle();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-skill-export]')).disabled,
    false,
  );
  assert.equal(
    defined(f.document.querySelector<HTMLDetailsElement>('[data-skill-path]')).hasAttribute('open'),
    true,
  );
  assert.equal(f.toasts.length, 1);
});

test('cancelling Save As leaves the skill intact without a success message', async () => {
  const f = fixture({ save: async () => ({ saved: false }) }),
    before = structuredClone(f.state.skills);
  await f.click();
  assert.deepEqual(f.state.skills, before);
  assert.deepEqual(f.toasts, []);
  assert.equal(f.document.querySelector<HTMLElement>('[role="status"]'), null);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-skill-export]')).disabled,
    false,
  );
});

test('export and save errors show a fixed safe message and allow an explicit retry', async () => {
  for (const stage of ['export', 'save']) {
    let fail = true;
    const problem = () => {
      if (fail) throw Error('private upstream detail');
      return { saved: true };
    };
    const f = fixture({
      request:
        stage === 'export'
          ? () => {
              problem();
              return { id: 'file', name: 'skill.zip', type: 'application/zip' };
            }
          : undefined,
      save: stage === 'save' ? async () => problem() : undefined,
    });
    defined(f.document.querySelector<HTMLDetailsElement>('[data-skill-path]')).setAttribute(
      'open',
      '',
    );
    await f.click();
    assert.match(
      defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent,
      /could not be downloaded/,
    );
    assert.doesNotMatch(
      defined(f.document.querySelector<HTMLElement>('#app')).textContent,
      /private upstream/,
    );
    assert.equal(
      defined(f.document.querySelector<HTMLDetailsElement>('[data-skill-path]')).hasAttribute(
        'open',
      ),
      true,
    );
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-skill-export]')).disabled,
      false,
    );
    assert.deepEqual(f.toasts, []);
    fail = false;
    await f.click();
    assert.equal(f.toasts.length, 1);
    assert.equal(f.document.querySelector<HTMLElement>('[role="status"]'), null);
  }
});

test('offline exports and stale conversation or VM responses never start a download', async () => {
  const offline = fixture({ online: false });
  assert.equal(
    defined(offline.document.querySelector<HTMLButtonElement>('[data-skill-export]')).disabled,
    true,
  );
  await offline.click();
  assert.deepEqual(offline.calls, []);
  for (const change of ['conversation', 'vm']) {
    const wait = deferred<unknown>(),
      f = fixture({ request: () => wait.promise });
    await f.click();
    if (change === 'conversation') f.state.conversationId = 'chat-b';
    else f.state.settings.vm.host = 'vm-b';
    f.render();
    wait.resolve(f.file);
    await settle();
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.toasts, []);
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-skill-export]')).disabled,
      false,
    );
  }
});

test('fixed export rejection codes describe file, size and credential problems without leaking upstream details', async () => {
  for (const language of ['en', 'zh'])
    for (const [code, message] of [
      ['unsupported_file', language === 'en' ? /could not be encoded/ : /未能编码/],
      ['size_limit', language === 'en' ? /supported limits/ : /超过支持范围/],
      ['credentials', language === 'en' ? /contains a saved credential/ : /包含已保存的凭据/],
    ] as const) {
      const f = fixture({
        language,
        request: () => {
          throw Object.assign(Error('private file content'), { code });
        },
      });
      await f.click();
      const status = defined(f.document.querySelector<HTMLElement>('[role="status"]')).textContent;
      assert.match(status, message);
      assert.doesNotMatch(status, /private file content/);
      assert.equal(f.downloads.length, 0);
      assert.equal(f.toasts.length, 0);
    }
});
