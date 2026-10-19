import { isRecord } from '../../../src/contracts/json.mts';
import type { ProgressSnapshot } from '../../../ui/work/progress-snapshot.mts';
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
import {
  workProgress,
  renderActiveWork,
  renderWorkTaskHistory,
} from '../../../ui/work/work-progress.mts';
import { createProgressActions } from '../../../ui/work/progress-actions.mts';

function setup({
  language = 'en',
  ongoing,
  registered = true,
  ephemeral = false,
  request,
}: {
  language?: string;
  ongoing?: string;
  registered?: boolean;
  ephemeral?: boolean;
  request?: (...args: RequestArgs) => unknown;
} = {}) {
  const { document } = parseHTML('<main></main>'),
    calls: RecordedCall[] = [],
    toasts: string[] = [];
  const state: ProgressSnapshot & {
    messages: NonNullable<ProgressSnapshot['messages']>;
    workTasks: NonNullable<ProgressSnapshot['workTasks']>;
    queue: string[];
    completions: NonNullable<ProgressSnapshot['completions']>;
    call: { id: string; status: string; provider?: string };
  } = {
    worker: { status: 'online' },
    controller: { status: 'online' },
    queue: [],
    completions: [],
    call: { id: 'media-call', status: 'connected' },
    messages: ephemeral
      ? []
      : [
          {
            id: 'message',
            role: 'user',
            turnId: 'turn',
            text: 'Check <project>',
            status: 'running',
          },
        ],
    workTasks: registered
      ? [
          {
            id: 'work',
            turnId: 'turn',
            messageId: ephemeral ? null : 'message',
            source: 'voice',
            title: 'Check <project>',
            status: ongoing || 'running',
            plan: {
              steps: [
                { step: 'Inspect', status: 'completed' },
                { step: 'Verify', status: 'inProgress' },
              ],
            },
          },
        ]
      : [],
    active: ongoing
      ? null
      : {
          messageId: ephemeral ? null : 'message',
          turnId: 'turn',
          source: 'voice',
          callId: 'owner-call',
          status: 'running',
          ...(registered ? { workId: 'work' } : {}),
        },
  };
  let actions: ReturnType<typeof createProgressActions>;
  const getModel = () => workProgress(state, { language }),
    render = () => {
      const model = getModel();
      defined(document.querySelector<HTMLElement>('main')).innerHTML =
        renderActiveWork(model, { pending: actions.busy }) +
        model.ongoing
          .map((item) =>
            renderWorkTaskHistory(defined(item), model.labels, { pending: actions.busy }),
          )
          .join('') +
        model.recent
          .filter((item) => item.registered)
          .map((item) =>
            renderWorkTaskHistory(defined(item), model.labels, { pending: actions.busy }),
          )
          .join('') +
        actions.renderConfirmation();
      actions.bind();
    };
  actions = createProgressActions({
    document,
    getModel,
    render,
    getLanguage: () => language,
    toast: (text: string) => toasts.push(text),
    request: async (...args: RequestArgs) => {
      assert.ok(isRecord(args[2]));
      calls.push([args[0], args[1], args[2]]);
      if (request) return request(...args);
      state.active = null;
      for (const record of state.workTasks) record.status = 'cancelled';
      for (const message of state.messages) message.status = 'cancelled';
      return { ok: true, cancelled: true };
    },
  });
  render();
  return { document, state, actions, getModel, render, calls, toasts };
}

test('the compact registered current X requires confirmation and retains exact cancelled history without touching call media', async () => {
  for (const language of ['en', 'zh']) {
    const app = setup({ language }),
      beforeCall = structuredClone(app.state.call);
    assert.equal(app.document.querySelectorAll<HTMLButtonElement>('[data-task-cancel]').length, 1);
    await invokeHandler(
      defined(app.document.querySelector<HTMLElement>('.progress-cancel')),
      'click',
    );
    assert.equal(app.calls.length, 0);
    assert.match(
      defined(app.document.querySelector<HTMLElement>('[role=alertdialog]')).textContent,
      language === 'en' ? /Recent tasks as Cancelled/ : /最近的任务.*已取消/,
    );
    assert.equal(app.document.querySelector<HTMLElement>('project'), null);
    await invokeHandler(
      defined(app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]')),
      'click',
    );
    assert.deepEqual(app.calls, [
      ['work', '/tasks/work/cancel', { kind: 'work', turnId: 'turn', callId: 'owner-call' }],
    ]);
    assert.equal(app.document.querySelector<HTMLElement>('.current-work'), null);
    assert.equal(app.getModel().ongoing.length, 0);
    assert.equal(defined(app.getModel().recent[0]).status, 'cancelled');
    assert.equal(app.getModel().completedCount, 0);
    assert.deepEqual(app.state.call, beforeCall);
    assert.equal(app.state.messages.length, 1);
    assert.equal(app.state.workTasks.length, 1);
    assert.match(
      defined(app.document.querySelector<HTMLElement>('.registered-work')).textContent,
      language === 'en' ? /Cancelled/ : /已取消/,
    );
    assert.equal(
      app.document.querySelector<HTMLButtonElement>('[data-work-step-status=inProgress]'),
      null,
    );
    assert.match(
      defined(
        app.document.querySelector<HTMLButtonElement>('[data-work-step-status=cancelled] small'),
      ).textContent,
      language === 'en' ? /Stopped/ : /已停止/,
    );
    assert.equal(
      defined(defined(defined(defined(app.state.workTasks[0]).plan).steps)[1]).status,
      'inProgress',
      'only presentation changes the unfinished step',
    );
    assert.equal(app.document.querySelector<HTMLButtonElement>('[data-task-cancel]'), null);
    assert.ok(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]'));
  }
});

