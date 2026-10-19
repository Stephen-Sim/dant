import type { Attachment, ChatMessage } from '../../../ui/shared/contracts.mts';
import { searchMessages } from '../../../ui/chat/chat-search.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection } from '../../support/source-fixtures.mts';
import { languageInfo } from '../../../src/i18n/languages.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import { createTaskReplyController } from '../../../ui/work/task-reply.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { formatCallDuration } from '../../../ui/call/call-duration.mts';
import { createChatHistory } from '../../../ui/chat/chat-history.mts';
import { defaultReactions } from '../../../src/conversation/reactions.mts';
import { canPreviewFile } from '../../../ui/files/file-preview.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
  part = (start: string, end: string) => sourceSection(source, start, end);
interface FixtureMessage extends Omit<Partial<ChatMessage>, 'id' | 'time'> {
  id: string;
  time?: unknown;
}
const at = Date.parse('2026-10-17T12:15:00Z');
function fixture(language = 'en', theme = 'light') {
  const { document } = parseHTML('<html><body><main id="app"></main></body></html>'),
    state = { settings: { language }, messages: [] as FixtureMessage[] };
  document.documentElement.dataset.theme = theme;
  const c = uiEntrypointFixture({
    canPreviewFile,
    state,
    document,
    formatCallDuration,
    defaultReactions,
    fallbackLanguage: language,
    emojiFor: null,
    speakingId: null,
    recording: null,
    recordStarting: false,
    speechBlocked: () => false,
    unknownTask: () => false,
    md: (value: unknown) => String(value),
    fileURL: (file: Attachment) => '/files/' + file.id,
    ico: (name: string) => `<svg data-icon="${name}"></svg>`,
    errorText: (value: unknown) => String(value),
  });
  Object.assign(c, {
    chatHistory: createChatHistory({
      getState: () => ({ settings: state.settings }),
      document,
      icon: c.ico,
      request: async () => {
        throw Error('Unexpected history request');
      },
      render() {},
      toast() {},
      openModal() {},
      closeModal() {},
      searchMessages,
    }),
  });
  c.taskReplies ??= createTaskReplyController({ document: c.document, getModel: () => ({}) });
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(
    stripTypeScriptTypes(
      part('function currentState(', 'const subscriptionVoiceUnavailable=') +
        '\n' +
        '' +
        '\n' +
        part('function unreadAssistant(', 'function revealMessage(){') +
        '\n' +
        part('function formatTime(', 'function renderComputer(){'),
    ),
    c,
  );
  return {
    c,
    state,
    document,
    render() {
      const template = document.createElement('template');
      template.innerHTML = c.renderMessages();
      reconcile(defined(document.querySelector<HTMLElement>('#app')), template.content);
    },
  };
}

test('nearby text and attachment messages share one localized divider while retaining receipts', () => {
  for (const language of ['en', 'zh'])
    for (const theme of ['light', 'dark']) {
      const f = fixture(language, theme);
      f.state.messages = [
        {
          id: 'user',
          role: 'user',
          text: 'Question',
          status: 'review',
          time: at,
          executorConfirmedAt: at + 9000,
        },
        { id: 'text', role: 'assistant', text: 'Answer', status: 'completed', time: at + 1000 },
        {
          id: 'image',
          role: 'assistant',
          text: '',
          status: 'completed',
          time: at + 2000,
          attachments: [{ id: 'photo', name: 'Screenshot.png', type: 'image/png' }],
        },
        {
          id: 'file',
          role: 'assistant',
          text: '',
          status: 'completed',
          time: at + 3000,
          attachments: [{ id: 'report', name: 'Report.pdf', type: 'application/pdf' }],
        },
        {
          id: 'audio',
          role: 'assistant',
          text: '',
          status: 'completed',
          time: at + 4000,
          attachments: [{ id: 'clip', name: 'Voice.wav', type: 'audio/wav' }],
        },
      ];
      f.render();
      assert.equal(f.document.querySelectorAll<HTMLElement>('time.message-time').length, 5);
      assert.equal(f.document.querySelectorAll<HTMLElement>('.time-divider').length, 1);
      assert.equal(
        defined(f.document.querySelector<HTMLElement>('.time-divider')).textContent,
        f.c.formatTime(at, true),
      );
      for (const message of f.state.messages) {
        const article = f.document.querySelector<HTMLButtonElement>(`[data-id="${message.id}"]`),
          stamp = defined(article).querySelector<HTMLElement>('.message-meta>time.message-time'),
          full = new Intl.DateTimeFormat(languageInfo(language).locale, {
            dateStyle: 'medium',
            timeStyle: 'medium',
          }).format(new Date(typeof message.time === 'number' ? message.time : NaN));
        assert.equal(typeof message.time, 'number');
        assert.ok(stamp);
        assert.equal(stamp.textContent, f.c.formatTime(message.time));
        assert.equal(
          stamp.getAttribute('datetime'),
          new Date(typeof message.time === 'number' ? message.time : NaN).toISOString(),
        );
        assert.equal(stamp.getAttribute('aria-label'), full);
        assert.equal(defined(stamp.parentElement).lastElementChild, stamp);
        assert.equal(stamp.hasAttribute('title'), false);
        assert.equal(
          defined(defined(article).querySelector<HTMLElement>('.bubble')).hasAttribute('title'),
          false,
        );
      }
      assert.equal(
        f.document.querySelector<HTMLButtonElement>('[data-id="text"] .delivery-state'),
        null,
      );
      assert.ok(
        f.document.querySelector<HTMLButtonElement>(
          '[data-id="user"] .delivery-state [data-icon="check-check"]',
        ),
      );
      assert.ok(
        f.document.querySelector<HTMLButtonElement>('[data-id="text"] .message-read-state'),
      );
      assert.equal(
        f.document.querySelector<HTMLButtonElement>('[data-id="user"] .task-status.review'),
        null,
      );
    }
});

