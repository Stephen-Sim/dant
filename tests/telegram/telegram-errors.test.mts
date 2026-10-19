import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramFailureReason } from '../../src/telegram/telegram-errors.mts';

test('Telegram diagnostics distinguish timeout from a deliberate abort', () => {
  const timeout = new AbortController();
  timeout.abort(new DOMException('secret', 'TimeoutError'));
  const cancelled = new AbortController();
  cancelled.abort(new Error('secret'));
  assert.equal(telegramFailureReason({ telegramCode: 503 }, { signal: timeout.signal }), 'timeout');
  assert.equal(
    telegramFailureReason({ cause: { code: 'ENOTFOUND' } }, { signal: cancelled.signal }),
    'cancelled',
  );
  assert.equal(telegramFailureReason(new DOMException('secret', 'TimeoutError')), 'timeout');
  assert.equal(telegramFailureReason({ cause: { code: 'UND_ERR_BODY_TIMEOUT' } }), 'timeout');
  assert.equal(telegramFailureReason(new DOMException('secret', 'AbortError')), 'cancelled');
  assert.equal(telegramFailureReason({ cause: { code: 'ABORT_ERR' } }), 'cancelled');
});

test('Telegram diagnostics use fixed DNS, TLS and network cause codes', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA'])
    assert.equal(telegramFailureReason(new Error('secret', { cause: { code } })), 'dns');
  for (const code of [
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'EPROTO',
  ])
    assert.equal(telegramFailureReason({ cause: { cause: { code } } }), 'tls');
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'UND_ERR_SOCKET'])
    assert.equal(telegramFailureReason({ code, unknownOutcome: true }), 'network');
  for (const code of [
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
  ])
    assert.equal(telegramFailureReason({ code }), 'timeout');
});

test('Telegram diagnostics distinguish rejection, server and local response failures', () => {
  for (const telegramCode of [400, 401, 403, 409, 429])
    assert.equal(telegramFailureReason({ telegramCode }), 'rejected');
  for (const telegramCode of [500, 502, 503])
    assert.equal(telegramFailureReason({ telegramCode, unknownOutcome: true }), 'server');
  assert.equal(telegramFailureReason(null, { phase: 'attachment' }), 'attachment');
  assert.equal(telegramFailureReason(null, { phase: 'response-too-large' }), 'response-too-large');
  assert.equal(telegramFailureReason(null, { phase: 'response-size' }), 'response-too-large');
  assert.equal(telegramFailureReason(null, { phase: 'parsing' }), 'invalid-response');
  assert.equal(telegramFailureReason(null, { phase: 'parse' }), 'invalid-response');
  assert.equal(telegramFailureReason(new SyntaxError('secret')), 'invalid-response');
  assert.equal(telegramFailureReason({ unknownOutcome: true }), 'unconfirmed');
  for (const value of [
    null,
    undefined,
    'token',
    {},
    { telegramCode: '500' },
    { code: 'secret-token' },
  ])
    assert.equal(telegramFailureReason(value), 'network');
});

test('Telegram diagnostics never inspect messages or serialize unknown values', () => {
  const secret = {
    get message() {
      throw Error('message must not be read');
    },
    get url() {
      throw Error('url must not be read');
    },
    toString() {
      throw Error('coercion must not be used');
    },
    cause: { code: 'ENOTFOUND' },
  };
  assert.equal(telegramFailureReason(secret), 'dns');
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(telegramFailureReason(cyclic), 'network');
  const broken = {
    get name() {
      throw Error('unavailable');
    },
    get cause() {
      throw Error('unavailable');
    },
    get code() {
      throw Error('unavailable');
    },
    get telegramCode() {
      throw Error('unavailable');
    },
  };
  assert.equal(telegramFailureReason(broken), 'network');
  assert.equal(
    telegramFailureReason({ cause: { cause: { cause: { cause: { code: 'ENOTFOUND' } } } } }),
    'network',
  );
});
