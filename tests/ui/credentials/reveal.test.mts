import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createCredentialReveal } from '../../../ui/credentials/reveal.mts';
import type { RevealIdentity } from '../../../ui/credentials/reveal.mts';
import type { ApiOptions } from '../../../ui/shared/contracts.mts';

function fixture() {
  const { document } = parseHTML('<input id="secret" readonly hidden>');
  const input = document.querySelector<HTMLInputElement>('#secret');
  let identity: RevealIdentity | null = {
    credentialId: 'synthetic-id',
    conversationId: 'synthetic-conversation',
    computer: 'synthetic-computer',
    modal: {},
  };
  const calls: { route: string; options: ApiOptions }[] = [];
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const reveal = createCredentialReveal({
    identity: () => identity,
    changed: () => reveal.apply(input),
    clear: () => {
      if (input) {
        input.value = '';
        input.hidden = true;
      }
    },
    request: async (route, options = {}) => {
      calls.push({ route, options });
      return await new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
  });
  return {
    reveal,
    calls,
    input,
    set identity(value: RevealIdentity | null) {
      identity = value;
    },
    get identity() {
      return identity;
    },
    resolve: (value: unknown) => resolve(value),
    reject: () => reject(Error('private raw failure must never render')),
  };
}
const response = {
  id: 'synthetic-id',
  conversationId: 'synthetic-conversation',
  secret: 'synthetic saved secret',
};

test('saved secrets require an explicit scoped click and remain outside serializable UI state', async () => {
  const f = fixture();
  assert.deepEqual(f.reveal.state, {
    available: true,
    visible: false,
    pending: false,
    failed: false,
  });
  assert.equal(f.calls.length, 0);
  const waiting = f.reveal.toggle();
  assert.equal(f.calls[0]?.route, '/credentials/reveal/synthetic-id');
  assert.deepEqual(f.calls[0]?.options.body, { conversationId: 'synthetic-conversation' });
  assert.equal(f.calls[0]?.options.beforeSend?.(), true);
  const received = { ...response };
  f.resolve(received);
  await waiting;
  assert.equal(received.secret, '');
  assert.equal(f.input?.value, response.secret);
  assert.equal(f.input?.hidden, false);
  assert.equal(JSON.stringify(f.reveal.state).includes(response.secret), false);
  await f.reveal.toggle();
  assert.equal(f.input?.value, '');
  assert.equal(f.input?.hidden, true);
  assert.equal(f.calls.length, 1);
});

test('Hide, close and each identity change invalidate a pending reveal and its dispatch guard', async () => {
  for (const change of [
    'hide',
    'close',
    'credentialId',
    'conversationId',
    'computer',
    'modal',
  ] as const) {
    const f = fixture(),
      pending = f.reveal.toggle();
    if (change === 'hide') await f.reveal.toggle();
    else if (change === 'close') {
      f.identity = null;
      f.reveal.reset();
    } else if (f.identity)
      f.identity = { ...f.identity, [change]: change === 'modal' ? {} : 'replacement-identity' };
    assert.equal(f.calls[0]?.options.beforeSend?.(), false);
    const received = { ...response };
    f.resolve(received);
    await pending;
    f.reveal.apply(f.input);
    assert.equal(received.secret, '');
    assert.equal(f.input?.value, '', change);
    assert.equal(f.reveal.state.visible, false, change);
  }
});

test('invalid reveal DTOs and raw failures never appear as plaintext or detailed errors', async () => {
  for (const value of [
    null,
    { ...response, id: 'other' },
    { ...response, conversationId: 'other' },
    { ...response, extra: 'unexpected' },
    { ...response, secret: '' },
    { ...response, secret: 'x'.repeat(16_385) },
    { ...response, secret: false },
  ]) {
    const f = fixture(),
      pending = f.reveal.toggle();
    f.resolve(value);
    await pending;
    assert.equal(f.reveal.state.failed, true);
    assert.equal(f.input?.value, '');
  }
  const f = fixture(),
    pending = f.reveal.toggle();
  f.reject();
  await pending;
  assert.equal(f.reveal.state.failed, true);
  assert.equal(JSON.stringify(f.reveal.state).includes('private'), false);
});
