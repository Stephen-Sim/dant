import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../ui/shared/dom.js';
import { createManagedSettings } from '../ui/settings/managed-settings.js';

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture({
  language = 'en',
  online = true,
  save = async () => ({ saved: true }),
  request: provided,
} = {}) {
  const { document, Event } = parseHTML('<main id="app"></main>'),
    app = document.querySelector('#app'),
    calls = [],
    downloads = [],
    toasts = [];
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
  let ui;
  function render() {
    const template = document.createElement('template');
    template.innerHTML = ui.renderSkillPage();
    reconcile(app, template.content);
    ui.bind();
  }
  ui = createManagedSettings({
    document,
    getState: () => state,
    render,
    toast: (value) => toasts.push(value),
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
      document
        .querySelector('[data-skill-export]')
        .dispatchEvent(new Event('click', { bubbles: true }));
      await settle();
    },
  };
}

test('each bilingual skill card exports once through the shared save flow without opening a URL', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ language }),
      button = f.document.querySelector('[data-skill-export]');
    assert.equal(button.textContent, language === 'en' ? 'Download ZIP' : '下载 ZIP');
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.hasAttribute('href'), false);
    await f.click();
    assert.deepEqual(f.calls, [
      { route: '/skills/desktop-check/export', method: 'POST', body: {} },
    ]);
    assert.deepEqual(f.downloads, [f.file]);
    assert.equal(f.toasts.length, 1);
    assert.ok(f.document.querySelector('[data-skill-edit]'));
    assert.match(f.ui.renderSkills(), /data-skill-export="desktop-check"/);
  }
});

test('pending export and save disable duplicate actions and preserve an expanded skill path', async () => {
  const exporting = deferred(),
    saving = deferred(),
    f = fixture({ request: () => exporting.promise, save: () => saving.promise });
  f.document.querySelector('[data-skill-path]').setAttribute('open', '');
  await f.click();
  assert.equal(f.document.querySelector('[data-skill-export]').disabled, true);
  assert.equal(f.document.querySelector('[data-skill-edit]').disabled, true);
  await f.click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.downloads.length, 0);
  exporting.resolve(f.file);
  await settle();
  assert.equal(f.downloads.length, 1);
  await f.click();
  assert.equal(f.calls.length, 1);
  assert.equal(f.document.querySelector('[data-skill-path]').hasAttribute('open'), true);
  saving.resolve({ saved: true });
  await settle();
  assert.equal(f.document.querySelector('[data-skill-export]').disabled, false);
  assert.equal(f.document.querySelector('[data-skill-path]').hasAttribute('open'), true);
  assert.equal(f.toasts.length, 1);
});

test('cancelling Save As leaves the skill intact without a success message', async () => {
  const f = fixture({ save: async () => ({ saved: false }) }),
    before = structuredClone(f.state.skills);
  await f.click();
  assert.deepEqual(f.state.skills, before);
  assert.deepEqual(f.toasts, []);
  assert.equal(f.document.querySelector('[role="status"]'), null);
  assert.equal(f.document.querySelector('[data-skill-export]').disabled, false);
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
              return { id: 'file', name: 'skill.zip' };
            }
          : undefined,
      save: stage === 'save' ? async () => problem() : undefined,
    });
    f.document.querySelector('[data-skill-path]').setAttribute('open', '');
    await f.click();
    assert.match(
      f.document.querySelector('[role="status"]').textContent,
      /could not be downloaded/,
    );
    assert.doesNotMatch(f.document.querySelector('#app').textContent, /private upstream/);
    assert.equal(f.document.querySelector('[data-skill-path]').hasAttribute('open'), true);
    assert.equal(f.document.querySelector('[data-skill-export]').disabled, false);
    assert.deepEqual(f.toasts, []);
    fail = false;
    await f.click();
    assert.equal(f.toasts.length, 1);
    assert.equal(f.document.querySelector('[role="status"]'), null);
  }
});

test('offline exports and stale conversation or VM responses never start a download', async () => {
  const offline = fixture({ online: false });
  assert.equal(offline.document.querySelector('[data-skill-export]').disabled, true);
  await offline.click();
  assert.deepEqual(offline.calls, []);
  for (const change of ['conversation', 'vm']) {
    const wait = deferred(),
      f = fixture({ request: () => wait.promise });
    await f.click();
    if (change === 'conversation') f.state.conversationId = 'chat-b';
    else f.state.settings.vm.host = 'vm-b';
    f.render();
    wait.resolve(f.file);
    await settle();
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.toasts, []);
    assert.equal(f.document.querySelector('[data-skill-export]').disabled, false);
  }
});
