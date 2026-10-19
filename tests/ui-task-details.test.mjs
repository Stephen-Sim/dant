import { compactCss } from './source-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { createTaskDetails } from '../ui/work/task-details.js';

const target = { workId: 'work-a', turnId: 'turn-a', conversationId: 'conversation-a' },
  other = { workId: 'work-b', turnId: 'turn-b', conversationId: 'conversation-a' };
const file = {
    id: '10b72b2a-346f-48c0-a243-1cb22871d91d',
    name: 'result.json',
    type: 'application/json',
    size: 20,
  },
  secondFile = {
    ...file,
    id: '20b72b2a-346f-48c0-a243-1cb22871d91d',
    name: 'result.png',
    type: 'image/png',
  };
const at = 1790000000000,
  tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const entry = (messageId, text, attachments = []) => ({
  messageId,
  turnId: target.turnId,
  at,
  text,
  attachments,
});
const context = () => ({
  version: 1,
  updatedAt: at,
  referenceDataOnly: true,
  originalRequest: entry('original', 'Keep the original project requirement.'),
  humanUpdates: [entry('update', 'Use the revised input.')],
  results: [entry('result', 'A real recorded result.', [file, secondFile])],
});
function fixture(options = {}) {
  const { document, Event } = parseHTML(
      '<html><body><textarea id="composer">Keep my draft</textarea><audio id="call-audio"></audio><div id="modal"></div></body></html>',
    ),
    calls = [],
    replies = [],
    opened = [],
    downloads = [],
    revealed = [],
    listeners = new Map();
  let modal = null,
    connected = true,
    ui;
  const state = {
    conversationId: 'conversation-a',
    settings: { language: 'en', vm: { host: 'vm-a', user: 'dant', port: 22 } },
    controller: { status: 'online' },
    worker: { status: 'online' },
    capabilities: { workReply: true, taskReopen: true },
    messages: [{ id: 'result', role: 'assistant' }],
    workTasks: [
      {
        id: 'work-a',
        turnId: 'turn-a',
        title: 'Verify <project> & report',
        status: 'waiting_user',
        executionEndedAt: at,
        plan: { steps: [{ step: 'Verify the output', status: 'inProgress' }] },
      },
      {
        id: 'work-b',
        turnId: 'turn-b',
        title: 'Another task',
        status: 'completed',
        executionEndedAt: at,
        plan: { steps: [{ step: 'Finished', status: 'completed' }] },
      },
    ],
  };
  const window = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
  };
  const render = () => {
    if (options.mainLifecycle) modal = ui.syncModal(modal);
    document.querySelector('#modal').innerHTML =
      options.mainLifecycle && modal?.type !== 'task-detail' ? '' : ui.renderModal();
    if (!options.mainLifecycle || modal?.type === 'task-detail') ui.bind();
    document.querySelector('[data-action="close-modal"]')?.addEventListener('click', () => {
      modal = modal?.parent || null;
      render();
    });
  };
  const response = (value = target) => ({
    ...value,
    title: state.workTasks.find((item) => item.id === value.workId)?.title || 'Task',
    status: 'waiting_user',
    plan: { steps: [{ step: 'A recorded step', status: 'pending' }] },
    projectContext: context(),
  });
  ui = createTaskDetails({
    document,
    window,
    getState: () => state,
    getLanguage: () => state.settings.language,
    getModal: () => modal,
    openModal: (value) => {
      modal = value;
      render();
    },
    render,
    connected: () => connected,
    request: async (route, opts) => {
      calls.push({ route, opts });
      return options.request ? options.request(route, opts) : response();
    },
    onReply: (value) => replies.push(value),
    onFile: (value) => opened.push(value),
    onDownload: (value) => downloads.push(value),
    onReveal: (messageId, value) => revealed.push({ messageId, target: value }),
    ...options.ui,
  });
  return {
    ui,
    state,
    document,
    Event,
    window,
    calls,
    replies,
    opened,
    downloads,
    revealed,
    listeners,
    response,
    render,
    get modal() {
      return modal;
    },
    set modal(value) {
      modal = value;
    },
    set connected(value) {
      connected = value;
    },
  };
}

