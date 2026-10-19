import type { TelegramStatus, TelegramPairing } from '../../../ui/app/application-types.ts';
import type { Timer } from '../../../ui/shared/contracts.mts';
import { isRecord, errorMessage } from '../../../src/contracts/json.mts';
import { escapeHtml } from '../../../ui/shared/html.mts';
import { observedRecord } from '../../support/service-fixtures.mts';
type StatusFixture = Omit<TelegramStatus, 'sync'> & { sync?: unknown };
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined, invokeHandler } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import {
  telegramConnectionError,
  telegramDeliveryNotice,
} from '../../../ui/chat/telegram-delivery.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
const section = (start: string, end: string) => sourceSection(source, start, end);
const deferred = () => {
  let resolve: ((value: unknown) => void) | undefined,
    reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve: defined(resolve), reject: defined(reject) };
};
function fixture({
  language = 'en',
  sync = {
    mode: 'new-shared-messages',
    forwardMode: 'unread',
    combineReplies: true,
    readState: 'independent',
  },
  paired = false,
}: { language?: string; sync?: unknown; paired?: boolean } = {}) {
  const { document } = parseHTML('<html><body><main></main></body></html>'),
    main = document.querySelector<HTMLElement>('main'),
    requests: { route: string; body: unknown }[] = [],
    toasts: string[] = [],
    cleared: (Timer | null)[] = [];
  const status: StatusFixture = {
    enabled: true,
    configured: true,
    connected: true,
    bot: { username: 'example_bot' },
    paired,
    owner: paired ? { userId: 123 } : null,
    pairing: null,
    lastError: null,
    delivery: { failed: 0, unknown: 0 },
    ...(sync === undefined ? {} : { sync }),
  };
  const context = uiEntrypointFixture({
    document,
    Date,
    URL,
    telegramConnectionError,
    telegramDeliveryNotice,
    fallbackLanguage: language,
    state: {
      conversationId: 'chat',
      settings: {
        language,
        vm: { host: 'vm-one', user: 'dant', port: 22, keyPath: 'private-vm-key' },
      },
      controller: { status: 'online', cached: false },
      worker: { status: 'online' },
      telegram: status,
    },
    eventConnected: true,
    telegramStatus: null as Partial<TelegramStatus> | null,
    telegramLoading: false,
    telegramError: '',
    telegramPairing: null as TelegramPairing | null,
    telegramPairTimer: null as Timer | null,
    pendingActions: new Set(),
    page: 'settings',
    esc: escapeHtml,
    ico: () => '',
    formatTime: (value: number) => new Date(value).toISOString(),
    errorText: (error: unknown) => errorMessage(error) || String(error),
    toast: (message: string) => toasts.push(message),
    clearTimeout: (value: Timer | null) => cleared.push(value),
    setTimeout: () => 31,
  });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(
    stripTypeScriptTypes(
      section('function currentState(', 'const subscriptionVoiceUnavailable=') +
        '\n' +
        section('function currentTelegram(){', 'function renderVoiceSettings(settings){'),
    ),
    context,
  );
  let requestHandler: ((route: string, body: unknown) => unknown) | undefined;
  context.post = async (route, body) => {
    requests.push({ route, body: structuredClone(body) });
    if (requestHandler) return requestHandler(route, body);
    return {
      ...context.state.telegram,
      sync: {
        ...(isRecord(context.state.telegram.sync) ? context.state.telegram.sync : {}),
        ...observedRecord(body),
      },
    };
  };
  context.api = async () => {
    throw Error('Forwarding settings must not reload or reconfigure Telegram');
  };
  context.render = () => {
    const template = document.createElement('template');
    template.innerHTML = context.renderTelegramSettings();
    reconcile(defined(main), template.content);
    context.bindTelegram();
  };
  context.render();
  function node(selector: '#telegram-forward-mode'): HTMLSelectElement | null;
  function node(selector: '#telegram-combine-replies' | '#telegram-token'): HTMLInputElement | null;
  function node(selector: string): HTMLElement | null;
  function node(selector: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(selector);
  }
  return {
    context,
    document,
    requests,
    toasts,
    cleared,
    render: context.render,
    set handler(value: (route: string, body: unknown) => unknown) {
      requestHandler = value;
    },
    node,
    async mode(value: string) {
      const select = document.querySelector<HTMLSelectElement>('#telegram-forward-mode');
      for (const option of defined(select).querySelectorAll<HTMLOptionElement>('option')) {
        if (option.value === value) option.setAttribute('selected', '');
        else option.removeAttribute('selected');
      }
      return invokeHandler(defined(select), 'change');
    },
    async combine(value: boolean) {
      const checkbox = document.querySelector<HTMLInputElement>('#telegram-combine-replies');
      defined(checkbox).checked = value;
      return invokeHandler(defined(checkbox), 'change');
    },
  };
}

