import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { reconcile } from '../ui/shared/dom.js';
import { createChatHistory, historyMessages } from '../ui/chat/chat-history.js';
import { searchMessages } from '../ui/chat/chat-search.js';

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};
function fixture(language = 'en', speechOptions = {}) {
  const { document, Event } = parseHTML('<main id="app"></main>'),
    app = document.querySelector('#app'),
    requests = [],
    toasts = [],
    navigation = [],
    state = {
      settings: { language },
      worker: { status: 'online' },
      messages: [
        {
          id: 'user',
          role: 'user',
          text: 'Original 中文 text',
          status: 'queued',
          time: 1,
          attachments: [],
        },
        {
          id: 'assistant',
          role: 'assistant',
          text: 'A reply <img src=x onerror=bad>',
          status: 'completed',
          time: 2,
          attachments: [{ name: 'Report.pdf' }],
        },
      ],
      credentials: { items: [{ name: 'kept' }] },
      skills: { items: [{ name: 'kept' }] },
      memory: 'kept',
      threadId: 'same-thread',
    };
  let ui,
    modal = null,
    call = false,
    fail = null,
    scrolled = null;
  const render = () => {
    const template = document.createElement('template');
    template.innerHTML =
      '<button data-chat-search>Search</button>' +
      state.messages
        .map(
          (message) =>
            `<article data-id="${message.id}"><div class="message-actions">${ui.renderActions(message)}</div>${ui.renderEdited(message)}</article>`,
        )
        .join('') +
      ui.renderSettings() +
      (ui.renderModal(modal) || '');
    for (const textarea of template.content.querySelectorAll('textarea')) {
      const decoder = document.createElement('div');
      decoder.innerHTML = textarea.textContent;
      textarea.textContent = decoder.textContent;
    }
    reconcile(app, template.content);
    document.querySelectorAll('article').forEach(
      (node) =>
        (node.scrollIntoView = (options) => {
          scrolled = { id: node.dataset.id, options };
        }),
    );
    ui.bind();
    ui.bindModal(modal);
    document
      .querySelectorAll('[data-action="close-modal"]')
      .forEach((node) => (node.onclick = closeModal));
  };
  function closeModal() {
    navigation.push('close');
    ui.onClose();
    modal = null;
    render();
  }
  const request = async (route, options = {}) => {
    requests.push({ route, ...structuredClone(options) });
    if (fail?.(route, options)) throw Error('Busy current task');
    if (route === '/state') return state;
    if (route === '/history') {
      state.messages = [];
      return { cleared: true };
    }
    const id = route.split('/').at(-1),
      message = state.messages.find((item) => item.id === id);
    if (options.method === 'DELETE')
      state.messages = state.messages.filter((item) => item.id !== id);
    else if (options.method === 'PATCH') {
      Object.assign(message, { text: options.body.text, editedAt: 3 });
    }
    return { ok: true };
  };
  ui = createChatHistory({
    getState: () => state,
    request,
    render,
    toast: (value) => toasts.push(value),
    openModal: (value) => {
      modal = value;
      render();
    },
    closeModal,
    revealMessage: (id) => {
      assert.equal(modal, null, 'close the search dialog before revealing chat');
      assert.equal(scrolled, null, 'reveal chat before scrolling a search hit');
      navigation.push('reveal:' + id);
      render();
    },
    document,
    callActive: () => call,
    searchMessages,
    icon: (name) => '<svg>' + name + '</svg>',
    ...speechOptions,
  });
  render();
  return {
    ui,
    document,
    state,
    requests,
    toasts,
    navigation,
    get modal() {
      return modal;
    },
    get scrolled() {
      return scrolled;
    },
    set call(value) {
      call = value;
    },
    set fail(value) {
      fail = value;
    },
    render,
    closeModal,
    async click(selector) {
      const node = document.querySelector(selector);
      assert.ok(node, selector);
      node.dispatchEvent(new Event('click', { bubbles: true }));
      await settle();
    },
    input(selector, value) {
      const node = document.querySelector(selector);
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    },
    async submit() {
      document
        .querySelector('#message-edit-form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await settle();
    },
  };
}

test('history menus and confirmation text are bilingual and keep model context and protected data explicit', async () => {
  assert.deepEqual(Object.keys(historyMessages.zh).sort(), Object.keys(historyMessages.en).sort());
  for (const words of Object.values(historyMessages))
    for (const word of Object.values(words)) assert.ok(word.trim());
  for (const language of ['zh', 'en']) {
    const f = fixture(language);
    await f.click('[data-message-more="user"]');
    assert.ok(f.document.querySelector('[data-message-edit="user"]'));
    assert.match(
      f.document.querySelector('[data-message-remove="user"]').textContent,
      language === 'zh' ? /撤回/ : /Withdraw/,
    );
    await f.click('[data-message-more="assistant"]');
    assert.equal(f.document.querySelector('[data-message-edit="assistant"]'), null);
    await f.click('[data-history-clear]');
    assert.equal(f.requests.length, 0, 'opening confirmation is read only');
    assert.match(
      f.document.querySelector('.history-dialog').textContent,
      language === 'zh' ? /模型会话与上下文保留/ : /model session and context/,
    );
    assert.match(
      f.document.querySelector('.history-dialog').textContent,
      language === 'zh' ? /凭据、技能和记忆不变/ : /credentials, skills and memory stay/,
    );
  }
});

test('editing defaults to record-only save; sending again requires its separate explicit button', async () => {
  const f = fixture();
  await f.click('[data-message-more="user"]');
  await f.click('[data-message-edit="user"]');
  f.input('#message-edit-form textarea', 'Edited 中文');
  f.render();
  assert.equal(f.document.querySelector('#message-edit-form textarea').value, 'Edited 中文');
  await f.submit();
  assert.deepEqual(f.requests[0], {
    route: '/messages/user',
    method: 'PATCH',
    body: { text: 'Edited 中文', resubmit: false },
  });
  assert.equal(f.modal, null);
  assert.equal(f.document.querySelector('.edited-label').textContent, 'Edited');
  assert.equal(f.state.threadId, 'same-thread');
  assert.equal(f.requests.filter((item) => item.route === '/messages').length, 0);
  await f.click('[data-message-more="user"]');
  await f.click('[data-message-edit="user"]');
  f.input('#message-edit-form textarea', 'Please do this');
  await f.click('[data-history-resubmit]');
  assert.deepEqual(f.requests.at(-2), {
    route: '/messages/user',
    method: 'PATCH',
    body: { text: 'Please do this', resubmit: true },
  });
  assert.equal(f.state.threadId, 'same-thread');
});

test('long message editing has no character cutoff and sends the entire draft only through the chosen action', async () => {
  const f = fixture(),
    text = '中文😀'.repeat(30000) + 'LONG_EDIT_TAIL';
  assert.ok(text.length > 100000);
  f.state.messages[0].text = text;
  f.render();
  await f.click('[data-message-more="user"]');
  await f.click('[data-message-edit="user"]');
  assert.equal(
    f.document.querySelector('#message-edit-form textarea').hasAttribute('maxlength'),
    false,
  );
  assert.equal(f.document.querySelector('#message-edit-form textarea').value, text);
  f.input('#message-edit-form textarea', text + ' saved');
  await f.submit();
  assert.deepEqual(f.requests[0], {
    route: '/messages/user',
    method: 'PATCH',
    body: { text: text + ' saved', resubmit: false },
  });
  assert.equal(f.state.threadId, 'same-thread');
  assert.equal(f.modal, null);
  await f.click('[data-message-more="user"]');
  await f.click('[data-message-edit="user"]');
  assert.equal(f.document.querySelector('#message-edit-form textarea').value, text + ' saved');
  f.input('#message-edit-form textarea', text + ' resent');
  await f.click('[data-history-resubmit]');
  assert.deepEqual(f.requests.at(-2), {
    route: '/messages/user',
    method: 'PATCH',
    body: { text: text + ' resent', resubmit: true },
  });
  assert.equal(f.requests.filter((request) => request.method === 'PATCH').length, 2);
  assert.equal(f.state.threadId, 'same-thread');
});

test('deleting and clearing require concrete confirmation and never remove VM credentials, skills, memory or model session', async () => {
  const f = fixture();
  await f.click('[data-message-more="assistant"]');
  await f.click('[data-message-remove="assistant"]');
  assert.equal(f.requests.length, 0);
  await f.click('[data-history-confirm-remove]');
  assert.equal(f.requests[0].route, '/messages/assistant');
  assert.equal(f.requests[0].method, 'DELETE');
  assert.equal(f.state.messages.length, 1);
  await f.click('[data-history-clear]');
  assert.match(f.document.querySelector('.history-dialog').textContent, /Messages: 1/);
  await f.click('[data-history-confirm-clear]');
  assert.deepEqual(f.requests.at(-2), {
    route: '/history',
    method: 'DELETE',
    body: { confirm: true },
  });
  assert.equal(f.state.messages.length, 0);
  assert.equal(f.state.credentials.items[0].name, 'kept');
  assert.equal(f.state.skills.items[0].name, 'kept');
  assert.equal(f.state.memory, 'kept');
  assert.equal(f.state.threadId, 'same-thread');
  assert.equal(f.document.querySelector('[data-history-clear]').disabled, true);
});

test('call and offline guards disable history actions and recheck state at the final mutation handler', async () => {
  const f = fixture();
  await f.click('[data-message-more="user"]');
  await f.click('[data-message-edit="user"]');
  f.input('#message-edit-form textarea', 'Kept draft');
  f.call = true;
  f.render();
  assert.match(f.document.querySelector('.history-dialog').textContent, /End the call/);
  assert.equal(f.document.querySelector('#message-edit-form [type="submit"]').disabled, true);
  await f.submit();
  assert.equal(f.requests.length, 0);
  assert.equal(f.document.querySelector('#message-edit-form textarea').value, 'Kept draft');
  f.closeModal();
  await f.click('[data-message-more="user"]');
  assert.equal(f.document.querySelector('[data-message-edit]').disabled, true);
  await f.click('[data-message-edit]');
  assert.equal(f.modal, null);
  f.call = false;
  f.state.worker.status = 'offline';
  f.render();
  assert.equal(f.document.querySelector('[data-history-clear]').disabled, true);
  assert.match(
    f.document.querySelector('.conversation-settings').textContent,
    /Connect the work computer/,
  );
});

test('rejected record edits keep the draft and acknowledged writes are not retried after refresh failure', async () => {
  const f = fixture();
  await f.click('[data-message-more="user"]');
  await f.click('[data-message-edit="user"]');
  f.input('#message-edit-form textarea', 'My draft');
  f.fail = () => true;
  await f.submit();
  assert.equal(f.document.querySelector('#message-edit-form textarea').value, 'My draft');
  assert.match(
    f.document.querySelector('[role="status"]').textContent,
    /Check the connection and task status/,
  );
  f.fail = (route) => route === '/state';
  await f.submit();
  assert.equal(f.modal, null);
  assert.equal(f.requests.filter((item) => item.method === 'PATCH').length, 2);
});

test('search uses current plaintext and attachment names without requests, escapes snippets, and navigates to the actual message', async () => {
  const f = fixture();
  await f.click('[data-chat-search]');
  const close = f.document.querySelector('.dialog-header [data-action="close-modal"]');
  assert.equal(close.getAttribute('aria-label'), 'Close');
  assert.equal(close.title, 'Close');
  assert.ok(close.classList.contains('icon-btn'));
  assert.equal(close.querySelector('svg').textContent, 'x');
  f.input('#chat-search-input', '中文');
  assert.equal(f.document.querySelectorAll('.search-result').length, 1);
  assert.match(f.document.querySelector('.search-result').textContent, /Original 中文/);
  f.state.messages[0].text = 'Changed elsewhere';
  f.render();
  assert.equal(f.document.querySelectorAll('.search-result').length, 0);
  assert.match(f.document.querySelector('.search-results').textContent, /No matching/);
  f.input('#chat-search-input', 'report');
  assert.equal(
    f.document.querySelector('[data-search-message]').dataset.searchMessage,
    'assistant',
  );
  f.input('#chat-search-input', '<img');
  assert.equal(f.document.querySelector('.search-result img'), null);
  assert.match(f.document.querySelector('.search-result').textContent, /<img/);
  await f.click('[data-search-message]');
  assert.equal(f.modal, null);
  assert.deepEqual(f.navigation, ['close', 'reveal:assistant']);
  assert.equal(f.scrolled.id, 'assistant');
  assert.equal(
    f.document.querySelector('[data-id="assistant"]').classList.contains('search-hit'),
    true,
  );
  assert.equal(f.requests.length, 0);
  const zh = fixture('zh');
  await zh.click('[data-chat-search]');
  zh.input('#chat-search-input', '不存在');
  assert.match(zh.document.querySelector('.search-results').textContent, /没有匹配/);
  assert.equal(
    zh.document
      .querySelector('.dialog-header [data-action="close-modal"]')
      .getAttribute('aria-label'),
    '关闭',
  );
  await zh.click('.dialog-header [data-action="close-modal"]');
  assert.equal(zh.modal, null);
  assert.equal(zh.requests.length, 0);
});

test('a message removed while its edit dialog is open is reported without a mutation', async () => {
  const f = fixture();
  await f.click('[data-message-more="user"]');
  await f.click('[data-message-edit="user"]');
  f.state.messages = [];
  f.render();
  assert.match(f.document.querySelector('.history-dialog').textContent, /changed or was deleted/);
  assert.equal(f.document.querySelector('#message-edit-form'), null);
  assert.equal(f.requests.length, 0);
});

test('read-aloud is an explicit localized assistant menu action and stopping uses the same safe callback', async () => {
  for (const language of ['en', 'zh']) {
    const calls = [];
    let active = false,
      f;
    f = fixture(language, {
      getSpeechState: (message) => ({
        active: active && message.id === 'assistant',
        disabled: false,
      }),
      onReadAloud: (id) => {
        assert.equal(
          f.document.querySelector('.history-menu'),
          null,
          'close the menu before beginning or stopping playback',
        );
        calls.push(id);
      },
    });
    assert.equal(f.document.querySelector('[data-message-speak]'), null);
    await f.click('[data-message-more="assistant"]');
    assert.deepEqual(calls, [], 'opening the ellipsis never starts playback');
    let button = f.document.querySelector('[data-message-speak="assistant"]');
    assert.equal(button.getAttribute('role'), 'menuitem');
    assert.match(button.textContent, language === 'en' ? /Read aloud/ : /朗读/);
    assert.equal(button.querySelector('svg').textContent, 'volume-2');
    assert.equal(button.disabled, false);
    f.call = true;
    f.render();
    button = f.document.querySelector('[data-message-speak="assistant"]');
    assert.equal(
      button.disabled,
      false,
      'history mutation guards do not override the supplied speech state',
    );
    assert.equal(f.document.querySelector('[data-message-remove="assistant"]').disabled, true);
    await f.click('[data-message-speak="assistant"]');
    assert.deepEqual(calls, ['assistant']);
    assert.equal(f.requests.length, 0);
    assert.equal(f.modal, null);
    active = true;
    await f.click('[data-message-more="assistant"]');
    button = f.document.querySelector('[data-message-speak="assistant"]');
    assert.match(button.textContent, language === 'en' ? /Stop reading/ : /停止朗读/);
    assert.equal(button.querySelector('svg').textContent, 'square');
    await f.click('[data-message-speak="assistant"]');
    assert.deepEqual(calls, ['assistant', 'assistant']);
    assert.equal(f.requests.length, 0);
    await f.click('[data-message-more="user"]');
    assert.equal(
      f.document.querySelector('[data-message-speak]'),
      null,
      'user messages never offer assistant read-aloud',
    );
  }
});

test('streaming, removed and changed message state are rechecked when a captured read-aloud action is clicked', async () => {
  const calls = [];
  let blocked = false;
  const f = fixture('en', {
    getSpeechState: (message) => ({
      active: false,
      disabled: blocked || message.status === 'streaming',
    }),
    onReadAloud: (id) => calls.push(id),
  });
  f.state.messages[1].status = 'streaming';
  await f.click('[data-message-more="assistant"]');
  let button = f.document.querySelector('[data-message-speak]');
  assert.equal(button.disabled, true);
  await button.onclick();
  assert.deepEqual(calls, []);
  f.state.messages[1].status = 'completed';
  f.render();
  button = f.document.querySelector('[data-message-speak]');
  assert.equal(button.disabled, false);
  blocked = true;
  await button.onclick();
  assert.deepEqual(calls, []);
  assert.equal(f.document.querySelector('[data-message-speak]').disabled, true);
  blocked = false;
  f.render();
  button = f.document.querySelector('[data-message-speak]');
  f.state.messages = f.state.messages.filter((message) => message.id !== 'assistant');
  await button.onclick();
  assert.deepEqual(calls, []);
  assert.equal(f.document.querySelector('[data-message-speak]'), null);
  assert.equal(f.requests.length, 0);
  const current = fixture('en', {
    getSpeechState: () => ({ active: false, disabled: false }),
    onReadAloud: (id) => calls.push(id),
  });
  await current.click('[data-message-more="assistant"]');
  const stale = current.document.querySelector('[data-message-speak]');
  await current.click('[data-message-more="assistant"]');
  await stale.onclick();
  assert.deepEqual(calls, [], 'a closed menu cannot replay an old audio action');
});

test('read-aloud stays absent without both hooks, valid state and assistant text', async () => {
  const callback = () => assert.fail('this menu must not start audio');
  for (const speechOptions of [
    {},
    { onReadAloud: callback },
    { getSpeechState: () => ({ active: false, disabled: false }) },
    { onReadAloud: callback, getSpeechState: () => null },
    { onReadAloud: callback, getSpeechState: () => ({ active: false }) },
    {
      onReadAloud: callback,
      getSpeechState: () => {
        throw Error('Private audio diagnostics');
      },
    },
  ]) {
    const f = fixture('en', speechOptions);
    await f.click('[data-message-more="assistant"]');
    assert.equal(f.document.querySelector('[data-message-speak]'), null);
    assert.doesNotMatch(f.document.body.textContent, /Private audio/);
  }
  for (const patch of [
    { text: '' },
    { text: '   ' },
    { text: null },
    { kind: 'call' },
    { role: 'user' },
  ]) {
    const f = fixture('en', {
      onReadAloud: callback,
      getSpeechState: () => ({ active: false, disabled: false }),
    });
    Object.assign(f.state.messages[1], patch);
    await f.click('[data-message-more="assistant"]');
    assert.equal(f.document.querySelector('[data-message-speak]'), null);
  }
});
