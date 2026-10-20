import type { ProgressSnapshot } from '../../../ui/work/progress-snapshot.mts';
import { errorCode, errorMessage } from '../../../ui/shared/json.mts';
import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  workProgress,
  renderWorkTaskHistory,
  renderActiveWork,
} from '../../../ui/work/work-progress.mts';
import { createTaskReplyController } from '../../../ui/work/task-reply.mts';

function fixture({ language = 'en', status = 'waiting_user' } = {}) {
  const { document } = parseHTML('<html><body></body></html>');
  const state: Omit<ProgressSnapshot, 'capabilities'> & {
    messages: NonNullable<ProgressSnapshot['messages']>;
    workTasks: NonNullable<ProgressSnapshot['workTasks']>;
    capabilities?: { workReply?: unknown; taskReopen?: unknown } | undefined;
    call?: { id: string; provider: string; status: string };
  } = {
    conversationId: 'conversation-a',
    capabilities: { workReply: true },
    controller: { status: 'online' },
    worker: { status: 'online' },
    queue: ['queued-other'],
    messages: [
      { id: 'quoted', role: 'assistant', text: 'Ordinary message quote' },
      { id: 'queued-other', role: 'user', text: 'Another request', status: 'queued' },
    ],
    workTasks: [
      {
        id: 'work-a',
        turnId: 'turn-a',
        status,
        title: 'Verify <project> & report',
        executionEndedAt: 1000,
        plan: { steps: [{ step: 'Run verification', status: 'inProgress' }] },
      },
      {
        id: 'work-b',
        turnId: 'turn-b',
        status: 'waiting_user',
        title: 'Unrelated task',
        executionEndedAt: 1000,
        plan: { steps: [{ step: 'Wait', status: 'pending' }] },
      },
    ],
    active: {
      workId: 'live-other',
      turnId: 'live-turn',
      source: 'voice',
      status: 'running',
      callId: 'call-a',
    },
    call: { id: 'call-a', provider: 'subscription', status: 'connected' },
  };
  const composer = {
      draft: 'Keep my unsent draft',
      replyTo: 'quoted',
      attachments: ['attachment-a'],
    },
    toasts: string[] = [];
  let modal = true,
    chatMode = 'call',
    opens = 0,
    controller: ReturnType<typeof createTaskReplyController>;
  const getModel = () => workProgress(state, { language });
  const render = () => {
    const model = getModel();
    document.body.innerHTML = `<main>${model.items
      .filter((item) => item.registered)
      .map((item) =>
        renderWorkTaskHistory(defined(item), model.labels, { pending: controller.pending }),
      )
      .join(
        '',
      )}</main><aside>${controller.render()}<div data-ordinary-reply>${composer.replyTo}</div><textarea id="composer">${composer.draft}</textarea><div data-attachment>${composer.attachments.join(',')}</div></aside>`;
    controller.bind();
  };
  controller = createTaskReplyController({
    document,
    getModel,
    getLanguage: () => language,
    render,
    toast: (message) => toasts.push(message),
    openChat: () => {
      modal = false;
      chatMode = 'text';
      opens++;
    },
  });
  render();
  return {
    document,
    state,
    composer,
    toasts,
    controller,
    getModel,
    render,
    get modal() {
      return modal;
    },
    get chatMode() {
      return chatMode;
    },
    get opens() {
      return opens;
    },
  };
}

test('Reply to task opens the text composer without sending, resuming, replacing a draft or ordinary message quote', () => {
  for (const language of ['en', 'zh']) {
    const app = fixture({ language }),
      before = structuredClone({ state: app.state, composer: app.composer });
    const button = app.document.querySelector<HTMLButtonElement>('[data-task-work-reply="work-a"]');
    assert.equal(defined(button).disabled, false);
    assert.match(defined(button).textContent, language === 'en' ? /Reply to task/ : /回复任务/);
    defined(button).click();
    assert.equal(app.modal, false);
    assert.equal(app.chatMode, 'text');
    assert.equal(app.opens, 1);
    assert.deepEqual({ state: app.state, composer: app.composer }, before);
    assert.equal(
      defined(app.document.querySelector<HTMLTextAreaElement>('#composer')).value,
      'Keep my unsent draft',
    );
    assert.equal(
      defined(app.document.querySelector<HTMLButtonElement>('[data-ordinary-reply]')).textContent,
      'quoted',
    );
    assert.equal(
      defined(app.document.querySelector<HTMLButtonElement>('[data-attachment]')).textContent,
      'attachment-a',
    );
    const preview = app.document.querySelector<HTMLButtonElement>('[data-task-reply-preview]');
    assert.match(defined(preview).textContent, /Verify <project> & report/);
    assert.equal(defined(preview).querySelector<HTMLElement>('project'), null);
    assert.match(
      defined(preview).textContent,
      language === 'en' ? /Replying to task/ : /正在回复任务/,
    );
    assert.deepEqual(app.controller.prepare(), {
      workId: 'work-a',
      turnId: 'turn-a',
      conversationId: 'conversation-a',
    });
    assert.equal(defined(app.state.active).workId, 'live-other');
    assert.equal(defined(app.state.call).id, 'call-a');
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-reply-cancel]')).click();
    assert.equal(app.controller.selected, false);
    assert.equal(app.controller.prepare(), null);
    assert.deepEqual(app.composer, before.composer);
    assert.equal(app.document.querySelector<HTMLButtonElement>('[data-task-reply-preview]'), null);
  }
});

