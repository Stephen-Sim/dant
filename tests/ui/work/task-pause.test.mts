import { isRecord } from '../../../ui/shared/json.mts';
import type { ProgressSnapshot } from '../../../ui/work/progress-snapshot.mts';
type ActionOptions = Parameters<typeof createProgressActions>[0];
type RequestArgs = Parameters<ActionOptions['request']>;
type RecordedCall = [string, string, Record<string, unknown>];
import { defined, invokeHandler } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  workProgress,
  renderActiveWork,
  renderWorkTaskHistory,
  updateWorkTimers,
} from '../../../ui/work/work-progress.mts';
import { createProgressActions } from '../../../ui/work/progress-actions.mts';

function setup({
  language = 'en',
  status = 'running',
  registered = true,
  ephemeral = false,
  request,
}: {
  language?: string;
  status?: string;
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
    queue: ['unrelated'],
    completions: [],
    call: { id: 'media-call', provider: 'subscription', status: 'connected' },
    messages: [
      ...(ephemeral
        ? []
        : [{ id: 'message', role: 'user', turnId: 'turn', text: 'Check <project>', status }]),
      { id: 'unrelated', role: 'user', status: 'queued', text: 'Unrelated work' },
    ],
    workTasks: registered
      ? [
          {
            id: 'work',
            turnId: 'turn',
            messageId: ephemeral ? null : 'message',
            source: 'voice',
            title: 'Check <project>',
            status,
            executionEndedAt: ['paused', 'continuing', 'waiting_user'].includes(status)
              ? 1000
              : undefined,
            plan: {
              steps: [
                { step: 'Inspect', status: 'completed' },
                { step: 'Verify', status: 'inProgress' },
              ],
            },
          },
        ]
      : [],
    active:
      status === 'running'
        ? {
            messageId: ephemeral ? null : 'message',
            turnId: 'turn',
            source: 'voice',
            callId: 'owner-call',
            status: 'running',
            ...(registered ? { workId: 'work' } : {}),
          }
        : null,
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
      if (args[1].endsWith('/pause')) {
        state.active = null;
        for (const record of state.workTasks) {
          record.status = 'paused';
          record.executionEndedAt = 2000;
        }
        for (const message of state.messages)
          if (message.id === 'message') message.status = 'paused';
        return { ok: true, paused: true };
      }
      if (args[1].endsWith('/resume')) {
        for (const record of state.workTasks) record.status = 'continuing';
        return { ok: true, resumed: true, queued: true };
      }
      throw Error('Unexpected route');
    },
  });
  render();
  return { document, state, actions, getModel, render, calls, toasts };
}

test('Pause current work keeps the exact task, media and unrelated queue, then resumes that same registered work', async () => {
  for (const language of ['en', 'zh']) {
    const app = setup({ language }),
      beforeCall = structuredClone(app.state.call),
      beforeQueue = [...app.state.queue],
      button = app.document.querySelector<HTMLButtonElement>('[data-task-pause]');
    assert.match(
      defined(button).textContent,
      language === 'en' ? /Pause current work/ : /暂停当前工作/,
    );
    await invokeHandler(defined(button), 'click');
    assert.deepEqual(app.calls, [
      ['work', '/tasks/work/pause', { kind: 'work', turnId: 'turn', callId: 'owner-call' }],
    ]);
    assert.equal(app.actions.renderConfirmation(), '');
    assert.equal(app.state.active, null);
    assert.equal(app.getModel().ongoing.length, 0);
    assert.equal(defined(app.getModel().recent[0]).status, 'paused');
    assert.equal(app.getModel().completedCount, 0);
    assert.deepEqual(app.state.call, beforeCall);
    assert.deepEqual(app.state.queue, beforeQueue);
    assert.equal(app.state.workTasks.length, 1);
    assert.equal(
      app.document.querySelector<HTMLButtonElement>('[data-task-resume]'),
      null,
      'registered work never replays its original user message',
    );
    assert.match(
      defined(app.document.querySelector<HTMLButtonElement>('[data-work-step-status=paused] small'))
        .textContent,
      language === 'en' ? /Paused/ : /已暂停/,
    );
    assert.equal(
      defined(defined(defined(defined(app.state.workTasks[0]).plan).steps)[1]).status,
      'inProgress',
    );
    const resume = app.document.querySelector<HTMLButtonElement>('[data-task-work-resume]');
    assert.equal(defined(resume).disabled, false);
    assert.match(defined(resume).textContent, language === 'en' ? /Resume task/ : /继续任务/);
    await invokeHandler(defined(resume), 'click');
    assert.deepEqual(app.calls[1], [
      'work',
      '/tasks/work/resume',
      { kind: 'work', turnId: 'turn' },
    ]);
    assert.equal(defined(app.getModel().ongoing[0]).id, 'work');
    assert.equal(defined(app.getModel().ongoing[0]).status, 'continuing');
    assert.equal(app.state.active, null, 'the response does not invent a running executor');
    assert.deepEqual(app.state.call, beforeCall);
    assert.deepEqual(app.state.queue, beforeQueue);
    assert.equal(
      app.toasts.some((text) => /cancel|取消/.test(text)),
      false,
    );
  }
});

