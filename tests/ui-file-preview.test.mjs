import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { canPreviewFile, formatFileText, createFilePreview } from '../ui/files/file-preview.js';
const id = '10b72b2a-346f-48c0-a243-1cb22871d91d',
  other = '20b72b2a-346f-48c0-a243-1cb22871d91d',
  token = 'a'.repeat(64),
  file = { id, name: 'result.json', type: 'application/json', size: 20 },
  tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture(options = {}) {
  const { document, Event } = parseHTML(
      '<html><body><textarea id="composer">Keep draft</textarea><audio id="call-audio"></audio><div id="modal"></div></body></html>',
    ),
    calls = [],
    timers = new Map(),
    listeners = new Map();
  let modal = null,
    nextTimer = 0,
    renders = 0;
  const state = {
      conversationId: 'same-conversation',
      settings: { language: 'en', vm: { host: 'vm.example', user: 'dant', port: 22 } },
    },
    window = {
      location: { href: 'tauri://localhost/' },
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: (event, fn) => {
        if (listeners.get(event) === fn) listeners.delete(event);
      },
    };
  const render = () => {
    renders++;
    modal = ui.syncModal(modal);
    document.querySelector('#modal').innerHTML = ui.renderModal(modal);
    ui.bind((value) =>
      value === id ? file : { ...file, id: other, name: 'next.txt', type: 'text/plain' },
    );
    document.querySelector('[data-action="close-modal"]')?.addEventListener('click', () => {
      modal = null;
      render();
    });
  };
  const ui = createFilePreview({
    getState: () => state,
    getModal: () => modal,
    openModal: (value) => {
      modal = value;
      render();
    },
    render,
    getToken: () => token,
    document,
    window,
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return new Response('{"ok":true}', {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
    schedule: (fn, ms) => {
      timers.set(++nextTimer, { fn, ms });
      return nextTimer;
    },
    cancel: (handle) => timers.delete(handle),
    ...options,
  });
  return {
    ui,
    document,
    Event,
    state,
    window,
    calls,
    timers,
    listeners,
    render,
    get modal() {
      return modal;
    },
    set modal(value) {
      modal = value;
    },
    get renders() {
      return renders;
    },
  };
}
test('general text and code types are previewable while media and unknown binary files retain their own controls', () => {
  for (const value of [
    { name: 'result.json' },
    ...[
      'txt',
      'md',
      'py',
      'js',
      'ts',
      'tsx',
      'ps1',
      'cmd',
      'html',
      'css',
      'toml',
      'ini',
      'yaml',
      'csv',
      'sql',
      'rs',
      'cpp',
    ].map((extension) => ({ name: 'file.' + extension })),
    { type: 'text/x-custom' },
    { type: 'application/problem+json' },
  ])
    assert.equal(canPreviewFile(value), true, JSON.stringify(value));
  for (const value of [
    { name: 'file.zip', type: 'application/zip' },
    { name: 'app.exe', type: 'text/plain' },
    { name: 'tricky.json', type: 'image/png' },
    { type: 'audio/webm' },
    { type: 'video/mp4' },
    {},
  ])
    assert.equal(canPreviewFile(value), false);
});
test('JSON formatting preserves exact large numbers, duplicate keys, escapes and string values without execution', () => {
  const source =
      '{"n":9007199254740993,"huge":1e999,"duplicate":1,"duplicate":2,"s":"</pre><script>alert(1)</script> \\" \\\\ \\n","empty":[],"nested":{"中文":true}}',
    result = formatFileText(source, { json: true });
  assert.equal(result.format, 'json');
  assert.match(result.text, /9007199254740993/);
  assert.match(result.text, /1e999/);
  assert.equal((result.text.match(/"duplicate"/g) || []).length, 2);
  assert.match(result.text, /\n  "n":/);
  assert.deepEqual(JSON.parse(result.text), JSON.parse(source));
  for (const text of ['not JSON', '{"a":}'])
    assert.deepEqual(formatFileText(text, { json: true }), { text, format: 'invalid' });
  assert.deepEqual(formatFileText('unchanged\r\ntext'), {
    text: 'unchanged\r\ntext',
    format: 'text',
  });
  for (const text of [
    '['.repeat(65) + '0' + ']'.repeat(65),
    '[' + Array.from({ length: 21000 }, () => 0).join(',') + ']',
  ])
    assert.deepEqual(formatFileText(text, { json: true }), { text, format: 'raw' });
  const prettyLarge =
    '['.repeat(60) + '[' + Array.from({ length: 18000 }, () => 0).join(',') + ']' + ']'.repeat(60);
  assert.deepEqual(formatFileText(prettyLarge, { json: true }), {
    text: prettyLarge,
    format: 'raw',
  });
});
test('a JSON View opens an inert closable modal with authenticated bytes and a separate Download, retaining draft and call media', async () => {
  const malicious =
      '{"text":"</pre><img src=x onerror=alert(1)><script>secret()</script>","n":9007199254740993}',
    f = fixture({
      fetchImpl: async (url, opts) => {
        f.calls.push({ url, opts });
        return new Response(malicious, { headers: { 'content-type': 'application/json' } });
      },
    }),
    composer = f.document.querySelector('#composer'),
    audio = f.document.querySelector('#call-audio');
  const opening = f.ui.open({ ...file, name: '<img src=x>.json' });
  assert.match(f.document.querySelector('.file-preview-status').textContent, /Loading/);
  await opening;
  assert.equal(f.calls[0].url, '/api/files/' + id);
  assert.equal(f.calls[0].opts.headers['X-Dant-Token'], token);
  assert.equal(f.calls[0].opts.redirect, 'error');
  assert.equal(f.calls[0].opts.credentials, 'omit');
  assert.match(f.document.querySelector('pre').textContent, /9007199254740993/);
  assert.equal(f.document.querySelectorAll('script,img,iframe').length, 0);
  assert.equal(f.document.querySelector('[data-download]').getAttribute('href'), null);
  assert.equal(f.document.querySelector('[data-download]').dataset.download, id);
  assert.equal(f.document.querySelector('#composer'), composer);
  assert.equal(composer.value, 'Keep draft');
  assert.equal(f.document.querySelector('#call-audio'), audio);
  assert.equal(f.window.location.href, 'tauri://localhost/');
  f.document.querySelector('[data-action="close-modal"]').click();
  assert.equal(f.modal, null);
  assert.equal(f.document.querySelector('pre'), null);
  assert.equal(f.document.querySelector('#call-audio'), audio);
  f.ui.dispose();
});
test('text/HTML remains exact plain text, malformed JSON is labeled, and UTF-8 and response media types are strict', async () => {
  for (const [name, type, data, expected] of [
    ['page.html', 'text/html', '<script>never()</script>', '<script>never()</script>'],
    ['bad.json', 'application/json', '{"bad":}', '{"bad":}'],
    ['note.txt', 'text/plain; charset=utf-8', '中文\nEnglish', '中文\nEnglish'],
  ]) {
    const f = fixture({
      fetchImpl: async () => new Response(data, { headers: { 'content-type': type } }),
    });
    await f.ui.open({ ...file, name, type });
    assert.equal(f.document.querySelector('pre').textContent, expected);
    assert.equal(f.document.querySelector('script'), null);
    if (name === 'bad.json')
      assert.match(f.document.querySelector('.file-preview-caption').textContent, /not valid JSON/);
    f.ui.dispose();
  }
  for (const [type, data] of [
    ['image/png', '{}'],
    ['text/plain; charset=iso-8859-1', '{}'],
    ['application/json', new Uint8Array([255])],
    ['text/plain', '\0binary'],
  ]) {
    const f = fixture({
      fetchImpl: async () => new Response(data, { headers: { 'content-type': type } }),
    });
    await f.ui.open(file);
    assert.match(f.document.querySelector('.file-preview-status').textContent, /UTF-8 text/);
    assert.equal(f.document.querySelector('pre'), null);
    assert.ok(f.document.querySelector('[data-download]'));
    f.ui.dispose();
  }
});
test('metadata, response headers and streamed bytes enforce the preview cap with an explicit complete-download message', async () => {
  const size = 1024 * 1024;
  for (const options of [
    { file: { ...file, size: size + 1 } },
    {
      fetchImpl: async () =>
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': String(size + 1) },
        }),
    },
    {
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(size));
              controller.enqueue(Uint8Array.of(1));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/plain' } },
        ),
    },
  ]) {
    const f = fixture(options);
    await f.ui.open(options.file || file);
    assert.match(f.document.querySelector('.file-preview-status').textContent, /1 MiB/);
    assert.equal(f.document.querySelector('pre'), null);
    if (options.file) assert.equal(f.calls.length, 0);
    f.ui.dispose();
  }
});
test('failure and timeout are fixed safe messages, explicit retry can succeed, and stalled reads can be cancelled', async () => {
  let attempt = 0;
  const f = fixture({
    fetchImpl: async () => {
      if (!attempt++) throw Error('private URL and raw content');
      return new Response('retry worked', { headers: { 'content-type': 'text/plain' } });
    },
  });
  await f.ui.open(file);
  assert.doesNotMatch(f.document.body.textContent, /private|raw content/);
  assert.match(f.document.querySelector('.file-preview-status').textContent, /could not be opened/);
  f.document.querySelector('[data-file-preview-retry]').click();
  await tick();
  assert.equal(f.document.querySelector('pre').textContent, 'retry worked');
  f.ui.dispose();
  const g = fixture({ fetchImpl: () => new Promise(() => {}) }),
    pending = g.ui.open(file);
  for (const timer of [...g.timers.values()]) timer.fn();
  await pending;
  assert.match(g.document.querySelector('.file-preview-status').textContent, /could not be opened/);
  g.ui.dispose();
  const h = fixture({
      fetchImpl: async () => ({
        ok: true,
        redirected: false,
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
      }),
    }),
    reading = h.ui.open(file);
  await tick();
  h.modal = null;
  h.render();
  await reading;
  assert.equal(h.document.querySelector('pre'), null);
  h.ui.dispose();
});
test('closing, switching VM/conversation, reopening and unloading cannot publish a stale file body', async () => {
  for (const change of [
    (f) => {
      f.modal = null;
    },
    (f) => (f.state.conversationId = 'different'),
    (f) => (f.state.settings.vm.host = 'different'),
  ]) {
    const wait = deferred(),
      f = fixture({ fetchImpl: () => wait.promise }),
      pending = f.ui.open(file);
    change(f);
    f.render();
    await pending;
    wait.resolve(
      new Response('private stale content', { headers: { 'content-type': 'text/plain' } }),
    );
    await tick();
    assert.equal(f.modal, null);
    assert.doesNotMatch(f.document.body.textContent, /private stale/);
    f.ui.dispose();
  }
  const waits = [deferred(), deferred()];
  let next = 0;
  const f = fixture({ fetchImpl: () => waits[next++].promise }),
    first = f.ui.open(file),
    second = f.ui.open({ ...file, id: other, name: 'next.txt' });
  waits[1].resolve(new Response('new content', { headers: { 'content-type': 'text/plain' } }));
  await second;
  waits[0].resolve(new Response('old content', { headers: { 'content-type': 'text/plain' } }));
  await first;
  assert.equal(f.document.querySelector('pre').textContent, 'new content');
  assert.equal(f.document.querySelector('h2').textContent, 'next.txt');
  f.ui.dispose();
  f.ui.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(await f.ui.open(file), false);
});
test('malformed ids, unsupported files and invalid auth/base never issue arbitrary requests', async () => {
  const f = fixture();
  for (const value of [
    null,
    { ...file, id: '../private' },
    { ...file, name: 'binary.zip', type: 'application/zip' },
  ])
    assert.equal(await f.ui.open(value), false);
  assert.equal(f.calls.length, 0);
  f.ui.dispose();
  for (const options of [{ getToken: () => '' }, { base: 'https://private.example' }]) {
    const g = fixture(options);
    await g.ui.open(file);
    assert.equal(g.calls.length, 0);
    assert.match(
      g.document.querySelector('.file-preview-status').textContent,
      /could not be opened/,
    );
    g.ui.dispose();
  }
});
test('bubbling View clicks prevent navigation and Chinese labels stay localized', async () => {
  const f = fixture();
  f.state.settings.language = 'zh';
  const button = f.document.createElement('button');
  button.dataset.filePreview = id;
  f.document.body.append(button);
  f.ui.bind(() => file);
  const event = new f.Event('click', { bubbles: true, cancelable: true });
  button.dispatchEvent(event);
  await tick();
  assert.equal(event.defaultPrevented, true);
  assert.ok(f.document.querySelector('pre'));
  assert.equal(f.document.querySelector('[data-download]').textContent, '下载');
  assert.equal(
    f.document.querySelector('[data-action="close-modal"]').getAttribute('aria-label'),
    '关闭',
  );
  f.ui.dispose();
});

