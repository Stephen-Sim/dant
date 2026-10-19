import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import {
  createMessageWindow,
  messageHistoryScope,
  RECENT_MESSAGE_LIMIT,
  OLDER_MESSAGE_BATCH_SIZE,
} from '../../../ui/chat/message-window.mts';
import { languages } from '../../../src/i18n/languages.mts';
import { registerLocale } from '../../../src/i18n/i18n.mts';
import { isRecord } from '../../../ui/shared/contracts.mts';
import { defined } from '../../support/fixture-assertions.mts';

const messages = Array.from({ length: 623 }, (_, index) => ({ id: 'message-' + index }));

test('opening a long conversation renders only its recent window and scrolling prepends explicit batches', () => {
  const window = createMessageWindow();
  assert.deepEqual(window.select(messages, 'conversation'), messages.slice(-RECENT_MESSAGE_LIMIT));
  assert.equal(window.loadOlder(messages, 'conversation'), true);
  assert.deepEqual(
    window.select(messages, 'conversation'),
    messages.slice(-RECENT_MESSAGE_LIMIT - OLDER_MESSAGE_BATCH_SIZE),
  );
  for (let index = 0; index < 8; index++) window.loadOlder(messages, 'conversation');
  assert.deepEqual(window.select(messages, 'conversation'), messages);
  assert.equal(window.loadOlder(messages, 'conversation'), false);
  assert.equal(window.control(messages, 'conversation', 'en'), '');
  assert.equal(messages.length, 623, 'windowing never removes records from application state');
});

test('new messages keep the default window bounded, preserve expanded history, and identity changes reset it', () => {
  const window = createMessageWindow(),
    scope = messageHistoryScope({
      conversationId: 'one',
      settings: { vm: { host: 'vm-a', user: 'user' } },
    }),
    appended = [...messages, { id: 'new-message' }];
  window.select(messages, scope);
  assert.deepEqual(window.select(appended, scope), appended.slice(-RECENT_MESSAGE_LIMIT));
  window.loadOlder(appended, scope);
  const expanded = window.select(appended, scope);
  assert.deepEqual(window.select([...appended, { id: 'another' }], scope), [
    ...expanded,
    { id: 'another' },
  ]);
  const otherVm = messageHistoryScope({
    conversationId: 'one',
    settings: { vm: { host: 'vm-b', user: 'user' } },
  });
  assert.notEqual(scope, otherVm);
  assert.deepEqual(window.select(appended, otherVm), appended.slice(-RECENT_MESSAGE_LIMIT));
  window.loadOlder(appended, otherVm);
  assert.deepEqual(
    window.select(appended, 'other-conversation'),
    appended.slice(-RECENT_MESSAGE_LIMIT),
  );
  assert.deepEqual(window.select([], 'other-conversation'), []);
  assert.deepEqual(
    window.select(messages, 'other-conversation'),
    messages.slice(-RECENT_MESSAGE_LIMIT),
  );
  assert.equal(messageHistoryScope(null), messageHistoryScope({}));
  window.dispose();
  assert.deepEqual(
    window.select(messages, 'other-conversation'),
    messages.slice(-RECENT_MESSAGE_LIMIT),
  );
});

test('search, unread and task-result navigation can reveal an exact older target without inventing a missing message', () => {
  const window = createMessageWindow();
  window.select(messages, 'conversation');
  assert.equal(window.reveal('missing', messages, 'conversation'), false);
  assert.equal(window.select(messages, 'conversation').length, RECENT_MESSAGE_LIMIT);
  assert.equal(window.reveal('message-10', messages, 'conversation'), true);
  assert.equal(window.select(messages, 'conversation')[0]?.id, 'message-10');
  assert.equal(window.reveal('message-622', messages, 'conversation'), true);
  assert.equal(window.select(messages, 'conversation')[0]?.id, 'message-10');
});