test('waiting, continuing and paused records may be targeted only when ended and authoritatively confirmed', () => {
  for (const status of ['waiting_user', 'continuing', 'paused']) {
    const app = fixture({ status }),
      item = app.getModel().items.find((item) => item.id === 'work-a');
    assert.equal(defined(item).canReply, true, status);
    assert.equal(app.controller.select(defined(item).replyTarget), true);
  }
  for (const change of [
    'noEnd',
    'running',
    'review',
    'completed',
    'cancelled',
    'unknown',
    'submitting',
    'dispatch',
    'invalid',
    'relatedUnknown',
    'workUnknown',
    'offline',
    'cached',
  ]) {
    const app = fixture(),
      record = app.state.workTasks[0];
    if (change === 'noEnd') delete defined(record).executionEndedAt;
    else if (['running', 'review', 'completed', 'cancelled'].includes(change))
      defined(record).status = change;
    else if (change === 'unknown') defined(record).unknownOutcome = true;
    else if (change === 'submitting') defined(record).submission = 'submitting';
    else if (change === 'dispatch')
      defined(record).continuation = { dispatch: { phase: 'submitting' } };
    else if (change === 'invalid') defined(record).continuation = { invalid: true };
    else if (change === 'relatedUnknown')
      app.state.messages.push({
        id: 'uncertain',
        role: 'user',
        turnId: defined(record).turnId,
        submission: 'unknown',
      });
    else if (change === 'workUnknown')
      app.state.messages.push({
        id: 'uncertain',
        role: 'user',
        workId: defined(record).id,
        submission: 'unknown',
      });
    else if (change === 'offline') defined(app.state.worker).status = 'offline';
    else defined(app.state.controller).cached = true;
    assert.equal(
      defined(app.getModel().items.find((item) => item.id === 'work-a')).canReply,
      false,
      change,
    );
    assert.equal(
      app.controller.select({
        workId: 'work-a',
        turnId: 'turn-a',
        conversationId: 'conversation-a',
      }),
      false,
      change,
    );
    assert.equal(app.controller.selected, false);
  }
});

test('stale card controls and changed conversation identities never switch the reply target to another task', () => {
  for (const change of ['turn', 'conversation', 'dismissed', 'removed', 'cancelled']) {
    const app = fixture(),
      old = app.document.querySelector<HTMLButtonElement>('[data-task-work-reply="work-a"]');
    if (change === 'turn') defined(app.state.workTasks[0]).turnId = 'new-turn';
    else if (change === 'conversation') app.state.conversationId = 'conversation-b';
    else if (change === 'dismissed') defined(app.state.workTasks[0]).progressDismissedAt = 2000;
    else if (change === 'removed') app.state.workTasks.shift();
    else defined(app.state.workTasks[0]).status = 'cancelled';
    defined(old).click();
    assert.equal(app.controller.selected, false, change);
    assert.equal(app.opens, 0);
    assert.match(
      defined(app.toasts.at(-1)),
      change === 'cancelled' ? /Update the work computer/ : /changed|no longer/,
    );
  }
  const app = fixture();
  assert.equal(
    app.controller.select({ workId: 'work-a', turnId: 'turn-b', conversationId: 'conversation-a' }),
    false,
  );
  assert.equal(
    app.controller.select({ workId: 'work-a', turnId: 'turn-a', conversationId: 'other' }),
    false,
  );
  assert.equal(
    app.controller.select({
      workId: 'work-a',
      turnId: 'turn-a\n',
      conversationId: 'conversation-a',
    }),
    false,
  );
});