test('task details reads one exact target and renders only inert real records while preserving the composer and call media', async () => {
  const f = fixture(),
    composer = f.document.querySelector('#composer'),
    audio = f.document.querySelector('#call-audio');
  await f.ui.open(target);
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.calls[0].route,
    '/tasks/work-a/context?turnId=turn-a&conversationId=conversation-a',
  );
  assert.equal(f.calls[0].opts.method, 'GET');
  assert.equal(f.calls[0].opts.body, undefined);
  assert.equal(f.calls[0].opts.signal.aborted, false);
  assert.match(f.document.querySelector('h2').textContent, /Verify <project> & report/);
  assert.match(f.document.body.textContent, /Project memory/);
  assert.match(f.document.body.textContent, /reference material and do not authorize new work/);
  assert.match(f.document.body.textContent, /Keep the original project requirement/);
  assert.match(f.document.body.textContent, /Use the revised input/);
  assert.match(f.document.body.textContent, /A real recorded result/);
  assert.equal(f.document.querySelector('#composer'), composer);
  assert.equal(composer.value, 'Keep my draft');
  assert.equal(f.document.querySelector('#call-audio'), audio);
  assert.equal(f.replies.length, 0);
  assert.equal(f.opened.length, 0);
  f.ui.dispose();
});

test('reply selects the exact task in the composer and never submits or reopens work by itself', async () => {
  for (const status of [
    'waiting_user',
    'paused',
    'continuing',
    'review',
    'completed',
    'failed',
    'cancelled',
  ]) {
    const f = fixture();
    f.state.workTasks[0].status = status;
    await f.ui.open(target);
    const button = f.document.querySelector('[data-task-detail-reply]');
    assert.equal(button.disabled, false, status);
    assert.equal(button.textContent, 'Reply to task');
    button.click();
    assert.deepEqual(f.replies, [target]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.document.querySelector('#composer').value, 'Keep my draft');
    assert.equal(f.state.workTasks[0].status, status);
    f.replies[0].turnId = 'client-mutated';
    button.click();
    assert.equal(f.replies[1].turnId, 'turn-a');
    f.ui.dispose();
  }
});

test('active acknowledged work uses the shared progress reply guard and pausing or unknown work cannot reply', async () => {
  const f = fixture();
  f.state.workTasks[0].status = 'running';
  delete f.state.workTasks[0].executionEndedAt;
  f.state.workTasks[0].continuation = { dispatch: { phase: 'acknowledged' } };
  f.state.active = {
    workId: 'work-a',
    turnId: 'turn-a',
    status: 'running',
    source: 'chat',
    canSteer: true,
  };
  await f.ui.open(target);
  assert.equal(f.document.querySelector('[data-task-detail-reply]').disabled, false);
  assert.doesNotMatch(f.document.body.textContent, /task status is unconfirmed/);
  f.document.querySelector('[data-task-detail-reply]').click();
  assert.deepEqual(f.replies, [target]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.document.querySelector('#composer').value, 'Keep my draft');
  for (const status of ['pausing', 'unknown']) {
    f.state.active.status = status;
    f.render();
    assert.equal(f.document.querySelector('[data-task-detail-reply]').disabled, true, status);
  }
  f.ui.dispose();
});

test('safe file controls discard private metadata and only reveal messages still in the current chat', async () => {
  const f = fixture({
    request: async () => ({
      ...target,
      title: 'A project',
      plan: null,
      projectContext: {
        ...context(),
        results: [
          entry('result', '<script>never()</script>', [
            {
              ...file,
              sourcePath: '/private/workspace/result.json',
              url: 'https://private.example',
              token: 'secret',
            },
            secondFile,
            { id: '../outside', name: 'Unsafe' },
            file,
          ]),
        ],
      },
    }),
  });
  await f.ui.open(target);
  assert.equal(f.document.querySelector('script'), null);
  assert.equal(f.document.querySelector('img'), null);
  assert.equal(f.document.querySelector('a'), null);
  assert.match(f.document.body.textContent, /<script>never\(\)<\/script>/);
  assert.doesNotMatch(
    f.document.body.innerHTML,
    /private\.example|sourcePath|secret|private\/workspace/,
  );
  assert.equal(f.document.querySelectorAll('[data-task-detail-file]').length, 2);
  f.document.querySelector('[data-task-detail-file]').click();
  f.document.querySelector('[data-task-detail-download]').click();
  f.document.querySelector('[data-task-detail-reveal]').click();
  await tick();
  assert.deepEqual(f.opened, [file]);
  assert.deepEqual(f.downloads, [file]);
  assert.deepEqual(f.revealed, [{ messageId: 'result', target }]);
  assert.equal(f.document.querySelectorAll('[data-task-detail-reveal]').length, 1);
  assert.deepEqual(f.ui.file(file.id), file);
  assert.equal(f.ui.file('../outside'), null);
  f.ui.dispose();
});

