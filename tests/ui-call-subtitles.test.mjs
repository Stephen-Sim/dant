import { sourceIndex } from './source-fixtures.mjs';
import { languageContext } from './language-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createCallSubtitles } from '../ui/call/call-subtitles.js';
const caption = (sequence, text = 'Caption', extra = {}) => ({
  method: 'dant/call/subtitle',
  params: { callId: 'a', provider: 'subscription', sequence, text, final: false, ...extra },
});
function fixture() {
  let id = 0;
  const timers = new Map(),
    changes = [],
    subtitles = createCallSubtitles({
      schedule: (fn) => {
        const key = ++id;
        timers.set(key, () => {
          timers.delete(key);
          fn();
        });
        return key;
      },
      cancel: (key) => timers.delete(key),
      onChange: (value) => changes.push(value),
    });
  subtitles.sync({ id: 'a', provider: 'subscription' });
  return { subtitles, timers, changes };
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

test('finished captions clear after reading time while old timers cannot erase another utterance', () => {
  const { subtitles, timers } = fixture();
  subtitles.receive(caption(1, 'Finished', { final: true }));
  assert.equal(timers.size, 1);
  const old = [...timers.values()][0];
  subtitles.receive(caption(2, 'New partial'));
  assert.equal(timers.size, 0);
  old();
  assert.equal(subtitles.snapshot.text, 'New partial');
  subtitles.receive(caption(3, 'New final', { final: true }));
  [...timers.values()][0]();
  assert.equal(subtitles.snapshot.text, '');
  subtitles.end();
  assert.equal(timers.size, 0);
});

test('subtitle DOM uses plain assistant text with accessible bilingual labels and stays hidden in mini call', () => {
  const { subtitles } = fixture(),
    { document } = parseHTML('<main></main>');
  subtitles.receive(caption(1, '<img src=x onerror=alert(1)> 中文 & speech'));
  document.querySelector('main').innerHTML = subtitles.render({ language: 'zh' });
  const node = document.querySelector('[data-call-subtitles]');
  assert.equal(node.querySelector('img'), null);
  assert.equal(node.textContent, '<img src=x onerror=alert(1)> 中文 & speech');
  assert.equal(node.getAttribute('aria-label'), 'dant 实时字幕');
  assert.equal(node.getAttribute('aria-live'), 'polite');
  assert.equal(node.getAttribute('aria-busy'), 'true');
  subtitles.receive(caption(2, 'Done', { final: true }));
  subtitles.update(document);
  assert.equal(node.textContent, 'Done');
  assert.equal(node.getAttribute('aria-busy'), 'false');
  subtitles.end();
  subtitles.update(document);
  assert.equal(node.textContent, '');
  assert.equal(node.getAttribute('aria-hidden'), 'true');
  document.querySelector('main').innerHTML = subtitles.render({ mini: true, language: 'en' });
  assert.equal(document.querySelector('[data-call-subtitles]').hidden, true);
  assert.equal(
    document.querySelector('[data-call-subtitles]').getAttribute('aria-label'),
    'dant live captions',
  );
});

test('actual full call renderer places captions underneath avatar without replacing media or chat content', () => {
  const source = fs.readFileSync(new URL('../ui/main.js', import.meta.url), 'utf8'),
    start = sourceIndex(source, 'function renderCall(){'),
    end = sourceIndex(source, 'function publishCallOverlay(){', start),
    { subtitles } = fixture(),
    { document } = parseHTML('<main></main>');
  subtitles.receive(caption(1, '正在检查这个结果。'));
  const peer = { connectionState: 'connected' },
    context = {
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
      t: (key) => key,
      button: () => '<button></button>',
      language: () => 'zh',
    };
  vm.createContext(Object.assign(context, languageContext));
  vm.runInContext(source.slice(start, end), context);
  document.querySelector('main').innerHTML = context.renderCall();
  const avatar = document.querySelector('.call-avatar'),
    captionNode = document.querySelector('[data-call-subtitles]');
  assert.ok(avatar.compareDocumentPosition(captionNode) & 4);
  assert.equal(captionNode.textContent, '正在检查这个结果。');
  assert.equal(context.pc, peer);
  assert.equal(document.querySelector('.bubble'), null);
  context.callMini = true;
  document.querySelector('main').innerHTML = context.renderCall();
  assert.equal(document.querySelector('[data-call-subtitles]').hidden, true);
});
