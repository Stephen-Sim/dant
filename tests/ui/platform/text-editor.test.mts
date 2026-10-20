import type { NativeInvoke } from '../../../ui/platform/transport.mts';
import { isRecord } from '../../../ui/shared/json.mts';
type EditorOptions = NonNullable<Parameters<typeof createTextEditor>[0]>;
import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { createTextEditor } from '../../../ui/platform/text-editor.mts';
import canonical from '../../../resources/config/protocol.json' with { type: 'json' };
import { validateProtocol } from '../../../ui/shared/network-protocol.mts';
import { reconcile } from '../../../ui/shared/dom.mts';
const id = '10b72b2a-346f-48c0-a243-1cb22871d91d',
  token = 'a'.repeat(64),
  file = { id, name: 'source.ps1', type: 'text/plain' };
const tick = () => new Promise((resolve) => setImmediate(resolve)),
  deferred = <Value = unknown,>() => {
    let resolve: ((value: Value) => void) | undefined;
    const promise = new Promise<Value>((yes) => (resolve = yes));
    return { promise, resolve: defined(resolve) };
  };
function fixture(options: EditorOptions = {}) {
  const { document, Event } = parseHTML(
      '<html><body><input id="other-setting"><main></main></body></html>',
    ),
    calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  let renders = 0,
    focused: HTMLElement | null = null;
  Object.defineProperty(document, 'activeElement', {
    get: () => (focused?.isConnected ? focused : document.body),
  });
  const render = () => {
    renders++;
    const template = document.createElement('template');
    template.innerHTML = ui.renderSettings();
    reconcile(defined(document.querySelector<HTMLElement>('main')), template.content);
    for (const node of document.querySelectorAll<HTMLInputElement>('button,input'))
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
      defined(document.querySelector<HTMLButtonElement>('[data-editor-menu-trigger]')).click();
    },
    key(node: Element | null, key: string) {
      const event = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: key });
      defined(node).dispatchEvent(event);
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
          id: String(defined(args).editorId),
          name: defined(apps.find((app) => app.id === defined(args).editorId)).name,
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
  const trigger = f.document.querySelector<HTMLButtonElement>('[data-editor-menu-trigger]');
  assert.equal(defined(trigger).getAttribute('aria-haspopup'), 'menu');
  f.menu();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-menu]')).getAttribute('role'),
    'menu',
  );
  assert.deepEqual(
    [...f.document.querySelectorAll<HTMLButtonElement>('[data-editor-option]')].map(
      (node) => node.dataset.editorOption,
    ),
    ['notepad', 'vscode', 'cursor'],
  );
  assert.equal(
    defined(
      f.document.querySelector<HTMLButtonElement>('[data-editor-option="notepad"]'),
    ).getAttribute('aria-checked'),
    'true',
  );
  assert.equal(
    defined(
      defined(
        f.document.querySelector<HTMLButtonElement>('[data-editor-option="vscode"]'),
      ).querySelector<HTMLElement>('svg'),
    ).getAttribute('aria-hidden'),
    'true',
  );
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-editor-option="zed"]'), null);
  f.key(f.document.querySelector<HTMLButtonElement>('[data-editor-option="vscode"]'), 'Enter');
  await tick();
  assert.deepEqual(f.calls.at(-1), { command: 'select_text_editor', args: { editorId: 'vscode' } });
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-name]')).textContent,
    'Visual Studio Code',
  );
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-editor-menu]'), null);
  assert.equal(
    defined(f.document.activeElement?.closest<HTMLElement>('*')).dataset.editorMenuTrigger,
    '',
  );
  f.menu();
  assert.equal(
    defined(
      f.document.querySelector<HTMLButtonElement>('[data-editor-option="vscode"]'),
    ).getAttribute('aria-checked'),
    'true',
  );
  defined(f.document.querySelector<HTMLButtonElement>('[data-editor-option="notepad"]')).click();
  await tick();
  assert.deepEqual(f.calls.at(-1), { command: 'reset_text_editor', args: undefined });
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-name]')).textContent,
    'Notepad',
  );
  assert.equal(f.document.querySelector<HTMLInputElement>('main input'), null);
  assert.equal(f.document.querySelector<HTMLImageElement>('img'), null);
  f.ui.dispose();
});
test('the current custom editor stays selected and browsing cancellation is quiet and serialized', async () => {
  const wait = deferred();
  let picks = 0;
  const f = fixture({
    invoke: async (command: string) =>
      command === 'installed_text_editors'
        ? { editors: [] }
        : command === 'choose_text_editor'
          ? (picks++, wait.promise)
          : { editor: 'custom', name: 'My Editor.exe' },
  });
  await f.ui.load();
  f.menu();
  const custom = f.document.querySelector<HTMLButtonElement>('[data-editor-option="custom"]');
  assert.equal(defined(custom).getAttribute('aria-checked'), 'true');
  assert.match(defined(custom).textContent, /My Editor.exe.*Current editor/);
  defined(custom).click();
  await tick();
  assert.equal(picks, 0);
  f.menu();
  const choose = f.document.querySelector<HTMLButtonElement>('[data-editor-choose]');
  defined(choose).click();
  defined(choose).click();
  assert.equal(picks, 1);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-menu-trigger]')).disabled,
    true,
  );
  wait.resolve(null);
  await tick();
  assert.equal(f.document.querySelector<HTMLElement>('.error'), null);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-name]')).textContent,
    'My Editor.exe',
  );
  assert.equal(
    defined(f.document.activeElement?.closest<HTMLElement>('*')).dataset.editorMenuTrigger,
    '',
  );
  f.ui.dispose();
});
test('keyboard navigation follows menu radio semantics, restores focus and closes for Escape and outside clicks', async () => {
  const f = fixture({
    invoke: async (command: string) =>
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
  f.key(f.document.querySelector<HTMLButtonElement>('[data-editor-menu-trigger]'), 'ArrowDown');
  assert.equal(
    defined(f.document.activeElement?.closest<HTMLElement>('*')).dataset.editorOption,
    'notepad',
  );
  f.key(f.document.activeElement, 'ArrowDown');
  assert.equal(
    defined(f.document.activeElement?.closest<HTMLElement>('*')).dataset.editorOption,
    'vscode',
  );
  f.key(f.document.activeElement, 'End');
  assert.ok(defined(f.document.activeElement).hasAttribute('data-editor-choose'));
  f.key(f.document.activeElement, 'ArrowDown');
  assert.equal(
    defined(f.document.activeElement?.closest<HTMLElement>('*')).dataset.editorOption,
    'notepad',
  );
  f.key(f.document.activeElement, 'ArrowUp');
  assert.ok(defined(f.document.activeElement).hasAttribute('data-editor-choose'));
  f.key(f.document.activeElement, 'Home');
  assert.equal(
    defined(f.document.activeElement?.closest<HTMLElement>('*')).dataset.editorOption,
    'notepad',
  );
  assert.equal(
    f.document.querySelectorAll<HTMLButtonElement>('[data-editor-menu] [tabindex="0"]').length,
    1,
  );
  f.key(f.document.activeElement, 'Escape');
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-editor-menu]'), null);
  assert.ok(defined(f.document.activeElement).hasAttribute('data-editor-menu-trigger'));
  f.key(f.document.querySelector<HTMLButtonElement>('[data-editor-menu-trigger]'), 'ArrowUp');
  assert.ok(defined(f.document.activeElement).hasAttribute('data-editor-choose'));
  f.key(f.document.activeElement, 'Tab');
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-editor-menu]'), null);
  f.menu();
  defined(f.document.querySelector<HTMLElement>('#other-setting')).dispatchEvent(
    new f.Event('pointerdown', { bubbles: true }),
  );
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-editor-menu]'), null);
  f.ui.dispose();
});
test('pending reads and writes cannot race, stale menu choices cannot launch and late results do not steal unrelated focus', async () => {
  const read = deferred(),
    write = deferred(),
    commands: string[] = [],
    f = fixture({
      invoke: async (command) => {
        commands.push(command);
        if (command === 'installed_text_editors')
          return { editors: [{ id: 'vscode', name: 'VS Code' }] };
        if (command === 'editor_preferences') return read.promise;
        if (command === 'select_text_editor') return write.promise;
        return { editor: 'notepad', name: 'Notepad' };
      },
    }),
    loading = f.ui.load();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-menu-trigger]')).disabled,
    true,
  );
  f.menu();
  assert.equal(f.document.querySelector<HTMLButtonElement>('[data-editor-menu]'), null);
  read.resolve({ editor: 'notepad', name: 'Notepad' });
  await loading;
  f.menu();
  const stale = f.document.querySelector<HTMLButtonElement>('[data-editor-option="vscode"]');
  defined(stale).click();
  defined(stale).click();
  assert.equal(commands.filter((value) => value === 'select_text_editor').length, 1);
  defined(f.document.querySelector<HTMLElement>('#other-setting')).focus();
  write.resolve({ editor: 'custom', id: 'vscode', name: 'VS Code' });
  await tick();
  assert.equal(defined(f.document.activeElement).id, 'other-setting');
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-name]')).textContent,
    'VS Code',
  );
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
    async (command: string) =>
      command === 'installed_text_editors'
        ? { editors: [{ id: 'C:\\private\\run.exe', name: 'private' }] }
        : { editor: 'notepad', name: 'Notepad' },
  ]) {
    const f = fixture({ invoke: bad });
    await f.ui.load();
    assert.ok(f.document.querySelector<HTMLElement>('.error'));
    assert.doesNotMatch(f.document.body.textContent, /private|secret/);
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-editor-menu-trigger]')).disabled,
      false,
    );
    f.menu();
    assert.ok(f.document.querySelector<HTMLButtonElement>('[data-editor-choose]'));
    assert.ok(f.document.querySelector<HTMLButtonElement>('[data-editor-option="notepad"]'));
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
  defined(f.document.querySelector<HTMLButtonElement>('[data-editor-retry]')).click();
  await tick();
  assert.equal(f.document.querySelector<HTMLElement>('.error'), null);
  f.menu();
  assert.ok(f.document.querySelector<HTMLButtonElement>('[data-editor-option="zed"]'));
  f.ui.dispose();
});
test('a formerly selected detected app is retained as unavailable instead of silently resetting preference', async () => {
  const f = fixture({
    invoke: async (command: string) =>
      command === 'installed_text_editors'
        ? { editors: [] }
        : { editor: 'custom', id: 'cursor', name: 'Cursor' },
  });
  await f.ui.load();
  f.menu();
  const missing = f.document.querySelector<HTMLButtonElement>('[data-editor-option="cursor"]');
  assert.equal(defined(missing).disabled, true);
  assert.equal(defined(missing).getAttribute('aria-checked'), 'true');
  assert.match(defined(missing).textContent, /No longer detected/);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-name]')).textContent,
    'Cursor',
  );
  f.ui.dispose();
});
test('selecting Notepad repairs an unreadable preference, while an inventory-only failure does not reset a confirmed preference', async () => {
  for (const failedRead of ['preference', 'inventory']) {
    const commands: string[] = [],
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
    assert.ok(f.document.querySelector<HTMLElement>('.error'));
    f.menu();
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-option="notepad"]')).click();
    await tick();
    assert.equal(
      commands.filter((command) => command === 'reset_text_editor').length,
      failedRead === 'preference' ? 1 : 0,
    );
    assert.equal(f.document.querySelector<HTMLButtonElement>('[data-editor-menu]'), null);
    assert.equal(
      defined(f.document.querySelector<HTMLButtonElement>('[data-editor-name]')).textContent,
      'Notepad',
    );
    if (failedRead === 'preference')
      assert.equal(f.document.querySelector<HTMLElement>('.error'), null);
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
    await assert.rejects(
      f.ui.open(file),
      (error: unknown) => isRecord(error) && error.code === 'editor_failed',
    );
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
      (error: unknown) =>
        isRecord(error) &&
        typeof error.message === 'string' &&
        !error.message.includes('private') &&
        error.code === 'editor_failed',
    );
    bad.ui.dispose();
  }
});
test('disposal prevents late dynamic imports from invoking native commands or changing settings', async () => {
  const wait = deferred<{ invoke: NativeInvoke }>(),
    calls: string[] = [],
    f = fixture({ invoke: undefined, loadCore: () => wait.promise }),
    opening = f.ui.open(file),
    failed = assert.rejects(
      opening,
      (error: unknown) => isRecord(error) && error.code === 'editor_failed',
    ),
    loading = f.ui.load();
  f.ui.dispose();
  wait.resolve({
    invoke: async (command: string) => {
      calls.push(command);
      return { editor: 'custom', name: 'Code.exe' };
    },
  });
  await failed;
  await loading;
  assert.equal(calls.length, 0);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-name]')).textContent,
    'Notepad',
  );
  await assert.rejects(f.ui.open(file));
});
test('Chinese settings and browser availability are localized and do not contact the VM', async () => {
  const f = fixture({ desktop: false, getLanguage: () => 'zh' });
  await f.ui.load();
  assert.match(f.document.body.textContent, /打开方式/);
  assert.match(f.document.body.textContent, /桌面应用/);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-editor-menu-trigger]')).disabled,
    true,
  );
  assert.equal(f.calls.length, 0);
  f.ui.dispose();
});
test('native editor opens only safe cached text with a fixed Notepad or picked editor, never a shell or file association', () => {
  const source = fs.readFileSync(
      new URL('../../../src-tauri/src/text_editor.rs', import.meta.url),
      'utf8',
    ),
    protocolSource = fs.readFileSync(
      new URL('../../../src-tauri/src/protocol.rs', import.meta.url),
      'utf8',
    ),
    protocol = validateProtocol(canonical);
  assert.match(source, /window\.label\(\) == "main"/);
  assert.match(source, /crate::protocol::api_url\(&format!\(\s*"files\/\{file_id\}"\s*\)\)/);
  assert.equal(protocol.loopbackHost, '127.0.0.1');
  assert.equal(protocol.apiPort, canonical.apiPort);
  assert.match(
    protocolSource,
    /include_str!\(\s*"\.\.\/\.\.\/resources\/config\/protocol\.json"\s*\)/,
  );
  assert.match(protocolSource, /api_port\s*:\s*u16\b/);
  assert.match(protocolSource, /let\s+host\s*:\s*Ipv4Addr\s*=\s*value\.loopback_host\.parse\(\)/);
  assert.match(protocolSource, /host\s*!=\s*Ipv4Addr::LOCALHOST/);
  assert.match(protocolSource, /SocketAddrV4::new\(\s*host\s*,\s*value\.api_port\s*\)/);
  assert.doesNotMatch(
    source,
    /pub\s+async\s+fn\s+open_attachment_in_editor\s*\([^)]*\b(?:url|endpoint|destination|path)\s*:/,
  );
  assert.match(source, /no_proxy\(\)\s*\.redirect\(reqwest::redirect::Policy::none\(\)\)/);
  assert.match(source, /Command::new\(crate::runtime_path\(executable\.to_path_buf\(\)\)\)/);
  assert.match(source, /command\s*\.arg\(target\)/);
  assert.match(source, /editor_command\(&executable, &target\)\s*\.spawn\(\)/);
  assert.match(source, /editor_cache_root\(std::env::temp_dir\(\)\)/);
  assert.doesNotMatch(source, /app_cache_dir\(/);
  assert.doesNotMatch(source, /cmd\s*\/c|powershell|opener\(\)|open_path|shell_execute/i);
  assert.match(source, /join\("System32"\)\s*\.join\("notepad.exe"\)/);
  assert.match(source, /text_payload\(&bytes/);
  assert.match(source, /Sha256::digest/);
  assert.match(source, /create_new\(true\)/);
  assert.match(source, /file_attributes\(\) & 0x400/);
  assert.match(source, /3 \* 24 \* 60 \* 60/);
  assert.match(source, /Preserve a user's edits/);
});