test('HTML and SVG delivered as octet-stream are escaped complete source and never load references', async () => {
  for (const name of ['page.html', 'image.svg']) {
    const source = name.endsWith('.svg')
        ? '<svg><image href="https://private.invalid/image.png"/><script>never()</script></svg>'
        : '<iframe src="https://private.invalid/"></iframe><script>never()</script>',
      f = fixture({
        fetchImpl: async () =>
          new Response(source, { headers: { 'content-type': 'application/octet-stream' } }),
      });
    await f.ui.open({ ...file, name, type: 'application/octet-stream' });
    assert.equal(f.document.querySelector('pre').textContent, source);
    assert.equal(f.document.querySelectorAll('iframe,img,svg,script,image').length, 0);
    f.ui.dispose();
  }
});

test('known textual application MIME types share the same strict inert UTF-8 preview', async () => {
  for (const [name, type, source] of [
    ['source.xml', 'application/xml', '<xml/>'],
    ['source.js', 'application/javascript', 'globalThis.example = true;'],
    ['source.yaml', 'application/yaml', 'name: fixture'],
  ]) {
    const f = fixture({
      fetchImpl: async () => new Response(source, { headers: { 'content-type': type } }),
    });
    await f.ui.open({ ...file, name, type });
    assert.equal(f.document.querySelector('pre').textContent, source);
    assert.equal(f.document.querySelector('script'), null);
    f.ui.dispose();
  }
});

