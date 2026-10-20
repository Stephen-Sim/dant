import type { Attachment, ChatMessage } from '../../../ui/shared/contracts.mts';
import { searchMessages } from '../../../ui/chat/chat-search.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection } from '../../support/source-fixtures.mts';
import { languageInfo } from '../../../ui/i18n/languages.mts';
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
import { defaultReactions } from '../../../ui/chat/reactions.mts';
import { canPreviewFile } from '../../../ui/files/file-preview.mts';
import { messageHistoryScope, RECENT_MESSAGE_LIMIT } from '../../../ui/chat/message-window.mts';
import postcss from 'postcss';
import { readAppState } from '../../../ui/app/application-state.mts';

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

test('Go omitted-text attachment and call history passes the state boundary and actual message renderer', () => {
  const wire = {
      settings: { vm: {}, language: 'en' },
      worker: { status: 'offline', models: [] },
      messages: [
        { id: 'text', role: 'assistant', text: 'History remains visible', time: at },
        {
          id: 'image',
          role: 'assistant',
          attachments: [{ id: 'photo', name: 'Screenshot.png', type: 'image/png' }],
          time: at + 1000,
        },
        { id: 'call', role: 'user', kind: 'call', seconds: 75, time: at + 2000 },
      ],
    },
    f = fixture(),
    decoded = readAppState(wire);
  f.state.messages = decoded.messages;
  f.render();
  assert.equal(f.document.querySelectorAll('article.message').length, 2);
  assert.equal(f.document.querySelectorAll('.image-attachment img').length, 1);
  assert.equal(f.document.querySelectorAll('.call-log').length, 1);
  assert.match(
    f.document.querySelector('[data-id="text"]')?.textContent ?? '',
    /History remains visible/,
  );
  assert.match(f.document.querySelector('[data-id="call"]')?.textContent ?? '', /1:15/);
  assert.equal(Object.hasOwn(wire.messages[1] ?? {}, 'text'), false);
});

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

test('call history menus stay beside the capsule without occupying its inline-end edge', () => {
  const rules = new Map<string, Map<string, string>>();
  postcss
    .parse(fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'))
    .walkRules((rule) => {
      let values = rules.get(rule.selector);
      if (!values) rules.set(rule.selector, (values = new Map()));
      rule.walkDecls((declaration) => {
        values.set(declaration.prop, declaration.value);
      });
    });
  for (const [language, direction] of [
    ['en', 'ltr'],
    ['ar', 'rtl'],
  ]) {
    const f = fixture(language);
    f.document.documentElement.setAttribute('dir', defined(direction));
    f.state.messages = [{ id: 'call-exact', kind: 'call', seconds: 75, time: at }];
    f.render();
    const call = defined(f.document.querySelector('.call-log')),
      capsule = defined(call.querySelector(':scope > span')),
      toolbar = defined(call.querySelector(':scope > .message-actions')),
      menu = defined(toolbar.querySelector<HTMLButtonElement>('[data-message-more]'));
    assert.match(capsule.textContent, /1:15/);
    assert.equal(capsule.querySelector('button'), null);
    assert.equal(toolbar.getAttribute('role'), 'toolbar');
    assert.equal(menu.dataset.messageMore, 'call-exact');
    assert.equal(menu.getAttribute('aria-haspopup'), 'menu');
    assert.ok(menu.getAttribute('aria-label'));
    // Both directions use the same inline-end alignment. An invisible menu
    // must precede the capsule in flex order rather than reserve its edge.
    assert.equal(rules.get('.call-log')?.get('justify-content'), 'flex-end');
    assert.ok(
      Number(rules.get('.call-log > .message-actions')?.get('order') ?? 0) <
        Number(rules.get('.call-log > span')?.get('order') ?? 0),
    );
    assert.equal(rules.get('.call-log > .message-actions')?.has('left'), false);
    assert.equal(rules.get('.call-log > .message-actions')?.has('right'), false);
  }
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

test('the actual message renderer builds recent history first while keeping replies to hidden messages intact', () => {
  const f = fixture();
  let renders = 0;
  f.c.md = (text) => {
    renders++;
    return text;
  };
  f.state.messages = Array.from({ length: 623 }, (_, index) => ({
    id: 'message-' + index,
    role: index % 2 ? 'user' : 'assistant',
    text: 'Message ' + index,
    status: 'completed',
    time: at + index * 1_000,
    ...(index === 622 ? { replyTo: 'message-0' } : {}),
  }));
  f.render();
  assert.equal(f.document.querySelectorAll('.message').length, RECENT_MESSAGE_LIMIT);
  assert.equal(renders, RECENT_MESSAGE_LIMIT);
  assert.equal(f.document.querySelector('[data-id="message-0"]'), null);
  assert.match(
    defined(f.document.querySelector('[data-id="message-622"] blockquote')).textContent,
    /Message 0/,
  );
  assert.equal(f.state.messages.length, 623);
  const window = defined(f.c.messageWindow),
    scope = messageHistoryScope(f.state);
  window.loadOlder(f.state.messages, scope);
  f.render();
  assert.equal(f.document.querySelectorAll('.message').length, RECENT_MESSAGE_LIMIT * 2);
  window.reveal('message-10', f.state.messages, scope);
  f.render();
  assert.ok(f.document.querySelector('[data-id="message-10"]'));
});

test('paused status, delivery ticks and hover time occupy separate wrapping footer slots', () => {
  for (const language of ['en', 'zh']) {
    const f = fixture(language);
    f.state.messages = [
      {
        id: 'paused',
        role: 'user',
        text: 'Continue',
        status: 'paused',
        executorConfirmedAt: at,
        time: at,
      },
    ];
    f.render();
    const footer = defined(f.document.querySelector('.message-meta')),
      status = defined(footer.querySelector('.task-status')),
      delivery = defined(footer.querySelector('.delivery-state')),
      time = defined(footer.querySelector('.message-time'));
    assert.equal(status.parentNode, footer);
    assert.equal(status.nextElementSibling, delivery);
    assert.equal(delivery.nextElementSibling, time);
    assert.equal(status.textContent, language === 'en' ? 'Paused' : '已暂停');
    assert.ok(delivery.querySelector('[data-icon="check-check"]'));
    assert.equal(time.textContent, f.c.formatTime(at));
  }
  const rules = new Map<string, Map<string, string>>();
  postcss
    .parse(fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'))
    .walkRules((rule) => {
      let values = rules.get(rule.selector);
      if (!values) rules.set(rule.selector, (values = new Map()));
      rule.walkDecls((declaration) => {
        values.set(declaration.prop, declaration.value);
      });
    });
  assert.equal(rules.get('.message-meta')?.get('display'), 'flex');
  assert.equal(rules.get('.message-meta')?.get('flex-wrap'), 'wrap');
  assert.equal(rules.get('.message-meta')?.get('gap'), '3px 8px');
  assert.notEqual(rules.get('.message-time')?.get('position'), 'absolute');
  assert.equal(rules.get('.message-time')?.get('flex'), '0 0 auto');
  assert.equal(rules.get('.task-status')?.get('overflow-wrap'), 'anywhere');
  assert.equal(rules.get('.task-status')?.get('max-width'), '100%');
});
