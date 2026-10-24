import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import type { ApiOptions, Attachment, ChatMessage } from '../../../ui/shared/contracts.mts';
import { createOutgoingMessages } from '../../../ui/chat/outgoing.mts';
import { createMessageSubmissions } from '../../../ui/chat/pending.mts';
import { composerAttachmentScope } from '../../../ui/chat/composer-attachments.mts';
import { escapeHtml } from '../../../ui/shared/html.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import { sourceDeclaration } from '../../support/source-fixtures.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
function deferred() {
  let resolve: (value: unknown) => void = () => assert.fail('Uninitialized reply'),
    reject: (cause: unknown) => void = () => assert.fail('Uninitialized reply');
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const { document } = parseHTML('<html><body><main></main></body></html>'),
    state = {
      conversationId: 'conversation-a',
      settings: { language: 'en', vm: { host: 'computer-a', knownHosts: 'known-a' } },
      worker: { status: 'online' },
      messages: [{ id: 'quote-a', role: 'assistant', text: 'Quoted result' }] as ChatMessage[],
      call: null as { id: string; provider: string } | null,
    },
    file: Attachment = { id: 'file-a', name: 'Picture.png', type: 'image/png', size: 8 },
    reply = deferred(),
    requests: { route: string; body: unknown; options?: Pick<ApiOptions, 'beforeSend'> }[] = [];
  let sequence = 0;
  const submissions = createMessageSubmissions({
      newId: () => 'client-' + ++sequence,
      getScope: () => composerAttachmentScope(state),
    }),
    outgoing = createOutgoingMessages(),
    context = uiEntrypointFixture({
      document,
      state,
      currentState: () => state,
      unloading: false,
      eventConnected: true,
      updateInstalling: false,
      sending: false,
      uploading: 0,
      recording: null,
      recordStarting: false,
      recordDraft: null,
      composerDraft: 'Send this immediately',
      attachments: [file],
      replyTo: 'quote-a',
      messageSubmissions: submissions,
      outgoingMessages: outgoing,
      composerAttachmentScope,
      callStops: { pending: false },
      emojiFor: null,
      defaultReactions: [],
      dictating: false,
      speakingId: null,
      language: () => 'en',
      t: (key: string) => key,
      ico: (name: string) => `<svg data-icon="${name}"></svg>`,
      button: (action: string) => `<button data-action="${action}"></button>`,
      md: (text: string) => escapeHtml(text),
      renderDraftAttachment: (item: Attachment) => `<span>${escapeHtml(item.name)}</span>`,
      formatTime: () => '12:00',
      renderAttachments: (files: readonly Attachment[] | undefined) =>
        files?.map((item) => `<img alt="${escapeHtml(item.name)}">`).join('') ?? '',
      renderAssistantReadState: () => '',
      renderVoiceRecorder: () => '',
      renderUnreadControl: () => '',
      renderAttachmentOptions: () => '',
      speechBlocked: () => false,
      chatHistory: { renderEdited: () => '', renderActions: () => '' },
      managedSettings: { renderRequests: () => '' },
      taskReplies: {
        prepare: () => null,
        setPending() {},
        acknowledged() {},
        render: () => '',
        renderMessageReference: () => '',
      },
      toast() {},
      openProgress() {
        render();
      },
      api: async () => state,
      post(route: string, body: unknown, options?: Pick<ApiOptions, 'beforeSend'>) {
        requests.push({ route, body: structuredClone(body), ...(options ? { options } : {}) });
        return reply.promise;
      },
      render: () => render(),
    });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(
    [
      'function messageDate(',
      'function renderMessages(',
      'function renderOutgoingMessages(',
      'function renderChat(',
      'function renderUnconfirmedMessage(',
      'function reconcileOutgoingMessages(',
      'function clearSentDraft(',
      'async function checkUnconfirmedMessage(',
      'async function send(',
    ]
      .map((marker) => sourceDeclaration(source, marker))
      .join('\n'),
    context,
  );
  function render() {
    context.reconcileOutgoingMessages();
    const previous = document.querySelector<HTMLTextAreaElement>('#composer');
    if (previous) context.composerDraft = previous.value;
    defined(document.querySelector('main')).innerHTML = context.renderChat();
    const input = document.querySelector<HTMLTextAreaElement>('#composer');
    if (input) input.focus = () => {};
  }
  render();
  const canonical = (): ChatMessage => ({
    id: 'canonical-server-id',
    role: 'user',
    text: 'Send this immediately',
    clientMessageId: 'client-1',
    time: 1000,
    receivedAt: 1001,
    attachments: [file],
    replyTo: 'quote-a',
  });
  return {
    context,
    state,
    document,
    reply,
    requests,
    render,
    canonical,
    submissions,
    outgoing,
    input: () => defined(document.querySelector<HTMLTextAreaElement>('#composer')),
  };
}