test('Open in editor uses the current file once and leaves preview and close intact through failures or stale completions', async () => {
  const wait = deferred(),
    opened = [],
    f = fixture({
      desktop: true,
      openExternal: async (value) => {
        opened.push(value);
        return wait.promise;
      },
    });
  await f.ui.open(file);
  const button = f.document.querySelector('[data-file-preview-editor]');
  button.click();
  f.document.querySelector('[data-file-preview-editor]').click();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].id, id);
  assert.equal(f.document.querySelector('[data-file-preview-editor]').disabled, true);
  f.document.querySelector('[data-action="close-modal"]').click();
  wait.resolve({ opened: true });
  await tick();
  assert.equal(f.modal, null);
  assert.equal(f.document.querySelector('.file-preview-dialog'), null);
  f.ui.dispose();
  const bad = fixture({
    desktop: true,
    openExternal: async () => {
      throw Error('private process path');
    },
  });
  await bad.ui.open(file);
  bad.document.querySelector('[data-file-preview-editor]').click();
  await tick();
  assert.ok(bad.document.querySelector('pre'));
  assert.match(bad.document.querySelector('.error').textContent, /Settings/);
  assert.doesNotMatch(bad.document.body.textContent, /private process/);
  assert.ok(bad.document.querySelector('[data-action="close-modal"]'));
  bad.ui.dispose();
});