test('context-only file metadata survives its selected preview and returns to the same details safely', async () => {
  let f;
  f = fixture({
    ui: {
      onFile: (value) => {
        assert.deepEqual(f.ui.file(value.id), value);
        f.modal = { type: 'image', fileId: value.id, parent: f.modal };
        f.render();
      },
    },
  });
  await f.ui.open(target);
  const parent = f.modal;
  f.document.querySelector('[data-task-detail-file]').click();
  await tick();
  assert.equal(f.modal.type, 'image');
  assert.deepEqual(f.ui.file(file.id), file);
  assert.equal(f.ui.file(secondFile.id), null);
  f.modal = parent;
  f.render();
  assert.match(f.document.body.textContent, /A real recorded result/);
  assert.deepEqual(f.ui.file(secondFile.id), secondFile);
  assert.equal(f.calls.length, 1, 'returning from a preview does not refetch or replay work');
  f.document.querySelector('[data-task-detail-file]').click();
  await tick();
  f.state.settings.vm.host = 'different-vm';
  f.render();
  assert.equal(f.ui.file(file.id), null);
  f.modal = parent;
  f.render();
  assert.doesNotMatch(f.document.body.textContent, /A real recorded result/);
  assert.match(f.document.body.textContent, /work computer has changed/);
  f.ui.dispose();
});

test('closing or replacing a modal aborts pending details and late responses never publish', async () => {
  for (const change of [
    (f) => {
      f.modal = null;
    },
    (f) => {
      f.modal = { type: 'settings' };
    },
  ]) {
    const wait = deferred(),
      f = fixture({ request: () => wait.promise }),
      pending = f.ui.open(target);
    assert.match(f.document.body.textContent, /Loading task details/);
    change(f);
    f.render();
    assert.equal(await pending, false);
    assert.equal(f.calls[0].opts.signal.aborted, true);
    wait.resolve({ ...target, title: 'Private stale title', projectContext: context() });
    await tick();
    assert.doesNotMatch(f.document.body.textContent, /Private stale|A real recorded result/);
    f.ui.dispose();
  }
});

test('VM, conversation, current turn and dismissed-record changes invalidate context and callbacks on SSE refresh', async () => {
  for (const change of [
    (f) => (f.state.settings.vm.host = 'another-vm'),
    (f) => (f.state.conversationId = 'another-chat'),
    (f) => (f.state.workTasks[0].turnId = 'new-turn'),
    (f) => (f.state.workTasks[0].progressDismissedAt = at),
  ]) {
    const wait = deferred(),
      f = fixture({ request: () => wait.promise }),
      pending = f.ui.open(target);
    change(f);
    f.render();
    assert.equal(await pending, false);
    wait.resolve({ ...target, title: 'Private stale title', projectContext: context() });
    await tick();
    assert.doesNotMatch(f.document.body.textContent, /Private stale|A real recorded result/);
    assert.equal(f.document.querySelector('[data-task-detail-reply]').disabled, true);
    assert.equal(f.ui.file(file.id), null);
    f.ui.dispose();
  }
  const f = fixture();
  await f.ui.open(target);
  const button = f.document.querySelector('[data-task-detail-reply]');
  f.state.workTasks[0].turnId = 'later-turn';
  button.click();
  assert.equal(f.replies.length, 0);
  f.ui.dispose();
});

test('opening another task prevents an older response from overwriting its records', async () => {
  const waits = [deferred(), deferred()];
  let next = 0;
  const f = fixture({ request: () => waits[next++].promise }),
    first = f.ui.open(target),
    second = f.ui.open(other);
  waits[1].resolve({
    ...other,
    title: 'Current second project',
    projectContext: { ...context(), results: [entry('new', 'Current second result')] },
  });
  await second;
  assert.equal(await first, false);
  waits[0].resolve({ ...target, title: 'Private first project', projectContext: context() });
  await tick();
  assert.equal(f.document.querySelector('h2').textContent, 'Current second project');
  assert.match(f.document.body.textContent, /Current second result/);
  assert.doesNotMatch(f.document.body.textContent, /Private first|A real recorded result/);
  f.ui.dispose();
});

