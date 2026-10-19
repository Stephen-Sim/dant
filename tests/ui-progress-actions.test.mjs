import { sourceIndex } from './source-fixtures.mjs';
import { languageContext } from './language-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createProgressActions } from '../ui/work/progress-actions.js';
import {
  workProgress,
  renderWorkReply,
  renderActiveWork,
  renderWorkTaskHistory,
  renderVoiceWorkHistory,
  renderWorkPriority,
} from '../ui/work/work-progress.js';

function setup({ kind = 'work', completed = false, language = 'en', request, isPending } = {}) {
  const { document } = parseHTML('<main id="body"></main>'),
    calls = [],
    toasts = [];
  const item = {
    id: 'task/id',
    title: 'Keep <script>private</script> & results',
    status: completed ? 'completed' : 'continuing',
    knownStatus: completed ? 'completed' : 'continuing',
    progressCompleted: completed,
    ...(kind === 'work'
      ? { registered: true }
      : kind === 'completion'
        ? { voice: true }
        : { message: { id: 'task/id' } }),
  };
  const model = {
    reliable: true,
    items: [item],
    ongoing: completed ? [] : [item],
    recent: [],
    completed: completed ? [item] : [],
    completedCount: completed ? 1 : 0,
  };
  let actions;
  const render = () => {
    document.querySelector('#body').innerHTML =
      `<button data-task-dismiss="task/id" data-progress-kind="${kind}" data-progress-status="completed">×</button><select data-task-priority="task/id" data-progress-kind="${kind}"><option value="normal" selected>Normal</option><option value="high">High</option></select><button data-progress-clear-completed>Clear all</button>${actions.renderConfirmation()}`;
    actions.bind();
  };
  actions = createProgressActions({
    getModel: () => model,
    request: async (...args) => {
      calls.push(args);
      return request?.(...args);
    },
    render,
    toast: (text) => toasts.push(text),
    getLanguage: () => language,
    document,
    isPending,
  });
  render();
  return { actions, document, item, model, calls, toasts, render };
}

test('unfinished removal requires an explicit second click, keeps escaped context, and supports cancellation', async () => {
  for (const language of ['en', 'zh'])
    for (const kind of ['work', 'task', 'completion']) {
      const app = setup({ language, kind }),
        { document, actions, calls } = app;
      await document.querySelector('[data-task-dismiss]').onclick();
      assert.equal(calls.length, 0);
      assert.equal(document.querySelector('script'), null);
      assert.match(
        document.querySelector('blockquote').textContent,
        /<script>private<\/script> & results/,
      );
      assert.match(
        document.querySelector('[role="alertdialog"]').textContent,
        language === 'en' ? /not completed/ : /尚未完成/,
      );
      document.querySelector('[data-progress-dismiss-cancel]').onclick();
      assert.equal(actions.renderConfirmation(), '');
      assert.equal(calls.length, 0);
      await document.querySelector('[data-task-dismiss]').onclick();
      await document.querySelector('[data-progress-dismiss-confirm]').onclick();
      assert.deepEqual(calls, [
        ['task/id', '/tasks/task%2Fid/dismiss', { kind, confirmUnfinished: true }],
      ]);
      assert.equal(actions.renderConfirmation(), '');
    }
});

test('known completed removal needs one click while stale completed status still requires confirmation', async () => {
  const done = setup({ completed: true });
  await done.document.querySelector('[data-task-dismiss]').onclick();
  assert.deepEqual(done.calls, [['task/id', '/tasks/task%2Fid/dismiss', { kind: 'work' }]]);
  assert.equal(done.actions.renderConfirmation(), '');
  const unknown = setup({ completed: true });
  unknown.item.progressCompleted = false;
  await unknown.document.querySelector('[data-task-dismiss]').onclick();
  assert.equal(unknown.calls.length, 0);
  assert.ok(unknown.document.querySelector('[data-progress-dismiss-confirm]'));
});