test('Telegram forwarding renders one language with recommended defaults and saves only the changed field', async () => {
  for (const language of ['en', 'zh']) {
    const f = fixture({ language }),
      preferences = f.node('.telegram-forwarding-settings');
    assert.match(
      defined(preferences).textContent,
      language === 'en' ? /Message forwarding/ : /消息转发/,
    );
    assert.match(
      defined(preferences).textContent,
      language === 'en' ? /Unread replies only \(recommended\)/ : /仅未读回复（推荐）/,
    );
    assert.match(
      defined(preferences).textContent,
      language === 'en' ? /Combine consecutive replies/ : /合并连续回复/,
    );
    assert.match(defined(preferences).textContent, language === 'en' ? /independent/ : /保持独立/);
    assert.doesNotMatch(
      defined(preferences).textContent,
      language === 'en' ? /[\u4e00-\u9fff]/ : /Unread replies|Combine consecutive/,
    );
    assert.equal(defined(f.node('#telegram-forward-mode')).value, 'unread');
    assert.equal(defined(f.node('#telegram-combine-replies')).hasAttribute('checked'), true);
    await f.mode('all');
    assert.deepEqual(f.requests, [{ route: '/telegram/config', body: { forwardMode: 'all' } }]);
    assert.equal(observedRecord(f.context.state.telegram.sync).forwardMode, 'all');
    assert.equal(observedRecord(f.context.state.telegram.sync).mode, 'new-shared-messages');
    assert.equal(observedRecord(f.context.state.telegram.sync).combineReplies, true);
    assert.equal(defined(f.node('#telegram-forward-mode')).value, 'all');
    assert.match(
      defined(f.toasts.at(-1)),
      language === 'en' ? /forwarding settings saved/ : /转发设置已保存/,
    );
    await f.combine(false);
    assert.deepEqual(f.requests[1], { route: '/telegram/config', body: { combineReplies: false } });
    assert.equal(observedRecord(f.context.state.telegram.sync).combineReplies, false);
    assert.equal(defined(f.node('#telegram-combine-replies')).hasAttribute('checked'), false);
    assert.equal(
      f.requests.some((request) => 'token' in request.body || 'enabled' in request.body),
      false,
    );
    await f.mode('all');
    assert.equal(f.requests.length, 2, 'unchanged controls do not save');
  }
});

test('forwarding updates preserve a typed token, active pairing code and timer, connection and enable state', async () => {
  for (const paired of [false, true]) {
    const f = fixture({ paired }),
      pairing = {
        code: 'private-pairing-code',
        expiresAt: Date.now() + 60000,
        botUrl: 'https://t.me/example_bot',
      };
    f.context.telegramPairing = pairing;
    f.context.telegramPairTimer = 77;
    f.render();
    const input = f.node('#telegram-token');
    defined(input).value = 'private-unsent-token';
    await f.mode('all');
    assert.equal(f.node('#telegram-token'), input);
    assert.equal(defined(input).value, 'private-unsent-token');
    assert.equal(f.context.telegramPairing, pairing);
    assert.equal(f.context.telegramPairTimer, 77);
    assert.deepEqual(f.cleared, []);
    assert.equal(f.context.state.telegram.paired, paired);
    assert.equal(f.context.state.telegram.enabled, true);
    assert.equal(f.context.state.telegram.connected, true);
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(f.requests), /private-unsent-token|private-pairing-code/);
  }
});

test('offline, cached, loading and in-flight states disable forwarding and serialize captured old controls', async () => {
  for (const mode of ['offline', 'cached', 'controller', 'loading', 'disconnected']) {
    const f = fixture();
    if (mode === 'offline') f.context.state.worker.status = 'offline';
    else if (mode === 'cached') f.context.state.controller.cached = true;
    else if (mode === 'controller') f.context.state.controller.status = 'connecting';
    else if (mode === 'loading') f.context.telegramLoading = true;
    else f.context.eventConnected = false;
    f.render();
    assert.equal(defined(f.node('#telegram-forward-mode')).disabled, true, mode);
    assert.equal(defined(f.node('#telegram-combine-replies')).disabled, true, mode);
    await f.mode('all');
    assert.equal(f.requests.length, 0, mode);
  }
  const f = fixture(),
    wait = deferred();
  f.handler = () => wait.promise;
  const combine = f.node('#telegram-combine-replies'),
    saving = f.mode('all');
  assert.equal(f.context.pendingActions.has('telegram'), true);
  assert.equal(defined(f.node('#telegram-forward-mode')).disabled, true);
  assert.equal(defined(f.node('#telegram-combine-replies')).disabled, true);
  defined(combine).checked = false;
  await invokeHandler(defined(combine), 'change');
  assert.equal(f.requests.length, 1);
  wait.resolve({
    ...f.context.state.telegram,
    sync: { ...observedRecord(f.context.state.telegram.sync), forwardMode: 'all' },
  });
  await saving;
  assert.equal(f.context.pendingActions.has('telegram'), false);
  assert.equal(defined(f.node('#telegram-forward-mode')).disabled, false);
  assert.equal(observedRecord(f.context.state.telegram.sync).combineReplies, true);
});

