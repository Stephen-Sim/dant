import { isRecord } from '../../../src/contracts/json.mts';
type ActionOptions = Parameters<typeof createProgressActions>[0];
type RequestArgs = Parameters<ActionOptions['request']>;
type RecordedCall = [string, string, Record<string, unknown>];
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined, invokeHandler } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceIndex } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createProgressActions } from '../../../ui/work/progress-actions.mts';
import {
  workProgress,
  renderWorkReply,
  renderActiveWork,
  renderWorkTaskHistory,
  renderVoiceWorkHistory,
  renderWorkPriority,
} from '../../../ui/work/work-progress.mts';

function setup({
  kind = 'work',
  completed = false,
  language = 'en',
  request,
  isPending,
}: {
  kind?: string;
  completed?: boolean;
  language?: string;
  request?: (...args: RequestArgs) => unknown;
  isPending?: (id: string) => boolean;
} = {}) {
  const { document } = parseHTML('<main id="body"></main>'),
    calls: RecordedCall[] = [],
    toasts: string[] = [];
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
  let actions: ReturnType<typeof createProgressActions>;
  const render = () => {
    defined(document.querySelector<HTMLElement>('#body')).innerHTML =
      `<button data-task-dismiss="task/id" data-progress-kind="${kind}" data-progress-status="completed">×</button><select data-task-priority="task/id" data-progress-kind="${kind}"><option value="normal" selected>Normal</option><option value="high">High</option></select><button data-progress-clear-completed>Clear all</button>${actions.renderConfirmation()}`;
    actions.bind();
  };
  actions = createProgressActions({
    getModel: () => model,
    request: async (...args: RequestArgs) => {
      assert.ok(isRecord(args[2]));
      calls.push([args[0], args[1], args[2]]);
      return request?.(...args);
    },
    render,
    toast: (text: string) => toasts.push(text),
    getLanguage: () => language,
    document,
    ...(isPending ? { isPending } : {}),
  });
  render();
  return { actions, document, item, model, calls, toasts, render };
}

test('unfinished removal requires an explicit second click, keeps escaped context, and supports cancellation', async () => {
  for (const language of ['en', 'zh'])
    for (const kind of ['work', 'task', 'completion']) {
      const app = setup({ language, kind }),
        { document, actions, calls } = app;
      await invokeHandler(
        defined(document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
        'click',
      );
      assert.equal(calls.length, 0);
      assert.equal(document.querySelector<HTMLElement>('script'), null);
      assert.match(
        defined(document.querySelector<HTMLElement>('blockquote')).textContent,
        /<script>private<\/script> & results/,
      );
      assert.match(
        defined(document.querySelector<HTMLElement>('[role="alertdialog"]')).textContent,
        language === 'en' ? /not completed/ : /尚未完成/,
      );
      invokeHandler(
        defined(document.querySelector<HTMLButtonElement>('[data-progress-dismiss-cancel]')),
        'click',
      );
      assert.equal(actions.renderConfirmation(), '');
      assert.equal(calls.length, 0);
      await invokeHandler(
        defined(document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
        'click',
      );
      await invokeHandler(
        defined(document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]')),
        'click',
      );
      assert.deepEqual(calls, [
        ['task/id', '/tasks/task%2Fid/dismiss', { kind, confirmUnfinished: true }],
      ]);
      assert.equal(actions.renderConfirmation(), '');
    }
});

test('known completed removal needs one click while stale completed status still requires confirmation', async () => {
  const done = setup({ completed: true });
  await invokeHandler(
    defined(done.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
  assert.deepEqual(done.calls, [['task/id', '/tasks/task%2Fid/dismiss', { kind: 'work' }]]);
  assert.equal(done.actions.renderConfirmation(), '');
  const unknown = setup({ completed: true });
  unknown.item.progressCompleted = false;
  await invokeHandler(
    defined(unknown.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
  assert.equal(unknown.calls.length, 0);
  assert.ok(unknown.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]'));
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
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
  assert.equal(app.calls.length, 1);
  assert.ok(app.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]'));
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]')),
    'click',
  );
  assert.equal(app.calls.length, 2);
  assert.equal(defined(app.calls[1])[2].confirmUnfinished, true);
});

test('confirmation cannot remove a task that became active or disappeared', async () => {
  const app = setup();
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
  app.model.items = [];
  app.model.ongoing = [];
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]')),
    'click',
  );
  assert.equal(app.calls.length, 0);
  assert.equal(app.actions.renderConfirmation(), '');
  assert.match(defined(app.toasts[0]), /changed/);
});

test('pending mutations block duplicate confirmation, cancellation and competing bulk actions', async () => {
  let release: ((value?: unknown) => void) | undefined;
  const waiting = new Promise<unknown>((resolve) => (release = resolve)),
    app = setup({ request: () => waiting });
  app.model.completedCount = 4;
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
  const confirm = app.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]'),
    pending = invokeHandler(defined(confirm), 'click');
  assert.equal(app.actions.busy, true);
  await invokeHandler(defined(confirm), 'click');
  invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-cancel]')),
    'click',
  );
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-clear-completed]')),
    'click',
  );
  assert.equal(app.calls.length, 1);
  assert.ok(app.actions.renderConfirmation());
  defined(release)();
  await pending;
  assert.equal(app.actions.busy, false);
  assert.equal(app.actions.renderConfirmation(), '');
});