test('editing, streaming and reaction refreshes retain the group divider and audio playback nodes', () => {
  const f = fixture();
  f.state.messages = [
    {
      id: 'user',
      role: 'user',
      text: 'Original',
      status: 'completed',
      time: at,
      reactions: ['👍'],
    },
    {
      id: 'reply',
      role: 'assistant',
      text: 'A streamed response',
      status: 'streaming',
      time: at + 1000,
      replyTo: 'user',
      attachments: [{ id: 'clip', name: 'Voice.ogg', type: 'audio/ogg' }],
    },
  ];
  f.render();
  const audio = f.document.querySelector<HTMLAudioElement>('audio'),
    divider = f.document.querySelector<HTMLElement>('.time-divider'),
    original = defined(divider).textContent,
    stamp = f.document.querySelector<HTMLButtonElement>('[data-id="user"] .message-time');
  defined(f.state.messages[0]).text = 'Edited';
  defined(f.state.messages[0]).editedAt = at + 86400000;
  defined(f.state.messages[1]).text += ' continues';
  defined(f.state.messages[1]).status = 'completed';
  f.render();
  assert.equal(f.document.querySelector<HTMLElement>('.time-divider'), divider);
  assert.equal(defined(divider).textContent, original);
  assert.equal(defined(f.state.messages[0]).time, at);
  assert.equal(f.document.querySelectorAll<HTMLElement>('.message-time').length, 2);
  assert.equal(
    f.document.querySelector<HTMLButtonElement>('[data-id="user"] .message-time'),
    stamp,
  );
  assert.equal(defined(stamp).getAttribute('datetime'), new Date(at).toISOString());
  assert.equal(defined(stamp).textContent, f.c.formatTime(at));
  assert.ok(f.document.querySelector<HTMLElement>('.edited-label'));
  assert.equal(f.document.querySelector<HTMLAudioElement>('audio'), audio);
  assert.ok(f.document.querySelector<HTMLButtonElement>('[data-reply="reply"]'));
  assert.ok(f.document.querySelector<HTMLButtonElement>('.reactions [data-emoji="👍"]'));
  assert.match(
    defined(f.document.querySelector<HTMLButtonElement>('[data-id="reply"] blockquote'))
      .textContent,
    /Edited/,
  );
  assert.equal(f.document.querySelector<HTMLElement>('.stream-cursor'), null);
});

test('day and long-gap separators remain visible alongside the call duration', () => {
  const f = fixture();
  f.state.messages = [
    { id: 'a', role: 'assistant', text: 'One', time: at },
    { id: 'b', role: 'assistant', text: 'Two', time: at + 60000 },
    { id: 'gap', role: 'user', text: 'Later', time: at + 1900000 },
    { id: 'call', kind: 'call', seconds: 75, time: at + 1960000 },
    { id: 'tomorrow', role: 'assistant', text: 'Next day', time: at + 86400000 },
  ];
  f.render();
  assert.equal(f.document.querySelectorAll<HTMLElement>('.time-divider').length, 3);
  assert.equal(f.document.querySelectorAll<HTMLElement>('.message-time').length, 4);
  assert.match(defined(f.document.querySelector<HTMLElement>('.call-log')).textContent, /1:15/);
  assert.equal(f.document.querySelector<HTMLElement>('.call-log .message-time'), null);
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('.call-log>span')).getAttribute('title'),
    new Intl.DateTimeFormat(languageInfo('en').locale, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(at + 1960000)),
  );
  assert.ok(f.document.querySelector<HTMLButtonElement>('[data-key="time-gap"]'));
  assert.ok(f.document.querySelector<HTMLButtonElement>('[data-key="time-tomorrow"]'));
});

test('missing and invalid times remain blank without fabricating a current or epoch timestamp', () => {
  const f = fixture();
  f.state.messages = [undefined, null, '', '   ', false, NaN, Infinity, 'not-a-date', {}, []].map(
    (time, index) => ({ id: 'invalid-' + index, role: 'assistant', text: 'Saved message', time }),
  );
  f.state.messages.push(
    { id: 'valid', role: 'assistant', text: 'Valid', time: at },
    { id: 'missing', role: 'user', text: 'Unknown time' },
    { id: 'after', role: 'assistant', text: 'Still same group', time: at + 1000 },
  );
  f.render();
  assert.equal(f.document.querySelectorAll<HTMLElement>('.message-time').length, 2);
  assert.deepEqual(
    [...f.document.querySelectorAll<HTMLElement>('.message-time')].map(
      (node) => defined(node.closest<HTMLElement>('.message')).dataset.id,
    ),
    ['valid', 'after'],
  );
  assert.equal(f.document.querySelectorAll<HTMLElement>('.time-divider').length, 1);
  assert.doesNotMatch(
    defined(f.document.querySelector<HTMLElement>('#app')).textContent,
    /Invalid Date|1970|NaN/,
  );
  assert.equal(f.c.formatTime(null), '');
  assert.equal(f.c.formatTime(''), '');
  assert.equal(f.c.formatTime(false), '');
  assert.equal(f.c.formatTime('2026-10-17T12:15:00Z', true), f.c.formatTime(at, true));
});