test('inactive continuing and waiting work pause directly, while unregistered active owners keep exact preparation or call identity', async () => {
  for (const status of ['continuing', 'waiting_user']) {
    const app = setup({ status });
    await invokeHandler(
      defined(app.document.querySelector<HTMLButtonElement>('[data-task-pause]')),
      'click',
    );
    assert.deepEqual(app.calls, [['work', '/tasks/work/pause', { kind: 'work', turnId: 'turn' }]]);
    assert.equal(defined(app.getModel().recent[0]).status, 'paused');
  }
  for (const [ephemeral, preparing, expected, id] of [
    [false, false, { kind: 'task', turnId: 'turn', callId: 'owner-call' }, 'message'],
    [true, false, { kind: 'active', turnId: 'turn', callId: 'owner-call' }, 'current'],
    [false, true, { kind: 'task', turnId: null, callId: 'owner-call' }, 'message'],
  ] as const) {
    const app = setup({ registered: false, ephemeral });
    if (preparing) {
      defined(app.state.active).turnId = null;
      delete defined(app.state.messages[0]).turnId;
      app.render();
    }
    await invokeHandler(
      defined(app.document.querySelector<HTMLButtonElement>('[data-task-pause]')),
      'click',
    );
    assert.deepEqual(app.calls, [[id, '/tasks/' + id + '/pause', expected]]);
  }
});

test('stale pause and resume controls revalidate the exact turn, call and lifecycle before requesting', async () => {
  for (const change of ['turn', 'call', 'finished', 'offline']) {
    const app = setup(),
      stale = app.document.querySelector<HTMLButtonElement>('[data-task-pause]');
    if (change === 'turn') defined(app.state.active).turnId = 'new-turn';
    else if (change === 'call') defined(app.state.active).callId = 'new-call';
    else if (change === 'finished') {
      app.state.active = null;
      defined(app.state.workTasks[0]).status = 'review';
    } else defined(app.state.controller).cached = true;
    await invokeHandler(defined(stale), 'click');
    assert.equal(app.calls.length, 0, change);
  }
  for (const change of ['turn', 'active', 'cancelled', 'unknown', 'dispatch', 'offline']) {
    const app = setup({ status: 'paused' }),
      stale = app.document.querySelector<HTMLButtonElement>('[data-task-work-resume]');
    if (change === 'turn') defined(app.state.workTasks[0]).turnId = 'new-turn';
    else if (change === 'active')
      app.state.active = { workId: 'work', turnId: 'turn', status: 'running' };
    else if (change === 'cancelled') defined(app.state.workTasks[0]).status = 'cancelled';
    else if (change === 'unknown') defined(app.state.messages[0]).submission = 'unknown';
    else if (change === 'dispatch')
      defined(app.state.workTasks[0]).continuation = { dispatch: { phase: 'submitting' } };
    else defined(app.state.worker).status = 'offline';
    await invokeHandler(defined(stale), 'click');
    assert.equal(app.calls.length, 0, change);
  }
});