test('a selected task that changes is blocked before sending while its target and draft remain visible', () => {
  for (const change of ['turn', 'cancelled', 'offline', 'removed'])
    for (const language of ['en', 'zh']) {
      const app = fixture({ language });
      defined(
        app.document.querySelector<HTMLButtonElement>('[data-task-work-reply="work-a"]'),
      ).click();
      const before = app.controller.target;
      if (change === 'turn') defined(app.state.workTasks[0]).turnId = 'new-turn';
      else if (change === 'cancelled') defined(app.state.workTasks[0]).status = 'cancelled';
      else if (change === 'offline') defined(app.state.controller).cached = true;
      else app.state.workTasks.shift();
      assert.throws(
        () => app.controller.prepare(),
        (error) =>
          errorCode(error) === 'task_reply_changed' &&
          new RegExp(language === 'en' ? 'draft has been kept' : '草稿已保留').test(
            errorMessage(error),
          ),
      );
      assert.deepEqual(app.controller.target, before);
      app.render();
      assert.ok(app.document.querySelector<HTMLElement>('.task-reply-warning'));
      assert.equal(
        defined(app.document.querySelector<HTMLTextAreaElement>('#composer')).value,
        'Keep my unsent draft',
      );
      assert.equal(app.composer.replyTo, 'quoted');
    }
});

test('pending sends prevent cancellation or retargeting and acknowledgements clear only the exact sent target', () => {
  const app = fixture();
  defined(app.document.querySelector<HTMLButtonElement>('[data-task-work-reply="work-a"]')).click();
  const target = app.controller.prepare();
  defined(target).turnId = 'client-mutated';
  assert.equal(defined(app.controller.target).turnId, 'turn-a');
  app.controller.setPending(true);
  app.render();
  assert.equal(app.controller.pending, true);
  assert.equal(
    defined(app.document.querySelector<HTMLButtonElement>('[data-task-reply-cancel]')).disabled,
    true,
  );
  assert.equal(app.controller.cancel(), false);
  assert.equal(
    app.controller.select({ workId: 'work-b', turnId: 'turn-b', conversationId: 'conversation-a' }),
    false,
  );
  assert.equal(defined(app.controller.target).workId, 'work-a');
  assert.equal(app.controller.acknowledged(target), false);
  assert.equal(app.controller.selected, true);
  assert.equal(
    app.controller.acknowledged({
      workId: 'work-a',
      turnId: 'turn-a',
      conversationId: 'conversation-a',
    }),
    true,
  );
  assert.equal(app.controller.selected, false);
  app.controller.setPending(false);
  assert.equal(app.controller.pending, false);
  app.controller.select({ workId: 'work-b', turnId: 'turn-b', conversationId: 'conversation-a' });
  assert.equal(
    app.controller.acknowledged({
      workId: 'work-a',
      turnId: 'turn-a',
      conversationId: 'conversation-a',
    }),
    false,
  );
  assert.equal(defined(app.controller.target).workId, 'work-b');
});

test('sent task reply references use explicit metadata and stable task title without confusing ordinary quoted-message replies', () => {
  const app = fixture(),
    message = {
      role: 'user',
      workId: 'work-a',
      replyTo: 'quoted',
      workReply: { workId: 'work-a', turnId: 'turn-a', conversationId: 'conversation-a' },
    };
  let html = app.controller.renderMessageReference(message);
  assert.match(html, /Reply to task/);
  assert.match(html, /Verify &lt;project&gt; &amp; report/);
  assert.doesNotMatch(html, /Ordinary message quote/);
  defined(app.state.workTasks[0]).turnId = 'later-turn';
  defined(app.state.workTasks[0]).status = 'running';
  app.state.active = { workId: 'work-a', turnId: 'later-turn', status: 'running' };
  html = app.controller.renderMessageReference(message);
  assert.match(
    html,
    /Verify &lt;project&gt;/,
    'an already-sent historical turn reference keeps the current task title',
  );
  defined(app.state.workTasks[0]).progressDismissedAt = 2000;
  html = app.controller.renderMessageReference(message);
  assert.match(html, /<span>Task<\/span>/);
  assert.doesNotMatch(html, /Verify/);
  assert.equal(app.controller.renderMessageReference({ ...message, workReply: undefined }), '');
  assert.equal(app.controller.renderMessageReference({ ...message, role: 'assistant' }), '');
  assert.equal(
    app.controller.renderMessageReference({
      ...message,
      workReply: { ...message.workReply, conversationId: 'other' },
    }),
    '',
  );
  assert.equal(
    app.controller.renderMessageReference({ ...message, workReply: { workId: 'work-a' } }),
    '',
  );
});