test('Clear all uses the completed-only endpoint, does not accept work, and is unavailable when empty or offline', async () => {
  const app = setup();
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-clear-completed]')),
    'click',
  );
  assert.equal(app.calls.length, 0);
  app.model.completedCount = 30;
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-clear-completed]')),
    'click',
  );
  assert.deepEqual(app.calls, [['clear-completed', '/tasks/clear-completed', {}]]);
  assert.match(defined(app.toasts.at(-1)), /Completed tasks cleared/);
  app.model.reliable = false;
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-clear-completed]')),
    'click',
  );
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
  assert.equal(app.calls.length, 1);
  assert.match(defined(app.toasts.at(-1)), /Reconnect/);
});

test('priority changes encode the exact record and kind and recover their UI after failure', async () => {
  const app = setup({
      request: () => {
        throw Error('Update failed');
      },
    }),
    select = app.document.querySelector<HTMLSelectElement>('select');
  Object.defineProperty(select, 'value', { value: 'high' });
  await invokeHandler(defined(select), 'change');
  assert.deepEqual(app.calls, [
    ['task/id', '/tasks/task%2Fid/priority', { kind: 'work', priority: 'high' }],
  ]);
  assert.equal(app.actions.busy, false);
  assert.equal(defined(app.document.querySelector<HTMLSelectElement>('select')).value, 'normal');
  assert.deepEqual(app.toasts, ['Update failed']);
  const invalid = app.document.querySelector<HTMLSelectElement>('select');
  Object.defineProperty(invalid, 'value', { value: 'urgent' });
  await invokeHandler(defined(invalid), 'change');
  assert.equal(app.calls.length, 1);
  const bad = app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]');
  defined(bad).dataset.progressKind = 'constructor';
  await invokeHandler(defined(bad), 'click');
  assert.equal(app.calls.length, 1);
});

test('bulk-clear failures and protected completed work do not report that everything was cleared', async () => {
  const kept = setup({ completed: true, request: () => ({ ok: true, cleared: 0 }) });
  await invokeHandler(
    defined(kept.document.querySelector<HTMLButtonElement>('[data-progress-clear-completed]')),
    'click',
  );
  assert.match(defined(kept.toasts[0]), /kept/);
  assert.equal(kept.actions.busy, false);
  const failed = setup({
    completed: true,
    request: () => {
      throw Error('Storage failed');
    },
  });
  await invokeHandler(
    defined(failed.document.querySelector<HTMLButtonElement>('[data-progress-clear-completed]')),
    'click',
  );
  assert.deepEqual(failed.toasts, ['Storage failed']);
  assert.equal(failed.actions.busy, false);
});

test('failed confirmation preserves its prompt and closing the panel resets it', async () => {
  const app = setup({
    request: () => {
      throw Error('Task became active');
    },
  });
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]')),
    'click',
  );
  assert.ok(app.actions.renderConfirmation());
  assert.deepEqual(app.toasts, ['Task became active']);
  app.actions.onClose();
  assert.equal(app.actions.renderConfirmation(), '');
});

test('late responses cannot restore confirmation after the panel closed and external task locks prevent requests', async () => {
  let reject: ((reason: unknown) => void) | undefined;
  const waiting = new Promise<unknown>((_resolve, rejectPromise) => (reject = rejectPromise)),
    app = setup({ completed: true, request: () => waiting });
  const pending = invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
  app.actions.onClose();
  defined(reject)(Object.assign(Error('Changed'), { code: 'confirmation_required' }));
  await pending;
  assert.equal(app.actions.renderConfirmation(), '');
  const locked = setup({ isPending: () => true });
  await invokeHandler(
    defined(locked.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
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
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
    start = sourceIndex(source, 'function renderProgress(){'),
    end = sourceIndex(source, 'function renderModal(){', start);
  const context = uiEntrypointFixture({
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
    t: (key: string) => key,
    esc: (value: unknown) => String(value ?? ''),
    ico: () => '',
    formatTime: () => '',
    unknownTask: () => false,
    humanControl: () => false,
  });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
  const { document } = parseHTML(context.renderProgress());
  assert.ok(document.querySelector<HTMLButtonElement>('[data-progress-clear-completed]'));
  assert.match(
    defined(document.querySelector<HTMLElement>('.progress-section-heading')).textContent,
    /20/,
  );
  const titles = [...document.querySelectorAll<HTMLElement>('.progress-item>div>p')].map(
    (node) => node.textContent,
  );
  assert.deepEqual(titles.slice(0, 2), ['High unfinished', 'Low unfinished']);
  assert.equal(titles.filter((title) => title.startsWith('Completed ')).length, 12);
  assert.equal(state.messages.filter((message) => message.status === 'completed').length, 20);
});