test('a completed-to-unfinished server race prompts again without automatically retrying', async () => {
  let first = true;
  const app = setup({
    completed: true,
    request: () => {
      if (first) {
        first = false;
        throw Object.assign(Error('Changed'), { code: 'confirmation_required' });
      }
    },
  });
  await app.document.querySelector('[data-task-dismiss]').onclick();
  assert.equal(app.calls.length, 1);
  assert.ok(app.document.querySelector('[data-progress-dismiss-confirm]'));
  await app.document.querySelector('[data-progress-dismiss-confirm]').onclick();
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1][2].confirmUnfinished, true);
});

test('confirmation cannot remove a task that became active or disappeared', async () => {
  const app = setup();
  await app.document.querySelector('[data-task-dismiss]').onclick();
  app.model.items = [];
  app.model.ongoing = [];
  await app.document.querySelector('[data-progress-dismiss-confirm]').onclick();
  assert.equal(app.calls.length, 0);
  assert.equal(app.actions.renderConfirmation(), '');
  assert.match(app.toasts[0], /changed/);
});

test('pending mutations block duplicate confirmation, cancellation and competing bulk actions', async () => {
  let release;
  const waiting = new Promise((resolve) => (release = resolve)),
    app = setup({ request: () => waiting });
  app.model.completedCount = 4;
  await app.document.querySelector('[data-task-dismiss]').onclick();
  const confirm = app.document.querySelector('[data-progress-dismiss-confirm]'),
    pending = confirm.onclick();
  assert.equal(app.actions.busy, true);
  await confirm.onclick();
  app.document.querySelector('[data-progress-dismiss-cancel]').onclick();
  await app.document.querySelector('[data-progress-clear-completed]').onclick();
  assert.equal(app.calls.length, 1);
  assert.ok(app.actions.renderConfirmation());
  release();
  await pending;
  assert.equal(app.actions.busy, false);
  assert.equal(app.actions.renderConfirmation(), '');
});

test('Clear all uses the completed-only endpoint, does not accept work, and is unavailable when empty or offline', async () => {
  const app = setup();
  await app.document.querySelector('[data-progress-clear-completed]').onclick();
  assert.equal(app.calls.length, 0);
  app.model.completedCount = 30;
  await app.document.querySelector('[data-progress-clear-completed]').onclick();
  assert.deepEqual(app.calls, [['clear-completed', '/tasks/clear-completed', {}]]);
  assert.match(app.toasts.at(-1), /Completed tasks cleared/);
  app.model.reliable = false;
  await app.document.querySelector('[data-progress-clear-completed]').onclick();
  await app.document.querySelector('[data-task-dismiss]').onclick();
  assert.equal(app.calls.length, 1);
  assert.match(app.toasts.at(-1), /Reconnect/);
});

test('priority changes encode the exact record and kind and recover their UI after failure', async () => {
  const app = setup({
      request: () => {
        throw Error('Update failed');
      },
    }),
    select = app.document.querySelector('select');
  Object.defineProperty(select, 'value', { value: 'high' });
  await select.onchange();
  assert.deepEqual(app.calls, [
    ['task/id', '/tasks/task%2Fid/priority', { kind: 'work', priority: 'high' }],
  ]);
  assert.equal(app.actions.busy, false);
  assert.equal(app.document.querySelector('select').value, 'normal');
  assert.deepEqual(app.toasts, ['Update failed']);
  const invalid = app.document.querySelector('select');
  Object.defineProperty(invalid, 'value', { value: 'urgent' });
  await invalid.onchange();
  assert.equal(app.calls.length, 1);
  const bad = app.document.querySelector('[data-task-dismiss]');
  bad.dataset.progressKind = 'constructor';
  await bad.onclick();
  assert.equal(app.calls.length, 1);
});

