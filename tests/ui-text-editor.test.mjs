import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { createTextEditor } from '../ui/platform/text-editor.js';
import { reconcile } from '../ui/shared/dom.js';
const id = '10b72b2a-346f-48c0-a243-1cb22871d91d',
  token = 'a'.repeat(64),
  file = { id, name: 'source.ps1', type: 'text/plain' };
const tick = () => new Promise((resolve) => setImmediate(resolve)),
  deferred = () => {
    let resolve;
    const promise = new Promise((yes) => (resolve = yes));
    return { promise, resolve };
  };
function fixture(options = {}) {
  const { document, Event } = parseHTML(
      '<html><body><input id="other-setting"><main></main></body></html>',
    ),
    calls = [];
  let renders = 0,
    focused = null;
  Object.defineProperty(document, 'activeElement', {
    get: () => (focused?.isConnected ? focused : document.body),
  });
  const render = () => {
    renders++;
    const template = document.createElement('template');
    template.innerHTML = ui.renderSettings();
    reconcile(document.querySelector('main'), template.content);
    for (const node of document.querySelectorAll('button,input'))
      node.focus = () => {
        focused = node;
      };
    ui.bind();
  };
  const ui = createTextEditor({
    desktop: true,
    document,
    getToken: () => token,
    render,
    invoke: async (command, args) => {
      calls.push({ command, args });
      return command === 'open_attachment_in_editor'
        ? { opened: true }
        : command === 'installed_text_editors'
          ? { editors: [{ id: 'notepad', name: 'Notepad' }] }
          : { editor: 'notepad', id: 'notepad', name: 'Notepad' };
    },
    ...options,
  });
  render();
  return {
    ui,
    document,
    Event,
    calls,
    render,
    get renders() {
      return renders;
    },
    menu() {
      document.querySelector('[data-editor-menu-trigger]').click();
    },
    key(node, key) {
      const event = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: key });
      node.dispatchEvent(event);
      return event;
    },
  };
}
test('the app menu lists only native installed editor IDs, shows the current check and selects without paths or commands', async () => {
  const apps = [
    { id: 'notepad', name: 'Notepad' },
    { id: 'vscode', name: 'Visual Studio Code' },
    { id: 'cursor', name: 'Cursor' },
  ];
  let preference = { editor: 'notepad', id: 'notepad', name: 'Notepad' };
  const f = fixture({
    invoke: async (command, args) => {
      f.calls.push({ command, args });
      if (command === 'installed_text_editors') return { editors: apps };
      if (command === 'select_text_editor') {
        preference = {
          editor: 'custom',
          id: args.editorId,
          name: apps.find((app) => app.id === args.editorId).name,
        };
        return preference;
      }
      if (command === 'reset_text_editor')
        preference = { editor: 'notepad', id: 'notepad', name: 'Notepad' };
      return preference;
    },
  });
  await Promise.all([f.ui.load(), f.ui.load()]);
  assert.deepEqual(
    f.calls.map((call) => call.command),
    ['editor_preferences', 'installed_text_editors'],
  );
  const trigger = f.document.querySelector('[data-editor-menu-trigger]');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  f.menu();
  assert.equal(f.document.querySelector('[data-editor-menu]').getAttribute('role'), 'menu');
  assert.deepEqual(
    [...f.document.querySelectorAll('[data-editor-option]')].map(
      (node) => node.dataset.editorOption,
    ),
    ['notepad', 'vscode', 'cursor'],
  );
  assert.equal(
    f.document.querySelector('[data-editor-option="notepad"]').getAttribute('aria-checked'),
    'true',
  );
  assert.equal(
    f.document
      .querySelector('[data-editor-option="vscode"]')
      .querySelector('svg')
      .getAttribute('aria-hidden'),
    'true',
  );
  assert.equal(f.document.querySelector('[data-editor-option="zed"]'), null);
  f.key(f.document.querySelector('[data-editor-option="vscode"]'), 'Enter');
  await tick();
  assert.deepEqual(f.calls.at(-1), { command: 'select_text_editor', args: { editorId: 'vscode' } });
  assert.equal(f.document.querySelector('[data-editor-name]').textContent, 'Visual Studio Code');
  assert.equal(f.document.querySelector('[data-editor-menu]'), null);
  assert.equal(f.document.activeElement.dataset.editorMenuTrigger, '');
  f.menu();
  assert.equal(
    f.document.querySelector('[data-editor-option="vscode"]').getAttribute('aria-checked'),
    'true',
  );
  f.document.querySelector('[data-editor-option="notepad"]').click();
  await tick();
  assert.deepEqual(f.calls.at(-1), { command: 'reset_text_editor', args: undefined });
  assert.equal(f.document.querySelector('[data-editor-name]').textContent, 'Notepad');
  assert.equal(f.document.querySelector('main input'), null);
  assert.equal(f.document.querySelector('img'), null);
  f.ui.dispose();
});
test('the current custom editor stays selected and browsing cancellation is quiet and serialized', async () => {
  const wait = deferred();
  let picks = 0;
  const f = fixture({
    invoke: async (command) =>
      command === 'installed_text_editors'
        ? { editors: [] }
        : command === 'choose_text_editor'
          ? (picks++, wait.promise)
          : { editor: 'custom', name: 'My Editor.exe' },
  });
  await f.ui.load();
  f.menu();
  const custom = f.document.querySelector('[data-editor-option="custom"]');
  assert.equal(custom.getAttribute('aria-checked'), 'true');
  assert.match(custom.textContent, /My Editor.exe.*Current editor/);
  custom.click();
  await tick();
  assert.equal(picks, 0);
  f.menu();
  const choose = f.document.querySelector('[data-editor-choose]');
  choose.click();
  choose.click();
  assert.equal(picks, 1);
  assert.equal(f.document.querySelector('[data-editor-menu-trigger]').disabled, true);
  wait.resolve(null);
  await tick();
  assert.equal(f.document.querySelector('.error'), null);
  assert.equal(f.document.querySelector('[data-editor-name]').textContent, 'My Editor.exe');
  assert.equal(f.document.activeElement.dataset.editorMenuTrigger, '');
  f.ui.dispose();
});
test('keyboard navigation follows menu radio semantics, restores focus and closes for Escape and outside clicks', async () => {
  const f = fixture({
    invoke: async (command) =>
      command === 'installed_text_editors'
        ? {
            editors: [
              { id: 'vscode', name: 'VS Code' },
              { id: 'cursor', name: 'Cursor' },
            ],
          }
        : { editor: 'notepad', name: 'Notepad' },
  });
  await f.ui.load();
  f.key(f.document.querySelector('[data-editor-menu-trigger]'), 'ArrowDown');
  assert.equal(f.document.activeElement.dataset.editorOption, 'notepad');
  f.key(f.document.activeElement, 'ArrowDown');
  assert.equal(f.document.activeElement.dataset.editorOption, 'vscode');
  f.key(f.document.activeElement, 'End');
  assert.ok(f.document.activeElement.hasAttribute('data-editor-choose'));
  f.key(f.document.activeElement, 'ArrowDown');
  assert.equal(f.document.activeElement.dataset.editorOption, 'notepad');
  f.key(f.document.activeElement, 'ArrowUp');
  assert.ok(f.document.activeElement.hasAttribute('data-editor-choose'));
  f.key(f.document.activeElement, 'Home');
  assert.equal(f.document.activeElement.dataset.editorOption, 'notepad');
  assert.equal(f.document.querySelectorAll('[data-editor-menu] [tabindex="0"]').length, 1);
  f.key(f.document.activeElement, 'Escape');
  assert.equal(f.document.querySelector('[data-editor-menu]'), null);
  assert.ok(f.document.activeElement.hasAttribute('data-editor-menu-trigger'));
  f.key(f.document.querySelector('[data-editor-menu-trigger]'), 'ArrowUp');
  assert.ok(f.document.activeElement.hasAttribute('data-editor-choose'));
  f.key(f.document.activeElement, 'Tab');
  assert.equal(f.document.querySelector('[data-editor-menu]'), null);
  f.menu();
  f.document
    .querySelector('#other-setting')
    .dispatchEvent(new f.Event('pointerdown', { bubbles: true }));
  assert.equal(f.document.querySelector('[data-editor-menu]'), null);
  f.ui.dispose();
});
test('pending reads and writes cannot race, stale menu choices cannot launch and late results do not steal unrelated focus', async () => {
  const read = deferred(),
    write = deferred(),
    commands = [],
    f = fixture({
      invoke: async (command, args) => {
        commands.push(command);
        if (command === 'installed_text_editors')
          return { editors: [{ id: 'vscode', name: 'VS Code' }] };
        if (command === 'editor_preferences') return read.promise;
        if (command === 'select_text_editor') return write.promise;
        return { editor: 'notepad', name: 'Notepad' };
      },
    }),
    loading = f.ui.load();
  assert.equal(f.document.querySelector('[data-editor-menu-trigger]').disabled, true);
  f.menu();
  assert.equal(f.document.querySelector('[data-editor-menu]'), null);
  read.resolve({ editor: 'notepad', name: 'Notepad' });
  await loading;
  f.menu();
  const stale = f.document.querySelector('[data-editor-option="vscode"]');
  stale.click();
  stale.click();
  assert.equal(commands.filter((value) => value === 'select_text_editor').length, 1);
  f.document.querySelector('#other-setting').focus();
  write.resolve({ editor: 'custom', id: 'vscode', name: 'VS Code' });
  await tick();
  assert.equal(f.document.activeElement.id, 'other-setting');
  assert.equal(f.document.querySelector('[data-editor-name]').textContent, 'VS Code');
  await f.ui.load();
  assert.equal(commands.filter((value) => value === 'editor_preferences').length, 1);
  f.ui.dispose();
});
test('invalid native names and inventory failures stay private while Browse and retry remain usable', async () => {
  for (const bad of [
    async () => {
      throw Error('private directory and secret');
    },
    async () => ({ editor: 'custom', name: 'C:\\private\\Code.exe' }),
    async (command) =>
      command === 'installed_text_editors'
        ? { editors: [{ id: 'C:\\private\\run.exe', name: 'private' }] }
        : { editor: 'notepad', name: 'Notepad' },
  ]) {
    const f = fixture({ invoke: bad });
    await f.ui.load();
    assert.ok(f.document.querySelector('.error'));
    assert.doesNotMatch(f.document.body.textContent, /private|secret/);
    assert.equal(f.document.querySelector('[data-editor-menu-trigger]').disabled, false);
    f.menu();
    assert.ok(f.document.querySelector('[data-editor-choose]'));
    assert.ok(f.document.querySelector('[data-editor-option="notepad"]'));
    f.ui.dispose();
  }
  let recover = false;
  const f = fixture({
    invoke: async (command) => {
      if (command === 'installed_text_editors') {
        if (!recover) throw Error('old native command');
        return { editors: [{ id: 'zed', name: 'Zed' }] };
      }
      return { editor: 'notepad', name: 'Notepad' };
    },
  });
  await f.ui.load();
  recover = true;
  f.document.querySelector('[data-editor-retry]').click();
  await tick();
  assert.equal(f.document.querySelector('.error'), null);
  f.menu();
  assert.ok(f.document.querySelector('[data-editor-option="zed"]'));
  f.ui.dispose();
});
test('a formerly selected detected app is retained as unavailable instead of silently resetting preference', async () => {
  const f = fixture({
    invoke: async (command) =>
      command === 'installed_text_editors'
        ? { editors: [] }
        : { editor: 'custom', id: 'cursor', name: 'Cursor' },
  });
  await f.ui.load();
  f.menu();
  const missing = f.document.querySelector('[data-editor-option="cursor"]');
  assert.equal(missing.disabled, true);
  assert.equal(missing.getAttribute('aria-checked'), 'true');
  assert.match(missing.textContent, /No longer detected/);
  assert.equal(f.document.querySelector('[data-editor-name]').textContent, 'Cursor');
  f.ui.dispose();
});
test('selecting Notepad repairs an unreadable preference, while an inventory-only failure does not reset a confirmed preference', async () => {
  for (const failedRead of ['preference', 'inventory']) {
    const commands = [],
      f = fixture({
        invoke: async (command) => {
          commands.push(command);
          if (command === 'editor_preferences') {
            if (failedRead === 'preference') throw Error('private corrupt preference');
            return { editor: 'notepad', id: 'notepad', name: 'Notepad' };
          }
          if (command === 'installed_text_editors') {
            if (failedRead === 'inventory') throw Error('private failed inventory');
            return { editors: [] };
          }
          return { editor: 'notepad', id: 'notepad', name: 'Notepad' };
        },
      });
    await f.ui.load();
    assert.ok(f.document.querySelector('.error'));
    f.menu();
    f.document.querySelector('[data-editor-option="notepad"]').click();
    await tick();
    assert.equal(
      commands.filter((command) => command === 'reset_text_editor').length,
      failedRead === 'preference' ? 1 : 0,
    );
    assert.equal(f.document.querySelector('[data-editor-menu]'), null);
    assert.equal(f.document.querySelector('[data-editor-name]').textContent, 'Notepad');
    if (failedRead === 'preference') assert.equal(f.document.querySelector('.error'), null);
    f.ui.dispose();
  }
});
test('opening a text attachment directly invokes the fixed native command once, with no URL, local destination or command arguments', async () => {
  const wait = deferred(),
    f = fixture({
      invoke: async (command, args) => {
        f.calls.push({ command, args });
        return wait.promise;
      },
    }),
    first = f.ui.open(file),
    second = f.ui.open(file);
  assert.equal(first, second);
  assert.deepEqual(f.calls, [
    { command: 'open_attachment_in_editor', args: { fileId: id, token, fileName: 'source.ps1' } },
  ]);
  wait.resolve({ opened: true });
  assert.deepEqual(await first, { opened: true });
  f.ui.dispose();
});
test('browser, malformed auth/id, executable attachments and private native errors never launch an editor', async () => {
  for (const options of [{ desktop: false }, { getToken: () => '' }]) {
    const f = fixture(options);
    await assert.rejects(f.ui.open(file), (error) => error.code === 'editor_failed');
    assert.equal(f.calls.length, 0);
    f.ui.dispose();
  }
  const f = fixture();
  for (const value of [
    null,
    { ...file, id: '../private' },
    { ...file, name: 'run.exe', type: 'text/plain' },
    { ...file, name: 'file.zip', type: 'application/zip' },
  ])
    await assert.rejects(f.ui.open(value));
  assert.equal(f.calls.length, 0);
  f.ui.dispose();
  for (const invoke of [
    async () => {
      throw Error('private process path');
    },
    async () => ({ opened: false }),
  ]) {
    const bad = fixture({ invoke });
    await assert.rejects(
      bad.ui.open(file),
      (error) => !error.message.includes('private') && error.code === 'editor_failed',
    );
    bad.ui.dispose();
  }
});
test('disposal prevents late dynamic imports from invoking native commands or changing settings', async () => {
  const wait = deferred(),
    calls = [],
    f = fixture({ invoke: undefined, loadCore: () => wait.promise }),
    opening = f.ui.open(file),
    failed = assert.rejects(opening, (error) => error.code === 'editor_failed'),
    loading = f.ui.load();
  f.ui.dispose();
  wait.resolve({
    invoke: async (command) => {
      calls.push(command);
      return { editor: 'custom', name: 'Code.exe' };
    },
  });
  await failed;
  await loading;
  assert.equal(calls.length, 0);
  assert.equal(f.document.querySelector('[data-editor-name]').textContent, 'Notepad');
  await assert.rejects(f.ui.open(file));
});
test('Chinese settings and browser availability are localized and do not contact the VM', async () => {
  const f = fixture({ desktop: false, getLanguage: () => 'zh' });
  await f.ui.load();
  assert.match(f.document.body.textContent, /打开方式/);
  assert.match(f.document.body.textContent, /桌面应用/);
  assert.equal(f.document.querySelector('[data-editor-menu-trigger]').disabled, true);
  assert.equal(f.calls.length, 0);
  f.ui.dispose();
});
test('native editor opens only safe cached text with a fixed Notepad or picked editor, never a shell or file association', () => {
  const source = fs.readFileSync(
    new URL('../src-tauri/src/text_editor.rs', import.meta.url),
    'utf8',
  );
  assert.match(source, /window\.label\(\) == "main"/);
  assert.match(source, /127\.0\.0\.1:4317\/api\/files\/\{file_id\}/);
  assert.match(source, /no_proxy\(\)\s*\.redirect\(reqwest::redirect::Policy::none\(\)\)/);
  assert.match(source, /Command::new\(executable\)/);
  assert.match(source, /command\s*\.arg\(target\)/);
  assert.match(source, /editor_command\(&executable, &target\)\s*\.spawn\(\)/);
  assert.doesNotMatch(source, /cmd\s*\/c|powershell|opener\(\)|open_path|shell_execute/i);
  assert.match(source, /join\("System32"\)\s*\.join\("notepad.exe"\)/);
  assert.match(source, /text_payload\(&bytes/);
  assert.match(source, /Sha256::digest/);
  assert.match(source, /create_new\(true\)/);
  assert.match(source, /file_attributes\(\) & 0x400/);
  assert.match(source, /3 \* 24 \* 60 \* 60/);
  assert.match(source, /Preserve a user's edits/);
});