test('restored draft targets stay explicit even after another conversation or task turn replaces them', () => {
  for (const change of ['unchanged', 'turn', 'conversation', 'removed']) {
    const app = fixture(),
      target = { workId: 'work-a', turnId: 'turn-a', conversationId: 'conversation-a' };
    if (change === 'turn') defined(app.state.workTasks[0]).turnId = 'new-turn';
    else if (change === 'conversation') app.state.conversationId = 'another-conversation';
    else if (change === 'removed') app.state.workTasks.shift();
    assert.equal(app.controller.restore(target), true);
    assert.deepEqual(app.controller.target, target);
    assert.equal(app.opens, 0);
    assert.equal(app.modal, true);
    assert.equal(app.composer.draft, 'Keep my unsent draft');
    if (change === 'unchanged') {
      assert.deepEqual(app.controller.prepare(), target);
      assert.doesNotMatch(app.controller.render(), /task-reply-warning/);
    } else {
      assert.throws(() => app.controller.prepare(), { code: 'task_reply_changed' });
      assert.match(app.controller.render(), /task-reply-warning/);
      assert.deepEqual(app.controller.target, target);
    }
  }
  const app = fixture();
  assert.equal(app.controller.restore({ workId: 'work-a' }), false);
  assert.equal(app.controller.selected, false);
  app.controller.setPending(true);
  assert.equal(
    app.controller.restore({
      workId: 'work-a',
      turnId: 'turn-a',
      conversationId: 'conversation-a',
    }),
    false,
  );
});

test('old work services without explicit reply capability cannot silently accept a targeted reply as ordinary chat', () => {
  for (const capability of [undefined, false, 'true'])
    for (const language of ['en', 'zh']) {
      const app = fixture({ language }),
        target = { workId: 'work-a', turnId: 'turn-a', conversationId: 'conversation-a' };
      app.state.capabilities = capability === undefined ? undefined : { workReply: capability };
      app.render();
      const button = app.document.querySelector<HTMLButtonElement>(
        '[data-task-work-reply="work-a"]',
      );
      assert.equal(defined(button).disabled, true);
      assert.match(
        defined(button).title,
        language === 'en' ? /Update the work computer/ : /更新工作电脑服务/,
      );
      assert.equal(app.controller.select(target), false);
      assert.match(
        defined(app.toasts.at(-1)),
        language === 'en' ? /Update the work computer/ : /更新工作电脑服务/,
      );
      assert.equal(app.controller.restore(target), true);
      assert.deepEqual(app.controller.target, target);
      assert.throws(
        () => app.controller.prepare(),
        (error) =>
          errorCode(error) === 'task_reply_changed' && /draft|草稿/.test(errorMessage(error)),
      );
      assert.match(
        app.controller.render(),
        language === 'en' ? /Update the work computer/ : /更新工作电脑服务/,
      );
    }
});

test('terminal task replies select the same saved task and reopen only through the eventual explicit message', () => {
  for (const language of ['en', 'zh'])
    for (const status of ['review', 'completed', 'cancelled', 'failed']) {
      const app = fixture({ language, status });
      defined(app.state.capabilities).taskReopen = true;
      defined(defined(defined(defined(app.state.workTasks[0]).plan).steps)[0]).status = 'completed';
      app.render();
      const before = structuredClone(app.state),
        button = app.document.querySelector<HTMLButtonElement>('[data-task-work-reply="work-a"]');
      assert.equal(defined(button).disabled, false, status);
      assert.equal(defined(button).textContent, language === 'en' ? 'Reply to task' : '回复任务');
      defined(button).click();
      assert.deepEqual(
        app.state,
        before,
        'choosing a terminal task does not start, replay or reopen it',
      );
      assert.deepEqual(app.controller.prepare(), {
        workId: 'work-a',
        turnId: 'turn-a',
        conversationId: 'conversation-a',
      });
      assert.equal(defined(app.state.active).workId, 'live-other');
      assert.equal(defined(app.state.workTasks[0]).status, status);
      assert.match(
        app.controller.render(),
        language === 'en'
          ? /Sending this message reopens the task with its saved project context/
          : /发送这条消息后，将保留已有项目上下文/,
      );
      assert.equal(
        app.document.querySelector<HTMLButtonElement>('[data-task-priority="work-a"]'),
        null,
      );
      defined(app.state.capabilities).taskReopen = false;
      assert.throws(
        () => app.controller.prepare(),
        (error) =>
          errorCode(error) === 'task_reply_changed' && /Update|更新/.test(errorMessage(error)),
      );
      assert.equal(defined(app.controller.target).workId, 'work-a');
      assert.equal(app.composer.draft, 'Keep my unsent draft');
    }
});

