import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createTransport } from '../../../ui/platform/transport.mts';
import { readAppState } from '../../../ui/app/application-state.mts';
import type { AppState } from '../../../ui/app/application-types.ts';
import { createCallSubtitles } from '../../../ui/call/call-subtitles.mts';
import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import { sourceDeclaration } from '../../support/source-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';

const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8');
const pause = () => new Promise((resolve) => setTimeout(resolve, 2));
async function until(test: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!test()) {
    assert.ok(Date.now() < deadline, 'the fixture state must be delivered');
    await pause();
  }
}
test('native state polling delivers only current call captions to the actual UI event handler without opening event sockets or starting calls', async () => {
  const { document } = parseHTML('<main></main>');
  let snapshot: AppState = {
      mode: 'vm-controller',
      conversationId: 'one',
      settings: { language: 'en', vm: { host: 'fixture-vm' } },
      worker: { status: 'online', models: [] },
      controller: { status: 'online', cached: false },
      messages: [],
      queue: [],
      active: null,
      call: { id: 'call-one', provider: 'subscription', status: 'connected' },
      callCaption: null,
    },
    reads = 0;
  const subtitles = createCallSubtitles({ onChange: () => subtitles.update(document) });
  const c = uiEntrypointFixture({
    document,
    state: snapshot,
    readAppState,
    restoreUpdateDraft: async () => {},
    callDuration: { sync() {} },
    callSubtitles: subtitles,
    callId: 'call-one',
    pc: null,
    callStarting: false,
    initialized: true,
    page: 'chat',
    language: () => 'en',
    localStorage: { setItem() {} },
    speechBlocked: () => false,
    lastAssistant: new Set<string>(),
    loadVoices() {},
    render: () => {
      defined(document.querySelector('main')).innerHTML = subtitles.render({
        enabled: c.state.settings.showCallCaptions !== false,
      });
    },
  });
  vm.createContext(uiFixtureContext(c));
  vm.runInContext(sourceDeclaration(source, 'async function handleEvent('), c);
  const transport = createTransport({
    desktop: true,
    pollDelay: 2,
    invokeRequest: async (command, request) => {
      assert.equal(command, 'api_request');
      assert.equal(request.route, '/api/state');
      assert.equal(request.method, 'GET');
      reads++;
      return { status: 200, body: JSON.stringify(snapshot) };
    },
  });
  try {
    transport.startEvents({ onEvent: (event) => c.handleEvent(event) });
    await until(() => document.querySelector('[data-call-subtitle-placeholder]') !== null);
    assert.match(
      document.querySelector('[data-call-subtitle-placeholder]')?.textContent ?? '',
      /Waiting for dant/,
    );
    snapshot = {
      ...snapshot,
      callCaption: {
        callId: 'call-one',
        provider: 'subscription',
        sequence: 1,
        text: 'Actually spoken text 原文',
        final: true,
      },
    };
    await until(
      () =>
        document.querySelector('[data-call-subtitle-text]')?.textContent ===
        'Actually spoken text 原文',
    );
    snapshot = { ...snapshot, settings: { ...snapshot.settings, showCallCaptions: false } };
    await until(
      () =>
        document.querySelector('[data-call-subtitles]')?.getAttribute('data-caption-enabled') ===
        'false',
    );
    assert.equal(document.querySelector('[data-call-subtitle-text]')?.textContent, '');
    snapshot = { ...snapshot, settings: { ...snapshot.settings, showCallCaptions: true } };
    await until(
      () =>
        document.querySelector('[data-call-subtitle-text]')?.textContent ===
        'Actually spoken text 原文',
    );
    snapshot = { ...snapshot, call: { id: 'call-two', provider: 'api', status: 'connected' } };
    await until(() => subtitles.snapshot.callId === 'call-two');
    assert.equal(document.querySelector('[data-call-subtitle-text]')?.textContent, '');
    await c.handleEvent({
      type: 'realtime',
      data: {
        method: 'dant/call/subtitle',
        params: {
          callId: 'call-one',
          provider: 'subscription',
          sequence: 10,
          text: 'Late old speech',
          final: true,
        },
      },
    });
    assert.equal(subtitles.snapshot.text, '');
    snapshot = { ...snapshot, call: null, callCaption: null };
    await until(() => subtitles.snapshot.callId === null);
    assert.equal(subtitles.snapshot.text, '');
    assert.ok(reads > 1);
  } finally {
    transport.close();
  }
});
