import { uiEntrypointFixture } from '../../support/ui-entrypoint-fixtures.mts';
import { defined } from '../../support/fixture-assertions.mts';
import { stripTypeScriptTypes } from 'node:module';
import { sourceIndex } from '../../support/source-fixtures.mts';
import { uiFixtureContext } from '../../support/language-context.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createCallSubtitles } from '../../../ui/call/call-subtitles.mts';
const caption = (sequence: number, text = 'Caption', extra = {}) => ({
  method: 'dant/call/subtitle',
  params: { callId: 'a', provider: 'subscription', sequence, text, final: false, ...extra },
});
function fixture() {
  const changes: ReturnType<typeof createCallSubtitles>['snapshot'][] = [],
    subtitles = createCallSubtitles({
      onChange: (value) => changes.push(value),
    });
  subtitles.sync({ id: 'a', provider: 'subscription' });
  return { subtitles, changes };
}

test('call subtitles reject stale sessions, old revisions and unknown payloads and clear on call replacement/end', () => {
  const { subtitles } = fixture();
  assert.equal(subtitles.receive(caption(1, 'Hello')), true);
  for (const event of [
    caption(1, 'duplicate'),
    caption(0, 'old'),
    caption(2, 'wrong call', { callId: 'b' }),
    caption(2, 'wrong provider', { provider: 'api' }),
    caption(2, 'x'.repeat(4001)),
    caption(2, 'bad final', { final: 'yes' }),
    caption(2, 'not assistant speech', { role: 'user' }),
    caption(2, 'control\0text'),
    { method: 'thread/realtime/transcript/done', params: { role: 'user', text: 'User speech' } },
  ])
    assert.equal(subtitles.receive(event), false);
  assert.equal(subtitles.snapshot.text, 'Hello');
  subtitles.sync({ id: 'b', provider: 'api' });
  assert.equal(subtitles.snapshot.text, '');
  assert.equal(subtitles.receive(caption(3, 'stale')), false);
  subtitles.receive(caption(1, 'New call', { callId: 'b', provider: 'api' }));
  subtitles.end();
  assert.equal(subtitles.snapshot.text, '');
  subtitles.sync({ id: 'b', provider: 'api' });
  assert.equal(subtitles.snapshot.callId, null);
  subtitles.dispose();
});

test('the last actual utterance stays readable until a new response or exact call end, without a transcript history', () => {
  const { subtitles } = fixture();
  subtitles.receive(caption(1, 'Finished', { final: true }));
  assert.equal(subtitles.snapshot.text, 'Finished');
  subtitles.receiveSnapshot(caption(1, 'Finished', { final: true }).params);
  assert.equal(subtitles.snapshot.text, 'Finished');
  subtitles.receive(caption(2, ''));
  assert.equal(subtitles.snapshot.text, '');
  subtitles.receive(caption(3, 'New final', { final: true }));
  assert.equal(subtitles.snapshot.text, 'New final');
  subtitles.end();
  assert.equal(subtitles.snapshot.text, '');
  assert.equal(subtitles.receive(caption(4, 'late text')), false);
});

test('caption snapshots stay scoped across VM or conversation replacement and reject ended or unknown calls', () => {
  const { subtitles } = fixture();
  subtitles.sync({ id: 'a', provider: 'subscription', status: 'connected' }, 'conversation-one');
  subtitles.receiveSnapshot(caption(1, 'Old scope text').params);
  assert.equal(subtitles.receiveSnapshot(undefined), false);
  assert.equal(subtitles.snapshot.text, 'Old scope text');
  subtitles.sync({ id: 'a', provider: 'subscription', status: 'connected' }, 'conversation-two');
  assert.equal(subtitles.snapshot.text, '');
  assert.equal(subtitles.receiveSnapshot(caption(1, 'New scope text').params), true);
  subtitles.receiveSnapshot(null);
  assert.equal(subtitles.snapshot.text, '');
  subtitles.sync(
    { id: 'a', provider: 'subscription', status: 'future-unknown' },
    'conversation-two',
  );
  assert.equal(subtitles.receiveSnapshot(caption(2, 'Not active speech').params), false);
  subtitles.sync({ id: 'b', provider: 'api', status: 'connected' }, 'conversation-two');
  subtitles.receiveSnapshot(caption(1, 'API segment', { callId: 'b', provider: 'api' }).params);
  subtitles.sync(null, 'conversation-two');
  assert.equal(
    subtitles.receiveSnapshot(
      caption(2, 'Late API segment', { callId: 'b', provider: 'api' }).params,
    ),
    false,
  );
});