test('active task reply requires a confirmed exact live owner and shares the composer route without steering another task', () => {
  const app = fixture({ status: 'running' });
  defined(app.state.capabilities).taskReopen = true;
  app.state.active = {
    workId: 'work-a',
    turnId: 'turn-a',
    status: 'running',
    source: 'chat',
    canSteer: true,
  };
  delete defined(app.state.workTasks[0]).executionEndedAt;
  let model = app.getModel();
  assert.equal(defined(model.active).canReply, true);
  assert.equal(defined(model.active).registered, true);
  assert.deepEqual(defined(model.active).detailsTarget, {
    workId: 'work-a',
    turnId: 'turn-a',
    conversationId: 'conversation-a',
  });
  const document = parseHTML(renderActiveWork(model)).document;
  assert.equal(
    document.querySelectorAll<HTMLButtonElement>('[data-task-work-reply]').length,
    1,
    'the compact active card contains one reply action',
  );
  assert.equal(
    defined(
      document.querySelector<HTMLButtonElement>(
        '.current-work .task-actions [data-task-work-reply]',
      ),
    ).dataset.taskWorkReply,
    'work-a',
  );
  assert.equal(
    defined(document.querySelector<HTMLDetailsElement>('[data-task-details]')).dataset.taskDetails,
    'work-a',
  );
  assert.equal(app.controller.select(defined(model.active).replyTarget), true);
  assert.deepEqual(app.controller.prepare(), {
    workId: 'work-a',
    turnId: 'turn-a',
    conversationId: 'conversation-a',
  });
  for (const change of [
    'no-cap',
    'stopping',
    'not-acknowledged',
    'uncertain',
    'dispatch',
    'takeover',
  ]) {
    const other = fixture({ status: 'running' });
    defined(other.state.capabilities).taskReopen = change !== 'no-cap';
    other.state.active = {
      workId: 'work-a',
      turnId: 'turn-a',
      status: change === 'stopping' ? 'pausing' : 'running',
      source: 'chat',
      canSteer: change !== 'not-acknowledged',
    };
    if (change === 'uncertain') defined(other.state.workTasks[0]).submission = 'unknown';
    if (change === 'dispatch')
      defined(other.state.workTasks[0]).continuation = { dispatch: { phase: 'submitting' } };
    if (change === 'takeover') other.state.takeover = true;
    assert.equal(defined(other.getModel().active).canReply, false, change);
    assert.equal(
      other.controller.select({
        workId: 'work-a',
        turnId: 'turn-a',
        conversationId: 'conversation-a',
      }),
      false,
      change,
    );
  }
  const mismatched = fixture({ status: 'running' });
  defined(mismatched.state.capabilities).taskReopen = true;
  mismatched.state.active = {
    workId: 'work-a',
    turnId: 'turn-b',
    status: 'running',
    canSteer: true,
  };
  model = mismatched.getModel();
  assert.equal(
    defined(model.active).replyTarget,
    undefined,
    'a mismatched work ID and turn never gains the other task target',
  );
  assert.equal(
    Reflect.get(defined(model.queue[0]), 'replyTarget'),
    undefined,
    'an unregistered queued request cannot invent a persistent task target',
  );
});

test('registered tasks expose exact details identities before results and legacy call receipts stay chat-only', () => {
  for (const language of ['en', 'zh']) {
    const app = fixture({ language }),
      model = app.getModel(),
      item = model.items.find((item) => item.id === 'work-a'),
      document = parseHTML(renderWorkTaskHistory(defined(item), model.labels)).document,
      button = document.querySelector<HTMLDetailsElement>('[data-task-details]');
    assert.equal(defined(button).textContent, language === 'en' ? 'View task' : '查看任务详情');
    assert.deepEqual(
      { ...defined(button).dataset },
      { taskDetails: 'work-a', progressTurn: 'turn-a', progressConversation: 'conversation-a' },
    );
    assert.equal(document.querySelector<HTMLButtonElement>('[data-progress-message]'), null);
    assert.equal(defined(item).messageId, undefined);
  }
});