test('old services with missing or malformed forwarding capability fields stay disabled with automatic-update guidance', async () => {
  for (const language of ['en', 'zh'])
    for (const sync of [
      null,
      {},
      { mode: 'old' },
      { forwardMode: 'all', combineReplies: true },
      { forwardMode: 'unread', combineReplies: 'true', readState: 'independent' },
      { forwardMode: 'unknown', combineReplies: true, readState: 'independent' },
    ]) {
      const f = fixture({ language, sync });
      assert.equal(defined(f.node('#telegram-forward-mode')).disabled, true);
      assert.equal(defined(f.node('#telegram-combine-replies')).disabled, true);
      assert.equal(defined(f.node('#telegram-forward-mode')).value, 'unread');
      assert.equal(defined(f.node('#telegram-combine-replies')).hasAttribute('checked'), true);
      assert.match(
        defined(f.node('.telegram-forwarding-update')).textContent,
        language === 'en' ? /updates automatically/ : /自动更新/,
      );
      await f.mode('all');
      assert.equal(f.requests.length, 0);
      assert.match(
        defined(f.toasts.at(-1)),
        language === 'en' ? /updates automatically/ : /自动更新/,
      );
    }
});

test('failed saves and incomplete or mismatching echoes never confirm or replace the authoritative setting', async () => {
  for (const response of ['network', 'missing', 'wrongMode', 'wrongCombine', 'wrongReadState']) {
    const f = fixture(),
      previous = f.context.state.telegram;
    defined(f.node('#telegram-token')).value = 'private-draft';
    f.handler = async () => {
      if (response === 'network') throw Error('private transport failure');
      const sync: { forwardMode: string; combineReplies?: unknown; readState?: unknown } = {
        ...observedRecord(previous.sync),
        forwardMode: 'all',
      };
      if (response === 'missing') delete sync.combineReplies;
      if (response === 'wrongMode') sync.forwardMode = 'unread';
      if (response === 'wrongCombine') sync.combineReplies = false;
      if (response === 'wrongReadState') sync.readState = 'shared';
      return { ...previous, sync };
    };
    await f.mode('all');
    assert.equal(f.context.state.telegram, previous, response);
    assert.equal(observedRecord(f.context.state.telegram.sync).forwardMode, 'unread');
    assert.equal(defined(f.node('#telegram-forward-mode')).value, 'unread');
    assert.equal(defined(f.node('#telegram-token')).value, 'private-draft');
    assert.match(defined(f.toasts.at(-1)), /could not be saved/);
    assert.equal(
      f.toasts.some((text) => /settings saved/.test(text)),
      false,
    );
    assert.doesNotMatch(f.document.body.textContent, /private transport failure/);
    assert.equal(f.context.pendingActions.has('telegram'), false);
  }
});

test('forwarding accepts no token, enabled, malformed or undefined fields and stale scopes cannot save or apply results', async () => {
  const f = fixture();
  for (const body of [
    { token: 'private' },
    { enabled: false },
    { forwardMode: 'wrong' },
    { combineReplies: 'false' },
    { combineReplies: undefined },
    {},
    null,
  ])
    await assert.rejects(f.context.updateTelegram('forwarding', body));
  assert.equal(f.requests.length, 0);
  const old = f.node('#telegram-forward-mode');
  f.context.state.settings.vm.host = 'vm-two';
  await invokeHandler(defined(old), 'change');
  assert.equal(f.requests.length, 0);
  const current = fixture(),
    wait = deferred();
  current.handler = () => wait.promise;
  const saving = current.mode('all');
  current.context.state.settings.vm.host = 'vm-two';
  const replacement = {
    ...current.context.state.telegram,
    sync: { ...observedRecord(current.context.state.telegram.sync), forwardMode: 'unread' },
  };
  current.context.state.telegram = replacement;
  wait.resolve({ ...replacement, sync: { ...replacement.sync, forwardMode: 'all' } });
  await saving;
  assert.equal(current.context.state.telegram, replacement);
  assert.equal(current.toasts.length, 0);
  assert.equal(current.context.pendingActions.has('telegram'), false);
});