test('inactive ongoing work cancels into recent history while a historical task still uses dismiss', async () => {
  for (const status of ['continuing', 'waiting_user']) {
    const app = setup({ ongoing: status });
    assert.equal(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]'), null);
    await invokeHandler(
      defined(app.document.querySelector<HTMLButtonElement>('[data-task-cancel]')),
      'click',
    );
    await invokeHandler(
      defined(app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]')),
      'click',
    );
    assert.deepEqual(app.calls, [['work', '/tasks/work/cancel', { kind: 'work', turnId: 'turn' }]]);
    assert.equal(app.getModel().ongoing.length, 0);
    assert.equal(defined(app.getModel().recent[0]).status, 'cancelled');
    await invokeHandler(
      defined(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
      'click',
    );
    assert.ok(app.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]'));
    assert.equal(
      app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]'),
      null,
    );
  }
});

test('legacy bottom cancellation targets the actual task, preparation message or ephemeral native turn', async () => {
  for (const entry of [
    {
      registered: false,
      expected: { kind: 'task', turnId: 'turn', callId: 'owner-call' },
      id: 'message',
    },
    {
      registered: false,
      ephemeral: true,
      expected: { kind: 'active', turnId: 'turn', callId: 'owner-call' },
      id: 'current',
    },
    {
      registered: false,
      preparing: true,
      expected: { kind: 'task', turnId: null, callId: 'owner-call' },
      id: 'message',
    },
  ]) {
    const app = setup(entry);
    if (entry.preparing) {
      defined(app.state.active).turnId = null;
      delete defined(app.state.messages[0]).turnId;
      app.render();
    }
    assert.equal(app.document.querySelectorAll<HTMLButtonElement>('[data-task-cancel]').length, 2);
    await invokeHandler(
      defined(app.document.querySelector<HTMLElement>('.current-work-cancel')),
      'click',
    );
    await invokeHandler(
      defined(app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]')),
      'click',
    );
    assert.deepEqual(app.calls, [[entry.id, '/tasks/' + entry.id + '/cancel', entry.expected]]);
  }
});

test('a changed turn, owner call or completed task invalidates both stale controls and their open confirmation', async () => {
  for (const change of ['turn', 'call', 'completed']) {
    const app = setup(),
      stale = app.document.querySelector<HTMLButtonElement>('[data-task-cancel]');
    await invokeHandler(defined(stale), 'click');
    if (change === 'turn') defined(app.state.active).turnId = 'new-turn';
    else if (change === 'call') defined(app.state.active).callId = 'new-call';
    else {
      app.state.active = null;
      defined(app.state.workTasks[0]).status = 'review';
    }
    await invokeHandler(
      defined(app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]')),
      'click',
    );
    assert.equal(app.calls.length, 0);
    assert.equal(app.actions.renderConfirmation(), '');
    assert.match(defined(app.toasts.at(-1)), /changed/);
    await invokeHandler(defined(stale), 'click');
    assert.equal(app.calls.length, 0);
    assert.equal(app.actions.renderConfirmation(), '');
  }
});

