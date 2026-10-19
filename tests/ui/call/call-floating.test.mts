import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceSection, compactCss } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import { createCallSubtitles } from '../../../ui/call/call-subtitles.mts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { reconcile } from '../../../ui/shared/dom.mts';
import { formatCallDuration } from '../../../ui/call/call-duration.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
  css = compactCss(fs.readFileSync(new URL('../../../ui/style.css', import.meta.url), 'utf8'));
const part = (start: string, end: string) => sourceSection(source, start, end);
function style(selector: string) {
  return Object.fromEntries(
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => defined(match[1]).trim() === selector)
      .flatMap((match) =>
        defined(match[2])
          .split(';')
          .filter(Boolean)
          .map((value) => {
            const colon = value.indexOf(':');
            return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
          }),
      ),
  );
}
function fixture(language: string) {
  const { document } = parseHTML('<html><body><main id="app"></main></body></html>');
  const c = uiEntrypointFixture({
    document,
    formatCallDuration,
    fallbackLanguage: language,
    state: { settings: { language }, call: { id: 'call-a', provider: 'subscription' } },
    pc: { connectionState: 'connected' } as { connectionState: string } | null,
    callMini: true,
    callStarting: false,
    callConnected: true,
    callChannel: { readyState: 'open' },
    callProvider: 'subscription',
    stream: {} as object | null,
    callId: 'call-a',
    nativeCallOverlay: { update() {} },
    words: { t: (key: string) => key },
    callMuted: false,
    callStops: { pending: false },
    callDuration: { snapshot: { confirmed: true, seconds: 123 } },
    ico: (name: string) => `<svg data-icon="${name}"></svg>`,
  });
  c.callSubtitles = createCallSubtitles();
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(
    stripTypeScriptTypes(
      part('function currentState(', 'const subscriptionVoiceUnavailable=') +
        '\n' +
        '' +
        '\n' +
        part('const button=', 'async function api(') +
        '\n' +
        part('function updateCallDuration(){', 'function renderUnconfirmedMessage(){') +
        '\nglobalThis.words={t};',
    ),
    c,
  );
  c.callId = 'call-a';
  c.nativeCallOverlay = { update() {} };
  const render = () => {
    const template = document.createElement('template');
    template.innerHTML = c.renderCall();
    reconcile(defined(document.querySelector<HTMLElement>('#app')), template.content);
  };
  render();
  return { c, document, render };
}

test('floating call is a responsive horizontal bar with avatar left and controls right', () => {
  const bar = style('.call-view.mini');
  assert.equal(bar.display, 'grid');
  assert.match(defined(bar['grid-template-columns']), /^42px minmax\(0,1fr\) auto 26px$/);
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
  ] as const) {
    const f = fixture(language),
      bar = f.document.querySelector<HTMLElement>('.call-view'),
      avatar = defined(bar).querySelector<HTMLElement>('.call-avatar'),
      mute = defined(bar).querySelector<HTMLButtonElement>('[data-action="mute"]'),
      hangup = defined(bar).querySelector<HTMLButtonElement>('[data-action="hangup"]'),
      size = defined(bar).querySelector<HTMLButtonElement>('[data-action="call-size"]'),
      duration = defined(bar).querySelector<HTMLButtonElement>('[data-call-duration]');
    assert.equal(defined(defined(bar).querySelector<HTMLElement>('p')).textContent, talking);
    assert.equal(defined(duration).textContent, '2:03');
    assert.equal(defined(size).getAttribute('aria-label'), expand);
    assert.equal(defined(size).textContent, '');
    assert.ok(defined(mute).getAttribute('aria-label'));
    assert.ok(defined(hangup).getAttribute('aria-label'));
    assert.equal(defined(avatar).getAttribute('aria-hidden'), 'true');
    f.c.callDuration.snapshot.seconds = 124;
    f.c.updateCallDuration();
    assert.equal(defined(duration).textContent, '2:04');
    f.render();
    assert.equal(f.document.querySelector<HTMLElement>('.call-view'), bar);
    assert.equal(defined(bar).querySelector<HTMLElement>('.call-avatar'), avatar);
    assert.equal(defined(bar).querySelector<HTMLButtonElement>('[data-action="mute"]'), mute);
    assert.equal(defined(bar).querySelector<HTMLButtonElement>('[data-action="hangup"]'), hangup);
    assert.equal(defined(bar).querySelector<HTMLButtonElement>('[data-action="call-size"]'), size);
    assert.equal(defined(bar).querySelector<HTMLButtonElement>('[data-call-duration]'), duration);
    f.c.pc = null;
    f.c.stream = null;
    f.render();
    assert.equal(
      defined(defined(bar).querySelector<HTMLElement>('p')).textContent,
      f.c.words.t('callRecover'),
    );
    assert.equal(defined(bar).querySelector<HTMLButtonElement>('[data-action="mute"]'), null);
    assert.equal(defined(bar).querySelector<HTMLButtonElement>('[data-action="hangup"]'), hangup);
    f.c.callStops.pending = true;
    f.render();
    assert.equal(
      defined(defined(bar).querySelector<HTMLElement>('p')).textContent,
      f.c.words.t('callPendingStop'),
    );
    f.c.callDuration.snapshot.confirmed = false;
    f.render();
    assert.equal(defined(bar).querySelector<HTMLButtonElement>('[data-call-duration]'), null);
  }
});