test('Resume is available only for a confirmed ended paused registered task with unfinished work', () => {
  for (const change of [
    'running',
    'review',
    'cancelled',
    'failed',
    'unknownOutcome',
    'submitting',
    'unknown',
    'invalid',
    'dispatch',
    'ended',
    'allDone',
    'missingPlan',
    'relatedUnknown',
    'workIdUnknown',
    'cached',
    'worker',
  ]) {
    const app = setup({ status: 'paused' }),
      record = app.state.workTasks[0];
    if (['running', 'review', 'cancelled', 'failed'].includes(change))
      defined(record).status = change;
    else if (change === 'unknownOutcome') defined(record).unknownOutcome = true;
    else if (['submitting', 'unknown'].includes(change)) defined(record).submission = change;
    else if (change === 'invalid') defined(record).continuation = { invalid: true };
    else if (change === 'dispatch')
      defined(record).continuation = { dispatch: { phase: 'acknowledged' } };
    else if (change === 'ended') delete defined(record).executionEndedAt;
    else if (change === 'allDone')
      defined(defined(defined(record).plan).steps).forEach((step) => (step.status = 'completed'));
    else if (change === 'missingPlan') defined(record).plan = null;
    else if (change === 'relatedUnknown')
      app.state.messages.push({
        id: 'second',
        role: 'user',
        turnId: 'turn',
        submission: 'unknown',
      });
    else if (change === 'workIdUnknown')
      app.state.messages.push({
        id: 'second',
        role: 'user',
        workId: 'work',
        submission: 'unknown',
      });
    else if (change === 'cached') defined(app.state.controller).cached = true;
    else defined(app.state.worker).status = 'offline';
    const item = app.getModel().items.find((item) => item.id === 'work');
    assert.equal(item?.canResume, false, change);
  }
  const provisional = setup({ status: 'paused' });
  defined(provisional.state.workTasks[0]).plan = null;
  defined(provisional.state.workTasks[0]).provisional = true;
  assert.equal(defined(provisional.getModel().recent[0]).canResume, true);
});

test('pending pause and resume serialize with cancellation and Clear all without claiming unconfirmed success', async () => {
  for (const status of ['running', 'paused']) {
    let release: ((value?: unknown) => void) | undefined;
    const wait = new Promise<unknown>((resolve) => (release = resolve)),
      app = setup({ status, request: () => wait }),
      selector = status === 'running' ? '[data-task-pause]' : '[data-task-work-resume]',
      button = app.document.querySelector<HTMLSelectElement>(selector),
      pending = invokeHandler(defined(button), 'click');
    assert.equal(app.actions.busy, true);
    assert.ok(
      defined(app.document.querySelector<HTMLSelectElement>(selector)).hasAttribute('disabled'),
    );
    await invokeHandler(defined(button), 'click');
    if (status === 'running')
      await invokeHandler(
        defined(app.document.querySelector<HTMLButtonElement>('[data-task-cancel]')),
        'click',
      );
    assert.equal(app.calls.length, 1);
    assert.equal(app.actions.renderConfirmation(), '');
    defined(release)({ ok: true });
    await pending;
    assert.equal(app.actions.busy, false);
    assert.match(defined(app.toasts.at(-1)), /not confirmed/);
    assert.equal(defined(app.state.workTasks[0]).status, status);
  }
});

