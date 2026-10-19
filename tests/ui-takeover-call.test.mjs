import { sourceIndex, sourceSection } from './source-fixtures.mjs';
import { languageContext } from './language-context.mjs';
import { createTaskReplyController } from '../ui/work/task-reply.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { reconcile } from '../ui/shared/dom.js';
import { bindAttachmentImages } from '../ui/files/attachment-images.js';
import { createWorkDisclosures } from '../ui/work/work-disclosures.js';

const source = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
const part = (start, end) => sourceSection(source, start, end),
  settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(language = 'en') {
  const { document, Event } = parseHTML(
      '<!doctype html><html><body><main id="app"></main></body></html>',
    ),
    app = document.querySelector('#app'),
    requests = [],
    toasts = [];
  const c = {
    bindAttachmentImages,
    downloads: { bind() {} },
    filePreview: { bind() {}, syncModal: (value) => value },
    modal: null,
    managedSettings: {
      renderRequests: () => '',
      renderCredentials: () => '',
      renderSkills: () => '',
      renderModal: () => null,
      bind() {},
      load: async () => {},
      onClose() {},
    },
    chatHistory: {
      renderActions: () => '',
      renderEdited: () => '',
      renderSettings: () => '',
      renderModal: () => null,
      bind() {},
      bindModal() {},
      onClose() {},
    },
    document,
    Event,
    window: {},
    innerWidth: 1440,
    localStorage: { getItem: () => null, setItem() {} },
    fallbackLanguage: language,
    state: {
      settings: {
        language,
        vm: { host: '192.0.2.10', user: 'dant', port: 22, keyPath: 'C:/vm-key' },
      },
      worker: { status: 'online' },
      computer: { status: 'agent', sessionId: 'lease-1' },
      call: null,
      messages: [],
    },
    eventConnected: true,
    pc: null,
    callStarting: false,
    callStops: { pending: false },
    pendingActions: new Set(),
    screenURL: '/fixture/desktop.png',
    screenError: '',
    page: 'chat',
    chatMode: 'text',
    showComputer: true,
    vmDraft: null,
    vmProfilesVisible: false,
    manualVMExpanded: false,
    render() {},
    toast: (message) => toasts.push(message),
    icons: {},
    createElement: () => ({ outerHTML: '<svg aria-hidden="true"></svg>' }),
    bindSteer() {},
    bindProvision() {},
    bindVoiceKey() {},
    bindTelegram() {},
    bindAppearance() {},
    bindVMSettings() {},
    bindComputerInput() {},
  };
  c.progressActions = { bind() {}, renderConfirmation: () => '', onClose() {}, busy: false };
  c.workDisclosures = createWorkDisclosures({ getState: () => c.state, document });
  c.post = async (route, body) => {
    requests.push({ route, body });
    if (route === '/takeover') c.state.computer.status = body.enabled ? 'human' : 'agent';
    return { ok: true };
  };
  c.api = async (route) => {
    requests.push({ route });
    assert.equal(route, '/state');
    return c.state;
  };
  c.updateInstalling = false;
  c.chatScroll ??= { capture() {}, restore() {}, dispose() {}, navigate: (action) => action() };
  c.memorySettings ??= { setVisible() {}, render: () => '', bind() {}, dispose() {} };
  c.taskReplies ??= createTaskReplyController({ document: c.document, getModel: () => ({}) });
  vm.createContext(Object.assign(c, languageContext));
  vm.runInContext(
    [
      part('const zh={', 'const subscriptionVoiceUnavailable='),
      part('const subscriptionVoiceUnavailable=', 'const eyes='),
      part('function renderComputer(){', 'function renderSettings(){'),
      part('function hasVMConnection(){', 'function renderVMProfiles(){'),
      part('function bind(){', 'async function taskRequest('),
      part('async function action(a){', 'async function checkUnconfirmedMessage(){'),
    ].join('\n'),
    c,
  );
  c.render = () => {
    const template = document.createElement('template');
    template.innerHTML =
      c.renderComputer() + c.renderVMSettings() + '<input id="file-input" type="file" hidden>';
    reconcile(app, template.content);
    c.bind();
  };
  c.render();
  return {
    c,
    document,
    requests,
    toasts,
    async click(node) {
      node.dispatchEvent(new Event('click', { bubbles: true }));
      await settle();
    },
  };
}