test('bulk-clear failures and protected completed work do not report that everything was cleared', async () => {
  const kept = setup({ completed: true, request: () => ({ ok: true, cleared: 0 }) });
  await kept.document.querySelector('[data-progress-clear-completed]').onclick();
  assert.match(kept.toasts[0], /kept/);
  assert.equal(kept.actions.busy, false);
  const failed = setup({
    completed: true,
    request: () => {
      throw Error('Storage failed');
    },
  });
  await failed.document.querySelector('[data-progress-clear-completed]').onclick();
  assert.deepEqual(failed.toasts, ['Storage failed']);
  assert.equal(failed.actions.busy, false);
});

test('failed confirmation preserves its prompt and closing the panel resets it', async () => {
  const app = setup({
    request: () => {
      throw Error('Task became active');
    },
  });
  await app.document.querySelector('[data-task-dismiss]').onclick();
  await app.document.querySelector('[data-progress-dismiss-confirm]').onclick();
  assert.ok(app.actions.renderConfirmation());
  assert.deepEqual(app.toasts, ['Task became active']);
  app.actions.onClose();
  assert.equal(app.actions.renderConfirmation(), '');
});

test('late responses cannot restore confirmation after the panel closed and external task locks prevent requests', async () => {
  let reject;
  const waiting = new Promise((resolve, rejectPromise) => (reject = rejectPromise)),
    app = setup({ completed: true, request: () => waiting });
  const pending = app.document.querySelector('[data-task-dismiss]').onclick();
  app.actions.onClose();
  reject(Object.assign(Error('Changed'), { code: 'confirmation_required' }));
  await pending;
  assert.equal(app.actions.renderConfirmation(), '');
  const locked = setup({ isPending: () => true });
  await locked.document.querySelector('[data-task-dismiss]').onclick();
  assert.equal(locked.calls.length, 0);
  assert.equal(locked.actions.renderConfirmation(), '');
});

test('progress separates completed work, keeps all-clear available beyond the visible limit and retains unfinished priority order', () => {
  const state = {
    messages: [
      ...Array.from({ length: 20 }, (_, index) => ({
        id: 'done-' + index,
        role: 'user',
        status: 'completed',
        time: 1000 + index,
        text: 'Completed ' + index,
      })),
      {
        id: 'low',
        role: 'user',
        status: 'paused',
        text: 'Low unfinished',
        progressPriority: 'low',
        time: 3000,
      },
      {
        id: 'high',
        role: 'user',
        status: 'review',
        text: 'High unfinished',
        progressPriority: 'high',
        time: 2000,
      },
    ],
    workTasks: [],
    completions: [],
    queue: [],
    worker: { status: 'online' },
  };
  const source = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8'),
    start = sourceIndex(source, 'function renderProgress(){'),
    end = sourceIndex(source, 'function renderModal(){', start);
  const context = {
    state,
    workProgress,
    renderWorkReply,
    renderActiveWork,
    renderWorkTaskHistory,
    renderVoiceWorkHistory,
    renderWorkPriority,
    progressActions: { busy: false, renderConfirmation: () => '' },
    workDisclosures: { isOpen: () => false },
    language: () => 'en',
    eventConnected: true,
    pendingActions: new Set(),
    steerExpectedTurn: null,
    steerDraft: '',
    t: (key) => key,
    esc: (value) => String(value ?? ''),
    ico: () => '',
    formatTime: () => '',
    unknownTask: () => false,
    humanControl: () => false,
  };
  vm.createContext(Object.assign(context, languageContext));
  vm.runInContext(source.slice(start, end), context);
  const { document } = parseHTML(context.renderProgress());
  assert.ok(document.querySelector('[data-progress-clear-completed]'));
  assert.match(document.querySelector('.progress-section-heading').textContent, /20/);
  const titles = [...document.querySelectorAll('.progress-item>div>p')].map(
    (node) => node.textContent,
  );
  assert.deepEqual(titles.slice(0, 2), ['High unfinished', 'Low unfinished']);
  assert.equal(titles.filter((title) => title.startsWith('Completed ')).length, 12);
  assert.equal(state.messages.filter((message) => message.status === 'completed').length, 20);
});
