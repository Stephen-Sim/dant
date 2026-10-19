import { sourceIndex, sourceSection } from './source-fixtures.mjs';
import { languageContext } from './language-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
const source = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8');
const section = (start, end) => sourceSection(source, start, end);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
function fixture(language = 'en', update) {
  const context = {
    fallbackLanguage: language,
    state: {
      settings: {
        language,
        vm: { host: 'example.invalid', user: 'dant', port: 22, keyPath: 'fixture' },
      },
      worker: { status: 'online' },
      controller: { status: 'online', cached: false, ...(update ? { serviceUpdate: update } : {}) },
    },
    vmDraft: null,
    hasVMConnection: () => true,
    pendingActions: new Set(),
    pc: null,
    callStarting: false,
    callStops: { pending: false },
    vmProfilesVisible: false,
    manualVMExpanded: false,
    vmSystemDescription: () => 'Linux · SSH',
    esc,
    button: (action, icon, label, cls, disabled) =>
      `<button data-action="${action}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`,
  };
  vm.createContext(Object.assign(context, languageContext));
  vm.runInContext(
    section('const zh={', 'const subscriptionVoiceUnavailable=') +
      section('function renderVMSettings(){', 'function renderVMProfiles(){'),
    context,
  );
  return {
    context,
    render: () =>
      parseHTML('<html><body>' + context.renderVMSettings() + '</body></html>').document,
  };
}
test('checking and updating are localized and disable conflicting connection controls', () => {
  for (const language of ['en', 'zh'])
    for (const status of ['checking', 'updating']) {
      const f = fixture(language, {
          status,
          targetVersion: '0.4.7-beta.7',
          runningVersion: '0.4.7-beta.6',
          confirmed: false,
        }),
        document = f.render(),
        notice = document.querySelector('[data-service-update]');
      assert.equal(notice.dataset.serviceUpdate, status);
      assert.equal(notice.getAttribute('role'), 'status');
      assert.match(
        notice.textContent,
        language === 'en' ? /work computer service/ : /工作电脑服务/,
      );
      for (const action of ['connect', 'setup', 'use-existing'])
        assert.equal(
          document.querySelector(`[data-action="${action}"]`).hasAttribute('disabled'),
          true,
        );
    }
});
test('a connected older worker remains pending until idle, and cached success cannot claim current', () => {
  const f = fixture('en', {
      status: 'pending',
      targetVersion: '0.4.7-beta.7',
      runningVersion: '0.4.7-beta.6',
      confirmed: false,
      reason: 'work-active',
    }),
    notice = f.render().querySelector('[data-service-update]');
  assert.match(notice.textContent, /0\.4\.7-beta\.6/);
  assert.match(notice.textContent, /0\.4\.7-beta\.7/);
  assert.match(notice.textContent, /continue automatically.*work, calls/);
  assert.doesNotMatch(notice.textContent, /up to date/);
  assert.match(f.render().querySelector('.computer-summary').textContent, /Online/);
  f.context.state.controller.serviceUpdate = {
    status: 'current',
    targetVersion: '0.4.7-beta.7',
    runningVersion: '0.4.7-beta.7',
    confirmed: true,
  };
  assert.equal(f.render().querySelector('[data-service-update]').dataset.serviceUpdate, 'current');
  for (const patch of [
    { status: 'offline' },
    { status: 'online', cached: true },
    {
      status: 'online',
      cached: false,
      serviceUpdate: { ...f.context.state.controller.serviceUpdate, confirmed: false },
    },
  ]) {
    f.context.state.controller = {
      status: 'online',
      cached: false,
      serviceUpdate: { status: 'current', confirmed: true },
      ...patch,
    };
    assert.equal(
      f.render().querySelector('[data-service-update]').dataset.serviceUpdate,
      'pending',
    );
  }
});
test('unknown update state, unsafe versions and raw reasons never enter the card', () => {
  const old = fixture();
  assert.equal(old.render().querySelector('[data-service-update]'), null);
  const f = fixture('en', {
    status: 'failed',
    targetVersion: '<img src=x onerror=alert(1)>',
    runningVersion: 'PRIVATE /path/token',
    reason: 'PRIVATE stdout',
  });
  let document = f.render();
  assert.equal(document.querySelector('img'), null);
  assert.doesNotMatch(document.body.textContent, /PRIVATE|onerror|stdout/);
  assert.match(
    document.querySelector('[data-service-update]').textContent,
    /Saved task records are preserved/,
  );
  f.context.state.controller.serviceUpdate.status = 'PRIVATE';
  document = f.render();
  assert.equal(document.querySelector('[data-service-update]'), null);
});
test('an unconfigured computer keeps setup available before automatic updates can start', () => {
  const f = fixture('en', { status: 'checking', reason: 'not-configured', confirmed: false });
  f.context.hasVMConnection = () => false;
  f.context.state.settings.vm = { host: '', user: 'dant', port: 22, keyPath: '' };
  const document = f.render();
  assert.equal(document.querySelector('[data-service-update]'), null);
  assert.equal(document.querySelector('[data-action="setup"]').hasAttribute('disabled'), false);
  assert.equal(
    document.querySelector('[data-action="use-existing"]').hasAttribute('disabled'),
    false,
  );
});
test('known update failures have short localized errors and unrelated diagnostics remain intact', () => {
  for (const language of ['en', 'zh']) {
    const f = fixture(language),
      expected = language === 'en' ? /update did not finish/ : /更新未完成/;
    for (const error of [
      Error('VM preparation failed (1). PRIVATE stdout /home/private'),
      { code: 'vm_update_work_unconfirmed', message: 'PRIVATE raw output' },
    ]) {
      const text = f.context.errorText(error);
      assert.match(text, expected);
      assert.doesNotMatch(text, /PRIVATE|stdout|\/home/);
    }
    assert.match(
      f.context.errorText(Error('Unrelated fixture detail')),
      /Unrelated fixture detail/,
    );
    assert.doesNotMatch(
      f.context.errorText({ code: 'service_update_required' }),
      /choose Reconnect|刷新连接/,
    );
  }
});

test('a paused automatic update exposes resume and explicit pause-work-and-install controls', () => {
  const f = fixture('en', { status: 'failed', targetVersion: '0.4.7-beta.7' });
  f.context.state.controller.updatesPaused = true;
  const document = f.render();
  assert.match(
    document.querySelector('[data-service-update]').textContent,
    /Automatic service updates paused/,
  );
  assert.ok(document.querySelector('[data-action="service-resume"]'));
  assert.ok(document.querySelector('[data-action="service-install"]'));
  assert.equal(document.querySelector('[data-action="service-pause"]'), null);
  f.context.state.controller.serviceUpdateBusy = true;
  assert.equal(
    f.render().querySelector('[data-action="service-install"]').hasAttribute('disabled'),
    true,
  );
});

test('service controls submit the selected operation once and refresh authoritative state', async () => {
  const f = fixture('en', { status: 'pending' }),
    c = f.context,
    requests = [];
  c.updateInstalling = false;
  c.render = () => {};
  c.post = async (route, body) => requests.push({ route, body });
  c.api = async () => c.state;
  vm.runInContext(
    section('async function action(a){', 'async function checkUnconfirmedMessage(){'),
    c,
  );
  for (const action of ['pause', 'resume', 'install']) await c.action('service-' + action);
  assert.deepEqual(
    JSON.parse(JSON.stringify(requests)),
    ['pause', 'resume', 'install'].map((action) => ({
      route: '/service-update',
      body: { action },
    })),
  );
  c.pendingActions.add('service-update');
  await c.action('service-install');
  assert.equal(requests.length, 3);
});
