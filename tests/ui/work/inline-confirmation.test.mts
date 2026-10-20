import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { parseHTML } from 'linkedom';
import { ConnectionStatus, TaskStatus, PlanStepStatus } from '../../../ui/shared/states.mts';
import { isRecord } from '../../../ui/shared/json.mts';
import { escapeHtml } from '../../../ui/shared/html.mts';
import { reconcile } from '../../../ui/shared/dom.mts';
import { createProgressActions } from '../../../ui/work/progress-actions.mts';
import {
  workProgress,
  renderActiveWork,
  renderWorkTaskHistory,
  renderVoiceWorkHistory,
  renderWorkPriority,
} from '../../../ui/work/work-progress.mts';
import type { ProgressSnapshot } from '../../../ui/work/progress-snapshot.mts';
import { defined, invokeHandler } from '../../support/fixture-assertions.mts';
import { sourceSection } from '../../support/source-fixtures.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';

type FixtureState = ProgressSnapshot &
  Required<Pick<ProgressSnapshot, 'messages' | 'workTasks' | 'completions'>>;

function fixture({ active = false } = {}) {
  const { document } = parseHTML('<main><div class="work-progress-body"></div></main>'),
    body = defined(document.querySelector<HTMLElement>('.work-progress-body')),
    calls: Array<{ id: string; route: string; body: Record<string, unknown> }> = [],
    focusCalls: Array<{ node: HTMLElement; options?: FocusOptions }> = [],
    toasts: string[] = [],
    state: FixtureState = {
      conversationId: 'conversation',
      capabilities: { workReply: true, taskReopen: true },
      worker: { status: ConnectionStatus.Online },
      controller: { status: ConnectionStatus.Online },
      queue: [],
      messages: [
        {
          id: 'shared-id',
          role: 'user',
          turnId: 'legacy-turn',
          text: 'Legacy task',
          status: TaskStatus.Paused,
        },
        { id: 'voice-result', role: 'assistant', text: 'Call result' },
      ],
      workTasks: [
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `ongoing-${index}`,
          turnId: `ongoing-turn-${index}`,
          title: `Waiting task ${index}`,
          status: TaskStatus.WaitingUser,
          updatedAt: 1000 + index,
          plan: { steps: [{ step: 'Waiting for a reply', status: PlanStepStatus.Pending }] },
        })),
        {
          id: 'shared-id',
          turnId: 'work-turn',
          title: 'Registered task',
          status: TaskStatus.Paused,
        },
        {
          id: 'remove-target',
          turnId: 'original-turn',
          title: 'Lower task',
          status: TaskStatus.Paused,
        },
      ],
      completions: [
        {
          id: 'voice-receipt',
          turnId: 'voice-turn',
          messageIds: ['voice-result'],
          work: { source: 'voice', status: TaskStatus.Review },
        },
      ],
    };
  if (active) {
    state.workTasks.push({
      id: 'active-work',
      turnId: 'active-turn',
      title: 'Active work',
      status: TaskStatus.Running,
    });
    state.active = {
      workId: 'active-work',
      turnId: 'active-turn',
      source: 'voice',
      status: TaskStatus.Running,
      callId: 'owner-call',
    };
  }
  let scrollCalls = 0;
  const actions = createProgressActions({
    document,
    getModel: () => workProgress(state),
    render: () => render(),
    toast: (message) => toasts.push(message),
    request: async (id, route, requestBody) => {
      assert.ok(isRecord(requestBody));
      calls.push({ id, route, body: requestBody });
      if (route.endsWith('/dismiss')) {
        const entries =
            requestBody.kind === 'work'
              ? state.workTasks
              : requestBody.kind === 'completion'
                ? state.completions
                : state.messages,
          entry = entries.find((item) => item.id === id);
        assert.ok(entry);
        entry.progressDismissedAt = Date.now();
      }
      return { ok: true, cancelled: true };
    },
  });
  const context = uiEntrypointFixture({
    state,
    document,
    currentState: () => state,
    workProgress,
    renderActiveWork,
    renderWorkTaskHistory,
    renderVoiceWorkHistory,
    renderWorkPriority,
    progressActions: actions,
    workDisclosures: { isOpen: () => false },
    pendingActions: new Set<string>(),
    language: () => 'en',
    eventConnected: true,
    t: (key: string) => key,
    esc: escapeHtml,
    ico: () => '',
    formatTime: () => '',
    unknownTask: () => false,
    humanControl: () => false,
  });
  const render = () => {
    const template = document.createElement('template');
    template.innerHTML = context.renderProgress();
    reconcile(body, template.content);
    for (const node of body.querySelectorAll<HTMLElement>('button,select')) {
      node.focus = (options?: FocusOptions) => {
        focusCalls.push({ node, ...(options ? { options } : {}) });
        // Model the browser's default scroll-on-focus behavior; prevention must
        // be explicit on the actual focused control, not inferred from markup.
        if (options?.preventScroll !== true) body.scrollTop = 0;
      };
      node.scrollIntoView = () => {
        scrollCalls++;
        body.scrollTop = 0;
      };
    }
    actions.bind();
  };
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(
    stripTypeScriptTypes(
      sourceSection(source, 'function renderProgress()', 'function renderModal()'),
    ),
    context,
  );
  render();
  body.scrollTop = 1400;
  return {
    document,
    body,
    state,
    actions,
    render,
    calls,
    focusCalls,
    toasts,
    scrollCalls: () => scrollCalls,
  };
}