test('top scrolling and the native keyboard button request one older batch, with no duplicate handlers after a re-render', () => {
  const window = createMessageWindow(),
    { document, Event } = parseHTML('<div id="messages"></div><div id="replacement"></div>'),
    root = defined(document.querySelector<HTMLElement>('#messages'));
  let top = 500,
    loads = 0;
  Object.defineProperties(root, {
    scrollTop: { get: () => top },
    scrollHeight: { value: 2_000 },
    clientHeight: { value: 500 },
  });
  root.innerHTML = window.control(messages, 'conversation', 'en');
  const load = () => {
    if (window.loadOlder(messages, 'conversation')) loads++;
  };
  window.bind(root, load);
  window.bind(root, load);
  root.dispatchEvent(new Event('scroll'));
  assert.equal(loads, 0);
  top = 80;
  root.dispatchEvent(new Event('scroll'));
  assert.equal(loads, 1);
  const button = defined(root.querySelector<HTMLButtonElement>('[data-load-older]'));
  assert.equal(button.type, 'button');
  button.click();
  assert.equal(loads, 2);
  window.bind(document.querySelector<HTMLElement>('#replacement'), load);
  root.dispatchEvent(new Event('scroll'));
  assert.equal(loads, 2);
  window.bind(root, load);
  window.dispose();
  root.dispatchEvent(new Event('scroll'));
  assert.equal(loads, 2);
});

test('earlier-history controls use all supported interface languages and never translate message content', () => {
  for (const language of languages) {
    if (!['en', 'zh'].includes(language.code)) {
      const catalog: unknown = JSON.parse(
        fs.readFileSync(
          new URL(`../../../src/i18n/locales/${language.code}.json`, import.meta.url),
          'utf8',
        ),
      );
      assert.ok(isRecord(catalog));
      registerLocale(language.code, catalog);
    }
    const window = createMessageWindow(),
      { document } = parseHTML(window.control(messages, 'conversation', language.code)),
      button = defined(document.querySelector<HTMLButtonElement>('[data-load-older]'));
    assert.ok(button.textContent);
    if (language.code !== 'en') assert.notEqual(button.textContent, 'Load earlier messages');
    assert.deepEqual(
      window.select(messages, 'conversation'),
      messages.slice(-RECENT_MESSAGE_LIMIT),
    );
  }
});

test('new arrivals preserve the visible anchor while reading the middle of the recent 623-message history', () => {
  const window = createMessageWindow(),
    { document, Event } = parseHTML('<div id="messages"></div>'),
    root = defined(document.querySelector<HTMLElement>('#messages'));
  let top = 0;
  Object.defineProperties(root, {
    scrollTop: { get: () => top },
    clientHeight: { value: 400 },
    scrollHeight: { get: () => root.querySelectorAll('article').length * 40 },
  });
  const render = (records: readonly { id: string }[], scope = 'conversation') => {
    root.innerHTML = window
      .select(records, scope)
      .map((message) => `<article data-id="${message.id}"></article>`)
      .join('');
    window.bind(root, () => {
      if (window.loadOlder(records, scope)) render(records, scope);
    });
  };
  render(messages);
  assert.equal(root.querySelectorAll('article').length, RECENT_MESSAGE_LIMIT);
  top = root.scrollHeight - root.clientHeight;
  const initialAppend = [...messages, { id: 'new-at-bottom' }];
  render(initialAppend);
  assert.equal(
    root.querySelectorAll('article').length,
    RECENT_MESSAGE_LIMIT,
    'bottom-following stays bounded',
  );
  top = 600;
  root.dispatchEvent(new Event('scroll'));
  const anchor = root.querySelectorAll('article')[Math.floor(top / 40)]?.getAttribute('data-id'),
    arrivals = [
      ...initialAppend,
      ...Array.from({ length: 100 }, (_, index) => ({ id: 'incoming-' + index })),
    ];
  render(arrivals);
  assert.ok(anchor);
  assert.equal(
    root.querySelectorAll('article')[Math.floor(top / 40)]?.getAttribute('data-id'),
    anchor,
  );
  assert.equal(root.querySelectorAll('article').length, RECENT_MESSAGE_LIMIT + 100);
  render(arrivals, 'different-conversation');
  assert.equal(
    root.querySelectorAll('article').length,
    RECENT_MESSAGE_LIMIT,
    'old viewport metrics cannot pin another conversation',
  );
});