test('subtitle DOM uses plain assistant text with accessible bilingual labels and stays hidden in mini call', () => {
  const { subtitles } = fixture(),
    { document } = parseHTML('<main></main>');
  subtitles.receive(caption(1, '<img src=x onerror=alert(1)> 中文 & speech'));
  defined(document.querySelector<HTMLElement>('main')).innerHTML = subtitles.render({
    language: 'zh',
  });
  const node = document.querySelector<HTMLButtonElement>('[data-call-subtitles]');
  assert.equal(defined(node).querySelector<HTMLImageElement>('img'), null);
  assert.equal(
    defined(node).querySelector('[data-call-subtitle-text]')?.textContent,
    '<img src=x onerror=alert(1)> 中文 & speech',
  );
  assert.equal(defined(node).getAttribute('aria-label'), 'dant 实时字幕');
  assert.equal(defined(node).getAttribute('aria-live'), 'polite');
  assert.equal(defined(node).getAttribute('aria-busy'), 'true');
  subtitles.receive(caption(2, 'Done', { final: true }));
  subtitles.update(document);
  assert.equal(defined(node).querySelector('[data-call-subtitle-text]')?.textContent, 'Done');
  assert.equal(defined(node).getAttribute('aria-busy'), 'false');
  subtitles.end();
  subtitles.update(document);
  assert.equal(defined(node).querySelector('[data-call-subtitle-text]')?.textContent, '');
  assert.equal(defined(node).getAttribute('aria-hidden'), 'true');
  defined(document.querySelector<HTMLElement>('main')).innerHTML = subtitles.render({
    mini: true,
    language: 'en',
  });
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-call-subtitles]')).hidden,
    true,
  );
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-call-subtitles]')).getAttribute(
      'aria-label',
    ),
    'dant live captions',
  );
});

test('actual full call renderer places captions underneath avatar without replacing media or chat content', () => {
  const source = fs.readFileSync(new URL('../../../ui/main.mts', import.meta.url), 'utf8'),
    start = sourceIndex(source, 'function renderCall(){'),
    end = sourceIndex(source, 'function publishCallOverlay(){', start),
    { subtitles } = fixture(),
    { document } = parseHTML('<main></main>');
  subtitles.receive(caption(1, '正在检查这个结果。'));
  const peer = { connectionState: 'connected' },
    context = uiEntrypointFixture({
      callSubtitles: subtitles,
      pc: peer,
      callStarting: false,
      state: { call: { id: 'a', provider: 'subscription' } },
      callStops: { pending: false },
      callProvider: 'subscription',
      callMini: false,
      callConnected: true,
      callChannel: { readyState: 'open' },
      callDuration: { snapshot: { confirmed: false } },
      stream: {},
      callMuted: false,
      eyes: () => '<i class="call-avatar"></i>',
      t: (key: string) => key,
      button: () => '<button></button>',
      language: () => 'zh',
    });
  vm.createContext(uiFixtureContext(context));
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
  defined(document.querySelector<HTMLElement>('main')).innerHTML = context.renderCall();
  const avatar = document.querySelector<HTMLElement>('.call-avatar'),
    captionNode = document.querySelector<HTMLButtonElement>('[data-call-subtitles]');
  assert.ok(defined(avatar).compareDocumentPosition(defined(captionNode)) & 4);
  assert.equal(
    defined(captionNode).querySelector('[data-call-subtitle-text]')?.textContent,
    '正在检查这个结果。',
  );
  assert.equal(context.pc, peer);
  assert.equal(document.querySelector<HTMLElement>('.bubble'), null);
  context.callMini = true;
  defined(document.querySelector<HTMLElement>('main')).innerHTML = context.renderCall();
  assert.equal(
    defined(document.querySelector<HTMLButtonElement>('[data-call-subtitles]')).hidden,
    true,
  );
});