test('actual Send immediately renders an outgoing bubble before delayed POST without inventing canonical identity or receipts', async () => {
  const f = fixture(),
    pending = f.context.send();
  const bubble = defined(f.document.querySelector<HTMLElement>('[data-outgoing-client-id]'));
  assert.equal(bubble.dataset.outgoingClientId, 'client-1');
  assert.match(bubble.textContent, /Send this immediately/);
  assert.match(bubble.textContent, /Quoted result/);
  assert.equal(bubble.querySelector('img')?.getAttribute('alt'), 'Picture.png');
  assert.equal(bubble.querySelector('.outgoing-state')?.textContent, 'Sending…');
  assert.equal(bubble.hasAttribute('data-id'), false);
  assert.equal(
    bubble.querySelector('time,button,[data-icon="check"],[data-icon="check-check"]'),
    null,
  );
  assert.equal(f.state.messages.length, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0]?.body, {
    conversationId: 'conversation-a',
    text: 'Send this immediately',
    attachments: ['file-a'],
    replyTo: 'quote-a',
    clientMessageId: 'client-1',
  });
  assert.equal(f.requests[0]?.options?.beforeSend?.(), true);
  f.reply.resolve({ submission: 'confirmed' });
  await pending;
});

test('POST acknowledgement before SSE keeps one sent projection until the matching canonical echo', async () => {
  const f = fixture(),
    pending = f.context.send();
  f.reply.resolve({ submission: 'confirmed' });
  await pending;
  assert.equal(f.input().value, '');
  assert.equal(f.document.querySelector('.outgoing-state')?.textContent, 'Sent · synchronizing…');
  f.state.messages.push(f.canonical());
  f.render();
  assert.equal(f.document.querySelectorAll('.message.user').length, 1);
  assert.equal(f.document.querySelector('[data-outgoing-client-id]'), null);
  assert.ok(f.document.querySelector('[data-id="canonical-server-id"]'));
  assert.equal(f.requests.length, 1);
});

test('SSE before a lost POST response acknowledges exactly once and preserves a typed follow-up', async () => {
  const f = fixture(),
    pending = f.context.send();
  f.input().value = 'New follow-up';
  f.state.messages.push(f.canonical());
  f.render();
  assert.equal(f.document.querySelectorAll('.message.user').length, 1);
  assert.equal(f.input().value, 'New follow-up');
  f.reply.reject(Object.assign(Error('lost response'), { unknownOutcome: true }));
  await pending;
  assert.equal(f.submissions.unknown, null);
  assert.equal(f.document.querySelector('.unconfirmed-send'), null);
  assert.equal(f.input().value, 'New follow-up');
  assert.equal(f.requests.length, 1);
});

test('uncertain POST keeps the original draft and outgoing uncertainty until matching SSE, without default retry', async () => {
  const f = fixture(),
    pending = f.context.send();
  f.reply.reject(Object.assign(Error('lost response'), { unknownOutcome: true }));
  await assert.rejects(pending, /sendUnknownHint/);
  assert.equal(f.input().value, 'Send this immediately');
  assert.equal(f.context.attachments.length, 1);
  assert.equal(f.context.replyTo, 'quote-a');
  assert.equal(f.document.querySelector('.outgoing-state')?.textContent, 'sendUnknown');
  await f.context.send();
  assert.equal(f.requests.length, 1);
  f.state.messages.push(f.canonical());
  f.render();
  assert.equal(f.submissions.unknown, null);
  assert.equal(f.input().value, '');
  assert.equal(f.document.querySelectorAll('.message.user').length, 1);
});

test('definitive rejection removes only the provisional display and retains text, attachment and quote for explicit retry', async () => {
  const f = fixture(),
    pending = f.context.send();
  f.reply.reject(Object.assign(Error('rejected'), { status: 409 }));
  await assert.rejects(pending, /rejected/);
  assert.equal(f.document.querySelector('[data-outgoing-client-id]'), null);
  assert.equal(f.input().value, 'Send this immediately');
  assert.equal(f.context.attachments.length, 1);
  assert.equal(f.context.replyTo, 'quote-a');
  assert.equal(
    f.submissions.prepare('/messages', {
      conversationId: 'conversation-a',
      text: 'Send this immediately',
      attachments: ['file-a'],
      replyTo: 'quote-a',
    }).clientMessageId,
    'client-1',
  );
});

test('conversation/computer/call switches fence dispatch and stale completion cannot clear the new target draft', async () => {
  for (const change of ['conversation', 'computer', 'call'] as const) {
    const f = fixture(),
      pending = f.context.send(),
      canSend = defined(f.requests[0]?.options?.beforeSend);
    if (change === 'conversation') f.state.conversationId = 'conversation-b';
    else if (change === 'computer') f.state.settings.vm.knownHosts = 'known-b';
    else f.state.call = { provider: 'subscription', id: 'new-call' };
    assert.equal(canSend(), false, change);
    f.input().value = 'Draft for new target';
    f.render();
    if (change !== 'call')
      assert.equal(f.document.querySelector('[data-outgoing-client-id]'), null);
    f.reply.resolve({ submission: 'confirmed' });
    await pending;
    if (change !== 'call') {
      assert.equal(f.input().value, 'Draft for new target');
      assert.equal(f.context.attachments.length, 1);
      assert.equal(f.context.replyTo, 'quote-a');
    }
  }
});