test('lower work, legacy task and voice removals keep confirmation inside the exact card and preserve scroll through cancel and confirm', async () => {
  for (const [id, kind, cardKey, expected] of [
    [
      'remove-target',
      'work',
      'registered-work-remove-target',
      { expectedTurnId: 'original-turn', expectedConversationId: 'conversation' },
    ],
    ['shared-id', 'task', 'progress-shared-id', { expectedTurnId: 'legacy-turn' }],
    ['voice-receipt', 'completion', 'voice-work-voice-receipt', { expectedTurnId: 'voice-turn' }],
  ] as const) {
    const app = fixture(),
      card = defined(app.body.querySelector<HTMLElement>(`[data-key="${cardKey}"]`)),
      before = [...app.body.querySelectorAll('.progress-item')].indexOf(card),
      remove = defined(card.querySelector<HTMLButtonElement>('[data-task-dismiss]'));
    assert.ok(before >= 20, 'the selected history entry follows twenty ongoing tasks');
    await invokeHandler(remove, 'click');
    const confirmation = defined(app.body.querySelector<HTMLElement>('[role="alertdialog"]'));
    assert.equal(confirmation.closest('.progress-item'), card);
    assert.equal(app.body.querySelectorAll('[role="alertdialog"]').length, 1);
    assert.equal(app.body.firstElementChild?.getAttribute('role'), null);
    assert.equal(app.body.scrollTop, 1400);
    assert.equal(app.calls.length, 0);
    assert.equal(app.focusCalls.at(-1)?.options?.preventScroll, true);
    await invokeHandler(
      defined(confirmation.querySelector('[data-progress-dismiss-cancel]')),
      'click',
    );
    assert.equal(app.body.querySelector('[role="alertdialog"]'), null);
    assert.equal(app.focusCalls.at(-1)?.node, remove);
    assert.equal(app.body.scrollTop, 1400);
    await invokeHandler(remove, 'click');
    await invokeHandler(
      defined(app.body.querySelector('[data-progress-dismiss-confirm]')),
      'click',
    );
    assert.deepEqual(app.calls, [
      { id, route: `/tasks/${id}/dismiss`, body: { kind, confirmUnfinished: true, ...expected } },
    ]);
    assert.equal(app.body.querySelector(`[data-key="${cardKey}"]`), null);
    assert.equal(app.body.scrollTop, 1400);
    assert.equal(app.scrollCalls(), 0);
    assert.ok(app.focusCalls.every((call) => call.options?.preventScroll === true));
  }
});