test('wrong target responses and private request errors become fixed safe messages with explicit retry', async () => {
  for (const wrong of [
    { ...target, workId: 'other' },
    { ...target, turnId: 'other' },
    { ...target, conversationId: 'other' },
    null,
  ]) {
    const f = fixture({
      request: async () => ({
        ...wrong,
        title: 'Private wrong project',
        projectContext: context(),
      }),
    });
    await f.ui.open(target);
    assert.match(f.document.body.textContent, /could not be loaded/);
    assert.doesNotMatch(f.document.body.textContent, /Private wrong|A real recorded result/);
    assert.ok(f.document.querySelector('[data-task-detail-retry]'));
    f.ui.dispose();
  }
  let count = 0;
  const f = fixture({
    request: async () => {
      if (!count++) throw Error('private token /workspace/credentials');
      return { ...target, title: 'Retry succeeded', projectContext: context() };
    },
  });
  await f.ui.open(target);
  assert.doesNotMatch(f.document.body.textContent, /private token|credentials/);
  f.document.querySelector('[data-task-detail-retry]').click();
  await tick();
  assert.equal(f.document.querySelector('h2').textContent, 'Retry succeeded');
  assert.equal(f.calls.length, 2);
  f.ui.dispose();
});

test('offline snapshots and old services provide honest guidance without requests or active reply actions', async () => {
  for (const change of [
    (f) => (f.connected = false),
    (f) => (f.state.controller.cached = true),
    (f) => (f.state.controller.status = 'offline'),
    (f) => (f.state.worker.status = 'offline'),
  ]) {
    const f = fixture();
    f.state.workTasks[0].projectContext = context();
    change(f);
    await f.ui.open(target);
    assert.equal(f.calls.length, 0);
    assert.match(f.document.body.textContent, /last known records/);
    assert.match(f.document.body.textContent, /A real recorded result/);
    assert.equal(f.document.querySelector('[data-task-detail-reply]').disabled, true);
    assert.equal(f.document.querySelector('[data-task-detail-file]').disabled, true);
    f.ui.dispose();
  }
  for (const capability of [undefined, false, 'true']) {
    const f = fixture();
    f.state.capabilities = capability === undefined ? undefined : { taskReopen: capability };
    await f.ui.open(target);
    assert.equal(f.calls.length, 0);
    assert.match(f.document.body.textContent, /work computer service updates automatically/);
    assert.equal(f.document.querySelector('[data-task-detail-reply]').disabled, true);
    f.ui.dispose();
  }
  const f = fixture();
  f.state.workTasks[0].status = 'unknown';
  await f.ui.open(target);
  assert.equal(f.document.querySelector('[data-task-detail-reply]').disabled, true);
  assert.match(f.document.body.textContent, /task status is unconfirmed/);
  assert.match(f.document.body.textContent, /A real recorded result/);
  f.ui.dispose();
});

test('missing or untrusted project context stays empty and all rendered references remain strictly bounded', async () => {
  for (const value of [
    null,
    {},
    { ...context(), referenceDataOnly: false },
    { ...context(), version: 2 },
    { ...context(), updatedAt: 'now' },
  ]) {
    const f = fixture({
      request: async () => ({ ...target, title: 'Task', projectContext: value }),
    });
    await f.ui.open(target);
    assert.match(f.document.body.textContent, /No saved project records/);
    assert.equal(f.document.querySelectorAll('.task-detail-entry').length, 0);
    f.ui.dispose();
  }
  const updates = Array.from({ length: 20 }, (_, index) =>
      entry('human-' + index, 'x'.repeat(5000)),
    ),
    results = Array.from({ length: 20 }, (_, index) =>
      entry(
        'result-' + index,
        'y'.repeat(5000),
        Array.from({ length: 8 }, (_, n) => ({
          ...file,
          id: `${String(n + 1).padStart(8, '0')}-346f-48c0-a243-1cb22871d91d`,
        })),
      ),
    );
  const f = fixture({
    request: async () => ({
      ...target,
      title: 't'.repeat(5000),
      plan: {
        steps: Array.from({ length: 200 }, () => ({ step: 's'.repeat(1000), status: 'pending' })),
      },
      projectContext: { ...context(), humanUpdates: updates, results },
    }),
  });
  await f.ui.open(target);
  assert.equal(f.document.querySelector('h2').textContent.length, 240);
  assert.equal(f.document.querySelectorAll('.task-detail-entry').length, 17);
  assert.ok(
    [...f.document.querySelectorAll('.task-detail-text')].every(
      (node) => node.textContent.length <= 4000,
    ),
  );
  assert.equal(f.document.querySelectorAll('.task-detail-plan li').length, 128);
  assert.ok(
    [...f.document.querySelectorAll('.task-detail-plan li>span')].every(
      (node) => node.textContent.length <= 240,
    ),
  );
  assert.ok(
    [...f.document.querySelectorAll('.task-detail-files')].every(
      (node) => node.children.length <= 5,
    ),
  );
  f.ui.dispose();
});