test('unknown outcomes remain bound to their original scope rather than blocking or clearing a different conversation', async () => {
  const f = fixture(),
    pending = f.context.send();
  f.state.conversationId = 'conversation-b';
  f.input().value = 'Different conversation draft';
  f.reply.reject(Object.assign(Error('lost'), { unknownOutcome: true }));
  await pending;
  assert.equal(f.submissions.unknown, null);
  assert.equal(f.input().value, 'Different conversation draft');
  f.state.conversationId = 'conversation-a';
  f.render();
  assert.equal(f.submissions.find([{ clientMessageId: 'client-1' }])?.clientMessageId, 'client-1');
  assert.equal(f.document.querySelector('.outgoing-state')?.textContent, 'sendUnknown');
});

test('an uncertain successful HTTP reply is checked by identity without another submission', async () => {
  const f = fixture(),
    pending = f.context.send();
  f.reply.resolve({ unknownOutcome: true });
  await assert.rejects(pending, /sendUnknownHint/);
  f.state.messages.push(f.canonical());
  await f.context.checkUnconfirmedMessage();
  assert.equal(f.requests.length, 1);
  assert.equal(f.submissions.unknown, null);
  assert.equal(f.document.querySelectorAll('.message.user').length, 1);
  assert.equal(f.document.querySelector('[data-outgoing-client-id]'), null);
});

test('a late explicit outcome check cannot adopt old state or clear a different target draft', async () => {
  const f = fixture(),
    pending = f.context.send();
  f.reply.reject(Object.assign(Error('lost'), { unknownOutcome: true }));
  await assert.rejects(pending, /sendUnknownHint/);
  const get = deferred(),
    old = structuredClone(f.state);
  old.messages.push(f.canonical());
  f.context.api = () => get.promise;
  const checking = f.context.checkUnconfirmedMessage();
  f.state.conversationId = 'conversation-b';
  f.input().value = 'New target draft';
  get.resolve(old);
  await checking;
  assert.equal(f.context.state.conversationId, 'conversation-b');
  assert.equal(f.input().value, 'New target draft');
  assert.equal(f.context.attachments.length, 1);
  assert.equal(f.requests.length, 1);
});

test('acknowledgement does not remove a replacement attachment object with the same ID', async () => {
  const f = fixture(),
    pending = f.context.send(),
    replacement = { ...defined(f.context.attachments[0]), name: 'Replacement.png' };
  f.context.attachments = [replacement];
  f.reply.resolve({ submission: 'confirmed' });
  await pending;
  assert.equal(f.context.attachments[0], replacement);
});

test('a delayed canonical echo does not clear a new identical draft after the POST already acknowledged it', async () => {
  const f = fixture(),
    original = defined(f.context.attachments[0]),
    pending = f.context.send();
  f.reply.resolve({ submission: 'confirmed' });
  await pending;
  assert.equal(f.input().value, '');
  f.input().value = 'Send this immediately';
  f.context.attachments = [original];
  f.context.replyTo = 'quote-a';
  f.state.messages.push(f.canonical());
  f.render();
  assert.equal(f.input().value, 'Send this immediately');
  assert.equal(f.context.attachments[0], original);
  assert.equal(f.context.replyTo, 'quote-a');
  assert.equal(f.document.querySelectorAll('.message.user').length, 1);
});

test('a delayed POST acknowledgement does not clear a new identical draft after the canonical echo already consumed it', async () => {
  const f = fixture(),
    original = defined(f.context.attachments[0]),
    pending = f.context.send();
  f.state.messages.push(f.canonical());
  f.render();
  assert.equal(f.input().value, '');
  f.input().value = 'Send this immediately';
  f.context.attachments = [original];
  f.context.replyTo = 'quote-a';
  f.reply.resolve({ submission: 'confirmed' });
  await pending;
  assert.equal(f.input().value, 'Send this immediately');
  assert.equal(f.context.attachments[0], original);
  assert.equal(f.context.replyTo, 'quote-a');
  assert.equal(f.document.querySelectorAll('.message.user').length, 1);
});

test('connection-changing and update admission immediately reject the captured dispatch without inventing delivery', async () => {
  const f = fixture(),
    pending = f.context.send(),
    canSend = defined(f.requests[0]?.options?.beforeSend),
    actions = defined(f.context.pendingActions);
  for (const action of ['connect', 'import-vm']) {
    actions.add(action);
    assert.equal(canSend(), false);
    actions.delete(action);
  }
  f.context.updateInstalling = true;
  assert.equal(canSend(), false);
  f.context.updateInstalling = false;
  actions.add('takeover');
  assert.equal(
    canSend(),
    true,
    'same-target human-control changes are handled by backend admission',
  );
  f.reply.reject(Object.assign(Error('target changed before send'), { status: 409 }));
  await assert.rejects(pending, /target changed/);
  assert.equal(f.input().value, 'Send this immediately');
});