test('equal IDs from different progress kinds never share an inline confirmation', async () => {
  const app = fixture(),
    work = defined(app.body.querySelector<HTMLElement>('[data-key="registered-work-shared-id"]')),
    task = defined(app.body.querySelector<HTMLElement>('[data-key="progress-shared-id"]'));
  await invokeHandler(defined(work.querySelector('[data-task-dismiss]')), 'click');
  assert.ok(work.querySelector('[role="alertdialog"]'));
  assert.equal(task.querySelector('[role="alertdialog"]'), null);
  assert.equal(app.actions.renderConfirmation({ id: 'shared-id', kind: 'task' }), '');
  await invokeHandler(defined(work.querySelector('[data-progress-dismiss-cancel]')), 'click');
  await invokeHandler(defined(task.querySelector('[data-task-dismiss]')), 'click');
  assert.ok(task.querySelector('[role="alertdialog"]'));
  assert.equal(work.querySelector('[role="alertdialog"]'), null);
  assert.equal(app.actions.renderConfirmation({ id: 'shared-id', kind: 'work' }), '');
});

test('an inline dismiss confirmation cannot hide a new execution turn reusing the saved work ID', async () => {
  const app = fixture(),
    record = defined(app.state.workTasks.find((item) => item.id === 'remove-target')),
    remove = defined(app.body.querySelector('[data-task-dismiss="remove-target"]'));
  await invokeHandler(remove, 'click');
  record.turnId = 'new-turn';
  record.status = TaskStatus.Review;
  record.title = 'A newer result needs review';
  app.render();
  const confirm = defined(
    app.body.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]'),
  );
  assert.equal(confirm.disabled, true);
  await invokeHandler(confirm, 'click');
  assert.equal(app.calls.length, 0);
  assert.match(app.toasts.at(-1) || '', /changed/);
  assert.equal(record.progressDismissedAt, undefined);
});

test('a conversation change invalidates a saved work confirmation even when its ID and turn remain equal', async () => {
  const app = fixture(),
    remove = defined(app.body.querySelector('[data-task-dismiss="remove-target"]'));
  await invokeHandler(remove, 'click');
  app.state.conversationId = 'other-conversation';
  app.render();
  const confirm = defined(
    app.body.querySelector<HTMLButtonElement>('[data-progress-dismiss-confirm]'),
  );
  assert.equal(confirm.disabled, true);
  await invokeHandler(confirm, 'click');
  assert.equal(app.calls.length, 0);
  assert.match(app.toasts.at(-1) || '', /changed/);
});

test('legacy dismissal preserves a real null turn and does not invent an omitted turn or conversation owner', async () => {
  for (const turnId of [undefined, null]) {
    const app = fixture(),
      message = defined(app.state.messages.find((item) => item.id === 'shared-id'));
    if (turnId === undefined) delete message.turnId;
    else message.turnId = turnId;
    app.render();
    await invokeHandler(
      defined(app.body.querySelector('[data-task-dismiss="shared-id"][data-progress-kind="task"]')),
      'click',
    );
    await invokeHandler(
      defined(app.body.querySelector('[data-progress-dismiss-confirm]')),
      'click',
    );
    const body = defined(app.calls[0]).body;
    assert.equal(Object.hasOwn(body, 'expectedTurnId'), turnId !== undefined);
    if (turnId !== undefined) assert.equal(body.expectedTurnId, null);
    assert.equal(Object.hasOwn(body, 'expectedConversationId'), false);
  }
});

test('active cancellation stays inside its current card and rejects a changed turn or call owner', async () => {
  const app = fixture({ active: true }),
    card = defined(app.body.querySelector<HTMLElement>('.current-work')),
    cancel = defined(card.querySelector('[data-task-cancel]'));
  await invokeHandler(cancel, 'click');
  assert.equal(
    defined(app.body.querySelector('[role="alertdialog"]')).closest('.current-work'),
    card,
  );
  assert.equal(app.body.scrollTop, 1400);
  assert.equal(app.focusCalls.at(-1)?.options?.preventScroll, true);
  const active = defined(app.state.active),
    record = defined(app.state.workTasks.find((item) => item.id === 'active-work'));
  active.turnId = 'new-active-turn';
  active.callId = 'new-call-owner';
  record.turnId = active.turnId;
  app.render();
  const confirm = defined(
    app.body.querySelector<HTMLButtonElement>('[data-progress-task-cancel-confirm]'),
  );
  assert.equal(confirm.disabled, true);
  await invokeHandler(confirm, 'click');
  assert.equal(app.calls.length, 0);
  assert.match(app.toasts.at(-1) || '', /changed/);
  assert.equal(app.body.scrollTop, 1400);
});