test('task buttons support both progress selectors and Chinese labels without navigation or automatic work', async () => {
  for (const attribute of ['data-task-details', 'data-task-detail-open']) {
    const f = fixture();
    f.state.settings.language = 'zh';
    const button = f.document.createElement('button');
    button.setAttribute(attribute, 'work-a');
    button.dataset.progressTurn = 'turn-a';
    button.dataset.progressConversation = 'conversation-a';
    f.document.body.append(button);
    f.ui.bind();
    const event = new f.Event('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    await tick();
    assert.equal(event.defaultPrevented, true);
    assert.match(f.document.body.textContent, /项目记忆/);
    assert.match(f.document.body.textContent, /真实任务记录/);
    assert.equal(f.document.querySelector('[data-task-detail-reply]').textContent, '回复任务');
    assert.equal(
      f.document.querySelector('[data-action="close-modal"]').getAttribute('aria-label'),
      '关闭',
    );
    assert.equal(f.replies.length, 0);
    assert.equal(f.calls.length, 1);
    f.ui.dispose();
  }
  const f = fixture();
  for (const value of [
    null,
    {},
    { ...target, workId: '../private' },
    { ...target, conversationId: 'other' },
    { ...target, turnId: 'wrong' },
  ])
    assert.equal(await f.ui.open(value), false);
  assert.equal(f.calls.length, 0);
  f.ui.dispose();
});

test('file callback failures are generic and unloading clears file leases and pending requests', async () => {
  const f = fixture({
    ui: {
      onDownload: async () => {
        throw Error('Private download URL secret');
      },
    },
  });
  await f.ui.open(target);
  f.document.querySelector('[data-task-detail-download]').click();
  await tick();
  assert.match(f.document.body.textContent, /file could not be opened/);
  assert.doesNotMatch(f.document.body.textContent, /Private download|secret/);
  assert.equal(f.listeners.has('beforeunload'), true);
  f.listeners.get('beforeunload')();
  assert.equal(f.ui.file(file.id), null);
  assert.equal(f.listeners.size, 0);
  f.ui.dispose();
  assert.equal(await f.ui.open(target), false);
  const source = fs.readFileSync(new URL('../ui/work/task-details.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|\b(?:eval|Function)\s*\(/);
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PATCH|DELETE)/);
  assert.match(
    compactCss(fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')),
    /\.task-detail-dialog/,
  );
});

test('main modal lifecycle synchronization clears closed requests and keeps only the exact child preview lease', async () => {
  const wait = deferred(),
    f = fixture({ mainLifecycle: true, request: () => wait.promise }),
    pending = f.ui.open(target);
  f.modal = null;
  f.render();
  assert.equal(await pending, false);
  assert.equal(f.calls[0].opts.signal.aborted, true);
  assert.equal(f.ui.file(file.id), null);
  wait.resolve({ ...target, title: 'Late private context', projectContext: context() });
  await tick();
  assert.doesNotMatch(f.document.body.textContent, /Late private|A real recorded result/);
  f.ui.dispose();
  let g;
  g = fixture({
    mainLifecycle: true,
    ui: {
      onFile: (value) => {
        g.modal = { type: 'file', fileId: value.id, parent: g.modal };
        g.render();
      },
    },
  });
  await g.ui.open(target);
  const parent = g.modal;
  g.document.querySelector('[data-task-detail-file]').click();
  await tick();
  assert.deepEqual(g.ui.file(file.id), file);
  assert.equal(g.ui.file(secondFile.id), null);
  g.modal = parent;
  g.render();
  assert.match(g.document.body.textContent, /A real recorded result/);
  assert.equal(g.calls.length, 1);
  g.modal = null;
  g.render();
  assert.equal(g.ui.file(file.id), null);
  assert.equal(g.ui.file(secondFile.id), null);
  g.ui.dispose();
});
