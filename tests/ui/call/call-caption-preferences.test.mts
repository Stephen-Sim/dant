import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createCallCaptionPreferences } from '../../../ui/call/call-caption-preferences.mts';
import { createCallSubtitles } from '../../../ui/call/call-subtitles.mts';
import { callCaptionCopy } from '../../../ui/call/call-caption-copy.mts';
import { languages } from '../../../src/i18n/languages.mts';
import type { ApiRequest } from '../../../ui/shared/contracts.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { deferred } from '../../support/service-fixtures.mts';
import { observedRecord } from '../../support/service-fixtures.mts';

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(language = 'en') {
  const { document, Event } = parseHTML('<main></main>'),
    calls: { route: string; body: unknown }[] = [],
    errors: string[] = [];
  let persisted = true,
    state: {
      conversationId: string;
      settings: { vm: { host: string }; showCallCaptions?: boolean };
    } = { conversationId: 'one', settings: { vm: { host: 'one' }, showCallCaptions: true } },
    request: ApiRequest = async (route, options) => {
      assert.equal(options?.method, 'PATCH');
      const body = observedRecord(options?.body);
      assert.deepEqual(Object.keys(body), ['showCallCaptions']);
      calls.push({ route, body });
      persisted = body.showCallCaptions === true;
      return { ok: true };
    };
  const subtitles = createCallSubtitles();
  subtitles.sync({ id: 'call-one', provider: 'subscription' });
  const preferences = createCallCaptionPreferences({
    document,
    getState: () => state,
    getLanguage: () => language,
    request: (route, options) => request(route, options),
    onChange: render,
    onError: (message) => errors.push(message),
  });
  function render() {
    defined(document.querySelector('main')).innerHTML =
      preferences.renderSetting() +
      preferences.renderToggle() +
      subtitles.render({ language, enabled: preferences.enabled });
    preferences.bind();
  }
  render();
  return {
    document,
    Event,
    calls,
    errors,
    preferences,
    subtitles,
    render,
    get state() {
      return state;
    },
    set request(value: ApiRequest) {
      request = value;
    },
    reload() {
      state = { ...state, settings: { ...state.settings, showCallCaptions: persisted } };
      render();
    },
  };
}

test('captions default on, distinguish waiting from spoken text, and both controls persist only the display preference', async () => {
  const f = fixture();
  delete f.state.settings.showCallCaptions;
  f.render();
  assert.equal(f.preferences.enabled, true);
  assert.equal(
    f.document.querySelector('[data-call-caption-setting]')?.hasAttribute('checked'),
    true,
  );
  assert.match(
    f.document.querySelector('[data-call-subtitle-placeholder]')?.textContent ?? '',
    /Waiting for dant/,
  );
  f.subtitles.receiveSnapshot({
    callId: 'call-one',
    provider: 'subscription',
    sequence: 1,
    text: 'Actual spoken reply',
    final: true,
  });
  f.render();
  defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).click();
  await settle();
  assert.equal(f.preferences.enabled, false);
  assert.equal(
    f.document.querySelector('[data-call-caption-toggle]')?.getAttribute('aria-pressed'),
    'false',
  );
  assert.equal(f.document.querySelector('[data-call-subtitle-text]')?.textContent, '');
  assert.equal(
    f.document.querySelector('[data-call-subtitle-disabled]')?.textContent,
    'Captions off',
  );
  assert.equal(
    defined(f.document.querySelector<HTMLElement>('[data-call-subtitle-placeholder]')).hidden,
    true,
  );
  assert.equal(
    f.subtitles.snapshot.text,
    'Actual spoken reply',
    'hiding captions does not delete the current call segment',
  );
  f.reload();
  assert.equal(
    f.preferences.enabled,
    false,
    'a fresh saved settings snapshot retains the disabled preference',
  );
  const checkbox = defined(
    f.document.querySelector<HTMLInputElement>('[data-call-caption-setting]'),
  );
  checkbox.checked = true;
  checkbox.dispatchEvent(new f.Event('change'));
  await settle();
  assert.equal(f.preferences.enabled, true);
  assert.equal(
    f.document.querySelector('[data-call-subtitle-text]')?.textContent,
    'Actual spoken reply',
  );
  assert.deepEqual(f.calls, [
    { route: '/settings', body: { showCallCaptions: false } },
    { route: '/settings', body: { showCallCaptions: true } },
  ]);
  assert.deepEqual(f.errors, []);
});

test('a pending preference is serialized and a failed or stale save never invents a confirmed setting', async () => {
  const f = fixture(),
    pending = deferred<unknown>();
  let requests = 0;
  f.request = async () => {
    requests++;
    return pending.promise;
  };
  defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).click();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).disabled,
    true,
  );
  defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).click();
  assert.equal(requests, 1);
  f.state.conversationId = 'other';
  pending.resolve({ ok: true });
  await settle();
  assert.equal(
    f.preferences.enabled,
    true,
    'late success cannot edit the replacement conversation state',
  );
  f.request = async () => {
    throw Error('private backend detail');
  };
  defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).click();
  await settle();
  assert.equal(f.preferences.enabled, true);
  assert.deepEqual(f.errors, [callCaptionCopy('en').failed]);
  assert.ok(!f.document.body.textContent.includes('private backend detail'));
});

test('caption controls and waiting status have complete copy in every registered language and never translate speech', () => {
  for (const language of languages) {
    const f = fixture(language.code),
      words = callCaptionCopy(language.code);
    for (const word of Object.values(words)) assert.ok(word.trim());
    assert.equal(f.document.querySelector('label')?.textContent, words.title + words.hint);
    assert.equal(
      f.document.querySelector('[data-call-caption-toggle]')?.getAttribute('aria-label'),
      words.hide,
    );
    assert.equal(
      f.document.querySelector('[data-call-subtitle-placeholder]')?.textContent,
      words.waiting,
    );
    f.subtitles.receiveSnapshot({
      callId: 'call-one',
      provider: 'subscription',
      sequence: 1,
      text: '<b>Untranslated speech 原文</b>',
      final: true,
    });
    f.render();
    assert.equal(
      f.document.querySelector('[data-call-subtitle-text]')?.textContent,
      '<b>Untranslated speech 原文</b>',
    );
    assert.equal(f.document.querySelector('[data-call-subtitle-text] b'), null);
    assert.equal(f.document.querySelector('[data-call-subtitle-speaker]')?.textContent, 'dant');
  }
});

test('an unknown preference result waits for a fresh settings snapshot and is never resent automatically', async () => {
  const f = fixture();
  let requests = 0;
  f.request = async () => {
    requests++;
    throw Object.assign(Error('transport unavailable'), { unknownOutcome: true });
  };
  defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).click();
  await settle();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).disabled,
    true,
  );
  defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).click();
  await settle();
  assert.equal(requests, 1);
  f.reload();
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).disabled,
    false,
  );
  assert.equal(requests, 1);
});

test('a late unknown outcome from the previous connection cannot block or warn the new scope', async () => {
  const f = fixture(),
    pending = deferred<unknown>();
  f.request = async () => pending.promise;
  defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).click();
  f.state.settings.vm.host = 'replacement';
  pending.reject(Object.assign(Error('old connection detail'), { unknownOutcome: true }));
  await settle();
  assert.equal(f.preferences.enabled, true);
  assert.equal(
    defined(f.document.querySelector<HTMLButtonElement>('[data-call-caption-toggle]')).disabled,
    false,
  );
  assert.deepEqual(f.errors, []);
});
