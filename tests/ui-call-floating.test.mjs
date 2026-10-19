import { sourceIndex, sourceSection, compactCss } from './source-fixtures.mjs';
import { languageContext } from './language-context.mjs';
import test from 'node:test';
import { createCallSubtitles } from '../ui/call/call-subtitles.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { reconcile } from '../ui/shared/dom.js';
import { formatCallDuration } from '../ui/call/call-duration.mts';

const source = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8'),
  css = compactCss(fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8'));
const part = (start, end) => sourceSection(source, start, end);
function style(selector) {
  return Object.fromEntries(
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1].trim() === selector)
      .flatMap((match) =>
        match[2]
          .split(';')
          .filter(Boolean)
          .map((value) => {
            const colon = value.indexOf(':');
            return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
          }),
      ),
  );
}
function fixture(language) {
  const { document } = parseHTML('<html><body><main id="app"></main></body></html>');
  const c = {
    document,
    formatCallDuration,
    fallbackLanguage: language,
    state: { settings: { language }, call: { id: 'call-a', provider: 'subscription' } },
    pc: { connectionState: 'connected' },
    callMini: true,
    callStarting: false,
    callConnected: true,
    callChannel: { readyState: 'open' },
    callProvider: 'subscription',
    stream: {},
    callMuted: false,
    callStops: { pending: false },
    callDuration: { snapshot: { confirmed: true, seconds: 123 } },
    ico: (name) => `<svg data-icon="${name}"></svg>`,
  };
  c.callSubtitles = createCallSubtitles();
  vm.createContext(Object.assign(c, languageContext));
  vm.runInContext(
    part('const zh={', 'const subscriptionVoiceUnavailable=') +
      '\n' +
      part('const esc=', 'const iconCache=') +
      '\n' +
      part('const button=', 'async function api(') +
      '\n' +
      part('function updateCallDuration(){', 'function renderUnconfirmedMessage(){') +
      '\nglobalThis.words={t};',
    c,
  );
  c.callId = 'call-a';
  c.nativeCallOverlay = { update() {} };
  const render = () => {
    const template = document.createElement('template');
    template.innerHTML = c.renderCall();
    reconcile(document.querySelector('#app'), template.content);
  };
  render();
  return { c, document, render };
}

test('floating call is a responsive horizontal bar with avatar left and controls right', () => {
  const bar = style('.call-view.mini');
  assert.equal(bar.display, 'grid');
  assert.match(bar['grid-template-columns'], /^42px minmax\(0,1fr\) auto 26px$/);
  assert.equal(bar.height, 'auto');
  assert.equal(bar['max-width'], 'calc(100% - 32px)');
  assert.equal(style('.mini .eyes.call-avatar')['grid-column'], '1');
  assert.equal(style('.mini>p')['grid-column'], '2');
  assert.equal(style('.mini .call-duration')['grid-column'], '2');
  assert.equal(style('.mini .call-controls')['grid-column'], '3');
  assert.equal(style('.mini .call-size-toggle')['grid-column'], '4');
  assert.equal(style('.mini .call-top').display, 'contents');
  assert.equal(style('.mini .call-top>span').display, 'none');
  assert.equal(
    style('.call-view')['flex-direction'],
    'column',
    'full call retains its existing vertical layout',
  );
  assert.equal(style('.call-size-toggle').background, 'transparent');
});

test('floating status, duration and accessible controls survive refreshes in both languages', () => {
  for (const [language, talking, expand] of [
    ['en', 'In a call', 'Expand call'],
    ['zh', '正在通话', '展开通话'],
  ]) {
    const f = fixture(language),
      bar = f.document.querySelector('.call-view'),
      avatar = bar.querySelector('.call-avatar'),
      mute = bar.querySelector('[data-action="mute"]'),
      hangup = bar.querySelector('[data-action="hangup"]'),
      size = bar.querySelector('[data-action="call-size"]'),
      duration = bar.querySelector('[data-call-duration]');
    assert.equal(bar.querySelector('p').textContent, talking);
    assert.equal(duration.textContent, '2:03');
    assert.equal(size.getAttribute('aria-label'), expand);
    assert.equal(size.textContent, '');
    assert.ok(mute.getAttribute('aria-label'));
    assert.ok(hangup.getAttribute('aria-label'));
    assert.equal(avatar.getAttribute('aria-hidden'), 'true');
    f.c.callDuration.snapshot.seconds = 124;
    f.c.updateCallDuration();
    assert.equal(duration.textContent, '2:04');
    f.render();
    assert.equal(f.document.querySelector('.call-view'), bar);
    assert.equal(bar.querySelector('.call-avatar'), avatar);
    assert.equal(bar.querySelector('[data-action="mute"]'), mute);
    assert.equal(bar.querySelector('[data-action="hangup"]'), hangup);
    assert.equal(bar.querySelector('[data-action="call-size"]'), size);
    assert.equal(bar.querySelector('[data-call-duration]'), duration);
    f.c.pc = null;
    f.c.stream = null;
    f.render();
    assert.equal(bar.querySelector('p').textContent, f.c.words.t('callRecover'));
    assert.equal(bar.querySelector('[data-action="mute"]'), null);
    assert.equal(bar.querySelector('[data-action="hangup"]'), hangup);
    f.c.callStops.pending = true;
    f.render();
    assert.equal(bar.querySelector('p').textContent, f.c.words.t('callPendingStop'));
    f.c.callDuration.snapshot.confirmed = false;
    f.render();
    assert.equal(bar.querySelector('[data-call-duration]'), null);
  }
});