test('failed pause stays unknown and a queued resume response never claims task execution has started', async () => {
  const app = setup({
    request: () => {
      defined(app.state.active).status = 'unknown';
      throw Error('Pause unconfirmed');
    },
  });
  await invokeHandler(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-pause]')),
    'click',
  );
  assert.equal(defined(app.getModel().active).status, 'unknown');
  assert.equal(app.getModel().recent.length, 0);
  assert.deepEqual(app.toasts, ['Pause unconfirmed']);
  assert.equal(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-pause]')).disabled,
    true,
  );
  const waiting = setup({ request: () => ({ ok: true, pausing: true }) });
  await invokeHandler(
    defined(waiting.document.querySelector<HTMLButtonElement>('[data-task-pause]')),
    'click',
  );
  assert.match(defined(waiting.toasts.at(-1)), /Waiting/);
  assert.equal(defined(waiting.state.active).status, 'running');
  const resumed = setup({ status: 'paused' });
  await invokeHandler(
    defined(resumed.document.querySelector<HTMLButtonElement>('[data-task-work-resume]')),
    'click',
  );
  assert.match(defined(resumed.toasts.at(-1)), /executor is free/);
  assert.equal(resumed.state.active, null);
});

test('an old service pause or resume route gives update guidance without pausing other work or retrying', async () => {
  for (const language of ['en', 'zh'])
    for (const status of ['running', 'paused']) {
      const app = setup({
          language,
          status,
          request: () => {
            throw Object.assign(Error('Request failed (404)'), { status: 404 });
          },
        }),
        before = structuredClone(app.state),
        selector = status === 'running' ? '[data-task-pause]' : '[data-task-work-resume]';
      await invokeHandler(
        defined(app.document.querySelector<HTMLSelectElement>(selector)),
        'click',
      );
      assert.equal(app.calls.length, 1);
      assert.deepEqual(app.state, before);
      assert.match(
        defined(app.toasts.at(-1)),
        language === 'en'
          ? /service needs an update.*updates automatically/
          : /服务需要更新.*自动完成/,
      );
      assert.equal(
        app.calls.some(([, route]) => route === '/tasks/pause'),
        false,
      );
    }
  for (const error of [
    Object.assign(Error('The task pause could not be confirmed. Check its current status.'), {
      status: 404,
    }),
    Object.assign(Error('Request failed (404)'), { status: 404, unknownOutcome: true }),
  ]) {
    const app = setup({
      request: () => {
        throw error;
      },
    });
    await invokeHandler(
      defined(app.document.querySelector<HTMLButtonElement>('[data-task-pause]')),
      'click',
    );
    assert.deepEqual(app.toasts, [error.message]);
    assert.equal(app.calls.length, 1);
  }
});

test('registered paused history has a work-ID Resume while preserving supplied warnings and explicit unknown safeguards', () => {
  const app = setup({ status: 'paused' }),
    model = app.getModel(),
    item = model.recent[0];
  let document = parseHTML(
    renderWorkTaskHistory(defined(item), model.labels, {
      actions: '<button data-existing-action>View earlier result</button>',
    }),
  ).document;
  assert.ok(document.querySelector<HTMLButtonElement>('[data-existing-action]'));
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-task-work-resume]')).disabled,
    false,
  );
  defined(app.state.messages[0]).submission = 'unknown';
  const unknown = app.getModel();
  document = parseHTML(
    renderWorkTaskHistory(defined(unknown.recent[0]), unknown.labels, {
      actions:
        '<p class="unknown-outcome">Check before retry</p><button data-task-unknown="old-message">Confirm repeat</button>',
    }),
  ).document;
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-task-work-resume]')).disabled,
    true,
  );
  assert.ok(document.querySelector<HTMLButtonElement>('[data-task-unknown]'));
  assert.match(
    defined(document.querySelector<HTMLElement>('.unknown-outcome')).textContent,
    /Check before retry/,
  );
});

test('work timers keep multi-hour elapsed time in the shared hours, minutes and seconds format', () => {
  const app = setup();
  defined(app.state.active).startedAt = 1000;
  const { document } = parseHTML(renderActiveWork(workProgress(app.state, { now: 4506000 })));
  assert.equal(defined(document.querySelector<HTMLElement>('time')).textContent, '1:15:05');
  updateWorkTimers(document, 75124000);
  assert.equal(defined(document.querySelector<HTMLElement>('time')).textContent, '20:52:03');
});