test('pending cancellation disables duplicate actions and unknown failure never moves work into cancelled history', async () => {
  let reject: ((reason: unknown) => void) | undefined;
  const waiting = new Promise<unknown>((_resolve, no) => (reject = no)),
    app = setup({ request: () => waiting });
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-cancel]')),
    'click',
  );
  const confirm = app.document.querySelector<HTMLButtonElement>(
      '[data-progress-task-cancel-confirm]',
    ),
    pending = invokeHandler(defined(confirm), 'click');
  assert.equal(app.actions.busy, true);
  assert.ok(
    [...app.document.querySelectorAll<HTMLButtonElement>('[data-task-cancel]')].every((node) =>
      node.hasAttribute('disabled'),
    ),
  );
  await invokeHandler(defined(confirm), 'click');
  assert.equal(app.calls.length, 1);
  defined(app.state.active).status = 'unknown';
  defined(reject)(Error('Stop was not confirmed'));
  await pending;
  assert.equal(defined(app.getModel().active).status, 'unknown');
  assert.equal(app.getModel().recent.length, 0);
  assert.match(
    defined(app.document.querySelector<HTMLElement>('.current-work')).textContent,
    /Status unconfirmed/,
  );
  assert.ok(
    defined(
      app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]'),
    ).hasAttribute('disabled'),
  );
  assert.equal(app.toasts.includes('Task cancelled'), false);
});

test('no cancellation result or an offline owner cannot claim success, and backing out never mutates a task', async () => {
  const app = setup({ request: () => ({ ok: true }) });
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-cancel]')),
    'click',
  );
  invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-back]')),
    'click',
  );
  assert.equal(app.calls.length, 0);
  assert.equal(app.actions.renderConfirmation(), '');
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-cancel]')),
    'click',
  );
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]')),
    'click',
  );
  assert.match(defined(app.toasts.at(-1)), /not confirmed/);
  assert.ok(app.getModel().active);
  assert.equal(app.getModel().recent.length, 0);
  app.actions.onClose();
  defined(app.state.controller).cached = true;
  app.render();
  assert.ok(
    [...app.document.querySelectorAll<HTMLButtonElement>('[data-task-cancel]')].every((node) =>
      node.hasAttribute('disabled'),
    ),
  );
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-cancel]')),
    'click',
  );
  assert.equal(app.calls.length, 1);
});

test('cancelled work stays outside ongoing and completed even when every step had been checked', () => {
  const app = setup({ ongoing: 'continuing' });
  defined(app.state.workTasks[0]).status = 'cancelled';
  for (const step of defined(defined(defined(app.state.workTasks[0]).plan).steps))
    step.status = 'completed';
  const model = app.getModel();
  assert.equal(model.active, null);
  assert.equal(model.ongoing.length, 0);
  assert.equal(model.completedCount, 0);
  assert.equal(defined(model.recent[0]).status, 'cancelled');
  assert.equal(model.reviewCount, 0);
});

test('a historical dismiss confirmation cannot hide a task that became ongoing', async () => {
  const app = setup({ ongoing: 'paused' });
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-dismiss]')),
    'click',
  );
  defined(app.state.workTasks[0]).status = 'continuing';
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]')),
    'click',
  );
  assert.equal(app.calls.length, 0);
  assert.equal(
    app.document.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]'),
    null,
  );
  assert.ok(app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]'));
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]')),
    'click',
  );
  assert.deepEqual(app.calls, [['work', '/tasks/work/cancel', { kind: 'work', turnId: 'turn' }]]);
});

test('main uses task-scoped progress cancellation controls and refreshes failed cancellation without replay', async () => {
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
    renderStart = sourceIndex(source, 'function renderProgress(){'),
    renderEnd = sourceIndex(source, 'function renderModal(){', renderStart),
    progress = source.slice(renderStart, renderEnd);
  assert.doesNotMatch(progress, /data-action="stop"/);
  assert.match(
    progress,
    /renderActiveWork\(model,\s*\{\s*pending:\s*busy,\s*planOpen:\s*Boolean\(active\.id\s*&&\s*workDisclosures\.isOpen\(active\.id\)\),\s*confirmation:/,
  );
  const start = sourceIndex(source, 'async function taskRequest('),
    end = sourceIndex(source, 'function resumeTask(', start),
    requests: unknown[][] = [],
    reads: string[] = [],
    context = uiEntrypointFixture({
      state: null as { active: { turnId: string; status: string } } | null,
      pendingActions: new Set(),
      render() {},
      post: async (...args: unknown[]) => {
        requests.push(args);
        throw Error('Unconfirmed');
      },
      api: async (route: string) => {
        reads.push(route);
        return { active: { turnId: 'turn', status: 'unknown' } };
      },
    });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
  await assert.rejects(
    context.taskRequest('work', '/tasks/work/cancel', { kind: 'work', turnId: 'turn' }),
    /Unconfirmed/,
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(reads, ['/state']);
  assert.equal(defined(context.state).active.status, 'unknown');
  assert.equal(context.pendingActions.size, 0);
});
