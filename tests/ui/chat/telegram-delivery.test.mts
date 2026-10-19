import { defined } from '../../support/fixture-assertions.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  telegramConnectionError,
  telegramDeliveryNotice,
} from '../../../ui/chat/telegram-delivery.mts';

const ready = {
  enabled: true,
  configured: true,
  connected: true,
  paired: true,
  connectionError: null,
  lastError: 'Request failed',
  delivery: {
    unknown: 2,
    failed: 1,
    lastIssue: { status: 'unknown', at: 1234, reason: 'timeout' },
  },
};

test('current connection errors are independent from historical delivery errors with safe legacy fallback', () => {
  assert.equal(telegramConnectionError(ready), null);
  assert.equal(
    telegramConnectionError({ ...ready, connectionError: 'Network unavailable' }),
    'Network unavailable',
  );
  assert.equal(
    telegramConnectionError({ connected: true, lastError: 'Old delivery failed' }),
    null,
  );
  assert.equal(
    telegramConnectionError({ connected: false, lastError: 'Could not connect' }),
    'Could not connect',
  );
  assert.equal(
    telegramConnectionError({
      connected: false,
      connectionError: null,
      lastError: 'Old delivery failed',
    }),
    null,
  );
  for (const value of [
    null,
    {},
    undefined,
    { connectionError: '' },
    { connectionError: 32 },
    { lastError: 32 },
  ])
    assert.equal(telegramConnectionError(value), null);
});

test('both historical issue counts, last issue time and fixed reason are displayed in the selected language', () => {
  for (const language of ['zh', 'en']) {
    const calls: number[] = [],
      notice = telegramDeliveryNotice(ready, {
        language,
        formatTime: (at) => {
          calls.push(at);
          return '18 Oct, 09:30';
        },
      });
    assert.deepEqual(calls, [1234]);
    assert.match(defined(notice).latest, /18 Oct, 09:30/);
    if (language === 'zh') {
      assert.match(defined(notice).summary, /2 条消息的发送结果未确认/);
      assert.match(defined(notice).summary, /1 条消息未送达/);
      assert.match(defined(notice).latest, /请求超时/);
      assert.match(defined(notice).reassurance, /连接和账号配对仍然有效，新消息可以继续发送/);
      assert.match(defined(notice).hint, /先检查 Telegram/);
      assert.doesNotMatch(
        Object.values(defined(notice)).join(' '),
        /unconfirmed|Request timed out|New messages/,
      );
    } else {
      assert.match(defined(notice).summary, /2 messages with unconfirmed delivery/);
      assert.match(defined(notice).summary, /1 message was not delivered/);
      assert.match(defined(notice).latest, /Request timed out/);
      assert.match(defined(notice).reassurance, /pairing are still active/);
      assert.match(defined(notice).reassurance, /New messages can still be sent/);
      assert.match(defined(notice).hint, /avoid duplicates/);
      assert.doesNotMatch(Object.values(defined(notice)).join(' '), /[\u4e00-\u9fff]/);
    }
  }
});

test('reason enums localize without exposing network diagnostics or raw responses', () => {
  const values = [
    'timeout',
    'network',
    'dns',
    'tls',
    'cancelled',
    'invalid-response',
    'response-too-large',
    'server',
    'rejected',
    'attachment',
    'unconfirmed',
  ];
  for (const reason of values)
    for (const language of ['zh', 'en']) {
      const notice = telegramDeliveryNotice(
        {
          ...ready,
          delivery: { unknown: 1, failed: 0, lastIssue: { status: 'unknown', reason, at: 1 } },
        },
        { language },
      );
      assert.ok(defined(notice).latest);
      assert.doesNotMatch(defined(notice).latest, /Reason unavailable|原因尚未确认/);
    }
  for (const reason of ['private-token-and-response', '__proto__', 'toString', null]) {
    const notice = telegramDeliveryNotice(
      {
        ...ready,
        delivery: { unknown: 1, failed: 0, lastIssue: { status: 'unknown', reason, at: 1 } },
      },
      { language: 'en' },
    );
    assert.match(defined(notice).latest, /Reason unavailable/);
    assert.doesNotMatch(defined(notice).latest, /private-token|__proto__|toString/);
  }
});

test('failed-only history has accurate singular/plural wording and no promise of automatic replay', () => {
  for (const failed of [1, 3]) {
    const notice = telegramDeliveryNotice(
      {
        ...ready,
        delivery: {
          failed,
          unknown: 0,
          lastIssue: { status: 'failed', at: 1234, reason: 'attachment' },
        },
      },
      { language: 'en' },
    );
    assert.match(
      defined(notice).summary,
      failed === 1 ? /1 message was not delivered/ : /3 messages were not delivered/,
    );
    assert.match(
      defined(notice).latest,
      /Last failed delivery.*Attachment could not be read or sent/,
    );
    assert.match(defined(notice).hint, /will not be resent automatically/);
    assert.doesNotMatch(defined(notice).summary, /unconfirmed/);
  }
  const single = telegramDeliveryNotice(
    { ...ready, delivery: { failed: 0, unknown: 1 } },
    { language: 'en' },
  );
  assert.match(defined(single).summary, /1 message with unconfirmed delivery/);
  assert.match(defined(single).hint, /will not be resent automatically/);
});

test('only an actually ready connection is described as ready, without changing pairing or retrying', () => {
  for (const change of [
    { enabled: false },
    { configured: false },
    { connected: false },
    { paired: false },
    { connectionError: 'Connection failed' },
  ])
    assert.equal(defined(telegramDeliveryNotice({ ...ready, ...change })).reassurance, '');
  assert.equal(
    defined(telegramDeliveryNotice(ready, { online: false })).reassurance,
    '',
    'cached connected status is not evidence that an offline VM can send',
  );
  const status = structuredClone(ready),
    before = JSON.stringify(status);
  telegramDeliveryNotice(status);
  telegramConnectionError(status);
  assert.equal(JSON.stringify(status), before);
});

test('invalid counters and stale issue metadata do not invent an active delivery issue', () => {
  for (const delivery of [
    null,
    {},
    { unknown: -1, failed: 0 },
    { unknown: '2', failed: NaN },
    { unknown: Infinity, failed: 1.5 },
  ])
    assert.equal(telegramDeliveryNotice({ ...ready, delivery }), null);
  assert.equal(telegramDeliveryNotice(null), null);
  assert.equal(telegramDeliveryNotice(), null);
  for (const lastIssue of [
    null,
    { status: 'unknown', at: 1, reason: 'network' },
    { status: 'invented', at: 1, reason: 'network' },
  ])
    assert.equal(
      defined(telegramDeliveryNotice({ ...ready, delivery: { unknown: 0, failed: 1, lastIssue } }))
        .latest,
      '',
    );
  for (const at of [null, '1234', -1, Infinity, 8640000000000001]) {
    const notice = telegramDeliveryNotice(
      {
        ...ready,
        delivery: { unknown: 1, lastIssue: { status: 'unknown', at, reason: 'network' } },
      },
      {
        formatTime: () => {
          throw Error('Invalid time must not be formatted');
        },
      },
    );
    assert.match(defined(notice).latest, /Network connection interrupted/);
  }
  const notice = telegramDeliveryNotice(ready, {
    formatTime: () => {
      throw Error('Formatter unavailable');
    },
  });
  assert.match(defined(notice).latest, /Request timed out/);
});