test('recovering, connecting and pending-stop calls block takeover before any API request', async () => {
  for (const [language, hint] of [
    ['zh', '请等待通话连接或停止操作完成，再接管电脑。'],
    ['en', 'Wait for the call to connect or finish stopping before taking control.'],
  ])
    for (const mode of ['recovering', 'connecting', 'pending-stop']) {
      const f = fixture(language),
        call = { id: 'live-call', provider: 'subscription', status: 'connected' },
        peer = {
          close() {
            throw Error('Do not close a live call');
          },
        };
      if (mode === 'active') {
        f.c.state.call = call;
        f.c.pc = peer;
      } else if (mode === 'recovering') f.c.state.call = { ...call, status: 'stop-unconfirmed' };
      else if (mode === 'connecting') f.c.callStarting = true;
      else f.c.callStops.pending = true;
      f.c.render();
      const control = f.document.querySelector('[data-action="takeover"]');
      assert.equal(control.disabled, true, mode);
      assert.equal(control.title, hint);
      assert.equal(control.getAttribute('aria-describedby'), 'takeover-call-hint');
      assert.equal(f.document.querySelector('#takeover-call-hint').textContent, hint);
      assert.match(
        f.document.querySelector('.vm-settings .takeover-call-hint').textContent,
        language === 'en' ? /before changing/ : /更改电脑连接/,
      );
      assert.equal(f.document.querySelector('#screen').getAttribute('src'), '/fixture/desktop.png');
      // Even a stale/custom client dispatching a click on a disabled node must be guarded.
      await f.click(control);
      assert.equal(f.requests.length, 0);
      assert.equal(f.toasts.at(-1), hint);
      assert.equal(f.c.state.computer.status, 'agent');
      assert.equal(f.c.pc, mode === 'active' ? peer : null);
      assert.equal(f.c.pendingActions.size, 0);
    }
});

test('connected calls retain media while human desktop takeover and return use the existing lease', async () => {
  for (const provider of ['subscription', 'api']) {
    const f = fixture(),
      call = { id: 'live-call', provider, status: 'connected' },
      peer = {
        close() {
          throw Error('Do not close a live call');
        },
      };
    f.c.state.call = call;
    f.c.pc = peer;
    f.c.render();
    const control = f.document.querySelector('[data-action="takeover"]');
    assert.equal(control.disabled, false);
    assert.equal(f.document.querySelector('#takeover-call-hint'), null);
    await f.click(control);
    assert.equal(f.c.pc, peer);
    assert.equal(f.c.state.call, call);
    assert.equal(f.c.state.computer.status, 'human');
    assert.equal(f.document.querySelector('#vm-ime').hasAttribute('disabled'), false);
    assert.equal(
      f.document.querySelector('#screen-target').classList.contains('controlling'),
      true,
    );
    assert.equal(vm.runInContext('computerInputReady()', f.c), true);
    await f.click(f.document.querySelector('[data-action="takeover"]'));
    assert.equal(f.c.state.computer.status, 'agent');
    assert.equal(f.c.pc, peer);
    assert.equal(f.c.state.call, call);
    assert.deepEqual(
      f.requests.map((item) => item.route),
      ['/takeover', '/state', '/takeover', '/state'],
    );
  }
});

test('takeover becomes available after the call ends, with the exact lease and desktop kept intact', async () => {
  const f = fixture();
  f.c.state.call = { id: 'old-call' };
  f.c.callStops.pending = true;
  f.c.render();
  assert.equal(f.document.querySelector('[data-action="takeover"]').disabled, true);
  f.c.state.call = null;
  f.c.callStops.pending = false;
  f.c.render();
  const control = f.document.querySelector('[data-action="takeover"]');
  assert.equal(control.disabled, false);
  assert.equal(f.document.querySelector('#takeover-call-hint'), null);
  assert.equal(f.document.querySelector('.vm-settings .takeover-call-hint'), null);
  await f.click(control);
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [
    { route: '/takeover', body: { enabled: true, sessionId: 'lease-1' } },
    { route: '/state' },
  ]);
  assert.equal(f.c.state.computer.status, 'human');
  assert.equal(f.document.querySelector('#screen').getAttribute('src'), '/fixture/desktop.png');
});

test('returning an existing human lease remains available during an inconsistent active or pending-stop call', async () => {
  for (const pending of [false, true]) {
    const f = fixture();
    f.c.state.computer.status = 'human';
    f.c.state.call = { id: 'live-call' };
    f.c.callStops.pending = pending;
    f.c.render();
    const control = f.document.querySelector('[data-action="takeover"]');
    assert.equal(control.disabled, false);
    assert.equal(control.textContent, 'Return to dant');
    assert.equal(f.document.querySelector('#takeover-call-hint'), null);
    await f.click(control);
    assert.deepEqual(JSON.parse(JSON.stringify(f.requests)), [
      { route: '/takeover', body: { enabled: false, sessionId: 'lease-1' } },
      { route: '/state' },
    ]);
    assert.equal(f.c.state.call.id, 'live-call');
    assert.equal(f.c.state.computer.status, 'agent');
  }
});
